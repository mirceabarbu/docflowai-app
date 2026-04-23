import { describe, it, expect } from 'vitest';
import { formatMoneyRO, parseMoneyRO } from '../../services/format-money.mjs';

describe('formatMoneyRO', () => {
  it('formatează întreg cu separator mii', () => {
    expect(formatMoneyRO(1234567)).toBe('1.234.567,00');
  });
  it('formatează zecimal standard', () => {
    expect(formatMoneyRO(300.60)).toBe('300,60');
  });
  it('rotunjește la 2 zecimale', () => {
    expect(formatMoneyRO(123.456)).toBe('123,46');
  });
  it('zero → "0,00"', () => {
    expect(formatMoneyRO(0)).toBe('0,00');
  });
  it('valoare negativă', () => {
    expect(formatMoneyRO(-1234.5)).toBe('-1.234,50');
  });
  it('string numeric cu punct decimal', () => {
    expect(formatMoneyRO('1234567.89')).toBe('1.234.567,89');
  });
  it('null/undefined/empty → ""', () => {
    expect(formatMoneyRO(null)).toBe('');
    expect(formatMoneyRO(undefined)).toBe('');
    expect(formatMoneyRO('')).toBe('');
  });
  it('string invalid → ""', () => {
    expect(formatMoneyRO('abc')).toBe('');
  });
  it('decimals=0 → fără zecimale', () => {
    expect(formatMoneyRO(1234.56, 0)).toBe('1.235');
  });
});

describe('parseMoneyRO', () => {
  it('parsează format standard cu separator mii', () => {
    expect(parseMoneyRO('1.234.567,89')).toBe(1234567.89);
  });
  it('parsează fără separator mii', () => {
    expect(parseMoneyRO('300,60')).toBe(300.6);
  });
  it('parsează număr întreg', () => {
    expect(parseMoneyRO('1234')).toBe(1234);
  });
  it('null pentru input gol', () => {
    expect(parseMoneyRO('')).toBe(null);
    expect(parseMoneyRO(null)).toBe(null);
  });
  it('null pentru input invalid', () => {
    expect(parseMoneyRO('abc')).toBe(null);
  });
  it('roundtrip: formatMoneyRO → parseMoneyRO', () => {
    const original = 1234567.89;
    expect(parseMoneyRO(formatMoneyRO(original))).toBe(original);
  });
  it('roundtrip: valoare mică', () => {
    expect(parseMoneyRO(formatMoneyRO(0.01))).toBe(0.01);
  });
});
