// server/tests/unit/angajament-normalize.test.mjs
// Coduri de angajament canonice cu MAJUSCULE (v3.9.683) — teste pure, importate din producție.
import { describe, it, expect } from 'vitest';
import {
  normAngajamentCode,
  normalizeAngajamentRows,
  normalizeRowsCtrl,
} from '../../services/angajament-normalize.mjs';

describe('normAngajamentCode', () => {
  it('ridică minusculele la majuscule', () => {
    expect(normAngajamentCode('sdgdsgs')).toBe('SDGDSGS');
  });
  it('trim + upper', () => {
    expect(normAngajamentCode('  aab  ')).toBe('AAB');
  });
  it('idempotent pe valori deja canonice', () => {
    expect(normAngajamentCode('AAB')).toBe('AAB');
    expect(normAngajamentCode(normAngajamentCode('aab'))).toBe('AAB');
  });
  it('diacritice românești — toUpperCase real', () => {
    // rezultat real observat: ăîâșț → ĂÎÂȘȚ (fără surprize)
    expect(normAngajamentCode('ăîâșț')).toBe('ĂÎÂȘȚ');
  });
  it('null / undefined / gol ⇒ fără excepție', () => {
    expect(normAngajamentCode(null)).toBe('');
    expect(normAngajamentCode(undefined)).toBe('');
    expect(normAngajamentCode('')).toBe('');
  });
});

describe('normalizeAngajamentRows', () => {
  it('rescrie DOAR cod_angajament + indicator_angajament, restul intact', () => {
    const rows = [
      { cod_angajament: 'abc', indicator_angajament: 'x1', program: 'prog', cod_SSI: 'ssi01',
        sum_rezv_crdt_bug_act: '100', necunoscut: 'ține-mă' },
    ];
    const out = normalizeAngajamentRows(rows);
    expect(out[0]).toEqual({
      cod_angajament: 'ABC', indicator_angajament: 'X1', program: 'prog', cod_SSI: 'ssi01',
      sum_rezv_crdt_bug_act: '100', necunoscut: 'ține-mă',
    });
  });

  it('nu inventează chei pe rândurile care nu le au', () => {
    const rows = [{ program: 'p', cod_SSI: 's' }];
    const out = normalizeAngajamentRows(rows);
    expect(out[0]).toEqual({ program: 'p', cod_SSI: 's' });
    expect('cod_angajament' in out[0]).toBe(false);
    expect('indicator_angajament' in out[0]).toBe(false);
  });

  it('păstrează ORDINEA rândurilor', () => {
    const rows = [
      { cod_angajament: 'a', program: '1' },
      { cod_angajament: 'b', program: '2' },
      { cod_angajament: 'c', program: '3' },
    ];
    const out = normalizeAngajamentRows(rows);
    expect(out.map(r => r.cod_angajament)).toEqual(['A', 'B', 'C']);
    expect(out.map(r => r.program)).toEqual(['1', '2', '3']);
  });

  it('nu mută input-ul (imutabil)', () => {
    const rows = [{ cod_angajament: 'abc' }];
    const out = normalizeAngajamentRows(rows);
    expect(rows[0].cod_angajament).toBe('abc');   // input neatins
    expect(out[0].cod_angajament).toBe('ABC');
  });

  it('input non-array ⇒ întors ca atare', () => {
    expect(normalizeAngajamentRows(null)).toBe(null);
    expect(normalizeAngajamentRows(undefined)).toBe(undefined);
    expect(normalizeAngajamentRows('nope')).toBe('nope');
  });

  it('rânduri non-obiect rămân neatinse', () => {
    const rows = [null, 'x', 42, { cod_angajament: 'q' }];
    const out = normalizeAngajamentRows(rows);
    expect(out).toEqual([null, 'x', 42, { cod_angajament: 'Q' }]);
  });

  it('normalizeRowsCtrl e alias pentru aceeași logică', () => {
    expect(normalizeRowsCtrl).toBe(normalizeAngajamentRows);
    expect(normalizeRowsCtrl([{ cod_angajament: 'z' }])[0].cod_angajament).toBe('Z');
  });
});
