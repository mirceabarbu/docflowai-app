/**
 * SEC-P0.4 — middleware CORS real, cu ORDINEA reală de montare.
 * Testul pe resolveAppOrigins (unit) NU demonstrează că landingCors/appCors se ramifică
 * corect pe rută; asta se dovedește doar cu supertest peste un express real.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mountCors } from '../../utils/cors-config.mjs';

function buildApp(env) {
  const app = express();
  mountCors(app, env);
  app.get('/api/my-flows', (req, res) => res.json({ ok: true }));
  app.post('/api/contact', (req, res) => res.json({ ok: true }));
  return app;
}

const APP_ENV = { CORS_ORIGIN: 'https://app.docflowai.ro' };

describe('SEC-P0.4 — CORS middleware (ordine reală)', () => {
  it('1 — landing NU are acces credentialed la aplicație (OPTIONS /api/my-flows)', async () => {
    const app = buildApp(APP_ENV);
    const res = await request(app)
      .options('/api/my-flows')
      .set('Origin', 'https://docflowai.ro')
      .set('Access-Control-Request-Method', 'GET');
    // Proprietatea de securitate: FĂRĂ Access-Control-Allow-Origin ⇒ browserul NU expune
    // răspunsul credentialed originii landing-ului. (Pachetul `cors` emite ACAC:true
    // necondiționat când credentials:true, dar fără un ACAO care să se potrivească e INERT.)
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('2 — landing are acces la /api/contact, FĂRĂ credențiale', async () => {
    const app = buildApp(APP_ENV);
    const res = await request(app)
      .options('/api/contact')
      .set('Origin', 'https://docflowai.ro')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBe('https://docflowai.ro');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('3 — originea aplicației primește ACAO exact + credentials', async () => {
    const app = buildApp(APP_ENV);
    const res = await request(app)
      .options('/api/my-flows')
      .set('Origin', 'https://app.docflowai.ro')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.docflowai.ro');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('4 — origine necunoscută nu primește ACAO', async () => {
    const app = buildApp(APP_ENV);
    const res = await request(app)
      .options('/api/my-flows')
      .set('Origin', 'https://evil.ro')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('5 — landing filtrat activ chiar când apare în CORS_ORIGIN (regresia v1)', async () => {
    const app = buildApp({ CORS_ORIGIN: 'https://app.docflowai.ro,https://docflowai.ro' });
    const res = await request(app)
      .options('/api/my-flows')
      .set('Origin', 'https://docflowai.ro')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
