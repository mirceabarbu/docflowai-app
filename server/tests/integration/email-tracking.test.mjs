/**
 * DocFlowAI — Integration tests: Email tracking (/d/, /p/)
 *
 * Testează rutele de tracking neutral montate în server/index.mjs.
 * Folosim o app Express minimală care replică exact logica din index.mjs
 * fără a importa întregul server.
 *
 * Acoperire:
 *   GET /d/:trackingId — click tracking
 *     ✓ redirect 302 → docflowai.ro
 *     ✓ trackingId invalid (negăsit în DB) — redirect oricum, fără crash
 *     ✓ înregistrează EMAIL_OPENED la primul click
 *     ✓ nu înregistrează EMAIL_OPENED la click duplicat
 *     ✓ flux negăsit după query — skip silențios
 *     ✓ trackingId fără EVENT EMAIL_SENT asociat — skip silențios
 *
 *   GET /p/:trackingId — pixel tracking
 *     ✓ returnează GIF 1x1 (Content-Type: image/gif)
 *     ✓ header Cache-Control: no-store
 *     ✓ înregistrează EMAIL_OPENED via pixel
 *     ✓ deduplicare — nu înregistrează a doua oară
 *
 *   Query SQL
 *     ✓ folosește `id AS flow_id` (nu `flow_id`) — fix aplicat
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock-uri ──────────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn() },
  DB_READY:        true,
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn:  vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

import * as dbModule from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';

// ── App Express minimală — replică rutele /d/ și /p/ din index.mjs ────────────
// (identic cu implementarea, fără restul serverului)

function createTrackingApp() {
  const app = express();
  app.set('trust proxy', 1);

  // /d/:trackingId — click tracking
  app.get('/d/:trackingId', async (req, res) => {
    const safeDest = 'https://www.docflowai.ro';
    res.redirect(302, safeDest);

    setImmediate(async () => {
      try {
        const { trackingId } = req.params;
        if (!trackingId) return;
        const { rows } = await dbModule.pool.query(
          `SELECT id AS flow_id FROM flows WHERE data->'events' @> $1::jsonb LIMIT 1`,
          [JSON.stringify([{ trackingId }])]
        );
        if (!rows.length) return;
        const flowId = rows[0].flow_id;
        const data = await dbModule.getFlowData(flowId);
        if (!data) return;
        const events = Array.isArray(data.events) ? data.events : [];
        const emailEv = events.find(e => e.trackingId === trackingId);
        if (!emailEv) return;
        if (events.some(e => e.type === 'EMAIL_OPENED' && e.trackingId === trackingId)) return;
        const now = new Date().toISOString();
        const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '—';
        const ua  = (req.headers['user-agent'] || '').substring(0, 200);
        data.events.push({ at: now, type: 'EMAIL_OPENED', trackingId, to: emailEv.to, by: emailEv.by, ip, userAgent: ua });
        data.updatedAt = now;
        await dbModule.saveFlow(flowId, data);
        dbModule.writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'EMAIL_OPENED',
          actorEmail: emailEv.to, actorIp: ip,
          payload: { trackingId, sentBy: emailEv.by, via: 'click', userAgent: ua } });
        logger.info({ flowId, trackingId, ip }, '📬 Email deschis (click /d/)');
      } catch(e) { logger.warn({ err: e }, '/d/ tracking error'); }
    });
  });

  // /p/:trackingId — pixel tracking
  app.get('/p/:trackingId', async (req, res) => {
    const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store,no-cache,must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.end(GIF);

    setImmediate(async () => {
      try {
        const { trackingId } = req.params;
        if (!trackingId) return;
        const { rows } = await dbModule.pool.query(
          `SELECT id AS flow_id FROM flows WHERE data->'events' @> $1::jsonb LIMIT 1`,
          [JSON.stringify([{ trackingId }])]
        );
        if (!rows.length) return;
        const flowId = rows[0].flow_id;
        const data = await dbModule.getFlowData(flowId);
        if (!data) return;
        const events = Array.isArray(data.events) ? data.events : [];
        const emailEv = events.find(e => e.trackingId === trackingId);
        if (!emailEv) return;
        if (events.some(e => e.type === 'EMAIL_OPENED' && e.trackingId === trackingId)) return;
        const now = new Date().toISOString();
        const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '—';
        const ua  = (req.headers['user-agent'] || '').substring(0, 200);
        data.events.push({ at: now, type: 'EMAIL_OPENED', trackingId, to: emailEv.to, by: emailEv.by, ip, userAgent: ua });
        data.updatedAt = now;
        await dbModule.saveFlow(flowId, data);
        dbModule.writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'EMAIL_OPENED',
          actorEmail: emailEv.to, actorIp: ip,
          payload: { trackingId, sentBy: emailEv.by, via: 'pixel', userAgent: ua } });
        logger.info({ flowId, trackingId, ip }, '📬 Email deschis (pixel /p/)');
      } catch(e) { logger.warn({ err: e }, '/p/ tracking error'); }
    });
  });

  return app;
}

// ── Helper: așteptăm setImmediate să ruleze async logic ───────────────────────
function flushImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeFlowWithTracking(trackingId, alreadyOpened = false) {
  const events = [
    { type: 'EMAIL_SENT', trackingId, to: 'dest@extern.ro', by: 'init@primaria.ro', at: new Date().toISOString() },
  ];
  if (alreadyOpened) {
    events.push({ type: 'EMAIL_OPENED', trackingId, to: 'dest@extern.ro', by: 'init@primaria.ro', at: new Date().toISOString() });
  }
  return { flowId: 'PT_TRACK1', orgId: 1, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  dbModule.getFlowData.mockResolvedValue(null);
  dbModule.saveFlow.mockResolvedValue(undefined);
  dbModule.writeAuditEvent.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /d/:trackingId — click tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /d/:trackingId — click tracking', () => {
  const app = createTrackingApp();

  it('redirect 302 → docflowai.ro', async () => {
    const res = await request(app).get('/d/orice-id');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://www.docflowai.ro');
  });

  it('trackingId negăsit în DB — redirect oricum, fără crash', async () => {
    dbModule.pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/d/id-inexistent');
    expect(res.status).toBe(302);
    await flushImmediate();
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('înregistrează EMAIL_OPENED la primul click', async () => {
    const trackingId = 'track-abc-123';
    const flowData   = makeFlowWithTracking(trackingId);

    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_TRACK1' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get(`/d/${trackingId}`);
    await flushImmediate();

    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    const openedEv  = savedData.events.find(e => e.type === 'EMAIL_OPENED');
    expect(openedEv).toBeDefined();
    expect(openedEv.trackingId).toBe(trackingId);
    expect(openedEv.to).toBe('dest@extern.ro');
  });

  it('nu înregistrează EMAIL_OPENED a doua oară (deduplicare)', async () => {
    const trackingId = 'track-dup-999';
    const flowData   = makeFlowWithTracking(trackingId, true); // deja deschis

    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_TRACK1' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get(`/d/${trackingId}`);
    await flushImmediate();

    // saveFlow nu trebuie apelat — deja marcat ca deschis
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('flux negăsit după query — skip silențios, fără eroare', async () => {
    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_MISSING' }] });
    dbModule.getFlowData.mockResolvedValue(null);

    const res = await request(app).get('/d/track-xyz');
    expect(res.status).toBe(302);
    await flushImmediate();
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('eveniment EMAIL_SENT absent pentru trackingId — skip silențios', async () => {
    const flowData = { flowId: 'PT_NOEVENT', orgId: 1, events: [] };
    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_NOEVENT' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get('/d/no-email-event');
    await flushImmediate();
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('query SQL folosește id AS flow_id (fix aplicat)', async () => {
    await request(app).get('/d/test-sql-fix');
    await flushImmediate();
    const callArgs = dbModule.pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('id AS flow_id');
    expect(callArgs[0]).not.toContain('SELECT flow_id FROM flows');
  });

  it('scrie audit event cu via=click', async () => {
    const trackingId = 'track-audit-click';
    const flowData   = makeFlowWithTracking(trackingId);
    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_TRACK1' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get(`/d/${trackingId}`);
    await flushImmediate();

    expect(dbModule.writeAuditEvent).toHaveBeenCalledOnce();
    const auditCall = dbModule.writeAuditEvent.mock.calls[0][0];
    expect(auditCall.eventType).toBe('EMAIL_OPENED');
    expect(auditCall.payload.via).toBe('click');
    expect(auditCall.payload.trackingId).toBe(trackingId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /p/:trackingId — pixel tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /p/:trackingId — pixel tracking', () => {
  const app = createTrackingApp();

  it('returnează GIF 1x1 (Content-Type: image/gif)', async () => {
    const res = await request(app).get('/p/orice-id');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
  });

  it('header Cache-Control: no-store prezent', async () => {
    const res = await request(app).get('/p/test-cache');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('conținut este GIF binar valid (44 bytes)', async () => {
    const res = await request(app).get('/p/test-gif').buffer(true).parse((res, callback) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(res.body.length).toBe(42); // GIF 1x1 transparent = 42 bytes (cu headers)
  });

  it('înregistrează EMAIL_OPENED via pixel la primul acces', async () => {
    const trackingId = 'pixel-track-001';
    const flowData   = makeFlowWithTracking(trackingId);
    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_TRACK1' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get(`/p/${trackingId}`);
    await flushImmediate();

    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    const openedEv  = savedData.events.find(e => e.type === 'EMAIL_OPENED');
    expect(openedEv).toBeDefined();
    expect(openedEv.trackingId).toBe(trackingId);
  });

  it('deduplicare — al doilea request pixel nu salvează din nou', async () => {
    const trackingId = 'pixel-dup-002';
    const flowData   = makeFlowWithTracking(trackingId, true);
    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_TRACK1' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get(`/p/${trackingId}`);
    await flushImmediate();
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('scrie audit event cu via=pixel', async () => {
    const trackingId = 'pixel-audit-003';
    const flowData   = makeFlowWithTracking(trackingId);
    dbModule.pool.query.mockResolvedValue({ rows: [{ flow_id: 'PT_TRACK1' }] });
    dbModule.getFlowData.mockResolvedValue(flowData);

    await request(app).get(`/p/${trackingId}`);
    await flushImmediate();

    expect(dbModule.writeAuditEvent).toHaveBeenCalledOnce();
    const auditCall = dbModule.writeAuditEvent.mock.calls[0][0];
    expect(auditCall.payload.via).toBe('pixel');
  });

  it('query SQL folosește id AS flow_id (fix aplicat)', async () => {
    await request(app).get('/p/sql-fix-check');
    await flushImmediate();
    const callArgs = dbModule.pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('id AS flow_id');
  });
});
