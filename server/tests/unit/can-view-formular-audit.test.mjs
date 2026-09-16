// #216 — canViewFormularAudit: sursa unică pentru poarta GET /api/formulare-audit/:type/:id
// ȘI pentru câmpul `can_audit` din GET /api/formulare/list. Tabel de adevăr.
import { describe, it, expect } from 'vitest';
import { canViewFormularAudit } from '../../services/authz-formular.mjs';

describe('canViewFormularAudit — tabel de adevăr', () => {
  it('admin ⇒ true chiar pe document din altă organizație', () => {
    const actor = { role: 'admin', orgId: 1 };
    expect(canViewFormularAudit(actor, { docOrgId: 99 })).toBe(true);
  });

  it('org_admin ⇒ true pe același org', () => {
    const actor = { role: 'org_admin', orgId: 1 };
    expect(canViewFormularAudit(actor, { docOrgId: 1 })).toBe(true);
  });

  it('org_admin ⇒ false pe alt org', () => {
    const actor = { role: 'org_admin', orgId: 1 };
    expect(canViewFormularAudit(actor, { docOrgId: 99 })).toBe(false);
  });

  it('user CAB ⇒ true pe același org', () => {
    const actor = { role: 'user', orgId: 1 };
    expect(canViewFormularAudit(actor, {
      actorComp: 'Serviciul Buget', cabComp: 'Serviciul Buget', docOrgId: 1,
    })).toBe(true);
  });

  it('user CAB ⇒ false pe alt org', () => {
    const actor = { role: 'user', orgId: 1 };
    expect(canViewFormularAudit(actor, {
      actorComp: 'Serviciul Buget', cabComp: 'Serviciul Buget', docOrgId: 99,
    })).toBe(false);
  });

  it('user non-CAB ⇒ false', () => {
    const actor = { role: 'user', orgId: 1 };
    expect(canViewFormularAudit(actor, {
      actorComp: 'Contabilitate', cabComp: 'Serviciul Buget', docOrgId: 1,
    })).toBe(false);
  });

  it('user fără compartiment și cabComp gol ⇒ false', () => {
    const actor = { role: 'user', orgId: 1 };
    expect(canViewFormularAudit(actor, { actorComp: '', cabComp: '', docOrgId: 1 })).toBe(false);
  });

  it('actor null ⇒ false', () => {
    expect(canViewFormularAudit(null, { docOrgId: 1 })).toBe(false);
  });

  it('docOrgId absent pentru CAB ⇒ true (folosire în listă, deja scopată pe org)', () => {
    const actor = { role: 'user', orgId: 1 };
    expect(canViewFormularAudit(actor, { actorComp: 'Serviciul Buget', cabComp: 'Serviciul Buget' })).toBe(true);
  });
});
