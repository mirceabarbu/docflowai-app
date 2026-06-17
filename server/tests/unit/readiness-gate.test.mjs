/**
 * readiness-gate.test.mjs (P0.1)
 *
 * Caracterizează + verifică gate-ul de readiness separat de liveness:
 *  - /health  → liveness pur: mereu 200 + ok:true (comportament neschimbat).
 *  - /readyz  → 200 doar dacă DB_READY && SELECT 1 trece; altfel 503 db_not_ready.
 *  - state machine: markDbFailed închide gate-ul (requireDb 503), markDbReady îl deschide.
 *
 * NB: acest fișier NU mock-uiește db/index.mjs — vrem markDbReady/markDbFailed/requireDb
 * + live bindings DB_READY/DB_LAST_ERROR REALE. (DATABASE_URL nesetat în unit → pool=null,
 * dar requireDb depinde DOAR de DB_READY.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeHealthRouter } from '../../routes/health.mjs';
import { markDbReady, markDbFailed, requireDb } from '../../db/index.mjs';

describe('/health — liveness pur', () => {
  it('întoarce 200 + ok:true indiferent de starea DB', async () => {
    const app = express();
    app.use(makeHealthRouter({ version: '9.9.9', pool: null, getReady: () => false, getLastError: () => 'boom' }));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('DocFlowAI');
    expect(res.body.version).toBe('9.9.9');
    expect(res.body.memory).toBeTypeOf('object');
  });
});

describe('/readyz — readiness gate', () => {
  function mkApp({ ready, lastErr = null, ping } = {}) {
    const app = express();
    const pool = ping ? { query: ping } : null;
    app.use(makeHealthRouter({ version: '9.9.9', pool, getReady: () => ready, getLastError: () => lastErr }));
    return app;
  }

  it('503 db_not_ready când DB_READY=false (cu dbLastError)', async () => {
    const res = await request(mkApp({ ready: false, lastErr: 'migration boom' })).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('db_not_ready');
    expect(res.body.dbLastError).toBe('migration boom');
  });

  it('503 când pool lipsește', async () => {
    const res = await request(mkApp({ ready: true, ping: null })).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('db_not_ready');
  });

  it('503 când SELECT 1 aruncă (dbLastError = mesajul erorii)', async () => {
    const res = await request(mkApp({ ready: true, ping: async () => { throw new Error('conn refused'); } })).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('db_not_ready');
    expect(res.body.dbLastError).toBe('conn refused');
  });

  it('200 ok:true dbReady:true când DB_READY && SELECT 1 trece', async () => {
    const res = await request(mkApp({ ready: true, ping: async () => ({ rows: [{ '?column?': 1 }] }) })).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dbReady).toBe(true);
  });
});

describe('state machine: markDbReady / markDbFailed → requireDb', () => {
  function fakeRes() {
    return {
      statusCode: null, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }

  it('markDbFailed închide gate-ul: requireDb → 503 db_not_ready cu dbLastError', () => {
    markDbFailed(new Error('v4 migration failed'));
    const res = fakeRes();
    const blocked = requireDb(res);
    expect(blocked).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('db_not_ready');
    expect(res.body.dbLastError).toBe('v4 migration failed');
  });

  it('markDbReady deschide gate-ul: requireDb → false (lasă traficul să treacă)', () => {
    markDbReady();
    const res = fakeRes();
    const blocked = requireDb(res);
    expect(blocked).toBe(false);
    expect(res.statusCode).toBe(null);
  });
});
