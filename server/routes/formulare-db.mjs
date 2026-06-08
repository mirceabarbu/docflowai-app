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
import { requireModule } from '../middleware/require-module.mjs';
import { logger } from '../middleware/logger.mjs';
import { pool } from '../db/index.mjs';
import { loadActorComp, canEditFormular, canViewFormular, canDestroyOnly } from '../services/authz-formular.mjs';
import { computeDocCapabilities } from '../services/formular-capabilities.mjs';
import { recordFormularAudit, listFormularAudit } from '../db/queries/formulare-audit.mjs';
import { isAdminOrOrgAdmin } from './admin/_helpers.mjs';
import {
  pick, buildUpdate,
  DF_P1_FIELDS, DF_P2_FIELDS, ORD_P1_FIELDS, ORD_P2_FIELDS,
  submitFormular, completeFormular, returnFormular, linkFlowFormular, stergeFormular,
} from '../services/formular-shared.mjs';

let PDFLibFormular = null;
try { PDFLibFormular = await import('pdf-lib'); } catch (e) { logger.warn('⚠️ pdf-lib indisponibil pentru export audit formular PDF'); }

const router = Router();
const _csrf  = csrfMiddleware;

// ── helpers ───────────────────────────────────────────────────────────────────

function requireDb(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return true; }
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// sendNotif, pick, buildUpdate, DF_P1_FIELDS/DF_P2_FIELDS/ORD_P1_FIELDS/ORD_P2_FIELDS
// și lifecycle-ul DF/ORD (submit/complete/returneaza/link-flow/sterge) trăiesc acum în
// ../services/formular-shared.mjs (parametrizat pe formType). Rutele de mai jos sunt
// wrappers subțiri peste service; create/PUT/capturi rămân aici și reutilizează helperele.

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
      const _acRes = await pool.query('SELECT compartiment FROM users WHERE id=$1', [actor.userId]);
      const actorComp = (_acRes.rows[0]?.compartiment || '').trim();
      orgFilter = `AND fd.org_id = $1 AND (
  fd.created_by = $2
  OR fd.assigned_to = $2
  OR EXISTS (
    SELECT 1 FROM flows fl
    WHERE fl.id = fd.flow_id
      AND fl.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $2::text))
  )
  OR ($3::text <> '' AND EXISTS (
    SELECT 1 FROM users u_p1 WHERE u_p1.id = fd.created_by
      AND TRIM(u_p1.compartiment) = $3 AND TRIM(u_p1.compartiment) <> ''
  ))
  OR ($3::text <> '' AND EXISTS (
    SELECT 1 FROM users u_p2 WHERE u_p2.id = fd.assigned_to
      AND TRIM(u_p2.compartiment) = $3 AND TRIM(u_p2.compartiment) <> ''
  ))
)`;
      params = [actor.orgId, actor.userId, actorComp];
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
      SELECT DISTINCT ON (fd.nr_unic_inreg)
        fd.id, fd.nr_unic_inreg, fd.subtitlu_df, fd.data_revizuirii,
        fd.rows_ctrl, fd.revizie_nr
      FROM formulare_df fd
      JOIN flows f ON f.id = fd.flow_id
      WHERE fd.org_id = $1
        AND fd.deleted_at IS NULL
        AND fd.flow_id IS NOT NULL
        AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
      ORDER BY fd.nr_unic_inreg, fd.revizie_nr DESC
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
        CASE WHEN fd.flow_id IS NOT NULL
              AND (f.data->>'completed') IS DISTINCT FROM 'true'
              AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
             THEN true ELSE false END AS flow_active,
        (SELECT a.id FROM alop_instances a
         WHERE a.df_id = fd.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_id,
        (SELECT a.titlu FROM alop_instances a
         WHERE a.df_id = fd.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_titlu,
        (SELECT a.valoare_totala FROM alop_instances a
         WHERE a.df_id = fd.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_valoare,
        (SELECT COALESCE(MAX(fd2.revizie_nr), 0)
         FROM formulare_df fd2
         WHERE fd2.nr_unic_inreg = fd.nr_unic_inreg
           AND fd2.org_id = fd.org_id
           AND fd2.deleted_at IS NULL) AS latest_revizie_nr,
        EXISTS(
          SELECT 1 FROM formulare_df fd3
          WHERE fd3.nr_unic_inreg = fd.nr_unic_inreg
            AND fd3.org_id = fd.org_id
            AND fd3.deleted_at IS NULL
            AND fd3.revizie_nr > fd.revizie_nr
        ) AS has_newer_revision
      FROM formulare_df fd
      JOIN users p1 ON p1.id = fd.created_by
      LEFT JOIN users p2 ON p2.id = fd.assigned_to
      LEFT JOIN flows f  ON f.id = fd.flow_id
      WHERE fd.id = $1 ${orgCond} AND fd.deleted_at IS NULL
    `, params);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const view = await canViewFormular(pool, actor, doc, actorComp);
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    doc.capabilities = computeDocCapabilities(doc, actor, 'notafd');
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-df — creare draft (P1)
router.post('/api/formulare-df', _csrf, requireModule('alop'), requireModule('df'), async (req, res) => {
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
    await recordFormularAudit({ orgId: actor.orgId, formType: 'df', formId: rows[0].id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'creat', toStatus: 'draft' });
    rows[0].capabilities = computeDocCapabilities(rows[0], actor, 'notafd');
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

    const actorComp = await loadActorComp(pool, actor.userId);
    const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true });
    if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    const isP1 = doc.created_by === actor.userId || authz.role === 'comp' || authz.role === 'admin';
    const isP2 = doc.assigned_to === actor.userId || authz.role === 'p2_comp';

    // P1 poate modifica doar în draft (sau resetează completed → draft cu version++)
    let extraSets = [];
    let extraVals = [];
    if (isP1 || actor.role === 'admin' || actor.role === 'org_admin') {
      if (doc.status === 'completed') {
        // P1 modifică după ce P2 a completat → reset + version++
        extraSets = ['status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL'];
        extraVals = ['draft', doc.version + 1];
      } else if (!['draft', 'returnat', 'de_revizuit'].includes(doc.status)) {
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
    allSets.push(`updated_by=$${allVals.length + 1}`);
    allVals.push(actor.userId);
    allVals.push(req.params.id, actor.orgId);

    if (!allSets.filter(s => !s.startsWith('updated')).length && !extraSets.length)
      return res.status(400).json({ error: 'no_fields' });

    const { rows: updated } = await pool.query(`
      UPDATE formulare_df SET ${allSets.join(', ')}
      WHERE id=$${allVals.length - 1} AND org_id=$${allVals.length}
      RETURNING *
    `, allVals);
    // Reopen completed → draft (P1 modifică după ce P2 a completat) = revizie
    if (doc.status === 'completed' && extraSets.length) {
      await recordFormularAudit({ orgId: actor.orgId, formType: 'df', formId: req.params.id,
        actorId: actor.userId, actorEmail: actor.email, eventType: 'revizuit',
        fromStatus: 'completed', toStatus: 'draft', meta: { version_nou: doc.version + 1 } });
    }
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, 'notafd');
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
  const r = await submitFormular({ type: 'df', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});

// POST /api/formulare-df/:id/complete — P2 finalizează sectiunea B
router.post('/api/formulare-df/:id/complete', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await completeFormular({ type: 'df', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});

// POST /api/formulare-df/:id/returneaza — P2 returnează documentul ca neconform
router.post('/api/formulare-df/:id/returneaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await returnFormular({ type: 'df', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});

// POST /api/formulare-df/:id/link-flow — P1 leagă documentul de fluxul de semnare
router.post('/api/formulare-df/:id/link-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await linkFlowFormular({ type: 'df', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
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
  // formulare_df.id e UUID — un id malformat ar arunca „invalid input syntax for type uuid"
  // în SELECT (→ 500). Tratăm ca document inexistent (404), consistent cu restul rutelor.
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not_found' });
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

    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const authz = await canEditFormular(pool, actor, df, actorComp, { assignedCounts: true });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    // Doar DF-uri aprobate (flux de semnare finalizat) sau neaprobate (refuz) pot fi revizuite
    if (!df.aprobat && df.status !== 'neaprobat')
      return res.status(400).json({ error: 'Doar documentele aprobate sau neaprobate pot fi revizuite' });

    const { motiv } = req.body || {};

    // Determină numărul reviziei noi (max existent + 1)
    const { rows: maxRows } = await pool.query(
      `SELECT COALESCE(MAX(revizie_nr), 0) AS max_rev
       FROM formulare_df
       WHERE nr_unic_inreg = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [df.nr_unic_inreg, actor.orgId]
    );
    const maxRev = maxRows[0]?.max_rev ?? 0;

    // GUARD: doar revizia cea mai recentă poate fi revizuită
    // (împiedică ramificări — istoric liniar R0 → R1 → R2 → ...)
    if ((df.revizie_nr || 0) < maxRev) {
      return res.status(400).json({
        error: `Această revizie (R${df.revizie_nr || 0}) nu mai este cea curentă. Revizia curentă este R${maxRev}. Doar revizia curentă poate fi revizuită.`
      });
    }

    const nouaRevizie = maxRev + 1;

    // Transformă rows_val — col.5 (valt_rev_prec) = col.7 (valt_actualiz) din revizia precedentă, col.6 (influente) = 0
    const rowsValOrig = Array.isArray(df.rows_val) ? df.rows_val : JSON.parse(df.rows_val || '[]');
    const rowsValNoi = rowsValOrig.map(r => ({
      ...r,
      valt_rev_prec: r.valt_actualiz || 0,
      influente: 0,
    }));

    // Transformă rows_ctrl — c5/c8 (af_rvz_prc) = c7/c10 (act) din revizia precedentă, c6/c9 (influente) = 0
    const rowsCtrlOrig = Array.isArray(df.rows_ctrl)
      ? df.rows_ctrl
      : JSON.parse(df.rows_ctrl || '[]');

    const rowsCtrlNoi = rowsCtrlOrig.map(r => ({
      ...r,
      sum_rezv_crdt_ang_af_rvz_prc: r.sum_rezv_crdt_ang_act || 0,
      influente_c6: 0,
      sum_rezv_crdt_ang_act: r.sum_rezv_crdt_ang_act || 0,
      sum_rezv_crdt_bug_af_rvz_prc: r.sum_rezv_crdt_bug_act || 0,
      influente_c9: 0,
      sum_rezv_crdt_bug_act: r.sum_rezv_crdt_bug_act || 0,
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
        $3::integer, id, TRUE, $4, NOW(),
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
        $8::jsonb
      FROM formulare_df WHERE id = $1
      RETURNING *
    `, [req.params.id, actor.userId, nouaRevizie, motiv ?? '', JSON.stringify(rowsValNoi), isAnUrmator, totalValPrec, JSON.stringify(rowsCtrlNoi)]);

    const nou = nouRows[0];

    // Actualizează linkul ALOP → df_id la noua revizie
    await pool.query(
      `UPDATE alop_instances SET df_id=$1, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$3
       WHERE df_id=$2 AND cancelled_at IS NULL`,
      [nou.id, req.params.id, actor.userId]
    );

    logger.info({ id: nou.id, parent: req.params.id, revizie: nouaRevizie, isAnUrmator, actor: actor.email }, 'formulare-df revizie creata');
    await recordFormularAudit({ orgId: actor.orgId, formType: 'df', formId: req.params.id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'revizuit',
      meta: { version_nou: nouaRevizie, revizie_id: nou.id } });
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
    {
      const authz = canDestroyOnly(actor, rows[0]);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }
    if (rows[0].status !== 'draft')
      return res.status(409).json({ error: 'only_draft_deletable' });
    await pool.query(
      'UPDATE formulare_df SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1',
      [req.params.id, actor.userId]
    );
    await recordFormularAudit({ orgId: actor.orgId, formType: 'df', formId: req.params.id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'sters', fromStatus: rows[0].status });
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
      const _acRes = await pool.query('SELECT compartiment FROM users WHERE id=$1', [actor.userId]);
      const actorComp = (_acRes.rows[0]?.compartiment || '').trim();
      orgFilter = `AND fo.org_id = $1 AND (
  fo.created_by = $2
  OR fo.assigned_to = $2
  OR EXISTS (
    SELECT 1 FROM flows fl
    WHERE fl.id = fo.flow_id
      AND fl.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $2::text))
  )
  OR ($3::text <> '' AND EXISTS (
    SELECT 1 FROM users u_p1 WHERE u_p1.id = fo.created_by
      AND TRIM(u_p1.compartiment) = $3 AND TRIM(u_p1.compartiment) <> ''
  ))
  OR ($3::text <> '' AND EXISTS (
    SELECT 1 FROM users u_p2 WHERE u_p2.id = fo.assigned_to
      AND TRIM(u_p2.compartiment) = $3 AND TRIM(u_p2.compartiment) <> ''
  ))
)`;
      params = [actor.orgId, actor.userId, actorComp];
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
             THEN true ELSE false END AS aprobat,
        CASE WHEN fo.flow_id IS NOT NULL
              AND (f.data->>'completed') IS DISTINCT FROM 'true'
              AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
             THEN true ELSE false END AS flow_active,
        (SELECT a.id FROM alop_instances a
         WHERE a.ord_id = fo.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_id,
        (SELECT a.titlu FROM alop_instances a
         WHERE a.ord_id = fo.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_titlu,
        (SELECT a.valoare_totala FROM alop_instances a
         WHERE a.ord_id = fo.id AND a.cancelled_at IS NULL
         LIMIT 1) AS alop_valoare
      FROM formulare_ord fo
      JOIN users p1 ON p1.id = fo.created_by
      LEFT JOIN users p2 ON p2.id = fo.assigned_to
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows f ON f.id = fo.flow_id
      WHERE fo.id = $1 ${orgCond} AND fo.deleted_at IS NULL
    `, params);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const view = await canViewFormular(pool, actor, doc, actorComp);
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    doc.capabilities = computeDocCapabilities(doc, actor, 'ordnt');
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/formulare-ord — creare draft (P1)
router.post('/api/formulare-ord', _csrf, requireModule('alop'), requireModule('ord'), async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const body = req.body || {};
    const data = pick(body, ORD_P1_FIELDS);
    if (data.nr_ordonant_pl) {
      const { rows: dup } = await pool.query(
        `SELECT id FROM formulare_ord
         WHERE nr_ordonant_pl = $1 AND org_id = $2 AND deleted_at IS NULL`,
        [data.nr_ordonant_pl, actor.orgId]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          error: 'nr_ord_duplicat',
          message: 'Numărul ordonanțării există deja. Folosiți alt număr.'
        });
      }
    }
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
    await recordFormularAudit({ orgId: actor.orgId, formType: 'ord', formId: rows[0].id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'creat', toStatus: 'draft' });
    rows[0].capabilities = computeDocCapabilities(rows[0], actor, 'ordnt');
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

    const actorComp = await loadActorComp(pool, actor.userId);
    const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true });
    if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    const isP1 = doc.created_by === actor.userId || authz.role === 'comp' || authz.role === 'admin';
    const isP2 = doc.assigned_to === actor.userId || authz.role === 'p2_comp';
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';

    const extraSets = [];
    const extraVals = [];
    if ((isP1 || isAdmin) && doc.status === 'completed') {
      extraSets.push('status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL');
      extraVals.push('draft', doc.version + 1);
    } else if (isP1 && !['draft', 'returnat'].includes(doc.status)) {
      return res.status(409).json({ error: 'document_locked', status: doc.status });
    }

    const allowedFields = isP2 && !isP1 && !isAdmin ? ORD_P2_FIELDS : [...ORD_P1_FIELDS];
    const data = pick(req.body || {}, allowedFields);
    if (data.nr_ordonant_pl && data.nr_ordonant_pl !== doc.nr_ordonant_pl) {
      const { rows: dup } = await pool.query(
        `SELECT id FROM formulare_ord
         WHERE nr_ordonant_pl = $1 AND org_id = $2 AND deleted_at IS NULL AND id != $3`,
        [data.nr_ordonant_pl, actor.orgId, req.params.id]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          error: 'nr_ord_duplicat',
          message: 'Numărul ordonanțării există deja. Folosiți alt număr.'
        });
      }
    }
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
    allSets.push(`updated_by=$${allVals.length + 1}`);
    allVals.push(actor.userId);
    allVals.push(req.params.id, actor.orgId);

    const { rows: updated } = await pool.query(`
      UPDATE formulare_ord SET ${allSets.join(', ')}
      WHERE id=$${allVals.length - 1} AND org_id=$${allVals.length}
      RETURNING *
    `, allVals);
    // Reopen completed → draft (P1 modifică după ce P2 a completat) = revizie
    if (doc.status === 'completed' && extraSets.length) {
      await recordFormularAudit({ orgId: actor.orgId, formType: 'ord', formId: req.params.id,
        actorId: actor.userId, actorEmail: actor.email, eventType: 'revizuit',
        fromStatus: 'completed', toStatus: 'draft', meta: { version_nou: doc.version + 1 } });
    }
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, 'ordnt');
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
  const r = await submitFormular({ type: 'ord', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});

// POST /api/formulare-ord/:id/complete — P2 finalizează
router.post('/api/formulare-ord/:id/complete', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await completeFormular({ type: 'ord', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});

// POST /api/formulare-ord/:id/returneaza — P2 returnează documentul ca neconform
router.post('/api/formulare-ord/:id/returneaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await returnFormular({ type: 'ord', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});

// POST /api/formulare-ord/:id/link-flow — leagă de fluxul de semnare
router.post('/api/formulare-ord/:id/link-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await linkFlowFormular({ type: 'ord', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
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
    {
      const authz = canDestroyOnly(actor, rows[0]);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }
    if (rows[0].status !== 'draft')
      return res.status(409).json({ error: 'only_draft_deletable' });
    await pool.query(
      'UPDATE formulare_ord SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1', [req.params.id, actor.userId]
    );
    await recordFormularAudit({ orgId: actor.orgId, formType: 'ord', formId: req.params.id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'sters', fromStatus: rows[0].status });
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
      `SELECT created_by, assigned_to FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canView = doc.created_by === actor.userId || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canView) return res.status(403).json({ error: 'forbidden' });

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
    const canUpload = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canUpload) return res.status(403).json({ error: 'forbidden' });

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
    const filename = req.headers['x-filename'] || `atasament_${Date.now()}`;

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
      `SELECT created_by, assigned_to FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canView = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canView) return res.status(403).json({ error: 'forbidden' });

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
      `SELECT created_by, assigned_to FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canView = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canView) return res.status(403).json({ error: 'forbidden' });

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
    const canDelete = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canDelete) return res.status(403).json({ error: 'forbidden' });
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

// ── POST /api/formulare-df/:id/sterge — ȘTERGERE (soft-delete) ─────────────────
// Permis dacă DF NU e pe flux (flow_id IS NULL) ȘI nu are ORD legată ne-ștearsă.
// Pentru revizii: condiția se aplică pe rândul reviziei. Relink ALOP (mirror refuse).
router.post('/api/formulare-df/:id/sterge', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const r = await stergeFormular({ type: 'df', id: req.params.id, actor });
  res.status(r.status).json(r.body);
});

// ── POST /api/formulare-ord/:id/sterge — ȘTERGERE (soft-delete) ────────────────
// Permis dacă ORD NU a fost trimisă pe flux (flow_id IS NULL). Relink ALOP (eliberează ord_id).
router.post('/api/formulare-ord/:id/sterge', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const r = await stergeFormular({ type: 'ord', id: req.params.id, actor });
  res.status(r.status).json(r.body);
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

export { router as formulareDbRouter };
