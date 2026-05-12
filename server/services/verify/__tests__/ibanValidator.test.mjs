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
      expect(r.data.treasuryType).toBe(null);
      expect(r.data.treasuryVerified).toBe(null);
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
  });

  describe('trezorerii — ancore din date oficiale ANAF', () => {
    // Helper: construiește IBAN cu cod localitate dat (validitatea mod-97 nu
    // contează — tests verifică lookup-ul după codul TREZ).
    const trezIban = code => `RO45TREZ${code}5069XXX004466`;

    describe('Brașov (BV) — 130-138', () => {
      it('cod 130 → Trezoreria județeană Brașov', () => {
        const r = verifyIban(trezIban('130'));
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCity).toBe('Brașov');
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.treasuryType).toBe('judeteana');
        expect(r.data.treasuryBranchName).toBe('Trezoreria județeană Brașov');
        expect(r.data.treasuryVerified).toBe(true);
      });

      it('cod 131 → Trezoreria operativă Municipiul Brașov', () => {
        const r = verifyIban(trezIban('131'));
        expect(r.data.treasuryCity).toBe('Brașov');
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.treasuryType).toBe('municipiu');
        expect(r.data.treasuryBranchName).toBe('Trezoreria operativă Municipiul Brașov');
      });

      it('cod 132 → Făgăraș (municipiu)', () => {
        const r = verifyIban(trezIban('132'));
        expect(r.data.treasuryCity).toBe('Făgăraș');
        expect(r.data.treasuryType).toBe('municipiu');
      });

      it('cod 133 → Rupea (operativa)', () => {
        const r = verifyIban(trezIban('133'));
        expect(r.data.treasuryCity).toBe('Rupea');
        expect(r.data.treasuryType).toBe('operativa');
      });

      it('cod 136 → Săcele (operativa)', () => {
        const r = verifyIban(trezIban('136'));
        expect(r.data.treasuryCity).toBe('Săcele');
      });

      it('cod 137 → Codlea (operativa)', () => {
        const r = verifyIban(trezIban('137'));
        expect(r.data.treasuryCity).toBe('Codlea');
      });

      // Bug fix prompt audit: vechiul mapping spunea Victoria; ANAF zice Rașnov.
      it('cod 138 → Rașnov (NU Victoria) — bug fix audit', () => {
        const r = verifyIban(trezIban('138'));
        expect(r.data.treasuryCity).toBe('Rașnov');
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.treasuryBranchName).toContain('Rașnov');
        expect(r.data.treasuryBranchName).not.toContain('Victoria');
      });
    });

    describe('Alba — cap de listă', () => {
      it('cod 001 → Trezoreria județeană Alba', () => {
        const r = verifyIban(trezIban('001'));
        expect(r.data.treasuryCity).toBe('Alba');
        expect(r.data.treasuryCounty).toBe('Alba');
        expect(r.data.treasuryType).toBe('judeteana');
        expect(r.data.treasuryBranchName).toBe('Trezoreria județeană Alba');
      });

      it('cod 002 → Trezoreria operativă Municipiul Alba Iulia', () => {
        const r = verifyIban(trezIban('002'));
        expect(r.data.treasuryCity).toBe('Alba Iulia');
        expect(r.data.treasuryType).toBe('municipiu');
      });
    });

    describe('București — entries hardcoded', () => {
      it('cod 700 → Trezoreria operativă Municipiul București', () => {
        const r = verifyIban(trezIban('700'));
        expect(r.data.treasuryCity).toBe('București');
        expect(r.data.treasuryCounty).toBe('București');
        expect(r.data.treasuryType).toBe('municipiu');
        expect(r.data.treasuryBranchName).toBe('Trezoreria operativă Municipiul București');
      });

      it('cod 703 → Sector 3', () => {
        const r = verifyIban(trezIban('703'));
        expect(r.data.treasuryCity).toContain('Sector 3');
        expect(r.data.treasuryType).toBe('sector');
      });

      it('cod 706 → Sector 6', () => {
        const r = verifyIban(trezIban('706'));
        expect(r.data.treasuryCity).toContain('Sector 6');
      });
    });

    describe('Alte ancore reprezentative', () => {
      it('cod 491 → Piatra Neamț (municipiu)', () => {
        const r = verifyIban(trezIban('491'));
        expect(r.data.treasuryCity).toBe('Piatra Neamț');
        expect(r.data.treasuryCounty).toBe('Neamț');
      });

      it('cod 492 → Roman (municipiu)', () => {
        const r = verifyIban(trezIban('492'));
        expect(r.data.treasuryCity).toBe('Roman');
        expect(r.data.treasuryCounty).toBe('Neamț');
        expect(r.data.treasuryType).toBe('municipiu');
      });

      it('cod 482 → Sovata (operativa, Mureș)', () => {
        const r = verifyIban(trezIban('482'));
        expect(r.data.treasuryCity).toBe('Sovata');
        expect(r.data.treasuryCounty).toBe('Mureș');
      });

      it('cod 028 → Sebiș (operativa, Arad)', () => {
        const r = verifyIban(trezIban('028'));
        expect(r.data.treasuryCity).toBe('Sebiș');
        expect(r.data.treasuryCounty).toBe('Arad');
      });

      it('cod 046 → Pitești (municipiu, Argeș)', () => {
        const r = verifyIban(trezIban('046'));
        expect(r.data.treasuryCity).toBe('Pitești');
        expect(r.data.treasuryCounty).toBe('Argeș');
      });

      it('cod 621 → Timișoara (municipiu, Timiș)', () => {
        const r = verifyIban(trezIban('621'));
        expect(r.data.treasuryCity).toBe('Timișoara');
        expect(r.data.treasuryCounty).toBe('Timiș');
      });
    });

    describe('coduri necunoscute → fallback elegant', () => {
      it('cod 999 (necunoscut) → necunoscut, verified=false', () => {
        const r = verifyIban(trezIban('999'));
        expect(r.data.isTreasury).toBe(true);
        expect(r.data.treasuryCity).toBe(null);
        expect(r.data.treasuryCounty).toBe(null);
        expect(r.data.treasuryVerified).toBe(false);
        expect(r.data.treasuryBranchName).toContain('cod 999');
        expect(r.data.treasuryBranchName).toContain('necunoscut');
        expect(r.data.bankName).toBe(r.data.treasuryBranchName);
      });

      it('cod 158 (necunoscut) → necunoscut, fără fallback pe județ', () => {
        const r = verifyIban(trezIban('158'));
        expect(r.data.treasuryCity).toBe(null);
        expect(r.data.treasuryCounty).toBe(null);
        expect(r.data.treasuryBranchName).toContain('158');
      });
    });

    describe('regression: bug original cod 131 ≠ Constanța', () => {
      it('cod 131 din IBAN test user → Brașov, NU Constanța', () => {
        const r = verifyIban('RO45TREZ1315069XXX004466');
        expect(r.data.treasuryCity).toBe('Brașov');
        expect(r.data.treasuryCounty).toBe('Brașov');
        expect(r.data.treasuryBranchName).not.toContain('Constanța');
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
      expect(r.data.treasuryType).toBe(null);
      expect(r.data.treasuryVerified).toBe(null);
    });

    it('verifică mod-97 și pentru IBAN străin', () => {
      const r = verifyIban('GB82WEST12345698765432');
      expect(r.data.valid).toBe(true);
    });
  });
});
