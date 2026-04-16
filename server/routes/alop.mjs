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
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

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

// ── State machine ─────────────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  draft:       ['angajare', 'cancelled'],
  angajare:    ['lichidare', 'cancelled'],
  lichidare:   ['ordonantare', 'cancelled'],
  ordonantare: ['plata', 'cancelled'],
  plata:       ['completed', 'cancelled'],
  completed:   [],
  cancelled:   [],
};
function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// ── GET /api/alop/:id/debug — diagnostic temporar ────────────────────────────
router.get('/api/alop/:id/debug', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        a.id, a.status, a.df_id, a.df_flow_id, a.ord_flow_id,
        a.df_completed_at, a.lichidare_confirmed_at,
        f1.data->>'status' as df_flow_status,
        f1.data->>'allSigned' as df_all_signed,
        fd.status as df_doc_status, fd.aprobat_calc
      FROM alop_instances a
      LEFT JOIN flows f1 ON f1.id = a.df_flow_id
      LEFT JOIN (
        SELECT id, status,
          (flow_id IS NOT NULL AND EXISTS(
            SELECT 1 FROM flows WHERE id=formulare_df.flow_id
            AND data->>'status'='completed'
          )) as aprobat_calc
        FROM formulare_df
      ) fd ON fd.id = a.df_id
      WHERE a.id = $1 AND a.org_id = $2
    `, [req.params.id, actor.orgId]);
    res.json(rows[0] || {});
  } catch (e) {
    logger.error({ err: e }, 'alop debug error');
    res.status(500).json({ error: e.message });
  }
});

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

// ── GET /api/alop/stats — montat ÎNAINTE de /:id ─────────────────────────────
router.get('/api/alop/stats', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                    AS total,
        COUNT(*) FILTER (WHERE status='completed')::int                  AS completate,
        COUNT(*) FILTER (WHERE status IN
          ('angajare','lichidare','ordonantare','plata'))::int            AS in_progres,
        COUNT(*) FILTER (WHERE status='draft')::int                      AS draft
      FROM alop_instances
      WHERE org_id=$1 AND cancelled_at IS NULL
    `, [actor.orgId]);
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
        fo.status        AS ord_status,
        (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
         FROM jsonb_array_elements(COALESCE(df.rows_val,'[]'::jsonb)) r) AS df_valoare,
        (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
         FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r) AS ord_valoare,
        a.plata_suma_efectiva AS op_valoare
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
router.post('/api/alop', _csrf, async (req, res) => {
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

// ── GET /api/alop/:id — detalii ALOP ─────────────────────────────────────────
router.get('/api/alop/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        a.*,
        u.nume   AS creator_name,
        u.email  AS creator_email,
        df.nr_unic_inreg             AS df_nr,
        df.status                    AS df_status,
        df.obiect_fd_reviz_scurt     AS df_obiect,
        df.compartiment_specialitate AS df_compartiment,
        fo.status                    AS ord_status,
        f1.id AS df_flow_exists,
        f2.id AS ord_flow_exists,
        CASE WHEN a.df_flow_id IS NOT NULL AND (
          f1.data->>'status' = 'completed' OR (f1.data->>'completed')::boolean = true
        ) THEN true ELSE false END AS df_aprobat,
        CASE WHEN a.ord_flow_id IS NOT NULL AND (
          f2.data->>'status' = 'completed' OR (f2.data->>'completed')::boolean = true
        ) THEN true ELSE false END AS ord_aprobat,
        ul.nume AS lichidare_by_name,
        up.nume AS plata_by_name,
        (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
         FROM jsonb_array_elements(COALESCE(df.rows_val,'[]'::jsonb)) r) AS df_valoare,
        (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
         FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r) AS ord_valoare,
        a.plata_suma_efectiva AS op_valoare
      FROM alop_instances a
      LEFT JOIN users        u   ON u.id   = a.created_by
      LEFT JOIN formulare_df df  ON df.id  = a.df_id
      LEFT JOIN formulare_ord fo ON fo.id  = a.ord_id
      LEFT JOIN flows        f1  ON f1.id  = a.df_flow_id
      LEFT JOIN flows        f2  ON f2.id  = a.ord_flow_id
      LEFT JOIN users        ul  ON ul.id  = a.lichidare_confirmed_by
      LEFT JOIN users        up  ON up.id  = a.plata_confirmed_by
      WHERE a.id = $1
        AND a.org_id = $2
        AND a.cancelled_at IS NULL
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop get error');
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
          status = CASE WHEN status = 'draft' THEN 'angajare' ELSE status END
      WHERE id = $2 AND org_id = $3
        AND (df_id IS NULL OR df_id = $1)
      RETURNING *
    `, [df_id, req.params.id, actor.orgId]);

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

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_flow_id=$1, updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

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
          SET status='lichidare', df_completed_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND org_id=$2 AND status IN ('draft','angajare')
        `, [req.params.id, actor.orgId]);
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
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_completed_at=NOW(), status='lichidare', updated_at=NOW()
      WHERE id=$1 AND org_id=$2 AND df_flow_id IS NOT NULL AND status='angajare'
      RETURNING *
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(400).json({ error: 'df_flow_necesar_sau_status_invalid' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop df-completed error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/confirma-lichidare → status: ordonantare ──────────────
router.post('/api/alop/:id/confirma-lichidare', _csrf, async (req, res) => {
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
      return res.status(403).json({ error: 'forbidden' });
    }
    logger.info({ alopId: req.params.id, currentStatus: cur[0].status }, 'confirma-lichidare attempt');

    const { notes, observatii, nr_factura, data_factura, nr_pv, data_pv } = req.body;

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET lichidare_confirmed_by=$1,
          lichidare_confirmed_at=NOW(),
          lichidare_notes=$2,
          lichidare_nr_factura=$3,
          lichidare_data_factura=$4,
          lichidare_nr_pv=$5,
          lichidare_data_pv=$6,
          status='ordonantare',
          updated_at=NOW()
      WHERE id=$7 AND org_id=$8 AND status IN ('lichidare','ordonantare')
      RETURNING *
    `, [actor.userId, observatii || notes || '', nr_factura || null, data_factura || null, nr_pv || null, data_pv || null, req.params.id, actor.orgId]);

    if (!rows[0]) {
      logger.warn({ alopId: req.params.id, currentStatus: cur[0].status }, 'confirma-lichidare status_invalid — no row updated');
      return res.status(400).json({ error: 'status_invalid' });
    }
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop confirma-lichidare error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-ord — leagă ORD ──────────────────────────────────
router.post('/api/alop/:id/link-ord', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { ord_id } = req.body;
    if (!ord_id) return res.status(400).json({ error: 'ord_id obligatoriu' });

    const { rows: ordRows } = await pool.query(
      'SELECT id FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [ord_id, actor.orgId]
    );
    if (!ordRows[0]) return res.status(404).json({ error: 'ord_not_found' });

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_id=$1, updated_at=NOW()
      WHERE id=$2 AND org_id=$3
        AND (ord_id IS NULL OR ord_id = $1)
      RETURNING *
    `, [ord_id, req.params.id, actor.orgId]);

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

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_flow_id=$1, updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
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
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_completed_at=NOW(), status='plata', updated_at=NOW()
      WHERE id=$1 AND org_id=$2 AND ord_flow_id IS NOT NULL AND status='ordonantare'
      RETURNING *
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(400).json({ error: 'ord_flow_necesar_sau_status_invalid' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop ord-completed error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/confirma-plata → status: completed ────────────────────
router.post('/api/alop/:id/confirma-plata', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { notes, nr_ordin_plata, data_plata, suma_efectiva, observatii } = req.body;
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET plata_confirmed_by=$1,
          plata_confirmed_at=NOW(),
          plata_notes=$2,
          plata_nr_ordin=$3,
          plata_data=$4,
          plata_suma_efectiva=$5,
          plata_observatii=$6,
          status='completed',
          completed_at=NOW(),
          updated_at=NOW()
      WHERE id=$7 AND org_id=$8 AND status='plata'
      RETURNING *
    `, [actor.userId, observatii || notes || '', nr_ordin_plata || null, data_plata || null,
        suma_efectiva || null, observatii || null, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(400).json({ error: 'status_invalid' });
    res.json({ ok: true, alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop confirma-plata error');
    res.status(500).json({ error: e.message || 'server_error' });
  }
});

// ── POST /api/alop/:id/cancel ─────────────────────────────────────────────────
// ── POST /api/alop/admin/repair-status — reparare status ALOP pentru fluxuri deja semnate ─
router.post('/api/alop/admin/repair-status', _csrf, async (req, res) => {
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
          updated_at = NOW()
      WHERE a.cancelled_at IS NULL
        AND a.status IN ('draft','angajare','ordonantare')
        AND ($1::integer IS NULL OR a.org_id = $1)
      RETURNING id, status
    `, [actor.role === 'admin' ? null : actor.orgId]);
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
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND org_id=$2 AND status != 'completed'
      RETURNING *
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop cancel error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
