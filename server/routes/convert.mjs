import { Router } from 'express';
import Busboy from 'busboy';
import { convertToPdf } from '../utils/convertToPdf.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = Router();

// POST /api/convert-to-pdf
// Primește un fișier multipart, returnează PDF ca base64
router.post('/api/convert-to-pdf', (req, res) => {
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
      res.status(422).json({ error: e.message });
    }
  });

  bb.on('error', e => res.status(500).json({ error: e.message }));
  req.pipe(bb);
});

export default router;
