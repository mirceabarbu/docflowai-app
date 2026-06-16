/**
 * Caracterizare + concurență: POST /api/alop/:id/confirma-plata (P0.2).
 *
 * Acoperă:
 *   • Regula financiară NOUĂ plată ≤ ord (block hard 400 `plata_peste_ord`).
 *   • Skip-urile regulii: suma_efectiva null; total ORD = 0 (fără rânduri / fără ORD).
 *   • Idempotență sub gardă (a doua confirmare → 400 status_invalid).
 *   • Concurență: două confirmări simultane → exact UNA reușește (FOR UPDATE + gardă
 *     plata_confirmed_at IS NULL), plata_confirmed_at setat o singură dată.
 *
 * Fotografie a comportamentului DUPĂ P0.2 (handler alop.mjs confirma-plata).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/alop/:id/confirma-plata — plată ≤ ord + lock (P0.2)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  async function seedPlataAlop({ ordRows = [{ suma_ordonantata_plata: '1000' }] } = {}) {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', rows: ordRows });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', ordId });
    return { ordId, alopId };
  }

  it('suma_efectiva > total ORD → 400 plata_peste_ord, stare neschimbată', async () => {
    const { alopId } = await seedPlataAlop({ ordRows: [{ suma_ordonantata_plata: '1000' }] });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
      .send({ nr_ordin_plata: 'OP-1', suma_efectiva: 1500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('plata_peste_ord');
    expect(Number(res.body.ord_total)).toBe(1000);
    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.plata_confirmed_at).toBeNull();
  });

  it('suma_efectiva în limita ORD → 200 completed', async () => {
    const { alopId } = await seedPlataAlop({ ordRows: [{ suma_ordonantata_plata: '1000' }] });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
      .send({ nr_ordin_plata: 'OP-1', suma_efectiva: 900 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(a.plata_confirmed_at).not.toBeNull();
    expect(Number(a.plata_suma_efectiva)).toBe(900);
  });

  it('total ORD = 0 (fără rânduri) → skip regulă, 200 chiar dacă suma e mare', async () => {
    const { alopId } = await seedPlataAlop({ ordRows: [] });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
      .send({ nr_ordin_plata: 'OP-1', suma_efectiva: 99999 });
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('suma_efectiva null → skip regulă, 200 completed', async () => {
    const { alopId } = await seedPlataAlop({ ordRows: [{ suma_ordonantata_plata: '1000' }] });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
      .send({ nr_ordin_plata: 'OP-1' });
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('a doua confirmare → 400 status_invalid (gardă plata_confirmed_at IS NULL)', async () => {
    const { alopId } = await seedPlataAlop();
    const r1 = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
      .send({ nr_ordin_plata: 'OP-1', suma_efectiva: 1000 });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
      .send({ nr_ordin_plata: 'OP-2', suma_efectiva: 1000 });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('status_invalid');
  });

  it('CONCURENȚĂ: două confirmări simultane → exact una 200, una 400; confirmat o singură dată', async () => {
    const { alopId } = await seedPlataAlop();
    const [a, b] = await Promise.all([
      request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
        .send({ nr_ordin_plata: 'OP-A', suma_efectiva: 1000 }),
      request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie())
        .send({ nr_ordin_plata: 'OP-B', suma_efectiva: 1000 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const alop = await getAlop(alopId);
    expect(alop.status).toBe('completed');
    expect(alop.plata_confirmed_at).not.toBeNull();
    // perdantul a primit status_invalid (nu 500)
    const loser = a.status === 400 ? a : b;
    expect(loser.body.error).toBe('status_invalid');
  });
});
