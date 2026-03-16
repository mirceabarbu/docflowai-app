# DocFlowAI v3.3.7 — Changelog (b61)

## Modificări față de b60

### 🔴 Bug fixes critice

---

#### b61 — 15.03.2026

**`server/routes/flows.mjs`**

- **BUG-01 — `ReferenceError: db is not defined` în `POST /flows/:id/reinitiate`**
  - Blocul de copiere atașamente folosea variabila `db` care nu exista în scope
  - `flows.mjs` importă `pool`, nu `db` — toate apelurile `db.query(...)` → `pool.query(...)`
  - Efect anterior: crash garantat la orice reinițiere care implica atașamente

- **BUG-02 — `signersTable` construit dar neutilizat în `POST /flows/:id/send-email`**
  - Tabelul HTML cu semnatarii și statusurile era generat în variabila `signersTable`
    dar nu era inclus în template-ul `html` final
  - Adăugat bloc dedicat „Semnatari" în email, între Info card și corpul personalizat
  - Efect anterior: destinatarul extern nu vedea lista semnatarilor în email

- **BUG-03 — Status mapping greșit în `POST /flows/:id/send-email`**
  - `s.signed` și `s.refused` nu există pe obiectul semnatar; câmpul real este `s.status`
  - `s.signed ? 'semnat' : ...` → `s.status === 'signed' ? 'semnat' : ...`
  - Efect anterior: toți semnatarii apăreau cu statusul „în așteptare" indiferent de starea reală

**`server/index.mjs`**

- **BUG-04 — Versioning inconsistent**
  - `/health` și `/admin/health` returnau `version: '3.3.5'` → corectat la `'3.3.7'`
  - Logger la startup afișa `'DocFlowAI v3.3.5 server pornit'` → corectat la `v3.3.7`

**`README.md`**

- Header actualizat de la `v3.3.6` la `v3.3.7`

**`package.json`**

- Version bump `3.3.20` → `3.3.21`

---

### ⚠️ Known issues rămase (planificate pentru b62+)

| ID | Severitate | Descriere |
|---|---|---|
| SEC-01 | 🔴 | Coloana `plain_password` în schema DB — necesită migrare DROP COLUMN |
| SEC-02 | 🟠 | `pbkdf2Sync` blochează event loop (600k iterații) — migrare la async |
| SEC-03 | 🟡 | ADMIN_SECRET rate limit in-memory (se resetează la restart) |
| ARCH-04 | 🟠 | `getUserMapForOrg` fără cache — query la fiecare GET flux |
| PERF-01 | 🟢 | Index lipsă pe `notifications(flow_id)` |
