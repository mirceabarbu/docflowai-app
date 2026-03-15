# DocFlowAI v3.3.7 — Enterprise

**Platformă de circulație și semnare electronică calificată pentru administrația publică din România.**

> Deploy: [Railway](https://railway.app) · DB: PostgreSQL · Backend: Node.js/Express (ESM) · Notificări: Resend (email) + Meta WhatsApp + WebPush + WebSocket

---

## Changelog v3.3.7 (14.03.2026)

### 🐛 Bug fixes
- **Admin PDF raport fluxuri**: eliminat `window.print()` automat — utilizatorul decide
- **Tabel ancore signer**: gap eliminat între header și casuțe, font header redus la `size: 7`
- **`reinitiate`**: atașamentele (documente suport) se copiază automat în noul flux
- **Finalizare flux**: eliminat `data.urgent = false` la completion — badge URGENT rămâne vizibil

### 🆕 Modul Outreach (b51)
- Email campaigns pentru instituții publice din România
- Import bulk CSV destinatari, tracking deschidere (pixel 1×1), retry erori
- CLI `tools/send-campaign.mjs` compatibil cron
- Tabet dedicat în `admin.html`

---

## Changelog v3.3.6 (13.03.2026)

### 🆕 Funcționalități noi
- **`POST /flows/:flowId/send-email`** — trimitere externă document semnat (PDF atașat, template branded, semnatari, corp personalizat)
- **Documente suport** (`flow_attachments`) — upload/download/ștergere PDF/ZIP/RAR per flux
- **`EMAIL_SENT`** event în audit PDF și inline în timeline flux

---

## Changelog v3.3.5 (11.03.2026)

### 🆕 Funcționalități noi
- **Prometheus `/metrics`** endpoint — zero dependențe, scrape Grafana/Uptimerobot
- **Test suite** — 30 teste vitest/supertest (`npm test`)
- **Reminder multi-nivel** — 24h / 48h / 72h escaladare cu notificare inițiator la nivel 3

### 🔴 Bug fixes
- `logger is not defined` crash în `mailer.mjs`
- `tempPassword` lipsă din răspunsul reset-parolă

---

## Changelog v3.3.3 (09.03.2026)

### 🔴 Security
- **JWT → HttpOnly cookie** (SEC-01), eliminare localStorage
- **`plain_password` eliminat** din răspunsuri API și exporturi
- **`org_id` null bypass** fix — filtru multi-tenant strict
- **`innerHTML` → `escH()`** — XSS prevention pe toate câmpurile user input
- **CSP activat** via helmet (v3.3.4)
- **Cross-tenant check** pe flows și users

---

## Arhitectură

```
Railway (Node.js ESM, single process)
├── server/
│   ├── index.mjs              — Express orchestrator, WebSocket, notify(), stampFooter, jobs
│   ├── mailer.mjs             — Email via Resend API
│   ├── whatsapp.mjs           — WhatsApp via Meta Graph API
│   ├── drive.mjs              — Arhivare Google Drive (Service Account)
│   ├── push.mjs               — Web Push (VAPID)
│   ├── db/
│   │   └── index.mjs          — Pool PG (max:10), 26 migrări, saveFlow, getFlowData
│   ├── middleware/
│   │   ├── auth.mjs           — JWT, PBKDF2-v2 (600k), requireAuth/Admin, escHtml
│   │   ├── logger.mjs         — Structured JSON logging (pino-like)
│   │   ├── metrics.mjs        — Prometheus counters/gauges (zero deps)
│   │   └── rateLimiter.mjs    — In-memory rate limiter configurable
│   └── routes/
│       ├── auth.mjs           — /auth/login, /auth/me, /auth/refresh, /auth/logout
│       ├── flows.mjs          — CRUD fluxuri, sign, refuse, upload, delegate, cancel, send-email
│       ├── admin.mjs          — Users CRUD, fluxuri admin, arhivare, audit export, statistici
│       ├── notifications.mjs  — In-app notifications CRUD
│       └── admin/
│           └── outreach.mjs   — Email campaigns (outreach instituții)
└── public/
    ├── login.html
    ├── semdoc-initiator.html  — Creare, monitorizare, anulare, outreach
    ├── semdoc-signer.html     — Descărcare, upload, semnare, tabel ancore
    ├── flow.html              — Detalii flux, timeline, send-email
    ├── admin.html             — Panou admin (users, fluxuri, audit, statistici, outreach)
    ├── notifications.html
    ├── templates.html
    └── notif-widget.js        — Widget notificări (injectat în toate paginile)
```

### Schema DB (26 migrări)

| Tabel | Descriere |
|---|---|
| `flows` | Fluxuri de semnare (JSONB) |
| `flows_pdfs` | PDF-uri separate (pdfB64, signedPdfB64, originalPdfB64) |
| `flow_attachments` | Documente suport per flux |
| `users` | Utilizatori cu roluri și preferințe notificări |
| `organizations` | Multi-tenant (org_id pe toate tabelele) |
| `templates` | Șabloane semnatari (shared per instituție) |
| `notifications` | Notificări in-app (max 500/user) |
| `push_subscriptions` | VAPID endpoints WebPush |
| `delegations` | Delegări active (valid_from / valid_until) |
| `login_blocks` | Rate limiting autentificare (DB-backed) |
| `audit_log` | Audit append-only (toate evenimentele critice) |
| `archive_jobs` | Job queue arhivare Google Drive (async) |
| `outreach_campaigns` | Campanii email outreach |
| `outreach_recipients` | Destinatari campanii cu tracking |

---

## Variabile de mediu

### Obligatorii
```env
PORT=3000
DATABASE_URL=postgresql://user:pass@host:5432/db
JWT_SECRET=min-32-chars-random-string
PUBLIC_BASE_URL=https://app.docflowai.ro
```

### Autentificare & Securitate
```env
JWT_EXPIRES=2h
JWT_REFRESH_GRACE_SEC=900
ADMIN_SECRET=your-strong-admin-bypass-secret
ADMIN_INIT_PASSWORD=parola-initiala-admin
SIGNER_TOKEN_EXPIRY_DAYS=90
```

### Rate limiting (opționale)
```env
LOGIN_MAX=10
LOGIN_WINDOW_SEC=900
LOGIN_BLOCK_SEC=900
```

### Email (Resend)
```env
RESEND_API_KEY=re_xxxxxxxxxxxx
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>
```

### WhatsApp (opțional)
```env
WA_PHONE_NUMBER_ID=...
WA_ACCESS_TOKEN=...
WA_TEMPLATE_SIGN=semnare_document
WA_TEMPLATE_COMPLETE=document_finalizat
WA_TEMPLATE_REFUSED=document_refuzat
WA_TEMPLATE_LANG=ro
```

### Google Drive (opțional)
```env
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_SERVICE_ACCOUNT_JSON={...escaped JSON...}
```

### Web Push / VAPID (opțional)
```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@docflowai.ro
```

### Reminder automat (opționale)
```env
REMINDER_INTERVAL_HOURS=6
REMINDER_1_HOURS=24
REMINDER_2_HOURS=48
REMINDER_3_HOURS=72
```

### Outreach (opționale)
```env
OUTREACH_DAILY_LIMIT=100
OUTREACH_FROM=DocFlowAI <contact@docflowai.ro>
OUTREACH_PDF_PATH=/app/tools/DocFlowAI_Prezentare.pdf
```

### Metrics (opțional)
```env
METRICS_PUBLIC=0    # 1 = endpoint /metrics public (pentru Grafana/Prometheus extern)
```

### CORS (opțional)
```env
CORS_ORIGIN=https://app.docflowai.ro,https://staging.docflowai.ro
```

---

## Endpoints API

### Autentificare
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| POST | `/auth/login` | — | Login → JWT HttpOnly cookie |
| GET | `/auth/me` | ✅ | Profil utilizator curent |
| POST | `/auth/refresh` | ✅ | Reînnoire token (grace 15 min) |
| POST | `/auth/logout` | ✅ | Ștergere cookie |
| POST | `/auth/change-password` | ✅ | Schimbare parolă (force_password_change) |

### Fluxuri
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| POST | `/flows` | ✅ | Creare flux |
| GET | `/flows/:flowId` | ✅/token | Date flux (fără PDF) |
| PUT | `/flows/:flowId` | 🔐 Admin | Editare completă |
| DELETE | `/flows/:flowId` | ✅ Init/Admin | Ștergere permanentă |
| GET | `/flows/:flowId/pdf` | ✅/token | PDF original + emite uploadToken |
| GET | `/flows/:flowId/signed-pdf` | ✅/token | PDF semnat final |
| POST | `/flows/:flowId/sign` | token | Marcare semnat (fără upload) |
| POST | `/flows/:flowId/refuse` | token | Refuz cu motiv |
| POST | `/flows/:flowId/upload-signed-pdf` | token | Upload PDF semnat (verificare hash) |
| POST | `/flows/:flowId/register-download` | token | Înregistrare descărcare + emitere uploadToken |
| POST | `/flows/:flowId/resend` | ✅ | Re-trimitere notificare semnatar curent |
| POST | `/flows/:flowId/regenerate-token` | ✅ Admin | Token nou pentru semnatar |
| POST | `/flows/:flowId/reinitiate` | ✅ Init/Admin | Reinițiere după refuz (flux nou) |
| POST | `/flows/:flowId/reinitiate-review` | ✅ Init/Admin | Reinițiere după revizuire (același ID) |
| POST | `/flows/:flowId/request-review` | token | Cerere revizuire de la semnatar |
| POST | `/flows/:flowId/delegate` | token | Delegare semnătură |
| POST | `/flows/:flowId/cancel` | ✅ Init/Admin | Anulare flux |
| POST | `/flows/:flowId/send-email` | ✅ | Trimitere externă document semnat |

### Documente suport (attachments)
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| POST | `/flows/:flowId/attachments` | ✅ Init/Admin | Upload document suport (PDF/ZIP/RAR, max 10MB) |
| GET | `/flows/:flowId/attachments` | ✅/token | Lista documente suport |
| GET | `/flows/:flowId/attachments/:id` | ✅/token | Descărcare document suport |
| DELETE | `/flows/:flowId/attachments/:id` | ✅ Init/Admin | Ștergere document suport |

### Fluxuri utilizator
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/my-flows` | ✅ | Fluxuri proprii (inițiate + de semnat) |
| GET | `/my-flows/:flowId/download` | ✅ | Descărcare PDF semnat propriu |
| GET | `/api/my-signer-token/:flowId` | ✅ | Token semnare propriu |

### Template-uri
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/api/templates` | ✅ | Lista șabloane (proprii + shared instituție) |
| POST | `/api/templates` | ✅ | Creare șablon |
| PUT | `/api/templates/:id` | ✅ | Editare șablon (owner only) |
| DELETE | `/api/templates/:id` | ✅ | Ștergere șablon (owner only) |

### Admin — Utilizatori
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/admin/users` | 🔐 | Lista utilizatori (org filtrat) |
| POST | `/admin/users` | 🔐 | Creare user → `_generatedPassword` one-time |
| PUT | `/admin/users/:id` | 🔐 | Editare user |
| DELETE | `/admin/users/:id` | 🔐 | Ștergere user |
| POST | `/admin/users/:id/reset-password` | 🔐 | Reset parolă one-time |
| POST | `/admin/users/:id/send-credentials` | 🔐 | Reset + email credențiale |

### Admin — Fluxuri & Arhivare
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/admin/flows/list` | 🔐 | Lista fluxuri paginată (include cancelled) |
| POST | `/admin/flows/clean` | 🔐 | Ștergere fluxuri vechi |
| GET | `/admin/flows/archive-preview` | 🔐 | Preview arhivare Drive |
| POST | `/admin/flows/archive` | 🔐 | Arhivare batch async în Drive |
| GET | `/admin/flows/:flowId/audit` | 🔐 | Export audit (json/csv/txt/pdf) |
| GET | `/admin/flows/audit-export` | 🔐 | Export bulk CSV |
| POST | `/admin/db/vacuum` | 🔐 | VACUUM ANALYZE |

### Admin — Outreach
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/admin/outreach/stats` | 🔐 | Statistici globale campanii |
| GET | `/admin/outreach/campaigns` | 🔐 | Lista campanii |
| POST | `/admin/outreach/campaigns` | 🔐 | Creare campanie |
| GET | `/admin/outreach/campaigns/:id` | 🔐 | Detalii campanie + destinatari |
| DELETE | `/admin/outreach/campaigns/:id` | 🔐 | Ștergere campanie |
| POST | `/admin/outreach/campaigns/:id/recipients` | 🔐 | Adăugare destinatari (JSON/CSV) |
| DELETE | `/admin/outreach/campaigns/:id/recipients/:rid` | 🔐 | Ștergere destinatar |
| POST | `/admin/outreach/campaigns/:id/send` | 🔐 | Trimitere batch (max 100) |
| POST | `/admin/outreach/campaigns/:id/reset-errors` | 🔐 | Retry destinatari cu eroare |
| GET | `/admin/outreach/track/:trackingId` | — | Pixel tracking deschidere (public) |

### Notificări
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/api/notifications` | ✅ | Lista notificări |
| GET | `/api/notifications/with-status` | ✅ | Cu status semnatar |
| GET | `/api/notifications/unread-count` | ✅ | Număr necitite |
| POST | `/api/notifications/:id/read` | ✅ | Marchează citit |
| POST | `/api/notifications/read-all` | ✅ | Marchează toate citite |
| DELETE | `/api/notifications/:id` | ✅ | Șterge notificare |

### Sistem
| Metodă | Endpoint | Auth | Descriere |
|---|---|---|---|
| GET | `/health` | — | Status server + memorie (public) |
| GET | `/admin/health` | 🔐 | Status detaliat + DB latency + WS clients |
| GET | `/metrics` | 🔐/public | Prometheus format (METRICS_PUBLIC=1 pentru public) |

**Legendă:** ✅ = JWT cookie/Bearer · 🔐 = Admin only · token = signer token (public link) · — = public

### WebSocket
```
ws://app/ws  — auto-auth din cookie HttpOnly la upgrade
             ← events: auth_ok, new_notification, unread_count, pong, auth_timeout
             → messages: { type: 'auth', token } | { type: 'ping' }
```

---

## Tipuri de flux (`flowType`)

| Tip | Descriere | Footer stamp | AcroForm |
|---|---|---|---|
| `tabel` | DocFlowAI generează tabelul de semnături | ✅ Da | Nu |
| `ancore` | PDF pre-anchored (ex: Forexebug Formular 17) | ❌ Nu (ar invalida semnăturile) | ✅ Păstrat |

---

## Securitate

### Parole
1. Admin creează user → server returnează `_generatedPassword` **o singură dată**
2. Admin trimite credențialele via `/admin/users/:id/send-credentials`
3. Parola nu mai poate fi recuperată din DB (PBKDF2 v2, 600k iterații)
4. La primul login, utilizatorul este forțat să schimbe parola (`force_password_change`)

### Multi-tenant
Toate query-urile filtrează pe `org_id` din JWT. Izolare completă între organizații. `getUserMapForOrg(orgId)` previne leak-ul userilor între organizații la vizualizarea fluxurilor.

### Upload verificare integritate
`uploadToken` JWT cu `preHash` (sha256 hex al PDF-ului livrat la descărcare) — expiră în 4h. La upload, serverul verifică:
1. `uploadToken` valid și neexpirat
2. PDF primit != PDF original (nu se poate încărca același document înapoi)
3. Dimensiune max 30MB

### Token semnatar
Linkurile de semnare expiră după `SIGNER_TOKEN_EXPIRY_DAYS` (default 90 zile). Admin poate regenera token via `/flows/:flowId/regenerate-token`.

### Rate limiting
- **Login**: DB-backed (persistent), 10 încercări / 15 min / IP+email → blocare 15 min
- **ADMIN_SECRET**: in-memory, 5 req/min/IP → blocare 5 min
- **Sign/refuse/delegate**: 20 req/min/IP
- **Upload PDF**: 5 req/min/IP

### Headers securitate (Helmet + manual)
- `Content-Security-Policy` (unsafe-inline permis temporar pentru CDN-uri PDF.js/pdf-lib)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

## Notificări

Fiecare utilizator poate configura independent:
- **In-app** (default: activ) — notificări în `/notifications` + WebSocket real-time
- **Email** (default: inactiv) — via Resend API, template HTML branded
- **WhatsApp** (default: inactiv) — via Meta Graph API (necesită număr de telefon)
- **Web Push** (default: inactiv) — VAPID, funcționează offline (PWA)

### Tipuri de notificări
| Tip | Descriere |
|---|---|
| `YOUR_TURN` | Este rândul tău să semnezi |
| `COMPLETED` | Flux finalizat complet |
| `REFUSED` | Semnatar a refuzat |
| `DELEGATED` | Semnătură delegată |
| `REVIEW_REQUESTED` | Cerere revizuire de la semnatar |
| `REMINDER` | Reminder automat (nivel 1/2/3) |
| `CANCELLED` | Flux anulat |

### Reminder automat multi-nivel
- **Nivel 1** (24h inactivitate): notificare semnatar curent
- **Nivel 2** (48h): notificare escaladată semnatar
- **Nivel 3** (72h): notificare urgentă semnatar + notificare inițiator

---

## Modul Outreach

Campaniile de email marketing pentru promovarea DocFlowAI la primării și instituții publice.

```bash
# CLI — listare campanii
node tools/send-campaign.mjs --list

# Dry run
node tools/send-campaign.mjs --campaign 1 --batch 50 --dry-run

# Trimitere
node tools/send-campaign.mjs --campaign 1 --batch 50

# Cron zilnic
0 8 * * * cd /app && node tools/send-campaign.mjs --campaign 1 --batch 100 >> /var/log/outreach.log 2>&1
```

---

## Background jobs (în-process)

| Job | Interval | Descriere |
|---|---|---|
| Reminder multi-nivel | 6h (configurable) | Trimite remindere semnatarilor inactivi |
| Archive job processor | 30s | Procesează coada `archive_jobs` (Google Drive) |
| Cleanup notificări | 6h | Șterge notificările vechi (>500/user) |
| Cleanup login_blocks | 30 min | Șterge blocările expirate |

---

## PWA (Progressive Web App)

Aplicația este instalabilă ca PWA pe mobile/desktop via `manifest.json` + service worker (`sw.js`).

---

## Rulare locală

```bash
# 1. Clonare
git clone https://github.com/mirceabarbu/docflowai-app
cd docflowai-app

# 2. Dependențe
npm install

# 3. Configurare
cp env.example .env
# → editați .env cu DATABASE_URL, JWT_SECRET, RESEND_API_KEY etc.

# 4. Start
npm start
# sau cu auto-reload:
# npx nodemon server/index.mjs

# 5. Teste
npm test
```

---

## Deploy Railway

1. Fork repo → conectare Railway
2. Adăugare serviciu PostgreSQL în Railway project
3. Setare variabile de mediu (toate din secțiunea de mai sus)
4. Railway detectează automat `npm start` din package.json
5. DB se migrează automat la primul start

---

## Known issues (v3.3.7 b60)

> Urmărite pentru remediere în v3.3.8:

- **BUG-01** `ReferenceError: db is not defined` în `POST /flows/:id/reinitiate` — copierea atașamentelor va crasha (fix: `db.query` → `pool.query`)
- **BUG-02** `signersTable` construit dar neutilizat în HTML-ul `send-email` — tabelul cu semnatarii lipsește din email
- **BUG-03** Status mapping greșit în `send-email` (`s.signed` vs `s.status === 'signed'`) — toate statusurile apar ca "în așteptare"
- **BUG-04** Versioning inconsistent: `package.json` = 3.3.20, health = 3.3.5, README = 3.3.7
- **SEC-01** Coloana `plain_password` există în schema DB (migrare 001) — necesită DROP COLUMN

---

*DocFlowAI — Platformă de semnare electronică pentru administrația publică românească*
