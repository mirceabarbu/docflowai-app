/**
 * DocFlowAI — Admin Outreach Module
 *
 * Endpoints:
 *   POST   /admin/outreach/campaigns              — creare campanie
 *   GET    /admin/outreach/campaigns              — lista campanii
 *   GET    /admin/outreach/campaigns/:id          — detalii campanie + destinatari
 *   DELETE /admin/outreach/campaigns/:id          — sterge campanie
 *   POST   /admin/outreach/campaigns/:id/recipients       — adauga destinatari (JSON array sau CSV bulk)
 *   DELETE /admin/outreach/campaigns/:id/recipients/:rid  — sterge destinatar
 *   POST   /admin/outreach/campaigns/:id/send     — trimite batch (max 100/zi global)
 *   GET    /admin/outreach/stats                  — sent/opened azi + total
 *   GET    /admin/outreach/track/:trackingId      — pixel 1x1 tracking deschidere (public)
 */

import express from 'express';
import crypto  from 'crypto';
import fs      from 'fs';
import path    from 'path';
import { fileURLToPath } from 'url';
import { pool, requireDb } from '../../db/index.mjs';
import { requireAuth, requireAdmin, escHtml } from '../../middleware/auth.mjs';
import { logger } from '../../middleware/logger.mjs';

const router = express.Router();
const __dirname_outreach = path.dirname(fileURLToPath(import.meta.url));

const DAILY_SEND_LIMIT    = parseInt(process.env.OUTREACH_DAILY_LIMIT || '100');
const FROM_EMAIL          = process.env.OUTREACH_FROM || 'DocFlowAI <contact@docflowai.ro>';
const PDF_PATH            = process.env.OUTREACH_PDF_PATH || null;
const APP_URL             = process.env.APP_URL || '';

// ── Dataset primării (lazy-loaded, cached) ────────────────────────────────
let _primarii = null;
function getPrimarii() {
  if (_primarii) return _primarii;
  const candidates = [
    path.join(__dirname_outreach, '../../../tools/primarii-romania.json'),
    path.join(process.cwd(), 'tools/primarii-romania.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _primarii = JSON.parse(fs.readFileSync(p, 'utf8'));
      logger.info({ count: _primarii.length, path: p }, 'Primarii dataset loaded');
      return _primarii;
    }
  }
  _primarii = [];
  logger.warn('primarii-romania.json not found');
  return _primarii;
}

// ── GET /admin/outreach/primarii — dataset cu filtru + paginare ───────────
router.get('/primarii', (req, res) => {
  if (requireAdmin(req, res)) return;
  const { judet = '', q = '', page = '1', limit = '50' } = req.query;
  const pageN  = Math.max(1, parseInt(page));
  const limitN = Math.min(200, Math.max(1, parseInt(limit)));
  const qLow   = q.toLowerCase().trim();
  const jLow   = judet.toLowerCase().trim();

  let list = getPrimarii();
  if (jLow) list = list.filter(p => p.judet.toLowerCase() === jLow);
  if (qLow) list = list.filter(p =>
    p.localitate.toLowerCase().includes(qLow) ||
    p.institutie.toLowerCase().includes(qLow) ||
    p.email.toLowerCase().includes(qLow)
  );

  const total = list.length;
  const pages = Math.ceil(total / limitN) || 1;
  const items = list.slice((pageN - 1) * limitN, pageN * limitN);
  const judete = [...new Set(getPrimarii().map(p => p.judet))].sort();

  res.json({ items, total, page: pageN, pages, limit: limitN, judete });
});

/** Trimite email via Resend REST API (fără SDK — consistente cu mailer.mjs) */
async function sendEmail({ to, subject, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY nu este setat');
  const body = { from: FROM_EMAIL, to, subject, html };
  if (attachments?.length) body.attachments = attachments;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || json?.name || `Resend error ${res.status}`);
  return json;
}

const _getIp = req => req.ip || req.socket?.remoteAddress || null;

// ── Helpers ───────────────────────────────────────────────────────────────

/** Câte emailuri s-au trimis azi (00:00 UTC) */
async function sentToday() {
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM outreach_recipients
    WHERE status = 'sent'
      AND sent_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `);
  return parseInt(rows[0].cnt);
}

/** Email HTML de baza cu tracking pixel injectat */
function buildHtml(template, institutie, trackingId) {
  // Normalizare: "PRIMĂRIA COMUNEI BRAN" → "Primăria Comunei Bran"
  const displayInstitutie = institutie
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, c => c.toUpperCase());
  const pixel = APP_URL
    ? `<img src="${APP_URL}/admin/outreach/track/${trackingId}" width="1" height="1" style="display:none" alt=""/>`
    : '';
  return template
    .replace(/\{\{institutie\}\}/g, escHtml(displayInstitutie))
    .replace('</body>', `${pixel}</body>`)
    + (template.includes('</body>') ? '' : pixel);
}

// ── Pixel tracking (public — fără auth) ───────────────────────────────────
router.get('/track/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  // GIF 1×1 transparent
  const GIF1x1 = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
  );
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(GIF1x1);
  // Actualizare async — nu blocăm răspunsul
  if (!trackingId || !/^[a-f0-9]{32}$/.test(trackingId)) return;
  pool.query(`
    UPDATE outreach_recipients
    SET status = CASE WHEN status = 'sent' THEN 'opened' ELSE status END,
        opened_at = CASE WHEN opened_at IS NULL AND status = 'sent' THEN NOW() ELSE opened_at END
    WHERE tracking_id = $1
  `, [trackingId]).catch(e => logger.warn({ err: e }, 'outreach track update error'));
});

// ── Stats ─────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  try {
    const today = await sentToday();
    const { rows: total } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','opened')) AS total_sent,
        COUNT(*) FILTER (WHERE status = 'opened')           AS total_opened,
        COUNT(*) FILTER (WHERE status = 'error')            AS total_errors,
        COUNT(*) FILTER (WHERE status = 'pending')          AS total_pending
      FROM outreach_recipients
    `);
    res.json({
      sentToday: today,
      dailyLimit: DAILY_SEND_LIMIT,
      remainingToday: Math.max(0, DAILY_SEND_LIMIT - today),
      ...total[0],
    });
  } catch(e) {
    logger.error({ err: e }, 'outreach stats error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Campanii — CRUD ───────────────────────────────────────────────────────

router.get('/campaigns', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(r.id)                                          AS total_recipients,
        COUNT(r.id) FILTER (WHERE r.status IN ('sent','opened')) AS sent_count,
        COUNT(r.id) FILTER (WHERE r.status = 'opened')      AS opened_count,
        COUNT(r.id) FILTER (WHERE r.status = 'error')       AS error_count,
        COUNT(r.id) FILTER (WHERE r.status = 'pending')     AS pending_count
      FROM outreach_campaigns c
      LEFT JOIN outreach_recipients r ON r.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ campaigns: rows });
  } catch(e) {
    logger.error({ err: e }, 'outreach list error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/campaigns', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, subject, html_body } = req.body;
  if (!name?.trim() || !subject?.trim() || !html_body?.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'name, subject și html_body sunt obligatorii.' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO outreach_campaigns (name, subject, html_body, created_by)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name.trim(), subject.trim(), html_body.trim(), actor.email]);
    logger.info({ campaignId: rows[0].id, by: actor.email }, 'outreach campaign created');
    res.json({ campaign: rows[0] });
  } catch(e) {
    logger.error({ err: e }, 'outreach create error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rows: camps } = await pool.query('SELECT * FROM outreach_campaigns WHERE id=$1', [id]);
    if (!camps.length) return res.status(404).json({ error: 'not_found' });
    const { rows: recips } = await pool.query(
      'SELECT id, email, institutie, status, sent_at, opened_at, error_msg FROM outreach_recipients WHERE campaign_id=$1 ORDER BY id ASC',
      [id]
    );
    res.json({ campaign: camps[0], recipients: recips });
  } catch(e) {
    logger.error({ err: e }, 'outreach get error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/campaigns/:id', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    await pool.query('DELETE FROM outreach_recipients WHERE campaign_id=$1', [id]);
    const { rowCount } = await pool.query('DELETE FROM outreach_campaigns WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    logger.info({ campaignId: id, by: actor.email }, 'outreach campaign deleted');
    res.json({ ok: true });
  } catch(e) {
    logger.error({ err: e }, 'outreach delete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Destinatari ───────────────────────────────────────────────────────────

router.post('/campaigns/:id/recipients', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });

  // Acceptă { recipients: [{email, institutie}, ...] }
  // sau { csv: "email,institutie\ntest@a.ro,Primăria X\n..." }
  let entries = [];

  if (req.body.csv) {
    const lines = req.body.csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const start = lines[0]?.toLowerCase().startsWith('email') ? 1 : 0;
    for (const line of lines.slice(start)) {
      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const email = cols[0]?.toLowerCase();
      const institutie = cols[1] || '';
      if (email && /^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        entries.push({ email, institutie });
      }
    }
  } else if (Array.isArray(req.body.recipients)) {
    for (const r of req.body.recipients) {
      const email = (r.email || '').toLowerCase().trim();
      if (email && /^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        entries.push({ email, institutie: (r.institutie || '').trim() });
      }
    }
  } else {
    return res.status(400).json({ error: 'bad_request', message: 'Trimite recipients[] sau csv.' });
  }

  if (!entries.length) return res.status(400).json({ error: 'no_valid_recipients' });

  // De-duplicate față de ce există deja în campanie
  const { rows: existing } = await pool.query(
    'SELECT email FROM outreach_recipients WHERE campaign_id=$1', [id]
  );
  const existingEmails = new Set(existing.map(r => r.email));
  const newEntries = entries.filter(e => !existingEmails.has(e.email));

  if (!newEntries.length) {
    return res.json({ added: 0, skipped: entries.length, message: 'Toți destinatarii există deja.' });
  }

  try {
    const { rowCount } = await pool.query(`
      INSERT INTO outreach_recipients (campaign_id, email, institutie, tracking_id)
      SELECT $1, e, i, md5(random()::text || clock_timestamp()::text)
      FROM UNNEST($2::text[], $3::text[]) AS t(e, i)
      ON CONFLICT (campaign_id, email) DO NOTHING
    `, [id, newEntries.map(e => e.email), newEntries.map(e => e.institutie)]);
    res.json({ added: rowCount, skipped: entries.length - rowCount });
  } catch(e) {
    logger.error({ err: e }, 'outreach add recipients error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/campaigns/:id/recipients/:rid', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id  = parseInt(req.params.id);
  const rid = parseInt(req.params.rid);
  if (!id || !rid) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM outreach_recipients WHERE id=$1 AND campaign_id=$2', [rid, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch(e) {
    logger.error({ err: e }, 'outreach delete recipient error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Send batch ────────────────────────────────────────────────────────────

router.post('/campaigns/:id/send', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  const campaignId = parseInt(req.params.id);
  if (!campaignId) return res.status(400).json({ error: 'bad_id' });

  // Limit pe batch: default 50, max 100
  const batchSize = Math.min(parseInt(req.body.batchSize || '50'), 100);

  try {
    // Campanie
    const { rows: camps } = await pool.query(
      'SELECT * FROM outreach_campaigns WHERE id=$1', [campaignId]
    );
    if (!camps.length) return res.status(404).json({ error: 'not_found' });
    const campaign = camps[0];

    // Rate limit global zilnic
    const alreadySent = await sentToday();
    const remaining   = DAILY_SEND_LIMIT - alreadySent;
    if (remaining <= 0) {
      return res.status(429).json({
        error: 'daily_limit_reached',
        message: `Limita zilnică de ${DAILY_SEND_LIMIT} emailuri a fost atinsă. Reîncearcă mâine.`,
        sentToday: alreadySent,
      });
    }
    const toSend = Math.min(batchSize, remaining);

    // Destinatari pending
    const { rows: pending } = await pool.query(`
      SELECT id, email, institutie, tracking_id
      FROM outreach_recipients
      WHERE campaign_id = $1 AND status = 'pending'
      ORDER BY id ASC
      LIMIT $2
    `, [campaignId, toSend]);

    if (!pending.length) {
      return res.json({ sent: 0, message: 'Nu există destinatari în așteptare.' });
    }

    // PDF atașament (opțional)
    let attachment = null;
    const pdfPath = PDF_PATH || path.join(process.cwd(), 'tools', 'DocFlowAI_Prezentare.pdf');
    if (fs.existsSync(pdfPath)) {
      const pdfBuf = fs.readFileSync(pdfPath);
      attachment = { filename: 'DocFlowAI_Prezentare.pdf', content: pdfBuf };
    }

    let sentCount = 0, errorCount = 0;

    for (const recip of pending) {
      const html = buildHtml(campaign.html_body, recip.institutie, recip.tracking_id);
      try {
        await sendEmail({
          to: recip.email,
          subject: campaign.subject,
          html,
          ...(attachment ? { attachments: [{ filename: attachment.filename, content: attachment.content.toString('base64') }] } : {}),
        });
        await pool.query(
          `UPDATE outreach_recipients SET status='sent', sent_at=NOW() WHERE id=$1`,
          [recip.id]
        );
        sentCount++;
      } catch(e) {
        const errMsg = e?.message || String(e);
        logger.warn({ recip: recip.email, err: errMsg }, 'outreach send error');
        await pool.query(
          `UPDATE outreach_recipients SET status='error', error_msg=$1 WHERE id=$2`,
          [errMsg.substring(0, 500), recip.id]
        );
        errorCount++;
      }
    }

    logger.info({ campaignId, sentCount, errorCount, by: actor.email }, 'outreach batch sent');
    res.json({
      sent: sentCount,
      errors: errorCount,
      sentToday: alreadySent + sentCount,
      dailyLimit: DAILY_SEND_LIMIT,
      remainingToday: Math.max(0, remaining - sentCount),
    });

  } catch(e) {
    logger.error({ err: e }, 'outreach send batch error');
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ── Reset destinatari cu eroare (retry) ────────────────────────────────────
router.post('/campaigns/:id/reset-errors', async (req, res) => {
  if (requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE outreach_recipients SET status='pending', error_msg=NULL WHERE campaign_id=$1 AND status='error'`,
      [id]
    );
    res.json({ reset: rowCount });
  } catch(e) {
    logger.error({ err: e }, 'outreach reset errors error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
