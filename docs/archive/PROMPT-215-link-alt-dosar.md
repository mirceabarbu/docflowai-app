---
prompt: 215
titlu: "ALOP — un ORD/DF nu mai poate fi legat de alt dosar decât al lui (link-ord, link-df, contextul din browser)"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: "cea din package.json (v3.9.866 în producție; v3.9.867 dacă #214 a rulat deja)"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU (reparația de producție se face manual — SQL-215 R1)
fisiere_din_public: DA — `js/formular/alop.js` ⇒ `?v=` ȚINTIT, `CACHE_VERSION` doar dacă e în PRECACHE
zona_no_touch_atinsa: NU
tip: bugfix de integritate (pointer ALOP → document) + teste care reproduc incidentul
precondiție: "Mircea a rulat SQL-215 Q1–Q4 și R1. Dacă Q3 (DF din alt dosar) NU a dat 0 rânduri, Etapa C se SARE și se raportează."
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
`main` = producție, gestionat manual DOAR de Mircea.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL — incidentul „ORD pe două dosare" (16.09.2026)

Trasabilitatea ORD-ului **47842** (RATBV S.A., 217.526,49) arată ORD-ul pe **două** dosare ALOP:

- „DIFERENTA DE TARIF transport public local" (RATBV), ciclul 4, în ordonanțare — **corect**;
- „CONSUM CARBURANT", ciclul 1, **în lichidare** — **greșit**.

Ambele au `alop_instances.ord_id` = același ORD.

## Mecanismul, verificat pe cod

1. **Un singur loc scrie `ord_id`:** `POST /api/alop/:id/link-ord` (`alop.mjs:~1629`). Singura lui
   gardă e `WHERE … AND (ord_id IS NULL OR ord_id = $1)` — adică „dosarul-țintă n-are încă un ORD".
   **Nu verifică** că ORD-ul aparține dosarului (`formulare_ord.source_alop_id`), că ORD-ul nu e deja
   pe alt dosar, și nici faza dosarului.
2. **Asimetrie cu DF:** `link-df` (`alop.mjs:~1249`) ARE verificarea de conflict (`df_deja_legat`,
   409). `link-ord` nu a primit-o niciodată.
3. **Frontendul cheamă link-ord la FIECARE salvare** (`formular/doc.js` și `list.js` → `_alopLinkDoc`,
   inclusiv autosave-ul cu debounce), cu dosarul luat din **`window._alopContext`** — stare de browser,
   persistată și în `sessionStorage`. Un context rămas de la un dosar deschis anterior leagă ORD-ul
   curent de acel dosar. Dosarul „CONSUM CARBURANT", în lichidare, avea `ord_id` NULL ⇒ garda a trecut.

## De ce e grav

- La lansarea fluxului ORD, `crud.mjs:~627` face `UPDATE alop_instances SET ord_flow_id … WHERE ord_id = $2`
  ⇒ pune fluxul pe **toate** dosarele cu acel ORD.
- La semnare (`signing.mjs:~492`), `SELECT … WHERE ord_flow_id=$1` fără `ORDER BY` și `rows[0]` ⇒
  **doar unul, arbitrar**, trece în plată. Dacă rândul ales e dosarul în lichidare, RATBV rămâne blocat
  în ordonanțare.
- Plafonul bugetar (`resolveAlopIdForBudget`, `formular-shared.mjs:~315`) ia `LIMIT 1` pe `ord_id` ⇒
  poate calcula plafonul ORD-ului pe DF-ul altui dosar.
- Dosarul greșit nu mai poate primi propriul ORD (`ord_id` ocupat).

Datele de producție se repară manual (SQL-215 R1). ⛔ Lotul ăsta **nu** scrie date.

## Regula implementată

O legare **nouă** a unui document la un dosar e refuzată cu 409 când:

| Cod | Condiție |
|---|---|
| `ord_alt_dosar` / `df_alt_dosar` | documentul are `source_alop_id` și acesta **nu** e dosarul-țintă |
| `ord_deja_legat` | ORD-ul e ORD curent pe alt dosar activ **sau** într-un ciclu arhivat al altui dosar |
| `dosar_nu_e_in_ordonantare` | dosarul-țintă nu e în `ordonantare` (ORD-ul se completează doar din ordonanțare) |

„Nouă" = ORD-ul primit diferă de `ord_id` curent al dosarului. Reapelul idempotent (același ORD, deja
legat) trece exact ca azi, în orice fază — altfel autosave-ul unui ORD aprobat, în plată, ar produce
409 la fiecare salvare.

Documentele **fără** `source_alop_id` (vechi) nu pot fi verificate pe proveniență; pentru ele rămân
`ord_deja_legat` și faza.

Frontendul, la aceste coduri, **uită contextul rămas** și nu mai afișează banda roșie care sfătuia
exact greșeala („legați documentul din dosarul ALOP").

---

# ETAPA 0 — ancore (READ-ONLY, raportează valorile OBȚINUTE)

```bash
git branch --show-current
cat package.json | grep '"version"'

grep -rn "SET ord_id\s*=\s*\$\|SET ord_id=\$" server --include=*.mjs | grep -v tests
# Așteptat: UN singur loc — link-ord. ⭐ Dacă mai e unul, RAPORTEAZĂ și OPREȘTE-TE.

grep -n "router.post('/api/alop/:id/link-ord'" server/routes/alop.mjs
grep -n "router.post('/api/alop/:id/link-df'" server/routes/alop.mjs
grep -n "df_deja_legat" server/routes/alop.mjs
grep -n "source_alop_id" server/db/index.mjs | grep -i "formulare_ord\|formulare_df" | head

grep -n "_alopContext" public/js/formular/*.js
grep -n "async function _alopLinkDoc" -A30 public/js/formular/alop.js

grep -rn "link-ord\|link-df'" server/tests --include=*.mjs | grep -v "link-ord-flow\|link-df-flow"
# Cunoscut: db/alop-progresie-stari.test.mjs (link-df din draft, link-ord din ordonantare, pe
# documente seedate FĂRĂ source_alop_id). ⭐ Trebuie să rămână verde neatins.

grep -n "js/formular/alop.js" public/*.html public/sw.js
```

---

# ⭐ ETAPA T — testele ÎNTÂI, pe codul NEREPARAT

`server/tests/db/alop-link-alt-dosar.test.mjs` (nou). Seed-urile după `alop-progresie-stari.test.mjs`
și `opme-accept-linie.test.mjs`. Două dosare în aceeași organizație: **A** („RATBV") și **B**
(„CONSUM CARBURANT"). Pentru `source_alop_id` pe ORD/DF, extinde seed-ul **în fișierul nou**.

**link-ord**
1. ⭐⭐ Reproducerea exactă: ORD cu `source_alop_id = A`, legat de A (A în `ordonantare`); B în
   `lichidare`, `ord_id` NULL. `link-ord(B, ORD)` ⇒ **409 `ord_alt_dosar`**. B neatins
   (`ord_id` NULL, `updated_at` neschimbat).
2. B în `ordonantare`, ORD cu `source_alop_id = A` ⇒ **409 `ord_alt_dosar`**.
3. ORD **fără** proveniență, legat de A; B în `ordonantare` ⇒ **409 `ord_deja_legat`**.
4. ORD fără proveniență, aflat doar într-un **ciclu arhivat** al lui A (`alop_ord_cicluri`); B în
   `ordonantare` ⇒ **409 `ord_deja_legat`**.
5. ORD fără proveniență, liber; B în `lichidare` ⇒ **409 `dosar_nu_e_in_ordonantare`**.
6. Neregresie: ORD cu `source_alop_id = A`, liber, A în `ordonantare` ⇒ 200, `ord_id` setat.
7. ⭐ Neregresie idempotență: A în **`plata`** cu `ord_id` = ORD; `link-ord(A, același ORD)` ⇒ 200.
8. Neregresie documente vechi: ORD fără proveniență, liber, A în `ordonantare` ⇒ 200.
9. ⭐ Consecința evitată: după 1, un flux lansat cu `meta.ordId = ORD` (via `POST /flows`, ca în
   `flow-link-audit.test.mjs`) pune `ord_flow_id` **doar** pe A.

**link-df**
10. ⭐ DF cu `source_alop_id = A`; B în `draft`, `df_id` NULL ⇒ **409 `df_alt_dosar`**; B rămâne
    **`draft`** (UPDATE-ul de azi l-ar fi mutat și în `angajare`).
11. Neregresie: DF cu `source_alop_id = B` ⇒ 200, B în `angajare`.
12. Neregresie #185: o revizie a aceluiași dosar (`source_alop_id = A`), A pointând spre R0 ⇒ 200
    `noop: 'revizie_in_lucru'`. (Dacă `link-df-revizie` sau echivalentul acoperă deja exact asta,
    trimite la el în comentariu, nu duplica.)

**Rulare pe codul nereparat:**
```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/alop-link-alt-dosar.test.mjs
```
⭐ **Raportează roșiile ÎNAINTE de patch.** Așteptat roșii: 1, 2, 3, 4, 5, 9, 10. Verzi: 6, 7, 8, 11,
12. Dacă 1 e verde pe codul vechi, seed-ul nu reproduce incidentul — repară seed-ul, nu testul.

---

# ETAPA A — link-ord

`server/routes/alop.mjs`, ruta `POST /api/alop/:id/link-ord`.

`old_str`:
```js
    const { rows: ordRows } = await pool.query(
      'SELECT id FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [ord_id, actor.orgId]
    );
    if (!ordRows[0]) return res.status(404).json({ error: 'ord_not_found' });
```
`new_str`:
```js
    const { rows: ordRows } = await pool.query(
      'SELECT id, source_alop_id FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [ord_id, actor.orgId]
    );
    if (!ordRows[0]) return res.status(404).json({ error: 'ord_not_found' });

    // #215 — gărzi DOAR pentru o legare NOUĂ. Incident 16.09.2026: ORD 47842 (RATBV) a ajuns
    // și pe dosarul „CONSUM CARBURANT", aflat în lichidare. Frontendul cheamă link-ord la
    // fiecare salvare cu dosarul reținut în browser; singura gardă era „dosarul-țintă n-are
    // încă un ORD". Reapelul idempotent (același ORD deja legat) trece ca înainte, în orice
    // fază — autosave-ul unui ORD aprobat nu trebuie să producă 409.
    const _ordLegatDeja = String(alopRows[0].ord_id || '').toLowerCase() === String(ord_id).toLowerCase();
    if (!_ordLegatDeja) {
      // (a) Proveniența: un ORD creat dintr-un dosar aparține acelui dosar.
      const _src = ordRows[0].source_alop_id;
      if (_src && String(_src).toLowerCase() !== String(req.params.id).toLowerCase()) {
        logger.warn({ alopId: req.params.id, ordId: ord_id, sourceAlopId: _src },
          '[ALOP] link-ord REFUZAT: ORD-ul aparține altui dosar (#215)');
        return res.status(409).json({
          error: 'ord_alt_dosar',
          message: 'Această ordonanțare aparține altui dosar ALOP.',
        });
      }
      // (b) Conflict — simetric cu `df_deja_legat` din link-df: ORD curent pe alt dosar activ,
      //     sau ORD dintr-un ciclu arhivat al altui dosar.
      const { rows: _conflict } = await pool.query(
        `SELECT 1 FROM alop_instances
          WHERE ord_id = $1 AND id <> $2 AND cancelled_at IS NULL
         UNION ALL
         SELECT 1 FROM alop_ord_cicluri
          WHERE ord_id = $1 AND alop_id <> $2
         LIMIT 1`,
        [ord_id, req.params.id]
      );
      if (_conflict.length) {
        logger.warn({ alopId: req.params.id, ordId: ord_id },
          '[ALOP] link-ord REFUZAT: ORD-ul e deja pe alt dosar (#215)');
        return res.status(409).json({
          error: 'ord_deja_legat',
          message: 'Această ordonanțare este deja asociată unui alt dosar ALOP.',
        });
      }
      // (c) Faza: ORD-ul se completează doar din ordonanțare.
      const { rows: _st } = await pool.query(
        'SELECT status FROM alop_instances WHERE id=$1 AND org_id=$2',
        [req.params.id, actor.orgId]
      );
      if (_st[0]?.status !== 'ordonantare') {
        return res.status(409).json({
          error: 'dosar_nu_e_in_ordonantare',
          status: _st[0]?.status || null,
          message: 'Dosarul ALOP nu este în faza de ordonanțare.',
        });
      }
    }
```

⚠️ Ordinea porților rămâne: tenant/404 → autorizare (403) → ORD inexistent (404) → gărzile #215.
⛔ UPDATE-ul cu `(ord_id IS NULL OR ord_id = $1)` **rămâne** — e a doua linie de apărare la o cursă.
⛔ SELECT-ul inițial pe `alop_instances` **nu se modifică**: același text apare identic în link-df.

---

# ETAPA B — `crud.mjs`: nimic

⛔ `UPDATE alop_instances SET ord_flow_id … WHERE ord_id = $2` (`crud.mjs:~627`) **nu se atinge**.
Cu Etapa A, un ORD nu mai poate fi pe două dosare, deci UPDATE-ul atinge un singur rând. Raportează-l
la colaterale.

---

# ETAPA C — link-df (DOAR dacă precondiția Q3 = 0 e confirmată în header)

`server/routes/alop.mjs`, ruta `POST /api/alop/:id/link-df`.

`old_str`:
```js
    const { rows: dfRows } = await pool.query(
      'SELECT id FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [df_id, actor.orgId]
    );
    if (!dfRows[0]) return res.status(404).json({ error: 'df_not_found' });
```
`new_str`:
```js
    const { rows: dfRows } = await pool.query(
      'SELECT id, source_alop_id FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [df_id, actor.orgId]
    );
    if (!dfRows[0]) return res.status(404).json({ error: 'df_not_found' });

    // #215 — proveniența, simetric cu link-ord. Un DF creat dintr-un dosar (orice revizie a
    // lui păstrează `source_alop_id`) nu se leagă de alt dosar. Fără gardă, un context rămas
    // în browser lega o revizie în lucru a dosarului A de un dosar B nou (df_id NULL) și îl
    // muta pe B din `draft` în `angajare`. DF-urile vechi, fără proveniență, trec ca înainte.
    {
      const _src = dfRows[0].source_alop_id;
      if (_src && String(_src).toLowerCase() !== String(req.params.id).toLowerCase()) {
        logger.warn({ alopId: req.params.id, dfId: df_id, sourceAlopId: _src },
          '[ALOP] link-df REFUZAT: DF-ul aparține altui dosar (#215)');
        return res.status(409).json({
          error: 'df_alt_dosar',
          message: 'Acest Document de Fundamentare aparține altui dosar ALOP.',
        });
      }
    }
```

⚠️ Verificarea `df_deja_legat` de mai jos și ramura #185 rămân **neatinse**.

---

# ETAPA D — frontend: contextul rămas se uită, fără bandă roșie

`public/js/formular/alop.js`, în `_alopLinkDoc`.

**D.1 — setul de coduri**, imediat înainte de `async function _alopLinkDoc(ft, docId){`:
```js
// #215 — coduri cu care serverul refuză legarea unui document de ALT dosar decât al lui.
// Apar când `window._alopContext` a rămas de la un dosar deschis anterior.
const _LINK_ALT_DOSAR = new Set(['ord_alt_dosar', 'ord_deja_legat', 'df_alt_dosar', 'df_deja_legat', 'dosar_nu_e_in_ordonantare']);
```
⚠️ Verifică să nu existe deja un identificator `_LINK_ALT_DOSAR` în scope și locul exact (funcția e în
IIFE-ul fișierului). Raportează linia.

**D.2 — tratarea.** `old_str`:
```js
    else{
      console.warn(`ALOP ${endpoint} warn:`,j.error);
```
`new_str`:
```js
    else{
      console.warn(`ALOP ${endpoint} warn:`,j.error);
      // #215 — documentul nu aparține dosarului reținut în browser. Serverul a refuzat corect;
      // banda roșie de mai jos ar sfătui exact greșeala („legați documentul din dosarul ALOP").
      // Uităm contextul, ca salvările următoare (autosave) să nu mai încerce legarea.
      if(r.status===409&&_LINK_ALT_DOSAR.has(j.error)){
        window._alopContext=null;
        try{sessionStorage.removeItem('_alopContext');}catch(_){}
        setS(`Documentul a fost salvat. Nu a fost atașat dosarului ALOP deschis anterior: ${esc(j.message||j.error)}`,'info');
        return;
      }
```

⛔ Restul funcției, `alopLaunchOrdFlow`, `list.js:~677` (curățarea contextului la schimbarea de tab)
— **neatinse**. Nu reproiecta ciclul de viață al contextului în lotul ăsta.

---

# ETAPA E — suitele

```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/alop-link-alt-dosar.test.mjs
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**. `skipped` ≠ `passed`. `npm test` verde, fără regresii.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge**, cu numele și aserțiunea.
Candidat previzibil: un test care leagă un ORD de un dosar aflat în altă fază decât `ordonantare`,
sau care seedează două dosare pe același ORD. Dacă apare, e posibil ca **testul** să codifice exact
bug-ul — descrie-l, nu-l schimba.

⭐ Neregresie citată: `alop-progresie-stari.test.mjs` (link-df din draft, link-ord din ordonantare),
testele #185 (revizie în lucru), `flow-link-audit.test.mjs`.

---

# ETAPA F — versiune, cache, commit

```bash
# versiunea țintă = următorul patch după cea din package.json
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json   # ≤ 4 linii

grep -n "js/formular/alop.js?v=" public/formular.html
NEW=<TINTA>
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\1${NEW}#g" public/formular.html
grep -n "js/formular/alop.js?v=" public/formular.html
# ⭐ linia <script> ÎNTREAGĂ după sed.
```
`CACHE_VERSION` doar dacă `js/formular/alop.js` e în `PRECACHE_ASSETS` — dovada prin grep în raport.

`git add` explicit. Arhivează promptul ca `docs/archive/PROMPT-215-link-alt-dosar.md`. Dacă
`docs/archive/sql/SQL-215-ord-legat-de-doua-dosare.sql` există netrackat, adaugă-l.

```
fix(#215): ALOP — un ORD/DF nu mai poate fi legat de alt dosar decat al lui — v<TINTA>

Incident 16.09.2026: ORD 47842 (RATBV) aparea pe doua dosare, RATBV (corect)
si CONSUM CARBURANT (in lichidare, gresit). link-ord era singurul scriitor al
lui alop_instances.ord_id si verifica doar ca dosarul-tinta n-are inca un ORD.
Frontendul il cheama la fiecare salvare, cu dosarul retinut in browser.

Consecinte evitate: la lansarea fluxului, ord_flow_id ajungea pe ambele dosare,
iar la semnare doar unul, arbitrar, trecea in plata; plafonul bugetar putea fi
calculat pe DF-ul altui dosar.

- link-ord: 409 ord_alt_dosar (proveniența), ord_deja_legat (simetric cu
  df_deja_legat, inclusiv cicluri arhivate), dosar_nu_e_in_ordonantare
- link-df: 409 df_alt_dosar (proveniența)
- reapelul idempotent trece ca inainte; documentele fara provenienta trec pe
  conflict si faza
- frontend: la aceste coduri contextul ramas in browser se uita, fara banda rosie

Datele de productie reparate manual (SQL-215 R1). Teste scrise intai, rulate
rosii pe codul nereparat.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE** — în special unicitatea scriitorului `ord_id`.
2. ⭐ Roșiile pe codul nereparat.
3. Dacă Etapa C a rulat sau a fost sărită (precondiția Q3).
4. Rezultatul fiecărui test nou, **în special 1, 7, 9, 10**.
5. Teste preexistente atinse (așteptat: niciunul), cu diff și motiv.
6. Numere reale `npm test` și `npm run test:db`, secvențial, cu sursa verdictului.
7. `?v=` și `CACHE_VERSION`: decizia și dovada.
8. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
9. Colaterale observate, **nereparate**. Cunoscute:
   - `crud.mjs:~627` actualizează `ord_flow_id` pe TOATE dosarele cu `ord_id` dat;
   - `signing.mjs:~492` ia `rows[0]` fără `ORDER BY`;
   - `resolveAlopIdForBudget` ia `LIMIT 1` pe `ord_id`;
   - `list.js:~677` nu curăță contextul la trecerea pe tab-urile DF/ORD;
   - lipsa unui index unic parțial pe `alop_instances(ord_id)` pentru dosarele active.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy. `git push origin develop`, apoi **stop**.
- **Zero migrații, zero scrieri de date.**
- Testele se scriu și se rulează **înainte** de patch-uri; roșiile se raportează.
- Gărzile se aplică DOAR la legare nouă; reapelul idempotent rămâne neschimbat.
- ⛔ `crud.mjs`, `signing.mjs`, `lifecycle.mjs`, `formular-shared.mjs`, `trasabilitate.mjs` — neatinse.
- ⛔ SELECT-ul inițial pe `alop_instances` din link-ord/link-df — neatins (text identic în ambele).
- ⛔ Zona NO-TOUCH (STS/PAdES) — neatinsă.
- `?v=` țintit. Fără `sed` în masă. `git add` explicit.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
