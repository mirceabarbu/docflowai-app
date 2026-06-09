/**
 * DocFlowAI — server/routes/formulare/df.mjs
 *
 * Document de Fundamentare (DF) — formulare_df.
 * Rute mutate verbatim din formulare-db.mjs (split mecanic Etapa 2).
 *
 * ⚠️ Ordinea rutelor la aceeași adâncime CONTEAZĂ (Express match by registration order):
 *   listă → /aprobate (STATIC) → /:id (PARAM) → restul.
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { requireModule } from '../../middleware/require-module.mjs';
import { logger } from '../../middleware/logger.mjs';
import { pool } from '../../db/index.mjs';
import { loadActorComp, canEditFormular, canViewFormular, canDestroyOnly } from '../../services/authz-formular.mjs';
import { computeDocCapabilities } from '../../services/formular-capabilities.mjs';
import { recordFormularAudit } from '../../db/queries/formulare-audit.mjs';
import {
  pick, buildUpdate,
  DF_P1_FIELDS, DF_P2_FIELDS,
  submitFormular, completeFormular, returnFormular, linkFlowFormular, stergeFormular,
} from '../../services/formular-shared.mjs';
import { requireDb } from './_helpers.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

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

export default router;
