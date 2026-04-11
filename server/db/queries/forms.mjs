/**
 * server/db/queries/forms.mjs — form template, version, and instance queries.
 */

import { getOne, getMany } from '../index.mjs';

// ── Templates ─────────────────────────────────────────────────────────────────

export async function listFormTemplates({ orgId, isActive = true } = {}) {
  if (orgId) {
    return getMany(
      `SELECT * FROM form_templates
       WHERE (org_id=$1 OR is_standard=TRUE) AND is_active=$2
       ORDER BY name`,
      [orgId, isActive]
    );
  }
  return getMany(
    'SELECT * FROM form_templates WHERE is_active=$1 ORDER BY name',
    [isActive]
  );
}

export async function findTemplateById(id) {
  return getOne('SELECT * FROM form_templates WHERE id=$1', [id]);
}

export async function findTemplateByCode(code, orgId) {
  return getOne(
    `SELECT * FROM form_templates
     WHERE code=$1 AND (org_id=$2 OR is_standard=TRUE) AND is_active=TRUE
     ORDER BY org_id NULLS LAST LIMIT 1`,
    [code, orgId]
  );
}

// ── Versions ──────────────────────────────────────────────────────────────────

export async function getActiveVersion(templateId) {
  return getOne(
    `SELECT * FROM form_versions
     WHERE template_id=$1 AND status='published'
     ORDER BY version_no DESC LIMIT 1`,
    [templateId]
  );
}

export async function getVersionById(id) {
  return getOne('SELECT * FROM form_versions WHERE id=$1', [id]);
}

// ── Instances ─────────────────────────────────────────────────────────────────

export async function findInstanceById(id) {
  return getOne('SELECT * FROM form_instances WHERE id=$1', [id]);
}

export async function findInstanceByFlowId(flowId) {
  return getOne(
    'SELECT * FROM form_instances WHERE flow_id=$1 LIMIT 1',
    [flowId]
  );
}

export async function createInstance({
  orgId, templateId, versionId, flowId, createdById, dataJson = {},
}) {
  return getOne(
    `INSERT INTO form_instances
       (org_id, template_id, version_id, flow_id, created_by_id, data_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING *`,
    [orgId, templateId, versionId, flowId ?? null, createdById, JSON.stringify(dataJson)]
  );
}

export async function updateInstance(id, { status, dataJson, validationErrors } = {}) {
  const sets = ['updated_at = NOW()'];
  const vals = [];
  let idx = 1;
  if (status !== undefined)           { sets.push(`status=$${idx++}`);            vals.push(status); }
  if (dataJson !== undefined)         { sets.push(`data_json=$${idx++}::jsonb`);  vals.push(JSON.stringify(dataJson)); }
  if (validationErrors !== undefined) { sets.push(`validation_errors=$${idx++}::jsonb`); vals.push(JSON.stringify(validationErrors)); }
  vals.push(id);
  return getOne(
    `UPDATE form_instances SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
}
