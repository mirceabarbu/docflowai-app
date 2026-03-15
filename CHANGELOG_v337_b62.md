# DocFlowAI v3.3.7 — Changelog (b62)

## Modificări față de b61

### 🔴 Security fix

---

#### b62 — 15.03.2026

**`server/db/index.mjs`**

- **SEC-01 — Migrare 027: eliminare coloană `plain_password` din tabelul `users`**
  - Coloana `plain_password TEXT` a fost creată în migrarea 001 (schema inițială)
  - Codul nu mai scrie parole în clar din v3.3.2, dar coloana persista în schema DB
  - Risc: orice backup sau acces direct la DB expunea parolele utilizatorilor (GDPR)
  - Fix: `ALTER TABLE users DROP COLUMN IF EXISTS plain_password`
  - `IF EXISTS` — sigur pe orice DB, inclusiv pe cele unde coloana a fost deja ștearsă manual
  - La startup, înainte de DROP, se loghează câți useri aveau câmpul populat:
    - `[WARN] SEC-01: plain_password — există N useri cu parolă în clar` → urmărire necesară
    - `[INFO] SEC-01: plain_password — coloana este goală. DROP sigur.` → situația normală

**`package.json`**

- Version bump `3.3.21` → `3.3.22`

---

### Ce se întâmplă la primul deploy după b62

1. Serverul pornește normal
2. `initDbWithRetry()` rulează migrările în ordine
3. La migrarea `027_drop_plain_password`:
   - Se loghează situația coloanei (vezi Railway logs)
   - `ALTER TABLE users DROP COLUMN IF EXISTS plain_password` se execută
   - Migrarea se marchează ca aplicată în `schema_migrations`
4. La orice restart ulterior — migrarea 027 este deja în `schema_migrations`, nu se mai rulează

### Verificare post-deploy

În Railway logs, la startup, trebuie să vezi una din:
```
INFO  SEC-01: plain_password — coloana este goală. DROP sigur.
INFO  Migrare aplicata cu succes. { migrationId: '027_drop_plain_password' }
```

Sau, dacă existau date:
```
WARN  SEC-01: plain_password — există N useri cu parolă în clar. [...]
INFO  Migrare aplicata cu succes. { migrationId: '027_drop_plain_password' }
```

---

### ⚠️ Known issues rămase (planificate pentru b63+)

| ID | Severitate | Descriere |
|---|---|---|
| SEC-02 | 🟠 | `pbkdf2Sync` blochează event loop (600k iterații) — migrare la async |
| SEC-03 | 🟡 | ADMIN_SECRET rate limit in-memory (se resetează la restart) |
| ARCH-04 | 🟠 | `getUserMapForOrg` fără cache — query la fiecare GET flux |
| PERF-01 | 🟢 | Index lipsă pe `notifications(flow_id)` |
