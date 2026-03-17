# DocFlowAI v3.3.7 — Changelog (b82)

## Modificări față de b81

### CODE-N01 — Template-uri email extrase în server/emailTemplates.mjs

**Fișier nou:** `server/emailTemplates.mjs`
**Fișiere modificate:** `server/index.mjs`, `server/routes/flows.mjs`, `server/routes/admin.mjs`

Toate template-urile HTML inline extrase în funcții exportate:

| Funcție | Utilizare |
|---------|-----------|
| `emailYourTurn()` | Invitație semnare (YOUR_TURN) |
| `emailGeneric()` | COMPLETED, REFUSED, REVIEW_REQUESTED, DELEGATED |
| `emailDelegare()` | Email pentru noul semnatar delegat |
| `emailResetPassword()` | Parolă resetată de admin |
| `emailCredentials()` | Credențiale cont nou / retrimise |
| `emailVerifyGws()` | Verificare email Google Workspace |

Avantaje: template-uri editabile fără a atinge logica de business, testabile
independent, fără risc de a strica fluxul de notificări.

---

### BUG-FIX: isAdmin org_admin cu orgId null

**Fișier:** `server/routes/flows.mjs`

Condiția `Number(null) === Number(null)` returnează `true` (0===0),
permițând unui org_admin fără org_id să acționeze pe fluxuri fără org_id.

Fix aplicat pe toate cele 8 instanțe:
```js
// ÎNAINTE (fals pozitiv cu null):
actor.role === 'org_admin' && Number(data.orgId) === Number(actor.orgId)

// DUPĂ (protejat):
actor.role === 'org_admin' && data.orgId != null && actor.orgId != null
  && Number(data.orgId) === Number(actor.orgId)
```

---

### CODE-03 — Teste noi (+20 teste, total 98)

**Fișier:** `server/tests/integration/flows.test.mjs`

Suite-uri noi adăugate:

- **POST /flows/:flowId/reinitiate** (4 teste)
  - 404 flux inexistent
  - 403 user care nu e inițiator/admin
  - 409 niciun semnatar refuzat
  - 200 reinițiere reușită (semnatar refuzat eliminat)
  - 200 admin global poate reinițializa indiferent de inițiator

- **POST /flows/:flowId/upload-signed-pdf** (5 teste)
  - 400 token lipsă
  - 400 signedPdfB64 lipsă
  - 413 PDF > 30MB
  - 404 flux inexistent
  - 409 flux anulat

- **GET /my-flows — multi-tenant isolation** (2 teste)
  - Verificare că query conține org_id în params (filtrare tenant)
  - User fără orgId → query fără filtru org

- **POST /flows/:flowId/resend — org_admin tenant check** (3 teste)
  - 403 org_admin din altă organizație
  - 200 org_admin din aceeași organizație
  - 200 inițiatorul poate retrimite indiferent de rol

- **POST /flows/:flowId/cancel — org_admin tenant check** (3 teste)
  - 403 org_admin din altă organizație
  - 200 org_admin din aceeași organizație
  - 409 org_admin nu poate anula flux finalizat

**package.json** — version bump `3.3.50` → `3.3.51`
