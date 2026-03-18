# DocFlowAI v3.3.7 — Changelog (b80)

## Modificări față de b79

### 🔴 BUG-N01 — Recovery archive_jobs blocate după Railway restart

**Fișier:** `server/index.mjs`

**Problema:** `_runArchiveJobProcessor()` setează `status='processing'` la preluarea unui job, dar nu resetează niciodată job-urile rămase în `processing` după un restart Railway. La repornire, funcția selectează doar `status='pending'` — job-urile blocate nu sunt niciodată reluate, cauzând pierdere silențioasă de date.

**Fix:** La startup, după ce `initDbWithRetry()` finalizează cu succes, se execută un query de recovery:

```sql
UPDATE archive_jobs
SET status = 'pending', started_at = NULL
WHERE status = 'processing'
  AND started_at < NOW() - INTERVAL '30 minutes'
```

Logat cu `logger.warn` dacă există job-uri resetate, silențios dacă nu.

---

### 🟠 BUG-N02 — org_admin limitat la propria instituție în flows.mjs

**Fișier:** `server/routes/flows.mjs`

**Problema:** Rolul `org_admin` era fie complet ignorat (5 endpoint-uri cu `=== 'admin'` strict), fie acceptat fără verificare de tenant (2 endpoint-uri cu `|| actor.role === 'org_admin'` neprotejat).

**Fix:** Toate cele **8 instanțe** `isAdmin` din flows.mjs folosesc acum condiția:

```js
const isAdmin = actor.role === 'admin' ||
  (actor.role === 'org_admin' && Number(data.orgId) === Number(actor.orgId));
```

- `admin` global → acces la orice flux ✅
- `org_admin` → acces **doar** la fluxurile din propria instituție (`data.orgId === actor.orgId`) ✅
- `org_admin` cross-tenant → `403 forbidden` ✅

**Endpoint-uri afectate (linii):**
| Linia | Handler |
|-------|---------|
| 331 | `DELETE /flows/:flowId` |
| 721 | `POST /flows/:flowId/reinitiate` |
| 817 | `POST /flows/:flowId/request-review` |
| 882 | `POST /flows/:flowId/reinitiate-review` |
| 998 | `POST /flows/:flowId/delegate` |
| 1106 | `POST /flows/:flowId/cancel` |
| 1159 | `POST /flows/:flowId/attachments` |
| 1245 | `DELETE /flows/:flowId/attachments/:attId` |

---

### 🟠 BUG-N03 — Swagger /api-docs protejat cu autentificare

**Fișier:** `server/index.mjs`

**Problema:** `/api-docs` și `/api-docs.json` erau accesibile oricui fără autentificare, expunând structura completă a API-ului intern.

**Fix:**
- `GET /api-docs.json` — returnează `401` dacă cookie-ul `auth_token` lipsește
- `GET /api-docs` — redirect la `/login.html?redirect=/api-docs` dacă nu e autentificat

---

### 🟡 PERF-04 — Pool DB max: 10 → 20

**Fișier:** `server/db/index.mjs`

```js
// ÎNAINTE:
max: 10
// DUPĂ:
max: 20, idleTimeoutMillis: 30000
```

Previne bottleneck-ul la peak load (arhivare batch + reminder jobs + request-uri normale concurente).

---

### 🟡 CODE-N02 — APP_VERSION din package.json (single source of truth)

**Fișier:** `server/index.mjs`

Versiunea hardcodată `'3.3.7'` din endpoint-urile `/health` și `/admin/health` înlocuită cu `APP_VERSION` citit dinamic din `package.json`:

```js
const _pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const APP_VERSION = _pkg.version; // '3.3.40'
```

Log-ul de startup afișează acum versiunea corectă automat la fiecare bump.

---

**`package.json`** — version bump `3.3.39` → `3.3.40`

---

### 🟠 BUG-UI01 — org_admin fără instituție vedea ⚠ Administrare fluxuri și 🧹 VACUUM

**Fișier:** `public/admin.html`

**Problema:** `lockOrgAdminFilters(institutie)` începea cu `if (!institutie) return` —
dacă un `org_admin` nu avea câmpul `institutie` populat în profil, funcția ieșea imediat
fără să ascundă `adminFluxSection`. Aceasta conține: ⚠ Ștergere fluxuri vechi, 💣 Ștergere TOATE și 🧹 VACUUM ANALYZE — operații rezervate exclusiv super-adminului.

**Fix:** Ascunderea `adminFluxSection` mutată **înaintea** guard-ului `if (!institutie) return`,
astfel încât să se execute întotdeauna pentru `org_admin`, indiferent de profilul utilizatorului.
Linia duplicată de ascundere de la finalul funcției eliminată.

---

### 🔴 BUG-SIGNER01 — Buton upload blocat la reinițiere flux (signedPdfFile rămânea disabled)

**Fișier:** `public/semdoc-signer.html`

**Problema:** La reinițierea unui flux după refuz, semnatarul curent (primul semnatar) vedea pagina
de semnare dar butonul **📂 Încarcă fișier PDF semnat calificat** rămânea `disabled` permanent,
indiferent dacă descărcarea PDF-ului reușea sau nu.

**Cauza:** `btnChooseSignedPdf.disabled = false` era plasat la finalul blocului `try` din
`downloadPdfForSigning()`, după `buildCartusBlob()`. Dacă `buildCartusBlob()` arunca
excepție (ex: timeout 10s așteptând `pdf-lib` de pe CDN), execuția sări în `catch` fără
să activeze niciodată butonul.

**Fix A — activare imediată:** `btnChooseSignedPdf.disabled = false` mutat imediat după
`a.click()` (descărcarea reușită), **înainte** de operații care pot eșua (`register-download`,
`setTimeout`).

**Fix B — fallback pdf-lib:** `buildCartusBlob()` nu mai aruncă excepție când `pdf-lib`
nu se încarcă în 10 secunde (CDN lent/blocat). În loc, descarcă PDF-ul simplu de la
`/flows/:flowId/pdf` fără cartuș vizual și returnează blob-ul — semnatarul poate semna
documentul și îl poate încărca înapoi normal.

---

### 🟡 PERF-03 — express.json limit global 50MB → 1MB

**Fișiere:** `server/index.mjs`, `server/routes/flows.mjs`

Limita globală redusă la 1MB — previne body flood pe endpoint-urile care acceptă
JSON mic (auth, notifications, sign, refuse, cancel, delegate etc.).

Override 50MB aplicat explicit pe cele 6 rute din `flows.mjs` care primesc `pdfB64` /
`signedPdfB64` / `dataB64`:
- `POST /flows` + `POST /api/flows`
- `PUT /flows/:flowId`
- `POST /flows/:flowId/upload-signed-pdf`
- `POST /flows/:flowId/reinitiate-review`
- `POST /flows/:flowId/attachments`

---

### 🟠 SEC-N01 — Outreach: link dezabonare GDPR (Legea 506/2004 / GDPR Art.21)

**Fișiere:** `server/db/index.mjs`, `server/routes/admin/outreach.mjs`, `public/admin.html`

Emailurile comerciale trimise primăriilor nu aveau link de dezabonare — risc GDPR
și risc de ban pe Resend.

**Migrare 030** (`030_outreach_unsubscribe`): două coloane noi în `outreach_primarii`:
- `unsubscribed BOOLEAN NOT NULL DEFAULT FALSE`
- `unsubscribe_token TEXT UNIQUE` (UUID generat la seed/import)

**`outreach.mjs`** — 5 modificări:
1. **Seed**: generare `unsubscribe_token = randomUUID()` la inserarea inițială din JSON
2. **`buildHtml()`**: parametru nou `unsubscribeUrl` → footer HTML cu link dezabonare
3. **`/send`**: JOIN cu `outreach_primarii` pentru a exclude `unsubscribed = TRUE` din batch
4. **`/send`**: generare `unsubUrl` per destinatar, injectat în email via `buildHtml()`
5. **Endpoint nou `GET /admin/outreach/unsubscribe/:token`** — public (fără auth),
   setează `unsubscribed = TRUE`, returnează pagină HTML de confirmare în română

**Endpoint nou `POST /admin/outreach/primarii/ensure-tokens`** — admin only,
generează `unsubscribe_token` pentru rândurile existente fără token (upgrade graceful).

**`admin.html`**: badge `🚫 dezabonat` vizibil în tabelul instituțiilor outreach.

---

### 🟠 BUG-N04 — org_admin primea forbidden la Retrimite notificare și Regenerare token

**Fișier:** `server/routes/flows.mjs`

**Problema:** `POST /flows/:flowId/resend` și `POST /flows/:flowId/regenerate-token`
foloseau `requireAdmin` strict (`role === admin`) — blocând complet `org_admin`.

**Fix:**
- `/resend` — înlocuit cu `requireAuth` + verificare tenant:
  admin global / org_admin pe propria instituție / inițiatorul fluxului pot retrimite
- `/regenerate-token` — înlocuit cu `requireAuth` + verificare tenant:
  admin global / org_admin pe propria instituție pot regenera tokenul

`PUT /flows/:flowId` (editare completă câmpuri sensibile) rămâne `requireAdmin` strict.

---

### 🔴 BUG-N05 — Crash la GET /admin/stats pentru org_admin (column n.user_id does not exist)

**Fișier:** `server/routes/admin.mjs`, linia 937

**Eroarea:** `ERROR: column n.user_id does not exist`

Tabelul `notifications` stochează utilizatorul prin `user_email TEXT`, nu prin `user_id INTEGER`.
Query-ul pentru org_admin folosea `JOIN users u ON u.id=n.user_id` — coloana nu există,
cauzând crash la fiecare încărcare a paginii de admin.

**Fix:** JOIN corectat la `lower(u.email) = lower(n.user_email)`.

---

### FIX-8 · Graceful shutdown — închidere pool DB la SIGTERM

**Fișier:** `server/index.mjs`

`httpServer.close()` callback devine async și apelează `pool.end()` înainte de
`process.exit(0)`. Elimină log-ul `Connection reset by peer` din Postgres la fiecare
deploy Railway.

---

### SEC-04 · JWT revocation la reset parolă (token_version)

**Fișiere:** `server/db/index.mjs`, `server/middleware/auth.mjs`,
`server/routes/auth.mjs`, `server/routes/admin.mjs`, `server/index.mjs`

**Migrare 031** — coloana `token_version INTEGER DEFAULT 1` în `users`.

**Flux:**
1. La login: `tv = user.token_version` inclus în payload JWT
2. La refresh: `tv` propagat în noul token
3. La `reset-password` și `send-credentials`: `token_version = token_version + 1`
4. `checkTokenVersionValid(actor, res)` compară `actor.tv` (din JWT) cu DB —
   dacă diferit → 401 `token_revoked` → utilizatorul este forțat la re-login

**Caracteristici:**
- Zero overhead pentru request-uri normale (verificarea nu e apelată pe toate rutele)
- Fail-open la erori DB tranzitorii — nu blochează utilizatori legitimi
- Backward compat cu JWT-uri vechi (fără `tv`) — tratate ca `tv=1`
- `injectTokenVersionChecker` injectat din `index.mjs` — evită dependency cycle

---

### 🔴 BUG-CARTUS01 — Tabelul de semnături se suprapune peste conținutul documentului

**Fișier:** `public/semdoc-signer.html`

**Problema:** Logica de detectare a spațiului liber via PDF.js calcula corect
`lowestContentY`, dar **decizia de a adăuga pagină nouă lipsea complet** — codul
sări direct la `drawPage.drawRectangle` fără să compare cu spațiul necesar.
Cartușul era întotdeauna plasat pe pagina curentă, indiferent de conținut.

**Fix:** Adăugare logică de decizie explicită:
- `spatiuNecesar = cartusH + cartusBottom + 20pt` (margine siguranță)
- Dacă `lowestContentY < spatiuNecesar` → `pdfDoc.addPage()` → cartuș jos pe pagina nouă
- Dacă `lowestContentY === 0` (PDF.js indisponibil) → pagină nouă conservator
- Dacă spațiu suficient → cartuș pe pagina curentă (comportament așteptat)

---

### SEC-04 complet — verificare token_version activă în /auth/me și /auth/refresh

**Fișier:** `server/routes/auth.mjs`

Token_version era incrementat la reset-password dar niciodată verificat.

**Acum:** ambele endpoint-uri de sesiune verifică `tv` din JWT vs `token_version` din DB:

- `GET /auth/me` — SELECT include `token_version`; dacă `jwtTv !== dbTv` → cookie șters + `401 token_revoked`
- `POST /auth/refresh` — idem; utilizatorul e forțat la re-login

**Fluxul complet:**
1. Admin resetează parola → `token_version = token_version + 1` în DB
2. Utilizatorul face orice request → `/auth/me` sau `/auth/refresh` detectează discrepanța
3. Cookie șters → redirect la login → utilizatorul se autentifică cu parola nouă
4. JWT nou include `tv` corect → acces normal

Zero overhead pe request-urile normale — verificarea e în query-urile DB deja existente.

---

### ARCH-03 — getFlowData: 2 query-uri → 1 LEFT JOIN

**Fișier:** `server/db/index.mjs`

`getFlowData()` e apelată de 27 de ori în server. Fiecare apel făcea:
- `SELECT data FROM flows WHERE id=$1`
- `SELECT key, data FROM flows_pdfs WHERE flow_id=$1`

Înlocuit cu un singur LEFT JOIN pe cele 3 chei PDF.
Reduce latența DB la jumătate pentru fiecare acces la date flux.

---

### 🟠 BUG-ADMIN01 — Dropdown instituții gol în Administrare Fluxuri (super-admin)

**Fișiere:** `server/routes/admin.mjs`, `public/admin.html`

**Bug 1 — Dropdown gol:** `populateFlowInstDropdown(flows)` construia lista de instituții
din fluxurile paginii curente (max 10). Un super-admin cu sute de fluxuri vedea dropdown
aproape gol sau cu doar câteva instituții.

**Bug 2 — Filtrare parțială:** Consecința directă — filtrul de instituție funcționa corect
la nivel server (parametru trimis ok), dar nu puteai selecta instituția din dropdown.

**Fix:**
- Endpoint nou `GET /admin/flows/institutions` — returnează lista distinctă de instituții
  din toate fluxurile via JOIN DISTINCT (org-filtered pentru org_admin)
- `loadFlowInstitutions()` — funcție async care apelează endpoint-ul și populează dropdown-ul
- Apelat la inițializarea tab-ului Fluxuri (o singură dată)
- `populateFlowInstDropdown(flows)` devine no-op (backward compat)
