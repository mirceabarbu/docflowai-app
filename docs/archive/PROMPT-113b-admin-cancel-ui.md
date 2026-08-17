---
task: "#113b — UI pentru admin-cancel (buton pe pagina fluxului + mesaje de eroare umane)"
branch: develop
model_suggested: Sonnet 4.6   # UI pe tipar existent; ruta și gărzile există deja din #113a
target_version: v3.9.742
migrations: none
cache_version_bump: NO   # flow.js NU e în PRECACHE; /flow.html e, dar e servit network-first ⇒ ?v= țintit ajunge (precedent v3.9.710)
---

# ⚠️ BRANCH: develop

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE
```
git branch --show-current      # Așteptat: develop
git fetch origin && git status
```
(A cincea oară când sesiunea pornește pe `main`. Verifică, nu presupune.)

===============================================================================
## CONTEXT
===============================================================================

#113a (v3.9.741) a livrat ruta `POST /flows/:flowId/admin-cancel` — anulare
administrativă a unui flux **FINALIZAT**, cu gărzi complete pe server. Ruta nu are
încă niciun punct de intrare în UI, deci operația se face tot manual.

#113b adaugă butonul pe pagina fluxului. ⛔ ZERO schimbări de backend.

**Contractul rutei (din #113a — verifică-l în cod înainte de a scrie UI-ul):**
- succes → `{ ok: true, ... }`
- `403 forbidden` — nu ești admin/org_admin sau ești din altă org
- `400 reason_required` — motiv lipsă sau sub 10 caractere
- `409 not_completed` — fluxul nu e finalizat (pentru el există „Anulează" normal)
- `409 already_cancelled`
- `409 payment_confirmed` — ALOP-ul are plată confirmată sau sume > 0
- `409 has_archived_cycles` — ALOP-ul are cicluri arhivate

===============================================================================
## PASUL 1 — Butonul în `public/flow.html`
===============================================================================

Lângă `#btnCancelFlow` (linia ~201). Același tipar (`df-action-btn`, `display:none`,
SVG inline), dar variantă **danger** și text distinct, ca să nu se confunde cu anularea
obișnuită:

- `id="btnAdminCancelFlow"`
- `class="df-action-btn danger"`
- `style="display:none;"`
- `title="Anulare administrativă (flux finalizat)"`
- text: **„Anulare administrativă"**
- icon: refolosește un `<use href="/icons.svg?v=…#ico-…"/>` existent (⛔ nu inventa un id
  de icon — `grep` în `public/icons.svg` și alege unul prezent, ex. un shield/alert)

⛔ NU modifica `#btnCancelFlow`.

===============================================================================
## PASUL 2 — Logica în `public/js/flow/flow.js`
===============================================================================

Imediat DUPĂ blocul `btnCancelFlow` (~liniile 701-722), care e modelul de urmat.

### 2a. Poarta de vizibilitate
`isAdmin` există deja la linia ~692 (`role === 'admin' || role === 'org_admin'`).
```js
const canAdminCancel = !!data.completed
  && computedStatus !== 'cancelled'
  && isAdmin;
```
⛔ Deliberat FĂRĂ `isInitiator` — e o operație administrativă, nu una a inițiatorului.
⛔ Nu atinge `canCancel`; cele două sunt mutual exclusive prin `data.completed`.

### 2b. Handlerul
Pași, în ordine:

1. **Motiv obligatoriu.** `prompt('Motiv anulare administrativă (minim 10 caractere):')`.
   - `null` (Cancel) → abandonează tăcut.
   - sub 10 caractere după `trim()` → `setMsg('error', …)` cu explicație și
     **abandonează** (nu trimite request). Serverul validează oricum; asta e doar ca
     adminul să nu piardă un tur.
2. **Confirmare explicită**, care numește documentul și consecința:
   `confirm('Fluxul „<docName>" este FINALIZAT și conține un document semnat digital.\n\nAnularea administrativă îl deconectează de la ALOP/DF/ORD și permite relansarea semnării. Documentul semnat NU se șterge, dar fluxul devine inactiv.\n\nContinui?')`
3. Dezactivează butonul + text `⏳ Se anulează...` (ca la `btnCancelFlow`).
4. `_apiFetch('/flows/<id>/admin-cancel', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ reason }) })`
5. La succes: `setMsg('ok', '✅ Flux anulat administrativ. Documentul poate fi relansat.')`
   apoi `setTimeout(() => loadFlow(), 800)` (tiparul existent).
6. `finally` — restaurează starea butonului.

### 2c. Mesaje de eroare UMANE (partea cea mai importantă)
⛔ Nu afișa codul brut. Mapează explicit:

| cod | mesaj RO |
|---|---|
| `payment_confirmed` | „Nu se poate anula: ALOP-ul are deja o plată confirmată. Pentru corecție folosește o nouă lichidare (ciclu nou), nu anularea." |
| `has_archived_cycles` | „Nu se poate anula: ALOP-ul are cicluri arhivate. Anularea ar rescrie istoricul." |
| `not_completed` | „Fluxul nu este finalizat — folosește butonul «Anulează»." |
| `already_cancelled` | „Fluxul este deja anulat." |
| `reason_required` | „Motivul este obligatoriu (minim 10 caractere)." |
| `forbidden` | „Nu ai drepturi de administrare pe acest flux." |
| altceva | `j.message || j.error` |

Motivul e cel din bug-ul de acum două zile: un 403 afișat ca „nu e disponibil încă" a
costat o oră de diagnostic. Un cod brut într-un `setMsg` e aceeași greșeală.

===============================================================================
## PASUL 3 — Cache-bust + versiune
===============================================================================
```
grep -n "flow/flow.js?v=" public/flow.html      # citește valoarea curentă
sed -i -E "s#(flow/flow\.js\?v=)[0-9.]+#\13.9.742#g" public/flow.html
grep -n "flow/flow.js?v=" public/flow.html      # Așteptat: ?v=3.9.742
```
Bump `package.json` → `3.9.742`.
⛔ NU bumpа `CACHE_VERSION` — `flow.js` nu e în `PRECACHE_ASSETS`, iar `/flow.html` e
servit network-first (precedentul v3.9.710). Confirmă tu însuți cu
`grep -n "flow" public/sw.js` înainte să accepți asta.
⛔ Fără bulk-sed pe alte `?v=`.

===============================================================================
## PASUL 4 — Test
===============================================================================

`server/tests/unit/admin-cancel-ui.test.mjs` — **analiză statică** pe sursă
(`readFileSync` + regex), tiparul din `pagin-wiring.test.mjs`.

Motivul alegerii, explicit: `flow.js` e un script clasic mare, cu multe dependențe de
DOM și de starea paginii; încărcarea lui în happy-dom ar cere un schelet artificial care
ar testa schelet, nu comportament. Comportamentul real e acoperit de cele 9 cazuri DB
din #113a. ⛔ Nu forța un test happy-dom aici.

Cazuri:
1. `flow.html` conține `id="btnAdminCancelFlow"` exact o dată, cu clasa `danger`.
2. `flow.js` conține `canAdminCancel` și include `data.completed` în condiție.
3. Poarta NU conține `isInitiator` (asertează absența pe linia/blocul respectiv).
4. Endpoint-ul `/admin-cancel` apare exact o dată.
5. Toate cele 6 coduri de eroare din tabel apar în sursă.
6. `#btnCancelFlow` și `canCancel` rămân neschimbate (asertează prezența lor).

===============================================================================
## PASUL 5 — Porți
===============================================================================
```
npm test        # baseline la intrare: 108 fișiere / 1398 teste
```
`test:db` nu e necesar (zero backend). Dacă totuși îl rulezi, baseline 77/515.

===============================================================================
## PASUL 6 — Commit + PUSH
===============================================================================
```
git status                     # verifică lista
git add public/flow.html public/js/flow/flow.js package.json server/tests/unit/admin-cancel-ui.test.mjs
git commit -m "feat(flows): buton de anulare administrativă pe pagina fluxului + mesaje de eroare explicite — v3.9.742"
git push origin develop
```
⛔ NU `git add -A` — repo-ul are clutter netrackuit preexistent (prompturi, PDF-uri,
`tools/repair-ord-*.mjs`) care NU face parte din acest task.

===============================================================================
## RAPORT FINAL
===============================================================================
- Commit + versiune; `npm test` (fișiere/teste, PASS/FAIL).
- Ieșirea reală a grep-urilor din Pasul 3, plus ce ai găsit în `sw.js` despre `flow.js`.
- Ce id de icon ai folosit și dovada că există în `public/icons.svg`.
- Confirmă: `#btnCancelFlow` și `canCancel` NEATINSE; zero schimbări de backend.
- Orice abatere + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI
===============================================================================
- ⛔ BRANCH develop; PASUL 0 obligatoriu.
- ⛔ ZERO backend — ruta există din #113a.
- ⛔ NU atinge `#btnCancelFlow` / `canCancel`.
- ⛔ Poarta admin-cancel NU include inițiatorul.
- ⛔ Motivul e obligatoriu în UI, nu doar pe server.
- ⛔ Niciun cod de eroare brut afișat utilizatorului.
- ⛔ NU bumpа CACHE_VERSION; `?v=` doar pe flow.js.
- ⛔ `git push origin develop`. Pe `main` niciodată.
