---
prompt: 213
titlu: "OPME — o plată dintr-un ciclu închis nu mai poate ajunge pe ciclul curent (acceptare, rematch, agregare)"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.865
versiune_tinta: v3.9.866
migratii: NU
scrieri_in_baza: NU (reparația de date a fost făcută manual pe producție — SQL-213d)
fisiere_din_public: DA — un singur fișier ⇒ `?v=` ȚINTIT, `CACHE_VERSION` doar dacă e în PRECACHE
zona_no_touch_atinsa: NU
tip: bugfix financiar (4 puncte pe server + UX în dialog) + teste care reproduc incidentul
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
`main` = producție, gestionat manual DOAR de Mircea.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL — incidentul RATBV (16.09.2026), măsurat pe producție

Dosarul „DIFERENTA DE TARIF transport public local", furnizor RATBV, are 4 cicluri:

| Ciclu | ORD | Valoare ORD | Plată confirmată | OP-uri |
|---|---|---|---|---|
| 1 | 42300 | 26.166,00 | 26.166,00 auto | 2379, 2382, 2383 |
| 2 | 43702 | 231.117,77 | 231.117,77 **manual** (18.08) | 2666, 2667, 2668, 2669 |
| 3 | 45339 | 191.790,72 | 191.790,72 **manual** | 2781 |
| 4 (curent, `ordonantare`) | 47842 | 217.526,49 | — | — |

La 16.09, un administrator a acceptat din raportul OPME liniile **2666, 2667, 2668** (32.852,00).
Dialogul i-a preselectat dosarul RATBV, deși dosarul era în `ordonantare`. Ruta a acceptat și a pus
`matched_ciclu_id = NULL` ⇒ **trei plăți din august au ajuns pe ciclul 4**.

Consecința, dacă nu era prinsă: la finalizarea fluxului ORD 47842, dosarul trece în `plata`,
`tryAutoConfirmAlop` rulează imediat și adună 32.852 la OP-urile din septembrie ⇒ ciclul 4 nu se mai
confirmă corect, sau se confirmă pe o sumă greșită. Nimic nu dă eroare.

**Datele au fost deja reparate manual pe producție (SQL-213d).** Lotul ăsta închide calea prin care
s-a ajuns acolo. ⛔ Nu scrie nicio reparație de date.

## Lanțul cauzal — patru verigi, verificate pe cod

1. **Rematch-ul redeschide linii arhivate.** `POST /api/opme/imports/:id/rematch` (`opme.mjs:~672`)
   și `POST /api/opme/rematch-all` (`:~812`) pun `pending` pe **toate** liniile
   `unmatched/ambiguous/partial` ale importului — inclusiv pe cele care aparțin unui ciclu arhivat
   (`matched_ciclu_id` setat de `noua-lichidare`). Istoria unui ciclu închis e rescrisă.
2. **`_markLine` lasă pointerii în urmă.** (`opme-matcher.mjs:~591`) Când o linie redeschisă nu mai
   găsește dosar în plată, devine `unmatched`, dar **păstrează `matched_alop_id`** (și
   `matched_ciclu_id`). O linie „nepotrivită" care arată spre un dosar e o contradicție. Măsurat pe
   producție: 2666–2668 aveau `match_status_vechi = unmatched` ȘI `matched_alop_id` = RATBV.
3. **Acceptarea nu verifică faza dosarului și nici ciclul liniei.** `POST /api/opme/lines/:id/accept`
   (`opme.mjs:~521`) acceptă pe orice dosar neanulat și pune `matched_ciclu_id = NULL`. Dialogul
   (`opme-report-drawer.js:~331`) oferă dosarul „(legat de matcher)" indiferent de faza lui.
4. **Agregarea nu filtrează ciclul pe ramura `pending/unmatched/partial`.** `_processAlop`
   (`opme-matcher.mjs:~455`) filtrează `matched_ciclu_id IS NULL` doar pe ramura `auto/manual`. O
   linie `partial` arhivată pe ciclul 2, cu același CIF/triplet/IBAN, **e reabsorbită** în suma
   oricărui ciclu ulterior al aceluiași dosar — iar la potrivire `_bulkMarkMatched` îi pune
   `matched_ciclu_id = NULL`, mutând-o definitiv.

Fiecare verigă singură pare inofensivă. Împreună mută bani între cicluri, tăcut.

## Regula pe care o implementează lotul

**O linie legată de un ciclu arhivat e istorie și nu se mai atinge din aplicație.** Nici de rematch,
nici de agregare, nici de acceptare. **Acceptarea se face doar pe un dosar al cărui ciclu curent e în
faza de plată** — `plata` sau `completed` (plată confirmată în ciclul curent; calea #209 de corectare,
test 13 din `plata-reia-confirmare.test.mjs`, trebuie să rămână verde).

⭐ Decizie de produs a lui Mircea: legarea unei plăți de un ciclu **închis** NU se face din interfață.
Cazul e rar și se tratează cu SQL, ca SQL-213d. **Nu construi o astfel de cale.**

---

# ETAPA 0 — ancore (READ-ONLY, raportează valorile OBȚINUTE)

```bash
git branch --show-current
# Așteptat: develop

grep -n "match_status IN ('unmatched','ambiguous','partial')" server/routes/opme.mjs
# Așteptat: 2 apariții — rematch (~676) și rematch-all (~816). ⭐ Dacă sunt mai multe, RAPORTEAZĂ.

grep -n "async function _markLine" -A4 server/services/opme-matcher.mjs
grep -n "_markLine(" server/services/opme-matcher.mjs
# Așteptat: definiția + 3 apeluri (unmatched ×2, ambiguous ×1). ⭐ Confirmă că NU e chemat cu alt status.

grep -n "match_status IN ('pending','unmatched','partial')" server/services/opme-matcher.mjs
grep -c "AND matched_ciclu_id IS NULL" server/services/opme-matcher.mjs
# Notează numărul OBȚINUT — îl folosești la verificarea din Etapa B.

grep -n "SELECT id, org_id, nr_op, suma_op, match_status, match_notes, matched_alop_id" server/routes/opme.mjs
grep -n "SELECT id, org_id, status, plata_confirmed_at, ciclu_curent" server/routes/opme.mjs
# Cele două SELECT-uri din ruta de acceptare. ⭐ Confirmă că `status` e deja încărcat pe ALOP.

grep -n "alop_status_valid" -A2 server/db/index.mjs
# Lista statusurilor ALOP. ⭐ Confirmă numele exacte `plata` și `completed`.

grep -n "opme-report-drawer" public/*.html public/sw.js
# ⚠️ La #207 presupunerea că un fișier nu e în PRECACHE s-a dovedit GREȘITĂ. Raportează dovada.
```

⭐ Verifică și **testele care ancorează pe textul SQL** al acestor interogări (mock-uri pe
`pool.query` care potrivesc după fragment):

```bash
grep -rn "UPDATE opme_lines SET match_status=\$2\|match_status IN ('pending','unmatched','partial')\|IN \\\\('unmatched','ambiguous','partial'\\\\)\|match_status='pending'" server/tests --include=*.mjs
```

Cunoscute: `unit/opme-matcher.test.mjs` (mock pe `UPDATE opme_lines SET match_status=$2`, citește
`params[1]` și `params[2]`), `integration/opme-routes-read.test.mjs` (verifică regex pe SQL-ul de
reset: conține `IN ('unmatched','ambiguous','partial')`, NU conține `'auto'` și `'manual'`),
`integration/opme-e2e.test.mjs` și `integration/opme-matching.test.mjs` (mock-uri pe
`match_status IN ('pending','unmatched','partial')` și `match_status='pending'`).

⛔ **Consecința pentru patch-uri:** fragmentele de mai sus rămân **caracter cu caracter** în SQL.
Adaugi condiții pe linii noi; nu reformulezi, nu reordonezi parametrii. ⛔ **Niciun comentariu în
interiorul template-urilor SQL** care să conțină `'auto'` sau `'manual'` între apostrofuri — ar pica
testul de reset pe regex. Comentariile explicative stau în JS, deasupra `client.query`.

---

# ⭐ ETAPA T — testele ÎNTÂI, rulate pe codul NEREPARAT

`server/tests/db/opme-ciclu-arhivat.test.mjs` (nou). Modelează seed-urile după
`opme-accept-linie.test.mjs` (`seedImport`, `seedLine`, `seedScenariu8836`) și arhivarea de ciclu
după `ord-buget-an-curent-plafon.test.mjs` (`INSERT INTO alop_ord_cicluri … an_exercitiu, status`).
`seedLine` din testul existent nu setează `matched_ciclu_id` — extinde-l **în fișierul nou**, nu
modifica helper-ul din testul #209.

Scenariul de bază, „RATBV": un dosar cu ORD curent (CIF, triplet, IBAN), un ciclu arhivat nr. 1 cu
plată manuală, un import cu linii **cu același CIF/triplet/IBAN** ca ORD-ul (altfel regula de bloc
le respinge și testele de agregare nu măsoară nimic).

**A — acceptarea**
1. ⭐⭐ Reproducerea exactă: linie `unmatched` cu `matched_alop_id` = dosarul și `matched_ciclu_id`
   NULL, dosar în `ordonantare` ⇒ **409 `dosar_nu_e_in_plata`**. Zero scrieri: linia identică
   (status, pointeri, notă), zero rânduri `opme_line_accepted_manual` în audit.
2. Același lucru pentru dosar în `lichidare`, `angajare`, `draft` (parametrizat).
3. ⭐ Linie cu `matched_ciclu_id` setat (arhivată), dosar în `plata` ⇒ **409 `linie_ciclu_arhivat`**,
   zero scrieri.
4. Neregresie: dosar în `plata` ⇒ 200; dosar în `completed` ⇒ 200 cu `already_confirmed`. (Dacă
   testele 8 și 13b din #209 acoperă deja exact asta, trimite la ele în comentariu, nu duplica.)

**B — agregarea**
5. ⭐⭐ Dosar în `plata`, ciclul curent cu ORD = X. În baza de date: o linie `partial` arhivată pe
   ciclul 1 (`matched_alop_id` = dosarul, `matched_ciclu_id` = ciclul 1, sumă S) + o linie nouă
   `pending` cu sumă X. `tryAutoConfirmAlop` ⇒ **`matched` cu `plata_suma_efectiva` = X** (nu X+S).
   După: linia arhivată are **același** `match_status`, `matched_ciclu_id` și notă ca înainte.
6. Aceeași configurație cu o linie arhivată `unmatched` (pointer spre dosar) ⇒ la fel, neabsorbită.

**C — rematch**
7. ⭐ Import cu o linie `partial` arhivată (ciclu setat) + o linie `unmatched` curentă.
   `POST /api/opme/imports/:id/rematch` ⇒ linia arhivată **neatinsă** (status, notă, ambii
   pointeri); linia curentă reevaluată.
8. Același lucru pe `POST /api/opme/rematch-all`.

**D — `_markLine`**
9. ⭐ Linie `pending` cu `matched_alop_id` rămas (stale), niciun dosar în plată pentru triplet.
   `matchImport` ⇒ `unmatched` cu **`matched_alop_id` NULL și `matched_ciclu_id` NULL**.

**E — raportul**
10. `GET /api/opme/imports/:id` întoarce `alop_status` pe fiecare linie legată de un dosar (și
    `null` pe cele nelegate).

**F — cap-coadă**
11. ⭐⭐ Secvența din producție: dosar cu ciclul 1 arhivat conținând linii `partial`; rematch pe
    importul lor; încercare de acceptare pe dosarul aflat în `ordonantare` (409); dosarul trece în
    `plata` cu ORD curent = X; sosește un OP nou = X ⇒ confirmat cu **exact X**, liniile ciclului 1
    neatinse.

## T.1 — rulare pe codul nereparat

```bash
git stash list   # notează starea
npx vitest run --config vitest.config.db.mjs server/tests/db/opme-ciclu-arhivat.test.mjs
```

⭐ **Raportează lista testelor roșii ÎNAINTE de a scrie o linie de cod.** Așteptat roșii: 1, 2, 3, 5,
(6), 7, 8, 9, 10, 11. Verzi: 4. Dacă 5 e verde pe codul nereparat, seed-ul nu reproduce
reabsorbția (cel mai probabil IBAN-ul sau tripletul liniei arhivate diferă de ORD) — **repară
seed-ul, nu testul**. Un test de regresie care n-a fost niciodată roșu nu dovedește nimic.

---

# ETAPA A — `_markLine` golește pointerii

`server/services/opme-matcher.mjs`.

`old_str`:
```js
    UPDATE opme_lines SET match_status=$2, match_notes=$3 WHERE id=$1
```
`new_str`:
```js
    UPDATE opme_lines SET match_status=$2, match_notes=$3, matched_alop_id=NULL, matched_ciclu_id=NULL WHERE id=$1
```

Deasupra funcției (în JS, nu în SQL), un comentariu scurt: `_markLine` e chemat doar cu
`unmatched`/`ambiguous` — o linie nepotrivită nu mai arată spre niciun dosar; pointerul rămas era cel
care făcea dialogul de acceptare să preselecteze un dosar aflat în altă fază (#213, RATBV).

⛔ Prefixul `UPDATE opme_lines SET match_status=$2` și ordinea parametrilor rămân identice.

---

# ETAPA B — agregarea ignoră liniile arhivate

`server/services/opme-matcher.mjs`, `_processAlop`.

`old_str`:
```js
             AND match_status IN ('pending','unmatched','partial')
             AND (matched_alop_id IS NULL OR matched_alop_id = $3))
```
`new_str`:
```js
             AND match_status IN ('pending','unmatched','partial')
             AND matched_ciclu_id IS NULL
             AND (matched_alop_id IS NULL OR matched_alop_id = $3))
```

Comentariul explicativ merge în blocul de comentarii JS de deasupra `client.query` (cel care începe
cu `// (b) toate liniile pending/unmatched/partial`), o frază: o linie legată de un ciclu arhivat
aparține acelui ciclu și nu intră în suma ciclului curent (#213).

Verificare:
```bash
grep -c "AND matched_ciclu_id IS NULL" server/services/opme-matcher.mjs
# Așteptat: valoarea din Etapa 0 + 1.
# ⚠️ Dacă ai pus în comentariu exact fragmentul „AND matched_ciclu_id IS NULL", numărătoarea iese +2.
#    Reformulează comentariul, nu ajusta așteptarea.
```

---

# ETAPA C — rematch-ul nu redeschide istoria

`server/routes/opme.mjs`, **două** locuri.

**C.1 — rematch pe un import.** `old_str`:
```js
         AND match_status IN ('unmatched','ambiguous','partial')
    `, [importId, actor.orgId]);
```
`new_str`:
```js
         AND match_status IN ('unmatched','ambiguous','partial')
         AND matched_ciclu_id IS NULL
    `, [importId, actor.orgId]);
```

**C.2 — rematch-all.** `old_str`:
```js
             AND match_status IN ('unmatched','ambiguous','partial')
        `, [imp.id, actor.orgId]);
```
`new_str`:
```js
             AND match_status IN ('unmatched','ambiguous','partial')
             AND matched_ciclu_id IS NULL
        `, [imp.id, actor.orgId]);
```

Actualizează comentariul JS de deasupra lui C.1 („Re-deschide pending pentru toate liniile care NU
sunt deja …"): liniile legate de un ciclu arhivat sunt istorie și rămân neatinse (#213). ⛔ Fără
`'auto'`/`'manual'` între apostrofuri **în SQL**.

---

# ETAPA D — poarta pe acceptare

`server/routes/opme.mjs`, ruta `POST /api/opme/lines/:id/accept`.

**D.1 — încarcă ciclul liniei.** `old_str`:
```js
      `SELECT id, org_id, nr_op, suma_op, match_status, match_notes, matched_alop_id
         FROM opme_lines WHERE id=$1 AND org_id=$2 FOR UPDATE`,
```
`new_str`:
```js
      `SELECT id, org_id, nr_op, suma_op, match_status, match_notes, matched_alop_id, matched_ciclu_id
         FROM opme_lines WHERE id=$1 AND org_id=$2 FOR UPDATE`,
```

**D.2 — cele două refuzuri**, imediat după verificarea `deja_potrivita`. `old_str`:
```js
    // 3. Doar linii respinse/parțiale/ambigue. Una deja potrivită ('auto'/'manual') ⇒ 409.
    if (!['unmatched', 'partial', 'ambiguous'].includes(line.match_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'deja_potrivita', match_status: line.match_status });
    }
```
`new_str`:
```js
    // 3. Doar linii respinse/parțiale/ambigue. Una deja potrivită ('auto'/'manual') ⇒ 409.
    if (!['unmatched', 'partial', 'ambiguous'].includes(line.match_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'deja_potrivita', match_status: line.match_status });
    }

    // 3b. #213 — o linie legată de un ciclu ARHIVAT e istorie: acceptarea ar pune
    //     matched_ciclu_id = NULL și ar muta plata pe ciclul curent (incident RATBV, 16.09.2026).
    if (line.matched_ciclu_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'linie_ciclu_arhivat',
        message: 'Linia aparține unui ciclu de plată deja arhivat și nu se mai poate accepta pe dosar.',
      });
    }

    // 3c. #213 — doar pe un dosar al cărui ciclu curent e în faza de plată: `plata`, sau
    //     `completed` (plată confirmată în ciclul curent — calea de corectare #209, urmată de
    //     „Reia confirmarea plății"). În lichidare/ordonanțare, orice OP existent aparține unui
    //     ciclu anterior; acceptat aici, ar fi adunat la plata ciclului care urmează.
    //     ⛔ Legarea unei plăți de un ciclu închis NU se face din aplicație (decizie de produs).
    if (!['plata', 'completed'].includes(alop.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'dosar_nu_e_in_plata',
        status: alop.status,
        message: 'Dosarul nu este în faza de plată. O plată OPME se acceptă doar pe un dosar în plată '
          + 'sau cu plata confirmată în ciclul curent. Dacă OP-ul aparține unui ciclu deja închis, '
          + 'nu se acceptă din aplicație.',
      });
    }
```

⚠️ Verifică numele real al variabilei cu rândul ALOP în rută (în codul actual: `alop`, din
`aRows[0]`). Dacă diferă, folosește-l pe cel real și raportează.

⛔ Ordinea porților rămâne: tenant (404) → rol (403) → status linie (409 `deja_potrivita`) → 3b → 3c.
Un utilizator fără drept primește în continuare 403, nu 409 — nu dezvăluim faza dosarului.

⛔ Pasul 5 (`matched_ciclu_id=NULL` în UPDATE-ul de acceptare) **rămâne**. După 3b, linia acceptată
are oricum ciclul NULL; resetarea e acum inofensivă și păstrează forma testată.

---

# ETAPA E — raportul expune faza dosarului

`server/routes/opme.mjs`, ruta `GET /api/opme/imports/:id` (interogarea liniilor).

`old_str`:
```js
        l.matched_alop_id, l.matched_ciclu_id, l.matched_at,
        l.match_status, l.match_notes,
        a.titlu AS alop_titlu,
```
`new_str`:
```js
        l.matched_alop_id, l.matched_ciclu_id, l.matched_at,
        l.match_status, l.match_notes,
        a.titlu AS alop_titlu,
        a.status AS alop_status,
```

⚠️ Același `a.titlu AS alop_titlu,` apare și în exportul CSV (`:~719`). `old_str`-ul de mai sus e
lărgit ca să fie unic — **nu** atinge exportul CSV.

---

# ETAPA F — dialogul nu mai oferă ce serverul refuză

`public/js/components/opme-report-drawer.js`. Serverul e poarta; asta e doar ca utilizatorul să nu
fie invitat spre un 409. Divergența între cele două nu e tăcută: dialogul afișează deja `j.message`.

**F.1 — butonul „Acceptă potrivirea" nu apare pe linii arhivate.** `old_str`:
```js
                ${canAccept ? `<td>${ACCEPTABLE[l.match_status]
```
`new_str`:
```js
                ${canAccept ? `<td>${(ACCEPTABLE[l.match_status] && !l.matched_ciclu_id)
```

**F.2 — preselectarea doar pentru un dosar în faza de plată.** `old_str`:
```js
    // Dosarele în faza de plată (+ cel deja legat, dacă e în altă fază — ex. confirmat greșit).
    const opts = [];
    const seen = new Set();
    if (line.matched_alop_id) {
      opts.push({ id: line.matched_alop_id, label: `${line.alop_titlu || line.df_nr || line.matched_alop_id.slice(0, 8)} (legat de matcher)` });
      seen.add(line.matched_alop_id);
    }
```
`new_str`:
```js
    // Dosarele în faza de plată (+ cel deja legat, DOAR dacă e în plată sau confirmat în ciclul
    // curent — calea de corectare #209). #213: înainte se oferea indiferent de fază, iar o plată
    // dintr-un ciclu închis ajungea pe ciclul curent (incident RATBV). Aceeași regulă ca poarta
    // rutei (opme.mjs, pasul 3c); serverul rămâne poarta.
    const opts = [];
    const seen = new Set();
    const preLegat = !!line.matched_alop_id && !line.matched_ciclu_id
      && ['plata', 'completed'].includes(line.alop_status);
    if (preLegat) {
      opts.push({ id: line.matched_alop_id, label: `${line.alop_titlu || line.df_nr || line.matched_alop_id.slice(0, 8)} (legat de matcher)` });
      seen.add(line.matched_alop_id);
    }
```

**F.3** — `old_str`:
```js
    if (line.matched_alop_id) sel.value = line.matched_alop_id;
```
`new_str`:
```js
    if (preLegat) sel.value = line.matched_alop_id;
```

⛔ `fetch`-urile din fișier **nu** se migrează pe `DFApi` aici — e lot separat. Nu atinge nimic
altceva din fișier.

---

# ETAPA G — documentația

`docs/docs-plati-transe-conturi-diferite.md`.

**G.1 — cine poate** (documentul contrazice codul de la #210). `old_str`:
```
**Doar responsabilul CAB** — membru al compartimentului CAB al organizației. Nu inițiatorul, nu
un coleg de compartiment, nu administratorul de organizație doar pentru că e administrator.
```
`new_str`:
```
**Responsabilul CAB** — membru al compartimentului CAB al organizației — **sau un administrator**
(administratorul platformei ori administratorul organizației; lărgire introdusă la #210). Nu
inițiatorul, nu un coleg de compartiment.
```

**G.2 — limita nouă.** După paragraful care începe cu `⭐ Nota originală de respingere **se
păstrează**` (în calea A), adaugă:

```
⚠️ **Dosarul trebuie să fie în faza de plată** — în starea „plată" sau cu plata confirmată în
ciclul curent. Un dosar trecut deja la ciclul următor (în lichidare sau ordonanțare) nu apare în
listă, iar serverul refuză acceptarea. Motivul: orice OP existent aparține atunci unui ciclu
anterior; acceptat pe dosar, ar fi adunat la plata ciclului care urmează.

Liniile care aparțin unui **ciclu arhivat** nu mai au butonul „Acceptă potrivirea" și nu sunt
redeschise de „Re-rulează matching". Dacă o plată trebuie legată de un ciclu închis, nu se face din
aplicație: se tratează separat, cu script SQL (precedent: SQL-213d, dosarul RATBV, 16.09.2026).
```

---

# ETAPA H — teste complete

```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/opme-ciclu-arhivat.test.mjs
# Toate verzi.

npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`. `npm test` verde, fără regresii.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge**, cu numele testului și
aserțiunea. Candidații previzibili sunt mock-urile din Etapa 0; dacă pică unul, aproape sigur ai
modificat un fragment de SQL pe care îl ancorează — **repară patch-ul, nu testul**.

⭐ Neregresie obligatorie, citată în raport cu rezultatul: `opme-accept-linie.test.mjs` (toate),
`plata-reia-confirmare.test.mjs` **13 și 13b** (calea 8836), `opme-accept-poarta.test.mjs`,
`capabilitati-vs-porti.test.mjs`, `opme-per-group-isolation.test.mjs`, `opme-match-iban.test.mjs`.

---

# ETAPA I — versiune, cache, commit

```bash
npm version 3.9.866 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json   # ≤ 4 linii

grep -n "opme-report-drawer.js?v=" public/*.html
NEW=3.9.866
sed -i -E "s#(opme-report-drawer\.js\?v=)[0-9.]+#\1${NEW}#g" public/formular.html
grep -n "opme-report-drawer.js?v=" public/formular.html
# ⭐ Verifică linia <script> ÎNTREAGĂ după sed — un tag corupt nu pică niciun test.
```

⛔ Fără `sed` în masă pe `?v=`. `CACHE_VERSION` **doar** dacă `opme-report-drawer.js` e în
`PRECACHE_ASSETS` — decizia și dovada prin grep, în raport.

```bash
git status --short
```

`git add` **explicit**, fișier cu fișier. Arhivează promptul ca
`docs/archive/PROMPT-213-opme-ciclu-arhivat.md`, în același commit.

Dacă în `docs/archive/sql/` există (puse de Mircea) `SQL-213-masuratori-post-865.sql`,
`SQL-213b-opme-cicluri-ratbv.sql`, `SQL-213c-ratbv-cicluri-si-morani.sql`,
`SQL-213d-reparatie-ratbv-ciclu2.sql` și sunt netrackate, adaugă-le. Dacă lipsesc, spune-o.

```
fix(#213): OPME — platile din cicluri inchise nu mai ajung pe ciclul curent — v3.9.866

Incident productie 16.09.2026, dosarul RATBV: trei OP-uri din august
(2666-2668, 32.852,00), plata ciclului 2 deja confirmat manual, au fost
acceptate din raportul OPME pe dosarul aflat in ordonantare (ciclul 4).
Acceptarea le-a pus matched_ciclu_id = NULL. La intrarea ciclului 4 in plata,
matcher-ul le-ar fi adunat la OP-urile din septembrie. Datele au fost reparate
manual (SQL-213d); lotul inchide calea.

Patru verigi, fiecare inofensiva singura:
- rematch si rematch-all redeschideau linii legate de cicluri arhivate
- _markLine lasa matched_alop_id pe o linie trecuta pe unmatched, iar
  dialogul preselecta dosarul indiferent de faza lui
- acceptarea nu verifica nici faza dosarului, nici ciclul liniei
- _processAlop nu filtra ciclul pe ramura pending/unmatched/partial, deci o
  linie partiala arhivata era reabsorbita in suma ciclului urmator

Regula: o linie legata de un ciclu arhivat e istorie. Acceptarea doar pe
dosar in plata sau completed (calea #209 de corectare ramane). Legarea unei
plati de un ciclu inchis nu se face din aplicatie (decizie de produs).

Teste scrise intai si rulate rosii pe codul nereparat.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE** (inclusiv apelurile `_markLine` și statusurile ALOP).
2. ⭐ Lista testelor din `opme-ciclu-arhivat.test.mjs` **roșii pe codul nereparat** (T.1). Dacă vreunul
   așteptat roșu a fost verde, ce ai schimbat în seed.
3. ⭐ Pentru testul 5: suma cu care s-ar fi confirmat pe codul vechi (X+S, overpay sau altceva) —
   dovada că reabsorbția era reală.
4. `git diff` pe fiecare fișier modificat, scurt. ⭐ Confirmarea că fragmentele SQL ancorate de
   mock-uri au rămas identice caracter cu caracter.
5. Rezultatul verificării `grep -c "AND matched_ciclu_id IS NULL"` (Etapa B).
6. Rezultatul fiecărui test nou și al testelor de neregresie numite în Etapa H, **în special 13 și 13b**.
7. Teste preexistente atinse, cu diff și motiv (așteptat: niciunul).
8. Numere reale `npm test` și `npm run test:db`, secvențial, cu sursa verdictului declarată.
9. `?v=` și `CACHE_VERSION`: decizia și dovada prin grep; linia `<script>` completă după sed.
10. Documentația: G.1 și G.2 aplicate; fișierele SQL-213* găsite sau nu.
11. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
12. Colaterale observate (ex. alte locuri care scriu `matched_ciclu_id = NULL`), **nereparate**.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy. `git push origin develop`, apoi **stop**.
- **Zero scrieri de date, zero migrații.** Reparația de producție e deja făcută (SQL-213d).
- Testele din Etapa T se scriu și se rulează **înainte** de patch-uri; lista roșiilor se raportează.
- Fragmentele SQL ancorate de mock-uri rămân **caracter cu caracter**; condiții noi doar pe linii noi.
- ⛔ Niciun comentariu în SQL cu `'auto'` / `'manual'` între apostrofuri.
- Calea #209 de corectare (acceptare pe dosar `completed` → reluare → reagregare) rămâne verde.
- ⛔ Nu construi o cale de legare a unei plăți de un ciclu închis (decizie de produs).
- ⛔ Nu atinge `noua-lichidare`, `confirma-plata`, `plata/reia`, exportul CSV, `fetch`-urile din drawer.
- ⛔ Zona NO-TOUCH (STS/PAdES) — neatinsă; lotul nu are nicio legătură cu semnarea.
- `?v=` țintit pe `opme-report-drawer.js` în `formular.html`. Fără `sed` în masă.
- `git add` explicit. Niciodată `git add -A` / `git add .`.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
