/**
 * server/routes/formulare-oficiale.mjs
 * REST CRUD pentru formulare_oficiale (Referat Necesitate, NF Investiții).
 * Mount: app.use('/api/formulare-oficiale', formulareOficialeRouter)
 */

import { Router, json as expressJson } from 'express';
import { requireAuth }                  from '../middleware/auth.mjs';
import { csrfMiddleware }               from '../middleware/csrf.mjs';
import { pool }                         from '../db/index.mjs';
import { logger }                       from '../middleware/logger.mjs';
import { generateNfInvestPdf }          from '../services/formulare-oficiale/nf-invest-pdf.mjs';

const router = Router();
const _json  = expressJson({ limit: '2mb' });

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
router.post('/', requireAuth, csrfMiddleware, _json, async (req, res) => {
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

// ── POST /api/formulare-oficiale/:id/generate-pdf ────────────────────────────
router.post('/:id/generate-pdf', requireAuth, csrfMiddleware, async (req, res) => {
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
    } else {
      return res.status(400).json({ error: 'Generare PDF nu este suportată pentru acest tip.' });
    }

    await pool.query(`
      UPDATE formulare_oficiale
         SET pdf_generated_at = NOW()
       WHERE id = $1
    `, [id]);

    const fileName = `NF-Invest-${formular.title.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    return res.send(pdfBuf);
  } catch (e) {
    logger.error({ err: e }, 'formulare-oficiale generate-pdf error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});

export default router;
