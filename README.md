# DocFlowAI v3.3.6 — Enterprise

**Platformă de circulație și semnare electronică calificată pentru administrația publică.**

---

## Changelog v3.3.0 (08.03.2026)

### ✨ Funcționalități noi
- **`POST /flows/:flowId/cancel`** — Anulare flux de către inițiator sau admin. Setează `data.status = 'cancelled'`, înregistrează `cancelledAt / cancelledBy / cancelReason`, șterge notificările `YOUR_TURN/REMINDER`, notifică inițiatorul dacă adminul a anulat.
- **`notifiedAt`** pe semnatar — timestamp setat la trimiterea email-ului `YOUR_TURN`.
- **`downloadedAt`** pe semnatar — timestamp setat în `register-download` la descărcarea PDF-ului.
- **Template email complet** — Emailuri `YOUR_TURN` cu branding DocFlowAI, buton direct „Semnează documentul", card document cu instituție/compartiment/ID flux, salut personalizat cu inițiator și funcție.
- **Badge `🚫 Anulat`** în `semdoc-initiator.html`, `flow.html`, `admin.html` cu filtru dedicat în admin.
- **Buton `🚫 Anulează`** pentru inițiator pe fluxuri active.
- **Export CSV/PDF utilizatori** respectă filtrul activ din tabel, cu notă „filtrat: X din Y" în PDF.

### 🔴 Bug fixes
- **`NOTIFY_FAILED`** fals în jurnal — `sendSignerEmail()` returnează acum `{ ok: true, id }` la succes.
- **Badge `🚨 Prioritate`** → corectat `🚨 URGENT`.
- **Email `✅ ✅ Document semnat complet`** — emoji duplicat eliminat.
- **Export utilizatori ignora filtrul activ** — `window._filteredUsers` nu era setat (variabila locală ≠ `window.*`). Rezolvat în `renderUsers()`.

### 🟡 Îmbunătățiri audit PDF
- **Secțiunea SEMNATARI** — timestamps în ordine cronologică: `Notificat → Descarcat → Incarcat → Semnat / Refuzat / Delegat`.
- **`Incarcat`** determinat din `signedPdfVersions[signerIndex]` per semnatar.
- **ISTORICUL RUNDELOR** — același format extins per semnatar per rundă.
- **Header audit** — afișează `cancelledAt`, `cancelledBy`, `cancelReason` pentru fluxuri anulate.

---

## Changelog v3.2.0 — Patch Enterprise (07.03.2026)

### 🔴 Security fixes
- **Eliminat `plain_password`** — parola nu se mai stochează niciodată în clar în DB. La creare/reset, parola este returnată **o singură dată** în `_generatedPassword`.
- **`GET /users`** — filtrează strict pe `org_id`. Previne scurgerea de date între organizații.
- **`GET /flows/:flowId` și `GET /my-flows`** — folosesc `getUserMapForOrg(orgId)`.
- **`GET /my-flows`** — filtrul `org_id` fără fallback la `OR $2 = 0`.

### 🟠 Bug fixes
- **`export default router`** mutat la sfârșitul fișierelor `flows.mjs` și `admin.mjs`.
- **`PUT /flows/:flowId`** — validare câmpuri obligatorii; câmpuri imutabile protejate.
- **`stampFooterOnPdf`** — lățime text calculată cu `font.widthOfTextAtSize()`.
- **`upload-signed-pdf`** — limita 30 MB verificată pe bytes reali.
- **`reinitiate`** — footer-ul PDF re-aplicat cu noul `flowId`.
- **`notify`** — `notif_email` și `notif_inapp` evaluate independent.

### 🟡 Improvements
- Rate limiting configurabil via ENV.
- Cache `_defaultOrgIdCache` cu TTL 5 minute.
- Cleanup automat notificări la 6 ore (max 500/user).
- Pool DB `max: 10` conexiuni. Helmet security headers.
- `SIGNER_TOKEN_EXPIRY_DAYS` configurabil via ENV (default 90).

---

## Arhitectură

```
Railway (Node.js)
├── server/
│   ├── index.mjs           — Express orchestrator, WebSocket, notify, stampFooter
│   ├── mailer.mjs          — Email via Resend API (template HTML branded)
│   ├── whatsapp.mjs        — WhatsApp via Meta Graph API
│   ├── drive.mjs           — Arhivare Google Drive via Service Account
│   ├── push.mjs            — Web Push (VAPID)
│   ├── db/index.mjs        — Pool PG, migrări, saveFlow, getUserMapForOrg
│   ├── middleware/auth.mjs  — JWT, hashPassword, requireAuth/Admin
│   └── routes/
│       ├── auth.mjs        — /auth/login, /auth/me, /auth/refresh
│       ├── flows.mjs       — CRUD fluxuri, sign, refuse, upload, delegate, cancel
│       ├── admin.mjs       — Users CRUD, arhivare, audit PDF/CSV/JSON, health
│       └── notifications.mjs
└── public/
    ├── login.html
    ├── semdoc-initiator.html  — Creare, monitorizare, anulare fluxuri
    ├── semdoc-signer.html     — Descărcare, upload, semnare
    ├── flow.html              — Detalii flux
    ├── admin.html             — Panou admin (users, fluxuri, audit, statistici)
    ├── notifications.html
    ├── templates.html
    └── notif-widget.js
```

---

## Variabile de mediu

### Obligatorii
```
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=min-32-chars-random
PUBLIC_BASE_URL=https://app.docflowai.ro
```

### Autentificare
```
JWT_EXPIRES=2h
JWT_REFRESH_GRACE_SEC=900
ADMIN_SECRET=your-admin-bypass-secret
ADMIN_INIT_PASSWORD=parola-initiala-admin
SIGNER_TOKEN_EXPIRY_DAYS=90
```

### Rate limiting (opționale)
```
LOGIN_MAX=10
LOGIN_WINDOW_SEC=900
LOGIN_BLOCK_SEC=900
```

### Email (Resend)
```
RESEND_API_KEY=re_xxxxxxxxxxxx
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>
```

### WhatsApp (opțional)
```
WA_PHONE_NUMBER_ID=...
WA_ACCESS_TOKEN=...
WA_TEMPLATE_SIGN=...
WA_TEMPLATE_COMPLETE=...
WA_TEMPLATE_REFUSED=...
WA_TEMPLATE_LANG=ro
```

### Google Drive (opțional)
```
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_SERVICE_ACCOUNT_JSON={...}
```

### Web Push / VAPID (opțional)
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@docflowai.ro
```

---

## Endpoints API

### Autentificare
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/auth/login` | Login → JWT |
| GET | `/auth/me` | Profil utilizator curent |
| POST | `/auth/refresh` | Reînnoire token (grace 15 min) |

### Fluxuri
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/flows` | Creare flux |
| GET | `/flows/:flowId` | Date flux |
| PUT | `/flows/:flowId` | Editare completă (admin only) |
| DELETE | `/flows/:flowId` | Ștergere (inițiator/admin) |
| GET | `/flows/:flowId/pdf` | PDF original + emite uploadToken |
| GET | `/flows/:flowId/signed-pdf` | PDF semnat final |
| POST | `/flows/:flowId/sign` | Marcare semnat |
| POST | `/flows/:flowId/refuse` | Refuz cu motiv |
| POST | `/flows/:flowId/upload-signed-pdf` | Upload PDF semnat (verificare hash) |
| POST | `/flows/:flowId/register-download` | Emitere uploadToken + setare `downloadedAt` |
| POST | `/flows/:flowId/resend` | Reminder semnatar curent |
| POST | `/flows/:flowId/regenerate-token` | Token nou pentru semnatar |
| POST | `/flows/:flowId/reinitiate` | Reinițiere după refuz |
| POST | `/flows/:flowId/reinitiate-review` | Reinițiere după revizuire |
| POST | `/flows/:flowId/request-review` | Cerere revizuire de la semnatar |
| POST | `/flows/:flowId/delegate` | Delegare semnătură |
| POST | `/flows/:flowId/cancel` | Anulare flux (inițiator/admin) |

### Fluxuri utilizator
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/my-flows` | Fluxuri proprii |
| GET | `/my-flows/:flowId/download` | Descărcare PDF semnat |
| GET | `/api/my-signer-token/:flowId` | Token semnare propriu |

### Admin — Utilizatori
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/users` | Lista utilizatori |
| POST | `/admin/users` | Creare user → `_generatedPassword` one-time |
| PUT | `/admin/users/:id` | Editare user |
| DELETE | `/admin/users/:id` | Ștergere user |
| POST | `/admin/users/:id/reset-password` | Reset parolă one-time |
| POST | `/admin/users/:id/send-credentials` | Reset + email credențiale |

### Admin — Fluxuri & Arhivare
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/flows/list` | Lista fluxuri (paginată, cu `cancelled`) |
| POST | `/admin/flows/clean` | Ștergere fluxuri vechi |
| GET | `/admin/flows/archive-preview` | Preview arhivare Drive |
| POST | `/admin/flows/archive` | Arhivare batch în Drive |
| GET | `/admin/flows/:flowId/audit` | Export audit (json/csv/txt/pdf) |
| GET | `/admin/flows/audit-export` | Export bulk CSV |
| POST | `/admin/db/vacuum` | VACUUM ANALYZE |

### Notificări
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/api/notifications` | Lista notificări |
| GET | `/api/notifications/with-status` | Cu status semnatar |
| GET | `/api/notifications/unread-count` | Număr necitite |
| POST | `/api/notifications/:id/read` | Marchează citit |
| POST | `/api/notifications/read-all` | Marchează toate citite |
| DELETE | `/api/notifications/:id` | Șterge notificare |

### WebSocket
```
ws://app/ws  →  auth { type: 'auth', token: '...' }
             ←  events: auth_ok, new_notification, unread_count, pong
```

---

## Note de securitate

### Parole
1. Admin creează user → server returnează `_generatedPassword` **o singură dată**
2. Admin trimite credențialele via `/admin/users/:id/send-credentials`
3. Parola nu mai poate fi recuperată din DB

### Multi-tenant
Toate query-urile filtrează pe `org_id` din JWT. Izolare completă între organizații.

### Upload verificare integritate
`uploadToken` JWT cu `preHash` (sha256 PDF livrat) expiră în 4h. La upload, serverul verifică că PDF-ul primit ≠ PDF-ul original.

### Token semnatar
Linkurile de semnare expiră după `SIGNER_TOKEN_EXPIRY_DAYS` (default 90 zile). Regenerabil de admin via `/flows/:flowId/regenerate-token`.
