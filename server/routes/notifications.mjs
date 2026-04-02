/**
 * DocFlowAI — Notifications routes
 * GET /api/notifications, /api/notifications/with-status, unread-count,
 * POST /:id/read, /read-all, DELETE /:id, GET /api/my-signer-token/:flowId
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { pool, requireDb, getFlowData } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

// wsPush injectat la montare
let _wsPush;
export function injectWsPush(fn) { _wsPush = fn; }

const router = Router();

router.get('/api/notifications', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100',
      [actor.email.toLowerCase()]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.get('/api/notifications/with-status', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100',
      [actor.email.toLowerCase()]
    );

    // FIX v3.2.2: batch query în loc de N+1 — un singur query pentru toate flow_id-urile relevante
    const flowIds = [...new Set(
      rows
        .filter(n => (n.type === 'YOUR_TURN' || n.type === 'REVIEW_REQUESTED') && n.flow_id)
        .map(n => n.flow_id)
    )];

    const flowMap = {};
    if (flowIds.length > 0) {
      const { rows: flowRows } = await pool.query(
        'SELECT id, data FROM flows WHERE id = ANY($1)',
        [flowIds]
      );
      for (const fr of flowRows) {
        const signer = (fr.data?.signers || []).find(
          s => (s.email || '').toLowerCase() === actor.email.toLowerCase()
        );
        flowMap[fr.id] = { signer_status: signer?.status || null, flow_urgent: !!(fr.data?.urgent) };
      }
    }

    const enriched = rows.map(n => {
      if ((n.type === 'YOUR_TURN' || n.type === 'REVIEW_REQUESTED') && n.flow_id && flowMap[n.flow_id]) {
        return { ...n, ...flowMap[n.flow_id] };
      }
      return { ...n, signer_status: null, flow_urgent: !!(n.urgent) };
    });

    res.json(enriched);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.get('/api/notifications/unread-count', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE',
      [actor.email.toLowerCase()]
    );
    res.json({ count: parseInt(rows[0].count) });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.post('/api/notifications/:id/read', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    await pool.query('UPDATE notifications SET read=TRUE WHERE id=$1 AND user_email=$2',
      [parseInt(req.params.id), actor.email.toLowerCase()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.post('/api/notifications/read-all', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    await pool.query('UPDATE notifications SET read=TRUE WHERE user_email=$1 AND read=FALSE',
      [actor.email.toLowerCase()]);
    _wsPush?.(actor.email, { event: 'unread_count', count: 0 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.delete('/api/notifications/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    await pool.query('DELETE FROM notifications WHERE id=$1 AND user_email=$2',
      [parseInt(req.params.id), actor.email.toLowerCase()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.get('/api/my-signer-token/:flowId', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signer = (data.signers || []).find(s => (s.email || '').toLowerCase() === actor.email.toLowerCase());
    if (!signer) return res.status(403).json({ error: 'not_a_signer' });
    res.json({ token: signer.token, flowId: req.params.flowId, status: signer.status });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── GET /api/my-pending-flows — fluxuri unde userul curent e semnatar activ ──
// Folosit de bulk-signer.html și semdoc-initiator.html pentru selecția bulk
router.get('/api/my-pending-flows', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const email = actor.email.toLowerCase();
    const orgId = actor.orgId || null;
    let whereClause, params;
    if (orgId) {
      whereClause = `(data->>'completed') IS DISTINCT FROM 'true'
        AND (data->>'status') IS DISTINCT FROM 'cancelled'
        AND (data->>'status') IS DISTINCT FROM 'refused'
        AND org_id = $2 AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(data->'signers') s
          WHERE lower(s->>'email') = $1 AND s->>'status' = 'current'
        )`;
      params = [email, orgId];
    } else {
      whereClause = `(data->>'completed') IS DISTINCT FROM 'true'
        AND (data->>'status') IS DISTINCT FROM 'cancelled'
        AND (data->>'status') IS DISTINCT FROM 'refused'
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(data->'signers') s
          WHERE lower(s->>'email') = $1 AND s->>'status' = 'current'
        )`;
      params = [email];
    }
    const { rows } = await pool.query(
      `SELECT id AS flow_id, data, created_at FROM flows
       WHERE ${whereClause} ORDER BY created_at DESC LIMIT 50`,
      params
    );
    const flows = rows.map(r => {
      const d = r.data || {};
      const signer = (d.signers || []).find(s => (s.email||'').toLowerCase() === email && s.status === 'current');
      return {
        flowId:      d.flowId,
        docName:     d.docName || '—',
        flowType:    d.flowType || 'tabel',
        createdAt:   d.createdAt || r.created_at,
        urgent:      !!(d.urgent),
        signerToken: signer?.token || null,
        signingProvider: signer?.signingProvider || null,
      };
    }).filter(f => f.flowId && f.signerToken);
    res.json({ flows, total: flows.length });
  } catch(e) { logger.error({ err: e }, 'my-pending-flows error'); res.status(500).json({ error: 'server_error' }); }
});

export default router;

// ── Push Subscription endpoints ──────────────────────────────────────────
// Importul e lazy — push.mjs are import dinamic pentru web-push
let _pushModule = null;
async function getPush() { if (!_pushModule) _pushModule = await import('../push.mjs'); return _pushModule; }

// GET /api/push/vapid-public-key — cheia publică VAPID pentru Service Worker
router.get('/api/push/vapid-public-key', async (req, res) => {
  const push = await getPush();
  const key = push.getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'push_not_configured' });
  res.json({ key });
});

// POST /api/push/subscribe — înregistrează un abonament push
router.post('/api/push/subscribe', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'invalid_subscription' });
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_email, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_email, endpoint) DO UPDATE SET p256dh=$3, auth=$4`,
      [actor.email.toLowerCase(), endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/push/subscribe — dezabonare
router.delete('/api/push/subscribe', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint_required' });
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE user_email=$1 AND endpoint=$2', [actor.email.toLowerCase(), endpoint]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});
