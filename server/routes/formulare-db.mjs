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
  'inf_pv_plata','inf_pv_plata1','rows','compartiment_specialitate',
  'img2',
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
    let orgFilter, params;
    if (actor.role === 'admin') {
      orgFilter = '';
      params = [];
    } else if (actor.role === 'org_admin') {
      orgFilter = 'AND fd.org_id = $1';
      params = [actor.orgId];
    } else {
      orgFilter = 'AND fd.org_id = $1 AND (fd.created_by = $2 OR fd.assigned_to = $2)';
      params = [actor.orgId, actor.userId];
    }
    const { rows } = await pool.query(`
      SELECT
        fd.id, fd.version, fd.status, fd.nr_unic_inreg, fd.subtitlu_df,
        fd.created_at, fd.updated_at, fd.submitted_at, fd.completed_at,
        fd.flow_id, fd.revizie_nr, fd.este_revizie,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        CASE WHEN fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat
      FROM formulare_df fd
      JOIN users p1 ON p1.id = fd.created_by
      LEFT JOIN users p2 ON p2.id = fd.assigned_to
      LEFT JOIN flows f  ON f.id = fd.flow_id
      WHERE fd.deleted_at IS NULL
        ${orgFilter}
      ORDER BY fd.updated_at DESC
    `, params);
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
        AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
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
    // Admin fără org_id nu are org_id → skip filtrul de org
    const isGlobalAdmin = actor.role === 'admin' && !actor.orgId;
    const orgCond = isGlobalAdmin ? '' : 'AND fd.org_id = $2';
    const params  = isGlobalAdmin ? [req.params.id] : [req.params.id, actor.orgId];
    const { rows } = await pool.query(`
      SELECT fd.*,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        CASE WHEN fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat,
        (SELECT a.id FROM alop_instances a
         WHERE a.df_id = fd.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_id,
        (SELECT a.titlu FROM alop_instances a
         WHERE a.df_id = fd.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_titlu,
        (SELECT a.valoare_totala FROM alop_instances a
         WHERE a.df_id = fd.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_valoare
      FROM formulare_df fd
      JOIN users p1 ON p1.id = fd.created_by
      LEFT JOIN users p2 ON p2.id = fd.assigned_to
      LEFT JOIN flows f  ON f.id = fd.flow_id
      WHERE fd.id = $1 ${orgCond} AND fd.deleted_at IS NULL
    `, params);
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
    if (data.nr_unic_inreg) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM formulare_df
         WHERE nr_unic_inreg = $1 AND org_id = $2 AND deleted_at IS NULL`,
        [data.nr_unic_inreg, actor.orgId]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: 'nr_unic_duplicat',
          message: 'Numărul unic de înregistrare există deja. Folosiți alt număr sau revizuiți documentul existent.'
        });
      }
    }
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
    if (!['draft','returnat'].includes(doc.status))
      return res.status(409).json({ error: 'document_not_draft', status: doc.status });

    // Verifică că P2 e din același org
    const { rows: p2rows } = await pool.query(
      'SELECT id, email, nume FROM users WHERE id=$1 AND org_id=$2', [assigned_to, actor.orgId]
    );
    if (!p2rows.length) return res.status(400).json({ error: 'utilizator_invalid' });
    const p2 = p2rows[0];

    const { rows: updated } = await pool.query(`
      UPDATE formulare_df
      SET status='pending_p2', assigned_to=$1, submitted_at=NOW(), updated_at=NOW(), motiv_returnare=NULL
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

    // Actualizează statusul ALOP legat de acest DF: draft → angajare (non-fatal)
    try {
      await pool.query(
        `UPDATE alop_instances
         SET df_completed_at=NOW(), status=CASE WHEN status='draft' THEN 'angajare' ELSE status END, updated_at=NOW()
         WHERE df_id=$1 AND org_id=$2 AND status IN ('draft','angajare')`,
        [req.params.id, actor.orgId]
      );
    } catch(e) {
      logger.warn({ err: e }, 'alop_instances update failed after P2 complete');
    }

    await sendNotif(doc.created_by, 'formulare_df_completed',
      'Document de Fundamentare — completat de Responsabil CAB',
      `${actor.nume || actor.email} a completat Secțiunea B din DF "${doc.nr_unic_inreg || 'fără număr'}"`,
      { form_type: 'df', form_id: req.params.id });

    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-df completat de P2');
    res.json({ ok: true, document: updated[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df complete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-df/:id/returneaza — P2 returnează documentul ca neconform
router.post('/api/formulare-df/:id/returneaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { motiv } = req.body || {};
    if (!motiv || !motiv.trim()) return res.status(400).json({ error: 'motiv_obligatoriu' });
    const { rows } = await pool.query(
      'SELECT * FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (doc.assigned_to !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'pending_p2')
      return res.status(409).json({ error: 'status_invalid', status: doc.status });
    await pool.query(
      `UPDATE formulare_df SET status='returnat', motiv_returnare=$1, updated_at=NOW() WHERE id=$2`,
      [motiv.trim(), req.params.id]
    );
    await sendNotif(doc.created_by, 'formulare_df_returnat',
      'Document de Fundamentare — returnat ca neconform',
      `${actor.nume || actor.email} a returnat DF "${doc.nr_unic_inreg || 'fără număr'}" cu observații`,
      { form_type: 'df', form_id: req.params.id });
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-df returnat de P2');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df returneaza error');
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
      'UPDATE formulare_df SET flow_id=$1, status=\'transmis_flux\', updated_at=NOW() WHERE id=$2 AND org_id=$3',
      [flow_id, req.params.id, actor.orgId]
    );
    // Actualizează df_flow_id în ALOP (non-fatal)
    try {
      await pool.query(
        `UPDATE alop_instances SET df_flow_id=$1, updated_at=NOW()
         WHERE df_id=$2 AND org_id=$3 AND cancelled_at IS NULL`,
        [flow_id, req.params.id, actor.orgId]
      );
    } catch(e) {
      logger.warn({ err: e }, 'alop_instances df_flow_id update failed');
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df link-flow error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-df/:id/revizii — toate reviziile aceluiași document
router.get('/api/formulare-df/:id/revizii', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, revizie_nr, status, created_at, revizie_motiv, revizie_at, este_revizie
      FROM formulare_df
      WHERE (id = $1
          OR parent_df_id = $1
          OR nr_unic_inreg = (
               SELECT nr_unic_inreg FROM formulare_df
               WHERE id = $1 AND deleted_at IS NULL LIMIT 1))
        AND org_id = $2
        AND deleted_at IS NULL
      ORDER BY revizie_nr ASC
    `, [req.params.id, actor.orgId]);
    res.json({ revizii: rows });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df revizii error');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/formulare-df/:id/revizuieste — crează o revizie nouă a documentului
// Alias: POST /api/formulare-df/:id/revizie
router.post(['/api/formulare-df/:id/revizuieste', '/api/formulare-df/:id/revizie'], _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: origRows } = await pool.query(`
      SELECT fd.*,
        (fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)) AS aprobat
      FROM formulare_df fd
      LEFT JOIN flows f ON f.id = fd.flow_id
      WHERE fd.id=$1 AND fd.org_id=$2 AND fd.deleted_at IS NULL
    `, [req.params.id, actor.orgId]);
    if (!origRows.length) return res.status(404).json({ error: 'DF negăsit' });
    const df = origRows[0];

    if (df.created_by !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });

    // Doar DF-uri aprobate (flux de semnare finalizat) pot fi revizuite
    if (!df.aprobat)
      return res.status(400).json({ error: 'Doar documentele aprobate pot fi revizuite' });

    const { motiv } = req.body || {};

    // Determină numărul reviziei noi
    const { rows: maxRows } = await pool.query(
      `SELECT COALESCE(MAX(revizie_nr), 0) AS max_rev
       FROM formulare_df
       WHERE nr_unic_inreg = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [df.nr_unic_inreg, actor.orgId]
    );
    const nouaRevizie = (maxRows[0]?.max_rev ?? 0) + 1;

    // Transformă rows_val — col.5 (valt_rev_prec) = col.7 (valt_actualiz) din revizia precedentă, col.6 (influente) = 0
    const rowsValOrig = Array.isArray(df.rows_val) ? df.rows_val : JSON.parse(df.rows_val || '[]');
    const rowsValNoi = rowsValOrig.map(r => ({
      ...r,
      valt_rev_prec: r.valt_actualiz || 0,
      influente: 0,
    }));

    // FIX 1: Detectează dacă revizia e pentru "an următor" (checkbox ckbx_ang_leg_emise_ct_an_urm)
    const isAnUrmator = df.ckbx_ang_leg_emise_ct_an_urm === '1';
    const totalValPrec = rowsValOrig.reduce((s, r) => s + (parseFloat(r.valt_actualiz) || 0), 0);

    // Copiază câmpurile SecA (P1); SecB se resetează explicit la []
    // rows_val se transmite ca parametru JS (transformat), rows_plati se copiază din SQL
    const { rows: nouRows } = await pool.query(`
      INSERT INTO formulare_df (
        org_id, created_by, nr_unic_inreg,
        revizie_nr, parent_df_id, este_revizie, revizie_motiv, revizie_at,
        status,
        revizuirea, data_revizuirii,
        cif, den_inst_pb, subtitlu_df,
        compartiment_specialitate,
        obiect_fd_reviz_scurt, obiect_fd_reviz_lung,
        ckbx_stab_tin_cont, ckbx_ramane_suma, ramane_suma,
        rows_val, rows_plati,
        ckbx_fara_ang_emis_ancrt, ckbx_cu_ang_emis_ancrt,
        ckbx_sting_ang_in_ancrt, ckbx_fara_plati_ang_in_ancrt,
        ckbx_cu_plati_ang_in_mmani, ckbx_ang_leg_emise_ct_an_urm,
        este_revizie_an_urmator, total_val_prec,
        rows_ctrl
      )
      SELECT
        org_id, $2, nr_unic_inreg,
        $3, id, TRUE, $4, NOW(),
        'draft',
        $3::text, TO_CHAR(NOW(), 'DD.MM.YYYY'),
        cif, den_inst_pb, subtitlu_df,
        compartiment_specialitate,
        obiect_fd_reviz_scurt, obiect_fd_reviz_lung,
        ckbx_stab_tin_cont, ckbx_ramane_suma, ramane_suma,
        $5::jsonb, rows_plati,
        ckbx_fara_ang_emis_ancrt, ckbx_cu_ang_emis_ancrt,
        ckbx_sting_ang_in_ancrt, ckbx_fara_plati_ang_in_ancrt,
        ckbx_cu_plati_ang_in_mmani, ckbx_ang_leg_emise_ct_an_urm,
        $6::boolean, $7::numeric,
        '[]'::jsonb
      FROM formulare_df WHERE id = $1
      RETURNING *
    `, [req.params.id, actor.userId, nouaRevizie, motiv ?? '', JSON.stringify(rowsValNoi), isAnUrmator, totalValPrec]);

    const nou = nouRows[0];

    // Actualizează linkul ALOP → df_id la noua revizie
    await pool.query(
      `UPDATE alop_instances SET df_id=$1, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
       WHERE df_id=$2 AND cancelled_at IS NULL`,
      [nou.id, req.params.id]
    );

    logger.info({ id: nou.id, parent: req.params.id, revizie: nouaRevizie, isAnUrmator, actor: actor.email }, 'formulare-df revizie creata');
    res.json({ ok: true, df: { ...nou, total_val_prec: totalValPrec }, mesaj: `Revizia ${nouaRevizie} creată cu succes` });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df revizuieste error');
    res.status(500).json({ error: 'server_error', detail: e.message });
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
    let orgFilter, params;
    if (actor.role === 'admin') {
      orgFilter = '';
      params = [];
    } else if (actor.role === 'org_admin') {
      orgFilter = 'AND fo.org_id = $1';
      params = [actor.orgId];
    } else {
      orgFilter = 'AND fo.org_id = $1 AND (fo.created_by = $2 OR fo.assigned_to = $2)';
      params = [actor.orgId, actor.userId];
    }
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
      WHERE fo.deleted_at IS NULL
        ${orgFilter}
      ORDER BY fo.updated_at DESC
    `, params);
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
    const isGlobalAdmin = actor.role === 'admin' && !actor.orgId;
    const orgCond = isGlobalAdmin ? '' : 'AND fo.org_id = $2';
    const params  = isGlobalAdmin ? [req.params.id] : [req.params.id, actor.orgId];
    const { rows } = await pool.query(`
      SELECT fo.*,
        p1.nume AS created_by_nume, p1.email AS created_by_email,
        p2.nume AS assigned_to_nume, p2.email AS assigned_to_email,
        fd.nr_unic_inreg AS df_nr, fd.rows_ctrl AS df_rows_ctrl,
        CASE WHEN fo.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat
      FROM formulare_ord fo
      JOIN users p1 ON p1.id = fo.created_by
      LEFT JOIN users p2 ON p2.id = fo.assigned_to
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows f ON f.id = fo.flow_id
      WHERE fo.id = $1 ${orgCond} AND fo.deleted_at IS NULL
    `, params);
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
    // df_id poate fi actualizat explicit (include null pentru a șterge legătura)
    if ('df_id' in (req.body || {})) {
      allSets.push(`df_id=$${pi}`);
      allVals.push(req.body.df_id || null);
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
    if (!['draft','returnat'].includes(doc.status))
      return res.status(409).json({ error: 'document_not_draft', status: doc.status });

    const { rows: p2rows } = await pool.query(
      'SELECT id, email, nume FROM users WHERE id=$1 AND org_id=$2', [assigned_to, actor.orgId]
    );
    if (!p2rows.length) return res.status(400).json({ error: 'utilizator_invalid' });
    const p2 = p2rows[0];

    const { rows: updated } = await pool.query(`
      UPDATE formulare_ord
      SET status='pending_p2', assigned_to=$1, submitted_at=NOW(), updated_at=NOW(), motiv_returnare=NULL
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
      'Ordonanțare de Plată — completată de Responsabil CAB',
      `${actor.nume || actor.email} a completat ORD "${doc.nr_ordonant_pl || 'fără număr'}"`,
      { form_type: 'ord', form_id: req.params.id });

    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-ord completat de P2');
    res.json({ ok: true, document: updated[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord complete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-ord/:id/returneaza — P2 returnează documentul ca neconform
router.post('/api/formulare-ord/:id/returneaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { motiv } = req.body || {};
    if (!motiv || !motiv.trim()) return res.status(400).json({ error: 'motiv_obligatoriu' });
    const { rows } = await pool.query(
      'SELECT * FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [req.params.id, actor.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (doc.assigned_to !== actor.userId && actor.role !== 'admin' && actor.role !== 'org_admin')
      return res.status(403).json({ error: 'forbidden' });
    if (doc.status !== 'pending_p2')
      return res.status(409).json({ error: 'status_invalid', status: doc.status });
    await pool.query(
      `UPDATE formulare_ord SET status='returnat', motiv_returnare=$1, updated_at=NOW() WHERE id=$2`,
      [motiv.trim(), req.params.id]
    );
    await sendNotif(doc.created_by, 'formulare_ord_returnat',
      'Ordonanțare de Plată — returnată ca neconformă',
      `${actor.nume || actor.email} a returnat ORD "${doc.nr_ordonant_pl || 'fără număr'}" cu observații`,
      { form_type: 'ord', form_id: req.params.id });
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-ord returnat de P2');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord returneaza error');
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

  const { type = 'df', status, from, to, comp, init, page = '1', limit = '20' } = req.query;
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
          const u1 = params.push(actor.userId);
          const u2 = params.push(actor.userId);
          conds.push(`(fd.created_by=$${u1} OR fd.assigned_to=$${u2})`);
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
      if (comp) conds.push(`fd.compartiment_specialitate=$${params.push(comp)}`);
      if (init) {
        const like = `%${init}%`;
        conds.push(`(u1.email ILIKE $${params.push(like)} OR u1.nume ILIKE $${params.push(like)})`);
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
          CASE WHEN fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
               THEN true ELSE false END AS aprobat,
          COALESCE(u1.nume, u1.email) AS initiator,
          COALESCE(u2.nume, u2.email) AS p2,
          (fd.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_df fd
        LEFT JOIN users u1 ON u1.id = fd.created_by
        LEFT JOIN users u2 ON u2.id = fd.assigned_to
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
          const u1 = params.push(actor.userId);
          const u2 = params.push(actor.userId);
          conds.push(`(fo.created_by=$${u1} OR fo.assigned_to=$${u2})`);
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
      // formulare_ord nu are compartiment_specialitate — filtru ignorat pentru ORD
      if (init) {
        const like = `%${init}%`;
        conds.push(`(u1.email ILIKE $${params.push(like)} OR u1.nume ILIKE $${params.push(like)})`);
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
          COALESCE(u2.nume, u2.email) AS p2,
          (fo.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_ord fo
        LEFT JOIN users u1 ON u1.id = fo.created_by
        LEFT JOIN users u2 ON u2.id = fo.assigned_to
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

// ── POST /api/formulare-df/:id/anuleaza ───────────────────────────────────────
router.post('/api/formulare-df/:id/anuleaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT created_by, org_id, status FROM formulare_df WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    const isAdmin = actor.role === 'admin';
    const isOrgAdmin = actor.role === 'org_admin';
    if (!isAdmin && doc.org_id !== actor.orgId) return res.status(403).json({ error: 'forbidden' });
    if (!isAdmin && !isOrgAdmin && doc.created_by !== actor.userId)
      return res.status(403).json({ error: 'forbidden' });
    if (!['draft','pending_p2','returnat'].includes(doc.status))
      return res.status(400).json({ error: 'cannot_cancel', message: 'Doar documentele draft, transmis_p2 sau returnate pot fi anulate.' });

    await pool.query(
      `UPDATE formulare_df SET status='anulat', updated_at=NOW() WHERE id=$1`,
      [id]
    );
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'anuleaza df error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/formulare-ord/:id/anuleaza ──────────────────────────────────────
router.post('/api/formulare-ord/:id/anuleaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT created_by, org_id, status FROM formulare_ord WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    const isAdmin = actor.role === 'admin';
    const isOrgAdmin = actor.role === 'org_admin';
    if (!isAdmin && doc.org_id !== actor.orgId) return res.status(403).json({ error: 'forbidden' });
    if (!isAdmin && !isOrgAdmin && doc.created_by !== actor.userId)
      return res.status(403).json({ error: 'forbidden' });
    if (!['draft','pending_p2','returnat'].includes(doc.status))
      return res.status(400).json({ error: 'cannot_cancel', message: 'Doar documentele draft, transmis_p2 sau returnate pot fi anulate.' });

    await pool.query(
      `UPDATE formulare_ord SET status='anulat', updated_at=NOW() WHERE id=$1`,
      [id]
    );
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'anuleaza ord error');
    res.status(500).json({ error: 'server_error' });
  }
});

export { router as formulareDbRouter };
