/**
 * Unit tests pentru server/services/opme-parser.mjs
 *
 * Folosește fixture-ul real F1129:
 *   server/tests/fixtures/f1129_sample.pdf
 * Valori așteptate (verificate manual împotriva PDF-ului):
 *   45 linii, suma 215901.00, NrDocument 0000000130, DataOP 06.05.2026,
 *   ORASUL ZARNESTI (CIF 4646897), 4 unique CodAngajament.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { parseOpmePdf } from '../../services/opme-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/f1129_sample.pdf');

async function loadFixture() {
  return fs.readFile(FIXTURE);
}

describe('parseOpmePdf — fixture F1129 real', () => {
  it('parsează antetul corect', async () => {
    const buf = await loadFixture();
    const { header } = await parseOpmePdf(buf);
    expect(header.nr_inregistrari).toBe(45);
    expect(header.suma_totala).toBeCloseTo(215901.00, 2);
    expect(header.cif_platitor).toBe('4646897');
    expect(header.den_platitor).toMatch(/ZARNESTI/);
    expect(header.nr_document).toBe('0000000130');
    expect(header.data_op).toBeInstanceOf(Date);
    expect(header.data_op.toISOString().slice(0, 10)).toBe('2026-05-06');
    expect(header.an_r).toBe(2026);
    expect(header.luna_r).toBe(5);
    expect(header.universal_code).toMatch(/^F1129/);
  });

  it('parsează 45 de linii cu primul rând corect', async () => {
    const buf = await loadFixture();
    const { lines } = await parseOpmePdf(buf);
    expect(lines).toHaveLength(45);
    expect(lines[0].nr_op).toBe('1310');
    expect(lines[0].cod_angajament).toBe('AAB2FMGM4HG');
    expect(lines[0].indicator_angajament).toBe('AAB');
    expect(lines[0].cif_beneficiar).toBe('2801201082577');
    expect(lines[0].suma_op).toBeCloseTo(4061.00, 2);
    expect(lines[0].row_index).toBe(0);
  });

  it('Σ(lines.suma_op) === header.suma_totala (validat de parser, dar verificăm și aici)', async () => {
    const buf = await loadFixture();
    const { header, lines } = await parseOpmePdf(buf);
    const sum = lines.reduce((a, l) => a + l.suma_op, 0);
    expect(Math.abs(sum - header.suma_totala)).toBeLessThan(0.01);
  });

  it('ignoră Row1 template (cele cu NrOp gol)', async () => {
    const buf = await loadFixture();
    const { lines, raw_meta } = await parseOpmePdf(buf);
    // În fixture: 46 Row1 raw (1 template + 45 reale), parser păstrează 45.
    expect(raw_meta.row_count_raw).toBe(46);
    expect(raw_meta.row_count_filled).toBe(45);
    expect(lines.every(l => l.nr_op && l.nr_op.trim() !== '')).toBe(true);
  });

  it('returnează 4 unique cod_angajament', async () => {
    const buf = await loadFixture();
    const { lines } = await parseOpmePdf(buf);
    const uniq = new Set(lines.map(l => l.cod_angajament));
    expect(uniq.size).toBe(4);
  });

  it('raw_meta conține creator + universalCode', async () => {
    const buf = await loadFixture();
    const { raw_meta } = await parseOpmePdf(buf);
    expect(raw_meta.xfa_universal_code).toMatch(/^F1129/);
    // creator e best-effort din /Info — nu impunem o valoare exactă
    expect(typeof raw_meta.creator === 'string' || raw_meta.creator === null).toBe(true);
  });
});

describe('parseOpmePdf — erori', () => {
  it('aruncă OPME_NOT_XFA pentru un PDF normal fără AcroForm', async () => {
    const blank = await PDFDocument.create();
    blank.addPage([300, 300]);
    const blankBytes = Buffer.from(await blank.save());
    await expect(parseOpmePdf(blankBytes)).rejects.toMatchObject({ code: 'OPME_NOT_XFA' });
  });

  it('aruncă OPME_NOT_XFA dacă input-ul nu e Buffer', async () => {
    await expect(parseOpmePdf('not a buffer')).rejects.toMatchObject({ code: 'OPME_NOT_XFA' });
  });
});
