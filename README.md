# DocFlowAI — MVP (README actualizat)

## Descriere
Platformă de circulație și semnare electronică a documentelor.  
Suportă două tipuri de fluxuri:
- **Cu tabel generat** — DocFlowAI adaugă cartuș + ancoră pentru semnătură calificată
- **Ancore existente** — PDF-ul are deja ancore, merge pe flux fără modificări

---

## Variabile de mediu (Railway)

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

### Email (SMTP)
```
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=noreply@docflowai.ro
SMTP_PASS=APP_PASSWORD
```

---

## Fișiere principale

| Fișier | Rol |
|---|---|
| `index.mjs` | Server Express — toate endpoint-urile |
| `mailer.mjs` | Trimitere email via SMTP (nodemailer) |
| `semdoc-initiator.html` | Pagina inițiatorului (creare flux, status, fluxuri mele) |
| `semdoc-signer.html` | Pagina semnătarului (vizualizare, descărcare, upload PDF semnat, refuz) |
| `admin.html` | Panou administrare utilizatori și fluxuri |
| `login.html` | Pagina de autentificare |

---

## Endpoints API

### Autentificare
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/auth/login` | Login cu email + parolă → JWT |
| GET | `/auth/me` | Verificare token curent |

### Fluxuri
| Metodă | Endpoint | Descriere | Auth |
|---|---|---|---|
| POST | `/flows` | Creare flux nou (cu PDF, semnatari, flowType) | JWT |
| GET | `/flows/:flowId` | Date flux (fără PDF brut) | token semnatar |
| PUT | `/flows/:flowId` | Actualizare flux | Admin |
| GET | `/flows/:flowId/pdf` | Descărcare PDF original | token semnatar |
| GET | `/flows/:flowId/signed-pdf` | Descărcare PDF semnat (ultimul upload) | token semnatar |
| POST | `/flows/:flowId/sign` | Marcare semnat (fără upload PDF) | token semnatar |
| POST | `/flows/:flowId/upload-signed-pdf` | Upload PDF semnat calificat | token semnatar |
| POST | `/flows/:flowId/refuse` | Refuz semnare + notificare email | token semnatar |
| POST | `/flows/:flowId/resend` | Retrimite email semnatar curent | Admin |

### Fluxuri utilizator autentificat
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/my-flows` | Lista fluxurilor inițiate de utilizatorul curent |
| GET | `/my-flows/:flowId/download` | Descărcare PDF final din fluxurile proprii |

### Admin — Utilizatori
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/admin/users` | Lista tuturor utilizatorilor |
| POST | `/admin/users` | Creare utilizator nou |
| PUT | `/admin/users/:id` | Editare utilizator |
| DELETE | `/admin/users/:id` | Ștergere utilizator |
| POST | `/admin/users/:id/reset-password` | Resetare parolă |
| POST | `/admin/users/:id/send-credentials` | Trimitere credențiale pe email |

### Admin — Fluxuri
| Metodă | Endpoint | Descriere |
|---|---|---|
| POST | `/admin/flows/clean` | Ștergere fluxuri vechi sau toate |

### Utilitar
| Metodă | Endpoint | Descriere |
|---|---|---|
| GET | `/health` | Status server |
| GET | `/smtp-test` | Verificare configurație SMTP |
| POST | `/smtp-test` | Trimitere email de test |

---

## Autentificare endpoints admin
Endpoint-urile admin acceptă:
- Header: `x-admin-secret: <ADMIN_SECRET>`
- Header: `Authorization: Bearer <ADMIN_SECRET>`
- sau JWT cu rol `admin`

---

## Note arhitecturale

### Link semnare
Format: `/semdoc-signer.html?flow=<flowId>&token=<token>`  
Indexul semnătarului se derivă din token (server lookup), nu din URL.

### PDF
- `GET /flows/:flowId` **nu** returnează `pdfB64` — returnează `hasPdf: true/false`
- PDF-ul brut se obține separat via `GET /flows/:flowId/pdf`
- PDF-ul semnat (ultimul upload) via `GET /flows/:flowId/signed-pdf`

### flowType
- `"tabel"` (default) — DocFlowAI generează cartuș + ancoră pe PDF original
- `"ancore"` — PDF-ul are deja ancore, se trimite pe flux fără modificări

### Logica semnare
1. Semnatar 1 → descarcă PDF cu cartuș generat (sau original dacă `flowType=ancore`) → semnează calificat în Adobe → uploadează PDF semnat
2. Semnatar 2+ → descarcă PDF-ul semnat de predecesori → adaugă semnătura → uploadează
3. La refuz → flow `status: "refused"`, email trimis inițiatorului + semnatarilor care au semnat deja

### Email notificări
- **Creare flux** — email trimis primului semnatar cu link de semnare
- **Semnare completă** — email trimis inițiatorului
- **Refuz** — email trimis inițiatorului + semnatarilor care au semnat anterior (text diferit per destinatar)
- **Credențiale** — email cu email + parolă trimis la crearea utilizatorului (opțional, la confirmare)
