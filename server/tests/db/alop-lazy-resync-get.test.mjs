/**
 * Caracterizare: GET /api/alop/:id MUTĂ starea (lazy auto-tranziție / self-heal).
 * Inima riscului ALOP. O citire avansează `status` ca efect secundar, pe baza
 * fluxurilor legate completate și a COALESCE(df.flow_id, a.df_flow_id).
 *
 * Pentru fiecare scenariu: seed ALOP în stare X cu flux legat *completed* → GET →
 * afirmă că getAlop().status a avansat la Y ÎN DB (nu doar în răspuns).
 *
 * Fotografie a comportamentului CURENT. Dacă pică fiindcă ipoteza despre comportament
 * e greșită → se corectează TESTUL, nu codul.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlow, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/alop/:id — lazy resync (mutație la citire)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  // creatorul (userId=1) trece de authz fără rol admin
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('draft + DF aprobat (braț df.flow_id) → după GET status=lichidare + resync df_flow_id', async () => {
    const flux = await seedFlow({ id: 'flow-df-A', completed: true });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, flowId: flux });
    // braț 1: autoritatea vine din df.flow_id; df_flow_id de pe ALOP e NULL
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', dfId, dfFlowId: null });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    // resync: df_flow_id rămas NULL e completat cu fluxul autoritar al DF-ului
    expect(a.df_flow_id).toBe(flux);
    expect(a.df_completed_at).not.toBeNull();
  });

  it('draft + DF aprobat (braț a.df_flow_id, fără df) → după GET status=lichidare', async () => {
    const flux = await seedFlow({ id: 'flow-df-B', completed: true });
    // braț 2: nu există DF; COALESCE cade pe a.df_flow_id
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', dfId: null, dfFlowId: flux });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    // fără df autoritar, df_flow_id rămâne fluxul de pe ALOP
    expect(a.df_flow_id).toBe(flux);
  });

  it('ambele brațe setate dar diferite → df.flow_id câștigă (autoritar)', async () => {
    // COALESCE prioritizează df.flow_id — sursa autoritară. NU inversa.
    const fluxAutoritar = await seedFlow({ id: 'flow-df-auth', completed: true });
    const fluxStalePeAlop = await seedFlow({ id: 'flow-df-stale', completed: false });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, flowId: fluxAutoritar });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', dfId, dfFlowId: fluxStalePeAlop });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    // df_flow_id resincronizat la fluxul autoritar al DF-ului (NU rămâne cel stale)
    expect(a.df_flow_id).toBe(fluxAutoritar);
  });

  it('ordonantare + ORD aprobat → după GET status=plata', async () => {
    const fluxOrd = await seedFlow({ id: 'flow-ord-A', completed: true });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, flowId: fluxOrd });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: fluxOrd,
    });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.ord_completed_at).not.toBeNull();
  });

  it('fără flux legat → GET NU schimbă status (idempotent la citire)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).status).toBe('draft');
  });

  it('ALOP cancelled → GET = 404, NU resincronizează', async () => {
    // GET filtrează cancelled_at IS NULL → 404; nicio mutație de status.
    const flux = await seedFlow({ id: 'flow-cancel', completed: true });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, flowId: flux });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'cancelled', dfId, dfFlowId: flux, cancelledAt: new Date(),
    });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(404);
    expect((await getAlop(alopId)).status).toBe('cancelled');
  });
});
