# DocFlowAI

**Platformă de circulație și semnare electronică calificată a documentelor pentru administrația publică.**

Suportă fluxuri multi-semnatar secvențiale cu notificări în timp real, arhivare în Google Drive și securitate la upload prin token verificat.

---

## Cuprins
- [Arhitectură](#arhitectură)
- [Variabile de mediu](#variabile-de-mediu)
- [Fișiere principale](#fișiere-principale)
- [Endpoints API](#endpoints-api)
- [Funcționalități](#funcționalități)
- [Note tehnice](#note-tehnice)

---

## Arhitectură

```
Railway (Node.js)
├── server/
│   ├── index.mjs        — Express server, toate endpoint-urile
│   ├── mailer.mjs       — Email via Resend API
│   ├── whatsapp.mjs     — WhatsApp via Meta Graph API
│   └── drive.mjs        — Arhivare Google Drive via Service Account
└── public/
    ├── login.html
    ├── semdoc-initiator.html
    ├── semdoc-signer.html
    ├── admin.html
    ├── notifications.html
    ├── templates.html
    └── notif-widget.js

PostgreSQL (Railway)
└── Tabele: flows, users, notifications, templates
```

---

## Variabile de mediu

### Aplicație
```
PUBLIC_BASE_URL=https://app.docflowai.ro
PORT=3000
```

### Bază de date
```
DATABASE_URL=postgresql://...
```

### Autentificare
```
JWT_SECRET=your-long-random-secret
ADMIN_SECRET=your-long-random-secret
ADMIN_INIT_PASSWORD=parola-initiala-admin
```

### Email (Resend)
```
RESEND_API_KEY=re_xxxxxxxxxxxx
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>
```

### WhatsApp (opțional — Meta Business API)
```
WA_PHONE_NUMBER_ID=your_phone_number_id
WA_ACCESS_TOKEN=your_access_token
WA_TEMPLATE_SIGN=nume_template_semnare
WA_TEMPLATE_COMPLETE=nume_template_finalizat
WA_TEMPLATE_REFUSED=nume_template_refuzat
WA_TEMPLATE_LANG=ro
```

### Google Drive (arhivare)
```
GOOGLE_DRIVE_FOLDER_ID=id_folder_arhiva_drive
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

---

## Fișiere principale

| Fișier | Rol |
|---|---|
| `server/index.mjs` | Server Express — toate endpoint-urile |
| `server/mailer.mjs` | Trimitere email via Resend |
| `server/whatsapp.mjs` | Notificări WhatsApp via Meta Graph API |
| `server/drive.mjs` | Arhivare PDF-uri în Google Drive |
| `public/login.html` | Autentificare |
| `public/semdoc-initiator.html` | Inițiere flux, Status, Fluxuri mele, Șabloane |
| `public/semdoc-signer.html` | Semnare calificată, upload PDF, refuz |
| `public/admin.html` | Administrare utilizatori, fluxuri, arhivare Drive |
| `public/notifications.html` | Centru notificări cu tabs și badge-uri |
| `public/templates.html` | Șabloane reutilizabile de semnatari |
| `public/notif-widget.js` | Widget notificări în timp real (WebSocket) |

---

## Endpoints API

### Autentificare
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/auth/login` | Login email + parolă → JWT |
| GET | `/auth/me` | Verificare token curent |

### Fluxuri
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/flows` | Creare flux nou |
| GET | `/flows/:flowId` | Date flux + semnatari îmbogățiți (fără PDF) |
| GET | `/flows/:flowId/pdf` | PDF original (emite uploadToken în header) |
| GET | `/flows/:flowId/signed-pdf` | PDF semnat final (sau redirect Drive dacă arhivat) |
| POST | `/flows/:flowId/sign` | Marcare semnat |
| POST | `/flows/:flowId/upload-signed-pdf` | Upload PDF semnat calificat (verificare uploadToken) |
| POST | `/flows/:flowId/refuse` | Refuz semnare |
| POST | `/flows/:flowId/resend` | Retrimitere notificare semnatar curent |

### Fluxuri utilizator
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/my-flows` | Fluxurile proprii (inițiat sau semnatar) |
| GET | `/my-flows/:flowId/download` | Descărcare PDF semnat (sau redirect Drive) |
| GET | `/api/my-signer-token/:flowId` | Token semnare pentru flow curent |

### Notificări
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/api/notifications` | Lista notificărilor |
| GET | `/api/notifications/with-status` | Notificări + status semnatar (pentru filtrare) |
| POST | `/api/notifications/:id/read` | Marchează citit |
| POST | `/api/notifications/read-all` | Marchează toate citite |
| DELETE | `/api/notifications/:id` | Șterge notificare |

### Șabloane
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/api/templates` | Șabloanele proprii + cele shared din instituție |
| POST | `/api/templates` | Creare șablon |
| PUT | `/api/templates/:id` | Editare șablon (doar owner) |
| DELETE | `/api/templates/:id` | Ștergere șablon (doar owner) |

### Admin — Utilizatori
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/users` | Lista utilizatorilor |
| POST | `/admin/users` | Creare utilizator |
| PUT | `/admin/users/:id` | Editare utilizator |
| DELETE | `/admin/users/:id` | Ștergere utilizator |
| POST | `/admin/users/:id/reset-password` | Resetare parolă |
| POST | `/admin/users/:id/send-credentials` | Trimitere credențiale email |

### Admin — Fluxuri
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/admin/flows/clean` | Ștergere fluxuri vechi / toate |

### Admin — Arhivare Drive
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/drive/verify` | Test conexiune Google Drive |
| GET | `/admin/flows/archive-preview` | Preview fluxuri eligibile + MB estimat |
| POST | `/admin/flows/archive` | Arhivare în Drive + eliberare DB |

### WebSocket
| Endpoint | Descriere |
|---|---|
| `ws://app/ws` | Notificări în timp real (autentificare via JWT în query) |

### Utilitar
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/health` | Status server |
| GET | `/smtp-test` | Verificare configurație email |
| POST | `/smtp-test` | Trimitere email de test |
| GET | `/wa-test` | Verificare configurație WhatsApp |
| POST | `/wa-test` | Trimitere mesaj WhatsApp de test |

---

## Funcționalități

### Fluxuri de semnare
- **flowType `tabel`** — DocFlowAI generează cartuș cu semnatari + ancoră AcroForm pe PDF original
- **flowType `ancore`** — PDF-ul are deja ancore, merge pe flux fără modificări
- Semnare secvențială: fiecare semnatar primește PDF-ul cu semnăturile anterioare
- Refuz cu motiv: blochează fluxul și notifică toți participanții

### Securitate upload (Nivel 1)
La descărcarea PDF-ului, serverul emite un `uploadToken` JWT care conține:
- `flowId`, `signerToken`, `preHash` (sha256 al PDF-ului livrat), `exp: 4h`

La upload, serverul verifică:
- Token valid și neexpirat
- `flowId` și `signerToken` corespund
- `preHash` = hash-ul PDF-ului curent din sistem

Dacă verificarea eșuează → `409 pdf_version_mismatch`.

### Notificări
- **In-app** — WebSocket în timp real, badge pe clopoțel, tabs cu număr (Toate / Necitite / De semnat / Finalizate / Refuzate)
- **Email** — via Resend API (activat per user cu `notif_email = true`)
- **WhatsApp** — via Meta Graph API cu template messages (activat per user cu `notif_whatsapp = true`)

Evenimentele care declanșează notificări:
- `YOUR_TURN` — rândul semnătarului să semneze
- `COMPLETED` — documentul a fost semnat de toți
- `REFUSED` — un semnatar a refuzat

### Șabloane
- Creare și reutilizare șabloane de semnatari
- Partajare cu colegii din aceeași instituție (`shared = true`)
- Aplicare automată la inițierea unui flux nou

### Administrare utilizatori
- Câmpuri: Nume, Funcție, Instituție, Compartiment, Email, Rol, Telefon
- Notificări configurabile per user (in-app / email / WhatsApp)
- Formular 3 coloane, tabel cu paginare 10 rânduri, modal editare, dublu-click pe rând
- Dropdown autocompletat pentru Funcție, Instituție, Compartiment

### Arhivare Google Drive
- Arhivare manuală din panoul admin pentru fluxuri finalizate/refuzate
- Structură foldere: `DocFlowAI/Arhiva/Institutie/An/Luna/`
- Per flow: `_semnat.pdf` + `_original.pdf` + `_audit.json`
- După arhivare: `pdfB64` și `signedPdfB64` șterse din DB
- Download-urile redirecționează automat către Drive dacă flow-ul e arhivat
- Preview înainte de arhivare: număr fluxuri + MB eliberat

---

## Note tehnice

### Autentificare endpoints admin
Endpoint-urile `/admin/*` acceptă:
- Header `Authorization: Bearer <JWT>` cu rol `admin`
- Header `x-admin-secret: <ADMIN_SECRET>`

### Îmbogățire semnatari
`GET /flows/:flowId` și `GET /my-flows` returnează semnatarii îmbogățiți cu `functie` și `compartiment` din tabelul `users` (lookup după email), util pentru afișare în Status și Fluxuri mele.

### Migrări DB automate la pornire
La fiecare pornire, serverul verifică și adaugă automat coloanele lipsă:
- `users`: `phone`, `notif_inapp`, `notif_email`, `notif_whatsapp`, `compartiment`
- Tabel `notifications`: creat automat dacă nu există
- Tabel `templates`: creat automat dacă nu există

### Redirect după semnare
După upload PDF semnat, semnatarul este redirecționat automat la pagina Status după 2.5 secunde.

### PDF livrat semnătarului
- **Semnatar 1, flowType `tabel`**: PDF original + cartuș generat de DocFlowAI
- **Semnatar 1, flowType `ancore`**: PDF original nemodificat
- **Semnatar 2+**: PDF semnat de predecesori (descărcat direct din `/signed-pdf`)
