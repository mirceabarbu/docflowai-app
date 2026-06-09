# DocFlowAI v3.9.547

**Platformă SaaS de circulație și semnare electronică calificată pentru administrația publică din România.**

Conformă cu **eIDAS**, **Legea 455/2001**, **HG 1259/2001** și **OMF 1140/2025** (workflow ALOP).

---

## Descriere

DocFlowAI gestionează fluxuri complete de aprobare și semnare electronică calificată (QES) pentru instituții publice (primării, direcții, ordonatori de credite). Platforma acoperă:

- **Fluxuri de semnare secvențială multi-semnatar** pe documente PDF generice
- **Workflow ALOP complet** (Angajare Legală → Lichidare → Ordonanțare → Plată) conform OMF 1140/2025
- **Document de Fundamentare (DF)** și **Ordonanțare de Plată (ORD)** cu workflow P1 → P2 și revizii R0/R1+
- **Formulare oficiale** (Referat Necesitate, Notă Fundamentare Investiții)
- **Bulk signing** pentru aprobări în lot
- **Verificare furnizor** (CUI ANAF, IBAN, coerență date)
- **Trust Report PDF** cu verificare X.509 pe 6 niveluri (L1-L6) + QR code

---

## Stack tehnic

| Componentă | Tehnologie |
|---|---|
| Runtime | Node.js (ES Modules) |
| Framework | Express 4 |
| Bază de date | PostgreSQL (pg) |
| Real-time | WebSocket (ws) |
| PDF generare/stamp | pdf-lib + @signpdf/placeholder-pdf-lib |
| **PAdES signing** | **Java Spring Boot microservice + iText** |
| Autentificare | JWT (HttpOnly cookies) + 2FA TOTP (otplib) |
| Email | Resend API |
| WhatsApp | Meta Business API |
| Notificări push | Web Push (VAPID) |
| Stocare arhivă | Google Drive API |
| Conversie DOCX → PDF | LibreOffice headless |
| Logging | Pino structured |
| Metrics | Prometheus endpoint |
| Testing | Vitest + Supertest (mock + Postgres real) |
| Deploy | Railway (Node app + Java sidecar) |

---

## Structura proiectului

```
server/
  index.mjs                     ← Entry point: Express, WebSocket, jobs, notify(), wsPush(), stampFooterOnPdf()
  db/
    index.mjs                   ← Pool PostgreSQL + 65 migrații inline
    migrate.mjs                 ← Runner pentru migrații .sql adiționale
    migrations/*.sql            ← Migrații paralele (.sql files)
    queries/                    ← Query builders refolosibile (audit, signing, flows)
  middleware/
    auth.mjs                    ← JWT verify, requireAuth, password hashing (PBKDF2)
    logger.mjs                  ← Pino structured logging
    rateLimiter.mjs             ← Rate limiting DB-backed
    metrics.mjs                 ← Prometheus metrics
    errorHandler.mjs            ← Error normalization
  core/
    errors.mjs                  ← AppError hierarchy
    hashing.mjs                 ← Password hashing helpers
    ids.mjs                     ← ID generation
    pagination.mjs              ← Pagination helpers
  routes/
    auth.mjs                    ← Login, logout, JWT refresh, 2FA
    admin.mjs                   ← Panel admin (orgs, users, flows, rapoarte)
    admin/
      outreach.mjs              ← Campanii email outreach
      analytics.mjs             ← Dashboard analytics
      audit.mjs                 ← Audit log queries + export
      maintenance.mjs           ← Health, archive jobs, GWS
      organizations.mjs         ← Multi-tenant management
      users.mjs                 ← User CRUD + bulk import CSV
    flows/                      ← Modular: index orchestrează submodulele
      index.mjs                 ← Mount + dependency injection
      crud.mjs                  ← CRUD fluxuri
      lifecycle.mjs             ← Pornire/refuz/anulare flux
      signing.mjs               ← Local upload signing
      cloud-signing.mjs         ← STS Cloud QES (NO-TOUCH)
      bulk-signing.mjs          ← Bulk signing sessions (NO-TOUCH)
      acroform.mjs              ← Detecție AcroForm/XFA fields
      attachments.mjs           ← File attachments
      email.mjs                 ← Email semnatari
      signer-status.mjs         ← Status real-time semnatari
    formulare.mjs               ← DF/ORD generare PDF (pdf-lib + NotoSans)
    formulare/                  ← Modular (model flows/): DF/ORD CRUD + workflow P1→P2 + revizii
      index.mjs                 ← Orchestrator, export formulareDbRouter
      df.mjs                    ← Rute /api/formulare-df* (CRUD, lifecycle, revizii R0/R1+)
      ord.mjs                   ← Rute /api/formulare-ord*
      shared.mjs                ← Capturi, atașamente, beneficiari, list, audit (:type)
      _helpers.mjs              ← requireDb partajat
    formulare-oficiale.mjs      ← Referat Necesitate + Notă Fundamentare Investiții
    alop.mjs                    ← ALOP state machine (draft → angajare → lichidare → ordonanțare → plată)
    notifications.mjs           ← Notificări in-app
    templates.mjs               ← Șabloane semnatari
    supplier-verify.mjs         ← Verificare furnizor (montat la /api/verify)
    verify.mjs                  ← Rute publice verificare PDF (Trust Report)
    report.mjs                  ← Rapoarte
  services/
    formular-shared.mjs         ← Lifecycle DF/ORD parametrizat pe formType (FORMULAR_TYPES)
    formular-capabilities.mjs   ← Decizii UI server-side (computeDocCapabilities)
    authz-formular.mjs          ← Autorizare DF/ORD (canEdit/canView/canDestroy)
    formulare-oficiale/         ← Generatoare PDF formulare oficiale
    verify/                     ← Logică verificare CUI ANAF + IBAN + coerență
    sign-trust-report.mjs       ← Generare Trust Report PDF cu QR code
    certificate-verify.mjs      ← Verificare X.509 6 niveluri (L1-L6)
    user-leave.mjs              ← Concediu/delegare automată
    format-money.mjs            ← Formatare numerică RO
  signing/
    SigningProvider.mjs         ← Interfață abstractă provider
    index.mjs                   ← Factory + registry
    pades.mjs                   ← PAdES preparation (NO-TOUCH)
    java-pades-client.mjs       ← Client HTTP către Java microservice (NO-TOUCH)
    providers/
      LocalUploadProvider.mjs   ← Upload local (orice certificat calificat) ✅
      STSCloudProvider.mjs      ← STS Cloud QES — implementare completă (NO-TOUCH) ✅
      CertSignProvider.mjs      ← certSIGN / Paperless ⏳ în dezvoltare
      TransSpedProvider.mjs     ← Trans Sped ⏳ în dezvoltare
      AlfaTrustProvider.mjs     ← AlfaTrust / AlfaSign ⏳ în dezvoltare
      NamirialProvider.mjs      ← Namirial eSignAnyWhere ⏳ în dezvoltare
      CloudProviderBase.mjs     ← HTTP + retry + HMAC comun
  utils/
    convertToPdf.mjs            ← Conversie DOCX/XLSX/DOC/XLS → PDF (LibreOffice)
  webhook.mjs                   ← Webhook generic per organizație (HMAC-SHA256)
  mailer.mjs / whatsapp.mjs / push.mjs / drive.mjs / gws.mjs

public/
  semdoc-initiator.html         ← Creare flux, upload PDF, configurare semnatari
  semdoc-signer.html            ← Semnare document, selecție provider QES
  flow.html                     ← Status flux, timeline vizual
  formular.html                 ← Editor DF/ORD/ALOP/formulare oficiale (5 tab-uri)
  admin.html                    ← Panel administrare complet
  templates.html                ← Gestionare șabloane
  bulk-signer.html              ← Semnare în lot
  notifications.html            ← Centru notificări
  setari.html                   ← Setări utilizator + concediu/delegare
  verifica.html                 ← Verificare publică PDF (Trust Report)
  js/
    common/                     ← Loader-e partajate (pdf-lib, pdfjs-worker)
    formular/                   ← DF/ORD/ALOP UI logic
    semdoc-initiator/           ← Logic creare flux
    semdoc-signer/              ← Logic semnare
    admin/                      ← Module admin (organizations, users, etc.)
    notifications/
  css/
    df/                         ← Design system unificat (tokens, components, shell)

docs/
  archive/                      ← Prompturi istorice (BLOC 4.1, 4.2, 4.3, hotfix)
  audits/                       ← Rapoarte audit (AUDIT_REPORT, MONEY-FIELDS-AUDIT)
  incidents/                    ← Postmortems (DB init failure)
  PATCH-JAVA-DELEGARE.md
```

---

## Variabile de mediu

Copiază `env.example` în `.env`:

```env
# Bază
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=secret-minim-32-caractere
PORT=3000
PUBLIC_BASE_URL=https://app.docflowai.ro

# Email (Resend)
RESEND_API_KEY=re_...
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>

# Push notifications (VAPID)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:contact@docflowai.ro

# Bootstrap admin (la primul start)
ADMIN_EMAIL=admin@docflowai.ro
ADMIN_INIT_PASSWORD=Admin1234!
ADMIN_NAME=Administrator

# Java PAdES microservice
JAVA_PADES_URL=http://localhost:8081

# Opțional — Google Drive arhivare
GOOGLE_SERVICE_ACCOUNT_JSON=...
DRIVE_FOLDER_ID=...

# Opțional — WhatsApp Business
WA_TOKEN=...
WA_PHONE_ID=...

# Opțional — Google Workspace provisioning
GWS_SUBJECT=admin@domeniu.ro
```

---

## Rulare locală

```bash
npm install
cp env.example .env
# Editează .env cu credențialele tale
npm start
```

Migrările DB rulează **automat la startup** (sistem dual: 65 migrații inline în `db/index.mjs` + 16 fișiere `.sql` în `db/migrations/`).

### Teste

Două niveluri (detalii în CLAUDE.md → Testing):

```bash
npm test            # Nivel 1 — Vitest mock/unit + integration (rapid, fără DB)
npm run db:test:up  # pornește Postgres efemer (Docker) → exportă TEST_DATABASE_URL afișat
npm run test:db     # Nivel 2 — Postgres real: plasă de caracterizare (sursa de adevăr pt. regresii)
npm run check       # node --check sintaxă pe fișierele server
```

⚠️ `test:db` *sărit* (fără Docker) ≠ *trecut*. Confirmarea autoritară e CI (`push: develop`, `postgres:16`).

---

## Tipuri de fluxuri

### Tabel generat
DocFlowAI generează PDF-ul cu tabelul de semnături și ancora predefinită.

### Ancore existente (XFA / AcroForm)
PDF-ul vine cu câmpuri de semnătură predefinite. Suportat:
- **AcroForm standard** — câmpuri `/Sig` în structura PDF
- **XFA dinamic** — formulare Adobe LiveCycle (deferred 2027)

Platforma detectează automat câmpurile și le prezintă inițiatorului pentru asociere per semnatar.

---

## Module principale

### ALOP — Workflow OMF 1140/2025
State machine completă pentru aprobări financiare publice:
- **Angajare Legală** → DF semnat (Document de Fundamentare cu P1 inițiator + P2 Responsabil CAB)
- **Lichidare** → confirmare conformitate furnizor + documente justificative
- **Ordonanțare** → ORD semnat (Ordonanțare de Plată)
- **Plată** → înregistrare plată finală cu nr. OP + data

Suport pentru **multi-ORD** per ALOP, **revizii DF R0/R1+** cu pre-populare col.5 (val. revizie precedentă), **lichidare cu data PV**.

### DF / ORD — Workflow P1 → P2 cu revizii
- **P1** (inițiator) completează Secțiunea A
- **P2** (Responsabil CAB) completează Secțiunea B sau **returnează ca neconform** cu motiv
- **R0** = inițială, **R1+** = revizii cu header lock + pre-populare col.5 = col.7 din revizie precedentă
- Generare PDF nativă cu `pdf-lib` + NotoSans Romanian (fără XFA)

### Formulare oficiale
- **Referat de Necesitate** — formular complet ANAF
- **Notă de Fundamentare Investiții** — 6 secțiuni cu APROBAT/VIZAT + semnatari

### Bulk Signing
Semnare în lot pentru fluxuri multiple cu același semnatar — sesiune unică STS Cloud sau upload local repetat.

### Verificare furnizor
- **CUI** — interogare ANAF live
- **IBAN** — validare structură + cifră de control
- **Coerență** — cross-check denumire furnizor vs CUI

---

## Provideri semnătură electronică calificată

### ✅ Local Upload — Operațional
Semnare cu orice aplicație desktop, orice certificat calificat. Cartușul vizual și câmpul `/Sig` sunt construite client-side cu `pdf-lib` (CDN cu fallback multi-CDN).

### ✅ STS Cloud QES — Implementat (necesită credențiale)
Implementare completă conform documentației oficiale STS, cu **Java Spring Boot microservice + iText** pentru semnare PAdES:
- Documentul rămâne exclusiv pe server — STS primește doar hash SHA-256
- OAuth 2.0 PKCE flow + 2FA + PIN certificat pe `idp.stsisp.ro`
- Aprobare pe email sau notificare PUSH
- Înregistrare prin `formulare.sts.ro` de reprezentantul instituției
- Toate câmpurile de semnătură există în revizia 0 PDF (creată de iText) — Java adaugă ByteRange + Contents per semnatar cu `fieldAlreadyExists=true`

**Configurare:** Admin → Organizații → ⚙ Config → bifează STS → ⚙ Config → Generează pereche chei RSA → trimite cheia publică la STS → completează `clientId`, `kid`, `redirectUri`.

### ⏳ certSIGN / Trans Sped / AlfaTrust / Namirial — În dezvoltare
Schelete arhitecturale implementate. Marcate `stub: true` în UI admin (badge vizibil "în dezvoltare", checkbox dezactivat) pentru a preveni activarea accidentală în producție.

---

## Arhitectură multi-tenant

- Fiecare **organizație** are propria configurație de provideri de semnătură
- **Semnatarul alege** providerul la semnare dintre cei activi în organizație
- **Upload local** este întotdeauna disponibil ca fallback
- Cross-tenant isolation enforced la nivel de query (org_id în toate tabelele relevante)

---

## Securitate

- JWT în cookie HttpOnly (nu localStorage)
- Token versioning — invalidare la reset parolă
- 2FA TOTP cu `otplib`
- Rate limiting DB-backed
- Cross-tenant isolation
- Audit log complet per flux + IP tracking
- HMAC-SHA256 pentru webhook-uri
- CSP + Helmet activate
- PBKDF2 pentru hash parole
- Soft-delete pe fluxuri (cu deleted_by tracking)
- Plain password ELIMINAT din toate response-urile
- Trust Report PDF cu verificare X.509 L1-L6 (lanț CA + revocare)

---

## Schema DB

Sistem dual de migrări la startup:
1. **65 migrații inline** în `server/db/index.mjs` (sistemul principal)
2. **16 fișiere `.sql`** în `server/db/migrations/` rulate prin `runMigrations()` (scheme adiționale)

Ambele sunt idempotente (`CREATE TABLE IF NOT EXISTS`).

> Reguli stricte pentru migrări noi în `CLAUDE.md` — citește înainte de orice migrare. Postmortem incident DB init: [`docs/incidents/2026-04-19-db-init-failure.md`](docs/incidents/2026-04-19-db-init-failure.md)

### Tabele principale
- `organizations`, `users`, `delegations`, `login_blocks`
- `flows`, `flow_signers`, `flow_signatures`, `flow_attachments`, `flows_pdfs`
- `formulare_df`, `formulare_ord`, `formulare_capturi`, `formulare_oficiale`, `beneficiari`
- `alop_instances`, `alop_sabloane`, `alop_ord_cicluri`
- `bulk_signing_sessions`, `signature_certificates`, `trust_reports`
- `audit_log`, `notifications`, `push_subscriptions`
- `outreach_campaigns`, `outreach_recipients`, `outreach_primarii`
- `archive_jobs`, `templates`, `schema_migrations`

---

## Integrare AvanDoc / webhook-uri

Configurează `webhook_url` per organizație. La finalizare flux, DocFlowAI trimite `POST` cu payload complet semnat HMAC-SHA256.

Evenimente: `flow.completed`, `flow.refused`, `flow.cancelled`, `flow.signed_step`.

---

## Deployment

### Producție: Railway
- **App principal**: Node.js (acest repo)
- **Java PAdES microservice**: separate Railway service (Spring Boot + iText)
- **PostgreSQL**: Railway managed
- **Domeniu**: `app.docflowai.ro`

### Staging
- `docflowai-app-staging.up.railway.app` (auto-deploy din `develop`)

### Branch strategy
- `main` = producție (auto-deploy la push)
- `develop` = staging (auto-deploy la push)
- Feature branches `v4.1-xxx` pentru schimbări mai mari

---

## Cleanup major v3.9.422 → v3.9.426

Audit complet pre-prod cu eliminare ~7.000 linii cod mort în 5 livrări incrementale:

| Versiune | Bloc | Schimbare |
|---|---|---|
| v3.9.422 | Bugfix | DF/ORD R1+ — returnat → P1 editare salvează + UI corect (3 bug-uri) |
| v3.9.423 | GRUPA A | Orfani HTML/MD + ascundere UI provideri stub |
| v3.9.424 | B1+B2 | -613 linii servicii moarte (services/pdf, ws, webhook, notifications/notify, pdf/stamp) |
| v3.9.425 | B3 | -5.788 linii sistem v4 mort + `/api/v4/*` eliminat (păstrat `/api/verify`) |
| v3.9.426 | B4 | Consolidare loader-e identice semdoc → `public/js/common/` |

**Beneficii:** surface area redusă, mentenanță simplificată, codebase mai ușor de înțeles, zero regresii (293 teste verzi).

---

## Consolidare anti-regresie v3.9.543 → v3.9.546

| Versiune | Etapă | Schimbare |
|---|---|---|
| v3.9.543 | Etapa 0 | Plasă caracterizare DB DF/ORD (submit/complete/returneaza/revizuieste) |
| v3.9.544 | Etapa 1 | Lifecycle DF/ORD → `formular-shared.mjs` parametrizat pe formType (−587 linii duplicat) |
| v3.9.545 | Etapa 2 | Split `formulare-db.mjs` → `routes/formulare/{df,ord,shared,index}` |
| v3.9.546 | Etapa 0-ALOP | Plasă caracterizare DB mașină de stare ALOP (progresie, lazy-resync, ciclu multi-ORD) |

---

## Licență

Proprietar — DocFlowAI © 2026. Toate drepturile rezervate.
