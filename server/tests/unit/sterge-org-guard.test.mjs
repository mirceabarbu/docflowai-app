/**
 * #105e — stergeFormular: guard de tenant.
 * Platform-admin sare peste bariera de org; admin-cu-org și org_admin doar pe același org.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../db/index.mjs', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../services/authz-formular.mjs', () => ({
  loadActorComp:   vi.fn(),
  canEditFormular: vi.fn(),
  canDestroyOnly:  vi.fn(() => ({ allowed: false, reason: 'not_destroyable' })),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as dbModule from '../../db/index.mjs';
import { stergeFormular } from '../../services/formular-shared.mjs';

function mockDoc(orgId) {
  dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: 'x', org_id: orgId, flow_id: null }] });
}

describe('#105e — stergeFormular tenant guard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('org_admin din ALT org → 403 forbidden (tenant)', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'org_admin', orgId: 2, userId: 5 } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });

  it('platform-admin (fără org_id) → sare peste tenant guard (eroarea NU e forbidden)', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'admin', orgId: null, userId: 1 } });
    expect(r.body.error).not.toBe('forbidden');
  });

  it('admin CU org_id, ACELAȘI org → trece de tenant guard', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'admin', orgId: 1, userId: 1 } });
    expect(r.body.error).not.toBe('forbidden');
  });

  it('admin CU org_id, ALT org → 403 forbidden (fail-closed)', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'admin', orgId: 2, userId: 1 } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });
});
