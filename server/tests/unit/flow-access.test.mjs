/**
 * v3.9.603 — server/services/flow-access.mjs → canActorReadFlow (PUR)
 *
 * Poarta de acces la nivel de obiect pentru fluxuri. Testul unit acoperă doar
 * partea pură (fără DB); ramura „destinatar repartizat" (isFlowAccessAllowed →
 * isFlowRecipient) e acoperită de server/tests/db/flow-doc-acl.test.mjs.
 */
import { describe, it, expect } from 'vitest';
import { canActorReadFlow } from '../../services/flow-access.mjs';

const SIGNER_TOKEN = 'sig-token-xyz';
function makeData() {
  return {
    flowId: 'FLOW_X', initEmail: 'init@x.ro', orgId: 1,
    signers: [{ name: 'S', email: 'sig@x.ro', token: SIGNER_TOKEN }],
  };
}
function actor(email, role, orgId) { return { email, role, orgId, userId: 1 }; }

describe('canActorReadFlow (pur)', () => {
  it('initiator → true', () => {
    expect(canActorReadFlow(actor('init@x.ro', 'user', 1), makeData(), null)).toBe(true);
  });
  it('semnatar după email → true', () => {
    expect(canActorReadFlow(actor('sig@x.ro', 'user', 1), makeData(), null)).toBe(true);
  });
  it('semnatar via token, fără actor → true', () => {
    expect(canActorReadFlow(null, makeData(), SIGNER_TOKEN)).toBe(true);
  });
  it('token greșit, fără actor → false', () => {
    expect(canActorReadFlow(null, makeData(), 'wrong-token')).toBe(false);
  });
  it('admin same-org → true', () => {
    expect(canActorReadFlow(actor('admin@x.ro', 'org_admin', 1), makeData(), null)).toBe(true);
  });
  it('admin cross-org → false', () => {
    expect(canActorReadFlow(actor('admin@y.ro', 'org_admin', 99), makeData(), null)).toBe(false);
  });
  it('străin same-org (non-init, non-signer, user) → false', () => {
    expect(canActorReadFlow(actor('intruder@x.ro', 'user', 1), makeData(), null)).toBe(false);
  });
  it('străin cross-org → false', () => {
    expect(canActorReadFlow(actor('other@y.ro', 'user', 99), makeData(), null)).toBe(false);
  });
  it('anonim fără token → false', () => {
    expect(canActorReadFlow(null, makeData(), null)).toBe(false);
  });
  it('platform-admin (admin fără org_id) cross-org → true (lockout reparat)', () => {
    expect(canActorReadFlow(actor('super@z.ro', 'admin', null), makeData(), null)).toBe(true);
  });
  it('admin CU org_id, cross-org → false (fail-closed până la flip)', () => {
    expect(canActorReadFlow(actor('admin@y.ro', 'admin', 99), makeData(), null)).toBe(false);
  });
  it('admin CU org_id, same-org → true', () => {
    expect(canActorReadFlow(actor('admin@x.ro', 'admin', 1), makeData(), null)).toBe(true);
  });
});
