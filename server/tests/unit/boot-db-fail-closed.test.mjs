/**
 * #207 — Boot DB fail-closed: `initDbWithRetry` ARUNCĂ după epuizarea încercărilor.
 *
 * Înainte, funcția loga „DB init failed permanent. Exiting." și se întorcea NORMAL —
 * lanțul `.then()` din server/index.mjs continua, runMigrationsV4 reușea (baza e
 * accesibilă, picase doar o migrare inline), markDbReady() declara baza gata și
 * aplicația servea trafic cu schema inline INCOMPLETĂ.
 *
 * Importă funcția REALĂ din db/index.mjs și mock-uiește DOAR pool-ul pg (ca în
 * user-map-tenant.test.mjs). Întârzierile (1+2+4+8+15 s) sunt scurtcircuitate prin
 * spy pe setTimeout — altfel testul ar dura 30 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryMock:   vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock('pg', () => {
  class Pool {
    query(...a)   { return h.queryMock(...a); }
    connect(...a) { return h.connectMock(...a); }
    on() {}
  }
  return { default: { Pool } };
});
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  redactUrl: (u) => u,
}));

import { initDbWithRetry, DB_LAST_ERROR } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';

/** Client pg mock pentru ramura de succes a initDbOnce (BEGIN / migrări / COMMIT). */
function okClient() {
  return {
    query: vi.fn(async (sql) => {
      if (typeof sql === 'string' && /SELECT id FROM schema_migrations/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

/** pool.query care reușește pe orice — inclusiv COUNT(*) users (citit ca uc[0].count). */
async function okQuery(sql) {
  if (typeof sql === 'string' && /COUNT\(\*\) FROM users/.test(sql)) return { rows: [{ count: '1' }], rowCount: 1 };
  if (typeof sql === 'string' && /role='admin' LIMIT 1/.test(sql))  return { rows: [{ id: 1 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

let setTimeoutSpy;
beforeEach(() => {
  h.queryMock.mockReset();
  h.connectMock.mockReset();
  vi.clearAllMocks();
  // Fără așteptare reală între încercări: fn-ul rulează la următorul microtask.
  setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => { Promise.resolve().then(fn); return 0; });
});
afterEach(() => { setTimeoutSpy.mockRestore(); });

describe('#207 initDbWithRetry — fail-closed', () => {
  it('⭐ initDbOnce eșuează la TOATE cele 5 încercări ⇒ promisiunea RESPINGE cu ultima eroare (înainte: se rezolva normal)', async () => {
    let n = 0;
    h.queryMock.mockImplementation(async () => { n++; throw new Error(`boom-${n}`); });

    await expect(initDbWithRetry()).rejects.toThrow('boom-5');

    // 5 încercări = 5 × `SELECT 1` picate, apoi stop.
    expect(n).toBe(5);
    expect(h.connectMock).not.toHaveBeenCalled();
    // Mesajul nu mai promite „Exiting" fără să iasă — descrie oprirea reală.
    const lastErrLog = logger.error.mock.calls.at(-1);
    expect(lastErrLog[0]?.err?.message).toBe('boom-5');
    expect(lastErrLog[1]).toMatch(/permanent/);
    expect(lastErrLog[1]).not.toMatch(/Exiting/);
  });

  it('initDbOnce reușește la a 3-a încercare ⇒ se rezolvă, fără throw', async () => {
    let n = 0;
    h.queryMock.mockImplementation(async (sql) => {
      n++;
      if (n <= 2) throw new Error(`transient-${n}`);
      return okQuery(sql);
    });
    h.connectMock.mockImplementation(async () => okClient());

    await expect(initDbWithRetry()).resolves.toBeUndefined();

    expect(h.connectMock).toHaveBeenCalledTimes(1);
    // Exact două întârzieri consumate (după eșecurile 1 și 2), niciuna după succes.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls.some(c => /permanent/.test(String(c[1])))).toBe(false);
  });
});
