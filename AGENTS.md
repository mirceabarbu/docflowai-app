# AGENTS.md — DocFlowAI

This file is the primary instruction set for Codex and other coding agents working in this repository.
It consolidates the operational, architectural, security, testing, Git, ALOP, PDF and migration rules previously documented in `CLAUDE.md`.

## 0. Instruction priority

Apply instructions in this order:

1. The current task/prompt, when it is explicit and safe.
2. This `AGENTS.md`.
3. Repository documentation, including `CLAUDE.md`, `README.md`, `docs/**` and comments that describe current invariants.
4. Existing code and tests.

If two rules conflict, choose the safer fail-closed interpretation and report the conflict before editing.
Never silently resolve a conflict that could affect production data, tenant isolation, ALOP, signing, migrations or Git history.

---

## 1. Mission and product context

DocFlowAI is a multi-tenant SaaS platform for Romanian public institutions. It manages document workflows, DF/ORD/ALOP financial processes, qualified electronic signatures, attachments, audit evidence and electronic archiving.

Production is used by real clients. Preserve, in this order:

1. tenant isolation;
2. financial correctness;
3. qualified-signature and PDF integrity;
4. authorization and identity correctness;
5. auditability and traceability;
6. data durability;
7. backward compatibility;
8. operational stability.

Prefer small, reviewable, reversible changes with explicit tests. Never perform unrelated cleanup during a security or production fix.

Current stack:

- Node.js 20, ES modules (`.mjs`, `"type": "module"`);
- Express 4;
- PostgreSQL via `pg`;
- WebSocket via `ws`;
- Vitest and Supertest;
- Java/iText PAdES sidecar through `SIGNING_SERVICE_URL`;
- Railway staging and production;
- JWT in HttpOnly cookies, CSRF, TOTP/2FA;
- Resend, WhatsApp, Web Push and Google Drive integrations.

---

## 2. Repository map

Important areas:

- `server/index.mjs` — application composition, middleware, routes, WebSocket and background jobs.
- `server/routes/auth.mjs` — authentication, refresh, logout and CSRF-related endpoints.
- `server/middleware/auth.mjs` — dual-mode `requireAuth`.
- `server/routes/flows/` — document workflow routes.
- `server/routes/flows/crud.mjs` — flow creation, reads and listings.
- `server/routes/flows/lifecycle.mjs` — reinitiation, delegation, review, cancellation.
- `server/routes/formulare/` — DF/ORD wrappers and routes.
- `server/services/formular-shared.mjs` — shared DF/ORD lifecycle logic.
- `server/routes/alop.mjs` — ALOP routes and state transitions.
- `server/services/alop-*.mjs` — ALOP capabilities, linking and domain services.
- `server/services/buget-an.mjs` — annual budget helpers.
- `server/db/index.mjs` — pool, DB helpers and inline migrations.
- `server/db/migrate.mjs` and `server/db/migrations/` — legacy file-based migration system.
- `server/tests/db/` — tests against real PostgreSQL.
- `public/js/formular/` — DF/ORD/ALOP frontend.
- `public/js/semdoc-initiator/` — flow composition frontend.
- `public/sw.js` — service worker.
- `server/signing/` — high-risk signing implementation.

Read the relevant files before proposing or applying a patch. File contents are the source of truth; line numbers and snippets in prompts may drift.

---

## 3. Git and branch discipline

### Branches

- `main` is PRODUCTION and is managed manually by Mircea.
- `develop` is STAGING and auto-deploys to Railway staging.
- Never checkout, merge into, push to or force-push `main` unless Mircea explicitly instructs it in the current task.
- Default implementation branch is `develop` or a dedicated branch based on `develop`, according to the current prompt.

### Before editing

Run:

```bash
git status --porcelain
git branch --show-current
```

If the working tree is not clean and the current prompt does not explicitly account for those changes, STOP and report.

Do not automatically run:

- `git stash`;
- `git reset --hard`;
- `git checkout -- .`;
- `git clean`;
- force push;
- destructive rebases;
- any command that can discard local or remote work.

Update safely with:

```bash
git switch develop
git pull --ff-only origin develop
```

### Staging files

Never use `git add .`, `git add -A` or broad staging for autonomous work.
Stage only explicit, reviewed paths:

```bash
git add -- path/to/file1 path/to/file2
```

Before committing, run:

```bash
git status --short
git diff --check
git diff --cached --name-only
git diff --cached --check
git diff --cached --stat
```

If any file outside the authorized task scope appears, STOP. Do not delete or restore it automatically.

### Commit and push

After a requested implementation is complete and all required tests pass:

1. stage only the authorized files;
2. create a clear commit;
3. push to the authorized non-production branch;
4. report branch, commit hash, tests and final `git status`.

A coding task that explicitly requests autonomous delivery is not complete until `git push` succeeds. Analysis-only, review-only and plan-only tasks must not commit or push.

Never push if:

- tests fail;
- required DB tests were skipped but the task depends on them;
- the diff contains secrets or unauthorized files;
- a NO-TOUCH file changed;
- the branch is not the authorized branch;
- a safety precondition failed.

---

## 4. Required commands and definition of done

Common commands:

```bash
npm start
npm run check
npm test
npm run test:watch
npm run test:coverage
```

Single test file:

```bash
npx vitest run path/to/test.mjs
```

Real PostgreSQL suite:

```bash
npm run db:test:up
# Use the TEST_DATABASE_URL printed by the command.
npm run test:db
npm run db:test:down
```

`npm test` uses mocks for the main suite. It is not proof that SQL works against PostgreSQL.
`npm run test:db` may exit successfully with tests skipped when `TEST_DATABASE_URL` is missing. Skipped is not passed.

Before editing, run the relevant baseline tests. Before completion, run at minimum:

```bash
npm run check
npm test
git diff --check
```

Also run `npm run test:db` locally with a real DB, or verify the CI DB job after push, whenever the task touches:

- SQL;
- migrations;
- ALOP;
- DF/ORD/formulare;
- authorization based on persisted fields;
- tenant resolution;
- attachments or captures persisted in DB;
- lifecycle transitions;
- DB transaction behavior.

Definition of done:

- acceptance criteria are met;
- relevant regression tests were added;
- existing relevant tests pass;
- DB tests genuinely passed when required, not skipped;
- diff was reviewed for tenant leaks, authz, CSRF, caching, secrets, audit gaps and destructive behavior;
- version/cache busting was updated when required;
- only authorized files were committed;
- push completed to the authorized branch;
- final report includes deviations and remaining risks.

Do not hardcode an expected total test count. Require zero failures, no new unexplained skips and execution of all new tests.

---

## 5. Absolute NO-TOUCH signing zone

These files are production-critical and must not be modified unless the current prompt explicitly names them and Mircea has authorized signing work:

```text
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/cloud-signing.mjs
server/signing/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
```

Some paths may not exist in every version. The rule applies to the corresponding STS/PAdES implementation wherever located.

If a requested change could affect:

- STS OAuth/PKCE;
- hash generation;
- ByteRange;
- CMS injection;
- iText signature fields;
- multi-signature incremental updates;
- Java PAdES protocol fields;
- cloud-signing callbacks;

STOP and report before editing unless the task explicitly authorizes that scope and defines dedicated tests.

Never claim eIDAS, PAdES or qualified-signature compliance solely because unit tests pass.

---

## 6. PDF and signature invariants

Flow types:

- `tabel` — DocFlowAI creates the signature table/footer before any signature.
- `ancore` — the PDF already contains external signature anchors; DocFlowAI must not add a footer at creation.

Critical rules:

1. Never call `pdf-lib.save()` on an already signed PDF. Re-saving can invalidate QES signatures.
2. A PDF that contains `/ByteRange` is treated as pre-signed. Do not stamp or rewrite it.
3. For pre-signed uploads, calculate signer rectangles read-only with `computeSignerRectsReadOnly`.
4. Every flow-creation path must populate `padesRect`:
   - unsigned PDF: through the existing footer/field path;
   - pre-signed PDF: through the read-only placement path.
5. Geometry is manually synchronized between footer placement and read-only signer placement. If one changes, review and test the other.
6. `data.flowId` inside JSONB is not authoritative. Use the explicit flow ID from the URL/caller.
7. Do not expose PDF Base64, signature tokens, private keys, JWTs, signer URLs or full provider responses in logs.

---

## 7. Authentication, identity and tenant isolation

### Fail closed

A database or validation error in authentication, authorization, tenant resolution, signing or financial transitions must fail closed.

Never:

- fall back to the first/default organization;
- infer a tenant from arbitrary client data;
- silently swallow tenant lookup errors;
- continue with a null or ambiguous `org_id`;
- trust an email lookup when a stable `userId` is available.

### Authoritative identity

`requireAuth` supports two modes:

- helper: `const actor = requireAuth(req, res); if (!actor) return;`
- middleware: `router.post('/x', requireAuth, ..., handler)` and use `req.actor`.

Choose one mode per router/file and use it consistently.

For security-sensitive tenant resolution:

- identify the active user by `actor.userId`;
- query `users.id` with `deleted_at IS NULL` when a current DB check is required;
- never resolve the actor by `WHERE email=$1` when `userId` is available;
- use `actor.orgId` as a scoped token claim or stale-session consistency check, not as a fallback around a failed DB lookup;
- if token org and authoritative DB org differ, fail closed and require reauthentication.

Every authenticated business resource must be scoped by the dedicated `org_id` column. Prefer indexed columns over `data->>'orgId'`.

Add cross-tenant tests for every new read or mutation endpoint.

### ÎNTOCMIT identity

The actor who creates a flow is always the identity for the normalized `ÎNTOCMIT` role.

- derive the real name/email from the authenticated actor and/or active user row;
- never trust `body.initName` or `body.initEmail` as the effective identity;
- overwrite any `ÎNTOCMIT` signer imported from a shared template with the authenticated actor;
- preserve frontend UX that disables editing of the active `ÎNTOCMIT` row.

---

## 8. Security invariants

1. Use parameterized SQL only.
2. Never return raw internal errors to clients; log safely with Pino.
3. Never log secrets, credentials, private keys, JWTs, TOTP secrets, PDF bytes/Base64, signer tokens or sensitive provider payloads.
4. JWTs remain in HttpOnly cookies, never localStorage.
5. Preserve CSRF double-submit protections and origin checks.
6. Webhooks require HMAC-SHA256 or the existing authenticated mechanism.
7. Unknown states and invalid state transitions must be rejected.
8. State-changing financial/signing operations and their audit events must be atomic or use a transactional outbox.
9. Preserve idempotency for callbacks, payment confirmation, retries, signing and attachment-copy operations.
10. Do not cache authenticated API responses, PDFs, ALOP/budget data, auth responses or admin data in the browser or service worker.
11. Service-worker authenticated routes are network-only. Static assets may use the existing safe strategies.
12. Any user-derived value inserted into HTML must be escaped with the shared `esc()` pattern. Never use unescaped `innerHTML`.
13. Do not weaken authorization because a UI capability hides a button. Backend guards remain authoritative.

Money and limits:

- use PostgreSQL `NUMERIC` and decimal-safe logic;
- do not use JavaScript binary floating point for authorization, budget or financial acceptance decisions;
- preserve documented tolerances only where the existing domain rule explicitly uses them.

---

## 9. CORS policy

CORS credentialed access is only for application origins.

Landing origins:

```text
https://docflowai.ro
https://www.docflowai.ro
```

may receive non-credentialed CORS only for the explicitly authorized contact endpoint.
They must be actively filtered out of any global credentialed origin list, including values supplied by `CORS_ORIGIN` or `PUBLIC_BASE_URL`.

Test both:

- pure origin resolution;
- actual Express middleware order and preflight behavior.

Do not use `Clear-Site-Data: "storage"` as a casual logout defense. It can delete IndexedDB, localStorage, Service Worker registration, push subscriptions and in-progress drafts. Any full local purge is a separate product decision requiring explicit approval and dedicated UX tests.

---

## 10. Service worker and cache busting

Authenticated prefixes such as `/api/`, `/auth/`, `/flows/` and `/admin/` must never read from or write to Cache Storage.

For service-worker changes:

- use network-only for authenticated/data routes;
- return a controlled offline error without cached user data;
- bump `CACHE_VERSION` when required to purge old caches;
- preserve static asset strategies unless the task explicitly changes them;
- add a regression test that prevents reintroduction of authenticated caching;
- manually inspect Cache Storage on staging after deploy.

Browser asset cache busting:

- bump `package.json` version when the release process requires it;
- update `?v=` only for changed JS/CSS assets;
- inspect the current `?v=` value in HTML instead of assuming it equals the package version;
- when a changed file is in `PRECACHE_ASSETS`, bump the Service Worker cache version.

Do not bulk-replace all asset versions for a backend-only change.

---

## 11. Frontend and CSS rules

Frontend pages are large SPA-style documents and scripts. Keep changes targeted.

### HTML safety

- escape user data with `esc(str)`;
- no unescaped user data in `innerHTML`;
- preserve CSP/nonce patterns;
- do not move auth tokens to localStorage.

### CSS isolation

Page CSS must be scoped under the page wrapper. Avoid bare selectors such as:

```css
input { ... }
label { ... }
```

Prefer:

```css
.df-shell input { ... }
```

Global components mounted under `<body>` must be self-contained and defensively declare their own styles under a component root.

The two-layer defense is intentional:

1. page styles are scoped;
2. global components are self-contained.

Do not remove component-level defensive CSS because a page was scoped.

### SPA state

When loading a different DF/ORD document in the same SPA session, reset attachment/capture locks before reapplying document-specific locks. Do not leave `disabled` state from the previous document.

---

## 12. DF/ORD shared lifecycle invariants

DF and ORD lifecycle logic is consolidated in `server/services/formular-shared.mjs` and configured through `FORMULAR_TYPES`.

Rules:

1. Differences between DF and ORD must be explicit configuration keys.
2. Do not hide new asymmetries inside `if (ft === 'ord')` branches in duplicated handlers.
3. Do not “uniformize” documented intentional differences.
4. When touching a duplicated DF/ORD pair, prefer consolidation into the shared service if the task scope allows it.
5. Before refactoring a DB-backed lifecycle path, add a real-DB characterization test if one does not exist.
6. Express route order matters: static routes must be registered before parameter routes.
7. File splitting is a verbatim move first, not an opportunistic rewrite.

Known intentional asymmetries include:

- DF accepts `de_revizuit` in submit states; ORD does not.
- ORD has hard budget checks; DF may use soft-warning behavior according to the current domain rule.
- DF completion advances/link-heals ALOP in documented cases; ORD completion behavior differs.
- DF and ORD link-flow status changes differ intentionally.
- DF revision deletion/relink is revision-aware; ORD behavior is simpler.

Read the current tests and `FORMULAR_TYPES` before changing any of these.

---

## 13. ALOP and financial domain invariants

ALOP is the commercially critical core. Do not change its formulas, transitions, document linkage or audit behavior without dedicated tests.

### General transition rules

- lock the relevant rows for state-changing operations where concurrency matters;
- validate current state and expected state;
- enforce role/authorization independently of UI capabilities;
- write state and audit atomically;
- preserve idempotency;
- reject unknown or out-of-order transitions;
- test concurrent/double-submit behavior when relevant.

### Capabilities

Server-side capability functions are the source of truth for which actions the UI displays.

- add new conditional actions in the relevant capability service;
- add unit and DB characterization tests;
- frontend renders capabilities but does not replace backend authorization;
- refresh capabilities after every mutation.

### DF ↔ ALOP linking

Preserve persistent provenance through `source_alop_id` and the documented self-heal/relink behavior.

Do not add `completed_at IS NULL` filters to relink/self-heal queries that intentionally operate on completed ALOP records. Completed ALOP may be revised and used for a new liquidation cycle.

### Attachments and captures

- revision must copy non-deleted attachments and captures as documented;
- attachment/capture authz goes through the shared formular authorization service;
- copying formulario attachments into flows is add-only and idempotent;
- source attachments are never deleted or moved by flow-copy logic;
- both documented link paths are intentional and complementary;
- cancellation/soft-delete cleanup of DF and ORD pointers must remain symmetric where documented.

### New liquidation and archived cycles

Preserve:

- archived cycle history;
- exercise-year attribution;
- distinction between amounts ordered and amounts actually paid;
- audit totals versus budget authorization totals;
- revision relinking behavior.

### Budget rules — do not reinterpret

Current domain rules distinguish display values from authorization limits.
Do not derive a new rule from field names.

In particular:

- the display card and the hard ordonnancement limit may intentionally use different bases;
- “Stingere” has explicit owner-defined behavior;
- hard authorization uses the documented budget-credit fields and previously ordered amounts, not an arbitrary total commitment or paid amount;
- `suma_totala_platita` remains an audit amount and is not automatically the authorization denominator;
- annual budget band mapping and its SQL equivalent are manually synchronized;
- null and zero are distinct and must remain distinct in UI and backend;
- legacy records with null reference year follow the documented blocking/fallback rule, not a new guessed behavior.

Before changing any ALOP/budget formula, read:

- `server/services/buget-an.mjs`;
- relevant fragments in `server/routes/alop.mjs`;
- `server/services/formular-shared.mjs`;
- all matching `server/tests/db/**` and unit tests.

Add tests first.

---

## 14. OPME invariants

OPME imports and matching are financial operations.

Preserve:

- per-org file-hash idempotency;
- matching by the documented triplet;
- `pending`, `auto`, `manual`, `ambiguous`, `unmatched`, `partial` semantics;
- equal-sum auto-confirm behavior;
- ambiguous and partial cases not being auto-confirmed incorrectly;
- `plata_source` provenance;
- `plata_auto_opme` audit payload;
- retroactive absorption through the existing service;
- parser interface `{ header, lines, raw_meta }` for new treasury formats.

Any OPME change requires real-DB tests or CI DB verification.

---

## 15. Internal transmission / repartizare invariants

The durable access source for transmitted flows is `flow_recipients`.

Preserve:

- recipients may be users or compartments according to the XOR rule;
- acknowledgement is per person;
- transmit authorization uses the normal flow-reader/owner rules, not “recipient can retransmit” by default;
- metadata, PDFs and attachments use the same access gate;
- auto-transmit remains non-fatal relative to completion notification;
- flow ID is passed explicitly and not inferred from JSONB;
- `FLOW_TRANSMITTED` and `FLOW_ACKNOWLEDGED` correlation uses `recipientKey`.

---


## 15A. Specific anti-regression invariants from production fixes

These rules come from prior production incidents and must not be “simplified” without dedicated tests:

1. Formular attachments are copied into flows; they are not moved. The source rows/bytes remain intact.
2. Attachment copy may run through more than one documented link path. This redundancy is intentional and idempotent.
3. `linkFlowFormular` must treat the current flow differently from a different active flow; do not reintroduce an `already_on_flow` guard that rejects the flow currently being linked.
4. Pre-setting `formulare_{df,ord}.flow_id` must be awaited where the current lifecycle depends on it.
5. Cancelling or soft-deleting a flow must clean DF and ORD ALOP pointers according to the documented symmetric rules.
6. A self-heal query must not resurrect a cancelled flow pointer.
7. Soft-deleted flows must not count as active or approved.
8. Revision attachment/capture copies preserve historical provenance according to existing tests.
9. In traceability UI and services, an ORD card displays the ORD's own `nr_ordonant_pl`, not the shared DF registration number.
10. `flow_id` from the route/caller is authoritative; a JSONB copy is compatibility data only.

Before changing any of these paths, locate and run the matching real-DB regression tests.

---

## 16. Database query and performance rules

- filter by dedicated indexed `org_id`, not JSONB org fields;
- use parameterized SQL;
- project only needed fields for listings;
- prefer appropriate window functions over duplicated count/list queries where existing patterns support it;
- avoid correlated queries when a safe indexed join is clearer;
- be careful: widening a SELECT can change authorization behavior if downstream code checks whether a projected field exists;
- use transactions for multi-write state changes;
- use `SELECT ... FOR UPDATE` when serializing a financial/state transition is required;
- do not hold DB transactions open across remote network calls.

Do not optimize SQL solely from appearance. Verify with tests and, for important queries, execution plans on a realistic dataset.

---

## 17. Database migrations — safety policy

DocFlowAI currently has two historical migration systems:

1. inline migrations in `server/db/index.mjs`, run first;
2. file-based migrations in `server/db/migrations/`, run later.

This architecture has caused production incidents and fresh-provision schema gaps.

### Mandatory safety rules

- never edit, delete or force-rerun an applied migration ID;
- never modify `server/db/migrate.mjs` to add force-rerun behavior;
- never add `DELETE FROM schema_migrations` logic;
- never use `DROP`, `TRUNCATE`, destructive `DELETE`, `DROP COLUMN` or `DROP CONSTRAINT` without explicit owner approval;
- use idempotent `CREATE ... IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` where appropriate;
- use guarded constraint creation because PostgreSQL lacks `ADD CONSTRAINT IF NOT EXISTS`;
- a new `NOT NULL` column on existing data needs a safe default/backfill plan;
- test both upgraded and fresh-provision schemas;
- a migration that merely avoids rollback is not sufficient: verify that the intended columns/constraints actually exist on a fresh DB;
- inspect Railway logs for `DB ready`, but do not treat that alone as schema proof;
- real DB tests are mandatory.

### Conflict rule for migration placement

Historical documentation contains conflicting rules about whether all new migrations must be inline or whether changes to V4-owned tables must be file-based.

Therefore:

- do not create a migration unless the current task explicitly states the approved migration location;
- if the task touches a table originally owned by a file-based migration, or if placement is ambiguous, STOP and ask/report before writing the migration;
- never invent a third workaround using guarded inline migrations that silently skip on fresh provision;
- prefer an add-only forward migration with a fresh-provision test once the owner-approved location is clear.

### Required migration verification

For migration work, verify:

1. current DB upgrade path;
2. fresh DB bootstrap;
3. actual schema objects after bootstrap;
4. `npm run test:db` genuinely passes;
5. no migration was skipped silently;
6. package and lockfile remain synchronized if dependencies changed;
7. staging deploy and functional smoke test;
8. backup/rollback plan before production.

Never deploy a migration directly to production from an autonomous agent.

---

## 18. External services and timeouts

External integrations include Resend, Meta/WhatsApp, Google Drive/Workspace, STS, DigiCert TSA, Web Push and the Java PAdES service.

Rules:

- preserve existing idempotency keys and webhook verification;
- do not expose credentials in code, logs, tests or commits;
- use explicit timeouts and cancellation for outbound calls when changing an integration;
- do not hold a DB transaction open while waiting for an external service;
- classify failures as retryable/non-retryable;
- keep critical state changes and async notification delivery separated through existing outbox/job patterns where available;
- provider failures must not silently corrupt workflow state.

The Java signing client currently has known timeout/authentication concerns, but it is a NO-TOUCH area unless explicitly authorized.

---

## 19. Environment and secrets

Typical required variables include:

- `DATABASE_URL`;
- `JWT_SECRET` of adequate entropy;
- `PUBLIC_BASE_URL`;
- `CORS_ORIGIN`;
- `RESEND_API_KEY`;
- `MAIL_FROM`;
- provider-specific signing and integration variables.

Never read, print, copy, commit or request production `.env` values.
Never put real secrets into prompts, tests, fixtures, screenshots, logs or Git history.
Use placeholders in documentation and test-only values in tests.

If a task changes environment configuration:

- update `env.example` when authorized;
- document safe rollout order;
- ensure missing configuration fails safely;
- do not modify Railway production variables autonomously.

---

## 20. Versioning and package files

- Keep `package.json` and `package-lock.json` synchronized.
- Railway runs `npm ci`; a lockfile mismatch can break deploy.
- Do not install a dependency without explaining why and obtaining any required network approval.
- For frontend assets, follow targeted cache-busting rules.
- For backend-only changes, do not perform a global `?v=` replacement.
- Report the final application version and Service Worker cache version when changed.

---


## 20A. ANAF treasury reference data

The committed source of truth for Romanian treasury reference data is:

```text
server/services/verify/data/trezorerii-anaf.json
```

It is generated by `tools/scrape-trezorerii-anaf.mjs` from official ANAF pages and consumed by the IBAN validator.

Rules:

- do not reintroduce a second hardcoded treasury list in application code;
- preserve deterministic sorting and the documented character normalization;
- review `tools/output/trezorerii-diff.md` before accepting refreshed data;
- commit only the reviewed JSON source, not ignored local reports;
- run the relevant tests after refresh;
- do not fabricate or infer missing treasury entries.

---

## 21. Testing strategy by risk

For every change, add the smallest tests that prove the acceptance criteria and prevent regression.

Consider:

- unit tests for pure helpers;
- Supertest integration tests for middleware order, headers and route behavior;
- real-DB characterization tests for SQL/state/authz;
- cross-tenant tests;
- unauthorized/forbidden cases;
- stale session and soft-deleted user cases;
- idempotent retry and duplicate submission cases;
- concurrency/double-click cases;
- static source regression tests for Service Worker safety when browser-level tests are unavailable;
- staging manual checks for browser cache, PWA behavior and Railway deployment.

Do not weaken assertions or remove tests to make the suite green. Fix fixtures when a previously hidden unsafe fallback is removed.
Report every existing test fixture modified and why.

---

## 22. Change workflow for autonomous implementation

Unless the current prompt specifies a stricter flow:

1. verify clean working tree and authorized branch;
2. pull with `--ff-only`;
3. verify baseline version/preconditions;
4. read this file, the relevant code and relevant tests;
5. run baseline tests for the affected area;
6. state a concise implementation plan;
7. make minimal changes;
8. add/update tests;
9. run focused tests;
10. run `npm run check` and `npm test`;
11. run real DB tests when required;
12. inspect `git status --short` and full diff;
13. verify no secrets, NO-TOUCH files or unrelated changes;
14. stage explicit paths only;
15. inspect cached diff;
16. commit with a clear message;
17. push only to the authorized branch;
18. report results and staging verification commands.

If any safety gate fails, stop before commit/push and report the exact failure.

---

## 23. Required final report

For implementation tasks, report:

1. branch and baseline commit/version;
2. root cause and chosen fix;
3. files changed;
4. tests added or updated;
5. focused test output;
6. `npm run check` result;
7. `npm test` result and total tests, without treating skipped DB tests as passed;
8. real DB/CI status when required;
9. `git diff --check` result;
10. commit hash and push result;
11. final `git status --short`;
12. deviations from the prompt;
13. remaining risks and manual staging checks;
14. confirmation that `main` and NO-TOUCH files were not modified.

Be honest about anything not executed or not verified.
