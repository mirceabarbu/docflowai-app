/**
 * DB — P0-03 (#122): proveniența fluxului la link-{df,ord}-flow + dovada semnării la
 * {df,ord}-completed.
 *
 * Gaura reparată: `link-df-flow` / `link-ord-flow` scriau `{df,ord}_flow_id` primit de la
 * client fără nicio validare (existență / organizație / stare / proveniență), iar
 * `{df,ord}-completed` cereau doar „pointerul e non-NULL" ⇒ un utilizator autorizat pe ALOP
 * putea avansa dosarul angajare→…→plata FĂRĂ niciun document semnat.
 *
 * Cazul 3 (flux ANULAT dar cu `completed:true`) e miezul lecției din incidentul
 * PZ_8C34C4E842 (0/5 semnături): `completed` singur NU e dovadă de semnare.
 * Cazul 6 dovedește că recuperarea cloud „Fără DF" (`alop.df_id` NULL + `source_alop_id`)
 * NU se rupe.
 *
 * Rutele reale, app-ul real (buildApp) — fără redeclararea logicii.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlow, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

// Marchează un flux ca ANULAT păstrând `completed:true` (forma reală a incidentului).
async function anuleazaFlux(flowId) {
  await pool.query(
    `UPDATE flows SET data = data || '{"status":"cancelled"}'::jsonb WHERE id=$1`, [flowId]
  );
}
async function semneazaFlux(flowId) {
  await pool.query(
    `UPDATE flows SET data = data || '{"status":"completed","completed":true}'::jsonb WHERE id=$1`, [flowId]
  );
}
async function setSourceAlop(dfOrOrd, docId, alopId) {
  await pool.query(
    `UPDATE formulare_${dfOrOrd} SET source_alop_id=$1 WHERE id=$2`, [alopId, docId]
  );
}

d('ALOP — proveniența fluxului la link-{df,ord}-flow (P0-03)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  // pool.end() se face O SINGURĂ DATĂ, în ULTIMUL describe din fișier (altfel al doilea
  // describe ar rula peste un pool închis).
  const cookie = (o = {}) => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, ...o });

  const link = (alopId, kind, flowId) =>
    request(app).post(`/api/alop/${alopId}/link-${kind}-flow`).set('Cookie', cookie()).send({ flow_id: flowId });

  // ── DF ─────────────────────────────────────────────────────────────────────
  describe('link-df-flow', () => {
    async function scena({ dfStatus = 'completed' } = {}) {
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: dfStatus, nrUnic: 'DF-PROV-1' });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId });
      return { dfId, alopId };
    }

    it('1. flux inexistent → 404 flow_inexistent, df_flow_id rămâne NULL', async () => {
      const { alopId } = await scena();
      const res = await link(alopId, 'df', 'nu-exista');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('flow_inexistent');
      expect((await getAlop(alopId)).df_flow_id).toBeNull();
    });

    it('2. flux din ALTĂ organizație → 403 flow_alt_org, df_flow_id rămâne NULL', async () => {
      const { dfId, alopId } = await scena();
      const { orgId: org2 } = await seedOrgUser({ orgName: 'Org 2', email: 'org2@x.ro', role: 'user' });
      const flowId = await seedFlow({ completed: false, orgId: org2, meta: { dfId: String(dfId) } });
      const res = await link(alopId, 'df', flowId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('flow_alt_org');
      expect((await getAlop(alopId)).df_flow_id).toBeNull();
    });

    it('3. flux ANULAT dar cu completed:true → 409 flux_anulat_sau_refuzat (PZ_8C34C4E842)', async () => {
      const { dfId, alopId } = await scena();
      const flowId = await seedFlow({ completed: true, orgId: 1, meta: { dfId: String(dfId) } });
      await anuleazaFlux(flowId);
      const res = await link(alopId, 'df', flowId);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('flux_anulat_sau_refuzat');
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.status).toBe('angajare'); // NU s-a auto-lichidat pe un flux anulat
    });

    it('4. flux care revendică ALT document → 403 flux_alt_document', async () => {
      const { alopId } = await scena();
      const altDf = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-PROV-ALT' });
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { dfId: String(altDf) } });
      const res = await link(alopId, 'df', flowId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('flux_alt_document');
      expect((await getAlop(alopId)).df_flow_id).toBeNull();
    });

    it('5. POZITIV: org potrivit + meta.dfId = alop.df_id → 200, df_flow_id setat', async () => {
      const { dfId, alopId } = await scena();
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { dfId: String(dfId) } });
      const res = await link(alopId, 'df', flowId);
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).df_flow_id).toBe(flowId);
    });

    it('6. POZITIV cloud „Fără DF": alop.df_id NULL + DF cu source_alop_id = alop.id → 200', async () => {
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' }); // df_id NULL
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-CLOUD-1' });
      await setSourceAlop('df', dfId, alopId);
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { dfId: String(dfId) } });
      const res = await link(alopId, 'df', flowId);
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).df_flow_id).toBe(flowId);
    });

    it('6b. cloud NEGATIV: alop.df_id NULL + DF fără source_alop_id → 403 flux_alt_document', async () => {
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-CLOUD-2' });
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { dfId: String(dfId) } });
      const res = await link(alopId, 'df', flowId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('flux_alt_document');
    });
  });

  // ── ORD ────────────────────────────────────────────────────────────────────
  describe('link-ord-flow', () => {
    async function scena() {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-PROV-1' });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId });
      return { ordId, alopId };
    }

    it('1. flux inexistent → 404 flow_inexistent, ord_flow_id rămâne NULL', async () => {
      const { alopId } = await scena();
      const res = await link(alopId, 'ord', 'nu-exista');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('flow_inexistent');
      expect((await getAlop(alopId)).ord_flow_id).toBeNull();
    });

    it('2. flux din ALTĂ organizație → 403 flow_alt_org', async () => {
      const { ordId, alopId } = await scena();
      const { orgId: org2 } = await seedOrgUser({ orgName: 'Org 2', email: 'org2@x.ro', role: 'user' });
      const flowId = await seedFlow({ completed: false, orgId: org2, meta: { ordId: String(ordId) } });
      const res = await link(alopId, 'ord', flowId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('flow_alt_org');
      expect((await getAlop(alopId)).ord_flow_id).toBeNull();
    });

    it('3. flux ANULAT dar cu completed:true → 409 flux_anulat_sau_refuzat', async () => {
      const { ordId, alopId } = await scena();
      const flowId = await seedFlow({ completed: true, orgId: 1, meta: { ordId: String(ordId) } });
      await anuleazaFlux(flowId);
      const res = await link(alopId, 'ord', flowId);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('flux_anulat_sau_refuzat');
      expect((await getAlop(alopId)).ord_flow_id).toBeNull();
    });

    it('4. flux care revendică ALT document → 403 flux_alt_document', async () => {
      const { alopId } = await scena();
      const altOrd = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-PROV-ALT' });
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { ordId: String(altOrd) } });
      const res = await link(alopId, 'ord', flowId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('flux_alt_document');
      expect((await getAlop(alopId)).ord_flow_id).toBeNull();
    });

    it('5. POZITIV: org potrivit + meta.ordId = alop.ord_id → 200, ord_flow_id setat', async () => {
      const { ordId, alopId } = await scena();
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { ordId: String(ordId) } });
      const res = await link(alopId, 'ord', flowId);
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowId);
    });

    it('6. POZITIV cloud: alop.ord_id NULL + ORD cu source_alop_id = alop.id → 200', async () => {
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare' }); // ord_id NULL
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-CLOUD-1' });
      await setSourceAlop('ord', ordId, alopId);
      const flowId = await seedFlow({ completed: false, orgId: 1, meta: { ordId: String(ordId) } });
      const res = await link(alopId, 'ord', flowId);
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowId);
    });
  });
});

d('ALOP — dovada semnării la {df,ord}-completed (P0-03)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('7. df-completed cu flux legat legitim dar NESEMNAT → 409 document_nesemnat, rămâne angajare', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-SGN-1' });
    const flowId = await seedFlow({ completed: false, orgId: 1, meta: { dfId: String(dfId) } });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, dfFlowId: flowId });

    const res = await request(app).post(`/api/alop/${alopId}/df-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_nesemnat');
    const a = await getAlop(alopId);
    expect(a.status).toBe('angajare');
    expect(a.df_completed_at).toBeNull();
  });

  it('7b. df-completed cu flux ANULAT dar completed:true → 409 document_nesemnat', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-SGN-2' });
    const flowId = await seedFlow({ completed: true, orgId: 1, meta: { dfId: String(dfId) } });
    await anuleazaFlux(flowId);
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, dfFlowId: flowId });

    const res = await request(app).post(`/api/alop/${alopId}/df-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_nesemnat');
    expect((await getAlop(alopId)).status).toBe('angajare');
  });

  it('8. df-completed cu flux semnat valid → 200, lichidare', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-SGN-3' });
    const flowId = await seedFlow({ completed: true, orgId: 1, meta: { dfId: String(dfId) } });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, dfFlowId: flowId });

    const res = await request(app).post(`/api/alop/${alopId}/df-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    expect(a.df_completed_at).not.toBeNull();
  });

  it('9. ord-completed cu flux NESEMNAT → 409 document_nesemnat, rămâne ordonantare', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-SGN-1' });
    const flowId = await seedFlow({ completed: false, orgId: 1, meta: { ordId: String(ordId) } });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowId });

    const res = await request(app).post(`/api/alop/${alopId}/ord-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_nesemnat');
    const a = await getAlop(alopId);
    expect(a.status).toBe('ordonantare');
    expect(a.ord_completed_at).toBeNull();
  });

  it('10. ord-completed cu flux semnat valid → 200, plata', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-SGN-2' });
    const flowId = await seedFlow({ completed: true, orgId: 1, meta: { ordId: String(ordId) } });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowId });

    const res = await request(app).post(`/api/alop/${alopId}/ord-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('11. df-completed cu flux semnat al ALTUI document → 409 document_nesemnat', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-SGN-4' });
    const altDf = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-SGN-4B' });
    const flowId = await seedFlow({ completed: true, orgId: 1, meta: { dfId: String(altDf) } });
    // pointer deturnat direct în DB (ocolind link-df-flow) — a doua apărare trebuie să prindă
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, dfFlowId: flowId });

    const res = await request(app).post(`/api/alop/${alopId}/df-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_nesemnat');
    expect((await getAlop(alopId)).status).toBe('angajare');
  });
});
