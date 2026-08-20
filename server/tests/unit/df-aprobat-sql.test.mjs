import { describe, it, expect } from 'vitest';
import { dfAprobatSql, dfAprobatExistsSql } from '../../services/df-aprobat-sql.mjs';

function balancedParens(sql) {
  let depth = 0;
  for (const ch of sql) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('df-aprobat-sql', () => {
  it('dfAprobatSql folosește aliasurile implicite fd/f', () => {
    const sql = dfAprobatSql();
    expect(sql).toContain('fd.flow_id IS NOT NULL');
    expect(sql).toContain('f.deleted_at IS NULL');
  });

  it('dfAprobatSql acceptă aliasuri personalizate', () => {
    const sql = dfAprobatSql('dfx', 'fx');
    expect(sql).toContain('dfx.flow_id IS NOT NULL');
    expect(sql).toContain('fx.deleted_at IS NULL');
    expect(sql).not.toContain('fd.');
    expect(sql).not.toMatch(/\bf\.deleted_at/);
  });

  it('dfAprobatSql conține cele patru gărzi', () => {
    const sql = dfAprobatSql();
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain("IS DISTINCT FROM 'cancelled'");
    expect(sql).toContain("IS DISTINCT FROM 'refused'");
    expect(sql).toMatch(/'status'\)\s*=\s*'completed'|'completed'\)::boolean = true/);
  });

  it('dfAprobatExistsSql folosește aliasul implicit fx', () => {
    const sql = dfAprobatExistsSql('a.df_flow_id');
    expect(sql).toContain('fx.id::text = a.df_flow_id');
    expect(sql).toContain('fx.deleted_at IS NULL');
  });

  it('dfAprobatExistsSql conține cele patru gărzi și interpolează flowExpr', () => {
    const flowExpr = `COALESCE((SELECT dfx.flow_id FROM formulare_df dfx WHERE dfx.id = a.df_id), a.df_flow_id)`;
    const sql = dfAprobatExistsSql(flowExpr, 'fx');
    expect(sql).toContain(`fx.id::text = ${flowExpr}`);
    expect(sql).toContain('fx.deleted_at IS NULL');
    expect(sql).toContain("IS DISTINCT FROM 'cancelled'");
    expect(sql).toContain("IS DISTINCT FROM 'refused'");
    expect(sql).toContain("'completed'");
  });

  it('acceptă aliasuri personalizate pentru fx în varianta EXISTS', () => {
    const sql = dfAprobatExistsSql('a.df_flow_id', 'ffx');
    expect(sql).toContain('ffx.id::text');
    expect(sql).toContain('ffx.deleted_at IS NULL');
  });

  it('nu conține niciun backtick în ieșire', () => {
    expect(dfAprobatSql()).not.toContain('`');
    expect(dfAprobatExistsSql('a.df_flow_id')).not.toContain('`');
  });

  it('ieșirea e echilibrată ca paranteze', () => {
    expect(balancedParens(dfAprobatSql())).toBe(true);
    expect(balancedParens(dfAprobatExistsSql('a.df_flow_id'))).toBe(true);
  });
});
