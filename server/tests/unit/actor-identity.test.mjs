import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.mjs', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { pool } from '../../db/index.mjs';
import { resolveActor } from '../../services/actor-identity.mjs';

const actor = (overrides = {}) => ({
  userId: 7,
  email: 'actor@test.ro',
  role: 'user',
  orgId: 12,
  tv: 3,
  ...overrides,
});

const row = (overrides = {}) => ({
  id: 7,
  email: 'actor@test.ro',
  nume: 'Actor Test',
  functie: 'Inspector',
  compartiment: 'Juridic',
  institutie: 'Instituția Test',
  role: 'user',
  org_id: 12,
  token_version: 3,
  force_password_change: false,
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe('resolveActor', () => {
  it('respinge JWT fără userId fără query DB', async () => {
    const result = await resolveActor(actor({ userId: null }));
    expect(result).toMatchObject({ ok: false, status: 401, error: 'session_identity_invalid' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'abc'])('respinge tv obligatoriu invalid: %s', async tv => {
    const result = await resolveActor(actor({ tv }));
    expect(result).toMatchObject({ ok: false, status: 401, error: 'session_identity_invalid' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('eșuează închis la eroare DB', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveActor(actor())).toMatchObject({ ok: false, status: 503, error: 'identity_lookup_failed' });
  });

  it('respinge actor inexistent sau soft-deleted', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveActor(actor())).toMatchObject({ ok: false, status: 403, error: 'actor_not_found' });
  });

  it('respinge token_version diferit', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ token_version: 4 })] });
    expect(await resolveActor(actor())).toMatchObject({ ok: false, status: 401, error: 'token_revoked' });
  });

  it('respinge token_version DB invalid', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ token_version: null })] });
    expect(await resolveActor(actor())).toMatchObject({ ok: false, status: 401, error: 'token_revoked' });
  });

  it('respinge organizație diferită', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ org_id: 13 })] });
    expect(await resolveActor(actor())).toMatchObject({ ok: false, status: 401, error: 'session_org_stale' });
  });

  it('acceptă null/null pentru organizație', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ org_id: null })] });
    expect(await resolveActor(actor({ orgId: null }))).toMatchObject({ ok: true });
  });

  it('respinge null JWT versus organizație DB', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ org_id: 12 })] });
    expect(await resolveActor(actor({ orgId: null }))).toMatchObject({ ok: false, error: 'session_org_stale' });
  });

  it('respinge organizație JWT versus null DB', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ org_id: null })] });
    expect(await resolveActor(actor())).toMatchObject({ ok: false, error: 'session_org_stale' });
  });

  it('respinge null versus șir gol', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ org_id: '' })] });
    expect(await resolveActor(actor({ orgId: null }))).toMatchObject({ ok: false, error: 'session_org_stale' });
  });

  it('respinge rol diferit', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ role: 'user' })] });
    expect(await resolveActor(actor({ role: 'admin' }))).toMatchObject({ ok: false, error: 'session_role_stale' });
  });

  it('respinge rol JWT gol sau lipsă', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row()] });
    expect(await resolveActor(actor({ role: '' }))).toMatchObject({ ok: false, error: 'session_role_stale' });
  });

  it('acceptă organizație string echivalentă numeric', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ org_id: 12 })] });
    expect(await resolveActor(actor({ orgId: '12' }))).toEqual({ ok: true, user: row() });
  });

  it('returnează utilizatorul când toate claims sunt concordante', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row()] });
    expect(await resolveActor(actor())).toEqual({ ok: true, user: row() });
  });

  it('identifică exclusiv după id activ, nu după email', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row()] });
    await resolveActor(actor());
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(sql).not.toMatch(/WHERE\s+(?:lower\s*\(\s*)?email/i);
    expect(sql).not.toMatch(/AND\s+(?:lower\s*\(\s*)?email/i);
    expect(params).toEqual([7]);
  });
});
