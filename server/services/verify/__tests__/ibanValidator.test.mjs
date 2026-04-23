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

    describe('trezorerie localitate (mapping 3-cifre ANAF real)', () => {
      it('Brașov Municipiu — cod 131 (IBAN real DFBV)', () => {
        const r = verifyIban('RO15TREZ1312107020102XXX');
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCity).toBe('Brașov (Municipiu)');
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.bankName).toBe('Trezoreria Brașov (Municipiu)');
      });

      it('Brașov Județeană — cod 130', () => {
        const r = verifyIban('RO49TREZ1302001010XXXXXX');
        expect(r.data.treasuryCity).toBe('Brașov (Județeană)');
        expect(r.data.treasuryCounty).toBe('Brașov');
      });

      it('Nădlac — cod 026 (IBAN real ANAF iban_TREZ026.pdf)', () => {
        const r = verifyIban('RO07TREZ0262003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Nădlac');
        expect(r.data.treasuryCounty).toBe('Arad');
      });

      it('Pâncota — cod 027', () => {
        const r = verifyIban('RO29TREZ0272003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Pâncota');
      });

      it('Sebiș — cod 028', () => {
        const r = verifyIban('RO51TREZ0282003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Sebiș');
      });

      it('Pitești — cod 046 (IBAN real ANAF)', () => {
        const r = verifyIban('RO59TREZ0462003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Pitești');
        expect(r.data.treasuryCounty).toBe('Argeș');
      });

      it('Deva Municipiu — cod 365 (IBAN real ANAF iban_TREZ365.pdf)', () => {
        const r = verifyIban('RO07TREZ3652003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Deva (Municipiu)');
        expect(r.data.treasuryCounty).toBe('Hunedoara');
      });

      it('Reghin — cod 479 (IBAN real ANAF)', () => {
        const r = verifyIban('RO79TREZ4792003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Reghin');
        expect(r.data.treasuryCounty).toBe('Mureș');
      });

      it('Sovata — cod 482 (IBAN real ANAF)', () => {
        const r = verifyIban('RO48TREZ4822003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Sovata');
      });

      it('Roman Municipiu — cod 492 (IBAN real ANAF iban_TREZ490_TREZ492.pdf)', () => {
        const r = verifyIban('RO42TREZ4922003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Roman (Municipiu)');
        expect(r.data.treasuryCounty).toBe('Neamț');
      });

      it('Ocna Mureș — cod 007 (IBAN real ANAF)', () => {
        const r = verifyIban('RO74TREZ0072003010XXXXXX');
        expect(r.data.treasuryCity).toBe('Ocna Mureș');
        expect(r.data.treasuryCounty).toBe('Alba');
      });

      it('București ATCPMB — cod 700', () => {
        const r = verifyIban('RO16TREZ7002003010XXXXXX');
        expect(r.data.treasuryCity).toBe('București (ATCPMB)');
        expect(r.data.treasuryCounty).toBe('București');
      });

      it('București Sector 3 — cod 703 (IBAN real ANAF iban_TREZ703.pdf)', () => {
        const r = verifyIban('RO45TREZ7032003010XXXXXX');
        expect(r.data.treasuryCity).toBe('București Sector 3');
      });

      it('cod 3-cifre necunoscut dar județ cunoscut — fallback județ (cod 158, jud. Brăila)', () => {
        const r = verifyIban('RO45TREZ1582003010XXXXXX');
        expect(r.data.treasuryCity).toBe(null);
        expect(r.data.treasuryCounty).toBe('Brăila');
        expect(r.data.bankName).toContain('jud. Brăila');
        expect(r.data.bankName).toContain('158');
      });

      it('cod 3-cifre complet necunoscut — fallback Trezoreria Statului', () => {
        const r = verifyIban('RO45TREZ9992003010XXXXXX');
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCity).toBe(null);
        expect(r.data.treasuryCounty).toBe(null);
        expect(r.data.bankName).toContain('Trezoreria Statului');
        expect(r.data.bankName).toContain('999');
      });

      it('regression: IBAN test user (cod 131) → Brașov, NU Constanța', () => {
        const r = verifyIban('RO45TREZ1315069XXX004466');
        expect(r.data.treasuryCity).toBe('Brașov (Municipiu)');
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.bankName).not.toContain('Constanța');
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
