/**
 * Prompt 63 (v3.9.644) — DOAR AFIȘARE: revizie DF în curs.
 *
 * Un ALOP finalizat apoi revizuit (DF R1 pe flux de semnare ACTIV, neaprobat) trebuie
 * să expună coloanele derivate care permit frontend-ului să semnaleze „revizie în curs":
 *   df_revizie_nr > 0 && df_flow_active && !df_aprobat
 * pe AMBELE răspunsuri — listă (GET /api/alop) și detaliu (GET /api/alop/:id).
 *
 * ⚠️ Read-only: coloane derivate în SELECT, zero funcțional. Statusul persistat rămâne
 * 'completed' — badge-ul/stepper-ul doar re-derivă starea reală la momentul afișării.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('ALOP — afișare revizie DF în curs (derivate read-only)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ALOP completed cu DF R1 pe flux activ → df_flow_active=true, df_aprobat=false, df_revizie_nr=1 (listă + detaliu)', async () => {
    const flowId = await seedFlow({ completed: false }); // status 'pending' — activ, neaprobat, neanulat
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'transmis_flux', flowId,
      nrUnic: 'DF-REV-1', revizieNr: 1,
    });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, dfFlowId: flowId,
      plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    // Listă
    const list = await request(app).get('/api/alop').set('Cookie', p1());
    expect(list.status).toBe(200);
    const row = list.body.alop.find(x => x.id === alopId);
    expect(row).toBeTruthy();
    expect(row.df_revizie_nr).toBe(1);
    expect(row.df_flow_active).toBe(true);
    expect(row.df_aprobat).toBe(false);

    // Detaliu
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', p1());
    expect(det.status).toBe(200);
    expect(det.body.alop.df_revizie_nr).toBe(1);
    expect(det.body.alop.df_flow_active).toBe(true);
    expect(det.body.alop.df_aprobat).toBe(false);
    expect(det.body.alop.status).toBe('completed'); // funcțional neatins
  });

  it('ALOP fără revizie (DF R0 aprobat) → df_flow_active=false, df_aprobat=true, df_revizie_nr=0 (neschimbat)', async () => {
    const flowId = await seedFlow({ completed: true }); // flux completat → aprobat, nu mai e activ
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV-0' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, dfFlowId: flowId });

    const list = await request(app).get('/api/alop').set('Cookie', p1());
    const row = list.body.alop.find(x => x.id === alopId);
    expect(row.df_revizie_nr).toBe(0);
    expect(row.df_flow_active).toBe(false);
    expect(row.df_aprobat).toBe(true);

    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', p1());
    expect(det.body.alop.df_flow_active).toBe(false);
    expect(det.body.alop.df_aprobat).toBe(true);
  });
});
