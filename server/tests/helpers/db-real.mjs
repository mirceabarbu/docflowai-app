/**
 * Harness pentru teste pe PostgreSQL REAL.
 * Folosit doar din server/tests/db/**. Importă pool-ul REAL (db/index.mjs nu e mock-uit aici).
 *
 * Flux tipic într-un fișier de test:
 *   import { hasTestDb, migrate, truncateAll, seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';
 *   const d = describe.skipIf(!hasTestDb())('...', () => { beforeAll(migrate); beforeEach(truncateAll); ... });
 */
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
