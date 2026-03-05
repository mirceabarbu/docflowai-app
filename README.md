# DocFlowAI v3.2.0 — Enterprise

**Platformă de circulație și semnare electronică calificată pentru administrația publică.**

---

## Changelog v3.2.0 — Patch Enterprise

### 🔴 Security fixes
- **Eliminat `plain_password`** — parola nu se mai stochează niciodată în clar în DB (migration `010_drop_plain_password`). La creare/reset, parola este generată, returnată **o singură dată** în răspunsul API (`_generatedPassword`) și trimisă pe email, după care nu mai este recuperabilă din sistem.
- **`GET /users`** — acum filtrează strict pe `org_id` al actorului autentificat. Previne scurgerea de email-uri și date personale între organizații în context multi-tenant.
- **`GET /flows/:flowId` și `GET /my-flows`** — folosesc `getUserMapForOrg(orgId)` (funcție nouă în `db/index.mjs`) care filtrează userii pe organizație. Elimină leak-ul inter-tenant la îmbogățirea semnatarilor.
- **`GET /my-flows`** — filtrul `org_id` nu mai are fallback la `OR $2 = 0`. Un user fără `orgId` vede **exclusiv** fluxurile proprii, nu toate fluxurile din DB.

### 🟠 Bug fixes
- **`export default router`** — mutat la **sfârșitul** fișierelor `flows.mjs` și `admin.mjs`. Rutele `/delegate` și `/admin/flows/:flowId/audit` care erau definite după `export default` sunt acum corect poziționate.
- **`PUT /flows/:flowId`** — adăugată validare: `signers` (array nevid), `docName` și `initEmail` sunt obligatorii. Câmpurile imutabile `flowId`, `orgId` și `createdAt` sunt protejate de suprascrierea body-ului.
- **`stampFooterOnPdf`** — lățimea textului din dreapta calculată cu `fontR.widthOfTextAtSize(footerRight, FONT_SIZE)` (font metric real) în loc de `length * 4.5` (estimare incorectă pentru majuscule și caractere late).
- **`upload-signed-pdf`** — limita de 30 MB verificată pe bytes PDF reali (`estimatedBytes = base64.length * 0.75`) în loc de pe lungimea string-ului base64.
- **`reinitiate`** — footer-ul PDF este re-aplicat cu noul `flowId`. Anterior, noul flux moștenea footer-ul cu `flowId`-ul vechi.
- **`notify`** — `notif_email` și `notif_inapp` sunt evaluate **independent**. Un user poate primi email chiar dacă dezactivează notificările in-app.

### 🟡 Improvements
- **`_defaultOrgIdCache`** — cache cu TTL de 5 minute (în loc de infinit). Funcție nouă `invalidateDefaultOrgCache()` pentru invalidare manuală.
- **Rate limiting configurabil** via `LOGIN_MAX`, `LOGIN_WINDOW_SEC`, `LOGIN_BLOCK_SEC` în variabilele de mediu.
- **`JWT_REFRESH_GRACE_SEC`** — grace period la refresh token acum configurabil via ENV (default 900 sec).
- **Cleanup automat notificări** — job la 6 ore păstrează maxim 500 notificări per user (migration `012_notifications_cleanup_index`).
- **Pool DB** — `max: 10` conexiuni (era 5).
- **`nodemailer`** eliminat din `package.json` (nu era folosit — aplicația folosea Resend direct via `fetch`).
- **Versiune** afișată ca `3.2.0` în `/health` și `/admin/health`.

---

## Arhitectură

```
Railway (Node.js)
├── server/
│   ├── index.mjs           — Express orchestrator, WebSocket, notify
│   ├── mailer.mjs          — Email via Resend API
│   ├── whatsapp.mjs        — WhatsApp via Meta Graph API
│   ├── drive.mjs           — Arhivare Google Drive via Service Account
│   ├── push.mjs            — Web Push (VAPID)
│   ├── db/
│   │   └── index.mjs       — Pool PG, migrări, saveFlow, getUserMapForOrg
│   ├── middleware/
│   │   └── auth.mjs        — JWT, hashPassword, requireAuth/Admin
│   └── routes/
│       ├── auth.mjs        — /auth/login, /auth/me, /auth/refresh
│       ├── flows.mjs       — CRUD fluxuri, sign, refuse, upload, delegate
│       ├── admin.mjs       — Users CRUD, arhivare, audit, health
│       └── notifications.mjs — Notificări, push subscriptions
└── public/
    ├── login.html
    ├── semdoc-initiator.html
    ├── semdoc-signer.html
    ├── admin.html
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
```

### Rate limiting (opționale, valori default)
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
| GET | `/flows/:flowId` | Date flux (semnatari îmbogățiți) |
| PUT | `/flows/:flowId` | Editare completă (admin only, validat) |
| DELETE | `/flows/:flowId` | Ștergere (inițiator/admin) |
| GET | `/flows/:flowId/pdf` | PDF original + emite uploadToken |
| GET | `/flows/:flowId/signed-pdf` | PDF semnat final |
| POST | `/flows/:flowId/sign` | Marcare semnat |
| POST | `/flows/:flowId/refuse` | Refuz cu motiv |
| POST | `/flows/:flowId/upload-signed-pdf` | Upload PDF semnat (verificare hash) |
| POST | `/flows/:flowId/register-download` | Emitere uploadToken |
| POST | `/flows/:flowId/resend` | Reminder semnatar curent (admin) |
| POST | `/flows/:flowId/regenerate-token` | Token nou pentru semnatar (admin) |
| POST | `/flows/:flowId/reinitiate` | Reinițiere după refuz (cu footer nou) |
| POST | `/flows/:flowId/delegate` | Delegare semnătură |

### Fluxuri utilizator
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/my-flows` | Fluxuri proprii (filtrat strict pe org) |
| GET | `/my-flows/:flowId/download` | Descărcare PDF semnat |
| GET | `/api/my-signer-token/:flowId` | Token semnare propriu |

### Admin — Utilizatori
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/users` | Lista utilizatori (fără parole) |
| POST | `/admin/users` | Creare user → `_generatedPassword` one-time |
| PUT | `/admin/users/:id` | Editare user |
| DELETE | `/admin/users/:id` | Ștergere user |
| POST | `/admin/users/:id/reset-password` | Reset parolă → `_generatedPassword` one-time |
| POST | `/admin/users/:id/send-credentials` | Reset + email credențiale |

### Admin — Fluxuri & Arhivare
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/flows/list` | Lista fluxuri (paginată, filtrate) |
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
Parolele nu sunt stocate în clar. Fluxul corect:
1. Admin creează user → server returnează `_generatedPassword` **o singură dată**
2. Admin trimite credențialele via `/admin/users/:id/send-credentials` (resetează parola și trimite email)
3. Parola nu mai poate fi recuperată din DB după aceea

### Multi-tenant
Toate query-urile pe `users`, `flows`, `templates` filtrează pe `org_id` din JWT. Un user dintr-o organizație nu poate vedea datele altei organizații.

### Upload verificare integritate
`uploadToken` JWT cu `preHash` (sha256 PDF livrat) expiră în 4h. La upload, serverul verifică că PDF-ul primit ≠ PDF-ul original (documentul a fost semnat efectiv).
