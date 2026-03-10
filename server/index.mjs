/**
 * DocFlowAI v3.3.4 — Main entry point (orchestrator)
 *
 * CHANGES v3.3.4:
 *  SEC-02: ADMIN_SECRET rate limiting + audit log (in auth.mjs)
 *  SEC-03: PBKDF2 600k + lazy re-hash (in auth.mjs + routes/auth.mjs)
 *  PERF-01: 3 indexuri JSONB noi (in db/index.mjs migration 021)
 *  LOG-01: Logging structurat JSON via middleware/logger.mjs (inlocuieste console.log)
 *  HEALTH: /health endpoint imbunatatit cu memory usage + DB latency
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
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
import { logger } from './middleware/logger.mjs';

let PDFLib = null;
try { PDFLib = await import('pdf-lib'); } catch(e) { logger.warn({ err: e }, 'pdf-lib not available - flow stamp disabled'); }

import { pool, DB_READY, DB_LAST_ERROR, initDbWithRetry, saveFlow, getFlowData, requireDb } from './db/index.mjs';
import { JWT_SECRET, JWT_EXPIRES, requireAuth, requireAdmin, hashPassword, verifyPassword, generatePassword, sha256Hex, escHtml } from './middleware/auth.mjs';

import authRouter from './routes/auth.mjs';
import { injectRateLimiter } from './routes/auth.mjs';
import notifRouter, { injectWsPush } from './routes/notifications.mjs';
import adminRouter, { injectWsSize } from './routes/admin.mjs';
import flowsRouter, { injectFlowDeps } from './routes/flows.mjs';

const app = express();
app.set('trust proxy', 1);

// SEC-01: cookie-parser — necesár pentru req.cookies.auth_token (JWT HttpOnly)
app.use(cookieParser());

// ── Security headers ──────────────────────────────────────────────────────
// Fallback manual dacă helmet nu e instalat încă (graceful degradation)
try {
  app.use(helmet({
    // SEC-05: CSP activat — protecție XSS
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],  // staging: permite CDN-urile folosite de pdf-lib/pdf.js
        styleSrc:    ["'self'", "'unsafe-inline'"],
        scriptSrcAttr:["'unsafe-inline'"],
        imgSrc:      ["'self'", 'data:', 'blob:'],
        connectSrc:  ["'self'", 'wss:', 'ws:'],
        objectSrc:   ["'none'"],
        frameAncestors: ["'none'"],           // previne clickjacking (înlocuiește X-Frame-Options)
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,         // necesar pentru PDF viewer blob:
    frameguard: { action: 'deny' },           // X-Frame-Options: DENY
  }));
} catch(e) {
  logger.warn('helmet not installed - adaug manual security headers');
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────
// FIX v3.2.2: origin:true cu credentials:true e periculos (accept orice domeniu).
// Fallback la domeniu explicit din PUBLIC_BASE_URL dacă CORS_ORIGIN nu e setat.
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : (process.env.PUBLIC_BASE_URL ? [process.env.PUBLIC_BASE_URL.replace(/\/$/, '')] : true);
app.use(cors({ origin: corsOrigins, credentials: true }));
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

// ── Request log structurat ────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl]({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms,
      requestId: req.requestId,
      ip: req.ip,
    }, 'request');
  });
  next();
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException',  (err) => logger.error({ err }, 'uncaughtException'));

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
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    service: 'DocFlowAI',
    version: '3.3.4',
    ts: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
    },
  });
});

app.get('/admin/health', async (req, res) => {
  if (requireAdmin(req, res)) return;
  let dbLatencyMs = null;
  if (pool && DB_READY) {
    const t0 = Date.now();
    try { await pool.query('SELECT 1'); dbLatencyMs = Date.now() - t0; } catch(_) {}
  }
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    service: 'DocFlowAI',
    version: '3.3.4',
    dbReady: !!DB_READY,
    dbLatencyMs,
    dbLastError: DB_LAST_ERROR ? String(DB_LAST_ERROR?.message || DB_LAST_ERROR) : null,
    wsClients: wsClients.size,
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
    },
    ts: new Date().toISOString(),
  });
});

// ── Template API ──────────────────────────────────────────────────────────
app.get('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query('SELECT institutie, org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || '';
    const orgId = uRows[0]?.org_id || actor.orgId || null;
    // FIX v3.2.3: filtrare pe org_id pentru sabloane partajate (nu doar pe institutie text)
    const { rows } = await pool.query(
      `SELECT * FROM templates WHERE user_email=$1 OR (shared=TRUE AND institutie=$2 AND institutie!='' AND ($3::integer IS NULL OR org_id=$3))
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), institutie, orgId]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (name.trim().length > 200) return res.status(400).json({ error: 'name_too_long', max: 200 });
  if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers_required' });
  if (signers.length > 50) return res.status(400).json({ error: 'too_many_signers', max: 50 });
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
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (name.trim().length > 200) return res.status(400).json({ error: 'name_too_long', max: 200 });
  if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers_required' });
  if (signers.length > 50) return res.status(400).json({ error: 'too_many_signers', max: 50 });
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
// FIX v3.3.2: escHtml importat din middleware/auth.mjs — eliminat duplicatul local

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

const SIGNER_TOKEN_EXPIRY_DAYS = parseInt(process.env.SIGNER_TOKEN_EXPIRY_DAYS || '90');
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
  } catch(e) { logger.warn({ err: e }, 'stampFooterOnPdf error (non-fatal)'); return pdfB64; }
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
  } catch(e) { logger.error({ err: e }, 'checkLoginRate error'); return { blocked: false }; }
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
  } catch(e) { logger.error({ err: e }, 'recordLoginFail error'); }
}
async function clearLoginRate(req, email) {
  if (!pool || !DB_READY) return;
  try { await pool.query('DELETE FROM login_blocks WHERE key=$1', [loginRateKey(req, email)]); } catch(e) {}
}
const _loginBlocksCleanupInterval = setInterval(async () => {
  if (!pool || !DB_READY) return;
  try {
    const { rowCount } = await pool.query(`DELETE FROM login_blocks WHERE (blocked_until IS NULL OR blocked_until < NOW()) AND first_at < NOW() - ($1 || ' seconds')::INTERVAL`, [LOGIN_WINDOW * 2]);
    if (rowCount > 0) logger.info({ rowCount }, 'login_blocks: intrari expirate sterse');
  } catch(e) {}
}, 30 * 60 * 1000);

// ── R-04: Reminder automat semnatari inactivi ─────────────────────────────
// Configurabil via ENV: REMINDER_INTERVAL_HOURS (default: 24h), REMINDER_INACTIVITY_DAYS (default: 3)
// Trimite notificare REMINDER semnatarului curent dacă fluxul nu a avut activitate în N zile.
const REMINDER_INTERVAL_MS   = (parseInt(process.env.REMINDER_INTERVAL_HOURS || '24') * 3600_000);
const REMINDER_INACTIVITY_MS = (parseInt(process.env.REMINDER_INACTIVITY_DAYS || '3') * 86_400_000);

async function _runReminderJob() {
  if (!pool || !DB_READY) return;
  try {
    const cutoff = new Date(Date.now() - REMINDER_INACTIVITY_MS).toISOString();
    const { rows } = await pool.query(
      `SELECT id, data FROM flows
       WHERE (data->>'completed') IS DISTINCT FROM 'true'
         AND (data->>'status') NOT IN ('refused','cancelled')
         AND updated_at < $1
       LIMIT 200`,
      [cutoff]
    );
    let reminded = 0;
    for (const row of rows) {
      const data = row.data;
      const flowId = row.id;
      const current = (data.signers || []).find(s => s.status === 'current');
      if (!current?.email) continue;
      // Evităm spam: verificăm dacă există deja o notificare REMINDER recentă (<24h)
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type='REMINDER'
         AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
        [current.email.toLowerCase(), flowId]
      );
      if (recent.length > 0) continue;
      await notify({
        userEmail: current.email, flowId, type: 'REMINDER',
        title: '⏳ Document în așteptare',
        message: `Documentul „${data.docName}" este în așteptarea semnăturii tale de mai mult de ${process.env.REMINDER_INACTIVITY_DAYS || 3} zile.`,
        waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
        urgent: false,
      });
      reminded++;
    }
    if (reminded > 0) logger.info({ reminded }, 'Reminder job: semnatari notificati');
  } catch(e) { logger.error({ err: e }, 'Reminder job error'); }
}
const _reminderInterval = setInterval(_runReminderJob, REMINDER_INTERVAL_MS);
logger.info({ intervalH: process.env.REMINDER_INTERVAL_HOURS || 24, inactivitateZ: process.env.REMINDER_INACTIVITY_DAYS || 3 }, 'Reminder job pornit');

// ── Cleanup notificari vechi (max 500/user) ────────────────────────────────
// Rulat o data la 6 ore pentru a preveni cresterea nelimitata
const _notifsCleanupInterval = setInterval(async () => {
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
    if (rowCount > 0) logger.info({ rowCount }, 'notifications: notificari vechi sterse (limita 500/user)');
  } catch(e) { logger.error({ err: e }, 'Cleanup notificari error'); }
}, 6 * 60 * 60 * 1000);

// ── Notify helper ──────────────────────────────────────────────────────────
// FIX: notif_email si notif_inapp sunt independente
async function notify({ userEmail, flowId, type, title, message, waParams = {}, urgent = false }) {
  if (!pool || !DB_READY) return;
  const email = (userEmail || '').toLowerCase();
  if (!email) return;
  const [uRow] = (await pool.query('SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1', [email])).rows;

  // FIX: fiecare canal evaluat independent
  const needsInApp = uRow?.notif_inapp !== false; // default TRUE
  const needsEmail = !!(uRow?.notif_email);       // FIX: independent de notif_inapp
  const needsWa = !!(isWhatsAppConfigured() && uRow?.notif_whatsapp && uRow?.phone);

  // Prefixăm titlul cu [URGENT] dacă e cazul
  const displayTitle = urgent ? `🚨 [URGENT] ${title}` : title;

  if (needsInApp) {
    const r = await pool.query(
      'INSERT INTO notifications (user_email,flow_id,type,title,message,urgent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, flowId || null, type, displayTitle, message, !!urgent]
    );
    wsPush(email, { event: 'new_notification', notification: { id: r.rows[0]?.id, flow_id: flowId, type, title: displayTitle, message, read: false, created_at: new Date().toISOString(), urgent: !!urgent } });
    const { rows: cntRows } = await pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [email]);
    wsPush(email, { event: 'unread_count', count: parseInt(cntRows[0].count) });
  }

  pushToUser(pool, email, { title: displayTitle, body: message, icon: '/icon-192.png', badge: '/icon-72.png', data: { flowId, type, urgent: !!urgent } }).catch(() => {});

  const eventsToAdd = [];
  const appUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';

  // Construiește HTML email — template complet pentru YOUR_TURN, simplu pentru restul
  let emailHtml;
  if (type === 'YOUR_TURN' && waParams.signerToken) {
    const signerLink = `${appUrl}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(waParams.signerToken)}`;
    const flowUrl = `${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}`;
    emailHtml = `
<div style="background:#0b1120;margin:0;padding:32px 16px;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1e1460 0%,#0f2a4a 100%);padding:28px 32px 24px;text-align:center;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:10px;padding:10px 18px;font-size:1.1rem;font-weight:800;color:#fff;letter-spacing:.5px;">📋 DocFlowAI</div>
    <div style="margin-top:14px;font-size:.8rem;color:rgba(255,255,255,.4);letter-spacing:1px;text-transform:uppercase;">Platformă documente electronice</div>
  </div>
  <!-- Body -->
  <div style="padding:28px 32px;">
    <p style="margin:0 0 6px;font-size:1rem;color:#cdd8ff;">Bună${waParams.signerName ? ', <strong>' + escHtml(waParams.signerName) + '</strong>' : ''},</p>
    <p style="margin:0 0 20px;font-size:.9rem;color:#9db0ff;line-height:1.6;">
      ${waParams.initName ? `<strong style="color:#eaf0ff;">${escHtml(waParams.initName)}</strong> te-a adăugat ca semnatar pe documentul de mai jos.` : 'Ești invitat să semnezi electronic un document.'}
      ${waParams.initFunctie || waParams.institutie ? `<br><span style="font-size:.82rem;color:#7c8db0;">${[waParams.initFunctie, waParams.institutie].filter(Boolean).map(escHtml).join(' · ')}</span>` : ''}
    </p>
    <!-- Document card -->
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
      <div style="font-size:1rem;font-weight:700;color:#eaf0ff;margin-bottom:8px;">📄 ${escHtml(waParams.docName || 'Document de semnat')}</div>
      ${waParams.institutie ? `<div style="font-size:.82rem;color:#9db0ff;margin-bottom:3px;">🏛 ${escHtml(waParams.institutie)}</div>` : ''}
      ${waParams.compartiment ? `<div style="font-size:.82rem;color:#9db0ff;margin-bottom:3px;">📂 ${escHtml(waParams.compartiment)}</div>` : ''}
      <div style="font-size:.8rem;color:#5a6a8a;margin-top:6px;">ID flux: <code style="color:#7c8db0;">${escHtml(flowId)}</code></div>
    </div>
    ${waParams.roundInfo ? `<div style="background:rgba(250,180,0,.08);border:1px solid rgba(250,180,0,.2);border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:.83rem;color:#ffd580;">🔄 ${escHtml(waParams.roundInfo)}</div>` : ''}
    <!-- CTA -->
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${signerLink}" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:1rem;letter-spacing:.3px;">✍️ Semnează documentul</a>
    </div>
    <div style="text-align:center;margin-bottom:8px;">
      <a href="${flowUrl}" style="font-size:.8rem;color:#5a6a8a;text-decoration:none;">🔍 Vezi statusul fluxului</a>
    </div>
    <!-- Warning -->
    <div style="background:rgba(255,100,100,.07);border:1px solid rgba(255,100,100,.18);border-radius:8px;padding:10px 14px;margin-top:16px;font-size:.8rem;color:#ffb3b3;">
      ⚠️ Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi în aplicație.
    </div>
  </div>
  <!-- Footer -->
  <div style="border-top:1px solid rgba(255,255,255,.06);padding:14px 32px;text-align:center;">
    <p style="margin:0;font-size:.72rem;color:rgba(255,255,255,.25);">Link valabil 90 de zile · DocFlowAI · Dacă nu ești semnatarul acestui document, ignoră acest email.</p>
  </div>
</div>
</div>`;
  } else {
    // Template generic pentru REFUSED, COMPLETED, REVIEW_REQUESTED etc.
    const iconMap = { COMPLETED: '✅', REFUSED: '⛔', REVIEW_REQUESTED: '🔄', DELEGATED: '👥' };
    const icon = iconMap[type] || 'ℹ️';
    emailHtml = `
<div style="background:#0b1120;margin:0;padding:32px 16px;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);">
  <div style="background:linear-gradient(135deg,#1e1460 0%,#0f2a4a 100%);padding:24px 32px;text-align:center;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:10px;padding:10px 18px;font-size:1.1rem;font-weight:800;color:#fff;">📋 DocFlowAI</div>
  </div>
  <div style="padding:28px 32px;">
    <h2 style="margin:0 0 12px;font-size:1.05rem;color:#eaf0ff;">${icon} ${escHtml(title)}</h2>
    <p style="margin:0 0 16px;font-size:.9rem;color:#9db0ff;line-height:1.6;">${escHtml(message)}</p>
    ${flowId ? `<div style="text-align:center;margin-top:20px;"><a href="${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}" style="display:inline-block;background:rgba(124,92,255,.2);border:1px solid rgba(124,92,255,.4);color:#b39dff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:.88rem;font-weight:600;">🔍 Vezi detalii flux</a></div>` : ''}
  </div>
  <div style="border-top:1px solid rgba(255,255,255,.06);padding:12px 32px;text-align:center;">
    <p style="margin:0;font-size:.72rem;color:rgba(255,255,255,.25);">DocFlowAI · Platformă documente electronice</p>
  </div>
</div>
</div>`;
  }

  const [emailResult, waResult] = await Promise.allSettled([
    needsEmail ? sendSignerEmail({ to: email, subject: urgent ? `🚨 [URGENT] ${title}` : title, html: emailHtml }) : Promise.resolve({ ok: false, reason: 'disabled' }),
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
    } catch(e) { logger.error({ err: e, flowId }, 'notify event save error'); }
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

// FIX v3.2.2: heartbeat pentru detecție conexiuni zombie + timeout auth
const WS_AUTH_TIMEOUT_MS = 15_000;  // 15s să trimită auth
const WS_PING_INTERVAL_MS = 30_000; // ping la 30s

const wsHeartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL_MS);
wss.on('close', () => clearInterval(wsHeartbeat));

// SEC-01: helper — parsează cookie auth_token din header-ul de upgrade WS
function getWsCookieToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

wss.on('connection', (ws, req) => {
  let clientEmail = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // SEC-01: încearcă auto-auth din cookie-ul HttpOnly trimis la upgrade
  const cookieToken = getWsCookieToken(req);
  if (cookieToken) {
    try {
      const decoded = jwt.verify(cookieToken, JWT_SECRET);
      clientEmail = decoded.email.toLowerCase();
      wsRegister(clientEmail, ws);
      ws.send(JSON.stringify({ event: 'auth_ok', email: clientEmail }));
      if (pool && DB_READY) {
        pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [clientEmail])
          .then(r => ws.send(JSON.stringify({ event: 'unread_count', count: parseInt(r.rows[0].count) })))
          .catch(() => {});
      }
      logger.info({ email: clientEmail }, 'WS auto-auth (cookie)');
    } catch(e) {
      // Cookie invalid/expirat — continuăm, clientul poate trimite auth manual
      logger.warn({ err: e }, 'WS cookie invalid');
    }
  }

  // Timeout dacă clientul nu a reușit auto-auth și nu trimite auth manual în 15s
  const authTimeout = setTimeout(() => {
    if (!clientEmail) {
      ws.send(JSON.stringify({ event: 'auth_timeout', message: 'Autentificare obligatorie în 15s.' }));
      ws.terminate();
    }
  }, WS_AUTH_TIMEOUT_MS);

  // Dacă auto-auth a reușit, anulăm timeout-ul
  if (clientEmail) clearTimeout(authTimeout);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Fallback: auth manual cu token (compatibilitate tranziție)
      if (msg.type === 'auth' && msg.token) {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          clientEmail = decoded.email.toLowerCase();
          clearTimeout(authTimeout);
          wsRegister(clientEmail, ws);
          ws.send(JSON.stringify({ event: 'auth_ok', email: clientEmail }));
          if (pool && DB_READY) {
            pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [clientEmail])
              .then(r => ws.send(JSON.stringify({ event: 'unread_count', count: parseInt(r.rows[0].count) })))
              .catch(() => {});
          }
          logger.info({ email: clientEmail }, 'WS auth (token)');
        } catch(e) { ws.send(JSON.stringify({ event: 'auth_error', message: 'invalid_token' })); }
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ event: 'pong' }));
    } catch(e) {}
  });
  ws.on('close', () => { clearTimeout(authTimeout); if (clientEmail) { wsUnregister(clientEmail, ws); logger.info({ email: clientEmail }, 'WS connection closed'); } });
  ws.on('error', (e) => logger.error({ err: e }, 'WS error'));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  // FIX v3.2.3: oprim toate intervalele la shutdown
  clearInterval(_loginBlocksCleanupInterval);
  clearInterval(_notifsCleanupInterval);
  clearInterval(_reminderInterval);
  clearInterval(wsHeartbeat);
  httpServer.close(() => { logger.info('Server closed.'); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT;
if (!PORT) { logger.error('PORT missing - setati variabila de mediu PORT'); process.exit(1); }
httpServer.listen(Number(PORT), '0.0.0.0', () => {
  logger.info({ port: PORT }, 'DocFlowAI v3.3.4 server pornit');
  logger.info({ port: PORT }, 'WebSocket ready');
  initDbWithRetry();
});
