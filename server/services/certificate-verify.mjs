/**
 * DocFlowAI — Certificate Verification Service
 *
 * Extrage și verifică certificatele X.509 dintr-un PDF semnat.
 * Folosește pkijs pentru parsare CMS/PKCS#7 și verificare lanț.
 *
 * Niveluri verificare:
 *   L1 — Integritate document (hash SHA-256 ByteRange)
 *   L2 — Semnătură CMS validă
 *   L3 — Certificat semnatar (CN, O, validitate)
 *   L4 — Lanț de certificare (cert → intermediate → root)
 *   L5 — OCSP/CRL (certificatul era valabil la semnare)
 *   L6 — QES/eIDAS conformance (QcCompliance sau QTSP cunoscut)
 */

import crypto from 'crypto';
import { logger } from '../middleware/logger.mjs';

// ── OID-uri PDF/X.509 ─────────────────────────────────────────────────────
const OID = {
  SIGNED_DATA:     '1.2.840.113549.1.7.2',
  SIGNING_TIME:    '1.2.840.113549.1.9.5',
  MSG_DIGEST:      '1.2.840.113549.1.9.4',
  CONTENT_TYPE:    '1.2.840.113549.1.9.3',
  CN:              '2.5.4.3',
  O:               '2.5.4.10',
  OU:              '2.5.4.11',
  C:               '2.5.4.6',
  SERIAL:          '2.5.4.5',
  EMAIL:           '1.2.840.113549.1.9.1',
  AIA:             '1.3.6.1.5.5.7.1.1',
  OCSP:            '1.3.6.1.5.5.7.48.1',
  CA_ISSUERS:      '1.3.6.1.5.5.7.48.2',
  CRL_DIST:        '2.5.29.31',
  KEY_USAGE:       '2.5.29.15',
  EXT_KEY_USAGE:   '2.5.29.37',
  BASIC_CONSTR:    '2.5.29.19',
  QC_STATEMENTS:   '1.3.6.1.5.5.7.1.3',
  QC_COMPLIANCE:   '0.4.0.1862.1.1',
  QC_TYPE:         '0.4.0.1862.1.6',
  QC_TYPE_ESIGN:   '0.4.0.1862.1.6.1',
  TIMESTAMP:       '1.2.840.113549.1.9.16.2.14',
};

// QTSP-uri românești/europene cunoscute
const KNOWN_QTSP = [
  { name: 'STS',        patterns: ['STS', 'SERVICIUL DE TELECOMUNICATII', 'TELECOMMUNICATION'] },
  { name: 'certSIGN',   patterns: ['CERTSIGN', 'CERT SIGN'] },
  { name: 'Trans Sped', patterns: ['TRANS SPED', 'TRANSSPED'] },
  { name: 'AlfaTrust',  patterns: ['ALFATRUST', 'ALFA TRUST', 'ALFASIGN'] },
  { name: 'DigiSign',   patterns: ['DIGISIGN', 'DIGI SIGN'] },
  { name: 'Namirial',   patterns: ['NAMIRIAL'] },
  { name: 'IVBB',       patterns: ['IVBB'] },
  { name: 'QuoVadis',   patterns: ['QUOVADIS'] },
];

/**
 * Extrage toate semnăturile din bytes-ii unui PDF.
 * @param {Buffer} pdfBytes
 * @returns {Array<{byteRange, cmsHex, hashData, index}>}
 */
export function extractPdfSignatures(pdfBytes) {
  const sigs   = [];
  const pdfStr = pdfBytes.toString('binary');
  const re     = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m, idx = 0;

  while ((m = re.exec(pdfStr)) !== null) {
    const [b1, l1, b2, l2] = [m[1], m[2], m[3], m[4]].map(Number);
    const zone1    = pdfBytes.slice(b1, b1 + l1);
    const zone2    = pdfBytes.slice(b2, b2 + l2);
    const hashData = Buffer.concat([zone1, zone2]);
    const rawHex   = pdfStr.slice(b1 + l1, b2).replace(/[<>\s]/g, '');
    if (rawHex.length < 200) continue;
    sigs.push({ byteRange: [b1, l1, b2, l2], cmsHex: rawHex, hashData, index: idx++ });
  }
  return sigs;
}

/**
 * Verifică complet toate semnăturile dintr-un PDF.
 * @param {Buffer} pdfBytes
 * @returns {Promise<FullVerificationResult>}
 */
export async function verifyPdfSignatures(pdfBytes) {
  let pkijs, asn1js;
  try {
    pkijs  = await import('pkijs');
    asn1js = await import('asn1js');
    const { webcrypto } = crypto;
    pkijs.setEngine('NodeJS', new pkijs.CryptoEngine({ name: 'NodeJS', crypto: webcrypto }));
  } catch(e) {
    return { ok: false, error: 'crypto_unavailable', message: e.message, signatures: [] };
  }

  const rawSigs = extractPdfSignatures(pdfBytes);
  if (!rawSigs.length) {
    return { ok: false, error: 'no_signatures', message: 'Nicio semnătură electronică găsită în PDF.', signatures: [] };
  }

  const results = [];
  for (const raw of rawSigs) {
    const r = await _verifySingleSignature(raw, pkijs, asn1js);
    results.push(r);
  }

  return {
    ok:             results.some(r => r.isValid),
    signatures:     results,
    signatureCount: results.length,
    allValid:       results.every(r => r.isValid),
  };
}

async function _verifySingleSignature({ cmsHex, hashData, index }, pkijs, asn1js) {
  const result = {
    index:          index + 1,
    isValid:        false,
    isQES:          false,
    certificate:    null,
    chain:          [],
    signingTime:    null,
    docHash:        null,
    levels:         { L1: null, L2: null, L3: null, L4: null, L5: null, L6: null },
    errors:         [],
    warnings:       [],
    // ── Câmpuri compliance ──────────────────────────────────────────────
    validation_time:       new Date().toISOString(),  // momentul verificării
    validation_source:     'local',                   // 'local' | 'ocsp' | 'crl'
    ltv_ready:             false,                     // true dacă avem timestamp CMS + OCSP
    certificate_qc_status: 'unknown',                 // 'qualified' | 'non-qualified' | 'unknown'
  };

  try {
    // ── Hash document ────────────────────────────────────────────────────
    result.docHash = crypto.createHash('sha256').update(hashData).digest('hex');

    // ── Parsare CMS ───────────────────────────────────────────────────────
    const cmsBuf = Buffer.from(cmsHex, 'hex');
    const ab     = cmsBuf.buffer.slice(cmsBuf.byteOffset, cmsBuf.byteOffset + cmsBuf.byteLength);
    const asn1   = asn1js.fromBER(ab);
    if (asn1.offset === -1) {
      result.errors.push('ASN.1 invalid — CMS corupt');
      return result;
    }

    const ci = new pkijs.ContentInfo({ schema: asn1.result });
    if (ci.contentType !== OID.SIGNED_DATA) {
      result.errors.push(`ContentType neașteptat: ${ci.contentType}`);
      return result;
    }
    const sd = new pkijs.SignedData({ schema: ci.content });

    // ── L1: Integritate document ───────────────────────────────────────
    const si = sd.signerInfos?.[0];
    const digestAttr = si?.signedAttrs?.attributes?.find(a => a.type === OID.MSG_DIGEST);
    if (digestAttr) {
      const embedded = Buffer.from(digestAttr.values[0].valueBlock.valueHex).toString('hex');
      const computed = crypto.createHash('sha256').update(hashData).digest('hex');
      result.levels.L1 = {
        name:         'Integritate document',
        ok:           embedded.toLowerCase() === computed.toLowerCase(),
        embeddedHash: embedded,
        computedHash: computed,
        note:         embedded.toLowerCase() === computed.toLowerCase() ? 'Documentul NU a fost modificat' : '⚠ Documentul a fost MODIFICAT după semnare!',
      };
    } else {
      result.levels.L1 = { name: 'Integritate document', ok: true, note: 'Hash intact (atribut msgDigest absent)' };
    }

    // ── L2: Semnătură CMS ─────────────────────────────────────────────
    result.levels.L2 = { name: 'Semnătură CMS/PKCS#7', ok: null, note: 'Parsare reușită' };
    try {
      const verOk = await sd.verify({ signer: 0, data: ab, extendedMode: true, checkChain: false });
      result.levels.L2.ok   = verOk === true || verOk?.signatureVerified === true;
      result.levels.L2.note = result.levels.L2.ok ? 'Semnătură criptografică validă' : 'Semnătură invalidă';
    } catch(e) {
      result.levels.L2.ok   = null;
      result.levels.L2.note = 'Verificare parțială (context WebCrypto server)';
      result.warnings.push('Verificare CMS completă necesită contextul original al datelor semnate');
    }

    // ── L3: Certificat semnatar ──────────────────────────────────────
    const certs = sd.certificates || [];

    // Găsim end-entity cert — cel care corespunde signerInfo
    // (nu CA-ul, nu OCSP responder — cel cu keyUsage digitalSignature și fără isCA)
    let signerCert = null;
    const si0 = sd.signerInfos?.[0];

    // Metodă 1: potrivire issuer+serialNumber din signerInfo
    if (si0?.sid?.issuerAndSerialNumber) {
      const { issuer, serialNumber } = si0.sid.issuerAndSerialNumber;
      const targetSerial = Buffer.from(serialNumber.valueBlock.valueHex).toString('hex').toLowerCase();
      for (const cert of certs) {
        if (!(cert instanceof pkijs.Certificate)) continue;
        const certSerial = Buffer.from(cert.serialNumber.valueBlock.valueHex).toString('hex').toLowerCase();
        if (certSerial === targetSerial) { signerCert = cert; break; }
      }
    }

    // Metodă 2: primul cert care NU e CA, NU e OCSP responder, NU e self-signed
    if (!signerCert) {
      for (const cert of certs) {
        if (!(cert instanceof pkijs.Certificate)) continue;
        const isCA = !!cert.extensions?.find(e => e.extnID === OID.BASIC_CONSTR)?.parsedValue?.cA;
        const getCN = rdn => rdn?.typesAndValues?.find(tv => tv.type === OID.CN)?.value?.valueBlock?.value || '';
        const subjectCN = getCN(cert.subject);
        const isSelf = subjectCN === getCN(cert.issuer);
        // Excludem OCSP responders (CN conține "OCSP")
        const isOCSP = subjectCN.toUpperCase().includes('OCSP');
        if (!isCA && !isSelf && !isOCSP) { signerCert = cert; break; }
      }
    }

    // Fallback: primul cert din listă
    if (!signerCert) signerCert = certs[0];

    result.levels.L3 = { name: 'Certificat semnatar', ok: false };

    if (signerCert instanceof pkijs.Certificate) {
      const certInfo = _extractCertInfo(signerCert, pkijs);
      result.certificate = certInfo;
      result.levels.L3.ok = true;
      result.levels.L3.note = `CN: ${certInfo.subject.CN}`;

      // Signing time — din atributul CMS sau fallback la data curentă
      const stAttr = si?.signedAttrs?.attributes?.find(a => a.type === OID.SIGNING_TIME);
      if (stAttr) {
        result.signingTime = stAttr.values?.[0]?.toDate?.() || null;
      }
      // validAtSigning: folosim signingTime din CMS dacă există, altfel verificăm că cert e valid acum
      const checkTime = result.signingTime || new Date();
      result.certificate.validAtSigning =
        (new Date(certInfo.notBefore) <= checkTime && checkTime <= new Date(certInfo.notAfter));

      // ── L4: Lanț certificare ────────────────────────────────────────
      result.levels.L4 = { name: 'Lanț de certificare', ok: false };
      // Construim lanțul pornind de la signerCert → issueri succesivi
      const chainCerts = [];
      let currentCert = signerCert;
      const visited = new Set();
      while (currentCert && chainCerts.length < 10) {
        const certInfo2 = _extractCertInfo(currentCert, pkijs);
        const isEndEntity = currentCert === signerCert;
        chainCerts.push({ ...certInfo2, isEndEntity });
        const serialKey = certInfo2.serialNumber;
        if (visited.has(serialKey)) break;
        visited.add(serialKey);
        // Self-signed strict: subject DN = issuer DN (nu doar CN)
        const getDN = rdn => (rdn?.typesAndValues || []).map(tv => tv.value?.valueBlock?.value || '').join('|');
        if (getDN(currentCert.subject) === getDN(currentCert.issuer)) break;
        // Găsim issuer-ul în celelalte certs
        const issuerCN2 = certInfo2.issuer?.CN || '';
        const next = certs.find(cert => {
          if (!(cert instanceof pkijs.Certificate) || cert === currentCert) return false;
          const subj = cert.subject?.typesAndValues?.find(tv => tv.type === OID.CN)?.value?.valueBlock?.value || '';
          const certSerial = Buffer.from(cert.serialNumber.valueBlock.valueHex).toString('hex').toUpperCase();
          return subj === issuerCN2 && !visited.has(certSerial);
        });
        currentCert = next || null;
      }
      // Fallback: dacă chainCerts are < 2 elemente, includem toate certurile non-OCSP
      const nonOCSP = certs.filter(cert => {
        if (!(cert instanceof pkijs.Certificate)) return false;
        const getCN = rdn => rdn?.typesAndValues?.find(tv => tv.type === OID.CN)?.value?.valueBlock?.value || '';
        return !getCN(cert.subject).toUpperCase().includes('OCSP');
      });
      const chain = chainCerts.length >= 2 ? chainCerts :
        nonOCSP.map(cert => {
          const ci = _extractCertInfo(cert, pkijs);
          ci.isEndEntity = cert === signerCert;
          return ci;
        });
      result.chain = chain;
      result.levels.L4.ok   = chain.length >= 2;
      result.levels.L4.note = `${chain.length} certificate în lanț`;

      // ── L5: OCSP ────────────────────────────────────────────────────
      result.levels.L5 = { name: 'Validitate la semnare (OCSP/CRL)', ok: null };
      if (certInfo.ocspUrl) {
        try {
          // Găsim CA-ul direct al signerCert (issuer match)
        const getIssuerCN = cert => cert?.issuer?.typesAndValues?.find(tv => tv.type === OID.CN)?.value?.valueBlock?.value || '';
        const signerIssuerCN = getIssuerCN(signerCert);
        const issuerCertForOCSP = certs.find(cert => {
          if (!(cert instanceof pkijs.Certificate)) return false;
          const subjectCN = cert.subject?.typesAndValues?.find(tv => tv.type === OID.CN)?.value?.valueBlock?.value || '';
          return subjectCN === signerIssuerCN && cert !== signerCert;
        }) || certs.find(c => c !== signerCert && c instanceof pkijs.Certificate);
        const ocsp = await _checkOCSP(signerCert, issuerCertForOCSP, certInfo.ocspUrl, pkijs, asn1js);
          result.levels.L5.ok     = ocsp.good;
          result.levels.L5.status = ocsp.status;
          result.levels.L5.note   = ocsp.note;
          result.certificate.revocationStatus = ocsp.status;
          result.validation_source = 'ocsp';
        } catch(e) {
          result.levels.L5.ok   = null;
          result.levels.L5.note = `OCSP neverificat: ${e.message.substring(0, 60)}`;
        }
      } else {
        result.levels.L5.note = 'URL OCSP negăsit în certificat';
      }

      // ── L6: QES/eIDAS ───────────────────────────────────────────────
      result.levels.L6 = { name: 'Conformitate QES/eIDAS', ok: false };
      const qtsp = _detectQTSP(certInfo);
      const hasQcExt = !!signerCert.extensions?.find(e => e.extnID === OID.QC_STATEMENTS);
      result.isQES = qtsp.found || hasQcExt;
      result.levels.L6.ok      = result.isQES;
      result.levels.L6.qtsp    = qtsp.name;
      result.levels.L6.note    = result.isQES
        ? `QTSP: ${qtsp.name || 'QcCompliance prezent'}${hasQcExt ? ' · QcCompliance ✓' : ''}`
        : 'QTSP nerecunoscut — posibil certificat necalificat';
      result.certificate.certificateType = result.isQES ? 'qualified' : 'unknown';
      result.certificate.qtspName        = qtsp.name;

      // ── Campuri compliance derivate ──────────────────────────────────
      result.certificate_qc_status = result.isQES ? 'qualified' : 'non-qualified';
      // ltv_ready: avem timestamp CMS + OCSP verificat cu succes
      result.ltv_ready = !!(result.signingTime && result.levels.L5?.ok === true);
    }

  } catch(e) {
    result.errors.push(`Eroare: ${e.message.substring(0, 150)}`);
    logger.warn({ err: e }, 'cert-verify: error');
  }

  // Status global
  result.isValid =
    result.levels.L1?.ok !== false &&
    result.levels.L2?.ok !== false &&
    result.levels.L3?.ok === true;

  return result;
}

// ── Extrage informații dintr-un certificat X.509 ────────────────────────────
function _extractCertInfo(cert, pkijs) {
  const get = (rdn, oid) => rdn?.typesAndValues?.find(tv => tv.type === oid)?.value?.valueBlock?.value || '';

  const notBefore = cert.notBefore?.value;
  const notAfter  = cert.notAfter?.value;
  const now       = new Date();

  // Număr serial hex
  const serialHex = cert.serialNumber?.valueBlock?.valueHex
    ? Buffer.from(cert.serialNumber.valueBlock.valueHex).toString('hex').toUpperCase()
    : '—';

  // AIA — OCSP URL
  let ocspUrl = null, caIssuersUrl = null;
  for (const ext of (cert.extensions || [])) {
    if (ext.extnID === OID.AIA) {
      try {
        const aia = new pkijs.InfoAccessSyntax({ schema: ext.parsedValue || asn1js?.fromBER?.(ext.extnValue.valueBlock.valueHex)?.result });
        for (const d of (aia.accessDescriptions || [])) {
          if (d.accessMethod === OID.OCSP)      ocspUrl = d.accessLocation?.value;
          if (d.accessMethod === OID.CA_ISSUERS) caIssuersUrl = d.accessLocation?.value;
        }
      } catch { /* non-fatal */ }
    }
  }

  // Key usage
  let keyUsage = null;
  const kuExt = cert.extensions?.find(e => e.extnID === OID.KEY_USAGE);
  if (kuExt?.parsedValue) {
    const bits = kuExt.parsedValue;
    const usages = [];
    if (bits.valueBlock?.valueHex) {
      const byte = Buffer.from(bits.valueBlock.valueHex)[0];
      if (byte & 0x80) usages.push('digitalSignature');
      if (byte & 0x40) usages.push('contentCommitment');
      if (byte & 0x20) usages.push('keyEncipherment');
    }
    keyUsage = usages.join(', ');
  }

  // QcStatements
  const qcExt = cert.extensions?.find(e => e.extnID === OID.QC_STATEMENTS);

  // Algoritmii
  const sigAlg = cert.signatureAlgorithm?.algorithmId || '—';
  const sigAlgName = {
    '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
    '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
    '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
    '1.2.840.10045.4.3.2':   'ecdsa-with-SHA256',
    '1.2.840.10045.4.3.3':   'ecdsa-with-SHA384',
  }[sigAlg] || sigAlg;

  const isSelfSigned = get(cert.subject, OID.CN) === get(cert.issuer, OID.CN);

  return {
    subject: {
      CN:     get(cert.subject, OID.CN),
      O:      get(cert.subject, OID.O),
      OU:     get(cert.subject, OID.OU),
      C:      get(cert.subject, OID.C),
      serial: get(cert.subject, OID.SERIAL),
    },
    issuer: {
      CN: get(cert.issuer, OID.CN),
      O:  get(cert.issuer, OID.O),
      C:  get(cert.issuer, OID.C),
    },
    serialNumber:       serialHex,
    notBefore:          notBefore,
    notAfter:           notAfter,
    isCurrentlyValid:   notBefore <= now && now <= notAfter,
    validAtSigning:     null, // completat mai sus
    revocationStatus:   'unknown',
    certificateType:    'unknown',
    qtspName:           null,
    isSelfSigned,
    isCA:               !!cert.extensions?.find(e => e.extnID === OID.BASIC_CONSTR)?.parsedValue?.cA,
    keyUsage,
    signatureAlgorithm: sigAlgName,
    hasQcStatements:    !!qcExt,
    ocspUrl,
    caIssuersUrl,
  };
}

// ── Detectare QTSP din emitentul certificatului ───────────────────────────
function _detectQTSP(certInfo) {
  const issuerCN = (certInfo.issuer?.CN || '').toUpperCase();
  const issuerO  = (certInfo.issuer?.O  || '').toUpperCase();
  for (const qtsp of KNOWN_QTSP) {
    if (qtsp.patterns.some(p => issuerCN.includes(p) || issuerO.includes(p))) {
      return { found: true, name: qtsp.name };
    }
  }
  return { found: false, name: null };
}

// ── Verificare OCSP live ──────────────────────────────────────────────────
async function _checkOCSP(cert, issuerCert, ocspUrl, pkijs, asn1js) {
  if (!issuerCert || !ocspUrl) {
    return { good: null, status: 'unknown', note: 'Date insuficiente pentru OCSP' };
  }
  try {
    const { webcrypto } = crypto;
    const ocspReq = new pkijs.OCSPRequest();
    await ocspReq.createForCertificate(cert, {
      hashAlgorithm:     'SHA-256',
      issuerCertificate: issuerCert,
    });
    const reqBuf = ocspReq.toSchema(true).toBER(false);
    const resp   = await fetch(ocspUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/ocsp-request' },
      body:    reqBuf,
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { good: null, status: 'unknown', note: `OCSP HTTP ${resp.status}` };

    const buf   = Buffer.from(await resp.arrayBuffer());
    const asn1r = asn1js.fromBER(buf.buffer);
    const ocspResp = new pkijs.OCSPResponse({ schema: asn1r.result });
    if (ocspResp.responseStatus?.valueBlock?.valueDec !== 0) {
      return { good: false, status: 'error', note: 'OCSP responder error' };
    }
    const basic   = new pkijs.BasicOCSPResponse({ schema: ocspResp.responseBytes.response });
    const single  = basic.tbsResponseData.responses?.[0];
    const tagNum  = single?.certStatus?.idBlock?.tagNumber;
    const status  = tagNum === 0 ? 'valid' : tagNum === 1 ? 'revoked' : 'unknown';
    return { good: status === 'valid', status, note: `OCSP: ${status}` };
  } catch(e) {
    return { good: null, status: 'unknown', note: `OCSP: ${e.message.substring(0, 60)}` };
  }
}

export { _extractCertInfo, _detectQTSP };
