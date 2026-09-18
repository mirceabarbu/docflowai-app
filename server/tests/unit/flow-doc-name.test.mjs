// server/tests/unit/flow-doc-name.test.mjs — #222
//
// `parseGeneratedDocName` recunoaște tiparul de nume produs de `routes/formulare.mjs`
// (OrdonantarePlata_<nr>_<YYYYMMDD>[.pdf] / DocumentFundamentare_<nr>_<YYYYMMDD>[.pdf]).
// Fixture-urile vin din helpers/flow-doc-name-fixtures.mjs și sunt REFOLOSITE de testul
// DB de paritate JS↔SQL (tests/db/flow-link-audit-clasa-g.test.mjs).

import { describe, it, expect } from 'vitest';
import { parseGeneratedDocName, generatedDocNameSql, GENERATED_DOC_NAME_RE } from '../../services/flow-doc-name.mjs';
import { FIXTURES_POZITIVE, FIXTURES_NEGATIVE } from '../helpers/flow-doc-name-fixtures.mjs';

describe('#222 — parseGeneratedDocName', () => {
  for (const [nume, asteptat] of FIXTURES_POZITIVE) {
    it(`pozitiv: ${nume}`, () => {
      expect(parseGeneratedDocName(nume)).toEqual(asteptat);
    });
  }

  for (const nume of FIXTURES_NEGATIVE) {
    it(`negativ: ${JSON.stringify(nume)}`, () => {
      expect(parseGeneratedDocName(nume)).toBeNull();
    });
  }

  it('negativ: non-string / gol', () => {
    expect(parseGeneratedDocName(null)).toBeNull();
    expect(parseGeneratedDocName(undefined)).toBeNull();
    expect(parseGeneratedDocName('')).toBeNull();
    expect(parseGeneratedDocName(123)).toBeNull();
    expect(parseGeneratedDocName({})).toBeNull();
  });

  it('tolerează spații la margini (crud.mjs trimuiește docName oricum)', () => {
    expect(parseGeneratedDocName('  OrdonantarePlata_45301_20260821.pdf ')).toEqual({ formType: 'ord', nr: '45301' });
  });

  it('GENERATED_DOC_NAME_RE e un RegExp (nu funcție — meta-testul anti-backtick îl ignoră)', () => {
    expect(GENERATED_DOC_NAME_RE).toBeInstanceOf(RegExp);
  });
});

describe('#222 — generatedDocNameSql', () => {
  it('întoarce string fără backtick și fără ${ neevaluat', () => {
    const s = generatedDocNameSql('f');
    expect(typeof s).toBe('string');
    expect(s).not.toContain('`');
    expect(s).not.toMatch(/\$\{/);
    expect(s).toContain("f.data->>'docName'");
  });

  it('respectă alias-ul primit', () => {
    expect(generatedDocNameSql('fx')).toContain("fx.data->>'docName'");
    expect(generatedDocNameSql()).toContain("f.data->>'docName'");
  });
});
