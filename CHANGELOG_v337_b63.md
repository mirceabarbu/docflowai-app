# DocFlowAI v3.3.7 — Changelog (b63)

## Modificări față de b62

### 🔴 Hotfix — migrare 027 crash la retry

---

#### b63 — 15.03.2026

**`server/db/index.mjs`**

- **Hotfix: pre-check migrare 027 crash în tranzacție PG la al doilea attempt**

  **Cauza (bug în b62):**
  La primul deploy Railway, `ALTER TABLE DROP COLUMN` a rulat și a șters coloana `plain_password`.
  Tranzacția nu s-a committed (server restart în mijlocul migrării), deci migrarea 027 nu apărea
  în `schema_migrations`. La re-pornire (attempt 2+), pre-check-ul făcea:
  ```sql
  SELECT COUNT(*) FROM users WHERE plain_password IS NOT NULL
  ```
  pe o coloană care nu mai exista → `ERROR: column "plain_password" does not exist` →
  PostgreSQL abortează **întreaga tranzacție** → toate query-urile ulterioare eșuează →
  `DB init failed permanent. Exiting.`

  **Fix:**
  Pre-check-ul verifică acum **mai întâi existența coloanei** via `information_schema.columns`
  (interogare sigură, nu poate crapa):
  - Dacă coloana **există** → face COUNT și loghează situația, apoi continuă cu DROP
  - Dacă coloana **nu mai există** → loghează și sare direct la `ALTER TABLE IF EXISTS` (no-op)

**`package.json`**

- Version bump `3.3.22` → `3.3.23`

---

### Ce vei vedea în Railway logs la deploy b63

**Scenariul tău actual** (coloana a fost deja ștearsă de b62):
```
INFO  SEC-01: plain_password — coloana nu mai există (attempt anterior). ALTER IF EXISTS va fi no-op.
INFO  Migrare: 027_drop_plain_password...
INFO  Migrare aplicata cu succes. { migrationId: '027_drop_plain_password' }
INFO  DB ready.
```

**Scenariul normal** (prima rulare, coloana există dar e goală):
```
INFO  SEC-01: plain_password — coloana goală. DROP sigur.
INFO  Migrare: 027_drop_plain_password...
INFO  Migrare aplicata cu succes. { migrationId: '027_drop_plain_password' }
INFO  DB ready.
```
