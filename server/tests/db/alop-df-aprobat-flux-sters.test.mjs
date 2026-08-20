/**
 * #134d — plasă anti-drift pentru definiția STRICTĂ de „DF aprobat" (forma 4,
 * server/services/df-aprobat-sql.mjs), folosită de SQL_ALOP_DF_APROBAT din alop.mjs.
 *
 * Testează direct expresia SQL (dfAprobatExistsSql), corelată pe alop_instances,
 * exact ca în alop.mjs — pe fixture-uri PG reale: flux soft-șters/anulat/refuzat
 * NU mai „aprobă" dosarul. Cazul 1 e cel care dovedește divergența reparată la
 * Etapa 2 (vezi RAPORT FINAL pentru ieșirea brută contra codului nemodificat).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedAlop, seedDf, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { dfAprobatExistsSql } from '../../services/df-aprobat-sql.mjs';
import { sqlDosarAreFluxActiv, sqlDosarAreAprobat } from '../../services/alop-dosar-sql.mjs';

const d = describe.skipIf(!hasTestDb());

// Aceeași expresie de pointer flux pe care o folosește alop.mjs (SQL_ALOP_DF_FLOW).
const SQL_ALOP_DF_FLOW = `COALESCE((SELECT dfx.flow_id FROM formulare_df dfx WHERE dfx.id = a.df_id), a.df_flow_id)`;

async function dfAprobatFor(alopId) {
  const sql = `SELECT ${dfAprobatExistsSql(SQL_ALOP_DF_FLOW)} AS aprobat FROM alop_instances a WHERE a.id = $1`;
  const { rows } = await pool.query(sql, [alopId]);
  return rows[0].aprobat;
}

async function fluxDfActivFor(alopId) {
  const sql = `SELECT EXISTS (
      SELECT 1 FROM flows fx
       WHERE fx.id::text = ${SQL_ALOP_DF_FLOW}
         AND fx.deleted_at IS NULL
         AND (fx.data->>'completed') IS DISTINCT FROM 'true'
         AND (fx.data->>'status')    IS DISTINCT FROM 'cancelled'
         AND (fx.data->>'status')    IS DISTINCT FROM 'refused') AS activ
    FROM alop_instances a WHERE a.id = $1`;
  const { rows } = await pool.query(sql, [alopId]);
  return rows[0].activ;
}

d('#134d — DF aprobat: gărzi flux soft-șters/anulat/refuzat (alop.mjs)', () => {
  let app, orgId, adminId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId: adminId } = await seedOrgUser({ role: 'org_admin', email: 'admin@x.ro' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' });

  it('1. flux soft-șters + completed ⇒ df_aprobat = false (azi, cod vechi: true)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id = $1`, [flowId]);
    const dfId = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId, nrUnic: 'DF-134D-1' });
    const alopId = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId, dfFlowId: flowId, titlu: 'ALOP flux sters' });

    expect(await dfAprobatFor(alopId)).toBe(false);
  });

  it('2. același fixture: df_flow_active = false (neschimbat — garda deja exista)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id = $1`, [flowId]);
    const dfId = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId, nrUnic: 'DF-134D-2' });
    const alopId = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId, dfFlowId: flowId, titlu: 'ALOP flux sters 2' });

    expect(await fluxDfActivFor(alopId)).toBe(false);
  });

  it('3. flux cancelled ⇒ df_aprobat = false', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', '"cancelled"') WHERE id = $1`, [flowId]);
    const dfId = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId, nrUnic: 'DF-134D-3' });
    const alopId = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId, dfFlowId: flowId, titlu: 'ALOP flux cancelled' });

    expect(await dfAprobatFor(alopId)).toBe(false);
  });

  it('4. flux refused ⇒ df_aprobat = false', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', '"refused"') WHERE id = $1`, [flowId]);
    const dfId = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId, nrUnic: 'DF-134D-4' });
    const alopId = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId, dfFlowId: flowId, titlu: 'ALOP flux refused' });

    expect(await dfAprobatFor(alopId)).toBe(false);
  });

  it('5. flux normal completat ⇒ df_aprobat = true (non-regresie)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId, nrUnic: 'DF-134D-5' });
    const alopId = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId, dfFlowId: flowId, titlu: 'ALOP flux ok' });

    expect(await dfAprobatFor(alopId)).toBe(true);
  });

  it('6. forma "completed=true" în loc de status=completed ⇒ true', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{completed}', 'true') WHERE id = $1`, [flowId]);
    const dfId = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId, nrUnic: 'DF-134D-6' });
    const alopId = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId, dfFlowId: flowId, titlu: 'ALOP flux completed-bool' });

    expect(await dfAprobatFor(alopId)).toBe(true);
  });

  it('7. total din GET /api/alop coincide cu rows.length — expresia nouă merge identic în COUNT-ul fără JOIN', async () => {
    // Fixtures de badge (#132b): angajare simplu + angajare_flux + revizie_flux + lichidare
    const dfA = await seedDf({ orgId, createdBy: adminId, status: 'completed', nrUnic: 'DF-134D-7A' });
    await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId: dfA, titlu: 'A' });

    const flB = await seedFlow({ orgId, completed: false });
    const dfB = await seedDf({ orgId, createdBy: adminId, status: 'transmis_flux', flowId: flB, nrUnic: 'DF-134D-7B' });
    await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId: dfB, dfFlowId: flB, titlu: 'B' });

    const flC = await seedFlow({ orgId, completed: false });
    const dfC = await seedDf({ orgId, createdBy: adminId, status: 'transmis_flux', flowId: flC, revizieNr: 1, nrUnic: 'DF-134D-7C' });
    await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', dfId: dfC, dfFlowId: flC, titlu: 'C' });

    // flux soft-șters (fixture-ul chestiunii de la #134d) — nu trebuie să rupă COUNT-ul
    const flD = await seedFlow({ orgId, completed: true });
    await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id = $1`, [flD]);
    const dfD = await seedDf({ orgId, createdBy: adminId, status: 'completed', flowId: flD, nrUnic: 'DF-134D-7D' });
    await seedAlop({ orgId, createdBy: adminId, status: 'angajare', dfId: dfD, dfFlowId: flD, titlu: 'D' });

    for (const st of ['angajare', 'angajare_flux', 'revizie_flux', 'lichidare']) {
      const res = await request(app).get('/api/alop?status=' + st).set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect({ st, total: res.body.total }).toEqual({ st, total: res.body.alop.length });
    }
    // și fără filtru
    const resAll = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(resAll.status).toBe(200);
    expect(resAll.body.total).toBe(resAll.body.alop.length);
  });

  it('8. anti-drift — definiția aprobării rămâne cablată pe helper-ul cu gărzi (nu poate diverge silențios)', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const alopSrc   = fs.readFileSync(path.join(__dirname, '../../routes/alop.mjs'), 'utf8');
    const dosarSrc  = fs.readFileSync(path.join(__dirname, '../../services/alop-dosar-sql.mjs'), 'utf8');
    const helperSrc = fs.readFileSync(path.join(__dirname, '../../services/df-aprobat-sql.mjs'), 'utf8');

    // ⚠️ #134e a adăugat UN nivel de indirecție: alop.mjs nu mai importă direct helper-ul de
    // aprobare, ci fragmentele de DOSAR din alop-dosar-sql.mjs, care la rândul lor refolosesc
    // df-aprobat-sql.mjs. INTENȚIA testului (#134d) e neschimbată — nicăieri pe lanț nu se
    // rescriu gărzile inline — doar locul unde trăiește textul s-a mutat cu un fișier.
    expect(alopSrc).toMatch(/from\s*['"]\.\.\/services\/alop-dosar-sql\.mjs['"]/);
    expect(alopSrc).toMatch(/const SQL_ALOP_DF_APROBAT\s*=\s*sqlDosarAreAprobat\(/);
    expect(dosarSrc).toMatch(/from\s*['"]\.\/df-aprobat-sql\.mjs['"]/);

    // alop.mjs NU redefinește gărzile pe cont propriu — singura lor sursă rămâne helper-ul.
    expect(alopSrc).not.toMatch(/const SQL_ALOP_DF_APROBAT\s*=\s*`/);

    // Cele trei gărzi de excludere trăiesc ȘI în fragmentul de flux activ, ȘI în definiția
    // aprobării — sursa unde divergența dovedită la #134d s-ar putea strecura din nou.
    // Verificate pe SQL-ul CHIAR GENERAT, nu pe o felie de text sursă (mai robust la refactor).
    for (const guard of ['deleted_at IS NULL', "DISTINCT FROM 'cancelled'", "DISTINCT FROM 'refused'"]) {
      expect(sqlDosarAreFluxActiv('a'), `sqlDosarAreFluxActiv trebuie să conțină "${guard}"`).toContain(guard);
      expect(sqlDosarAreAprobat('a'),   `sqlDosarAreAprobat trebuie să conțină "${guard}"`).toContain(guard);
      expect(helperSrc, `dfAprobatExistsSql trebuie să conțină "${guard}"`).toContain(guard);
    }
  });
});
