// #141 — teste unit pentru verifyIban (server/services/verify/ibanValidator.mjs)
// Serviciul n-avea acoperire proprie înainte de lotul 141 (frontend verificare IBAN în ORD).
import { describe, it, expect } from 'vitest';
import { verifyIban } from '../../services/verify/ibanValidator.mjs';

describe('verifyIban', () => {
  it('⭐ trezorerie reală — RO45TREZ1315069XXX004466 (Brașov)', () => {
    const r = verifyIban('RO45TREZ1315069XXX004466');
    expect(r.ok).toBe(true);
    expect(r.data.valid).toBe(true);
    expect(r.data.bankCode).toBe('TREZ');
    expect(r.data.isTreasury).toBe(true);
    expect(r.data.treasuryCity).toBe('Brașov');
  });

  it('aceeași trezorerie cu o cifră schimbată — invalid la mod-97, dar bancă tot derivată', () => {
    const r = verifyIban('RO45TREZ1315069XXX004467');
    expect(r.ok).toBe(true);
    expect(r.data.valid).toBe(false);
    expect(r.data.bankCode).toBe('TREZ');
    expect(r.data.isTreasury).toBe(true);
    expect(r.data.bankName).toBeTruthy();
  });

  it('IBAN comercial RO, cod cunoscut — bankName corect, isTreasury false', () => {
    const r = verifyIban('RO49AAAA1B31007593840000');
    expect(r.ok).toBe(true);
    expect(r.data.isTreasury).toBe(false);
    expect(r.data.bankName).toBeTruthy();
  });

  it('IBAN non-RO — country corect, bankName null, accountType foreign', () => {
    const r = verifyIban('DE89370400440532013000');
    expect(r.ok).toBe(true);
    expect(r.data.country).toBe('DE');
    expect(r.data.bankName).toBeNull();
    expect(r.data.accountType).toBe('foreign');
  });

  it('lungime RO greșită — ok:false, reason iban_ro_length_invalid', () => {
    const r = verifyIban('RO49AAAA1B3100759384');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('iban_ro_length_invalid');
  });

  it('gol — ok:false, reason iban_empty', () => {
    const r = verifyIban('');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('iban_empty');
  });

  it('format invalid — ok:false, reason iban_format_invalid', () => {
    const r = verifyIban('!!!invalid!!!');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('iban_format_invalid');
  });

  it('spații și minuscule — normalizate, valid true', () => {
    const r = verifyIban('ro45 trez 1315 069x xx00 4466');
    expect(r.ok).toBe(true);
    expect(r.data.iban).toBe('RO45TREZ1315069XXX004466');
    expect(r.data.valid).toBe(true);
  });
});
