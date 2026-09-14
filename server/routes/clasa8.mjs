/**
 * server/routes/clasa8.mjs
 * Endpoint pentru centralizatorul Clasa 8 (read-only, agregator) +
 * gestionare buget importat per versiune.
 * Mount: app.use('/api/clasa8', clasa8Router)
 */

import { Router } from 'express';
import { requireAuth }    from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { requireModule }  from '../middleware/require-module.mjs';
import { logger }         from '../middleware/logger.mjs';
import { pool }           from '../db/index.mjs';
import { getClasa8Aggregate, getBugetDisponibil } from '../services/clasa8.mjs';

const router = Router();

// #202 — anul de exercițiu al bugetului. Explicit în corp/query, cu implicit anul curent:
// cazul real e „în decembrie încarc bugetul pe anul următor", deci nu se poate deriva din ceas.
const AN_MIN = 2000, AN_MAX = 2100;
// #203 — exportat: `admin/flows.mjs` îl importă pentru `/admin/alop/stats?an=`. O singură
// definiție a validării, nu două copii care pot diverge.
export function _parseAn(raw) {
  if (raw === undefined || raw === null || raw === '') return new Date().getFullYear();
  // #203 — doar scalari. Number([2026]) === 2026, deci fără garda asta un array
  // cu un element trecea ca an valid; `?an=` duplicat dădea deja NaN ⇒ 400.
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < AN_MIN || n > AN_MAX) return null; // null = invalid
  return n;
}

// GET /api/clasa8?ssi=&compartiment=&q=&an= (#203: an implicit anul curent)
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    // #203 — anul pe care utilizatorul vrea să-l VADĂ vine din cerere (raport read-only).
    const an = _parseAn(req.query?.an);
    if (an === null) return res.status(400).json({ error: 'an_invalid' });

    const filters = {
      ssi:          typeof req.query.ssi === 'string' ? req.query.ssi : '',
      compartiment: typeof req.query.compartiment === 'string' ? req.query.compartiment : '',
      q:            typeof req.query.q === 'string' ? req.query.q : '',
      an,
    };

    if (filters.ssi.length > 100)          return res.status(400).json({ error: 'ssi_too_long' });
    if (filters.compartiment.length > 200) return res.status(400).json({ error: 'compartiment_too_long' });
    if (filters.q.length > 200)            return res.status(400).json({ error: 'q_too_long' });

    const result = await getClasa8Aggregate(pool, orgId, filters);
    return res.json({ an, ...result });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 aggregate error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/clasa8/buget/disponibil?exclude_df=<uuid?>&an= (#203: an implicit anul curent)
// Read-only — buget disponibil per cod_SSI pentru soft-warning Sec.B (CAB).
router.get('/buget/disponibil', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const excludeDf = typeof req.query.exclude_df === 'string' ? req.query.exclude_df.trim() : '';
    if (excludeDf &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(excludeDf)) {
      return res.status(400).json({ error: 'exclude_df_invalid' });
    }

    const an = _parseAn(req.query?.an);
    if (an === null) return res.status(400).json({ error: 'an_invalid' });

    const result = await getBugetDisponibil(pool, orgId, excludeDf || null, an);
    return res.json({ an, ...result });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget disponibil error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/clasa8/buget/ani — anii cu buget încărcat, pentru selectorul din UI (#203).
// Populat din ce EXISTĂ în bază, nu dintr-o listă generată. `an_curent` vine separat:
// anul curent poate lipsi din `ani` (niciun buget încărcat) și trebuie totuși să fie
// selectabil — centralizatorul are sens și fără buget (coloana BUGET goală).
router.get('/buget/ani', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const { rows } = await pool.query(
      `SELECT DISTINCT an FROM clasa8_buget WHERE org_id = $1 ORDER BY an DESC`,
      [orgId]
    );
    return res.json({ ani: rows.map(r => r.an), an_curent: new Date().getFullYear() });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget ani error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/clasa8/buget/meta?an= — metadate versiune activă a anului (implicit anul curent)
router.get('/buget/meta', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    const { orgId } = req.actor;

    const an = _parseAn(req.query?.an);
    if (an === null)
      return res.status(400).json({ error: 'an_invalid' });

    const { rows } = await pool.query(
      `SELECT v.version_no, v.uploaded_at, v.source_filename,
              v.row_count, v.total_value, u.nume AS uploaded_by_nume
         FROM clasa8_buget_versions v
         LEFT JOIN users u ON u.id = v.uploaded_by
        WHERE v.org_id = $1 AND v.an = $2
          AND EXISTS (SELECT 1 FROM clasa8_buget b WHERE b.version_id = v.id)
        ORDER BY v.version_no DESC LIMIT 1`,
      [orgId, an]
    );

    return res.json({
      an,
      active: rows.length ? {
        version_no:       rows[0].version_no,
        uploaded_at:      rows[0].uploaded_at,
        uploaded_by_nume: rows[0].uploaded_by_nume,
        source_filename:  rows[0].source_filename,
        row_count:        rows[0].row_count,
        total_value:      rows[0].total_value,
      } : null,
    });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget meta error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/clasa8/buget/coduri?an= — pentru datalist DF (implicit anul curent).
// #202: cu doi ani în bază și fără filtru, fiecare cod ar apărea de două ori, cu valori diferite.
router.get('/buget/coduri', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    const { orgId } = req.actor;

    const an = _parseAn(req.query?.an);
    if (an === null)
      return res.status(400).json({ error: 'an_invalid' });

    const { rows } = await pool.query(
      `SELECT cod_ssi, valoare FROM clasa8_buget
        WHERE org_id = $1 AND an = $2 ORDER BY cod_ssi ASC`,
      [orgId, an]
    );

    return res.json({ items: rows.map(r => ({ cod_ssi: r.cod_ssi, valoare: Number(r.valoare) })) });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget coduri error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/clasa8/buget/import — import fișier buget (versionat)
router.post('/buget/import', requireAuth, csrfMiddleware, requireModule('clasa8'), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    const { orgId, userId } = req.actor;

    const { rows: rawRows, filename } = req.body || {};

    // #202 — anul de exercițiu al acestui import.
    const an = _parseAn(req.body?.an);
    if (an === null)
      return res.status(400).json({ error: 'an_invalid', message: `an trebuie să fie un întreg între ${AN_MIN} și ${AN_MAX}` });

    if (!Array.isArray(rawRows) || rawRows.length === 0)
      return res.status(400).json({ error: 'rows_required', message: 'rows trebuie să fie array nenul' });
    if (rawRows.length > 5000)
      return res.status(400).json({ error: 'rows_too_many', message: 'Maximum 5000 rânduri per import' });

    // Deduplicate + validare
    const map = new Map();
    for (const row of rawRows) {
      const cod = String(row.cod_ssi || '').trim();
      const val = Number(row.valoare);
      if (!cod || cod.length > 50)
        return res.status(400).json({ error: 'cod_ssi_invalid', message: `cod_ssi invalid: "${cod}"` });
      if (!isFinite(val) || val < 0 || val > 999_999_999_999.99)
        return res.status(400).json({ error: 'valoare_invalid', message: `valoare invalidă pentru cod "${cod}"` });
      map.set(cod, val);
    }

    const deduped = [...map.entries()];
    const count = deduped.length;
    const total = deduped.reduce((s, [, v]) => s + v, 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: vRows } = await client.query(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_v
           FROM clasa8_buget_versions WHERE org_id = $1`,
        [orgId]
      );
      const nextV = vRows[0].next_v;

      const { rows: ins } = await client.query(
        `INSERT INTO clasa8_buget_versions
           (org_id, version_no, uploaded_by, source_filename, row_count, total_value, an)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, version_no, uploaded_at, an`,
        [orgId, nextV, userId, filename || null, count, Math.round(total * 100) / 100, an]
      );
      const versionId = ins[0].id;

      // #202 — ștergerea e scopată pe AN. Fără `AND an = $2`, importul pe 2027 ar șterge
      // bugetul pe 2026, exact comportamentul pe care lotul ăsta îl repară.
      await client.query('DELETE FROM clasa8_buget WHERE org_id = $1 AND an = $2', [orgId, an]);

      if (deduped.length > 0) {
        const valuePlaceholders = deduped.map((_, i) =>
          `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
        ).join(', ');
        const valueParams = deduped.flatMap(([cod, val]) => [versionId, orgId, cod, val, an]);
        await client.query(
          `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare, an) VALUES ${valuePlaceholders}`,
          valueParams
        );
      }

      await client.query('COMMIT');
      return res.json({
        ok: true,
        version_no:  ins[0].version_no,
        uploaded_at: ins[0].uploaded_at,
        an,
        count,
        total: Math.round(total * 100) / 100,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget import error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/clasa8/buget?an= — șterge bugetul activ al anului (implicit anul curent);
// metadatele versiunilor rămân în istoric. #202: scopat pe an — nu atinge ceilalți ani.
router.delete('/buget', requireAuth, csrfMiddleware, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    const { orgId } = req.actor;

    const an = _parseAn(req.query?.an);
    if (an === null)
      return res.status(400).json({ error: 'an_invalid' });

    const { rowCount } = await pool.query(
      'DELETE FROM clasa8_buget WHERE org_id = $1 AND an = $2',
      [orgId, an]
    );

    return res.json({ ok: true, deleted: rowCount, an });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget delete error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
