# DocFlowAI v3.3.7 — Changelog (b67)

## Modificări față de b66

### 🟡 Security — SEC-03: ADMIN_SECRET rate limit persistent în DB

---

#### b67 — 15.03.2026

**Problema:**
Rate limiter-ul pentru `ADMIN_SECRET` (bypass admin) folosea un `Map()` în memorie
(`_adminAttempts`). La fiecare restart Railway (deploy, crash, scale), contoarele se
resetau complet. Un atacator putea face 5 încercări, provoca un restart al serverului
(ex. prin eroare), și repeta la infinit.

**Fix: reutilizare `login_blocks` (tabelă DB existentă) via același pattern de
injectare ca `injectRateLimiter()` pentru login normal.**

---

**`server/middleware/auth.mjs`**

- Eliminat: `_adminAttempts` Map, `setInterval` cleanup, `_adminRlBlocked()`, `_adminRlFail()`
- Adăugat: `injectAdminRateLimiter(check, record, clear)` — exportat, injectează 3 funcții async
- `requireAdmin()` → `async function requireAdmin()`:
  - Check blocare: `await _adminCheckRate(req, ip)`
  - Secret greșit: `await _adminRecordFail(req, ip)`
  - Secret corect: `await _adminClearRate(req, ip)`
- Fallback no-op dacă funcțiile nu sunt injectate (teste, medii fără DB)

**`server/index.mjs`**

- Import `injectAdminRateLimiter` din `./routes/auth.mjs`
- Apel `injectAdminRateLimiter(...)` cu aceleași funcții `checkLoginRate` /
  `recordLoginFail` / `clearLoginRate` — reutilizare completă a logicii DB existente
- Cheia de rate limit folosită: IP-ul requestului (nu email — ADMIN_SECRET nu are email)

**`server/routes/flows.mjs`** — 3 apeluri `requireAdmin()` → `await requireAdmin()`

**`server/routes/admin/outreach.mjs`** — 10 apeluri → `await requireAdmin()`

**`server/index.mjs`** — 2 apeluri `/admin/health` și `/metrics` → `await requireAdmin()`

**`package.json`** — version bump `3.3.26` → `3.3.27`

---

### Comportament după fix

- Blocările ADMIN_SECRET supraviețuiesc restart-urilor Railway
- Același TTL ca login normal (configurat via `LOGIN_WINDOW_SEC`, `LOGIN_BLOCK_SEC`)
- Cleanup automat via intervalul existent din `index.mjs` (30 min)
- La succes: `login_blocks` entry șters (același comportament ca `clearLoginRate`)

---

### ✅ Lista completă de fixes — FINALIZATĂ

| ID | Build | Descriere |
|---|---|---|
| BUG-01/02/03/04 | b61 | Bug-uri flows.mjs + versioning |
| SEC-01 | b63 | DROP `plain_password` |
| PERF-01 | b64 | Index `notifications(flow_id)` |
| SEC-02 | b65 | `pbkdf2Sync` → async |
| ARCH-04 | b66 | Cache `getUserMapForOrg` (TTL 60s) |
| SEC-03 | b67 | ADMIN_SECRET rate limit persistent în DB |

Toate fix-urile planificate din analiza v3.3.7 au fost implementate și testate.
