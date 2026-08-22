/**
 * #139 — back-fill lazy al pointerilor ALOP→flux (df_flow_id / df_completed_at)
 * pentru ALOP-uri al căror `df_id` e deja corect setat, dar care au trecut de
 * `angajare` (deci blocul de lazy auto-tranziție din alop.mjs nu mai rulează
 * pentru ele) — vezi server/services/alop-link.mjs → backfillAlopFlowPointers.
 *
 * ⚠️ Fixture-urile reproduc forma REALĂ a fluxurilor semnate prin STS Cloud în
 * producție: `data.status = 'active'`, `data.completed = true`, `completedAt`
 * setat. Măsurat: 1913 fluxuri finalizate, ZERO cu status='completed' (acela
 * se scrie doar pe calea de upload local). Un fixture cu status:'completed' ar
 * testa o cale care nu există în această producție.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { backfillAlopFlowPointers } from '../../services/alop-link.mjs';

const d = describe.skipIf(!hasTestDb());

/** Flux „shape" real STS Cloud: status='active' + completed=true + completedAt. */
async function seedFlowCloudCompleted({ orgId = null, completedAt } = {}) {
  const id = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = {
    flowId: id,
    docName: 'Document test',
    initName: 'Inițiator',
    initEmail: 'init@x.ro',
    signers: [],
    status: 'active',
    completed: true,
    completedAt: completedAt || new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify(data), orgId]
  );
  return id;
}

d('#139 — backfillAlopFlowPointers: pointeri de flux pentru ALOP dincolo de draft/angajare', () => {
  let app;
  beforeAll(migrate);
  afterAll(() => pool.end());

  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  beforeAll(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });

  it('⭐ cazul din producție — lichidare, df_id setat, pointeri NULL → se populează, df_id NESCHIMBAT', async () => {
    const completedAt = '2026-07-30T10:00:00.000Z';
    const flowId = await seedFlowCloudCompleted({ orgId: 1, completedAt });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DOS-139-1', revizieNr: 0,
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, titlu: 'DOS-139-1' });

    const before = await pool.query(`SELECT df_id, df_flow_id, df_completed_at, status FROM alop_instances WHERE id=$1`, [alopId]);
    expect(before.rows[0].df_flow_id).toBeNull();
    expect(before.rows[0].df_completed_at).toBeNull();

    const filled = await backfillAlopFlowPointers(pool, alopId);
    expect(filled).toBeTruthy();
    expect(filled.df_flow_id).toBe(flowId);
    expect(new Date(filled.df_completed_at).toISOString()).toBe(completedAt);

    const after = await pool.query(`SELECT df_id, df_flow_id, df_completed_at FROM alop_instances WHERE id=$1`, [alopId]);
    expect(after.rows[0].df_id).toBe(dfId); // ⭐ df_id NESCHIMBAT
    expect(after.rows[0].df_flow_id).toBe(flowId);
    expect(after.rows[0].df_completed_at).not.toBeNull();
  });

  it('⭐⭐ NU atinge status — identic înainte/după', async () => {
    const flowId = await seedFlowCloudCompleted({ orgId: 1 });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DOS-139-2', revizieNr: 0,
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, titlu: 'DOS-139-2' });

    const before = await pool.query(`SELECT status FROM alop_instances WHERE id=$1`, [alopId]);
    await backfillAlopFlowPointers(pool, alopId);
    const after = await pool.query(`SELECT status FROM alop_instances WHERE id=$1`, [alopId]);

    expect(after.rows[0].status).toBe(before.rows[0].status);
    expect(after.rows[0].status).toBe('ordonantare');
  });

  it('idempotență — a doua rulare întoarce null, valorile rămân cele de la prima', async () => {
    const flowId = await seedFlowCloudCompleted({ orgId: 1 });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DOS-139-3', revizieNr: 0,
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, titlu: 'DOS-139-3' });

    const first = await backfillAlopFlowPointers(pool, alopId);
    expect(first).toBeTruthy();

    const second = await backfillAlopFlowPointers(pool, alopId);
    expect(second).toBeNull();

    const row = await pool.query(`SELECT df_flow_id FROM alop_instances WHERE id=$1`, [alopId]);
    expect(row.rows[0].df_flow_id).toBe(flowId);
  });

  it('nu suprascrie — df_flow_id deja setat spre un flux DIFERIT rămâne neschimbat', async () => {
    const flowReal = await seedFlowCloudCompleted({ orgId: 1 });
    const flowZombi = await seedFlowCloudCompleted({ orgId: 1 });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId: flowReal, nrUnic: 'DOS-139-4', revizieNr: 0,
    });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowZombi, titlu: 'DOS-139-4',
    });

    const filled = await backfillAlopFlowPointers(pool, alopId);
    // df_completed_at era NULL, deci încă se poate popula chiar dacă df_flow_id nu se schimbă;
    // ce contează e că df_flow_id rămâne PE flowZombi, nu se suprascrie cu flowReal.
    const row = await pool.query(`SELECT df_flow_id FROM alop_instances WHERE id=$1`, [alopId]);
    expect(row.rows[0].df_flow_id).toBe(flowZombi);
    if (filled) expect(filled.df_flow_id).toBe(flowZombi);
  });

  it('DF neaprobat ⇒ nu se atinge nimic (0 rânduri)', async () => {
    const flowId = await seedFlowCloudCompleted({ orgId: 1 });
    // flux ne-finalizat: suprascriem status/completed pentru a simula un DF încă în lucru
    await pool.query(`UPDATE flows SET data = data || '{"status":"active","completed":false}'::jsonb WHERE id=$1`, [flowId]);
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'transmis_flux', flowId, nrUnic: 'DOS-139-5', revizieNr: 0,
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, titlu: 'DOS-139-5' });

    const filled = await backfillAlopFlowPointers(pool, alopId);
    expect(filled).toBeNull();
    const row = await pool.query(`SELECT df_flow_id, df_completed_at FROM alop_instances WHERE id=$1`, [alopId]);
    expect(row.rows[0].df_flow_id).toBeNull();
    expect(row.rows[0].df_completed_at).toBeNull();
  });

  it('ALOP anulat (cancelled_at non-NULL) ⇒ 0 rânduri', async () => {
    const flowId = await seedFlowCloudCompleted({ orgId: 1 });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DOS-139-6', revizieNr: 0,
    });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'lichidare', dfId, titlu: 'DOS-139-6',
      cancelledAt: new Date().toISOString(),
    });

    const filled = await backfillAlopFlowPointers(pool, alopId);
    expect(filled).toBeNull();
  });

  it('ruta GET /api/alop/:id întoarce valorile completate la prima cerere', async () => {
    const completedAt = '2026-07-24T09:00:00.000Z';
    const flowId = await seedFlowCloudCompleted({ orgId: 1, completedAt });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DOS-139-7', revizieNr: 0,
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, titlu: 'DOS-139-7' });

    const r = await request(app).get(`/api/alop/${alopId}`).set('Cookie', p1());
    expect(r.status).toBe(200);
    expect(r.body.alop.df_flow_id).toBe(flowId);
    expect(r.body.alop.df_completed_at).toBeTruthy();

    const row = await pool.query(`SELECT df_flow_id FROM alop_instances WHERE id=$1`, [alopId]);
    expect(row.rows[0].df_flow_id).toBe(flowId);
  });
});
