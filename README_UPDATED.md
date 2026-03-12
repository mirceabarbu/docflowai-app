# DocFlowAI

Platformă web pentru circulația documentelor și semnare electronică calificată, construită pentru fluxuri administrative și organizaționale cu trasabilitate, audit și notificări multi-canal.

## Ce face aplicația
DocFlowAI gestionează end-to-end un flux de semnare:
- inițiere document,
- definire semnatari și ordine,
- notificare semnatar curent,
- descărcare document,
- încărcare PDF semnat,
- validare, delegare, refuz, cerere de revizuire,
- finalizare și arhivare.

Aplicația include și funcții administrative:
- administrare utilizatori,
- configurare notificări,
- audit/export,
- arhivare în Google Drive,
- verificări de sănătate și metrics.

## Stack tehnic
### Backend
- Node.js
- Express
- PostgreSQL
- WebSocket
- pdf-lib
- Google APIs
- web-push

### Frontend
- HTML/CSS/JS vanilla
- PWA basics (service worker + offline page)

### Integrări
- Resend pentru email
- Meta WhatsApp Business API
- Google Drive
- Google Workspace provisioning

## Structura proiectului
```text
server/
  index.mjs
  db/index.mjs
  routes/
    auth.mjs
    flows.mjs
    admin.mjs
    notifications.mjs
  middleware/
    auth.mjs
    logger.mjs
    metrics.mjs
    rateLimiter.mjs
  drive.mjs
  mailer.mjs
  whatsapp.mjs
  push.mjs
  gws.mjs

public/
  login.html
  semdoc-initiator.html
  semdoc-signer.html
  flow.html
  admin.html
  notifications.html
  templates.html
  notif-widget.js
  sw.js
  offline.html
  mobile.css
```

## Funcționalități principale

### Utilizator / inițiator
- autentificare și schimbare parolă
- creare flux
- alegere tip flux
- adăugare semnatari în ordine
- urmărire stare flux
- reamintire către semnatar
- reinițiere după refuz / revizuire
- anulare flux
- descărcare document final

### Semnatar
- acces prin token dedicat
- descărcare PDF
- încărcare PDF semnat
- semnare / refuz / delegare
- cerere de revizuire

### Administrator
- CRUD utilizatori
- resetare parolă
- trimitere credențiale
- vizualizare fluxuri
- curățare și arhivare
- export audit CSV / JSON / TXT / PDF
- verificare email / WhatsApp / Drive / Workspace
- vacuum DB

## Variabile de mediu

### Obligatorii
```env
PUBLIC_BASE_URL=https://app.docflowai.ro
PORT=3000
DATABASE_URL=postgresql://user:pass@host/dbname
JWT_SECRET=schimba-cu-un-secret-lung
```

### Autentificare
```env
JWT_EXPIRES=2h
JWT_REFRESH_GRACE_SEC=900
ADMIN_SECRET=secret-admin
ADMIN_INIT_PASSWORD=parola-initiala-admin
SIGNER_TOKEN_EXPIRY_DAYS=90
```

### CORS
```env
CORS_ORIGIN=https://app.docflowai.ro
```

### Rate limiting
```env
LOGIN_MAX=10
LOGIN_WINDOW_SEC=900
LOGIN_BLOCK_SEC=900
```

### Email
```env
RESEND_API_KEY=re_xxxxxxxxxxxx
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>
```

### WhatsApp
```env
WA_PHONE_NUMBER_ID=
WA_ACCESS_TOKEN=
WA_TEMPLATE_SIGN=
WA_TEMPLATE_COMPLETE=
WA_TEMPLATE_REFUSED=
WA_TEMPLATE_LANG=ro
WA_DEFAULT_COUNTRY_PREFIX=40
```

### Google Drive
```env
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account", ...}
```

### Google Workspace
```env
GWS_DOMAIN=docflowai.ro
GWS_ADMIN_EMAIL=
GWS_SERVICE_ACCOUNT_JSON={"type":"service_account", ...}
```

### Web Push
```env
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@docflowai.ro
```

## Scripturi
```bash
npm start
npm test
npm run test:watch
npm run test:coverage
```

## Instalare locală
```bash
npm install
cp env.example .env
npm start
```

Aplicația pornește pe portul definit în `PORT`.

## Endpoint-uri principale

### Auth
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/refresh`
- `POST /auth/change-password`

### Fluxuri
- `POST /flows`
- `GET /flows/:flowId`
- `PUT /flows/:flowId`
- `DELETE /flows/:flowId`
- `GET /flows/:flowId/pdf`
- `GET /flows/:flowId/signed-pdf`
- `POST /flows/:flowId/sign`
- `POST /flows/:flowId/refuse`
- `POST /flows/:flowId/upload-signed-pdf`
- `POST /flows/:flowId/register-download`
- `POST /flows/:flowId/resend`
- `POST /flows/:flowId/regenerate-token`
- `POST /flows/:flowId/reinitiate`
- `POST /flows/:flowId/reinitiate-review`
- `POST /flows/:flowId/request-review`
- `POST /flows/:flowId/delegate`
- `POST /flows/:flowId/cancel`

### Utilizator curent
- `GET /my-flows`
- `GET /my-flows/:flowId/download`
- `GET /api/my-signer-token/:flowId`

### Admin
- `GET /admin/users`
- `POST /admin/users`
- `PUT /admin/users/:id`
- `DELETE /admin/users/:id`
- `POST /admin/users/:id/reset-password`
- `POST /admin/users/:id/send-credentials`
- `GET /admin/flows/list`
- `GET /admin/flows/clean-preview`
- `POST /admin/flows/clean`
- `GET /admin/flows/archive-preview`
- `POST /admin/flows/archive`
- `GET /admin/flows/:flowId/audit`
- `GET /admin/flows/audit-export`
- `POST /admin/db/vacuum`

### Notificări
- `GET /api/notifications`
- `GET /api/notifications/with-status`
- `GET /api/notifications/unread-count`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`
- `DELETE /api/notifications/:id`

### Push
- `GET /api/push/vapid-public-key`
- `POST /api/push/subscribe`
- `DELETE /api/push/subscribe`

### Operațional
- `GET /health`
- `GET /admin/health`
- `GET /metrics`

## Observații de operare
- aplicația folosește PostgreSQL atât pentru date de business, cât și pentru notificări și config operațional;
- există suport pentru job-uri de arhivare;
- există WebSocket pentru notificări live;
- service worker-ul oferă bază pentru comportament PWA;
- fluxurile și auditul depind puternic de structura datelor JSONB din DB.

## Testare
În proiect există teste Vitest pentru:
- autentificare și crypto,
- login,
- metrics.

Pentru producție extinsă este recomandată completarea cu integration tests pentru întregul lifecycle de flux.

## Recomandări imediate
- blochează endpoint-urile de suport/debug în producție;
- separă JS-ul din paginile mari în module;
- extinde testarea pentru fluxuri, multi-tenant și arhivare;
- mută fișierele PDF operaționale într-un storage dedicat;
- păstrează README sincronizat cu migrațiile și codul curent.

## Licență / utilizare internă
Document intern de lucru pentru proiectul DocFlowAI.
