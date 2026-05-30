/**
 * v3.9.517 — Self-healing ALOP↔ORD pe GET /api/alop/:id
 *
 * String-match guard că blocurile self-heal sunt prezente cu logica corectă.
 * Comportament real testabil doar pe staging (depinde de date).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ALOP self-heal orphan ORD (v3.9.517)', () => {
  const SRC = readFileSync(path.join(REPO, 'server/routes/alop.mjs'), 'utf8');
  const DB  = readFileSync(path.join(REPO, 'server/db/index.mjs'), 'utf8');

  it('self-heal #1 prezent — orphan ORD link by df_id', () => {
    expect(SRC).toMatch(/self-heal #1/);
    // Condiție de declanșare
    expect(SRC).toMatch(/alop\.status\s*===?\s*['"]ordonantare['"][\s\S]{0,80}!alop\.ord_id[\s\S]{0,80}alop\.df_id/);
    // Heuristic match prin df_id
    expect(SRC).toMatch(/fo\.df_id\s*=\s*\$1/);
    // Safety: nu deja legat la alt ALOP/ciclu
    expect(SRC).toMatch(/NOT EXISTS[\s\S]{0,300}a2\.ord_id\s*=\s*fo\.id/);
    expect(SRC).toMatch(/NOT EXISTS[\s\S]{0,300}c\.ord_id\s*=\s*fo\.id/);
    // Max 2 candidați (1=link, 2+=ambiguu)
    expect(SRC).toMatch(/LIMIT 2/);
    expect(SRC).toMatch(/cands\.length\s*===?\s*1/);
    expect(SRC).toMatch(/cands\.length\s*>\s*1/);
  });

  it('self-heal #2 prezent — ord_flow_id back-fill', () => {
    expect(SRC).toMatch(/self-heal #2/);
    expect(SRC).toMatch(/alop\.ord_id[\s\S]{0,80}!alop\.ord_flow_id/);
  });

  it('self-heal: tranziție automată la plata dacă flow complet', () => {
    expect(SRC).toMatch(/status\s*=\s*['"]plata['"]/);
    expect(SRC).toMatch(/willTransitionToPlata/);
  });

  it('self-heal e idempotent — guard în WHERE clause', () => {
    // #1: AND ord_id IS NULL
    expect(SRC).toMatch(/UPDATE alop_instances[\s\S]{0,800}AND ord_id IS NULL[\s\S]{0,200}RETURNING ord_id/);
    // #2: AND ord_flow_id IS NULL
    expect(SRC).toMatch(/UPDATE alop_instances[\s\S]{0,500}AND ord_flow_id IS NULL[\s\S]{0,200}RETURNING ord_flow_id/);
  });

  it('self-heal e non-fatal (try/catch + logger.warn)', () => {
    expect(SRC).toMatch(/\[ALOP\] self-heal #1[\s\S]{0,200}failed/);
    expect(SRC).toMatch(/\[ALOP\] self-heal #2[\s\S]{0,200}failed/);
    expect(SRC).toMatch(/logger\.warn[\s\S]{0,400}self-heal/);
  });

  it('self-heal folosește alop.org_id (nu actor.orgId — cross-org safety)', () => {
    // Pickează alop.df_id, alop.org_id ca parametri
    expect(SRC).toMatch(/\[alop\.df_id,\s*alop\.org_id\]/);
    expect(SRC).toMatch(/\[alop\.ord_id,\s*alop\.org_id\]/);
  });

  it('self-heal apelează OPME auto-confirm la tranziție plata', () => {
    // Split pe header-ele de secțiune (`// ── Self-heal #N`), nu pe string-urile
    // de log (care apar de mai multe ori per bloc și ar fragmenta greșit).
    const heals = SRC.match(/\/\/ ── Self-heal #[12][\s\S]*?(?=\/\/ ── Self-heal #[12]|\/\/ ORD aprobat dar ALOP|\/\/ Calcul sumă rămasă|$)/g);
    expect(heals, 'blocurile self-heal nu au fost găsite').toBeTruthy();
    heals.forEach(block => {
      if (block.includes('willTransitionToPlata') && block.includes('linked[0]')) {
        expect(block).toMatch(/tryAutoConfirmAlop/);
      }
    });
  });

  it('db/index.mjs: migration 082 index pe formulare_ord(df_id)', () => {
    expect(DB).toMatch(/082_formulare_ord_df_id_idx/);
    expect(DB).toMatch(/idx_formulare_ord_df_id/);
    expect(DB).toMatch(/ON formulare_ord\(df_id\)/);
    expect(DB).toMatch(/deleted_at IS NULL/);
  });
});
