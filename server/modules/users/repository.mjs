/**
 * server/modules/users/repository.mjs — User data access layer (v4)
 */

import { pool } from '../../db/index.mjs';
import { hashPassword } from '../../core/hashing.mjs';
import { parsePagination } from '../../core/pagination.mjs';
import { generateToken } from '../../core/ids.mjs';

const SAFE_COLS = `id, org_id, email, name, phone, position, department, role, status,
  functie, institutie, compartiment,
  preferred_signing_provider, mfa_enabled, totp_enabled,
  notif_inapp, notif_email, notif_whatsapp,
  force_password_change, created_at, updated_at`;

export async function createUser({ org_id, email, name = '', phone = '', position = '',
  department = '', role = 'user', password,
  functie = '', institutie = '', compartiment = '' }) {
  const pwd  = password || generateToken().slice(0, 12);
  const hash = await hashPassword(pwd);

  const { rows } = await pool.query(
    `INSERT INTO users
       (org_id, email, password_hash, hash_algo, name, phone, position, department, role,
        functie, institutie, compartiment, status)
     VALUES ($1, lower($2), $3, 'bcrypt', $4, $5, $6, $7, $8, $9, $10, $11, 'active')
     RETURNING ${SAFE_COLS}`,
    [org_id, email, hash, name, phone, position, department, role,
     functie, institutie, compartiment]
  );
  return { user: rows[0], generatedPassword: password ? null : pwd };
}

export async function getUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1',
    [email]
  );
  return rows[0] ?? null;
}

export async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT ${SAFE_COLS} FROM users WHERE id=$1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateUser(id, updates) {
  const allowed = ['name', 'email', 'phone', 'position', 'department', 'role', 'status',
    'functie', 'institutie', 'compartiment',
    'preferred_signing_provider', 'notif_inapp', 'notif_email', 'notif_whatsapp',
    'force_password_change'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = $${idx++}`);
    vals.push(v);
  }
  if (sets.length === 0) return getUserById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$${idx} RETURNING ${SAFE_COLS}`,
    vals
  );
  return rows[0] ?? null;
}

export async function listUsers(org_id, { page, limit, search, role, status } = {}) {
  const { page: p, limit: lim, offset } = parsePagination({ page, limit });
  const conds = ['org_id=$1'];
  const vals  = [org_id];
  let idx = 2;
  if (status) { conds.push(`status=$${idx++}`); vals.push(status); }
  if (role)   { conds.push(`role=$${idx++}`);   vals.push(role); }
  if (search) {
    conds.push(`(lower(name) LIKE $${idx} OR lower(email) LIKE $${idx})`);
    vals.push(`%${search.toLowerCase()}%`);
    idx++;
  }
  const where = conds.join(' AND ');
  const { rows } = await pool.query(
    `SELECT ${SAFE_COLS}, COUNT(*) OVER() AS _total
     FROM users WHERE ${where} ORDER BY name LIMIT $${idx} OFFSET $${idx + 1}`,
    [...vals, lim, offset]
  );
  const total = rows.length > 0 ? parseInt(rows[0]._total) : 0;
  return { users: rows.map(({ _total, ...r }) => r), total, page: p, limit: lim };
}

export async function softDeleteUser(id) {
  const { rows } = await pool.query(
    `UPDATE users SET status='inactive', updated_at=NOW() WHERE id=$1 RETURNING id, status`,
    [id]
  );
  return rows[0] ?? null;
}

export async function bulkImportCsv(org_id, csvText) {
  const lines   = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
  const created = [];
  const skipped = [];
  const errors  = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row    = {};
    headers.forEach((h, j) => { row[h] = values[j] ?? ''; });

    const email = (row.email || '').toLowerCase().trim();
    if (!email) { errors.push({ line: i + 1, reason: 'missing email' }); continue; }

    try {
      // Check existing
      const { rows: existing } = await pool.query(
        'SELECT id FROM users WHERE lower(email)=$1 AND org_id=$2',
        [email, org_id]
      );
      if (existing.length > 0) { skipped.push(email); continue; }

      const { user } = await createUser({
        org_id,
        email,
        name:       row.name       || row.name || '',
        phone:      row.phone      || '',
        position:   row.position   || row.functie || '',
        department: row.department || row.compartiment || '',
        role:       ['user','admin','superadmin'].includes(row.role) ? row.role : 'user',
      });
      created.push(user.email);
    } catch (e) {
      errors.push({ line: i + 1, email, reason: e.message });
    }
  }

  return { created: created.length, skipped: skipped.length, errors };
}
