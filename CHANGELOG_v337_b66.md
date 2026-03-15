# DocFlowAI v3.3.7 — Changelog (b66)

## Modificări față de b65

### 🟠 Performanță — ARCH-04: cache getUserMapForOrg

---

#### b66 — 15.03.2026

**Problema:**
`getUserMapForOrg(orgId)` executa un `SELECT email,functie,compartiment,institutie FROM users`
la fiecare apel `GET /flows/:flowId` și `GET /my-flows`. Datele userilor se schimbă rar
(doar la POST/PUT/DELETE din admin panel), deci query-ul era redundant la fiecare request.

**Fix: cache în-process per `org_id` cu TTL 60 secunde + invalidare explicită.**

---

**`server/db/index.mjs`**

- `const _userMapCache = new Map()` — cache per org (`orgId` sau `'all'` pentru fallback)
- `const USER_MAP_CACHE_TTL = 60_000` — TTL 60 secunde
- `getUserMapForOrg()` verifică cache-ul înainte de query; populează la miss
- `export function invalidateOrgUserCache(orgId)` — invalidare:
  - `orgId` valid → șterge doar entry-ul org-ului respectiv
  - `orgId` null/0 → `_userMapCache.clear()` (fallback sigur)

**`server/routes/admin.mjs`**

- Import `invalidateOrgUserCache` din `db/index.mjs`
- Apel invalidare în 3 locuri:
  - `POST /admin/users` (creare) → `invalidateOrgUserCache(insertOrgId)`
  - `PUT /admin/users/:id` (editare) → `invalidateOrgUserCache(rows[0].org_id)`
  - `DELETE /admin/users/:id` (ștergere) → `invalidateOrgUserCache(actorOrgId)`

**`package.json`** — version bump `3.3.25` → `3.3.26`

---

### Comportament

- **La GET /flows/:id sau GET /my-flows**: primul request populează cache-ul; toate
  requesturile din următoarele 60s returnează date din memorie fără query DB
- **La modificare user din admin**: cache-ul org-ului afectat este invalidat imediat;
  următorul request va face query proaspăt
- **La restart Railway**: cache-ul e în memorie — se repopulează la primul request (normal)

---

### Stare completă fixes

| ID | Build | Status | Descriere |
|---|---|---|---|
| BUG-01/02/03/04 | b61 | ✅ | Bug-uri flows.mjs + versioning |
| SEC-01 | b63 | ✅ | DROP `plain_password` |
| PERF-01 | b64 | ✅ | Index `notifications(flow_id)` |
| SEC-02 | b65 | ✅ | `pbkdf2Sync` → async |
| ARCH-04 | b66 | ✅ | Cache `getUserMapForOrg` (TTL 60s) |

### ⚠️ Known issues rămase

| ID | Severitate | Descriere |
|---|---|---|
| SEC-03 | 🟡 | ADMIN_SECRET rate limit in-memory (resetat la restart) |
