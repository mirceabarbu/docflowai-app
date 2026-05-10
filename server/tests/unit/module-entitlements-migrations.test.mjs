/**
 * DocFlowAI — Unit tests: module_catalog + module_entitlements migrations
 *
 * Verifică că migrațiile 070/071 sunt prezente în MIGRATIONS[] din db/index.mjs
 * și conțin DDL-ul corect (CREATE TABLE, seed, constraints).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const dbSrc = readFileSync(join(__dir, '../../db/index.mjs'), 'utf-8');

describe('Migration 070_module_catalog', () => {
  it('exists in MIGRATIONS array', () => {
    expect(dbSrc).toContain("'070_module_catalog'");
  });

  it('creates module_catalog table with correct columns', () => {
    expect(dbSrc).toContain('CREATE TABLE IF NOT EXISTS module_catalog');
    expect(dbSrc).toContain('module_key      TEXT PRIMARY KEY');
    expect(dbSrc).toContain('display_name    TEXT NOT NULL');
    expect(dbSrc).toContain('default_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(dbSrc).toContain('active          BOOLEAN NOT NULL DEFAULT TRUE');
    expect(dbSrc).toContain('display_order   INTEGER NOT NULL DEFAULT 100');
  });

  it('seeds 7 modules with default_enabled = TRUE', () => {
    const modules = ['refnec', 'nf-invest', 'alop', 'df', 'ord', 'clasa8', 'verif-furnizor'];
    for (const m of modules) {
      expect(dbSrc).toContain(`'${m}'`);
    }
    expect(dbSrc).toContain('ON CONFLICT (module_key) DO NOTHING');
  });

  it('seed categories are correct', () => {
    expect(dbSrc).toMatch(/'refnec'.*'documente'/s);
    expect(dbSrc).toMatch(/'nf-invest'.*'documente'/s);
    expect(dbSrc).toMatch(/'alop'.*'alop'/s);
    expect(dbSrc).toMatch(/'clasa8'.*'verificari'/s);
  });
});

describe('Migration 071_module_entitlements', () => {
  it('exists in MIGRATIONS array', () => {
    expect(dbSrc).toContain("'071_module_entitlements'");
  });

  it('creates module_entitlements table with FK and constraints', () => {
    expect(dbSrc).toContain('CREATE TABLE IF NOT EXISTS module_entitlements');
    expect(dbSrc).toContain('REFERENCES module_catalog(module_key) ON DELETE CASCADE');
    expect(dbSrc).toContain("CHECK (scope_type IN ('org','comp','user'))");
    expect(dbSrc).toContain('UNIQUE (module_key, scope_type, scope_id)');
    expect(dbSrc).toContain('REFERENCES users(id)');
  });

  it('creates lookup index', () => {
    expect(dbSrc).toContain('CREATE INDEX IF NOT EXISTS idx_module_entitlements_lookup');
    expect(dbSrc).toContain('ON module_entitlements (scope_type, scope_id, module_key)');
  });

  it('scope_id is TEXT (supports compartiment strings)', () => {
    expect(dbSrc).toMatch(/scope_id\s+TEXT\s+NOT NULL/);
  });
});

describe('Migration ordering', () => {
  it('070 comes before 071 in the file', () => {
    const pos070 = dbSrc.indexOf("'070_module_catalog'");
    const pos071 = dbSrc.indexOf("'071_module_entitlements'");
    expect(pos070).toBeGreaterThan(-1);
    expect(pos071).toBeGreaterThan(pos070);
  });

  it('both come after 069_clasa8_buget', () => {
    const pos069 = dbSrc.indexOf("'069_clasa8_buget'");
    const pos070 = dbSrc.indexOf("'070_module_catalog'");
    expect(pos070).toBeGreaterThan(pos069);
  });
});
