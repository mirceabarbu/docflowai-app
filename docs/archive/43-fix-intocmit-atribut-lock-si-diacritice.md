---
fix: Integritate ÎNTOCMIT — blochează ȘI atributul (nu doar userul) pe rândul ÎNTOCMIT în UI + forțarea identității pe server devine robustă la diacritice (ÎNTOCMIT ≡ INTOCMIT). Închide spoof-ul vizual al rolului de autor.
target_branch: develop
model_suggested: Opus 4.8 (atinge normalizarea semnatarilor + garanția de identitate ÎNTOCMIT — rigoare pe securitate)
risk: MIC-MEDIU (aditiv; autoral era deja sigur prin initEmail actor-derived — asta întărește lacătul de rol + defense-in-depth)
version: 3.9.622 → 3.9.623
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.
> Ordine de aplicare: după promptul 42 („Transmis de —"). Dacă îl aplici înaintea lui 42, ajustează bump-ul de versiune ca să rămână strict crescător.

# Simptom (owner, checklist grup A)
Pe „Flux nou", rândul ÎNTOCMIT: userul (persoana) e blocat corect, DAR **atributul poate fi modificat**. Schimbând atributul, numele se deblochează și primul rând devine editabil liber.

# Cauză (confirmată în cod)
- **Frontend** `public/js/semdoc-initiator/main.js` — `lockIntocmitRowIdentity` (~linia 818) blochează DOAR `.name-select` (`nameSel.disabled = true`), nu și `.rol` (atributul) sau `.rolCustom`.
- **Backend** `server/routes/flows/crud.mjs:152` — detecția rolului e sensibilă la diacritice: `String(s.rol || s.atribut || '').trim().toUpperCase() === 'ÎNTOCMIT'`. Un atribut custom fără diacritic (`INTOCMIT`, I simplu, prin „Alt atribut...") NU matchează → identitatea nu mai e forțată pe acel rând → semnatar etichetat ~„INTOCMIT" cu nume/email inventat.

# Ce e DEJA sigur (NU regresa)
`crud.mjs:113-114` — `initEmail`/`initName` (autorul fluxului din `flow.data`) se derivă mereu din actorul autentificat, indiferent de body. **Autoral fluxului NU se poate falsifica** și rămâne așa. Fix-ul de față întărește DOAR garanția pe rândul-semnatar ÎNTOCMIT + UI.

# Etapa 0 — caracterizare (rulează ÎNAINTE; raportează liniile reale)
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== lock UI (doar name?) ==="; grep -n "lockIntocmitRowIdentity\|unlockIntocmitRowIdentity\|nameSel.disabled\|\.rol\b\|rolCustom\|intocmitLocked" public/js/semdoc-initiator/main.js | head -30
echo "=== detecție rol server ==="; grep -n "isIntocmitRole\|=== 'ÎNTOCMIT'\|initEmail = String(actor" server/routes/flows/crud.mjs
```

# Modificări

## 1. Frontend — blochează atributul pe rândul ÎNTOCMIT (oglindă la lacătul de nume)
`public/js/semdoc-initiator/main.js`.

**a.** În `lockIntocmitRowIdentity(tr, nameSel)`, în blocul `finish()` (unde se setează `nameSel.disabled = true`), adaugă și lacătul pe atribut:
```js
const rolSel = tr.querySelector('.rol');
if (rolSel) {
  rolSel.value = 'ÎNTOCMIT';
  rolSel.disabled = true;
  rolSel.dataset.intocmitLocked = '1';
  rolSel.style.opacity = '.65';
  rolSel.style.cursor = 'not-allowed';
  rolSel.title = 'Rândul ÎNTOCMIT nu poate schimba atributul — ești chiar tu, autorul.';
}
const rolCustom = tr.querySelector('.rolCustom');
if (rolCustom) rolCustom.style.display = 'none';
```
Extinde garda de idempotență de la începutul funcției ca să NU refacă lacătul dacă e deja pus corect (evită re-dispatch → buclă `MutationObserver`, root cause reparat în 35):
```js
if (nameSel.dataset.intocmitLocked === '1' && nameSel.value === u.nume
    && tr.querySelector('.rol')?.disabled) return;
```

**b.** În `unlockIntocmitRowIdentity(nameSel)` — semnătura primește și `tr` (sau recuperează `tr` din `nameSel.closest('tr')`), și dezblochează atributul simetric:
```js
const tr = nameSel.closest('tr');
const rolSel = tr?.querySelector('.rol');
if (rolSel && rolSel.dataset.intocmitLocked === '1') {
  rolSel.disabled = false;
  delete rolSel.dataset.intocmitLocked;
  rolSel.style.opacity = ''; rolSel.style.cursor = ''; rolSel.title = '';
}
```
(Actualizează și apelul din `updateIntocmitVisibility`, dacă schimbi semnătura.)

> NU atinge logica `updateIntocmitVisibility` de ascundere a opțiunii ÎNTOCMIT pe rândurile ulterioare (funcționează). Doar extinzi lock/unlock.

## 2. Backend — forțarea identității ÎNTOCMIT robustă la diacritice (plasa reală)
`server/routes/flows/crud.mjs`, în `normalizedSigners.map(...)`. Înlocuiește comparația fragilă cu una normalizată (Î ≡ I), astfel încât și `INTOCMIT` fără diacritic să fie tratat ca rol de autor și să primească identitatea actorului:
```js
const _rolNorm = String(s.rol || s.atribut || '')
  .trim().toUpperCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // scoate diacriticele (Î→I, Ș→S…)
const isIntocmitRole = _rolNorm === 'INTOCMIT';
```
Restul blocului (`name: isIntocmitRole ? initName : …`, `email: isIntocmitRole ? initEmail.toLowerCase() : …`) rămâne neschimbat. Efect: orice variantă a atributului de autor (cu/fără diacritic) primește identitatea reală → dispare spoof-ul vizual.

> NU schimba `initEmail`/`initName` (deja actor-derived). NU atinge alte roluri.

# Test
Extinde testul care acoperă `createFlow`/identitatea ÎNTOCMIT (caută `createFlow`/`initEmail`/`ÎNTOCMIT` în `server/tests/`). Adaugă:
- rând cu `rol: 'INTOCMIT'` (fără diacritic) + `name/email` inventate în body → semnatarul rezultat are `name === actor.nume` și `email === actor.email` (identitate forțată, NU cea din body).
- rând cu `rol: 'ÎNTOCMIT'` (cu diacritic) → același rezultat (fără regresie).
Fără hardcodare de count.

# Verificare manuală (owner)
1. „Flux nou" → pe rândul ÎNTOCMIT, dropdown-ul de **atribut** e gri/blocat pe „ÎNTOCMIT"; nu ajungi la „Alt atribut..." pe acel rând.
2. Numele rămâne blocat pe tine; pagina NU îngheață (fără „Page Unresponsive").
3. Schimbi un rând ulterior între atribute → funcționează normal; ÎNTOCMIT rămâne exclusiv pe primul rând.
4. (dacă ai unelte API) POST creare flux cu primul rând `rol:"INTOCMIT"` + nume/email fals → fluxul salvat are ÎNTOCMIT = tu, nu identitatea falsă.

# Guardrails diff
EXCLUSIV: `public/js/semdoc-initiator/main.js`, `server/routes/flows/crud.mjs`, testul de identitate ÎNTOCMIT, `public/*.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|alop\.mjs|flow-transmit\.mjs|transmit\.mjs|flow-access\.mjs|index\.mjs" && echo "⛔ STOP: zonă interzisă atinsă!" || echo "✅ NO-TOUCH respectat (semnare + financiar + transmitere + notify neatinse)"
```

# Cache busting + versiune
3.9.622 → 3.9.623. `CACHE_VERSION` în `public/sw.js`. `?v=3.9.623` pe `semdoc-initiator/main.js` în HTML-urile care îl încarcă.

# La final
```bash
git add -A -- public/js/semdoc-initiator/main.js server/routes/flows/crud.mjs server/tests/**/*intocmit*.* public/*.html public/sw.js package.json
git commit -m "fix(sec): lacăt pe atributul ÎNTOCMIT în UI + forțare identitate robustă la diacritice (ÎNTOCMIT≡INTOCMIT) (v3.9.623)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) atribut + nume blocate simetric pe rândul ÎNTOCMIT, fără buclă MutationObserver; (2) detecția server normalizată (Î≡I), `initEmail`/`initName` neschimbate; (3) testul cu `INTOCMIT` fără diacritic forțează identitatea actorului; (4) `npm test verde, fără regresii`, `npm run check` OK, v3.9.623.
