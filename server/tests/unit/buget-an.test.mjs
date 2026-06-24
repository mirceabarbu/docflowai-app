// server/tests/unit/buget-an.test.mjs
// FEATURE buget multi-anual (v3.9.558) — teste pure pentru helper-ul de buget pe an de exercițiu.
import { describe, it, expect } from 'vitest';
import { bugetPentruAnul, bandaPentruOffset, crediteBugetareAnCurent } from '../../services/buget-an.mjs';

const ROWS = [
  {
    plati_ani_precedenti: '100',
    plati_estim_ancrt:    '200',
    plati_estim_an_np1:   '300',
    plati_estim_an_np2:   '400',
    plati_estim_an_np3:   '500',
    plati_estim_ani_ulter:'600',
  },
  {
    plati_ani_precedenti: '10',
    plati_estim_ancrt:    '20',
    plati_estim_an_np1:   '30',
    plati_estim_an_np2:   '40',
    plati_estim_an_np3:   '50',
    plati_estim_ani_ulter:'60',
  },
];

describe('bandaPentruOffset', () => {
  it('mapează offset-urile la benzile absolute corecte', () => {
    expect(bandaPentruOffset(-2)).toBe('plati_ani_precedenti');
    expect(bandaPentruOffset(-1)).toBe('plati_ani_precedenti');
    expect(bandaPentruOffset(0)).toBe('plati_estim_ancrt');
    expect(bandaPentruOffset(1)).toBe('plati_estim_an_np1');
    expect(bandaPentruOffset(2)).toBe('plati_estim_an_np2');
    expect(bandaPentruOffset(3)).toBe('plati_estim_an_np3');
    expect(bandaPentruOffset(4)).toBe('plati_estim_ani_ulter');
    expect(bandaPentruOffset(99)).toBe('plati_estim_ani_ulter');
  });
});

describe('bugetPentruAnul', () => {
  it('offset 0 (an exercițiu = an referință) → SUM(plati_estim_ancrt)', () => {
    expect(bugetPentruAnul(ROWS, 2026, 2026)).toBe(220); // 200 + 20
  });
  it('offset 1 → SUM(np1)', () => {
    expect(bugetPentruAnul(ROWS, 2026, 2027)).toBe(330); // 300 + 30
  });
  it('offset 2 → SUM(np2)', () => {
    expect(bugetPentruAnul(ROWS, 2026, 2028)).toBe(440);
  });
  it('offset 3 → SUM(np3)', () => {
    expect(bugetPentruAnul(ROWS, 2026, 2029)).toBe(550);
  });
  it('offset > 3 → SUM(ani_ulter)', () => {
    expect(bugetPentruAnul(ROWS, 2026, 2030)).toBe(660); // 600 + 60
    expect(bugetPentruAnul(ROWS, 2026, 2040)).toBe(660);
  });
  it('offset < 0 → SUM(ani_precedenti)', () => {
    expect(bugetPentruAnul(ROWS, 2026, 2025)).toBe(110); // 100 + 10
  });
  it('an_referinta NULL/undefined → null (nedeclarat)', () => {
    expect(bugetPentruAnul(ROWS, null, 2026)).toBeNull();
    expect(bugetPentruAnul(ROWS, undefined, 2026)).toBeNull();
    expect(bugetPentruAnul(ROWS, '', 2026)).toBeNull();
  });
  it('rows_plati gol/non-array → 0 (cu an_referinta setat)', () => {
    expect(bugetPentruAnul([], 2026, 2026)).toBe(0);
    expect(bugetPentruAnul(null, 2026, 2026)).toBe(0);
    expect(bugetPentruAnul(undefined, 2026, 2026)).toBe(0);
  });
  it('parsează valori cu spații și virgulă zecimală', () => {
    const rows = [{ plati_estim_ancrt: '1 234,50' }, { plati_estim_ancrt: '0,50' }];
    expect(bugetPentruAnul(rows, 2026, 2026)).toBeCloseTo(1235.0);
  });
  it('ignoră celule lipsă/invalide pe banda selectată', () => {
    const rows = [{ plati_estim_an_np1: '100' }, { /* fără np1 */ plati_estim_ancrt: '999' }];
    expect(bugetPentruAnul(rows, 2026, 2027)).toBe(100);
  });
  it('an_referinta sau an_exercitiu nenumerice → null', () => {
    expect(bugetPentruAnul(ROWS, 'abc', 2026)).toBeNull();
    expect(bugetPentruAnul(ROWS, 2026, 'xyz')).toBeNull();
  });
});

// fix 12 (v3.9.582): plafonul de ordonanțare = credite bugetare col.10 din rows_ctrl.
describe('crediteBugetareAnCurent', () => {
  it('SUMĂ peste sum_rezv_crdt_bug_act (col.10)', () => {
    const rows = [{ sum_rezv_crdt_bug_act: '150000' }, { sum_rezv_crdt_bug_act: '50000' }];
    expect(crediteBugetareAnCurent(rows)).toBe(200000);
  });
  it('un singur rând', () => {
    expect(crediteBugetareAnCurent([{ sum_rezv_crdt_bug_act: '150000' }])).toBe(150000);
  });
  it('gol/non-array → 0', () => {
    expect(crediteBugetareAnCurent([])).toBe(0);
    expect(crediteBugetareAnCurent(null)).toBe(0);
    expect(crediteBugetareAnCurent(undefined)).toBe(0);
  });
  it('ignoră alte coloane (col.7 credite de angajament) — DOAR col.10', () => {
    const rows = [{ sum_rezv_crdt_ang_act: '999999', sum_rezv_crdt_bug_act: '1000' }];
    expect(crediteBugetareAnCurent(rows)).toBe(1000);
  });
  it('parsează valori cu spații și virgulă zecimală', () => {
    const rows = [{ sum_rezv_crdt_bug_act: '1 234,50' }, { sum_rezv_crdt_bug_act: '0,50' }];
    expect(crediteBugetareAnCurent(rows)).toBeCloseTo(1235.0);
  });
  it('celule lipsă/invalide → 0 pe acel rând', () => {
    const rows = [{ sum_rezv_crdt_bug_act: '500' }, { /* fără col.10 */ alt: 'x' }];
    expect(crediteBugetareAnCurent(rows)).toBe(500);
  });
});
