/**
 * test:db — #178: vizibilitatea ALOP are o SINGURĂ sursă (`buildAlopVisibilityWhere`).
 *
 * Ruta de detaliu `GET /api/alop/:id` avea o COPIE inline a helperului, identică în afara
 * ieșirii devreme pe compartimentul CAB — adăugată ulterior DOAR în helper. Consecința,
 * reprodusă în producție (04.09.2026): un utilizator din compartimentul CAB vedea toate
 * dosarele în listă și primea 404 `not_found` la deschidere, pe sărite.
 *
 * Testul-cheie (1) e o PARITATE exhaustivă pe mulțimi de id-uri: ce se vede în listă se
 * deschide, și invers. E singurul care ar fi prins divergența din prima zi, indiferent de
 * ce anume diverge.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const CAB    = 'Serviciul Buget';
const COMP_A = 'Achizitii';
const COMP_B = 'Urbanism';

d('#178 — paritate listă↔detaliu pe vizibilitatea ALOP', () => {
  let app, orgA, orgB;
  let adminId, orgAdminId, cabId, userAId, userBId, otherOrgUserId;
  let ids;   // toate id-urile de dosar din orgA

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();

    const seed = await seedOrgUser({ orgName: 'Org A', role: 'user', email: 'ua@x.ro', compartiment: COMP_A });
    orgA    = seed.orgId;
    userAId = seed.userId;

    adminId    = await seedUser({ orgId: orgA, email: 'admin@x.ro',  role: 'admin',     compartiment: '',     nume: 'Admin' });
    orgAdminId = await seedUser({ orgId: orgA, email: 'oadmin@x.ro', role: 'org_admin', compartiment: '',     nume: 'OrgAdmin' });
    cabId      = await seedUser({ orgId: orgA, email: 'cab@x.ro',    role: 'user',      compartiment: CAB,    nume: 'Cab' });
    userBId    = await seedUser({ orgId: orgA, email: 'ub@x.ro',     role: 'user',      compartiment: COMP_B, nume: 'UserB' });

    const seedB = await seedOrgUser({ orgName: 'Org B', role: 'user', email: 'ob@x.ro', compartiment: CAB });
    orgB           = seedB.orgId;
    otherOrgUserId = seedB.userId;

    await pool.query('UPDATE organizations SET cab_compartiment=$1 WHERE id=$2', [CAB, orgA]);
    await pool.query('UPDATE organizations SET cab_compartiment=$1 WHERE id=$2', [CAB, orgB]);

    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user', orgId = orgA) =>
    makeAuthCookie({ userId, role, orgId, email: `u${userId}@x.ro` });

  // Un set eterogen de dosare: creator diferit, compartiment diferit, cu/fără semnatar.
  async function seedPeisaj() {
    const flowSemnatUserA = await seedFlow({ id: 'flow-178-a', orgId: orgA, signers: [{ userId: String(userAId) }] });
    const out = {};
    out.alCreatDeA  = await seedAlop({ orgId: orgA, createdBy: userAId,    status: 'draft', compartiment: COMP_A });
    out.alCompA     = await seedAlop({ orgId: orgA, createdBy: userBId,    status: 'draft', compartiment: COMP_A });
    out.alCompB     = await seedAlop({ orgId: orgA, createdBy: userBId,    status: 'draft', compartiment: COMP_B });
    out.alSemnatarA = await seedAlop({ orgId: orgA, createdBy: userBId,    status: 'draft', compartiment: COMP_B, dfFlowId: flowSemnatUserA });
    out.alStrain    = await seedAlop({ orgId: orgA, createdBy: orgAdminId, status: 'draft', compartiment: 'Juridic' });
    ids = Object.values(out);
    return out;
  }

  // Mulțimea id-urilor din listă (paginare mare — peisajul e mic).
  async function idsDinLista(cookie) {
    const res = await request(app).get('/api/alop?limit=100').set('Cookie', cookie);
    expect(res.status).toBe(200);
    return new Set(res.body.alop.map(r => r.id));
  }

  // Mulțimea id-urilor pentru care detaliul întoarce 200, testate EXHAUSTIV.
  async function idsDinDetaliu(cookie, candidati) {
    const ok = new Set();
    for (const id of candidati) {
      const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie);
      expect([200, 403, 404]).toContain(res.status);
      if (res.status === 200) ok.add(id);
    }
    return ok;
  }

  // ── 1. PARITATE exhaustivă, patru tipuri de actor ─────────────────────────
  it('1. mulțimea din listă === mulțimea deschisă la detaliu (admin, org_admin, CAB, user)', async () => {
    await seedPeisaj();
    const actori = [
      ['admin',     ck(adminId, 'admin')],
      ['org_admin', ck(orgAdminId, 'org_admin')],
      ['cab',       ck(cabId)],
      ['user',      ck(userBId)],
    ];
    for (const [nume, cookie] of actori) {
      const lista   = await idsDinLista(cookie);
      const detaliu = await idsDinDetaliu(cookie, ids);
      expect({ actor: nume, ids: [...detaliu].sort() })
        .toEqual({ actor: nume, ids: [...lista].sort() });
    }
  });

  // ── 2. Regresia raportată ─────────────────────────────────────────────────
  it('2. membrul CAB deschide un dosar creat de altcineva, din alt compartiment (înainte: 404)', async () => {
    const alopId = await seedAlop({ orgId: orgA, createdBy: userBId, status: 'draft', compartiment: COMP_B });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(cabId));
    expect(res.status).toBe(200);
    expect(res.body.alop.id).toBe(alopId);
  });

  // ── 3. Izolarea între organizații ─────────────────────────────────────────
  it('3. CAB din org A NU deschide un dosar din org B', async () => {
    const alopB = await seedAlop({ orgId: orgB, createdBy: otherOrgUserId, status: 'draft', compartiment: COMP_A });
    const res = await request(app).get(`/api/alop/${alopB}`).set('Cookie', ck(cabId));
    expect(res.status).toBe(404);
    // și invers: CAB-ul din org B nu vede dosarul din org A
    const alopA = await seedAlop({ orgId: orgA, createdBy: userAId, status: 'draft', compartiment: COMP_A });
    const res2 = await request(app).get(`/api/alop/${alopA}`)
      .set('Cookie', ck(otherOrgUserId, 'user', orgB));
    expect(res2.status).toBe(404);
  });

  // ── 4. Utilizatorul obișnuit NU s-a lărgit ────────────────────────────────
  it('4. utilizatorul obișnuit rămâne cu 404 pe dosarul altui compartiment', async () => {
    const alopId = await seedAlop({ orgId: orgA, createdBy: userAId, status: 'draft', compartiment: COMP_A });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(userBId));
    expect(res.status).toBe(404);
  });

  // ── 5. Căile permise pentru utilizatorul obișnuit ─────────────────────────
  it('5. utilizatorul obișnuit deschide: dosarul propriu, cel al compartimentului său, cel unde e semnatar', async () => {
    const propriu = await seedAlop({ orgId: orgA, createdBy: userAId, status: 'draft', compartiment: 'Juridic' });
    const alComp  = await seedAlop({ orgId: orgA, createdBy: userBId, status: 'draft', compartiment: COMP_A });
    const flow    = await seedFlow({ id: 'flow-178-s', orgId: orgA, signers: [{ userId: String(userAId) }] });
    const semnat  = await seedAlop({ orgId: orgA, createdBy: userBId, status: 'draft', compartiment: COMP_B, dfFlowId: flow });

    for (const id of [propriu, alComp, semnat]) {
      const res = await request(app).get(`/api/alop/${id}`).set('Cookie', ck(userAId));
      expect({ id, status: res.status }).toEqual({ id, status: 200 });
    }
  });

  // ── 6. Fail-safe: cab_compartiment gol ────────────────────────────────────
  it('6. cu cab_compartiment gol pe organizație, nimeni nu primește relaxarea CAB', async () => {
    await pool.query("UPDATE organizations SET cab_compartiment='' WHERE id=$1", [orgA]);
    const alopId = await seedAlop({ orgId: orgA, createdBy: userBId, status: 'draft', compartiment: COMP_B });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(cabId));
    expect(res.status).toBe(404);
    // iar lista e la fel de restrictivă (paritatea se păstrează și în fail-safe)
    const lista = await idsDinLista(ck(cabId));
    expect(lista.has(alopId)).toBe(false);
  });

  // ── 7. Capabilities intacte pentru membrul CAB ────────────────────────────
  it('7. capabilities pentru membrul CAB primesc actorComp/cabComp reale (is_cab true)', async () => {
    const alopId = await seedAlop({ orgId: orgA, createdBy: userBId, status: 'draft', compartiment: COMP_B });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(cabId));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities).toBeTruthy();
    expect(res.body.alop.capabilities.is_cab).toBe(true);
  });

  // ── 8. Dosar anulat — 404 pentru oricine, inclusiv admin ──────────────────
  it('8. dosarul anulat rămâne 404 inclusiv pentru admin', async () => {
    const alopId = await seedAlop({
      orgId: orgA, createdBy: userAId, status: 'draft', compartiment: COMP_A,
      cancelledAt: new Date().toISOString(),
    });
    for (const [role, id] of [['admin', adminId], ['org_admin', orgAdminId], ['user', cabId]]) {
      const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(id, role));
      expect({ role, status: res.status }).toEqual({ role, status: 404 });
    }
  });
});
