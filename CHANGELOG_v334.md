# DocFlowAI v3.3.4 — Changelog

## Modificări față de v3.3.3

### 🔴 Securitate

**SEC-02: ADMIN_SECRET rate limiting + audit log**
- `server/middleware/auth.mjs`: `requireAdmin()` blochează IP-ul după 5 încercări eșuate cu `x-admin-secret` greșit (fereastră 1 min, blocare 5 min)
- Fiecare acces reușit via `ADMIN_SECRET` → scriere automată în `audit_log` cu IP, metodă HTTP, URL
- Feedback diferit pentru "secret greșit" vs "IP blocat"

**SEC-03: PBKDF2 upgrade 100k → 600k iterații (OWASP 2025)**
- `hashPassword()` generează acum hash-uri cu prefix `v2:` și 600.000 iterații
- `verifyPassword()` returnează `{ ok: boolean, needsRehash: boolean }` — detectează automat v1 (100k) vs v2 (600k)
- **Lazy re-hash transparent**: la primul login reușit cu hash vechi (v1), parola e re-hashată cu v2 și salvată în DB fără intervenție manuală
- Nicio sesiune nu e întreruptă — backward compat complet

**SEC-04: innerHTML audit + fix XSS în admin.html**
- `f.docName`, `f.initEmail`, `current.name/email` — escaped cu `escH()` în lista fluxuri admin
- `f.docName`, `f.institutie`, `f.compartiment` — escaped în preview arhivare
- `onclick` handlers cu `flowId` și `email` — escaped cu `escH()`
- URL `href="/flow.html?flow=..."` → `encodeURIComponent()` aplicat corect

### 🟡 Performanță DB

**PERF-01: 3 indexuri JSONB noi (Migration 021)**
- `idx_flows_active` — partial index pe fluxuri active (reminder job, lista admin "în lucru")
- `idx_flows_init_org` — index compus `(org_id, initEmail, updated_at)` pentru "Fluxurile mele"
- `idx_flows_org_status` — index compus `(org_id, status, created_at)` pentru filtrare admin

**Migration 022: coloana `hash_algo`**
- Coloana `hash_algo TEXT DEFAULT 'pbkdf2_v1'` pe tabelul `users`
- Update automat la `pbkdf2_v2` pentru hash-urile deja migrate (prefix `v2:`)

### 🟢 Logging structurat (LOG-01)

**`server/middleware/logger.mjs`** — Logger nou, zero dependențe externe
- Output JSON lines (compatibil Railway log aggregation, Datadog, Grafana Loki)
- Nivele: debug / info / warn / error
- Configurabil via `LOG_LEVEL=debug|info|warn|error` și `LOG_PRETTY=1` (pentru development)
- Suport `logger.child({ requestId })` pentru context per-request
- Înlocuiește **toate** `console.log/warn/error` din: `index.mjs`, `db/index.mjs`, `routes/auth.mjs`, `routes/admin.mjs`, `routes/flows.mjs`, `mailer.mjs`, `push.mjs`

### 🟢 Health endpoint îmbunătățit

**GET /health** — acum include: uptime, memory RSS/heap

**GET /admin/health** — acum include: DB latency ping, WS clients count, memory

## Fișiere modificate
- `server/middleware/auth.mjs` ← modificat major
- `server/middleware/logger.mjs` ← **fișier nou**
- `server/db/index.mjs` ← migrations 021 + 022 + logger
- `server/routes/auth.mjs` ← lazy re-hash + logger
- `server/routes/admin.mjs` ← logger
- `server/routes/flows.mjs` ← logger
- `server/index.mjs` ← logger + health endpoint
- `server/mailer.mjs` ← logger
- `server/push.mjs` ← logger
- `public/admin.html` ← XSS fixes innerHTML
- `package.json` ← version 3.3.4

## Upgrade fără downtime
1. Deploy normal (Railway rebuild automat)
2. La startup, migrationele 021 și 022 rulează automat
3. Re-hash-ul parolelor se face transparent la fiecare login succesat
4. Nicio acțiune manuală necesară
