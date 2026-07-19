---
fix: La ORD, câmpul Beneficiar afișează un badge de avertizare când furnizorul e într-o stare anormală la ANAF (radiată/inactivă/TVA anulat). Datele există deja în /api/verify/cui; se oglindește logica de badge din verif.js. Non-blocant. Și pe furnizorii din DB (verificare de stare async), nu doar pe cei preluați live din ANAF.
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — pur frontend, oglindește logică existentă; zero backend/serializer/ALOP
risk: MIC (aditiv, display-only; NU se persistă pe ORD, NU atinge serializer/mapper)
version: 3.9.626 → 3.9.627
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.

# Cerință (owner)
La completarea ORD, în cardul „Compartiment specialitate — Date beneficiar & plată", când introduci CIF-ul beneficiarului platforma preia denumirea (ANAF sau DB). Dacă furnizorul e **radiat / inactiv / cu TVA anulat**, acum NU apare niciun semnal — deși modulul de verificare știe starea. Adaugă un **badge de avertizare** lângă câmpul Beneficiar. **Avertizare, nu blocare** — lansarea ORD rămâne permisă (owner decide). NU se persistă pe ORD (fază 1, frontend); persistarea e discuție separată post-ALOP.

# Ce există deja (NU reinventa)
- `GET /api/verify/cui?cui=<cif>` întoarce în `data`: `radiated`, `radiatedDate`, `inactive`, `inactiveDate`, `reactivationDate`, `vat`, `vatEndDate`, `vatStartDate`, `stareInregistrareText`, `name`. (Confirmă cu Etapa 0.)
- `public/js/formular/verif.js:85-91` are DEJA logica de badge severitate (RADIATĂ/INACTIVĂ roșu; TVA anulat chihlimbariu; activ verde) — o **oglindești**, n-o rescrii de la zero.
- Câmpul Beneficiar: `public/formular.html:685` → `<textarea id="o-benef">` + `<div id="o-benef-drop">`.
- Path-ul de verificare la ORD: `public/js/formular/list.js` → `_lookupByCif()` (~linia 193): întâi local (`/api/beneficiari`), apoi fallback ANAF (`/api/verify/cui`). Calea ANAF are deja tot obiectul de stare (folosește doar `.name`); calea locală NU are stare.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== campuri stare din /api/verify/cui ==="; grep -n "radiated\|inactive\|vat\b\|stareInregistrareText\|vatEndDate\|radiatedDate" server/services/verify/anafClient.mjs | head
echo "=== _lookupByCif: cele doua cai ==="; sed -n '193,246p' public/js/formular/list.js
echo "=== badge verif.js de oglindit ==="; sed -n '85,91p' public/js/formular/verif.js
echo "=== test frontend existent ==="; ls server/tests/unit/cif-lookup-frontend.test.mjs
```

# Modificări (TOATE frontend)

## 1. HTML — container pentru badge — `public/formular.html`
Imediat DUPĂ `<div id="o-benef-drop" class="ac-drop"></div>` (linia ~686), adaugă:
```html
<div id="o-benef-status" style="margin-top:6px;min-height:0;" aria-live="polite"></div>
```

## 2. Helper de badge — `public/js/formular/list.js`
Adaugă o funcție pură care oglindește severitatea din verif.js și scrie în `#o-benef-status`. Ordinea severității: radiat > inactiv > TVA anulat > activ.
```js
function renderBenefStatusBadge(d){
  const box = document.getElementById('o-benef-status');
  if(!box) return;
  if(!d){ box.innerHTML=''; return; }
  const esc = window.esc || (s=>String(s==null?'':s));
  const red   = 'background:rgba(239,68,68,.15);color:#ff8080;padding:3px 12px;border-radius:10px;font-size:.78rem;font-weight:700;display:inline-flex;align-items:center;gap:6px;';
  const amber = 'background:rgba(251,191,36,.15);color:#fbbf24;padding:3px 12px;border-radius:10px;font-size:.78rem;font-weight:700;display:inline-flex;align-items:center;gap:6px;';
  const green = 'color:#5eead4;font-size:.76rem;font-weight:600;';
  if(d.radiated){
    box.innerHTML = `<span style="${red}">⛔ Beneficiar RADIAT la ANAF${d.radiatedDate?(' — '+esc(d.radiatedDate)):''} · verifică înainte de plată</span>`;
  } else if(d.inactive){
    box.innerHTML = `<span style="${red}">⛔ Beneficiar INACTIV fiscal${d.inactiveDate?(' din '+esc(d.inactiveDate)):''}${d.reactivationDate?(' · reactivat '+esc(d.reactivationDate)):''} · verifică înainte de plată</span>`;
  } else if(d.vat===false && d.vatEndDate){
    box.innerHTML = `<span style="${amber}">⚠ TVA anulat la ANAF${d.vatEndDate?(' la '+esc(d.vatEndDate)):''}</span>`;
  } else {
    box.innerHTML = `<span style="${green}">✓ În funcțiune la ANAF${d.stareInregistrareText?(' · '+esc(d.stareInregistrareText)):''}</span>`;
  }
}
window.renderBenefStatusBadge = renderBenefStatusBadge;
```

## 3. Cablare în `_lookupByCif()` — `public/js/formular/list.js`
- La ÎNCEPUTUL funcției (după ce ai `cifEl`), **curăță** badge-ul: `const _sb=document.getElementById('o-benef-status'); if(_sb) _sb.innerHTML='';`. Și pe return-ul timpuriu când CIF-ul e invalid (`if(!/^\d{2,10}$/.test(cif))`), lasă-l curățat.
- **Calea ANAF** (unde faci `setF('o-benef', j.data.name)`): adaugă imediat `renderBenefStatusBadge(j.data);`.
- **Calea locală** (după ce ai `resolved=true` din `/api/beneficiari`): furnizorul din DB NU are stare → lansează o verificare de stare ANAF **non-blocantă**, cu gardă anti-race (dacă userul a schimbat CIF-ul între timp, nu scrie):
```js
// DB nu are starea ANAF — verifică starea separat (non-blocant, fail-open)
const _cifSnapshot = cif;
fetch('/api/verify/cui?cui='+encodeURIComponent(cif),{credentials:'include'})
  .then(r=>r.ok?r.json():null)
  .then(j=>{
    const cur=document.getElementById('o-cifb');
    if(!cur || (cur.value||'').trim().toUpperCase().replace(/^RO\s*/,'')!==_cifSnapshot) return; // race
    if(j&&j.ok&&j.data) renderBenefStatusBadge(j.data);
  })
  .catch(()=>{}); // ANAF jos → fără badge (e avertizare, nu blocaj)
```
> Denumirea/IBAN/banca se completează instant din DB — verificarea de stare rulează în fundal și badge-ul apare când răspunde. NU întârzia completarea locală.

> NU atinge `core.js` (colectarea câmpurilor ORD) — starea NU se salvează pe ORD. NU atinge serializer/mapper (`ord-to-xsd`, `ordnt-serializer`). NU atinge `verif.js` (rămâne sursa oglindită). NU schimba gating-ul de lansare ORD (avertizare, nu blocaj).

# Test — `server/tests/unit/cif-lookup-frontend.test.mjs` (extinde)
Adaugă aserții pe `renderBenefStatusBadge` (jsdom, ca testul existent):
- `{radiated:true, radiatedDate:'23.07.2013'}` → `#o-benef-status` conține „RADIAT".
- `{inactive:true}` (fără radiated) → conține „INACTIV".
- `{vat:false, vatEndDate:'2012-03-29'}` → conține „TVA anulat".
- `{radiated:false, inactive:false, vat:true, stareInregistrareText:'...'}` → conține „În funcțiune".
- `renderBenefStatusBadge(null)` → golește containerul.
Fără hardcodare de count.

# Verificare manuală (owner)
1. ORD → CIF beneficiar `15352242` (MIRCOMIR SRL, radiată) → sub Beneficiar apare „⛔ Beneficiar RADIAT la ANAF — 23.07.2013 · verifică înainte de plată". Lansarea ORD rămâne posibilă.
2. Un CIF de firmă activă → „✓ În funcțiune la ANAF".
3. Un furnizor salvat în DB care e radiat la ANAF → denumirea/IBAN vin instant din DB, iar badge-ul roșu apare după verificarea de stare.
4. Schimbi CIF-ul rapid → nu rămâne badge-ul vechi (gardă anti-race + curățare la început).
5. ANAF pică / CIF gol → fără badge, fără eroare blocantă.

# Guardrails diff
EXCLUSIV: `public/formular.html`, `public/js/formular/list.js`, `server/tests/unit/cif-lookup-frontend.test.mjs`, `public/*.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "^server/(?!tests)|\.mjs$|ord-to-xsd|ordnt-serializer|verif\.js|core\.js|alop|crud\.mjs|signing|pades" | grep -v "cif-lookup-frontend.test.mjs" && echo "⛔ STOP: backend/serializer/ALOP/verif/core atinse — trebuie DOAR list.js + html + test!" || echo "✅ pur frontend, zero persistare, serializer/ALOP neatinse"
```

# Cache busting + versiune
`package.json` 3.9.626 → 3.9.627. `CACHE_VERSION` în `public/sw.js` (v260→v261). `?v=3.9.627` pe `formular/list.js` în `public/formular.html`.

# La final
```bash
git add -A -- public/formular.html public/js/formular/list.js server/tests/unit/cif-lookup-frontend.test.mjs public/*.html public/sw.js package.json
git commit -m "feat(ord): badge avertizare stare beneficiar ANAF (radiat/inactiv/TVA anulat) la câmpul Beneficiar, non-blocant + verificare stare pe furnizorii din DB (v3.9.627)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) badge randat pe ambele căi (ANAF direct + DB via verificare stare async cu gardă anti-race); (2) severitate oglindită din verif.js (radiat/inactiv roșu, TVA chihlimbariu, activ verde); (3) non-blocant — gating ORD neschimbat; (4) zero persistare, serializer/mapper/ALOP/core.js neatinse; (5) `npm test verde, fără regresii`, `npm run check` OK, v3.9.627.
