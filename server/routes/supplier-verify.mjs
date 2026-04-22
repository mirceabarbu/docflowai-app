// server/routes/supplier-verify.mjs — verificare furnizor (CUI ANAF + IBAN + coerență)
// Montat la /api/v4/verify în server/index.mjs
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { logger } from '../middleware/logger.mjs';
import { lookupCui } from '../services/verify/anafClient.mjs';
import { verifyIban } from '../services/verify/ibanValidator.mjs';
import { analyzeCoherence } from '../services/verify/coherence.mjs';

const router = Router();

// GET /api/v4/verify/cui?cui=12345678
router.get('/cui', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  const cui = (req.query.cui || '').toString();
  if (!cui) return res.status(400).json({ error: 'cui_required' });
  try {
    const result = await lookupCui(cui);
    res.json(result);
  } catch (e) {
    logger.error({ err: e }, 'verify/cui error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/v4/verify/iban?iban=RO12...
router.get('/iban', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  const iban = (req.query.iban || '').toString();
  if (!iban) return res.status(400).json({ error: 'iban_required' });
  try {
    const result = verifyIban(iban);
    res.json(result);
  } catch (e) {
    logger.error({ err: e }, 'verify/iban error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/v4/verify/coherence  body: {cui, iban, name}
router.post('/coherence', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  const { cui, iban, name } = req.body || {};
  if (!cui && !iban) return res.status(400).json({ error: 'cui_or_iban_required' });
  try {
    const [cuiResult, ibanResult] = await Promise.all([
      cui ? lookupCui(cui) : Promise.resolve({ ok: true, data: null, skipped: true }),
      iban ? Promise.resolve(verifyIban(iban)) : Promise.resolve({ ok: true, data: null, skipped: true }),
    ]);
    const companyData = cuiResult.ok ? cuiResult.data : null;
    const ibanData = ibanResult.ok ? ibanResult.data : null;
    const warnings = analyzeCoherence({ companyData, ibanData, declaredName: name });
    res.json({
      ok: true,
      company: cuiResult,
      iban: ibanResult,
      warnings,
    });
  } catch (e) {
    logger.error({ err: e }, 'verify/coherence error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
