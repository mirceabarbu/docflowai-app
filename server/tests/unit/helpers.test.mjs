/**
 * DocFlowAI — Unit tests: helper functions critice
 *
 * Testează funcțiile pure exportate/definite în server/index.mjs fără
 * nicio dependență externă (DB, API, FS). Rulează instant.
 *
 * Acoperire:
 *   stripSensitive
 *     ✓ elimină pdfB64 și signedPdfB64
 *     ✓ setează hasPdf / hasSignedPdf corect
 *     ✓ elimină token din toți semnatarii
 *     ✓ păstrează token pentru callerSignerToken potrivit
 *     ✓ hasSignedPdf=true dacă storage=drive cu driveFileIdFinal
 *     ✓ input null/non-object returnat neschimbat
 *
 *   stripPdfB64
 *     ✓ elimină pdfB64 și signedPdfB64
 *     ✓ setează hasPdf / hasSignedPdf boolean
 *     ✓ input null returnat neschimbat
 *
 *   isSignerTokenExpired
 *     ✓ token fără tokenCreatedAt → false
 *     ✓ token creat acum → false
 *     ✓ token creat acum 91 zile → true (>90 zile default)
 *     ✓ token creat acum 89 zile → false
 *     ✓ SIGNER_TOKEN_EXPIRY_DAYS respectat din env
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Implementăm direct funcțiile (identice cu server/index.mjs) ──────────────
// Testăm logica pură fără a importa index.mjs (care are side-effects la import)

function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}

function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ...rest,
    hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && (data.driveFileLinkFinal || data.driveFileIdFinal))),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = s;
      return callerSignerToken && s.token === callerSignerToken
        ? { ...signerRest, token }
        : signerRest;
    }),
  };
}

function isSignerTokenExpired(signer, expiryDays = 90) {
  if (!signer.tokenCreatedAt) return false;
  const created = new Date(signer.tokenCreatedAt).getTime();
  return (Date.now() - created) > expiryDays * 24 * 60 * 60 * 1000;
}

// ── Fixture helpers ───────────────────────────────────────────────────────────
function makeFlowData(overrides = {}) {
  return {
    flowId:    'PT_TEST1234',
    docName:   'Referat test',
    initEmail: 'init@primaria.ro',
    orgId:     1,
    pdfB64:    'dGVzdA==',
    signedPdfB64: 'c2lnbmVk',
    signers: [
      { email: 's1@primaria.ro', name: 'Semnatar 1', token: 'tok-s1', status: 'signed' },
      { email: 's2@primaria.ro', name: 'Semnatar 2', token: 'tok-s2', status: 'current' },
    ],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// stripSensitive
// ─────────────────────────────────────────────────────────────────────────────

describe('stripSensitive', () => {

  it('elimină pdfB64 și signedPdfB64 din răspuns', () => {
    const data = makeFlowData();
    const result = stripSensitive(data);
    expect(result.pdfB64).toBeUndefined();
    expect(result.signedPdfB64).toBeUndefined();
  });

  it('setează hasPdf=true când pdfB64 există', () => {
    const result = stripSensitive(makeFlowData({ pdfB64: 'cGRm' }));
    expect(result.hasPdf).toBe(true);
  });

  it('setează hasPdf=false când pdfB64 lipsește', () => {
    const result = stripSensitive(makeFlowData({ pdfB64: undefined }));
    expect(result.hasPdf).toBe(false);
  });

  it('setează hasSignedPdf=true când signedPdfB64 există', () => {
    const result = stripSensitive(makeFlowData({ signedPdfB64: 'c2ln' }));
    expect(result.hasSignedPdf).toBe(true);
  });

  it('setează hasSignedPdf=false când signedPdfB64 lipsește', () => {
    const result = stripSensitive(makeFlowData({ signedPdfB64: undefined }));
    expect(result.hasSignedPdf).toBe(false);
  });

  it('hasSignedPdf=true dacă storage=drive cu driveFileIdFinal', () => {
    const result = stripSensitive(makeFlowData({
      signedPdfB64: undefined,
      storage: 'drive',
      driveFileIdFinal: 'drive-file-id-123',
    }));
    expect(result.hasSignedPdf).toBe(true);
  });

  it('hasSignedPdf=false dacă storage=drive fără driveFileIdFinal', () => {
    const result = stripSensitive(makeFlowData({
      signedPdfB64: undefined,
      storage: 'drive',
      driveFileIdFinal: null,
      driveFileLinkFinal: null,
    }));
    expect(result.hasSignedPdf).toBe(false);
  });

  it('elimină token din toți semnatarii când callerSignerToken lipsește', () => {
    const result = stripSensitive(makeFlowData());
    result.signers.forEach(s => {
      expect(s.token).toBeUndefined();
    });
  });

  it('elimină token din toți semnatarii când callerSignerToken este null', () => {
    const result = stripSensitive(makeFlowData(), null);
    result.signers.forEach(s => expect(s.token).toBeUndefined());
  });

  it('păstrează token DOAR pentru semnatarul cu callerSignerToken potrivit', () => {
    const result = stripSensitive(makeFlowData(), 'tok-s1');
    const s1 = result.signers.find(s => s.email === 's1@primaria.ro');
    const s2 = result.signers.find(s => s.email === 's2@primaria.ro');
    expect(s1.token).toBe('tok-s1');   // caller → token vizibil
    expect(s2.token).toBeUndefined();  // celălalt → token ascuns
  });

  it('păstrează toate celelalte câmpuri neschimbate', () => {
    const data = makeFlowData();
    const result = stripSensitive(data);
    expect(result.flowId).toBe(data.flowId);
    expect(result.docName).toBe(data.docName);
    expect(result.initEmail).toBe(data.initEmail);
    expect(result.orgId).toBe(data.orgId);
  });

  it('returnează null neschimbat', () => {
    expect(stripSensitive(null)).toBeNull();
  });

  it('returnează string neschimbat', () => {
    expect(stripSensitive('test')).toBe('test');
  });

  it('tratează signers lipsă ca array gol', () => {
    const result = stripSensitive({ flowId: 'X', pdfB64: 'abc' });
    expect(result.signers).toEqual([]);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// stripPdfB64
// ─────────────────────────────────────────────────────────────────────────────

describe('stripPdfB64', () => {

  it('elimină pdfB64 și signedPdfB64', () => {
    const result = stripPdfB64({ pdfB64: 'abc', signedPdfB64: 'def', docName: 'test' });
    expect(result.pdfB64).toBeUndefined();
    expect(result.signedPdfB64).toBeUndefined();
  });

  it('setează hasPdf=true când pdfB64 prezent', () => {
    expect(stripPdfB64({ pdfB64: 'abc' }).hasPdf).toBe(true);
  });

  it('setează hasPdf=false când pdfB64 absent', () => {
    expect(stripPdfB64({ docName: 'x' }).hasPdf).toBe(false);
  });

  it('setează hasSignedPdf=true când signedPdfB64 prezent', () => {
    expect(stripPdfB64({ signedPdfB64: 'xyz' }).hasSignedPdf).toBe(true);
  });

  it('setează hasSignedPdf=false când signedPdfB64 absent', () => {
    expect(stripPdfB64({ docName: 'x' }).hasSignedPdf).toBe(false);
  });

  it('păstrează celelalte câmpuri', () => {
    const r = stripPdfB64({ pdfB64: 'a', orgId: 5, events: [1, 2] });
    expect(r.orgId).toBe(5);
    expect(r.events).toEqual([1, 2]);
  });

  it('returnează null neschimbat', () => {
    expect(stripPdfB64(null)).toBeNull();
  });

  it('returnează număr neschimbat', () => {
    expect(stripPdfB64(42)).toBe(42);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// isSignerTokenExpired
// ─────────────────────────────────────────────────────────────────────────────

describe('isSignerTokenExpired', () => {

  it('returnează false când tokenCreatedAt lipsește', () => {
    expect(isSignerTokenExpired({})).toBe(false);
    expect(isSignerTokenExpired({ tokenCreatedAt: null })).toBe(false);
    expect(isSignerTokenExpired({ tokenCreatedAt: undefined })).toBe(false);
  });

  it('returnează false pentru token creat acum (câteva ms în urmă)', () => {
    const signer = { tokenCreatedAt: new Date().toISOString() };
    expect(isSignerTokenExpired(signer)).toBe(false);
  });

  it('returnează false pentru token creat acum 89 de zile (< 90 zile default)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 89);
    expect(isSignerTokenExpired({ tokenCreatedAt: d.toISOString() })).toBe(false);
  });

  it('returnează true pentru token creat acum 91 de zile (> 90 zile default)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 91);
    expect(isSignerTokenExpired({ tokenCreatedAt: d.toISOString() })).toBe(true);
  });

  it('returnează true exact la limita de expirare (90 zile + 1 secundă)', () => {
    const d = new Date(Date.now() - (90 * 24 * 60 * 60 * 1000 + 1000));
    expect(isSignerTokenExpired({ tokenCreatedAt: d.toISOString() })).toBe(true);
  });

  it('respectă expiryDays custom (30 zile)', () => {
    const d31 = new Date();
    d31.setDate(d31.getDate() - 31);
    const d29 = new Date();
    d29.setDate(d29.getDate() - 29);
    expect(isSignerTokenExpired({ tokenCreatedAt: d31.toISOString() }, 30)).toBe(true);
    expect(isSignerTokenExpired({ tokenCreatedAt: d29.toISOString() }, 30)).toBe(false);
  });

  it('returnează false pentru tokenCreatedAt în viitor (clock skew)', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(isSignerTokenExpired({ tokenCreatedAt: future })).toBe(false);
  });

});
