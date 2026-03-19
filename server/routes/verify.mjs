/**
 * Rute publice de verificare — fără autentificare.
 * GET  /verify/:flowId    — verificare după Flow ID
 * POST /verify/signature  — verificare criptografică PDF
 */
import { Router } from 'express';
const router = Router();

let _pool = null;
let _getFlowData = null;
let _verifyPdfSignatures = null;
let _formatVerificationResult = null;

export function injectVerifyDeps(deps) {
  _pool            = deps.pool;
  _getFlowData     = deps.getFlowData;
}

// ── GET /verify/:flowId ────────────────────────────────────────────────────
router.get('/verify/:flowId', async (req, res) => {
  try {
    const { flowId } = req.params;
    if (!flowId) return res.status(400).json({ error: 'flowId_required' });
    if (!_pool || !_getFlowData)
      return res.status(503).json({ error: 'service_unavailable' });

    const data = await _getFlowData(flowId);
    if (!data) return res.status(404).json({
      error: 'not_found',
      message: 'Documentul cu acest ID nu a fost găsit în platformă.',
    });

    const signers = (data.signers || []).map(s => ({
      name:      s.name || s.email,
      rol:       s.rol || '',
      status:    s.status,
      signedAt:  s.signedAt || null,
      signingProvider: s.signingProvider || 'local-upload',
    }));

    const events = (data.events || [])
      .filter(e => ['FLOW_CREATED','SIGNED','SIGNED_PDF_UPLOADED',
                    'FLOW_COMPLETED','FLOW_CANCELLED','REFUSED'].includes(e.type))
      .map(e => ({ at: e.at, type: e.type, by: e.by }));

    return res.json({
      ok:           true,
      flowId,
      docName:      data.docName || flowId,
      institutie:   data.institutie || '',
      compartiment: data.compartiment || '',
      flowType:     data.flowType || 'tabel',
      status:       data.completed ? 'completed' : (data.status || 'active'),
      createdAt:    data.createdAt,
      completedAt:  data.completedAt || null,
      cancelledAt:  data.cancelledAt || null,
      signers,
      events,
    });
  } catch(e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /verify/signature ─────────────────────────────────────────────────
router.post('/verify/signature', async (req, res) => {
  try {
    const { pdfB64, flowId } = req.body || {};
    if (!pdfB64) return res.status(400).json({ error: 'pdfB64_required' });

    const raw      = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const pdfBytes = Buffer.from(raw, 'base64');
    if (pdfBytes.length > 50 * 1024 * 1024)
      return res.status(413).json({ error: 'pdf_too_large' });

    // Import lazy (pkijs instalat prin npm)
    if (!_verifyPdfSignatures) {
      try {
        const mod = await import('../verify.mjs');
        _verifyPdfSignatures       = mod.verifyPdfSignatures;
        _formatVerificationResult  = mod.formatVerificationResult;
      } catch(e) {
        return res.status(503).json({
          error: 'crypto_unavailable',
          message: 'Modulul de verificare criptografică nu este disponibil. ' + e.message,
        });
      }
    }

    const rawResult = await _verifyPdfSignatures(pdfBytes);
    const result    = _formatVerificationResult(rawResult);

    // Corelăm cu DB dacă avem flowId
    let dbData = null;
    if (flowId && _getFlowData) {
      try {
        const data = await _getFlowData(flowId);
        if (data) dbData = {
          docName:      data.docName,
          institutie:   data.institutie,
          compartiment: data.compartiment,
          completedAt:  data.completedAt,
          status:       data.completed ? 'completed' : data.status,
          signers: (data.signers || []).map(s => ({
            name: s.name || s.email, rol: s.rol,
            status: s.status, signedAt: s.signedAt,
          })),
        };
      } catch { /* non-fatal */ }
    }

    return res.json({ ...result, dbData });
  } catch(e) {
    return res.status(500).json({ error: 'server_error', message: e.message });
  }
});

export default router;
