/**
 * server/services/opme-matcher.mjs — Pachet B: matching engine OPME → ALOP.
 *
 * Conectează liniile dintr-un import OPME (F1129) la ALOP-urile active aflate
 * în status='plata' folosind tripletul:
 *   (cod_angajament, indicator_angajament, cif_beneficiar)
 *
 * Reguli (per prompt Pachet B):
 *   • Candidați = alop_instances a JOIN formulare_ord o ON o.id = a.ord_id
 *       a.org_id = line.org_id
 *       a.status = 'plata' AND a.plata_confirmed_at IS NULL AND a.cancelled_at IS NULL
 *       o.cif_beneficiar = line.cif_beneficiar (TEXT, trimmed)
 *       EXISTS jsonb_array_elements(o.rows) care matchează (cod, indicator)
 *
 *   • 0 candidați → 'unmatched'
 *   • >1 candidați → 'ambiguous'
 *   • 1 candidat → grupează TOATE liniile pending/unmatched din aceeași org cu
 *     același (alop, cod, indicator, cif) și agregă:
 *       expected = SUM(rows.suma_ordonantata_plata) pe rândurile ORD ale
 *                  candidatului care matchează tripletul
 *       actual   = SUM(opme_lines.suma_op) pe grup
 *       (c1) actual === expected  → confirmă ALOP (apel applyPlataConfirmedSideEffects)
 *       (c2) actual <  expected   → 'partial' (rămâne în plata)
 *       (c3) actual >  expected   → 'partial' (overpay) — NU confirmă
 *
 *   • plata_source = 'opme_auto' la confirmările automate.
 *   • Idempotență: re-rularea pe același import NU re-update-ează cicluri
 *     deja completate (gardă WHERE plata_confirmed_at IS NULL).
 *   • matched_ciclu_id rămâne NULL pe auto-confirm; se populează la
 *     noua-lichidare când ALOP-ul se arhivează în alop_ord_cicluri.
 *
 * Public API:
 *   matchImport(importId, opts)        — apelat post-upload + ad-hoc
 *   tryAutoConfirmAlop(alopId, opts)   — apelat la tranziții către 'plata'
 *
 * opts = { client? : pgClient }
 *   • Dacă client e furnizat, se folosește direct (caller deschide tranzacția).
 *   • Dacă nu, se ia conexiune din pool și se deschide tranzacția intern.
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { applyPlataConfirmedSideEffects } from '../routes/alop.mjs';

const TOLERANCE = 0.01;
const _eq = (a, b) => Math.abs(Number(a) - Number(b)) < TOLERANCE;

/**
 * matchImport — procesează toate liniile pending dintr-un import.
 *
 * @param {string} importId
 * @param {{ client?: any }} [opts]
 * @returns {Promise<{
 *   matched: number, ambiguous: number, unmatched: number, partial: number,
 *   confirmed_alopuri: string[], details: object[]
 * }>}
 */
export async function matchImport(importId, opts = {}) {
  const { client: externalClient } = opts;
  const ownClient = !externalClient;
  const client = externalClient || await pool.connect();
  if (ownClient) await client.query('BEGIN');

  try {
    // ── 1. Header import (org + uploaded_by ca actor pentru audit) ──────────
    const { rows: impRows } = await client.query(
      `SELECT id, org_id, uploaded_by, nr_document, data_op
         FROM opme_imports WHERE id = $1`,
      [importId]
    );
    if (!impRows[0]) {
      if (ownClient) await client.query('ROLLBACK');
      return _emptyReport();
    }
    const imp = impRows[0];

    // ── 2. Linii pending din acest import ───────────────────────────────────
    const { rows: lines } = await client.query(`
      SELECT id, cod_angajament, indicator_angajament, cif_beneficiar, suma_op, nr_op
        FROM opme_lines
       WHERE opme_import_id = $1
         AND match_status = 'pending'
       ORDER BY row_index
    `, [importId]);

    if (lines.length === 0) {
      if (ownClient) await client.query('COMMIT');
      return _emptyReport();
    }

    const report = _emptyReport();

    // ── 3. Pentru fiecare linie: găsește candidați ──────────────────────────
    // Marchează unmatched/ambiguous direct (per linie). Pentru cele cu un singur
    // candidat, deferăm la pasul de grupare.
    const lineCandidates = new Map(); // line.id → alop_id unic (când e cazul)

    for (const line of lines) {
      const cif  = (line.cif_beneficiar || '').trim();
      const cod  = (line.cod_angajament || '').trim();
      const ind  = (line.indicator_angajament || '').trim();
      if (!cif || !cod || !ind) {
        await _markLine(client, line.id, 'unmatched',
          'Date insuficiente pe linia OPME (cif/cod/indicator gol).');
        report.unmatched++;
        continue;
      }
      const { rows: cands } = await client.query(`
        SELECT a.id AS alop_id
          FROM alop_instances a
          JOIN formulare_ord  o ON o.id = a.ord_id
         WHERE a.org_id = $1
           AND a.status = 'plata'
           AND a.plata_confirmed_at IS NULL
           AND a.cancelled_at IS NULL
           AND TRIM(o.cif_beneficiar) = $2
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(o.rows,'[]'::jsonb)) AS r
              WHERE r->>'cod_angajament' = $3
                AND r->>'indicator_angajament' = $4
           )
      `, [imp.org_id, cif, cod, ind]);

      if (cands.length === 0) {
        logger.info({ line_id: line.id, triplet: { cif, cod, ind } }, 'opme.match.unmatched');
        await _markLine(client, line.id, 'unmatched',
          'Nu există ALOP activ în plată cu acest beneficiar și angajament.');
        report.unmatched++;
      } else if (cands.length > 1) {
        const list = cands.map(c => c.alop_id).slice(0, 5).join(', ');
        logger.warn({ line_id: line.id, alop_ids: list, triplet: { cif, cod, ind } }, 'opme.match.ambiguous');
        await _markLine(client, line.id, 'ambiguous',
          `Mai multe ALOP active potrivite: ${list}`);
        report.ambiguous++;
      } else {
        logger.info({ line_id: line.id, candidates_count: 1, triplet: { cif, cod, ind } }, 'opme.match.candidate');
        lineCandidates.set(line.id, cands[0].alop_id);
      }
    }

    // ── 4. Grupare pe (alop, triplet) — include liniile pending VECHI din
    //      alte import-uri pentru aceeași org (absorbție retro).
    const groups = new Map(); // key = alop|cod|ind|cif → { alopId, triplet, lineIds, sumLocal }
    for (const line of lines) {
      const alopId = lineCandidates.get(line.id);
      if (!alopId) continue;
      const cif = (line.cif_beneficiar || '').trim();
      const cod = (line.cod_angajament || '').trim();
      const ind = (line.indicator_angajament || '').trim();
      const key = `${alopId}|${cod}|${ind}|${cif}`;
      if (!groups.has(key)) {
        groups.set(key, { alopId, cif, cod, ind, lineIds: [], sumLocal: 0 });
      }
      const g = groups.get(key);
      g.lineIds.push(line.id);
      g.sumLocal += Number(line.suma_op || 0);
    }

    // ── 5. Pentru fiecare grup, procesează prin tryAutoConfirmAlop (cu
    //      liniile candidate adăugate explicit la pool-ul de absorbție).
    for (const g of groups.values()) {
      const out = await _processGroup(client, {
        alopId: g.alopId,
        org_id: imp.org_id,
        triplet: { cod: g.cod, ind: g.ind, cif: g.cif },
        primaryLineIds: g.lineIds,
        actorUserId: imp.uploaded_by,
        importNrDocument: imp.nr_document,
        importDataOp: imp.data_op,
      });
      report.details.push(out);
      if (out.result === 'matched') {
        report.matched += out.line_count;
        report.confirmed_alopuri.push(g.alopId);
      } else if (out.result === 'partial' || out.result === 'overpay') {
        report.partial += out.line_count;
      } else if (out.result === 'already_confirmed') {
        // re-marchează liniile ca matched_alop_id pentru consistență vizuală,
        // dar nu intră în contor matched (nu am produs confirmarea aici)
      }
    }

    if (ownClient) await client.query('COMMIT');
    return report;
  } catch (e) {
    if (ownClient) { try { await client.query('ROLLBACK'); } catch {} }
    logger.error({ err: e, importId }, 'opme-matcher: matchImport failed');
    throw e;
  } finally {
    if (ownClient) client.release();
  }
}

/**
 * tryAutoConfirmAlop — invocat la tranzițiile automate către 'plata' pentru
 * a absorbi liniile OPME deja încărcate care matchează acum ALOP-ul.
 *
 * @param {string} alopId
 * @param {{ client?: any }} [opts]
 * @returns {Promise<{
 *   confirmed: boolean, reason: string, details?: object
 * }>}
 */
export async function tryAutoConfirmAlop(alopId, opts = {}) {
  const { client: externalClient, actorUserId: optActor } = opts;
  const ownClient = !externalClient;
  const client = externalClient || await pool.connect();
  if (ownClient) await client.query('BEGIN');

  try {
    // 1. Încarcă ALOP + ORD asociat
    const { rows: aRows } = await client.query(`
      SELECT a.id, a.org_id, a.status, a.plata_confirmed_at, a.created_by,
             o.id AS ord_id, TRIM(o.cif_beneficiar) AS cif_beneficiar,
             o.rows AS ord_rows
        FROM alop_instances a
        LEFT JOIN formulare_ord o ON o.id = a.ord_id
       WHERE a.id = $1
    `, [alopId]);
    if (!aRows[0]) {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'not_found' };
    }
    const alop = aRows[0];
    if (alop.status !== 'plata') {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'wrong_status' };
    }
    if (alop.plata_confirmed_at) {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'already_confirmed' };
    }
    if (!alop.ord_id || !alop.cif_beneficiar) {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'ord_missing' };
    }

    // 2. Extrage triplet-urile (cod, indicator) din rândurile ORD
    const ordRows = Array.isArray(alop.ord_rows) ? alop.ord_rows : [];
    const triplete = [];
    for (const r of ordRows) {
      const cod = (r?.cod_angajament || '').trim();
      const ind = (r?.indicator_angajament || '').trim();
      if (cod && ind) triplete.push({ cod, ind });
    }
    if (triplete.length === 0) {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'no_triplets_in_ord' };
    }

    // 3. Pentru fiecare triplet din ORD, încearcă o procesare.
    //    În practică majoritatea ALOP-urilor au un singur triplet pe ORD.
    const details = [];
    for (const t of triplete) {
      const out = await _processGroup(client, {
        alopId,
        org_id: alop.org_id,
        triplet: { cod: t.cod, ind: t.ind, cif: alop.cif_beneficiar },
        primaryLineIds: [], // doar absorbție retro
        actorUserId: optActor || alop.created_by,
        importNrDocument: null,
        importDataOp: null,
      });
      details.push(out);
      if (out.result === 'matched') {
        if (ownClient) await client.query('COMMIT');
        return { confirmed: true, reason: 'matched', details };
      }
    }
    if (ownClient) await client.query('COMMIT');
    return { confirmed: false, reason: 'no_match', details };
  } catch (e) {
    if (ownClient) { try { await client.query('ROLLBACK'); } catch {} }
    logger.error({ err: e, alopId }, 'opme-matcher: tryAutoConfirmAlop failed');
    throw e;
  } finally {
    if (ownClient) client.release();
  }
}

// ── Helper privat: procesează un grup (alopId + triplet) ────────────────────
async function _processGroup(client, args) {
  const {
    alopId, org_id, triplet, primaryLineIds,
    actorUserId, importNrDocument, importDataOp,
  } = args;
  const { cod, ind, cif } = triplet;

  // (a) calc expected din rândurile ORD ale ALOP-ului care matchează tripletul.
  const { rows: expRows } = await client.query(`
    SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata','')::numeric), 0) AS expected
      FROM alop_instances a
      JOIN formulare_ord  o ON o.id = a.ord_id
      LEFT JOIN jsonb_array_elements(COALESCE(o.rows,'[]'::jsonb)) AS r ON true
     WHERE a.id = $1
       AND r->>'cod_angajament' = $2
       AND r->>'indicator_angajament' = $3
  `, [alopId, cod, ind]);
  const expected = Number(expRows[0]?.expected || 0);

  // (b) adună toate liniile pending+unmatched din această org cu tripletul,
  //     plus orice linii din primaryLineIds (care încă pot fi 'pending').
  const { rows: poolLines } = await client.query(`
    SELECT id, suma_op, nr_op, opme_import_id
      FROM opme_lines
     WHERE org_id = $1
       AND TRIM(cod_angajament) = $2
       AND TRIM(indicator_angajament) = $3
       AND TRIM(cif_beneficiar) = $4
       AND match_status IN ('pending','unmatched','partial')
       AND (matched_alop_id IS NULL OR matched_alop_id = $5)
  `, [org_id, cod, ind, cif, alopId]);

  const lineIds = new Set();
  let actual = 0;
  const nrOps = [];
  const importIds = new Set();
  for (const ln of poolLines) {
    lineIds.add(ln.id);
    actual += Number(ln.suma_op || 0);
    if (ln.nr_op) nrOps.push(ln.nr_op);
    if (ln.opme_import_id) importIds.add(ln.opme_import_id);
  }
  for (const id of primaryLineIds) lineIds.add(id);

  const lineCount = lineIds.size;
  const lineArr = Array.from(lineIds);

  if (lineCount === 0) {
    return { alop_id: alopId, triplet, result: 'no_lines', expected, actual: 0, line_count: 0 };
  }

  // (c1) actual === expected → confirmă
  if (_eq(actual, expected)) {
    // determină nr_ordin (primul + restul) + data_op (cea mai veche)
    let nrOrdin = null;
    let dataOp = null;
    let observ;
    if (nrOps.length) nrOrdin = nrOps.join(', ');
    if (importIds.size) {
      const { rows: dataRow } = await client.query(`
        SELECT MIN(data_op) AS data_op,
               STRING_AGG(DISTINCT nr_document, ', ') AS nr_documents
          FROM opme_imports
         WHERE id = ANY($1::uuid[])
      `, [Array.from(importIds)]);
      dataOp = dataRow[0]?.data_op || importDataOp || null;
      const docs = dataRow[0]?.nr_documents || importNrDocument || '';
      observ = `Confirmat automat din OPME ${docs}${dataOp ? ' / ' + _fmtDate(dataOp) : ''}`.trim();
    } else {
      observ = 'Confirmat automat din OPME';
    }

    const row = await applyPlataConfirmedSideEffects(client, alopId, org_id, {
      userId: actorUserId,
      notes: observ,
      nr_ordin_plata: nrOrdin,
      data_plata: dataOp,
      suma_efectiva: actual,
      observatii: observ,
      source: 'opme_auto',
    });

    if (!row) {
      // race: alt apel a confirmat între timp → marchează liniile drept matched
      // dar raportează already_confirmed.
      await _bulkMarkMatched(client, lineArr, alopId, 'auto');
      return { alop_id: alopId, triplet, result: 'already_confirmed', expected, actual, line_count: lineCount };
    }

    await _bulkMarkMatched(client, lineArr, alopId, 'auto');

    logger.info({ alop_id: alopId, suma: actual, lines_count: lineCount, triplet: { cod, ind, cif } }, 'opme.match.confirmed');

    try {
      await client.query(`
        INSERT INTO audit_log (flow_id, org_id, event_type, actor_email, payload)
        VALUES (NULL, $1, 'plata_auto_opme', NULL, $2::jsonb)
      `, [org_id, JSON.stringify({
        alop_id: alopId,
        opme_import_ids: Array.from(importIds),
        opme_line_ids: lineArr,
        nr_op_list: nrOps,
        suma_efectiva: actual,
        data_op: importDataOp,
        cif_beneficiar: cif,
        cod_angajament: cod,
        actor_user_id: actorUserId,
      })]);
    } catch (_auditErr) {
      logger.warn({ err: _auditErr, alop_id: alopId }, 'opme.match.audit_log insert failed (non-fatal)');
    }

    return { alop_id: alopId, triplet, result: 'matched', expected, actual, line_count: lineCount };
  }

  // (c2/c3) partial / overpay → marchează liniile, NU confirmă
  logger.warn({ alop_id: alopId, expected, actual, lines_count: lineCount, triplet: { cod, ind, cif } }, 'opme.match.partial');
  const partialNote = actual < expected
    ? `Plată parțială ${actual.toFixed(2)} din ${expected.toFixed(2)} RON`
    : `Suma OPME (${actual.toFixed(2)}) depășește valoarea ORD (${expected.toFixed(2)} RON)`;
  if (lineArr.length) {
    await client.query(`
      UPDATE opme_lines
         SET match_status='partial',
             matched_alop_id=$2,
             match_notes=$3
       WHERE id = ANY($1::uuid[])
    `, [lineArr, alopId, partialNote]);
  }
  return {
    alop_id: alopId,
    triplet,
    result: actual < expected ? 'partial' : 'overpay',
    expected,
    actual,
    line_count: lineCount,
  };
}

async function _markLine(client, lineId, status, note) {
  await client.query(`
    UPDATE opme_lines SET match_status=$2, match_notes=$3 WHERE id=$1
  `, [lineId, status, note]);
}

async function _bulkMarkMatched(client, lineIds, alopId, status) {
  if (!lineIds.length) return;
  await client.query(`
    UPDATE opme_lines
       SET match_status=$3,
           matched_alop_id=$2,
           matched_ciclu_id=NULL,
           matched_at=NOW(),
           match_notes=NULL
     WHERE id = ANY($1::uuid[])
  `, [lineIds, alopId, status]);
}

function _emptyReport() {
  return {
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    partial: 0,
    confirmed_alopuri: [],
    details: [],
  };
}

function _fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d); }
}

export function summarizeReport(rep) {
  const lines = (rep.matched + rep.ambiguous + rep.unmatched + rep.partial);
  return `${lines} linii citite · ${rep.confirmed_alopuri.length} ALOP confirmate automat · ${rep.ambiguous} ambigue · ${rep.unmatched} fără match${rep.partial ? ' · ' + rep.partial + ' parțiale' : ''}`;
}
