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

## Reguli de lucru

După ORICE implementare completă și după ce testele trec:
1. `git add .`
2. `git commit -m "descriere"`
3. `git push origin develop`

**O sarcină nu este considerată terminată fără `git push`.**

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

### PDF-uri pre-semnate la upload (din v3.9.552)
Dacă PDF-ul încărcat **conține deja o semnătură QES** (`pdfLooksSigned` → `/ByteRange`),
`stampFooterOnPdf` se sare **intenționat** (guard `preventRewriteIfSigned`) — un re-save pdf-lib ar
invalida semnătura existentă. Deci **fără footer, fără cartuș desenat**, by design.

În schimb, `padesRect` per semnatar se calculează **read-only** prin
`computeSignerRectsReadOnly(pdfB64, signers, PDFLib)` din `server/utils/pdf-signed-placement.mjs`:
PDF-ul NU se salvează niciodată, rect-urile se plasează în spațiul liber de pe **ultima pagină**
(bottom → gap → forced), `page` 1-based. `crud.mjs` + `lifecycle.mjs` (ambele call-site-uri reinitiate)
iau decizia **explicit la call-site** și setează `data.preSignedUpload = true` + eveniment
`PRESIGNED_UPLOAD_DETECTED`; răspunsul `POST /flows` întoarce `preSignedUpload` pentru bannerul din
inițiator.

**UX avertizare (din v3.9.553):** avertismentul nu depinde de niciun timer. Apare în trei locuri:
(1) **la selectarea fișierului** — `clientPdfLooksSigned` în `public/js/semdoc-initiator/main.js`,
REPLICĂ manual-sincronizată a euristicii `pdfLooksSigned` server-side (schimbi una, schimbi ambele);
(2) **după POST /flows** — când `preSignedUpload:true`, fără redirect automat: banner persistent +
buton manual „Am înțeles — continuă..." (PDF normal păstrează redirect-ul pe timer 900ms);
(3) **pe semdoc-signer** — banner informativ deasupra zonei de semnare, citit din `preSignedUpload`
expus de `GET /flows/:flowId` (flag-ul trece prin `stripSensitive` ca parte din `...rest` — test în
`presigned-upload.test.mjs`).

⚠️ Fallback-ul de coordonate hardcodate din `cloud-signing.mjs` (NO-TOUCH) trebuie să rămână **cod mort** —
`padesRect` e garantat populat acum. **Orice path nou care creează fluxuri TREBUIE să populeze `padesRect`**
(stampFooterOnPdf pentru PDF nesemnat, computeSignerRectsReadOnly pentru cel semnat). Geometria celulelor
e **sincronizată manual** între `stampFooterOnPdf` și `computeSignerRectsReadOnly` — schimbi una, schimbi
ambele.

---

## Multi-tenancy

Fiecare `organization` configurează ce provideri de semnare sunt activi (`signing_providers_enabled` JSONB array, GIN indexed). Utilizatorii aparțin organizațiilor via `org_id`. **Toate** query-urile flows/users includ izolare `org_id`.

**Roluri utilizatori:**
- `admin` — super-admin, vede totul
- `org_admin` — administrator instituție, vede doar org-ul propriu
- `user` — utilizator normal

**Pattern important:** `org_id` este disponibil direct din JWT payload (`actor.orgId`). Nu face `SELECT org_id FROM users WHERE email=...` dacă `actor.orgId` este disponibil — este un query redundant.

---

## Pattern: requireAuth dual-mode (since v3.9.442)

`server/middleware/auth.mjs` exportă `requireAuth` care funcționează în 2 moduri:

- **Helper mode** (2 args: `(req, res)`) — returnează payload-ul JWT direct, sau trimite 401 și returnează null.
  Folosit în routere vechi cu pattern: `const actor = requireAuth(req, res); if (!actor) return;`

- **Middleware mode** (3 args: `(req, res, next)`) — setează `req.actor` și apelează `next()`.
  Folosit în routere noi cu pattern: `router.post('/x', requireAuth, csrfMiddleware, handler)`

⚠️ Când adaugi un router nou, alege UN pattern și fii consistent în tot fișierul. NU amesteca.

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

### CSS: scoping & componente globale (din v3.9.551)

CSS-ul NU e scopat per component — într-o pagină fără Shadow DOM, fiecare stylesheet se aplică
*fiecărui* element din document, inclusiv componentelor injectate în `<body>` la runtime (modaluri,
toast-uri, widget-uri globale).

**Regula 1 — CSS de pagină = selectori scopați la wrapper-ul paginii, NICIODATĂ pe element gol.**
Un `input{width:100%}` sau `label{display:block}` într-un CSS de pagină (ex. `semdoc-initiator.css`)
se scurge în orice component global injectat în body și îi rupe stilul. Scopează la wrapper-ul de
conținut: `.df-shell input{…}`. Componentele se atașează în `<body>` ca frate al `.df-shell`, deci
rămân în afara razei.

**Regula 2 — componentele globale își declară DEFENSIV toate proprietățile (auto-conținere).**
Un component montat în body (ex. `df-email-modal`) NU se bazează pe igiena CSS a paginii-gazdă:
declară explicit width/display/etc. pe propriile clase, scopate sub rădăcina lui (`.dfem-overlay`),
cu specificitate suficientă cât să bată selectorii pe element gol ai paginii (și `!important`-ul lor,
dacă există). O proprietate nedeclarată = un gol pe care pagina-gazdă îl umple cu regulile ei generice.

**Stratul dublu e INTENȚIONAT, nu redundanță:** pagină scopată (Regula 1) + component auto-conținut
(Regula 2). Fiecare acoperă ce ratează celălalt; împreună fac montarea unui component pe orice pagină
sigură. NU „curăța" defensiva unui component pe motiv că pagina a fost scopată.

Incident de referință: modalul de email apărea rupt pe `semdoc-initiator.html` (dar corect pe
`flow.html`) fiindcă `semdoc-initiator.css` avea `input{width:100%}` + `input,select,textarea{…!important}`
pe element gol. Fix: defensivă în `email-modal.css` (v3.9.549) + scoping la `.df-shell` în
`semdoc-initiator.css` (v3.9.550).

---

## Java Signing Service (Spring Boot)

Microserviciu separat pentru operații PAdES iText. Configurat via `SIGNING_SERVICE_URL`.

**Endpoints folosite:**
- `POST /api/pades/create-fields` — creează câmpuri AcroForm `/Sig` cu iText
- `POST /api/pades/prepare` — pregătește PDF cu placeholder ByteRange
- `POST /api/pades/finalize` — injectează CMS DER în placeholder

**Important:** Apelurile `fetch()` către Java service nu au timeout explicit — în caz de hung service, conexiunile Node.js rămân blocate.

---

## OPME (F1129) Import

Modul de import plăți OPME din fișiere F1129 ale Trezoreriei (PDF XFA). Permite auto-confirmare ALOP-uri aflate în status `plata`.

**Schema:**
- `opme_imports` — header import (nr_document, data_op, file_hash UNIQUE per org)
- `opme_lines` — rânduri OP cu match_status (pending/auto/manual/ambiguous/unmatched/partial)
- `plata_source` pe `alop_instances` + `alop_ord_cicluri` — 'opme_auto' | 'manual'
- Migrări: 072 (opme_imports/opme_lines) + 073 (coloane opme pe alop_instances)

**Rute** (`server/routes/opme.mjs`):
| Metodă | Path | Rol |
|--------|------|-----|
| POST | `/api/opme/import` | P2/admin — upload + auto-match |
| GET | `/api/opme/imports` | auth — listă paginabilă |
| GET | `/api/opme/imports/:id` | auth — detaliu + linii |
| GET | `/api/opme/imports/:id/export.csv` | P2/admin — CSV audit |
| POST | `/api/opme/imports/:id/rematch` | P2/admin — re-rulează matcher |
| POST | `/api/opme/rematch-all` | admin — re-match la nivel org |
| GET | `/api/opme/lines/by-alop/:alopId` | auth — linii per ALOP |
| GET | `/api/me/can-import-opme` | auth — gating server-driven (`{ can: bool }`) |

**Servicii:**
- `server/services/opme-parser.mjs` — extrage XFA din PDF → header + lines
- `server/services/opme-matcher.mjs` — matching pe triplet (cod_angajament, indicator_angajament, cif_beneficiar), auto-confirm la sumă egală

**Matching:** Per linie OPME, caută ALOP cu ORD al cărui cif_beneficiar și (cod, indicator) din rows matchează. Suma liniilor OPME grupate pe ALOP se compară cu suma ORD: egală → auto-confirm, parțială → pending, mai mulți candidați → ambiguous.

**Audit:** `audit_log.event_type = 'plata_auto_opme'` cu payload JSON (alop_id, line_ids, suma, triplet).

**Absorbție retro:** `tryAutoConfirmAlop(alopId)` — apelat la tranziții ALOP către `plata`, absoarbe linii OPME deja încărcate.

**UI:** `opme-import-modal.js` (upload), `opme-report-drawer.js` (raport linii), `alop.js` (badge Auto + lista OP).

**Format nou trezorerie:** Creează parser în services/, respectă interfața `{ header, lines, raw_meta }`, înregistrează în `opme.mjs`. Matcher-ul funcționează identic.

Documentație completă: `docs/opme-import.md`.

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

## Testing — două niveluri

**Nivel 1 — Mock (rapid, default): `npm test`**
- ~758 teste (62 fișiere) în `server/tests/**` + `server/services/**/__tests__/**`.
- `pool.query` este **mock-uit** (`vi.mock('../../db/index.mjs')`) — rulează **fără** Postgres.
  ATENȚIE: testele NU lovesc o DB reală; afirmația veche „contra unei baze de date reale" era greșită.
- Pattern poziţional (`mockResolvedValueOnce` în secvență) → cuplat de implementare, fragil la refactor SQL.
- PBKDF2 (~200ms) → timeout 15s în `vitest.config.mjs`. Coverage exclude: Drive, GWS, WhatsApp, Web Push.

**Nivel 2 — Postgres real (plasă de siguranță): `npm run test:db`**
- `server/tests/db/**` (config separat `vitest.config.db.mjs`, `fileParallelism:false`).
- Rulează routerele REALE peste un Postgres efemer; `db/index.mjs` NU e mock-uit.
- Verifică **rezultatul** (status code + starea din DB), nu ordinea apelurilor → sigur la refactor.
- Local: `npm run db:test:up` (Docker) → exportă `TEST_DATABASE_URL` afișat → `npm run test:db` → `npm run db:test:down`.
- Fără `TEST_DATABASE_URL` se auto-skip (exit 0) — de aceea `npm test` rămâne verde și fără DB.
- ⚠️ **Skipped ≠ passed.** Un raport local „test:db verde" cu teste *sărite* (fără Docker) NU e dovadă —
  doar testele *passed* contează. Lecție din practică (mai 2026): un test scris greșit a trecut „verde"
  prin skip două commit-uri la rând, apoi a picat la primul push în CI. Confirmă DB-tests prin CI
  (push pe `develop`) sau local cu Docker — niciodată prin skip.
- CI rulează ambele (serviciu `postgres:16` în GitHub Actions) și pe `push: develop`.

**Baseline teste — crește în timp** (≈800 la mai/2026; era 758 la Etapa 1). Confirmă prin `npm test`
că e **verde, fără regresii** — NU hardcoda un număr în prompturi (suita crește) și NU folosi `grep it(`
(ratează al doilea pattern din `vitest.config.mjs` + testele generate în buclă). Plus `npm run test:db`
verde (în CI sau cu Docker).

**Înainte de orice modificare:** rulează `npm test` (și `npm run test:db` dacă atingi formulare/ALOP/DB).
Nu livra cod cu teste care pică. Pentru rute de formulare/ALOP (liste, ștergere, cancel, revizii),
adaugă întâi un test de caracterizare în `server/tests/db/**` care captează comportamentul curent,
APOI refactorizează — testele DB sunt sursa de adevăr pentru regresii.

---

## Consolidare DF/ORD & asimetrii (anti-regresie) (din v3.9.544)

Lifecycle-ul DF/ORD e consolidat într-un singur service parametrizat pe `formType`, NU duplicat:

- `server/services/formular-shared.mjs` → `FORMULAR_TYPES` (config per tip) + funcții lifecycle
  (`submitFormular`/`completeFormular`/`returnFormular`/`linkFlowFormular`/`stergeFormular`), contract
  `{ status, body }`. Rutele din `server/routes/formulare/{df,ord}.mjs` sunt wrappers subțiri.

**Regula de aur:** orice diferență DF↔ORD trăiește ca o CHEIE EXPLICITĂ în `FORMULAR_TYPES`, niciodată ca
`if (ft === 'ord')` îngropat într-un handler. O asimetrie tăcută într-un handler duplicat e vectorul #1 de
regresie (fix pe DF uitat pe ORD; sau uniformizare care șterge o regulă intenționată).

Asimetrii intenționate DEJA cimentate (test în `server/tests/db/caracterizare-*`) — **NU le uniformiza**:
- `submitStatuses` — DF acceptă `de_revizuit`, ORD nu.
- `budgetCheck` — ORD hard `422 receptii_neplatite_negative` (col.5 ≥ 0); DF `none` (buget = soft-warning
  DOAR în frontend, by design).
- `alopOnComplete` — DF complete avansează ALOP `draft→angajare` + audit `legat_alop`; ORD nu atinge ALOP
  la complete.
- `linkFlow*` — DF setează `status='transmis_flux'`; ORD doar `flow_id`. ⚠️ ORD link-flow folosește o
  proiecție îngustă de coloane — `canEditFormular` citește `doc.assigned_to` pe ramura `p2_comp`, deci ce
  coloane încarci AFECTEAZĂ autorizarea. NU lărgi `SELECT`-ul fără să verifici impactul de authz.
- `relinkOnDelete` — DF conștient de revizii (R0 eliberează / R1+ restore parent aprobat); ORD simplu.

**Workflow obligatoriu când atingi formulare/ALOP:**
1. **Caracterizează întâi.** Dacă zona n-are test de caracterizare DB, adaugă-l în `server/tests/db/**`
   (status code + stare DB curentă) ÎNAINTE de orice schimbare. Vezi secțiunea Testing.
2. **Consolidează ce atingi.** Dacă lovești o pereche DF/ORD încă duplicată (ex. `/api/formulare/list`,
   create/PUT), pliază diferențele în config + funcție shared — nu adăuga o a treia copie.
3. **Asimetrie nouă = cheie nouă de config + test + comentariu „NU uniformiza".** Niciodată un `if` mut.

**Split de fișiere = MUTARE verbatim, nu rescriere.** Modelul e `routes/flows/` (orchestrator `index.mjs`
+ submodule). Capcană: Express potrivește în ordinea înregistrării — rutele statice (`/aprobate`) TREBUIE
înregistrate ÎNAINTEA celor cu param (`/:id`), altfel `:id` le prinde. Un test anti-shadowing în
`server/tests/db/` dovedește asta.

**Stare caracterizată la nivel DB (plasă activă):** formulare DF/ORD
(submit/complete/returneaza/revizuieste/sterge), ALOP (progresie stări, lazy-resync GET, ciclu multi-ORD,
gărzi tranziție), capabilities, zombie-flow, cancel. **Încă pe mock (fără plasă DB — caracterizează
înainte să atingi):** flows lifecycle, signing, entitlements, registratură, OPME.

---

## Linking DF↔ALOP & authz atașamente (din v3.9.554)

**Proveniență persistentă:** DF/ORD create din context ALOP poartă `source_alop_id` (migrarea 084;
frontend-ul îl trimite din `window._alopContext.alopId`, backend-ul îl persistă DOAR la INSERT;
revizia îl copiază din părinte). **Self-heal la aprobare:** `server/services/alop-link.mjs` →
`selfHealAlopDfLink(pool, flowId)`, apelat din `signing.mjs` (allDone) + `crud.mjs` (edge-case flux
deja completed) — re-leagă ALOP-ul dacă `df_id` e NULL (refuz R0, link-df eșuat silențios) sau
pointează la o revizie veche din același `nr_unic_inreg`. Erorile de link-df/link-ord sunt vizibile
în UI (setS în `alop.js`, banner în `semdoc-initiator/main.js`) — nu doar `console.warn`.

🔒 **INVARIANT — NU modifica:** relink-ul de revizie (`df.mjs` /revizuieste) și self-heal-ul se
aplică **INTENȚIONAT și ALOP-urilor `completed`** (doar `cancelled_at IS NULL` exclude) — e
mecanismul care permite: ALOP finalizat → revizuire DF (valoare mărită) → `noua-lichidare`
recalculează `ramas` pe valoarea reviziei noi → ciclu nou. NU adăuga filtre `completed_at IS NULL`
pe aceste query-uri. Test: `server/tests/db/alop-df-relink-selfheal.test.mjs`.

**Revizii — atașamente/capturi (din v3.9.555):** `/revizuieste` copiază în aceeași tranzacție
rândurile `formulare_atasamente` (nedeleted) și `formulare_capturi` ale părintelui pe noua revizie
(`form_id` nou, `uploaded_by`/`created_at` originale păstrate) — fără asta R1 pornea fără anexele
R0. Test: `server/tests/db/revizie-df-copiere-atasamente.test.mjs`.

**Authz atașamente/capturi:** rutele `formulare-atasamente` + `formulare-capturi` (`shared.mjs`)
folosesc **exclusiv** `authz-formular.mjs` (`canEditFormular` upload/delete, `canViewFormular`
listă/download) — include drepturile prin compartiment (comp/p2_comp), pe care verificarea veche
creator/assigned/admin le refuza cu 403. Test prin lanțul real de middleware (json adaptiv + CSRF
real): `server/tests/db/formulare-atasamente-authz.test.mjs`.

**Buget an curent (din v3.9.556):** cardul ALOP expune `df_buget_an_curent` =
`SUM(formulare_df.rows_plati[].plati_estim_ancrt)` al DF-ului activ (`alop.df_id`), alături de
`df_valoare` = angajamentul total (`SUM(rows_val[].valt_actualiz)`) — doar afișare, fără validare
nouă (validarea hard pe bugetul anului curent vine separat). Test:
`server/tests/db/alop-buget-an-curent.test.mjs`.

**Ordonanțare plafonată hard pe bugetul anului curent (din v3.9.557, FIX B):** ordonanțarea/plata
se poate face DOAR în limita bugetului anului curent = `SUM(formulare_df.rows_plati[].plati_estim_ancrt)`
al DF-ului legat (`ord.df_id` / `alop.df_id`, revizia activă), NU în limita angajamentului total
multianual (`rows_val.valt_actualiz`). Două puncte de control:
(1) **la finalizarea ORD** (`formular-shared.mjs` → `validateOrdBugetAnCurent`, gated de
`budgetCheck==='hard_col5'`): col.5 ≥ 0 rămâne validare SEPARATĂ și rulează ÎNAINTE; apoi, dacă
`suma_ordonanțată_cumulată_an_curent > buget + 0.001` → `422 buget_an_curent_depasit`. Cumulul =
suma rândurilor noi ORD (`data.rows`) + plățile ciclurilor arhivate (`alop_ord_cicluri.plata_suma_efectiva`)
ale ALOP-ului legat de același DF — REFOLOSEȘTE logica `total_ord_valoare` din `alop.mjs` (fără dublă
numărare). Skip dacă ORD-ul nu are `df_id`.
(2) **la `noua-lichidare`** (`alop.mjs`): `ramas = bugetAnCurent − sumaPlata` (înainte: `dfVal` =
`SUM(valt_actualiz)`); `limita_depasita` când bugetul an curent e epuizat chiar dacă angajamentul total
mai are loc. După revizie de DF care mărește `plati_estim_ancrt`, `alop.df_id` relegat → ramas crește →
ciclu nou posibil (invariant relink v3.9.554). Modelare „an curent" = mono-an (toate ciclurile active
ale DF-ului). Teste: `server/tests/db/ord-buget-an-curent-plafon.test.mjs` +
`server/tests/db/alop-noua-lichidare-ciclu.test.mjs`.

---

## Buget multi-anual — an_referinta ancorează benzile la ani absoluți (din v3.9.558)

FIX B (v3.9.557) trata `rows_plati` ca **mono-an** — plafonul fix pe `plati_estim_ancrt`. Corect pentru
2026, dar `rows_plati` are benzi **RELATIVE** (`ancrt`/`np1`/`np2`/`np3`/`ani_precedenti`/`ani_ulter`) și
nicăieri nu se stoca CARE an absolut e „ancrt". La 1 ian. 2027 plafonul ar fi trebuit să devină `np1`.

**Ancorare:** `formulare_df.an_referinta` (INTEGER, migrarea **085**) = anul absolut al benzii `ancrt`;
`np1`→`+1`, … `ani_ulter`→`>+3`. „Anul de exercițiu" pentru plafon = `EXTRACT(YEAR FROM NOW())`
(fără setting per-org în iterația 1 — documentat). La **creare** se setează din body sau default anul
curent; la **revizie** se moștenește din părinte (copiat în INSERT-ul `/revizuieste`, NU re-trimis din
frontend) — o suplimentare în 2026 rămâne ancorată pe 2026. DF legacy (pre-085) = `an_referinta` NULL,
**fără backfill**.

**Helper central PUR:** `server/services/buget-an.mjs` → `bugetPentruAnul(rowsPlati, anReferinta,
anExercitiu)` mapează `offset = anExercitiu − anReferinta` la banda corectă și întoarce `SUM`-ul peste
rânduri. `anReferinta` NULL → `null` („nedeclarat"). Acoperit de `server/tests/unit/buget-an.test.mjs`.

**Decizia owner pentru DF legacy (an_referinta NULL):** **block mono-an pe `ancrt`** (identic FIX B) —
apelanții coalescează `anReferinta ← anExercitiu` ⇒ offset 0 ⇒ banda `ancrt`, deci plafonul 422 rămâne
activ. (NU skip+warn.)

**Cumul PER an de exercițiu (migrarea 086):** `alop_ord_cicluri.an_exercitiu` (INTEGER) marchează anul
plății arhivate; populat la `noua-lichidare` din anul `plata_data` (fallback anul curent). Cumulul de
ordonanțări filtrează ciclurile pe anul de exercițiu: `COALESCE(an_exercitiu,
YEAR(plata_data), YEAR(created_at)) = an_exercitiu_curent` — o plată din 2026 NU consumă bugetul 2027.

**Trei puncte de control** (toate prin helper / fragment SQL sincronizat):
(1) **plafon ORD** (`formular-shared.mjs` → `validateOrdBugetAnCurent`): banda anului de exercițiu +
cumul filtrat pe an; 422 `buget_an_curent_depasit` (body include `anExercitiu`).
(2) **noua-lichidare** (`alop.mjs`): `ramas = bugetPentruAnul(...) − sumaPlatitaInAnulExercitiului`.
(3) **card ALOP** (FIX A, list+detail): `df_buget_an_curent` via fragmentul SQL `sqlBugetAnExercitiu`.

⚠️ **Geometria benzii e SINCRONIZATĂ MANUAL** între `bandaPentruOffset()` (JS, buget-an.mjs) și
`sqlBugetAnExercitiu()` (SQL, alop.mjs) — schimbi mapping-ul într-una, schimbi-l în ambele.

**Frontend:** câmp `an_referinta` (`n-anref`) în formularul DF — default anul curent la creare, read-only
la revizie; etichetele coloanelor `rows_plati` afișează anii absoluți (`anrefSync()`); cardul ALOP arată
„Buget exercițiu <an>"; eroarea 422 menționează anul. Teste:
`server/tests/db/buget-multianual-an-referinta.test.mjs` (offset 0/1/−1, cumul per an, legacy block,
revizie moștenește, default la creare).

**Cardurile ALOP — buget exercițiu = cifră dominantă (var. B, frontend `alop.js`):** cardul „VALOARE DF"
afișează `df_buget_an_curent` ca cifră MARE („Buget exercițiu <an curent>"), cu `df_valoare` (angajament
total) pe linia secundară; header-ul adaugă „buget ex. <an>" lângă „estimat"/„DF actual". Fallback la
`df_valoare` („Angajament total DF" + „(exercițiu nedefinit)") când `df_an_referinta` e null (DF legacy/
neancorat). ⚠️ Distinge null de 0: DF ancorat cu buget 0 (plăți doar în N+1) afișează „0,00 RON" via
`fmtRON` — NU `fmtV`, care întoarce „—" pe 0. Anul afișat = exercițiul curent; `an_referinta` e doar
gate-ul ancorării.

---

## Capabilities — sursă unică pentru deciziile de UI (din v3.9.522)

Logica „ce acțiuni/butoane sunt disponibile pe un document" se calculează **server-side**, ca să nu
existe divergență server↔frontend. Frontend-ul DOAR randează din `capabilities`.

- `server/services/formular-capabilities.mjs` → `computeDocCapabilities(doc, actor, ft)` (DF/ORD).
  Atașat pe `document.capabilities` la GET detaliu ȘI pe toate răspunsurile de mutație
  (create/PUT/submit/complete/returneaza) din `server/routes/formulare/{df,ord}.mjs`.
- `server/services/alop-capabilities.mjs` → `computeAlopCapabilities(alop, actor)` (ALOP):
  `df_action`/`phase_action` (enum), `can_revise_df`/`can_delete`/`can_refresh`/`can_start_noua_ordonantare`.
  Atașat pe GET detaliu `/api/alop/:id` + `can_delete` pe lista `/api/alop`.

Frontend: `doc.js` → `renderActions`, `alop.js` → `renderAlopDetail`, `list.js` → `can_delete`.
Caps decid CE butoane apar; `status`×`rol` aleg DOAR eticheta (prezentare: „Trimite"/„Retrimite",
„Câmpuri"/„Resetează"). Singura decizie client legitimă rămasă e `hasPdf` la DF completed&p1
(Generează PDF vs Lansează flux) — stare locală, nu există pe server.

**Regula:** NU reintroduce decizii status×rol în frontend. Pentru un buton nou condiționat, adaugă un
flag în funcția de capabilities (server) + un test, apoi randează din el. Funcțiile sunt PURE și
acoperite de teste unit + caracterizare DB (`server/tests/db/*capabilities*`,
`server/tests/unit/alop-capabilities.test.mjs`). „Hint de afișare, NU autorizare" — mutațiile rămân
păzite independent pe rutele server (ex. ștergerea fluxurilor e `admin`-only pe backend, indiferent de UI).

**Prospețime caps:** DF/ORD fac update optimist local în `doc.js` → caps trebuie reîmprospătate din
`j.document.capabilities` după FIECARE mutație (de aceea caps e atașat și pe răspunsurile de mutație, nu
doar pe GET). ALOP re-fetch-uiește via `openAlop()` după orice acțiune → caps mereu proaspăt din GET detaliu.

---

**Preview atașamente (din v3.9.574):** modal unic `window.openAttPreview` (self-contained,
`public/js/shared/att-preview.js`), folosit pe DF/ORD (`formular.html`) ȘI semnare/flux
(`semdoc-signer.html`) — fără pagină nouă (`window.open`); creează markup-ul modalului dacă pagina
nu îl are deja static, reutilizând `.df-modal`/`.df-modal-bg` din `public/css/df/components.css`.

---

**Lock atașare/captură SPA (din v3.9.575):** `lockCaptureAndAttachments(ft,false)` trebuie resetat
explicit în `newDoc`/`loadDoc` (`public/js/formular/doc.js`), oglindind `lockAll(ft,false)` și ÎNAINTE
de ramurile condiționale care reaplică `lock=true` — altfel `disabled` rămas de la un document
`completed`/`aprobat` anterior persistă în SPA și blochează atașarea pe documentul următor din aceeași
sesiune.

---

## Cache busting — când modifici JS/CSS

Două niveluri de cache există:

1. **Browser cache** → `?v=VERSION` pe link-urile CSS/JS din HTML. Bump-ează `version` în `package.json`
   ȘI bump-ează `?v=` DOAR pe asset-urile schimbate.
   ⚠️ **`?v=` driftează** față de `package.json`: la commit-uri backend-only NU rulezi `sed`, deci `?v=`
   rămâne în urmă (văzut: `df-shell.js` la `518` în 11 fișiere și `524` în unul, cu `package.json` la `528`).
   NU presupune `OLD` din `package.json` — bump **țintit pe numele asset-ului**, independent de valoarea curentă:
   `sed -i -E "s#(nume-asset\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html` (uniformizează și drift-ul existent).
   Citește `?v=` curent din HTML (`grep`), nu-l deduce din versiune.

2. **Service Worker** (`sw.js`) → cache-uiește agresiv assets în `PRECACHE_ASSETS`. Când modifici un fișier din acea listă (`notif-widget.js`, `mobile.css`, `Logo.png`, etc.), bump-ează manual `CACHE_VERSION` în `public/sw.js` (ex. `v7` → `v8`). Fără bump, utilizatorii primesc versiunea veche până la hard refresh.

---

## Date trezorerii ANAF

**Sursa de adevăr:** `server/services/verify/data/trezorerii-anaf.json`
(committed în git). Conține ~243 entries — 41 județe + 7 entries București
hardcoded — fiecare cu `{ code, city, county, type, fullName, verified, source }`.

**Generat de:** `tools/scrape-trezorerii-anaf.mjs` din paginile oficiale
ANAF (`static.anaf.ro/.../iban2014/<Județ>.htm`). Paginile sunt declarate
windows-1252; scraperul decodează explicit acest charset și normalizează
diacriticele vechi (`ţ`→`ț`, `ş`→`ș`).

**Consumat de:** `server/services/verify/ibanValidator.mjs` — citește JSON-ul
la load și folosește `entries[localityCode]` pentru a popula
`treasuryCity`, `treasuryCounty`, `treasuryBranchName`, `treasuryType`,
`treasuryVerified`. Nu mai există listă hardcoded în validator (cea veche
avea 156/200 entries fabricate `unverified`).

**Refresh (anual recomandat, sau la apariția de trezorerii noi):**

1. `npm run scrape:trezorerii` (sau `node tools/scrape-trezorerii-anaf.mjs`)
2. Verifică `tools/output/trezorerii-diff.md` pentru schimbări așteptate
3. Dacă diff-ul arată schimbări OK, commit JSON-ul actualizat
4. `npm test` verde
5. PR develop → main

Tool-ul e idempotent (sortare deterministă a cheilor). `tools/output/` e
git-ignored — rapoartele sunt locale.

---

## Database Migrations — Lessons learned (incident 2026-04-19)

### Arhitectura duală — cum funcționează

Există **două sisteme de migrări** care rulează la fiecare boot, în ordine fixă:

1. **Inline** (`server/db/index.mjs` → `runMigrations()`) — array `MIGRATIONS[]` cu 001–N, rulează **primul**, într-o singură tranzacție `BEGIN/COMMIT`.
2. **File-based V4** (`server/db/migrate.mjs` → `runMigrationsV4()`) — fișiere `*.sql` din `server/db/migrations/`, rulează **după** inline, per-fișier în tranzacții separate.

**Ordinea la boot:**
```
initDbWithRetry()          ← rulează inline 001-N (o singură tranzacție)
  .then(async () => {
    await runMigrationsV4()  ← rulează file-based 000-014.sql
    markDbReady()
  })
```

**Consecință critică:** dacă o migrare inline eșuează, întreaga tranzacție se face ROLLBACK, `markDbReady()` nu e niciodată apelat, și serverul rămâne UP dar returnează `503 db_not_ready` pe toate endpoint-urile.

### Reguli obligatorii pentru migrări inline noi

**Regula 1 — Guard IF EXISTS pentru tabele V4**

Tabelele create EXCLUSIV de V4 file migrations (nu de inline): `alop_instances`, `alop_sabloane`.

Orice migrare inline care face `ALTER TABLE` pe o tabelă V4 **trebuie** wrappată în guard:

```sql
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='alop_instances'
  ) THEN RETURN; END IF;

  -- ALTER TABLE alop_instances ...

END $g$;
```

Pattern precedent: `054_alop_sabloane_schema` (model de referință).

**Regula 2 — Dollar-quoting nested**

Dacă SQL-ul intern conține deja `DO $$ ... END $$`, folosește tag diferit pentru outer block:
- Outer: `DO $g$ BEGIN ... END $g$;`
- Inner exception block: `BEGIN ... EXCEPTION WHEN ... END;` (fără DO separat)

**Regula 3 — `CREATE TABLE` cu FK spre tabelă V4**

Dacă migrarea inline creează o tabelă nouă cu `REFERENCES alop_instances(id)`, pune și acel `CREATE TABLE` în același guard `IF EXISTS` — altfel FK constraint eșuează pe fresh DB.

**Regula 4 — Testare pe fresh DB înainte de push**

Înainte de orice PR develop → main care adaugă migrări inline noi:
```bash
# Simulează fresh DB local: drop + recreate + start server
dropdb docflowai_dev && createdb docflowai_dev && npm start
# Verifică în logs că toate migrările trec fără ROLLBACK
```

### Anti-patterns de evitat

| Anti-pattern | Problemă | Soluție |
|---|---|---|
| `ALTER TABLE alop_instances` fără guard | Fail pe fresh DB, 503 permanent | Wrap în `DO $g$ IF NOT EXISTS` |
| `CREATE TABLE ... REFERENCES alop_instances` fără guard | FK fail pe fresh DB | Wrap în același guard |
| `DO $$ BEGIN ... END $$` nested în `DO $$ ... END $$` | Dollar-quoting conflict | Folosește `$g$` sau alt tag pentru outer |
| Migrare inline care presupune V4 rulat deja | Race condition garantată | V4 rulează DUPĂ inline, întotdeauna |

### ⚠️ Garda rezolvă 503-ul, dar lasă un GOL TĂCUT de schemă pe fresh DB

Garda `DO $g$ IF NOT EXISTS (table) THEN RETURN` (Regula 1) previne ROLLBACK-ul/503, DAR are un cost
ascuns: pe o **bază fresh**, ALTER-ul gardat **sare** (tabela V4 nu există încă, fiindcă inline rulează
înaintea V4), migrarea se marchează „applied" și **nu se mai reia niciodată**. Coloana/constraint-ul
**nu se adaugă** — fără nicio eroare în log. În prod/staging „merge" doar pentru că bazele s-au construit
incremental (tabela exista deja când a rulat ALTER-ul gardat).

**Goluri de fresh-provision cunoscute (de remediat — task dedicat):**
- `alop_instances`: `updated_by` (+ index), coloanele de semnatari (mig. 055), CHECK `plata_source`,
  tabela-copil `alop_ord_cicluri` (FK spre `alop_instances`) — toate gardate, toate sar pe fresh boot.
- `organizations.slug`: V4 `001_organizations.sql` îl cere `NOT NULL`, dar inline creează `organizations`
  fără slug primul → `CREATE TABLE IF NOT EXISTS` din V4 sare → `slug`/`idx_org_slug` lipsesc pe fresh.

**Consecință runtime:** relink-ul ALOP la ștergere/refuz scrie `alop_instances.updated_by`; pe o schemă
fresh fără coloana asta, scrierea eșuează — și fiindcă relink-ul e în `try/catch` non-fatal, eșuează
**tăcut**. Pe prod merge (coloana există).

**Regula 4 e necesară dar NU suficientă:** „verifică în logs că nu e ROLLBACK" nu prinde golul, fiindcă
o gardă care sare nu produce eroare. Verificarea autoritară de fresh-provision e acum **`npm run test:db`**
(`server/tests/db/**`): construiește schema fresh și rulează rute reale care ar pica dacă o coloană lipsește.
Bootstrap-ul fresh canonic e în `server/tests/helpers/db-real.mjs` (`migrateForTests`): inline-first cu
migrările V4-dependente pre-marcate „applied", apoi `014_alop.sql` + `015_formulare_oficiale.sql`, apoi
re-aplică inline-ul deferred — reconstruind ordinea pe care prod o are din creștere incrementală.

**Regula 5 — coloane care TREBUIE să existe pe tabele V4 NU se pun ca ALTER inline gardat.**
Garda le face opționale de facto (lipsesc pe fresh). Pune-le în migrarea V4 care deține tabela de bază
(ex. o nouă `016_*.sql` lângă `014_alop.sql`), unde tabela există garantat la momentul ALTER-ului.

---

## Database Migrations — Reguli obligatorii

### Context

DocFlowAI folosește **DOUĂ sisteme paralele de migrări** din motive istorice:

1. **Inline migrations** în `server/db/index.mjs` (funcția `runMigrations` apelată din `initDbOnce`). ~62 migrări numerotate 001-062. Rulează PRIMA la boot, într-o **singură tranzacție** — dacă una eșuează, TOATE fac rollback.

2. **File-based V4 migrations** în `server/db/migrations/*.sql`. 15 fișiere numerotate 000-014. Rulează A DOUA (după `markDbReady()`), per-file tranzacție, erorile sunt **prinse ca non-fatal** și doar logate.

**Această arhitectură duală creează risc** — dacă un inline migration depinde de tabelă creată de V4, la fresh DB eșuează (tabela încă nu există).

### Reguli absolute

#### REGULA 1: Migrări noi se scriu EXCLUSIV în inline

Nu mai adăuga fișiere în `server/db/migrations/`. Toate migrările noi merg în `server/db/index.mjs` cu numărul următor (063, 064, ...).

Motiv: inline se testează imediat, V4 tinde să fie ignorat din cauza `try/catch` non-fatal.

#### REGULA 2: Orice CREATE/ALTER folosește IF NOT EXISTS

```sql
-- BINE:
CREATE TABLE IF NOT EXISTS foo (...);
ALTER TABLE bar ADD COLUMN IF NOT EXISTS baz TEXT;
CREATE INDEX IF NOT EXISTS idx_foo ON foo(x);

-- RĂU:
CREATE TABLE foo (...);            -- eșec dacă tabela există
ALTER TABLE bar ADD COLUMN baz;    -- eșec dacă coloana există
```

#### REGULA 3: Constraint-urile se adaugă în DO block cu exception

PostgreSQL nu are `ADD CONSTRAINT IF NOT EXISTS`. Workaround:

```sql
DO $$ BEGIN
  ALTER TABLE foo ADD CONSTRAINT foo_bar_fk
    FOREIGN KEY (bar_id) REFERENCES bar(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
```

#### REGULA 4: ALTER pe tabelă care POATE LIPSI primește guard

Dacă tabela e creată de alt sistem (V4) sau de feature care poate nu fi activat pe toate mediile, wrap în guard:

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='target_table'
  ) THEN RETURN; END IF;

  ALTER TABLE target_table ADD COLUMN IF NOT EXISTS new_col TEXT DEFAULT '';
END $$;
```

Precedent: migrațiile 054, 055, 059-062 au primit acest guard după incidentul din 2026-04-19.

#### REGULA 5: Coloane noi NOT NULL trebuie DEFAULT

Pe tabele cu date existente:

```sql
-- BINE:
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- RĂU pe tabelă cu date existente:
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL;
-- → eșec: "column contains null values"
```

#### REGULA 6: NICIODATĂ DROP fără confirmare explicită

- `DROP TABLE`
- `DROP COLUMN`
- `DROP CONSTRAINT`
- `TRUNCATE`
- `DELETE` fără `WHERE`

Astea nu merg într-o migrație fără confirmare explicită de la owner (Mircea). Dacă ai nevoie să ștergi o coloană/tabelă, **întreabă prima dată, nu scrie migrația direct**.

#### REGULA 7: NICIODATĂ nu modifica `server/db/migrate.mjs`

Force-rerun pe migration ID (`DELETE FROM schema_migrations WHERE id='X'`) e extrem de periculos. Dacă migrația are efect cumulativ, re-rulatul poate strica date. Există un force-rerun pe `014_alop` — **nu adăuga altele**.

### Proces pentru migrare nouă

1. **Scrie migrația** în `server/db/index.mjs` cu următorul număr liber (verifică cu `grep -oE "'[0-9]{3}_[a-z_]+'" server/db/index.mjs | sort -u | tail -5`)

2. **Respectă regulile 2-6** de mai sus

3. **Test pe local** dacă ai DB local, altfel staging

4. **Deploy pe staging** (`git push origin develop`) și monitorizează Railway logs:
   - Așteaptă să vezi `DB ready.` în log

5. **Testare funcțională pe staging** — minim 24h uptime + login + un workflow end-to-end care atinge noua schemă

6. **Dacă staging stabil → PR develop → main** pentru production

7. **Monitorizare post-deploy production** — primele 10 min după redeploy:
   - `/health` → 200
   - Login → merge
   - Railway logs: `DB ready.` apare fără `DB init failed`

### Anti-patterns interzise

- ❌ Migrații care presupun ordinea între inline și V4
- ❌ Modificări la `migrate.mjs` (force-rerun)
- ❌ `CREATE TABLE` fără `IF NOT EXISTS`
- ❌ `ADD COLUMN` fără `IF NOT EXISTS`
- ❌ `ADD CONSTRAINT` în afara unui `DO $$ ... EXCEPTION` block
- ❌ `NOT NULL` fără `DEFAULT` pe tabelă cu date
- ❌ `DROP` sau `TRUNCATE` fără confirmare explicită
- ❌ Deploy direct pe main fără staging 24h uptime
- ❌ PR develop → main fără backup manual `pg_dump` salvat local

### În caz de incident DB (schema drift, init failure)

Vezi `docs/incidents/2026-04-19-db-init-failure.md` pentru playbook:

1. **Nu face wipe distructiv** — încearcă întâi reconcile add-only
2. **Backup manual local** cu `pg_dump` (nu te baza pe Railway backup)
3. **Dry-run pe staging** înainte de production
4. **Execuție în `BEGIN/COMMIT`** cu `ON_ERROR_STOP=1`
5. **Comparație state before/after** pentru verificare

---

## Incident log

### 2026-04-19: Production DB init failure

- **Cause:** inline migrations 055–062 ALTER `alop_instances` which didn't exist on production (ALOP feature was staging-only, table created only by V4 `014_alop.sql`)
- **Detection:** post PR develop → main merge, login returned `503 db_not_ready` ("Baza de date nu este disponibilă")
- **Fix:** added `DO $g$ IF NOT EXISTS` guard to migrations 055, 059, 060, 061, 062; migration 062 also guards `CREATE TABLE alop_ord_cicluri` (FK to `alop_instances`)
- **Time to recovery:** ~1h (diagnostic + fix commit + PR develop→main + Railway redeploy)
- **Data loss:** zero
- **Root cause:** dual migration systems (inline + V4 file-based) without coordination — inline runs first, V4 errors non-fatal but inline errors fatal; `alop_instances` created only by V4
- **Prevention:** rules documented above + guard pattern established for all future ALOP migrations

---

## Index migrații ALOP & Formulare

Schema ALOP este împărțită între un fișier SQL inițial și migrații inline
în db/index.mjs (per regula "doar inline pentru ALTER ulterioare"):

| Sursă                                     | Migrație               | Conținut                                        |
|-------------------------------------------|------------------------|-------------------------------------------------|
| server/db/migrations/014_alop.sql         | (initial schema)       | alop_instances + alop_sabloane + indexuri       |
| server/db/migrations/015_formulare_oficiale.sql | (initial schema) | formulare_oficiale (REFNEC, NOTAFD_INVEST)     |
| server/db/index.mjs                       | 048_formulare_df       | Tabela formulare_df (DF workflow P1→P2)        |
| server/db/index.mjs                       | 049_formulare_ord      | Tabela formulare_ord (ORD workflow P1→P2)      |
| server/db/index.mjs                       | 055_alop_instances_semnatari | df_semnatari + ord_semnatari JSONB         |
| server/db/index.mjs                       | 056_formulare_df_revizuiri | revision tracking pe DF                     |
| server/db/index.mjs                       | 057_formulare_df_revizie_an_urmator | flag "an următor"                  |
| server/db/index.mjs                       | 058_formulare_ord_img2 | A doua captură "Informații complete contract"  |
| server/db/index.mjs                       | 059_alop_lichidare_documente | factură + PV pentru lichidare              |
| server/db/index.mjs                       | 060_alop_plata_documente | nr_ordin + sumă efectivă pentru plată         |
| server/db/index.mjs                       | 061_alop_lichidare_data_pv | data_pv extra                                |
| server/db/index.mjs                       | 062_alop_multi_ord     | Tabela alop_ord_cicluri (multi-ORD per ALOP)    |
| server/db/index.mjs                       | 063_user_leave_delegate | concediu + delegare                            |
| server/db/index.mjs                       | 064_delegation_functie | funcție pentru delegare                         |
| server/db/index.mjs                       | 085_formulare_df_an_referinta | an absolut ancorare benzi rows_plati     |
| server/db/index.mjs                       | 086_alop_ord_cicluri_an_exercitiu | an de exercițiu per ciclu arhivat    |

Pentru orice nouă migrație ALOP/formulare, urmează regula stabilită:
ALTER inline în db/index.mjs cu pattern `id: 'NNN_descriere'` și SQL idempotent.
