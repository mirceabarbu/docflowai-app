import { Router } from 'express';
import Busboy from 'busboy';
import { convertToPdf } from '../utils/convertToPdf.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { createRateLimiter } from '../middleware/rateLimiter.mjs';

const router = Router();

// #107 — aceeași convenție ca _uploadRateLimit din flows/*: 5 conversii/minut.
// Rulează ÎNAINTE de Busboy, deci refuzul nu consumă banda de upload.
const _convertRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Prea multe conversii. Încearcă în 1 minut.',
});

// POST /api/convert-to-pdf
// Primește un fișier multipart, returnează PDF ca base64
router.post('/api/convert-to-pdf', _convertRateLimit, (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  const bb = Busboy({
    headers: req.headers,
    limits: { fileSize: 50 * 1024 * 1024 }
  });
  let fileName = 'document';
  const chunks = [];
  let limitHit = false;

  bb.on('file', (_field, stream, info) => {
    fileName = info.filename || 'document';
    stream.on('data', d => chunks.push(d));
    stream.on('limit', () => {
      limitHit = true;
      res.status(413).json({ error: 'Fișier prea mare (max 50MB)' });
    });
  });

  bb.on('finish', async () => {
    if (limitHit) return;
    try {
      const buffer = Buffer.concat(chunks);
      const pdfBuffer = await convertToPdf(buffer, fileName);
      const b64 = 'data:application/pdf;base64,' + pdfBuffer.toString('base64');
      res.json({ pdfB64: b64, originalName: fileName });
    } catch (e) {
      // #107 — semaforul LibreOffice a refuzat: e o condiție TEMPORARĂ de
      // încărcare, nu un fișier invalid. 503 + Retry-After, ca să reîncerce.
      if (e && (e.code === 'GATE_BUSY' || e.code === 'GATE_TIMEOUT')) {
        res.setHeader('Retry-After', '30');
        return res.status(503).json({
          error: 'convert_busy',
          message: 'Serverul de conversie e ocupat. Reîncearcă în câteva secunde.',
        });
      }
      res.status(422).json({ error: e.message });
    }
  });

  bb.on('error', e => res.status(500).json({ error: e.message }));
  req.pipe(bb);
});

export default router;
