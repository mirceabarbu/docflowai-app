/**
 * test:db — #143b: completarea lotului #143 pentru listele DF/ORD, dedup-ul DF și
 * invariantul de separare a atribuțiilor (confirma-plata rămâne CAB-only).
 *
 * Fixture-uri oglindesc `alop-drepturi-compartiment.test.mjs`: creator (owner), coleg de
 * compartiment (COMP), străin din alt compartiment (ALT). CAB e setat pe un compartiment
 * TERȚ, ca nimeni din test să nu capete drepturi prin ramura cab_dept.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const COMP = 'Achizitii';
const ALT  = 'Urbanism';

d('#143b — drepturi de compartiment pe listele DF/ORD, dedup DF, separare atribuții', () => {
  let app, orgId, ownerId, colegId, strainId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const { orgId: oid, userId } = await seedOrgUser({ role: 'user', email: 'owner@x.ro', compartiment: COMP });
    orgId   = oid;
    ownerId = userId;
    colegId  = await seedUser({ orgId, email: 'coleg@x.ro',  compartiment: COMP, nume: 'Coleg' });
    strainId = await seedUser({ orgId, email: 'strain@x.ro', compartiment: ALT,  nume: 'Strain' });
    // CAB pe un compartiment TERȚ: nimeni din test nu capătă drepturi prin ramura cab_dept.
    await pool.query('UPDATE organizations SET cab_compartiment=$1 WHERE id=$2', ['Buget', orgId]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId) => makeAuthCookie({ userId, role: 'user', orgId, email: `u${userId}@x.ro` });

  // ── D3.1 — lista DF ──────────────────────────────────────────────────────
  it('1. ⭐ lista DF: colegul vede can_delete=true; străinul nu vede deloc rândul', async () => {
    await seedDf({ orgId, createdBy: ownerId, status: 'draft', nrUnic: 'DF-C1-001' });

    const asColeg = await request(app).get('/api/formulare/list?type=df').set('Cookie', ck(colegId));
    expect(asColeg.status).toBe(200);
    const rowColeg = asColeg.body.rows.find(r => r.nr === 'DF-C1-001');
    expect(rowColeg).toBeTruthy();
    expect(rowColeg.can_delete).toBe(true);

    const asStrain = await request(app).get('/api/formulare/list?type=df').set('Cookie', ck(strainId));
    expect(asStrain.status).toBe(200);
    // Vizibilitatea și ștergerea sunt ALINIATE: filtrul de WHERE îl scoate deja pe străin
    // din rezultat — nu ajunge să vadă rândul cu can_delete=false.
    const rowStrain = asStrain.body.rows.find(r => r.nr === 'DF-C1-001');
    expect(rowStrain).toBeFalsy();
  });

  it('2. starea are prioritate: DF cu flow_id ⇒ can_delete=false pentru creator ȘI coleg', async () => {
    await seedDf({ orgId, createdBy: ownerId, status: 'transmis_flux', flowId: 'flow-1', nrUnic: 'DF-C1-002' });

    const asOwner = await request(app).get('/api/formulare/list?type=df').set('Cookie', ck(ownerId));
    const asColeg = await request(app).get('/api/formulare/list?type=df').set('Cookie', ck(colegId));
    const rOwner = asOwner.body.rows.find(r => r.nr === 'DF-C1-002');
    const rColeg = asColeg.body.rows.find(r => r.nr === 'DF-C1-002');
    expect(rOwner.can_delete).toBe(false);
    expect(rColeg.can_delete).toBe(false);
  });

  // ── D3.3 — lista ORD ─────────────────────────────────────────────────────
  it('3. lista ORD: colegul vede can_delete=true; străinul nu vede deloc rândul', async () => {
    await seedOrd({ orgId, createdBy: ownerId, status: 'draft', nrOrd: 'ORD-C1-001' });

    const asColeg = await request(app).get('/api/formulare/list?type=ord').set('Cookie', ck(colegId));
    const rowColeg = asColeg.body.rows.find(r => r.nr === 'ORD-C1-001');
    expect(rowColeg).toBeTruthy();
    expect(rowColeg.can_delete).toBe(true);

    const asStrain = await request(app).get('/api/formulare/list?type=ord').set('Cookie', ck(strainId));
    const rowStrain = asStrain.body.rows.find(r => r.nr === 'ORD-C1-001');
    expect(rowStrain).toBeFalsy();
  });

  // ── D3.4 — dedup DF ──────────────────────────────────────────────────────
  it('4. ⭐⭐ dedup DF: colegul primește documentul existent cu capabilities de PROPRIETAR, nu de vizitator', async () => {
    // #143b Etapa C: fără fix, `computeDocCapabilities` primea actorComp='' și authzRole=''
    // ⇒ deriveDocRole întorcea 'view' pentru coleg. Cu DF-ul deja la 'pending_p2' (trimis
    // de creator la P2), un simplu vizitator cade pe ramura fallback (can_send_p2:true,
    // can_reset:true) — SEMNAL GREȘIT, sugerează că poate retrimite la P2. Cu fix, rolul
    // authz ('comp' → 'p1') dă starea corectă: is_waiting_p2:true, can_send_p2:false.
    const alopId = await seedAlop({ orgId, createdBy: ownerId, status: 'draft' });
    const dfId = await seedDf({
      orgId, createdBy: ownerId, status: 'pending_p2', nrUnic: 'DF-C2-001',
    });
    await pool.query('UPDATE formulare_df SET source_alop_id=$1 WHERE id=$2', [alopId, dfId]);

    const { rows: countBefore } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM formulare_df WHERE org_id=$1 AND deleted_at IS NULL', [orgId]);
    expect(countBefore[0].n).toBe(1);

    const res = await request(app)
      .post('/api/formulare-df')
      .set('Cookie', ck(colegId))
      .send({ source_alop_id: alopId });

    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(dfId);
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.is_waiting_p2).toBe(true);
    expect(res.body.document.capabilities.can_send_p2).toBe(false);

    const { rows: countAfter } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM formulare_df WHERE org_id=$1 AND deleted_at IS NULL', [orgId]);
    expect(countAfter[0].n).toBe(1); // niciun al doilea DF creat
  });

  // ── D3.5 — invariantul de separare a atribuțiilor (#143) ───────────────────
  it('5. ⭐⭐ separarea atribuțiilor: colegul (necab) NU poate confirma plata', async () => {
    const alopId = await seedAlop({
      orgId, createdBy: ownerId, status: 'plata', compartiment: COMP,
    });

    const res = await request(app)
      .post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(colegId))
      .send({ suma_efectiva: 100 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_cab');

    const { rows } = await pool.query(
      'SELECT status, plata_confirmed_at FROM alop_instances WHERE id=$1', [alopId]);
    expect(rows[0].status).toBe('plata');
    expect(rows[0].plata_confirmed_at).toBeFalsy();
  });
});
