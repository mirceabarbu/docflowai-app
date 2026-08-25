import { describe, it, expect } from 'vitest';
import { formatVerificationResult } from '../../verify.mjs';

function sig(overrides = {}) {
  return {
    isValid: true,
    isQES: true,
    certificate: { subject: { CN: 'Test Semnatar', O: 'Test Org' }, issuer: { CN: 'Test CA' } },
    signingTime: '2026-08-01T10:00:00Z',
    levels: {
      L1: { ok: true },
      L2: { ok: true },
      L3: { ok: true },
      L4: { ok: true },
      L5: { ok: true },
      L6: { ok: true, qtspName: 'certSIGN' },
    },
    ...overrides,
  };
}

describe('formatVerificationResult — summary agregat pe document (#146)', () => {
  it('1. ⭐⭐ trei semnături, a doua cu L2.ok:false => allValid:false, summary.isValid:false', () => {
    const result = {
      signatures: [
        sig({ certificate: { subject: { CN: 'A' }, issuer: { CN: 'CA' } } }),
        sig({
          isValid: false,
          certificate: { subject: { CN: 'B' }, issuer: { CN: 'CA' } },
          levels: { L1: { ok: true }, L2: { ok: false }, L3: { ok: true }, L4: { ok: true }, L5: { ok: true }, L6: { ok: true } },
        }),
        sig({ certificate: { subject: { CN: 'C' }, issuer: { CN: 'CA' } } }),
      ],
    };
    const out = formatVerificationResult(result);
    expect(out.summary.allValid).toBe(false);
    expect(out.summary.isValid).toBe(false);
    expect(out.summary.signatureCount).toBe(3);
  });

  it('2. ⭐ trei valide => allValid:true, signatureCount:3, signers are 3 in order', () => {
    const result = {
      signatures: [
        sig({ certificate: { subject: { CN: 'A' }, issuer: { CN: 'CA' } } }),
        sig({ certificate: { subject: { CN: 'B' }, issuer: { CN: 'CA' } } }),
        sig({ certificate: { subject: { CN: 'C' }, issuer: { CN: 'CA' } } }),
      ],
    };
    const out = formatVerificationResult(result);
    expect(out.summary.allValid).toBe(true);
    expect(out.summary.signatureCount).toBe(3);
    expect(out.summary.signers.map(s => s.cn)).toEqual(['A', 'B', 'C']);
  });

  it('3. ⭐ două valide + una cu L2.ok:null => allValid:true, anyInconclusive:true', () => {
    const result = {
      signatures: [
        sig({ certificate: { subject: { CN: 'A' }, issuer: { CN: 'CA' } } }),
        sig({ certificate: { subject: { CN: 'B' }, issuer: { CN: 'CA' } } }),
        sig({
          certificate: { subject: { CN: 'C' }, issuer: { CN: 'CA' } },
          levels: { L1: { ok: true }, L2: { ok: null }, L3: { ok: true }, L4: { ok: true }, L5: { ok: null }, L6: { ok: true } },
        }),
      ],
    };
    const out = formatVerificationResult(result);
    expect(out.summary.allValid).toBe(true);
    expect(out.summary.anyInconclusive).toBe(true);
  });

  it('4. toate valide dar una cu isQES:false => allValid:true, allQES:false', () => {
    const result = {
      signatures: [
        sig({ certificate: { subject: { CN: 'A' }, issuer: { CN: 'CA' } } }),
        sig({ isQES: false, certificate: { subject: { CN: 'B' }, issuer: { CN: 'CA' } } }),
      ],
    };
    const out = formatVerificationResult(result);
    expect(out.summary.allValid).toBe(true);
    expect(out.summary.allQES).toBe(false);
  });

  it('5. o singură semnătură validă => toate câmpurile vechi identice cu azi', () => {
    const s = sig();
    const result = { signatures: [s] };
    const out = formatVerificationResult(result);
    expect(out.summary.isValid).toBe(true);
    expect(out.summary.isQES).toBe(true);
    expect(out.summary.signer).toBe('Test Semnatar');
    expect(out.summary.organization).toBe('Test Org');
    expect(out.summary.issuer).toBe('Test CA');
    expect(out.summary.signingTime).toBe('2026-08-01T10:00:00Z');
    expect(out.summary.qtsp).toBe('certSIGN');
    expect(out.summary.levels).toEqual({
      integrity: true, signature: true, certificate: true, chain: true, revocation: true, qes: true,
    });
  });

  it('6. signatures: [] => signatureCount:0, fără excepție', () => {
    const out = formatVerificationResult({ signatures: [] });
    expect(out.summary.signatureCount).toBe(0);
    expect(out.summary.allValid).toBe(false);
    expect(out.summary.signers).toEqual([]);
  });
});
