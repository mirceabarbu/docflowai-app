/**
 * DocFlowAI — Report Routes
 *
 * GET  /api/flows/:flowId/report        — generează și returnează PDF raport (cu cache BYTEA)
 * GET  /api/flows/:flowId/report/json   — returnează structura JSON a raportului
 * GET  /api/flows/:flowId/report/status — verifică dacă raportul există în cache
 *
 * ?force=1 (admin only) — ignoră cache-ul și regenerează raportul
 */

import { Router }   from 'express';
import { getFlowData, pool } from '../db/index.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { logger } from '../middleware/logger.mjs';
import { generateTrustReport } from '../services/sign-trust-report.mjs';

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

    // Verificăm cache în trust_reports (BUG-01 fix: cache era citit dar ignorat)
    // ?force=1 permite admin să regenereze explicit raportul
    const forceRegen = req.query.force === '1' && isAdmin;
    if (!forceRegen) {
      const cache = await pool.query(
        `SELECT report_pdf, generated_at FROM trust_reports WHERE flow_id = $1`, [flowId]
      ).catch(() => ({ rows: [] }));
      if (cache.rows.length > 0 && cache.rows[0].report_pdf) {
        logger.info({ flowId, actor: actor.email }, 'Trust report servit din cache');
        const pdfBuf = Buffer.isBuffer(cache.rows[0].report_pdf)
          ? cache.rows[0].report_pdf
          : Buffer.from(cache.rows[0].report_pdf);
        const filename = `TrustReport_${flowId}_${new Date(cache.rows[0].generated_at).toISOString().slice(0,10)}.pdf`;
        res.setHeader('Content-Type',        'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length',      pdfBuf.length);
        res.setHeader('Cache-Control',       'no-store');
        res.setHeader('X-Report-Cached',     'true');
        return res.end(pdfBuf);
      }
    }

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
    const { pdfBytes: pdfOutput, report, conclusion } = await generateTrustReport({
      flowId, flowData: data, pdfBytes, pool,
    });

    logger.info({ flowId, actor: actor.email, size: pdfOutput.length }, 'Trust report generat');

    // Logăm TRUST_REPORT_GENERATED + CERTIFICATE_EXTRACTED în flow_events
    try {
      const certEvents = [];
      for (const sig of (report.certificates || [])) {
        if (!sig.certificate) continue;
        const c = sig.certificate;
        certEvents.push({
          type: 'CERTIFICATE_EXTRACTED',
          at: new Date().toISOString(),
          by: actor.email,
          signerIndex: sig.signerIndex,
          certificateType: c.certificateType || 'unknown',
          issuer: c.issuer?.CN || c.issuer?.O || '—',
          subjectCN: c.subject?.CN || '—',
          wasValidAtSigning: c.validAtSigning,
          revocationStatus: c.revocationStatus || 'unknown',
          isQES: sig.isQES || false,
        });
      }
      const trustEvent = {
        type: 'TRUST_REPORT_GENERATED',
        at: new Date().toISOString(),
        by: actor.email,
        conclusion: report.conclusion?.substring(0, 200),
        signatureCount: report.verification?.signatureCount || 0,
        allQES: report.verification?.allQES ?? null,
        integrityOk: report.verification?.integrityOk ?? null,
      };
      // Inserăm în flow_events (JSONB append)
      await pool.query(
        `UPDATE flows SET data = jsonb_set(
          data,
          '{events}',
          (COALESCE(data->'events', '[]'::jsonb) || $2::jsonb)
        ) WHERE flow_id = $1`,
        [flowId, JSON.stringify([...certEvents, trustEvent])]
      );
    } catch(evErr) {
      logger.warn({ err: evErr, flowId }, 'flow_events update failed (non-fatal)');
    }

    // Returnăm PDF
    const filename = `TrustReport_${flowId}_${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      pdfOutput.length);
    res.setHeader('Cache-Control',       'no-store');
    return res.end(pdfOutput);

  } catch(e) {
    logger.error({ err: e, stack: e.stack, flowId }, 'report generation error');
    if (!res.headersSent) {
      return res.status(500).json({ error: 'server_error', message: 'Eroare la generarea raportului. Verificați log-urile serverului.', requestId: req.requestId });
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
