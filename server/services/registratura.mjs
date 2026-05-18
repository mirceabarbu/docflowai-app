/**
 * server/services/registratura.mjs — Registratură Faza 1
 *
 * allocateNumber(): alocă un număr de înregistrare pentru un document EMIS
 * (sursa_tip='flow'). Atomic prin UPDATE ... RETURNING pe registru_serii.
 * Idempotent prin UNIQUE(org_id, registru, sursa_tip, sursa_id):
 *   - prima dată  → alocă, întoarce { numar, numarFormat, data, an }
 *   - retry/reinit → întoarce poziția deja existentă (NU al doilea număr)
 * Nu aruncă: pe orice eroare logează și întoarce null (fluxul nu se blochează).
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

function _fmt(pattern, { nr, d }) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return String(pattern || '{nr}/{dd}.{mm}.{yyyy}')
    .replace('{nr}', String(nr))
    .replace('{dd}', dd)
    .replace('{mm}', mm)
    .replace('{yyyy}', yyyy);
}

/**
 * @param {object} p
 * @param {number} p.orgId        — obligatoriu
 * @param {string} p.sursaId      — obligatoriu (flowId pentru documente emise)
 * @param {string} [p.registru='general']
 * @param {string} [p.sursaTip='flow']
 * @param {string} [p.flowId]
 * @param {string} [p.obiect]
 * @param {string} [p.expeditor]
 * @param {string} [p.destinatar]
 * @param {string} [p.compartiment]
 * @param {number} [p.createdBy]
 * @returns {Promise<{numar:number,numarFormat:string,data:string,an:number}|null>}
 */
export async function allocateNumber(p = {}) {
  const orgId   = Number(p.orgId);
  const sursaId = String(p.sursaId || '').trim();
  const registru = String(p.registru || 'general').trim() || 'general';
  const sursaTip = String(p.sursaTip || 'flow').trim() || 'flow';
  if (!pool || !orgId || !sursaId) return null;

  const now = new Date();
  const an = now.getFullYear();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Idempotență: poziția există deja pentru această sursă?
    const exist = await client.query(
      `SELECT numar, numar_format, data_inreg, an
         FROM registru_intrari
        WHERE org_id=$1 AND registru=$2 AND sursa_tip=$3 AND sursa_id=$4
        LIMIT 1`,
      [orgId, registru, sursaTip, sursaId]
    );
    if (exist.rows.length) {
      await client.query('COMMIT');
      const r = exist.rows[0];
      return {
        numar: r.numar,
        numarFormat: r.numar_format,
        data: new Date(r.data_inreg).toISOString(),
        an: r.an,
      };
    }

    // 2. Upsert seria + incrementare atomică a contorului.
    await client.query(
      `INSERT INTO registru_serii (org_id, registru, an)
         VALUES ($1,$2,$3)
       ON CONFLICT (org_id, registru, an) DO NOTHING`,
      [orgId, registru, an]
    );
    const seq = await client.query(
      `UPDATE registru_serii
          SET contor = contor + 1, updated_at = NOW()
        WHERE org_id=$1 AND registru=$2 AND an=$3
        RETURNING contor, pattern`,
      [orgId, registru, an]
    );
    const numar = seq.rows[0].contor;
    const pattern = seq.rows[0].pattern;
    const numarFormat = _fmt(pattern, { nr: numar, d: now });

    // 3. Inserare poziție. ON CONFLICT acoperă cursa cu un retry concurent.
    const ins = await client.query(
      `INSERT INTO registru_intrari
         (org_id, registru, an, numar, numar_format, data_inreg, directie,
          sursa_tip, sursa_id, flow_id, obiect, expeditor, destinatar,
          compartiment, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'iesire',$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (org_id, registru, sursa_tip, sursa_id) DO NOTHING
       RETURNING numar, numar_format, data_inreg, an`,
      [orgId, registru, an, numar, numarFormat, now, sursaTip, sursaId,
       p.flowId || null, String(p.obiect || ''), String(p.expeditor || ''),
       String(p.destinatar || ''), p.compartiment || null,
       p.createdBy || null]
    );

    if (!ins.rows.length) {
      // Cursă: alt request a inserat între timp. Rollback contorul nostru
      // (revert increment) și citește poziția câștigătoare.
      await client.query(
        `UPDATE registru_serii SET contor = contor - 1
          WHERE org_id=$1 AND registru=$2 AND an=$3`,
        [orgId, registru, an]
      );
      const win = await client.query(
        `SELECT numar, numar_format, data_inreg, an
           FROM registru_intrari
          WHERE org_id=$1 AND registru=$2 AND sursa_tip=$3 AND sursa_id=$4
          LIMIT 1`,
        [orgId, registru, sursaTip, sursaId]
      );
      await client.query('COMMIT');
      if (!win.rows.length) return null;
      const r = win.rows[0];
      return {
        numar: r.numar,
        numarFormat: r.numar_format,
        data: new Date(r.data_inreg).toISOString(),
        an: r.an,
      };
    }

    await client.query('COMMIT');
    const r = ins.rows[0];
    return {
      numar: r.numar,
      numarFormat: r.numar_format,
      data: new Date(r.data_inreg).toISOString(),
      an: r.an,
    };
  } catch (e) {
    try { if (client) await client.query('ROLLBACK'); } catch {}
    logger.warn({ err: e, orgId, sursaId }, 'registratura: allocateNumber eșuat');
    return null;
  } finally {
    if (client) client.release();
  }
}
