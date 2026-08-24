/**
 * test:db — #143: „proprietarul unui ALOP e COMPARTIMENTUL, nu persoana".
 *
 * Înainte, `canEditAlop` accepta de mult colegul de compartiment (rol 'comp') pe TOATE
 * mutațiile, dar `computeAlopCapabilities` gata drepturile pe `created_by` ⇒ colegul
 * trecea de poartă, însă nu primea NICIUN buton (df_action/phase_action null). Ștergerea
 * (`canDestroyOnly`) era, în plus, restricționată real la creator+admin.
 *
 * Testele de aici fixează AMBELE capete:
 *   A. capabilities pe GET detaliu — colegul primește aceleași acțiuni ca proprietarul;
 *   B. ștergerea (/cancel) — colegul poate, străinul de compartiment NU.
 *
 * ⛔ Granița rămâne COMPARTIMENTUL, nu organizația: un utilizator din alt compartiment
 *    (fără rol CAB/admin) nu capătă nimic.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const COMP = 'Achizitii';
const ALT  = 'Urbanism';

d('#143 — drepturi de proprietar pentru compartimentul creatorului', () => {
  let app, ownerId, colegId, strainId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const { userId } = await seedOrgUser({ role: 'user', email: 'owner@x.ro', compartiment: COMP });
    ownerId  = userId;
    colegId  = await seedUser({ orgId: 1, email: 'coleg@x.ro',  compartiment: COMP, nume: 'Coleg' });
    strainId = await seedUser({ orgId: 1, email: 'strain@x.ro', compartiment: ALT,  nume: 'Strain' });
    // CAB setat pe un compartiment TERȚ: nimeni din test nu capătă drepturi prin ramura
    // cab_dept, deci ce se observă mai jos vine STRICT din regula de compartiment.
    await pool.query("UPDATE organizations SET cab_compartiment='Buget' WHERE id=1");
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user') => makeAuthCookie({ userId, role, orgId: 1, email: `u${userId}@x.ro` });

  // ── A. capabilities pe GET detaliu ─────────────────────────────────────────
  it('1. colegul de compartiment primește aceleași capabilities ca proprietarul', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft', compartiment: COMP });

    const asOwner = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(ownerId));
    const asColeg = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(colegId));

    expect(asOwner.status).toBe(200);
    expect(asColeg.status).toBe(200);
    expect(asColeg.body.alop.capabilities.is_owner).toBe(true);
    expect(asColeg.body.alop.capabilities.is_owner_comp).toBe(true);
    // acțiunile efective, nu doar flag-ul: butoanele chiar se randează
    expect(asColeg.body.alop.capabilities.df_action).toBe(asOwner.body.alop.capabilities.df_action);
    expect(asColeg.body.alop.capabilities.df_action).not.toBeNull();
    expect(asColeg.body.alop.capabilities.can_delete).toBe(true);
  });

  it('2. moștenirea merge și prin compartimentul CREATORULUI, când ALOP-ul n-are compartiment declarat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft' }); // fără `compartiment`
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(colegId));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities.is_owner_comp).toBe(true);
    expect(res.body.alop.capabilities.df_action).not.toBeNull();
  });

  it('3. utilizatorul din alt compartiment NU capătă drepturi (granița rămâne compartimentul)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft', compartiment: COMP });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck(strainId));
    // Vizibilitatea pe detaliu nu e obiectul acestui fix: filtrul existent îl scoate deja
    // pe străin din rezultat (404 „nu există pentru tine"). Ce fixăm aici e că, DACĂ rândul
    // i-ar ajunge vreodată, NU devine proprietar prin efectul lateral al #143.
    expect([403, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.alop.capabilities.is_owner).toBe(false);
      expect(res.body.alop.capabilities.is_owner_comp).toBe(false);
      expect(res.body.alop.capabilities.can_delete).toBe(false);
    }
  });

  // ── B. ștergere (/cancel) ──────────────────────────────────────────────────
  it('4. colegul de compartiment poate ȘTERGE ALOP-ul (decizie owner #143)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft', compartiment: COMP });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', ck(colegId));
    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT cancelled_at FROM alop_instances WHERE id=$1', [alopId]);
    expect(rows[0].cancelled_at).not.toBeNull();
  });

  it('5. utilizatorul din alt compartiment NU poate șterge ⇒ 403, nimic scris în DB', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft', compartiment: COMP });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', ck(strainId));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_destroy_creator_only');
    const { rows } = await pool.query('SELECT cancelled_at FROM alop_instances WHERE id=$1', [alopId]);
    expect(rows[0].cancelled_at).toBeNull();
  });

  it('6. lista ALOP: can_delete e owner-aware — true pentru coleg, false pentru străin', async () => {
    await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft', compartiment: COMP });
    const asColeg  = await request(app).get('/api/alop').set('Cookie', ck(colegId));
    expect(asColeg.status).toBe(200);
    expect(asColeg.body.alop[0].can_delete).toBe(true);

    // străinul: dacă rândul îi e vizibil, butonul NU trebuie să apară (înainte apărea și da 403)
    const asStrain = await request(app).get('/api/alop').set('Cookie', ck(strainId));
    expect(asStrain.status).toBe(200);
    for (const r of asStrain.body.alop) expect(r.can_delete).toBe(false);
  });

  // ── C. mutație existentă — poarta accepta deja colegul; verificare anti-regresie ──
  it('7. colegul poate edita titlul (canEditAlop → rol comp, comportament preexistent)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: ownerId, status: 'draft', compartiment: COMP });
    const res = await request(app).post(`/api/alop/${alopId}/titlu`)
      .set('Cookie', ck(colegId)).send({ titlu: 'Titlu schimbat de coleg' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT titlu FROM alop_instances WHERE id=$1', [alopId]);
    expect(rows[0].titlu).toBe('Titlu schimbat de coleg');
  });

  // ── D. DF: capabilities pentru colegul de compartiment ─────────────────────
  it('8. DF — colegul de compartiment primește rolul P1 în capabilities (poate trimite la P2)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: ownerId, status: 'draft' });
    const res = await request(app).get(`/api/formulare-df/${dfId}`).set('Cookie', ck(colegId));
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
  });
});
