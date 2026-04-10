/**
 * server/modules/admin/outreach.mjs — Outreach module for DocFlowAI v4.
 *
 * Clean rewrite of server/routes/admin/outreach.mjs as a proper v4 ES6 module.
 * Tracking pixel + click endpoints live in tracking.mjs (public, no auth).
 *
 * Endpoints (all require admin):
 *   GET    /primarii                          — dataset instituții cu filtru + paginare
 *   POST   /primarii                          — adaugă instituție
 *   PUT    /primarii/:id                      — editează instituție
 *   DELETE /primarii/:id                      — dezactivează/șterge
 *   POST   /primarii/import                   — import bulk JSON/CSV
 *   POST   /primarii/ensure-tokens            — generare unsubscribe_token lipsă
 *   GET    /stats                             — statistici globale
 *   GET    /campaigns                         — lista campanii
 *   POST   /campaigns                         — creare campanie
 *   GET    /campaigns/:id                     — detalii + destinatari
 *   DELETE /campaigns/:id                     — șterge campanie
 *   POST   /campaigns/:id/recipients          — adaugă destinatari (JSON sau CSV)
 *   DELETE /campaigns/:id/recipients/:rid     — șterge destinatar
 *   POST   /campaigns/:id/send                — trimite batch
 *   POST   /campaigns/:id/reset-errors        — retry destinatari cu eroare
 *   GET    /unsubscribe/:token                — dezabonare publică (fără auth)
 *   GET    /download/:trackingId              — PDF cu tracking (public)
 *   GET    /click/:trackingId                 — click redirect tracking (public)
 *   GET    /track/:trackingId                 — pixel GIF tracking (public)
 */

import express from 'express';
import crypto  from 'crypto';
import fs      from 'fs';
import path    from 'path';
import { fileURLToPath } from 'url';
import { pool, requireDb }        from '../../db/index.mjs';
import { requireAuth, requireAdmin, escHtml } from '../../middleware/auth.mjs';
import { logger }                 from '../../middleware/logger.mjs';

const router = express.Router();
const __dir  = path.dirname(fileURLToPath(import.meta.url));

const DAILY_SEND_LIMIT = parseInt(process.env.OUTREACH_DAILY_LIMIT || '100');
const FROM_EMAIL       = process.env.OUTREACH_FROM || 'DocFlowAI <contact@docflowai.ro>';
const PDF_PATH         = process.env.OUTREACH_PDF_PATH || null;
const APP_URL          = process.env.PUBLIC_BASE_URL || process.env.APP_URL || '';

function getBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}`;
}

// ── Dataset primării (lazy-loaded, cached) ────────────────────────────────────

let _primarii       = null;
let _primariiSeeded = false;

function getPrimarii() {
  if (_primarii) return _primarii;
  const candidates = [
    path.join(__dir, '../../../tools/primarii-romania.json'),
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

async function ensurePrimariiSeeded() {
  if (_primariiSeeded) return;
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM outreach_primarii');
    if (parseInt(rows[0].cnt) > 0) { _primariiSeeded = true; return; }
    const jsonData = getPrimarii();
    if (!jsonData.length) return;
    const values = jsonData.map((_, i) => {
      const b = i * 5;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
    }).join(',');
    const flat = jsonData.flatMap(p => [
      p.institutie, p.email, p.judet || '', p.localitate || p.institutie,
      crypto.randomUUID(),
    ]);
    await pool.query(
      `INSERT INTO outreach_primarii (institutie,email,judet,localitate,unsubscribe_token)
       VALUES ${values} ON CONFLICT (email) DO NOTHING`,
      flat
    );
    _primariiSeeded = true;
    logger.info({ count: jsonData.length }, 'outreach_primarii: seed efectuat');
  } catch (e) { logger.error({ err: e }, 'ensurePrimariiSeeded error'); }
}

// ── Email helper ──────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY nu este setat');
  const body = { from: FROM_EMAIL, to, subject, html };
  if (attachments?.length) body.attachments = attachments;
  const r = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.message || json?.name || `Resend error ${r.status}`);
  return json;
}

async function sentToday() {
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM outreach_recipients
    WHERE status='sent' AND sent_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `);
  return parseInt(rows[0].cnt);
}

function buildHtml(template, institutie, trackingId, baseUrl, unsubscribeUrl = null) {
  const displayInst = (institutie || 'instituția dumneavoastră')
    .toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());
  const pixel = baseUrl
    ? `<img src="${baseUrl}/admin/outreach/track/${trackingId}" width="1" height="1" style="display:none" alt=""/>`
    : '';
  let html = template.replace(/\{\{institutie\}\}/g, escHtml(displayInst));
  if (baseUrl) {
    html = html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
      if (url.includes('/admin/outreach/')) return match;
      return `href="${baseUrl}/admin/outreach/click/${trackingId}?u=${encodeURIComponent(url)}"`;
    });
  }
  const unsubFooter = unsubscribeUrl
    ? `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;text-align:center;font-family:Arial,sans-serif;font-size:11px;color:#aaa;">
        Dacă nu mai doriți comunicări, puteți
        <a href="${unsubscribeUrl}" style="color:#aaa;">dezabona această adresă</a>.
       </div>`
    : '';
  const withFooter = html.includes('</body>')
    ? html.replace('</body>', `${unsubFooter}</body>`)
    : html + unsubFooter;
  return withFooter.replace('</body>', `${pixel}</body>`)
    + (withFooter.includes('</body>') ? '' : pixel);
}

// ── Primarii CRUD ─────────────────────────────────────────────────────────────

router.get('/primarii', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  await ensurePrimariiSeeded();
  const { judet = '', q = '', page = '1', limit = '50', activ = '' } = req.query;
  const pageN  = Math.max(1, parseInt(page));
  const limitN = Math.min(200, Math.max(1, parseInt(limit)));
  const offset = (pageN - 1) * limitN;
  const conds = ['1=1']; const params = [];
  if (judet.trim()) { params.push(judet.trim()); conds.push(`judet=$${params.length}`); }
  conds.push(activ === '0' ? 'activ=FALSE' : 'activ=TRUE');
  if (q.trim()) {
    const qp = `%${q.trim().toLowerCase()}%`;
    params.push(qp);
    conds.push(`(lower(institutie) LIKE $${params.length} OR lower(email) LIKE $${params.length} OR lower(judet) LIKE $${params.length})`);
  }
  const where = conds.join(' AND ');
  try {
    const { rows: cnt }   = await pool.query(`SELECT COUNT(*) AS c FROM outreach_primarii WHERE ${where}`, params);
    const { rows: items } = await pool.query(
      `SELECT id,institutie,email,judet,localitate,activ FROM outreach_primarii WHERE ${where}
       ORDER BY judet ASC, institutie ASC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limitN, offset]
    );
    const { rows: jRows } = await pool.query(`SELECT DISTINCT judet FROM outreach_primarii WHERE activ=TRUE ORDER BY judet ASC`);
    res.json({ items, total: parseInt(cnt[0].c), page: pageN, pages: Math.ceil(parseInt(cnt[0].c)/limitN)||1, limit: limitN, judete: jRows.map(r=>r.judet).filter(Boolean) });
  } catch(e) { logger.error({err:e},'GET primarii'); res.status(500).json({error:'server_error'}); }
});

router.post('/primarii', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const { institutie, email, judet = '', localitate = '' } = req.body || {};
  if (!institutie?.trim()) return res.status(400).json({error:'institutie_required'});
  if (!email?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
    return res.status(400).json({error:'email_invalid'});
  try {
    const { rows } = await pool.query(
      `INSERT INTO outreach_primarii (institutie,email,judet,localitate)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [institutie.trim(), email.trim().toLowerCase(), judet.trim(), localitate.trim()||institutie.trim()]
    );
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code==='23505') return res.status(409).json({error:'email_exists',message:'Emailul există deja.'});
    logger.error({err:e},'POST primarii'); res.status(500).json({error:'server_error'});
  }
});

router.put('/primarii/:id', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  const { institutie, email, judet, localitate, activ } = req.body || {};
  if (!institutie?.trim()) return res.status(400).json({error:'institutie_required'});
  if (!email?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
    return res.status(400).json({error:'email_invalid'});
  try {
    const { rows } = await pool.query(
      `UPDATE outreach_primarii SET institutie=$1,email=$2,judet=$3,localitate=$4,activ=$5,updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [institutie.trim(), email.trim().toLowerCase(), (judet||'').trim(), (localitate||institutie).trim(), activ!==false, id]
    );
    if (!rows.length) return res.status(404).json({error:'not_found'});
    res.json(rows[0]);
  } catch(e) {
    if (e.code==='23505') return res.status(409).json({error:'email_exists',message:'Emailul există deja.'});
    logger.error({err:e},'PUT primarii'); res.status(500).json({error:'server_error'});
  }
});

router.delete('/primarii/:id', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  const hard = req.query.hard === '1';
  try {
    if (hard) {
      const { rowCount } = await pool.query('DELETE FROM outreach_primarii WHERE id=$1', [id]);
      if (!rowCount) return res.status(404).json({error:'not_found'});
    } else {
      const { rows } = await pool.query(
        `UPDATE outreach_primarii SET activ=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id`, [id]
      );
      if (!rows.length) return res.status(404).json({error:'not_found'});
    }
    res.json({ok:true, hard});
  } catch(e) { logger.error({err:e},'DELETE primarii'); res.status(500).json({error:'server_error'}); }
});

router.post('/primarii/import', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const { format = 'json', data, replace = false } = req.body || {};
  if (!data) return res.status(400).json({error:'data_required'});
  let rows = [];
  try {
    if (format === 'json') {
      rows = JSON.parse(data);
      if (!Array.isArray(rows)) return res.status(400).json({error:'json_must_be_array'});
    } else {
      rows = data.split(/\r?\n/).slice(1).map(line => {
        const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g,''));
        return { email: parts[0], institutie: parts[1]||parts[0], judet: parts[2]||'', localitate: parts[3]||parts[1]||'' };
      }).filter(r => r.email && r.institutie);
    }
  } catch(e) { return res.status(400).json({error:'parse_error',message:e.message}); }
  const valid = rows.filter(r => r.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim()));
  if (!valid.length) return res.status(400).json({error:'no_valid_rows'});
  let added = 0, skipped = 0;
  try {
    if (replace) await pool.query('DELETE FROM outreach_primarii');
    for (const r of valid) {
      try {
        await pool.query(
          `INSERT INTO outreach_primarii (institutie,email,judet,localitate)
           VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE
           SET institutie=$1,judet=$3,localitate=$4,updated_at=NOW()`,
          [r.institutie?.trim()||r.email, r.email.trim().toLowerCase(), (r.judet||'').trim(), (r.localitate||r.institutie||r.email).trim()]
        );
        added++;
      } catch(_) { skipped++; }
    }
    res.json({ok:true, added, skipped, total:valid.length});
  } catch(e) { logger.error({err:e},'import primarii'); res.status(500).json({error:'server_error'}); }
});

router.post('/primarii/ensure-tokens', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  try {
    const { rows: missing } = await pool.query(
      `SELECT id FROM outreach_primarii WHERE unsubscribe_token IS NULL LIMIT 5000`
    );
    let updated = 0;
    for (const row of missing) {
      await pool.query(`UPDATE outreach_primarii SET unsubscribe_token=$1 WHERE id=$2`, [crypto.randomUUID(), row.id]);
      updated++;
    }
    res.json({ok:true, updated, remaining: missing.length===5000?'5000+':0});
  } catch(e) { logger.error({err:e},'ensure-tokens'); res.status(500).json({error:'server_error'}); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  try {
    const today = await sentToday();
    const { rows: total } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','opened')) AS total_sent,
        COUNT(*) FILTER (WHERE status='opened')             AS total_opened,
        COUNT(*) FILTER (WHERE status='error')              AS total_errors,
        COUNT(*) FILTER (WHERE status='pending')            AS total_pending
      FROM outreach_recipients
    `);
    res.json({ sentToday: today, dailyLimit: DAILY_SEND_LIMIT, remainingToday: Math.max(0,DAILY_SEND_LIMIT-today), ...total[0] });
  } catch(e) { logger.error({err:e},'outreach stats'); res.status(500).json({error:'server_error'}); }
});

// ── Campaigns CRUD ────────────────────────────────────────────────────────────

router.get('/campaigns', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(r.id)                                              AS total_recipients,
        COUNT(r.id) FILTER (WHERE r.status IN ('sent','opened')) AS sent_count,
        COUNT(r.id) FILTER (WHERE r.status='opened')             AS opened_count,
        COUNT(r.id) FILTER (WHERE r.clicked_at IS NOT NULL)      AS click_count,
        COUNT(r.id) FILTER (WHERE r.status='error')              AS error_count,
        COUNT(r.id) FILTER (WHERE r.status='pending')            AS pending_count
      FROM outreach_campaigns c
      LEFT JOIN outreach_recipients r ON r.campaign_id=c.id
      GROUP BY c.id ORDER BY c.created_at DESC
    `);
    res.json({campaigns: rows});
  } catch(e) { logger.error({err:e},'outreach list'); res.status(500).json({error:'server_error'}); }
});

router.post('/campaigns', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, subject, html_body } = req.body;
  if (!name?.trim() || !subject?.trim() || !html_body?.trim())
    return res.status(400).json({error:'bad_request',message:'name, subject și html_body sunt obligatorii.'});
  try {
    const { rows } = await pool.query(
      `INSERT INTO outreach_campaigns (name,subject,html_body,created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), subject.trim(), html_body.trim(), actor.email]
    );
    res.json({campaign: rows[0]});
  } catch(e) { logger.error({err:e},'outreach create'); res.status(500).json({error:'server_error'}); }
});

router.get('/campaigns/:id', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({error:'bad_id'});
  try {
    const { rows: camps } = await pool.query('SELECT * FROM outreach_campaigns WHERE id=$1', [id]);
    if (!camps.length) return res.status(404).json({error:'not_found'});
    const { rows: recips } = await pool.query(
      `SELECT id,email,institutie,status,sent_at,opened_at,clicked_at,click_count,error_msg
       FROM outreach_recipients WHERE campaign_id=$1 ORDER BY id ASC`, [id]
    );
    res.json({campaign: camps[0], recipients: recips});
  } catch(e) { logger.error({err:e},'outreach get'); res.status(500).json({error:'server_error'}); }
});

router.delete('/campaigns/:id', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({error:'bad_id'});
  try {
    await pool.query('DELETE FROM outreach_recipients WHERE campaign_id=$1', [id]);
    const { rowCount } = await pool.query('DELETE FROM outreach_campaigns WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({error:'not_found'});
    res.json({ok:true});
  } catch(e) { logger.error({err:e},'outreach delete'); res.status(500).json({error:'server_error'}); }
});

// ── Recipients ────────────────────────────────────────────────────────────────

router.post('/campaigns/:id/recipients', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({error:'bad_id'});
  let entries = [];
  if (req.body.csv) {
    const lines = req.body.csv.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const start = lines[0]?.toLowerCase().startsWith('email') ? 1 : 0;
    for (const line of lines.slice(start)) {
      const cols = line.split(',').map(c=>c.trim().replace(/^"|"$/g,''));
      const email = cols[0]?.toLowerCase();
      if (email && /^[^@]+@[^@]+\.[^@]+$/.test(email)) entries.push({email, institutie: cols[1]||''});
    }
  } else if (Array.isArray(req.body.recipients)) {
    for (const r of req.body.recipients) {
      const email = (r.email||'').toLowerCase().trim();
      if (email && /^[^@]+@[^@]+\.[^@]+$/.test(email)) entries.push({email, institutie:(r.institutie||'').trim()});
    }
  } else {
    return res.status(400).json({error:'bad_request',message:'Trimite recipients[] sau csv.'});
  }
  if (!entries.length) return res.status(400).json({error:'no_valid_recipients'});
  const { rows: existing } = await pool.query('SELECT email FROM outreach_recipients WHERE campaign_id=$1', [id]);
  const existingEmails = new Set(existing.map(r=>r.email));
  const newEntries = entries.filter(e=>!existingEmails.has(e.email));
  if (!newEntries.length) return res.json({added:0, skipped:entries.length, message:'Toți destinatarii există deja.'});
  try {
    const { rowCount } = await pool.query(`
      INSERT INTO outreach_recipients (campaign_id,email,institutie,tracking_id)
      SELECT $1,e,i,md5(random()::text||clock_timestamp()::text)
      FROM UNNEST($2::text[],$3::text[]) AS t(e,i)
      ON CONFLICT (campaign_id,email) DO NOTHING
    `, [id, newEntries.map(e=>e.email), newEntries.map(e=>e.institutie)]);
    res.json({added:rowCount, skipped:entries.length-rowCount});
  } catch(e) { logger.error({err:e},'add recipients'); res.status(500).json({error:'server_error'}); }
});

router.delete('/campaigns/:id/recipients/:rid', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id=parseInt(req.params.id), rid=parseInt(req.params.rid);
  if (!id||!rid) return res.status(400).json({error:'bad_id'});
  try {
    const { rowCount } = await pool.query('DELETE FROM outreach_recipients WHERE id=$1 AND campaign_id=$2', [rid,id]);
    if (!rowCount) return res.status(404).json({error:'not_found'});
    res.json({ok:true});
  } catch(e) { logger.error({err:e},'delete recipient'); res.status(500).json({error:'server_error'}); }
});

// ── Send batch ────────────────────────────────────────────────────────────────

router.post('/campaigns/:id/send', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const campaignId = parseInt(req.params.id);
  if (!campaignId) return res.status(400).json({error:'bad_id'});
  const batchSize = Math.min(parseInt(req.body.batchSize||'50'), 100);
  try {
    const { rows: camps } = await pool.query('SELECT * FROM outreach_campaigns WHERE id=$1', [campaignId]);
    if (!camps.length) return res.status(404).json({error:'not_found'});
    const campaign = camps[0];
    const alreadySent = await sentToday();
    const remaining   = DAILY_SEND_LIMIT - alreadySent;
    if (remaining <= 0) {
      return res.status(429).json({error:'daily_limit_reached',message:`Limita zilnică de ${DAILY_SEND_LIMIT} emailuri a fost atinsă.`,sentToday:alreadySent});
    }
    const toSend = Math.min(batchSize, remaining);
    const { rows: pending } = await pool.query(`
      SELECT r.id,r.email,r.institutie,r.tracking_id,p.unsubscribe_token
      FROM outreach_recipients r
      LEFT JOIN outreach_primarii p ON lower(p.email)=lower(r.email)
      WHERE r.campaign_id=$1 AND r.status='pending'
        AND (p.unsubscribed IS NULL OR p.unsubscribed=FALSE)
      ORDER BY r.id ASC LIMIT $2
    `, [campaignId, toSend]);
    if (!pending.length) return res.json({sent:0,message:'Nu există destinatari în așteptare.'});
    let attachment = null;
    const pdfPath = PDF_PATH || path.join(process.cwd(),'tools','DocFlowAI_Prezentare.pdf');
    if (fs.existsSync(pdfPath)) {
      const buf = fs.readFileSync(pdfPath);
      attachment = {filename:'DocFlowAI_Prezentare.pdf', content:buf};
    }
    let sentCount=0, errorCount=0;
    const baseUrl = getBaseUrl(req);
    for (const recip of pending) {
      const unsubUrl = recip.unsubscribe_token ? `${baseUrl}/admin/outreach/unsubscribe/${recip.unsubscribe_token}` : null;
      const html = buildHtml(campaign.html_body, recip.institutie, recip.tracking_id, baseUrl, unsubUrl);
      const displayInst = (recip.institutie||'instituția dumneavoastră').toLowerCase().replace(/(?:^|\s)\S/g,c=>c.toUpperCase());
      const subject = (campaign.subject||'').replace(/\{\{institutie\}\}/g, displayInst);
      try {
        await sendEmail({to:recip.email, subject, html, ...(attachment?{attachments:[{filename:attachment.filename,content:attachment.content.toString('base64')}]}:{})});
        await pool.query(`UPDATE outreach_recipients SET status='sent',sent_at=NOW() WHERE id=$1`, [recip.id]);
        sentCount++;
      } catch(e) {
        const errMsg = e?.message||String(e);
        await pool.query(`UPDATE outreach_recipients SET status='error',error_msg=$1 WHERE id=$2`, [errMsg.substring(0,500),recip.id]);
        errorCount++;
      }
    }
    res.json({sent:sentCount, errors:errorCount, sentToday:alreadySent+sentCount, dailyLimit:DAILY_SEND_LIMIT, remainingToday:Math.max(0,remaining-sentCount)});
  } catch(e) { logger.error({err:e},'outreach send batch'); res.status(500).json({error:'server_error'}); }
});

router.post('/campaigns/:id/reset-errors', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  if (requireDb(res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({error:'bad_id'});
  try {
    const { rowCount } = await pool.query(
      `UPDATE outreach_recipients SET status='pending',error_msg=NULL WHERE campaign_id=$1 AND status='error'`, [id]
    );
    res.json({reset:rowCount});
  } catch(e) { logger.error({err:e},'reset errors'); res.status(500).json({error:'server_error'}); }
});

// ── Public endpoints (no auth) ────────────────────────────────────────────────

router.get('/unsubscribe/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || !/^[0-9a-f-]{36}$/.test(token))
    return res.status(400).send('<h2>Link de dezabonare invalid.</h2>');
  try {
    const { rowCount, rows } = await pool.query(
      `UPDATE outreach_primarii SET unsubscribed=TRUE,updated_at=NOW()
       WHERE unsubscribe_token=$1 AND unsubscribed=FALSE RETURNING email,institutie`,
      [token]
    );
    if (!rowCount) {
      return res.status(200).send(`<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8"><title>Dezabonare</title>
        <style>body{font-family:Arial,sans-serif;max-width:520px;margin:80px auto;text-align:center;color:#444;}</style></head>
        <body><h2>✅ Adresa este deja dezabonată</h2><p>Nu veți mai primi comunicări de la DocFlowAI pe această adresă.</p></body></html>`);
    }
    const { email, institutie } = rows[0];
    logger.info({email,institutie},'outreach: dezabonare reusita');
    res.status(200).send(`<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8"><title>Dezabonare confirmată</title>
      <style>body{font-family:Arial,sans-serif;max-width:520px;margin:80px auto;text-align:center;color:#444;}</style></head>
      <body><h2>✅ Dezabonare confirmată</h2>
      <p>Adresa <strong>${escHtml(email)}</strong> a fost dezabonată cu succes.<br>Nu veți mai primi comunicări de la DocFlowAI.</p></body></html>`);
  } catch(e) { logger.error({err:e},'unsubscribe'); res.status(500).send('<h2>Eroare internă.</h2>'); }
});

router.get('/download/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const pdfPath = PDF_PATH || path.join(process.cwd(),'tools','DocFlowAI_Prezentare.pdf');
  if (!fs.existsSync(pdfPath)) return res.status(404).send('Prezentarea nu este disponibilă momentan.');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','attachment; filename="DocFlowAI_Prezentare.pdf"');
  res.sendFile(path.resolve(pdfPath));
  if (!trackingId || !/^[a-f0-9-]{32,36}$/.test(trackingId)) return;
  pool.query(`
    UPDATE outreach_recipients
    SET downloaded_at=CASE WHEN downloaded_at IS NULL THEN NOW() ELSE downloaded_at END,
        download_count=COALESCE(download_count,0)+1,
        status=CASE WHEN status IN ('sent','pending') THEN 'opened' ELSE status END,
        opened_at=CASE WHEN opened_at IS NULL THEN NOW() ELSE opened_at END
    WHERE tracking_id=$1
  `, [trackingId]).catch(e=>logger.warn({err:e},'download track error'));
});

router.get('/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const dest = req.query.u ? decodeURIComponent(req.query.u) : 'https://www.docflowai.ro';
  const safeDest = /^https?:\/\//.test(dest) ? dest : 'https://www.docflowai.ro';
  res.redirect(302, safeDest);
  if (!trackingId || !/^[a-f0-9-]{32,36}$/.test(trackingId)) return;
  pool.query(`
    UPDATE outreach_recipients
    SET status=CASE WHEN status IN ('sent','pending') THEN 'opened' ELSE status END,
        opened_at=CASE WHEN opened_at IS NULL THEN NOW() ELSE opened_at END,
        clicked_at=CASE WHEN clicked_at IS NULL THEN NOW() ELSE clicked_at END,
        click_count=COALESCE(click_count,0)+1
    WHERE tracking_id=$1
  `, [trackingId]).catch(e=>logger.warn({err:e},'click track error'));
});

router.get('/track/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const GIF1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  res.setHeader('Content-Type','image/gif');
  res.setHeader('Cache-Control','no-store,no-cache,must-revalidate');
  res.end(GIF1x1);
  if (!trackingId || !/^[a-f0-9-]{32,36}$/.test(trackingId)) return;
  pool.query(`
    UPDATE outreach_recipients
    SET status=CASE WHEN status='sent' THEN 'opened' ELSE status END,
        opened_at=CASE WHEN opened_at IS NULL AND status='sent' THEN NOW() ELSE opened_at END
    WHERE tracking_id=$1
  `, [trackingId]).catch(e=>logger.warn({err:e},'track update error'));
});

export default router;
