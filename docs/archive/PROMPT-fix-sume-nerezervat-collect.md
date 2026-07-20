---
titlu: Fix corupere sume DF la trimiterea către P1 ("Nu s-au rezervat…" / "Rămâne suma") — parse RO la persistare
model_suggested: Sonnet 4.6 (Default)  # fix chirurgical, izolat, 3 linii; nu atinge financiar-serializarea sau XSD
branch: develop
versiune_curenta: 3.9.697
---

# ⚠️ BRANCH: develop — EXCLUSIV
# `main` = PRODUCȚIE, administrat MANUAL de Mircea. NU face merge / push / checkout pe `main`.
# Toate modificările stau pe `develop` (auto-deploy pe staging).

====================================================================
CONTEXT — bug financiar (grav)
====================================================================
În DF, când responsabilul CAB (rol P2) completează câmpurile "Nu s-au rezervat …
credite de angajament în cuantum de [X] lei, respectiv credite bugetare în cuantum de [Y] lei"
și finalizează secțiunea către P1, valoarea se corupe.

Exemplu reprodus: introdus 2964,50 → după trimitere devine 2,96.

CAUZA (dovedită, NU presupusă):
- Inputurile `n-sumfara`, `n-sumfararezvcrbug`, `n-ramana` au `data-money="true"`
  (public/formular.html:1184,1186,1059) → la blur `attachMoneyInput` le formatează
  românește: "2964,50" devine în DOM **"2.964,50"** (cu punct de mii).
- La persistarea în DB, funcțiile de colectare din `public/js/formular/doc.js` iau
  valoarea **BRUTĂ** cu `g('n-sumfara')` (string afișat "2.964,50"), NU o parsează:
      collectDfP2Db(): sum_fara_inreg_ctrl_crdbug:g('n-sumfara')||'0'
      collectDfP2Db(): sum_fara_inreg_ctrl_crd_bug:g('n-sumfararezvcrbug')||'0'
      collectDfP1Db(): ramane_suma:g('n-ramana')||'0'
  → în DB ajunge string-ul "2.964,50".
- La reafișare, `sv()` (doc.js) face pentru câmpurile data-money:
      e.value = fMR(parseFloat(val)||0)
  iar `parseFloat("2.964,50")` = **2.964** (JS se oprește la virgulă) →
  `fMR(2.964)` = **"2,96"**. Coruperea.

REFERINȚA CORECTĂ (deja în cod): `public/js/formular/core.js` (funcția `colN`, ~liniile
444/452/453) colectează ACELEAȘI câmpuri corect, cu `String(pMR(g('...'))||0)`.
`pMR` normalizează "2.964,50" → 2964.5 (elimină punctele de mii, virgulă→punct).
Deci fix-ul aliniază calea de PERSISTARE (doc.js) la calea canonică (core.js/colN).

`pMR` este deja disponibil ca identificator global în doc.js (folosit de 16 ori;
listat în header-ul modulului la "Cross-module reads").

DOMENIU: EXCLUSIV cele 3 linii de mai jos. ORD (`collectOrdDb`) NU e afectat — toate
sumele ORD trec prin `getOR()` care deja aplică `pMR`. Verificat.

====================================================================
PASUL 1 — patch collectDfP2Db (cele 2 câmpuri "Nu s-au rezervat")
====================================================================
Fișier: public/js/formular/doc.js

old_str:
  sum_fara_inreg_ctrl_crdbug:g('n-sumfara')||'0',
  sum_fara_inreg_ctrl_crd_bug:g('n-sumfararezvcrbug')||'0',

new_str:
  sum_fara_inreg_ctrl_crdbug:String(pMR(g('n-sumfara'))||0),
  sum_fara_inreg_ctrl_crd_bug:String(pMR(g('n-sumfararezvcrbug'))||0),

====================================================================
PASUL 2 — patch collectDfP1Db (câmpul "Rămâne suma")
====================================================================
Fișier: public/js/formular/doc.js

old_str:
  ckbx_stab_tin_cont:cb('n-ck-stab'),ckbx_ramane_suma:cb('n-ck-ramane'),ramane_suma:g('n-ramana')||'0',

new_str:
  ckbx_stab_tin_cont:cb('n-ck-stab'),ckbx_ramane_suma:cb('n-ck-ramane'),ramane_suma:String(pMR(g('n-ramana'))||0),

====================================================================
PASUL 3 — verificare grep (NU trebuie să mai rămână niciun `g('n-...')` money brut în doc.js)
====================================================================
bash:
  grep -nE "ramane_suma:|sum_fara_inreg_ctrl_crdbug:|sum_fara_inreg_ctrl_crd_bug:" public/js/formular/doc.js
# Așteptat: toate trei liniile conțin acum `String(pMR(g(...))||0)`, niciuna `g('n-...')||'0'`.

bash:
  grep -nE "g\('n-(ramana|sumfara|sumfararezvcrbug)'\)\|\|'0'" public/js/formular/doc.js
# Așteptat: 0 rezultate (niciun câmp money mai colectat brut).

====================================================================
PASUL 4 — teste (fără regresii)
====================================================================
bash:
  npm test
# Așteptat: npm test verde, fără regresii (suita crește în timp — nu fixa un număr).

====================================================================
PASUL 5 — bump versiune + cache-busting ȚINTIT
====================================================================
- doc.js NU este în PRECACHE_ASSETS (sw.js) → NU bumpa CACHE_VERSION.
- package.json: 3.9.697 → 3.9.698 (patch).
- `?v=` pe doc.js este 3.9.693 în formular.html (drift intenționat față de package.json).
  Bump ȚINTIT DOAR pe acest asset, la noua versiune:

bash:
  sed -i -E "s#(formular/doc\.js\?v=)[0-9.]+#\13.9.698#g" public/formular.html
  grep -n "formular/doc.js?v=" public/formular.html
# Așteptat: formular/doc.js?v=3.9.698

NU face sed bulk pe toate `?v=` — se șterge drift-ul intenționat.

====================================================================
PASUL 6 — commit pe develop
====================================================================
bash:
  git checkout develop
  git add public/js/formular/doc.js public/formular.html package.json
  git commit -m "fix(df): parse RO amounts on P1/P2 persist (sum nerezervat + ramane_suma) — 2964,50 no longer collapses to 2,96 (v3.9.698)"
  git push origin develop
# NU atinge main.

====================================================================
RAPORT FINAL (obligatoriu)
====================================================================
1. Diff-ul celor 3 linii (înainte/după).
2. Ieșirea grep de la Pasul 3 (dovada că nu mai există `g('n-...')||'0'` money).
3. Rezultatul `npm test` (verde / fără regresii).
4. Confirmare `?v=` doc.js = 3.9.698 și package.json = 3.9.698, CACHE_VERSION neschimbat.
5. Commit hash pe develop.
6. NOTĂ de raportat lui Mircea: rândurile DEJA corupte în DB (ex. valoarea afișată "2,96")
   NU se auto-repară — CAB trebuie să redeschidă DF-ul și să reintroducă suma corectă
   după deploy pe staging. (Reparare în masă opțională, separat, cu backup pg_dump.)

====================================================================
⛔ CONSTRÂNGERI ABSOLUTE
====================================================================
⛔ Doar `develop`. NU merge/push/checkout pe `main`.
⛔ NU atinge NO-TOUCH: server/signing/*.
⛔ NU atinge financiar-serializarea XML (server/services/alop-xml/*) — acela e un fix SEPARAT (Bug B).
⛔ NU modifica core.js/colN — este deja referința corectă; DOAR aliniezi doc.js la ea.
⛔ NU face sed bulk pe `?v=`. Bump țintit DOAR pe formular/doc.js.
⛔ Domeniul e strict cele 3 linii. Fără refactor colateral.
