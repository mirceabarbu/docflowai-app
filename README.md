# DocFlowAI

**Platformă SaaS de circulație și semnare electronică calificată pentru administrația publică din România.**

> Versiunea curentă este cea din [`package.json`](package.json) (câmpul `version`) — nu este replicată aici, ca să nu rămână în urmă.

Cadru normativ de referință:

| Act | Rol |
|---|---|
| **Regulamentul eIDAS (UE) 910/2014**, cu modificările ulterioare (Reg. (UE) 2024/1183) | semnătura electronică calificată, prestatori de servicii de încredere |
| **Legea nr. 214/2024** | transpunerea/aplicarea la nivel național; înlocuiește reglementarea anterioară a semnăturii electronice și a mărcii temporale |
| **Ordinul MEDAT nr. 102/2026** (MO nr. 81 / 2.02.2026) | normele tehnice în vigoare |
| **OMF nr. 1140/2025** (MO nr. 696 / 25.07.2025, aplicabil de la 1.01.2026) | workflow ALOP — Angajare, Lichidare, Ordonanțare, Plată |

---

## Descriere

DocFlowAI gestionează fluxuri complete de aprobare și semnare electronică calificată (QES) pentru instituții publice (primării, direcții, ordonatori de credite). Platforma acoperă:

- **Fluxuri de semnare secvențială multi-semnatar** pe documente PDF generice
- **Workflow ALOP complet** (Angajare Legală → Lichidare → Ordonanțare → Plată) conform OMF 1140/2025, cu poartă de stări aplicată în baza de date
- **Document de Fundamentare (DF)** și **Ordonanțare de Plată (ORD)** cu workflow P1 → P2 și revizii R0/R1+
- **Buget multianual** — benzi ancorate pe ani absoluți (`an_referinta`), plafonare pe creditele bugetare ale anului de exercițiu
- **Formulare oficiale** (Referat Necesitate, Notă Fundamentare Investiții)
- **Import OPME (F1129)** — auto-confirmarea plăților din fișierele Trezoreriei
- **Registratură** (registru de intrări, read-only) și **Centralizator Clasa 8**
- **Trasabilitate** DF ↔ ALOP ↔ ORD
- **Transmitere internă (repartizare)** către utilizator sau compartiment, cu confirmare de luare la cunoștință
- **Chat intern** (mesagerie între utilizatori + suport platformă)
- **Bulk signing** pentru aprobări în lot
- **Verificare furnizor** (CUI ANAF, IBAN + trezorerii ANAF, coerență date)
- **Trust Report PDF** cu analiză X.509 pe 6 niveluri (L1-L6) + QR code — vezi limitările din secțiunea [Securitate](#securitate)

---

## Stack tehnic

Reconfirmat din `package.json`.

| Componentă | Tehnologie |
|---|---|
| Runtime | Node.js 20 (ES Modules, `.mjs`) |
| Framework | Express 4 (`express`), `helmet`, `compression`, `cors`, `cookie-parser` |
| Bază de date | PostgreSQL (`pg`) |
| Real-time | WebSocket (`ws`) |
| PDF generare/stamp | `pdf-lib` + `@pdf-lib/fontkit` + `@signpdf/signpdf` + `@signpdf/placeholder-pdf-lib` |
| Criptografie X.509 / CMS | `node-forge`, `pkijs`, `asn1js`, `pvutils` |
| **PAdES signing** | **Java Spring Boot microservice + iText** (`SIGNING_SERVICE_URL`) |
| Autentificare | JWT (HttpOnly cookies, `jsonwebtoken`) + 2FA TOTP (`otplib`); parole PBKDF2-SHA256 |
| Upload multipart | `busboy` |
| Email | Resend API (`resend`) |
| WhatsApp | Meta Business API (`fetch`, fără SDK) |
| Notificări push | Web Push / VAPID (`web-push`) |
| Stocare arhivă | Google Drive API (`googleapis`) |
| QR code | `qrcode` |
| XML / XFA | `fast-xml-parser`, `xmllint-wasm` |
| Conversie DOCX/XLSX → PDF | LibreOffice headless (binar extern, `server/utils/convertToPdf.mjs`) |
| Logging | Pino structured |
| Metrics | endpoint Prometheus (`server/middleware/metrics.mjs`) |
| Testing | Vitest + Supertest (nivel mock + nivel Postgres real) |
| Deploy | Railway (Node app + Java sidecar + PostgreSQL managed) |

---

## Structura proiectului

```
server/
  index.mjs                     ← Entry point: Express, WebSocket, joburi background, notify()
  config.mjs                    ← Citire/validare variabile de mediu
  db/
    index.mjs                   ← Pool PostgreSQL + 109 migrații inline (001-109)
    migrate.mjs                 ← Runner pentru migrațiile .sql (V4)
    migrations/*.sql            ← 16 fișiere (000_extensions … 015_formulare_oficiale)
    queries/                    ← Query builders refolosibili (audit, documents, flows)
  middleware/
    auth.mjs                    ← JWT verify, requireAuth dual-mode, PBKDF2
    csrf.mjs / cspNonce.mjs     ← CSRF double-submit, nonce CSP
    session-guard.mjs           ← Invalidare sesiune (token versioning)
    rateLimiter.mjs             ← Rate limiting IN-MEMORY (Map per IP+path)
    uploadGuard.mjs             ← Limite/validare upload
    require-module.mjs          ← Gating pe entitlements de modul
    logger.mjs / metrics.mjs / errorHandler.mjs
  core/
    errors.mjs · hashing.mjs · ids.mjs · pagination.mjs
  routes/
    auth.mjs · totp.mjs · health.mjs · notifications.mjs · templates.mjs · report.mjs
    admin.mjs                   ← Panel admin
    admin/
      organizations.mjs · users.mjs · flows.mjs · analytics.mjs · audit.mjs
      maintenance.mjs · outreach.mjs · entitlements.mjs · _helpers.mjs
    flows/                      ← Modular (index.mjs orchestrează)
      crud.mjs · lifecycle.mjs · signing.mjs · attachments.mjs · email.mjs
      acroform.mjs · signer-status.mjs · transmit.mjs
      cloud-signing.mjs         ← STS Cloud QES (NO-TOUCH)
      bulk-signing.mjs          ← Bulk signing (NO-TOUCH)
    formulare.mjs               ← Generare PDF DF/ORD (pdf-lib + NotoSans)
    formulare/                  ← df.mjs · ord.mjs · shared.mjs · index.mjs · _helpers.mjs
    formulare-oficiale.mjs      ← Referat Necesitate + Notă Fundamentare Investiții
    alop.mjs                    ← Mașina de stări ALOP
    opme.mjs                    ← Import OPME F1129
    registratura.mjs            ← Registru intrări (read-only)
    clasa8.mjs                  ← Centralizator Clasa 8 + buget importat
    trasabilitate.mjs           ← Arbore DF ↔ ALOP ↔ ORD
    chat.mjs                    ← Mesagerie internă + suport platformă
    convert.mjs                 ← Conversie Office → PDF
    supplier-verify.mjs         ← Verificare furnizor (montat la /api/verify)
    verify.mjs                  ← Verificare publică PDF (Trust Report)
  services/
    formular-shared.mjs         ← Lifecycle DF/ORD parametrizat pe formType
    formular-capabilities.mjs · alop-capabilities.mjs   ← Decizii UI server-side
    authz-formular.mjs · authz-scope.mjs · flow-access.mjs · chat-access.mjs
    buget-an.mjs                ← Benzi bugetare pe ani absoluți + credite bugetare col.10
    alop-link.mjs · alop-dosar-sql.mjs · df-dosar-key.mjs · df-aprobat-sql.mjs
    opme-parser.mjs · opme-matcher.mjs
    clasa8.mjs · trasabilitate.mjs · registratura.mjs · ord-blocuri.mjs
    flow-transmit.mjs · flow-completion.mjs · flow-undo.mjs · flow-provenance.mjs
    sign-trust-report.mjs       ← Generare Trust Report PDF + QR
    certificate-verify.mjs      ← Analiză X.509 pe 6 niveluri (L1-L6)
    verify/                     ← CUI ANAF, IBAN, trezorerii ANAF (JSON versionat)
    entitlements.mjs · user-leave.mjs · format-money.mjs · actor-identity.mjs
    formulare-oficiale/ · alop-xml/
  signing/
    SigningProvider.mjs · index.mjs
    pades.mjs · java-pades-client.mjs        ← NO-TOUCH
    providers/
      LocalUploadProvider.mjs   ← Upload local ✅
      STSCloudProvider.mjs      ← STS Cloud QES ✅ (NO-TOUCH)
      CertSignProvider.mjs · TransSpedProvider.mjs
      AlfaTrustProvider.mjs · NamirialProvider.mjs   ← schelete
      CloudProviderBase.mjs
  utils/
    convertToPdf.mjs · pdf-signed-placement.mjs · pdf-content-detect.mjs
    concurrency-gate.mjs · cors-config.mjs
  certs/sts-ca-bundle.pem       ← placeholder: NU conține încă certificate CA
  webhook.mjs · mailer.mjs · whatsapp.mjs · push.mjs · drive.mjs · gws.mjs · verify.mjs

public/                          ← SPA-uri single-file servite static
  login.html · semdoc-initiator.html · semdoc-signer.html · flow.html
  formular.html · admin.html · templates.html · bulk-signer.html
  notifications.html · setari.html · verifica.html · chat.html
  registratura.html · refnec-form.html · notafd-invest-form.html · offline.html
  sw.js                          ← Service Worker (precache + strategii per tip)
  js/
    df-utils.js · df-shell.js · df-subtabs.js · df-entitlements.js
    df-email-modal.js · df-transmit-modal.js · df-user-modals.js
    admin/ · formular/ · flow/ · semdoc-initiator/ · semdoc-signer/
    chat/ · registratura/ · notifications/ · templates/ · setari/
    bulk-signer/ · login/ · verifica/ · common/ · components/ · shared/
  css/df/                        ← Design system (tokens, components, shell, email-modal)

server/tests/
  unit/ · integration/           ← Nivel 1: pool.query mock-uit, fără Postgres
  db/                            ← Nivel 2: Postgres real (sursa de adevăr pt. regresii)
  helpers/ · fixtures/

docs/
  archive/ · audits/ · incidents/ · opme-import.md · PATCH-JAVA-DELEGARE.md
```

---

## Variabile de mediu

Copiază `env.example` în `.env`. Numele de mai jos sunt cele din `env.example` / `server/config.mjs`.

```env
# Bază
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://app.docflowai.ro
CORS_ORIGIN=
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=secret-minim-32-caractere
JWT_EXPIRES=
JWT_REFRESH_GRACE_SEC=

# Bootstrap admin + politici login
ADMIN_SECRET=
ADMIN_INIT_PASSWORD=
LOGIN_MAX=
LOGIN_WINDOW_SEC=
LOGIN_BLOCK_SEC=

# Email (Resend)
RESEND_API_KEY=re_...
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>

# Push notifications (VAPID)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:contact@docflowai.ro

# Opțional — WhatsApp Business
WA_PHONE_NUMBER_ID=...
WA_ACCESS_TOKEN=...
WA_TEMPLATE_SIGN=... / WA_TEMPLATE_COMPLETE=... / WA_TEMPLATE_REFUSED=... / WA_TEMPLATE_LANG=...

# Opțional — Google Drive arhivare
GOOGLE_SERVICE_ACCOUNT_JSON=...
GOOGLE_DRIVE_FOLDER_ID=...

# Opțional — Outreach
OUTREACH_DAILY_LIMIT=... / OUTREACH_FROM=... / OUTREACH_PDF_PATH=... / OUTREACH_GHID_PATH=...

# Java PAdES microservice (citit din server/config.mjs, absent din env.example)
SIGNING_SERVICE_URL=http://localhost:8081
```

---

## Rulare locală

```bash
npm install
cp env.example .env
# Editează .env cu credențialele tale
npm start
```

Migrările DB rulează **automat la startup**, în sistem dual: **109 migrații inline** în `server/db/index.mjs` (prima, într-o singură tranzacție) + **16 fișiere `.sql`** în `server/db/migrations/` (după, per-fișier).

> ⚠️ Regulile pentru migrări noi sunt obligatorii și sunt în `CLAUDE.md` → *Database Migrations*. Migrațiile noi se scriu **exclusiv inline**.

### Teste

Două niveluri (detalii în `CLAUDE.md` → Testing):

```bash
npm test            # Nivel 1 — Vitest unit + integration (pool.query mock-uit, fără Postgres)
npm run db:test:up  # pornește Postgres efemer (Docker) → exportă TEST_DATABASE_URL afișat
npm run test:db     # Nivel 2 — Postgres real: plasă de caracterizare
npm run db:test:down
npm run check       # node --check sintaxă pe fișierele server
```

⚠️ `test:db` *sărit* (fără `TEST_DATABASE_URL`) ≠ *trecut*. Confirmarea autoritară e CI (`push: develop`, serviciu `postgres:16`).

---

## Tipuri de fluxuri

### Tabel generat
DocFlowAI generează PDF-ul cu tabelul de semnături. Footer-ul se aplică la **crearea** fluxului, înainte de orice semnătură, ca să nu invalideze QES-ul ulterior.

### Ancore existente (XFA / AcroForm)
PDF-ul vine cu câmpuri de semnătură predefinite de sisteme externe (ex. Forexebug). DocFlowAI **nu** modifică PDF-ul la creare. Suportat:
- **AcroForm standard** — câmpuri `/Sig` în structura PDF
- **XFA dinamic** — formulare Adobe LiveCycle

Platforma detectează automat câmpurile și le prezintă inițiatorului pentru asociere per semnatar.

### PDF-uri deja semnate la upload
Dacă PDF-ul încărcat conține deja o semnătură, aplicarea footer-ului se **sare intenționat** (un re-save `pdf-lib` ar invalida semnătura). Dreptunghiurile de semnătură se calculează read-only, iar utilizatorul primește un avertisment explicit în interfață.

---

## Module principale

### ALOP — Workflow OMF 1140/2025
Mașină de stări pentru aprobări financiare publice:
- **Angajare Legală** → DF semnat (P1 inițiator + P2 Responsabil CAB)
- **Lichidare** → confirmare conformitate furnizor + documente justificative (factură, PV)
- **Ordonanțare** → ORD semnat (Ordonanțare de Plată)
- **Plată** → nr. OP + sumă efectivă; confirmarea manuală e rezervată compartimentului CAB

Suport pentru **multi-ORD** per ALOP (cicluri arhivate), **revizii DF R0/R1+** și plafonare bugetară.

**Poarta de stări** (`alop_status_guard`, migrarea inline 109) este **activă în mod blocare**: tranzițiile care nu sunt în matrice sunt respinse la nivel de bază de date (`RAISE EXCEPTION`). Matricea trăiește exclusiv în SQL.

### DF / ORD — Workflow P1 → P2 cu revizii
- **P1** (inițiator) completează Secțiunea A
- **P2** (Responsabil CAB) completează Secțiunea B sau **returnează ca neconform** cu motiv
- **R0** = inițială, **R1+** = revizii; atașamentele și capturile părintelui se copiază pe revizie
- Lanțul de revizii se cheie pe **dosarul ALOP**, nu pe numărul de înregistrare (numerele se repetă în producție)
- Generare PDF nativă cu `pdf-lib` + NotoSans (fără XFA)

### Buget multianual
`rows_plati` folosește benzi relative (`ancrt`, `np1`…`np3`, ani precedenți/ulteriori), ancorate la ani absoluți prin `formulare_df.an_referinta`. Plafonarea ordonanțării se face pe **creditele bugetare (col.10)** ale DF-ului legat, minus ordonanțările anterioare din același an de exercițiu.

### Import OPME (F1129)
Import al plăților din fișierele Trezoreriei (PDF XFA), cu matching pe (cod angajament, indicator, CIF beneficiar) **+ IBAN beneficiar** și auto-confirmare a ALOP-urilor aflate în `plata`. Idempotent prin hash de fișier per organizație. Detalii: [`docs/opme-import.md`](docs/opme-import.md).

### Registratură · Clasa 8 · Trasabilitate
- **Registratură** — registru de intrări org-scoped, listă + export CSV (read-only)
- **Clasa 8** — centralizator agregat + buget importat pe versiuni
- **Trasabilitate** — arborele DF ↔ ALOP ↔ ORD, inclusiv ciclurile arhivate

### Transmitere internă (repartizare)
Documentul semnat + atașamentele unui flux pot fi transmise prin aplicație către un **utilizator sau un compartiment** care nu a fost semnatar — automat la finalizare (configurabil la creare) sau manual. Confirmare de luare la cunoștință **per-persoană**, inbox „📥 Primite", trasabilitate în timeline-ul fluxului și în audit.

### Chat intern
Conversații între utilizatorii organizației și canal de suport către platformă, cu istoric paginat.

### Entitlements de module
Catalog de module (`module_catalog`) cu activare per scope (`module_entitlements`), administrat de super-admin și aplicat prin middleware-ul `require-module.mjs`.

### Bulk Signing
Semnare în lot pentru fluxuri multiple cu același semnatar — sesiune unică STS Cloud sau upload local repetat.

### Verificare furnizor
- **CUI** — interogare ANAF live
- **IBAN** — validare structură + cifră de control, cu identificarea trezoreriei din datele oficiale ANAF (`server/services/verify/data/trezorerii-anaf.json`)
- **Coerență** — cross-check denumire furnizor vs CUI

---

## Provideri semnătură electronică calificată

### ✅ Local Upload — Operațional
Semnare cu orice aplicație desktop și orice certificat calificat, urmată de upload al PDF-ului semnat.

### ✅ STS Cloud QES — Implementat (necesită credențiale)
Implementare conform documentației oficiale STS, cu **Java Spring Boot microservice + iText** pentru PAdES:
- Documentul rămâne exclusiv pe server — STS primește doar hash SHA-256 (ByteRange)
- OAuth 2.0 PKCE + 2FA + PIN certificat pe `idp.stsisp.ro`
- Toate câmpurile de semnătură există în revizia 0 a PDF-ului (create de iText); semnarea ulterioară scrie minim, ca incremental update, ca să nu invalideze semnăturile anterioare

**Configurare:** Admin → Organizații → ⚙ Config → activează STS → generează pereche de chei RSA → trimite cheia publică la STS → completează `clientId`, `kid`, `redirectUri`.

### ⏳ certSIGN / Trans Sped / AlfaTrust / Namirial — În dezvoltare
Doar schelete arhitecturale. Marcate `stub: true` în UI admin, cu checkbox dezactivat, ca să nu poată fi activate accidental în producție.

---

## Arhitectură multi-tenant

- Fiecare **organizație** are propria configurație de provideri de semnătură (`signing_providers_enabled`)
- **Semnatarul alege** providerul la semnare dintre cei activi în organizație
- **Upload local** rămâne întotdeauna disponibil ca fallback
- Izolare cross-tenant impusă la nivel de query (coloana `org_id`, nu câmp JSONB)
- Roluri: `admin` (super-admin platformă), `org_admin` (instituție), `user`

---

## Securitate

- JWT în cookie HttpOnly (niciodată `localStorage`)
- Token versioning — invalidare la reset parolă (`session-guard.mjs`)
- 2FA TOTP (`otplib`)
- Parole PBKDF2-SHA256 (100k iterații)
- CSRF double-submit cookie (`X-CSRF-Token` + cookie)
- CSP cu nonce + Helmet
- Rate limiting **in-memory** (Map per IP+path — nu supraviețuiește restarturilor)
- Izolare cross-tenant pe `org_id`
- Audit log complet (`audit_log` + `audit_events`), soft-delete cu păstrarea urmei
- HMAC-SHA256 pentru webhook-uri
- Acces la documentele unui flux (PDF semnat, atașamente) restricționat la nivel de obiect — inițiator/semnatar/admin same-org/destinatar repartizat
- Trimiterea externă de email restricționată la aceeași barieră de autorizare
- Identitatea „Întocmit" nu poate fi impersonată — derivată server-side din actorul autentificat, indiferent ce trimite clientul
- Poarta de stări ALOP în **mod blocare** la nivel de bază de date (migrarea 109): o tranziție nelegală abortează tranzacția
- Service Worker: rutele autentificate (`/api/`, `/auth/`, `/flows/`, `/admin/`) sunt **network-only** — nu ajung niciodată în Cache Storage

### ⚠️ Limitările Trust Report-ului

Raportul evaluează șase niveluri: **L1** integritate document · **L2** semnătură CMS/PKCS#7 · **L3** certificat semnatar · **L4** lanț de certificare · **L5** validitate la semnare (OCSP/CRL) · **L6** conformitate QES/eIDAS.

Ce **nu** face, în starea actuală a codului:

- **Validarea lanțului până la o ancoră de încredere nu este activă.** `server/certs/sts-ca-bundle.pem` nu conține niciun certificat CA, iar verificarea CMS rulează cu `checkChain: false`. L4 raportează câte certificate au fost găsite în lanț (posibil *inferate* din câmpul `issuer`), nu că lanțul a fost validat criptografic față de o Listă de Încredere.
- **Calificarea (L6) este o constatare pe metadate**, derivată din recunoașterea emitentului după denumire și/sau prezența extensiei `QcStatements` — nu o verificare în Trusted List.
- **L5 (revocare)** se interoghează live prin OCSP doar când certificatul publică un URL OCSP; altfel rămâne neconcludent.

Prin urmare raportul **constată**, nu **certifică**, iar textul livrat utilizatorilor este formulat corespunzător. Nu substituie o verificare la un prestator de servicii de încredere calificat.

---

## Schema DB

Sistem dual de migrări la startup:
1. **109 migrații inline** în `server/db/index.mjs` (sistemul principal; migrațiile noi merg **doar** aici)
2. **16 fișiere `.sql`** în `server/db/migrations/` (`000_extensions` … `015_formulare_oficiale`), rulate după inline

Ambele sunt idempotente (`IF NOT EXISTS`).

> Reguli stricte pentru migrări noi în `CLAUDE.md`. Postmortem incident DB init: [`docs/incidents/2026-04-19-db-init-failure.md`](docs/incidents/2026-04-19-db-init-failure.md). Incident numere DF duplicate: [`docs/incidents/DF-NR-DUPLICAT.md`](docs/incidents/DF-NR-DUPLICAT.md).

### Tabele

Extrase din migrări (inline + `.sql`):

| Domeniu | Tabele |
|---|---|
| Tenancy & utilizatori | `organizations`, `users`, `delegations`, `login_blocks` |
| Fluxuri | `flows`, `flow_signers`, `flow_signatures`, `flow_attachments`, `flows_pdfs`, `document_revisions` |
| Repartizare | `flow_recipients`, `flow_recipient_acks` |
| Semnare & verificare | `bulk_signing_sessions`, `signature_sessions`, `signature_certificates`, `certificate_records`, `trust_reports` |
| Formulare DF/ORD | `formulare_df`, `formulare_ord`, `formulare_capturi`, `formulare_atasamente`, `formulare_audit`, `formulare_oficiale`, `beneficiari` |
| Motor de formulare | `form_templates`, `form_versions`, `form_instances`, `formular_attachments` |
| ALOP | `alop_instances`, `alop_sabloane`, `alop_ord_cicluri`, `alop_status_log` |
| OPME | `opme_imports`, `opme_lines` |
| Buget | `clasa8_buget`, `clasa8_buget_versions` |
| Registratură | `registru_intrari`, `registru_serii`, `registru_atasamente` |
| Chat | `conversations`, `conversation_participants`, `messages` |
| Notificări | `notifications`, `inapp_notifications`, `notification_events`, `push_subscriptions` |
| Entitlements | `module_catalog`, `module_entitlements` |
| Audit & politici | `audit_log`, `audit_events`, `policy_rules` |
| Outreach | `outreach_campaigns`, `outreach_recipients`, `outreach_primarii` |
| Diverse | `archive_jobs`, `templates`, `schema_migrations` |

---

## Integrare AvanDoc / webhook-uri

Configurează `webhook_url` per organizație. La finalizare flux, DocFlowAI trimite `POST` cu payload semnat HMAC-SHA256.

Evenimente: `flow.completed`, `flow.refused`, `flow.cancelled`, `flow.signed_step`.

---

## Deployment

### Producție: Railway
- **App principal**: Node.js (acest repo)
- **Java PAdES microservice**: serviciu Railway separat (Spring Boot + iText)
- **PostgreSQL**: Railway managed
- **Domeniu**: `app.docflowai.ro`

### Staging
- `docflowai-app-staging.up.railway.app` (auto-deploy din `develop`)

### Branch strategy
- `main` = **producție**. Deploy-ul este **manual**, gestionat de owner, după procedura din `CLAUDE.md` (staging sănătos 24h, teste verzi, backup `pg_dump`, merge `--no-ff`, monitorizare post-deploy).
- `develop` = staging (auto-deploy la push)
- Feature branches de tip `v4.1-*` pentru schimbări mari (`v4.1-alop-ui`, `v4.1-backend-core`, `v4-enterprise`)

### Cache busting
La modificarea unui asset din `public/`: bump `version` în `package.json` **și** `?v=` **țintit pe asset-ul schimbat** (valorile `?v=` driftează între fișiere — citește-le cu `grep`, nu le deduce). Dacă asset-ul e în `PRECACHE_ASSETS` din `public/sw.js`, bump și `CACHE_VERSION`.

---

## Istoric

Etape majore, documentate în `docs/`:

- **v3.9.422 → v3.9.426** — audit pre-producție cu eliminarea a ~7.000 de linii de cod mort (servicii moarte, sistemul v4 nefolosit, consolidarea loader-elor)
- **v3.9.543 → v3.9.546** — consolidare anti-regresie: lifecycle DF/ORD unificat în `services/formular-shared.mjs` parametrizat pe `formType`, split `routes/formulare/`, plasă de teste de caracterizare pe Postgres real
- **v3.9.554 → v3.9.585** — linking DF↔ALOP cu self-heal, buget multianual ancorat pe ani absoluți, plafonare pe credite bugetare
- **v3.9.601 → v3.9.610** — transmitere internă (repartizare) către utilizator sau compartiment, cu confirmare per-persoană
- **v3.9.793 → v3.9.796** — poarta de stări ALOP trecută din observare în **blocare** (migrarea 109), după 29 de zile de observare fără violări noi

Prompturile și rapoartele de audit istorice sunt în `docs/archive/` și `docs/audits/` — sunt datate și **nu se rescriu retroactiv**.

---

## Licență

Proprietar — DocFlowAI © 2026. Toate drepturile rezervate.
