/**
 * Regresie pe poarta fail-closed care împiedică harness-ul de test să atingă
 * producția (audit P0-01, v3.9.747). Unit — fără conexiune reală la Postgres:
 * doar env vars + stub pe pool.query.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { pool, assertTestDatabase, truncateAll } from '../helpers/db-real.mjs';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('setup.mjs — TEST_DATABASE_URL are întotdeauna prioritate', () => {
  it('ignoră DATABASE_URL (producție) când TEST_DATABASE_URL e setat', async () => {
    process.env.TEST_DATABASE_URL = 'postgres://test-db';
    process.env.DATABASE_URL = 'postgres://PRODUCTIE';
    vi.resetModules();
    await import('../setup.mjs');
    expect(process.env.DATABASE_URL).toBe('postgres://test-db');
  });
});

describe('assertTestDatabase', () => {
  it('aruncă dacă TEST_DATABASE_URL lipsește', () => {
    delete process.env.TEST_DATABASE_URL;
    expect(() => assertTestDatabase()).toThrow(/TEST_DATABASE_URL/);
  });

  it('aruncă dacă DATABASE_URL diferă de TEST_DATABASE_URL', () => {
    process.env.TEST_DATABASE_URL = 'postgres://test-db';
    process.env.DATABASE_URL = 'postgres://PRODUCTIE';
    expect(() => assertTestDatabase()).toThrow(/REFUZ TRUNCATE/);
  });
});

describe('truncateAll — poarta pe numele bazei', () => {
  it('aruncă și NU emite TRUNCATE dacă baza nu se numește "...test..."', async () => {
    process.env.TEST_DATABASE_URL = 'postgres://test-db';
    process.env.DATABASE_URL = 'postgres://test-db';
    delete process.env.TEST_DB_ALLOW_ANY_NAME;
    const spy = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ db: 'railway' }] });

    await expect(truncateAll()).rejects.toThrow(/REFUZ TRUNCATE/);

    const executedSql = spy.mock.calls.map((c) => String(c[0]));
    expect(executedSql.some((sql) => /TRUNCATE/i.test(sql))).toBe(false);
  });

  it('emite TRUNCATE când baza conectată conține "test"', async () => {
    process.env.TEST_DATABASE_URL = 'postgres://test-db';
    process.env.DATABASE_URL = 'postgres://test-db';
    const spy = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ db: 'docflowai_test' }] });

    await truncateAll();

    const executedSql = spy.mock.calls.map((c) => String(c[0]));
    expect(executedSql.some((sql) => /TRUNCATE/i.test(sql))).toBe(true);
  });
});
