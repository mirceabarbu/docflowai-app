---
fix: La ORD, câmpul „Nr. unic înregistrare Document de Fundamentare" (select o-df-sel) devine NEEDITABIL când ORD-ul are deja un DF legat (o-df-id setat — cazul ALOP și al oricărui ORD salvat cu DF). Un ORD nou fără DF rămâne selectabil. Integritatea legăturii ORD↔DF în ciclul ALOP.
target_branch: develop
model_suggested: Opus 4.8 (atinge fluxul ALOP/ORD — sensibil, în producție de luni; rigoare)
risk: MIC (pur frontend; blochează VIZUAL select-ul, valorile salvate rămân în hidden o-df-id/o-nrUnic — neatinse)
version: 3.9.632 → 3.9.633
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final: `git push origin develop` și **STOP**.
> Notă: arhiva de referință a fost v3.9.630; develop e la 3.9.632 (50/51/52 nu au atins formularul ORD/ALOP). Etapa 0 re-caracterizează pe develop-ul curent.

# Cerință (owner)
ORD e generată strict în ciclul ALOP și e legată de un DF (ex. „DF 2468 — Servicii digitalizare (R1)"). Câmpul de referință DF NU trebuie editabil manual — schimbarea lui ar rupe legătura ORD↔DF.

# Structură (confirmată în cod — NU presupune)
- `public/formular.html:660` — `<select id="o-df-sel" onchange="selectDfAprobat()">` = câmpul VIZIBIL de referință DF.
- `public/formular.html:663-664` — `<input id="o-nrUnic" type="hidden">` și `<input id="o-df-id" type="hidden">` = valorile SALVATE (`df_id`, `nr_unic_inreg`). Select-ul e doar UI-ul de selecție.
- La salvare, `df_id` vine din `o-df-id` (doc.js:41), NU din select → **blocarea vizuală a select-ului NU pierde nimic**.
- ALOP setează select-ul: `alop.js` (~811 și ~838) face `s.value=alop.df_id; s.dispatchEvent(new Event('change'))` → rulează `selectDfAprobat()` → setează `o-df-id`.
- Load ORD salvat: `doc.js:83-84` setează `o-df-sel.value` și `o-df-id` din `doc.df_id`.
- Reset/ORD nou: `doc.js:882-883` golește `o-df-sel` și `o-df-id`.

# Regulă (fixată)
Select-ul `o-df-sel` e **disabled** când `o-df-id` are valoare (DF legat) și **enabled** când e gol (ORD nou fără DF). Astfel: ORD din ALOP → mereu legat → mereu blocat; ORD salvat cu DF → blocat la redeschidere; ORD nou gol → selectabil.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
grep -n 'id="o-df-sel"\|id="o-df-id"\|id="o-nrUnic"' public/formular.html
echo "=== unde e definit selectDfAprobat ==="; grep -rn 'function selectDfAprobat\|selectDfAprobat\s*=' public/js/formular/*.js
echo "=== call sites: load (doc.js ~84), reset (doc.js ~883), ALOP (alop.js) ==="; grep -n "o-df-id')?.value\|dfId.value=doc.df_id\|dfId.*value=''\|o-df-sel')" public/js/formular/doc.js
```

# Modificare (TOATE frontend)

## 1. Helper — `public/js/formular/doc.js` (expus pe window)
```js
function lockDfSelectIfLinked() {
  const sel = document.getElementById('o-df-sel');
  const dfId = document.getElementById('o-df-id');
  if (!sel || !dfId) return;
  const linked = (dfId.value || '').trim().length > 0;
  sel.disabled = linked;
  sel.title = linked ? 'Documentul de Fundamentare este stabilit de ciclul ALOP și nu poate fi schimbat aici.' : '';
  sel.style.opacity = linked ? '.7' : '';
  sel.style.cursor = linked ? 'not-allowed' : '';
}
window.lockDfSelectIfLinked = lockDfSelectIfLinked;
```

## 2. Apeluri
- `public/js/formular/doc.js`, la finalul funcției de LOAD (după `dfId.value=doc.df_id` ~linia 84): `lockDfSelectIfLinked();`
- `public/js/formular/doc.js`, la RESET/ORD nou (după golirea `o-df-id` ~linia 883): `lockDfSelectIfLinked();`
- La finalul funcției `selectDfAprobat()` (unde e definită — vezi Etapa 0): `if (window.lockDfSelectIfLinked) window.lockDfSelectIfLinked();`
  (acoperă și dispatch-ul programatic din ALOP, și selecția manuală — ambele setează `o-df-id` apoi blochează.)

> NU atinge salvarea (`o-df-id`/`o-nrUnic` hidden rămân sursa valorilor). NU schimba `selectDfAprobat` în rest. NU atinge backend-ul/serializer-ul ALOP. NU blochează dacă `o-df-id` e gol (ORD nou trebuie să rămână selectabil).

# Notă (out of scope, pentru mai târziu)
Blocarea e pe UI. O gardă server-side (respinge schimbarea `df_id` pe un ORD ALOP-legat, din body) ar fi complementul robust, dar atinge logica de salvare ALOP — o tratăm SEPARAT, cu test, NU în acest fix rapid post-lansare. NU o include aici.

# Verificare manuală (owner)
1. Deschizi/creezi ORD din ciclul ALOP → câmpul „Nr. unic înregistrare DF" e gri/blocat pe „DF 2468 …", cu tooltip; nu-l poți schimba.
2. Salvezi ORD, îl redeschizi → tot blocat pe DF-ul legat.
3. (dacă există) ORD nou fără DF → select-ul e activ, poți alege; după alegere se blochează (ORD-ul e acum legat).
4. Valorile salvate (df_id, nr_unic) rămân corecte — verifici că ORD-ul păstrează legătura la DF după salvare.

# Guardrails diff
EXCLUSIV: `public/js/formular/doc.js`, `public/js/formular/list.js` (dacă acolo e `selectDfAprobat`), `public/*.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "server/|\.mjs$|alop\.js|ord-to-xsd|serializer|signing|pades" && echo "⛔ STOP: backend/serializer/ALOP-logic/semnare atinse — trebuie DOAR UI select!" || echo "✅ pur frontend UI"
```
> `alop.js` NU trebuie atins (blocarea se face în selectDfAprobat/doc.js, care rulează oricum pe calea ALOP).

# Cache busting + versiune
`package.json` 3.9.632 → 3.9.633. `CACHE_VERSION` în `public/sw.js`. `?v=3.9.633` pe `formular/doc.js` (+ `formular/list.js` dacă a fost atins) în `public/formular.html`.

# La final
```bash
git add -A -- public/js/formular/doc.js public/js/formular/list.js public/*.html public/sw.js package.json
git commit -m "fix(ord): referința DF needitabilă când ORD e legat de DF (ciclu ALOP); ORD nou rămâne selectabil; valori salvate intacte (v3.9.633)"
git push origin develop
```
(Dacă `list.js` n-a fost atins, scoate-l din add și din `?v=`.)
**STOP. NU merge/push pe `main`.** Raportează: (1) helper + cele 3 call-site-uri; (2) select blocat DOAR când o-df-id setat, enabled la ORD nou gol; (3) valorile salvate (hidden) neatinse, backend/ALOP-logic neatinse; (4) `npm test verde, fără regresii`, `npm run check` OK, v3.9.633.
