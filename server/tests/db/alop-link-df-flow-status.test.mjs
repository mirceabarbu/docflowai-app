/**
 * DB caracterizare — fix (v3.9.636): POST /api/alop/:id/link-df-flow persistă
 * status='transmis_flux' pe DF (calea ALOP necondiționată, mirror al linkFlowFormular).
 *
 * Simptom reparat: DF lansat pe flux din ciclul ALOP apărea „Completat" în lista DF
 * (calea ALOP seta doar alop_instances.df_flow_id, nu atingea formulare_df).
 *
 * ASIMETRIE DF (intenționată): transmis_flux e status REAL persistat (NU derivat ca la ORD).
 *
 * Cazuri: (1) flip completed→transmis_flux + badge_status în listă; (2) idempotență (fără
 * audit dublu); (3) gardă anti-deturnare (DF pe alt flux activ neatins); (4) simetrie ORD
 * — link-ord-flow NU persistă transmis_flux.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function dfStatus(id) {
  const { rows } = await pool.query('SELECT status, flow_id FROM formulare_df WHERE id=$1', [id]);
  return rows[0];
}
async function ordStatus(id) {
  const { rows } = await pool.query('SELECT status FROM formulare_ord WHERE id=$1', [id]);
  return rows[0].status;
}
async function auditCount(formType, formId, eventType) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM formulare_audit WHERE form_type=$1 AND form_id=$2 AND event_type=$3',
    [formType, formId, eventType]
  );
  return rows[0].n;
}
function findRow(body, id) { return body.rows.find(r => r.id === id); }

d('POST /api/alop/:id/link-df-flow — persistă status=transmis_flux pe DF (v3.9.636)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('1. DF completed + link-df-flow → status=transmis_flux și badge_status=transmis_flux în listă', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-ST-1' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/alop/${alopId}/link-df-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(res.status).toBe(200);

    const st = await dfStatus(df);
    expect(st.status).toBe('transmis_flux');
    expect(st.flow_id).toBe(flowId);

    const list = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(list.status).toBe(200);
    expect(findRow(list.body, df).badge_status).toBe('transmis_flux');

    expect(await auditCount('df', df, 'transmis_flux')).toBe(1);
  });

  it('2. Idempotență: al doilea link-df-flow nu re-flipează și nu adaugă audit dublu', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-ST-2' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df });
    const flowId = await seedFlow({ completed: false });

    const r1 = await request(app).post(`/api/alop/${alopId}/link-df-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/alop/${alopId}/link-df-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(r2.status).toBe(200);

    expect((await dfStatus(df)).status).toBe('transmis_flux');
    expect(await auditCount('df', df, 'transmis_flux')).toBe(1);
  });

  it('3. Gardă anti-deturnare: DF pe alt flux activ → link-df-flow cu flux nou NU-i schimbă statusul', async () => {
    const otherFlow = await seedFlow({ completed: false });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-ST-3', flowId: otherFlow });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df });
    const newFlow = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/alop/${alopId}/link-df-flow`).set('Cookie', cookie()).send({ flow_id: newFlow });
    expect(res.status).toBe(200);

    const st = await dfStatus(df);
    expect(st.status).toBe('completed');   // neatins
    expect(st.flow_id).toBe(otherFlow);    // rămâne pe fluxul vechi
    expect(await auditCount('df', df, 'transmis_flux')).toBe(0);
  });

  it('4. Simetrie ORD: link-ord-flow NU persistă transmis_flux (rămâne completed, badge derivat)', async () => {
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-ST-1' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId: ord });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(res.status).toBe(200);

    expect(await ordStatus(ord)).toBe('completed'); // status brut neatins
    expect(await auditCount('ord', ord, 'transmis_flux')).toBe(0);
  });
});
