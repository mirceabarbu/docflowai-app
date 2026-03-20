/**
 * DocFlowAI — routes/flows/index.mjs
 *
 * Orchestrator ARCH-01: flows.mjs (2250 linii) → 7 module specializate
 *
 *   crud.mjs          — CRUD fluxuri, creare, citire, my-flows
 *   signing.mjs       — sign, refuse, upload-signed-pdf, resend, regen-token
 *   lifecycle.mjs     — reinitiere, revizuire, delegare, anulare
 *   attachments.mjs   — documente suport (upload/list/download/delete)
 *   email.mjs         — email extern + tracking (open/click)
 *   acroform.mjs      — detectare câmpuri AcroForm/XFA
 *   cloud-signing.mjs — STS OAuth, cloud providers, signing-callback
 *
 * Injectare deps (același contract ca flows.mjs original):
 *   injectFlowDeps(deps) — apelat din server/index.mjs
 */

import { Router } from 'express';

import crudRouter,        { _injectDeps as _injCrud }        from './crud.mjs';
import signingRouter,     { _injectDeps as _injSigning }      from './signing.mjs';
import lifecycleRouter,   { _injectDeps as _injLifecycle }    from './lifecycle.mjs';
import attachmentsRouter, { _injectDeps as _injAttachments }  from './attachments.mjs';
import emailRouter,       { _injectDeps as _injEmail }        from './email.mjs';
import acroformRouter,    { _injectDeps as _injAcroform }     from './acroform.mjs';
import cloudRouter,       { _injectDeps as _injCloud }        from './cloud-signing.mjs';

const router = Router();

// ── Montăm toate sub-routerele ────────────────────────────────────────────
router.use('/', crudRouter);
router.use('/', signingRouter);
router.use('/', lifecycleRouter);
router.use('/', attachmentsRouter);
router.use('/', emailRouter);
router.use('/', acroformRouter);
router.use('/', cloudRouter);

// ── injectFlowDeps — compatibilitate cu server/index.mjs existent ─────────
// Propagă deps injectate la toate sub-modulele simultan.
export function injectFlowDeps(deps) {
  _injCrud(deps);
  _injSigning(deps);
  _injLifecycle(deps);
  _injAttachments(deps);
  _injEmail(deps);
  _injAcroform(deps);
  _injCloud(deps);
}

export default router;
