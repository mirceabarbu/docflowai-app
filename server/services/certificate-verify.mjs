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
 *   L6 — QES/eIDAS conformance (dovadă: qcStatements + politici — vezi qc-evidence.mjs)
 */

import crypto from 'crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../middleware/logger.mjs';
import { evaluateQcEvidence, derOids, keyUsageFromDer, OID_CERT_POLICIES } from './qc-evidence.mjs';
// #147 — nucleul criptografic verificat trăiește într-un SINGUR loc (verify.mjs).
// ⛔ Nu duplica tabelele SIG_ALGS / EC_CURVES / DIGEST_ALGS aici — două copii diverg.
import {
  _selectSignerCert, _sigAlgInfo, _curveFromSpki, ecdsaDerToRaw, computeVerdict,
} from '../verify.mjs';

// ── Trusted CA bundle (opțional) ──────────────────────────────────────────
// Fișier: server/certs/sts-ca-bundle.pem
// Conține certificate CA publice (STS și alți QTSP) pentru extinderea lanțului.
// Non-fatal dacă fișierul lipsește — verificarea continuă fără bundle.
let _trustedCaDers = null; // null = neîncărcat; [] = fișier absent/gol

async function _loadTrustedCas() {
  if (_trustedCaDers !== null) return _trustedCaDers;
  _trustedCaDers = [];
  try {
    const dir     = dirname(fileURLToPath(import.meta.url));
    const pemPath = join(dir, '..', 'certs', 'sts-ca-bundle.pem');
    const pem     = await readFile(pemPath, 'utf8');
    const re = /-----BEGIN CERTIFICATE-----\r?\n([\s\S]+?)\r?\n-----END CERTIFICATE-----/g;
    let m;
    while ((m = re.exec(pem)) !== null) {
      const der = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
      _trustedCaDers.push(der);
    }
    if (_trustedCaDers.length > 0) {
      logger.info({ count: _trustedCaDers.length }, 'cert-verify: trusted CA bundle încărcat');
    }
  } catch(e) {
    if (e.code !== 'ENOENT') logger.warn({ err: e }, 'cert-verify: CA bundle error (non-fatal)');
  }
  return _trustedCaDers;
}

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
  QC_TYPE:         '0.4.0.1862.1.6',
  QC_TYPE_ESIGN:   '0.4.0.1862.1.6.1',
  TIMESTAMP:       '1.2.840.113549.1.9.16.2.14',
  CERT_POLICIES:   OID_CERT_POLICIES,
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

  // #144/E2 — trăsături la nivel de DOCUMENT, citite o singură dată.
  // DocTimeStamp / DSS decid nivelul PAdES; nu se pot deduce din CMS-ul semnăturii.
  const pdfFeatures = _detectPdfTimestampFeatures(pdfBytes);

  const results = [];
  for (const raw of rawSigs) {
    const r = await _verifySingleSignature(raw, pkijs, asn1js, pdfFeatures);
    results.push(r);
  }

  return {
    ok:             results.some(r => r.isValid),
    signatures:     results,
    signatureCount: results.length,
    allValid:       results.every(r => r.isValid),
  };
}

async function _verifySingleSignature({ cmsHex, hashData, index }, pkijs, asn1js, pdfFeatures = {}) {
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
    ltv_ready:             false,                     // true doar cu marcă temporală REALĂ + OCSP (#144/E1)
    certificate_qc_status: 'unknown',                 // 'qualified' | 'qualified-no-qscd' | 'non-qualified' | 'unknown'
    hasTrustedTimestamp:   false,                     // marcă temporală atestată de terț (#144/E1)
    padesLevel:            'B-B',                     // 'B-B' | 'B-T' | 'B-LT' (#144/E2)
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
      // #147 — fail-closed: absența atributului nu dovedește integritatea.
      result.levels.L1 = { name: 'Integritate document', ok: null, note: 'Neconcludent — atributul messageDigest lipseste din CMS' };
    }

    // ── Certificate + selecția semnatarului ───────────────────────────
    // #147 — MUTATĂ ÎNAINTEA lui L2: verificarea criptografică reală are nevoie
    // de cheia publică a semnatarului, deci certificatul trebuie ales întâi.
    // Includem și certurile din trusted CA bundle (dacă există).
    const cmsCerts = sd.certificates || [];
    const extraCerts = [];
    try {
      const trustedDers = await _loadTrustedCas();
      for (const der of trustedDers) {
        const ab2  = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);
        const asn2 = asn1js.fromBER(ab2);
        if (asn2.offset !== -1) extraCerts.push(new pkijs.Certificate({ schema: asn2.result }));
      }
    } catch { /* non-fatal */ }
    const certs = [...cmsCerts, ...extraCerts];

    // #147/C — selecție prin funcția PARTAJATĂ (emitent DER + serie, apoi SKI,
    // apoi euristică, apoi fallback). Varianta locală potrivea DOAR pe serie și
    // ignora emitentul destructurat — două certificate cu aceeași serie de la
    // emitenți diferiți se confundau tăcut.
    const _sel       = _selectSignerCert(sd, certs, pkijs);
    const signerCert = _sel.cert;
    const _APROX_NOTE = 'Certificatul semnatar nu a putut fi identificat din SignerInfo — verificare aproximativă';
    if (_sel.branch === 4) result.warnings.push(_APROX_NOTE);
    result.signerCertSource = _sel.branch;

    // ── L2: Semnătură CMS ─────────────────────────────────────────────
    // #147 — verificare criptografică REALĂ. Codul vechi cerea lui pkijs să
    // verifice semnătura contra bufferului CMS însuși (`data: ab`), ceea ce
    // pentru o semnătură PAdES detașată nu poate reuși cu niciun algoritm.
    result.levels.L2 = { name: 'Semnătură CMS/PKCS#7', ok: null, note: 'Parsare reușită' };
    try {
      if (!(signerCert instanceof pkijs.Certificate)) {
        result.levels.L2.ok   = null;
        result.levels.L2.note = 'Certificat semnatar absent în CMS — verificare imposibilă';
      } else {
        const { webcrypto } = crypto;
        const sigValue   = Buffer.from(si.signature.valueBlock.valueHexView ?? si.signature.valueBlock.valueHex);
        const pubKeyInfo = signerCert.subjectPublicKeyInfo;
        const algOid     = pubKeyInfo.algorithm.algorithmId;
        const keyIsECDSA = algOid === '1.2.840.10045.2.1';
        const keyIsRSA   = algOid === '1.2.840.113549.1.1.1';
        // Algoritmul REAL al SEMNĂTURII, citit din SignerInfo — nu dedus din cheie.
        const sigAlg = _sigAlgInfo(si.signatureAlgorithm?.algorithmId, si.digestAlgorithm?.algorithmId);
        const needsEC  = sigAlg.family === 'ECDSA';
        const needsRSA = sigAlg.family === 'RSA' || sigAlg.family === 'RSA-PSS';

        // Datele semnate: DER-ul atributelor semnate cu tagul implicit [0]
        // (0xa0) înlocuit cu SET (0x31), conform RFC 5652. NU hashData, NU CMS.
        let dataToVerify;
        if (si.signedAttrs?.encodedValue) {
          const rawAttrs = Buffer.from(si.signedAttrs.encodedValue);
          dataToVerify = Buffer.concat([Buffer.from([0x31]), rawAttrs.slice(1)]);
        } else {
          dataToVerify = Buffer.from(hashData);
        }
        const pubKeyDer = Buffer.from(pubKeyInfo.toSchema().toBER(false));

        if ((needsEC && !keyIsECDSA) || (needsRSA && !keyIsRSA)) {
          // necunoscut ≠ invalid: NU verificăm cu o cheie străină.
          result.levels.L2.ok   = null;
          result.levels.L2.note = 'Algoritmul semnăturii nu corespunde cheii certificatului selectat';
        } else if (needsEC || (!sigAlg.family && keyIsECDSA)) {
          const curve = _curveFromSpki(pubKeyInfo);   // ⛔ nu se presupune P-256
          if (!curve) {
            result.levels.L2.ok   = null;
            result.levels.L2.note = 'Curbă eliptică necunoscută — verificare imposibilă';
          } else {
            const hash = sigAlg.hash || 'SHA-256';
            const cryptoKey = await webcrypto.subtle.importKey(
              'spki', pubKeyDer, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']
            );
            const rawSig = ecdsaDerToRaw(sigValue, curve.size);  // DER → r||s
            const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash }, cryptoKey, rawSig, dataToVerify);
            result.levels.L2.ok   = ok;
            result.levels.L2.note = ok
              ? `Semnătură ECDSA ${curve.name}/${hash} verificată criptografic (WebCrypto)`
              : `Semnătură ECDSA ${curve.name}/${hash} INVALIDĂ`;
          }
        } else if (sigAlg.family === 'RSA-PSS') {
          result.levels.L2.ok   = null;
          result.levels.L2.note = 'Semnătură RSASSA-PSS — verificare nesuportată de acest verificator';
        } else if (sigAlg.family === 'RSA' || (!sigAlg.family && keyIsRSA)) {
          const hash = sigAlg.hash || 'SHA-256';
          const cryptoKey = await webcrypto.subtle.importKey(
            'spki', pubKeyDer, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']
          );
          const ok = await webcrypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, sigValue, dataToVerify);
          result.levels.L2.ok   = ok;
          result.levels.L2.note = ok
            ? `Semnătură RSA/${hash} verificată criptografic (WebCrypto)`
            : `Semnătură RSA/${hash} INVALIDĂ`;
        } else {
          result.levels.L2.ok   = null;
          result.levels.L2.note = `Algoritm semnătură necunoscut (${sigAlg.oid || 'n/a'}) — verificare imposibilă`;
        }
      }
    } catch(e) {
      result.levels.L2.ok   = null;
      result.levels.L2.note = `Verificare eșuată: ${e.message?.substring(0, 80)}`;
      result.warnings.push('Verificarea semnăturii CMS nu a putut fi finalizată');
    }

    // ── L3: Certificat semnatar ──────────────────────────────────────
    result.levels.L3 = { name: 'Certificat semnatar', ok: false };
    if (_sel.branch === 4) result.levels.L3.note = _APROX_NOTE;

    if (signerCert instanceof pkijs.Certificate) {
      const certInfo = _extractCertInfo(signerCert, pkijs);
      result.certificate = certInfo;
      result.levels.L3.ok = true;
      result.levels.L3.note = `CN: ${certInfo.subject.CN}`
        + (_sel.branch === 4 ? ` · ${_APROX_NOTE}` : '');

      // Signing time — din atributul CMS sau fallback la data curentă
      const stAttr = si?.signedAttrs?.attributes?.find(a => a.type === OID.SIGNING_TIME);
      if (stAttr) {
        result.signingTime = stAttr.values?.[0]?.toDate?.() || null;
      }
      // #150 (D) — validAtSigning cere un MOMENT DE REFERINȚĂ real. `signingTime`
      // lipsește la fiecare document real (STS nu pune atributul CMS — vezi #147),
      // iar fallback-ul la `new Date()` evalua de fapt „valabil ACUM", nu „la
      // semnare" — un certificat expirat între timp ar fi apărut fals „valabil
      // la semnare". Fără moment declarat, răspunsul corect e null (nedeterminat).
      result.certificate.validAtSigning = result.signingTime
        ? (new Date(certInfo.notBefore) <= new Date(result.signingTime) && new Date(result.signingTime) <= new Date(certInfo.notAfter))
        : null;

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
      let chain = chainCerts.length >= 2 ? chainCerts :
        nonOCSP.map(cert => {
          const ci = _extractCertInfo(cert, pkijs);
          ci.isEndEntity = cert === signerCert;
          return ci;
        });

      // ── Inferare lanț din issuer CN ─────────────────────────────────
      // Dacă CMS nu conține CA certs (cazul tipic STS), reconstruim lanțul
      // din câmpurile issuer ale certificatelor. Marcat isInferred=true.
      if (chain.length < 2 && chain.length > 0) {
        const ee = chain[0];
        const issuerCN = ee.issuer?.CN;
        // Adăugăm CA Intermediar inferit
        if (issuerCN && issuerCN !== (ee.subject?.CN || '')) {
          chain = [...chain, {
            subject:      { CN: issuerCN, O: ee.issuer?.O || '', OU: '', C: ee.issuer?.C || '', serial: '' },
            issuer:       { CN: issuerCN, O: ee.issuer?.O || '', C: ee.issuer?.C || '' },
            serialNumber: '—',
            isEndEntity:  false,
            isSelfSigned: false,
            isCA:         true,
            isInferred:   true,
          }];
        }
      }
      // Adăugăm Root CA inferit dacă ultimul element nu e self-signed și are issuer diferit
      if (chain.length >= 2) {
        const last = chain[chain.length - 1];
        const lastIssuerCN = last.issuer?.CN;
        if (!last.isSelfSigned && lastIssuerCN && lastIssuerCN !== (last.subject?.CN || '')) {
          const alreadyPresent = chain.some(c => (c.subject?.CN || '') === lastIssuerCN);
          if (!alreadyPresent) {
            chain = [...chain, {
              subject:      { CN: lastIssuerCN, O: last.issuer?.O || '', OU: '', C: last.issuer?.C || '', serial: '' },
              issuer:       { CN: lastIssuerCN, O: last.issuer?.O || '', C: last.issuer?.C || '' },
              serialNumber: '—',
              isEndEntity:  false,
              isSelfSigned: true,
              isCA:         true,
              isInferred:   true,
            }];
          }
        }
      }

      result.chain = chain;
      // #150 (C) — oglindește regula #149 din verify.mjs: un lanț a cărui
      // rădăcină e DEDUSĂ (nu vine din CMS/bundle) nu e verificat criptografic.
      // Dacă TOATE certificatele vin din CMS/bundle (niciun isInferred), lanțul
      // e verificat și L4.ok=true rămâne corect — nu se degradează la null.
      const _chainInferred = chain.some(c => c.isInferred === true);
      result.levels.L4.ok   = chain.length >= 2 ? (_chainInferred ? null : true) : false;
      result.levels.L4.note = _chainInferred
        ? 'Neconcludent — rădăcina lanțului e dedusă, nu verificată criptografic'
        : `${chain.length} certificate în lanț`;

      // ── L5: OCSP ────────────────────────────────────────────────────
      result.levels.L5 = { name: 'Stare de revocare (OCSP/CRL)', ok: null };
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
      // #144 (P0-05): verdictul se ia pe DOVADĂ (OID-uri din qcStatements și
      // din politicile de certificare), NU pe potrivirea numelui emitentului.
      // Numele QTSP rămâne DOAR etichetă de afișare.
      result.levels.L6 = { name: 'Conformitate QES/eIDAS', ok: false };
      const qtsp = _detectQTSP(certInfo);
      const hasQcExt = !!signerCert.extensions?.find(e => e.extnID === OID.QC_STATEMENTS);
      const qcStatementOids = _extOids(signerCert, OID.QC_STATEMENTS);
      const certPolicyOids  = _extOids(signerCert, OID.CERT_POLICIES);
      // keyUsage: preferăm forma deja parsată; dacă pkijs nu a populat
      // `parsedValue`, o recitim din DER-ul brut. Fără plasa asta, un certificat
      // REAL ar fi declasat doar pentru că extensia n-a fost pre-parsată.
      const keyUsage = certInfo.keyUsage
        || keyUsageFromDer(signerCert.extensions?.find(e => e.extnID === OID.KEY_USAGE)?.extnValue?.valueBlock?.valueHex);
      const qc = evaluateQcEvidence({ qcStatementOids, certPolicyOids, keyUsage });

      result.isQES             = qc.isQES;
      result.levels.L6.ok      = qc.isQES;
      result.levels.L6.qtsp    = qtsp.name;          // etichetă, NU dovadă
      result.levels.L6.evidence = qc.evidence;
      result.levels.L6.missing  = qc.missing;
      result.levels.L6.note    = qc.isQES
        ? `Calificat pe dovadă: ${qc.evidence.join(' · ')}`
        : qc.isQualifiedCert
          ? `Certificat calificat, dar fără dovadă QSCD — lipsește: ${qc.missing.join(', ')}`
          : `Necalificat — lipsește: ${qc.missing.join(', ')}`;
      result.certificate.certificateType =
        qc.isQES ? 'qualified' : qc.isQualifiedCert ? 'qualified_no_qscd' : 'unknown';
      result.certificate.qtspName        = qtsp.name;
      if (hasQcExt && qcStatementOids.length === 0) {
        result.warnings.push('Extensia QcStatements e prezentă dar nu conține OID-uri recunoscute.');
      }

      // ── Campuri compliance derivate ──────────────────────────────────
      result.certificate_qc_status =
        qc.isQES ? 'qualified' : qc.isQualifiedCert ? 'qualified-no-qscd' : 'non-qualified';

      // ── E1: ltv_ready cere marcă temporală REALĂ ─────────────────────
      // Înainte de #144 se folosea `result.signingTime`, care vine din atributul
      // CMS `signing_time` — AUTODECLARAT de semnatar, nu atestat de o terță
      // parte. „LTV" fără marcă temporală e o afirmație falsă. Cerem acum
      // atributul nesemnat de timestamp (RFC 3161) sau un DocTimeStamp în PDF.
      const hasTsAttr = !!si?.unsignedAttrs?.attributes?.find(a => a.type === OID.TIMESTAMP);
      const hasTimestamp = hasTsAttr || !!pdfFeatures.hasDocTimeStamp;
      result.hasTrustedTimestamp = hasTimestamp;
      result.ltv_ready = !!(hasTimestamp && result.levels.L5?.ok === true);
      // #149 — marca temporală e DETECTATĂ, nu VALIDATĂ: nu verificăm tokenul
      // RFC 3161 și nici lanțul TSA. Nivelul declarat e o observație.
      result.timestampValidated = false;

      // ── E2: nivelul PAdES declarat ───────────────────────────────────
      result.padesLevel = hasTimestamp
        ? (pdfFeatures.hasDss ? 'B-LT' : 'B-T')
        : 'B-B';
      if (!hasTimestamp) {
        result.levels.L6.note += ' · Verdict valabil LA MOMENTUL VERIFICĂRII: fără marcă temporală '
          + '(PAdES B-B), momentul semnării nu poate fi probat de o terță parte.';
      }
    }

  } catch(e) {
    result.errors.push(`Eroare: ${e.message.substring(0, 150)}`);
    logger.warn({ err: e }, 'cert-verify: error');
  }

  // Status global
  // #147 — aceeași formulă ca motorul public, prin funcția partajată. `null`
  // (nu am putut verifica) nu mai contribuie la un verdict pozitiv. L4 și L5
  // rămân DELIBERAT în afara formulei — vezi comentariul din verify.mjs.
  result.isValid = computeVerdict(result.levels);

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

// ── #144 (P0-05) — OID-urile din corpul unei extensii X.509 ───────────────
// pkijs expune `extnValue` ca OctetString; scanăm DER-ul brut cu `derOids`
// (tolerant) în loc să construim arborele ASN.1 al fiecărei extensii.
function _extOids(cert, extnID) {
  try {
    const ext = cert?.extensions?.find(e => e.extnID === extnID);
    const hex = ext?.extnValue?.valueBlock?.valueHex;
    if (!hex) return [];
    return derOids(hex);
  } catch { return []; }
}

// ── #144/E2 — DocTimeStamp / DSS la nivel de document ─────────────────────
function _detectPdfTimestampFeatures(pdfBytes) {
  try {
    const s = Buffer.from(pdfBytes).toString('binary');
    return {
      hasDocTimeStamp: /\/DocTimeStamp/.test(s),
      hasDss:          /\/DSS\b/.test(s) || /\/VRI\b/.test(s),
    };
  } catch { return { hasDocTimeStamp: false, hasDss: false }; }
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
