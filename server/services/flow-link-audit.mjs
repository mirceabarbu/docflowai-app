/**
 * DocFlowAI — flow-link-audit.mjs  (audit #120)
 * ---------------------------------------------
 * Detecție PURĂ, strict read-only, a divergențelor document↔flux: „un document
 * semnat care nu știe că e semnat" (și fratele lui, „mai multe fluxuri pe același
 * document"). Trei incidente în șase zile, aceeași familie, niciunul prins de
 * self-heal-urile existente (care se declanșează DOAR pe df_id/ord_id NULL).
 *
 * ⛔ ZERO scrieri. Acest modul NU repară nimic — semnalează, decizia e a omului
 * (un document semnat nu se re-leagă tăcut de un flux ales de o euristică).
 *
 * Predicatul „flux valid semnat" e definit O SINGURĂ DATĂ (validSignedFlowSql) și
 * reutilizat în toate clasele — inclusiv excluderea `cancelled`/`refused`, care NU
 * e opțională: un flux ANULAT poate rămâne cu `data->>'completed' = 'true'`
 * (incidentul PZ_8C34C4E842, 0/5 semnături). `IS DISTINCT FROM` e obligatoriu
 * (NULL-safe). Aceeași formă apare deja în formular-shared.mjs (relink revizie).
 *
 * ⚠️ Din P0-03 (#122), ambele predicate trăiesc în `flow-provenance.mjs` (sursa unică,
 * folosită și de poarta de proveniență din alop.mjs) și se importă de acolo — o a doua
 * definiție locală ar fi drift garantat. Test anti-drift: tests/unit/flow-provenance.test.mjs.
 */

import { validSignedFlowSql, liveFlowSql } from './flow-provenance.mjs';

const CLASS_KEYS = ['doc_fara_flux', 'alop_fara_flux', 'alop_fara_document', 'fluxuri_paralele'];

/**
 * Găsește divergențele document↔flux, opțional scopate pe o organizație.
 *
 * @param {import('pg').Pool} pool
 * @param {{ orgId?: number|string|null, limit?: number }} [opts]
 *   - orgId: null ⇒ toate organizațiile (platform-admin); altfel scop pe org.
 *   - limit: câte rânduri detaliate să întoarcă (total e numărat integral).
 *            0 ⇒ doar numărătoare (fără rânduri).
 * @returns {Promise<{ total:number, byClass:Record<string,number>, rows:Array }>}
 */
export async function findFlowLinkDivergences(pool, { orgId = null, limit = 200 } = {}) {
  const scoped = orgId != null;
  const lim = Number.isFinite(+limit) ? Math.max(0, Math.min(1000, Math.trunc(+limit))) : 200;
  // param $1 = orgId când e scopat; același param pentru count și pentru rânduri.
  const params = () => (scoped ? [orgId] : []);
  const orgCond = (alias) => (scoped ? ` AND ${alias}.org_id = $1` : '');

  // Fiecare detector: { clasa, sql } — sql întoarce coloanele de rând standard.
  const detectors = [
    // ── A — doc_fara_flux ────────────────────────────────────────────────────
    // Document (DF/ORD) cu flow_id NULL, dar un flux valid semnat îl revendică prin
    // data->'meta'->>'dfId'/'ordId'. (Cazul 3 din incidente; ORD 42719 parțial.)
    { clasa: 'doc_fara_flux', sql: `
      SELECT 'doc_fara_flux'::text AS clasa, 'df'::text AS tip, d.id::text AS doc_id,
             d.nr_unic_inreg AS doc_nr, NULL::text AS alop_id, f.id AS flux,
             'DF fără flow_id, dar un flux semnat îl revendică prin meta.dfId'::text AS detaliu
        FROM formulare_df d
        JOIN flows f ON f.data->'meta'->>'dfId' = d.id::text
       WHERE d.flow_id IS NULL AND d.deleted_at IS NULL AND ${validSignedFlowSql('f')}${orgCond('d')}` },
    { clasa: 'doc_fara_flux', sql: `
      SELECT 'doc_fara_flux'::text AS clasa, 'ord'::text AS tip, d.id::text AS doc_id,
             d.nr_ordonant_pl AS doc_nr, NULL::text AS alop_id, f.id AS flux,
             'ORD fără flow_id, dar un flux semnat îl revendică prin meta.ordId'::text AS detaliu
        FROM formulare_ord d
        JOIN flows f ON f.data->'meta'->>'ordId' = d.id::text
       WHERE d.flow_id IS NULL AND d.deleted_at IS NULL AND ${validSignedFlowSql('f')}${orgCond('d')}` },

    // ── B — alop_fara_flux ───────────────────────────────────────────────────
    // ALOP ne-anulat cu df_id/ord_id setat, documentul are flow_id pe un flux valid
    // semnat, dar alop.{df,ord}_flow_id e NULL — lipsește legătura ALOP↔flux. (Cazul 2.)
    { clasa: 'alop_fara_flux', sql: `
      SELECT 'alop_fara_flux'::text AS clasa, 'df'::text AS tip, d.id::text AS doc_id,
             d.nr_unic_inreg AS doc_nr, a.id::text AS alop_id, f.id AS flux,
             'ALOP cu DF semnat (df.flow_id) dar df_flow_id NULL'::text AS detaliu
        FROM alop_instances a
        JOIN formulare_df d ON d.id = a.df_id
        JOIN flows f ON f.id = d.flow_id
       WHERE a.cancelled_at IS NULL AND a.df_id IS NOT NULL AND a.df_flow_id IS NULL
         AND d.flow_id IS NOT NULL AND ${validSignedFlowSql('f')}${orgCond('a')}` },
    { clasa: 'alop_fara_flux', sql: `
      SELECT 'alop_fara_flux'::text AS clasa, 'ord'::text AS tip, d.id::text AS doc_id,
             d.nr_ordonant_pl AS doc_nr, a.id::text AS alop_id, f.id AS flux,
             'ALOP cu ORD semnat (ord.flow_id) dar ord_flow_id NULL'::text AS detaliu
        FROM alop_instances a
        JOIN formulare_ord d ON d.id = a.ord_id
        JOIN flows f ON f.id = d.flow_id
       WHERE a.cancelled_at IS NULL AND a.ord_id IS NOT NULL AND a.ord_flow_id IS NULL
         AND d.flow_id IS NOT NULL AND ${validSignedFlowSql('f')}${orgCond('a')}` },

    // ── C — alop_fara_document ───────────────────────────────────────────────
    // ALOP ne-anulat cu df_id/ord_id NULL, dar există un document nedeleted cu
    // source_alop_id = ALOP. (Cazul 1 — deja auto-vindecat, raportat pt. frecvență.)
    { clasa: 'alop_fara_document', sql: `
      SELECT 'alop_fara_document'::text AS clasa, 'df'::text AS tip, d.id::text AS doc_id,
             d.nr_unic_inreg AS doc_nr, a.id::text AS alop_id, NULL::text AS flux,
             'ALOP fără df_id, dar există un DF cu source_alop_id = ALOP'::text AS detaliu
        FROM alop_instances a
        JOIN formulare_df d ON d.source_alop_id = a.id AND d.deleted_at IS NULL
       WHERE a.cancelled_at IS NULL AND a.df_id IS NULL${orgCond('a')}` },
    { clasa: 'alop_fara_document', sql: `
      SELECT 'alop_fara_document'::text AS clasa, 'ord'::text AS tip, d.id::text AS doc_id,
             d.nr_ordonant_pl AS doc_nr, a.id::text AS alop_id, NULL::text AS flux,
             'ALOP fără ord_id, dar există un ORD cu source_alop_id = ALOP'::text AS detaliu
        FROM alop_instances a
        JOIN formulare_ord d ON d.source_alop_id = a.id AND d.deleted_at IS NULL
       WHERE a.cancelled_at IS NULL AND a.ord_id IS NULL${orgCond('a')}` },

    // ── D — fluxuri_paralele ─────────────────────────────────────────────────
    // Două sau mai multe fluxuri VII (neșterse, ne-anulate, ne-refuzate) revendică
    // ACELAȘI document prin data->'meta'. Semnalul TIMPURIU: apare înainte de orice
    // semnătură, deci înainte ca paguba (pointer greșit) să existe. (ORD 42719: trei
    // fluxuri în patru secunde — dublu/triplu click.)
    { clasa: 'fluxuri_paralele', sql: `
      SELECT 'fluxuri_paralele'::text AS clasa, 'df'::text AS tip, m.doc_id AS doc_id,
             NULL::text AS doc_nr, NULL::text AS alop_id, string_agg(m.flux, ', ') AS flux,
             (COUNT(*)::text || ' fluxuri active revendică același DF (meta.dfId)') AS detaliu
        FROM (
          SELECT f.data->'meta'->>'dfId' AS doc_id, f.id AS flux
            FROM flows f
           WHERE f.data->'meta'->>'dfId' IS NOT NULL AND ${liveFlowSql('f')}${orgCond('f')}
        ) m
       GROUP BY m.doc_id
      HAVING COUNT(*) >= 2` },
    { clasa: 'fluxuri_paralele', sql: `
      SELECT 'fluxuri_paralele'::text AS clasa, 'ord'::text AS tip, m.doc_id AS doc_id,
             NULL::text AS doc_nr, NULL::text AS alop_id, string_agg(m.flux, ', ') AS flux,
             (COUNT(*)::text || ' fluxuri active revendică același ORD (meta.ordId)') AS detaliu
        FROM (
          SELECT f.data->'meta'->>'ordId' AS doc_id, f.id AS flux
            FROM flows f
           WHERE f.data->'meta'->>'ordId' IS NOT NULL AND ${liveFlowSql('f')}${orgCond('f')}
        ) m
       GROUP BY m.doc_id
      HAVING COUNT(*) >= 2` },
  ];

  const byClass = Object.fromEntries(CLASS_KEYS.map((k) => [k, 0]));
  let total = 0;
  const rows = [];

  for (const det of detectors) {
    // Numărătoare integrală (independent de `lim`) — wrap în subquery (clasa D are GROUP BY).
    const { rows: cr } = await pool.query(`SELECT COUNT(*)::int AS n FROM (${det.sql}) t`, params());
    const n = cr[0]?.n || 0;
    byClass[det.clasa] += n;
    total += n;

    // Rânduri detaliate — doar dacă mai avem buget în `lim`.
    if (lim > 0 && rows.length < lim) {
      const { rows: dr } = await pool.query(`${det.sql} LIMIT ${lim}`, params());
      for (const r of dr) {
        if (rows.length >= lim) break;
        rows.push(r);
      }
    }
  }

  return { total, byClass, rows };
}
