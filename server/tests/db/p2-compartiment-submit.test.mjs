/**
 * #131a (v3.9.779) — trimiterea la un COMPARTIMENT (Responsabil CAB pe compartiment).
 * Rute REALE + Postgres real.
 *
 * Invariantul central: `assigned_to` XOR `p2_compartiment` — niciodată amândouă scrise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const COMP = 'Serviciul Buget';

d('#131a — POST /submit cu assigned_comp', () => {
  let app, orgId, p1Id, m1, m2, altId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();
    const s = await seedOrgUser({ orgName: 'Org 131a', email: 'p1@x.ro', role: 'user', compartiment: 'Achizitii' });
    orgId = s.orgId; p1Id = s.userId;
    m1    = await seedUser({ orgId, email: 'cab1@x.ro', compartiment: COMP });
    m2    = await seedUser({ orgId, email: 'cab2@x.ro', compartiment: COMP });
    altId = await seedUser({ orgId, email: 'alt@x.ro',  compartiment: 'Juridic' });
  });
  afterAll(() => pool.end());

  const p1 = () => makeAuthCookie({ userId: p1Id, role: 'user', orgId });
  // `truncateAll()` nu golește `notifications` ⇒ numărăm SCOPAT pe document (data->>'form_id'),
  // altfel contorul s-ar acumula între teste.
  const notifCount = async (email, formId) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_email=$1 AND data->>'form_id'=$2`,
      [email, String(formId)]
    );
    return rows[0].n;
  };

  it('11. ⭐ DF: assigned_comp ⇒ assigned_to NULL, p2_compartiment setat, pending_p2, 1 notificare/membru activ (fără expeditor)', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res.status).toBe(200);
    expect(res.body.assigned_comp).toBe(COMP);
    const doc = await getDf(id);
    expect(doc.status).toBe('pending_p2');
    expect(doc.assigned_to).toBeNull();
    expect(doc.p2_compartiment).toBe(COMP);
    expect(await notifCount('cab1@x.ro', id)).toBe(1);
    expect(await notifCount('cab2@x.ro', id)).toBe(1);
    expect(await notifCount('alt@x.ro', id)).toBe(0);
    expect(await notifCount('p1@x.ro', id)).toBe(0);   // expeditorul nu se notifică pe sine
  });

  it('11b. ORD: aceeași cale (paritate DF/ORD prin service-ul comun)', async () => {
    const id = await seedOrd({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res.status).toBe(200);
    const doc = await getOrd(id);
    expect(doc.status).toBe('pending_p2');
    expect(doc.assigned_to).toBeNull();
    expect(doc.p2_compartiment).toBe(COMP);
  });

  it('11c. expeditorul E MEMBRU al compartimentului ⇒ nu primește notificare, ceilalți da', async () => {
    // p1 mutat în compartimentul CAB
    await pool.query(`UPDATE users SET compartiment=$1 WHERE id=$2`, [COMP, p1Id]);
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res.status).toBe(200);
    expect(await notifCount('p1@x.ro', id)).toBe(0);
    expect(await notifCount('cab1@x.ro', id)).toBe(1);
  });

  it('12. ⭐ assigned_to ȘI assigned_comp ⇒ 400 assigned_ambiguu, FĂRĂ nicio scriere', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1())
      .send({ assigned_to: m1, assigned_comp: COMP });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('assigned_ambiguu');
    const doc = await getDf(id);
    expect(doc.status).toBe('draft');
    expect(doc.assigned_to).toBeNull();
    expect(doc.p2_compartiment).toBeNull();
  });

  it('12b. niciunul ⇒ 400 cu mesajul VECHI, neschimbat (frontend din cache)', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('assigned_to obligatoriu');
  });

  it('13. compartiment fără utilizatori activi ⇒ 400 compartiment_fara_membri, fără scriere', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1())
      .send({ assigned_comp: 'Compartiment Inexistent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('compartiment_fara_membri');
    const doc = await getDf(id);
    expect(doc.status).toBe('draft');
    expect(doc.p2_compartiment).toBeNull();
  });

  it('13b. assigned_comp doar spații ⇒ 400 compartiment_invalid', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('compartiment_invalid');
  });

  it('14. ⭐ EXCLUSIVITATE la retrimitere: compartiment → persoană ⇒ p2_compartiment devine NULL', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    // P2 returnează ca să redevină trimisibil
    await pool.query(`UPDATE formulare_df SET status='returnat' WHERE id=$1`, [id]);
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: altId });
    expect(res.status).toBe(200);
    const doc = await getDf(id);
    expect(doc.assigned_to).toBe(altId);
    expect(doc.p2_compartiment).toBeNull();
  });

  it('14b. ⭐ și INVERS: persoană → compartiment ⇒ assigned_to devine NULL', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: altId });
    await pool.query(`UPDATE formulare_df SET status='returnat' WHERE id=$1`, [id]);
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res.status).toBe(200);
    const doc = await getDf(id);
    expect(doc.assigned_to).toBeNull();
    expect(doc.p2_compartiment).toBe(COMP);
  });

  it('15. NON-REGRESIE: submit cu assigned_to are efect IDENTIC — o singură notificare', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: m1 });
    expect(res.status).toBe(200);
    expect(res.body.assigned_to.id).toBe(m1);
    const doc = await getDf(id);
    expect(doc.status).toBe('pending_p2');
    expect(doc.assigned_to).toBe(m1);
    expect(doc.p2_compartiment).toBeNull();
    expect(await notifCount('cab1@x.ro', id)).toBe(1);
    expect(await notifCount('cab2@x.ro', id)).toBe(0);   // colegul de compartiment NU e notificat
  });

  it('16. utilizator SOFT-ȘTERS: fără notificare și fără efect asupra compartiment_fara_membri', async () => {
    await pool.query(`UPDATE users SET deleted_at=NOW() WHERE id=$1`, [m2]);
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res.status).toBe(200);
    expect(await notifCount('cab1@x.ro', id)).toBe(1);
    expect(await notifCount('cab2@x.ro', id)).toBe(0);

    // toți membrii șterși ⇒ compartimentul devine „fără membri activi"
    await pool.query(`UPDATE users SET deleted_at=NOW() WHERE id=$1`, [m1]);
    const id2 = await seedDf({ orgId, createdBy: p1Id, status: 'draft', nrUnic: 'DF-2026-002' });
    const res2 = await request(app).post(`/api/formulare-df/${id2}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toBe('compartiment_fara_membri');
  });

  it('audit: eventType rămâne `trimis_p2`, meta poartă assigned_comp + membri (fără tip nou)', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    const { rows } = await pool.query(
      `SELECT event_type, meta FROM formulare_audit WHERE form_id=$1 AND event_type='trimis_p2'`, [id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].meta.assigned_comp).toBe(COMP);
    expect(rows[0].meta.membri).toBe(2);
  });

  it('membrul compartimentului poate COMPLETA secțiunea B și primește caps de P2 în răspuns', async () => {
    const id = await seedDf({ orgId, createdBy: p1Id, status: 'draft' });
    await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_comp: COMP });
    const cab = makeAuthCookie({ userId: m1, role: 'user', orgId });
    // GET detaliu: caps de P2, nu de P1
    const det = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cab);
    expect(det.status).toBe(200);
    expect(det.body.document.capabilities.can_complete_p2).toBe(true);
    expect(det.body.document.capabilities.can_send_p2).toBe(false);
    // complete
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', cab).send({ rows_ctrl: [] });
    expect(res.status).toBe(200);
    expect((await getDf(id)).status).toBe('completed');
  });
});
