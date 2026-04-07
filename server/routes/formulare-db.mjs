/**
 * DocFlowAI — server/routes/formulare-db.mjs
 *
 * CRUD + workflow pentru:
 *   - Document de Fundamentare (DF) — formulare_df
 *   - Ordonanțare de Plată (ORD)   — formulare_ord
 *   - Capturi de ecran              — formulare_capturi
 *
 * Workflow comun P1 → P2 → P1:
 *   draft → pending_p2 → completed
 *   (dacă P1 modifică după completed → draft, version++)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { logger } from '../middleware/logger.mjs';
import { pool } from '../db/index.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

// ── helpers ───────────────────────────────────────────────────────────────────

function requireDb(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return true; }
  return false;
}

/** Trimite notificare in-app corect (user_email + data JSONB) */
async function sendNotif(userId, type, title, message, data) {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!rows.length) return;
    await pool.query(
      `INSERT INTO notifications (user_email, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].email.toLowerCase(), type, title, message, JSON.stringify(data)]
    );
  } catch (_) { /* non-fatal */ }
}

/** Câmpuri DF sectiunea A (P1) */
const DF_P1_FIELDS = [
  'cif','den_inst_pb','subtitlu_df','nr_unic_inreg','revizuirea','data_revizuirii',
  'compartiment_specialitate','obiect_fd_reviz_scurt','obiect_fd_reviz_lung',
  'ckbx_stab_tin_cont','ckbx_ramane_suma','ramane_suma','rows_val',
  'ckbx_fara_ang_emis_ancrt','ckbx_cu_ang_emis_ancrt','ckbx_sting_ang_in_ancrt',
  'ckbx_fara_plati_ang_in_ancrt','ckbx_cu_plati_ang_in_mmani',
  'ckbx_ang_leg_emise_ct_an_urm','rows_plati',
];

/** Câmpuri DF sectiunea B (P2) */
const DF_P2_FIELDS = [
  'ckbx_secta_inreg_ctrl_ang','ckbx_fara_inreg_ctrl_ang','sum_fara_inreg_ctrl_crdbug',
  'ckbx_interzis_emit_ang','ckbx_interzis_intrucat','intrucat','rows_ctrl',
];

/** Câmpuri ORD P1 */
const ORD_P1_FIELDS = [
  'cif','den_inst_pb','nr_ordonant_pl','data_ordont_pl',
  'nr_unic_inreg','beneficiar','documente_justificative',
  'iban_beneficiar','cif_beneficiar','banca_beneficiar',
  'inf_pv_plata','inf_pv_plata1','rows',
];

/** Câmpuri ORD P2 (actualizare rânduri cu receptii/plati/receptii_neplatite) */
const ORD_P2_FIELDS = ['rows'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

function buildUpdate(data, fields, startIdx = 1) {
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (!(f in data)) continue;
    vals.push(typeof data[f] === 'object' ? JSON.stringify(data[f]) : data[f]);
    sets.push(`${f}=$${startIdx + vals.length - 1}`);
  }
  return { sets, vals };
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT DE FUNDAMENTARE (DF)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/formulare-df — lista documentelor pentru utilizatorul curent
router.get('/api/formulare-df', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        fd.id, fd.version, fd.status, fd.nr_unic_inreg, fd.subtitlu_df,
        fd.created_at, fd.updated_at, fd.submitted_at, fd.completed_at,
        fd.flow_id,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        CASE WHEN fd.flow_id IS NOT NULL AND f.data->>'status' = 'completed'
             THEN true ELSE false END AS aprobat
      FROM formulare_df fd
      JOIN users p1 ON p1.id = fd.created_by
      LEFT JOIN users p2 ON p2.id = fd.assigned_to
      LEFT JOIN flows f  ON f.id = fd.flow_id
      WHERE fd.org_id = $1
        AND fd.deleted_at IS NULL
        AND (fd.created_by = $2 OR fd.assigned_to = $2)
      ORDER BY fd.updated_at DESC
    `, [actor.orgId, actor.userId]);
    res.json({ ok: true, documents: rows });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-df/aprobate — lista DF aprobate (pentru dropdown ORD)
router.get('/api/formulare-df/aprobate', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        fd.id, fd.nr_unic_inreg, fd.subtitlu_df, fd.data_revizuirii,
        fd.rows_ctrl
      FROM formulare_df fd
      JOIN flows f ON f.id = fd.flow_id
      WHERE fd.org_id = $1
        AND fd.deleted_at IS NULL
        AND fd.flow_id IS NOT NULL
        AND f.data->>'status' = 'completed'
      ORDER BY fd.updated_at DESC
    `, [actor.orgId]);
    res.json({ ok: true, documents: rows });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df aprobate error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-df/:id — detaliu document
router.get('/api/formulare-df/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT fd.*,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        CASE WHEN fd.flow_id IS NOT NULL AND f.data->>'status' = 'completed'
             THEN true ELSE false END AS aprobat
      FROM formulare_df fd
      JOIN users p1 ON p1.id = fd.created_by
      LEFT JOIN users p2 ON p2.id = fd.assigned_to
      LEFT JOIN flows f  ON f.id = fd.flow_id
      WHERE fd.id = $1 AND fd.org_id = $2 AND fd.deleted_at IS NULL
    `, [req.params.id, actor.orgId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (doc.created_by !== actor.userId && doc.assigned_to !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-df — creare draft (P1)
router.post('/api/formulare-df', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const data = pick(req.body || {}, DF_P1_FIELDS);
    const { sets, vals } = buildUpdate(data, DF_P1_FIELDS, 3);
    const cols = ['org_id', 'created_by', ...Object.keys(data)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const allVals = [actor.orgId, actor.userId, ...vals];

    const q = `
      INSERT INTO formulare_df (${cols.join(', ')})
      VALUES (${placeholders})
      RETURNING *
    `;
    const { rows } = await pool.query(q, allVals);
    logger.info({ id: rows[0].id, actor: actor.email }, 'formulare-df creat');
    res.json({ ok: true, document: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df create error');
    res.status(500).json({ error: 'server_error' });
  }
});

// PUT /api/formulare-df/:id — actualizare câmpuri P1 sau P2
router.put('/api/formulare-df/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];

    const isP1 = doc.created_by === actor.userId;
    const isP2 = doc.assigned_to === actor.userId;
    if (!isP1 && !isP2 && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });

    // P1 poate modifica doar în draft (sau resetează completed → draft cu version++)
    let extraSets = [];
    let extraVals = [];
    if (isP1 || actor.role === 'admin' || actor.role === 'org_admin') {
      if (doc.status === 'completed') {
        // P1 modifică după ce P2 a completat → reset + version++
        extraSets = ['status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL'];
        extraVals = ['draft', doc.version + 1];
      } else if (doc.status !== 'draft') {
        return res.status(409).json({ error: 'document_locked', status: doc.status });
      }
    }

    const allowedFields = isP2 && !isP1 ? DF_P2_FIELDS : [...DF_P1_FIELDS, ...DF_P2_FIELDS];
    const data = pick(req.body || {}, allowedFields);
    const { sets, vals } = buildUpdate(data, allowedFields, 1);

    // Asamblare query
    const allSets = [...sets];
    const allVals = [...vals];
    let pi = allVals.length + 1;
    for (let i = 0; i < extraSets.length; i++) {
      const s = extraSets[i].replace('$__', `$${pi}`);
      allSets.push(s);
      allVals.push(extraVals[i]);
      pi++;
    }
    allSets.push(`updated_at=NOW()`);
    allVals.push(req.params.id, actor.orgId);

    if (!allSets.filter(s => !s.startsWith('updated')).length && !extraSets.length)
      return res.status(400).json({ error: 'no_fields' });

    const { rows: updated } = await pool.query(`
      UPDATE formulare_df SET ${allSets.join(', ')}
      WHERE id=$${allVals.length - 1} AND org_id=$${allVals.length}
      RETURNING *
    `, allVals);
    res.json({ ok: true, document: updated[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df update error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-df/:id/submit — P1 trimite la P2
router.post('/api/formulare-df/:id/submit', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { assigned_to } = req.body || {};
    if (!assigned_to) return res.status(400).json({ error: 'assigned_to obligatoriu' });

    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    if (doc.created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'draft')
      return res.status(409).json({ error: 'document_not_draft', status: doc.status });

    // Verifică că P2 e din același org
    const { rows: p2rows } = await pool.query(
      'SELECT id, email, nume FROM users WHERE id=$1 AND org_id=$2', [assigned_to, actor.orgId]
    );
    if (!p2rows.length) return res.status(400).json({ error: 'utilizator_invalid' });
    const p2 = p2rows[0];

    const { rows: updated } = await pool.query(`
      UPDATE formulare_df
      SET status='pending_p2', assigned_to=$1, submitted_at=NOW(), updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [assigned_to, req.params.id, actor.orgId]);

    await sendNotif(assigned_to, 'formulare_df_p2',
      'Document de Fundamentare — completare solicitată',
      `${actor.nume || actor.email} vă solicită completarea Secțiunii B din DF "${doc.nr_unic_inreg || 'fără număr'}"`,
      { form_type: 'df', form_id: req.params.id });

    logger.info({ id: req.params.id, p2: p2.email, actor: actor.email }, 'formulare-df trimis la P2');
    res.json({ ok: true, document: updated[0], assigned_to: p2 });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df submit error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-df/:id/complete — P2 finalizează sectiunea B
router.post('/api/formulare-df/:id/complete', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    if (doc.assigned_to !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'pending_p2')
      return res.status(409).json({ error: 'status_invalid', status: doc.status });

    const data = pick(req.body || {}, DF_P2_FIELDS);
    const { sets, vals } = buildUpdate(data, DF_P2_FIELDS, 1);
    sets.push(`status='completed'`, `completed_at=NOW()`, `updated_at=NOW()`);
    vals.push(req.params.id, actor.orgId);

    const { rows: updated } = await pool.query(`
      UPDATE formulare_df SET ${sets.join(', ')}
      WHERE id=$${vals.length - 1} AND org_id=$${vals.length}
      RETURNING *
    `, vals);

    await sendNotif(doc.created_by, 'formulare_df_completed',
      'Document de Fundamentare — completat de P2',
      `${actor.nume || actor.email} a completat Secțiunea B din DF "${doc.nr_unic_inreg || 'fără număr'}"`,
      { form_type: 'df', form_id: req.params.id });

    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-df completat de P2');
    res.json({ ok: true, document: updated[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df complete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-df/:id/link-flow — P1 leagă documentul de fluxul de semnare
router.post('/api/formulare-df/:id/link-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flow_id } = req.body || {};
    if (!flow_id) return res.status(400).json({ error: 'flow_id obligatoriu' });

    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    if (doc.created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'completed')
      return res.status(409).json({ error: 'document_not_completed' });

    await pool.query(
      'UPDATE formulare_df SET flow_id=$1, updated_at=NOW() WHERE id=$2 AND org_id=$3',
      [flow_id, req.params.id, actor.orgId]
    );
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df link-flow error');
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/formulare-df/:id — soft delete (doar P1, doar din draft)
router.delete('/api/formulare-df/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT created_by, status FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (rows[0].status !== 'draft')
      return res.status(409).json({ error: 'only_draft_deletable' });
    await pool.query(
      'UPDATE formulare_df SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDONANȚARE DE PLATĂ (ORD)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/formulare-ord — lista documentelor
router.get('/api/formulare-ord', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        fo.id, fo.version, fo.status, fo.nr_ordonant_pl, fo.nr_unic_inreg,
        fo.beneficiar, fo.created_at, fo.updated_at, fo.submitted_at, fo.completed_at,
        fo.flow_id, fo.df_id,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        fd.nr_unic_inreg AS df_nr
      FROM formulare_ord fo
      JOIN users p1 ON p1.id = fo.created_by
      LEFT JOIN users p2 ON p2.id = fo.assigned_to
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      WHERE fo.org_id = $1
        AND fo.deleted_at IS NULL
        AND (fo.created_by = $2 OR fo.assigned_to = $2)
      ORDER BY fo.updated_at DESC
    `, [actor.orgId, actor.userId]);
    res.json({ ok: true, documents: rows });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-ord/:id — detaliu document
router.get('/api/formulare-ord/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT fo.*,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        fd.nr_unic_inreg AS df_nr, fd.rows_ctrl AS df_rows_ctrl
      FROM formulare_ord fo
      JOIN users p1 ON p1.id = fo.created_by
      LEFT JOIN users p2 ON p2.id = fo.assigned_to
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      WHERE fo.id = $1 AND fo.org_id = $2 AND fo.deleted_at IS NULL
    `, [req.params.id, actor.orgId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (doc.created_by !== actor.userId && doc.assigned_to !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-ord — creare draft (P1)
router.post('/api/formulare-ord', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const body = req.body || {};
    const data = pick(body, ORD_P1_FIELDS);
    const cols = ['org_id', 'created_by'];
    const vals = [actor.orgId, actor.userId];

    if (body.df_id) { cols.push('df_id'); vals.push(body.df_id); }

    for (const f of ORD_P1_FIELDS) {
      if (!(f in data)) continue;
      cols.push(f);
      vals.push(typeof data[f] === 'object' ? JSON.stringify(data[f]) : data[f]);
    }

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO formulare_ord (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals
    );
    logger.info({ id: rows[0].id, actor: actor.email }, 'formulare-ord creat');
    res.json({ ok: true, document: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord create error');
    res.status(500).json({ error: 'server_error' });
  }
});

// PUT /api/formulare-ord/:id — actualizare (P1 sau P2)
router.put('/api/formulare-ord/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];

    const isP1 = doc.created_by === actor.userId;
    const isP2 = doc.assigned_to === actor.userId;
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    if (!isP1 && !isP2 && !isAdmin) return res.status(403).json({ error: 'forbidden' });

    const extraSets = [];
    const extraVals = [];
    if ((isP1 || isAdmin) && doc.status === 'completed') {
      extraSets.push('status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL');
      extraVals.push('draft', doc.version + 1);
    } else if (isP1 && doc.status !== 'draft') {
      return res.status(409).json({ error: 'document_locked', status: doc.status });
    }

    const allowedFields = isP2 && !isP1 && !isAdmin ? ORD_P2_FIELDS : [...ORD_P1_FIELDS];
    const data = pick(req.body || {}, allowedFields);
    const { sets, vals } = buildUpdate(data, allowedFields, 1);

    const allSets = [...sets];
    const allVals = [...vals];
    let pi = allVals.length + 1;
    for (let i = 0; i < extraSets.length; i++) {
      allSets.push(extraSets[i].replace('$__', `$${pi}`));
      allVals.push(extraVals[i]);
      pi++;
    }
    allSets.push(`updated_at=NOW()`);
    allVals.push(req.params.id, actor.orgId);

    const { rows: updated } = await pool.query(`
      UPDATE formulare_ord SET ${allSets.join(', ')}
      WHERE id=$${allVals.length - 1} AND org_id=$${allVals.length}
      RETURNING *
    `, allVals);
    res.json({ ok: true, document: updated[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord update error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-ord/:id/submit — P1 trimite la P2
router.post('/api/formulare-ord/:id/submit', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { assigned_to } = req.body || {};
    if (!assigned_to) return res.status(400).json({ error: 'assigned_to obligatoriu' });

    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    if (doc.created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'draft')
      return res.status(409).json({ error: 'document_not_draft', status: doc.status });

    const { rows: p2rows } = await pool.query(
      'SELECT id, email, nume FROM users WHERE id=$1 AND org_id=$2', [assigned_to, actor.orgId]
    );
    if (!p2rows.length) return res.status(400).json({ error: 'utilizator_invalid' });
    const p2 = p2rows[0];

    const { rows: updated } = await pool.query(`
      UPDATE formulare_ord
      SET status='pending_p2', assigned_to=$1, submitted_at=NOW(), updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [assigned_to, req.params.id, actor.orgId]);

    await sendNotif(assigned_to, 'formulare_ord_p2',
      'Ordonanțare de Plată — completare solicitată',
      `${actor.nume || actor.email} vă solicită completarea ORD "${doc.nr_ordonant_pl || 'fără număr'}"`,
      { form_type: 'ord', form_id: req.params.id });

    logger.info({ id: req.params.id, p2: p2.email, actor: actor.email }, 'formulare-ord trimis la P2');
    res.json({ ok: true, document: updated[0], assigned_to: p2 });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord submit error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-ord/:id/complete — P2 finalizează
router.post('/api/formulare-ord/:id/complete', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    if (doc.assigned_to !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'pending_p2')
      return res.status(409).json({ error: 'status_invalid', status: doc.status });

    const data = pick(req.body || {}, ORD_P2_FIELDS);
    const { sets, vals } = buildUpdate(data, ORD_P2_FIELDS, 1);
    sets.push(`status='completed'`, `completed_at=NOW()`, `updated_at=NOW()`);
    vals.push(req.params.id, actor.orgId);

    const { rows: updated } = await pool.query(`
      UPDATE formulare_ord SET ${sets.join(', ')}
      WHERE id=$${vals.length - 1} AND org_id=$${vals.length}
      RETURNING *
    `, vals);

    await sendNotif(doc.created_by, 'formulare_ord_completed',
      'Ordonanțare de Plată — completată de P2',
      `${actor.nume || actor.email} a completat ORD "${doc.nr_ordonant_pl || 'fără număr'}"`,
      { form_type: 'ord', form_id: req.params.id });

    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-ord completat de P2');
    res.json({ ok: true, document: updated[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord complete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-ord/:id/link-flow — leagă de fluxul de semnare
router.post('/api/formulare-ord/:id/link-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flow_id } = req.body || {};
    if (!flow_id) return res.status(400).json({ error: 'flow_id obligatoriu' });

    const { rows: existing } = await pool.query(
      'SELECT created_by, status FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    if (doc.created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'completed')
      return res.status(409).json({ error: 'document_not_completed' });

    await pool.query(
      'UPDATE formulare_ord SET flow_id=$1, updated_at=NOW() WHERE id=$2 AND org_id=$3',
      [flow_id, req.params.id, actor.orgId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/formulare-ord/:id — soft delete
router.delete('/api/formulare-ord/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT created_by, status FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (rows[0].status !== 'draft')
      return res.status(409).json({ error: 'only_draft_deletable' });
    await pool.query(
      'UPDATE formulare_ord SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1', [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

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
  const assignedField = 'assigned_to';

  try {
    const { rows: existing } = await pool.query(
      `SELECT created_by, ${assignedField}, status FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    const canUpload = doc.created_by === actor.userId || doc[assignedField] === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canUpload) return res.status(403).json({ error: 'forbidden' });

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

    // Ștergem captura anterioară dacă există
    await pool.query(
      'DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2', [type, id]
    );

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, filename, mimetype, size_bytes, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data]);

    logger.info({ type, id, size: data.length, actor: actor.email }, 'formulare-captura upload');
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
      `SELECT created_by, assigned_to FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canView = doc.created_by === actor.userId || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canView) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await pool.query(
      'SELECT filename, mimetype, data FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 ORDER BY created_at DESC LIMIT 1',
      [type, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'no_captura' });
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
// UTILIZATORI DIN ORG (pentru selectorul P2)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/formulare/utilizatori-org', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!actor.orgId) return res.json({ ok: true, users: [] });
  try {
    const { rows } = await pool.query(
      `SELECT id, email, nume, functie, compartiment
       FROM users
       WHERE org_id=$1 AND id != $2
       ORDER BY COALESCE(nume, email) ASC`,
      [actor.orgId, actor.userId]
    );
    res.json({ ok: true, users: rows });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CENTRALIZARE — GET /api/formulare/list
// ─────────────────────────────────────────────────────────────────────────────
// Parametri query: tip=df|ord, page=1, limit=20, status=all|draft|...,
//   dateFrom=YYYY-MM-DD, dateTo=YYYY-MM-DD, compartiment=, initiator=
// Vizibilitate: user → propriile + P2; org_admin → tot org; admin → tot

router.get('/api/formulare/list', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  const tip  = req.query.tip === 'ord' ? 'ord' : 'df';
  const page = Math.max(1, parseInt(req.query.page)  || 1);
  const lim  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const status     = req.query.status     || 'all';
  const dateFrom   = req.query.dateFrom   || null;
  const dateTo     = req.query.dateTo     || null;
  const compartiment = req.query.compartiment || null;
  const initiator    = req.query.initiator    || null;

  const isAdmin    = actor.role === 'admin';
  const isOrgAdmin = actor.role === 'org_admin';

  // Aliasuri status: noile nume UI → valorile din DB
  const STATUS_ALIAS = { transmis_p2: 'pending_p2', completat: 'completed' };

  try {
    const params = [];
    const conds  = [];

    if (tip === 'df') {
      conds.push('fd.deleted_at IS NULL');
      if (!isAdmin) {
        conds.push(`fd.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgAdmin) {
          const u1 = params.push(actor.userId);
          const u2 = params.push(actor.userId);
          conds.push(`(fd.created_by=$${u1} OR fd.assigned_to=$${u2})`);
        }
      }
      if (status !== 'all') {
        const dbStatus = STATUS_ALIAS[status] || status;
        conds.push(`fd.status=$${params.push(dbStatus)}`);
      }
      if (dateFrom)     conds.push(`fd.created_at >= $${params.push(dateFrom)}`);
      if (dateTo)       conds.push(`fd.created_at < ($${params.push(dateTo)}::date + interval '1 day')`);
      if (compartiment) conds.push(`fd.compartiment_specialitate=$${params.push(compartiment)}`);
      if (initiator) {
        const pct = `%${initiator}%`;
        const i1 = params.push(pct), i2 = params.push(pct);
        conds.push(`(p1.email ILIKE $${i1} OR p1.nume ILIKE $${i2})`);
      }
      const limIdx = params.push(lim);
      const offIdx = params.push((page - 1) * lim);
      const where  = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(`
        SELECT
          fd.id, 'df' AS tip, fd.version, fd.status,
          fd.nr_unic_inreg   AS nr_document,
          fd.subtitlu_df     AS titlu,
          fd.compartiment_specialitate AS compartiment,
          fd.created_at, fd.updated_at, fd.flow_id,
          fd.created_by,  p1.nume AS initiator_nume, p1.email AS initiator_email,
          fd.assigned_to, p2.nume AS p2_nume,        p2.email AS p2_email,
          CASE WHEN fd.flow_id IS NOT NULL
                AND f.data->>'status' = 'completed'           THEN true  ELSE false END AS aprobat,
          CASE WHEN fd.flow_id IS NOT NULL
                AND f.data->>'status' IN ('refused','rejected') THEN true ELSE false END AS respins,
          COUNT(*) OVER() AS total_count
        FROM formulare_df fd
        JOIN  users p1 ON p1.id = fd.created_by
        LEFT JOIN users p2 ON p2.id = fd.assigned_to
        LEFT JOIN flows  f  ON f.id  = fd.flow_id
        ${where}
        ORDER BY fd.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}
      `, params);

      const total = rows.length ? parseInt(rows[0].total_count) : 0;
      return res.json({
        ok: true,
        documents: rows.map(({ total_count, ...r }) => r),
        total, page, limit: lim,
      });
    }

    // ── ORD ──────────────────────────────────────────────────────────────────
    conds.push('fo.deleted_at IS NULL');
    if (!isAdmin) {
      conds.push(`fo.org_id=$${params.push(actor.orgId)}`);
      if (!isOrgAdmin) {
        const u1 = params.push(actor.userId);
        const u2 = params.push(actor.userId);
        conds.push(`(fo.created_by=$${u1} OR fo.assigned_to=$${u2})`);
      }
    }
    if (status !== 'all') {
      const dbStatus = STATUS_ALIAS[status] || status;
      conds.push(`fo.status=$${params.push(dbStatus)}`);
    }
    if (dateFrom)     conds.push(`fo.created_at >= $${params.push(dateFrom)}`);
    if (dateTo)       conds.push(`fo.created_at < ($${params.push(dateTo)}::date + interval '1 day')`);
    if (compartiment) conds.push(`fd.compartiment_specialitate=$${params.push(compartiment)}`);
    if (initiator) {
      const pct = `%${initiator}%`;
      const i1 = params.push(pct), i2 = params.push(pct);
      conds.push(`(p1.email ILIKE $${i1} OR p1.nume ILIKE $${i2})`);
    }
    const limIdx = params.push(lim);
    const offIdx = params.push((page - 1) * lim);
    const where  = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT
        fo.id, 'ord' AS tip, fo.version, fo.status,
        fo.nr_ordonant_pl  AS nr_document,
        fo.beneficiar      AS titlu,
        fd.compartiment_specialitate AS compartiment,
        fo.created_at, fo.updated_at, fo.flow_id, fo.df_id,
        fo.created_by,  p1.nume AS initiator_nume, p1.email AS initiator_email,
        fo.assigned_to, p2.nume AS p2_nume,        p2.email AS p2_email,
        fd.nr_unic_inreg AS df_nr,
        CASE WHEN fo.flow_id IS NOT NULL
              AND f.data->>'status' = 'completed'             THEN true  ELSE false END AS aprobat,
        CASE WHEN fo.flow_id IS NOT NULL
              AND f.data->>'status' IN ('refused','rejected') THEN true  ELSE false END AS respins,
        COUNT(*) OVER() AS total_count
      FROM formulare_ord fo
      JOIN  users p1 ON p1.id = fo.created_by
      LEFT JOIN users p2 ON p2.id = fo.assigned_to
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows        f  ON f.id  = fo.flow_id
      ${where}
      ORDER BY fo.updated_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}
    `, params);

    const total = rows.length ? parseInt(rows[0].total_count) : 0;
    res.json({
      ok: true,
      documents: rows.map(({ total_count, ...r }) => r),
      total, page, limit: lim,
    });

  } catch (e) {
    logger.error({ err: e }, 'formulare list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ANULARE DF / ORD (P1 sau admin)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/formulare-df/:id/anuleaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT created_by, status FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (['aprobat', 'anulat'].includes(rows[0].status))
      return res.status(409).json({ error: 'cannot_cancel', status: rows[0].status });

    await pool.query(
      `UPDATE formulare_df SET status='anulat', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [req.params.id, actor.orgId]
    );
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-df anulat');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df anuleaza error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/api/formulare-ord/:id/anuleaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT created_by, status FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (['aprobat', 'anulat'].includes(rows[0].status))
      return res.status(409).json({ error: 'cannot_cancel', status: rows[0].status });

    await pool.query(
      `UPDATE formulare_ord SET status='anulat', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [req.params.id, actor.orgId]
    );
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-ord anulat');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord anuleaza error');
    res.status(500).json({ error: 'server_error' });
  }
});

export { router as formulareDbRouter };
