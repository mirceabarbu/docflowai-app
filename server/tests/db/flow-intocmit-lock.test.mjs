/**
 * DB caracterizare — fix 29: identitatea "Întocmit" (nume+email) pe fluxul nou creat NU poate fi
 * impersonată prin body — se derivă ÎNTOTDEAUNA din actorul autentificat (JWT), indiferent ce
 * trimite clientul în `body.initEmail`/`body.initName`/`signers[].email` pentru rândul ÎNTOCMIT.
 *
 * Verifică ruta REALĂ POST /flows peste Postgres real (server/tests/db/**, auto-skip fără
 * TEST_DATABASE_URL; sursa de adevăr = CI).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';

const flowsRouter = (await import('../../routes/flows.mjs')).default;
const { injectFlowDeps } = await import('../../routes/flows.mjs');

injectFlowDeps({
  newFlowId: () => `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  notify: async () => {},
  wsPush: () => {},
});

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

async function getFlowRow(flowId) {
  const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
  return rows[0]?.data || null;
}

const d = describe.skipIf(!hasTestDb());

d('POST /flows — identitate ÎNTOCMIT blocată la actorul autentificat (fix 29)', () => {
  let app, orgId, actorId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const o = await seedOrgUser({ email: 'actor@x.ro', role: 'user' });
    orgId = o.orgId; actorId = o.userId;
    app = buildApp();
  });
  afterAll(() => pool.end());

  const actorCookie = () => makeAuthCookie({ userId: actorId, role: 'user', orgId, email: 'actor@x.ro' });

  it('body.initEmail/initName + semnatar ÎNTOCMIT spoofate cu altă persoană → flux creat cu identitatea actorului, NU cea din body', async () => {
    const res = await request(app)
      .post('/flows')
      .set('Cookie', actorCookie())
      .send({
        docName: 'Document test',
        initName: 'Alt Nume Impersonat',
        initEmail: 'altcineva@x.ro',
        signers: [
          { order: 1, rol: 'ÎNTOCMIT', name: 'Alt Nume Impersonat', email: 'altcineva@x.ro' },
          { order: 2, rol: 'VIZAT', name: 'Semnatar Doi', email: 'semnatar2@x.ro' },
        ],
      });

    expect(res.status).toBe(200);
    const flowId = res.body.flowId;
    expect(flowId).toBeTruthy();

    const data = await getFlowRow(flowId);
    expect(data.initEmail).toBe('actor@x.ro');
    const intocmitRow = (data.signers || []).find(s => s.rol === 'ÎNTOCMIT');
    expect(intocmitRow.email).toBe('actor@x.ro');
    expect(intocmitRow.email).not.toBe('altcineva@x.ro');
    // fix 45: numele ÎNTOCMIT e autoritar din DB (seedOrgUser seed-uiește actorul cu nume='Test'),
    // NU cel din body — JWT-ul de test (makeAuthCookie) nu cară `nume`, deci fallback-ul din
    // linia 114 ar fi căzut pe body fără fix-ul din DB.
    expect(intocmitRow.name).toBe('Test');
    expect(intocmitRow.name).not.toBe('Alt Nume Impersonat');

    // VIZAT (nu e ÎNTOCMIT) rămâne complet editabil — fără regresie
    const vizatRow = (data.signers || []).find(s => s.rol === 'VIZAT');
    expect(vizatRow.email).toBe('semnatar2@x.ro');
  });

  it('numele ÎNTOCMIT vine din DB (users.nume), NU din body.initName fals (fix 45)', async () => {
    const res = await request(app)
      .post('/flows')
      .set('Cookie', actorCookie())
      .send({
        docName: 'Document test nume',
        initName: 'Nume Fals Din Body',
        initEmail: 'actor@x.ro',
        signers: [
          { order: 1, rol: 'ÎNTOCMIT', name: 'Nume Fals Din Body', email: 'actor@x.ro' },
          { order: 2, rol: 'VIZAT', name: 'Semnatar Doi', email: 'semnatar2@x.ro' },
        ],
      });

    expect(res.status).toBe(200);
    const data = await getFlowRow(res.body.flowId);
    const intocmitRow = (data.signers || []).find(s => s.rol === 'ÎNTOCMIT');
    // seedOrgUser seed-uiește userul cu nume='Test' în DB — asta trebuie să câștige, nu body-ul
    expect(intocmitRow.name).toBe('Test');
    expect(intocmitRow.name).not.toBe('Nume Fals Din Body');
  });

  it('rol „INTOCMIT" FĂRĂ diacritic (atribut custom) → identitatea tot forțată la actor (fix diacritice v3.9.623)', async () => {
    const res = await request(app)
      .post('/flows')
      .set('Cookie', actorCookie())
      .send({
        docName: 'Document test',
        initName: 'Alt Nume Impersonat',
        initEmail: 'altcineva@x.ro',
        signers: [
          { order: 1, rol: 'INTOCMIT', name: 'Alt Nume Impersonat', email: 'altcineva@x.ro' },
          { order: 2, rol: 'VIZAT', name: 'Semnatar Doi', email: 'semnatar2@x.ro' },
        ],
      });

    expect(res.status).toBe(200);
    const data = await getFlowRow(res.body.flowId);
    // rândul cu atribut fără diacritic e recunoscut ca ÎNTOCMIT → identitatea = actorul, NU body-ul
    const intocmitRow = (data.signers || []).find(s => String(s.rol).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === 'INTOCMIT');
    expect(intocmitRow.email).toBe('actor@x.ro');
    expect(intocmitRow.email).not.toBe('altcineva@x.ro');
  });

  it('flux normal, fără spoofing (body.initEmail === actor) → comportament identic cu azi (non-regresie)', async () => {
    const res = await request(app)
      .post('/flows')
      .set('Cookie', actorCookie())
      .send({
        docName: 'Document normal',
        initName: 'Actor Normal',
        initEmail: 'actor@x.ro',
        signers: [
          { order: 1, rol: 'ÎNTOCMIT', name: 'Actor Normal', email: 'actor@x.ro' },
        ],
      });

    expect(res.status).toBe(200);
    const data = await getFlowRow(res.body.flowId);
    expect(data.initEmail).toBe('actor@x.ro');
    expect((data.signers || [])[0].email).toBe('actor@x.ro');
  });

  it('non-regresie: validarea 400 pe initName/initEmail lipsă/invalide în body rulează ÎNAINTE de auth', async () => {
    const resNoName = await request(app)
      .post('/flows')
      .set('Cookie', actorCookie())
      .send({ docName: 'Doc', initName: '', initEmail: 'actor@x.ro', signers: [{ order: 1, rol: 'ÎNTOCMIT', name: 'X', email: 'x@x.ro' }] });
    expect(resNoName.status).toBe(400);
    expect(resNoName.body.error).toBe('initName_required');

    const resBadEmail = await request(app)
      .post('/flows')
      .set('Cookie', actorCookie())
      .send({ docName: 'Doc', initName: 'Test User', initEmail: 'not-an-email', signers: [{ order: 1, rol: 'ÎNTOCMIT', name: 'X', email: 'x@x.ro' }] });
    expect(resBadEmail.status).toBe(400);
    expect(resBadEmail.body.error).toBe('initEmail_invalid');

    // fără cookie de auth deloc, dar body invalid → tot 400 (validarea rulează înainte de auth)
    const resAnon = await request(app)
      .post('/flows')
      .send({ docName: '', initName: 'X', initEmail: 'x@x.ro', signers: [{ order: 1, rol: 'ÎNTOCMIT', name: 'X', email: 'x@x.ro' }] });
    expect(resAnon.status).toBe(400);
    expect(resAnon.body.error).toBe('docName_required');
  });
});
