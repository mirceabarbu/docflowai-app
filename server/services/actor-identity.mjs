/**
 * DocFlowAI — identitatea autoritară a actorului autentificat.
 *
 * Emailul este reutilizabil după soft-delete. ID-ul utilizatorului nu este.
 * Autorizarea se face numai după confirmarea stării curente din DB.
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

function requiredFiniteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameNullableId(left, right) {
  return (left == null && right == null)
    || (left != null && right != null && String(left) === String(right));
}

/**
 * @param {object|null|undefined} actor
 * @returns {Promise<
 *   { ok:true, user:object }
 *   | { ok:false, status:number, error:string, message:string }
 * >}
 */
export async function resolveActor(actor, req = null) {
  if (!actor?.userId) {
    logger.warn({ email: actor?.email }, 'resolveActor: JWT fără userId — fail-closed');
    return {
      ok: false,
      status: 401,
      error: 'session_identity_invalid',
      message: 'Sesiunea nu mai este validă. Reautentifică-te.',
    };
  }

  // SEC-88: dacă sessionGuard a rulat deja pe această cerere, rândul e validat și proaspăt
  // (fără cache — a fost citit în acest request). Îl refolosim: zero query suplimentar.
  // Garda a verificat DEJA deleted_at, token_version, rol și org — nu le reverificăm.
  if (req?._actorRow && String(req._actorRow.id) === String(actor.userId)) {
    return { ok: true, user: req._actorRow };
  }

  const jwtTv = requiredFiniteNumber(actor.tv);
  if (jwtTv == null) {
    logger.warn({ userId: actor.userId }, 'resolveActor: JWT fără token_version valid — fail-closed');
    return {
      ok: false,
      status: 401,
      error: 'session_identity_invalid',
      message: 'Sesiunea nu mai este validă. Reautentifică-te.',
    };
  }

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT id,
              email,
              nume,
              functie,
              compartiment,
              institutie,
              role,
              org_id,
              token_version,
              force_password_change
         FROM users
        WHERE id = $1
          AND deleted_at IS NULL`,
      [actor.userId]
    );
    row = rows[0] || null;
  } catch (err) {
    logger.error({ err, userId: actor.userId }, 'resolveActor: lookup DB eșuat — fail-closed');
    return {
      ok: false,
      status: 503,
      error: 'identity_lookup_failed',
      message: 'Baza de date este temporar indisponibilă. Reîncearcă în câteva momente.',
    };
  }

  if (!row) {
    logger.warn({ userId: actor.userId }, 'resolveActor: actor inexistent sau dezactivat — fail-closed');
    return {
      ok: false,
      status: 403,
      error: 'actor_not_found',
      message: 'Contul tău nu a fost găsit sau a fost dezactivat. Reautentifică-te.',
    };
  }

  const dbTv = requiredFiniteNumber(row.token_version);
  if (dbTv == null || jwtTv !== dbTv) {
    logger.warn(
      { userId: actor.userId, jwtTv: actor.tv, dbTv: row.token_version },
      'resolveActor: token_version diferit — fail-closed'
    );
    return {
      ok: false,
      status: 401,
      error: 'token_revoked',
      message: 'Sesiunea a expirat. Reautentifică-te.',
    };
  }

  const tokenOrgId = actor.orgId ?? null;
  const dbOrgId = row.org_id ?? null;
  if (!sameNullableId(tokenOrgId, dbOrgId)) {
    logger.warn(
      { userId: actor.userId, tokenOrgId, dbOrgId },
      'resolveActor: organizația JWT diferă de DB — fail-closed'
    );
    return {
      ok: false,
      status: 401,
      error: 'session_org_stale',
      message: 'Asocierea contului cu instituția s-a modificat. Reautentifică-te.',
    };
  }

  const tokenRole = String(actor.role || '');
  const dbRole = String(row.role || '');
  if (!tokenRole || tokenRole !== dbRole) {
    logger.warn(
      { userId: actor.userId, tokenRole, dbRole },
      'resolveActor: rolul JWT diferă de DB — fail-closed'
    );
    return {
      ok: false,
      status: 401,
      error: 'session_role_stale',
      message: 'Drepturile contului s-au modificat. Reautentifică-te.',
    };
  }

  return { ok: true, user: row };
}

export async function resolveActorOr(res, actor, req = null) {
  const result = await resolveActor(actor, req);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, message: result.message });
    return null;
  }
  return result.user;
}
