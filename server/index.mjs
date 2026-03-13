/**
 * DocFlowAI v3.4.0 — Main entry point (orchestrator)
 *
 * CHANGES v3.4.0:
 *  REFACTOR-01: stampFooterOnPdf() extras în server/pdf/stamp.mjs
 *  REFACTOR-02: notify() extras în server/notifications/notify.mjs
 *  SEC-02: Signer token mutat din query string în X-Signer-Token header (frontend)
 *           Backend păstrează req.query.token fallback pentru linkuri vechi (~90 zile)
 *
 * CHANGES v3.3.8 (incluse):
 *  FIX-01: Versiunea citită dinamic din package.json (nu mai e hardcodată)
 *  FIX-02: express.json limite diferențiate per-rută (global 50kb, PDF 52mb)
 *  FIX-03: body.meta validat — limitat la 50 câmpuri, valori max 1000 chars
 *  FIX-04: Templates API mutat în routes/templates.mjs
 *  FIX-05: generatePassword() — entropie mărită (12 char, alfabet extins)
 *  SEC-01: Rate limiter migrare PostgreSQL-backed (nu mai pierde starea la restart)
 *  FEAT-01: Webhook per organizație la FLOW_COMPLETED cu retry backoff exponențial
 */

import express from 'express';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json');
const APP_VERSION = _pkg.version;
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
import { incCounter, setGauge, renderMetrics } from './middleware/metrics.mjs';
import { cspNonce, buildScriptSrc, serveWithNonce } from './middleware/cspNonce.mjs';
import { dispatchWebhook, _runWebhookRetryJob } from './webhook.mjs';
import { stampFooterOnPdf as _stampFooterOnPdfModule } from './pdf/stamp.mjs';
import { notify, injectNotifyDeps } from './notifications/notify.mjs';

let PDFLib = null;
try { PDFLib = await import('pdf-lib'); } catch(e) { logger.warn({ err: e }, 'pdf-lib not available - flow stamp disabled'); }

import { pool, DB_READY, DB_LAST_ERROR, initDbWithRetry, saveFlow, getFlowData, requireDb } from './db/index.mjs';
import { JWT_SECRET, JWT_EXPIRES, requireAuth, requireAdmin, hashPassword, verifyPassword, generatePassword, sha256Hex, escHtml } from './middleware/auth.mjs';

import authRouter from './routes/auth.mjs';
import { injectRateLimiter } from './routes/auth.mjs';
import notifRouter, { injectWsPush } from './routes/notifications.mjs';
import adminRouter, { injectWsSize } from './routes/admin.mjs';
import flowsRouter, { injectFlowDeps } from './routes/flows.mjs';
import templatesRouter from './routes/templates.mjs';

const app = express();
app.set('trust proxy', 1);

// SEC-01: cookie-parser — necesár pentru req.cookies.auth_token (JWT HttpOnly)
app.use(cookieParser());

// ── Security headers ──────────────────────────────────────────────────────
try {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      [
          "'self'", "'unsafe-inline'",
          'https://unpkg.com',
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com',
        ],
        styleSrc:       ["'self'", "'unsafe-inline'"],
        imgSrc:         ["'self'", 'data:', 'blob:'],
        connectSrc:     ["'self'", 'wss:', 'ws:'],
        objectSrc:      ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
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

// ── JSON body parser — limite diferențiate per tip de rută ─────────────────
// Global: 50kb (login, notifications, queries simple)
// PDF routes: 52mb (flows cu PDF atașat, upload-signed-pdf) — aplicat în routes/flows.mjs
// 50mb global era o suprafață de atac: login/notif/templates acceptau bodies uriașe
app.use(express.json({ limit: '50kb' }));

// Middleware care suprascrie limita pentru rutele care primesc PDF-uri
// Aplicat ÎNAINTE de flowsRouter pe rutele specifice
export const jsonPdfParser = express.json({ limit: '52mb' });

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
    incCounter('http_requests_total', { method: req.method, status_class: `${Math.floor(res.statusCode / 100)}xx` });
  });
  next();
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException',  (err) => logger.error({ err }, 'uncaughtException'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '../public');
// ── Fișiere statice ────────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));

// ── Rute HTML — alias-uri fără extensie ───────────────────────────────────
app.get('/',              (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'semdoc-initiator.html')));
app.get('/login',         (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/admin',         (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/notifications', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'notifications.html')));
app.get('/templates',     (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'templates.html')));
app.get('/semdoc-signer.html',    (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'semdoc-signer.html')));
app.get('/semdoc-initiator.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'semdoc-initiator.html')));
app.get('/flow.html',             (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'flow.html')));
app.get('/login.html',            (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/offline.html',          (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'offline.html')));

// ── Health public ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    service: 'DocFlowAI',
    version: APP_VERSION,
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
    version: APP_VERSION,
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

// ── METRICS-01: /metrics — Prometheus scrape endpoint ────────────────────
// Implicit: admin-only. Setați ENV METRICS_PUBLIC=1 pentru scrape extern.
app.get('/metrics', (req, res) => {
  const isPublic = process.env.METRICS_PUBLIC === '1';
  if (!isPublic && requireAdmin(req, res)) return;
  // Actualizăm gauge-ul WS clients înainte de render
  setGauge('ws_clients', wsClients.size);
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
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
// ── v3.4.0: stampFooterOnPdf extras în server/pdf/stamp.mjs ──────────────
// Wrapper local care injectează instanța PDFLib — semnătura rămâne compatibilă
// cu toate apelurile existente (flows.mjs via injectFlowDeps).
function stampFooterOnPdf(pdfB64, flowData) {
  return _stampFooterOnPdfModule(pdfB64, flowData, PDFLib);
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
// ── R-04: Reminder automat — niveluri multiple (24h / 48h / 72h escaladare)
// ENV: REMINDER_INTERVAL_HOURS (default: 6h — cat de des verificam)
//      REMINDER_1_HOURS (default: 24), REMINDER_2_HOURS (default: 48), REMINDER_3_HOURS (default: 72)
const REMINDER_INTERVAL_MS = (parseInt(process.env.REMINDER_INTERVAL_HOURS || '6') * 3600_000);
const R1_MS = (parseInt(process.env.REMINDER_1_HOURS || '24') * 3600_000);
const R2_MS = (parseInt(process.env.REMINDER_2_HOURS || '48') * 3600_000);
const R3_MS = (parseInt(process.env.REMINDER_3_HOURS || '72') * 3600_000);

async function _runReminderJob() {
  if (!pool || !DB_READY) return;
  try {
    const cutoff1 = new Date(Date.now() - R1_MS).toISOString();
    const { rows } = await pool.query(
      `SELECT id, data FROM flows
       WHERE (data->>'completed') IS DISTINCT FROM 'true'
         AND (data->>'status') NOT IN ('refused','cancelled','review_requested')
         AND updated_at < $1
       LIMIT 300`,
      [cutoff1]
    );
    let reminded = 0;
    for (const row of rows) {
      const data = row.data;
      const flowId = row.id;
      const current = (data.signers || []).find(s => s.status === 'current');
      if (!current?.email) continue;

      const { rows: sentRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type='REMINDER'`,
        [current.email.toLowerCase(), flowId]
      );
      const sentCount = parseInt(sentRows[0]?.cnt || '0');

      const { rows: lastRows } = await pool.query(
        `SELECT created_at FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type='REMINDER'
         ORDER BY created_at DESC LIMIT 1`,
        [current.email.toLowerCase(), flowId]
      );
      const lastSentAt = lastRows[0]?.created_at ? new Date(lastRows[0].created_at).getTime() : 0;
      const inactiveSince = current.notifiedAt ? new Date(current.notifiedAt).getTime() : (Date.now() - R1_MS);
      const inactiveMs = Date.now() - inactiveSince;
      const minGap = R1_MS - 3600_000; // anti-spam: minim R1-1h intre remindere

      if (sentCount === 0 && inactiveMs >= R1_MS && (Date.now() - lastSentAt) > minGap) {
        await notify({ userEmail: current.email, flowId, type: 'REMINDER',
          title: '⏳ Document în așteptare',
          message: `Documentul „${data.docName}" așteaptă semnătura ta de mai mult de 24 de ore.`,
          waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
          urgent: false });
        reminded++;
      } else if (sentCount === 1 && inactiveMs >= R2_MS && (Date.now() - lastSentAt) > minGap) {
        await notify({ userEmail: current.email, flowId, type: 'REMINDER',
          title: '⚠️ Acțiune necesară — document nesemnat',
          message: `Documentul „${data.docName}" este nesemnat de 2 zile. Te rugăm să acționezi.`,
          waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
          urgent: false });
        reminded++;
      } else if (sentCount === 2 && inactiveMs >= R3_MS && (Date.now() - lastSentAt) > minGap) {
        await notify({ userEmail: current.email, flowId, type: 'REMINDER',
          title: '🚨 Flux blocat — 3 zile fără acțiune',
          message: `Documentul „${data.docName}" este blocat de 3 zile. Semnează sau delegă urgent.`,
          waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
          urgent: true });
        // Escaladare: notifică și inițiatorul
        if (data.initEmail && data.initEmail.toLowerCase() !== current.email.toLowerCase()) {
          await notify({ userEmail: data.initEmail, flowId, type: 'REMINDER',
            title: '🚨 Flux blocat — intervenție necesară',
            message: `Documentul „${data.docName}" e blocat la ${current.name || current.email} [${current.rol || ''}] de 3 zile. Poți delega sau contacta semnatarul.`,
            waParams: { docName: data.docName, initName: data.initName }, urgent: true });
        }
        reminded++;
      }
    }
    if (reminded > 0) logger.info({ reminded }, 'Reminder job multi-level: notificari trimise');
  } catch(e) { logger.error({ err: e }, 'Reminder job error'); }
}
const _reminderInterval = setInterval(_runReminderJob, REMINDER_INTERVAL_MS);
logger.info({ intervalH: process.env.REMINDER_INTERVAL_HOURS || 6, r1h: 24, r2h: 48, r3h: 72 }, 'Reminder job (multi-level) pornit');

// ── ASYNC-01: Background processor pentru arhivare async ──────────────────
// Procesează jobs din tabelul archive_jobs în loturi de 10, evitând timeout Railway

async function _runArchiveJobProcessor() {
  if (!pool || !DB_READY) return;
  try {
    // Preluăm un job pending la un moment dat (SKIP LOCKED evită race condition)
    const { rows: jobs } = await pool.query(
      `UPDATE archive_jobs SET status='processing', started_at=NOW()
       WHERE id = (SELECT id FROM archive_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`
    );
    if (!jobs.length) return;
    const job = jobs[0];
    const flowIds = Array.isArray(job.flow_ids) ? job.flow_ids : [];
    const results = [];
    let totalOk = 0, totalFail = 0;
    for (const flowId of flowIds) {
      try {
        const data = await getFlowData(flowId);
        if (!data) { results.push({ flowId, ok: false, error: 'not_found' }); totalFail++; continue; }
        if (data.storage === 'drive') { results.push({ flowId, ok: true, skipped: true }); continue; }
        if (!data.pdfB64 && !data.signedPdfB64) {
          data.storage = 'drive'; data.archivedAt = new Date().toISOString();
          await saveFlow(flowId, data);
          results.push({ flowId, ok: true, warning: 'no_pdf_marked_archived' }); totalOk++; continue;
        }
        const driveResult = await archiveFlow(data, pool);
        data.pdfB64 = null; data.signedPdfB64 = null; data.originalPdfB64 = null;
        data.storage = 'drive'; data.archivedAt = new Date().toISOString();
        Object.assign(data, driveResult);
        await saveFlow(flowId, data);
        results.push({ flowId, ok: true }); totalOk++;
        logger.info({ flowId }, 'Archive job: flux arhivat in Drive');
      } catch(e) {
        logger.error({ err: e, flowId }, 'Archive job: eroare flux');
        results.push({ flowId, ok: false, error: String(e.message || e) }); totalFail++;
      }
    }
    await pool.query(
      `UPDATE archive_jobs SET status='done', finished_at=NOW(), result=$1 WHERE id=$2`,
      [JSON.stringify({ results, totalOk, totalFail }), job.id]
    );
    logger.info({ jobId: job.id, totalOk, totalFail }, 'Archive job procesat');
  } catch(e) { logger.error({ err: e }, 'Archive job processor error'); }
}
const _archiveJobInterval = setInterval(_runArchiveJobProcessor, 30_000); // verifică la 30s
logger.info('Archive job processor pornit (interval: 30s)');

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
// ── v3.4.0: notify() extras în server/notifications/notify.mjs ───────────────
// Dependențele sunt injectate după inițializarea WebSocket-ului și pool-ului.

// ── FEAT-01: Webhook retry processor ─────────────────────────────────────────
// Reîncarcă job-urile eșuate cu backoff exponențial (max 5 încercări)
const _webhookRetryInterval = setInterval(() => _runWebhookRetryJob(pool), 60_000);
logger.info('Webhook retry processor pornit (interval: 60s)');

// ── v3.4.0: Injectează dependențele în notify() ───────────────────────────────
injectNotifyDeps({ pool, wsPush, pushToUser, sendSignerEmail, sendWaSignRequest, sendWaCompleted, sendWaRefused, isWhatsAppConfigured, saveFlow, getFlowData, escHtml });

// ── Inject dependencies ───────────────────────────────────────────────────
injectRateLimiter(checkLoginRate, recordLoginFail, clearLoginRate);
injectWsPush(wsPush);
injectWsSize(() => wsClients.size);
injectFlowDeps({ notify, wsPush, PDFLib, stampFooterOnPdf, isSignerTokenExpired, newFlowId, buildSignerLink, stripSensitive, stripPdfB64, sendSignerEmail, jsonPdfParser, dispatchWebhook });

// ── Mount routers ─────────────────────────────────────────────────────────
app.use('/', authRouter);
app.use('/', notifRouter);
app.use('/', adminRouter);
app.use('/', flowsRouter);
app.use('/', templatesRouter);

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
  clearInterval(_archiveJobInterval);
  clearInterval(_webhookRetryInterval);
  clearInterval(wsHeartbeat);
  httpServer.close(() => { logger.info('Server closed.'); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT;
if (!PORT) { logger.error('PORT missing - setati variabila de mediu PORT'); process.exit(1); }
httpServer.listen(Number(PORT), '0.0.0.0', () => {
  logger.info({ port: PORT }, `DocFlowAI v${APP_VERSION} server pornit`);
  logger.info({ port: PORT }, 'WebSocket ready');
  initDbWithRetry();
});
