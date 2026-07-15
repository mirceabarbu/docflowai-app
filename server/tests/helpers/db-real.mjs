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

export function makeAuthCookie({ userId = 1, role = 'user', orgId = 1, email = 'p1@x.ro', tv = 1 } = {}) {
  const token = jwt.sign({ email, role, orgId, userId, tv }, JWT_SECRET, { expiresIn: '1h' });
  return `auth_token=${token}`;
}

let _migrated = false;
export async function migrate() {
  if (_migrated) return;
  await migrateForTests();
  // GOLUL de fresh-provision în `organizations` (coloanele V4 lipsă pe o bază creată din bootstrap-ul
  // inline cu 3 coloane) e acum reconciliat CANONIC de migrația inline 097_reconcile_organizations_columns,
  // care rulează în `migrateForTests` (runMigrations iterează toate migrațiile inline; 097 nu e V4-only).
  // Peticul ad-hoc de aici (ALTER pentru signing_providers_enabled/config, adăugat la #104) e redundant
  // și a fost scos — o singură sursă pentru aceleași coloane.
  _migrated = true;
}

// Curăță tabelele relevante între teste (RESTART IDENTITY ca id-urile SERIAL să fie deterministe).
const TRUNCATE_TABLES = [
  'registru_intrari',
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

// Adaugă un al doilea (sau N-lea) utilizator într-o organizație EXISTENTĂ.
// Util pentru testele P1→P2: creatorul vine din seedOrgUser, P2 din seedUser.
export async function seedUser({ orgId, email = 'p2@x.ro', role = 'user', compartiment = '', nume = 'P2' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, nume, role, compartiment, org_id)
     VALUES ($1, 'x', $2, $3, $4, $5) RETURNING id`,
    [email, nume, role, compartiment, orgId]
  );
  return rows[0].id;
}

// DF. Implicit: draft, R0, fără flow. Pasează flowId+status='aprobat' pentru "aprobat".
// assignedTo → setează assigned_to (P2) pentru testele de complete/returneaza din pending_p2.
// rowsVal (opțional) → rows_val JSONB; folosit de noua-lichidare pentru a calcula
// valoarea DF aprobat (SUM valt_actualiz). Nu schimbă semnătura pentru testele curente.
// anReferinta (opțional) → formulare_df.an_referinta (FEATURE buget multi-anual). NULL = legacy.
// rowsCtrl (opțional) → rows_ctrl JSONB (Secțiunea B); col.10 `sum_rezv_crdt_bug_act` = PLAFONUL
//   de ordonanțare (fix 12). ckbxSting (opțional) → ckbx_sting_ang_in_ancrt ('1'/''), bifa „Stingere".
export async function seedDf({ orgId, createdBy, status = 'draft', flowId = null, nrUnic = 'DF-2026-001', revizieNr = 0, parentDfId = null, assignedTo = null, rowsVal = null, rowsPlati = null, anReferinta = null, rowsCtrl = null, ckbxSting = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO formulare_df (org_id, created_by, status, flow_id, nr_unic_inreg, revizie_nr, parent_df_id, este_revizie, assigned_to, rows_val, rows_plati, an_referinta, rows_ctrl, ckbx_sting_ang_in_ancrt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::jsonb,'[]'::jsonb),COALESCE($11::jsonb,'[]'::jsonb),$12,COALESCE($13::jsonb,'[]'::jsonb),$14) RETURNING id`,
    [orgId, createdBy, status, flowId, nrUnic, revizieNr, parentDfId, (revizieNr || 0) > 0, assignedTo, rowsVal ? JSON.stringify(rowsVal) : null, rowsPlati ? JSON.stringify(rowsPlati) : null, anReferinta, rowsCtrl ? JSON.stringify(rowsCtrl) : null, ckbxSting]
  );
  return rows[0].id;
}

// rows (opțional) → formulare_ord.rows JSONB; folosit de confirma-plata pentru
// plafonul plată ≤ ord (SUM rows.suma_ordonantata_plata).
export async function seedOrd({ orgId, createdBy, status = 'draft', flowId = null, dfId = null, nrOrd = 'ORD-2026-001', assignedTo = null, rows = null } = {}) {
  const { rows: r } = await pool.query(
    `INSERT INTO formulare_ord (org_id, created_by, status, flow_id, df_id, nr_ordonant_pl, assigned_to, rows)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::jsonb,'[]'::jsonb)) RETURNING id`,
    [orgId, createdBy, status, flowId, dfId, nrOrd, assignedTo, rows ? JSON.stringify(rows) : null]
  );
  return r[0].id;
}

// seedAlop — câmpurile noi (compartiment, lichidareConfirmedBy, plataSumaEfectiva,
// cicluCurent, sumaTotalaPlatita, dfCompletedAt, ordCompletedAt, cancelledAt) sunt
// OPȚIONALE și se adaugă în INSERT doar dacă sunt furnizate (nu schimbă semnătura
// existentă folosită de testele DB curente).
export async function seedAlop({
  orgId, createdBy, status = 'draft',
  dfId = null, dfFlowId = null, ordId = null, ordFlowId = null, titlu = 'ALOP Test',
  compartiment, lichidareConfirmedBy, lichidareConfirmedAt,
  plataSumaEfectiva, cicluCurent, sumaTotalaPlatita,
  dfCompletedAt, ordCompletedAt, cancelledAt,
} = {}) {
  const cols = ['org_id', 'created_by', 'status', 'titlu', 'df_id', 'df_flow_id', 'ord_id', 'ord_flow_id'];
  const vals = [orgId, createdBy, status, titlu, dfId, dfFlowId, ordId, ordFlowId];
  const opt = {
    compartiment, lichidare_confirmed_by: lichidareConfirmedBy,
    lichidare_confirmed_at: lichidareConfirmedAt,
    plata_suma_efectiva: plataSumaEfectiva, ciclu_curent: cicluCurent,
    suma_totala_platita: sumaTotalaPlatita, df_completed_at: dfCompletedAt,
    ord_completed_at: ordCompletedAt, cancelled_at: cancelledAt,
  };
  for (const [col, v] of Object.entries(opt)) {
    if (v !== undefined) { cols.push(col); vals.push(v); }
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(
    `INSERT INTO alop_instances (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
    vals
  );
  return rows[0].id;
}

// Citește ciclurile arhivate în alop_ord_cicluri (pentru testele noua-lichidare / multi-ORD).
export async function getAlopCicluri(alopId) {
  const { rows } = await pool.query(
    `SELECT * FROM alop_ord_cicluri WHERE alop_id=$1 ORDER BY ciclu_nr`, [alopId]
  );
  return rows;
}

// Flux generic. completed=false → flux în lucru (NU declanșează auto-tranziția din link-*-flow).
// orgId (opțional) → scrie coloana org_id (izolare multi-tenant); initEmail (opțional) → data.initEmail
// (folosit de /my-flows pentru a găsi fluxul pe email). Backward-compatible: fără orgId, org_id rămâne NULL.
//
// ⚠️ `data` reproduce forma unui flux REAL: în plus de status/completed, are OBLIGATORIU `signers`
// ca ARRAY JSONB (chiar gol). Ruta /my-flows (crud.mjs) filtrează pe `data->'signers' @> jsonb_build_array(...)`
// și mapează `d.signers.map(...)` — un `data` fără cheia `signers` producea 500 (fix #104). Cheile
// status/completed rămân IDENTICE cu forma veche → apelanții existenți (alop link/lazy-resync) neafectați.
export async function seedFlow({ id = `flow-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, completed = false, orgId = null, initEmail = null, docName = null, signers = [] } = {}) {
  const data = {
    flowId: id,
    docName: docName || 'Document test',
    initName: 'Inițiator',
    initEmail: initEmail ? String(initEmail).toLowerCase() : 'init@x.ro',
    signers: Array.isArray(signers) ? signers : [],
    ...(completed ? { status: 'completed', completed: true } : { status: 'pending' }),
  };
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify(data), orgId]
  );
  return id;
}

// Intrare în registru (Registratură). Minimal: doar câmpurile NOT NULL + obiect pentru izolarea org.
// sursaId random ⇒ nu lovește indexul unic uq_registru_sursa(org_id, registru, sursa_tip, sursa_id).
export async function seedRegistru({ orgId, an = 2026, numar = 1, obiect = 'Cerere test', directie = 'intrare', sursaTip = 'manual', sursaId = null } = {}) {
  const sid = sursaId || `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const numarFormat = `${numar}/${an}`;
  const { rows } = await pool.query(
    `INSERT INTO registru_intrari (org_id, an, numar, numar_format, directie, sursa_tip, sursa_id, obiect)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, numar_format`,
    [orgId, an, numar, numarFormat, directie, sursaTip, sid, obiect]
  );
  return { id: rows[0].id, numarFormat: rows[0].numar_format, obiect };
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
