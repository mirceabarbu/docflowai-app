// server/ws/auth.mjs
// SEC-100: autentificarea WS trece prin ACELEAȘI verificări ca sessionGuard (#88).
// jwt.verify e necesar, dar NU e suficient: un JWT valid criptografic poate aparține
// unui cont dezactivat, unei sesiuni revocate sau unui login 2FA neterminat.

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/auth.mjs';
import { pool, DB_READY } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

/**
 * @returns {Promise<{userId:number, email:string, role:string, orgId:any, tv:number}|null>}
 *          null = REFUZ. Niciodată nu returnează un obiect „parțial valid".
 */
export async function authenticateWsToken(token) {
  if (!token || typeof token !== 'string') return null;

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return null; }

  // G2 — pending_token de 2FA: parola e corectă, al doilea factor NU a fost prezentat.
  if (payload?.requires2fa) {
    logger.warn({ userId: payload?.userId }, 'WS: pending_token 2FA refuzat');
    return null;
  }

  // G5 — tokenurile funcționale (upload/signer) nu sunt sesiuni de utilizator.
  if (!payload?.userId) return null;

  // FAIL-CLOSED: fără DB nu putem verifica revocarea ⇒ refuzăm. Consistent cu sessionGuard,
  // care returnează 503 pe aceeași condiție.
  if (!pool || !DB_READY) {
    logger.error({ userId: payload.userId }, 'WS: DB indisponibil — fail-closed');
    return null;
  }

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, org_id, token_version
         FROM users
        WHERE id = $1
          AND deleted_at IS NULL`,
      [payload.userId]
    );
    row = rows[0] || null;
  } catch (e) {
    logger.error({ err: e, userId: payload.userId }, 'WS: lookup eșuat — fail-closed');
    return null;
  }

  if (!row) return null;                                        // G1a — cont șters/dezactivat

  const dbTv  = row.token_version ?? 1;
  const jwtTv = payload.tv ?? 1;
  if (Number(jwtTv) !== Number(dbTv)) return null;              // G1b — sesiune revocată

  return {
    userId: row.id,
    email:  String(row.email || '').toLowerCase(),              // email-ul din DB, NU din token
    role:   row.role,
    orgId:  row.org_id ?? null,
    tv:     Number(dbTv),                                       // pentru revalidarea periodică (G1)
  };
}

/**
 * G4 — Origin permis la upgrade. `allowed` vine din `mountCors()` (`appOrigins`).
 * Tratează AMBELE forme: array de origini, sau `false` (CORS blocat complet).
 */
export function isWsOriginAllowed(origin, allowed) {
  if (!origin) return true;              // clienți non-browser (curl, teste) nu trimit Origin
  if (allowed === false) return false;   // CORS blocat ⇒ nu acceptăm origini externe
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(origin);
}
