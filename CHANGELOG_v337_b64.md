# DocFlowAI v3.3.7 — Changelog (b64)

## Modificări față de b63

### 🟢 Performanță

---

#### b64 — 15.03.2026

**`server/db/index.mjs`**

- **PERF-01 — Migrare 028: index `notifications(flow_id)`**

  Adăugat index `idx_notif_flow_id` pe coloana `flow_id` din tabela `notifications`.

  **De ce:** Query-urile `DELETE FROM notifications WHERE flow_id=$1 AND type IN (...)`
  se execută la fiecare acțiune din flux — sign, refuse, cancel, delegate, reinitiate.
  Fără index, PostgreSQL face **full table scan** pe întreaga tabelă de notificări la fiecare
  astfel de operație. Cu 500 notificări/user × N useri activi, latența crește liniar.

  **Impact:** Zero risc de regresie — un index nu modifică comportamentul, doar viteza.
  Creare cu `IF NOT EXISTS` — sigur la orice re-rulare.

  **Notă tehnică:** S-a ales `CREATE INDEX` standard (non-CONCURRENT) deoarece migrările
  rulează în tranzacție. Pe scala acestei instalări (sute–mii de rânduri), lock-ul de
  creare durează milisecunde. `CONCURRENTLY` ar necesita rulare în afara tranzacției.

**`package.json`**

- Version bump `3.3.23` → `3.3.24`

---

### Ce vei vedea în Railway logs la deploy b64

```
INFO  Migrare: 028_index_notifications_flow_id...
INFO  Migrare aplicata cu succes. { migrationId: '028_index_notifications_flow_id' }
INFO  DB ready.
```

---

### Stare fixes după b64

| ID | Status | Descriere |
|---|---|---|
| BUG-01 | ✅ b61 | `db.query` → `pool.query` în reinitiate |
| BUG-02 | ✅ b61 | `signersTable` adăugat în HTML send-email |
| BUG-03 | ✅ b61 | Status mapping corectat în send-email |
| BUG-04 | ✅ b61 | Versioning unificat la 3.3.7 |
| SEC-01 | ✅ b63 | `plain_password` DROP (migrare 027) |
| PERF-01 | ✅ b64 | Index `notifications(flow_id)` (migrare 028) |

### ⚠️ Known issues rămase

| ID | Severitate | Descriere |
|---|---|---|
| SEC-02 | 🟠 | `pbkdf2Sync` blochează event loop — migrare la async |
| SEC-03 | 🟡 | ADMIN_SECRET rate limit in-memory (resetat la restart) |
| ARCH-04 | 🟠 | `getUserMapForOrg` fără cache |
