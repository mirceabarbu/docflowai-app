# Audit câmpuri monetare — DocFlowAI v3.9.330

## Rezumat
- **Total câmpuri / zone identificate:** 20
- **Deja formatate corect (ro-RO):** 5 — nicio intervenție necesară
- **Confirmate monetare — de formatat:** 6 câmpuri input + 1 locație PDF
- **Ambigue / risc ridicat — necesită decizie Mircea:** 8 câmpuri input tabel (calcul)
- **Respinse — numerice NON-monetare:** 5

---

## Nota preliminară: ce e deja OK

Înainte de a lista ce trebuie schimbat, documentăm ce funcționează deja **corect**:

| ID element | Funcție | Format folosit | Stare |
|---|---|---|---|
| `fmtRON` (ALOP list cards) | `Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON'})` | `1.234,56 RON` | ✅ OK |
| `fmtV` (ALOP detail phases) | `Intl.NumberFormat('ro-RO',{minimumFractionDigits:2})` + ` RON` | `1.234,56 RON` | ✅ OK |
| `st2()` (totaluri tabele DF/ORD) | `Math.round(v).toLocaleString('ro-RO')` | `1.234` (fără zecimale) | ✅ OK (rotunjire intenționată — sume întregi lei) |
| ALOP list (renderAlopList) | `fmtRON` cu `maximumFractionDigits:0` | `1.234 RON` | ✅ OK |
| Rămas de ordonanțat | `fmtRON` | `1.234,56 RON` | ✅ OK |

---

## Categoria 1: CONFIRMATE MONETARE — de formatat

### 1.1 Frontend — Inputs standalone (simple, fără risc de calcul)

| Fișier | Linie | `id` | Label UI | Tip curent | Decizie |
|---|---|---|---|---|---|
| `public/formular.html` | 1002 | `alop-valoare` | "Valoare totală estimată (RON)" | `type="number" step="0.01"` | ✅ Formatează |
| `public/formular.html` | 1177 | `plata-suma` | "Suma efectiv plătită (lei)" | `type="number" step="0.01"` | ✅ Formatează |
| `public/formular.html` | 788 | `n-ramana` | "Rămâne în suma de … lei" (inline în label checkbox) | `type="number"` | ✅ Formatează |
| `public/formular.html` | 899 | `n-sumfara` | "Nu s-au rezervat credite de angajament în cuantum de … lei" | `type="number"` | ✅ Formatează |
| `public/formular.html` | 905 | `n-sumfararezvcrbug` | "Nu s-au rezervat credite bugetare în cuantum de … lei" | `type="number"` | ✅ Formatează |
| `public/notafd-invest-form.html` | 253 | `nf-valoare_totala_mii_lei` | "Valoarea totală estimată (mii lei)" | `type="text"` cu placeholder `"ex. 1.250,00"` | ✅ Formatează (placeholder e deja în formatul dorit, dar input nu e validat/formatat la blur) |

**Observație `nf-valoare_totala_mii_lei`:** câmpul e deja `type="text"`, deci nu necesită schimbare de tip. Trebuie doar adăugat comportamentul de formatare la blur + parsing la submit.

**Observație `n-ramana`:** inputul are `disabled` implicit (activat de checkbox `n-ck-ramane`). Formatarea se aplică când e activat — gestionare prin `attachMoneyInput` normal.

### 1.2 Frontend — Display read-only

| Fișier | Linie | Context | Decizie |
|---|---|---|---|
| `server/services/formulare-oficiale/nf-invest-pdf.mjs` | 188 | `${data.valoare_totala_mii_lei} mii lei` → afișat în textul PDF | ✅ Formatează (vezi Categoria 1.3) |

### 1.3 Backend — PDF Generation

| Fișier | Linie | Context | Decizie |
|---|---|---|---|
| `server/services/formulare-oficiale/nf-invest-pdf.mjs` | 188 | `data.valoare_totala_mii_lei` inserat direct ca string în PDF text | ✅ Aplică `formatMoneyRO()` server-side |

---

## Categoria 2: AMBIGUE / RISC RIDICAT — necesită decizie Mircea

Acestea sunt **inputs în rânduri dinamice de tabel** (generate de `addOR()`, `addNV()`, `addNP()`, `addNC()`). Toate sunt `type="number"` și sunt citite direct cu `parseFloat(i.value)` în funcția `sf()`:

```js
// formular.html:1472
function sf(bid,f){
  return [...document.querySelectorAll(`#${bid} input[data-f="${f}"]`)]
    .reduce((s,i)=>s+(parseFloat(i.value)||0),0);
}
```

**Riscul:** dacă schimbăm la `type="text"` cu valori formatate (`"1.234,56"`), `parseFloat("1.234,56")` returnează `1.234` (greșit — ignoră zecimalele după virgulă). Ar trebui înlocuit `parseFloat` cu `parseMoneyRO` în tot codul de calcul. Refactor non-trivial cu risc de regresie.

**Totalurile** (`st2()`) sunt deja formatate cu ro-RO, deci display-ul e corect — problema e doar la editarea valorilor în celule.

| Tabel | `data-f` | Label coloană | Linie generare |
|---|---|---|---|
| ORD (`#o-tbody`) | `receptii` | "Recepții (lei)" | 1325 |
| ORD (`#o-tbody`) | `plati_anterioare` | "Plăți anterioare (lei)" | 1325 |
| ORD (`#o-tbody`) | `suma_ordonantata_plata` | "Suma ordonantată la plată (lei)" | 1325 |
| ORD (`#o-tbody`) | `receptii_neplatite` | "Recepții neplatite (lei)" — **calculat automat, readonly** | 1325 |
| NV (`#n-vtbody`) | `valt_rev_prec` | "Val. totală revizie precedentă (lei)" | 1347 |
| NV (`#n-vtbody`) | `influente` | "Influențe +/- (lei)" | 1347 |
| NV (`#n-vtbody`) | `valt_actualiz` | "Val. totală actualizată (lei)" — **calc readonly** | 1347 |
| NP (`#n-ptbody`) | `plati_ani_precedenti` / `plati_estim_*` | "Plăți ani prec. / estimate" | 1357 |
| NC (`#n-ctbody`) | `sum_rezv_crdt_ang_*` / `influente_c*` | "Credite angajament/bugetare (lei)" | 1362 |

**Întrebări pentru Mircea:**
1. Vrem format vizual și pe inputurile din celulele de tabel (DF/ORD/NC/NP/NV), sau e suficient că totalurile (rândul TOTAL) sunt deja formatate ro-RO?
2. Dacă da — preferăm refactor complet `sf()` → `parseMoneyRO()`, sau lăsăm celulele tabel cu `type="number"` native (format browser) și formatăm doar totalurile?

---

## Categoria 3: RESPINSE — numerice NON-monetare (păstrăm ca sunt)

| Fișier | Linie | Element | Motivă respingere |
|---|---|---|---|
| `public/notafd-invest-form.html` | 169 | `id="nf-nr_inregistrare"` type=text | Număr de înregistrare registru (ex: "1234") — NU sumă |
| `public/notafd-invest-form.html` | 198 | `id="nf-an_program"` type=text | Anul programului (ex: "2026") — NU sumă |
| `public/admin.html` | 415 | `id="archiveDays"` type=number | Număr zile pentru arhivare — NU sumă monetară |
| `public/admin.html` | 452 | `id="delDays"` type=number | Număr zile pentru ștergere automată — NU sumă monetară |
| `public/notafd-invest-form.html` | 291 | `id="nf-durata_functionare"` type=text | "ex. 50 ani" — NU sumă |

---

## Plan de aplicare — FAZA B (doar după confirmare Mircea)

### Pasul 1 — Utility server-side
```
server/services/format-money.mjs          ← formatMoneyRO + parseMoneyRO (ES module)
server/services/__tests__/format-money.test.mjs  ← 12 teste vitest
```

### Pasul 2 — Utility client-side
```
public/js/utils/format-money.js           ← formatMoneyRO + parseMoneyRO + attachMoneyInput
                                             (ES module + window globals)
```

### Pasul 3 — Aplicare pe Categoria 1.1 (6 inputs)
Pentru fiecare input din tabelul 1.1:
- `type="number"` → `type="text" inputmode="decimal" data-money="true"`
- `step="0.01"` și `min="0"` se elimină (nu mai sunt relevante pentru text)
- Placeholder: `"0,00"` (virgulă, nu punct)
- La `DOMContentLoaded`: `document.querySelectorAll('[data-money]').forEach(attachMoneyInput)`
- La submit: `parseMoneyRO(el.value)` înainte de POST

**Câmpuri speciale:**
- `n-ramana` — disabled inițial; `attachMoneyInput` funcționează corect pe disabled inputs (ignoră până e enabled)
- `nf-valoare_totala_mii_lei` — deja `type="text"`, deci nu schimbăm tipul; adăugăm doar `data-money="true"` + call `attachMoneyInput` la init și la `nfLoad()`

### Pasul 4 — PDF generator (Categoria 1.3)
```js
// server/services/formulare-oficiale/nf-invest-pdf.mjs — adaugă la top:
function formatMoneyRO(value, decimals = 2) { ... }

// linia 188:
const valoare = data.valoare_totala_mii_lei
  ? `${formatMoneyRO(data.valoare_totala_mii_lei)} mii lei`
  : '—';
```

### Pasul 5 — Cache-busting
- `package.json`: 3.9.330 → 3.9.331
- `public/formular.html`, `public/notafd-invest-form.html`: bump `?v=`

### Categoria 2 — NU se atinge în Faza B inițială
Inputurile din tabelele dinamice (ORD/NV/NP/NC) rămân `type="number"` native.
Totalurile lor (`st2()`) sunt deja formatate ro-RO. Se poate face separat după decizia Mircea.

---

## Risc și complexitate estimată

| Scope | Complexitate | Risc regresie |
|---|---|---|
| Categoria 1.1 (6 inputs standalone) | Mică | Scăzut — nu afectează calcule |
| Categoria 1.3 (PDF) | Minimă | Zero — afișaj vizual doar |
| Categoria 2 (tabel rows) | Mare (refactor `sf()` + `calcORRow`) | Mediu-ridicat |
