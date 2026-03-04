/**
 * DocFlowAI v2 — Main entry point (orchestrator)
 * Toate rutele sunt extrase în server/routes/
 * Toată logica DB în server/db/
 * Middleware în server/middleware/
 */

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { sendSignerEmail, verifySmtp } from './mailer.mjs';
import { sendWaSignRequest, sendWaCompleted, sendWaRefused, verifyWhatsApp, isWhatsAppConfigured, validatePhone } from './whatsapp.mjs';
import { archiveFlow, verifyDrive } from './drive.mjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';

import { pushToUser } from './push.mjs';
// ── PDF-lib opțional ───────────────────────────────────────────────────────
let PDFLib = null;
try { PDFLib = await import('pdf-lib'); } catch(e) { console.warn('⚠️ pdf-lib not available — flow stamp disabled:', e.message); }
injectPDFLib(PDFLib);

// ── DB layer ───────────────────────────────────────────────────────────────
import { pool, DB_READY, DB_LAST_ERROR, initDbWithRetry, saveFlow, getFlowData, withFlowLock, requireDb, appendFlowEvent, migrateEventsToTable } from './db/index.mjs';

// ── Auth middleware ────────────────────────────────────────────────────────
import { JWT_SECRET, JWT_EXPIRES, requireAuth, requireAdmin, hashPassword, verifyPassword, generatePassword, sha256Hex } from './middleware/auth.mjs';

// ── Routers ────────────────────────────────────────────────────────────────
import { newFlowId, buildSignerLink, stripSensitive, stripPdfB64, isSignerTokenExpired } from './utils/helpers.mjs';
import { stampFooterOnPdf, injectPDFLib } from './utils/pdf.mjs';
import templatesRouter from './routes/templates.mjs';

import { globalRateLimit, strictRateLimit, downloadRateLimit, adminRateLimit, injectRateLimitPool, startRateLimitCleanup } from './middleware/rateLimit.mjs';
import authRouter from './routes/auth.mjs';
import { injectRateLimiter } from './routes/auth.mjs';
import notifRouter, { injectWsPush } from './routes/notifications.mjs';
import adminRouter, { injectWsSize } from './routes/admin.mjs';
import flowsRouter, { injectFlowDeps } from './routes/flows.mjs';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true, credentials: true }));
app.use(express.json({ limit: '25mb' }));

// ── Request ID + safe JSON error envelope ─────────────────────────────────
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  const _json = res.json.bind(res);
  res.json = (body) => {
    try { if (body && typeof body === 'object' && body.error && !body.requestId) return _json({ ...body, requestId: req.requestId }); } catch(e) {}
    return _json(body);
  };
  next();
});

// ── Request log ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => { console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now()-start}ms rid=${req.requestId}`); });
  next();
});

// ── Rate limiting global ───────────────────────────────────────────────────
app.use(['/auth', '/api', '/flows', '/users'], globalRateLimit);
app.use(['/admin'], adminRateLimit);

process.on('unhandledRejection', (err) => console.error('❌ unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('❌ uncaughtException:', err));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'semdoc-initiator.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/notifications', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'notifications.html')));
app.get('/templates', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'templates.html')));



// ── WebSocket ──────────────────────────────────────────────────────────────
const wsClients = new Map();
function wsRegister(email, ws) { if (!wsClients.has(email)) wsClients.set(email, new Set()); wsClients.get(email).add(ws); }
function wsUnregister(email, ws) { wsClients.get(email)?.delete(ws); if (wsClients.get(email)?.size === 0) wsClients.delete(email); }
function wsPush(email, payload) {
  const conns = wsClients.get(email.toLowerCase()); if (!conns) return;
  const msg = JSON.stringify(payload);
  for (const ws of conns) { try { if (ws.readyState === 1) ws.send(msg); } catch(e) {} }
}

// ── Rate limiter (auth) ────────────────────────────────────────────────────
const LOGIN_MAX = 10, LOGIN_WINDOW = 15 * 60, LOGIN_BLOCK = 15 * 60;
function loginRateKey(req, email) { return `${req.ip || ''}:${(email || '').toLowerCase()}`; }
async function checkLoginRate(req, email) {
  if (!pool || !DB_READY) return { blocked: false };
  const key = loginRateKey(req, email);
  try {
    const { rows } = await pool.query('SELECT count, first_at, blocked_until FROM login_blocks WHERE key=$1', [key]);
    if (!rows.length) return { blocked: false };
    const { blocked_until } = rows[0];
    if (blocked_until && new Date(blocked_until) > new Date()) { const remainSec = Math.ceil((new Date(blocked_until) - Date.now()) / 1000); return { blocked: true, remainSec }; }
    return { blocked: false };
  } catch(e) { console.error('checkLoginRate error:', e.message); return { blocked: false }; }
}
async function recordLoginFail(req, email) {
  if (!pool || !DB_READY) return;
  const key = loginRateKey(req, email);
  try {
    await pool.query(`
      INSERT INTO login_blocks (key, count, first_at, updated_at) VALUES ($1, 1, NOW(), NOW())
      ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN login_blocks.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN 1 ELSE login_blocks.count + 1 END,
            first_at = CASE WHEN login_blocks.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN NOW() ELSE login_blocks.first_at END,
            blocked_until = CASE WHEN (CASE WHEN login_blocks.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN 1 ELSE login_blocks.count + 1 END) >= $3 THEN NOW() + ($4 || ' seconds')::INTERVAL ELSE NULL END,
            updated_at = NOW()
    `, [key, LOGIN_WINDOW, LOGIN_MAX, LOGIN_BLOCK]);
  } catch(e) { console.error('recordLoginFail error:', e.message); }
}
async function clearLoginRate(req, email) {
  if (!pool || !DB_READY) return;
  try { await pool.query('DELETE FROM login_blocks WHERE key=$1', [loginRateKey(req, email)]); } catch(e) {}
}
setInterval(async () => {
  if (!pool || !DB_READY) return;
  try {
    const { rowCount } = await pool.query(`DELETE FROM login_blocks WHERE (blocked_until IS NULL OR blocked_until < NOW()) AND first_at < NOW() - ($1 || ' seconds')::INTERVAL`, [LOGIN_WINDOW * 2]);
    if (rowCount > 0) console.log(`🧹 login_blocks: ${rowCount} intrări expirate șterse.`);
  } catch(e) {}
}, 30 * 60 * 1000);

// ── Notify helper ──────────────────────────────────────────────────────────
async function notify({ userEmail, flowId, type, title, message, waParams = {} }) {
  if (!pool || !DB_READY) return;
  const email = (userEmail || '').toLowerCase();
  if (!email) return;
  const [uRow] = (await pool.query('SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1', [email])).rows;
  const needsInApp = !!(uRow?.notif_inapp !== false);
  const needsEmail = !!(uRow?.notif_email && uRow?.notif_inapp !== false);
  const needsWa = !!(isWhatsAppConfigured() && uRow?.notif_whatsapp && uRow?.phone);

  if (needsInApp) {
    const r = await pool.query(
      'INSERT INTO notifications (user_email,flow_id,type,title,message) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [email, flowId || null, type, title, message]
    );
    wsPush(email, { event: 'new_notification', notification: { id: r.rows[0]?.id, flow_id: flowId, type, title, message, read: false, created_at: new Date().toISOString() } });
    const { rows: cntRows } = await pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [email]);
    wsPush(email, { event: 'unread_count', count: parseInt(cntRows[0].count) });
  }

  // Web Push (daca e configurat)
  pushToUser(pool, email, { title, body: message, icon: '/icon-192.png', badge: '/icon-72.png', data: { flowId, type } }).catch(() => {});

  const eventsToAdd = [];
  const [emailResult, waResult] = await Promise.allSettled([
    needsEmail ? sendSignerEmail({ to: email, subject: title, html: `<div style="font-family:sans-serif;padding:20px;"><h2>${title}</h2><p>${message}</p></div>` }) : Promise.resolve({ ok: false, reason: 'disabled' }),
    needsWa ? (async () => {
      if (type === 'YOUR_TURN') return sendWaSignRequest({ phone: uRow.phone, signerName: waParams.signerName || '', docName: waParams.docName || '' });
      if (type === 'COMPLETED') return sendWaCompleted({ phone: uRow.phone, docName: waParams.docName || '' });
      if (type === 'REFUSED') return sendWaRefused({ phone: uRow.phone, docName: waParams.docName || '', refuserName: waParams.refuserName || '', reason: waParams.reason || '' });
      return { ok: false, reason: 'unknown_type' };
    })() : Promise.resolve({ ok: false, reason: 'disabled' }),
  ]);

  if (emailResult.status === 'fulfilled' && emailResult.value?.ok) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY', channel: 'email', to: email, notifType: type });
  else if (needsEmail) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY_FAILED', channel: 'email', to: email, reason: String(emailResult.reason || emailResult.value?.error || 'failed') });

  if (waResult.status === 'fulfilled' && waResult.value?.ok) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY', channel: 'whatsapp', to: uRow?.phone || email, notifType: type });
  else if (needsWa) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY_FAILED', channel: 'whatsapp', to: uRow?.phone || email, reason: String(waResult.reason || waResult.value?.reason || 'failed') });

  if (eventsToAdd.length && flowId) {
    try {
      // appendFlowEvent e atomic per-rând — nu necesită lock pentru notificări
      for (const ev of eventsToAdd) { await appendFlowEvent(flowId, ev); }
    } catch(e) { console.error('notify event save error:', e.message); }
  }
}

// ── Inject dependencies into routers ─────────────────────────────────────
injectRateLimiter(checkLoginRate, recordLoginFail, clearLoginRate);
injectRateLimitPool(pool);
startRateLimitCleanup();
injectWsPush(wsPush);
injectWsSize(() => wsClients.size);
injectFlowDeps({ notify, wsPush, PDFLib, stampFooterOnPdf, isSignerTokenExpired, newFlowId, buildSignerLink, stripSensitive, stripPdfB64 });

// ── Mount routers ─────────────────────────────────────────────────────────
app.use('/', authRouter);
app.use('/', notifRouter);
app.use('/', adminRouter);
app.use('/', templatesRouter);
app.use('/', flowsRouter);

// ── HTTP Server + WebSocket ────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  let clientEmail = null;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth' && msg.token) {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          clientEmail = decoded.email.toLowerCase();
          wsRegister(clientEmail, ws);
          ws.send(JSON.stringify({ event: 'auth_ok', email: clientEmail }));
          if (pool && DB_READY) {
            pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [clientEmail])
              .then(r => ws.send(JSON.stringify({ event: 'unread_count', count: parseInt(r.rows[0].count) })))
              .catch(() => {});
          }
          console.log(`🔌 WS auth: ${clientEmail}`);
        } catch(e) { ws.send(JSON.stringify({ event: 'auth_error', message: 'invalid_token' })); }
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ event: 'pong' }));
    } catch(e) {}
  });
  ws.on('close', () => { if (clientEmail) { wsUnregister(clientEmail, ws); console.log(`🔌 WS closed: ${clientEmail}`); } });
  ws.on('error', (e) => console.error('WS error:', e.message));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`🧯 ${signal} received.`);
  httpServer.close(() => { console.log('✅ Server closed.'); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT;
if (!PORT) { console.error('❌ PORT missing.'); process.exit(1); }
httpServer.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 DocFlowAI server on port ${PORT}`);
  console.log(`🔌 WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
  initDbWithRetry().then(() => migrateEventsToTable());
});
