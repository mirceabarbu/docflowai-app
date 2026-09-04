/**
 * test:db — #173 Etapa B: șablonul de semnatari acceptă un număr VARIABIL de roluri.
 *
 * Regula veche era de LUNGIME FIXĂ (6 la DF, 4 la ORD) — apăra o formă, nu o regulă:
 * nu există nicăieri acces pozițional la `df_semnatari[i]`, totul caută după `role`.
 * Regulile reale, verificate aici: `initiator` obligatoriu, roluri unice, iar un rol
 * PERSONALIZAT (necunoscut vocabularului) cere atribut de semnătură valid ales EXPLICIT
 * — altfel ar ajunge pe o ordonanțare de plată cu „SEMNAT", fără nicio eroare nicăieri.
 *
 * ⛔ Autorizarea rutei NU s-a atins: cazul 7 dovedește că garda de rol rămâne ÎNAINTEA
 *    validării (403, nu 400).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const DF_5 = [
  { order: 1, role: 'initiator',          user_id: null, name: '' },
  { order: 2, role: 'sef_compartiment',   user_id: null, name: '', same_as_initiator: false },
  { order: 3, role: 'responsabil_cab',    user_id: null, name: '' },
  { order: 4, role: 'director_economic',  user_id: null, name: '' },
  { order: 5, role: 'ordonator_credite',  user_id: null, name: '' },
];
const ORD_3 = [
  { order: 1, role: 'initiator',         user_id: null, name: '' },
  { order: 2, role: 'cfp_propriu',       user_id: null, name: '' },
  { order: 3, role: 'ordonator_credite', user_id: null, name: '' },
];

d('#173 B — POST/GET /api/alop/sablon: validare pe reguli, nu pe lungime', () => {
  let app, orgAdminId, userId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const seeded = await seedOrgUser({ role: 'user', email: 'user@x.ro', compartiment: 'Achizitii' });
    userId = seeded.userId;
    orgAdminId = await seedUser({ orgId: 1, email: 'oadm@x.ro', role: 'org_admin',
      compartiment: 'Achizitii', nume: 'OADM' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ckAdmin = () => makeAuthCookie({ userId: orgAdminId, role: 'org_admin', orgId: 1, email: 'oadm@x.ro' });
  const ckUser  = () => makeAuthCookie({ userId, role: 'user', orgId: 1, email: 'user@x.ro' });

  const post = (body, cookie = ckAdmin()) =>
    request(app).post('/api/alop/sablon').set('Cookie', cookie).send(body);

  async function sablonRow() {
    const { rows } = await pool.query('SELECT * FROM alop_sabloane WHERE org_id=1');
    return rows[0];
  }

  it('1. ⭐ 5 roluri la DF (fără sef_cab) ⇒ 200 și salvat (regula veche dădea 400)', async () => {
    const res = await post({ df_semnatari_sablon: DF_5, ord_semnatari_sablon: ORD_3, lichidare_sablon: {} });
    expect(res.status).toBe(200);
    const row = await sablonRow();
    expect(row.df_semnatari_sablon).toHaveLength(5);
    expect(row.df_semnatari_sablon.map((s) => s.role)).not.toContain('sef_cab');
  });

  it('2. ⭐ 3 roluri la ORD ⇒ 200', async () => {
    const res = await post({ df_semnatari_sablon: DF_5, ord_semnatari_sablon: ORD_3 });
    expect(res.status).toBe(200);
    expect((await sablonRow()).ord_semnatari_sablon).toHaveLength(3);
  });

  it('3. fără initiator ⇒ 400 sablon_invalid, mesajul conține „Inițiator"', async () => {
    const res = await post({
      df_semnatari_sablon: DF_5.filter((s) => s.role !== 'initiator'),
      ord_semnatari_sablon: ORD_3,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sablon_invalid');
    expect(res.body.message).toContain('Inițiator');
    expect(await sablonRow()).toBeUndefined();
  });

  it('4. două rânduri cu același role ⇒ 400', async () => {
    const res = await post({
      df_semnatari_sablon: [...DF_5, { order: 6, role: 'responsabil_cab', user_id: null, name: '' }],
      ord_semnatari_sablon: ORD_3,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('apare de două ori');
  });

  describe('5. rol personalizat', () => {
    const cu = (extra) => ({
      df_semnatari_sablon: [...DF_5, { order: 6, role: 'consilier_juridic', user_id: null, name: '', ...extra }],
      ord_semnatari_sablon: ORD_3,
    });

    it('fără atribut ⇒ 400', async () => {
      const res = await post(cu({ eticheta: 'Consilier juridic' }));
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('atribut de semnătură valid');
    });

    it('cu atribut inexistent („XYZ") ⇒ 400', async () => {
      const res = await post(cu({ eticheta: 'Consilier juridic', atribut: 'XYZ' }));
      expect(res.status).toBe(400);
    });

    it('cu atribut valid dar fără denumire ⇒ 400', async () => {
      const res = await post(cu({ atribut: 'AVIZAT' }));
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('denumire');
    });

    it('cu atribut „AVIZAT" + eticheta ⇒ 200, atributul persistat', async () => {
      const res = await post(cu({ eticheta: 'Consilier juridic', atribut: 'AVIZAT' }));
      expect(res.status).toBe(200);
      const row = await sablonRow();
      const custom = row.df_semnatari_sablon.find((s) => s.role === 'consilier_juridic');
      expect(custom.atribut).toBe('AVIZAT');
      expect(custom.eticheta).toBe('Consilier juridic');
    });
  });

  it('6. listă goală ⇒ 400; peste MAX_ROLURI_SABLON ⇒ 400', async () => {
    const gol = await post({ df_semnatari_sablon: [], ord_semnatari_sablon: ORD_3 });
    expect(gol.status).toBe(400);

    const prea = Array.from({ length: 13 }, (_, i) => (
      i === 0 ? { order: 1, role: 'initiator', user_id: null, name: '' }
              : { order: i + 1, role: `rol_${i}`, user_id: null, name: '',
                  eticheta: `Rol ${i}`, atribut: 'SEMNAT' }
    ));
    const res = await post({ df_semnatari_sablon: prea, ord_semnatari_sablon: ORD_3 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('maximum');
  });

  it('7. autorizare NESCHIMBATĂ: utilizator simplu ⇒ 403 (nu 400) chiar cu payload invalid', async () => {
    const res = await post({ df_semnatari_sablon: [], ord_semnatari_sablon: [] }, ckUser());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(await sablonRow()).toBeUndefined();
  });

  it('8. ⭐ GET fără rând în alop_sabloane întoarce defaults (6 DF / 4 ORD), NU chei legacy', async () => {
    const res = await request(app).get('/api/alop/sablon').set('Cookie', ckUser());
    expect(res.status).toBe(200);
    const s = res.body.sablon;
    expect(s.df_semnatari_sablon).toHaveLength(6);
    expect(s.ord_semnatari_sablon).toHaveLength(4);
    expect(s.lichidare_sablon).toEqual({});
    expect(s).not.toHaveProperty('signatari_angajare');
    expect(s).not.toHaveProperty('signatari_lichidare');
    expect(s).not.toHaveProperty('signatari_ordonantare');
    expect(s).not.toHaveProperty('signatari_plata');
  });

  it('9. round-trip: POST cu 5 roluri, GET întoarce exact ce s-a salvat (inclusiv lichidare_sablon)', async () => {
    const lich = { confirmed_by_user_id: 42 };
    const p = await post({ df_semnatari_sablon: DF_5, ord_semnatari_sablon: ORD_3, lichidare_sablon: lich });
    expect(p.status).toBe(200);

    const res = await request(app).get('/api/alop/sablon').set('Cookie', ckAdmin());
    expect(res.status).toBe(200);
    expect(res.body.sablon.df_semnatari_sablon).toEqual(DF_5);
    expect(res.body.sablon.ord_semnatari_sablon).toEqual(ORD_3);
    expect(res.body.sablon.lichidare_sablon).toEqual(lich);
  });
});
