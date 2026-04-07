# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DocFlowAI** (v3.9.x) is a multi-tenant SaaS platform for managing qualified electronic signatures (QES) on PDF documents, targeting Romanian public administration. Compliant with eIDAS, Law 455/2001, Law 214/2024, OUG 38/2020, HG 1259/2001.

## Commands

```bash
# Run the application
npm start                 # node server/index.mjs

# Testing
npm test                  # Run all tests once (vitest run)
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage report

# Syntax checking (runs node --check on 40+ server files)
npm run check
```

**Run a single test file:**
```bash
npx vitest run server/tests/integration/flows.test.mjs
```

**Environment:** Copy `env.example` to `.env`. Required vars: `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `PUBLIC_BASE_URL`, `RESEND_API_KEY`, `MAIL_FROM`.

**Node.js version:** 20 (see `.node-version`). Codebase uses ES modules throughout (`"type": "module"`, `.mjs` extensions).

---

## ⚠️ ZONE INTERZISE — NU MODIFICA NICIODATĂ

Următoarele fișiere sunt **STRICT NO-TOUCH**. Semnarea STS Cloud QES PAdES multi-semnatar funcționează în producție cu clienți reali. Orice modificare poate invalida semnăturile calificate existente:

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
```

**Regula absolută:** Dacă o modificare ar putea atinge fluxul de semnare STS sau PAdES, OPREȘTE și întreabă mai întâi.

---

## Architecture

### Stack
- **Backend:** Node.js 20, Express 4, PostgreSQL (via `pg`), compression middleware
- **Real-time:** WebSocket (`ws`)
- **PDF:** `pdf-lib`, `@signpdf/signpdf`, `node-forge`, `asn1js`/`pkijs` pentru X.509/CMS
- **Java microservice:** Spring Boot pentru operații PAdES iText (`SIGNING_SERVICE_URL`)
- **Auth:** JWT în HttpOnly cookies, PBKDF2 (100k iterații), TOTP/2FA
- **Notificări:** Resend (email), Meta Business API (WhatsApp), VAPID Web Push
- **Storage:** PDF bytes în PostgreSQL BYTEA (`flows_pdfs`); Google Drive pentru arhivare
- **Deploy:** Railway EU West (PostgreSQL + Node.js servicii separate)
- **Testing:** Vitest + Supertest

### Backend Structure (`server/`)

**Entry point:** `server/index.mjs` — montează toate rutele, inițializează WebSocket, pornește job-uri background (arhivare, cleanup notificări). Conține 500+ linii de changelog inline la început.

**Routes** (`server/routes/`):
- `auth.mjs` — login, JWT refresh, CSRF tokens
- `admin.mjs` — panou admin (utilizatori, organizații, analytics, outreach, onboarding) — 2257 linii
- `flows/` — management fluxuri modular (vezi mai jos)
- `templates.mjs` — template-uri semnatari
- `notifications.mjs` — centru notificări in-app
- `totp.mjs` — setup/verificare 2FA
- `verify.mjs` — endpoint public verificare semnături
- `report.mjs` — analytics/raportare
- `formulare.mjs` — gestionare formulare (Notă de Fundamentare, Ordonanțare)

**Flow sub-routes** (`server/routes/flows/`):
| Fișier | Responsabilitate |
|--------|-----------------|
| `index.mjs` | Orchestrator/router |
| `crud.mjs` | Creare, citire, listare fluxuri |
| `signing.mjs` | Semnare (upload local), refuz, upload PDF |
| `lifecycle.mjs` | Reinițiere, review, delegare, anulare |
| `cloud-signing.mjs` | ⛔ STS OAuth flow, coordonare provideri cloud |
| `email.mjs` | Trimitere email extern + tracking open/click |
| `attachments.mjs` | Gestiune documente suport |
| `acroform.mjs` | Detecție câmpuri XFA/AcroForm |
| `bulk-signing.mjs` | ⛔ Operații bulk semnare |

**Signing providers** (`server/signing/providers/`):
- `LocalUploadProvider.mjs` ✅ Operațional
- `STSCloudProvider.mjs` ✅ ⛔ Complet implementat — NU MODIFICA
- `CertSignProvider.mjs`, `TransSpedProvider.mjs`, `AlfaTrustProvider.mjs`, `NamirialProvider.mjs` — arhitectură skeleton

**Database** (`server/db/index.mjs`): Pool PostgreSQL + migrări automate la startup (50+ migrări în `schema_migrations`).

**Tabele principale:**
- `flows` — date flux în JSONB (`data`), cu coloane dedicate: `org_id`, `created_at`, `updated_at`, `deleted_at`
- `flows_pdfs` — PDF bytes în BYTEA (chei: `pdfB64`, `signedPdfB64`, `originalPdfB64`, `padesPdf_*`)
- `users` — utilizatori cu `org_id` FK
- `organizations` — organizații cu `cif`, `compartimente` JSONB, `signing_providers_enabled` GIN indexed
- `flow_signatures`, `signature_certificates`, `trust_reports` — audit QES
- `audit_log` — log evenimente complete
- `archive_jobs` — job-uri arhivare Google Drive
- `outreach_institutions`, `outreach_campaigns` — modul outreach

**Middleware** (`server/middleware/`): `auth.mjs` (JWT verify), `logger.mjs` (Pino), `metrics.mjs` (Prometheus), `rateLimiter.mjs` (in-memory), `cspNonce.mjs`, `csrf.mjs`.

---

## Tipuri de Fluxuri

Două tipuri de fluxuri, cu comportament diferit la semnare:

**`tabel`** — DocFlowAI generează tabelul de semnături (footer PDF). Footer-ul se aplică la CREAREA fluxului (înainte de orice semnătură) pentru a nu invalida QES-ul ulterior.

**`ancore`** — PDF-ul vine deja cu câmpuri de semnătură de la sisteme externe (ex: Forexebug). DocFlowAI NU aplică footer, NU modifică PDF-ul la creare.

**Regula critică:** `pdf-lib.save()` nu se apelează NICIODATĂ pe un PDF deja semnat — ar invalida semnăturile QES existente.

---

## PAdES Signature Flow

### Local Upload
Semnatar descarcă PDF unsigned → semnează offline cu aplicație desktop QES → uploadează via `POST /flows/:flowId/upload-signed-pdf` → sistemul validează și avansează fluxul.

### STS Cloud (hash-based) ⛔ NO-TOUCH
1. `POST /flows/:flowId/initiate-cloud-signing` → `signing/pades.mjs:preparePadesDoc()` creează placeholder, `calcPadesHash()` calculează SHA-256 ByteRange hash
2. Redirect la `https://idp.stsisp.ro/` (PKCE OAuth)
3. Sistemul trimite hash la `https://sign.stsisp.ro/api/v1/signature`, polling pentru CMS DER bytes
4. `injectCms()` inserează semnătura ca incremental PDF update

### Multi-semnatar PAdES
- Câmpurile de semnătură `/Sig` sunt create de **iText** (Java service) la crearea fluxului, NU de pdf-lib
- Motivul: pdf-lib creează Widget-uri incomplete; iText le „repară" la semnare, ceea ce invalidează semnaturile anterioare
- La semnare ulterioară, iText recunoaște propriile câmpuri și scrie MINIM în incremental update
- Cartuș vizual „SEMNAT SI APROBAT" afișează rol, nume, funcție per celulă

---

## Multi-tenancy

Fiecare `organization` configurează ce provideri de semnare sunt activi (`signing_providers_enabled` JSONB array, GIN indexed). Utilizatorii aparțin organizațiilor via `org_id`. **Toate** query-urile flows/users includ izolare `org_id`.

**Roluri utilizatori:**
- `admin` — super-admin, vede totul
- `org_admin` — administrator instituție, vede doar org-ul propriu
- `user` — utilizator normal

**Pattern important:** `org_id` este disponibil direct din JWT payload (`actor.orgId`). Nu face `SELECT org_id FROM users WHERE email=...` dacă `actor.orgId` este disponibil — este un query redundant.

---

## Convenții DB & Performance

### Indexuri importante
```sql
idx_flows_org_updated    ON flows(org_id, updated_at DESC)
idx_flows_active         ON flows WHERE not completed/refused/cancelled
idx_flows_signers_gin    ON flows USING GIN (data->'signers')
idx_flows_org_status     ON flows(org_id, data->>'status')
idx_flows_deleted_at     ON flows(deleted_at) WHERE deleted_at IS NULL
```

### Reguli query
- Folosește **`org_id` coloana** (nu `data->>'orgId'`) pentru filtrare — are index, JSONB nu
- Preferă **window function** `COUNT(*) OVER()` în loc de 2 query-uri separate (COUNT + SELECT)
- Folosește **LEFT JOIN users** în loc de correlated EXISTS pentru filtre instFilter/deptFilter
- Proiectează câmpurile JSONB necesare, nu `SELECT data` complet pentru listinguri

### Pool PostgreSQL
```js
max: 20, idleTimeoutMillis: 30_000
```

---

## Security Patterns

- JWT în HttpOnly cookies (niciodată `localStorage`), cu token versioning pentru invalidare la reset parolă
- CSRF: double-submit cookie pattern (`X-CSRF-Token` header + cookie), auto-retry în `notif-widget.js`
- Soft deletes (`deleted_at`) pentru audit trails complete
- Niciun detaliu de eroare raw în răspunsuri 500 (logate server-side via Pino)
- Webhook: HMAC-SHA256
- Rate limiting in-memory (nu supraviețuiește restarturilor Railway)

---

## Frontend

Toate frontendurile sunt SPA-uri single-file (HTML + JS inline), servite static din `public/`:

| Fișier | Dimensiune | Scop |
|--------|-----------|------|
| `admin.html` | 309KB | Panou admin complet |
| `semdoc-initiator.html` | 138KB | Creare flux, upload PDF |
| `semdoc-signer.html` | 114KB | Interfață semnare (STS OAuth) |
| `flow.html` | 71KB | Status flux, WebSocket real-time, ETag cache |
| `formular.html` | 57KB | Formulare administrative |
| `notif-widget.js` | — | Widget notificări shared, auto-retry CSRF |
| `sw.js` | — | Service Worker offline |

**Helper universal:** `esc(str)` — escaping HTML obligatoriu pentru orice date utilizator afișate în DOM. Niciodată `innerHTML` cu date neescapate.

---

## Java Signing Service (Spring Boot)

Microserviciu separat pentru operații PAdES iText. Configurat via `SIGNING_SERVICE_URL`.

**Endpoints folosite:**
- `POST /api/pades/create-fields` — creează câmpuri AcroForm `/Sig` cu iText
- `POST /api/pades/prepare` — pregătește PDF cu placeholder ByteRange
- `POST /api/pades/finalize` — injectează CMS DER în placeholder

**Important:** Apelurile `fetch()` către Java service nu au timeout explicit — în caz de hung service, conexiunile Node.js rămân blocate.

---

## Modul Outreach

Campanii email către ~2.950 municipalități românești. Tabele: `outreach_institutions`, `outreach_campaigns`, `outreach_recipients`. Router separat în `server/routes/admin/outreach.mjs`.

---

## Deployment Railway

- **Producție:** `docflowai-app.up.railway.app` (branch `main`)
- **Staging:** `docflowai-app-staging.up.railway.app` (branch `develop`)
- Migrările rulează automat la startup
- `.railwayignore` exclude fișierele mari din `tools/`
- Railway folosește `npm ci` — `package.json` și `package-lock.json` trebuie sincronizate întotdeauna

---

## Integrări Externe

| Serviciu | Scop | Config |
|----------|------|--------|
| Resend | Email tranzacțional | `RESEND_API_KEY` |
| Meta Business API | Notificări WhatsApp | `WHATSAPP_*` vars |
| Google Drive | Arhivare PDF-uri finalizate | `GOOGLE_*` vars |
| Google Workspace | Provisionare utilizatori GWS | `GWS_*` vars |
| STS Romania | Semnare cloud QES | `STS_*` vars |
| DigiCert TSA | RFC 3161 timestamp | `http://timestamp.digicert.com` |
| VAPID Web Push | Notificări browser | `VAPID_*` vars |

---

## Testing

Teste de integrare în `server/tests/integration/` folosesc Supertest contra unei baze de date reale (configurată în `server/tests/setup.mjs`). PBKDF2 (~200ms) implică timeout de 15s în `vitest.config.mjs`. Coverage exclude: Google Drive, GWS, WhatsApp, Web Push.

**Înainte de orice modificare:** rulează `npm test` și verifică că toate testele trec. Nu livra cod cu teste care pică.
