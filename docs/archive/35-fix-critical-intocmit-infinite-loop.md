---
fix(crit): buclă infinită MutationObserver în lock-ul ÎNTOCMIT — „Page Unresponsive" pe Inițiere flux
target_branch: develop
model_suggested: Sonnet 5 (fix mic, chirurgical — gardă de idempotență)
risk: FOARTE SCĂZUT (adaugă doar o condiție de ieșire timpurie; nu schimbă comportamentul dorit)
version: 3.9.613 → 3.9.614
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (URGENTĂ — pagina de creare flux e complet blocată, „Page Unresponsive")
Regresie introdusă în v3.9.609 (lock identitate ÎNTOCMIT). Buclă infinită:

1. `MutationObserver` existent pe `tbody` (`{childList:true, subtree:true}`) rulează
   `updateIntocmitVisibility()` la ORICE schimbare în tabel.
2. `updateIntocmitVisibility()` cheamă `lockIntocmitRowIdentity(tr, nameSel)` NECONDIȚIONAT
   de fiecare dată când `isIntocmitRow` e true — inclusiv când rândul e DEJA blocat corect.
3. `lockIntocmitRowIdentity()` → `finish()` face
   `nameSel.dispatchEvent(new Event("change", {bubbles:true}))` NECONDIȚIONAT, chiar dacă
   valoarea nu s-a schimbat față de apelul anterior.
4. Evenimentul „change" declanșează handler-ul existent (`nameSelect.addEventListener("change",...)`)
   care apelează `refreshAllDropdowns()` — aceasta modifică opțiuni în alte `<select>`-uri din
   tabel → mutație DOM în interiorul `tbody`.
5. Acea mutație re-declanșează `MutationObserver` → pasul 2 din nou → **buclă fără capăt**,
   blocând thread-ul JS al paginii ("Page Unresponsive" în Chrome).

# 🚫 NO-TOUCH
Comportamentul DORIT (rândul ÎNTOCMIT blocat, sincronizat cu userul logat, editare imposibilă)
rămâne EXACT cum e — fix-ul adaugă DOAR o gardă de idempotență, nu schimbă ce se întâmplă la
PRIMA blocare a unui rând. `updateIntocmitVisibility()` — restul logicii (afișare/ascundere
opțiune ÎNTOCMIT pe alte rânduri) neschimbat. Backend (`crud.mjs`) — neatins, era corect.

# Etapa 0 — caracterizare
```bash
grep -n "function lockIntocmitRowIdentity\|function unlockIntocmitRowIdentity\|function updateIntocmitVisibility" public/js/semdoc-initiator/main.js
sed -n '786,850p' public/js/semdoc-initiator/main.js
```
Confirmă conținutul exact (poate diferi ușor de ce e documentat aici, dacă au mai fost ajustări).

# Implementare — `public/js/semdoc-initiator/main.js`

## Gardă de idempotență în `lockIntocmitRowIdentity`
Adaugă, la ÎNCEPUTUL funcției (imediat după citirea `u` din `localStorage`), un early-return
dacă rândul e DEJA blocat cu valoarea corectă — nu mai reface nimic, deci nu mai dispatch-uiește
„change" din nou:
```js
function lockIntocmitRowIdentity(tr, nameSel) {
  const u = JSON.parse(localStorage.getItem("docflow_user") || "{}");
  if (!u.email) return;
  // FIX v3.9.614: gardă de idempotență — dacă rândul e deja blocat CU valoarea corectă,
  // nu mai face nimic (evită re-dispatch „change" → refreshAllDropdowns → MutationObserver
  // → buclă infinită, root cause al „Page Unresponsive" pe Inițiere flux).
  if (nameSel.dataset.intocmitLocked === "1" && nameSel.value === u.nume) return;
  const finish = () => {
    ...
```
Restul funcției (`finish`, ramura de așteptare cu `setInterval`) rămâne NESCHIMBAT — garda de
mai sus e SINGURA adăugire, plasată înainte de orice altă logică din funcție.

## Verificare suplimentară (defensivă, opțională dar recomandată)
Dacă vrei o plasă de siguranță în plus (nu obligatoriu dacă garda de mai sus e suficientă):
în `updateIntocmitVisibility()`, înainte de a apela `lockIntocmitRowIdentity(tr, nameSel)`,
poți verifica similar `if (nameSel.dataset.intocmitLocked !== "1")` — dar NU e necesar dacă
garda internă din `lockIntocmitRowIdentity` funcționează corect; nu adăuga complexitate dublă
fără motiv. Preferă UN SINGUR punct de gardă (cel din §Implementare de mai sus).

# Verificare manuală (CRITICĂ — bug-ul e vizual/runtime, nu prins de teste automate)
Pe staging sau local, după deploy:
1. Deschide pagina de creare flux nouă („Inițiere flux").
2. Așteaptă să se încarce complet (inclusiv dropdown-ul de useri).
3. Verifică în DevTools → Performance sau pur și simplu: pagina NU trebuie să înghețe, NU
   trebuie să apară „Page Unresponsive".
4. Rândul ÎNTOCMIT trebuie să rămână blocat (disabled), cu userul logat selectat corect.
5. Schimbă rolul unui alt rând ÎN „ÎNTOCMIT" (dacă opțiunea devine disponibilă) — noul rând
   trebuie să se blocheze corect, fără îngheț.
6. Deschide DevTools → Console în timp ce pagina se încarcă — NU trebuie să vezi apeluri
   repetate/infinite către funcțiile de lock (poți adăuga temporar un `console.count()` în
   `lockIntocmitRowIdentity` DOAR pentru testare locală, apoi elimină-l înainte de commit).

`npm test verde, fără regresii` (sanity check — bug-ul e de runtime DOM, nu prins de suita
curentă de teste backend). `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -vE "semdoc-initiator/main\.js|semdoc-initiator\.html|public/sw\.js|package\.json" && echo "⛔ STOP" || echo "✅ scope curat"
```

# Cache busting + versiune
- bump `package.json` 3.9.613 → 3.9.614;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.614` pe `semdoc-initiator/main.js` în `public/semdoc-initiator.html`.

# La final
```bash
git add public/js/semdoc-initiator/main.js public/semdoc-initiator.html public/sw.js package.json
git commit -m "fix(crit): gardă idempotență lock ÎNTOCMIT — elimină buclă infinită MutationObserver, Page Unresponsive pe Inițiere flux (v3.9.614)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Garda adăugată exact la începutul `lockIntocmitRowIdentity`, restul funcției neschimbat.
2. Verificare manuală: pagina „Inițiere flux" se încarcă și rămâne responsivă (fără hang),
   ÎNTOCMIT tot blocat corect pe userul logat.
3. Status CI (`npm test` + `npm run check`); versiune 3.9.614.
4. **Confirmare directă de la tine**: după acest fix, verifică din nou pagina care dădea
   „Page Unresponsive" — ar trebui să se rezolve COMPLET, independent de orice altă discuție
   despre Railway/Postgres (erau două probleme diferite, suprapuse).
