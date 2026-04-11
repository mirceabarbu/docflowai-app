/**
 * server/modules/flows/routes.mjs — Flow API routes (v4)
 * Mounted at /api/flows in app.mjs
 */

import { Router }       from 'express';
import { requireAuth }  from '../../middleware/auth.mjs';
import { acceptPdf }    from '../../middleware/uploadGuard.mjs';
import { getOrgId }     from '../../core/tenant.mjs';
import * as svc         from './service.mjs';
import * as repo        from './repository.mjs';

const router = Router();

// ── GET /api/flows ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const org_id = getOrgId(req);
    const result = await svc.listFlows(org_id, req.query, req.user);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/flows ────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { user } = req;
    const flow = await svc.createFlow({
      org_id:          getOrgId(req),
      initiator_id:    user.id,
      initiator_email: user.email,
      initiator_name:  user.name || '',
      ...req.body,
    });
    res.status(201).json(flow);
  } catch (err) { next(err); }
});

// ── GET /api/flows/:id ─────────────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const flow = await repo.getFlowById(req.params.id, getOrgId(req));
    if (!flow) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flow not found' } });
    res.json(svc.stripPdfBase64(svc.stripSensitive(flow)));
  } catch (err) { next(err); }
});

// ── DELETE /api/flows/:id — cancel ────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { user } = req;
    await svc.cancelFlow(req.params.id, {
      actor_id:   user.id,
      actor_role: user.role,
      org_id:     getOrgId(req),
      reason:     req.body?.reason,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/flows/:id/document ──────────────────────────────────────────────

router.post('/:id/document', requireAuth, acceptPdf({ maxSizeMB: 15 }), async (req, res, next) => {
  try {
    const { user } = req;
    const result = await svc.uploadDocument(req.params.id, req.uploadedFile.buffer, {
      actor_id:     user.id,
      org_id:       getOrgId(req),
      originalName: req.uploadedFile.originalName,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── POST /api/flows/:id/start ─────────────────────────────────────────────────

router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const { user } = req;
    const result = await svc.startFlow(req.params.id, {
      actor_id: user.id,
      org_id:   getOrgId(req),
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/flows/:id/advance ───────────────────────────────────────────────

router.post('/:id/advance', async (req, res, next) => {
  try {
    const { token, decision = 'approved', notes, signing_method } = req.body;
    if (!token) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'token required' } });
    const result = await svc.advanceSigner(token, { decision, notes, signing_method });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/flows/:id/refuse ────────────────────────────────────────────────

router.post('/:id/refuse', async (req, res, next) => {
  try {
    const { token, notes } = req.body;
    if (!token) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'token required' } });
    const result = await svc.advanceSigner(token, { decision: 'refused', notes });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/flows/:id/delegate ──────────────────────────────────────────────

router.post('/:id/delegate', requireAuth, async (req, res, next) => {
  try {
    const { user } = req;
    const result = await svc.delegateSigner(req.params.id, {
      from_user_id: user.id,
      org_id:       getOrgId(req),
      ...req.body,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/flows/:id/signers ────────────────────────────────────────────────

router.get('/:id/signers', requireAuth, async (req, res, next) => {
  try {
    const flow = await repo.getFlowById(req.params.id, getOrgId(req));
    if (!flow) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flow not found' } });
    res.json(svc.stripSensitive({ signers: flow.signers }).signers);
  } catch (err) { next(err); }
});

// ── GET /api/flows/:id/revisions ──────────────────────────────────────────────

router.get('/:id/revisions', requireAuth, async (req, res, next) => {
  try {
    const flow = await repo.getFlowById(req.params.id, getOrgId(req));
    if (!flow) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flow not found' } });
    const revisions = await repo.getFlowRevisions(req.params.id);
    res.json(revisions);
  } catch (err) { next(err); }
});

export default router;
