/**
 * server/routes/opme.mjs — OPME F1129 import (pachet A)
 *
 * POST /api/opme/import — multipart/form-data, câmp "file" (PDF F1129).
 *   Auth: cookie JWT. CSRF: header X-CSRF-Token.
 *   Role: admin sau utilizator cu rol P2 (gating fin pe compartiment vine în pachet B).
 *   Idempotent prin (org_id, sha256(file)).
 *   Storage: opme_imports + opme_lines (matching = pachet B).
 */

import { Router } from 'express';
import Busboy from 'busboy';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { parseOpmePdf } from '../services/opme-parser.mjs';
import { matchImport, summarizeReport } from '../services/opme-matcher.mjs';

const router = Router();

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function _requireDb(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return true; }
  return false;
}

// Goleste body-ul cand respingem inainte de busboy. Fara asta, clienti
// care au inceput sa stream-ureze multipart-ul primesc ECONNRESET pe socket.
function _drainBody(req) {
  try {
    req.on('error', () => {});
    req.resume();
  } catch {}
}

async function _hasOpmeImportRole(actor) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (actor.role === 'org_admin' && actor.orgId) return true;
  if (!actor.orgId || !actor.userId) return false;
  try {
    const { rows } = await pool.query(`
      SELECT (
        -- Responsabil CAB efectiv (assigned_to)
        EXISTS (
          SELECT 1 FROM formulare_df
           WHERE org_id = $1 AND assigned_to = $2
        ) OR EXISTS (
          SELECT 1 FROM formulare_ord
           WHERE org_id = $1 AND assigned_to = $2
        )
        -- P2-comp: actor are același compartiment ca un Responsabil CAB din org
        OR EXISTS (
          SELECT 1
          FROM users me
          JOIN users p2 ON TRIM(p2.compartiment) = TRIM(me.compartiment)
                        AND TRIM(p2.compartiment) <> ''
          WHERE me.id = $2
            AND p2.org_id = $1
            AND (
              EXISTS (SELECT 1 FROM formulare_df  WHERE org_id = $1 AND assigned_to = p2.id)
              OR EXISTS (SELECT 1 FROM formulare_ord WHERE org_id = $1 AND assigned_to = p2.id)
            )
        )
      ) AS can
    `, [actor.orgId, actor.userId]);
    return rows[0]?.can === true;
  } catch (e) {
    logger.warn({ err: e, userId: actor.userId }, 'opme gating: query failed (fallback deny)');
    return false;
  }
}

router.post('/api/opme/import', csrfMiddleware, async (req, res) => {
  if (_requireDb(res)) { _drainBody(req); return; }
  const actor = requireAuth(req, res);
  if (!actor) { _drainBody(req); return; }
  if (!actor.orgId) { _drainBody(req); return res.status(403).json({ error: 'org_required' }); }
  if (!(await _hasOpmeImportRole(actor))) {
    _drainBody(req);
    return res.status(403).json({ error: 'forbidden', message: 'Doar responsabil CAB sau super-admin pot importa OPME.' });
  }

  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1 } });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_multipart', message: e.message });
  }

  let fileName = null;
  let mimeType = null;
  const chunks = [];
  let limitHit = false;
  let responded = false;
  let gotFile = false;

  function _respond(status, body) {
    if (responded) return;
    responded = true;
    try { req.unpipe(bb); } catch {}
    res.status(status).json(body);
  }

  bb.on('file', (_field, stream, info) => {
    gotFile = true;
    fileName = info?.filename || 'opme.pdf';
    mimeType = (info?.mimeType || info?.mimetype || '').toLowerCase();
    stream.on('data', d => { if (!limitHit) chunks.push(d); });
    stream.on('limit', () => {
      limitHit = true;
      _respond(413, { error: 'file_too_large', max_bytes: MAX_BYTES });
    });
  });

  bb.on('error', e => {
    logger.warn({ err: e }, 'opme import: busboy error');
    _respond(400, { error: 'multipart_error', message: e.message });
  });

  bb.on('finish', async () => {
    if (responded) return;
    if (!gotFile) return _respond(400, { error: 'file_required' });
    if (mimeType && mimeType !== 'application/pdf') {
      return _respond(400, { error: 'invalid_mime', mime: mimeType });
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) return _respond(400, { error: 'file_empty' });
    if (buffer.length > MAX_BYTES) return _respond(413, { error: 'file_too_large', max_bytes: MAX_BYTES });

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Idempotency: dacă e duplicat în aceeași org, întoarcem 409 cu id-ul existent.
    try {
      const { rows: dup } = await pool.query(
        'SELECT id, created_at FROM opme_imports WHERE org_id=$1 AND file_hash=$2',
        [actor.orgId, fileHash]
      );
      if (dup.length) {
        return _respond(409, {
          error: 'duplicate_import',
          existing_import_id: dup[0].id,
          created_at: dup[0].created_at,
        });
      }
    } catch (e) {
      logger.error({ err: e }, 'opme import: duplicate check failed');
      return _respond(500, { error: 'server_error' });
    }

    let parsed;
    try {
      parsed = await parseOpmePdf(buffer);
    } catch (e) {
      const code = e?.code || 'OPME_PARSE_FAILED';
      const detail = e?.detail || e?.message || null;
      const status = (code === 'OPME_NOT_XFA' || code === 'OPME_INVALID_TEMPLATE') ? 400
                   : (code === 'OPME_VALIDATION_FAILED') ? 422
                   : 500;
      logger.warn({ code, detail, fileName }, 'opme import: parse error');
      return _respond(status, { error: code, detail });
    }

    const { header, lines, raw_meta } = parsed;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ins } = await client.query(
        `INSERT INTO opme_imports
           (org_id, uploaded_by, file_hash, file_name,
            nr_document, data_op, an_r, luna_r,
            cif_platitor, den_platitor, adresa_platitor,
            nr_inregistrari, suma_totala, universal_code, raw_meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, created_at`,
        [
          actor.orgId, actor.userId, fileHash, fileName,
          header.nr_document, header.data_op, header.an_r, header.luna_r,
          header.cif_platitor, header.den_platitor, header.adresa_platitor,
          header.nr_inregistrari, header.suma_totala, header.universal_code,
          raw_meta,
        ]
      );
      const importId = ins[0].id;

      if (lines.length) {
        // Bulk insert via UNNEST (un singur round-trip).
        const cols = [
          'row_index', 'nr_op', 'iban_platitor', 'den_trezorerie',
          'cod_program', 'cod_angajament', 'indicator_angajament',
          'den_beneficiar', 'cif_beneficiar', 'iban_beneficiar',
          'den_banca_trez', 'suma_op', 'nr_evid_platii', 'explicatii',
        ];
        const arrs = cols.map(c => lines.map(l => l[c]));
        // $1=importId, $2=orgId, $3..=arrays
        const params = [importId, actor.orgId, ...arrs];
        await client.query(
          `INSERT INTO opme_lines (
              opme_import_id, org_id, row_index, nr_op, iban_platitor, den_trezorerie,
              cod_program, cod_angajament, indicator_angajament,
              den_beneficiar, cif_beneficiar, iban_beneficiar,
              den_banca_trez, suma_op, nr_evid_platii, explicatii)
           SELECT $1, $2,
                  u.row_index, u.nr_op, u.iban_platitor, u.den_trezorerie,
                  u.cod_program, u.cod_angajament, u.indicator_angajament,
                  u.den_beneficiar, u.cif_beneficiar, u.iban_beneficiar,
                  u.den_banca_trez, u.suma_op, u.nr_evid_platii, u.explicatii
             FROM UNNEST(
                $3::int[], $4::text[], $5::text[], $6::text[],
                $7::text[], $8::text[], $9::text[],
                $10::text[], $11::text[], $12::text[],
                $13::text[], $14::numeric[], $15::text[], $16::text[]
             ) AS u(row_index, nr_op, iban_platitor, den_trezorerie,
                    cod_program, cod_angajament, indicator_angajament,
                    den_beneficiar, cif_beneficiar, iban_beneficiar,
                    den_banca_trez, suma_op, nr_evid_platii, explicatii)`,
          params
        );
      }

      await client.query('COMMIT');
      logger.info({ orgId: actor.orgId, importId, lines: lines.length, suma: header.suma_totala },
        'opme import: success');

      // ── Pachet B: matching engine sincron post-import ────────────────────
      // Rulează în propria tranzacție; eșecul NU invalidează upload-ul, ci
      // doar suprimă raportul de matching din răspuns.
      let match_report = null;
      try {
        const rep = await matchImport(importId);
        match_report = {
          matched: rep.matched,
          ambiguous: rep.ambiguous,
          unmatched: rep.unmatched,
          partial: rep.partial,
          confirmed_alopuri: rep.confirmed_alopuri,
          summary_text: summarizeReport(rep),
        };
        logger.info({ orgId: actor.orgId, importId, ...match_report },
          'opme import: matcher done');
      } catch (matchErr) {
        logger.warn({ err: matchErr, importId },
          'opme import: matcher failed (non-fatal — lines remain pending)');
      }

      return _respond(201, {
        ok: true,
        import_id: importId,
        header,
        lines_count: lines.length,
        match_report,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      // Race pe UNIQUE (org_id, file_hash) — alt request a inserat între check și insert.
      if (e && (e.code === '23505')) {
        try {
          const { rows: dup } = await pool.query(
            'SELECT id, created_at FROM opme_imports WHERE org_id=$1 AND file_hash=$2',
            [actor.orgId, fileHash]
          );
          if (dup.length) {
            return _respond(409, {
              error: 'duplicate_import',
              existing_import_id: dup[0].id,
              created_at: dup[0].created_at,
            });
          }
        } catch {}
      }
      logger.error({ err: e }, 'opme import: insert failed');
      return _respond(500, { error: 'server_error' });
    } finally {
      client.release();
    }
  });

  req.pipe(bb);
});

// ── GET /api/me/can-import-opme — gating server-driven pentru UI ─────────────
router.get('/api/me/can-import-opme', async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const can = await _hasOpmeImportRole(actor);
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json({ can });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pachet C: GET endpoints (read-only) + rematch
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/opme/imports — listă paginabilă a import-urilor org ────────────
router.get('/api/opme/imports', async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!actor.orgId) return res.status(403).json({ error: 'org_required' });

  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const { rows } = await pool.query(`
      SELECT
        i.id, i.nr_document, i.data_op, i.suma_totala, i.nr_inregistrari,
        i.cif_platitor, i.den_platitor, i.file_name, i.created_at,
        i.uploaded_by AS uploaded_by_id,
        u.nume        AS uploaded_by_name,
        u.email       AS uploaded_by_email,
        COUNT(*)               OVER() AS total_count,
        ls.matched, ls.ambiguous, ls.unmatched, ls.partial, ls.pending
      FROM opme_imports i
      LEFT JOIN users u ON u.id = i.uploaded_by
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE match_status='auto')      ::int AS matched,
          COUNT(*) FILTER (WHERE match_status='ambiguous') ::int AS ambiguous,
          COUNT(*) FILTER (WHERE match_status='unmatched') ::int AS unmatched,
          COUNT(*) FILTER (WHERE match_status='partial')   ::int AS partial,
          COUNT(*) FILTER (WHERE match_status='pending')   ::int AS pending
        FROM opme_lines WHERE opme_import_id = i.id
      ) ls ON true
      WHERE i.org_id = $1
      ORDER BY i.created_at DESC
      LIMIT $2 OFFSET $3
    `, [actor.orgId, limit, offset]);

    const total = rows[0]?.total_count ? Number(rows[0].total_count) : 0;
    const imports = rows.map(r => ({
      id: r.id,
      nr_document: r.nr_document,
      data_op: r.data_op,
      suma_totala: r.suma_totala,
      nr_inregistrari: r.nr_inregistrari,
      cif_platitor: r.cif_platitor,
      den_platitor: r.den_platitor,
      file_name: r.file_name,
      created_at: r.created_at,
      uploaded_by: r.uploaded_by_id
        ? { id: r.uploaded_by_id, name: r.uploaded_by_name, email: r.uploaded_by_email }
        : null,
      lines_stats: {
        matched: r.matched || 0,
        ambiguous: r.ambiguous || 0,
        unmatched: r.unmatched || 0,
        partial: r.partial || 0,
        pending: r.pending || 0,
      },
    }));

    res.json({ imports, total, limit, offset });
  } catch (e) {
    logger.error({ err: e }, 'opme imports list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/opme/imports/:id — detaliu import + linii ──────────────────────
router.get('/api/opme/imports/:id', async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!actor.orgId) return res.status(403).json({ error: 'org_required' });

  const importId = req.params.id;
  if (!importId || importId === 'null' || importId === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }

  try {
    const { rows: header } = await pool.query(`
      SELECT
        i.id, i.org_id, i.nr_document, i.data_op, i.an_r, i.luna_r,
        i.cif_platitor, i.den_platitor, i.adresa_platitor,
        i.nr_inregistrari, i.suma_totala, i.universal_code,
        i.file_name, i.file_hash, i.created_at,
        i.uploaded_by AS uploaded_by_id,
        u.nume        AS uploaded_by_name,
        u.email       AS uploaded_by_email
      FROM opme_imports i
      LEFT JOIN users u ON u.id = i.uploaded_by
      WHERE i.id = $1 AND i.org_id = $2
    `, [importId, actor.orgId]);
    if (!header[0]) return res.status(404).json({ error: 'not_found' });

    const { rows: lines } = await pool.query(`
      SELECT
        l.id, l.row_index, l.nr_op, l.iban_platitor, l.den_trezorerie,
        l.cod_program, l.cod_angajament, l.indicator_angajament,
        l.den_beneficiar, l.cif_beneficiar, l.iban_beneficiar,
        l.den_banca_trez, l.suma_op, l.nr_evid_platii, l.explicatii,
        l.matched_alop_id, l.matched_ciclu_id, l.matched_at,
        l.match_status, l.match_notes,
        a.titlu AS alop_titlu,
        df.nr_unic_inreg AS df_nr
      FROM opme_lines l
      LEFT JOIN alop_instances a ON a.id = l.matched_alop_id
      LEFT JOIN formulare_df   df ON df.id = a.df_id
      WHERE l.opme_import_id = $1 AND l.org_id = $2
      ORDER BY l.row_index
    `, [importId, actor.orgId]);

    const stats = lines.reduce((acc, l) => {
      acc[l.match_status] = (acc[l.match_status] || 0) + 1;
      return acc;
    }, { auto: 0, manual: 0, ambiguous: 0, unmatched: 0, partial: 0, pending: 0 });

    const h = header[0];
    res.json({
      import: {
        id: h.id, nr_document: h.nr_document, data_op: h.data_op,
        an_r: h.an_r, luna_r: h.luna_r,
        cif_platitor: h.cif_platitor, den_platitor: h.den_platitor,
        adresa_platitor: h.adresa_platitor,
        nr_inregistrari: h.nr_inregistrari, suma_totala: h.suma_totala,
        universal_code: h.universal_code,
        file_name: h.file_name, file_hash: h.file_hash,
        created_at: h.created_at,
        uploaded_by: h.uploaded_by_id
          ? { id: h.uploaded_by_id, name: h.uploaded_by_name, email: h.uploaded_by_email }
          : null,
      },
      lines,
      stats,
    });
  } catch (e) {
    logger.error({ err: e, importId }, 'opme import detail error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/opme/lines/by-alop/:alopId — linii OPME atașate unui ALOP ──────
router.get('/api/opme/lines/by-alop/:alopId', async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!actor.orgId) return res.status(403).json({ error: 'org_required' });

  const alopId = req.params.alopId;
  if (!alopId || alopId === 'null' || alopId === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }

  try {
    // Verifică ALOP aparține org
    const { rows: aRows } = await pool.query(
      'SELECT id FROM alop_instances WHERE id=$1 AND org_id=$2',
      [alopId, actor.orgId]
    );
    if (!aRows[0]) return res.status(404).json({ error: 'not_found' });

    const { rows: lines } = await pool.query(`
      SELECT
        l.id, l.nr_op, l.cif_beneficiar, l.den_beneficiar,
        l.cod_angajament, l.indicator_angajament,
        l.suma_op, l.match_status,
        l.matched_ciclu_id, l.matched_at,
        l.opme_import_id,
        i.nr_document AS import_nr_document,
        i.data_op     AS import_data_op
      FROM opme_lines l
      LEFT JOIN opme_imports i ON i.id = l.opme_import_id
      WHERE l.matched_alop_id = $1
        AND l.org_id = $2
      ORDER BY i.data_op DESC NULLS LAST, l.nr_op
    `, [alopId, actor.orgId]);

    // Grupare client-side pe matched_ciclu_id (NULL = ciclu activ)
    const groups = { active: [], byCiclu: {} };
    for (const l of lines) {
      if (l.matched_ciclu_id) {
        (groups.byCiclu[l.matched_ciclu_id] = groups.byCiclu[l.matched_ciclu_id] || []).push(l);
      } else {
        groups.active.push(l);
      }
    }

    res.json({ lines, groups });
  } catch (e) {
    logger.error({ err: e, alopId }, 'opme lines by-alop error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/opme/imports/:id/rematch — re-rulează matcher-ul pe un import ─
router.post('/api/opme/imports/:id/rematch', csrfMiddleware, async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!actor.orgId) return res.status(403).json({ error: 'org_required' });
  if (!(await _hasOpmeImportRole(actor))) {
    return res.status(403).json({ error: 'forbidden', message: 'Doar responsabil CAB sau super-admin pot re-rula matching.' });
  }

  const importId = req.params.id;
  if (!importId || importId === 'null' || importId === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }

  try {
    // Tenant check
    const { rows: dup } = await pool.query(
      'SELECT id FROM opme_imports WHERE id=$1 AND org_id=$2',
      [importId, actor.orgId]
    );
    if (!dup[0]) return res.status(404).json({ error: 'not_found' });

    // Re-deschide pending pentru toate liniile care NU sunt deja 'auto' sau 'manual'
    // (idempotent — liniile confirmate rămân neatinse).
    await pool.query(`
      UPDATE opme_lines
         SET match_status='pending', match_notes=NULL
       WHERE opme_import_id = $1
         AND org_id = $2
         AND match_status IN ('unmatched','ambiguous','partial')
    `, [importId, actor.orgId]);

    const rep = await matchImport(importId);
    const match_report = {
      matched: rep.matched,
      ambiguous: rep.ambiguous,
      unmatched: rep.unmatched,
      partial: rep.partial,
      confirmed_alopuri: rep.confirmed_alopuri,
      summary_text: summarizeReport(rep),
    };
    res.json({ ok: true, match_report });
  } catch (e) {
    logger.error({ err: e, importId }, 'opme rematch error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/opme/imports/:id/export.csv — export CSV pentru audit contabil ──
router.get('/api/opme/imports/:id/export.csv', async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!actor.orgId) return res.status(403).json({ error: 'org_required' });
  if (!(await _hasOpmeImportRole(actor))) {
    return res.status(403).json({ error: 'forbidden', message: 'Doar responsabil CAB sau super-admin pot exporta.' });
  }

  const importId = req.params.id;
  if (!importId || importId === 'null' || importId === 'undefined') {
    return res.status(400).json({ error: 'id_invalid' });
  }

  try {
    const { rows: header } = await pool.query(
      'SELECT nr_document, data_op FROM opme_imports WHERE id=$1 AND org_id=$2',
      [importId, actor.orgId]
    );
    if (!header[0]) return res.status(404).json({ error: 'not_found' });

    const { rows: lines } = await pool.query(`
      SELECT
        l.nr_op, l.cod_angajament, l.indicator_angajament,
        l.cif_beneficiar, l.den_beneficiar, l.iban_beneficiar,
        l.suma_op, l.explicatii,
        l.match_status, l.match_notes,
        l.matched_alop_id,
        a.titlu AS alop_titlu,
        df.nr_unic_inreg AS df_nr
      FROM opme_lines l
      LEFT JOIN alop_instances a ON a.id = l.matched_alop_id
      LEFT JOIN formulare_df   df ON df.id = a.df_id
      WHERE l.opme_import_id = $1 AND l.org_id = $2
      ORDER BY l.row_index
    `, [importId, actor.orgId]);

    const h = header[0];
    const dataOpStr = h.data_op ? new Date(h.data_op).toISOString().slice(0, 10) : 'export';
    const filename = `opme_${h.nr_document || 'import'}_${dataOpStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const BOM = '﻿';
    const CRLF = '\r\n';
    const csvHeaders = [
      'nr_op', 'cod_angajament', 'indicator_angajament', 'cif_beneficiar',
      'den_beneficiar', 'iban_beneficiar', 'suma_op', 'data_op', 'explicatii',
      'match_status', 'match_notes', 'alop_id', 'alop_titlu', 'df_nr',
    ];

    let csv = BOM + csvHeaders.join(',') + CRLF;
    for (const l of lines) {
      const sumaRO = l.suma_op != null
        ? String(Number(l.suma_op).toFixed(2)).replace('.', ',')
        : '';
      const row = [
        l.nr_op || '', l.cod_angajament || '', l.indicator_angajament || '',
        l.cif_beneficiar || '', l.den_beneficiar || '', l.iban_beneficiar || '',
        sumaRO, dataOpStr, l.explicatii || '',
        l.match_status || '', l.match_notes || '',
        l.matched_alop_id || '', l.alop_titlu || '', l.df_nr || '',
      ];
      csv += row.map(_csvEscape).join(',') + CRLF;
    }
    res.end(csv);
  } catch (e) {
    logger.error({ err: e, importId }, 'opme export.csv error');
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  }
});

function _csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes(';')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── POST /api/opme/rematch-all — re-rulează matching pe toate importurile org ─
const _rematchAllLast = new Map(); // orgId → timestamp

router.post('/api/opme/rematch-all', csrfMiddleware, async (req, res) => {
  if (_requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!actor.orgId) return res.status(403).json({ error: 'org_required' });
  if (!['admin','org_admin'].includes(actor.role)) {
    return res.status(403).json({ error: 'forbidden', message: 'Doar admin sau org_admin.' });
  }

  const now = Date.now();
  const last = _rematchAllLast.get(actor.orgId) || 0;
  if (now - last < 3600_000) {
    const retryAfter = Math.ceil((3600_000 - (now - last)) / 1000);
    return res.status(429).json({
      error: 'rate_limited',
      message: `Reîncercați peste ${Math.ceil(retryAfter / 60)} minute.`,
      retry_after_seconds: retryAfter,
    });
  }

  try {
    const { rows: imports } = await pool.query(`
      SELECT DISTINCT i.id
        FROM opme_imports i
        JOIN opme_lines l ON l.opme_import_id = i.id
       WHERE i.org_id = $1
         AND l.match_status IN ('pending','unmatched','ambiguous','partial')
    `, [actor.orgId]);

    _rematchAllLast.set(actor.orgId, Date.now());

    let totalConfirmed = 0;
    const summary = [];

    for (const imp of imports) {
      try {
        await pool.query(`
          UPDATE opme_lines
             SET match_status='pending', match_notes=NULL
           WHERE opme_import_id = $1 AND org_id = $2
             AND match_status IN ('unmatched','ambiguous','partial')
        `, [imp.id, actor.orgId]);

        const rep = await matchImport(imp.id);
        totalConfirmed += rep.confirmed_alopuri.length;
        summary.push({
          import_id: imp.id,
          matched: rep.matched,
          ambiguous: rep.ambiguous,
          unmatched: rep.unmatched,
          partial: rep.partial,
          confirmed: rep.confirmed_alopuri.length,
        });
      } catch (e) {
        logger.warn({ err: e, importId: imp.id }, 'opme rematch-all: import failed (non-fatal)');
        summary.push({ import_id: imp.id, error: e.message });
      }
    }

    logger.info({ orgId: actor.orgId, processed: imports.length, totalConfirmed }, 'opme rematch-all done');
    res.json({ ok: true, processed: imports.length, total_confirmed: totalConfirmed, summary });
  } catch (e) {
    logger.error({ err: e }, 'opme rematch-all error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
