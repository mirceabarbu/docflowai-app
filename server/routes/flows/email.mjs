/**
 * DocFlowAI — flows/email.mjs
 * Email extern: trimitere, tracking (open/click)
 */
import {{ Router, json as expressJson }} from 'express';
import {{ AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml }} from '../middleware/auth.mjs';
import {{ pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent }} from '../db/index.mjs';
import {{ createRateLimiter }} from '../middleware/rateLimiter.mjs';
import {{ logger }} from '../middleware/logger.mjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const _largePdf = expressJson({{ limit: '50mb' }});
const _getIp = req => req.ip || req.socket?.remoteAddress || null;
const _signRateLimit   = createRateLimiter({{ windowMs: 60_000, max: 20, message: 'Prea multe cereri de semnare. Încearcă în 1 minut.' }});
const _uploadRateLimit = createRateLimiter({{ windowMs: 60_000, max: 5,  message: 'Prea multe upload-uri. Încearcă în 1 minut.' }});
const _readRateLimit   = createRateLimiter({{ windowMs: 60_000, max: 60, message: 'Prea multe cereri. Încearcă în 1 minut.' }});

function getOptionalActor(req) {{
  const cookieToken = req.cookies?.[AUTH_COOKIE] || null;
  if (cookieToken) {{ try {{ return jwt.verify(cookieToken, JWT_SECRET); }} catch (e) {{}} }}
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {{ try {{ return jwt.verify(authHeader.slice(7), JWT_SECRET); }} catch (e) {{}} }}
  return null;
}}

// Deps injectate din flows/index.mjs
let _notify, _wsPush, _PDFLib, _stampFooterOnPdf, _isSignerTokenExpired;
let _newFlowId, _buildSignerLink, _stripSensitive, _stripPdfB64, _sendSignerEmail, _fireWebhook;
export function _injectDeps(d) {{
  _notify = d.notify; _fireWebhook = d.fireWebhook || null; _wsPush = d.wsPush;
  _PDFLib = d.PDFLib; _stampFooterOnPdf = d.stampFooterOnPdf;
  _isSignerTokenExpired = d.isSignerTokenExpired; _newFlowId = d.newFlowId;
  _buildSignerLink = d.buildSignerLink; _stripSensitive = d.stripSensitive;
  _stripPdfB64 = d.stripPdfB64; _sendSignerEmail = d.sendSignerEmail;
}}

const router = Router();

import { emailSendExtern } from '../emailTemplates.mjs';



router.post('/flows/:flowId/send-email', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flowId } = req.params;
    const { to, subject, bodyText, extraAttachments = [] } = req.body || {};
    // extraAttachments: [{ filename, dataB64 }] — fișiere suplimentare alese de user
    // Nu se salvează în DB, doar atașate la email
    const includeAttachment = true;
    const includeLink = true;

    // Generăm un tracking ID unic pentru acest email
    const trackingId = crypto.randomUUID();
    const appBase    = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

    // Validare
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim()))
      return res.status(400).json({ error: 'invalid_email', message: 'Adresă de email invalidă.' });
    if (!subject || !subject.trim())
      return res.status(400).json({ error: 'subject_required', message: 'Subiectul este obligatoriu.' });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!data.completed && data.status !== 'completed')
      return res.status(409).json({ error: 'not_completed', message: 'Documentul nu este finalizat.' });

    // Preluăm datele expeditorului din DB (funcție, institutie, compartiment)
    const { rows: senderRows } = await pool.query(
      'SELECT nume, functie, institutie, compartiment, email FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const sender = senderRows[0] || {};
    const senderName  = sender.nume  || actor.email;
    const senderTitle = [sender.functie, sender.compartiment, sender.institutie].filter(Boolean).join(' · ');

    // PDF semnat — din JSONB sau, dacă e arhivat, din Google Drive
    let pdfB64 = data.signedPdfB64 || data.pdfB64 || null;
    if (includeAttachment && !pdfB64 && data.storage === 'drive' && data.driveFileIdFinal) {
      try {
        const { getBufferFromDrive } = await import('../drive.mjs');
        const buf = await getBufferFromDrive(data.driveFileIdFinal);
        pdfB64 = buf.toString('base64');
      } catch(driveErr) {
        logger.warn({ err: driveErr, flowId }, 'send-email: failed to load PDF from Drive');
      }
    }
    if (includeAttachment && !pdfB64)
      return res.status(409).json({ error: 'no_pdf', message: 'PDF-ul semnat nu este disponibil (nici local, nici în Drive).' });

    // A — b97: template HTML extras în emailTemplates.mjs::emailSendExtern
    const signersForTemplate = (data.signers || []).map(s => ({
      name: s.name || s.email,
      rol: s.rol || '',
      signedAt: s.signedAt || null,
      status: s.status === 'signed' ? 'semnat' : s.status === 'refused' ? 'refuzat' : 'în așteptare',
    }));
    const { html } = emailSendExtern({ flowId, data, signers: signersForTemplate, bodyText, trackingId, appBase });

    // Construim payload Resend
    const { sendSignerEmail } = await import('../mailer.mjs');
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const MAIL_FROM = process.env.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>';

    if (!RESEND_API_KEY) return res.status(503).json({ error: 'mail_not_configured', message: 'Email-ul nu este configurat pe server.' });

    // Tracking primar: click pe link-ul "DocFlowAI" din email (funcționează și cu imagini blocate)
    // Tracking secundar: pixel GIF 1x1 ca fallback (blocat de mulți clienți de email instituționali)
    const trackingPixelUrl = `${appBase}/flows/${flowId}/email-open/${trackingId}`;
    const htmlWithTracking = html.replace('</body>', `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none;border:0;" alt="" /></body>`);

    const payload = { from: MAIL_FROM, to: to.trim(), subject: subject.trim(), html: htmlWithTracking };
    const attachments = [];

    if (includeAttachment && pdfB64) {
      const pdfName = `${(data.docName || flowId).replace(/[^a-zA-Z0-9_\-\.]/g, '_')}_semnat.pdf`;
      const cleanPdfB64 = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
      attachments.push({ filename: pdfName, content: cleanPdfB64 });
    }

    // Atașamente suplimentare trimise de user (max 20MB total, verificat în frontend)
    for (const att of extraAttachments) {
      if (!att.filename || !att.dataB64) continue;
      const clean = att.dataB64.includes(',') ? att.dataB64.split(',')[1] : att.dataB64;
      attachments.push({ filename: att.filename, content: clean });
    }

    if (attachments.length > 0) payload.attachments = attachments;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.error({ err: j }, `send-email FAILED to ${to}`);
      return res.status(502).json({ error: 'send_failed', message: j?.message || 'Eroare la trimiterea emailului.' });
    }

    // Audit log cu trackingId
    const now = new Date().toISOString();
    if (!Array.isArray(data.events)) data.events = [];
    data.events.push({
      at: now, type: 'EMAIL_SENT', by: actor.email,
      to: to.trim(), subject: subject.trim(),
      trackingId,
      extraAttachmentsCount: extraAttachments.length,
    });
    await saveFlow(flowId, data);
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'EMAIL_SENT',
      actorIp: _getIp(req), actorEmail: actor.email,
      payload: { to: to.trim(), subject: subject.trim(), resendId: j.id, trackingId } });

    logger.info({ flowId, to, actor: actor.email, trackingId }, '📧 Email extern trimis');
    return res.json({ ok: true, resendId: j.id, trackingId });
  } catch(e) { logger.error({ err: e }, 'send-email error'); return res.status(500).json({ error: 'server_error', message: String(e.message) }); }
});





// ── GET /flows/:flowId/email-open/:trackingId — pixel tracking deschidere email ──
// Apelat automat de clientul de email când deschide mesajul (img 1x1).
// Non-autentificat, răspunde cu GIF transparent 1x1.
router.get('/flows/:flowId/email-open/:trackingId', async (req, res) => {
  // GIF transparent 1x1 px
  const gif1x1 = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.setHeader('Content-Type',  'image/gif');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma',        'no-cache');
  res.setHeader('Expires',       '0');
  res.end(gif1x1);

  // Procesăm async — nu blocăm răspunsul
  setImmediate(async () => {
    try {
      if (requireDb({ status: () => {} })) return;
      const { flowId, trackingId } = req.params;
      const data = await getFlowData(flowId);
      if (!data) return;

      const events = Array.isArray(data.events) ? data.events : [];
      // Găsim evenimentul EMAIL_SENT cu acest trackingId
      const emailEv = events.find(e => e.type === 'EMAIL_SENT' && e.trackingId === trackingId);
      if (!emailEv) return;

      // Nu înregistrăm deschideri multiple (de-duplicare simplă pe trackingId)
      const alreadyOpened = events.some(e => e.type === 'EMAIL_OPENED' && e.trackingId === trackingId);
      if (alreadyOpened) return;

      const now = new Date().toISOString();
      const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '—';
      const ua  = (req.headers['user-agent'] || '').substring(0, 200);

      data.events.push({
        at:         now,
        type:       'EMAIL_OPENED',
        trackingId,
        to:         emailEv.to,
        by:         emailEv.by,       // cel care a trimis
        ip,
        userAgent:  ua,
      });
      data.updatedAt = now;
      await saveFlow(flowId, data);

      // Scriem și în audit_log pentru accesuri înregistrate
      writeAuditEvent({
        flowId, orgId: data.orgId, eventType: 'EMAIL_OPENED',
        actorEmail: emailEv.to,   // destinatarul care a deschis
        actorIp: ip,
        payload: { trackingId, sentBy: emailEv.by, userAgent: ua },
      });

      logger.info({ flowId, trackingId, to: emailEv.to, ip }, '📬 Email deschis');
    } catch(e) {
      logger.warn({ err: e }, 'email-open tracking error (non-fatal)');
    }
  });
});


// ── GET /flows/email-click/:trackingId — click tracking email extern ──────
// Link-ul "DocFlowAI" din email trece prin acest endpoint → redirect 302 → URL original.
// Nu necesită autentificare. Înregistrează EMAIL_OPENED la primul click.
router.get('/flows/email-click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const dest    = req.query.u ? decodeURIComponent(req.query.u) : (process.env.PUBLIC_BASE_URL || '/');
  const safeDest = /^https?:\/\//.test(dest) ? dest : (process.env.PUBLIC_BASE_URL || '/');

  // Redirect imediat — nu blocăm utilizatorul
  res.redirect(302, safeDest);

  // Procesăm async
  setImmediate(async () => {
    try {
      if (!trackingId) return;
      // Găsim fluxul după trackingId
      const { rows } = await pool.query(
        `SELECT flow_id FROM flows
         WHERE data->'events' @> $1::jsonb LIMIT 1`,
        [JSON.stringify([{ trackingId }])]
      );
      if (!rows.length) return;
      const flowId = rows[0].flow_id;
      const data   = await getFlowData(flowId);
      if (!data) return;

      const events = Array.isArray(data.events) ? data.events : [];
      const emailEv = events.find(e => e.trackingId === trackingId);
      if (!emailEv) return;

      // Deduplicare — înregistrăm o singură dată per trackingId
      const alreadyOpened = events.some(e => e.type === 'EMAIL_OPENED' && e.trackingId === trackingId);
      if (alreadyOpened) return;

      const now = new Date().toISOString();
      const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '—';
      const ua  = (req.headers['user-agent'] || '').substring(0, 200);

      data.events.push({
        at: now, type: 'EMAIL_OPENED', trackingId,
        to: emailEv.to, by: emailEv.by, ip, userAgent: ua,
      });
      data.updatedAt = now;
      await saveFlow(flowId, data);

      writeAuditEvent({
        flowId, orgId: data.orgId, eventType: 'EMAIL_OPENED',
        actorEmail: emailEv.to, actorIp: ip,
        payload: { trackingId, sentBy: emailEv.by, via: 'click', userAgent: ua },
      });
      logger.info({ flowId, trackingId, to: emailEv.to, ip }, '📬 Email deschis (click)');
    } catch(e) {
      logger.warn({ err: e }, 'email-click tracking error (non-fatal)');
    }
  });
});

// ── POST /flows/detect-acroform-fields ───────────────────────────────────
// Extrage câmpurile de semnătură din PDF.
// Suportă 3 formate:
//   1. AcroForm/Fields cu FT=/Sig (PDF standard)
//   2. Page/Annots cu Widget+FT=/Sig (formulare guvernamentale)
//   3. XFA cu tag <signature> (Ordonanță de Plată, formulare dinamice Adobe)


export default router;
