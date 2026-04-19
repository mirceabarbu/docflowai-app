/**
 * server/modules/forms/repository.mjs — DB operations for the Forms Engine.
 */

import { pool }       from '../../db/index.mjs';
import { generateId } from '../../core/ids.mjs';

// ── Templates ─────────────────────────────────────────────────────────────────

export async function listTemplates({ orgId, isActive = true } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM form_templates
     WHERE (org_id=$1 OR is_standard=TRUE) AND is_active=$2
     ORDER BY name`,
    [orgId ?? null, isActive]
  );
  return rows;
}

export async function findTemplateById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM form_templates WHERE id=$1',
    [id]
  );
  return rows[0] ?? null;
}

export async function findTemplateByCode(code, orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM form_templates
     WHERE code=$1 AND (org_id=$2 OR is_standard=TRUE) AND is_active=TRUE
     ORDER BY org_id NULLS LAST LIMIT 1`,
    [code, orgId ?? null]
  );
  return rows[0] ?? null;
}

export async function insertTemplate({ orgId, code, name, category, description, isStandard, isMandatory }) {
  const { rows } = await pool.query(
    `INSERT INTO form_templates
       (org_id, code, name, category, description, is_standard, is_mandatory)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [orgId ?? null, code, name, category ?? 'general', description ?? null,
     isStandard ?? false, isMandatory ?? false]
  );
  return rows[0];
}

export async function updateTemplate(id, fields) {
  const sets = ['updated_at = NOW()'];
  const vals = [];
  let idx = 1;
  if (fields.name        !== undefined) { sets.push(`name=$${idx++}`);        vals.push(fields.name); }
  if (fields.description !== undefined) { sets.push(`description=$${idx++}`); vals.push(fields.description); }
  if (fields.isActive    !== undefined) { sets.push(`is_active=$${idx++}`);   vals.push(fields.isActive); }
  if (fields.isMandatory !== undefined) { sets.push(`is_mandatory=$${idx++}`);vals.push(fields.isMandatory); }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE form_templates SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
  return rows[0] ?? null;
}

// ── Versions ──────────────────────────────────────────────────────────────────

export async function getActiveVersion(templateId) {
  const { rows } = await pool.query(
    `SELECT * FROM form_versions
     WHERE template_id=$1 AND status='published'
     ORDER BY version_no DESC LIMIT 1`,
    [templateId]
  );
  return rows[0] ?? null;
}

export async function getVersionById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM form_versions WHERE id=$1',
    [id]
  );
  return rows[0] ?? null;
}

export async function listVersions(templateId) {
  const { rows } = await pool.query(
    'SELECT * FROM form_versions WHERE template_id=$1 ORDER BY version_no DESC',
    [templateId]
  );
  return rows;
}

export async function insertVersion({ templateId, schemaJson, pdfMappingJson, rulesJson, requiredAttachments, requiredSigners }) {
  // Auto-increment version_no per template
  const { rows } = await pool.query(
    `INSERT INTO form_versions
       (template_id, version_no, schema_json, pdf_mapping_json, rules_json,
        required_attachments, required_signers)
     SELECT $1,
       COALESCE((SELECT MAX(version_no) FROM form_versions WHERE template_id=$1), 0) + 1,
       $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb
     RETURNING *`,
    [templateId,
     JSON.stringify(schemaJson ?? {}),
     JSON.stringify(pdfMappingJson ?? {}),
     JSON.stringify(rulesJson ?? []),
     JSON.stringify(requiredAttachments ?? []),
     JSON.stringify(requiredSigners ?? [])]
  );
  return rows[0];
}

export async function publishVersion(versionId) {
  const { rows } = await pool.query(
    `UPDATE form_versions
     SET status='published', published_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [versionId]
  );
  return rows[0] ?? null;
}

// ── Instances ─────────────────────────────────────────────────────────────────

export async function findInstanceById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM form_instances WHERE id=$1',
    [id]
  );
  return rows[0] ?? null;
}

export async function findInstanceByFlowId(flowId) {
  const { rows } = await pool.query(
    'SELECT * FROM form_instances WHERE flow_id=$1 LIMIT 1',
    [flowId]
  );
  return rows[0] ?? null;
}

export async function listInstances({ orgId, status, limit = 50, offset = 0 }) {
  const conditions = ['org_id=$1'];
  const vals = [orgId];
  let idx = 2;
  if (status) { conditions.push(`status=$${idx++}`); vals.push(status); }
  vals.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT fi.*,
            ft.code AS template_code, ft.name AS template_name,
            COUNT(*) OVER() AS total_count
     FROM form_instances fi
     JOIN form_templates ft ON ft.id = fi.template_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY fi.updated_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    vals
  );
  return rows;
}

export async function insertInstance({ orgId, templateId, versionId, flowId, createdById, dataJson }) {
  const { rows } = await pool.query(
    `INSERT INTO form_instances
       (org_id, template_id, version_id, flow_id, created_by_id, data_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING *`,
    [orgId, templateId, versionId, flowId ?? null, createdById, JSON.stringify(dataJson ?? {})]
  );
  return rows[0];
}

export async function updateInstance(id, { status, dataJson, validationErrors, flowId, generatedRevisionId } = {}) {
  const sets = ['updated_at = NOW()'];
  const vals = [];
  let idx = 1;
  if (status             !== undefined) { sets.push(`status=$${idx++}`);                        vals.push(status); }
  if (dataJson           !== undefined) { sets.push(`data_json=$${idx++}::jsonb`);              vals.push(JSON.stringify(dataJson)); }
  if (validationErrors   !== undefined) { sets.push(`validation_errors=$${idx++}::jsonb`);      vals.push(JSON.stringify(validationErrors)); }
  if (flowId             !== undefined) { sets.push(`flow_id=$${idx++}`);                       vals.push(flowId); }
  if (generatedRevisionId !== undefined) { sets.push(`generated_revision_id=$${idx++}`);        vals.push(generatedRevisionId); }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE form_instances SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
  return rows[0] ?? null;
}

// ── Document revisions (form-generated PDFs) ──────────────────────────────────

export async function insertFormDocumentRevision({ instanceId, pdfBase64, sha256, sizeBytes }) {
  const id = generateId();
  const { rows } = await pool.query(
    `INSERT INTO document_revisions
       (id, flow_id, revision_no, revision_type, storage_type, pdf_base64, sha256, size_bytes)
     VALUES ($1, NULL, 1, 'form_generated', 'inline', $2, $3, $4)
     RETURNING *`,
    [id, pdfBase64, sha256, sizeBytes]
  );
  return rows[0];
}
