import { describe, it, expect } from 'vitest';
import { analyzeCoherence } from '../coherence.mjs';

const mockCompany = (over = {}) => ({
  cui: '12345678',
  name: 'SC EXEMPLU SRL',
  entityType: 'SRL',
  inactive: false,
  radiated: false,
  liquidationDate: null,
  inactiveDate: null,
  reactivationDate: null,
  vat: true,
  vatEndDate: null,
  vatCancelReason: '',
  vatCollected: false,
  ...over,
});

const mockIban = (over = {}) => ({
  iban: 'RO49BTRLRONCRT0000000001',
  valid: true,
  country: 'RO',
  bankCode: 'BTRL',
  bankName: 'Banca Transilvania',
  accountType: 'commercial',
  isTreasury: false,
  ...over,
});

describe('analyzeCoherence', () => {
  it('întoarce CUI_NOT_FOUND când companyData lipsește', () => {
    const w = analyzeCoherence({ companyData: null, ibanData: null, declaredName: null });
    expect(w).toContainEqual(expect.objectContaining({ code: 'CUI_NOT_FOUND', level: 'error' }));
  });

  it('fără warnings pentru firmă normală fără date suplimentare', () => {
    const w = analyzeCoherence({ companyData: mockCompany(), ibanData: null, declaredName: null });
    expect(w).toHaveLength(0);
  });

  it('detectează firmă RADIATĂ (critic, error)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ radiated: true, liquidationDate: '2022-03-15' }),
      ibanData: null,
      declaredName: null,
    });
    const radiated = w.find(x => x.code === 'COMPANY_RADIATED');
    expect(radiated).toBeDefined();
    expect(radiated.level).toBe('error');
    expect(radiated.message).toContain('2022-03-15');
    expect(radiated.message).toContain('NU efectuați');
  });

  it('detectează firmă INACTIVĂ (error)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ inactive: true, inactiveDate: '2023-05-10' }),
      ibanData: null,
      declaredName: null,
    });
    const inactive = w.find(x => x.code === 'COMPANY_INACTIVE');
    expect(inactive).toBeDefined();
    expect(inactive.level).toBe('error');
    expect(inactive.message).toContain('2023-05-10');
  });

  it('prioritizează RADIATĂ peste INACTIVĂ dacă ambele', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ radiated: true, inactive: true, liquidationDate: '2022-03-15' }),
      ibanData: null,
      declaredName: null,
    });
    expect(w.some(x => x.code === 'COMPANY_RADIATED')).toBe(true);
    expect(w.some(x => x.code === 'COMPANY_INACTIVE')).toBe(false);
  });

  it('detectează TVA anulat (VAT_CANCELLED warning)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ vat: false, vatEndDate: '2024-01-01', vatCancelReason: 'art. 316' }),
      ibanData: null,
      declaredName: null,
    });
    const vatW = w.find(x => x.code === 'VAT_CANCELLED');
    expect(vatW).toBeDefined();
    expect(vatW.level).toBe('warning');
    expect(vatW.message).toContain('art. 316');
    expect(vatW.message).toContain('2024-01-01');
  });

  it('NU adaugă VAT_CANCELLED dacă vat=false dar fără vatEndDate', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ vat: false, vatEndDate: null }),
      ibanData: null,
      declaredName: null,
    });
    expect(w.some(x => x.code === 'VAT_CANCELLED')).toBe(false);
  });

  it('detectează VAT_COLLECTED (info)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ vatCollected: true }),
      ibanData: null,
      declaredName: null,
    });
    expect(w).toContainEqual(expect.objectContaining({ code: 'VAT_COLLECTED', level: 'info' }));
  });

  it('detectează TREASURY_PRIVATE_MISMATCH (IBAN trezorerie + entitate SRL)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ entityType: 'SRL' }),
      ibanData: mockIban({ isTreasury: true, bankCode: 'TREZ' }),
      declaredName: null,
    });
    const warn = w.find(x => x.code === 'TREASURY_PRIVATE_MISMATCH');
    expect(warn).toBeDefined();
    expect(warn.level).toBe('warning');
    expect(warn.message).toContain('Legii 207/2015');
    expect(warn.message).toContain('furnizori ai instituțiilor publice');
  });

  it('detectează TREASURY_PUBLIC_OK (IBAN trezorerie + instituție publică)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ entityType: 'public', name: 'PRIMARIA BRASOV' }),
      ibanData: mockIban({ isTreasury: true }),
      declaredName: null,
    });
    expect(w).toContainEqual(expect.objectContaining({ code: 'TREASURY_PUBLIC_OK', level: 'info' }));
  });

  it('detectează COMMERCIAL_BANK_PUBLIC_ENTITY (bancă comercială + instituție publică)', () => {
    const w = analyzeCoherence({
      companyData: mockCompany({ entityType: 'public', name: 'PRIMARIA BRASOV' }),
      ibanData: mockIban({ isTreasury: false, accountType: 'commercial' }),
      declaredName: null,
    });
    expect(w).toContainEqual(expect.objectContaining({ code: 'COMMERCIAL_BANK_PUBLIC_ENTITY', level: 'warning' }));
  });

  it('detectează IBAN_INVALID când mod-97 eșuează', () => {
    const w = analyzeCoherence({
      companyData: mockCompany(),
      ibanData: mockIban({ valid: false }),
      declaredName: null,
    });
    expect(w).toContainEqual(expect.objectContaining({ code: 'IBAN_INVALID', level: 'error' }));
  });

  describe('name matching (fuzzy)', () => {
    it('MATCH exact → COMPANY_NAME_MATCH info', () => {
      const w = analyzeCoherence({
        companyData: mockCompany({ name: 'SC BRACOMA SRL' }),
        ibanData: null,
        declaredName: 'SC BRACOMA SRL',
      });
      expect(w).toContainEqual(expect.objectContaining({ code: 'COMPANY_NAME_MATCH', level: 'info' }));
    });

    it('MATCH substring → MATCH sau PARTIAL', () => {
      const w = analyzeCoherence({
        companyData: mockCompany({ name: 'BRACOMA SRL' }),
        ibanData: null,
        declaredName: 'BRACOMA',
      });
      expect(w.some(x => ['COMPANY_NAME_MATCH', 'COMPANY_NAME_PARTIAL'].includes(x.code))).toBe(true);
    });

    it('MISMATCH total → COMPANY_NAME_MISMATCH warning', () => {
      const w = analyzeCoherence({
        companyData: mockCompany({ name: 'BRACOMA SRL' }),
        ibanData: null,
        declaredName: 'COMPLET ALTA FIRMA XYZ',
      });
      expect(w).toContainEqual(expect.objectContaining({ code: 'COMPANY_NAME_MISMATCH', level: 'warning' }));
    });

    it('ignoră diacritice la comparare', () => {
      const w = analyzeCoherence({
        companyData: mockCompany({ name: 'PRIMĂRIA BRAȘOV' }),
        ibanData: null,
        declaredName: 'PRIMARIA BRASOV',
      });
      expect(w).toContainEqual(expect.objectContaining({ code: 'COMPANY_NAME_MATCH' }));
    });

    it('NU adaugă name warning fără declaredName', () => {
      const w = analyzeCoherence({
        companyData: mockCompany({ name: 'BRACOMA SRL' }),
        ibanData: null,
        declaredName: null,
      });
      expect(w.some(x => x.code.startsWith('COMPANY_NAME_'))).toBe(false);
    });
  });
});
