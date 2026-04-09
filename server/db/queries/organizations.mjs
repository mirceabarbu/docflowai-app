/**
 * server/db/queries/organizations.mjs — organization CRUD queries.
 */

import { query, getOne, getMany } from '../index.mjs';

export async function findOrgById(id) {
  return getOne('SELECT * FROM organizations WHERE id=$1', [id]);
}

export async function findOrgBySlug(slug) {
  return getOne('SELECT * FROM organizations WHERE slug=$1', [slug]);
}

export async function listOrgs({ status } = {}) {
  if (status) {
    return getMany(
      'SELECT * FROM organizations WHERE status=$1 ORDER BY name',
      [status]
    );
  }
  return getMany('SELECT * FROM organizations ORDER BY name');
}

export async function createOrg({ name, slug, cif, status = 'active', plan = 'starter', settings = {} }) {
  return getOne(
    `INSERT INTO organizations (name, slug, cif, status, plan, settings)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [name, slug, cif ?? null, status, plan, JSON.stringify(settings)]
  );
}

export async function updateOrg(id, fields) {
  const allowed = ['name', 'slug', 'cif', 'status', 'plan', 'settings',
    'branding', 'compartimente', 'signing_providers_enabled', 'signing_providers_config'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = $${idx++}`);
    vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (sets.length === 0) return findOrgById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  return getOne(
    `UPDATE organizations SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
}

export async function getOrgSigningConfig(orgId) {
  return getOne(
    'SELECT signing_providers_enabled, signing_providers_config FROM organizations WHERE id=$1',
    [orgId]
  );
}
