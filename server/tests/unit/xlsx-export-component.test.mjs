// @vitest-environment happy-dom
/**
 * Teste comportamentale pentru public/js/shared/xlsx-export.js (#133a — DFXlsx).
 * Scriptul e clasic (fără `type="module"`), deci e evaluat cu `new Function(src)`
 * peste DOM real happy-dom, apoi comportamentul REAL (window.DFXlsx) e exercitat.
 * `window.XLSX` e MOCK-UIT — testele nu ating rețeaua (nu se apelează `load()`).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../../../public/js/shared/xlsx-export.js'), 'utf8');

let DFXlsx;

beforeAll(() => {
  new Function(src).call(globalThis);
  DFXlsx = globalThis.window.DFXlsx;
});

function mockXlsxLib() {
  const sheets = {};
  const calls = { aoa_to_sheet: [], writeFile: [] };
  const XLSX = {
    utils: {
      aoa_to_sheet: (aoa) => {
        calls.aoa_to_sheet.push(aoa);
        const ws = {};
        let maxR = 0, maxC = 0;
        aoa.forEach((row, r) => {
          row.forEach((v, c) => {
            ws[XLSX.utils.encode_cell({ r, c })] = { v, t: typeof v === 'number' ? 'n' : 's' };
            if (r > maxR) maxR = r;
            if (c > maxC) maxC = c;
          });
        });
        ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
        return ws;
      },
      decode_range: (ref) => {
        const [s, e] = ref.split(':');
        const parse = (cellRef) => {
          const m = /^([A-Z]+)(\d+)$/.exec(cellRef);
          const col = m[1].split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
          return { r: parseInt(m[2], 10) - 1, c: col };
        };
        return { s: parse(s), e: parse(e || s) };
      },
      encode_cell: ({ r, c }) => {
        let col = '', n = c + 1;
        while (n > 0) { const rem = (n - 1) % 26; col = String.fromCharCode(65 + rem) + col; n = Math.floor((n - 1) / 26); }
        return col + (r + 1);
      },
      encode_range: ({ s, e }) => `${XLSX.utils.encode_cell(s)}:${XLSX.utils.encode_cell(e)}`,
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      book_append_sheet: (wb, ws, name) => { wb.SheetNames.push(name); wb.Sheets[name] = ws; sheets[name] = ws; },
    },
    writeFile: (wb, filename) => { calls.writeFile.push({ wb, filename }); },
  };
  return { XLSX, calls, sheets };
}

describe('xlsx-export.js — se încarcă corect în happy-dom', () => {
  it('1. DFXlsx expune exact load și save', () => {
    expect(DFXlsx).toBeTruthy();
    expect(Object.keys(DFXlsx).sort()).toEqual(['load', 'save']);
    expect(typeof DFXlsx.load).toBe('function');
    expect(typeof DFXlsx.save).toBe('function');
  });
});

describe('DFXlsx.save', () => {
  beforeEach(() => {
    delete globalThis.window.XLSX;
  });

  it('2. cheamă XLSX.utils.aoa_to_sheet cu matricea primită', async () => {
    const { XLSX, calls } = mockXlsxLib();
    globalThis.window.XLSX = XLSX;
    const aoa = [['A', 'B'], ['x', 1]];
    await DFXlsx.save(aoa, { filename: 'test.xlsx' });
    expect(calls.aoa_to_sheet[0]).toEqual(aoa);
  });

  it('3. coloanele din numericCols primesc t=n și z=#,##0.00', async () => {
    const { XLSX, sheets } = mockXlsxLib();
    globalThis.window.XLSX = XLSX;
    const aoa = [['Nr', 'Suma'], ['1', '1234.5']];
    await DFXlsx.save(aoa, { filename: 'test.xlsx', sheet: 'S1', numericCols: [1] });
    const ws = sheets['S1'];
    expect(ws['B2'].t).toBe('n');
    expect(ws['B2'].z).toBe('#,##0.00');
    expect(ws['B2'].v).toBe(1234.5);
  });

  it('4. valoare nenumerică într-o coloană numerică rămâne text, fără NaN', async () => {
    const { XLSX, sheets } = mockXlsxLib();
    globalThis.window.XLSX = XLSX;
    const aoa = [['Nr', 'Suma'], ['1', 'n/a']];
    await DFXlsx.save(aoa, { filename: 'test.xlsx', sheet: 'S1', numericCols: [1] });
    const ws = sheets['S1'];
    expect(ws['B2'].v).toBe('n/a');
    expect(ws['B2'].t).not.toBe('n');
    expect(Number.isNaN(ws['B2'].v)).toBe(false);
  });

  it('5. antetul (linia 0) rămâne text chiar dacă indexul e în numericCols', async () => {
    const { XLSX, sheets } = mockXlsxLib();
    globalThis.window.XLSX = XLSX;
    const aoa = [['Suma'], ['100']];
    await DFXlsx.save(aoa, { filename: 'test.xlsx', sheet: 'S1', numericCols: [0] });
    const ws = sheets['S1'];
    expect(ws['A1'].v).toBe('Suma');
    expect(ws['A1'].t).not.toBe('n');
    expect(ws['A2'].t).toBe('n');
  });

  it('6. cols ajunge în ws["!cols"]', async () => {
    const { XLSX, sheets } = mockXlsxLib();
    globalThis.window.XLSX = XLSX;
    const cols = [{ wch: 12 }, { wch: 20 }];
    await DFXlsx.save([['A', 'B']], { filename: 'test.xlsx', sheet: 'S1', cols });
    expect(sheets['S1']['!cols']).toEqual(cols);
  });

  it('7. filename primește sufixul de dată o singură dată', async () => {
    const { XLSX, calls } = mockXlsxLib();
    globalThis.window.XLSX = XLSX;
    const dateStr = new Date().toISOString().slice(0, 10);
    await DFXlsx.save([['A']], { filename: `Export_${dateStr}.xlsx` });
    const fname = calls.writeFile[0].filename;
    expect(fname).toBe(`Export_${dateStr}.xlsx`);
    expect(fname.match(new RegExp(dateStr, 'g')).length).toBe(1);
  });

  it('8. save respinge dacă window.XLSX lipsește după load() (CDN indisponibil în sandbox)', async () => {
    globalThis.window.XLSX = undefined;
    await expect(DFXlsx.save([['A']], { filename: 'x.xlsx' })).rejects.toThrow();
  }, 15000);
});
