// ─────────────────────────────────────────────────────────────────────────────
// chat-access.mjs — Poartă de acces la nivel de obiect pentru chat
//
//   isConversationParticipant(convId, userId)   → regula UNICĂ de izolare
//   assertSameOrgParticipants(orgId, userIds)   → gardă la CREAREA unei conv `internal`
//
// Regula de aur: izolarea se face pe „ești participant ACTIV la conversație?",
// NU pe „e mesajul în org-ul meu". Conversația e unitatea de izolare, nu mesajul
// — o conversație `platform_support` traversează intenționat org-urile.
//
// Funcții PURE de acces: nimic despre WS / notificări aici.
// ─────────────────────────────────────────────────────────────────────────────
import { pool as defaultPool } from '../db/index.mjs';

/**
 * Regula unică de acces: ești participant ACTIV (left_at IS NULL) la conversație?
 * @param {number|string} convId
 * @param {number} userId
 * @param {object} [pool]
 * @returns {Promise<boolean>}
 */
export async function isConversationParticipant(convId, userId, pool = defaultPool) {
  if (!convId || !userId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_participants
      WHERE conv_id = $1 AND user_id = $2 AND left_at IS NULL
      LIMIT 1`,
    [convId, userId]
  );
  return rows.length > 0;
}

/**
 * La CREAREA unei conversații `internal`: TOȚI participanții (inclusiv creatorul)
 * trebuie să aparțină aceluiași org. NU se aplică pentru `platform_support`.
 * @param {number} orgId
 * @param {number[]} userIds — toți participanții, inclusiv creatorul
 * @param {object} [pool]
 * @returns {Promise<boolean>} true dacă toți sunt în org și activi (nu soft-deleted)
 */
export async function assertSameOrgParticipants(orgId, userIds, pool = defaultPool) {
  if (!orgId || !Array.isArray(userIds) || !userIds.length) return false;
  const uniq = [...new Set(userIds.map(Number).filter(Boolean))];
  if (!uniq.length) return false;
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE id = ANY($1::int[]) AND org_id = $2 AND deleted_at IS NULL`,
    [uniq, orgId]
  );
  return rows.length === uniq.length;
}
