import { describe, it, expect } from 'vitest';
import { verifyIban } from '../ibanValidator.mjs';

describe('verifyIban', () => {
  describe('format validation', () => {
    it('respinge input gol', () => {
      expect(verifyIban('')).toEqual({ ok: false, reason: 'iban_empty' });
      expect(verifyIban(null)).toEqual({ ok: false, reason: 'iban_empty' });
      expect(verifyIban(undefined)).toEqual({ ok: false, reason: 'iban_empty' });
    });

    it('respinge format invalid', () => {
      expect(verifyIban('123')).toEqual({ ok: false, reason: 'iban_format_invalid' });
      expect(verifyIban('RO')).toEqual({ ok: false, reason: 'iban_format_invalid' });
      expect(verifyIban('abc def')).toMatchObject({ ok: false });
    });

    it('respinge RO cu lungime greșită', () => {
      expect(verifyIban('RO49BTRL')).toEqual({ ok: false, reason: 'iban_ro_length_invalid' });
      expect(verifyIban('RO49BTRL1234567890123456789')).toEqual({ ok: false, reason: 'iban_ro_length_invalid' });
    });

    it('normalizează spații și case', () => {
      // RO49BTRLRONCRT0000000001 normalizat — verificăm că nu eșuează la format
      const r = verifyIban('  ro49 btrl RONCRT0000000001  ');
      expect(r.ok).toBe(true);
      expect(r.data.iban).toBe('RO49BTRLRONCRT0000000001');
      expect(r.data.country).toBe('RO');
      expect(r.data.bankCode).toBe('BTRL');
    });
  });

  describe('bank code detection', () => {
    it('detectează Banca Transilvania (BTRL)', () => {
      const r = verifyIban('RO49BTRLRONCRT0000000001');
      expect(r.ok).toBe(true);
      expect(r.data.bankCode).toBe('BTRL');
      expect(r.data.bankName).toContain('Transilvania');
      expect(r.data.accountType).toBe('commercial');
      expect(r.data.isTreasury).toBe(false);
    });

    it('detectează Trezoreria (TREZ)', () => {
      const r = verifyIban('RO12TREZ0805046XXX021001');
      expect(r.ok).toBe(true);
      expect(r.data.bankCode).toBe('TREZ');
      expect(r.data.isTreasury).toBe(true);
      expect(r.data.accountType).toBe('treasury');
    });

    it('detectează BRD (BRDE)', () => {
      const r = verifyIban('RO49BRDE123456789012345A');
      expect(r.ok).toBe(true);
      expect(r.data.bankCode).toBe('BRDE');
      expect(r.data.bankName).toContain('BRD');
    });

    it('detectează BCR (RNCB)', () => {
      const r = verifyIban('RO49RNCB123456789012345A');
      expect(r.ok).toBe(true);
      expect(r.data.bankCode).toBe('RNCB');
      expect(r.data.bankName).toContain('BCR');
    });

    it('marchează cod bancar necunoscut', () => {
      const r = verifyIban('RO49XXXX123456789012345A');
      expect(r.ok).toBe(true);
      expect(r.data.bankCode).toBe('XXXX');
      expect(r.data.bankName).toBe('Bancă necunoscută');
      expect(r.data.accountType).toBe('unknown');
      expect(r.data.isTreasury).toBe(false);
    });

    describe('trezorerie județeană', () => {
      it('detectează jud. Brașov (cod SIRUTA 08)', () => {
        const r = verifyIban('RO45TREZ0815069XXX004466');
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.bankName).toBe('Trezoreria Brașov');
      });

      it('detectează jud. Cluj (cod SIRUTA 12)', () => {
        const r = verifyIban('RO45TREZ1212345XXX004466');
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCounty).toBe('Cluj');
        expect(r.data.bankName).toBe('Trezoreria Cluj');
      });

      it('detectează sector București (cod 43 = S4)', () => {
        const r = verifyIban('RO45TREZ4312345XXX004466');
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCounty).toBe('București S4');
        expect(r.data.bankName).toBe('Trezoreria București S4');
      });

      it('cod trezorerie necunoscut → fallback Trezoreria Statului', () => {
        const r = verifyIban('RO45TREZ9912345XXX004466');
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCounty).toBe(null);
        expect(r.data.bankName).toBe('Trezoreria Statului');
      });
    });
  });

  describe('mod-97 checksum', () => {
    it('validează IBAN german real valid (DE89370400440532013000)', () => {
      const r = verifyIban('DE89370400440532013000');
      expect(r.ok).toBe(true);
      expect(r.data.valid).toBe(true);
      expect(r.data.country).toBe('DE');
      expect(r.data.accountType).toBe('foreign');
    });

    it('invalidează IBAN cu checksum greșit', () => {
      // RO49BTRLRONCRT0000000001 — check digit 49 e incorect pentru acest cont fictiv
      const r = verifyIban('RO00BTRLRONCRT0000000001');
      expect(r.ok).toBe(true);
      expect(r.data.valid).toBe(false);
    });
  });

  describe('IBAN străin', () => {
    it('acceptă IBAN GB fără verificare lungime RO', () => {
      const r = verifyIban('GB82WEST12345698765432');
      expect(r.ok).toBe(true);
      expect(r.data.country).toBe('GB');
      expect(r.data.accountType).toBe('foreign');
      expect(r.data.bankCode).toBe(null);
    });

    it('verifică mod-97 și pentru IBAN străin', () => {
      const r = verifyIban('GB82WEST12345698765432');
      expect(r.data.valid).toBe(true);
    });
  });
});
