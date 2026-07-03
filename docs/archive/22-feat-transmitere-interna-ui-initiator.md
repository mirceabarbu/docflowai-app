---
feat: UI selector „Transmite automat la finalizare" (utilizator SAU compartiment) + rezoluție în semdoc-initiator — Etapa 2a/2 (FRONTEND)
target_branch: develop
model_suggested: Sonnet 4.6 (UI vanilla, fără logică financiară — dar atenție la monolitul semdoc-initiator)
risk: SCĂZUT (frontend aditiv; motorul backend acceptă deja câmpul din Etapa 1)
version: 3.9.601 → 3.9.602
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop
Motorul de transmitere internă e livrat (Etapa 1, v3.9.601): backend-ul acceptă deja `transmiteLaFinalizare` în body-ul de creare flux și auto-transmite la finalizare. Acum adăugăm **UI-ul** prin care inițiatorul alege, opțional, cui i se transmite automat documentul la finalizare: **un utilizator din organizație SAU un compartiment întreg**, cu o **rezoluție** opțională. Zero backend nou.

# 🚫 NO-TOUCH
Backend integral (motorul e gata — NU-l atinge). Semnare integral. Nu modifica `readSigners()`, `signerRowTemplate()`, logica de providers, draft/IndexedDB. Adaugi un bloc UI izolat + un citit în payload.

# Etapa 0 — caracterizare (OBLIGATORIU)
```bash
grep -n "window._dbUsers\|_apiFetch('/users')\|refreshAllDropdowns" public/js/semdoc-initiator/main.js | head
grep -n 'btnCreate").addEventListener\|const payload = {\|signers: readSigners()' public/js/semdoc-initiator/main.js
grep -n "semdoc-initiator/main.js?v=\|main.js?v=" public/semdoc-initiator.html
grep -n "CACHE_VERSION" public/sw.js
grep -n '"version"' package.json | head -1
```
Confirmă: forma unui element din `window._dbUsers` (are `email`, `nume`/`name`, `compartiment`?), linia exactă unde se construiește `payload` în handlerul `btnCreate`, și linia de cache-bust a lui `main.js`.

# Implementare

## 1. Marcaj HTML — un container gol pentru bloc (în `public/semdoc-initiator.html`)
Adaugă, în secțiunea formularului de creare flux (lângă blocul de atașamente / înainte de butonul „Pornește fluxul"), un container:
```html
<div id="transmiteBlock" class="df-card" style="margin-top:12px"></div>
```
Dacă structura paginii face mai natural să injectezi blocul din JS, poți crea containerul din JS — dar preferă marcajul static + populare din JS (CSP-safe, fără inline handlers).

## 2. `public/js/semdoc-initiator/main.js` — bloc „Transmite automat la finalizare (opțional)"
Adaugă o funcție `renderTransmiteBlock()` apelată DUPĂ ce `window._dbUsers` e încărcat (în `loadDbUsers()`, după `refreshAllDropdowns?.()`; și în `window._refreshDbUsers`). Blocul conține:

- Titlu discret: „📨 Transmite automat la finalizare (opțional)" + un rând explicativ mic: „La finalizarea fluxului, documentul semnat și atașamentele vor fi transmise prin aplicație persoanei/compartimentului ales — chiar dacă nu a fost semnatar."
- **Selector țintă** (`<select id="transmiteTip">`): opțiuni `— nu transmite —` (default, gol), `Utilizator`, `Compartiment`.
- **Select utilizator** (`<select id="transmiteUser">`, ascuns până se alege „Utilizator"): populat din `window._dbUsers`, fiecare `<option value="<userId>" data-email="<email>">Nume — email</option>`. Dacă elementele n-au `id` numeric, folosește câmpul de id disponibil (confirmat în Etapa 0); dacă lista are doar email, trimite `type:'user'` cu `value=<email>` — DAR verifică ce acceptă `normalizeRecipients` din Etapa 1 (user value trebuie să fie **userId numeric**). Dacă `_dbUsers` NU expune id numeric, folosește ținta pe **email** doar dacă motorul o acceptă; altfel semnalează în raport că lista de useri trebuie să expună `id` (mic ajustaj de endpoint, prompt separat) și implementează deocamdată DOAR ținta „Compartiment" + user prin id dacă există.
- **Select compartiment** (`<select id="transmiteComp">`, ascuns până se alege „Compartiment"): opțiuni = valorile **distincte, ne-goale** de `compartiment` din `window._dbUsers` (dedup, sortate). Include și compartimentul propriu al inițiatorului dacă există.
- **Rezoluție** (`<textarea id="transmiteRezolutie" maxlength="2000">`, opțional): placeholder „Rezoluție / notă (opțional) — ex. «Spre analiză și propuneri»".
- Comutarea `transmiteTip` arată/ascunde selectul relevant (user vs comp) și resetează celălalt. Fără inline `onchange` — atașează `addEventListener` (CSP-safe).

Stil: refolosește clasele existente (`df-card`, `df-action-btn` etc.). Fără CSS nou dacă se poate; dacă e nevoie, minimal, scoped.

## 3. Payload — injectează `transmiteLaFinalizare` în `btnCreate`
În handlerul `btnCreate`, unde se construiește `const payload = { ... }`, adaugă un câmp calculat printr-un helper `readTransmiteLaFinalizare()`:
```js
function readTransmiteLaFinalizare() {
  const tip = document.getElementById('transmiteTip')?.value || '';
  const rez = (document.getElementById('transmiteRezolutie')?.value || '').trim().slice(0, 2000);
  if (tip === 'Utilizator') {
    const sel = document.getElementById('transmiteUser');
    const opt = sel?.options[sel.selectedIndex];
    const val = sel?.value?.trim();
    if (!val) return undefined;
    // dacă motorul cere userId numeric → Number(val); dacă acceptă email → opt?.dataset?.email
    return [{ type: 'user', value: /^\d+$/.test(val) ? Number(val) : (opt?.dataset?.email || val), rezolutie: rez || undefined }];
  }
  if (tip === 'Compartiment') {
    const val = document.getElementById('transmiteComp')?.value?.trim();
    if (!val) return undefined;
    return [{ type: 'comp', value: val, rezolutie: rez || undefined }];
  }
  return undefined;
}
```
Și în `payload`:
```js
transmiteLaFinalizare: readTransmiteLaFinalizare(),
```
`undefined` → câmpul nu se serializează (opt-in curat; back-compat cu fluxurile fără transmitere). Motorul din Etapa 1 validează/ignoră oricum prin `normalizeRecipients`, deci UI-ul e „best effort", backend-ul e garda.

## 4. (Opțional, dacă e trivial) persistă alegerea în draft
Dacă formularul salvează deja starea în `sessionStorage` (FORM_KEY), poți include cele 3 câmpuri; dacă adaugă complexitate, sari peste — nu e esențial pentru MVP.

# Verificare manuală (fără test automat — e UI)
- Cu „— nu transmite —": payload-ul NU conține `transmiteLaFinalizare` (verifică în Network → POST /flows). Fluxul se creează ca înainte.
- „Utilizator" + rezoluție: payload conține `[{type:'user', value:<id/email>, rezolutie:'...'}]`.
- „Compartiment": payload conține `[{type:'comp', value:'<compartiment>', ...}]`.
- Comutarea tipului ascunde/arată corect selectul potrivit; fără erori în consolă; CSP fără warning-uri (fără inline handlers).

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -vE "semdoc-initiator/main\.js|semdoc-initiator\.html|public/sw\.js|package\.json" && echo "⛔ STOP: fișier neașteptat!" || echo "✅ scope curat"
git diff public/js/semdoc-initiator/main.js | grep -n "readSigners\|signerRowTemplate\|preferredProvider" && echo "verifică: NU ai modificat logica de semnatari/providers"
```

# Cache busting + versiune
- bump `package.json`: `3.9.601` → `3.9.602`;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.602` pe `semdoc-initiator/main.js` în `public/semdoc-initiator.html`.

# La final
```bash
git add public/js/semdoc-initiator/main.js public/semdoc-initiator.html public/sw.js package.json
git commit -m "feat(flows): UI selector transmitere automată la finalizare (user/compartiment + rezoluție) în initiator (v3.9.602)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Dacă `window._dbUsers` expune `id` numeric (contează pentru ținta „Utilizator" — vezi §2): dacă NU, spune-o explicit ca să adăugăm `id` la `/users` într-un prompt mic.
2. Payload-ul conține/omite corect `transmiteLaFinalizare` în cele 3 scenarii.
3. Fără inline handlers noi (CSP-safe); guardrail scope curat.
4. Confirmare owner pe staging: creezi un flux cu „Compartiment" ales + rezoluție, îl finalizezi, și un user din acel compartiment (ne-semnatar) primește notificarea „📨 Document repartizat" și poate deschide documentul.

# Ce urmează (prompturi separate — NU acum)
- **Hardening securitate (recomandat imediat):** `GET /flows/:id/signed-pdf`, `/pdf`, `/attachments` (list+download) NU aplică `canActorReadFlow` azi (orice user autentificat descarcă după flowId — IDOR). Strânge-le la `canActorReadFlow ∪ isFlowRecipient` (închide IDOR-ul ȘI cimentează accesul destinatarului).
- **Etapa 2b:** rută manuală `POST /flows/:id/transmit` (repartizare ad-hoc pe fluxuri finalizate) + buton „📨 Transmite în aplicație" în `flow.js` + tab „Primite / Repartizate mie" + buton „Confirm luare la cunoștință" (`acknowledged_at`).
