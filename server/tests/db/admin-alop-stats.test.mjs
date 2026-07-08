/**
 * GET /admin/alop/stats — 4 KPI ALOP pentru Dashboard admin (read-only, prompt 66).
 *  - alop_active          = COUNT status IN (angajare,lichidare,ordonantare,plata)
 *  - alop_finalizate_an   = COUNT completed AND df.an_referinta = an curent
 *  - valoare_angajata_an  = SUM(col.10 rows_ctrl) pe ALOP cu df.an_referinta = an curent
 *  - valoare_platita_an   = SUM(suma_totala_platita + plata_suma_efectiva) idem
 * Scoping: org_admin → propriul org; admin (super-admin) → tot sistemul.
 * „An curent" = df.an_referinta (NULL → COALESCE anul curent), consecvent cu buget-an.mjs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  redactUrl: (u) => u,
}));

const adminFlowsRouter = (await import('../../routes/admin/flows.mjs')).default;

function buildAdminApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', adminFlowsRouter);
  return app;
}

const CUR = new Date().getFullYear();
const d = describe.skipIf(!hasTestDb());

d('GET /admin/alop/stats — 4 KPI ALOP (prompt 66)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ orgName: 'Org 1' });                    // org id 1
    await seedOrgUser({ orgName: 'Org 2', email: 'o2@x.ro' });  // org id 2
    app = buildAdminApp();
  });
  afterAll(() => pool.end());

  // Seed un ALOP + DF legat (col.10 din rows_ctrl) într-un org.
  async function seedScenarioAlop({ orgId, status, an, col10 = 0, platita = 0, plataEfectiva = 0, cancelled = false }) {
    const dfId = await seedDf({
      orgId, createdBy: 1, status: 'aprobat', nrUnic: `DF-${orgId}-${status}-${an}-${Math.random().toString(36).slice(2,6)}`,
      anReferinta: an, rowsCtrl: [{ sum_rezv_crdt_bug_act: String(col10) }],
    });
    return seedAlop({
      orgId, createdBy: 1, status, dfId,
      sumaTotalaPlatita: platita, plataSumaEfectiva: plataEfectiva,
      ...(cancelled ? { cancelledAt: new Date() } : {}),
    });
  }

  // Scenariu comun pe org 1.
  async function seedOrg1() {
    // A: activ, an curent, angajat 10000, platit 2000
    await seedScenarioAlop({ orgId: 1, status: 'angajare',  an: CUR,     col10: 10000, platita: 2000 });
    // B: finalizat, an curent, angajat 5000, plata efectivă 1500
    await seedScenarioAlop({ orgId: 1, status: 'completed', an: CUR,     col10: 5000,  plataEfectiva: 1500 });
    // C: activ dar an PRECEDENT → exclus din sume/finalizate, inclus în active
    await seedScenarioAlop({ orgId: 1, status: 'lichidare', an: CUR - 1, col10: 7000,  platita: 999 });
    // D: anulat → exclus complet
    await seedScenarioAlop({ orgId: 1, status: 'angajare',  an: CUR,     col10: 8888,  platita: 8888, cancelled: true });
  }

  const cookieOrgAdmin1 = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });
  const cookieAdmin     = () => makeAuthCookie({ userId: 1, role: 'admin', orgId: null });
  const cookieUser      = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('org_admin vede DOAR org-ul propriu; count-uri și sume corecte', async () => {
    await seedOrg1();
    // zgomot în org 2 (nu trebuie numărat de org_admin al org 1)
    await seedScenarioAlop({ orgId: 2, status: 'angajare', an: CUR, col10: 99999, platita: 99999 });

    const res = await request(app).get('/admin/alop/stats').set('Cookie', cookieOrgAdmin1());
    expect(res.status).toBe(200);
    expect(res.body.alop_active).toBe(2);              // A + C (B completed, D cancelled)
    expect(res.body.alop_finalizate_an).toBe(1);       // B
    expect(res.body.valoare_angajata_an).toBe(15000);  // A(10000)+B(5000); C prev-year, D cancelled excluse
    expect(res.body.valoare_platita_an).toBe(3500);    // A(2000)+B(1500)
  });

  it('super-admin global (admin, !orgId) agregă TOATE organizațiile', async () => {
    await seedOrg1();
    await seedScenarioAlop({ orgId: 2, status: 'angajare', an: CUR, col10: 20000, platita: 5000 });

    const res = await request(app).get('/admin/alop/stats').set('Cookie', cookieAdmin());
    expect(res.status).toBe(200);
    expect(res.body.alop_active).toBe(3);              // org1: A + C ; org2: 1
    expect(res.body.alop_finalizate_an).toBe(1);       // org1 B
    expect(res.body.valoare_angajata_an).toBe(35000);  // 15000 + 20000
    expect(res.body.valoare_platita_an).toBe(8500);    // 3500 + 5000
  });

  it('sumele = suma per-rând a acelorași expresii (paritate cu lista)', async () => {
    await seedOrg1();
    const res = await request(app).get('/admin/alop/stats').set('Cookie', cookieOrgAdmin1());
    // suma angajată = SUM col.10 pe DF-urile ALOP-urilor din an curent, necancelate
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM((SELECT COALESCE(SUM((r->>'sum_rezv_crdt_bug_act')::numeric),0)
              FROM jsonb_array_elements(COALESCE(df.rows_ctrl,'[]'::jsonb)) r
              WHERE (r->>'sum_rezv_crdt_bug_act') ~ '^[0-9.]+$')),0)::float8 AS s
        FROM alop_instances a LEFT JOIN formulare_df df ON df.id=a.df_id
       WHERE a.org_id=1 AND a.cancelled_at IS NULL
         AND COALESCE(df.an_referinta, ${CUR}) = ${CUR}`);
    expect(res.body.valoare_angajata_an).toBe(Number(rows[0].s));
  });

  it('user normal → 403', async () => {
    const res = await request(app).get('/admin/alop/stats').set('Cookie', cookieUser());
    expect(res.status).toBe(403);
  });

  it('fără date → toate 0', async () => {
    const res = await request(app).get('/admin/alop/stats').set('Cookie', cookieOrgAdmin1());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alop_active: 0, valoare_angajata_an: 0, valoare_platita_an: 0, alop_finalizate_an: 0 });
  });
});
