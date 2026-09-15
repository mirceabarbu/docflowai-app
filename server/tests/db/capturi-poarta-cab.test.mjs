/**
 * #206 (v3.9.859) — poarta de server pe capturile de ecran ale DF-ului.
 *
 * Normele ALOP: capturile de ecran de pe DF sunt atributul responsabilului CAB (P2), ca și
 * Secțiunea B. `POST /api/formulare-capturi/:type/:id` verifica doar `authz.allowed`, ignorând
 * `authz.role` — `canEditFormular` întoarce `allowed:true` și pentru `creator`/`comp`, deci P1
 * încărca capturi. Poarta cere P2 (assigned_to / p2_comp / cab_dept) sau admin, DOAR pe `df`.
 *
 * Rulează rutele REALE peste Postgres real, cu CSRF real (double-submit) — modelul
 * `capturi-upload-cursa.test.mjs`. Ruta citește corpul BRUT ⇒ Buffer + Content-Type image/png.
 *
 * ⭐ 7  — ancora lotului: P1 pur ⇒ 403 `doar_responsabil_cab`, zero rânduri.
 * ⭐ 9  — `p2_comp` prin `p2_compartiment`: prinde SELECT-ul incomplet (fără `p2_compartiment`
 *         în proiecție, ramura `p2_comp` din canEditFormular nu se evaluează niciodată).
 * ⭐ 12 — ORD NEATINS: P1 pur încarcă pe ORD ⇒ 200, exact ca înainte de lot (limita de scop).
 * ⭐ 13 — reparația #205 (ON CONFLICT) rămâne: încărcări paralele de P2 ⇒ toate 200, un rând.
 * ⭐ 14 — P1+P2 simultan (comuna mică, #131c) ⇒ 200: are dreptul prin al doilea rol.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');

function buildRealApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use((req, res, next) => express.json({ limit: '1mb' })(req, res, next));
  app.use('/', formulareDbRouter);
  return app;
}

const CSRF = 'test-csrf-token-cap-poarta';
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;

const ROUNDS = 3;
const PARALLEL = 4;

const d = describe.skipIf(!hasTestDb());

d('#206 — capturile DF sunt atributul responsabilului CAB (poartă pe POST capturi)', () => {
  let app, orgId;
  // 1 = P1 creator (Achizitii), 2 = P2 assigned (Contabilitate), 3 = coleg P1 (Achizitii),
  // 4 = coleg P2 comp (Contabilitate), 5 = membru CAB org (Serviciul Buget), 6 = străin (Juridic)
  let p1Id, p2Id, colegP1Id, colegP2Id, cabId, strainId;
  let dfId, ordId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId: p1Id } = await seedOrgUser({ role: 'user', email: 'p1@x.ro', compartiment: 'Achizitii' }));
    p2Id      = await seedUser({ orgId, email: 'p2@x.ro',       compartiment: 'Contabilitate' });
    colegP1Id = await seedUser({ orgId, email: 'coleg-p1@x.ro', compartiment: 'Achizitii' });
    colegP2Id = await seedUser({ orgId, email: 'coleg-p2@x.ro', compartiment: 'Contabilitate' });
    cabId     = await seedUser({ orgId, email: 'cab@x.ro',      compartiment: 'Serviciul Buget' });
    strainId  = await seedUser({ orgId, email: 'strain@x.ro',   compartiment: 'Juridic' });
    await pool.query(`UPDATE organizations SET cab_compartiment='Serviciul Buget' WHERE id=$1`, [orgId]);
    dfId  = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, nrUnic: 'DF-206-1' });
    ordId = await seedOrd({ orgId, createdBy: p1Id, status: 'draft', nrOrd: 'ORD-206-1' });
    app = buildRealApp();
  });
  afterAll(() => pool.end());

  const upload = (type, id, userId, { role = 'user', email = 'x@x.ro', filename = 'captura.png', body = 'PNG-BYTES', qs = '?slot=1' } = {}) =>
    request(app)
      .post(`/api/formulare-capturi/${type}/${id}${qs}`)
      .set('Cookie', authz({ userId, role, orgId, email }))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'image/png')
      .set('X-Filename', filename)
      .send(Buffer.from(body));

  const rowsOf = async (type, id) => {
    const { rows } = await pool.query(
      `SELECT uploaded_by, filename, slot, encode(data,'escape') AS body
         FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 ORDER BY id`, [type, id]);
    return rows;
  };

  // ── 7 ⭐ ANCORA LOTULUI ─────────────────────────────────────────────────────────────
  it('7 ⭐ P1 pur (creator) încarcă captură pe DF ⇒ 403 doar_responsabil_cab, zero rânduri', async () => {
    const r = await upload('df', dfId, p1Id, { email: 'p1@x.ro' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('doar_responsabil_cab');
    expect(r.body.message).toMatch(/responsabilul CAB/);
    expect(await rowsOf('df', dfId)).toHaveLength(0);
  });

  it('7b coleg de compartiment al creatorului (comp) e tot P1 ⇒ 403 doar_responsabil_cab, zero rânduri', async () => {
    const r = await upload('df', dfId, colegP1Id, { email: 'coleg-p1@x.ro' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('doar_responsabil_cab');
    expect(await rowsOf('df', dfId)).toHaveLength(0);
  });

  it('7c străin (fără drepturi) ⇒ 403 forbidden (poarta veche, înaintea celei noi)', async () => {
    const r = await upload('df', dfId, strainId, { email: 'strain@x.ro' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    expect(await rowsOf('df', dfId)).toHaveLength(0);
  });

  // ── 8 P2 (assigned_to) ⇒ 200 ──────────────────────────────────────────────────────
  it('8 P2 (assigned_to) ⇒ 200, captura există', async () => {
    const r = await upload('df', dfId, p2Id, { email: 'p2@x.ro', body: 'DE-LA-P2' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const rows = await rowsOf('df', dfId);
    expect(rows).toHaveLength(1);
    expect(rows[0].uploaded_by).toBe(p2Id);
    expect(rows[0].body).toBe('DE-LA-P2');
  });

  // ── 9 ⭐ p2_comp prin p2_compartiment — prinde SELECT-ul incomplet ─────────────────
  it('9 ⭐ membru al compartimentului atribuit (p2_comp via p2_compartiment, assigned_to NULL) ⇒ 200', async () => {
    const dfComp = await seedDf({ orgId, createdBy: p1Id, status: 'pending_p2', nrUnic: 'DF-206-COMP' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment='Contabilitate' WHERE id=$1`, [dfComp]);
    const r = await upload('df', dfComp, colegP2Id, { email: 'coleg-p2@x.ro', body: 'P2-COMP' });
    expect(r.status).toBe(200);
    const rows = await rowsOf('df', dfComp);
    expect(rows).toHaveLength(1);
    expect(rows[0].uploaded_by).toBe(colegP2Id);
  });

  it('9b coleg al userului atribuit (p2_comp via assigned_to în același compartiment) ⇒ 200', async () => {
    const r = await upload('df', dfId, colegP2Id, { email: 'coleg-p2@x.ro' });
    expect(r.status).toBe(200);
    expect(await rowsOf('df', dfId)).toHaveLength(1);
  });

  // ── 10 cab_dept ⇒ 200 (coerent cu filtrul de câmpuri din PUT — ambele porți la fel) ──
  it('10 cab_dept (membru CAB al org-ului, nici creator, nici atribuit) ⇒ 200', async () => {
    const r = await upload('df', dfId, cabId, { email: 'cab@x.ro' });
    expect(r.status).toBe(200);
    const rows = await rowsOf('df', dfId);
    expect(rows).toHaveLength(1);
    expect(rows[0].uploaded_by).toBe(cabId);
  });

  // ── 11 admin / org_admin ⇒ 200 ──────────────────────────────────────────────────
  it('11 admin ⇒ 200', async () => {
    const r = await upload('df', dfId, strainId, { role: 'admin', email: 'admin@x.ro' });
    expect(r.status).toBe(200);
    expect(await rowsOf('df', dfId)).toHaveLength(1);
  });

  it('11b org_admin ⇒ 200', async () => {
    const r = await upload('df', dfId, strainId, { role: 'org_admin', email: 'orgadmin@x.ro' });
    expect(r.status).toBe(200);
    expect(await rowsOf('df', dfId)).toHaveLength(1);
  });

  // ── 12 ⭐ ORD NEATINS — limita de scop ─────────────────────────────────────────────
  it('12 ⭐ ORD neatins: P1 pur încarcă captură pe ORD ⇒ 200, exact ca înainte de lot', async () => {
    const r = await upload('ord', ordId, p1Id, { email: 'p1@x.ro', body: 'ORD-P1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const rows = await rowsOf('ord', ordId);
    expect(rows).toHaveLength(1);
    expect(rows[0].uploaded_by).toBe(p1Id);
  });

  // ── 13 ⭐ reparația #205 rămâne: paralel de P2 ⇒ toate 200, un rând ────────────────
  it(`13 ⭐ ${PARALLEL} POST paralele × ${ROUNDS} runde de P2 pe același (slot, bloc) ⇒ toate 200, un singur rând`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const bodies = Array.from({ length: PARALLEL }, (_, i) => `IMG-${round}-${i}-${'x'.repeat(100 + i)}`);
      const results = await Promise.all(
        bodies.map((b, i) => upload('df', dfId, p2Id, { email: 'p2@x.ro', filename: `r${round}-${i}.png`, body: b }))
      );
      expect(results.map(r => r.status), `runda ${round}: ${JSON.stringify(results.map(r => r.body))}`)
        .toEqual(Array(PARALLEL).fill(200));
      const rows = await rowsOf('df', dfId);
      expect(rows, `runda ${round}`).toHaveLength(1);
      expect(bodies).toContain(rows[0].body);
    }
  });

  // ── 14 ⭐ P1 ȘI P2 simultan ⇒ 200 (are dreptul prin al doilea rol) ─────────────────
  it('14 ⭐ același user e creator ȘI assigned_to (comuna mică) ⇒ 200', async () => {
    const dfMic = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p1Id, nrUnic: 'DF-206-MIC' });
    const r = await upload('df', dfMic, p1Id, { email: 'p1@x.ro' });
    expect(r.status).toBe(200);
    const rows = await rowsOf('df', dfMic);
    expect(rows).toHaveLength(1);
    expect(rows[0].uploaded_by).toBe(p1Id);
  });
});
