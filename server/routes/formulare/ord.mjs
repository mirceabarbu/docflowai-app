/**
 * DocFlowAI — server/routes/formulare/ord.mjs
 *
 * Ordonanțare de Plată (ORD) — formulare_ord.
 * Rute mutate verbatim din formulare-db.mjs (split mecanic Etapa 2).
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
  ORD_P1_FIELDS, ORD_P2_FIELDS,
  submitFormular, completeFormular, returnFormular, linkFlowFormular, stergeFormular,
  computeOrdBudgetContext,
} from '../../services/formular-shared.mjs';
import { requireDb } from './_helpers.mjs';
import { serializeOrdnt } from '../../services/alop-xml/ordnt-serializer.mjs';
import { ordRowToXsd } from '../../services/alop-xml/ord-to-xsd.mjs';
import { serveFormularXml } from '../../services/alop-xml/serve.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

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
        fd.nr_unic_inreg AS df_nr,
        CASE
          WHEN fo.status = 'completed'
           AND fo.flow_id IS NOT NULL
           AND fl.deleted_at IS NULL
           AND NOT (fl.data->>'status' = 'completed' OR (fl.data->>'completed')::boolean = true)
          THEN 'transmis_flux'
          ELSE fo.status
        END AS display_status
      FROM formulare_ord fo
      JOIN users p1 ON p1.id = fo.created_by
      LEFT JOIN users p2 ON p2.id = fo.assigned_to
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows fl ON fl.id = fo.flow_id
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

// GET /api/formulare-ord/buget-context?df_id=X — context de buget pentru atenționarea inline.
// ⚠️ Înregistrat ÎNAINTEA lui /:id (altfel `:id` ar prinde 'buget-context'). Alimentează atât
// fluxul de CREARE ORD (P1 selectează un DF, încă fără ORD salvat) cât și editarea. Folosește
// EXACT computeOrdBudgetContext (sursa unică) → paritate cu garda hard din submit/complete.
router.get('/api/formulare-ord/buget-context', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const dfId = (req.query.df_id || '').trim();
    if (!isUuid(dfId)) return res.json({ ok: true, context: null });
    // Org-scope: nu divulga bugetul unui DF din alt org (admin global vede tot).
    const isGlobalAdmin = actor.role === 'admin' && !actor.orgId;
    const ownRes = await pool.query(
      `SELECT 1 FROM formulare_df WHERE id=$1 AND deleted_at IS NULL ${isGlobalAdmin ? '' : 'AND org_id=$2'}`,
      isGlobalAdmin ? [dfId] : [dfId, actor.orgId]
    );
    if (!ownRes.rows.length) return res.json({ ok: true, context: null });
    const ctx = await computeOrdBudgetContext({ dfId, orgId: actor.orgId });
    res.json({ ok: true, context: ctx && {
      an_exercitiu: ctx.anExercitiu,
      buget_an_curent: ctx.bugetAnCurent,
      cicluri_arhivate: ctx.cicluriArhivate,
    } });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord buget-context error');
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
        CASE WHEN fo.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat,
        CASE WHEN fo.flow_id IS NOT NULL
              AND f.deleted_at IS NULL              -- fluxul șters (soft-delete) nu mai e activ (fix D)
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
    // Buget an de exercițiu pentru atenționarea inline (P1+P2) — paritate cu garda hard
    // (acel. helper). Frontend-ul sumează rândurile din UI + cicluri_arhivate și compară cu
    // buget_an_curent. NULL când ORD-ul nu are df_id (nimic de plafonat).
    try {
      const ctx = await computeOrdBudgetContext({ dfId: doc.df_id, orgId: actor.orgId });
      if (ctx) {
        doc.an_exercitiu = ctx.anExercitiu;
        doc.buget_an_curent = ctx.bugetAnCurent;
        doc.cicluri_arhivate = ctx.cicluriArhivate;
      }
    } catch (_) { /* non-fatal: atenționarea inline e best-effort, garda hard rămâne pe server */ }
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-ord/:id/xml — export XML oficial ORDNT (validat XSD înainte de servire)
// Authz IDENTIC cu GET /api/formulare-ord/:id (canViewFormular). Gate: can_export_xml.
router.get('/api/formulare-ord/:id/xml', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const isGlobalAdmin = actor.role === 'admin' && !actor.orgId;
    const orgCond = isGlobalAdmin ? '' : 'AND fo.org_id = $2';
    const params  = isGlobalAdmin ? [req.params.id] : [req.params.id, actor.orgId];
    const { rows } = await pool.query(`
      SELECT fo.*,
        CASE WHEN fo.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat
      FROM formulare_ord fo
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
    const caps = computeDocCapabilities(doc, actor, 'ordnt');
    if (!caps.can_export_xml) {
      return res.status(409).json({ error: 'not_exportable',
        message: 'Ordonanțarea nu este validată (Secțiunea A+B complete) — exportul XML nu este disponibil.' });
    }
    await serveFormularXml(res, {
      mapRow: ordRowToXsd, serialize: serializeOrdnt, schema: 'ordnt_v0',
      row: doc, fileBase: 'OrdonantareDePlata', dateField: 'data_ordont_pl', refField: 'nr_ordonant_pl',
    });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord xml export error');
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
    // v3.9.554: proveniență ALOP (simetric cu DF) — persistată la INSERT, nu se schimbă la PUT
    if (isUuid(body.source_alop_id)) { cols.push('source_alop_id'); vals.push(body.source_alop_id); }

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

// ── POST /api/formulare-ord/:id/sterge — ȘTERGERE (soft-delete) ────────────────
// Permis dacă ORD NU a fost trimisă pe flux (flow_id IS NULL). Relink ALOP (eliberează ord_id).
router.post('/api/formulare-ord/:id/sterge', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const r = await stergeFormular({ type: 'ord', id: req.params.id, actor });
  res.status(r.status).json(r.body);
});

export default router;
