# DocFlowAI v4.0 — Developer Guide

## Stack

- **Runtime:** Node.js 20, ES modules throughout (`"type": "module"`, `.mjs` server, `.js` frontend)
- **Web framework:** Express 4, PostgreSQL via `pg` pool
- **Real-time:** `ws` WebSocket server (see `server/services/ws.mjs`)
- **PDF / Signing:** `pdf-lib`, `@signpdf/signpdf`, Java Spring Boot microservice (`SIGNING_SERVICE_URL`)
- **Auth:** JWT in HttpOnly cookies (`dfai_token`), PBKDF2 600k iterations, optional TOTP/2FA
- **Email:** Resend REST API; **WhatsApp:** Meta Business API; **Push:** VAPID Web Push
- **Storage:** PDF bytes in PostgreSQL BYTEA (`flows_pdfs`); Google Drive for archive
- **Deploy:** Railway EU West — Node.js + PostgreSQL separate services
- **Testing:** Vitest + Supertest

---

## STS Zone Contract — READ THIS FIRST

The following files are **STRICT NO-TOUCH**. QES PAdES multi-signer signing works in production with real clients. Any modification can invalidate existing qualified signatures:

```
server/signing/                         <- entire directory, all files
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/routes/flows/acroform.mjs
```

**Absolute rule:** If a change would touch the STS signing flow or PAdES, STOP and ask first.

If you need to interact with signing:
- Create NEW files that import from `server/signing/`
- Do NOT modify existing signing files

---

## Project Structure

```
server/
  index.mjs           -- Entry point: createServer, WS, graceful shutdown
  app.mjs             -- Express app factory + route mounting
  bootstrap.mjs       -- DB migrations, seeds, startup jobs
  config.mjs          -- All env vars with validation

  core/               -- Pure utilities (no DB, no HTTP)
    errors.mjs        -- AppError, ValidationError, NotFoundError, ForbiddenError
    ids.mjs           -- generateId() (nanoid-based)
    hashing.mjs       -- hashPassword, verifyPassword
    dates.mjs         -- formatDate helpers
    pagination.mjs    -- buildPaginationMeta
    tenant.mjs        -- getOrgId(req), isSuperAdmin(req)
    validation.mjs    -- validateEmail, sanitizeString

  db/
    index.mjs         -- pg Pool, DB_READY, migrations auto-run, helper queries
    migrate.mjs       -- migration runner
    migrations/       -- SQL files 001..013+
    queries/          -- Domain query modules (flows, users, audit, forms, ...)
    seeds/            -- Seed files (forms.mjs for ALOP template)

  middleware/
    auth.mjs          -- JWT verify, requireAuth, requireAdmin, hashPassword
    logger.mjs        -- Pino logger, requestLogger middleware
    csrf.mjs          -- Double-submit CSRF cookie
    errorHandler.mjs  -- Express error handler (no raw errors in responses)
    rateLimiter.mjs   -- In-memory rate limiting
    metrics.mjs       -- Prometheus metrics
    uploadGuard.mjs   -- File upload validation

  modules/            -- v4 feature modules (each: routes.mjs + service.mjs + repository.mjs)
    auth/             -- Login, JWT refresh, CSRF tokens
    users/            -- User CRUD, profile, password change
    flows/            -- Flow management (create, list, advance, cancel)
    notifications/    -- In-app notification center
    archive/          -- Google Drive archive jobs
    forms/            -- Forms Engine (templates, versions, instances, PDF render)
      evaluator.mjs   -- Pure validation engine: evaluateCondition, validateFormData
      pdf-renderer.mjs -- AcroForm fill + programmatic PDF generation (NotoSans TTF)
    admin/
      organizations.mjs -- Org CRUD at /api/admin/organizations
      users.mjs         -- Extended user mgmt: reset-password, force-logout, bulk-import
      outreach.mjs      -- Outreach campaigns + primarii dataset
      tracking.mjs      -- Public tracking pixel/click routes (/d/:id, /p/:id)
    analytics/        -- Summary KPIs + flows timeline (generate_series)
    policies/         -- Policy engine: evaluatePolicy, built-in rules
    audit/            -- Audit log: paginated events, per-flow, CSV export

  routes/             -- Legacy/NO-TOUCH routes
    flows/
      index.mjs       -- Orchestrator (mounts all flow sub-routes)
      crud.mjs        -- Create, read, list flows
      signing.mjs     -- Sign (local upload), refuse, upload PDF
      lifecycle.mjs   -- Reinitiate, review, delegate, cancel
      cloud-signing.mjs  NO-TOUCH -- STS OAuth
      bulk-signing.mjs   NO-TOUCH -- Bulk signing
      acroform.mjs       NO-TOUCH -- AcroForm detection
      email.mjs       -- External email + tracking
      attachments.mjs -- Support document management

  services/
    webhook.mjs       -- HMAC-SHA256 outgoing webhooks (fire, _dispatch)
    ws.mjs            -- WebSocket server (createWsServer, sendToUser, broadcastToOrg)
    certificate-verify.mjs -- X.509 chain validation
    sign-trust-report.mjs  -- Trust chain report generation

  signing/            NO-TOUCH -- All signing providers
    providers/
      LocalUploadProvider.mjs  -- operational
      STSCloudProvider.mjs     -- NO-TOUCH (production QES)

  tests/
    setup.mjs               -- Vitest global setup (env vars, DB mock config)
    integration/            -- Supertest tests with mocked DB
    unit/                   -- Pure unit tests

public/
  css/main.css              -- Complete design system (CSS variables, components)
  js/
    core/                   -- api.js, auth.js, toast.js, modal.js, tables.js, dom.js
    modules/
      auth/login.js
      admin/dashboard.js, users.js
      initiator/flow-list.js, flow-create.js
      forms/alop.js
  login.html
  admin.html
  semdoc-initiator.html
  formular.html
  semdoc-signer.html        -- DO NOT MODIFY
  flow.html                 -- DO NOT MODIFY
  verifica.html             -- DO NOT MODIFY
  bulk-signer.html          -- DO NOT MODIFY
```

---

## How to Run Locally

```bash
git clone <repo>
git checkout v4-enterprise
npm install

# Copy env (values from Railway dashboard)
cp env.example .env
# Fill in: DATABASE_URL, JWT_SECRET (>=32 chars), PUBLIC_BASE_URL,
#          RESEND_API_KEY, MAIL_FROM

npm start          # node server/index.mjs
```

---

## Commands

```bash
npm start              # Start application (node server/index.mjs)
npm run dev            # Start with --watch (auto-restart on changes)
npm test               # Run all tests once (vitest run)
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage report
npm run check          # node --check on 40+ server files (syntax only)
```

Run a single test file:
```bash
npx vitest run server/tests/integration/flows.test.mjs
```

---

## How to Add a New Module

1. Create `server/modules/{name}/routes.mjs` + `service.mjs` + `repository.mjs`
2. Mount in `server/app.mjs`:
   ```js
   import nameRouter from './modules/{name}/routes.mjs';
   app.use('/api/{name}', nameRouter);
   ```
3. Add tests in `server/tests/integration/{name}.test.mjs`
4. Add `node --check server/modules/{name}/*.mjs` to `npm run check` in `package.json`

---

## How to Add a New Form Template

1. Add seed in `server/db/seeds/forms.mjs`:
   ```js
   const MY_SCHEMA = { sections: [...], fields: [...] };
   const MY_RULES  = [...];
   await seedTemplate({ code: 'MY_FORM', name: '...', schema: MY_SCHEMA, rules: MY_RULES });
   ```
2. Schema: `{ sections: [{ id, title }], fields: [{ id, section, type, label, required }] }`
3. Rules: `[{ condition: { field, op, value }, effect: 'require'|'hide', target }]`
4. `seedDefaultForms()` is called at bootstrap automatically

Form evaluator operators: `eq neq gt gte lt lte contains not_contains in not_in empty not_empty`

---

## How to Add a New Signing Provider

1. Create `server/signing/providers/NameProvider.mjs` extending `SigningProvider`:
   ```js
   import { SigningProvider } from '../SigningProvider.mjs';
   export class NameProvider extends SigningProvider {
     async initiateSigning(flow, signer) { ... }
     async completeSigning(flow, signer, payload) { ... }
   }
   ```
2. Register in `server/signing/index.mjs` in `ALL_PROVIDERS` map
3. Add provider key to `signing_providers_enabled` for the org (via admin panel)

Never modify STSCloudProvider.mjs.

---

## Database Patterns

### Key tables
| Table | Purpose |
|-------|---------|
| `flows` | Flow metadata in JSONB `data`, with `org_id`, `created_at`, `updated_at`, `deleted_at` |
| `flows_pdfs` | PDF bytes in BYTEA: `pdfB64`, `signedPdfB64`, `originalPdfB64` |
| `users` | Users with `org_id` FK, `token_version` for session invalidation |
| `organizations` | Orgs with `signing_providers_enabled` GIN-indexed JSONB |
| `form_templates` | Form template definitions |
| `form_instances` | Per-flow form instances with `data_json` |
| `audit_log` | Complete event log |
| `policy_rules` | Policy engine rules (built-in: `org_id IS NULL`) |
| `outreach_primarii` | ~2950 Romanian municipalities dataset |

### Query rules
- Use **`org_id` column** (not `data->>'orgId'`) -- indexed
- Prefer **`COUNT(*) OVER()`** window function over two queries
- Soft deletes: `deleted_at IS NULL` always in flow queries
- `org_id` is in the JWT payload (`actor.orgId`) -- do not query it from DB if available

### Important indexes
```sql
idx_flows_org_updated  ON flows(org_id, updated_at DESC)
idx_flows_active       ON flows WHERE NOT status IN ('completed','refused','cancelled')
idx_flows_signers_gin  ON flows USING GIN (data->'signers')
```

---

## Security Patterns

- JWT in HttpOnly cookies (`dfai_token`), never `localStorage`
- CSRF: double-submit cookie (`X-CSRF-Token` header)
- Token versioning: `token_version` bump invalidates all active sessions
- Soft deletes (`deleted_at`) for complete audit trails
- No raw error details in 500 responses
- Webhook HMAC-SHA256 in `X-DocFlow-Signature` header
- `esc(str)` mandatory for all user data in DOM

---

## Multi-tenancy

- All flow/user queries include `org_id` isolation
- `getOrgId(req)` from `server/core/tenant.mjs` reads from JWT
- `isSuperAdmin(req)` returns `req.user?.role === 'admin'`
- Roles: `admin` (super-admin, sees all), `org_admin` (sees own org), `user` (normal)

---

## Two Flow Types

**`tabel`** -- DocFlowAI generates the signature footer. Applied at flow CREATION, before any QES.

**`ancore`** -- PDF has pre-existing signature fields. DocFlowAI does NOT modify the PDF at creation.

Critical: `pdf-lib.save()` is NEVER called on an already-signed PDF.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | >=32 chars |
| `PUBLIC_BASE_URL` | | Base URL |
| `PORT` | | Default: 3000 |
| `JWT_EXPIRES` | | Default: 8h |
| `RESEND_API_KEY` | | Transactional email |
| `MAIL_FROM` | | Sender address |
| `SIGNING_SERVICE_URL` | | Java PAdES microservice |
| `GOOGLE_DRIVE_FOLDER_ID` | | Archive destination |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | | Google service account JSON |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT` | | Web Push |
| `WA_PHONE_NUMBER_ID` / `WA_ACCESS_TOKEN` | | WhatsApp |
| `OUTREACH_DAILY_LIMIT` | | Default: 100 emails/day |
| `STS_CLIENT_ID` / `STS_CLIENT_SECRET` | NO-TOUCH | STS Cloud OAuth |

---

## Reguli de lucru

Dupa ORICE implementare completa si dupa ce testele trec:
1. `git add .`
2. `git commit -m "descriere"`
3. `git push origin v4-enterprise`

O sarcina nu este considerata terminata fara `git push`.

Inainte de orice modificare: ruleaza `npm test` si verifica ca toate testele trec.

---

## Deployment (Railway)

- Production: `docflowai-app.up.railway.app` (branch `main`)
- Staging: `docflowai-app-staging.up.railway.app` (branch `develop`)
- Migrations run automatically at startup
- `.railwayignore` excludes large files from `tools/`
- Railway uses `npm ci` -- `package.json` and `package-lock.json` must stay in sync
