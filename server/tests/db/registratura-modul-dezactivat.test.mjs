/**
 * #214 — Registratură: modulul DEZACTIVAT pe organizație oprește numerotarea automată a
 * fluxurilor noi și închide rutele de sub /api/registratura/.
 *
 * Context (producție, 16.09.2026): Primăria Zărnești are `registratura` dezactivat pe org din
 * 20.05.2026, dar fiecare flux creat primea un număr de înregistrare (2683 până la 16.09),
 * tipărit în subsolul PDF ÎNAINTE de semnare ⇒ actele semnate purtau un al doilea număr,
 * neoficial.
 *
 * Regula lotului:
 *  - numerotarea AUTOMATĂ a fluxurilor se decide pe ORGANIZAȚIE (override `org` > catalog);
 *    override-urile `user`/`comp` NU contează — o serie nu poate avea goluri după cine lansează;
 *  - accesul la ecran/rute rămâne per UTILIZATOR (isModuleEnabled: user > comp > org > catalog);
 *  - numerele deja alocate rămân (idempotența primează); la reactivare, seria continuă.
 *
 * ⛔ IMPORTĂ din producție — nu redeclară logica. Testele au fost scrise ÎNAINTE de patch și
 * rulate roșii pe codul nereparat (vezi raportul #214).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  hasTestDb, migrate, truncateAll, pool, seedOrgUser, makeAuthCookie,
} from '../helpers/db-real.mjs';

// Doar logger-ul e mock-uit (zgomot). csrf, entitlements, registratura, db: REALE.
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

// Import dinamic (namespace) — pe codul nereparat `isModuleEnabledForOrg` NU există; un import
// static cu nume ar face SyntaxError la încărcare și ar înroși TOT fișierul, inclusiv testele
// de neregresie care trebuie să fie verzi și înainte de patch.
const ent = await import('../../services/entitlements.mjs');
const { allocateNumber } = await import('../../services/registratura.mjs');
const crudMod = await import('../../routes/flows/crud.mjs');
const registraturaRouter = (await import('../../routes/registratura.mjs')).default;

let _flowSeq = 0;
crudMod._injectDeps({
  notify: async () => {}, fireWebhook: null, wsPush: () => {},
  PDFLib: null, stampFooterOnPdf: null, isSignerTokenExpired: () => false,
  newFlowId: () => `flow-214-${++_flowSeq}`, buildSignerLink: () => '', stripSensitive: (x) => x,
  stripPdfB64: (x) => x, sendSignerEmail: async () => {},
});

const MODULE = 'registratura';
const CSRF = 'test-csrf-token-214';

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', crudMod.default);
  app.use('/', registraturaRouter);
  return app;
}

// ── helpers DB ────────────────────────────────────────────────────────────────
async function setOverride({ scopeType, scopeId, enabled, setBy }) {
  await pool.query(
    `INSERT INTO module_entitlements (module_key, scope_type, scope_id, enabled, set_by)
     VALUES ($1,$2,$3::text,$4,$5)
     ON CONFLICT (module_key, scope_type, scope_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [MODULE, scopeType, String(scopeId), enabled, setBy]
  );
  ent.invalidateAll(); // cache-ul de 60s trăiește în proces
}
async function clearOverrides() {
  await pool.query(`DELETE FROM module_entitlements WHERE module_key=$1`, [MODULE]);
  ent.invalidateAll();
}
async function countIntrari(orgId, extra = '', params = []) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM registru_intrari WHERE org_id=$1 ${extra}`, [orgId, ...params]);
  return rows[0].n;
}
async function contorSerie(orgId, registru = 'general') {
  const { rows } = await pool.query(
    `SELECT contor FROM registru_serii WHERE org_id=$1 AND registru=$2 AND an=$3`,
    [orgId, registru, new Date().getFullYear()]);
  return rows.length ? rows[0].contor : null; // null = rândul seriei nu există
}
async function readFlow(id) {
  const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [id]);
  return rows[0]?.data || null;
}

const d = describe.skipIf(!hasTestDb());
afterAll(() => pool.end());

// ═══════════════════════════════════════════════════════════════════════════════
d('#214 — isModuleEnabledForOrg (org > catalog, fără user/comp)', () => {
  let orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ent.invalidateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
  });

  it('(0) igienă — truncateAll golește module_entitlements și registru_serii (prin CASCADE)', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    await pool.query(`INSERT INTO registru_serii (org_id, registru, an) VALUES ($1,'general',$2)`,
      [orgId, new Date().getFullYear()]);
    await truncateAll();
    const { rows: e } = await pool.query(`SELECT COUNT(*)::int AS n FROM module_entitlements`);
    const { rows: s } = await pool.query(`SELECT COUNT(*)::int AS n FROM registru_serii`);
    expect(e[0].n).toBe(0);
    expect(s[0].n).toBe(0);
  });

  it('(1) fără override ⇒ default_enabled din catalog (registratura: true)', async () => {
    expect(await ent.isModuleEnabledForOrg(pool, { moduleKey: MODULE, orgId })).toBe(true);
  });

  it('(2) override org=false ⇒ false', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    expect(await ent.isModuleEnabledForOrg(pool, { moduleKey: MODULE, orgId })).toBe(false);
  });

  it('(3) ⭐ override org=false + user=true pe un user al org-ului ⇒ TOT false (user nu contează)', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    await setOverride({ scopeType: 'user', scopeId: userId, enabled: true, setBy: userId });
    // Control: regula per utilizator îl vede activ — cele două funcții răspund la întrebări diferite.
    expect(await ent.isModuleEnabled(pool, { moduleKey: MODULE, userId, orgId })).toBe(true);
    expect(await ent.isModuleEnabledForOrg(pool, { moduleKey: MODULE, orgId })).toBe(false);
  });

  it('(4) override org=true ⇒ true', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: true, setBy: userId });
    expect(await ent.isModuleEnabledForOrg(pool, { moduleKey: MODULE, orgId })).toBe(true);
  });

  it('(5) modul inexistent în catalog ⇒ false', async () => {
    expect(await ent.isModuleEnabledForOrg(pool, { moduleKey: 'modul_inexistent_214', orgId })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
d('#214 — allocateNumber cu doarDacaModululEActiv', () => {
  let orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ent.invalidateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
  });
  const alloc = (sursaId, extra = {}) => allocateNumber({
    orgId, sursaId, sursaTip: 'flow', flowId: sursaId, obiect: 'Doc', ...extra,
  });

  it('(6) ⭐ org dezactivat ⇒ null; zero rânduri noi; contorul seriei neschimbat', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    const r = await alloc('flow-6', { doarDacaModululEActiv: MODULE });
    expect(r).toBeNull();
    expect(await countIntrari(orgId)).toBe(0);
    const c = await contorSerie(orgId);
    expect(c === null || c === 0).toBe(true);
  });

  it('(7) org activ (fără override) ⇒ număr alocat, contor +1', async () => {
    const r = await alloc('flow-7', { doarDacaModululEActiv: MODULE });
    expect(r).not.toBeNull();
    expect(r.numar).toBe(1);
    expect(await countIntrari(orgId)).toBe(1);
    expect(await contorSerie(orgId)).toBe(1);
  });

  it('(8) ⭐ poziție existentă (alocată când era activ), apoi org dezactivat ⇒ se întoarce poziția existentă', async () => {
    const first = await alloc('flow-8', { doarDacaModululEActiv: MODULE });
    expect(first.numar).toBe(1);
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    const again = await alloc('flow-8', { doarDacaModululEActiv: MODULE });
    expect(again).not.toBeNull();
    expect(again.numar).toBe(1);
    expect(again.numarFormat).toBe(first.numarFormat);
    expect(await countIntrari(orgId)).toBe(1);
    expect(await contorSerie(orgId)).toBe(1);
  });

  it('(9) ⭐ neregresie înregistrare manuală: FĂRĂ parametru, org dezactivat ⇒ număr alocat', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    const r = await allocateNumber({
      orgId, sursaId: 'manual-9', sursaTip: 'manual', registru: 'general',
      directie: 'intrare', status: 'inregistrat', obiect: 'Cerere', createdBy: userId,
    });
    expect(r).not.toBeNull();
    expect(r.numar).toBe(1);
    expect(await countIntrari(orgId)).toBe(1);
  });

  it('(10) reactivare ⇒ seria continuă de unde rămăsese (fără salt, fără reluare de la 1)', async () => {
    const a = await alloc('flow-10a', { doarDacaModululEActiv: MODULE });
    expect(a.numar).toBe(1);
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    expect(await alloc('flow-10b', { doarDacaModululEActiv: MODULE })).toBeNull();
    expect(await contorSerie(orgId)).toBe(1);
    await clearOverrides();
    const c = await alloc('flow-10c', { doarDacaModululEActiv: MODULE });
    expect(c.numar).toBe(2);
    expect(await contorSerie(orgId)).toBe(2);
    expect(await countIntrari(orgId)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
d('#214 — crearea fluxului (POST /flows) respectă modulul pe ORGANIZAȚIE', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ent.invalidateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
    app = buildApp();
  });
  const cookie = () => makeAuthCookie({ userId, role: 'user', orgId, email: 'p1@x.ro' });
  const postFlow = () => request(app).post('/flows').set('Cookie', cookie()).send({
    docName: 'Doc test 214', initName: 'Initiator', initEmail: 'p1@x.ro',
    signers: [{ name: 'Semnatar Extern', email: 'extern@example.com', order: 1, rol: 'APROBAT' }],
    flowType: 'tabel',
  });

  it('(11) ⭐⭐ org dezactivat ⇒ 200; nrInregistrare NULL; zero rânduri în registru pentru flux', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    const res = await postFlow();
    expect(res.status).toBe(200);
    const flowId = res.body.flowId;
    expect(flowId).toBeTruthy();
    const data = await readFlow(flowId);
    expect(data.nrInregistrare ?? null).toBeNull();
    expect(data.nrInregistrareData ?? null).toBeNull();
    expect(await countIntrari(orgId, 'AND flow_id=$2', [flowId])).toBe(0);
    expect(await countIntrari(orgId)).toBe(0);
  });

  it('(12) ⭐ org dezactivat + override user=true pe inițiator ⇒ TOT fără număr (regula e pe org)', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    await setOverride({ scopeType: 'user', scopeId: userId, enabled: true, setBy: userId });
    const res = await postFlow();
    expect(res.status).toBe(200);
    const data = await readFlow(res.body.flowId);
    expect(data.nrInregistrare ?? null).toBeNull();
    expect(await countIntrari(orgId)).toBe(0);
  });

  it('(13) neregresie: fără override ⇒ nrInregistrare setat și rândul în registru există', async () => {
    const res = await postFlow();
    expect(res.status).toBe(200);
    const flowId = res.body.flowId;
    const data = await readFlow(flowId);
    expect(data.nrInregistrare).toBeTruthy();
    expect(await countIntrari(orgId, 'AND flow_id=$2', [flowId])).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
d('#214 — poarta modulului pe rutele /api/registratura/* (per UTILIZATOR)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ent.invalidateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
    app = buildApp();
  });
  // Cookie auth + cookie csrf (double-submit); header-ul x-csrf-token per request.
  const cookie = () => `${makeAuthCookie({ userId, role: 'user', orgId, email: 'p1@x.ro' })}; csrf_token=${CSRF}`;

  const ROUTES = [
    ['get',  '/api/registratura/intrari', null],
    ['get',  '/api/registratura/export.csv', null],
    ['post', '/api/registratura/intrari', { obiect: 'Cerere 214', registru: 'general' }],
    ['post', '/api/registratura/intrari/1/status', { status: 'repartizat' }],
    ['post', '/api/registratura/intrari/1/leaga-raspuns', { flowId: 'x' }],
    ['post', '/api/registratura/intrari/1/atasament', { fileB64: 'QUJD', filename: 'a.pdf' }],
    ['get',  '/api/registratura/intrari/1/atasamente', null],
    ['get',  '/api/registratura/atasament/1', null],
    ['get',  '/api/registratura/asignatari', null],
  ];

  it.each(ROUTES)('(14) ⭐ org dezactivat, user fără override ⇒ 403 module_disabled pe %s %s', async (method, path, body) => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    let req = request(app)[method](path).set('Cookie', cookie());
    if (method === 'post') req = req.set('x-csrf-token', CSRF).send(body);
    const res = await req;
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('module_disabled'); // al modulului, NU csrf_invalid
    // Poarta nu a consumat nimic: nicio intrare manuală creată.
    expect(await countIntrari(orgId)).toBe(0);
  });

  it('(15) org dezactivat + user=true ⇒ GET /intrari 200 (accesul rămâne per utilizator)', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    await setOverride({ scopeType: 'user', scopeId: userId, enabled: true, setBy: userId });
    const res = await request(app).get('/api/registratura/intrari').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('(16) GET /api/me/can-registratura ⇒ 200 { can:false } pentru user fără override (neinterceptat)', async () => {
    await setOverride({ scopeType: 'org', scopeId: orgId, enabled: false, setBy: userId });
    const res = await request(app).get('/api/me/can-registratura').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ can: false });
  });

  it('(17) neregresie: fără override ⇒ GET /intrari 200', async () => {
    const res = await request(app).get('/api/registratura/intrari').set('Cookie', cookie());
    expect(res.status).toBe(200);
  });

  it('(17b) neregresie: fără override ⇒ POST /intrari cu CSRF valid alocă număr (200)', async () => {
    const res = await request(app).post('/api/registratura/intrari')
      .set('Cookie', cookie()).set('x-csrf-token', CSRF)
      .send({ obiect: 'Cerere 214', registru: 'general' });
    expect(res.status).toBe(200);
    expect(res.body.numar).toBe(1);
    expect(await countIntrari(orgId)).toBe(1);
  });
});
