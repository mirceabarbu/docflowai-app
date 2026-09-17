---
prompt: 217
titlu: "Listele DF/ORD — coloana Responsabil CAB arată și ultimul utilizator din CAB care a lucrat pe document"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: "cea din package.json (v3.9.869 după #216)"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA — `js/formular/list.js` ⇒ `?v=` ȚINTIT, `CACHE_VERSION` doar dacă e în PRECACHE
zona_no_touch_atinsa: NU
tip: afișare (fără logică financiară, fără autorizare nouă) + teste
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

Cererea lui Mircea: în coloana **„Responsabil CAB"** din listele DF și ORD să apară, pe lângă ce apare
azi (compartimentul „👥 Serviciul Buget" sau persoana atribuită), și **ultimul utilizator din
compartimentul CAB care a lucrat pe document**.

## Sursa datelor — măsurată pe producție (SQL-217, 17.09.2026)

Nu există o coloană dedicată. Informația se obține din două surse existente:

1. **Jurnalul de audit** `formulare_audit` (`actor_id`, `created_at`; index
   `idx_formulare_audit_form (form_type, form_id, created_at DESC)`). Evenimentele CAB: `completat`,
   `legat_alop` (înregistrat imediat după `completat`, de același actor), `returnat`.
2. **Ultima salvare** `updated_by` / `updated_at` — acoperă lucrul în curs pe secțiunea 2, dar e
   suprascrisă de următoarea salvare a oricui.

Acoperire pe documentele atribuite compartimentului: **DF 69 → 61 cu nume din audit, 0 doar din
salvare, 8 fără nume; ORD 67 → 65 / 0 / 2.** Documentele fără nume sunt cele încă `pending_p2`, pe
care nimeni din CAB nu a lucrat. Previzualizarea pe ultimele 40 de DF-uri a arătat nume corecte.

## Regula (decizii ale lui Mircea)

- **Ultimul din CAB** = cel mai recent dintre (a) evenimentele din `formulare_audit` ale documentului și
  (b) ultima salvare, făcut de un utilizator care e **acum** în compartimentul CAB al organizației
  documentului. Potrivirea e cea din `isCabDept` / `loadActorCompAndCab`: `TRIM` pe ambele părți,
  egalitate exactă, șirul gol exclus. Utilizatorul trebuie să fie din aceeași organizație cu documentul.
- **Afișare:** la atribuire pe **compartiment** — mereu (dacă există). La atribuire pe **persoană** —
  doar dacă ultimul din CAB e **alt** utilizator decât cel atribuit (concediu, delegare). Decizia se
  ia **pe server** (câmpul e `NULL` când nu trebuie afișat), nu în browser.
- Cine a ieșit între timp din CAB nu mai apare (acceptat).
- **Filtrul „Responsabil CAB"** găsește documentul și după numele/emailul ultimului din CAB.
- **Numai în liste** (și în exportul Excel al listelor). ⛔ Nu în antetul documentului deschis.

---

# ETAPA 0 — ancore (READ-ONLY, raportează valorile OBȚINUTE)

```bash
git branch --show-current
grep '"version"' package.json

grep -n "AS p2," server/routes/formulare/shared.mjs
grep -n "LEFT JOIN users u3 ON u3.id = f[do].updated_by" server/routes/formulare/shared.mjs
grep -n "u2.email ILIKE" server/routes/formulare/shared.mjs
# Așteptat: câte 2 (ramura DF + ramura ORD).

grep -n "o_cab\|pcab" server/routes/formulare/shared.mjs
# Așteptat: 0 — aliasurile noi nu trebuie să se ciocnească.

grep -n "idx_formulare_audit_form" server/db/index.mjs
grep -n "export async function loadActorCompAndCab" -A12 server/services/authz-formular.mjs

grep -n "row.p2_compartiment" public/js/formular/list.js
grep -n "respCab\|numericCols" public/js/formular/list.js
grep -n "js/formular/list.js" public/*.html public/sw.js

grep -rln "formulare/list" server/tests
# Cunoscute: integration/formulare-list.test.mjs (capturează SQL-ul și verifică
# `u2.nume ILIKE`), db/p2-compartiment-vizibilitate, db/formulare-list-*, db/tenant-isolation.
```

⭐ Interogarea de listă construiește `params` pozițional (`params.push`). Subinterogarea nouă **nu
adaugă niciun parametru**: folosește doar coloane (`fd.id`, `fd.org_id`, `fd.updated_by`, …). Filtrul
refolosește indicii `iA`/`iB` deja împinși. Confirmă în raport.

---

# ⭐ ETAPA T — testele ÎNTÂI, pe codul NEREPARAT

`server/tests/db/formulare-list-ultim-cab.test.mjs` (nou). O organizație cu
`cab_compartiment = 'Serviciul Buget'`; utilizatori: inițiator (Serviciul Tehnic), **X** și **Y** în
Serviciul Buget, **Z** în alt compartiment. Evenimentele de audit se inserează direct în
`formulare_audit` cu `created_at` explicit (ordinea în timp e esența testelor).

⚠️ Aserțiuni pe **prezența cheii** și pe `null` explicit (`expect(row).toHaveProperty('p2_ultim_cab')`,
`toBeNull()`), ca testele de „nu afișa" să fie roșii pe codul vechi, unde cheia lipsește.

**DF**
1. ⭐ Atribuit compartimentului; audit `completat` de X ⇒ `p2_ultim_cab` = numele lui X,
   `p2_ultim_cab_at` = momentul evenimentului.
2. ⭐ Apoi inițiatorul salvează (`updated_by` = inițiator, `updated_at` mai nou) ⇒ tot **X**.
3. ⭐ Apoi Y salvează (`updated_by` = Y, `updated_at` mai nou decât evenimentul lui X), fără eveniment
   ⇒ **Y** (cea mai recentă acțiune CAB).
4. ⭐ Atribuit **persoanei** X; audit `completat` de X ⇒ `p2_ultim_cab` **null** (aceeași persoană).
5. ⭐ Atribuit persoanei X; audit `completat` de Y ⇒ **Y**.
6. Evenimente doar de Z (non-CAB) și de un `admin` fără compartiment ⇒ **null**.
7. X a lucrat, apoi X e mutat în alt compartiment ⇒ **null** (regula e pe compartimentul de azi).
8. Paritate `TRIM`: `cab_compartiment = ' Serviciul Buget '` și compartimentul lui X
   `'Serviciul Buget  '` ⇒ X apare. `cab_compartiment` NULL sau gol ⇒ **null**.
9. ⭐ Filtru: `?p2=<fragment din numele lui X>` găsește documentul atribuit compartimentului pe care
   a lucrat X. `?p2=Buget` găsește în continuare documentele atribuite compartimentului (neregresie).
10. Un utilizator din **altă organizație** cu `compartiment = 'Serviciul Buget'`, cu eveniment pe
    documentul primei organizații (seed direct) ⇒ **ignorat**.

**ORD**
11. Ca 1, pe ORD.
12. Ca 4, pe ORD.

**Rulare pe codul nereparat:**
```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/formulare-list-ultim-cab.test.mjs
```
⭐ Raportează roșiile **ÎNAINTE** de patch. Așteptat: toate roșii, cu excepția celei de-a doua
jumătăți din 9 (filtrul pe compartiment, deja verde).

---

# ETAPA A — server: câmpurile noi în ambele ramuri

`server/routes/formulare/shared.mjs`, `GET /api/formulare/list`.

## A.1 — ramura DF, coloanele

`old_str`:
```js
          COALESCE(u2.nume, u2.email, NULLIF(TRIM(fd.p2_compartiment),'')) AS p2,
          NULLIF(TRIM(fd.p2_compartiment),'') AS p2_compartiment,
```
`new_str`:
```js
          COALESCE(u2.nume, u2.email, NULLIF(TRIM(fd.p2_compartiment),'')) AS p2,
          NULLIF(TRIM(fd.p2_compartiment),'') AS p2_compartiment,
          -- #217 — ultimul din CAB care a lucrat pe document (vezi LATERAL pcab). NULL la atribuire
          -- pe persoană când e chiar persoana atribuită — decizia de afișare stă aici, nu în browser.
          CASE WHEN pcab.uid IS DISTINCT FROM fd.assigned_to THEN pcab.nume END AS p2_ultim_cab,
          CASE WHEN pcab.uid IS DISTINCT FROM fd.assigned_to THEN pcab.at   END AS p2_ultim_cab_at,
```

## A.2 — ramura DF, sursa

`old_str`:
```js
        LEFT JOIN users u3 ON u3.id = fd.updated_by
        LEFT JOIN flows f  ON f.id::text = fd.flow_id
```
`new_str`:
```js
        LEFT JOIN users u3 ON u3.id = fd.updated_by
        -- #217 — ultimul utilizator din CAB-ul organizației documentului care a lucrat pe el:
        -- cel mai recent dintre evenimentele de audit și ultima salvare. Regula CAB = isCabDept
        -- (TRIM, egalitate exactă, șir gol exclus), pe compartimentul de AZI, aceeași organizație.
        -- Fără parametri noi (params e pozițional).
        LEFT JOIN organizations o_cab ON o_cab.id = fd.org_id
        LEFT JOIN LATERAL (
          SELECT x.uid, x.nume, x.email, x.at
            FROM (
              SELECT uc.id AS uid, COALESCE(NULLIF(uc.nume,''), uc.email) AS nume, uc.email,
                     fa.created_at AS at
                FROM formulare_audit fa
                JOIN users uc ON uc.id = fa.actor_id
               WHERE fa.form_type = 'df' AND fa.form_id = fd.id
                 AND uc.org_id = fd.org_id
                 AND TRIM(COALESCE(uc.compartiment,'')) <> ''
                 AND TRIM(COALESCE(uc.compartiment,'')) = TRIM(COALESCE(o_cab.cab_compartiment,''))
              UNION ALL
              SELECT u3.id, COALESCE(NULLIF(u3.nume,''), u3.email), u3.email, fd.updated_at
               WHERE u3.id IS NOT NULL
                 AND u3.org_id = fd.org_id
                 AND TRIM(COALESCE(u3.compartiment,'')) <> ''
                 AND TRIM(COALESCE(u3.compartiment,'')) = TRIM(COALESCE(o_cab.cab_compartiment,''))
            ) x
           ORDER BY x.at DESC
           LIMIT 1
        ) pcab ON TRUE
        LEFT JOIN flows f  ON f.id::text = fd.flow_id
```

## A.3 — ramura ORD

Identic cu A.1 și A.2, cu `fo` în loc de `fd` și `fa.form_type = 'ord'`.

`old_str` pentru coloane:
```js
          COALESCE(u2.nume, u2.email, NULLIF(TRIM(fo.p2_compartiment),'')) AS p2,
          NULLIF(TRIM(fo.p2_compartiment),'') AS p2_compartiment,
```
`old_str` pentru sursă:
```js
        LEFT JOIN users u3 ON u3.id = fo.updated_by
        LEFT JOIN flows f  ON f.id::text = fo.flow_id
```

⚠️ Verifică dacă `users.org_id` există ca coloană (Etapa 0 / schema). Dacă lipsește sau poate fi NULL
pe utilizatori reali, **oprește-te și raportează** — nu scoate garda de organizație tăcut.

## A.4 — filtrul „Responsabil CAB", ambele ramuri

`old_str` (DF):
```js
        conds.push(`(u2.email ILIKE $${iA} OR u2.nume ILIKE $${iB}
                     OR TRIM(COALESCE(fd.p2_compartiment,'')) ILIKE $${iA})`);
```
`new_str` (DF):
```js
        // #217 — găsește documentul și după ultimul din CAB care a lucrat pe el (LATERAL pcab).
        conds.push(`(u2.email ILIKE $${iA} OR u2.nume ILIKE $${iB}
                     OR TRIM(COALESCE(fd.p2_compartiment,'')) ILIKE $${iA}
                     OR pcab.nume ILIKE $${iB} OR pcab.email ILIKE $${iA})`);
```
Identic pe ORD, cu `fo.p2_compartiment`.

⚠️ `conds` se construiesc înainte de `SELECT`, dar se folosesc în `${where}`, după `FROM … LATERAL`,
deci `pcab` e vizibil. Verifică pe SQL-ul final (log sau test) și raportează.

⛔ Fragmentele `u2.email ILIKE` și `u2.nume ILIKE` rămân caracter cu caracter (le verifică
`integration/formulare-list.test.mjs`).

---

# ETAPA B — frontend

`public/js/formular/list.js`.

**B.1 — celula.** `old_str`:
```js
      <td>${row.p2_compartiment
        ? `<span title="Atribuit întregului compartiment — oricine din el poate completa">👥 ${esc(row.p2_compartiment)}</span>`
        : esc(row.p2||'—')}</td>
```
`new_str`:
```js
      <td>${row.p2_compartiment
        ? `<span title="Atribuit întregului compartiment — oricine din el poate completa">👥 ${esc(row.p2_compartiment)}</span>`
        : esc(row.p2||'—')}${row.p2_ultim_cab
        ? `<div style="font-size:.75rem;color:var(--df-text-3);margin-top:2px" title="Ultimul utilizator din compartimentul CAB care a lucrat pe document">ultim: ${esc(row.p2_ultim_cab)}${row.p2_ultim_cab_at?' · '+_fmtDate(row.p2_ultim_cab_at):''}</div>`
        : ''}</td>
```
⚠️ Confirmă că `_fmtDate` e în scope aici (e folosit în aceeași funcție pentru `created_at`).

**B.2 — exportul Excel.** Coloana nouă **„Ultimul din CAB"** imediat după „Responsabil CAB", pe
ambele tipuri.

- DF: antetul primește `'Ultimul din CAB'` după `'Responsabil CAB'`; rândul primește
  `row.p2_ultim_cab||''` după `respCab(row)`. `numericCols` rămâne `[]`.
- ORD: la fel. ⭐ **`numericCols` devine `[6,7]`** (era `[5,6]`: „Valoare ORD" și „Plată" se mută cu
  o poziție). Un index rămas `[5,6]` formatează numeric o coloană de text și lasă sumele ca text —
  nimic nu dă eroare.

Verificare obligatorie, în raport: pentru ORD, indicii din `numericCols` arată spre `'Valoare ORD'`
și `'Plată'` în antetul nou (număr și nume).

---

# ETAPA C — suitele

```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/formulare-list-ultim-cab.test.mjs
npm test
npm run test:db
```

⚠️ **Secvențial, complet.** Verdictul din **output real**, cu numărul de fișiere confruntat cu discul.
`skipped` ≠ `passed`. ⛔ O rulare `test:db` întreruptă **nu** e verdict — o reiei.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.**
Neregresie citată: `integration/formulare-list.test.mjs`, `db/p2-compartiment-vizibilitate`,
`db/formulare-list-caps`, `db/formulare-list-nr-search`, `db/tenant-isolation`,
`db/formulare-audit-cab` (#216).

---

# ETAPA D — versiune, cache, commit

```bash
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json   # ≤ 4 linii
grep -n "js/formular/list.js?v=" public/formular.html
NEW=<TINTA>
sed -i -E "s#(js/formular/list\.js\?v=)[0-9.]+#\1${NEW}#g" public/formular.html
grep -n "js/formular/list.js?v=" public/formular.html   # linia <script> întreagă
```
`CACHE_VERSION` doar dacă `js/formular/list.js` e în `PRECACHE_ASSETS`.

`git add` explicit. Arhivează ca `docs/archive/PROMPT-217-ultim-cab.md`; dacă
`docs/archive/sql/SQL-217-previzualizare-ultim-cab.sql` există netrackat, adaugă-l.

```
feat(#217): listele DF/ORD arata ultimul utilizator din CAB care a lucrat pe document — v<TINTA>

Coloana Responsabil CAB arata azi compartimentul atribuit sau persoana. Se
adauga, sub ea, ultimul utilizator din compartimentul CAB al organizatiei care
a lucrat pe document: cel mai recent dintre evenimentele din formulare_audit
(completat, returnat etc.) si ultima salvare. Regula CAB e cea din isCabDept.
La atribuire pe persoana apare doar daca e alt utilizator decat cel atribuit;
decizia e pe server. Filtrul Responsabil CAB gaseste si dupa acest nume.
Exportul Excel primeste coloana Ultimul din CAB (ORD: numericCols 5,6 -> 6,7).

Fara migratii si fara date noi: masurat pe productie, 61/69 DF si 65/67 ORD
atribuite compartimentului au nume din jurnal; restul sunt inca la CAB.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL
1. Ancore obținute (inclusiv `users.org_id` și absența aliasurilor `o_cab`/`pcab`).
2. ⭐ Roșiile pe codul nereparat.
3. Confirmarea că nu s-a adăugat niciun parametru pozițional; SQL-ul final al filtrului (fragment).
4. Rezultatul fiecărui test nou, în special 2, 3, 4, 5, 9, 10.
5. ⭐ `numericCols` ORD: indicii noi și coloanele spre care arată.
6. Teste preexistente atinse (așteptat: niciunul).
7. Numere reale `npm test` și `npm run test:db`, **complete**, secvențial, cu sursa verdictului.
8. `?v=` / `CACHE_VERSION` cu dovadă.
9. Divergențe prompt ↔ cod — raportate, nereparate tăcut.
10. Colaterale observate — nereparate.

# ⛔ CONSTRÂNGERI ABSOLUTE
- `develop` ONLY, apoi stop. Zero migrații, zero scrieri de date.
- Zero parametri poziționali noi în interogarea de listă.
- Decizia „afișez / nu afișez" pe server; browserul doar redă câmpul.
- ⛔ Antetul documentului deschis, rutele de salvare, `formulare_audit` (scriere), exportul CSV/PDF al
  auditului — neatinse.
- ⛔ Zona NO-TOUCH (STS/PAdES) — neatinsă.
- `?v=` țintit, `git add` explicit, `old_str` unic sau STOP.
