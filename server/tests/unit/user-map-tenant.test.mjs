/**
 * SEC-101 (TENANT-01) — getUserMapForOrg fail-closed + deleted_at.
 *
 * IMPORTĂ funcția REALĂ din producție (db/index.mjs) și mock-uiește DOAR pool-ul pg,
 * ca să dovedim că fără org NU se atinge DB-ul (fail-closed) și că SQL-ul conține
 * scope-ul de org + deleted_at. NU redeclarăm logica.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));

// Mock pg: new Pool() întoarce un obiect cu query controlabil + on() (pool.on('error') la load).
// Pool trebuie să fie constructabil (class), nu vi.fn() cu arrow.
vi.mock('pg', () => {
  class Pool {
    query(...a) { return h.queryMock(...a); }
    on() {}
  }
  return { default: { Pool } };
});
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  redactUrl: (u) => u,
}));

import { getUserMapForOrg } from '../../db/index.mjs';

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockResolvedValue({ rows: [] });
});

describe('getUserMapForOrg — fail-closed (SEC-101)', () => {
  it('null ⇒ {} și pool.query NU e apelat', async () => {
    const map = await getUserMapForOrg(null);
    expect(map).toEqual({});
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('0 ⇒ {} fără apel la DB', async () => {
    const map = await getUserMapForOrg(0);
    expect(map).toEqual({});
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('undefined ⇒ {} fără apel la DB', async () => {
    const map = await getUserMapForOrg(undefined);
    expect(map).toEqual({});
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('org valid ⇒ SQL conține org_id ȘI deleted_at IS NULL, params=[org]', async () => {
    h.queryMock.mockResolvedValueOnce({
      rows: [{ email: 'A@X.ro', functie: 'F', compartiment: 'C', institutie: 'I' }],
    });
    const map = await getUserMapForOrg(7);
    expect(h.queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = h.queryMock.mock.calls[0];
    expect(sql).toMatch(/org_id\s*=\s*\$1/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(params).toEqual([7]);
    // email normalizat lowercase
    expect(map['a@x.ro']).toBeTruthy();
  });

  it('harta goală NU se cachează: două apeluri null ⇒ {}, apoi org valid interoghează DB-ul', async () => {
    expect(await getUserMapForOrg(null)).toEqual({});
    expect(await getUserMapForOrg(null)).toEqual({});
    expect(h.queryMock).not.toHaveBeenCalled();

    // org nefolosit anterior (cache curat) ⇒ trebuie să lovească DB-ul
    await getUserMapForOrg(4242);
    expect(h.queryMock).toHaveBeenCalledTimes(1);
  });
});
