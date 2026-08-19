import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const COMP = 'Serviciul Buget';

// ─────────────────────────────────────────────────────────────────────────────
// #131c (v3.9.781) — inițiatorul e ÎN ACELAȘI compartiment cu CAB-ul (configurația reală din
// primării). La #131a ramura `p2_compartiment` din `canEditFormular` era ULTIMA din blocul
// `if (actorComp)`, deci ramura `'comp'` (creatorul e colegul meu) câștiga și întorcea rolul
// `'comp'`. `returnFormular`/`completeFormular` cer `['admin','assigned','p2_comp']` sau
// `doc.assigned_to === actor.userId` — pe atribuirea pe compartiment `assigned_to` e NULL
// ⇒ 403 pe butoane vizibile în UI (`deriveDocRole`, funcție separată, dădea corect 'p2').
//
// ⚠️ Testele de mai jos PICĂ pe codul de dinainte de fix. Testele #131a nu le-au prins fiindcă
// acolo inițiatorul e în 'Achizitii', deci ramura `'comp'` nu se declanșa.
// ─────────────────────────────────────────────────────────────────────────────
d('#131c — returneaza/complete când inițiatorul e coleg de compartiment cu CAB', () => {
  let app, orgId, p1Id, m1;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();
    // ⭐ p1 e ÎN COMP — exact configurația care declanșa defectul
    const s = await seedOrgUser({ orgName: 'Org 131c', email: 'p1@x.ro', role: 'user', compartiment: COMP });
    orgId = s.orgId; p1Id = s.userId;
    m1 = await seedUser({ orgId, email: 'cab1@x.ro', compartiment: COMP });
  });
  afterAll(() => pool.end());

  const p1  = () => makeAuthCookie({ userId: p1Id, role: 'user', orgId });
  const cab = () => makeAuthCookie({ userId: m1,   role: 'user', orgId });

  // Trimite un DF nou către COMPARTIMENT și întoarce id-ul.
  async function dfTrimisLaComp(nrUnic = 'DF-2026-001') {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft', nrUnic });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res.status).toBe(200);
    const doc = await getDf(id);
    expect(doc.assigned_to).toBeNull();       // atribuire pe compartiment, nu pe persoană
    expect(doc.p2_compartiment).toBe(COMP);
    return id;
  }

  it('2. ⭐ POST /returneaza → 200: status `returnat` + motiv scris în DB', async () => {
    const id = await dfTrimisLaComp();
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', cab())
      .send({ motiv: 'Lipsesc anexele.' });
    expect(res.status).toBe(200);                     // fără fix: 403 forbidden
    const doc = await getDf(id);
    expect(doc.status).toBe('returnat');
    expect(doc.motiv_returnare).toBe('Lipsesc anexele.');
  });

  it('2b. ORD: aceeași cale (același service partajat)', async () => {
    const id = await seedOrd({ orgId, createdBy: p1Id, status: 'draft' });
    expect((await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1())
      .send({ assigned_comp: COMP })).status).toBe(200);
    const res = await request(app).post(`/api/formulare-ord/${id}/returneaza`).set('Cookie', cab())
      .send({ motiv: 'Suma nu corespunde.' });
    expect(res.status).toBe(200);
    const doc = await getOrd(id);
    expect(doc.status).toBe('returnat');
    expect(doc.motiv_returnare).toBe('Suma nu corespunde.');
  });

  it('3. ⭐ POST /complete → 200 în același scenariu (al doilea buton afectat)', async () => {
    const id = await dfTrimisLaComp();
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', cab())
      .send({ rows_ctrl: [] });
    expect(res.status).toBe(200);                     // fără fix: 403 forbidden
    expect((await getDf(id)).status).toBe('completed');
  });

  it('6. creatorul NU-și returnează propriul document ⇒ 403 (separarea sarcinilor, INTENȚIONAT)', async () => {
    const id = await dfTrimisLaComp();
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p1())
      .send({ motiv: 'x' });
    expect(res.status).toBe(403);
    expect((await getDf(id)).status).toBe('pending_p2');
  });

  it('caps și authz sunt de acord: butoanele vizibile chiar funcționează', async () => {
    const id = await dfTrimisLaComp();
    const det = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cab());
    expect(det.status).toBe(200);
    expect(det.body.document.capabilities.can_return).toBe(true);
    expect(det.body.document.capabilities.can_complete_p2).toBe(true);
    // ...și ambele acțiuni chiar trec (divergența caps↔authz a fost forma reală a bug-ului)
    expect((await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', cab())
      .send({ motiv: 'ok' })).status).toBe(200);
  });
});
