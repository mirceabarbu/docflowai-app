/**
 * server/modules/flows/service.mjs — Flow business logic (v4)
 */

import crypto from 'crypto';

import config from '../../config.mjs';
import { generateToken } from '../../core/ids.mjs';
import { ValidationError, NotFoundError, ForbiddenError, AppError } from '../../core/errors.mjs';
import { logAuditEvent } from '../../db/queries/audit.mjs';
import { assertTransition, FLOW_STATUS } from './transitions.mjs';
import * as repo from './repository.mjs';

const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PDF_MAGIC   = Buffer.from('%PDF');
const TOKEN_TTL   = 72 * 60 * 60 * 1000; // 72 hours

// ── createFlow ─────────────────────────────────────────────────────────────────

export async function createFlow({
  org_id, initiator_id, initiator_email = '', initiator_name = '',
  title = '', doc_name = '', doc_type = 'tabel', form_type = 'none',
  signers = [],
}) {
  if (!Array.isArray(signers) || signers.length < 1) {
    throw new ValidationError('Cel puțin un semnatar este necesar', { signers: 'required' });
  }
  if (signers.length > 10) {
    throw new ValidationError('Maximum 10 semnatari', { signers: 'too_many' });
  }
  for (const [i, s] of signers.entries()) {
    if (!s.email || !EMAIL_RE.test(s.email)) {
      throw new ValidationError(`Email invalid pentru semnatarul ${i + 1}`, { signers: 'invalid_email' });
    }
  }

  const flow = await repo.createFlow({
    org_id, initiator_id, initiator_email, initiator_name,
    title, doc_name, doc_type, form_type, signers,
  });

  await _audit({
    orgId: org_id, flowId: flow.id,
    actorId: initiator_id, actorEmail: initiator_email,
    eventType: 'flow.created',
    message: `Flow creat: ${title || doc_name}`,
  });

  return flow;
}

// ── uploadDocument ─────────────────────────────────────────────────────────────

export async function uploadDocument(flow_id, pdfBuffer, { actor_id, org_id, originalName = 'document.pdf' }) {
  const flow = await repo.getFlowById(flow_id, org_id);
  if (!flow) throw new NotFoundError('Flow');

  if (flow.status !== FLOW_STATUS.DRAFT && flow.status !== FLOW_STATUS.ACTIVE) {
    throw new AppError('Documentul poate fi încărcat doar în starea draft sau active', 409, 'WRONG_STATUS');
  }

  // Magic bytes check
  if (!pdfBuffer || pdfBuffer.length < 4 || !pdfBuffer.slice(0, 4).equals(PDF_MAGIC)) {
    throw new ValidationError('Fișierul nu este un PDF valid');
  }
  if (pdfBuffer.length > 15 * 1024 * 1024) {
    throw new ValidationError('PDF-ul depășește limita de 15 MB');
  }

  const sha256  = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const base64  = pdfBuffer.toString('base64');

  const { id: revision_id } = await repo.insertDocumentRevision({
    flow_id, revision_type: 'original',
    pdf_base64: base64, sha256,
    size_bytes: pdfBuffer.length, created_by_id: actor_id,
  });

  await repo.updateFlowDocument(flow_id, base64, originalName);

  // draft → active transition
  if (flow.status === FLOW_STATUS.DRAFT) {
    assertTransition(flow.status, FLOW_STATUS.ACTIVE);
    await repo.updateFlowStatus(flow_id, FLOW_STATUS.ACTIVE);
  }

  await _audit({
    orgId: org_id, flowId: flow_id,
    actorId: actor_id,
    eventType: 'document.uploaded',
    message: `Document încărcat: ${originalName}`,
    meta: { sha256, size_bytes: pdfBuffer.length },
  });

  return { revision_id, sha256 };
}

// ── startFlow ─────────────────────────────────────────────────────────────────

export async function startFlow(flow_id, { actor_id, org_id }) {
  const flow = await repo.getFlowById(flow_id, org_id);
  if (!flow) throw new NotFoundError('Flow');

  if (flow.status !== FLOW_STATUS.ACTIVE) {
    throw new AppError('Flow-ul trebuie să fie în starea active pentru a fi pornit', 409, 'WRONG_STATUS');
  }
  if (!flow.metadata?.hasDocument) {
    throw new AppError('Flow-ul nu are un document încărcat', 409, 'NO_DOCUMENT');
  }

  const signers = Array.isArray(flow.signers) ? flow.signers : [];
  if (signers.length === 0) throw new AppError('Flow-ul nu are semnatari', 409, 'NO_SIGNERS');

  // Sort by step_order and find first pending
  const sorted    = [...signers].sort((a, b) => a.step_order - b.step_order);
  const firstSigner = sorted.find(s => s.status === 'pending');
  if (!firstSigner) throw new AppError('Nu există semnatari pending', 409, 'NO_PENDING_SIGNERS');

  const signerToken   = generateToken();
  const token_expires = new Date(Date.now() + TOKEN_TTL);

  await repo.updateSigner(firstSigner.id, {
    status:       'current',
    token:        signerToken,
    token_expires,
  });

  assertTransition(flow.status, FLOW_STATUS.IN_PROGRESS);
  await repo.updateFlowStatus(flow_id, FLOW_STATUS.IN_PROGRESS);

  const updatedFlow = await repo.getFlowById(flow_id, org_id);

  await _audit({
    orgId: org_id, flowId: flow_id,
    actorId: actor_id,
    eventType: 'flow.started',
    message: `Flow pornit — primul semnatar: ${firstSigner.email}`,
  });

  return {
    flow:        updatedFlow,
    firstSigner: { ...firstSigner, status: 'current', token: signerToken, token_expires },
    signerToken,
  };
}

// ── advanceSigner ─────────────────────────────────────────────────────────────

export async function advanceSigner(token, { decision, notes, signed_pdf_buffer, signing_method } = {}) {
  const signer = await repo.getSignerByToken(token);
  if (!signer) throw new NotFoundError('Token invalid sau expirat');

  if (signer.flow_status !== FLOW_STATUS.IN_PROGRESS) {
    throw new AppError('Flow-ul nu este în starea in_progress', 409, 'WRONG_STATUS');
  }

  if (decision === 'refused') {
    await repo.updateSigner(signer.id, { status: 'refused', decision: 'refused', notes: notes || null });
    await repo.updateFlowStatus(signer.flow_id, FLOW_STATUS.REFUSED);

    await _audit({
      orgId: signer.org_id, flowId: signer.flow_id,
      actorEmail: signer.email,
      eventType: 'flow.refused',
      message: `Flow refuzat de ${signer.email}`,
      meta: { notes },
    });

    return { action: 'refused' };
  }

  // decision === 'approved'
  if (signed_pdf_buffer) {
    const nextSigners = await repo.getNextPendingSigner(signer.flow_id, signer.step_order);
    const revType = nextSigners ? 'signed_partial' : 'signed_final';
    await repo.insertDocumentRevision({
      flow_id:       signer.flow_id,
      revision_type: revType,
      pdf_base64:    signed_pdf_buffer.toString('base64'),
      sha256:        crypto.createHash('sha256').update(signed_pdf_buffer).digest('hex'),
      size_bytes:    signed_pdf_buffer.length,
    });
  }

  await repo.updateSigner(signer.id, {
    status:         'completed',
    decision:       'approved',
    signed_at:      new Date(),
    signing_method: signing_method || null,
  });

  await _audit({
    orgId: signer.org_id, flowId: signer.flow_id,
    actorEmail: signer.email,
    eventType: 'flow.signer.completed',
    message: `Semnatar ${signer.email} a aprobat`,
  });

  const nextSigner = await repo.getNextPendingSigner(signer.flow_id, signer.step_order);

  if (nextSigner) {
    const nextToken   = generateToken();
    const token_expires = new Date(Date.now() + TOKEN_TTL);

    await repo.updateSigner(nextSigner.id, {
      status:       'current',
      token:        nextToken,
      token_expires,
    });

    await _audit({
      orgId: signer.org_id, flowId: signer.flow_id,
      eventType: 'flow.signer.activated',
      message: `Semnatar următor activat: ${nextSigner.email}`,
    });

    return {
      action:     'advanced',
      nextSigner: { ...nextSigner, status: 'current', token: nextToken, token_expires },
    };
  }

  // No more signers → completed
  await repo.updateFlowStatus(signer.flow_id, FLOW_STATUS.COMPLETED, { completed_at: new Date() });

  await _audit({
    orgId: signer.org_id, flowId: signer.flow_id,
    eventType: 'flow.completed',
    message:   'Toți semnatarii au aprobat. Flow finalizat.',
  });

  return { action: 'completed' };
}

// ── cancelFlow ─────────────────────────────────────────────────────────────────

export async function cancelFlow(flow_id, { actor_id, actor_role, org_id, reason }) {
  const flow = await repo.getFlowById(flow_id, org_id);
  if (!flow) throw new NotFoundError('Flow');

  const isAdmin = actor_role === 'admin' || actor_role === 'superadmin';
  if (flow.initiator_id !== actor_id && !isAdmin) {
    throw new ForbiddenError('Doar inițiatorul sau un admin poate anula flow-ul');
  }

  assertTransition(flow.status, FLOW_STATUS.CANCELLED);
  await repo.updateFlowStatus(flow_id, FLOW_STATUS.CANCELLED, { reason });

  await _audit({
    orgId: org_id, flowId: flow_id,
    actorId: actor_id,
    eventType: 'flow.cancelled',
    message: `Flow anulat. Motiv: ${reason || 'nespecificat'}`,
  });
}

// ── delegateSigner ────────────────────────────────────────────────────────────

export async function delegateSigner(flow_id, { from_user_id, to_email, to_name, reason, org_id }) {
  if (!to_email || !EMAIL_RE.test(to_email)) {
    throw new ValidationError('Email destinatar invalid');
  }

  const flow = await repo.getFlowById(flow_id, org_id);
  if (!flow) throw new NotFoundError('Flow');

  const currentSigner = await repo.getCurrentSigner(flow_id);
  if (!currentSigner) throw new NotFoundError('Semnatar curent');

  if (currentSigner.user_id !== from_user_id) {
    throw new ForbiddenError('Nu este rândul tău să semnezi');
  }

  const newToken      = generateToken();
  const token_expires = new Date(Date.now() + TOKEN_TTL);

  await repo.updateSigner(currentSigner.id, {
    email:          to_email,
    name:           to_name || to_email,
    delegated_from: from_user_id,
    notes:          reason || null,
    token:          newToken,
    token_expires,
  });

  await _audit({
    orgId: org_id, flowId: flow_id,
    actorId: from_user_id,
    eventType: 'flow.delegated',
    message:   `Delegat de la user ${from_user_id} la ${to_email}`,
    meta:      { to_email, to_name, reason },
  });

  return { signer: { ...currentSigner, email: to_email, name: to_name }, token: newToken };
}

// ── listFlows (thin wrapper) ──────────────────────────────────────────────────

export async function listFlows(org_id, queryParams = {}, user = {}) {
  return repo.listFlows(org_id, {
    actor_id:    user.id,
    actor_email: user.email,
    actor_role:  user.role,
    status:      queryParams.status,
    page:        queryParams.page,
    limit:       queryParams.limit,
    search:      queryParams.search,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isTokenExpired(token_expires) {
  if (!token_expires) return true;
  return new Date(token_expires) < new Date();
}

export function buildSignerLink(flow_id, token) {
  return `${config.publicBaseUrl}/semdoc-signer.html?flow=${flow_id}&token=${token}`;
}

export function stripSensitive(flowData) {
  if (!flowData) return flowData;
  const result = { ...flowData };
  if (Array.isArray(result.signers)) {
    result.signers = result.signers.map(({ token, token_expires, ...s }) => s);
  }
  return result;
}

export function stripPdfBase64(flowData) {
  if (!flowData) return flowData;
  return { ...flowData, pdfB64: undefined };
}

// ── Internal audit helper ─────────────────────────────────────────────────────

async function _audit({ orgId, flowId, actorId, actorEmail, eventType, message, meta = {} }) {
  try {
    await logAuditEvent({
      orgId, flowId,
      actorId:    actorId  ?? null,
      actorEmail: actorEmail ?? null,
      eventType,
      message,
      meta,
    });
  } catch (_) { /* fire-and-forget */ }
}
