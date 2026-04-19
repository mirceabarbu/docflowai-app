/**
 * server/modules/forms/service.mjs — Forms Engine business logic.
 */

import crypto from 'crypto';

import { logger }            from '../../middleware/logger.mjs';
import { logAuditEvent }     from '../../db/queries/audit.mjs';
import {
  AppError, ValidationError, NotFoundError, ForbiddenError,
} from '../../core/errors.mjs';

import * as repo             from './repository.mjs';
import { evaluateRules, validateFormData } from './evaluator.mjs';
import { renderFormPdf }     from './pdf-renderer.mjs';

// ── Templates ─────────────────────────────────────────────────────────────────

export async function listTemplates(orgId) {
  return repo.listTemplates({ orgId });
}

export async function getTemplate(id) {
  const t = await repo.findTemplateById(id);
  if (!t) throw new NotFoundError('FormTemplate');
  return t;
}

export async function createTemplate({ orgId, code, name, category, description, isStandard, isMandatory }) {
  if (!code || !name) throw new ValidationError('code și name sunt obligatorii');
  return repo.insertTemplate({ orgId, code, name, category, description, isStandard, isMandatory });
}

// ── Versions ──────────────────────────────────────────────────────────────────

export async function createVersion({ templateId, schemaJson, pdfMappingJson, rulesJson, requiredAttachments, requiredSigners }) {
  const template = await repo.findTemplateById(templateId);
  if (!template) throw new NotFoundError('FormTemplate');
  return repo.insertVersion({ templateId, schemaJson, pdfMappingJson, rulesJson, requiredAttachments, requiredSigners });
}

export async function publishVersion(versionId) {
  const version = await repo.getVersionById(versionId);
  if (!version) throw new NotFoundError('FormVersion');
  if (version.status === 'published') return version;   // idempotent
  return repo.publishVersion(versionId);
}

export async function getActiveVersion(templateId) {
  const v = await repo.getActiveVersion(templateId);
  if (!v) throw new NotFoundError('FormVersion');
  return v;
}

// ── Instances ─────────────────────────────────────────────────────────────────

export async function listInstances({ orgId, status, limit, offset }) {
  return repo.listInstances({ orgId, status, limit, offset });
}

export async function getInstance(id, orgId) {
  const inst = await repo.findInstanceById(id);
  if (!inst) throw new NotFoundError('FormInstance');
  if (inst.org_id !== orgId) throw new ForbiddenError('Access denied to form instance');
  return inst;
}

export async function createInstance({ orgId, templateCode, templateId, versionId, flowId, userId, initialData = {} }) {
  // Resolve template
  let template;
  if (templateId) {
    template = await repo.findTemplateById(templateId);
  } else if (templateCode) {
    template = await repo.findTemplateByCode(templateCode, orgId);
  }
  if (!template) throw new NotFoundError('FormTemplate');

  // Resolve version
  let version;
  if (versionId) {
    version = await repo.getVersionById(versionId);
  } else {
    version = await repo.getActiveVersion(template.id);
  }
  if (!version) throw new AppError('Nicio versiune publicată disponibilă pentru acest template', 409, 'NO_PUBLISHED_VERSION');

  const inst = await repo.insertInstance({
    orgId,
    templateId: template.id,
    versionId:  version.id,
    flowId:     flowId ?? null,
    createdById: userId,
    dataJson:   initialData,
  });

  await logAuditEvent({
    orgId, flowId: flowId ?? null,
    eventType: 'form.created',
    message:   `Form instance creat: ${template.code} (${inst.id})`,
    meta:      { instanceId: inst.id, templateCode: template.code },
  }).catch(() => {});

  return { instance: inst, template, version };
}

export async function saveData(instanceId, orgId, dataJson) {
  const inst = await repo.findInstanceById(instanceId);
  if (!inst) throw new NotFoundError('FormInstance');
  if (inst.org_id !== orgId) throw new ForbiddenError();
  if (['submitted', 'generated'].includes(inst.status)) {
    throw new AppError('Formularul a fost deja trimis și nu mai poate fi editat', 409, 'IMMUTABLE_FORM');
  }

  const version = await repo.getVersionById(inst.version_id);
  const { hidden, computed } = evaluateRules(version?.rules_json ?? [], dataJson);
  const mergedData = { ...dataJson, ...computed };

  const updated = await repo.updateInstance(instanceId, { status: 'draft', dataJson: mergedData });
  return updated;
}

export async function validateInstance(instanceId, orgId) {
  const inst = await repo.findInstanceById(instanceId);
  if (!inst) throw new NotFoundError('FormInstance');
  if (inst.org_id !== orgId) throw new ForbiddenError();

  const version = await repo.getVersionById(inst.version_id);
  const { valid, errors } = validateFormData(
    inst.data_json,
    version?.schema_json ?? {},
    version?.rules_json  ?? []
  );

  await repo.updateInstance(instanceId, {
    validationErrors: valid ? null : errors,
  });

  return { valid, errors };
}

export async function generatePdf(instanceId, orgId) {
  const inst = await repo.findInstanceById(instanceId);
  if (!inst) throw new NotFoundError('FormInstance');
  if (inst.org_id !== orgId) throw new ForbiddenError();

  const version  = await repo.getVersionById(inst.version_id);
  const template = await repo.findTemplateById(inst.template_id);

  // Validate before generating
  const { valid, errors } = validateFormData(
    inst.data_json,
    version?.schema_json ?? {},
    version?.rules_json  ?? []
  );
  if (!valid) {
    await repo.updateInstance(instanceId, { validationErrors: errors });
    throw new ValidationError('Formularul conține erori de validare', errors);
  }

  const pdfBuffer = await renderFormPdf(version, inst.data_json, template?.name ?? 'Formular');
  const sha256    = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const pdfBase64 = pdfBuffer.toString('base64');

  const revision = await repo.insertFormDocumentRevision({
    instanceId,
    pdfBase64,
    sha256,
    sizeBytes: pdfBuffer.length,
  });

  await repo.updateInstance(instanceId, {
    status:              'generated',
    generatedRevisionId: revision.id,
  });

  await logAuditEvent({
    orgId, flowId: inst.flow_id,
    eventType: 'form.pdf_generated',
    message:   `PDF generat pentru form instance ${instanceId}`,
    meta:      { instanceId, revisionId: revision.id, sha256 },
  }).catch(() => {});

  logger.info({ instanceId, revisionId: revision.id }, 'Form PDF generat');
  return { pdfBuffer, revisionId: revision.id, sha256 };
}
