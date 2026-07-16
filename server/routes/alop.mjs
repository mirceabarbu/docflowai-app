/**
 * server/routes/alop.mjs
 *
 * ALOP — Angajament Legal / Ordonanțare de Plată
 * Conform Ordinului 1140/2025 — 4 faze:
 *   1. Angajare      — Document de Fundamentare (DF) + flux semnare
 *   2. Lichidare     — confirmare servicii prestate / bunuri recepționate
 *   3. Ordonanțare   — Ordonanțare de Plată (ORD) + flux semnare
 *   4. Plată         — confirmare plată efectuată
 *
 * Status machine: draft → angajare → lichidare → ordonantare → plata → completed
 *
 * Toate rutele folosesc pattern-ul v3:
 *   const actor = requireAuth(req, res); if (!actor) return;
 *   actor.orgId / actor.userId
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { requireModule } from '../middleware/require-module.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { createRateLimiter } from '../middleware/rateLimiter.mjs';
import { loadActorCompAndCab, isCabDept, canEditAlop, canDestroyOnly, loadOrgCabComp } from '../services/authz-formular.mjs';
import { sendNotif } from '../services/formular-shared.mjs';
import { computeAlopCapabilities } from '../services/alop-capabilities.mjs';
import { crediteBugetareAnCurent } from '../services/buget-an.mjs';
import { copyFormularAttachmentsToFlow } from '../services/formular-flow-attachments.mjs';
import { recordFormularAudit } from '../db/queries/formulare-audit.mjs';
// Pachet B: hook lazy de auto-confirm OPME la tranziții către 'plata'.
// Import indirect (cycle cu opme-matcher) — folosit doar în handlers, nu la top-level.
import * as _opmeMatcher from '../services/opme-matcher.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

// FEATURE buget multi-anual (v3.9.558): fragment SQL care sumează banda `rows_plati`
// corespunzătoare ANULUI DE EXERCIȚIU CURENT, ancorată pe `df.an_referinta`.
//   offset = an_exercitiu_curent − an_referinta  (NULL an_referinta → 0 ⇒ banda `ancrt`)
//   offset <0 → ani_precedenti | 0 → ancrt | 1→np1 | 2→np2 | 3→np3 | >3 → ani_ulter
// ── CARD „buget exercițiu" (df_buget_an_curent) — DOAR afișare (fix 12, v3.9.582) ──────
// Regula owner pentru valoarea AFIȘATĂ pe card:
//   • „Stingere" bifat (`ckbx_sting_ang_in_ancrt`) → TABEL 1 = SUM(rows_val.valt_actualiz)
//     (angajamentul total; banda `rows_plati` an curent = 0 când Stingere e bifat, deci ar
//     afișa eronat 0).
//   • altfel → banda `rows_plati` a anului de exercițiu (regula veche, neschimbată).
// ⚠️ NU confunda cu PLAFONUL de verificare (sqlCrediteBugetareCol10 / computeOrdBudgetContext):
//    cardul afișează una, verificarea ordonanțării folosește col.10 — INTENȚIONAT diferite.
// ⚠️ Banda `rows_plati` e SINCRONIZATĂ MANUAL cu `bandaPentruOffset()` din services/buget-an.mjs.
// `df` = aliasul tabelei formulare_df în query-ul apelant.
function sqlStingereTruthy(df) {
  // ckbx_* sunt TEXT (`getNC`/save → '1'/''); legacy poate avea 'true'/'on'. Truthy = non-gol
  // și nu o valoare falsă explicită.
  return `(COALESCE(${df}.ckbx_sting_ang_in_ancrt,'') NOT IN ('','0','false','f','no','off'))`;
}
function sqlBandaRowsPlati(df) {
  const off = `(EXTRACT(YEAR FROM NOW())::int - COALESCE(${df}.an_referinta, EXTRACT(YEAR FROM NOW())::int))`;
  const band = `(CASE
        WHEN ${off} < 0 THEN 'plati_ani_precedenti'
        WHEN ${off} = 0 THEN 'plati_estim_ancrt'
        WHEN ${off} = 1 THEN 'plati_estim_an_np1'
        WHEN ${off} = 2 THEN 'plati_estim_an_np2'
        WHEN ${off} = 3 THEN 'plati_estim_an_np3'
        ELSE 'plati_estim_ani_ulter' END)`;
  return `(SELECT COALESCE(SUM((r->>${band})::numeric),0)
           FROM jsonb_array_elements(COALESCE(${df}.rows_plati,'[]'::jsonb)) r
           WHERE (r->>${band}) ~ '^[0-9.]+$')`;
}
function sqlTabel1(df) {
  return `(SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
           FROM jsonb_array_elements(COALESCE(${df}.rows_val,'[]'::jsonb)) r
           WHERE (r->>'valt_actualiz') ~ '^[0-9.]+$')`;
}
function sqlBugetAnExercitiu(df) {
  return `(CASE WHEN ${sqlStingereTruthy(df)} THEN ${sqlTabel1(df)} ELSE ${sqlBandaRowsPlati(df)} END)`;
}

// ── PLAFON verificare = CREDITE BUGETARE col.10 (`sum_rezv_crdt_bug_act` din rows_ctrl) ─────
// Sincronizat cu `crediteBugetareAnCurent()` (JS, buget-an.mjs) folosit de noua-lichidare +
// computeOrdBudgetContext. Format pe date reale = număr-string curat (`getNC`→`String(pMR)`),
// deci `::numeric` + regex `^[0-9.]+$` coincide cu `num()` din JS. `df` = alias formulare_df.
function sqlCrediteBugetareCol10(df) {
  return `(SELECT COALESCE(SUM((r->>'sum_rezv_crdt_bug_act')::numeric),0)
           FROM jsonb_array_elements(COALESCE(${df}.rows_ctrl,'[]'::jsonb)) r
           WHERE (r->>'sum_rezv_crdt_bug_act') ~ '^[0-9.]+$')`;
}

// ── suma ORDONANȚATĂ a anului de exercițiu pentru un ALOP (NU plătită) ───────────────
// = ordonanțările ciclurilor arhivate (JOIN ord_id → SUM rows.suma_ordonantata_plata,
//   fiindcă ciclul nu stochează direct suma ordonanțată), FILTRATE pe an de exercițiu,
//   PLUS ORD-ul curent (a.ord_id, necondiționat — exercițiul în curs). `a` = alias alop_instances.
function sqlOrdonantatAnCurent(a) {
  return `(
    COALESCE((
      SELECT SUM(co.s)
        FROM alop_ord_cicluri c_re
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
            FROM formulare_ord fo_re
            LEFT JOIN jsonb_array_elements(COALESCE(fo_re.rows,'[]'::jsonb)) r ON true
           WHERE fo_re.id = c_re.ord_id
        ) co
       WHERE c_re.alop_id = ${a}.id
         AND COALESCE(c_re.an_exercitiu,
                      EXTRACT(YEAR FROM c_re.plata_data)::int,
                      EXTRACT(YEAR FROM c_re.created_at)::int) = EXTRACT(YEAR FROM NOW())::int
    ), 0)
    + COALESCE((
      SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
        FROM formulare_ord fo_cur
        LEFT JOIN jsonb_array_elements(COALESCE(fo_cur.rows,'[]'::jsonb)) r ON true
       WHERE fo_cur.id = ${a}.ord_id
    ), 0)
  )`;
}

// ── ramas_an_curent (card ALOP) — OGLINDEȘTE EXACT garda din noua-lichidare (fix 12) ────
// = CREDITE BUGETARE col.10 − suma ORDONANȚATĂ în anul de exercițiu (cicluri arhivate per an
//   + ORD curent). Valoare CARD-ONLY (citire). ⚠️ Formula TREBUIE să rămână IDENTICĂ cu garda
//   din noua-lichidare (col.10 − ordonanțat); orice divergență ar afișa un „rămas" pe care
//   garda nu-l respectă (card zice X, garda Y).
// `df` = alias formulare_df, `a` = alias alop_instances.
// fără DF (a.df_id NULL) → NULL (nicio bază de buget; frontend afișează „—", nu NaN).
function sqlRamasAnExercitiu(df, a) {
  return `(CASE WHEN ${a}.df_id IS NULL THEN NULL ELSE
    ${sqlCrediteBugetareCol10(df)} - ${sqlOrdonantatAnCurent(a)}
  END)`;
}

// v3.9.499 (Finding E): rate limit pentru endpoint-uri admin destructive
const _alopAdminRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,  // 1 oră
  max: 5,
  message: 'Prea multe încercări de reparare ALOP. Așteptați 1 oră.'
});

function requireDb(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return true; }
  return false;
}

// ── Semnatari impliciti conform OMF 1140/2025 ─────────────────────────────────
const DF_DEFAULT_SEMNATARI = [
  { order: 1, role: 'initiator',          user_id: null, name: '' },
  { order: 2, role: 'sef_compartiment',   user_id: null, name: '', same_as_initiator: false },
  { order: 3, role: 'responsabil_cab',    user_id: null, name: '' },
  { order: 4, role: 'sef_cab',            user_id: null, name: '' },
  { order: 5, role: 'director_economic',  user_id: null, name: '' },
  { order: 6, role: 'ordonator_credite',  user_id: null, name: '' },
];
const ORD_DEFAULT_SEMNATARI = [
  { order: 1, role: 'initiator',          user_id: null, name: '' },
  { order: 2, role: 'responsabil_cab',    user_id: null, name: '' },
  { order: 3, role: 'cfp_propriu',        user_id: null, name: '' },
  { order: 4, role: 'ordonator_credite',  user_id: null, name: '' },
];

// ── GET /api/alop/sablon — montat ÎNAINTE de /:id ────────────────────────────
router.get('/api/alop/sablon', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM alop_sabloane WHERE org_id=$1',
      [actor.orgId]
    );
    const defaultSablon = {
      signatari_angajare:    [],
      signatari_lichidare:   [],
      signatari_ordonantare: [],
      signatari_plata:       [],
    };
    res.json({ sablon: rows[0] || defaultSablon });
  } catch (e) {
    logger.error({ err: e }, 'alop sablon get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/sablon — upsert șablon org ────────────────────────────────
router.post('/api/alop/sablon', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!['admin', 'org_admin'].includes(actor.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const {
      df_semnatari_sablon  = DF_DEFAULT_SEMNATARI,
      ord_semnatari_sablon = ORD_DEFAULT_SEMNATARI,
      lichidare_sablon     = {},
    } = req.body;

    if (!Array.isArray(df_semnatari_sablon) || df_semnatari_sablon.length !== 6) {
      return res.status(400).json({ error: 'df_semnatari_sablon trebuie să conțină 6 roluri' });
    }
    if (!Array.isArray(ord_semnatari_sablon) || ord_semnatari_sablon.length !== 4) {
      return res.status(400).json({ error: 'ord_semnatari_sablon trebuie să conțină 4 roluri' });
    }

    const { rows } = await pool.query(`
      INSERT INTO alop_sabloane
        (org_id, df_semnatari_sablon, ord_semnatari_sablon, lichidare_sablon, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (org_id) DO UPDATE
        SET df_semnatari_sablon  = EXCLUDED.df_semnatari_sablon,
            ord_semnatari_sablon = EXCLUDED.ord_semnatari_sablon,
            lichidare_sablon     = EXCLUDED.lichidare_sablon,
            updated_at           = NOW()
      RETURNING *
    `, [
      actor.orgId,
      JSON.stringify(df_semnatari_sablon),
      JSON.stringify(ord_semnatari_sablon),
      JSON.stringify(lichidare_sablon),
    ]);
    res.json({ sablon: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop sablon save error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Clauză de vizibilitate ALOP (per-user), goală pentru admin/org_admin ─────
// Mutează `params` (push) și întoarce fragmentul ` AND (...)`. SQL păstrat 1:1
// cu blocul inline al listei — folosit de AMBELE endpoint-uri (listă + stats)
// ca să nu mai poată diverge niciodată. Folosește aliasul `a` pe alop_instances.
async function buildAlopVisibilityWhere(actor, params) {
  if (actor.role === 'admin' || actor.role === 'org_admin') return '';
  // FEAT ALOP-CAB: membrul CAB al org-ului vede tot ALOP-ul org-ului. `return ''` e sigur fiindcă
  // apelantul are deja `a.org_id=$1` în WHERE-ul principal (liniile 290/318/1589) — restricția
  // cade DOAR în interiorul org-ului. Fail-safe: cab_compartiment gol ⇒ isCabDept false ⇒ nicio relaxare.
  const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
  if (isCabDept(actorComp, cabComp)) return '';
  params.push(actor.userId);
  const userIdx = params.length;
  let compClause = '';
  if (actorComp !== '') {
    params.push(actorComp);
    const compIdx = params.length;
    compClause = `
    OR (TRIM(a.compartiment) = $${compIdx} AND TRIM(a.compartiment) <> '')
    OR EXISTS (
      SELECT 1 FROM users uc
      WHERE uc.id = a.created_by
        AND TRIM(uc.compartiment) = $${compIdx}
        AND TRIM(uc.compartiment) <> ''
    )
    OR EXISTS (
      SELECT 1 FROM users u_p2
      WHERE TRIM(u_p2.compartiment) = $${compIdx}
        AND TRIM(u_p2.compartiment) <> ''
        AND (
          u_p2.id IN (
            SELECT fd.assigned_to FROM formulare_df fd WHERE fd.id = a.df_id AND fd.assigned_to IS NOT NULL
            UNION ALL
            SELECT fo.assigned_to FROM formulare_ord fo WHERE fo.id = a.ord_id AND fo.assigned_to IS NOT NULL
          )
          OR u_p2.id::text IN (
            SELECT s->>'user_id' FROM jsonb_array_elements(COALESCE(a.df_semnatari,'[]'::jsonb)) s
              WHERE s->>'role' = 'responsabil_cab' AND s->>'user_id' IS NOT NULL
            UNION ALL
            SELECT s->>'user_id' FROM jsonb_array_elements(COALESCE(a.ord_semnatari,'[]'::jsonb)) s
              WHERE s->>'role' = 'responsabil_cab' AND s->>'user_id' IS NOT NULL
          )
        )
    )`;
  }
  return ` AND (
    a.created_by = $${userIdx}
    OR EXISTS (
      SELECT 1 FROM flows fl1
      WHERE fl1.id = a.df_flow_id
        AND fl1.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text))
    )
    OR EXISTS (
      SELECT 1 FROM flows fl2
      WHERE fl2.id = a.ord_flow_id
        AND fl2.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text))
    )${compClause}
  )`;
}

// ── GET /api/alop/stats — montat ÎNAINTE de /:id ─────────────────────────────
router.get('/api/alop/stats', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const params = [actor.orgId];
    let where = 'a.org_id=$1 AND a.cancelled_at IS NULL';
    where += await buildAlopVisibilityWhere(actor, params);
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                    AS total,
        COUNT(*) FILTER (WHERE a.status='completed')::int                AS completate,
        COUNT(*) FILTER (WHERE a.status IN
          ('angajare','lichidare','ordonantare','plata'))::int            AS in_progres,
        COUNT(*) FILTER (WHERE a.status='draft')::int                    AS draft
      FROM alop_instances a
      WHERE ${where}
    `, params);
    res.json(rows[0]);
  } catch (e) {
    logger.error({ err: e }, 'alop stats error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/alop — lista ALOP pentru org ────────────────────────────────────
router.get('/api/alop', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const params = [actor.orgId];
    let where = 'a.org_id = $1 AND a.cancelled_at IS NULL';
    where += await buildAlopVisibilityWhere(actor, params);
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        a.id, a.status, a.titlu, a.compartiment, a.valoare_totala,
        a.df_id, a.ord_id, a.df_flow_id, a.ord_flow_id,
        a.df_completed_at, a.lichidare_confirmed_at,
        a.ord_completed_at, a.plata_confirmed_at,
        a.created_at, a.updated_at,
        u.nume   AS creator_name,
        u.email  AS creator_email,
        df.nr_unic_inreg AS df_nr,
        df.status        AS df_status,
        fo.nr_ordonant_pl AS ord_nr,
        fo.status        AS ord_status,
        df.revizie_nr                AS df_revizie_nr,
        df.este_revizie_an_urmator   AS df_este_revizie_an_urmator,
        (SELECT CASE WHEN COALESCE(df.flow_id, a.df_flow_id) IS NOT NULL
                      AND fdf.deleted_at IS NULL
                      AND (fdf.data->>'completed') IS DISTINCT FROM 'true'
                      AND (fdf.data->>'status')    IS DISTINCT FROM 'cancelled'
                      AND (fdf.data->>'status')    IS DISTINCT FROM 'refused'
                 THEN true ELSE false END
         FROM flows fdf WHERE fdf.id::text = COALESCE(df.flow_id, a.df_flow_id)) AS df_flow_active,
        (SELECT CASE WHEN (fdf.data->>'status')='completed' OR (fdf.data->>'completed')::boolean=true
                 THEN true ELSE false END
         FROM flows fdf WHERE fdf.id::text = COALESCE(df.flow_id, a.df_flow_id)) AS df_aprobat,
        (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
         FROM jsonb_array_elements(COALESCE(df.rows_val,'[]'::jsonb)) r) AS df_valoare,
        ${sqlBugetAnExercitiu('df')} AS df_buget_an_curent,
        ${sqlCrediteBugetareCol10('df')} AS credite_bugetare_an_curent,
        df.an_referinta AS df_an_referinta,
        ${sqlStingereTruthy('df')} AS df_stingere,
        (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
         FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r) AS ord_valoare,
        a.plata_suma_efectiva AS op_valoare,
        -- FIX v3.9.338: totaluri agregate (toate ciclurile) pentru afișarea pe listă
        (
          COALESCE(
            (SELECT SUM(plata_suma_efectiva)
             FROM alop_ord_cicluri c
             WHERE c.alop_id = a.id), 0
          )
          + COALESCE(
            (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
             FROM formulare_ord fo2
             LEFT JOIN jsonb_array_elements(COALESCE(fo2.rows,'[]'::jsonb)) r ON true
             WHERE fo2.id = a.ord_id), 0
          )
        ) AS total_ord_valoare,
        (
          COALESCE(a.suma_totala_platita, 0) + COALESCE(a.plata_suma_efectiva, 0)
        ) AS total_platit,
        EXISTS (
          SELECT 1 FROM opme_lines ol WHERE ol.matched_alop_id = a.id
        ) AS has_opme_lines,
        (a.status NOT IN ('completed','cancelled') AND a.df_id IS NULL AND a.ord_id IS NULL) AS can_delete
      FROM alop_instances a
      LEFT JOIN users        u  ON u.id  = a.created_by
      LEFT JOIN formulare_df df ON df.id = a.df_id
      LEFT JOIN formulare_ord fo ON fo.id = a.ord_id
      WHERE ${where}
      ORDER BY a.updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, Number(limit), offset]);

    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM alop_instances a WHERE ${where}`,
      params
    );

    res.json({
      alop:  rows,
      total: cnt[0].count,
      page:  Number(page),
      pages: Math.ceil(cnt[0].count / Number(limit)),
    });
  } catch (e) {
    logger.error({ err: e }, 'alop list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop — creare ALOP nou (status: draft) ─────────────────────────
router.post('/api/alop', _csrf, requireModule('alop'), async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const {
      titlu, compartiment, valoare_totala, notes,
      df_semnatari: bodyDfSem,
      ord_semnatari: bodyOrdSem,
    } = req.body;

    // Preia șablonul org
    const { rows: sabRows } = await pool.query(
      'SELECT df_semnatari_sablon, ord_semnatari_sablon, lichidare_sablon FROM alop_sabloane WHERE org_id=$1',
      [actor.orgId]
    );
    const sab = sabRows[0] || {};

    // Preia numele utilizatorului curent
    const { rows: uRows } = await pool.query('SELECT nume FROM users WHERE id=$1', [actor.userId]);
    const userName = uRows[0]?.nume || '';

    // Semnatari: override din body sau din șablon sau default
    let dfSem  = bodyDfSem  || sab.df_semnatari_sablon  || DF_DEFAULT_SEMNATARI;
    let ordSem = bodyOrdSem || sab.ord_semnatari_sablon || ORD_DEFAULT_SEMNATARI;

    // Înlocuiește inițiatorul cu userul curent
    dfSem = dfSem.map(s => {
      if (s.role === 'initiator') return { ...s, user_id: actor.userId, name: userName };
      if (s.role === 'sef_compartiment' && s.same_as_initiator)
        return { ...s, user_id: actor.userId, name: userName };
      return s;
    });
    ordSem = ordSem.map(s =>
      s.role === 'initiator' ? { ...s, user_id: actor.userId, name: userName } : s
    );

    const lichidareSablon = sab.lichidare_sablon || {};
    const lichidareUserId = lichidareSablon.user_id || null;

    const { rows } = await pool.query(`
      INSERT INTO alop_instances
        (org_id, created_by, titlu, compartiment, valoare_totala, notes,
         df_semnatari, ord_semnatari, lichidare_confirmed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
      RETURNING *
    `, [
      actor.orgId, actor.userId,
      titlu         || 'ALOP nou',
      compartiment  || '',
      valoare_totala || null,
      notes          || '',
      JSON.stringify(dfSem),
      JSON.stringify(ordSem),
      lichidareUserId,
    ]);
    res.status(201).json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop create error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/alop/facturi — centralizator read-only al facturilor din lichidări ──
// UNION: facturi CURENTE (alop_instances) + facturi ARHIVATE (alop_ord_cicluri).
// Vizibilitate: admin/org_admin/CAB văd tot org-ul; restul doar compartimentul lor
// (via buildAlopVisibilityWhere pe CTE-ul visible_alop, alias `a`).
// NB: definită ÎNAINTEA lui `/api/alop/:id` — altfel Express ar prinde 'facturi' ca :id.
router.get('/api/alop/facturi', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const params = [actor.orgId];
    // CTE cu ALOP-urile vizibile actorului (aceeași regulă ca lista ALOP)
    const visWhere = await buildAlopVisibilityWhere(actor, params); // '' sau ' AND (...)'
    const sql = `
      WITH visible_alop AS (
        SELECT a.id
          FROM alop_instances a
         WHERE a.org_id = $1 AND a.cancelled_at IS NULL${visWhere}
      )
      SELECT * FROM (
        -- Facturi CURENTE (ciclul în lucru)
        SELECT
          a.id                     AS alop_id,
          a.titlu                  AS alop_titlu,
          a.df_id                  AS df_id,
          a.ord_id                 AS ord_id,
          a.lichidare_nr_factura   AS nr_factura,
          a.lichidare_data_factura AS data_factura,
          a.lichidare_valoare_factura AS valoare,
          a.lichidare_nr_pv        AS nr_pv,
          a.lichidare_data_pv      AS data_pv,
          a.lichidare_notes        AS notes,
          a.lichidare_confirmed_at AS confirmed_at,
          ul.nume                  AS confirmed_by_name,
          COALESCE(a.ciclu_curent,1) AS ciclu_nr,
          'curent'                 AS sursa
        FROM alop_instances a
        JOIN visible_alop v ON v.id = a.id
        LEFT JOIN users ul ON ul.id = a.lichidare_confirmed_by
        WHERE a.lichidare_nr_factura IS NOT NULL
          AND TRIM(a.lichidare_nr_factura) <> ''

        UNION ALL

        -- Facturi ARHIVATE (cicluri închise) — DF din ALOP-ul părinte
        SELECT
          a.id                     AS alop_id,
          a.titlu                  AS alop_titlu,
          a.df_id                  AS df_id,
          c.ord_id                 AS ord_id,
          c.lichidare_nr_factura   AS nr_factura,
          c.lichidare_data_factura AS data_factura,
          c.lichidare_valoare_factura AS valoare,
          c.lichidare_nr_pv        AS nr_pv,
          c.lichidare_data_pv      AS data_pv,
          c.lichidare_notes        AS notes,
          c.lichidare_confirmed_at AS confirmed_at,
          ul.nume                  AS confirmed_by_name,
          c.ciclu_nr               AS ciclu_nr,
          'ciclu'                  AS sursa
        FROM alop_ord_cicluri c
        JOIN visible_alop v ON v.id = c.alop_id
        JOIN alop_instances a ON a.id = c.alop_id
        LEFT JOIN users ul ON ul.id = c.lichidare_confirmed_by
        WHERE c.org_id = $1
          AND c.lichidare_nr_factura IS NOT NULL
          AND TRIM(c.lichidare_nr_factura) <> ''
      ) t
      ORDER BY t.data_factura DESC NULLS LAST, t.confirmed_at DESC NULLS LAST
    `;
    const { rows } = await pool.query(sql, params);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, facturi: rows, total: rows.length });
  } catch (e) {
    logger.error({ err: e }, 'alop facturi centralizator error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/alop/:id — detalii ALOP ─────────────────────────────────────────
router.get('/api/alop/:id', async (req, res) => {
  if (!req.params.id || req.params.id === 'null' || req.params.id === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const detailParams = [req.params.id, actor.orgId];
    let extraWhere = '';
    if (actor.role !== 'admin' && actor.role !== 'org_admin') {
      const actorCompRes = await pool.query(
        'SELECT compartiment FROM users WHERE id=$1',
        [actor.userId]
      );
      const actorComp = (actorCompRes.rows[0]?.compartiment || '').trim();
      detailParams.push(actor.userId);
      const userIdx = detailParams.length;
      let compClause = '';
      if (actorComp !== '') {
        detailParams.push(actorComp);
        const compIdx = detailParams.length;
        compClause = `
          OR (TRIM(a.compartiment) = $${compIdx} AND TRIM(a.compartiment) <> '')
          OR EXISTS (
            SELECT 1 FROM users uc
            WHERE uc.id = a.created_by
              AND TRIM(uc.compartiment) = $${compIdx}
              AND TRIM(uc.compartiment) <> ''
          )
          OR EXISTS (
            SELECT 1 FROM users u_p2
            WHERE TRIM(u_p2.compartiment) = $${compIdx}
              AND TRIM(u_p2.compartiment) <> ''
              AND (
                u_p2.id IN (
                  SELECT fd.assigned_to FROM formulare_df fd WHERE fd.id = a.df_id AND fd.assigned_to IS NOT NULL
                  UNION ALL
                  SELECT fo.assigned_to FROM formulare_ord fo WHERE fo.id = a.ord_id AND fo.assigned_to IS NOT NULL
                )
                OR u_p2.id::text IN (
                  SELECT s->>'user_id' FROM jsonb_array_elements(COALESCE(a.df_semnatari,'[]'::jsonb)) s
                    WHERE s->>'role' = 'responsabil_cab' AND s->>'user_id' IS NOT NULL
                  UNION ALL
                  SELECT s->>'user_id' FROM jsonb_array_elements(COALESCE(a.ord_semnatari,'[]'::jsonb)) s
                    WHERE s->>'role' = 'responsabil_cab' AND s->>'user_id' IS NOT NULL
                )
              )
          )`;
      }
      extraWhere = ` AND (
        a.created_by = $${userIdx}
        OR EXISTS (
          SELECT 1 FROM flows fl1
          WHERE fl1.id = a.df_flow_id
            AND fl1.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text))
        )
        OR EXISTS (
          SELECT 1 FROM flows fl2
          WHERE fl2.id = a.ord_flow_id
            AND fl2.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text))
        )${compClause}
      )`;
    }
    const { rows } = await pool.query(`
      SELECT
        a.*,
        u.nume   AS creator_name,
        u.email  AS creator_email,
        df.nr_unic_inreg             AS df_nr,
        df.status                    AS df_status,
        df.obiect_fd_reviz_scurt     AS df_obiect,
        fo.nr_ordonant_pl            AS ord_nr,
        df.compartiment_specialitate AS df_compartiment,
        df.revizie_nr                AS df_revizie_nr,
        df.este_revizie_an_urmator   AS df_este_revizie_an_urmator,
        df.flow_id                   AS df_authoritative_flow_id,
        fo.flow_id                   AS ord_authoritative_flow_id,
        fo.status                    AS ord_status,
        f1.id AS df_flow_exists,
        f2.id AS ord_flow_exists,
        CASE WHEN COALESCE(df.flow_id, a.df_flow_id) IS NOT NULL AND (
          f1.data->>'status' = 'completed' OR (f1.data->>'completed')::boolean = true
        ) THEN true ELSE false END AS df_aprobat,
        CASE WHEN COALESCE(df.flow_id, a.df_flow_id) IS NOT NULL
                  AND f1.deleted_at IS NULL
                  AND (f1.data->>'completed') IS DISTINCT FROM 'true'
                  AND (f1.data->>'status')    IS DISTINCT FROM 'cancelled'
                  AND (f1.data->>'status')    IS DISTINCT FROM 'refused'
             THEN true ELSE false END AS df_flow_active,
        CASE WHEN COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL AND (
          f2.data->>'status' = 'completed' OR (f2.data->>'completed')::boolean = true
        ) THEN true ELSE false END AS ord_aprobat,
        ul.nume AS lichidare_by_name,
        up.nume AS plata_by_name,
        (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
         FROM jsonb_array_elements(COALESCE(df.rows_val,'[]'::jsonb)) r) AS df_valoare,
        ${sqlBugetAnExercitiu('df')} AS df_buget_an_curent,
        ${sqlCrediteBugetareCol10('df')} AS credite_bugetare_an_curent,
        ${sqlRamasAnExercitiu('df','a')} AS ramas_an_curent,
        df.an_referinta AS df_an_referinta,
        ${sqlStingereTruthy('df')} AS df_stingere,
        (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
         FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r) AS ord_valoare,
        a.plata_suma_efectiva AS op_valoare,
        COALESCE(a.suma_totala_platita,0) + COALESCE(a.plata_suma_efectiva,0) AS suma_platita_total,
        a.ciclu_curent,
        cicluri.cicluri_json AS cicluri_istorice,
        EXISTS(
          SELECT 1 FROM formulare_df fd2
          WHERE fd2.parent_df_id = df.id
            AND fd2.org_id = a.org_id
            AND fd2.status IN ('draft','pending_p2','completed','returnat','transmis_flux','de_revizuit')
            AND fd2.deleted_at IS NULL
        ) AS df_revizie_in_lucru
      FROM alop_instances a
      LEFT JOIN users        u   ON u.id   = a.created_by
      LEFT JOIN formulare_df df  ON df.id  = a.df_id
      LEFT JOIN formulare_ord fo ON fo.id  = a.ord_id
      LEFT JOIN flows        f1  ON f1.id  = COALESCE(df.flow_id, a.df_flow_id)
      LEFT JOIN flows        f2  ON f2.id  = COALESCE(fo.flow_id, a.ord_flow_id)
      LEFT JOIN users        ul  ON ul.id  = a.lichidare_confirmed_by
      LEFT JOIN users        up  ON up.id  = a.plata_confirmed_by
      LEFT JOIN LATERAL (
        SELECT json_agg(
          jsonb_build_object(
            'ciclu_nr', c.ciclu_nr,
            'ord_id', c.ord_id,
            'ord_flow_id', c.ord_flow_id,
            'lichidare_confirmed_by', c.lichidare_confirmed_by,
            'lichidare_confirmed_at', c.lichidare_confirmed_at,
            'lichidare_nr_factura', c.lichidare_nr_factura,
            'lichidare_data_factura', c.lichidare_data_factura,
            'lichidare_nr_pv', c.lichidare_nr_pv,
            'lichidare_data_pv', c.lichidare_data_pv,
            'lichidare_notes', c.lichidare_notes,
            'plata_confirmed_by', c.plata_confirmed_by,
            'plata_confirmed_at', c.plata_confirmed_at,
            'plata_nr_ordin', c.plata_nr_ordin,
            'plata_data', c.plata_data,
            'plata_suma_efectiva', c.plata_suma_efectiva,
            'plata_observatii', c.plata_observatii,
            'status', c.status,
            'nr_ordonant_pl', fo_c.nr_ordonant_pl
          ) ORDER BY c.ciclu_nr
        ) AS cicluri_json
        FROM alop_ord_cicluri c
        LEFT JOIN formulare_ord fo_c ON fo_c.id = c.ord_id
        WHERE c.alop_id = a.id
      ) cicluri ON true
      WHERE a.id = $1
        AND a.org_id = $2
        AND a.cancelled_at IS NULL${extraWhere}
    `, detailParams);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const alop = rows[0];

    // ── Lazy auto-tranziție pentru fluxuri STS Cloud (completed=true fără status='completed') ──
    // DF aprobat dar ALOP rămas în 'draft' sau 'angajare' → recuperare la 'lichidare'.
    // Cazul 'draft' acoperă scenarii rare în care propagarea normală a eșuat silent
    // (P2 /complete sau link-df-flow → catch silentioase). Idempotent: UPDATE limitat
    // la stările eligibile, logger pentru audit dacă se declanșează.
    if (alop.df_aprobat && ['draft', 'angajare'].includes(alop.status)) {
      try {
        const fromStatus = alop.status;
        // Resync df_flow_id când pointerul de pe ALOP a rămas pe un flux zombi
        // diferit de fluxul autoritar al DF-ului (formulare_df.flow_id).
        const authoritativeFlow = alop.df_authoritative_flow_id || null;
        const needsResync = authoritativeFlow && authoritativeFlow !== alop.df_flow_id;
        const { rows: up } = await pool.query(`
          UPDATE alop_instances
          SET status = 'lichidare',
              df_completed_at = COALESCE(df_completed_at, NOW()),
              df_flow_id = COALESCE($3, df_flow_id),
              updated_at = NOW(),
              updated_by = $2
          WHERE id = $1
            AND status IN ('draft', 'angajare')
          RETURNING status, df_completed_at, df_flow_id
        `, [req.params.id, actor.userId, needsResync ? authoritativeFlow : null]);
        if (up[0]) {
          alop.status = up[0].status;
          alop.df_completed_at = up[0].df_completed_at;
          alop.df_flow_id = up[0].df_flow_id;
          logger.info(`[ALOP] lazy auto-tranziție ${fromStatus}→lichidare (STS), id=${req.params.id}${needsResync ? ' + resync df_flow_id' : ''}`);
        }
      } catch (autoErr) {
        logger.warn({ err: autoErr }, '[ALOP] lazy tranziție lichidare failed (non-fatal)');
      }
    }

    // ── Self-heal #1 (v3.9.517): ord_id orphan recovery ──────────────────────
    // Scenariu: status='ordonantare' AND ord_id IS NULL, dar există un ORD
    // orfan (df_id=alop.df_id, ne-asociat altui ALOP/ciclu activ) → link automat.
    // Heuristic: pickeăm DOAR dacă există EXACT 1 candidat orfan
    // (2+ = ambiguitate → log warn, lasă user-ul să decidă manual).
    // Idempotent: UPDATE cu guard `AND ord_id IS NULL` în WHERE.
    if (alop.status === 'ordonantare' && !alop.ord_id && alop.df_id) {
      try {
        const { rows: cands } = await pool.query(`
          SELECT fo.id, fo.flow_id,
            CASE WHEN fo.flow_id IS NOT NULL AND (
              f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true
            ) THEN true ELSE false END AS aprobat
          FROM formulare_ord fo
          LEFT JOIN flows f ON f.id::text = fo.flow_id
          WHERE fo.df_id  = $1
            AND fo.org_id = $2
            AND fo.deleted_at IS NULL
            AND fo.status <> 'anulat'
            AND NOT EXISTS (
              SELECT 1 FROM alop_instances a2
              WHERE a2.ord_id = fo.id AND a2.cancelled_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM alop_ord_cicluri c WHERE c.ord_id = fo.id
            )
          ORDER BY fo.created_at DESC
          LIMIT 2
        `, [alop.df_id, alop.org_id]);

        if (cands.length === 1) {
          const cand = cands[0];
          const sets = ['ord_id = $1', 'updated_at = NOW()', 'updated_by = $2'];
          const vals = [cand.id, actor.userId];
          let p = 3;
          if (cand.flow_id) {
            sets.push(`ord_flow_id = $${p++}`);
            vals.push(cand.flow_id);
          }
          const willTransitionToPlata = !!cand.aprobat;
          if (willTransitionToPlata) {
            sets.push(`status = 'plata'`, `ord_completed_at = NOW()`);
          }
          vals.push(req.params.id);
          const { rows: linked } = await pool.query(`
            UPDATE alop_instances
            SET ${sets.join(', ')}
            WHERE id = $${p}
              AND status = 'ordonantare'
              AND ord_id IS NULL
            RETURNING ord_id, ord_flow_id, status, ord_completed_at
          `, vals);

          if (linked[0]) {
            alop.ord_id           = linked[0].ord_id;
            alop.ord_flow_id      = linked[0].ord_flow_id;
            alop.status           = linked[0].status;
            alop.ord_completed_at = linked[0].ord_completed_at;
            if (willTransitionToPlata) alop.ord_aprobat = true;
            logger.info({
              alopId: req.params.id, ordId: cand.id, flowId: cand.flow_id,
              aprobat: cand.aprobat, newStatus: linked[0].status,
            }, '[ALOP] self-heal #1: orphan ORD auto-linked');
            if (willTransitionToPlata) {
              try {
                const r = await _opmeMatcher.tryAutoConfirmAlop(req.params.id, { actorUserId: actor.userId });
                if (r?.confirmed) logger.info({ alopId: req.params.id }, '[ALOP] OPME auto-confirm (self-heal #1)');
              } catch (mErr) {
                logger.warn({ err: mErr, alopId: req.params.id }, '[ALOP] OPME auto-confirm failed (non-fatal, self-heal #1)');
              }
            }
          }
        } else if (cands.length > 1) {
          logger.warn({
            alopId: req.params.id, dfId: alop.df_id, candidateCount: cands.length,
          }, '[ALOP] self-heal #1: ambiguous (multiple orphan ORDs), skipped');
        }
      } catch (healErr) {
        logger.warn({ err: healErr, alopId: req.params.id }, '[ALOP] self-heal #1 orphan ORD failed (non-fatal)');
      }
    }

    // ── Self-heal #2 (v3.9.517): ord_flow_id back-fill ───────────────────────
    // Scenariu: status='ordonantare' AND ord_id setat AND ord_flow_id NULL, dar
    // formulare_ord.flow_id e setat (link-ord-flow s-a ratat). Idempotent prin
    // guard `AND ord_flow_id IS NULL` în WHERE.
    if (alop.status === 'ordonantare' && alop.ord_id && !alop.ord_flow_id) {
      try {
        const { rows: fo } = await pool.query(`
          SELECT fo.flow_id,
            (f.data->>'status' = 'cancelled') AS flow_cancelled,
            CASE WHEN fo.flow_id IS NOT NULL AND (
              f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true
            ) THEN true ELSE false END AS aprobat
          FROM formulare_ord fo
          LEFT JOIN flows f ON f.id::text = fo.flow_id
          WHERE fo.id=$1 AND fo.org_id=$2 AND fo.deleted_at IS NULL
        `, [alop.ord_id, alop.org_id]);

        // NU re-popula ord_flow_id dintr-un flux ANULAT (fix 9): la cancelul fluxului ORD,
        // lifecycle.mjs eliberează intenționat ord_flow_id pe ALOP, dar formulare_ord.flow_id
        // rămâne (paritate DF). Fără acest guard, self-heal #2 ar resuscita pointerul mort.
        if (fo[0]?.flow_id && !fo[0].flow_cancelled) {
          const sets = ['ord_flow_id = $1', 'updated_at = NOW()', 'updated_by = $2'];
          const vals = [fo[0].flow_id, actor.userId];
          const willTransitionToPlata = !!fo[0].aprobat;
          if (willTransitionToPlata) {
            sets.push(`status = 'plata'`, `ord_completed_at = NOW()`);
          }
          vals.push(req.params.id);
          const { rows: linked } = await pool.query(`
            UPDATE alop_instances
            SET ${sets.join(', ')}
            WHERE id = $${vals.length}
              AND ord_flow_id IS NULL
              AND status = 'ordonantare'
            RETURNING ord_flow_id, status, ord_completed_at
          `, vals);
          if (linked[0]) {
            alop.ord_flow_id      = linked[0].ord_flow_id;
            alop.status           = linked[0].status;
            alop.ord_completed_at = linked[0].ord_completed_at;
            if (willTransitionToPlata) alop.ord_aprobat = true;
            logger.info({
              alopId: req.params.id, flowId: fo[0].flow_id, aprobat: fo[0].aprobat,
            }, '[ALOP] self-heal #2: ord_flow_id back-filled');
            if (willTransitionToPlata) {
              try {
                const r = await _opmeMatcher.tryAutoConfirmAlop(req.params.id, { actorUserId: actor.userId });
                if (r?.confirmed) logger.info({ alopId: req.params.id }, '[ALOP] OPME auto-confirm (self-heal #2)');
              } catch (mErr) {
                logger.warn({ err: mErr, alopId: req.params.id }, '[ALOP] OPME auto-confirm failed (non-fatal, self-heal #2)');
              }
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e, alopId: req.params.id }, '[ALOP] self-heal #2 ord_flow_id failed (non-fatal)');
      }
    }

    // ORD aprobat dar ALOP încă în ordonantare → plata.
    // Robustețe (paritate cu DF): ord_aprobat se bazează pe fluxul autoritar al
    // ORD-ului (formulare_ord.flow_id), nu pe ord_flow_id-ul potențial stale de pe ALOP.
    // Resync ord_flow_id când pointerul a rămas pe un flux zombi diferit de cel autoritar.
    if (alop.ord_aprobat && alop.status === 'ordonantare') {
      try {
        const authoritativeOrdFlow = alop.ord_authoritative_flow_id || null;
        const needsResync = authoritativeOrdFlow && authoritativeOrdFlow !== alop.ord_flow_id;
        const { rows: up } = await pool.query(`
          UPDATE alop_instances
          SET status='plata', ord_completed_at=NOW(),
              ord_flow_id = COALESCE($3, ord_flow_id),
              updated_at=NOW(), updated_by=$2
          WHERE id=$1 AND status='ordonantare'
          RETURNING status, ord_completed_at, ord_flow_id
        `, [req.params.id, actor.userId, needsResync ? authoritativeOrdFlow : null]);
        if (up[0]) {
          alop.status = up[0].status;
          alop.ord_completed_at = up[0].ord_completed_at;
          alop.ord_flow_id = up[0].ord_flow_id;
          logger.info(`[ALOP] lazy auto-tranziție ordonantare→plata (STS), id=${req.params.id}${needsResync ? ' + resync ord_flow_id' : ''}`);
          // Pachet B: încearcă absorbția liniilor OPME deja existente
          try {
            const r = await _opmeMatcher.tryAutoConfirmAlop(req.params.id, { actorUserId: actor.userId });
            if (r?.confirmed) logger.info({ alopId: req.params.id }, '[ALOP] OPME auto-confirm (lazy)');
          } catch (mErr) {
            logger.warn({ err: mErr, alopId: req.params.id },
              '[ALOP] OPME auto-confirm failed (non-fatal)');
          }
        }
      } catch (autoErr) {
        logger.warn({ err: autoErr }, '[ALOP] lazy tranziție plata failed (non-fatal)');
      }
    }

    // Calcul sumă rămasă de ordonanțat (pentru multi-ORD)
    const dfVal = parseFloat(alop.df_valoare || 0);
    const sumaPlatita = parseFloat(alop.suma_platita_total || 0);
    alop.ramas = dfVal > 0 ? Math.max(0, dfVal - sumaPlatita) : 0;

    alop.capabilities = computeAlopCapabilities(alop, actor);
    res.json({ alop });
  } catch (e) {
    logger.error({ err: e }, 'alop get error');
    res.status(500).json({ error: e.message || 'server_error' });
  }
});

// ── POST /api/alop/:id/titlu — editează titlul ALOP (metadata, oricând) ──────
router.post('/api/alop/:id/titlu', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const titlu = String(req.body?.titlu || '').trim();
    if (!titlu) return res.status(400).json({ error: 'titlu_obligatoriu' });
    if (titlu.length > 300) return res.status(400).json({ error: 'titlu_prea_lung' });

    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows } = await pool.query(
      `UPDATE alop_instances SET titlu=$1, updated_at=NOW(), updated_by=$4
       WHERE id=$2 AND org_id=$3 RETURNING id, titlu`,
      [titlu, req.params.id, actor.orgId, actor.userId]
    );
    res.json({ ok: true, alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop titlu update error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-df — leagă DF, status → angajare ─────────────────
router.post('/api/alop/:id/link-df', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { df_id } = req.body;
    if (!df_id) return res.status(400).json({ error: 'df_id obligatoriu' });

    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows: dfRows } = await pool.query(
      'SELECT id FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [df_id, actor.orgId]
    );
    if (!dfRows[0]) return res.status(404).json({ error: 'df_not_found' });

    const { rows: conflict } = await pool.query(
      `SELECT id FROM alop_instances WHERE df_id=$1 AND id!=$2 AND cancelled_at IS NULL`,
      [df_id, req.params.id]
    );
    if (conflict.length > 0) {
      return res.status(409).json({
        error: 'df_deja_legat',
        message: 'Acest DF este deja asociat unui alt ALOP activ.'
      });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_id = $1,
          updated_at = NOW(),
          updated_by = $4,
          status = CASE WHEN status = 'draft' THEN 'angajare' ELSE status END
      WHERE id = $2 AND org_id = $3
        AND (df_id IS NULL OR df_id = $1)
      RETURNING *
    `, [df_id, req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-df error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-df-flow — leagă fluxul de semnare DF ─────────────
router.post('/api/alop/:id/link-df-flow', _csrf, async (req, res) => {
  console.log('🔗 LINK-DF-FLOW called:', req.params.id, 'flow_id:', req.body?.flow_id);
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flow_id } = req.body;
    if (!flow_id) return res.status(400).json({ error: 'flow_id obligatoriu' });

    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_flow_id=$1, updated_at=NOW(), updated_by=$4
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    // Copiază atașamentele DF→flux pe calea ALOP (necondiționat). Complementar cu
    // linkFlowFormular (happy path), care dă 409 când docul nu e completed / e deja pe flux.
    // Idempotent prin NOT EXISTS(flow_id, filename) în helper; non-fatal.
    if (alopRows[0].df_id) {
      try {
        await copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: 'df', formId: alopRows[0].df_id });
      } catch (e) { logger.warn({ err: e, alopId: req.params.id }, '[ALOP] copiere atașamente DF→flux non-fatal'); }
    }

    // Persistă starea DF „pe flux" (ASIMETRIE DF: transmis_flux = status REAL, nu derivat).
    // Mirror al linkFlowFormular, dar pe calea ALOP necondiționată (linkFlowFormular dă 409 aici).
    // Idempotent: flip DOAR completed→transmis_flux. Gardă anti-deturnare: nu pe un flux DIFERIT.
    if (alopRows[0].df_id) {
      try {
        const { rows: dfFlip } = await pool.query(
          `UPDATE formulare_df
             SET flow_id = $1,
                 status  = 'transmis_flux',
                 updated_at = NOW(), updated_by = $4
           WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL
             AND status = 'completed'
             AND (flow_id IS NULL OR flow_id = $1)
           RETURNING id`,
          [flow_id, alopRows[0].df_id, actor.orgId, actor.userId]
        );
        if (dfFlip[0]) {
          await recordFormularAudit({
            orgId: actor.orgId, formType: 'df', formId: alopRows[0].df_id,
            actorId: actor.userId, actorEmail: actor.email,
            eventType: 'transmis_flux', fromStatus: 'completed', toStatus: 'transmis_flux',
            meta: { flow_id, via: 'alop_link_df_flow' },
          });
        }
      } catch (e) {
        logger.warn({ err: e, alopId: req.params.id }, '[ALOP] DF status→transmis_flux non-fatal');
      }
    }

    // Dacă fluxul e deja completat, tranziționează imediat la lichidare
    try {
      const { rows: flowRows } = await pool.query(
        `SELECT id FROM flows WHERE id=$1 AND (
          data->>'status' = 'completed'
          OR (data->>'completed')::boolean = true
        )`,
        [flow_id]
      );
      if (flowRows[0]) {
        await pool.query(`
          UPDATE alop_instances
          SET status='lichidare', df_completed_at=NOW(), updated_at=NOW(), updated_by=$3
          WHERE id=$1 AND org_id=$2 AND status IN ('draft','angajare')
        `, [req.params.id, actor.orgId, actor.userId]);
        logger.info(`[ALOP] link-df-flow: flux deja completat → lichidare, id=${req.params.id}`);
      }
    } catch (linkErr) {
      logger.warn({ err: linkErr }, '[ALOP] link-df-flow: auto-lichidare check failed (non-fatal)');
    }

    // Re-fetch după posibil update
    const { rows: updated } = await pool.query(
      'SELECT * FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    res.json({ ok: true, alop: updated[0] || rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-df-flow error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/df-completed — DF semnat complet → status: lichidare ───
router.post('/api/alop/:id/df-completed', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_completed_at=NOW(), status='lichidare', updated_at=NOW(), updated_by=$3
      WHERE id=$1 AND org_id=$2 AND df_flow_id IS NOT NULL AND status='angajare'
      RETURNING *
    `, [req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(400).json({ error: 'df_flow_necesar_sau_status_invalid' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop df-completed error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/confirma-lichidare → status: ordonantare ──────────────
router.post('/api/alop/:id/confirma-lichidare', _csrf, async (req, res) => {
  if (!req.params.id || req.params.id === 'null' || req.params.id === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    // Guard: doar lichidare_confirmed_by sau admin/org_admin
    const { rows: cur } = await pool.query(
      'SELECT lichidare_confirmed_by, status FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!cur[0]) return res.status(404).json({ error: 'not_found' });
    const isAdmin = ['admin', 'org_admin'].includes(actor.role);
    const isAssigned = cur[0].lichidare_confirmed_by === actor.userId;
    if (!isAdmin && !isAssigned && cur[0].lichidare_confirmed_by !== null) {
      const { rows: alopRow } = await pool.query(
        'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1', [req.params.id]
      );
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRow[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: 'forbidden' });
    }
    logger.info({ alopId: req.params.id, currentStatus: cur[0].status }, 'confirma-lichidare attempt');

    const { notes, observatii, nr_factura, data_factura, nr_pv, data_pv, valoare_factura } = req.body;

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET lichidare_confirmed_by=$1,
          lichidare_confirmed_at=NOW(),
          lichidare_notes=$2,
          lichidare_nr_factura=$3,
          lichidare_data_factura=$4,
          lichidare_nr_pv=$5,
          lichidare_data_pv=$6,
          lichidare_valoare_factura=$9,
          status='ordonantare',
          updated_at=NOW(),
          updated_by=$1
      WHERE id=$7 AND org_id=$8 AND status IN ('lichidare','ordonantare')
      RETURNING *
    `, [actor.userId, observatii || notes || '', nr_factura || null, data_factura || null, nr_pv || null, data_pv || null, req.params.id, actor.orgId, (valoare_factura != null && Number.isFinite(Number(valoare_factura))) ? Number(valoare_factura) : null]);

    if (!rows[0]) {
      logger.warn({ alopId: req.params.id, currentStatus: cur[0].status }, 'confirma-lichidare status_invalid — no row updated');
      return res.status(400).json({ error: 'status_invalid' });
    }

    // FEAT Facturi: notifică Serviciul Buget (compartimentul CAB al org-ului) la PRIMA
    // confirmare de lichidare cu factură. Gardă anti-dublare: doar când statusul anterior
    // era 'lichidare' (o re-salvare din 'ordonantare' nu re-notifică). Non-fatal.
    try {
      const firstConfirm = cur[0].status === 'lichidare';
      const nrFact = (nr_factura || '').toString().trim();
      if (firstConfirm && nrFact) {
        const cabComp = await loadOrgCabComp(pool, actor.orgId);
        if (cabComp) {
          const { rows: cabUsers } = await pool.query(
            `SELECT id FROM users
              WHERE org_id=$1 AND deleted_at IS NULL
                AND TRIM(compartiment) = $2 AND TRIM(compartiment) <> ''
                AND id <> $3`,
            [actor.orgId, cabComp, actor.userId]
          );
          const dfId = rows[0].df_id || null;
          const titlu = rows[0].titlu || 'ALOP';
          const dataFactTxt = data_factura
            ? ' din ' + new Date(data_factura).toLocaleDateString('ro-RO')
            : '';
          const valFact = (valoare_factura != null && Number.isFinite(Number(valoare_factura))) ? Number(valoare_factura) : null;
          const valTxt = valFact != null
            ? ', valoare ' + new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(valFact) + ' RON'
            : '';
          const notifData = {
            form_type: 'df',            // click-through → deschide DF-ul legat
            form_id: dfId,
            alop_id: req.params.id,
            nr_factura: nrFact,
            data_factura: data_factura || null,
            valoare_factura: valFact,
          };
          for (const u of cabUsers) {
            await sendNotif(
              u.id,
              'alop_factura_lichidata',
              '🧾 Factură lichidată',
              `Factura nr. ${nrFact}${dataFactTxt}${valTxt} a fost lichidată — ALOP „${titlu}".`,
              notifData
            );
          }
        }
      }
    } catch (notifErr) {
      logger.warn({ err: notifErr, alopId: req.params.id }, '[Facturi] notificare CAB lichidare non-fatal');
    }

    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop confirma-lichidare error');
    res.status(500).json({ error: e.message || 'server_error' });
  }
});

// ── POST /api/alop/:id/link-ord — leagă ORD ──────────────────────────────────
router.post('/api/alop/:id/link-ord', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { ord_id } = req.body;
    if (!ord_id) return res.status(400).json({ error: 'ord_id obligatoriu' });

    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows: ordRows } = await pool.query(
      'SELECT id FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [ord_id, actor.orgId]
    );
    if (!ordRows[0]) return res.status(404).json({ error: 'ord_not_found' });

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_id=$1, updated_at=NOW(), updated_by=$4
      WHERE id=$2 AND org_id=$3
        AND (ord_id IS NULL OR ord_id = $1)
      RETURNING *
    `, [ord_id, req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-ord error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-ord-flow — leagă fluxul de semnare ORD ───────────
router.post('/api/alop/:id/link-ord-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flow_id } = req.body;
    if (!flow_id) return res.status(400).json({ error: 'flow_id obligatoriu' });

    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_flow_id=$1, updated_at=NOW(), updated_by=$4
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    // Copiază atașamentele ORD→flux pe calea ALOP (necondiționat). Complementar cu
    // linkFlowFormular (happy path), care dă 409 când docul nu e completed / e deja pe flux.
    // Idempotent prin NOT EXISTS(flow_id, filename) în helper; non-fatal.
    if (alopRows[0].ord_id) {
      try {
        await copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: 'ord', formId: alopRows[0].ord_id });
      } catch (e) { logger.warn({ err: e, alopId: req.params.id }, '[ALOP] copiere atașamente ORD→flux non-fatal'); }
    }

    res.json({ ok: true, alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-ord-flow error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/ord-completed — ORD semnat complet → status: plata ─────
router.post('/api/alop/:id/ord-completed', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_completed_at=NOW(), status='plata', updated_at=NOW(), updated_by=$3
      WHERE id=$1 AND org_id=$2 AND ord_flow_id IS NOT NULL AND status='ordonantare'
      RETURNING *
    `, [req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(400).json({ error: 'ord_flow_necesar_sau_status_invalid' });

    // Pachet B: încearcă absorbția liniilor OPME deja existente
    try {
      const r = await _opmeMatcher.tryAutoConfirmAlop(req.params.id, { actorUserId: actor.userId });
      if (r?.confirmed) logger.info({ alopId: req.params.id }, '[ALOP] OPME auto-confirm (ord-completed)');
    } catch (mErr) {
      logger.warn({ err: mErr, alopId: req.params.id },
        '[ALOP] OPME auto-confirm failed (non-fatal)');
    }

    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop ord-completed error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Helper privat: aplică side-effects de confirmare plată ───────────────────
// Folosit de:
//   • endpoint-ul manual POST /api/alop/:id/confirma-plata (source='manual')
//   • matcher-ul OPME (source='opme_auto', pachet B)
// Garda WHERE include plata_confirmed_at IS NULL pentru idempotență sub race.
// Returnează row-ul actualizat sau null (deja confirmat / status diferit / not found).
export async function applyPlataConfirmedSideEffects(executor, alopId, orgId, payload) {
  const {
    userId,
    notes = '',
    nr_ordin_plata = null,
    data_plata = null,
    suma_efectiva = null,
    observatii = null,
    source = 'manual',
  } = payload || {};
  const { rows } = await executor.query(`
    UPDATE alop_instances
    SET plata_confirmed_by=$1,
        plata_confirmed_at=NOW(),
        plata_notes=$2,
        plata_nr_ordin=$3,
        plata_data=$4,
        plata_suma_efectiva=$5,
        plata_observatii=$6,
        plata_source=$9,
        status='completed',
        completed_at=NOW(),
        updated_at=NOW(),
        updated_by=$1
    WHERE id=$7 AND org_id=$8
      AND status='plata'
      AND plata_confirmed_at IS NULL
    RETURNING *
  `, [
    userId,
    notes,
    nr_ordin_plata,
    data_plata,
    suma_efectiva,
    observatii,
    alopId,
    orgId,
    source,
  ]);
  return rows[0] || null;
}

// ── POST /api/alop/:id/confirma-plata → status: completed ────────────────────
router.post('/api/alop/:id/confirma-plata', _csrf, async (req, res) => {
  if (!req.params.id || req.params.id === 'null' || req.params.id === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp, { cabComp });
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { notes, nr_ordin_plata, data_plata, suma_efectiva, observatii } = req.body;
    const sumaEfectivaNum = (suma_efectiva === undefined || suma_efectiva === null || suma_efectiva === '')
      ? null : Number(suma_efectiva);

    // P0.2: tranzacție explicită cu FOR UPDATE pe rândul ALOP — serializează
    // confirmarea manuală cu confirmarea OPME (opme-matcher blochează același rând)
    // și previne dubla confirmare sub race. Garda din applyPlataConfirmedSideEffects
    // (status='plata' AND plata_confirmed_at IS NULL) rămâne sursa de idempotență.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: locked } = await client.query(
        `SELECT id, status, plata_confirmed_at, ord_id
           FROM alop_instances WHERE id=$1 AND org_id=$2 FOR UPDATE`,
        [req.params.id, actor.orgId]
      );
      if (!locked[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not_found' });
      }

      // P0.2 / decizie owner: plată ≤ ordonanțat (block hard). Totalul ORD =
      // SUM(rows.suma_ordonantata_plata) al ORD-ului legat. Skip dacă plata nu e
      // furnizată (null) sau ORD-ul nu are valoare (total 0 — fără rânduri/ORD).
      if (sumaEfectivaNum != null && locked[0].ord_id) {
        const { rows: ordTot } = await client.query(
          `SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata','')::numeric),0) AS ord_total
             FROM formulare_ord fo
             LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
            WHERE fo.id=$1`,
          [locked[0].ord_id]
        );
        const ordTotal = Number(ordTot[0]?.ord_total || 0);
        if (ordTotal > 0 && sumaEfectivaNum > ordTotal + 0.01) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'plata_peste_ord',
            message: `Suma plătită (${sumaEfectivaNum.toFixed(2)} RON) depășește suma ordonanțată (${ordTotal.toFixed(2)} RON).`,
            suma: sumaEfectivaNum,
            ord_total: ordTotal,
          });
        }
      }

      const row = await applyPlataConfirmedSideEffects(client, req.params.id, actor.orgId, {
        userId: actor.userId,
        notes: observatii || notes || '',
        nr_ordin_plata: nr_ordin_plata || null,
        data_plata: data_plata || null,
        suma_efectiva: sumaEfectivaNum,
        observatii: observatii || null,
        source: 'manual',
      });

      if (!row) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'status_invalid' });
      }
      await client.query('COMMIT');
      res.json({ ok: true, alop: row });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch {}
      throw txErr;
    } finally {
      client.release();
    }
  } catch (e) {
    logger.error({ err: e }, 'alop confirma-plata error');
    res.status(500).json({ error: e.message || 'server_error' });
  }
});

// ── POST /api/alop/:id/noua-lichidare — pornește un nou ciclu ORD pe același DF ─
router.post('/api/alop/:id/noua-lichidare', _csrf, async (req, res) => {
  if (!req.params.id || req.params.id === 'null') return res.status(400).json({ error: 'id_invalid' });
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    // P0.2: read-modify-write pe sume (buget an exercițiu → ramas → arhivare ciclu →
    // reset) rulează într-o tranzacție explicită cu FOR UPDATE pe rândul ALOP. Previne
    // dubla arhivare la apeluri concurente (ambele ar fi trecut de garda ramas>0) și
    // serializează cu confirma-plata/OPME (care blochează același rând).
    const client = await pool.connect();
    let updated = null, ramas = 0, newCicluId = null, cicluNr = 1;
    try {
      await client.query('BEGIN');
      const { rows: [alop] } = await client.query(
        'SELECT * FROM alop_instances WHERE id=$1 AND org_id=$2 AND cancelled_at IS NULL FOR UPDATE',
        [req.params.id, actor.orgId]
      );
      if (!alop) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
      {
        const { actorComp, cabComp } = await loadActorCompAndCab(client, actor.userId, actor.orgId);
        const authz = await canEditAlop(client, actor, alop, actorComp, { cabComp });
        if (!authz.allowed) { await client.query('ROLLBACK'); return res.status(403).json({ error: authz.reason }); }
      }
      if (alop.status !== 'completed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'status_invalid', message: 'ALOP trebuie să fie finalizat (plată efectuată).' });
      }

      // PLAFON = CREDITE BUGETARE col.10 (fix 12, v3.9.582): plafonul efectiv pentru
      // ordonanțare/plată = SUM(formulare_df.rows_ctrl[].sum_rezv_crdt_bug_act) al DF-ului
      // aprobat (credite bugetare an curent), NU banda `rows_plati` (aceea = baza CARDULUI),
      // NU angajamentul total (rows_val), NU creditele de angajament col.7. INDIFERENT de
      // bifa „Stingere". După o revizie de DF, alop.df_id pointează deja la revizia activă.
      const anExercitiu = new Date().getFullYear();
      const { rows: [dfRow] } = await client.query(
        `SELECT df.rows_ctrl FROM formulare_df df WHERE df.id=$1`,
        [alop.df_id]
      );
      const bugetAnCurent = crediteBugetareAnCurent(dfRow?.rows_ctrl) || 0;

      // Suma ORDONANȚATĂ (NU plătită — distincție owner) în ACELAȘI an de exercițiu: ciclurile
      // arhivate (JOIN ord_id → SUM rows.suma_ordonantata_plata, fiindcă ciclul nu stochează
      // direct suma ordonanțată) filtrate pe an + ORD-ul curent (alop.ord_id, exercițiul în curs).
      const { rows: [ordRow] } = await client.query(
        `SELECT
           COALESCE((
             SELECT SUM(co.s)
               FROM alop_ord_cicluri c
               CROSS JOIN LATERAL (
                 SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
                   FROM formulare_ord fo
                   LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
                  WHERE fo.id = c.ord_id
               ) co
              WHERE c.alop_id=$1
                AND COALESCE(c.an_exercitiu, EXTRACT(YEAR FROM c.plata_data)::int, EXTRACT(YEAR FROM c.created_at)::int) = $2
           ), 0) AS arhivat,
           COALESCE((
             SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
               FROM formulare_ord fo
               LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
              WHERE fo.id=$3
           ), 0) AS curent`,
        [req.params.id, anExercitiu, alop.ord_id]
      );
      const sumaOrdonantata = parseFloat(ordRow?.arhivat || 0) + parseFloat(ordRow?.curent || 0);

      // Suma PLĂTITĂ în ACELAȘI an (cumul per an) — pentru suma_totala_platita (audit plăți),
      // NU pentru plafon. Păstrată separat de suma ordonanțată.
      const { rows: [sumaRow] } = await client.query(
        `SELECT COALESCE(SUM(plata_suma_efectiva),0) AS total
           FROM alop_ord_cicluri
          WHERE alop_id=$1
            AND COALESCE(an_exercitiu, EXTRACT(YEAR FROM plata_data)::int, EXTRACT(YEAR FROM created_at)::int) = $2`,
        [req.params.id, anExercitiu]
      );
      const sumaPlata = parseFloat(sumaRow?.total || 0)
        + parseFloat(alop.plata_suma_efectiva || 0);

      ramas = bugetAnCurent - sumaOrdonantata;
      if (ramas <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'limita_depasita',
          message: `Creditele bugetare ale anului de exercițiu ${anExercitiu} (${bugetAnCurent} RON) au fost integral ordonanțate.`
        });
      }

      // Arhivează ciclul curent
      cicluNr = alop.ciclu_curent || 1;
      const { rows: cicluRows } = await client.query(`
        INSERT INTO alop_ord_cicluri (
          alop_id, org_id, ciclu_nr, ord_id, ord_flow_id,
          lichidare_confirmed_by, lichidare_confirmed_at,
          lichidare_nr_factura, lichidare_data_factura,
          lichidare_nr_pv, lichidare_data_pv, lichidare_notes,
          plata_confirmed_by, plata_confirmed_at,
          plata_nr_ordin, plata_data, plata_suma_efectiva, plata_observatii,
          plata_source,
          an_exercitiu,
          lichidare_valoare_factura,
          status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'completed')
        RETURNING id
      `, [
        req.params.id, actor.orgId, cicluNr,
        alop.ord_id, alop.ord_flow_id,
        alop.lichidare_confirmed_by, alop.lichidare_confirmed_at,
        alop.lichidare_nr_factura, alop.lichidare_data_factura,
        alop.lichidare_nr_pv, alop.lichidare_data_pv, alop.lichidare_notes,
        alop.plata_confirmed_by, alop.plata_confirmed_at,
        alop.plata_nr_ordin, alop.plata_data,
        alop.plata_suma_efectiva, alop.plata_observatii,
        alop.plata_source || 'manual',
        // an de exercițiu al ciclului arhivat = anul plății efective (fallback: anul curent)
        alop.plata_data ? new Date(alop.plata_data).getFullYear() : anExercitiu,
        alop.lichidare_valoare_factura,
      ]);
      newCicluId = cicluRows[0]?.id;

      // Reset pentru noul ciclu
      ({ rows: [updated] } = await client.query(`
        UPDATE alop_instances SET
          status = 'lichidare',
          ord_id = NULL, ord_flow_id = NULL, ord_completed_at = NULL,
          lichidare_confirmed_by = NULL, lichidare_confirmed_at = NULL,
          lichidare_nr_factura = NULL, lichidare_data_factura = NULL,
          lichidare_nr_pv = NULL, lichidare_data_pv = NULL, lichidare_notes = NULL,
          lichidare_valoare_factura = NULL,
          plata_confirmed_by = NULL, plata_confirmed_at = NULL,
          plata_nr_ordin = NULL, plata_data = NULL,
          plata_suma_efectiva = NULL, plata_observatii = NULL,
          plata_source = 'manual',
          completed_at = NULL,
          suma_totala_platita = $2,
          ciclu_curent = $3,
          updated_at = NOW(),
          updated_by = $4
        WHERE id=$1
        RETURNING *
      `, [req.params.id, sumaPlata, cicluNr + 1, actor.userId]));

      await client.query('COMMIT');
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch {}
      throw txErr;
    } finally {
      client.release();
    }

    // Pachet B: populează matched_ciclu_id pe liniile OPME absorbite în acest ALOP.
    // Rămâne NON-FATAL și DUPĂ COMMIT (pe pool): o eroare aici nu trebuie să rateze
    // arhivarea ciclului deja comisă, iar într-o tranzacție ar fi otrăvit tot blocul.
    if (newCicluId) {
      try {
        await pool.query(`
          UPDATE opme_lines
             SET matched_ciclu_id = $1
           WHERE matched_alop_id  = $2
             AND matched_ciclu_id IS NULL
        `, [newCicluId, req.params.id]);
      } catch (mErr) {
        logger.warn({ err: mErr, alopId: req.params.id, cicluId: newCicluId },
          '[ALOP] noua-lichidare: backfill matched_ciclu_id failed (non-fatal)');
      }
    }

    logger.info({ alopId: req.params.id, ciclu: cicluNr + 1, ramas }, '[ALOP] nouă lichidare pornită');
    res.json({ ok: true, alop: updated, ramas });
  } catch (e) {
    logger.error({ err: e }, 'alop noua-lichidare error');
    res.status(500).json({ error: e.message || 'server_error' });
  }
});

// ── POST /api/alop/:id/cancel ─────────────────────────────────────────────────
// ── POST /api/alop/admin/repair-status — reparare status ALOP pentru fluxuri deja semnate ─
router.post('/api/alop/admin/repair-status', _alopAdminRateLimit, _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!['admin','org_admin'].includes(actor.role)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await pool.query(`
      UPDATE alop_instances a
      SET status = CASE
            WHEN a.ord_flow_id IS NOT NULL
              AND EXISTS(
                SELECT 1 FROM flows f
                WHERE f.id::text = a.ord_flow_id
                  AND (f.data->>'completed')::boolean = true
              ) THEN 'plata'
            WHEN a.df_flow_id IS NOT NULL
              AND EXISTS(
                SELECT 1 FROM flows f
                WHERE f.id::text = a.df_flow_id
                  AND (f.data->>'completed')::boolean = true
              ) THEN 'lichidare'
            ELSE a.status
          END,
          updated_at = NOW(),
          updated_by = $2
      WHERE a.cancelled_at IS NULL
        AND a.status IN ('draft','angajare','ordonantare')
        AND ($1::integer IS NULL OR a.org_id = $1)
      RETURNING id, status
    `, [actor.role === 'admin' ? null : actor.orgId, actor.userId]);

    // Pachet B: încearcă absorbția pe fiecare ALOP care a ajuns în 'plata'
    for (const row of (r.rows || [])) {
      if (row?.status !== 'plata') continue;
      try {
        const m = await _opmeMatcher.tryAutoConfirmAlop(row.id, { actorUserId: actor.userId });
        if (m?.confirmed) logger.info({ alopId: row.id }, '[ALOP] OPME auto-confirm (repair-status)');
      } catch (mErr) {
        logger.warn({ err: mErr, alopId: row.id },
          '[ALOP] OPME auto-confirm failed (non-fatal)');
      }
    }

    res.json({ repaired: r.rows });
  } catch(e) {
    logger.error({ err: e }, 'alop repair-status error');
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/alop/:id/cancel', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: cur } = await pool.query(
      'SELECT created_by FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!cur[0]) return res.status(404).json({ error: 'not_found' });
    {
      const authz = canDestroyOnly(actor, cur[0]);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    // ALOP se poate ȘTERGE doar dacă NU are DF/ORD legat (pe documente ne-șterse).
    // Păstrăm codul cancel_blocked_df_exists pentru DF (compat. clienți + teste);
    // adăugăm ramura ORD. Refuzul (R0) eliberează df_id=NULL → ștergerea redevine permisă.
    const { rows: dfCheck } = await pool.query(`
      SELECT a.df_id, a.ord_id,
             fd.nr_unic_inreg, fd.status AS df_status,
             fo.nr_ordonant_pl AS ord_nr, fo.status AS ord_status
      FROM alop_instances a
      LEFT JOIN formulare_df  fd ON fd.id = a.df_id  AND fd.deleted_at IS NULL
      LEFT JOIN formulare_ord fo ON fo.id = a.ord_id AND fo.deleted_at IS NULL
      WHERE a.id=$1 AND a.org_id=$2
    `, [req.params.id, actor.orgId]);
    if (dfCheck[0]?.df_id && dfCheck[0]?.df_status) {
      return res.status(409).json({
        error: 'cancel_blocked_df_exists',
        message: `Nu se poate șterge ALOP-ul: există un DF legat (${dfCheck[0].nr_unic_inreg || 'fără nr.'}, status: ${dfCheck[0].df_status}). Ștergeți sau refuzați DF-ul mai întâi.`,
        df_id: dfCheck[0].df_id,
        df_nr: dfCheck[0].nr_unic_inreg,
        df_status: dfCheck[0].df_status,
      });
    }
    if (dfCheck[0]?.ord_id && dfCheck[0]?.ord_status) {
      return res.status(409).json({
        error: 'cancel_blocked_ord_exists',
        message: `Nu se poate șterge ALOP-ul: există o Ordonanțare de Plată legată (${dfCheck[0].ord_nr || 'fără nr.'}, status: ${dfCheck[0].ord_status}). Ștergeți întâi ORD-ul.`,
        ord_id: dfCheck[0].ord_id,
        ord_nr: dfCheck[0].ord_nr,
        ord_status: dfCheck[0].ord_status,
      });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET status='cancelled', cancelled_at=NOW(), updated_at=NOW(), updated_by=$3
      WHERE id=$1 AND org_id=$2 AND status != 'completed'
      RETURNING *
    `, [req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(409).json({ error: 'cancel_blocked', message: 'ALOP completat sau deja anulat' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop cancel error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
