/**
 * server/db/queries/users.mjs — user CRUD queries.
 */

import { query, getOne, getMany } from '../index.mjs';

export async function findUserById(id) {
  return getOne('SELECT * FROM users WHERE id=$1', [id]);
}

export async function findUserByEmail(email) {
  return getOne('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
}

export async function listUsersForOrg(orgId, { status } = {}) {
  if (status) {
    return getMany(
      `SELECT id, email, name, role, status, department, position,
              functie, institutie, compartiment,
              preferred_signing_provider, mfa_enabled, created_at
       FROM users WHERE org_id=$1 AND status=$2 ORDER BY name`,
      [orgId, status]
    );
  }
  return getMany(
    `SELECT id, email, name, role, status, department, position,
            functie, institutie, compartiment,
            preferred_signing_provider, mfa_enabled, created_at
     FROM users WHERE org_id=$1 ORDER BY name`,
    [orgId]
  );
}

export async function createUser({
  orgId, email, passwordHash, name = '', role = 'user',
  functie = '', institutie = '', compartiment = '',
}) {
  return getOne(
    `INSERT INTO users (org_id, email, password_hash, name, role,
                        functie, institutie, compartiment, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
     RETURNING *`,
    [orgId, email, passwordHash, name, role, functie, institutie, compartiment]
  );
}

export async function updateUser(id, fields) {
  const allowed = ['name', 'email', 'password_hash', 'role', 'status',
    'functie', 'institutie', 'compartiment', 'phone',
    'preferred_signing_provider', 'notif_inapp', 'notif_email', 'notif_whatsapp',
    'token_version', 'totp_secret', 'totp_enabled', 'login_blocked_until',
    'login_attempts', 'force_password_change', 'hash_algo'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = $${idx++}`);
    vals.push(v);
  }
  if (sets.length === 0) return findUserById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  return getOne(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
}

export async function incrementTokenVersion(userId) {
  return getOne(
    `UPDATE users SET token_version = token_version + 1, updated_at = NOW()
     WHERE id=$1 RETURNING token_version`,
    [userId]
  );
}

export async function getTokenVersion(userId) {
  const row = await getOne('SELECT token_version FROM users WHERE id=$1', [userId]);
  return row?.token_version ?? null;
}
