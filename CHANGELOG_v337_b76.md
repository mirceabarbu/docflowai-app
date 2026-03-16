# DocFlowAI v3.3.7 — Changelog (b76)

## Modificări față de b75

### 🔴 Bug fix — creare și copiere șabloane eșua cu server_error

#### b76 — 16.03.2026

**Fișier:** `server/index.mjs` — handler-ele `POST /api/templates` și `PUT /api/templates/:id`.

**Problema:**
`POST /api/templates` (creare șablon nou + copiere șablon instituție) făcea INSERT
fără coloana `org_id`. În producție, tabela `templates` are FK:
`FOREIGN KEY (org_id) REFERENCES organizations(id)` — INSERT-ul crăpa cu eroare DB,
prinsă silențios → `server_error` fără detalii în log.

**Fix `POST /api/templates`:**
- Citire `org_id` din DB alături de `institutie` (un singur query, nu două)
- Adăugare `org_id` în INSERT: `(user_email, institutie, name, signers, shared, org_id)`
- Adăugare `logger.error` în catch — erori viitoare apar în Railway logs

**Fix `PUT /api/templates/:id`:**
- Adăugare `logger.error` în catch pentru debug mai ușor

**`package.json`** — version bump `3.3.35` → `3.3.36`
