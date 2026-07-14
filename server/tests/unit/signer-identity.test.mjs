import { beforeEach, describe, expect, it, vi } from 'vitest';

// DB_READY e `export let` în producție → aici îl controlăm printr-un getter mutabil (hoisted).
const h = vi.hoisted(() => ({ dbReady: true }));
vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn() },
  get DB_READY() { return h.dbReady; },
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { pool } from '../../db/index.mjs';
import { classifySignerEmail } from '../../services/signer-identity.mjs';

beforeEach(() => {
  vi.clearAllMocks();
  h.dbReady = true;
});

describe('classifySignerEmail', () => {
  it('zero rânduri ⇒ external (semnatar extern, legitim)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await classifySignerEmail('nimeni@extern.ro')).toEqual({ cls: 'external', userId: null });
  });

  it('un rând activ (deleted_at null) ⇒ active + userId', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, deleted_at: null }] });
    expect(await classifySignerEmail('activ@x.ro')).toEqual({ cls: 'active', userId: 42 });
  });

  it('un rând șters ⇒ deactivated', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 9, deleted_at: new Date().toISOString() }] });
    expect(await classifySignerEmail('sters@x.ro')).toEqual({ cls: 'deactivated', userId: 9 });
  });

  it('două rânduri, ȘTERS primul + activ al doilea ⇒ active (ordinea fizică nu contează)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, deleted_at: '2026-01-01T00:00:00Z' },
      { id: 2, deleted_at: null },
    ] });
    expect(await classifySignerEmail('reutilizat@x.ro')).toEqual({ cls: 'active', userId: 2 });
  });

  it.each([undefined, null, '', '   '])('email gol/null (%s) ⇒ external, fără apel DB', async (email) => {
    expect(await classifySignerEmail(email)).toEqual({ cls: 'external', userId: null });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('DB_READY=false ⇒ unknown, fără apel la DB', async () => {
    h.dbReady = false;
    expect(await classifySignerEmail('x@x.ro')).toEqual({ cls: 'unknown', userId: null });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('query aruncă ⇒ unknown', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    expect(await classifySignerEmail('x@x.ro')).toEqual({ cls: 'unknown', userId: null });
  });

  it('normalizează emailul: trim + lower(email) în interogare', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, deleted_at: null }] });
    await classifySignerEmail('  MIXED@Case.RO  ');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/lower\(email\)\s*=\s*\$1/i);
    expect(params).toEqual(['mixed@case.ro']);
  });
});
