# PROMPT #128c — backendul scrie și citește `blocuri`; coloanele plate devin OGLINDĂ

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Opus (atinge calea de scriere a documentelor financiare)
**Target versiune:** `v3.9.763` (de la 3.9.762 — **citește `package.json`**, nu presupune)
**Migrații:** ZERO (coloana `blocuri` există din #128b) · **Fișiere din `public/`:** ZERO

---

## 1. Ce face lotul, și ce NU face

#128b a livrat coloana `blocuri JSONB` (goală peste tot) și modulul pur
`server/services/ord-blocuri.mjs`, deliberat necablat. Lotul ăsta îl **cablează pe calea de
scriere și de citire a ORD-ului**, fără nicio schimbare vizibilă pentru utilizatori: frontendul
nu trimite încă `blocuri`, deci fiecare document continuă să aibă exact un bloc.

⛔ **NU face parte din lotul ăsta** (fiecare are lotul lui):
- agregările de bani și `opme-matcher.mjs` → #128d;
- orice fișier din `public/`, butonul de adăugare bloc, cele 119 referințe `o-*` → #128e;
- PDF-ul și exportul XML → #128f;
- validările MF per bloc (Beneficiar / Documente justificative / Informații plată obligatorii)
  → #128e. ⛔ **Nu le introduce acum** — ar respinge documente aflate în lucru chiar în acest
  moment în producție.

**Criteriul de acceptanță al întregului lot, într-o frază:** pentru un payload FĂRĂ `blocuri`
(adică tot ce trimite clientul de azi), coloanele plate scrise în DB trebuie să fie **identice**
cu cele care s-ar fi scris înainte de acest patch. Dacă un test arată o diferență, patch-ul e
greșit, nu testul.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/routes/formulare/df.mjs` și `formulare_df` — DF-ul e mono-bloc în modelul MF și nu se
   atinge în tot șantierul #128
⛔ `server/routes/alop.mjs`, `server/services/clasa8.mjs`, `server/services/opme-matcher.mjs`
⛔ `server/services/alop-xml/**` (serializatoare, `ord-to-xsd.mjs`)
⛔ Garda de dedup #124e′ din `POST /api/formulare-ord` — nu se mută, nu se modifică
⛔ `deriveOrdIdentityCols` și `normalizeAngajamentRows` — se PĂSTREAZĂ ordinea lor actuală de
   apel; vezi §3.3, e o constrângere de ordonare, nu de rescriere

Se ating: `server/services/ord-blocuri.mjs` (o funcție nouă) și
`server/routes/formulare/ord.mjs` (POST create, PUT update, GET detaliu).

---

## 3. Etapa A — o funcție nouă în modulul pur

În `server/services/ord-blocuri.mjs`, adaugă **o singură** funcție exportată, pură (fără `pool`):

```js
pregatesteScriereBlocuri({ body, data, docExistent = null })
  → { blocuri, oglinda, rows }
```

### 3.1 `blocuri`

- dacă `Array.isArray(body.blocuri) && body.blocuri.length > 0` → normalizează prin
  `blocuriDinOrd({ blocuri: body.blocuri })` (garantează `bloc_idx` numeric, din poziție);
- altfel → **UN SINGUR bloc**, construit din cele 8 câmpuri plate, luate în ordinea:
  valoarea din `data` dacă cheia e prezentă în payload, altfel valoarea din `docExistent`,
  altfel `null`.

⚠️ Fuziunea peste `docExistent` e obligatorie și e miezul corectitudinii la PUT: clientul trimite
frecvent payload-uri PARȚIALE (doar `beneficiar`, doar `rows`). Fără fuziune, oglinda ar scrie
`null` peste câmpuri pe care utilizatorul nu le-a atins — adică ar ȘTERGE date. La POST,
`docExistent` e `null` și fuziunea degenerează corect la „doar ce e în payload".

### 3.2 `oglinda`

`oglindaBloc1(blocuri)` — obiectul celor 8 coloane plate. Ăsta devine **SINGURUL** loc din
proiect din care se scriu acele coloane.

### 3.3 `rows` — constrângere de ORDONARE, citește cu atenție

Dacă `data.rows` e prezent, întoarce rândurile cu `bloc_idx` completat: valoarea existentă dacă
e un număr, altfel `0`.

⚠️ În rută, aplicarea `bloc_idx` trebuie să se facă **DUPĂ** `normalizeAngajamentRows` și **DUPĂ**
`deriveOrdIdentityCols`, nu înainte. Ambele reconstruiesc obiectele rândurilor, iar
`deriveOrdIdentityCols` a fost scrisă cu `src[k] ?? null` pe patru chei de identitate.
**Verifică pe cod că păstrează cheile necunoscute** (deci și `bloc_idx`) — dacă NU le păstrează,
**oprește-te și raportează**, nu o modifica: e o funcție de derivare pe bani, cu test propriu, iar
soluția corectă ar fi ordonarea, nu rescrierea ei.

---

## 4. Etapa B — cablarea în `POST /api/formulare-ord`

Punctul de inserție: **imediat înainte** de `const cols = ['org_id', 'created_by'];`, adică DUPĂ
garda de dedup #124e′ (care trebuie să rămână prima scriere evitată — nu are rost să pregătim
blocuri pentru un document pe care oricum îl deduplicăm).

1. `const { blocuri, oglinda, rows } = pregatesteScriereBlocuri({ body, data });`
2. dacă `rows` e definit → `data.rows = rows;`
3. suprascrie în `data` cele 8 câmpuri din `oglinda` **înainte** de bucla `for (const f of
   ORD_P1_FIELDS)`, ca oglinda să intre pe traseul existent de coloane. ⛔ Nu adăuga o a doua
   buclă de coloane și nu scrie cele 8 câmpuri direct în `cols`/`vals` — ar deveni exact al
   doilea loc de scriere pe care lotul îl elimină.
4. adaugă `blocuri` la `cols`/`vals` ca `JSON.stringify(blocuri)`.

⚠️ Verifică pe cod dacă `blocuri` trebuie adăugat în `ORD_P1_FIELDS` sau tratat separat. Preferă
**tratarea separată** (un `cols.push('blocuri')` explicit, ca la `source_alop_id`): dacă intră în
lista generică, un client ar putea trimite `blocuri` direct și ar ocoli normalizarea.

---

## 5. Etapa C — cablarea în `PUT /api/formulare-ord/:id`

Punctul de inserție: după blocul `deriveOrdIdentityCols` și după verificarea de
`nr_ord_duplicat`, **înainte** de `const { sets, vals } = buildUpdate(data, allowedFields, 1);`

1. `const { blocuri, oglinda, rows } = pregatesteScriereBlocuri({ body: req.body || {}, data, docExistent: doc });`
2. dacă `rows` e definit → `data.rows = rows;`
3. suprascrie cele 8 câmpuri din `oglinda` în `data`, ca `buildUpdate` să le preia pe traseul
   existent;
4. `blocuri` se adaugă prin mecanismul `extraSets`/`extraVals` deja folosit în handler (`$__`
   înlocuit cu indexul), **nu** prin `allowedFields`.

⚠️ Atenție la interacțiunea cu `allowedFields`: dacă un câmp din cele 8 NU e în `allowedFields`,
`buildUpdate` îl ignoră tăcut și oglinda nu se scrie. **Verifică lista pe cod** și raportează
care dintre cele 8 sunt acolo. Dacă lipsesc, adaugă-le explicit prin `extraSets`, nu lărgi
`allowedFields` (lărgirea ar deschide și scrierea directă de la client).

---

## 6. Etapa D — citirea

În `GET /api/formulare-ord/:id` (detaliul), înainte de `res.json`, adaugă:

```js
doc.blocuri = blocuriDinOrd(doc);
```

Astfel un document vechi (`blocuri` NULL în DB) întoarce totuși un array cu un bloc derivat din
coloanele plate, iar #128e poate scrie frontendul contra unei singure forme.

⛔ **Doar detaliul.** Listele (`GET /api/formulare/list`, `/api/formulare-ord`) rămân neatinse —
ar umfla payload-ul fără consumator.

---

## 7. Etapa E — teste (Postgres real)

Fișier nou `server/tests/db/ord-blocuri-scriere.test.mjs`, oglindind montarea și helperii unui
test DB existent care lovește deja `POST`/`PUT /api/formulare-ord`.

1. ⭐ **NON-REGRESIE, cazul care contează cel mai mult:** POST cu payload-ul de azi (fără
   `blocuri`, cu beneficiar/cif/iban/banca/documente/inf) → cele 8 coloane plate în DB au
   **exact** aceleași valori ca înainte de patch, iar `blocuri` conține **un** bloc cu aceleași
   valori și `bloc_idx: 0`.
2. **PUT parțial** — se trimite DOAR `{ beneficiar: 'X' }` pe un document care avea deja
   cif/iban/banca completate → după update, cif/iban/banca sunt **NESCHIMBATE** (dovada că
   fuziunea peste `docExistent` funcționează), iar `blocuri[0].beneficiar === 'X'`.
3. **`bloc_idx` pe rânduri** — POST cu `rows` fără `bloc_idx` → toate rândurile salvate au
   `bloc_idx: 0`, iar coloanele de identitate derivate din DF (`cod_angajament`,
   `indicator_angajament`, `program`, `cod_SSI`) sunt **neschimbate** față de comportamentul
   actual (dovada că ordonarea din §3.3 e corectă).
4. **Payload CU `blocuri`** (2 blocuri, deși niciun client nu-l trimite încă) → ambele salvate,
   `bloc_idx` 0 și 1, iar coloanele plate reflectă **blocul 1**.
5. **Document legacy** — un rând cu `blocuri = NULL` inserat direct în DB → `GET` pe detaliu
   întoarce `blocuri` cu un element derivat din coloanele plate.
6. **PUT pe un document legacy** care nu atinge câmpurile de beneficiar → `blocuri` devine
   populat cu blocul derivat, iar coloanele plate rămân identice.
7. **Non-regresie pe dedup** — două POST-uri consecutive pe același `source_alop_id` → al doilea
   întoarce documentul existent (garda #124e′ neatinsă).

⚠️ Dacă un test preexistent pică fiindcă răspunsul are acum câmpul `blocuri` în plus, **actualizează
testul** (aserțiuni pe câmpuri, nu pe forma exactă a obiectului) și raportează care.

---

## 8. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed". `test:db` e obligatoriu — e singurul care validează scrierea reală.

Bump `package.json` → `3.9.763`; commit pe `develop`:
`feat(#128c): backendul scrie/citește blocuri ORD; coloanele plate devin oglinda blocului 1`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 9. Verificări de ieșire (verbatim în raport)

```bash
grep -n "pregatesteScriereBlocuri" server/routes/formulare/ord.mjs
# Așteptat: 2 apeluri (POST + PUT) + 1 import

grep -rn "oglindaBloc1" server/ --include=*.mjs | grep -v tests
# Așteptat: DOAR în ord-blocuri.mjs — un singur loc de scriere a coloanelor plate

grep -rn "blocuri" server/routes/alop.mjs server/services/opme-matcher.mjs server/services/clasa8.mjs
# Așteptat: 0 rezultate — agregările sunt #128d, nu acest lot

grep -rn "blocuri" public/ | head
# Așteptat: 0 rezultate — frontendul e #128e

git status --short
# Așteptat: package.json, ord.mjs, ord-blocuri.mjs, testul nou. Nimic din public/.
```

---

## 10. RAPORT FINAL

- commit hash + intervalul de push; versiunea, citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 4 verificări, verbatim
- ⭐ rezultatul cazurilor **1 și 2** menționate separat — sunt acceptanța lotului
- **răspunsul la cele două întrebări de recon din prompt:** (a) `deriveOrdIdentityCols` păstrează
  cheile necunoscute ale rândurilor, da sau nu, cu linia de cod; (b) care dintre cele 8 câmpuri
  ale oglinzii sunt în `allowedFields` la PUT și ce ai făcut pentru cele care lipsesc
- orice test preexistent modificat, cu motivul
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
