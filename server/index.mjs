/**
 * DocFlowAI v3.2.0 — Main entry point (orchestrator)
 * FIX: notify — notif_email independent de notif_inapp
 * FIX: stampFooterOnPdf — latimea textului calculata corect cu font.widthOfTextAtSize
 * FIX: LOGIN_MAX/WINDOW/BLOCK exportate ca constante configurabile via ENV
 */

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { sendSignerEmail } from './mailer.mjs';
import { sendWaSignRequest, sendWaCompleted, sendWaRefused, isWhatsAppConfigured } from './whatsapp.mjs';
import { archiveFlow, verifyDrive } from './drive.mjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { pushToUser } from './push.mjs';

let PDFLib = null;
try { PDFLib = await import('pdf-lib'); } catch(e) { console.warn('⚠️ pdf-lib not available — flow stamp disabled:', e.message); }

import { pool, DB_READY, DB_LAST_ERROR, initDbWithRetry, saveFlow, getFlowData, requireDb } from './db/index.mjs';
import { JWT_SECRET, JWT_EXPIRES, requireAuth, requireAdmin, hashPassword, verifyPassword, generatePassword, sha256Hex } from './middleware/auth.mjs';

import authRouter from './routes/auth.mjs';
import { injectRateLimiter } from './routes/auth.mjs';
import notifRouter, { injectWsPush } from './routes/notifications.mjs';
import adminRouter, { injectWsSize } from './routes/admin.mjs';
import flowsRouter, { injectFlowDeps } from './routes/flows.mjs';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

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

// ── Health public ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'DocFlowAI', version: '3.2.1', ts: new Date().toISOString() });
});

app.get('/admin/health', (req, res) => {
  if (requireAdmin(req, res)) return;
  res.json({ ok: true, service: 'DocFlowAI', version: '3.2.1', dbReady: !!DB_READY, dbLastError: DB_LAST_ERROR ? String(DB_LAST_ERROR?.message || DB_LAST_ERROR) : null, ts: new Date().toISOString() });
});

// ── Template API ──────────────────────────────────────────────────────────
app.get('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query('SELECT institutie FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || '';
    const { rows } = await pool.query(
      `SELECT * FROM templates WHERE user_email=$1 OR (shared=TRUE AND institutie=$2 AND institutie!='')
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), institutie]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers_required' });
  try {
    const { rows: uRows } = await pool.query('SELECT institutie FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || '';
    const { rows } = await pool.query(
      'INSERT INTO templates (user_email,institutie,name,signers,shared) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [actor.email.toLowerCase(), institutie, name.trim(), JSON.stringify(signers), !!shared]
    );
    res.status(201).json({ ...rows[0], isOwner: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  try {
    const { rows } = await pool.query(
      'UPDATE templates SET name=$1,signers=$2,shared=$3,updated_at=NOW() WHERE id=$4 AND user_email=$5 RETURNING *',
      [name?.trim(), JSON.stringify(signers), !!shared, parseInt(req.params.id), actor.email.toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ...rows[0], isOwner: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM templates WHERE id=$1 AND user_email=$2', [parseInt(req.params.id), actor.email.toLowerCase()]);
    if (!rowCount) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function publicBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const host = req.get('host');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}
function makeFlowId(institutie) {
  const words = (institutie || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.length >= 2 ? words.slice(0, 4).map(w => w[0].toUpperCase()).join('') : (words[0] ? words[0].slice(0, 3).toUpperCase() : 'DOC');
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${initials}_${rand}`;
}
function newFlowId(institutie) { return makeFlowId(institutie); }
function buildSignerLink(req, flowId, token) {
  return `${publicBaseUrl(req)}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
}
function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}
function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ...rest, hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && data.driveFileLinkFinal)),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = s;
      return callerSignerToken && s.token === callerSignerToken ? { ...signerRest, token } : signerRest;
    }),
  };
}

const SIGNER_TOKEN_EXPIRY_DAYS = 90;
function isSignerTokenExpired(signer) {
  if (!signer.tokenCreatedAt) return false;
  const created = new Date(signer.tokenCreatedAt).getTime();
  return (Date.now() - created) > SIGNER_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

// ── Stamp footer helper ────────────────────────────────────────────────────
// Footer stamp — linia de identificare pe ultima pagina.
// Pentru flowType 'ancore': salvare cu useObjectStreams:false pentru a nu degrada AcroForm/campuri semnatura.
// Pentru flowType 'tabel': comportament implicit (useObjectStreams:true).
async function stampFooterOnPdf(pdfB64, flowData) {
  if (!pdfB64 || !PDFLib) return pdfB64;
  try {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const diacr = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
    function ro(t) { return String(t || '').split('').map(ch => diacr[ch] || ch).join(''); }
    const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const pdfDoc = await PDFDocument.load(Buffer.from(clean, 'base64'), { ignoreEncryption: true });
    const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const { width: pW } = lastPage.getSize();
    const MARGIN = 40, footerY = 14, FONT_SIZE = 7;
    const createdDate = flowData.createdAt
      ? new Date(flowData.createdAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' })
      : new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
    const parts = [ro(flowData.initName || ''), flowData.initFunctie ? ro(flowData.initFunctie) : null, flowData.institutie ? ro(flowData.institutie) : null, flowData.compartiment ? ro(flowData.compartiment) : null].filter(Boolean).join(', ');
    const footerLeft = createdDate + (parts ? '  |  ' + parts : '');
    const footerRight = ro(flowData.flowId || '') + '  |  DocFlowAI';

    const rightWidth = fontR.widthOfTextAtSize(footerRight, FONT_SIZE);
    const rightX = pW - MARGIN - rightWidth;
    const leftMaxWidth = rightX - MARGIN - 8;

    lastPage.drawLine({ start: { x: MARGIN, y: footerY + 10 }, end: { x: pW - MARGIN, y: footerY + 10 }, thickness: 0.4, color: rgb(0.75, 0.75, 0.75) });
    lastPage.drawText(footerLeft, { x: MARGIN, y: footerY, size: FONT_SIZE, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8, maxWidth: leftMaxWidth });
    lastPage.drawText(footerRight, { x: rightX, y: footerY, size: FONT_SIZE, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8 });

    // ancore: useObjectStreams:false pastreaza structura AcroForm intacta pentru aplicatiile de semnare calificata
    const isAncore = flowData.flowType === 'ancore';
    return Buffer.from(await pdfDoc.save({ useObjectStreams: !isAncore })).toString('base64');
  } catch(e) { console.warn('stampFooterOnPdf error:', e.message); return pdfB64; }
}

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
const LOGIN_MAX = parseInt(process.env.LOGIN_MAX || '10');
const LOGIN_WINDOW = parseInt(process.env.LOGIN_WINDOW_SEC || String(15 * 60));
const LOGIN_BLOCK = parseInt(process.env.LOGIN_BLOCK_SEC || String(15 * 60));

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

// ── Cleanup notificari vechi (max 500/user) ────────────────────────────────
// Rulat o data la 6 ore pentru a preveni cresterea nelimitata
setInterval(async () => {
  if (!pool || !DB_READY) return;
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM notifications
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_email ORDER BY created_at DESC) AS rn
          FROM notifications
        ) ranked
        WHERE rn > 500
      )
    `);
    if (rowCount > 0) console.log(`🧹 notifications: ${rowCount} notificări vechi șterse (limita 500/user).`);
  } catch(e) { console.error('Cleanup notificări error:', e.message); }
}, 6 * 60 * 60 * 1000);

// ── Notify helper ──────────────────────────────────────────────────────────
// FIX: notif_email si notif_inapp sunt independente
async function notify({ userEmail, flowId, type, title, message, waParams = {} }) {
  if (!pool || !DB_READY) return;
  const email = (userEmail || '').toLowerCase();
  if (!email) return;
  const [uRow] = (await pool.query('SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1', [email])).rows;

  // FIX: fiecare canal evaluat independent
  const needsInApp = uRow?.notif_inapp !== false; // default TRUE
  const needsEmail = !!(uRow?.notif_email);       // FIX: independent de notif_inapp
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
      const fd = await getFlowData(flowId);
      if (fd) { fd.events = [...(Array.isArray(fd.events) ? fd.events : []), ...eventsToAdd]; await saveFlow(flowId, fd); }
    } catch(e) { console.error('notify event save error:', e.message); }
  }
}

// ── Inject dependencies ───────────────────────────────────────────────────
injectRateLimiter(checkLoginRate, recordLoginFail, clearLoginRate);
injectWsPush(wsPush);
injectWsSize(() => wsClients.size);
injectFlowDeps({ notify, wsPush, PDFLib, stampFooterOnPdf, isSignerTokenExpired, newFlowId, buildSignerLink, stripSensitive, stripPdfB64, sendSignerEmail });

// ── Mount routers ─────────────────────────────────────────────────────────
app.use('/', authRouter);
app.use('/', notifRouter);
app.use('/', adminRouter);
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
  console.log(`🚀 DocFlowAI v3.2.0 server on port ${PORT}`);
  console.log(`🔌 WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
  initDbWithRetry();
});
