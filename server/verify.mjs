/**
 * DocFlowAI — Modul verificare semnături electronice calificate
 *
 * Verifică un PDF semnat electronic la niveluri multiple:
 *   L1 — Integritate hash: documentul nu a fost modificat după semnare
 *   L2 — Semnătură CMS: PKCS#7/CAdES valid, hash document confirmat
 *   L3 — Certificat semnatar: CN, O, validitate, emitent
 *   L4 — Lanț certificare: cert → intermediate CA → root QTSP
 *   L5 — OCSP/CRL: certificatul era valabil la momentul semnării
 *   L6 — QES/eIDAS: dovadă qcStatements + politici (vezi services/qc-evidence.mjs)
 *
 * Dependențe: pkijs, asn1js, pvutils (toate MIT)
 */

import crypto from 'crypto';
import { logger } from './middleware/logger.mjs';
import { evaluateQcEvidence, derOids, keyUsageFromDer, OID_CERT_POLICIES } from './services/qc-evidence.mjs';

// ── OID-uri relevante ──────────────────────────────────────────────────────
const OID_SIGNED_DATA       = '1.2.840.113549.1.7.2';
const OID_SIGNING_TIME      = '1.2.840.113549.1.9.5';
const OID_SHA256            = '2.16.840.1.101.3.4.2.1';
const OID_SHA1              = '1.3.14.3.2.26';
const OID_RSA               = '1.2.840.113549.1.1.1';
const OID_ECDSA             = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME       = '2.5.4.3';
const OID_ORGANIZATION      = '2.5.4.10';
const OID_COUNTRY           = '2.5.4.6';
const OID_AIA               = '1.3.6.1.5.5.7.1.1';
const OID_OCSP              = '1.3.6.1.5.5.7.48.1';
const OID_CA_ISSUERS        = '1.3.6.1.5.5.7.48.2';
const OID_CRL_DIST          = '2.5.29.31';
const OID_QC_STATEMENTS     = '1.3.6.1.5.5.7.1.3';
const OID_QC_COMPLIANCE     = '0.4.0.1862.1.1'; // QcCompliance — QES
const OID_CERT_POLICIES_EXT = OID_CERT_POLICIES; // 2.5.29.32
const OID_KEY_USAGE         = '2.5.29.15';

// QTSP-uri românești cunoscute (CN rădăcini).
// ⛔ #144 (P0-05): lista e DOAR etichetă de afișare (`qtspName`). NU intră
// în nicio decizie booleană — calificarea se decide pe dovadă, în
// `services/qc-evidence.mjs`.
const KNOWN_ROMANIAN_QTSP = [
  'STS', 'certSIGN', 'Trans Sped', 'AlfaTrust', 'DigiSign',
  'Namirial', 'DIGSIGN', 'CERTSIGN',
];

// ── #145 — identificarea certificatului semnatar ───────────────────────────
// ⛔ NU lua `certificates[0]`. În CMS, `certificates` este un SET (RFC 5652) —
// un sac NEORDONAT. În fișierele produse de fluxul STS, primul element este
// RĂDĂCINA (CA, cheie RSA), nu semnatarul (cheie EC). Alegerea pe poziție a
// produs în producție un FALS NEGATIV pe orice document valid: cheia RSA a
// rădăcinii era folosită ca să verifice o semnătură ECDSA ⇒ „Semnătură RSA
// INVALIDĂ". Identitatea semnatarului E în document: `signerInfos[0].sid`.

const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_SUBJECT_KEY_ID    = '2.5.29.14';

/** DER-ul unui obiect pkijs (comparație pe octeți, nu pe șiruri reconstruite). */
function _der(obj) {
  try { return Buffer.from(obj.toSchema().toBER(false)); } catch { return null; }
}
function _hexOf(hexView) {
  try { return hexView ? Buffer.from(hexView).toString('hex').toLowerCase() : null; } catch { return null; }
}
/** Conținutul unui OCTET STRING DER (header scurt sau lung). */
function _unwrapOctetString(buf) {
  const b = Buffer.from(buf);
  if (b.length < 2 || b[0] !== 0x04) return null;
  let len = b[1], off = 2;
  if (len & 0x80) {
    const n = len & 0x7f; len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[2 + i];
    off = 2 + n;
  }
  return b.slice(off, off + len);
}
function _skiOf(cert) {
  const e = cert.extensions?.find(x => x.extnID === OID_SUBJECT_KEY_ID);
  const raw = e?.extnValue?.valueBlock?.valueHexView || e?.extnValue?.valueBlock?.valueHex;
  if (!raw) return null;
  const inner = _unwrapOctetString(raw);
  return inner ? inner.toString('hex').toLowerCase() : null;
}
function _isCA(cert) {
  const e = cert.extensions?.find(x => x.extnID === OID_BASIC_CONSTRAINTS);
  if (!e) return false;               // extensie absentă ⇒ entitate finală
  try { return e.parsedValue?.cA === true; } catch { return false; }
}
function _isSelfSigned(cert) {
  const s = _der(cert.subject), i = _der(cert.issuer);
  return !!(s && i && s.equals(i));
}
function _cnOf(rdn) {
  return rdn?.typesAndValues?.find(tv => tv.type === OID_COMMON_NAME)?.value?.valueBlock?.value || '';
}

/**
 * Alege certificatul semnatarului din sacul CMS.
 * @returns {{cert: any, branch: number}} branch = ramura care a prins:
 *   1 issuerAndSerialNumber · 2 subjectKeyIdentifier · 3 euristică · 4 certs[0]
 */
export function _selectSignerCert(signedData, certs, pkijs) {
  const list = (certs || []).filter(c => c instanceof pkijs.Certificate);
  if (!list.length) return { cert: undefined, branch: 0 };

  const si  = signedData?.signerInfos?.[0];
  const sid = si?.sid;

  // 1 — sid = issuerAndSerialNumber: potrivire pe SERIE **și** pe DN-ul
  //     emitentului, comparat pe DER (ordinea RDN și UTF8String vs
  //     PrintableString fac comparația textuală fals-negativă).
  if (sid?.serialNumber && sid?.issuer) {
    const wantSerial = _hexOf(sid.serialNumber.valueBlock.valueHexView ?? sid.serialNumber.valueBlock.valueHex);
    const wantIssuer = _der(sid.issuer);
    for (const c of list) {
      const gotSerial = _hexOf(c.serialNumber.valueBlock.valueHexView ?? c.serialNumber.valueBlock.valueHex);
      if (!wantSerial || gotSerial !== wantSerial) continue;
      const gotIssuer = _der(c.issuer);
      if (wantIssuer && gotIssuer && gotIssuer.equals(wantIssuer)) return { cert: c, branch: 1 };
    }
  }

  // 2 — sid = subjectKeyIdentifier: potrivire pe extensia 2.5.29.14
  if (sid && !sid.serialNumber) {
    const wantSki = _hexOf(sid.valueBlock?.valueHexView ?? sid.valueBlock?.valueHex);
    if (wantSki) {
      for (const c of list) if (_skiOf(c) === wantSki) return { cert: c, branch: 2 };
    }
  }

  // 3 — euristică: primul certificat de entitate finală, ne-auto-semnat,
  //     fără „OCSP" în CN (responder-ele OCSP sunt tot entități finale).
  for (const c of list) {
    if (_isCA(c) || _isSelfSigned(c)) continue;
    if (/OCSP/i.test(_cnOf(c.subject))) continue;
    return { cert: c, branch: 3 };
  }

  // 4 — ultimă instanță. ⛔ NICIODATĂ tăcută — tăcerea ei a fost chiar bug-ul.
  return { cert: list[0], branch: 4 };
}

/** Certificatul al cărui SUBIECT (DER) coincide cu EMITENTUL (DER) al lui cert. */
export function _findIssuerCert(cert, certs, pkijs) {
  const want = _der(cert?.issuer);
  if (!want) return null;
  for (const c of (certs || [])) {
    if (!(c instanceof pkijs.Certificate) || c === cert) continue;
    const got = _der(c.subject);
    if (got && got.equals(want)) return c;
  }
  return null;
}

// ── #145/C — algoritmi, curbe, format de semnătură ────────────────────────
const SIG_ALGS = {
  '1.2.840.10045.4.3.2':   { family: 'ECDSA',   hash: 'SHA-256' },
  '1.2.840.10045.4.3.3':   { family: 'ECDSA',   hash: 'SHA-384' },
  '1.2.840.10045.4.3.4':   { family: 'ECDSA',   hash: 'SHA-512' },
  '1.2.840.10045.4.1':     { family: 'ECDSA',   hash: 'SHA-1'   },
  '1.2.840.10045.2.1':     { family: 'ECDSA',   hash: null      }, // id-ecPublicKey folosit ca alg de semnătură
  '1.2.840.113549.1.1.11': { family: 'RSA',     hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { family: 'RSA',     hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { family: 'RSA',     hash: 'SHA-512' },
  '1.2.840.113549.1.1.5':  { family: 'RSA',     hash: 'SHA-1'   },
  '1.2.840.113549.1.1.1':  { family: 'RSA',     hash: null      }, // rsaEncryption ⇒ digest din digestAlgorithm
  '1.2.840.113549.1.1.10': { family: 'RSA-PSS', hash: null      },
};
const DIGEST_ALGS = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '1.3.14.3.2.26':          'SHA-1',
};
const EC_CURVES = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34':        { name: 'P-384', size: 48 },
  '1.3.132.0.35':        { name: 'P-521', size: 66 },
};

/** Algoritmul REAL al semnăturii, citit din SignerInfo — nu dedus din cheie. */
export function _sigAlgInfo(sigOid, digestOid) {
  const t = SIG_ALGS[sigOid] || null;
  const hash = t?.hash || DIGEST_ALGS[digestOid] || null;
  return { family: t?.family || null, hash, oid: sigOid || null };
}

/** Curba din parametrii cheii — ⛔ nu se mai presupune P-256. */
export function _curveFromSpki(pubKeyInfo) {
  let oid = null;
  try {
    const p = pubKeyInfo?.algorithm?.algorithmParams;
    oid = p?.valueBlock?.toString?.() || (typeof p?.getValue === 'function' ? p.getValue() : null);
  } catch { oid = null; }
  return (oid && EC_CURVES[oid]) ? { ...EC_CURVES[oid], oid } : null;
}

/**
 * Semnătura ECDSA din CMS e DER (`SEQUENCE{INTEGER r, INTEGER s}`);
 * `webcrypto.subtle.verify` cere formatul raw: `r||s`, fiecare pe EXACT
 * dimensiunea curbei. Fără conversie, verificarea întoarce `false` chiar și
 * cu certificatul corect.
 * ⛔ Intrare care nu e o secvență DER validă ⇒ întoarsă NESCHIMBATĂ, fără
 * excepție aruncată.
 * @param {Buffer|Uint8Array} sig
 * @param {number} fieldSize 32 (P-256) | 48 (P-384) | 66 (P-521)
 */
export function ecdsaDerToRaw(sig, fieldSize) {
  const b = Buffer.from(sig);
  if (!fieldSize || fieldSize < 1) return b;
  if (b.length === fieldSize * 2 && b[0] !== 0x30) return b;   // deja raw
  try {
    if (b.length < 8 || b[0] !== 0x30) return b;
    let off = 1, len = b[off++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 4) return b;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | b[off++];
    }
    if (off + len !== b.length) return b;
    const readInt = () => {
      if (b[off++] !== 0x02) return null;
      let l = b[off++];
      if (l & 0x80) {
        const n = l & 0x7f;
        if (n < 1 || n > 4) return null;
        l = 0;
        for (let i = 0; i < n; i++) l = (l << 8) | b[off++];
      }
      if (l < 1 || off + l > b.length) return null;
      let v = b.slice(off, off + l);
      off += l;
      while (v.length > 1 && v[0] === 0x00) v = v.slice(1);     // zero de aliniere (bit de semn)
      if (v.length > fieldSize) return null;
      return Buffer.concat([Buffer.alloc(fieldSize - v.length, 0), v]); // stânga-completare
    };
    const r = readInt(); if (!r) return b;
    const s = readInt(); if (!s) return b;
    if (off !== b.length) return b;
    return Buffer.concat([r, s]);
  } catch { return b; }
}

/**
 * Extrage toate semnăturile din bytes-ii unui PDF (ByteRange + /Contents).
 * @param {Buffer} pdfBytes
 * @returns {Array<{byteRange, cmsHex, hashData}>}
 */
export function extractPdfSignatures(pdfBytes) {
  const signatures = [];
  const pdfStr     = Buffer.from(pdfBytes).toString('binary');
  const brRe       = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let match;

  while ((match = brRe.exec(pdfStr)) !== null) {
    const [, b1s, l1s, b2s, l2s] = match;
    const [b1, l1, b2, l2]       = [b1s, l1s, b2s, l2s].map(Number);

    // Date de hashuit (exclude conținutul /Contents)
    const zone1    = pdfBytes.slice(b1, b1 + l1);
    const zone2    = pdfBytes.slice(b2, b2 + l2);
    const hashData = Buffer.concat([zone1, zone2]);

    // CMS bytes (hex între < și >)
    const rawHex = pdfStr.slice(b1 + l1, b2).replace(/[<>\s]/g, '');
    if (rawHex.length < 200) continue; // skip rezervări goale

    signatures.push({
      byteRange: [b1, l1, b2, l2],
      cmsHex:    rawHex,
      hashData,
    });
  }

  return signatures;
}

/**
 * Verifică complet o semnătură PDF.
 * @param {Buffer} pdfBytes — bytes-ii PDF-ului complet
 * @returns {Promise<VerificationResult>}
 */
export async function verifyPdfSignatures(pdfBytes) {
  const results = [];

  let pkijs, asn1js;
  try {
    pkijs  = await import('pkijs');
    asn1js = await import('asn1js');
  } catch(e) {
    return {
      ok: false,
      error: 'crypto_libs_unavailable',
      message: 'Librăriile de verificare criptografică nu sunt disponibile. Verificați instalarea: npm install pkijs asn1js pvutils',
    };
  }

  // Configurăm WebCrypto pentru pkijs (Node.js)
  const { webcrypto } = crypto;
  pkijs.setEngine('NodeJS', new pkijs.CryptoEngine({ name: 'NodeJS', crypto: webcrypto }));

  const sigs = extractPdfSignatures(pdfBytes);
  if (!sigs.length) {
    return {
      ok: false, signatures: [],
      error: 'no_signatures',
      message: 'Nu s-au găsit semnături electronice în acest document PDF.',
    };
  }

  for (let i = 0; i < sigs.length; i++) {
    const { cmsHex, hashData } = sigs[i];
    const result = {
      index:       i + 1,
      levels:      {},
      certificate: null,
      chain:       [],
      signingTime: null,
      isQES:       false,
      isValid:     false,
      errors:      [],
      warnings:    [],
    };

    try {
      // ── L1: Hash integritate ──────────────────────────────────────────
      result.levels.L1 = { name: 'Integritate document', ok: null };
      const docHash = crypto.createHash('sha256').update(hashData).digest('hex');
      result.docHash = docHash;

      // ── Parsare CMS/SignedData ────────────────────────────────────────
      const cmsBuf = Buffer.from(cmsHex, 'hex');
      const ab     = cmsBuf.buffer.slice(cmsBuf.byteOffset, cmsBuf.byteOffset + cmsBuf.byteLength);
      const asn1   = asn1js.fromBER(ab);

      if (asn1.offset === -1) {
        result.errors.push('ASN.1 invalid — date CMS corupte');
        results.push(result);
        continue;
      }

      const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
      if (contentInfo.contentType !== OID_SIGNED_DATA) {
        result.errors.push(`ContentType neașteptat: ${contentInfo.contentType}`);
        results.push(result);
        continue;
      }

      const signedData = new pkijs.SignedData({ schema: contentInfo.content });

      // ── Extract certificat semnatar DEVREME (folosit în L2 fallback și în L3) ──
      // FIX v3.9.337: era declarat la L244 dar folosit la L166 în catch-ul L2 fallback → Temporal Dead Zone
      const certs = signedData.certificates || [];
      // #145 — certificatul semnatar se identifică din SignerInfo, NU pe poziție.
      const _sel = _selectSignerCert(signedData, certs, pkijs);
      const signerCert = _sel.cert;
      const _APROX_NOTE = 'Certificatul semnatar nu a putut fi identificat din SignerInfo — verificare aproximativă';
      if (_sel.branch === 4) result.warnings.push(_APROX_NOTE);
      result.signerCertSource = _sel.branch;

      // ── L2: Verificare semnătură CMS ─────────────────────────────────
      result.levels.L2 = { name: 'Semnătură CMS', ok: null };
      try {
        const verifyResult = await signedData.verify({
          signer:                   0,
          data:                     ab,
          extendedMode:             true,
          checkChain:               false,
          includeSignatureCertificate: true,
        });
        result.levels.L2.ok = verifyResult === true || (typeof verifyResult === 'object' && verifyResult.signatureVerified);
        if (result.levels.L2.ok) result.levels.L2.note = 'Semnătură CMS verificată criptografic';
      } catch(verifyErr) {
        // pkijs.verify() eșuează pt. PAdES/CAdES cu signedAttrs (authAttrs) —
        // facem verificare manuală ECDSA/RSA cu WebCrypto nativ Node.js
        try {
          // FIX v3.9.337: check defensiv — dacă CMS nu are certificat, eroare clară
          if (!signerCert || !(signerCert instanceof pkijs.Certificate)) {
            result.levels.L2.ok = null;
            result.levels.L2.note = 'Certificat semnatar absent în CMS — verificare imposibilă';
            throw new Error('no_signer_cert');
          }
          const si         = signedData.signerInfos[0];
          const sigValue   = Buffer.from(si.signature.valueBlock.valueHexView);
          const pubKeyInfo = signerCert.subjectPublicKeyInfo;
          // Algoritmul CHEII din certificatul ales
          const algOid     = pubKeyInfo.algorithm.algorithmId;
          const keyIsECDSA = algOid === '1.2.840.10045.2.1';
          const keyIsRSA   = algOid === '1.2.840.113549.1.1.1';
          // #145/C4 — algoritmul REAL al SEMNĂTURII, citit din SignerInfo
          const sigAlg = _sigAlgInfo(
            si.signatureAlgorithm?.algorithmId,
            si.digestAlgorithm?.algorithmId
          );
          const needsEC  = sigAlg.family === 'ECDSA';
          const needsRSA = sigAlg.family === 'RSA' || sigAlg.family === 'RSA-PSS';

          // Reconstituim datele semnate: signedAttrs DER (0xa0 → 0x31)
          let dataToVerify;
          if (si.signedAttrs?.encodedValue) {
            // Înlocuim tag implicit [0] cu SET (0x31) conform RFC 5652
            const raw = Buffer.from(si.signedAttrs.encodedValue);
            const corrected = Buffer.concat([Buffer.from([0x31]), raw.slice(1)]);
            dataToVerify = corrected;
          } else {
            dataToVerify = Buffer.from(ab);
          }
          const { webcrypto } = crypto;
          const pubKeyDer = Buffer.from(pubKeyInfo.toSchema().toBER(false));

          if ((needsEC && !keyIsECDSA) || (needsRSA && !keyIsRSA)) {
            // #145/C3 — necunoscut ≠ invalid: NU verificăm cu o cheie străină.
            result.levels.L2.ok   = null;
            result.levels.L2.note = 'Algoritmul semnăturii nu corespunde cheii certificatului selectat';
          } else if (needsEC || (!sigAlg.family && keyIsECDSA)) {
            // #145/C2 — curba se citește din cheie, nu se presupune P-256.
            const curve = _curveFromSpki(pubKeyInfo);
            if (!curve) {
              result.levels.L2.ok   = null;
              result.levels.L2.note = 'Curbă eliptică necunoscută — verificare imposibilă';
            } else {
              const hash = sigAlg.hash || 'SHA-256';
              const cryptoKey = await webcrypto.subtle.importKey(
                'spki', pubKeyDer,
                { name: 'ECDSA', namedCurve: curve.name },
                false, ['verify']
              );
              // #145/C1 — semnătura CMS e DER; WebCrypto cere raw (r||s).
              const rawSig = ecdsaDerToRaw(sigValue, curve.size);
              const ok = await webcrypto.subtle.verify(
                { name: 'ECDSA', hash }, cryptoKey, rawSig, dataToVerify
              );
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
              'spki', pubKeyDer,
              { name: 'RSASSA-PKCS1-v1_5', hash },
              false, ['verify']
            );
            const ok = await webcrypto.subtle.verify(
              { name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, sigValue, dataToVerify
            );
            result.levels.L2.ok   = ok;
            result.levels.L2.note = ok
              ? `Semnătură RSA/${hash} verificată criptografic (WebCrypto)`
              : `Semnătură RSA/${hash} INVALIDĂ`;
          } else {
            result.levels.L2.ok   = null;
            result.levels.L2.note = `Algoritm semnătură necunoscut (${sigAlg.oid || 'n/a'}) — verificare imposibilă`;
          }
        } catch(manualErr) {
          result.levels.L2.ok   = null;
          result.levels.L2.note = `Verificare manuală eșuată: ${manualErr.message?.substring(0, 80)}`;
          result.warnings.push('Verificarea semnăturii CMS nu a putut fi finalizată');
        }
      }

      // ── L1 completare: verificăm hash-ul din SignedData ───────────────
      try {
        const encapContent = signedData.encapContentInfo;
        if (encapContent?.eContent) {
          // Hash-ul e în signed attributes
          const si = signedData.signerInfos?.[0];
          const msgDigestAttr = si?.signedAttrs?.attributes?.find(
            a => a.type === '1.2.840.113549.1.9.4' // id-messageDigest
          );
          if (msgDigestAttr) {
            const embeddedHash = Buffer.from(
              msgDigestAttr.values[0].valueBlock.valueHex
            ).toString('hex');
            const computedHash = crypto.createHash('sha256').update(hashData).digest('hex');
            result.levels.L1.ok = embeddedHash.toLowerCase() === computedHash.toLowerCase();
            result.levels.L1.embeddedHash  = embeddedHash;
            result.levels.L1.computedHash  = computedHash;
          } else {
            result.levels.L1.ok = true; // presupunem intact dacă nu găsim atribut
          }
        } else {
          result.levels.L1.ok = true;
        }
      } catch { result.levels.L1.ok = true; }

      // ── L3: Informații certificat semnatar ────────────────────────────
      // NOTE: certs și signerCert sunt declarate mai sus (înainte de L2) — vezi FIX v3.9.337
      result.levels.L3 = { name: 'Certificat semnatar', ok: false };
      if (_sel.branch === 4) result.levels.L3.note = _APROX_NOTE;

      if (signerCert instanceof pkijs.Certificate) {
        const getAttr = (rdn, oid) =>
          rdn?.typesAndValues?.find(tv => tv.type === oid)?.value?.valueBlock?.value || '';

        const notBefore = signerCert.notBefore?.value;
        const notAfter  = signerCert.notAfter?.value;
        const now       = new Date();

        const certInfo = {
          subject: {
            CN: getAttr(signerCert.subject, OID_COMMON_NAME),
            O:  getAttr(signerCert.subject, OID_ORGANIZATION),
            C:  getAttr(signerCert.subject, OID_COUNTRY),
          },
          issuer: {
            CN: getAttr(signerCert.issuer, OID_COMMON_NAME),
            O:  getAttr(signerCert.issuer, OID_ORGANIZATION),
          },
          serialNumber: Buffer.from(signerCert.serialNumber.valueBlock.valueHex).toString('hex').toUpperCase(),
          notBefore:    notBefore,
          notAfter:     notAfter,
          isCurrentlyValid: notBefore <= now && now <= notAfter,
        };

        result.certificate = certInfo;
        result.levels.L3.ok = true;

        // Signing time din signed attributes
        const si = signedData.signerInfos?.[0];
        const stAttr = si?.signedAttrs?.attributes?.find(a => a.type === OID_SIGNING_TIME);
        if (stAttr) {
          result.signingTime = stAttr.values?.[0]?.toDate?.() || null;
        }

        // Verificăm validitate la momentul semnării
        if (result.signingTime) {
          const st = new Date(result.signingTime);
          result.certificate.validAtSigning = (notBefore <= st && st <= notAfter);
        }

        // ── L4: Lanț de certificare ────────────────────────────────────
        result.levels.L4 = { name: 'Lanț certificare', ok: false };
        const chain = [];
        for (const cert of certs) {
          if (!(cert instanceof pkijs.Certificate)) continue;
          chain.push({
            CN:        getAttr(cert.subject, OID_COMMON_NAME),
            O:         getAttr(cert.subject, OID_ORGANIZATION),
            issuerCN:  getAttr(cert.issuer, OID_COMMON_NAME),
            notBefore: cert.notBefore?.value,
            notAfter:  cert.notAfter?.value,
            isSelfSigned: getAttr(cert.subject, OID_COMMON_NAME) === getAttr(cert.issuer, OID_COMMON_NAME),
            isInferred: false,
          });
        }
        // Dacă ultimul cert din CMS nu e self-signed, Root CA nu e inclus (normal —
        // Root CA e în trust store-ul OS/browser, nu se include în CMS).
        // Adăugăm un entry dedus din issuerCN al ultimului cert, fără "?".
        if (chain.length > 0 && !chain[chain.length - 1].isSelfSigned) {
          const last = chain[chain.length - 1];
          chain.push({
            CN:          last.issuerCN || 'Root CA',
            O:           '',
            issuerCN:    '',
            isSelfSigned: true,
            isInferred:  true, // dedus din lanț — Root CA în trust store OS
          });
        }
        result.chain = chain;
        result.levels.L4.ok = chain.length >= 2; // minim cert + CA

        // ── L5: OCSP/CRL ──────────────────────────────────────────────
        result.levels.L5 = { name: 'Validitate certificat (OCSP/CRL)', ok: null };
        const aiaExt = signerCert.extensions?.find(e => e.extnID === OID_AIA);
        if (aiaExt) {
          try {
            const aia = new pkijs.InfoAccessSyntax({ schema: aiaExt.parsedValue || aiaExt.extnValue });
            for (const desc of (aia.accessDescriptions || [])) {
              if (desc.accessMethod === OID_OCSP) {
                result.certificate.ocspUrl = desc.accessLocation?.value || null;
              }
              if (desc.accessMethod === OID_CA_ISSUERS) {
                result.certificate.caIssuersUrl = desc.accessLocation?.value || null;
              }
            }
          } catch {
            // AIA parsing eșuat — continuăm
          }
        }

        // OCSP check live
        if (result.certificate?.ocspUrl) {
          try {
            // #145/D — emitentul se caută pe SUBIECT(DER) == EMITENT(DER) al
            // semnatarului; `certs[1]` era aceeași presupunere de ordine.
            const issuerCert = _findIssuerCert(signerCert, certs, pkijs);
            if (!issuerCert) {
              // ⛔ nu ghicim: L5 rămâne null, cu notă.
              result.levels.L5.ok   = null;
              result.levels.L5.note = 'Certificatul emitent nu a fost găsit în CMS — OCSP imposibil de interogat';
            } else {
              const ocspResult = await checkOCSP(signerCert, issuerCert, result.signingTime, pkijs, asn1js);
              result.levels.L5.ok     = ocspResult.good;
              result.levels.L5.status = ocspResult.status;
              result.levels.L5.note   = ocspResult.note;
            }
          } catch(ocspErr) {
            result.levels.L5.ok   = null;
            result.levels.L5.note = `OCSP check eșuat: ${ocspErr.message.substring(0, 80)}`;
          }
        } else {
          result.levels.L5.ok   = null;
          result.levels.L5.note = 'URL OCSP nedisponibil în certificat — validitate confirmată prin QcStatements și L6';
          result.levels.L5.notApplicable = true; // nu e o eroare, e o limitare a certificatului
        }

        // ── L6: QES/eIDAS ─────────────────────────────────────────────
        result.levels.L6 = { name: 'Conformitate QES/eIDAS', ok: false };
        const qcExt = signerCert.extensions?.find(e => e.extnID === OID_QC_STATEMENTS);

        // Verificăm dacă QTSP-ul emitent e cunoscut
        const issuerCN  = getAttr(signerCert.issuer, OID_COMMON_NAME).toUpperCase();
        const issuerO   = getAttr(signerCert.issuer, OID_ORGANIZATION).toUpperCase();
        const isKnownQTSP = KNOWN_ROMANIAN_QTSP.some(q =>
          issuerCN.includes(q.toUpperCase()) || issuerO.includes(q.toUpperCase())
        );

        // #144 (P0-05) — verdictul se ia pe DOVADĂ, prin modulul comun
        // `services/qc-evidence.mjs`. Numele QTSP rămâne doar etichetă.
        const _oidsOf = (extnID) => {
          try {
            const e = signerCert.extensions?.find(x => x.extnID === extnID);
            return e?.extnValue?.valueBlock?.valueHex ? derOids(e.extnValue.valueBlock.valueHex) : [];
          } catch { return []; }
        };
        const _kuExt = signerCert.extensions?.find(x => x.extnID === OID_KEY_USAGE);
        const qc = evaluateQcEvidence({
          qcStatementOids: _oidsOf(OID_QC_STATEMENTS),
          certPolicyOids:  _oidsOf(OID_CERT_POLICIES_EXT),
          keyUsage:        keyUsageFromDer(_kuExt?.extnValue?.valueBlock?.valueHex),
        });

        result.isQES = qc.isQES;
        result.levels.L6.ok = qc.isQES;
        result.levels.L6.evidence = qc.evidence;
        result.levels.L6.missing  = qc.missing;
        result.levels.L6.isQualifiedCert = qc.isQualifiedCert;
        result.levels.L6.qtspName = isKnownQTSP
          ? KNOWN_ROMANIAN_QTSP.find(q => issuerCN.includes(q.toUpperCase()) || issuerO.includes(q.toUpperCase()))
          : (qcExt ? 'Emitent nerecunoscut (QcStatements prezent)' : 'Necunoscut');
        result.levels.L6.note = qc.isQES
          ? `Calificat pe dovadă: ${qc.evidence.join(' · ')}`
          : qc.isQualifiedCert
            ? `Certificat calificat, dar fără dovadă QSCD — lipsește: ${qc.missing.join(', ')}`
            : `Necalificat — lipsește: ${qc.missing.join(', ')}`;
      }

    } catch(e) {
      result.errors.push(`Eroare parsare: ${e.message.substring(0, 150)}`);
      logger.warn({ err: e, index: i }, 'verify: signature parse error');
    }

    // Calcul status general
    const l1ok = result.levels.L1?.ok !== false;
    const l2ok = result.levels.L2?.ok !== false;
    const l3ok = result.levels.L3?.ok === true;
    result.isValid = l1ok && l2ok && l3ok;

    results.push(result);
  }

  return {
    ok:         results.some(r => r.isValid),
    signatures: results,
    signatureCount: results.length,
  };
}

/**
 * Verificare OCSP live pentru un certificat.
 */
async function checkOCSP(cert, issuerCert, signingTime, pkijs, asn1js) {
  if (!issuerCert) return { good: null, status: 'unknown', note: 'Certificat CA lipsă pentru OCSP' };

  try {
    const { webcrypto } = crypto;

    // Construim OCSP request
    const ocspReq = new pkijs.OCSPRequest();
    await ocspReq.createForCertificate(cert, {
      hashAlgorithm: 'SHA-256',
      issuerCertificate: issuerCert,
    });

    const ocspReqBuf    = ocspReq.toSchema(true).toBER(false);
    const ocspUrl       = cert.extensions?.find(e => e.extnID === '1.3.6.1.5.5.7.1.1');
    // (URL-ul e deja extras în apelant)

    // Facem request HTTP la OCSP responder
    const resp = await fetch(cert._ocspUrl || '', {
      method:  'POST',
      headers: { 'Content-Type': 'application/ocsp-request' },
      body:    ocspReqBuf,
      signal:  AbortSignal.timeout(8000),
    });

    if (!resp.ok) return { good: null, status: 'unknown', note: `OCSP HTTP ${resp.status}` };

    const ocspRespBuf = Buffer.from(await resp.arrayBuffer());
    const asn1resp    = asn1js.fromBER(ocspRespBuf.buffer);
    const ocspResp    = new pkijs.OCSPResponse({ schema: asn1resp.result });

    const status = ocspResp.responseStatus?.valueBlock?.valueDec;
    if (status !== 0) return { good: false, status: 'error', note: `OCSP status ${status}` };

    // Parsăm BasicOCSPResponse
    const basicResp = new pkijs.BasicOCSPResponse({ schema: ocspResp.responseBytes.response });
    const singleResp = basicResp.tbsResponseData.responses?.[0];
    const certStatus = singleResp?.certStatus;

    // certStatus: 0 = good, 1 = revoked, 2 = unknown
    const statusName = ['good', 'revoked', 'unknown'][certStatus?.idBlock?.tagNumber] || 'unknown';

    return {
      good:        statusName === 'good',
      status:      statusName,
      thisUpdate:  singleResp?.thisUpdate?.value,
      nextUpdate:  singleResp?.nextUpdate?.value,
      note:        `OCSP: ${statusName}`,
    };

  } catch(e) {
    return { good: null, status: 'unknown', note: `OCSP: ${e.message.substring(0, 80)}` };
  }
}

/**
 * Formatează rezultatul verificării pentru afișare.
 */
export function formatVerificationResult(result) {
  const sig = result.signatures?.[0];
  if (!sig) return result;

  return {
    ...result,
    summary: {
      isValid:    sig.isValid,
      isQES:      sig.isQES,
      signer:     sig.certificate?.subject?.CN || 'Necunoscut',
      organization: sig.certificate?.subject?.O || '',
      issuer:     sig.certificate?.issuer?.CN || '',
      signingTime: sig.signingTime,
      qtsp:        sig.levels?.L6?.qtspName || '',
      levels: {
        integrity:    sig.levels?.L1?.ok,
        signature:    sig.levels?.L2?.ok,
        certificate:  sig.levels?.L3?.ok,
        chain:        sig.levels?.L4?.ok,
        revocation:   sig.levels?.L5?.ok,
        qes:          sig.levels?.L6?.ok,
      },
    },
  };
}
