/**
 * DocFlowAI — Report Routes
 *
 * GET  /api/flows/:flowId/report        — generează și returnează PDF raport
 * GET  /api/flows/:flowId/report/json   — returnează structura JSON a raportului
 * GET  /api/flows/:flowId/report/status — verifică dacă raportul există în cache
 */

import { Router }   from 'express';
import { getFlowData, pool } from '../db/index.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();

// ── GET /api/flows/:flowId/report — generează PDF raport ──────────────────
// Necesită autentificare (inițiator sau admin)
router.get('/api/flows/:flowId/report', async (req, res) => {
  try {
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });

    // Verificăm că actorul e inițiatorul sau admin
    const isAdmin = actor.role === 'admin';
    const isInit  = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isSigner = (data.signers || []).some(s => (s.email || '').toLowerCase() === actor.email.toLowerCase());
    if (!isAdmin && !isInit && !isSigner)
      return res.status(403).json({ error: 'forbidden', message: 'Acces permis doar inițiatorului sau semnatarilor.' });

    // Verificăm cache în trust_reports
    const cache = await pool.query(
      `SELECT report_json, generated_at FROM trust_reports WHERE flow_id = $1`, [flowId]
    ).catch(() => ({ rows: [] }));

    // Obținem PDF-ul semnat pentru verificare criptografică
    let pdfBytes = null;
    try {
      const pdfB64 = data.signedPdfB64 || data.pdfB64;
      if (pdfB64) {
        const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
        pdfBytes = Buffer.from(clean, 'base64');
      }
    } catch { /* non-fatal */ }

    // Generăm raportul
    const { generateTrustReport } = await import('../services/sign-trust-report.mjs');
    const { pdfBytes: pdfOutput, report, conclusion } = await generateTrustReport({
      flowId, flowData: data, pdfBytes, pool,
    });

    logger.info({ flowId, actor: actor.email, size: pdfOutput.length }, 'Trust report generat');

    // Returnăm PDF
    const filename = `TrustReport_${flowId}_${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      pdfOutput.length);
    res.setHeader('Cache-Control',       'no-store');
    return res.end(pdfOutput);

  } catch(e) {
    logger.error({ err: e, stack: e.stack }, 'report generation error');
    // Asigurăm că răspundem cu JSON indiferent de circumstanțe
    if (!res.headersSent) {
      return res.status(500).json({ error: 'server_error', message: e.message, stack: e.stack?.split('\n')[0] });
    }
  }
});

// ── GET /api/flows/:flowId/report/json — structura JSON raport ────────────
router.get('/api/flows/:flowId/report/json', async (req, res) => {
  try {
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });

    const isAdmin  = actor.role === 'admin';
    const isInit   = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isSigner = (data.signers || []).some(s => (s.email||'').toLowerCase() === actor.email.toLowerCase());
    if (!isAdmin && !isInit && !isSigner)
      return res.status(403).json({ error: 'forbidden' });

    let pdfBytes = null;
    try {
      const raw = data.signedPdfB64 || data.pdfB64;
      if (raw) pdfBytes = Buffer.from(raw.includes(',') ? raw.split(',')[1] : raw, 'base64');
    } catch { }

    const { generateTrustReport } = await import('../services/sign-trust-report.mjs');
    const { report } = await generateTrustReport({ flowId, flowData: data, pdfBytes, pool });

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, report });
  } catch(e) {
    return res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ── GET /api/flows/:flowId/report/status ──────────────────────────────────
router.get('/api/flows/:flowId/report/status', async (req, res) => {
  try {
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const { rows } = await pool.query(
      `SELECT generated_at, conclusion FROM trust_reports WHERE flow_id = $1`, [flowId]
    ).catch(() => ({ rows: [] }));
    return res.json({ exists: rows.length > 0, generatedAt: rows[0]?.generated_at, conclusion: rows[0]?.conclusion });
  } catch(e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
