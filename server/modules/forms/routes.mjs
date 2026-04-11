/**
 * server/modules/forms/routes.mjs — Forms Engine API (v4)
 * Mounted at /api/forms in app.mjs
 */

import { Router }      from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { getOrgId }    from '../../core/tenant.mjs';
import * as svc        from './service.mjs';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin', 'org_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── Templates ─────────────────────────────────────────────────────────────────

// GET /api/forms/templates
router.get('/templates', requireAuth, async (req, res, next) => {
  try {
    const templates = await svc.listTemplates(getOrgId(req));
    res.json({ templates });
  } catch (err) { next(err); }
});

// POST /api/forms/templates  (admin only)
router.post('/templates', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { code, name, category, description, isStandard, isMandatory } = req.body;
    const template = await svc.createTemplate({
      orgId: getOrgId(req), code, name, category, description,
      isStandard: isStandard ?? false,
      isMandatory: isMandatory ?? false,
    });
    res.status(201).json({ template });
  } catch (err) { next(err); }
});

// GET /api/forms/templates/:id
router.get('/templates/:id', requireAuth, async (req, res, next) => {
  try {
    const template = await svc.getTemplate(req.params.id);
    res.json({ template });
  } catch (err) { next(err); }
});

// ── Versions ──────────────────────────────────────────────────────────────────

// POST /api/forms/templates/:id/versions  (admin only)
router.post('/templates/:id/versions', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { schemaJson, pdfMappingJson, rulesJson, requiredAttachments, requiredSigners } = req.body;
    const version = await svc.createVersion({
      templateId: req.params.id,
      schemaJson, pdfMappingJson, rulesJson, requiredAttachments, requiredSigners,
    });
    res.status(201).json({ version });
  } catch (err) { next(err); }
});

// POST /api/forms/versions/:id/publish  (admin only)
router.post('/versions/:id/publish', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const version = await svc.publishVersion(req.params.id);
    res.json({ version });
  } catch (err) { next(err); }
});

// ── Instances ─────────────────────────────────────────────────────────────────

// GET /api/forms/instances
router.get('/instances', requireAuth, async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const rows = await svc.listInstances({
      orgId: getOrgId(req),
      status: status || undefined,
      limit:  Number(limit),
      offset: Number(offset),
    });
    const total = Number(rows[0]?.total_count ?? 0);
    res.json({ instances: rows, total });
  } catch (err) { next(err); }
});

// POST /api/forms/instances
router.post('/instances', requireAuth, async (req, res, next) => {
  try {
    const { templateCode, templateId, versionId, flowId, initialData } = req.body;
    const result = await svc.createInstance({
      orgId:        getOrgId(req),
      templateCode, templateId, versionId,
      flowId:       flowId ?? null,
      userId:       req.user.id,
      initialData:  initialData ?? {},
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// GET /api/forms/instances/:id
router.get('/instances/:id', requireAuth, async (req, res, next) => {
  try {
    const inst = await svc.getInstance(req.params.id, getOrgId(req));
    res.json({ instance: inst });
  } catch (err) { next(err); }
});

// PUT /api/forms/instances/:id/data
router.put('/instances/:id/data', requireAuth, async (req, res, next) => {
  try {
    const inst = await svc.saveData(req.params.id, getOrgId(req), req.body.data ?? req.body);
    res.json({ instance: inst });
  } catch (err) { next(err); }
});

// POST /api/forms/instances/:id/validate
router.post('/instances/:id/validate', requireAuth, async (req, res, next) => {
  try {
    const result = await svc.validateInstance(req.params.id, getOrgId(req));
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/forms/instances/:id/generate-pdf
router.post('/instances/:id/generate-pdf', requireAuth, async (req, res, next) => {
  try {
    const { pdfBuffer, revisionId, sha256 } = await svc.generatePdf(req.params.id, getOrgId(req));
    res.json({ revisionId, sha256, size: pdfBuffer.length });
  } catch (err) { next(err); }
});

// GET /api/forms/instances/:id/pdf  (returns binary)
router.get('/instances/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const { pdfBuffer } = await svc.generatePdf(req.params.id, getOrgId(req));
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="formular_${req.params.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

// ── ALOP convenience shortcuts ────────────────────────────────────────────────

// GET /api/forms/alop/templates   (list only ALOP templates)
router.get('/alop/templates', requireAuth, async (req, res, next) => {
  try {
    const templates = await svc.listTemplates(getOrgId(req));
    const alop = templates.filter(t => t.code?.startsWith('ALOP'));
    res.json({ templates: alop });
  } catch (err) { next(err); }
});

// POST /api/forms/alop/create   (create ALOP-2024 instance)
router.post('/alop/create', requireAuth, async (req, res, next) => {
  try {
    const { flowId, initialData } = req.body;
    const result = await svc.createInstance({
      orgId:       getOrgId(req),
      templateCode: 'ALOP-2024',
      flowId:       flowId ?? null,
      userId:       req.user.id,
      initialData:  initialData ?? {},
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

export default router;
