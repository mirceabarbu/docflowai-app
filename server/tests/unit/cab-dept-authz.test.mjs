// FEAT ALOP-CAB (v3.9.690) — helper pur isCabDept.
// Membrul compartimentului CAB al ORGANIZAȚIEI (organizations.cab_compartiment) vede+editează tot
// ALOP/DF/ORD din org. isCabDept e poarta pură; ambele argumente sunt deja trimmed la apel.
import { describe, it, expect } from 'vitest';
import { isCabDept } from '../../services/authz-formular.mjs';

describe('isCabDept — poarta pură cab_dept', () => {
  it('1. actor în CAB ⇒ true', () => {
    expect(isCabDept('Serviciul Buget', 'Serviciul Buget')).toBe(true);
  });

  it('2. actor în alt compartiment ⇒ false', () => {
    expect(isCabDept('Contabilitate', 'Serviciul Buget')).toBe(false);
  });

  it('3. actor fără compartiment ⇒ false', () => {
    expect(isCabDept('', 'Serviciul Buget')).toBe(false);
  });

  it('4. org fără CAB setat (cabComp gol) ⇒ false — FAIL-SAFE', () => {
    expect(isCabDept('Serviciul Buget', '')).toBe(false);
  });

  it('5. case-sensitive azi (documentat, NU se repară aici — datorie `compartiment` din audit)', () => {
    expect(isCabDept('serviciul buget', 'Serviciul Buget')).toBe(false);
  });
});
