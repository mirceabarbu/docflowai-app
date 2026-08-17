/**
 * test:db — #128g: derivarea coloanelor de identitate ORD urmează `ctrl_idx`, nu poziția.
 *
 * Cap-coadă peste rutele REALE (`ord.mjs`) și Postgres real: un payload cu `ctrl_idx` care NU
 * coincide cu poziția trebuie să scrie în DB identitatea rândului `rows_ctrl` INDICAT, iar
 * `ctrl_idx` însuși trebuie PĂSTRAT în coloana `rows` (e nevoie de el la fiecare salvare
 * ulterioară).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const CTRL = [
  { cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: '20.01.30' },
  { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: '20.01.31' },
  { cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: '20.01.32' },
];

d('#128g — ctrl_idx decide rândul sursă din DF (cap-coadă)', () => {
  let app, orgId, userId, cookie, dfId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro' }));
    cookie = makeAuthCookie({ userId, role: 'user', orgId });
    app = buildApp();
    dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', rowsCtrl: CTRL });
  });
  afterAll(() => pool.end());

  it('⭐ ctrl_idx ≠ poziție ⇒ identitatea vine din rândul INDICAT, iar ctrl_idx e păstrat în rows', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      nr_ordonant_pl: 'ORD-128G-1',
      df_id: dfId,
      rows: [
        // rândul 0 trimite la rows_ctrl[2], rândul 1 la rows_ctrl[0] — plus coloane FALSE
        { ctrl_idx: 2, cod_angajament: 'FAKE', indicator_angajament: 'FAKE', program: 'FAKE', cod_SSI: 'FAKE', suma_ordonantata_plata: '10' },
        { ctrl_idx: 0, cod_angajament: 'FAKE', indicator_angajament: 'FAKE', program: 'FAKE', cod_SSI: 'FAKE', suma_ordonantata_plata: '20' },
      ],
    });
    expect(cr.status).toBe(200);

    const ord = await getOrd(cr.body.document.id);
    const rows = Array.isArray(ord.rows) ? ord.rows : JSON.parse(ord.rows || '[]');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({ cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: '20.01.32' });
    expect(rows[1]).toMatchObject({ cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: '20.01.30' });

    // ctrl_idx supraviețuiește normalize → derive → pregatesteScriereBlocuri → coloana rows
    expect(rows[0].ctrl_idx).toBe(2);
    expect(rows[1].ctrl_idx).toBe(0);
    // sumele rămân ale clientului; bloc_idx e pus de #128c/f
    expect(rows[0].suma_ordonantata_plata).toBe('10');
    expect(rows[0].bloc_idx).toBe(0);
  });

  it('⭐ NON-REGRESIE: rânduri FĂRĂ ctrl_idx ⇒ derivare pozițională, ca înainte de lot', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      nr_ordonant_pl: 'ORD-128G-2',
      df_id: dfId,
      rows: [{ cod_SSI: 'FAKE' }, { cod_SSI: 'FAKE' }, { cod_SSI: 'FAKE' }],
    });
    expect(cr.status).toBe(200);

    const ord = await getOrd(cr.body.document.id);
    const rows = Array.isArray(ord.rows) ? ord.rows : JSON.parse(ord.rows || '[]');
    rows.forEach((r, i) => {
      expect(r.cod_angajament).toBe(CTRL[i].cod_angajament);
      expect(r.cod_SSI).toBe(CTRL[i].cod_SSI);
      expect('ctrl_idx' in r).toBe(false);
    });
  });

  it('PUT păstrează ctrl_idx și re-derivă din rândul indicat', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie)
      .send({ nr_ordonant_pl: 'ORD-128G-3', df_id: dfId, rows: [{ ctrl_idx: 1 }] });
    expect(cr.status).toBe(200);

    const pu = await request(app).put(`/api/formulare-ord/${cr.body.document.id}`).set('Cookie', cookie)
      .send({ rows: [{ ctrl_idx: 2, cod_SSI: 'FAKE', receptii: '5' }] });
    expect(pu.status).toBe(200);

    const ord = await getOrd(cr.body.document.id);
    const rows = Array.isArray(ord.rows) ? ord.rows : JSON.parse(ord.rows || '[]');
    expect(rows[0].cod_SSI).toBe('20.01.32');
    expect(rows[0].cod_angajament).toBe('A2');
    expect(rows[0].ctrl_idx).toBe(2);
  });
});
