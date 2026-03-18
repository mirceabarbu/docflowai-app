# DocFlowAI v3.3.7 — Changelog (b97)

## Modificări față de b96

### Securitate & Stabilitate (Q-01 → Q-05)

| ID | Fișier | Modificare |
|----|--------|-----------|
| Q-01 | `server/index.mjs` | CORS fallback `true → false` — blochează origini necunoscute dacă lipsesc env vars; `logger.warn` la startup |
| Q-02 | `server/index.mjs` | `/api-docs` și `/api-docs.json` — verificare JWT completă (`jwt.verify`) în loc de existența superficială a cookie-ului |
| Q-04 | `server/index.mjs` | Reminder job: `inactiveSince` fallback la `data.createdAt` — previne reminder trimis imediat pe fluxuri fără `notifiedAt` |
| Q-05 | `server/routes/flows.mjs` | `_readRateLimit` (60 req/min/IP) adăugat pe `GET /flows/:flowId`, `/pdf`, `/signed-pdf`, `/api/flows/:flowId` |

### Arhitectură (Q-06, A, B)

| ID | Fișier | Modificare |
|----|--------|-----------|
| Q-06 | `server/routes/templates.mjs` *(nou)* | Template CRUD extras din `index.mjs` → fișier dedicat; `index.mjs` −65 LOC |
| A   | `server/emailTemplates.mjs` | Template HTML `send-email` extras din `flows.mjs` în `emailSendExtern()`; `flows.mjs` −85 LOC |
| B   | `server/routes/admin/outreach.mjs` | `APP_URL` → `PUBLIC_BASE_URL \|\| APP_URL` — aliniat cu restul aplicației |

### Funcționalități noi (E, F, G)

| ID | Fișier | Modificare |
|----|--------|-----------|
| P-05 | `public/flow.html` | **Timeline vizual** progres flux: jaloane `FLOW_CREATED → SIGNED × N → FLOW_COMPLETED` cu timestamps, actori, stări colorate și animație pulse pe semnatarul curent |
| E   | `public/semdoc-initiator.html` | **Timeline inline** la inițiator — progresul fluxului curent vizibil direct în pagina principală |
| F   | `public/admin.html` | **Badge live** număr fluxuri active în header admin |
| G   | `public/admin.html` + `server/routes/admin.mjs` | **Export CSV** fluxuri — buton în tab Fluxuri, endpoint `GET /admin/flows/export-csv` |

### Versiune
`package.json`: `3.3.60` (build b96/b97 aplicate în același release)

---

## Impact funcțional
**Zero** — toate modificările sunt adăugiri pure sau refactorizări fără schimbări de logică.
Rutele `/api/templates`, fluxurile de semnare, notificări, webhook și arhivare sunt nemodificate.
