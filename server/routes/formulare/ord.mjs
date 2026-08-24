/**
 * DocFlowAI — server/routes/formulare/ord.mjs
 *
 * Ordonanțare de Plată (ORD) — formulare_ord.
 * Rute mutate verbatim din formulare-db.mjs (split mecanic Etapa 2).
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { isPlatformAdmin, isAdminOrOrgAdmin } from '../../services/authz-scope.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { requireModule } from '../../middleware/require-module.mjs';
import { logger } from '../../middleware/logger.mjs';
import { pool } from '../../db/index.mjs';
import { loadActorCompAndCab, canEditFormular, canViewFormular, canDestroyOnly } from '../../services/authz-formular.mjs';
import { computeDocCapabilities } from '../../services/formular-capabilities.mjs';
import { recordFormularAudit } from '../../db/queries/formulare-audit.mjs';
import {
  pick, buildUpdate,
  ORD_P1_FIELDS, ORD_P2_FIELDS,
  submitFormular, completeFormular, returnFormular, linkFlowFormular, stergeFormular,
  computeOrdBudgetContext, deriveOrdIdentityCols,
} from '../../services/formular-shared.mjs';
import { requireDb } from './_helpers.mjs';
import { normalizeAngajamentRows } from '../../services/angajament-normalize.mjs';
import { liveFlowSql } from '../../services/flow-provenance.mjs';
import { blocuriDinOrd, pregatesteScriereBlocuri } from '../../services/ord-blocuri.mjs';
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
    if (isPlatformAdmin(actor)) {          // #105d: doar platform-admin (fără org_id) vede tot
      orgFilter = '';
      params = [];
    } else if (isAdminOrOrgAdmin(actor)) { // admin-cu-org SAU org_admin → org-scoped (tot org-ul)
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
              AND (f.data->>'status') IS DISTINCT FROM 'refused'
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
    // #131a — actorComp e scos din bloc: îl consumă și computeDocCapabilities (Responsabil
    // CAB pe COMPARTIMENT ⇒ rolul P2 se derivă din compartiment când assigned_to e NULL).
    const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
    let authzRole = '';
    {
      const view = await canViewFormular(pool, actor, doc, actorComp, { cabComp });
      if (!view.allowed) return res.status(403).json({ error: view.reason });
      // #143 — rolul de authz (poate fi 'comp' = coleg de compartiment al creatorului)
      // e propagat în capabilities: altfel poarta îl acceptă, dar butoanele nu apar.
      authzRole = view.role || '';
    }
    doc.capabilities = computeDocCapabilities(doc, actor, 'ordnt', actorComp, { authzRole });
    // Buget an de exercițiu pentru atenționarea inline (P1+P2) — paritate cu garda hard
    // (acel. helper). Frontend-ul sumează rândurile din UI + cicluri_arhivate și compară cu
    // buget_an_curent. NULL când ORD-ul nu are df_id (nimic de plafonat).
    try {
      // #134b — `ordId` dat explicit: dosarul ALOP se rezolvă prin ORD (pointerul `alop.df_id`
      // se mută la revizia DF și nu mai potrivește revizia înghețată a ORD-ului).
      const ctx = await computeOrdBudgetContext({ dfId: doc.df_id, orgId: actor.orgId, ordId: doc.id });
      if (ctx) {
        doc.an_exercitiu = ctx.anExercitiu;
        doc.buget_an_curent = ctx.bugetAnCurent;
        doc.cicluri_arhivate = ctx.cicluriArhivate;
      }
    } catch (_) { /* non-fatal: atenționarea inline e best-effort, garda hard rămâne pe server */ }
    // #128c — un document vechi (`blocuri` NULL în DB) întoarce totuși un array cu blocul
    // derivat din coloanele plate, ca #128e să scrie frontendul contra unei singure forme.
    // ⛔ DOAR detaliul: listele ar căra payload fără consumator.
    doc.blocuri = blocuriDinOrd(doc);
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
    // #131a — actorComp e scos din bloc: îl consumă și computeDocCapabilities (Responsabil
    // CAB pe COMPARTIMENT ⇒ rolul P2 se derivă din compartiment când assigned_to e NULL).
    const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
    {
      const view = await canViewFormular(pool, actor, doc, actorComp, { cabComp });
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    const caps = computeDocCapabilities(doc, actor, 'ordnt', actorComp);
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
    // ORD.rows e câmpul pe care OPME îl potrivește efectiv (opme-matcher.mjs:127) — coduri
    // canonice cu MAJUSCULE la scriere (angajament-normalize.mjs). Serverul e poarta.
    if ('rows' in data) data.rows = normalizeAngajamentRows(data.rows);
    // SEC-100.2: dacă ORD-ul se creează deja legat de un DF, derivă cele 4 coloane de
    // identitate din rows_ctrl-ul DF-ului (org-scoped) — clientul nu e crezut pe ele.
    if ('rows' in data && body.df_id) {
      const { rows: dfRows } = await pool.query(
        'SELECT rows_ctrl FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
        [body.df_id, actor.orgId]
      );
      if (dfRows.length) {
        const ctrl = Array.isArray(dfRows[0].rows_ctrl)
          ? dfRows[0].rows_ctrl
          : JSON.parse(dfRows[0].rows_ctrl || '[]');
        data.rows = deriveOrdIdentityCols(data.rows, ctrl);
      }
    }
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
    // #124e′ — idempotență pe FEREASTRĂ DE TIMP (nu pe cheie unică).
    // ⚠️ Spre deosebire de DF, `formulare_ord` NU poate primi un index unic pe
    // `source_alop_id`: ORD nu are revizii, deci mai multe ordonanțări pe același dosar ALOP
    // sunt starea CORECTĂ (fiecare cu alt `nr_ordonant_pl`). Datele din producție (12.08.2026)
    // confirmă: 8 grupuri multi-ORD, distanța minimă între două ordonanțări legitime = 2 zile
    // și 20 de ore; în schimb duplicatele accidentale apar la 109–782 ms. Discriminatorul e
    // timpul, nu conținutul. Fereastra de 10 s e cu peste patru ordine de mărime sub cea mai
    // scurtă distanță legitimă observată.
    // Cauza vizată nu e doar dublu-clicul: `saveDoc` (public/js/formular/doc.js:1024) ramifică
    // pe `if(!docId)` → POST, deci două autosalvări plecate înainte de primul răspuns creează
    // două documente. O gardă de buton nu ar acoperi-o; asta e poarta.
    const srcAlopId = isUuid(body.source_alop_id) ? body.source_alop_id : null;
    if (srcAlopId) {
      const { rows: dup } = await pool.query(
        `SELECT * FROM formulare_ord
          WHERE source_alop_id = $1
            AND org_id         = $2
            AND created_by     = $3
            AND deleted_at IS NULL
            AND created_at > NOW() - INTERVAL '10 seconds'
          ORDER BY created_at ASC
          LIMIT 1`,
        [srcAlopId, actor.orgId, actor.userId]
      );
      if (dup.length) {
        logger.warn({ existingId: dup[0].id, srcAlopId, actor: actor.email },
          'formulare-ord: creare duplicat în fereastra de 10s — s-a returnat documentul existent');
        dup[0].capabilities = computeDocCapabilities(dup[0], actor, 'ordnt');
        return res.json({ ok: true, document: dup[0], deduplicated: true });
      }
    }
    // #128c — sursa de adevăr devine `blocuri`; cele 8 coloane plate se scriu EXCLUSIV ca
    // OGLINDĂ a blocului 1 (un singur loc de scriere: `oglindaBloc1`). Un payload FĂRĂ
    // `blocuri` — adică tot ce trimite clientul azi — dă un singur bloc derivat din câmpurile
    // plate, deci coloanele scrise rămân identice cu cele de dinainte de #128c.
    const { blocuri, oglinda, rows: rowsCuBloc } = pregatesteScriereBlocuri({ body, data });
    if (rowsCuBloc !== undefined) data.rows = rowsCuBloc;   // bloc_idx, DUPĂ derivarea de identitate
    Object.assign(data, oglinda);                           // intră pe traseul ORD_P1_FIELDS de mai jos

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
    // Tratat SEPARAT (ca `source_alop_id`), NU adăugat în ORD_P1_FIELDS: dacă ar intra în lista
    // generică, un client ar putea trimite `blocuri` direct, ocolind normalizarea.
    cols.push('blocuri');
    vals.push(JSON.stringify(blocuri));

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

    const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
    const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true, cabComp });
    if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    const isP1 = doc.created_by === actor.userId || authz.role === 'comp' || authz.role === 'admin';
    const isP2 = doc.assigned_to === actor.userId || authz.role === 'p2_comp';
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';

    const extraSets = [];
    const extraVals = [];
    if ((isP1 || isAdmin) && doc.status === 'completed') {
      // #129 — ASIMETRIE DF/ORD, poarta care lipsea: DF-ul persistă `transmis_flux` la legarea
      // de flux, deci un DF în semnare cade pe ramura `document_locked` de mai jos. ORD-ul NU
      // persistă asta — rămâne `completed` chiar cu un flux VIU. Fără verificarea de aici,
      // butonul „Redeschide" ar putea reseta la draft un ORD aflat în semnare.
      // Predicatul vine din flow-provenance.mjs (sursă unică, #122): `liveFlowSql` prinde ȘI
      // fluxul încă în semnare, ȘI cel deja finalizat (un flux `completed` E „viu" acolo),
      // excluzând `cancelled` / `refused` / șters — acelea NU trebuie să blocheze redeschiderea.
      // ⚠️ Poziția contează: garda stă DUPĂ `canEditFormular` (403 înaintea lui 409).
      if (doc.flow_id) {
        const { rows: fl } = await pool.query(
          `SELECT 1 FROM flows f WHERE f.id = $1 AND (${liveFlowSql('f')}) LIMIT 1`,
          [doc.flow_id]
        );
        if (fl.length) {
          return res.status(409).json({
            error: 'document_pe_flux',
            message: 'Documentul are un flux de semnare activ sau finalizat. Anulați fluxul înainte de a-l redeschide.'
          });
        }
      }
      extraSets.push('status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL');
      extraVals.push('draft', doc.version + 1);
    } else if (isP1 && !['draft', 'returnat'].includes(doc.status)) {
      return res.status(409).json({ error: 'document_locked', status: doc.status });
    }

    const allowedFields = isP2 && !isP1 && !isAdmin ? ORD_P2_FIELDS : [...ORD_P1_FIELDS];
    const data = pick(req.body || {}, allowedFields);
    if ('rows' in data) data.rows = normalizeAngajamentRows(data.rows);   // coduri canonice (OPME)
    // SEC-100.2: df_id-ul EFECTIV după acest PUT (body-ul îl poate schimba sau șterge).
    const _effDfId = ('df_id' in (req.body || {})) ? (req.body.df_id || null) : doc.df_id;
    if ('rows' in data && _effDfId) {
      const { rows: dfRows } = await pool.query(
        'SELECT rows_ctrl FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
        [_effDfId, actor.orgId]
      );
      if (dfRows.length) {
        const ctrl = Array.isArray(dfRows[0].rows_ctrl)
          ? dfRows[0].rows_ctrl
          : JSON.parse(dfRows[0].rows_ctrl || '[]');
        data.rows = deriveOrdIdentityCols(data.rows, ctrl);
      }
      // DF inexistent / alt org / șters ⇒ NU derivăm și NU blocăm. `df_id` e oricum
      // scris de FK-ul de mai jos; un ORD legat de un DF invalid e altă problemă, nu asta.
    }
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
    // #128c — oglinda blocului 1 + coloana `blocuri` (vezi POST). `docExistent: doc` e
    // OBLIGATORIU: PUT-urile sunt frecvent parțiale (doar `beneficiar`, doar `rows`), iar fără
    // fuziune oglinda ar scrie peste câmpuri pe care utilizatorul nu le-a atins.
    {
      const prep = pregatesteScriereBlocuri({ body: req.body || {}, data, docExistent: doc });
      if (prep.rows !== undefined) data.rows = prep.rows;   // bloc_idx, DUPĂ derivarea de identitate
      // ⚠️ Bucla de mai jos consumă `extraSets[i]` ↔ `extraVals[i]`, dar ramura de reopen
      // adaugă 2 seturi FĂRĂ valoare (`completed_at=NULL`, `submitted_at=NULL`). Aliniem
      // înainte de a adăuga perechi noi, altfel valorile s-ar decala cu 2 poziții.
      while (extraVals.length < extraSets.length) extraVals.push(undefined);
      for (const [k, v] of Object.entries(prep.oglinda)) {
        // Cele 8 sunt toate în ORD_P1_FIELDS; pe calea P2-only (`ORD_P2_FIELDS = ['rows']`)
        // NU sunt, iar `buildUpdate` le-ar înghiți tăcut → le scriem explicit prin extraSets
        // (valorile vin din `doc`, deci scrierea e un no-op — P2 nu schimbă beneficiarul).
        // ⛔ NU lărgi `allowedFields`: ar deschide și scrierea directă de la client.
        if (allowedFields.includes(k)) data[k] = v;
        else { extraSets.push(`${k}=$__`); extraVals.push(v); }
      }
      extraSets.push('blocuri=$__');
      extraVals.push(JSON.stringify(prep.blocuri));
    }
    const { sets, vals } = buildUpdate(data, allowedFields, 1);

    const allSets = [...sets];
    const allVals = [...vals];
    let pi = allVals.length + 1;
    // #129 — fragmentele LITERALE (`completed_at=NULL`, `submitted_at=NULL`) NU au placeholder:
    // pentru ele NU se consumă o valoare, altfel s-ar împinge un `undefined` ca parametru
    // nereferențiat și Postgres arunca „could not determine data type of parameter" (500 pe
    // ORICE reopen ORD). Identic cu fixul deja aplicat pe DF (df.mjs, v3.9.750). Indexarea
    // rămâne POZIȚIONALĂ (`extraVals[i]`) — alinierea e asigurată de padding-ul din #128c.
    for (let i = 0; i < extraSets.length; i++) {
      if (extraSets[i].includes('$__')) {
        allSets.push(extraSets[i].replace('$__', `$${pi}`));
        allVals.push(extraVals[i]);
        pi++;
      } else {
        allSets.push(extraSets[i]);
      }
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
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, 'ordnt', actorComp, { authzRole: authz.role || '' });
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
      const authz = await canDestroyOnly(pool, actor, rows[0]);
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
