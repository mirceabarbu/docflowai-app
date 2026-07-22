import { describe, it, expect } from 'vitest';
import {
  isPlatformAdmin,
  isAdminOrOrgAdmin,
  orgScopeSql,
  actorCanAccessOrg,
} from '../../services/authz-scope.mjs';

describe('isPlatformAdmin', () => {
  it('admin fără org_id ⇒ true (contul de platformă)', () => {
    expect(isPlatformAdmin({ role: 'admin', orgId: null })).toBe(true);
    expect(isPlatformAdmin({ role: 'admin' })).toBe(true);
  });
  it('admin CU org_id ⇒ true (role-only: role=admin ⟺ platform)', () => {
    expect(isPlatformAdmin({ role: 'admin', orgId: 1 })).toBe(true);
  });
  it('org_admin / user ⇒ false indiferent de org_id', () => {
    expect(isPlatformAdmin({ role: 'org_admin', orgId: null })).toBe(false);
    expect(isPlatformAdmin({ role: 'user', orgId: 5 })).toBe(false);
  });
  it('actor null/undefined ⇒ false, fără excepție', () => {
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });
});

describe('isAdminOrOrgAdmin', () => {
  it('admin și org_admin ⇒ true; user ⇒ false; null ⇒ false', () => {
    expect(isAdminOrOrgAdmin({ role: 'admin' })).toBe(true);
    expect(isAdminOrOrgAdmin({ role: 'org_admin' })).toBe(true);
    expect(isAdminOrOrgAdmin({ role: 'user' })).toBe(false);
    expect(isAdminOrOrgAdmin(null)).toBe(false);
  });
});

describe('orgScopeSql', () => {
  it('platform-admin ⇒ fragment gol, params NEATINS', () => {
    const params = ['x'];
    const sql = orgScopeSql({ role: 'admin', orgId: null }, 'a', params);
    expect(sql).toBe('');
    expect(params).toEqual(['x']);
  });
  it('org_admin ⇒ împinge org_id și placeholder corect ($N = params.length)', () => {
    const params = ['x'];
    const sql = orgScopeSql({ role: 'org_admin', orgId: 7 }, 'fd', params);
    expect(sql).toBe(' AND fd.org_id = $2');
    expect(params).toEqual(['x', 7]);
  });
  it('admin CU org_id ⇒ platform, fără filtru (role-only)', () => {
    const params = [];
    const sql = orgScopeSql({ role: 'admin', orgId: 1 }, 'a', params);
    expect(sql).toBe('');
    expect(params).toEqual([]);
  });
  it('non-platform fără org_id ⇒ = NULL (fail-closed, 0 rânduri), NU fără filtru', () => {
    const params = [];
    const sql = orgScopeSql({ role: 'org_admin', orgId: null }, 'a', params);
    expect(sql).toBe(' AND a.org_id = $1');
    expect(params).toEqual([null]);
  });
});

describe('actorCanAccessOrg', () => {
  it('platform-admin ⇒ true pt orice org', () => {
    expect(actorCanAccessOrg({ role: 'admin', orgId: null }, 999)).toBe(true);
  });
  it('același org ⇒ true (comparație pe string, tolerantă number/string)', () => {
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: 3 }, 3)).toBe(true);
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: '3' }, 3)).toBe(true);
  });
  it('org diferit ⇒ false', () => {
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: 3 }, 4)).toBe(false);
  });
  it('admin CU org_id ⇒ platform, acces la orice org (role-only)', () => {
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 2)).toBe(true);
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 1)).toBe(true);
  });
  it('org_id lipsă (și non-platform) ⇒ false, fără excepție', () => {
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: null }, 1)).toBe(false);
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: 2 }, null)).toBe(false);
    expect(actorCanAccessOrg(null, 1)).toBe(false);
  });
});
