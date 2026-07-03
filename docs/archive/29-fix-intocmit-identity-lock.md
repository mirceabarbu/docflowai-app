---
fix(sec+ux): identitatea ÎNTOCMIT blocată la actorul autentificat — server-side (închide gaură de impersonare) + UI (dropdown blocat, un singur punct de aplicare)
target_branch: develop
model_suggested: Opus 4.8 (fix de integritate pe identitate/authz + refactor UI centralizat într-un monolit de 2257 linii)
risk: MEDIU (backend: derivare identitate din actor, cascadă în lookup-uri existente; frontend: un singur choke point, dar monolit mare)
version: 3.9.608 → 3.9.609
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (descoperire în timpul analizei — mai serioasă decât cererea inițială)
Cererea: „utilizatorul nu poate schimba cine întocmește; cine creează fluxul nu poate face asta pentru altcineva."

Analiza a arătat că gaura NU e doar de UI. În `server/routes/flows/crud.mjs` (`createFlow`), `initName`/`initEmail` vin direct din `body`, iar `requireAuth` rulează, dar **rezultatul lui NU e comparat niciodată** cu `initEmail`/rândul ÎNTOCMIT din `signers[]`. Practic, orice apel direct la API (nu doar UI) poate crea azi un flux atribuit oricui, indiferent cine e autentificat.

# 🎯 Soluția — o regulă unică, aplicată în ambele straturi
**Identitatea ÎNTOCMIT (nume + email) se derivă ÎNTOTDEAUNA din actorul autentificat — niciodată din ce trimite clientul.** Aplicată universal (indiferent de origine: creare manuală, șablon propriu, șablon partajat pe instituție, prefill din ALOP/formulare, reinițiere), regula rezolvă simultan:
1. cererea explicită (utilizatorul nu poate alege pe altcineva la ÎNTOCMIT);
2. gaura de securitate (backend nu mai are cum să fie păcălit, apel direct sau nu);
3. cazul șablonului partajat (ÎNTOCMIT salvat în șablon e oricum suprascris cu identitatea celui care aplică șablonul — auto-swap, fără mesaj de eroare, fără cod separat pentru acest caz).

**Backend-ul e plasa de siguranță reală** (nu poate fi ocolit). **Frontend-ul e UX** (previne confuzia, arată clar că nu poți edita).

# 🚫 NO-TOUCH
Semnare integral. Financiar ALOP. `body.institutie` (override de instituție afișată pe document) — NU-l atinge, e o funcționalitate separată, nelegată de identitate. Restul rolurilor din tabelul de semnatari (VIZAT, APROBAT, etc.) — rămân complet editabile, ca azi.

# Etapa 0 — caracterizare (OBLIGATORIU)
```bash
# Backend — exact liniile de validare/auth/lookup din createFlow:
sed -n '55,75p' server/routes/flows/crud.mjs
sed -n '105,120p' server/routes/flows/crud.mjs
sed -n '238,250p' server/routes/flows/crud.mjs
grep -n "const normalizedSigners = signers.map" server/routes/flows/crud.mjs
sed -n '143,150p' server/routes/flows/crud.mjs
# JWT payload — confirmă câmpurile disponibile pe actor:
grep -n "const payload = {" -A5 server/routes/auth.mjs
# Frontend — funcția choke-point + toate apelurile ei (trebuie să acopere orice cale de creare rând):
grep -n "function updateIntocmitVisibility\|updateIntocmitVisibility()" public/js/semdoc-initiator/main.js
# Sursa identității actorului în UI (deja există, non-sensibil, cache local):
grep -n "docflow_user" public/js/semdoc-initiator/main.js | head -5
# Sync existent name-select → email/functie (de refolosit, NU de duplicat):
sed -n '720,735p' public/js/semdoc-initiator/main.js
```
Raportează: liniile exacte confirmate; dacă JWT payload are `nume` cache-uit (da, conform analizei — dar verifică din nou); toate locurile unde `updateIntocmitVisibility()` e apelată (trebuie să fie: rol-change handler, MutationObserver pe tbody, finalul `applyTemplate()` — dacă lipsește vreunul dintre acestea, raportează și NU continua fără să clarifici).

# Implementare — BACKEND (`server/routes/flows/crud.mjs`)

## 1. Derivarea autoritativă a identității (imediat DUPĂ `requireAuth`, ÎNAINTE de query-ul `orgId`)
Validarea de format pe `body.initName`/`body.initEmail` (liniile ~70-72, care rulează ÎNAINTE de auth — testele 6-7 depind de 400 acolo, NU le muta) **rămâne neschimbată**. Schimbă doar declararea lor din `const` în `let` (ca să poată fi reasignate). Imediat după `const actor = requireAuth(req, res); if (!actor) return;`, adaugă:
```js
// SEC v3.9.609: identitatea "Întocmit" NU poate fi impersonată — se derivă din actorul
// autentificat, nu din ce trimite clientul. Validarea de format de mai sus (400 pe body
// gol/invalid) rămâne neschimbată; de aici încolo, valorile REALE sunt cele ale actorului.
initEmail = String(actor.email || '').trim();
initName = String(actor.nume || '').trim() || initName; // fallback dacă JWT nu are nume cache-uit
```
Restul funcției (lookup `orgId`, lookup `initFunctie`/`initCompartiment`/`initInstitutie` la linia ~244, folosesc deja `initEmail` — devin automat autoritative, fără alte modificări). **Opțional, dacă simplu:** extinde SELECT-ul de la linia ~244 (`SELECT functie,compartiment,institutie FROM users WHERE email=$1`) să aducă și `nume`, și suprascrie `initName` cu valoarea din DB dacă există (mai proaspătă decât JWT-ul cache-uit la login). Dacă adaugă risc/complexitate, sari peste — fallback-ul pe `actor.nume` e suficient.

## 2. Forțarea identității pe rândul ÎNTOCMIT din `signers[]`
În construcția `normalizedSigners` (linia ~143, `signers.map((s, idx) => ({...}))`), pentru orice semnatar al cărui rol normalizat e ÎNTOCMIT, suprascrie `name`/`email` cu identitatea actorului — indiferent ce a trimis clientul:
```js
const isIntocmitRole = String(s.rol || s.atribut || '').trim().toUpperCase() === 'ÎNTOCMIT';
```
și în obiectul rezultat:
```js
name: isIntocmitRole ? initName : String(s.name || '').trim(),
email: isIntocmitRole ? initEmail.toLowerCase() : String(s.email || '').trim(),
```
(Adaptează exact la structura obiectului găsită în Etapa 0 — `isIntocmitRole` calculat per element în `.map`.) Dacă există accidental mai multe rânduri cu rol ÎNTOCMIT (nu ar trebui, frontend-ul previne, dar backend-ul nu se bazează pe asta), forțează-le pe TOATE la identitatea actorului — nu respinge, doar corectează (gracios, fără 400 nou).

# Teste — `server/tests/db/flow-intocmit-lock.test.mjs` (server/tests/db/**, auto-skip fără TEST_DATABASE_URL)
- `POST /flows` cu `body.initEmail`/`body.initName` = altă persoană decât actorul → flux creat, dar `data.initEmail === actor.email` și rândul cu `rol==='ÎNTOCMIT'` are `email === actor.email` (NU valoarea din body — miezul fix-ului).
- Body cu semnatar ÎNTOCMIT cu email diferit de actor → semnatarul salvat are email-ul actorului, nu cel trimis.
- Flux normal (fără încercare de spoofing, `initEmail` corect = actor) → comportament identic cu azi (non-regresie).
- Validarea 400 pe `initName`/`initEmail` lipsă/invalide în body rămâne (rulează înainte de auth) — test de non-regresie pe ordinea validărilor.

`npm test verde, fără regresii`. `npm run check` OK.

# Implementare — FRONTEND (`public/js/semdoc-initiator/main.js`)

## 3. Extinde `updateIntocmitVisibility()` — SINGURUL punct de aplicare
Funcția e deja apelată din toate căile de creare/modificare rânduri (confirmat în Etapa 0). Adaugă, în interiorul buclei existente, DUPĂ determinarea `isIntocmitRow`-ului curent (variabila care marchează rândul câștigător ÎNTOCMIT pentru acest pas), logica de blocare identitate:
```js
const nameSel = tr.querySelector(".name-select");
if (nameSel) {
  if (isIntocmitRow) {
    lockIntocmitRowIdentity(tr, nameSel);
  } else if (nameSel.dataset.intocmitLocked === "1") {
    unlockIntocmitRowIdentity(nameSel);
  }
}
```
(`isIntocmitRow` = exact variabila/condiția existentă din funcție care determină dacă acest rând e cel activ ÎNTOCMIT — NU introduce o a doua sursă de adevăr; refolosește ce găsești în Etapa 0.)

## 4. Helperi noi (lângă `updateIntocmitVisibility`, în același scope pentru acces la `window._dbUsers`)
```js
function lockIntocmitRowIdentity(tr, nameSel) {
  const u = JSON.parse(localStorage.getItem("docflow_user") || "{}");
  if (!u.email) return; // profil indisponibil — nu bloca UI-ul (edge case, backend rămâne plasa reală)
  const finish = () => {
    nameSel.disabled = true;
    nameSel.dataset.intocmitLocked = "1";
    nameSel.style.opacity = ".65";
    nameSel.style.cursor = "not-allowed";
    nameSel.title = "Nu poți schimba cine întocmește documentul — ești chiar tu.";
    nameSel.dispatchEvent(new Event("change", { bubbles: true })); // sincronizează email/funcție (handler existent)
  };
  if ([...nameSel.options].some(o => o.value === u.nume)) {
    nameSel.value = u.nume; finish();
  } else {
    // Așteaptă popularea dropdown-ului cu userii (pattern identic cu applyTemplate, max 3s)
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if ([...nameSel.options].some(o => o.value === u.nume)) {
        nameSel.value = u.nume; clearInterval(iv); finish();
      } else if (tries > 30) clearInterval(iv);
    }, 100);
  }
}
function unlockIntocmitRowIdentity(nameSel) {
  nameSel.disabled = false;
  delete nameSel.dataset.intocmitLocked;
  nameSel.style.opacity = "";
  nameSel.style.cursor = "";
  nameSel.title = "";
}
```
`nameSel.dispatchEvent(new Event("change"))` declanșează handler-ul existent de sincronizare email/funcție (confirmat în Etapa 0, ~linia 722) — NU duplica acea logică.

## 5. Verificare manuală (fără test automat — UI)
- La încărcarea paginii: rândul implicit ÎNTOCMIT apare cu numele userului logat, dropdown-ul e vizibil **disabled** (opacitate redusă, cursor `not-allowed`, tooltip la hover).
- Încerci să schimbi manual dropdown-ul ÎNTOCMIT → nu răspunde la click (disabled).
- Aplici un **șablon propriu** → ÎNTOCMIT rămâne userul logat (de obicei identic cu ce era în șablon oricum — fără schimbare vizibilă pentru cazul normal).
- Aplici un **șablon partajat pe instituție** (creat de altcineva) → ÎNTOCMIT se auto-schimbă la userul logat, NU la autorul șablonului — fără mesaj de eroare, silent-safe.
- Schimbi rolul altui rând LA „ÎNTOCMIT" (dacă opțiunea devine disponibilă) → acel rând se blochează la userul logat; rândul care a pierdut rolul ÎNTOCMIT se deblochează.
- Restul rolurilor (VIZAT, APROBAT etc.) rămân complet editabile — fără regresie.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/routes/flows/crud.mjs`, `public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`, `public/sw.js`, `server/tests/db/flow-intocmit-lock.test.mjs` (nou), `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs|flow-access\.mjs|flow-transmit\.mjs" && echo "⛔ STOP: zonă interzisă!" || echo "✅ NO-TOUCH ok"
git diff server/routes/flows/crud.mjs | grep -n "body.institutie" && echo "verifică: institutie override NEATINS" || true
```

# Cache busting + versiune
- bump `package.json` 3.9.608 → 3.9.609;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.609` pe `semdoc-initiator/main.js` în `public/semdoc-initiator.html`.

# La final
```bash
git add server/routes/flows/crud.mjs public/js/semdoc-initiator/main.js public/semdoc-initiator.html public/sw.js server/tests/db/flow-intocmit-lock.test.mjs package.json
git commit -m "fix(sec+ux): identitate ÎNTOCMIT blocată la actorul autentificat — server-side + UI (rezolvă și cazul șablon partajat) (v3.9.609)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Backend: `initEmail`/`initName` derivate din `actor` (nu din body) după auth; rândul ÎNTOCMIT din `signers[]` forțat la identitatea actorului, indiferent ce trimite clientul. Validarea 400 pre-auth neschimbată.
2. Frontend: `updateIntocmitVisibility()` extinsă, un singur punct de aplicare; dropdown ÎNTOCMIT disabled + tooltip; restul rolurilor neatinse.
3. Șablon partajat → auto-swap la userul logat, fără mesaj de eroare (confirmă comportamentul pe cazul de test manual).
4. `body.institutie` neatins.
5. Status CI (`npm test` + `npm run check`); versiune 3.9.609.
6. Verificare staging: user A creează șablon și-l partajează pe instituție; user B (diferit) aplică șablonul → ÎNTOCMIT arată B, nu A; user B nu poate edita manual rândul.
