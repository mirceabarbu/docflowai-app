// ─────────────────────────────────────────────────────────────────────────────
// flow-access.mjs — Poartă de acces la nivel de obiect pentru fluxuri
//
//   canActorReadFlow(actor, data, signerToken) → PUR: init | semnatar | admin
//                                                 same-org | signer token
//   isFlowAccessAllowed(pool, actor, data, signerToken) → canActorReadFlow ∪
//                                                 destinatar repartizat (async)
//
// Folosit de GET /flows/:flowId (metadata) ȘI de endpointurile de conținut
// (signed-pdf / pdf / attachments) — aceeași poartă peste tot, ca să nu mai
// existe IDOR pe documentele financiare de flux.
// ─────────────────────────────────────────────────────────────────────────────
import { isFlowRecipient } from './flow-transmit.mjs';
import { isPlatformAdmin } from './authz-scope.mjs';

// Mutat din routes/flows/crud.mjs (v3.9.502) — semantică IDENTICĂ.
// v3.9.502 (A-3 P0): înainte GET /flows/:flowId permitea citire pentru ORICE
// user autentificat → leak metadata cross-org. Acum: doar initiator, signer,
// sau admin/org_admin din aceeași org. Plus signer token (semnatari neînregistrați).
export function canActorReadFlow(actor, data, signerToken) {
  if (signerToken && (data.signers || []).some(s => s.token === signerToken)) return true;
  if (!actor) return false;
  const email = String(actor.email || '').toLowerCase();
  const isInit = String(data.initEmail || '').toLowerCase() === email;
  const isSigner = (data.signers || []).some(s => String(s.email || '').toLowerCase() === email);
  const sameOrg = actor.orgId && data.orgId && String(actor.orgId) === String(data.orgId);
  const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
  // #105f: platform-admin (admin fără org_id) vede tot cross-org; altfel same-org (fail-closed)
  return isInit || isSigner || (isAdmin && (isPlatformAdmin(actor) || sameOrg));
}

// Poarta la nivel de obiect pentru vizualizare flux + conținut (signed-pdf/pdf/attachments).
// Extinde canActorReadFlow cu ramura „destinatar repartizat" (transmitere internă).
// flowId explicit (din URL) are prioritate față de data.flowId (JSONB poate lipsi pe fluxuri
// inserate direct în test sau legacy care nu au persitat flowId în blob).
export async function isFlowAccessAllowed(pool, actor, data, signerToken, flowId = null) {
  if (canActorReadFlow(actor, data, signerToken)) return true;
  const fid = flowId || data?.flowId || null;
  if (!actor || !fid) return false;
  return await isFlowRecipient(pool, fid, actor);
}
