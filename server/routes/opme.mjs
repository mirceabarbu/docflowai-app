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

// Pachet A: admite admin sau orice user cu rol P2 (case-insensitive). Pachet B
// va înlocui asta cu gating pe compartiment via authz-formular.canEditAlop.
function _hasOpmeImportRole(actor) {
  const role = String(actor?.role || '').toLowerCase();
  if (role === 'admin') return true;
  const fnRoles = [actor?.functie_rol, actor?.functieRol, actor?.alopRole]
    .filter(Boolean).map(s => String(s).toLowerCase());
  return fnRoles.includes('p2');
}

router.post('/api/opme/import', csrfMiddleware, (req, res) => {
  if (_requireDb(res)) { _drainBody(req); return; }
  const actor = requireAuth(req, res);
  if (!actor) { _drainBody(req); return; }
  if (!actor.orgId) { _drainBody(req); return res.status(403).json({ error: 'org_required' }); }
  if (!_hasOpmeImportRole(actor)) {
    _drainBody(req);
    return res.status(403).json({ error: 'forbidden', message: 'Doar P2 sau super-admin pot importa OPME.' });
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

export default router;
