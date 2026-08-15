/**
 * server/services/opme-matcher.mjs — Pachet B: matching engine OPME → ALOP.
 *
 * Conectează liniile dintr-un import OPME (F1129) la ALOP-urile active aflate
 * în status='plata' folosind tripletul:
 *   (cod_angajament, indicator_angajament, cif_beneficiar)
 * plus, din #126, al PATRULEA criteriu: iban_beneficiar (normalizat), aplicat
 * DOAR când ambele părți îl au — vezi `_ibanVerdict` pentru decizie și motiv.
 *
 * #128d — potrivirea e conștientă de BLOCURI (un ORD, N beneficiari). Sursa de adevăr
 * nu mai e perechea de coloane plate `(cif_beneficiar, iban_beneficiar)` plus tripletele
 * din TOATE rândurile, ci un PROFIL per bloc: `profiluriBlocuri(ord)` din
 * `services/ord-blocuri.mjs` întoarce `{ bloc_idx, cif, iban, triplete }`, unde tripletele
 * sunt DOAR ale rândurilor blocului. O linie OPME se potrivește dacă EXISTĂ un bloc cu
 * `cif`-ul ei, cu tripletul ei și cu IBAN necontradictoriu. Un ORD legacy (`blocuri` NULL)
 * dă exact un profil din coloanele plate ⇒ comportament identic cu înainte.
 * ⚠️ Un `mismatch` de IBAN pe UN bloc NU mai respinge linia global — se încearcă blocul
 *    următor. E singura schimbare semantică, și e cerută: doi beneficiari = două IBAN-uri.
 *
 * Reguli (per prompt Pachet B):
 *   • Candidați = alop_instances a JOIN formulare_ord o ON o.id = a.ord_id
 *       a.org_id = line.org_id
 *       a.status = 'plata' AND a.plata_confirmed_at IS NULL AND a.cancelled_at IS NULL
 *       CIF-ul liniei apare pe coloana plată SAU într-un bloc (SUPERSET în SQL)
 *       EXISTS jsonb_array_elements(o.rows) care matchează (cod, indicator) — tot superset
 *       …iar regula AUTORITARĂ (cif+triplet+IBAN, PER BLOC) se aplică în JS, prin ACELAȘI
 *       helper folosit la agregare (vezi #126 C mai jos).
 *
 *   • 0 candidați → 'unmatched'
 *   • >1 candidați → 'ambiguous'
 *   • 1 candidat → confirmarea e ATOMICĂ pe ALOP-ul ÎNTREG (fix v3.9.745, prompt
 *     #115), nu pe triplet: un ORD cu mai mulți indicatori de angajament (mai
 *     multe rânduri) e plătit de mai multe OP-uri, iar ALOP-ul se închide când
 *     suma TUTUROR OP-urilor == valoarea TOTALĂ a ORD-ului. `_processAlop`
 *     grupează TOATE liniile pending/unmatched/partial din aceeași org cu
 *     CIF-urile blocurilor ORD-ului (filtrate în JS per bloc) și agregă:
 *       expected = SUM(rows.suma_ordonantata_plata) pe TOATE rândurile ORD-ului
 *       actual   = SUM(opme_lines.suma_op) pe toate liniile matchate
 *       (c1) actual === expected  → confirmă ALOP O SINGURĂ DATĂ, cu suma
 *                                    TOTALĂ (apel applyPlataConfirmedSideEffects)
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
import { profiluriBlocuri } from './ord-blocuri.mjs';

const TOLERANCE = 0.01;
const _eq = (a, b) => Math.abs(Number(a) - Number(b)) < TOLERANCE;

// ── #126 Etapa C: al PATRULEA criteriu — IBAN-ul beneficiarului ──────────────
// Pregătește ORD-urile cu mai multe CONTURI (același furnizor, conturi diferite):
// tripletul (cod, indicator, CIF) nu mai e suficient pentru dezambiguizare.
//
// ⛔ Normalizarea e OBLIGATORIE: „RO49 AAAA…" și „RO49AAAA…" sunt același IBAN.
//    Fără ea, criteriul ar respinge potriviri corecte — regresie mai gravă decât
//    problema rezolvată.
const _normIban = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// DECIZIE (#126 C2): criteriul IBAN se aplică DOAR când AMBELE părți au IBAN.
// Dacă ORD-ul n-are `iban_beneficiar` (documente vechi) SAU linia OPME n-are,
// potrivirea cade pe cele trei criterii existente — altfel toate ALOP-urile deja
// în „plata" ar deveni brusc nepotrivibile și s-ar confirma manual sute de plăți.
// ⚠️ Regula trăiește AICI, într-un singur helper, și e apelată IDENTIC în ambele
//    căi (selecția candidaților ȘI `_processAlop`). Dacă divergă, un OP s-ar
//    potrivi la selecție dar nu s-ar agrega la sumă = clasa de bug de la #115.
// @returns {'match'|'mismatch'|'no_iban'}
function _ibanVerdict(ordIbanRaw, lineIbanRaw) {
  const a = _normIban(ordIbanRaw);
  const b = _normIban(lineIbanRaw);
  if (!a || !b) return 'no_iban';
  return a === b ? 'match' : 'mismatch';
}

// ── #128d: regula AUTORITARĂ de potrivire linie ↔ ORD, PER BLOC, într-un SINGUR loc ──
// Apelată IDENTIC în selecția candidaților (`matchImport`, `tryAutoConfirmAlop`) ȘI în
// agregarea sumei (`_processAlop`). Dacă cele două căi divergă, o linie se potrivește la
// selecție dar nu se agregă la sumă = exact clasa de bug de la #115 (plată sub-numărată).
//
// O linie e acceptată de un bloc când, SIMULTAN: `profil.cif === cif-ul liniei`,
// `profil.triplete` conține `cod||ind`, iar `_ibanVerdict(profil.iban, linie.iban)` NU e
// 'mismatch'. Prima potrivire câștigă (blocurile sunt disjuncte pe (cif, triplet)).
// ⛔ Un 'mismatch' pe un bloc NU respinge linia global — se încearcă blocul următor:
//    un ORD cu doi beneficiari are două IBAN-uri, iar linia se compară cu al ei.
//
// @returns {{ profil: object|null, noIban: boolean, ibanRespins: boolean }}
//          `ibanRespins` e true DOAR când singurul motiv de respingere a fost IBAN-ul
//          (folosit pentru contorul/mesajul de raport, neschimbate ca formă).
function _potrivireBloc(profile, { cif, cod, ind, iban }) {
  const trip = `${cod}||${ind}`;
  let ibanRespins = false;
  for (const p of profile) {
    if (!p.cif || p.cif !== cif) continue;
    if (!p.triplete.has(trip)) continue;
    const v = _ibanVerdict(p.iban, iban);
    if (v === 'mismatch') { ibanRespins = true; continue; }
    return { profil: p, noIban: v === 'no_iban', ibanRespins: false };
  }
  return { profil: null, noIban: false, ibanRespins };
}

/**
 * matchImport — procesează toate liniile pending dintr-un import.
 *
 * Model tranzacțional (din v3.9.562): NU mai există un singur BEGIN/COMMIT care
 * înconjoară întreaga buclă. Decizia owner: importul OPME NU necesită atomicitate
 * de batch — dacă grupul N eșuează, grupurile confirmate înainte RĂMÂN confirmate.
 * Fiecare grup rulează în propria tranzacție scurtă (`BEGIN` → `FOR UPDATE` pe
 * ALOP-ul lui → muncă → `COMMIT`). La eroare pe un grup: `ROLLBACK` DOAR pe grupul
 * ăla, se înregistrează în `errors[]` și bucla CONTINUĂ. Per-grup elimină
 * deadlock-ul multi-ALOP prin construcție (max 1 lock de ALOP odată), fără pre-lock
 * global. Clasificarea liniilor (unmatched/ambiguous) rulează în autocommit — sunt
 * write-uri per-linie independente, fără lock de ALOP.
 *
 * @param {string} importId
 * @param {{ client?: any }} [opts]
 * @returns {Promise<{
 *   matched: number, ambiguous: number, unmatched: number, partial: number,
 *   confirmed_alopuri: string[], errors: {alop_id: string, reason: string}[],
 *   error_count: number, details: object[]
 * }>}
 */
export async function matchImport(importId, opts = {}) {
  const { client: externalClient } = opts;
  const ownClient = !externalClient;
  const client = externalClient || await pool.connect();

  try {
    // ── 1. Header import (org + uploaded_by ca actor pentru audit) ──────────
    const { rows: impRows } = await client.query(
      `SELECT id, org_id, uploaded_by, nr_document, data_op
         FROM opme_imports WHERE id = $1`,
      [importId]
    );
    if (!impRows[0]) {
      return _emptyReport();
    }
    const imp = impRows[0];

    // ── 2. Linii pending din acest import ───────────────────────────────────
    const { rows: lines } = await client.query(`
      SELECT id, cod_angajament, indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op, nr_op
        FROM opme_lines
       WHERE opme_import_id = $1
         AND match_status = 'pending'
       ORDER BY row_index
    `, [importId]);

    if (lines.length === 0) {
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
      // #128d: SQL-ul selectează un SUPERSET (CIF-ul poate veni de pe coloana plată SAU
      // dintr-un bloc; `EXISTS`-ul pe rânduri rămâne peste TOATE rândurile, indiferent de
      // bloc). Regula autoritară — cif+triplet+IBAN PER BLOC — se aplică imediat după, în
      // JS, prin `_potrivireBloc`: același helper folosit de `_processAlop` la agregare.
      // ⛔ NU muta regula în SQL peste JSONB — ar deveni o a doua implementare (#126 C).
      const { rows: candsRaw } = await client.query(`
        SELECT a.id AS alop_id, o.cif_beneficiar, o.iban_beneficiar,
               o.rows AS ord_rows, o.blocuri
          FROM alop_instances a
          JOIN formulare_ord  o ON o.id = a.ord_id
         WHERE a.org_id = $1
           AND a.status = 'plata'
           AND a.plata_confirmed_at IS NULL
           AND a.cancelled_at IS NULL
           AND (
             TRIM(o.cif_beneficiar) = $2
             OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(o.blocuri,'[]'::jsonb)) AS b
                WHERE TRIM(b->>'cif_beneficiar') = $2
             )
           )
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(o.rows,'[]'::jsonb)) AS r
              WHERE r->>'cod_angajament' = $3
                AND r->>'indicator_angajament' = $4
           )
      `, [imp.org_id, cif, cod, ind]);

      // #126 C: al patrulea criteriu (IBAN) se aplică în JS, prin ACELAȘI helper
      // folosit de `_processAlop` — SQL-ul ar fi o a doua implementare a normalizării.
      let ibanRespinse = 0;
      let ibanNedeclarat = false;
      const cands = candsRaw.filter(c => {
        const profile = profiluriBlocuri({
          blocuri: c.blocuri, rows: c.ord_rows,
          cif_beneficiar: c.cif_beneficiar, iban_beneficiar: c.iban_beneficiar,
        });
        const hit = _potrivireBloc(profile, { cif, cod, ind, iban: line.iban_beneficiar });
        if (!hit.profil) {
          if (hit.ibanRespins) ibanRespinse++;
          return false;
        }
        if (hit.noIban) ibanNedeclarat = true;
        return true;
      });
      if (ibanNedeclarat) {
        logger.info({ line_id: line.id, triplet: { cif, cod, ind } }, 'opme.match.candidate.no_iban');
      }

      if (cands.length === 0) {
        logger.info({ line_id: line.id, triplet: { cif, cod, ind }, iban_respinse: ibanRespinse },
          'opme.match.unmatched');
        await _markLine(client, line.id, 'unmatched',
          ibanRespinse > 0
            ? 'IBAN diferit față de ordonanțare (beneficiar și angajament potrivite).'
            : 'Nu există ALOP activ în plată cu acest beneficiar și angajament.');
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

    // ── 4. Grupare pe ALOP (nu pe triplet): un ORD cu mai mulți indicatori se
    //      confirmă ATOMIC per-ALOP când suma tuturor OP-urilor == total ORD.
    //      Colectăm liniile-candidat pe ALOP; _processAlop reia CIF-ul + tripletele
    //      din ORD și absoarbe și liniile pending vechi (retro) ale aceluiași ORD.
    const groups = new Map(); // key = alopId → { alopId, lineIds }
    for (const line of lines) {
      const alopId = lineCandidates.get(line.id);
      if (!alopId) continue;
      if (!groups.has(alopId)) groups.set(alopId, { alopId, lineIds: [] });
      groups.get(alopId).lineIds.push(line.id);
    }

    // ── 5. Pentru fiecare ALOP, propria tranzacție scurtă. Un ALOP picat face
    //      ROLLBACK doar pe el, se înregistrează în errors[] și bucla continuă.
    for (const g of groups.values()) {
      try {
        if (ownClient) await client.query('BEGIN');
        const out = await _processAlop(client, {
          alopId: g.alopId,
          org_id: imp.org_id,
          primaryLineIds: g.lineIds,
          actorUserId: imp.uploaded_by,
          importNrDocument: imp.nr_document,
          importDataOp: imp.data_op,
        });
        if (ownClient) await client.query('COMMIT');

        report.details.push(out);
        if (out.result === 'matched') {
          report.matched += out.line_count;
          report.confirmed_alopuri.push(g.alopId);
        } else if (out.result === 'partial' || out.result === 'overpay') {
          report.partial += out.line_count;
        } else if (out.result === 'already_confirmed') {
          // liniile sunt marcate matched, dar nu am produs confirmarea aici → nu contorizăm.
        }
      } catch (groupErr) {
        if (ownClient) { try { await client.query('ROLLBACK'); } catch {} }
        const reason = groupErr?.message || String(groupErr);
        logger.error({ err: groupErr, alop_id: g.alopId, importId },
          'opme-matcher: alop group failed (non-fatal, lines stay pending)');
        report.errors.push({ alop_id: g.alopId, reason });
        report.error_count++;
        report.details.push({ alop_id: g.alopId, result: 'error', reason });
        // continuă bucla — un ALOP picat NU abortează importul.
      }
    }

    return report;
  } catch (e) {
    // Eșec real de infra (read header/linii) — re-aruncă pentru 500 la call-site.
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
             o.id AS ord_id, o.cif_beneficiar, o.iban_beneficiar,
             o.rows AS ord_rows, o.blocuri
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
    // #128d: „are beneficiar" / „are triplete" se citesc de pe PROFILELE de bloc, nu de pe
    // coloanele plate. ORD legacy (`blocuri` NULL) ⇒ un profil din coloanele plate, deci
    // aceleași verdicte ca înainte. Codurile de rezultat rămân NESCHIMBATE.
    const profileAll = profiluriBlocuri({
      blocuri: alop.blocuri, rows: alop.ord_rows,
      cif_beneficiar: alop.cif_beneficiar, iban_beneficiar: alop.iban_beneficiar,
    });
    if (!alop.ord_id || !profileAll.some(p => p.cif)) {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'ord_missing' };
    }

    // 2. Verifică că ORD-ul are cel puțin un triplet valid (cod+indicator) într-un bloc.
    if (!profileAll.some(p => p.triplete.size > 0)) {
      if (ownClient) await client.query('COMMIT');
      return { confirmed: false, reason: 'no_triplets_in_ord' };
    }

    // 3. Procesează ALOP-ul ÎNTREG (toate tripletele ORD-ului) o singură dată.
    //    _processAlop re-citește profilele de bloc și agregă suma tuturor OP-urilor.
    const out = await _processAlop(client, {
      alopId,
      org_id: alop.org_id,
      primaryLineIds: [],   // doar absorbție retro
      actorUserId: optActor || alop.created_by,
      importNrDocument: null,
      importDataOp: null,
    });
    if (ownClient) await client.query('COMMIT');
    if (out.result === 'matched') {
      return { confirmed: true, reason: 'matched', details: [out] };
    }
    return {
      confirmed: false,
      reason: out.result === 'already_confirmed' ? 'already_confirmed' : 'no_match',
      details: [out],
    };
  } catch (e) {
    if (ownClient) { try { await client.query('ROLLBACK'); } catch {} }
    logger.error({ err: e, alopId }, 'opme-matcher: tryAutoConfirmAlop failed');
    throw e;
  } finally {
    if (ownClient) client.release();
  }
}

// ── Helper privat: procesează UN ALOP întreg (toate tripletele ORD-ului) ─────
// Confirmarea plății e un eveniment ATOMIC per-ALOP: un ORD cu mai mulți
// indicatori de angajament (mai multe rânduri) e plătit de mai multe OP-uri, iar
// ALOP-ul se închide când SUMA tuturor OP-urilor == valoarea TOTALĂ a ORD-ului.
// (Fix v3.9.745: înainte se confirma per-triplet și primul triplet bloca restul
//  prin garda plata_confirmed_at → plata_suma_efectiva conținea doar primul OP.)
async function _processAlop(client, args) {
  const {
    alopId, org_id, primaryLineIds,
    actorUserId, importNrDocument, importDataOp,
  } = args;

  // P0.2: lock rândul ALOP înainte de read-modify-write-ul confirmării — același
  // punct de choke ca înainte (serializează cu confirma-plata manuală FOR UPDATE).
  await client.query('SELECT id FROM alop_instances WHERE id=$1 FOR UPDATE', [alopId]);

  // (0) ORD-ul ALOP-ului: un PROFIL per bloc — (cif, iban, tripletele rândurilor SALE).
  //     #128d: înainte se citeau coloanele plate ca sursă unică de adevăr, iar tripletele
  //     din TOATE rândurile — cu N beneficiari asta potrivea plata pe furnizorul greșit.
  const { rows: aRows } = await client.query(`
    SELECT o.cif_beneficiar, o.iban_beneficiar, o.rows AS ord_rows, o.blocuri
      FROM alop_instances a
      JOIN formulare_ord  o ON o.id = a.ord_id
     WHERE a.id = $1
  `, [alopId]);
  if (!aRows[0]) {
    return { alop_id: alopId, result: 'ord_missing', expected: 0, actual: 0, line_count: 0 };
  }
  const profileAll = profiluriBlocuri({
    blocuri: aRows[0].blocuri, rows: aRows[0].ord_rows,
    cif_beneficiar: aRows[0].cif_beneficiar, iban_beneficiar: aRows[0].iban_beneficiar,
  });
  // Un bloc fără CIF (document incomplet) sau fără triplete e ignorat — restul funcționează.
  const profile = profileAll.filter(p => p.cif && p.triplete.size > 0);
  if (profile.length === 0) {
    // ⛔ Cod de rezultat NESCHIMBAT — consumat de raport și de teste.
    return { alop_id: alopId, result: 'no_triplets', expected: 0, actual: 0, line_count: 0 };
  }
  const cifuri = Array.from(new Set(profile.map(p => p.cif)));

  // (a) expected = SUM(suma_ordonantata_plata) pe TOATE rândurile ORD (valoarea totală ORD).
  const { rows: expRows } = await client.query(`
    SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata','')::numeric), 0) AS expected
      FROM alop_instances a
      JOIN formulare_ord  o ON o.id = a.ord_id
      LEFT JOIN jsonb_array_elements(COALESCE(o.rows,'[]'::jsonb)) AS r ON true
     WHERE a.id = $1
  `, [alopId]);
  const expected = Number(expRows[0]?.expected || 0);

  // (b) toate liniile pending/unmatched/partial ale org-ului cu CIF-ul ORICĂRUI bloc,
  //     filtrate în JS per bloc (evită liniile altui ALOP cu alt cod/indicator la același
  //     beneficiar, ȘI combinațiile încrucișate triplet-dintr-un-bloc / CIF-din-altul).
  //     Garda matched_alop_id protejează liniile deja legate de alt ALOP.
  const { rows: poolLines } = await client.query(`
    SELECT id, cod_angajament, indicator_angajament, cif_beneficiar, iban_beneficiar,
           suma_op, nr_op, opme_import_id
      FROM opme_lines
     WHERE org_id = $1
       AND TRIM(cif_beneficiar) = ANY($2::text[])
       AND match_status IN ('pending','unmatched','partial')
       AND (matched_alop_id IS NULL OR matched_alop_id = $3)
  `, [org_id, cifuri, alopId]);

  const lineIds = new Set();
  let actual = 0;
  const nrOps = [];
  const importIds = new Set();
  for (const ln of poolLines) {
    const cod = (ln.cod_angajament || '').trim();
    const ind = (ln.indicator_angajament || '').trim();
    // #126 C + #128d: regula per bloc, prin ACELAȘI helper ca la selecția candidaților —
    // altfel o linie s-ar potrivi la selecție dar nu s-ar agrega la sumă (#115).
    const hit = _potrivireBloc(profile, {
      cif: (ln.cif_beneficiar || '').trim(), cod, ind, iban: ln.iban_beneficiar,
    });
    if (!hit.profil) continue;
    if (hit.noIban) {
      logger.info({ alop_id: alopId, line_id: ln.id, bloc_idx: hit.profil.bloc_idx },
        'opme.match.candidate.no_iban');
    }
    lineIds.add(ln.id);
    actual += Number(ln.suma_op || 0);
    if (ln.nr_op) nrOps.push(ln.nr_op);
    if (ln.opme_import_id) importIds.add(ln.opme_import_id);
  }
  for (const id of (primaryLineIds || [])) lineIds.add(id);

  const lineCount = lineIds.size;
  const lineArr = Array.from(lineIds);

  if (lineCount === 0) {
    return { alop_id: alopId, result: 'no_lines', expected, actual: 0, line_count: 0 };
  }

  // (c1) actual === expected → confirmă O SINGURĂ DATĂ cu suma TOTALĂ a OP-urilor.
  if (_eq(actual, expected)) {
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
      // race: alt apel a confirmat între timp → marchează liniile drept matched.
      await _bulkMarkMatched(client, lineArr, alopId, 'auto');
      return { alop_id: alopId, result: 'already_confirmed', expected, actual, line_count: lineCount };
    }

    await _bulkMarkMatched(client, lineArr, alopId, 'auto');
    logger.info({ alop_id: alopId, suma: actual, lines_count: lineCount }, 'opme.match.confirmed');

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
        // #128d: un ORD multi-bloc are N beneficiari. Un singur bloc ⇒ string identic cu
        // înainte (non-regresie pe payload-ul de audit al documentelor de azi).
        cif_beneficiar: cifuri.join(', '),
        actor_user_id: actorUserId,
      })]);
    } catch (_auditErr) {
      logger.warn({ err: _auditErr, alop_id: alopId }, 'opme.match.audit_log insert failed (non-fatal)');
    }

    return { alop_id: alopId, result: 'matched', expected, actual, line_count: lineCount };
  }

  // (c2/c3) partial / overpay → marchează TOATE liniile ORD-ului ca partial, NU confirmă.
  logger.warn({ alop_id: alopId, expected, actual, lines_count: lineCount }, 'opme.match.partial');
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
    result: actual < expected ? 'partial' : 'overpay',
    expected, actual, line_count: lineCount,
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
    errors: [],        // [{ alop_id, reason }] — grupuri picate (non-fatal)
    error_count: 0,
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
  const errCount = rep.error_count || (rep.errors ? rep.errors.length : 0);
  return `${lines} linii citite · ${rep.confirmed_alopuri.length} ALOP confirmate automat · ${rep.ambiguous} ambigue · ${rep.unmatched} fără match${rep.partial ? ' · ' + rep.partial + ' parțiale' : ''}${errCount ? ' · ' + errCount + ' erori' : ''}`;
}
