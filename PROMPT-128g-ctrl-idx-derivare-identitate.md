# PROMPT #128g — derivarea identității ORD devine sigură la blocuri multiple (`ctrl_idx`)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus — atinge derivarea coloanelor de identitate pe documente financiare
**Target versiune:** `v3.9.767` (de la 3.9.766 — **citește `package.json`**) · **Migrații:** ZERO

---

## 1. Bugul pe care îl repară — și de ce trebuie reparat ÎNAINTE de butonul de bloc

`deriveOrdIdentityCols` (`server/services/formular-shared.mjs:74`) corelează **pozițional**:
rândul *i* din ORD primește `cod_angajament`, `indicator_angajament`, `program` și `cod_SSI` din
`ctrlRows[i]` — adică din `rows_ctrl[i]` al DF-ului legat, cu `src[k] ?? null` și fără nicio
încredere în ce trimite clientul (proiectat așa la #100.2).

Funcționează perfect cât timp ORD-ul oglindește 1:1 rândurile DF-ului, în aceeași ordine — cazul
de azi, produs de `onDfSelect` (`public/js/formular/list.js:177`), care iterează `rows_ctrl` cu
`forEach` și adaugă câte un rând pentru fiecare.

**Se rupe în clipa în care există al doilea bloc.** Rândurile blocului 2 se adaugă la coada listei
plate, pe pozițiile *n…m*, dar semantic trimit la angajamente aflate la începutul listei DF-ului.
Rezultat: cele patru coloane de identitate ale blocului 2 se derivă din rândurile GREȘITE ale
DF-ului. Tăcut, pe bani — clasa de bug de la #115.

⚠️ **Corectură la o afirmație anterioară:** la #128d s-a spus că `deriveOrdIdentityCols` „rămâne
valabil identic peste blocuri". **E fals**, din motivul de mai sus. De aceea lotul ăsta se
intercalează înaintea butonului de adăugare bloc (care devine #128h).

### Soluția

Un câmp nou pe rând, `ctrl_idx` — indexul rândului sursă din `rows_ctrl`, ștampilat de frontend
când pre-populează din DF. Serverul derivă din `ctrlRows[row.ctrl_idx]` când e prezent și valid,
altfel cade pe poziție (retrocompatibil pentru absolut tot ce există azi).

**Nu reintroduce încredere în client:** `ctrl_idx` e doar un POINTER într-o listă pe care serverul
o citește el însuși din DF; valorile continuă să vină exclusiv de acolo. În plus, clientul
controlează deja ORDINEA rândurilor, iar derivarea pozițională înseamnă că ordinea decide
identitatea — deci `ctrl_idx` face explicit ce era implicit, fără să adauge putere nouă.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `formulare_df` și `server/routes/formulare/df.mjs` — DF-ul nu se atinge în seria #128
⛔ `ORD_IDENT_COLS` — cele patru coloane rămân exact aceleași
⛔ `lockOrdIdentityCols` — rămâne cum e
⛔ Nu adăuga butonul de bloc, nu adăuga containere noi de bloc, nu muta markup — **e #128h**
⛔ `server/services/opme-matcher.mjs`, `alop.mjs`, `clasa8.mjs`

---

## 3. Etapa A — serverul

Fișier: `server/services/formular-shared.mjs`, `deriveOrdIdentityCols` (~:74).

Singura schimbare: alegerea indexului sursă.

```js
  return clientRows.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    // #128g: `ctrl_idx` = indexul rândului sursă din rows_ctrl, ștampilat de frontend la
    // pre-popularea din DF (list.js onDfSelect). Corelarea POZIȚIONALĂ (rândul i ← ctrlRows[i])
    // se rupe la ORD cu mai multe blocuri: rândurile blocului 2 stau la coada listei plate, dar
    // trimit la angajamente de la începutul DF-ului ⇒ identitate derivată din rândul greșit,
    // tăcut. `ctrl_idx` face explicit ce era implicit; NU adaugă încredere în client — e doar un
    // pointer într-o listă pe care serverul o citește el însuși din DF, iar valorile vin tot de
    // acolo. Un `ctrl_idx` absent, nenumeric sau în afara intervalului cade pe poziție ⇒
    // comportament identic cu cel de dinainte pentru tot ce există azi.
    const raw = row.ctrl_idx;
    const parsed = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    const idx = (Number.isInteger(parsed) && parsed >= 0 && parsed < ctrlRows.length) ? parsed : i;
    const src = ctrlRows[idx];
    if (!src || typeof src !== 'object') return row;
    const out = { ...row };
    for (const k of ORD_IDENT_COLS) out[k] = src[k] ?? null;
    return out;
  });
```

⚠️ **Fail-safe obligatoriu, nu opțional:** un `ctrl_idx` invalid sau în afara intervalului trebuie
să cadă pe `i`, **niciodată** să lase rândul neatins. Dacă l-ai lăsa neatins, un client care
trimite `ctrl_idx: 999` ar păstra coloanele de identitate scrise de el — exact gaura pe care
#100.2 a închis-o. Cazul de test 4 verifică asta.

⚠️ `ctrl_idx` vine din DOM ca **șir** (`'2'`), de aceea `Number(raw)` și nu `Number.isInteger(raw)`
direct. Nu folosi `parseInt` fără radix.

---

## 4. Etapa B — frontendul ștampilează

### B.1 `public/js/formular/list.js`, `onDfSelect` (~:177)

În `rows.forEach(row => { … })`, bucla are deja indexul disponibil — folosește-l:
`rows.forEach((row, idx) => { … tr.dataset.ctrlIdx = String(idx); … })`.

⛔ Nu adăuga un input ascuns în markup-ul rândului. `dataset` pe `<tr>` e mai puțin invaziv și nu
atinge `addOR()`.

### B.2 `public/js/formular/core.js`, `getOR` (~:150)

Adaugă `ctrl_idx` în obiectul rândului **doar când `tr.dataset.ctrlIdx` există**:

```js
const ci = tr.dataset.ctrlIdx;
if (ci !== undefined && ci !== '') o.ctrl_idx = Number(ci);
```

⛔ Nu îl adăuga necondiționat cu valoare implicită — un rând adăugat manual (`addOR()`) trebuie să
rămână FĂRĂ `ctrl_idx`, ca să cadă pe poziție exact ca azi.

### B.3 Verificare de traseu, obligatorie

Confirmă pe cod că `ctrl_idx` supraviețuiește tot lanțului până la DB:
`getOR()` → `collectOrdDb` (`doc.js:80`, modificat la #128f) → `POST/PUT /api/formulare-ord` →
`normalizeAngajamentRows` → `deriveOrdIdentityCols` → `pregatesteScriereBlocuri` (care pune
`bloc_idx`) → coloana `rows`.

⚠️ `normalizeAngajamentRows` rulează ÎNAINTE de derivare. Verifică pe cod că păstrează cheile
necunoscute (la #128c s-a confirmat că `deriveOrdIdentityCols` o face, prin `{ ...row }` la :81 —
confirmă și pentru normalize). Dacă NU le păstrează, **oprește-te și raportează**.

---

## 5. Etapa C — teste

**C.1 unitare pe derivare** — extinde suita existentă a lui `deriveOrdIdentityCols`:

1. ⭐ **NON-REGRESIE:** rânduri FĂRĂ `ctrl_idx` → derivare pozițională identică cu azi, pe toate
   cele patru coloane. Dacă asta pică, patch-ul e greșit;
2. rânduri CU `ctrl_idx` care coincide cu poziția → rezultat identic cu cazul 1;
3. ⭐ **cazul care motivează lotul:** 4 rânduri — două cu `ctrl_idx` 0 și 1, două cu `ctrl_idx` 0
   și 1 din nou (blocul 2 pe aceleași angajamente) → rândurile 3 și 4 primesc identitatea din
   `rows_ctrl[0]` și `[1]`, NU din `[2]` și `[3]`;
4. ⭐ **fail-safe:** `ctrl_idx: 999` (în afara intervalului) pe un rând care poartă coloane de
   identitate FALSE trimise de client → derivarea cade pe poziție și valorile clientului sunt
   SUPRASCRISE, nu păstrate;
5. `ctrl_idx` ca șir `'2'` → funcționează;
6. `ctrl_idx` negativ, `null`, `''`, `1.5`, `'abc'` → ignorate, cădere pe poziție;
7. `ctrlRows` gol → `clientRows` întors neatins (comportament existent, nemodificat).

**C.2 frontend** (happy-dom, modelul din `pagin-component.test.mjs`; capcana cunoscută:
`dirname(fileURLToPath(import.meta.url))`, nu `new URL('.', import.meta.url)`):

8. după `onDfSelect` cu un DF având 3 rânduri în `rows_ctrl`, fiecare `<tr>` are
   `dataset.ctrlIdx` = `'0'`, `'1'`, `'2'`;
9. `getOR()` întoarce `ctrl_idx` numeric pe acele rânduri;
10. un rând adăugat prin `addOR()` NU are `ctrl_idx` în obiectul întors.

**C.3 DB real** — un test cap-coadă: `POST /api/formulare-ord` cu rânduri purtând `ctrl_idx` care
NU coincide cu poziția → coloanele de identitate salvate în DB provin din rândul `rows_ctrl`
indicat, iar `ctrl_idx` însuși e **păstrat** în `rows` (e nevoie de el la fiecare salvare
ulterioară).

---

## 6. Cache busting

`core.js` și `list.js` sunt fișiere din `public/`. Verifică pe cod, ⛔ nu presupune:

```bash
grep -n "formular/core.js\|formular/list.js" public/sw.js
```

În `PRECACHE_ASSETS` ⇒ bump `CACHE_VERSION` (citit din fișier); altfel `?v=3.9.767` țintit în
`formular.html`. Raportează care caz e.

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.767`; commit pe `develop`:
`fix(#128g): derivarea identității ORD folosește ctrl_idx — sigură la blocuri multiple`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -n "ctrl_idx" server/services/formular-shared.mjs
# Așteptat: citirea + parsarea + alegerea indexului

grep -n "ctrlIdx" public/js/formular/list.js public/js/formular/core.js
# Așteptat: ștampilarea în onDfSelect + citirea condiționată în getOR

grep -rn "ctrl_idx" server/routes/formulare/ord.mjs
# Așteptat: 0 rezultate — ruta nu trebuie să știe de el, doar să-l lase să treacă

git diff --stat server/services/opme-matcher.mjs server/routes/alop.mjs
# Așteptat: GOL

git status --short
# ⚠️ fișiere .md netrackate preexistente în docs/archive — ignoră-le, confirmă ce ai stage-uit
```

---

## 9. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 3 și 4** menționate separat — non-regresia, cazul multi-bloc și
  fail-safe-ul
- **răspunsul la verificarea de traseu (§4.B.3):** `normalizeAngajamentRows` păstrează cheile
  necunoscute, da sau nu, cu linia de cod; și confirmarea că `ctrl_idx` ajunge intact în coloana
  `rows`
- cazul de cache busting
- orice test preexistent modificat, cu motivul
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
