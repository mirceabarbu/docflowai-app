// server/services/signer-identity.mjs
//
// SEC-103: un utilizator intern DEZACTIVAT nu mai poate fi semnatar.
//
// Semnarea nu are sesiune (token opac de semnatar, by design — semnatarii externi n-au cont),
// deci sessionGuard (#88) nu acoperă această cale. Clasificarea de mai jos e singurul loc unde
// „cine e emailul ăsta" primește un răspuns autoritar.
//
// TREI clase, nu două. Un simplu `deleted_at IS NULL` confundă „șters" cu „inexistent" și nu
// blochează nimic. `external` TREBUIE să treacă — semnarea de către externi e o funcție, nu o scăpare.

import { pool, DB_READY } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

/** @typedef {'active'|'deactivated'|'external'|'unknown'} SignerClass */

/**
 * @param {string} email
 * @returns {Promise<{ cls: SignerClass, userId: number|null }>}
 *
 * `unknown` = nu putem clasifica (DB indisponibil). Apelantul decide — vezi PAS 2.
 */
export async function classifySignerEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { cls: 'external', userId: null };     // fără email nu există utilizator intern

  if (!pool || !DB_READY) {
    logger.error({ email: e }, 'classifySignerEmail: DB indisponibil');
    return { cls: 'unknown', userId: null };
  }

  try {
    // O SINGURĂ interogare. Indexul parțial din migrația 067 garantează cel mult UN rând activ.
    const { rows } = await pool.query(
      'SELECT id, deleted_at FROM users WHERE lower(email) = $1',
      [e]
    );
    if (!rows.length) return { cls: 'external', userId: null };
    const act = rows.find(r => r.deleted_at === null);
    if (act) return { cls: 'active', userId: act.id };
    return { cls: 'deactivated', userId: rows[0].id };
  } catch (err) {
    logger.error({ err, email: e }, 'classifySignerEmail: interogare eșuată');
    return { cls: 'unknown', userId: null };
  }
}
