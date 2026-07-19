---
prompt: 100.1
titlu: "fix(ord): coloanele de identitate se blochează când ORD-ul e legat de un DF aprobat"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: public/js/formular/{core.js,doc.js,list.js} — DOAR frontend
versiune_tinta: v3.9.685
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.682)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.

---

## CONTEXT — regula de business

**ORD-ul își ia codurile din DF-ul aprobat. Punct.** Nu le inventează, nu le corectează, nu le
completează de mână.

Codul o respectă parțial: `public/js/formular/list.js:171-184` (`onDfSelect`) prepopulează din
`rows_ctrl`-ul DF-ului cele patru coloane de identitate:

```
cod_angajament · indicator_angajament · program · cod_SSI
```

**Dar câmpurile rămân editabile.** `core.js:129` (`addOR`) le generează ca
`<input type="text">` simplu — fără `readonly`. După prepopulare, oricine poate rescrie codul cu
mâna. Un `cod_SSI` greșit pe ORD = bani publici ordonanțați la plată pe altă linie bugetară.

DF-ul e apărat (validare Clasa 8, prompt #98). ORD-ul nu are validare **și nici nu are nevoie** —
sursa lui e deja validată. Ce-i lipsește e **să nu poată fi contrazisă**.

⚠️ **Nu adăuga validare Clasa 8 pe ORD.** Ar fi redundantă. Fix-ul e blocarea câmpurilor.

---

## PAS 0 — RECON (read-only)

```bash
sed -n '25,40p'   public/js/formular/doc.js    # mecanismul existent: o-df-sel disabled când o-df-id are valoare
sed -n '95,112p'  public/js/formular/doc.js    # încărcarea unui ORD salvat (doc.rows → addOR + fill)
sed -n '340,350p' public/js/formular/doc.js    # lockAll(ft, lock)
sed -n '128,135p' public/js/formular/core.js   # addOR() — șablonul rândului
sed -n '160,190p' public/js/formular/list.js   # onDfSelect() — prepopularea din DF
grep -n "lockAll('ordnt'\|lockAll(\"ordnt\"\|lockAll(ft" public/js/formular/doc.js
grep -n "badd" public/formular.html | grep -n "addOR"
```

**Răspunde înainte să scrii:** câte locuri cheamă `lockAll` pentru `ordnt`? Blocarea nouă trebuie
**re-aplicată după fiecare**, altfel `lockAll(ft,false)` (P1 în draft/returnat) o anulează.

---

## PAS 1 — O singură funcție, în `doc.js`

```js
// Coloanele de identitate ale ORD-ului sunt DERIVATE din DF-ul aprobat (rows_ctrl), nu introduse
// de utilizator. Odată ce ORD-ul e legat de un DF (`#o-df-id` are valoare), ele se citesc, nu se scriu.
const ORD_IDENT_COLS = ['cod_angajament', 'indicator_angajament', 'program', 'cod_SSI'];

function lockOrdIdentityCols() {
  const linked = !!(document.getElementById('o-df-id')?.value || '').trim();
  document.querySelectorAll('#o-tbody tr').forEach(tr => {
    ORD_IDENT_COLS.forEach(f => {
      const inp = tr.querySelector(`[data-f="${f}"]`);
      if (!inp) return;
      inp.readOnly = linked;
      inp.tabIndex = linked ? -1 : 0;
      inp.title    = linked ? 'Preluat din DF-ul aprobat — nu poate fi modificat' : '';
      inp.classList.toggle('df-derived', linked);
    });
  });
  // Rândurile ORD oglindesc rows_ctrl-ul DF-ului ⇒ cât timp e legat, nu se adaugă rânduri manual.
  const badd = document.querySelector('#form-ordnt .badd');
  if (badd) badd.disabled = linked;
}
```

**`readOnly`, nu `disabled`** — valorile trebuie să ajungă în payload la salvare.

Stil (`public/css/formular.css` sau fișierul unde sunt stilizate coloanele calculate — **caută
`readonly` existent în CSS și refolosește tiparul**, nu inventa culori noi):

```css
#o-tbody input.df-derived { background: rgba(255,255,255,.07); cursor: default; }
```

---

## PAS 2 — Trei puncte de apel

1. **La încărcarea unui ORD salvat** — `doc.js`, imediat după bucla care umple `#o-tbody` din
   `doc.rows` (linia ~108) **și după** ce se setează `#o-df-id` (linia ~100). Ordinea contează:
   funcția citește `#o-df-id`.
2. **La selectarea DF-ului** — `list.js`, la finalul lui `onDfSelect()`, după `upTot()`.
   ⚠️ `onDfSelect` setează doar `o-df-sel`; verifică dacă setează și `o-df-id`. Dacă **nu**, funcția
   ta va vedea `linked = false` și nu va bloca nimic. **Raportează ce ai găsit** și rezolvă corect
   (sursa adevărului = `o-df-id`, hidden, cel citit la salvare — `doc.js:57`).
3. **După fiecare `lockAll(...)` pe `ordnt`** — toate call-site-urile găsite la PAS 0.

Expune funcția pe `window` dacă `list.js` și `doc.js` nu se văd direct (vezi cum face
`window._loadOrdBuget`, `list.js:186`).

---

## PAS 3 — Test

`server/tests/unit/` — testele de frontend din proiect citesc fișierul sursă și verifică tiparul
(vezi `sw-no-auth-cache.test.mjs` ca model). Aici e suficient un test de regresie care apără
**invarianta**, nu implementarea:

1. `core.js` — rândul ORD (`addOR`) conține cele 4 `data-f` de identitate (dacă cineva le redenumește,
   blocarea devine tăcut inoperantă)
2. `doc.js` — `ORD_IDENT_COLS` conține exact cele 4 câmpuri, iar `lockOrdIdentityCols` folosește
   `readOnly` (**nu** `disabled`)

⛔ Testul citește fișierul real din `public/js/`. Nu redeclara lista de coloane în test.

---

## PAS 4 — Versiune și cache

`package.json` → **v3.9.685**.

```bash
grep -n "formular/core.js\|formular/doc.js\|formular/list.js\|formular.css" public/sw.js
# La #98/#90 s-a stabilit: NU sunt în PRECACHE_ASSETS ⇒ doar ?v=, FĂRĂ bump CACHE_VERSION.
# CONFIRMĂ pentru fiecare fișier pe care îl atingi efectiv. Dacă vreunul E în PRECACHE_ASSETS,
# bumpează CACHE_VERSION.
```

Bump `?v=` în `public/formular.html` pentru fișierele atinse.

```bash
npm run check && npm test
```

Commit:
```
fix(ord): coloanele de identitate blocate când ORD-ul e legat de DF aprobat (v3.9.685)
```

---

## RAPORT FINAL

1. `onDfSelect` setează `#o-df-id`, sau doar `#o-df-sel`? Ce ai găsit, ce ai făcut?
2. Câte call-site-uri `lockAll` pe `ordnt`? Ai re-aplicat blocarea după **toate**?
3. Un ORD **fără** DF selectat — câmpurile rămân editabile? (Trebuie. Nu blocăm ce n-are sursă.)
4. `readOnly`, nu `disabled` — confirmă că valorile ajung în payload-ul de salvare (`doc.js:57` colectează `rows`).
5. Butonul „+" (`.badd`) e dezactivat când ORD-ul e legat? Cel de ștergere („✕") — l-ai atins? (**Nu trebuia.**)
6. Ai adăugat validare Clasa 8 pe ORD? (**Răspunsul corect e NU.**)
7. `CACHE_VERSION` — bumpat sau nu, și de ce? Lipește ieșirea `grep`-ului din PAS 4.
8. `git diff --name-only` — lipește. Trebuie să conțină **doar** `public/js/formular/*`, `public/formular.html`, CSS, `package.json`, testul.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Zero cod de server.** Fix-ul e pur frontend.
- ⛔ **Fără validare Clasa 8 pe ORD.** Sursa (DF-ul) e deja validată la #98.
- ⛔ **`readOnly`, nu `disabled`.** `disabled` ar putea scoate valorile din payload.
- ⛔ Nu atinge coloanele de sume (col. 2–5) — alea **se completează** de CAB, sunt tot rostul ORD-ului.
- ⛔ Nu atinge `rows_ctrl` / DF-ul. Doar tabelul ORD (`#o-tbody`).
