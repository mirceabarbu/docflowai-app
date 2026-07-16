/**
 * GET /api/alop/facturi — coloana "Cod angajament" (din DF-ul legat, rows_ctrl).
 *
 * `cod_angajament` e UNIC pe toate rândurile din tabelul unui DF (doar `indicator_angajament`
 * diferă) — endpointul ia primul rând ne-gol via subcerere LATERAL corelată pe `df_id`.
 * Testul rulează pe Postgres REAL (nu mock) fiindcă verifică logica SQL efectivă
 * (jsonb_array_elements + LIMIT 1), nu doar forma răspunsului.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedDf, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';

const alopRouter = (await import('../../routes/alop.mjs')).default;

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', alopRouter);
  return app;
}

async function setLichidareFactura(alopId, { nrFactura = 'F-001', valoare = '100.00' } = {}) {
  await pool.query(
    `UPDATE alop_instances SET lichidare_nr_factura=$2, lichidare_valoare_factura=$3 WHERE id=$1`,
    [alopId, nrFactura, valoare]
  );
}

const d = describe.skipIf(!hasTestDb());

d('GET /api/alop/facturi — cod_angajament din DF legat', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'org_admin' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1, email: 'p1@x.ro' });

  it('ia primul cod_angajament ne-gol din rows_ctrl al DF-ului legat (unic pe toate rândurile)', async () => {
    const dfId = await seedDf({
      orgId: 1, createdBy: 1,
      rowsCtrl: [
        { cod_angajament: 'AAB54FEMNAA', indicator_angajament: 'AAB' },
        { cod_angajament: 'AAB54FEMNAA', indicator_angajament: 'XYZ' },
      ],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await setLichidareFactura(alopId);

    const res = await request(app).get('/api/alop/facturi').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.facturi).toHaveLength(1);
    expect(res.body.facturi[0].cod_angajament).toBe('AAB54FEMNAA');
  });

  it('cod_angajament null când DF-ul nu are rows_ctrl populat', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsCtrl: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await setLichidareFactura(alopId, { nrFactura: 'F-002' });

    const res = await request(app).get('/api/alop/facturi').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.facturi[0].cod_angajament).toBeNull();
  });

  it('cod_angajament null când ALOP nu are DF legat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' });
    await setLichidareFactura(alopId, { nrFactura: 'F-003' });

    const res = await request(app).get('/api/alop/facturi').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.facturi[0].df_id).toBeNull();
    expect(res.body.facturi[0].cod_angajament).toBeNull();
  });
});
