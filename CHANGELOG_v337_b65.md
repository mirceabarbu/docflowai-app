# DocFlowAI v3.3.7 — Changelog (b65)

## Modificări față de b64

### 🟠 Security — SEC-02: pbkdf2Sync → async

---

#### b65 — 15.03.2026

**Problema:**
`hashPassword()` și `verifyPassword()` foloseau `crypto.pbkdf2Sync` care blochează
complet event loop-ul Node.js pe durata calculului. La 600k iterații (OWASP 2025),
fiecare login durează ~400-600ms de blocking sincronic. Cu 10 cereri simultane de
login, serverul este complet paralizat.

**Fix: migrare la `crypto.pbkdf2` async via `util.promisify`.**

**Fișiere modificate:**

`server/middleware/auth.mjs`
- Import `util` + `const _pbkdf2 = util.promisify(crypto.pbkdf2)`
- `hashPassword()` → `async function hashPassword()`, folosește `await _pbkdf2(...)`
- `verifyPassword()` → `async function verifyPassword()`, folosește `await _pbkdf2(...)`
- Ambele versiuni de hash (v1 legacy 100k + v2 curent 600k) sunt async

`server/routes/auth.mjs`
- `verifyPassword(...)` → `await verifyPassword(...)` în handler-ul login
- `hashPassword(password)` → `await hashPassword(password)` în lazy re-hash (v1→v2)
- `verifyPassword(current_password, ...)` → `await` în `/auth/change-password`
- `hashPassword(new_password)` → `await` în `/auth/change-password`

`server/routes/admin.mjs`
- 4 apeluri `hashPassword(...)` → `await hashPassword(...)`:
  - `POST /admin/users` (creare user)
  - `PUT /admin/users/:id` (schimbare parolă opțională)
  - `POST /admin/users/:id/reset-password`
  - `POST /admin/users/:id/send-credentials`

`server/db/index.mjs`
- Import `util` + `const _pbkdf2 = util.promisify(crypto.pbkdf2)`
- `_hashPasswordLocal()` → `async function _hashPasswordLocal()` (folosit doar la
  crearea adminului inițial la primul boot — o singură dată în viața aplicației)
- Caller `_hashPasswordLocal(pwd)` → `await _hashPasswordLocal(pwd)`

`server/tests/unit/auth-crypto.test.mjs`
- Toate `it(...)` → `it(..., async () => {`
- `hashPassword(...)` → `await hashPassword(...)`
- `verifyPassword(...).ok` → `(await verifyPassword(...)).ok` (precedență operator)

`server/tests/integration/login.test.mjs`
- `function makeUser` → `async function makeUser`
- `hashPassword(pwd)` → `await hashPassword(pwd)`
- `makeUser(...)` → `await makeUser(...)`

**`package.json`**
- Version bump `3.3.24` → `3.3.25`

---

### Rezultat teste

```
Tests  4 failed | 28 passed (32)
```

Cele 4 eșecuri sunt **pre-existente din b64** (bug-uri în mock-ul pool.query din
`login.test.mjs` — incomplete setup pentru teste avansate). Zero regresii introduse
de SEC-02. Verificat prin rulare comparativă b64 vs b65.

---

### Stare completă fixes

| ID | Build | Status | Descriere |
|---|---|---|---|
| BUG-01 | b61 | ✅ | `db.query` → `pool.query` în reinitiate |
| BUG-02 | b61 | ✅ | `signersTable` în HTML send-email |
| BUG-03 | b61 | ✅ | Status mapping corectat în send-email |
| BUG-04 | b61 | ✅ | Versioning unificat la 3.3.7 |
| SEC-01 | b63 | ✅ | DROP `plain_password` (migrare 027) |
| PERF-01 | b64 | ✅ | Index `notifications(flow_id)` (migrare 028) |
| SEC-02 | b65 | ✅ | `pbkdf2Sync` → async (event loop liber) |

### ⚠️ Known issues rămase

| ID | Severitate | Descriere |
|---|---|---|
| SEC-03 | 🟡 | ADMIN_SECRET rate limit in-memory (resetat la restart) |
| ARCH-04 | 🟠 | `getUserMapForOrg` fără cache |
