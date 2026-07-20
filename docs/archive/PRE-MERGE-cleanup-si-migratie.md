---
prompt: PRE-MERGE
titlu: "chore+fix: scoate debug MYFLOWS + migrație de reconciliere organizations (fresh-provision gap)"
model_suggested: Opus 4.8
branch: develop
zona: server/routes/flows/crud.mjs (scoatere debug), server/db/index.mjs (migrație inline 097), teste
versiune_tinta: v3.9.691
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.689)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.
>
> Scopul acestui prompt: pregătește `develop` (v3.9.690) pentru un merge CURAT în `main`. Două lucruri,
> ambele mici, ambele sigure pe producție.

---

## CONTEXT

Înainte de a urca batch-ul (izolare #104 + fixtures + #ALOP-CAB) în producție, două fire trebuie legate:

1. **Linie de debug rămasă:** `console.error('MYFLOWS_DEBUG', ...)` în handlerul `/my-flows`
   (`server/routes/flows/crud.mjs`), rămasă din diagnosticul lui #104. Posibil doar în working tree local,
   nu comitată — verifică și scoate-o dacă există.

2. **Gol de fresh-provisioning în `organizations`** (descoperit de testul 7b): bootstrap-ul inline
   (`server/db/index.mjs:293`) creează `organizations` cu DOAR 3 coloane (`id`, `name`, `created_at`).
   V4 `001_organizations.sql` definește **18** coloane. Pe o bază unde `organizations` există deja din
   bootstrap, `CREATE TABLE IF NOT EXISTS` din V4 e sărit ⇒ celelalte 15 coloane sunt adăugate DOAR dacă
   există un `ALTER` inline. Azi doar `cab_compartiment` are `ALTER` inline (migrația 092). Restul:

   ```
   slug, cif, status, plan, signing_providers_enabled, signing_providers_config,
   settings, branding, compartimente, webhook_url, webhook_secret, webhook_events,
   webhook_enabled, updated_at
   ```

   Producția e OK azi — aceste coloane au crescut incremental (ex. `signing_providers_config` prin altă
   cale). DAR o bază genuin proaspătă (adică **onboarding-ul primăriei a doua**, dacă se face pe instanță
   nouă) ar rămâne fără ele, iar `/my-flows` ar da 500 pe `signing_providers_enabled` — exact ce a prins 7b.

⚠️ **Această migrație e precondiție pentru multi-tenant.** A doua primărie e un provisioning nou.

---

## PAS 0 — RECON (read-only)

```bash
grep -rn "MYFLOWS_DEBUG" server/ --include=*.mjs
cat server/db/migrations/001_organizations.sql        # sursa adevărului: 18 coloane
sed -n '293,313p' server/db/index.mjs                 # bootstrap inline: 3 coloane
grep -n "ALTER TABLE organizations ADD COLUMN" server/db/index.mjs   # ce e deja acoperit inline
grep -n "id: '096\|id: '095" server/db/index.mjs      # unde se termină lista de migrații → 097 e următorul
```

**Răspunde în raport:**
1. `MYFLOWS_DEBUG` — există în cod comitat, doar în working tree, sau deloc?
2. Ce coloane `organizations` au DEJA `ALTER TABLE ADD COLUMN IF NOT EXISTS` inline? (Ca să nu le dublezi — deși `IF NOT EXISTS` le face oricum idempotente.)
3. **VERIFICĂ TIPURILE exact din `001_organizations.sql`** — `signing_providers_enabled` e `TEXT[]`, `signing_providers_config` e `JSONB`, `webhook_events` e `TEXT[]` cu default `'{flow.completed}'`. O migrație care pune tipul greșit e mai rea decât golul.

---

## PAS 1 — Scoate debug-ul (dacă există)

Dacă `grep MYFLOWS_DEBUG` întoarce ceva:
- Șterge exact linia (și doar linia). Nu atinge logica din jur, nu atinge handlerul `catch`.
- Dacă e într-un `try` care a devenit gol după ștergere, verifică să rămână sintactic valid.

Dacă NU întoarce nimic: notează în raport „nu exista în cod" și treci mai departe. Nu inventa curățenii.

---

## PAS 2 — Migrația inline 097 de reconciliere

În `server/db/index.mjs`, imediat DUPĂ `096_uppercase_angajament_codes`, adaugă:

```js
{
  id: '097_reconcile_organizations_columns',
  sql: `
    -- SEC/PROVISION: bootstrap-ul inline creează organizations cu 3 coloane; V4 001 are 18.
    -- Pe o bază unde tabela există deja din bootstrap, CREATE TABLE IF NOT EXISTS din V4 e sărit,
    -- deci coloanele lipsesc pe fresh-provision. Aliniem la V4. ADD-ONLY, idempotent, fără DROP.
    -- Tipuri și defaults COPIATE EXACT din server/db/migrations/001_organizations.sql.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS slug                      TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cif                       TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status                    TEXT        NOT NULL DEFAULT 'active';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan                      TEXT        NOT NULL DEFAULT 'starter';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS signing_providers_enabled TEXT[]      NOT NULL DEFAULT ARRAY['local-upload'];
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS signing_providers_config  JSONB       NOT NULL DEFAULT '{}';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings                  JSONB       NOT NULL DEFAULT '{}';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branding                  JSONB       NOT NULL DEFAULT '{}';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS compartimente             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[];
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_url               TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_secret            TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_events            TEXT[]      NOT NULL DEFAULT '{flow.completed}';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_enabled           BOOLEAN     NOT NULL DEFAULT FALSE;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();

    -- slug UNIQUE NOT NULL în V4 — dar pe date existente slug poate fi NULL. NU forțăm NOT NULL aici
    -- (ar pica pe rânduri existente). Populăm slug lipsă din numele org-ului, apoi indexul unic.
    UPDATE organizations
       SET slug = lower(regexp_replace(COALESCE(name,'org'), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id
     WHERE slug IS NULL OR slug = '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_slug_uniq ON organizations(slug) WHERE slug IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_org_status ON organizations(status);
    CREATE INDEX IF NOT EXISTS idx_org_signing_providers ON organizations USING GIN (signing_providers_enabled);
  `
}
```

⚠️ **DE CE nu forțăm `slug NOT NULL`:** V4 declară `slug TEXT UNIQUE NOT NULL`, dar pe producție există
deja rânduri fără slug (a crescut fără el). Un `SET NOT NULL` ar pica migrația la boot pe un rând NULL —
și `DB_READY` n-ar mai fi setat (exact incidentul din aprilie cu migrația 055). Populăm slug-urile lipsă
dintr-un derivat determinist al numelui, apoi punem indexul unic PARȚIAL (`WHERE slug IS NOT NULL`).

⚠️ **Slug-ul derivat include `id`** ca să fie garantat unic (două primării „Primăria Comuna X" ar coliza
pe slug altfel). Verifică că nu există deja o convenție de slug în cod (`grep -rn "slug" server/routes/admin/organizations.mjs`) — dacă DA, folosește-o pe aceea, nu inventa alta.

⚠️ **Verifică `DEFAULT '{flow.completed}'` pe `webhook_events`** — sintaxa array-literal Postgres. Dacă
`001` folosește exact string-ul ăsta, copiază-l identic. Nu-l „îmbunătăți".

---

## PAS 3 — Test (⛔ IMPORTĂ / rulează pe Postgres real)

Golul ăsta a fost prins tocmai fiindcă schema de test diverge de producție. Testul trebuie să apere
INVARIANTA: după migrații, schema de test `organizations` are toate coloanele V4.

`server/tests/db/organizations-schema.test.mjs`:

1. după `migrate()`, `SELECT column_name FROM information_schema.columns WHERE table_name='organizations'`
   conține TOATE cele 18 coloane din V4 (listează-le explicit; comparație pe mulțime)
2. `INSERT INTO organizations (name) VALUES ('Test Fresh Org')` ⇒ reușește, iar rândul rezultat are
   `signing_providers_enabled = {local-upload}` (defaultul se aplică) — dovada că fresh-provision merge
3. după insert, `slug` NU e NULL (populat de migrație SAU de defaultul de insert) — sau, dacă e NULL pe
   insert minimal, `/my-flows`-style `SELECT signing_providers_enabled` NU crapă

⚠️ Testul `migrate()` helper a fost deja peticit la #104 cu un `ALTER` pentru `signing_providers_enabled`.
Acum migrația 097 acoperă asta CANONIC. **Scoate peticul ad-hoc din `migrate()`** dacă migrația 097 rulează
și în harness-ul de test — altfel ai două surse pentru aceeași coloană. Verifică cum aplică
`migrateForTests` lista de migrații inline: dacă include 097, peticul e redundant; dacă NU, lasă peticul
și notează în raport DE CE harness-ul nu rulează migrațiile inline.

---

## PAS 4 — Versiune

`package.json` → **v3.9.691**. Migrația nu atinge `public/` ⇒ fără `?v=`/`CACHE_VERSION`.

```bash
npm run check && npm test && npm run test:db
```

⚠️ Rulează `npm run test:db` pe Postgres REAL (PG 17 e disponibil local — vezi #104). NU declara verde
pe skip. Migrația 097 trebuie să ruleze efectiv o dată pe o bază de test și să nu arunce.

Commit:
```
chore+fix: scoate debug MYFLOWS + migrație 097 reconciliere organizations (fresh-provision) (v3.9.691)
```

---

## RAPORT FINAL

1. `MYFLOWS_DEBUG` — găsit unde? Scos? Sau nu exista în cod?
2. Migrația 097 rulează pe o bază de test REALĂ fără să arunce? Lipește confirmarea.
3. Pe o bază care are DEJA coloanele (simulează producția): 097 e no-op curat (toate `IF NOT EXISTS` sar)? Confirmă idempotența — rulează migrațiile de DOUĂ ori pe aceeași bază.
4. `slug` — ai găsit o convenție existentă de slug în cod? Ai folosit-o, sau ai derivat una nouă cu `id`?
5. Ai forțat `slug NOT NULL`? (**Trebuie să fie NU** — ar pica la boot pe rânduri existente.)
6. Peticul din `migrate()` de la #104 (`signing_providers_enabled`) — încă necesar, sau 097 îl face redundant? Ce ai făcut?
7. Testul de schemă (toate 18 coloanele prezente) — verde pe Postgres real? Lipește.
8. `npm test` + `npm run test:db` — separat, ambele verzi pe Postgres REAL (nu skip)?
9. `git diff --name-only` — lipește. Nimic din `public/`, nimic din `server/signing/`.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Migrația e **ADD-ONLY, idempotentă, fără DROP**, tipuri copiate EXACT din `001_organizations.sql`.
- ⛔ **Nu forța `slug NOT NULL`** — populează lipsă + index unic parțial.
- ⛔ Rulează 097 efectiv pe Postgres real ÎNAINTE de a declara verde. Un `RAISE` la boot = `DB_READY` never set = incident (aprilie 055).
- ⛔ Nu atinge alte tabele. Doar `organizations` + scoaterea liniei de debug.
- ⛔ Zona NO-TOUCH `server/signing/*` — neatinsă.
