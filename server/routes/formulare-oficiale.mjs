/**
 * server/routes/formulare-oficiale.mjs
 * REST CRUD pentru formulare_oficiale (Referat Necesitate, NF Investiții).
 * Mount: app.use('/api/formulare-oficiale', formulareOficialeRouter)
 */

import { Router, json as expressJson } from 'express';
import { requireAuth }                  from '../middleware/auth.mjs';
import { csrfMiddleware }               from '../middleware/csrf.mjs';
import { requireModule }                from '../middleware/require-module.mjs';
import { pool }                         from '../db/index.mjs';
import { logger }                       from '../middleware/logger.mjs';
import { generateNfInvestPdf }          from '../services/formulare-oficiale/nf-invest-pdf.mjs';
import { generateRefnecPdf }            from '../services/formulare-oficiale/refnec-pdf.mjs';
import { createRateLimiter }            from '../middleware/rateLimiter.mjs';

const router = Router();
const _json  = expressJson({ limit: '2mb' });

// Gate per form_type: REFNEC → modulul 'refnec', NOTAFD_INVEST → 'nf-invest'.
// Dacă form_type lipsește/e invalid, lăsăm handler-ul să răspundă 400.
function gateFormularOficial(req, res, next) {
  const ft = req.body?.form_type;
  const moduleKey =
    ft === 'REFNEC'        ? 'refnec'    :
    ft === 'NOTAFD_INVEST' ? 'nf-invest' : null;
  if (!moduleKey) return next();
  return requireModule(moduleKey)(req, res, next);
}

// ── GET /api/formulare-oficiale ───────────────────────────────────────────────
// Listare paginată (20/pagină) filtrată per org + opțional form_type
router.get('/', requireAuth, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const page     = Math.max(1, parseInt(req.query.page  || '1', 10));
    const per      = 20;
    const offset   = (page - 1) * per;
    const ftype    = req.query.form_type || null;

    const params = [orgId, per, offset];
    const typeClause = ftype ? `AND form_type = $4` : '';
    if (ftype) params.push(ftype);

    const sql = `
      SELECT id, form_type, ref_number, title, status,
             created_at, updated_at,
             COUNT(*) OVER() AS total_count
        FROM formulare_oficiale
       WHERE org_id = $1
         AND deleted_at IS NULL
         ${typeClause}
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3
    `;
    const { rows } = await pool.query(sql, params);
    const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    return res.json({
      items: rows.map(r => ({
        id:         r.id,
        form_type:  r.form_type,
        ref_number: r.ref_number,
        title:      r.title,
        status:     r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      total,
      page,
      pages: Math.ceil(total / per),
    });
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale list error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

// ── POST /api/formulare-oficiale ──────────────────────────────────────────────
router.post('/', requireAuth, csrfMiddleware, _json, gateFormularOficial, async (req, res) => {
  try {
    const { orgId, userId } = req.actor;
    const { form_type, title, ref_number, form_data } = req.body || {};

    if (!form_type || !['REFNEC', 'NOTAFD_INVEST'].includes(form_type))
      return res.status(400).json({ error: 'form_type invalid' });
    if (!title || typeof title !== 'string' || !title.trim())
      return res.status(400).json({ error: 'title obligatoriu' });

    const { rows } = await pool.query(`
      INSERT INTO formulare_oficiale
        (org_id, created_by, form_type, ref_number, title, form_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, form_type, ref_number, title, status, form_data, created_at, updated_at
    `, [orgId, userId, form_type, ref_number || null, title.trim(), JSON.stringify(form_data || {})]);

    return res.status(201).json({ ok: true, formular: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale create error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

// ── GET /api/formulare-oficiale/:id ──────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id }    = req.params;

    const { rows } = await pool.query(`
      SELECT id, form_type, ref_number, title, status, form_data,
             pdf_path, pdf_generated_at, created_at, updated_at
        FROM formulare_oficiale
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
    `, [id, orgId]);

    if (!rows.length) return res.status(404).json({ error: 'Formularul nu a fost găsit.' });
    return res.json(rows[0]);
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale get error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

// ── PUT /api/formulare-oficiale/:id ──────────────────────────────────────────
router.put('/:id', requireAuth, csrfMiddleware, _json, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id }    = req.params;
    const { title, ref_number, form_data, status } = req.body || {};

    const allowedStatus = ['draft', 'completed', 'archived'];
    if (status && !allowedStatus.includes(status))
      return res.status(400).json({ error: 'status invalid' });

    const { rows } = await pool.query(`
      UPDATE formulare_oficiale
         SET title      = COALESCE($3, title),
             ref_number = COALESCE($4, ref_number),
             form_data  = COALESCE($5, form_data),
             status     = COALESCE($6, status)
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
      RETURNING id, form_type, ref_number, title, status, form_data, updated_at
    `, [id, orgId,
        title       ? title.trim() : null,
        ref_number  !== undefined   ? ref_number : null,
        form_data   !== undefined   ? JSON.stringify(form_data) : null,
        status      || null]);

    if (!rows.length) return res.status(404).json({ error: 'Formularul nu a fost găsit.' });
    return res.json({ ok: true, formular: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale update error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

// ── DELETE /api/formulare-oficiale/:id ───────────────────────────────────────
router.delete('/:id', requireAuth, csrfMiddleware, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id }    = req.params;

    const { rowCount } = await pool.query(`
      UPDATE formulare_oficiale
         SET deleted_at = NOW()
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
    `, [id, orgId]);

    if (!rowCount) return res.status(404).json({ error: 'Formularul nu a fost găsit.' });
    return res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale delete error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

// #107 — generare PDF in-process (pdf-lib): CPU-heavy, fără subprocess.
const _genPdfRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Prea multe generări PDF. Încearcă în 1 minut.',
});

// ── POST /api/formulare-oficiale/:id/generate-pdf ────────────────────────────
router.post('/:id/generate-pdf', _genPdfRateLimit, requireAuth, csrfMiddleware, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id }    = req.params;

    const { rows } = await pool.query(`
      SELECT id, form_type, title, form_data
        FROM formulare_oficiale
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
    `, [id, orgId]);

    if (!rows.length) return res.status(404).json({ error: 'Formularul nu a fost găsit.' });

    const formular = rows[0];
    let pdfBuf;

    if (formular.form_type === 'NOTAFD_INVEST') {
      pdfBuf = await generateNfInvestPdf(formular);
    } else if (formular.form_type === 'REFNEC') {
      pdfBuf = await generateRefnecPdf(formular);
    } else {
      return res.status(400).json({ error: 'Generare PDF nu este suportată pentru acest tip.' });
    }

    await pool.query(`
      UPDATE formulare_oficiale
         SET pdf_generated_at = NOW()
       WHERE id = $1
    `, [id]);

    const typePrefix = formular.form_type === 'REFNEC' ? 'RefNec' : 'NF-Invest';
    const fileName = `${typePrefix}-${formular.title.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    return res.send(pdfBuf);
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale generate-pdf error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

// ═══════════════════════════════════════════════════════
// ATTACHMENTS — Caiet sarcini (sect J), Estimare valoare (sect F), altele
// ═══════════════════════════════════════════════════════

const ATT_ALLOWED_MIME = new Set([
  'application/pdf',
  'application/zip', 'application/x-zip-compressed', 'application/x-zip',
  'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png',
]);
const ATT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per fișier
const ATT_CATEGORIES = ['caiet_sarcini', 'estimare_valoare', 'altele'];

// POST /api/formulare-oficiale/:id/attachments — upload
router.post('/:id/attachments', requireAuth, csrfMiddleware, _json, async (req, res) => {
  try {
    const { orgId, userId } = req.actor;
    const { id } = req.params;
    const { filename, mimeType, dataB64, category, notes } = req.body || {};

    if (!filename || !dataB64) return res.status(400).json({ error: 'filename_and_data_required' });
    if (!ATT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'invalid_category', message: 'Categorie invalidă.' });

    // Verifică formularul există și aparține org-ului
    const { rows: fRows } = await pool.query(
      `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, orgId]
    );
    if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

    // MIME detection
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mimeByExt = {
      pdf: 'application/pdf',
      zip: 'application/zip',
      rar: 'application/x-rar-compressed',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    };
    const resolvedMime = (mimeType && ATT_ALLOWED_MIME.has(mimeType)) ? mimeType : (mimeByExt[ext] || mimeType || 'application/octet-stream');
    if (!ATT_ALLOWED_MIME.has(resolvedMime)) {
      return res.status(400).json({ error: 'invalid_type', message: 'Tipuri acceptate: PDF, DOC(X), XLS(X), ZIP, RAR, JPG, PNG.' });
    }

    const raw = dataB64.includes(',') ? dataB64.split(',')[1] : dataB64;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > ATT_MAX_BYTES) return res.status(413).json({ error: 'too_large', message: 'Fișierul depășește 25 MB.' });

    const { rows } = await pool.query(
      `INSERT INTO formular_attachments
         (formular_id, category, uploaded_by, filename, mime_type, size_bytes, data, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, category, filename, mime_type, size_bytes, notes, uploaded_at`,
      [id, category, userId, filename.slice(0, 255), resolvedMime, buf.length, buf, notes || null]
    );
    return res.status(201).json({ ok: true, attachment: rows[0] });
  } catch(e) {
    logger.error({ err: e }, 'formular attachment upload error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-oficiale/:id/attachments — listă (opțional ?category=X)
router.get('/:id/attachments', requireAuth, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id } = req.params;
    const { category } = req.query;

    const { rows: fRows } = await pool.query(
      `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, orgId]
    );
    if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

    const params = [id];
    let where = 'formular_id=$1 AND deleted_at IS NULL';
    if (category && ATT_CATEGORIES.includes(category)) {
      params.push(category);
      where += ` AND category=$${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT id, category, filename, mime_type, size_bytes, notes, uploaded_at, uploaded_by
         FROM formular_attachments
        WHERE ${where}
        ORDER BY uploaded_at DESC`,
      params
    );
    return res.json(rows);
  } catch(e) {
    logger.error({ err: e }, 'formular attachments list error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-oficiale/:id/attachments/:attId — descarcă
router.get('/:id/attachments/:attId', requireAuth, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id, attId } = req.params;

    const { rows: fRows } = await pool.query(
      `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, orgId]
    );
    if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

    const { rows } = await pool.query(
      `SELECT filename, mime_type, data
         FROM formular_attachments
        WHERE id=$1 AND formular_id=$2 AND deleted_at IS NULL`,
      [attId, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'attachment_not_found' });
    const att = rows[0];
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
    res.setHeader('Content-Length', att.data.length);
    return res.send(att.data);
  } catch(e) {
    logger.error({ err: e }, 'formular attachment download error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/formulare-oficiale/:id/attachments/:attId — soft-delete
router.delete('/:id/attachments/:attId', requireAuth, csrfMiddleware, async (req, res) => {
  try {
    const { orgId } = req.actor;
    const { id, attId } = req.params;

    const { rows: fRows } = await pool.query(
      `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, orgId]
    );
    if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

    const { rowCount } = await pool.query(
      `UPDATE formular_attachments SET deleted_at = NOW()
        WHERE id=$1 AND formular_id=$2 AND deleted_at IS NULL`,
      [attId, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'attachment_not_found' });
    return res.json({ ok: true, deleted: true });
  } catch(e) {
    logger.error({ err: e }, 'formular attachment delete error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
