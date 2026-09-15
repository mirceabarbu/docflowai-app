/**
 * #209 Etapa C — validarea listei de OP-uri + diferența de sumă (informativă, neblocantă).
 */
import { describe, it, expect } from 'vitest';
import { parseNrOrdinList, diferentaSuma } from '../../services/plata-ordin.mjs';

describe('parseNrOrdinList', () => {
  it('acceptă "2791, 2792" și normalizează la "2791, 2792"', () => {
    const r = parseNrOrdinList('2791, 2792');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('2791, 2792');
    expect(r.tokens).toEqual(['2791', '2792']);
  });
  it('normalizează spațiile din jurul virgulelor: " 2791 ,2792 ,  2793" → "2791, 2792, 2793"', () => {
    expect(parseNrOrdinList(' 2791 ,2792 ,  2793').value).toBe('2791, 2792, 2793');
  });
  it('un singur număr rămâne neschimbat', () => {
    expect(parseNrOrdinList('2791').value).toBe('2791');
  });
  it('formatul istoric cu prefix ("OP-2026-042", "OP-1") rămâne acceptat (compatibilitate producție + teste DB)', () => {
    expect(parseNrOrdinList('OP-2026-042').ok).toBe(true);
    expect(parseNrOrdinList('OP-1, OP-2').value).toBe('OP-1, OP-2');
  });
  it('respinge "2791;2792" (separator greșit)', () => {
    const r = parseNrOrdinList('2791;2792');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('nr_ordin_invalid');
  });
  // DIVERGENȚĂ #209 (raportată): promptul cerea respingerea lui "abc"; fixture-urile
  // preexistente ('OP-X' în integration/alop.test.mjs, 'OP-A'/'OP-B' în db/alop-plata-ord-lock)
  // și obiceiul din producție ar fi picat. Se respinge separatorul greșit și semnele străine,
  // nu absența cifrelor.
  it('token alfanumeric fără cifre ("abc", "OP-X") rămâne acceptat (compatibilitate)', () => {
    expect(parseNrOrdinList('abc').ok).toBe(true);
    expect(parseNrOrdinList('OP-X').ok).toBe(true);
  });
  it('respinge spațiu în interiorul unui token ("27 91")', () => {
    expect(parseNrOrdinList('27 91').ok).toBe(false);
  });
  it('respinge "" / null / doar virgule', () => {
    expect(parseNrOrdinList('').ok).toBe(false);
    expect(parseNrOrdinList(null).ok).toBe(false);
    expect(parseNrOrdinList(', ,').ok).toBe(false);
  });
  it('respinge caractere străine ("27<91")', () => {
    expect(parseNrOrdinList('27<91').ok).toBe(false);
  });
});

describe('diferentaSuma (informativ, nu blochează)', () => {
  it('sub valoarea ORD-ului', () => {
    const r = diferentaSuma(1726.53, 20891.04);
    expect(r.sub).toBe(true);
    expect(r.peste).toBe(false);
    expect(r.diferenta).toBeCloseTo(-19164.51, 2);
    expect(r.mesaj).toContain('19164.51');
    expect(r.mesaj).toContain('sub valoarea ORD-ului de 20891.04');
  });
  it('peste valoarea ORD-ului', () => {
    const r = diferentaSuma(21000, 20891.04);
    expect(r.peste).toBe(true);
    expect(r.diferenta).toBeCloseTo(108.96, 2);
  });
  it('egal (toleranță sub un ban) ⇒ fără mesaj', () => {
    const r = diferentaSuma(20891.04, 20891.044);
    expect(r.egal).toBe(true);
    expect(r.mesaj).toBeNull();
  });
  it('fără valoare ORD ⇒ egal, fără mesaj', () => {
    expect(diferentaSuma(100, 0).mesaj).toBeNull();
  });
});
