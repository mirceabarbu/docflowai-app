# DocFlowAI v3.3.7 — Changelog (b73)

## Modificări față de b72

### 🔴 Fix swagger /api-docs.json 404
### 🟢 Teste flows — 79/79 passed (47 teste noi)

#### b73 — 15.03.2026

**`server/index.mjs`**
- `/api-docs` folosea URL absolut (`publicBaseUrl(req)/api-docs.json`) → URL relativ `/api-docs.json`
  Fix: browser fetch-uiește direct de pe același origin, fără dependență de PUBLIC_BASE_URL

**`server/tests/integration/flows.test.mjs`** *(fișier nou)*
- 47 teste noi: POST /flows, GET /flows/:id, sign, refuse, delegate, cancel
- Acoperire: validare input, auth, token semnatar, flux anulat, token expirat, happy path

**`package.json`** — version bump `3.3.32` → `3.3.33`

### Teste: 79/79 (față de 32/32 în b72)
