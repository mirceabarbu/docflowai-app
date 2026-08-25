/**
 * #144 (P0-05) — calificarea se decide pe DOVADĂ, nu pe numele emitentului.
 * Teste PURE (fără DB, fără PDF-uri reale).
 *
 * ⛔ Niciun PDF de producție în repo: documentele reale conțin date cu caracter
 *    personal ale cetățenilor. Lucrăm exclusiv pe mulțimi de OID-uri.
 */
import { describe, it, expect } from 'vitest';
import { evaluateQcEvidence, derOids, keyUsageFromDer, QC_OID } from '../../services/qc-evidence.mjs';

describe('evaluateQcEvidence — cazul de aur (certificat STS real)', () => {
  // ⭐⭐ CAZ DE NON-REGRESIE AL PRODUCȚIEI.
  // Mulțimile de mai jos sunt EXACT cele măsurate pe un PDF real semnat cu
  // STS Qualified CA II (3 semnături). Dacă testul ăsta pică, lotul declasează
  // documente reale, valide — și greșeala e în REGULI, nu în date.
  const STS = {
    qcStatementOids: ['0.4.0.1862.1.1', '0.4.0.1862.1.4', '0.4.0.1862.1.5',
                      '0.4.0.1862.1.6', '0.4.0.1862.1.6.1'],
    certPolicyOids:  ['0.4.0.194112.1.2', '0.4.0.19431.1.1.3',
                      '1.3.6.1.4.1.20625.1.1.10.1', '1.3.6.1.5.5.7.2.1'],
    keyUsage: ['digital_signature', 'non_repudiation', 'key_encipherment'],
  };

  it('rămâne CALIFICAT (QES)', () => {
    const r = evaluateQcEvidence(STS);
    expect(r.qcCompliance).toBe(true);
    expect(r.qscd).toBe(true);
    expect(r.esign).toBe(true);
    expect(r.nonRepudiation).toBe(true);
    expect(r.isQualifiedCert).toBe(true);
    expect(r.isQES).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('acceptă și forma `contentCommitment` (denumirea RFC 5280 a aceluiași bit)', () => {
    // certificate-verify.mjs produce exact această formă, ca șir cu virgule.
    const r = evaluateQcEvidence({
      ...STS,
      keyUsage: 'digitalSignature, contentCommitment, keyEncipherment',
    });
    expect(r.nonRepudiation).toBe(true);
    expect(r.isQES).toBe(true);
  });
});

describe('evaluateQcEvidence — defectul reparat', () => {
  it('⭐⭐ extensie QcStatements PREZENTĂ dar GOALĂ ⇒ necalificat', () => {
    // Codul vechi: `qtsp.found || hasQcExt` ⇒ true (extensia există).
    // Codul nou: extensia nu declară nimic ⇒ false.
    const r = evaluateQcEvidence({
      qcStatementOids: [],
      certPolicyOids:  [],
      keyUsage: ['digital_signature', 'non_repudiation'],
    });
    expect(r.isQualifiedCert).toBe(false);
    expect(r.isQES).toBe(false);
    expect(r.missing).toContain('QcCompliance');
  });

  it('numele emitentului nu apare nicăieri în intrare — nu poate influența verdictul', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [],
      certPolicyOids:  [],
      keyUsage: [],
      issuerCN: 'STS Qualified CA II', // ignorat by design
    });
    expect(r.isQES).toBe(false);
  });
});

describe('evaluateQcEvidence — reguli', () => {
  it('QcCompliance fără nicio dovadă QSCD ⇒ calificat, dar NU QES', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [QC_OID.COMPLIANCE],
      certPolicyOids:  [],
      keyUsage: ['non_repudiation'],
    });
    expect(r.isQualifiedCert).toBe(true);
    expect(r.qscd).toBe(false);
    expect(r.isQES).toBe(false);
    expect(r.missing.join(' ')).toMatch(/QSCD/);
  });

  it('politica QCP-n-qscd e dovadă echivalentă cu QcSSCD', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [QC_OID.COMPLIANCE],
      certPolicyOids:  [QC_OID.POLICY_QCP_N_QSCD],
      keyUsage: ['non_repudiation'],
    });
    expect(r.qscd).toBe(true);
    expect(r.isQES).toBe(true);
  });

  it('QcType = eseal (sigiliu) ⇒ nu e semnătură de persoană ⇒ NU QES', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [QC_OID.COMPLIANCE, QC_OID.SSCD, QC_OID.TYPE_ESEAL],
      certPolicyOids:  [],
      keyUsage: ['non_repudiation'],
    });
    expect(r.esign).toBe(false);
    expect(r.isQualifiedCert).toBe(false);
    expect(r.isQES).toBe(false);
  });

  it('QcType complet ABSENT ⇒ esign implicit (EN 319 412-5) ⇒ QES', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [QC_OID.COMPLIANCE, QC_OID.SSCD],
      certPolicyOids:  [],
      keyUsage: ['non_repudiation'],
    });
    expect(r.esign).toBe(true);
    expect(r.isQES).toBe(true);
  });

  it('⭐ fără non-repudiation în key usage ⇒ NU QES', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [QC_OID.COMPLIANCE, QC_OID.SSCD, QC_OID.TYPE_ESIGN],
      certPolicyOids:  [QC_OID.POLICY_QCP_N_QSCD],
      keyUsage: ['digital_signature', 'key_encipherment'],
    });
    expect(r.isQualifiedCert).toBe(true);
    expect(r.isQES).toBe(false);
    expect(r.missing).toContain('key usage non-repudiation');
  });

  it('intrări degenerate ⇒ false, fără excepție', () => {
    for (const input of [undefined, null, {}, 0, 'x', [],
                         { qcStatementOids: null, certPolicyOids: undefined, keyUsage: null },
                         { qcStatementOids: ['1.2.3.4'], certPolicyOids: ['9.9'], keyUsage: ['x'] }]) {
      const r = evaluateQcEvidence(input);
      expect(r.isQES).toBe(false);
      expect(Array.isArray(r.evidence)).toBe(true);
      expect(Array.isArray(r.missing)).toBe(true);
    }
  });
});

describe('derOids', () => {
  // DER pentru 0.4.0.1862.1.1 (QcCompliance): 06 06 04 00 8E 46 01 01
  const QC_COMPLIANCE_DER = Buffer.from([0x06, 0x06, 0x04, 0x00, 0x8e, 0x46, 0x01, 0x01]);

  it('găsește un OID cunoscut', () => {
    expect(derOids(QC_COMPLIANCE_DER)).toContain(QC_OID.COMPLIANCE);
  });

  it('găsește mai multe OID-uri, într-o structură SEQUENCE', () => {
    // SEQUENCE { SEQUENCE { OID QcCompliance }, SEQUENCE { OID QcSSCD } }
    const der = Buffer.from([
      0x30, 0x10,
      0x30, 0x08, 0x06, 0x06, 0x04, 0x00, 0x8e, 0x46, 0x01, 0x01,
      0x30, 0x08, 0x06, 0x06, 0x04, 0x00, 0x8e, 0x46, 0x01, 0x04,
    ]);
    const oids = derOids(der);
    expect(oids).toContain(QC_OID.COMPLIANCE);
    expect(oids).toContain(QC_OID.SSCD);
  });

  it('acceptă ArrayBuffer și Uint8Array', () => {
    const u8 = new Uint8Array(QC_COMPLIANCE_DER);
    expect(derOids(u8)).toContain(QC_OID.COMPLIANCE);
    expect(derOids(u8.buffer.slice(0))).toContain(QC_OID.COMPLIANCE);
  });

  it('buffer gol / intrări invalide ⇒ []', () => {
    expect(derOids(Buffer.alloc(0))).toEqual([]);
    expect(derOids(null)).toEqual([]);
    expect(derOids(undefined)).toEqual([]);
    expect(derOids('nu e buffer')).toEqual([]);
  });

  it('gunoi binar ⇒ fără excepție', () => {
    const junk = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff));
    expect(() => derOids(junk)).not.toThrow();
    expect(Array.isArray(derOids(junk))).toBe(true);
  });

  it('nu produce duplicate', () => {
    const der = Buffer.concat([QC_COMPLIANCE_DER, QC_COMPLIANCE_DER]);
    expect(derOids(der).filter(o => o === QC_OID.COMPLIANCE)).toHaveLength(1);
  });
});

describe('keyUsageFromDer', () => {
  it('decodează digitalSignature + contentCommitment din DER complet', () => {
    // BIT STRING, 1 octet util, 6 biți nefolosiți, 0xC0
    expect(keyUsageFromDer(Buffer.from([0x03, 0x02, 0x06, 0xc0])))
      .toEqual(['digitalSignature', 'contentCommitment']);
  });

  it('decodează din corpul BIT STRING (forma expusă de asn1js)', () => {
    expect(keyUsageFromDer(Buffer.from([0xc0]))).toEqual(['digitalSignature', 'contentCommitment']);
  });

  it('intrări goale/invalide ⇒ []', () => {
    expect(keyUsageFromDer(null)).toEqual([]);
    expect(keyUsageFromDer(Buffer.alloc(0))).toEqual([]);
    expect(keyUsageFromDer('x')).toEqual([]);
  });

  it('rezultatul lui keyUsageFromDer e acceptat de evaluateQcEvidence', () => {
    const r = evaluateQcEvidence({
      qcStatementOids: [QC_OID.COMPLIANCE, QC_OID.SSCD, QC_OID.TYPE_ESIGN],
      certPolicyOids:  [],
      keyUsage: keyUsageFromDer(Buffer.from([0x03, 0x02, 0x05, 0xe0])),
    });
    expect(r.isQES).toBe(true);
  });
});
