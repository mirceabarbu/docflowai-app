/**
 * DocFlowAI — server/routes/formulare/shared.mjs
 *
 * Rute care servesc AMBELE tipuri (DF + ORD) sau sunt cross-cutting:
 *   - capturi de ecran (formulare_capturi)
 *   - atașamente (formulare_atasamente)
 *   - utilizatori din org (selector P2)
 *   - beneficiari
 *   - listă centralizată DF + ORD
 *   - audit per formular (json/csv/pdf)
 * Rute mutate verbatim din formulare-db.mjs (split mecanic Etapa 2).
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { logger } from '../../middleware/logger.mjs';
import { pool } from '../../db/index.mjs';
import { listFormularAudit } from '../../db/queries/formulare-audit.mjs';
import { isAdminOrOrgAdmin } from '../admin/_helpers.mjs';
import { loadActorComp, canEditFormular, canViewFormular } from '../../services/authz-formular.mjs';
import { requireDb } from './_helpers.mjs';

let PDFLibFormular = null;
try { PDFLibFormular = await import('pdf-lib'); } catch (e) { logger.warn('⚠️ pdf-lib indisponibil pentru export audit formular PDF'); }

const router = Router();
const _csrf  = csrfMiddleware;

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURI DE ECRAN (DF și ORD)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/formulare-capturi/:type/:id — upload captură (max 5MB)
router.post('/api/formulare-capturi/:type/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  const table = type === 'df' ? 'formulare_df' : 'formulare_ord';

  try {
    const { rows: existing } = await pool.query(
      `SELECT created_by, assigned_to, status FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    // v3.9.554 (B1): authz centralizat — include drepturile prin compartiment (comp/p2_comp),
    // pe care verificarea veche creator/assigned/admin le refuza cu 403.
    const actorComp = await loadActorComp(pool, actor.userId);
    const authz = await canEditFormular(pool, actor, doc, actorComp);
    if (!authz.allowed) return res.status(403).json({ error: 'forbidden' });

    // Citim body raw (imagine)
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise((resolve, reject) => {
      req.on('end', resolve);
      req.on('error', reject);
    });
    const data = Buffer.concat(chunks);
    if (data.length === 0) return res.status(400).json({ error: 'fisier_gol' });
    if (data.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'fisier_prea_mare' });

    const mimetype = req.headers['content-type'] || 'image/png';
    const filename = req.headers['x-filename'] || `captura_${Date.now()}.png`;

    // v3.9.499: ștergem doar captura din același slot (default 1 backward compat)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    await pool.query(
      'DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3',
      [type, id, slot]
    );

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mimetype, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data, slot]);

    logger.info({ type, id, slot, size: data.length, actor: actor.email }, 'formulare-captura upload');
    res.json({ ok: true, captura: inserted[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-captura upload error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-capturi/:type/:id — descărcare captură
router.get('/api/formulare-capturi/:type/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to, flow_id FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    // v3.9.554 (B1): authz centralizat — view include comp/p2_comp + semnatari în flux
    const actorComp = await loadActorComp(pool, actor.userId);
    const view = await canViewFormular(pool, actor, doc, actorComp);
    if (!view.allowed) return res.status(403).json({ error: 'forbidden' });

    // v3.9.499: filtrare pe slot (default 1 backward compat pentru DF + clienti vechi)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    const { rows } = await pool.query(
      'SELECT filename, mimetype, data FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3 ORDER BY created_at DESC LIMIT 1',
      [type, id, slot]
    );
    if (!rows.length) return res.status(404).json({ error: 'no_captura', slot });
    const { filename, mimetype, data } = rows[0];
    res.setHeader('Content-Type', mimetype || 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(data);
  } catch (e) {
    logger.error({ err: e }, 'formulare-captura get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v3.9.500: ATAȘAMENTE (DF și ORD) — pattern simetric cu formulare_capturi
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/formulare-atasamente/:type/:id — upload atașament (max 10MB)
router.post('/api/formulare-atasamente/:type/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  const table = type === 'df' ? 'formulare_df' : 'formulare_ord';

  try {
    const { rows: existing } = await pool.query(
      `SELECT created_by, assigned_to, status FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    // v3.9.554 (B1): authz centralizat — include drepturile prin compartiment (comp/p2_comp)
    const actorComp = await loadActorComp(pool, actor.userId);
    const authz = await canEditFormular(pool, actor, doc, actorComp);
    if (!authz.allowed) return res.status(403).json({ error: 'forbidden' });

    // v3.9.501: slot pentru a permite multiple seturi per formular (DF n-fdad vs n-adata)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;

    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise((resolve, reject) => {
      req.on('end', resolve);
      req.on('error', reject);
    });
    const data = Buffer.concat(chunks);
    if (data.length === 0) return res.status(400).json({ error: 'fisier_gol' });
    if (data.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'fisier_prea_mare' });

    const mime_type = req.headers['content-type'] || 'application/octet-stream';
    let filename = req.headers['x-filename'] || '';
    try { filename = decodeURIComponent(filename); } catch { /* valoare ne-encodată/legacy — lasă crud */ }
    if (!filename) filename = `atasament_${Date.now()}`;

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mime_type, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mime_type, data.length, data, slot]);

    logger.info({ type, id, slot, attId: inserted[0].id, size: data.length, actor: actor.email }, 'formulare-atasament upload');
    res.json({ ok: true, atasament: inserted[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasament upload error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-atasamente/:type/:id — listă atașamente (fără data)
router.get('/api/formulare-atasamente/:type/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to, flow_id FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    // v3.9.554 (B1): authz centralizat — view include comp/p2_comp + semnatari în flux
    const actorComp = await loadActorComp(pool, actor.userId);
    const view = await canViewFormular(pool, actor, doc, actorComp);
    if (!view.allowed) return res.status(403).json({ error: 'forbidden' });

    // v3.9.501: filtrare per slot (default 1 backward compat)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;

    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, slot, created_at
       FROM formulare_atasamente
       WHERE form_type=$1 AND form_id=$2 AND slot=$3 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [type, id, slot]
    );
    res.json({ ok: true, atasamente: rows });
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasamente list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-atasamente/:type/:id/:attId — descărcare atașament
router.get('/api/formulare-atasamente/:type/:id/:attId', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id, attId } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to, flow_id FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    // v3.9.554 (B1): authz centralizat — view include comp/p2_comp + semnatari în flux
    const actorComp = await loadActorComp(pool, actor.userId);
    const view = await canViewFormular(pool, actor, doc, actorComp);
    if (!view.allowed) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await pool.query(
      `SELECT filename, mime_type, data FROM formulare_atasamente
       WHERE id=$1 AND form_type=$2 AND form_id=$3 AND deleted_at IS NULL`,
      [attId, type, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const att = rows[0];
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
    res.send(att.data);
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasament get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/formulare-atasamente/:type/:id/:attId — ștergere soft
router.delete('/api/formulare-atasamente/:type/:id/:attId', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id, attId } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to, status FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    // v3.9.554 (B1): authz centralizat — include drepturile prin compartiment (comp/p2_comp)
    const actorComp = await loadActorComp(pool, actor.userId);
    const authz = await canEditFormular(pool, actor, doc, actorComp);
    if (!authz.allowed) return res.status(403).json({ error: 'forbidden' });
    if (['completed','aprobat'].includes(doc.status) && !['admin','org_admin'].includes(actor.role)) {
      return res.status(409).json({ error: 'document_locked', status: doc.status });
    }

    const { rowCount } = await pool.query(
      `UPDATE formulare_atasamente SET deleted_at=NOW()
       WHERE id=$1 AND form_type=$2 AND form_id=$3 AND deleted_at IS NULL`,
      [attId, type, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    logger.info({ type, id, attId, actor: actor.email }, 'formulare-atasament soft delete');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasament delete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILIZATORI DIN ORG (pentru selectorul P2)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/formulare/utilizatori-org', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!actor.orgId) return res.json({ ok: true, users: [], actor_compartiment: '' });
  try {
    const { rows: actorRows } = await pool.query(
      'SELECT compartiment FROM users WHERE id=$1',
      [actor.userId]
    );
    const actorComp = (actorRows[0]?.compartiment || '').trim();
    const { rows } = await pool.query(
      `SELECT id, email, nume, functie, compartiment
       FROM users
       WHERE org_id=$1 AND id != $2
       ORDER BY
         CASE WHEN TRIM(COALESCE(compartiment,'')) = $3 AND $3 <> '' THEN 0 ELSE 1 END,
         COALESCE(nume, email) ASC`,
      [actor.orgId, actor.userId, actorComp]
    );
    res.json({ ok: true, users: rows, actor_compartiment: actorComp });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/beneficiari — caută beneficiari din org ─────────────────────────
router.get('/api/beneficiari', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const q = (req.query.q || '').trim();
  try {
    const like = `%${q}%`;
    const { rows } = await pool.query(
      `SELECT id, denumire, cif, iban, banca
       FROM beneficiari
       WHERE org_id=$1 AND (denumire ILIKE $2 OR cif ILIKE $2 OR iban ILIKE $2)
       ORDER BY updated_at DESC LIMIT 20`,
      [actor.orgId, like]
    );
    res.json({ ok: true, beneficiari: rows });
  } catch (e) {
    logger.error({ err: e }, 'beneficiari search error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/beneficiari — salvează sau actualizează beneficiar ──────────────
router.post('/api/beneficiari', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { denumire, cif, iban, banca } = req.body || {};
  if (!denumire) return res.status(400).json({ error: 'denumire_required' });
  try {
    // Dacă există deja cu același CIF în org, returnăm cel existent
    if (cif) {
      const { rows: existing } = await pool.query(
        'SELECT * FROM beneficiari WHERE org_id=$1 AND cif=$2 LIMIT 1',
        [actor.orgId, cif]
      );
      if (existing.length) {
        // Actualizăm datele dacă s-au schimbat
        await pool.query(
          `UPDATE beneficiari SET denumire=$1, iban=$2, banca=$3, updated_at=NOW()
           WHERE id=$4`,
          [denumire, iban || existing[0].iban, banca || existing[0].banca, existing[0].id]
        );
        return res.json({ ok: true, id: existing[0].id, existing: true });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO beneficiari (org_id, denumire, cif, iban, banca)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [actor.orgId, denumire, cif || null, iban || null, banca || null]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    logger.error({ err: e }, 'beneficiari save error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/formulare/list — centralizare DF + ORD ──────────────────────────
router.get('/api/formulare/list', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;

  const isAdmin    = actor.role === 'admin';
  const isOrgAdmin = actor.role === 'org_admin';

  const { type = 'df', status, from, to, comp, init, p2, nr, page = '1', limit = '20' } = req.query;
  const lim  = Math.min(parseInt(limit) || 20, 100);
  const pg   = Math.max(parseInt(page)  || 1,  1);

  try {
    if (type === 'df') {
      // ── Documente de Fundamentare ────────────────────────────────────────
      const params = [];
      const conds  = ['fd.deleted_at IS NULL'];

      if (!isAdmin) {
        conds.push(`fd.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgAdmin) {
          const actorCompRes = await pool.query(
            'SELECT compartiment FROM users WHERE id=$1',
            [actor.userId]
          );
          const actorComp = (actorCompRes.rows[0]?.compartiment || '').trim();
          const u1 = params.push(actor.userId);
          const u2 = params.push(actor.userId);
          if (actorComp === '') {
            conds.push(`(fd.created_by=$${u1} OR fd.assigned_to=$${u2})`);
          } else {
            const c1 = params.push(actorComp);
            conds.push(`(
              fd.created_by=$${u1}
              OR fd.assigned_to=$${u2}
              OR EXISTS (
                SELECT 1 FROM users uc
                WHERE uc.id = fd.created_by
                  AND TRIM(uc.compartiment) = $${c1}
                  AND TRIM(uc.compartiment) <> ''
              )
            )`);
          }
        }
      }

      if (status && status !== 'all') {
        if (status === 'aprobat') {
          conds.push(`fd.status='completed' AND f.data->>'status'='completed' AND fd.flow_id IS NOT NULL`);
        } else if (status === 'respins') {
          conds.push(`fd.flow_id IS NOT NULL AND f.data->>'status' IN ('refused','rejected')`);
        } else {
          conds.push(`fd.status=$${params.push(status)}`);
        }
      }
      if (from) conds.push(`fd.created_at >= $${params.push(from)}`);
      if (to)   conds.push(`fd.created_at <  $${params.push(to + 'T23:59:59')}`);
      if (comp) conds.push(`u1.compartiment=$${params.push(comp)}`);
      if (init) {
        const like = `%${init}%`;
        conds.push(`(u1.email ILIKE $${params.push(like)} OR u1.nume ILIKE $${params.push(like)})`);
      }
      if (p2) {
        const likeP2 = `%${p2}%`;
        conds.push(`(u2.email ILIKE $${params.push(likeP2)} OR u2.nume ILIKE $${params.push(likeP2)})`);
      }
      if (nr) {
        conds.push(`fd.nr_unic_inreg ILIKE $${params.push('%' + nr + '%')}`);
      }

      const where = `WHERE ${conds.join(' AND ')}`;
      const limIdx = params.push(lim);
      const offIdx = params.push((pg - 1) * lim);

      const sql = `
        SELECT
          fd.id, fd.status, fd.created_at, fd.updated_at,
          fd.nr_unic_inreg AS nr,
          fd.subtitlu_df AS titlu,
          fd.created_by,
          fd.flow_id,
          COALESCE(fd.revizie_nr, 0) AS revizie_nr,
          COALESCE(fd.este_revizie, FALSE) AS este_revizie,
          EXISTS(
            SELECT 1 FROM formulare_df fd2
            WHERE fd2.nr_unic_inreg = fd.nr_unic_inreg
              AND fd2.org_id = fd.org_id
              AND fd2.deleted_at IS NULL
              AND fd2.revizie_nr > fd.revizie_nr
          ) AS has_newer_revision,
          CASE WHEN fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
               THEN true ELSE false END AS aprobat,
          COALESCE(u1.nume, u1.email) AS initiator,
          u1.compartiment AS initiator_comp,
          COALESCE(u2.nume, u2.email) AS p2,
          COALESCE(u3.nume, u3.email) AS updated_by_nume,
          (
            ${(isAdmin || isOrgAdmin) ? 'TRUE' : `fd.created_by = $${params.push(actor.userId)}`}
            AND fd.flow_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM formulare_ord fo_chk
              WHERE fo_chk.df_id = fd.id AND fo_chk.deleted_at IS NULL
            )
          ) AS can_delete,
          (fd.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_df fd
        LEFT JOIN users u1 ON u1.id = fd.created_by
        LEFT JOIN users u2 ON u2.id = fd.assigned_to
        LEFT JOIN users u3 ON u3.id = fd.updated_by
        LEFT JOIN flows f  ON f.id::text = fd.flow_id
        ${where}
        ORDER BY fd.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      const total = rows.length ? parseInt(rows[0].total) : 0;
      res.json({ ok: true, rows: rows.map(r => { const { total: _, ...rest } = r; return rest; }), total });

    } else {
      // ── Ordonanțări de Plată ─────────────────────────────────────────────
      const params = [];
      const conds  = ['fo.deleted_at IS NULL'];

      if (!isAdmin) {
        conds.push(`fo.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgAdmin) {
          const actorCompRes = await pool.query(
            'SELECT compartiment FROM users WHERE id=$1',
            [actor.userId]
          );
          const actorComp = (actorCompRes.rows[0]?.compartiment || '').trim();
          const u1 = params.push(actor.userId);
          const u2 = params.push(actor.userId);
          if (actorComp === '') {
            conds.push(`(fo.created_by=$${u1} OR fo.assigned_to=$${u2})`);
          } else {
            const c1 = params.push(actorComp);
            conds.push(`(
              fo.created_by=$${u1}
              OR fo.assigned_to=$${u2}
              OR EXISTS (
                SELECT 1 FROM users uc
                WHERE uc.id = fo.created_by
                  AND TRIM(uc.compartiment) = $${c1}
                  AND TRIM(uc.compartiment) <> ''
              )
            )`);
          }
        }
      }

      if (status && status !== 'all') {
        if (status === 'aprobat') {
          conds.push(`fo.status='completed' AND f.data->>'status'='completed' AND fo.flow_id IS NOT NULL`);
        } else if (status === 'respins') {
          conds.push(`fo.flow_id IS NOT NULL AND f.data->>'status' IN ('refused','rejected')`);
        } else {
          conds.push(`fo.status=$${params.push(status)}`);
        }
      }
      if (from) conds.push(`fo.created_at >= $${params.push(from)}`);
      if (to)   conds.push(`fo.created_at <  $${params.push(to + 'T23:59:59')}`);
      if (comp) conds.push(`u1.compartiment=$${params.push(comp)}`);
      if (init) {
        const like = `%${init}%`;
        conds.push(`(u1.email ILIKE $${params.push(like)} OR u1.nume ILIKE $${params.push(like)})`);
      }
      if (p2) {
        const likeP2 = `%${p2}%`;
        conds.push(`(u2.email ILIKE $${params.push(likeP2)} OR u2.nume ILIKE $${params.push(likeP2)})`);
      }
      if (nr) {
        conds.push(`fo.nr_ordonant_pl ILIKE $${params.push('%' + nr + '%')}`);
      }

      const where = `WHERE ${conds.join(' AND ')}`;
      const limIdx = params.push(lim);
      const offIdx = params.push((pg - 1) * lim);

      const sql = `
        SELECT
          fo.id, fo.status, fo.created_at, fo.updated_at,
          fo.nr_ordonant_pl AS nr,
          fo.beneficiar AS titlu,
          fo.created_by,
          fo.flow_id,
          CASE WHEN fo.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
               THEN true ELSE false END AS aprobat,
          COALESCE(u1.nume, u1.email) AS initiator,
          u1.compartiment AS initiator_comp,
          COALESCE(u2.nume, u2.email) AS p2,
          COALESCE(u3.nume, u3.email) AS updated_by_nume,
          (
            ${(isAdmin || isOrgAdmin) ? 'TRUE' : `fo.created_by = $${params.push(actor.userId)}`}
            AND fo.flow_id IS NULL
          ) AS can_delete,
          (fo.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_ord fo
        LEFT JOIN users u1 ON u1.id = fo.created_by
        LEFT JOIN users u2 ON u2.id = fo.assigned_to
        LEFT JOIN users u3 ON u3.id = fo.updated_by
        LEFT JOIN flows f  ON f.id::text = fo.flow_id
        ${where}
        ORDER BY fo.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      const total = rows.length ? parseInt(rows[0].total) : 0;
      res.json({ ok: true, rows: rows.map(r => { const { total: _, ...rest } = r; return rest; }), total });
    }
  } catch (e) {
    logger.error({ err: e }, 'formulare/list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT per formular — citire/export (admin / org_admin)
// GET /api/formulare-audit/:type/:id?format=json|csv|pdf
// ─────────────────────────────────────────────────────────────────────────────

// Etichete RO pentru event_type (folosite în timeline, CSV, PDF)
const FORMULAR_AUDIT_LABELS = {
  creat:         'CREAT',
  trimis_p2:     'TRIMIS LA RESPONSABIL CAB',
  completat:     'COMPLETAT DE RESPONSABIL CAB',
  legat_alop:    'LEGAT DE ALOP',
  returnat:      'RETURNAT',
  transmis_flux: 'TRANSMIS ÎN FLUX',
  revizuit:      'REVIZUIT',
  sters:         'ȘTERS',
};

router.get('/api/formulare-audit/:type/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });

  const type = String(req.params.type || '').toLowerCase();
  if (type !== 'df' && type !== 'ord') return res.status(400).json({ error: 'invalid_type' });
  const id = req.params.id;
  const format = String(req.query.format || 'json').toLowerCase();

  try {
    const table = type === 'ord' ? 'formulare_ord' : 'formulare_df';
    const nrCol = type === 'ord' ? 'nr_ordonant_pl' : 'nr_unic_inreg';
    const { rows: docRows } = await pool.query(
      `SELECT d.id, d.org_id, d.${nrCol} AS nr, d.den_inst_pb,
              COALESCE(NULLIF(TRIM(u.compartiment), ''), NULLIF(TRIM(d.compartiment_specialitate), '')) AS compartiment,
              d.status, d.created_at, d.updated_at, d.created_by,
              u.nume AS init_name, u.email AS init_email
         FROM ${table} d
         LEFT JOIN users u ON u.id = d.created_by
        WHERE d.id = $1`,
      [id]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];

    // Scoping org_admin: vede doar org-ul propriu
    if (actor.role === 'org_admin' && doc.org_id !== actor.orgId)
      return res.status(403).json({ error: 'forbidden' });

    const events = await listFormularAudit(type, id);

    const header = {
      type, id: doc.id, nr: doc.nr || null,
      den_inst_pb: doc.den_inst_pb || null,
      compartiment: doc.compartiment || null,
      status: doc.status, created_at: doc.created_at, updated_at: doc.updated_at,
      initiator: doc.init_name || doc.init_email || null,
      initiator_email: doc.init_email || null,
    };

    const fmtDate = iso => iso ? new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—';
    const evLabel = t => FORMULAR_AUDIT_LABELS[t] || (t || '').replace(/_/g, ' ').toUpperCase();
    const typeLabel = type === 'ord' ? 'Ordonanțare de Plată' : 'Document de Fundamentare';

    // ── CSV ──────────────────────────────────────────────────────────────────
    if (format === 'csv') {
      const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
      const lines = ['timestamp,event,actor,from,to,meta'];
      for (const e of events) {
        lines.push([
          q(fmtDate(e.created_at)), q(evLabel(e.event_type)), q(e.actor_name || e.actor_email || ''),
          q(e.from_status || ''), q(e.to_status || ''),
          q(e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : ''),
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${type}_${id}.csv"`);
      return res.send('﻿' + lines.join('\n'));
    }

    // ── PDF (mirror al patternului din admin/flows.mjs) ────────────────────────
    if (format === 'pdf') {
      if (!PDFLibFormular) return res.status(503).json({ error: 'pdf_lib_not_available' });
      const { PDFDocument, rgb, StandardFonts } = PDFLibFormular;
      const diacr = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
      const ro = t => String(t || '').split('').map(ch => diacr[ch] || ch).join('').replace(/[^\x00-\xFF]/g, '');
      const pdfDoc = await PDFDocument.create();
      const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;
      let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;
      const SECTION_GAP = 10;
      const newPage = () => { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
      const ensureSpace = needed => { if (y < MARGIN + needed) newPage(); };
      const drawText = (text, x, size, font, color) => {
        ensureSpace(size + 6);
        page.drawText(ro(text), { x, y, size, font: font || fontR, color: color || rgb(0.2,0.2,0.2), maxWidth: PAGE_W - x - MARGIN });
        y -= size + 6;
      };
      const drawLine = () => {
        ensureSpace(8);
        page.drawLine({ start:{x:MARGIN,y:y+4}, end:{x:PAGE_W-MARGIN,y:y+4}, thickness:0.5, color:rgb(0.75,0.75,0.75) });
        y -= 8;
      };
      // Header albastru
      page.drawRectangle({ x:0, y:PAGE_H-70, width:PAGE_W, height:70, color:rgb(0.1,0.1,0.25) });
      page.drawText('AUDIT FORMULAR', { x:MARGIN, y:PAGE_H-35, size:20, font:fontB, color:rgb(1,1,1) });
      page.drawText(ro(`DocFlowAI — ${typeLabel}`), { x:MARGIN, y:PAGE_H-52, size:9, font:fontR, color:rgb(0.7,0.8,1) });
      page.drawText(ro(`Generat: ${fmtDate(new Date().toISOString())}`), { x:PAGE_W-200, y:PAGE_H-35, size:9, font:fontR, color:rgb(0.7,0.8,1) });
      y = PAGE_H - 85;
      // Metadate document
      drawText('INFORMATII DOCUMENT', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      const infoRows = [
        ['Tip:', typeLabel],
        ['Numar:', header.nr || '—'],
        ['Institutie:', header.den_inst_pb || '—'],
        ['Compartiment:', header.compartiment || '—'],
        ['Initiator:', header.initiator ? `${header.initiator}${header.initiator_email ? ' <' + header.initiator_email + '>' : ''}` : '—'],
        ['Status:', header.status || '—'],
        ['Creat:', fmtDate(header.created_at)],
        ['Actualizat:', fmtDate(header.updated_at)],
      ];
      for (const [lbl, val] of infoRows) {
        ensureSpace(18);
        page.drawText(ro(lbl), { x:MARGIN, y, size:9, font:fontB, color:rgb(0.3,0.3,0.3) });
        page.drawText(ro(String(val || '—')), { x:MARGIN+100, y, size:9, font:fontR, color:rgb(0.15,0.15,0.15), maxWidth:PAGE_W-MARGIN-110 });
        y -= 16;
      }
      y -= SECTION_GAP;
      // Tabel evenimente (cronologic: cele mai vechi întâi în PDF)
      drawText(`JURNAL EVENIMENTE (${events.length})`, MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      const sorted = [...events].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      const EVENT_FONT_SIZE = 8;
      const COL_TS = MARGIN, COL_TYPE = MARGIN + 120, COL_DETAIL = MARGIN + 120 + 175;
      const DETAIL_MAX_W = PAGE_W - COL_DETAIL - MARGIN;
      for (const e of sorted) {
        ensureSpace(16);
        const transition = (e.from_status || e.to_status)
          ? `${e.from_status || '—'} -> ${e.to_status || '—'}` : '';
        const metaStr = e.meta && Object.keys(e.meta).length
          ? Object.entries(e.meta).map(([k, v]) => `${k}:${v}`).join(' ') : '';
        const detail = [e.actor_name ? `de:${e.actor_name}` : '', transition, metaStr].filter(Boolean).join('  ');
        page.drawText(ro(`[${fmtDate(e.created_at)}]`), { x:COL_TS, y, size:EVENT_FONT_SIZE, font:fontR, color:rgb(0.5,0.5,0.5) });
        page.drawText(ro(evLabel(e.event_type)), { x:COL_TYPE, y, size:EVENT_FONT_SIZE, font:fontB, color:rgb(0.2,0.2,0.5) });
        if (detail) page.drawText(ro(detail), { x:COL_DETAIL, y, size:EVENT_FONT_SIZE, font:fontR, color:rgb(0.4,0.4,0.4), maxWidth:DETAIL_MAX_W });
        y -= 14;
      }
      if (!sorted.length) drawText('(niciun eveniment inregistrat)', MARGIN, 8, fontR, rgb(0.5,0.5,0.5));

      const bytes = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${type}_${id}.pdf"`);
      return res.send(Buffer.from(bytes));
    }

    // ── JSON (default) ─────────────────────────────────────────────────────────
    return res.json({ document: header, events });
  } catch (e) {
    logger.error({ err: e, type, id }, 'formulare-audit export error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
