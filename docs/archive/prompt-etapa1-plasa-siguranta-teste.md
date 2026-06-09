# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire ca referință): `server/routes/flows/signing.mjs`,
> `bulk-signing.mjs`, `cloud-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`,
> `server/signing/providers/STSCloudProvider.mjs`.

---

## Obiectiv (Etapa 1 din planul de stabilizare formulare)

Construim o **plasă de siguranță**: un al doilea nivel de teste care rulează pe **PostgreSQL real**
(nu mock-uri poziționale pe `pool.query`) și **captează comportamentul ACTUAL** al zonelor cu cele
mai multe regresii (liste DF/ORD, ștergere, cancel ALOP, relink revizii). Scopul: să putem
refactoriza ulterior SQL-ul / regulile fără frică, pentru că testele verifică **rezultatul**
(status code + ce s-a scris în DB), nu ordinea apelurilor.

### Constrângeri dure (fără regresii)

1. **Suita existentă rămâne 100% neatinsă.** Cele 758 teste mock-uite din `server/tests/**` + `server/services/**/__tests__/**`
   (în afară de `server/tests/db/**`) rulează exact ca acum cu `npm test`.
2. **`npm test` rămâne verde și fără Postgres local.** Testele noi NU se rulează prin `npm test`;
   au scriptul lor `npm run test:db` și un config separat. Dacă lipsește `TEST_DATABASE_URL`,
   se auto-skip cu mesaj clar (zero erori).
3. **Producția (Railway) neafectată.** Singura atingere de cod runtime e un `ssl` condiționat
   (default = ca acum) și două export-uri noi folosite doar de teste.

---

## Patch 1 — `server/db/index.mjs`: SSL condiționat + export pentru migrări în teste

### 1a — SSL condiționat (Postgres local/CI nu are SSL)

**old_str**
```
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
```
**new_str**
```
      connectionString: DATABASE_URL,
      // Railway cere SSL (default). Testele pe Postgres local/CI setează DB_DISABLE_SSL=1.
      ssl: process.env.DB_DISABLE_SSL === '1' ? false : { rejectUnauthorized: false },
```

### 1b — export helper de migrare pentru teste (idempotent, folosit DOAR de teste)

Inserează imediat după linia `export function markDbReady() { ... }`.

**old_str**
```
export function markDbReady() { DB_READY = true; DB_LAST_ERROR = null; }
```
**new_str**
```
export function markDbReady() { DB_READY = true; DB_LAST_ERROR = null; }

// Folosit DOAR de harness-ul de teste (server/tests/helpers/db-real.mjs).
// Aplică întreaga listă MIGRATIONS pe pool-ul curent (idempotent via schema_migrations),
// apoi marchează DB_READY=true ca rutele să nu mai răspundă 503.
export async function migrateForTests() {
  if (!pool) throw new Error('migrateForTests: DATABASE_URL/TEST_DATABASE_URL lipsește');
  const client = await pool.connect();
  try {
    await runMigrations(client);
  } finally {
    client.release();
  }
  markDbReady();
}
```

---

## Patch 2 — `vitest.config.mjs`: exclude testele DB din rularea mock-uită

`server/tests/db/**` rulează prin config-ul propriu (Patch 4), NU prin `npm test`.

**old_str**
```
    // Pattern fișiere de test
    include: ['server/tests/**/*.test.mjs', 'server/services/**/__tests__/*.test.mjs'],
```
**new_str**
```
    // Pattern fișiere de test
    include: ['server/tests/**/*.test.mjs', 'server/services/**/__tests__/*.test.mjs'],

    // Testele pe Postgres real au config propriu (vitest.config.db.mjs) + `npm run test:db`.
    exclude: ['**/node_modules/**', 'server/tests/db/**'],
```

---

## Patch 3 — `server/tests/setup.mjs`: bridge TEST_DATABASE_URL (no-op pentru testele mock)

Setarea e inofensivă pentru testele mock-uite (ele înlocuiesc complet modulul `db/index.mjs`
prin `vi.mock`, deci pool-ul real nu se creează niciodată).

**old_str**
```
// ── Cleanup după toate testele ────────────────────────────────────────────────
// (nimic de cleanup global deocamdată — fiecare test suite face cleanup propriu)
```
**new_str**
```
// ── Postgres real (doar pentru server/tests/db/**) ───────────────────────────
// Dacă există TEST_DATABASE_URL, îl punem pe DATABASE_URL ÎNAINTE ca db/index.mjs
// să fie importat (pool-ul se creează la import). Testele mock-uite ignoră complet
// asta (înlocuiesc modulul prin vi.mock).
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DATABASE_URL) {
  process.env.DB_DISABLE_SSL = '1';
}

// ── Cleanup după toate testele ────────────────────────────────────────────────
// (nimic de cleanup global deocamdată — fiecare test suite face cleanup propriu)
```

---

## Patch 4 — fișier nou `vitest.config.db.mjs` (config dedicat testelor pe Postgres real)

**CREATE** `vitest.config.db.mjs`:
```js
/**
 * DocFlowAI — Vitest config pentru testele pe Postgres REAL.
 *   npm run test:db    — rulează server/tests/db/** pe TEST_DATABASE_URL
 *
 * Diferențe față de vitest.config.mjs:
 *  - include DOAR server/tests/db/**
 *  - fileParallelism: false (un singur DB partajat → fără curse pe TRUNCATE)
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./server/tests/setup.mjs'],
    include: ['server/tests/db/**/*.test.mjs'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporter: 'verbose',
  },
});
```

---

## Patch 5 — fișier nou `server/tests/helpers/db-real.mjs` (harness)

**CREATE** `server/tests/helpers/db-real.mjs`:
```js
/**
 * Harness pentru teste pe PostgreSQL REAL.
 * Folosit doar din server/tests/db/**. Importă pool-ul REAL (db/index.mjs nu e mock-uit aici).
 *
 * Flux tipic într-un fișier de test:
 *   import { hasTestDb, migrate, truncateAll, seedOrgUser, makeAuthCookie, app } from '../helpers/db-real.mjs';
 *   const d = describe.skipIf(!hasTestDb())('...', () => { beforeAll(migrate); beforeEach(truncateAll); ... });
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// IMPORTANT: db/index.mjs NU e mock-uit în testele DB → pool-ul real se conectează la DATABASE_URL
// (setat din TEST_DATABASE_URL în setup.mjs).
import { pool, migrateForTests } from '../../db/index.mjs';

export { pool };

export function hasTestDb() {
  return !!process.env.TEST_DATABASE_URL;
}

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

export function makeAuthCookie({ userId = 1, role = 'user', orgId = 1, email = 'p1@x.ro' } = {}) {
  const token = jwt.sign({ email, role, orgId, userId }, JWT_SECRET, { expiresIn: '1h' });
  return `auth_token=${token}`;
}

let _migrated = false;
export async function migrate() {
  if (_migrated) return;
  await migrateForTests();
  _migrated = true;
}

// Curăță tabelele relevante între teste (RESTART IDENTITY ca id-urile SERIAL să fie deterministe).
const TRUNCATE_TABLES = [
  'alop_instances',
  'formulare_ord',
  'formulare_df',
  'flows',
  'users',
  'organizations',
];
export async function truncateAll() {
  await pool.query(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

// ── Seed helpers ─────────────────────────────────────────────────────────────
export async function seedOrgUser({ orgName = 'Org Test', email = 'p1@x.ro', role = 'user', compartiment = '' } = {}) {
  const { rows: org } = await pool.query(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [orgName]
  );
  const orgId = org[0].id;
  const { rows: usr } = await pool.query(
    `INSERT INTO users (email, password_hash, nume, role, compartiment, org_id)
     VALUES ($1, 'x', 'Test', $2, $3, $4) RETURNING id`,
    [email, role, compartiment, orgId]
  ).catch(async (e) => {
    // org_id pe users poate să nu existe ca NOT NULL în orice schemă — fallback fără org_id
    if (/column .*org_id/.test(String(e.message))) {
      return pool.query(
        `INSERT INTO users (email, password_hash, nume, role, compartiment)
         VALUES ($1, 'x', 'Test', $2, $3) RETURNING id`,
        [email, role, compartiment]
      );
    }
    throw e;
  });
  return { orgId, userId: usr[0].id };
}

// Inserează un flow "aprobat" (data.status=completed) și întoarce id-ul (TEXT).
export async function seedFlowApproved(id = `flow-${Date.now()}-${Math.random().toString(36).slice(2,8)}`) {
  await pool.query(
    `INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({ status: 'completed', completed: true })]
  );
  return id;
}

// DF. Implicit: draft, R0, fără flow. Pasează flowId+status='aprobat' pentru "aprobat".
export async function seedDf({ orgId, createdBy, status = 'draft', flowId = null, nrUnic = 'DF-2026-001', revizieNr = 0, parentDfId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO formulare_df (org_id, created_by, status, flow_id, nr_unic_inreg, revizie_nr, parent_df_id, este_revizie)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, createdBy, status, flowId, nrUnic, revizieNr, parentDfId, (revizieNr || 0) > 0]
  );
  return rows[0].id;
}

export async function seedOrd({ orgId, createdBy, status = 'draft', flowId = null, dfId = null, nrOrd = 'ORD-2026-001' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO formulare_ord (org_id, created_by, status, flow_id, df_id, nr_ordonant_pl)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, createdBy, status, flowId, dfId, nrOrd]
  );
  return rows[0].id;
}

export async function seedAlop({ orgId, createdBy, status = 'draft', dfId = null, dfFlowId = null, ordId = null, ordFlowId = null, titlu = 'ALOP Test' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO alop_instances (org_id, created_by, status, titlu, df_id, df_flow_id, ord_id, ord_flow_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, createdBy, status, titlu, dfId, dfFlowId, ordId, ordFlowId]
  );
  return rows[0].id;
}

export async function getAlop(id) {
  const { rows } = await pool.query(`SELECT * FROM alop_instances WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function getDf(id) {
  const { rows } = await pool.query(`SELECT * FROM formulare_df WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function getOrd(id) {
  const { rows } = await pool.query(`SELECT * FROM formulare_ord WHERE id=$1`, [id]);
  return rows[0] || null;
}
```

> NOTĂ pentru Claude Code: dacă tabela `users` NU are coloana `org_id` în schema curentă,
> fallback-ul din `seedOrgUser` o tratează. Verifică totuși cu
> `grep -n "ADD COLUMN IF NOT EXISTS org_id" server/db/index.mjs` și ajustează `seedOrgUser`
> la signatura reală a `users` dacă e nevoie (păstrează `email`, `password_hash`, `role`, `compartiment`).

---

## Patch 6 — fișier nou `server/tests/db/helpers/app.mjs` (montează routerele reale)

**CREATE** `server/tests/db/helpers/app.mjs`:
```js
/**
 * Construiește o aplicație Express cu routerele REALE de formulare/ALOP, peste DB real.
 * Mock-uim DOAR middleware-urile ortogonale (csrf, require-module, logger) — NU db.
 */
import { vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../../middleware/require-module.mjs', () => ({ requireModule: () => (_req, _res, next) => next() }));
vi.mock('../../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

const { formulareDbRouter } = await import('../../../routes/formulare-db.mjs');
const alopRouter = (await import('../../../routes/alop.mjs')).default;

export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  app.use('/', alopRouter);
  return app;
}
```

> Atenție la nr. de `../` în căile de `vi.mock` (din `server/tests/db/helpers/` spre `server/middleware/`
> sunt 3 nivele: `../../../middleware/...`). Verifică după creare cu un `node --check`.
> `db/index.mjs` NU e mock-uit aici → rutele lovesc Postgres-ul real.

---

## Patch 7 — fișier nou `server/tests/db/formulare-list-caps.test.mjs` (caracterizare can_delete/aprobat)

**CREATE** `server/tests/db/formulare-list-caps.test.mjs`:
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list — capabilities (caracterizare)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });
  // după TRUNCATE RESTART IDENTITY, prima org+user au id=1

  it('DF draft fără flux → can_delete=true, aprobat=false', async () => {
    await seedDf({ orgId, createdBy: userId, status: 'draft' });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.can_delete).toBe(true);
    expect(row.aprobat).toBe(false);
  });

  it('DF pe flux (flow_id setat) → can_delete=false', async () => {
    const flowId = await seedFlowApproved();
    await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].can_delete).toBe(false);
  });

  it('DF aprobat → aprobat=true, can_delete=false', async () => {
    const flowId = await seedFlowApproved();
    await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    const row = res.body.rows[0];
    expect(row.aprobat).toBe(true);
    expect(row.can_delete).toBe(false);
  });

  it('DF draft cu ORD legată → can_delete=false', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft' });
    await seedOrd({ orgId, createdBy: userId, status: 'draft', dfId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].can_delete).toBe(false);
  });

  it('ORD draft fără flux → can_delete=true; ORD pe flux → can_delete=false', async () => {
    await seedOrd({ orgId, createdBy: userId, status: 'draft' });
    const r1 = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(r1.body.rows[0].can_delete).toBe(true);

    await truncateAll();
    await seedOrgUser({ role: 'org_admin' });
    const flowId = await seedFlowApproved();
    await seedOrd({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const r2 = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(r2.body.rows[0].can_delete).toBe(false);
  });
});
```

---

## Patch 8 — fișier nou `server/tests/db/sterge-df-ord.test.mjs` (ștergere + relink ALOP)

**CREATE** `server/tests/db/sterge-df-ord.test.mjs`:
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlowApproved,
         getAlop, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-*/:id/sterge (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ORD pe flux → 409 cannot_delete_on_flow, rândul rămâne', async () => {
    const flowId = await seedFlowApproved();
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, flowId });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_delete_on_flow');
    expect((await getOrd(ordId)).deleted_at).toBeNull();
  });

  it('ORD fără flux → 200, deleted_at setat, ALOP.ord_id eliberat', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).deleted_at).not.toBeNull();
    expect((await getAlop(alopId)).ord_id).toBeNull();
  });

  it('DF cu ORD legată → 409 cannot_delete_has_ord', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1 });
    await seedOrd({ orgId: 1, createdBy: 1, dfId });
    const res = await request(app).post(`/api/formulare-df/${dfId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_delete_has_ord');
  });

  it('DF R0 fără flux/ORD → 200, ALOP.df_id eliberat (NULL)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', revizieNr: 0 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, dfId });
    const res = await request(app).post(`/api/formulare-df/${dfId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getDf(dfId)).deleted_at).not.toBeNull();
    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  it('DF R1 (revizie) draft → restore ALOP la parent aprobat', async () => {
    const parentFlow = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: parentFlow, revizieNr: 0, nrUnic: 'DF-2026-009' });
    const revId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', revizieNr: 1, parentDfId: parentId, nrUnic: 'DF-2026-009' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, dfId: revId }); // ALOP pointează la revizie (ca după revizuieste)
    const res = await request(app).post(`/api/formulare-df/${revId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.df_id).toBe(parentId);
    expect(a.df_flow_id).toBe(parentFlow);
  });

  it('DF pe flux → 409 cannot_delete_on_flow', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const res = await request(app).post(`/api/formulare-df/${dfId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_delete_on_flow');
  });
});
```

---

## Patch 9 — fișier nou `server/tests/db/alop-cancel.test.mjs` (block df/ord)

**CREATE** `server/tests/db/alop-cancel.test.mjs`:
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/alop/:id/cancel (caracterizare ștergere ALOP)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ALOP fără DF/ORD → 200, cancelled_at setat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).cancelled_at).not.toBeNull();
  });

  it('ALOP cu DF legat ne-șters → 409 cancel_blocked_df_exists', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked_df_exists');
    expect((await getAlop(alopId)).cancelled_at).toBeNull();
  });

  it('ALOP cu ORD legată ne-ștearsă → 409 cancel_blocked_ord_exists', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked_ord_exists');
  });
});
```

---

## Patch 10 — `package.json`: scripturi noi + version bump

### 10a — scripturi

**old_str**
```
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
```
**new_str**
```
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:db": "vitest run --config vitest.config.db.mjs",
    "db:test:up": "docker run --rm -d --name docflow-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=docflow_test -p 55432:5432 postgres:16 && echo 'TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test'",
    "db:test:down": "docker rm -f docflow-testdb",
```

### 10b — version bump

**old_str**
```
  "version": "3.9.519",
```
**new_str**
```
  "version": "3.9.520",
```

---

## Patch 11 — CI: serviciu Postgres pentru job-ul de test (`.github/workflows/audit.yml`)

Adaugă un `services: postgres` la job-ul `test` și rulează și `npm run test:db`.

**old_str**
```
  test:
    name: Test suite
    runs-on: ubuntu-latest
    needs: audit

    env:
      JWT_SECRET: test-jwt-secret-github-actions-2025
      NODE_ENV: test
      LOG_LEVEL: error

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Run test suite
        run: npm test
```
**new_str**
```
  test:
    name: Test suite
    runs-on: ubuntu-latest
    needs: audit

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: docflow_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      JWT_SECRET: test-jwt-secret-github-actions-2025
      NODE_ENV: test
      LOG_LEVEL: error
      TEST_DATABASE_URL: postgres://postgres:test@localhost:5432/docflow_test

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Run test suite (mock)
        run: npm test

      - name: Run DB test suite (Postgres real)
        run: npm run test:db
```

---

## Patch 12 — `CLAUDE.md`: documentează cele două niveluri de test

Adaugă o secțiune (lângă secțiunea de testare existentă) care explică:
```
## Testare — două niveluri

1. **Mock (rapid, default)** — `npm test`
   - ~631 teste, `pool.query` mock-uit, rulează fără DB. Pattern poziţional (mockResolvedValueOnce).
   - Bun pentru logică pură / guards. Fragil la refactor SQL (cuplat de implementare).

2. **Postgres real (plasă de siguranță)** — `npm run test:db`
   - `server/tests/db/**`, rulează routerele reale peste un Postgres efemer.
   - Verifică REZULTATUL (status code + starea din DB), nu ordinea apelurilor → sigur la refactor.
   - Local: `npm run db:test:up` (Docker), exportă TEST_DATABASE_URL afișat, apoi `npm run test:db`,
     iar la final `npm run db:test:down`.
   - Fără TEST_DATABASE_URL, testele DB se auto-skip (npm test rămâne verde).
   - CI rulează ambele (serviciu postgres:16 în GitHub Actions).

REGULĂ: orice modificare pe rutele de formulare/ALOP (liste, ștergere, cancel, revizii)
trebuie acoperită întâi de un test în server/tests/db/** care captează comportamentul curent,
APOI refactorizezi. Testele DB sunt sursa de adevăr pentru regresii.
```

---

## Verificări (rulează în ordine)

```bash
# 0. Sintaxă fișiere noi
node --check server/tests/helpers/db-real.mjs
node --check server/tests/db/helpers/app.mjs
node --check vitest.config.db.mjs

# 1. Suita mock NU s-a schimbat ca scop și e verde (testele DB sunt excluse)
npm test
#    → trebuie verde, EXACT 758 teste (baseline), server/tests/db/** EXCLUS

# 2. Confirmă excluderea
grep -n "server/tests/db" vitest.config.mjs   # exclude prezent

# 3. Postgres real local (Docker) + suita DB
npm run db:test:up
export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db
#    → toate testele DB verzi (create/list/sterge/cancel/relink)
npm run db:test:down
unset TEST_DATABASE_URL

# 4. Fără DB, test:db se auto-skip (nu pică)
npm run test:db   # → toate "skipped", exit 0

# 5. NU s-a atins niciun fișier de semnare
git diff --name-only | grep -E "signing\.mjs|bulk-signing|cloud-signing|pades\.mjs|java-pades|STSCloudProvider" ; echo "↑ trebuie GOL"
```

> Dacă vreun seed pică din cauza unei coloane NOT NULL neașteptate (ex. `users.compartiment`
> sau `org_id`), ajustează `seedOrgUser`/`seedDf`/`seedOrd`/`seedAlop` la schema reală
> (verifică prin `\d formulare_df` etc.) — **fără** a modifica rutele de producție.

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.519 → 3.9.520 (package.json)
- [ ] Patch 1: SSL condiționat (`DB_DISABLE_SSL`) + `migrateForTests` exportat
- [ ] Patch 2: `vitest.config.mjs` exclude `server/tests/db/**`
- [ ] Patch 3: `setup.mjs` bridge `TEST_DATABASE_URL`
- [ ] Patch 4: `vitest.config.db.mjs` (fileParallelism:false)
- [ ] Patch 5: `helpers/db-real.mjs` (migrate/truncate/seed/getters)
- [ ] Patch 6: `db/helpers/app.mjs` (routere reale, db NEmock-uit)
- [ ] Patch 7–9: teste caracterizare (list-caps, sterge-df-ord, alop-cancel)
- [ ] Patch 10: scripturi `test:db` / `db:test:up` / `db:test:down`
- [ ] Patch 11: CI postgres:16 + rulează ambele suite
- [ ] Patch 12: CLAUDE.md — două niveluri de test
- [ ] `npm test` verde, **EXACT 758 teste** (baseline neschimbat) — raportează nr. exact
- [ ] `npm run test:db` verde pe Postgres local (raportează nr.)
- [ ] `npm run test:db` fără DB → toate skipped, exit 0
- [ ] diff fără fișiere de semnare
- [ ] commit + push **doar pe develop**

Commit sugerat:
```
test(formulare): plasă de siguranță pe Postgres real (caracterizare) + 2 niveluri de test

- harness db-real (migrate/truncate/seed) + vitest.config.db.mjs (fileParallelism:false)
- teste caracterizare: list capabilities (can_delete/aprobat), sterge DF/ORD + relink ALOP, cancel ALOP
- db/index.mjs: SSL condiționat (DB_DISABLE_SSL) + migrateForTests (doar teste)
- CI: serviciu postgres:16, rulează npm test + npm run test:db
- suita mock neatinsă; npm test rămâne verde fără DB (test:db se auto-skip)
- v3.9.520
```
```
