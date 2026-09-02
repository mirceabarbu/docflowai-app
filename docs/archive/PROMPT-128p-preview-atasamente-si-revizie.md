# PROMPT #128p — preview atașamente pe toate blocurile + câmpul „Revizuirea" editabil

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 5 · **Target versiune:** `v3.9.776` (de la 3.9.775 — **citește
`package.json`**) · **Migrații:** ZERO

Două defecte independente, în etape separate. Nu le amesteca într-un singur commit logic:
Etapa A e o numărătoare falsă la crearea fluxului, Etapa B e un câmp blocat inutil.

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## ETAPA A — preview-ul atașamentelor arată doar primul furnizor

### A.1 Simptomul, raportat de Mircea pe staging

La crearea fluxului dintr-un ORD cu doi furnizori, blocul „**Vor fi preluate din formular**"
scrie **1 fișier(e)** și listează unul singur. După lansare, în pagina de semnare apar **toate**
fișierele. Nimic nu se pierde — dar utilizatorul crede că i-au rămas anexe pe dinafară și le
încarcă manual încă o dată.

### A.2 Cauza, verificată pe cod

`public/js/semdoc-initiator/main.js` (~2148) cere lista cu `?slot=1` și `?slot=2`, **fără
`?bloc`**. După #128m, ruta de listare filtrează `COALESCE(bloc_idx, 0) = 0` când parametrul
lipsește ⇒ întoarce exact atașamentele blocului 0.

Copierea reală (`services/formular-flow-attachments.mjs::copyFormularAttachmentsToFlow`) **NU**
filtrează pe slot sau bloc ⇒ transferă tot. Deci preview-ul e mai îngust decât realitatea:
o divergență de afișare, nu o pierdere de date. ⛔ **Nu atinge funcția de copiere** — e corectă.

### A.3 Server — `?bloc=all` (`server/routes/formulare/shared.mjs`, ruta GET de LISTARE)

⛔ Numai ruta de **listare** (`GET /api/formulare-atasamente/:type/:id`). ⛔ NU `_blocIdx` însuși,
⛔ NU ruta de upload, ⛔ NU rutele de capturi, ⛔ NU descărcarea per atașament.

`old_str`:
```js
    // #128m: filtrare per bloc de furnizor. Cerere FĂRĂ `?bloc` ⇒ blocul 0 — exact lista
    // pe care o vede clientul de azi (rândurile legacy au bloc_idx NULL ⇒ tot blocul 0).
    const blocIdx = _blocIdx(req);

    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, slot, COALESCE(bloc_idx, 0) AS bloc_idx, created_at
       FROM formulare_atasamente
       WHERE form_type=$1 AND form_id=$2 AND slot=$3 AND COALESCE(bloc_idx, 0)=$4 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [type, id, slot, blocIdx]
    );
```
`new_str`:
```js
    // #128m: filtrare per bloc de furnizor. Cerere FĂRĂ `?bloc` ⇒ blocul 0 — exact lista
    // pe care o vede clientul de azi (rândurile legacy au bloc_idx NULL ⇒ tot blocul 0).
    // #128p: `?bloc=all` ⇒ TOATE blocurile, într-o singură cerere. Necesar la crearea
    // fluxului, unde preview-ul trebuie să arate exact ce copiază
    // `copyFormularAttachmentsToFlow`, care e bloc-agnostică. Fără el, preview-ul spunea
    // „1 fișier(e)" iar în pachetul de semnare apăreau toate — divergență de afișare.
    // Pattern null-tolerant (ca la #105g): $4 NULL ⇒ predicatul nu filtrează, fără reindexare.
    const totBlocurile = req.query.bloc === 'all';
    const blocIdx = _blocIdx(req);

    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, slot, COALESCE(bloc_idx, 0) AS bloc_idx, created_at
       FROM formulare_atasamente
       WHERE form_type=$1 AND form_id=$2 AND slot=$3
         AND ($4::int IS NULL OR COALESCE(bloc_idx, 0) = $4)
         AND deleted_at IS NULL
       ORDER BY COALESCE(bloc_idx, 0) ASC, created_at ASC`,
      [type, id, slot, totBlocurile ? null : blocIdx]
    );
```

⚠️ `ORDER BY` primește un termen nou. Pe calea normală (un singur bloc filtrat) ordinea din
interiorul blocului rămâne `created_at ASC`, deci **niciun consumator existent nu vede
altceva**. Confirmă asta explicit în raport.

⚠️ Autorizarea rămâne **exact** cea de dinainte (`canViewFormular` deasupra). `?bloc=all` nu
lărgește accesul: întoarce atașamente ale unui document pe care actorul îl poate deja citi.
⛔ Nu atinge nicio linie de authz.

### A.4 Client (`public/js/semdoc-initiator/main.js`, funcția `_renderFormAttachments`)

**A.4.a** — cele două cereri primesc `&bloc=all`:

`old_str`:
```js
              const r = await _apiFetch(`/api/formulare-atasamente/${ft}/${encodeURIComponent(_docId)}?slot=${slot}`, { method: 'GET' });
```
`new_str`:
```js
              // #128p — `bloc=all`: preview-ul trebuie să arate exact ce copiază backend-ul la
              // lansare, iar copierea e bloc-agnostică. Fără el se vedea doar primul furnizor.
              const r = await _apiFetch(`/api/formulare-atasamente/${ft}/${encodeURIComponent(_docId)}?slot=${slot}&bloc=all`, { method: 'GET' });
```

**A.4.b** — când există fișiere din mai multe blocuri, grupează-le vizual. Înlocuiește randarea
plată `items.map(...).join('')` cu grupare pe `bloc_idx`:

- calculează `const blocuri = [...new Set(items.map(a => a.bloc_idx || 0))].sort((x,y)=>x-y);`
- dacă `blocuri.length <= 1` ⇒ randare **byte-identică** cu cea de azi (fără niciun antet);
- dacă sunt mai multe ⇒ înaintea fiecărui grup, o linie discretă
  `Furnizorul N` (N = `bloc_idx + 1`), în stilul existent
  (`font-size:.75rem;color:var(--muted);margin:6px 0 2px`), urmată de fișierele acelui bloc.

⛔ `window.renderFileItem` (`public/js/shared/file-item.js`) rămâne **NEATINS** — e componenta
partajată de toate paginile; un câmp nou acolo ar fi refactor de scop mult mai larg.
⛔ Contorul rămâne `items.length` (numărul TOTAL) — el e chiar bug-ul reparat.
⛔ Deduplicarea pe `a.id` și modalul de previzualizare rămân neschimbate.

### A.5 Teste — Etapa A

Fișier DB nou sau extindere a testului de listare existent:

1. ⭐ **Bug-ul raportat**: document cu atașamente pe blocul 0 și pe blocul 1;
   `GET ...?slot=1&bloc=all` întoarce **toate**; `GET ...?slot=1` (fără parametru) întoarce
   **doar blocul 0**. Al doilea e garda de non-regresie: formularul însuși depinde de el.
2. `?bloc=all` respectă `slot` — atașamentele slotului 2 nu apar la `?slot=1&bloc=all`.
3. `?bloc=all` NU întoarce rânduri cu `deleted_at` setat.
4. ⭐ **Authz**: un actor fără drept de citire pe document primește **403** și cu `?bloc=all`
   (ancorează faptul că parametrul nu e o portiță).
5. Rânduri legacy cu `bloc_idx` NULL apar în `?bloc=all` cu `bloc_idx = 0` în răspuns.
6. `?bloc=abc` / `?bloc=-1` ⇒ tratate ca blocul 0, **nu** ca `all`.

---

## ETAPA B — câmpul „Revizuirea" editabil pe revizii

### B.1 Cererea

Pe o revizie, ANTET-ul e blocat integral („🔒 Datele de antet sunt preluate automat din revizia
precedentă și nu pot fi modificate"), inclusiv câmpul **Revizuirea**. Mircea vrea câmpul
editabil.

### B.2 ⚠️ Ce NU face lotul, și de ce — citește înainte de a scrie cod

Există **DOUĂ** valori distincte, care azi merg în lock-step:

| | |
|---|---|
| `formulare_df.revizie_nr` | întregul INTERN care ține lanțul de revizii |
| `formulare_df.revizuirea` | câmpul de FORMULAR MF afișat în ANTET (`#n-rev`), exportat în XML/PDF |

`/revizuieste` (`server/routes/formulare/df.mjs`, ~640) le scrie pe amândouă din același
parametru (`$3::integer` și `$3::text`).

**Lotul face editabil DOAR `revizuirea`. `revizie_nr` rămâne calculat de server.**

⛔ Interdicție explicită: **NU** deriva `revizie_nr` din câmpul tastat, oricât de natural ar
părea. Motivele, verificate pe cod:
- `revizie_nr` e jumătate din indexul unic `df_source_alop_revizie_uniq (source_alop_id,
  revizie_nr)` (migrația 095) ⇒ un număr deja folosit dă `23505`, iar `/revizuieste`
  (`df.mjs:521`) calculează `MAX+1` în afara tranzacției și **nu are `catch` pe 23505** ⇒ 500;
- lista face `DISTINCT ON (...) ORDER BY revizie_nr DESC` ⇒ un număr mai mic face documentul să
  DISPARĂ din listă;
- `has_newer_revision` / `latest_revizie_nr` l-ar bloca definitiv la editare cu „această revizie
  nu mai este cea curentă";
- arborele din `services/trasabilitate.mjs` se ordonează pe `revizie_nr`.

⛔ `nr_unic_inreg` (`#n-nrUnic`) rămâne **BLOCAT** pe revizii. Acolo e chiar invariantul apărat
de #126: reviziile împart numărul, iar deblocarea lui ar reintroduce coliziunile de număr.
⛔ `data_revizuirii` (`#n-data`) rămâne blocat — nu a fost cerut.

### B.3 Fixul (`public/js/formular/doc.js`, `applyDfRoleState`)

`old_str`:
```js
  if(antetBody){
    antetBody.querySelectorAll('input,textarea').forEach(e=>{e.disabled=!_antetEditabil;});
  }
```
`new_str`:
```js
  if(antetBody){
    antetBody.querySelectorAll('input,textarea').forEach(e=>{e.disabled=!_antetEditabil;});
    // #128p — excepție: câmpul „Revizuirea" rămâne editabil pe revizii cât documentul e încă
    // la P1 (draft/returnat). E un câmp de FORMULAR MF (`revizuirea`), care merge în PDF/XML —
    // ⛔ NU întregul intern `revizie_nr`, care ține lanțul de revizii și rămâne al serverului.
    // Restul antetului (mai ales `nr_unic_inreg`) rămâne blocat: acolo stă invariantul #126.
    const _rev=document.getElementById('n-rev');
    if(_rev)_rev.disabled=!(_antetEditabil||(_revNr>0&&(!status||status==='draft'||status==='returnat')));
  }
```

⚠️ La `pending_p2` / `completed` / `aprobat`, Secțiunea A e blocată ⇒ câmpul trebuie să rămână
blocat și el. Condiția de mai sus face exact asta — **verifică pe cod** că nu există altă cale
prin care `#n-rev` e reactivat, în special `setModeP2Df` (`doc.js:473`), care îl trece explicit
pe `disabled=true`. Acela e corect și **rămâne neatins**.

### B.4 Avertisment discret la divergență

Când `revizuirea` (text) diferă de `revizie_nr` (badge-ul R din antet), documentul spune un
lucru în PDF/XML și altul în listă. **Nu blocăm** — e alegerea utilizatorului — dar el trebuie
să vadă că a divergat.

Adaugă un `input`-handler pe `#n-rev` care afișează/ascunde un mesaj discret lângă câmp
(reutilizează stilul `df-lock-bar df-lock-warn` deja existent, sau un `<span>` simplu în
`var(--df-warn)`), cu textul:

```
⚠ Numărul afișat în document diferă de revizia din aplicație (R{revizie_nr}). Lanțul de revizii rămâne neschimbat.
```

Comparația se face pe `String(valoare).trim() !== String(ST.docRevizieNr?.notafd||0)`.
⛔ Nicio validare care să respingă salvarea. ⛔ Fără `alert()`.

### B.5 Teste — Etapa B

7. ⭐ Pe o revizie (`ST.docRevizieNr.notafd = 2`) cu `status='draft'`: `#n-rev` NU e `disabled`,
   dar `#n-nrUnic` **este** — cele două împreună sunt aserțiunea care contează.
8. Pe R0 draft: comportament neschimbat (tot antetul editabil).
9. Pe revizie cu `status='pending_p2'` și cu `'completed'`: `#n-rev` **este** `disabled`.
10. `setModeP2Df()` lasă `#n-rev` `disabled` (P2 nu editează antetul).
11. Avertismentul de divergență apare la valoare diferită și dispare la valoare egală.

---

## Cache busting

Assete atinse: `public/js/semdoc-initiator/main.js`, `public/js/formular/doc.js`.

```bash
grep -n "semdoc-initiator/main.js\|formular/doc.js" public/sw.js
# Așteptat: nicio linie ⇒ FĂRĂ bump CACHE_VERSION. Dacă apare vreuna, bumpează CACHE_VERSION
# (citit din fișier, nu presupus) și spune-o în raport.
```
`?v=` țintit, câte un `sed` per asset (⚠️ `\1`, nu `\g<1>`; `grep` pe linia atinsă după fiecare —
un `?v=` corupt nu pică niciun test și ajunge în producție cu pagina moartă).
⛔ `core.js`, `list.js`, `draft.js`, `file-item.js` NU se ating ⇒ versiunile lor rămân cum sunt.

---

## Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` e obligatoriu pentru Etapa A — atinge ruta reală.
Rețeta PG 17 efemer e în `CLAUDE.md`.

Bump la `3.9.776`;
`git commit -m "fix(#128p): preview atasamente pe toate blocurile + camp Revizuirea editabil"`;
`git push origin develop`.

---

## Verificări de ieșire (verbatim în raport)

```bash
# 1 — bloc=all doar pe ruta de listare
grep -n "bloc === 'all'\|totBlocurile" server/routes/formulare/shared.mjs
# Așteptat: strict în handlerul GET de listare

# 2 — _blocIdx nemodificat
git diff server/routes/formulare/shared.mjs | grep -n "^[-+].*function _blocIdx" 
# Așteptat: 0 linii

# 3 — copierea spre flux neatinsă
git status --short server/services/formular-flow-attachments.mjs
# Așteptat: nicio linie

# 4 — clientul cere toate blocurile
grep -n "bloc=all" public/js/semdoc-initiator/main.js

# 5 — componenta partajată neatinsă
git status --short public/js/shared/file-item.js
# Așteptat: nicio linie

# 6 — nr_unic_inreg rămâne blocat
grep -n "n-nrUnic" public/js/formular/doc.js
# Așteptat: NICIO excepție de disabled pe el; doar liniile istorice

# 7 — revizie_nr nu e derivat din client
git diff server/routes/formulare/df.mjs
# Așteptat: DIFF GOL — Etapa B e strict frontend

# 8 — scopul lotului
git status --short
# ⚠️ working tree-ul are fișiere netrackate din sesiuni vechi — confirmă EXPLICIT că ai
# stage-uit doar căile sarcinii

# 9 — ?v= țintit
grep -on "semdoc-initiator/main\.js?v=[0-9.]*\|formular/doc\.js?v=[0-9.]*" public/*.html
```

---

## RAPORT FINAL

- commit hash + push confirmat; versiunea din `package.json`; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE**
- ieșirea celor 9 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 4 și 7**, menționate separat
- confirmarea că ordinea de listare din interiorul unui bloc a rămas `created_at ASC` pentru
  calea normală (fără `?bloc=all`)
- confirmarea că `copyFormularAttachmentsToFlow` și `renderFileItem` sunt NEATINSE
- confirmarea că `revizie_nr` NU e derivat din client nicăieri (`server/` fără diff)
- cum arată preview-ul cu un singur bloc — trebuie să fie **identic** cu cel de azi (fără
  antetul „Furnizorul N")
- dacă `CACHE_VERSION` a fost bumpat sau nu, și de ce
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ Zero migrații.
⛔ `revizie_nr` rămâne calculat de server. Câmpul editabil e DOAR `revizuirea`.
⛔ `nr_unic_inreg` rămâne blocat pe revizii (invariantul #126).
⛔ `copyFormularAttachmentsToFlow`, `renderFileItem`, `_blocIdx` — neatinse.
⛔ Zero linii de authz modificate.
⛔ Preview cu un singur bloc = randare identică cu cea de azi.
⛔ Zero refactorizări în trecere.
