// Unit — validateCodSsi (server/services/cod-ssi-validate.mjs).
// Importă validatorul DIN PRODUCȚIE (nu-l redeclara). pool.query mock-uit.
//
// Capcana principală probată aici (test #4): cheia JSONB apare sub DOUĂ ortografii —
// `cod_SSI` (Sec.B) și `codSSI` (Sec.A). O validare care prinde doar una lasă cealaltă
// să treacă.
import { describe, it, expect, vi } from 'vitest';
import { validateCodSsi, _rowCodSsi } from '../../services/cod-ssi-validate.mjs';

// pool cu un set fix de coduri valide; query-ul spionat ca să dovedim că NU e atins
// când nu există coduri de validat.
function mkPool(validCodes) {
  return { query: vi.fn(async () => ({ rows: validCodes.map(c => ({ cod_ssi: c })) })) };
}

const ORG = 1;

describe('validateCodSsi', () => {
  it('1. cod valid ⇒ ok:true, fără invalid', async () => {
    const pool = mkPool(['02A670503710101']);
    const r = await validateCodSsi(pool, ORG, { rows_val: [{ codSSI: '02A670503710101' }] });
    expect(r.ok).toBe(true);
    expect(r.invalid).toEqual([]);
    expect(r.bugetGol).toBe(false);
  });

  it('2. cod invalid ⇒ ok:false, invalid[] cu cod + index rând', async () => {
    const pool = mkPool(['02A670503710101']);
    const r = await validateCodSsi(pool, ORG, {
      rows_val: [{ codSSI: '02A670503710101' }, { codSSI: 'NUEXISTA' }],
    });
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual([{ tabel: 'rows_val', index: 1, cod: 'NUEXISTA' }]);
  });

  it('3. cheia cod_SSI (underscore, Sec.B) ⇒ detectată', async () => {
    const pool = mkPool(['20.01.30']);
    const bad = await validateCodSsi(pool, ORG, { rows_ctrl: [{ cod_SSI: 'GRESIT' }] });
    expect(bad.ok).toBe(false);
    expect(bad.invalid[0]).toMatchObject({ tabel: 'rows_ctrl', cod: 'GRESIT' });
  });

  it('4. cheia codSSI (camelCase, Sec.A) ⇒ detectată — prinde capcana principală', async () => {
    const pool = mkPool(['20.01.30']);
    const bad = await validateCodSsi(pool, ORG, { rows_val: [{ codSSI: 'GRESIT' }] });
    expect(bad.ok).toBe(false);
    expect(bad.invalid[0]).toMatchObject({ tabel: 'rows_val', cod: 'GRESIT' });
    // și helperul pur, ambele ortografii:
    expect(_rowCodSsi({ cod_SSI: 'A' })).toBe('A');
    expect(_rowCodSsi({ codSSI: 'B' })).toBe('B');
  });

  it('5. cod cu spații ⇒ trim, apoi validare (match)', async () => {
    const pool = mkPool(['02A670503710101']);
    const r = await validateCodSsi(pool, ORG, { rows_val: [{ codSSI: '  02A670503710101  ' }] });
    expect(r.ok).toBe(true);
  });

  it('6. cod gol ⇒ valid, FĂRĂ să atingă DB', async () => {
    const pool = mkPool(['x']);
    const r = await validateCodSsi(pool, ORG, { rows_val: [{ codSSI: '' }, { codSSI: '   ' }, {}] });
    expect(r.ok).toBe(true);
    expect(r.bugetGol).toBe(false);
    expect(pool.query).not.toHaveBeenCalled(); // niciun cod de validat ⇒ zero query
  });

  it('7. buget gol ⇒ bugetGol:true, ok:false', async () => {
    const pool = mkPool([]); // 0 rânduri în clasa8_buget
    const r = await validateCodSsi(pool, ORG, { rows_val: [{ codSSI: 'ORICE' }] });
    expect(r.bugetGol).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('8. un caracter diferență ⇒ invalid (fără potrivire pe prefix)', async () => {
    const pool = mkPool(['02A670503710101']); // 15 caractere
    const r = await validateCodSsi(pool, ORG, { rows_val: [{ codSSI: '02A67050371010' }] }); // 14
    expect(r.ok).toBe(false);
    expect(r.invalid[0].cod).toBe('02A67050371010');
  });

  it('agregă peste toate cele trei tabele (rows_val + rows_plati + rows_ctrl)', async () => {
    const pool = mkPool(['OK']);
    const r = await validateCodSsi(pool, ORG, {
      rows_val:   [{ codSSI: 'OK' }],
      rows_plati: [{ codSSI: 'BAD1' }],
      rows_ctrl:  [{ cod_SSI: 'BAD2' }],
    });
    expect(r.ok).toBe(false);
    expect(r.invalid.map(x => x.cod).sort()).toEqual(['BAD1', 'BAD2']);
  });
});
