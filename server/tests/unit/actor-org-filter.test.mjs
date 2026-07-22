/**
 * #105c — actorOrgFilter: contract platform-admin vs. org-scoped.
 * Doar platform-admin (admin fără org_id) → null (fără filtru). Restul → propriul org.
 */
import { describe, it, expect } from 'vitest';
import { actorOrgFilter } from '../../routes/admin/_helpers.mjs';

describe('actorOrgFilter (#105c)', () => {
  it('platform-admin (admin fără org_id) ⇒ null (vede tot)', () => {
    expect(actorOrgFilter({ role: 'admin', orgId: null })).toBe(null);
    expect(actorOrgFilter({ role: 'admin' })).toBe(null);
  });
  it('admin CU org_id ⇒ scopat la propriul org (NU null) — fixul central', () => {
    expect(actorOrgFilter({ role: 'admin', orgId: 1 })).toBe(1);
    expect(actorOrgFilter({ role: 'admin', orgId: 2 })).toBe(2);
  });
  it('org_admin ⇒ propriul org', () => {
    expect(actorOrgFilter({ role: 'org_admin', orgId: 5 })).toBe(5);
  });
  it('org_admin fără org_id (nu apare în practică) ⇒ null', () => {
    // Documentăm comportamentul; apelanții gatează pe isAdminOrOrgAdmin, iar org_admin
    // are întotdeauna org_id la creare. Fail-closed real trăiește în orgScopeSql (authz-scope).
    expect(actorOrgFilter({ role: 'org_admin', orgId: null })).toBe(null);
  });
});
