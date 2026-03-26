/**
 * DocFlowAI — PAdES cu @signpdf/signpdf (incremental update corect)
 *
 * Arhitectura:
 *   CREARE FLUX (stampFooterOnPdf):
 *     - Generează cartuș vizual server-side cu câmpuri AcroForm /Sig per semnatar
 *     - signers[i].padesFieldName salvat în DB
 *
 *   SEMNARE STS:
 *     1. preparePadesDoc(pdfBuf, signer, signerIdx) → pdfBytes cu placeholder
 *        - Adaugă placeholder ByteRange în câmpul AcroForm al semnătarului
 *        - Returnează Buffer gata de hashing
 *     2. calcPadesHash(pdfBytes) → SHA-256 base64 → trimis la STS
 *     3. injectCms(pdfBytes, cmsBase64) → PDF semnat final
 *        - CMS de la STS injectat în placeholder prin @signpdf/signpdf
 *        - Incremental update → semnăturile anterioare rămân valide
 *
 *   Semnatar 2: baza = signedPdfB64 (PDF cu semnătura semnatarului 1) → incremental append
 */

import crypto from 'node:crypto';
import dns from 'dns';
import { createRequire } from 'module';
import { logger } from '../middleware/logger.mjs';

dns.setDefaultResultOrder('ipv4first');

const _require = createRequire(import.meta.url);
const { SignPdf }              = _require('@signpdf/signpdf');
const { pdflibAddPlaceholder } = _require('@signpdf/placeholder-pdf-lib');
const { Signer, DEFAULT_BYTE_RANGE_PLACEHOLDER, SUBFILTER_ADOBE_PKCS7_DETACHED } = _require('@signpdf/utils');

// Placeholder mai mare pentru STS QES (tipic 4-12KB DER)
const STS_SIGNATURE_LENGTH = 32768;

function ro(t) {
  const m = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
  return String(t||'').split('').map(ch => m[ch]||ch).join('');
}

// ── STSSigner — wrapper Signer care injectează CMS extern de la STS ──────────
class STSSigner extends Signer {
  constructor(cmsBuffer) {
    super();
    this._cmsBuffer = cmsBuffer; // Buffer cu CMS DER de la STS
  }
  async sign(_pdfBuffer, _signingTime) {
    return this._cmsBuffer; // SignPdf va injecta asta în placeholder
  }
}

// ── preparePadesDoc ───────────────────────────────────────────────────────────
/**
 * Adaugă placeholder ByteRange în câmpul AcroForm al semnătarului curent.
 * Returnează pdfBytes cu placeholder — gata de hash și semnare.
 *
 * @param {Buffer} pdfBuf  PDF din DB (cu câmpuri AcroForm create la flux)
 * @param {object} signer  signers[signerIdx] — trebuie să aibă padesFieldName
 * @param {number} signerIdx
 * @returns {Promise<Buffer>} pdfBytes cu placeholder
 */
export async function preparePadesDoc(pdfBuf, signer, signerIdx) {
  const { PDFDocument, PDFName, PDFNumber } = await import('pdf-lib');

  const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const pages  = pdfDoc.getPages();

  // Găsim pagina și Rect-ul câmpului AcroForm SIG_ROL_N (creat de stampFooterOnPdf)
  // Câmpul are Rect = zona JOS a celulei — exact unde vrem semnătura vizuală
  const fieldName = signer.padesFieldName;
  let targetPage  = pages[pages.length - 1];
  let widgetRect  = [0, 0, 0, 0]; // invizibil fallback

  if (fieldName) {
    const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    if (acroFormRef) {
      const acroForm = pdfDoc.context.lookup(acroFormRef);
      const fRef = acroForm.get(PDFName.of('Fields'));
      if (fRef) {
        const fArr = pdfDoc.context.lookup(fRef);
        for (let i = 0; i < (fArr.size ? fArr.size() : 0); i++) {
          try {
            const f    = pdfDoc.context.lookup(fArr.get(i));
            const tObj = f?.get(PDFName.of('T'));
            const tStr = tObj?.decodeText ? tObj.decodeText() : tObj?.asString?.();
            if (tStr === fieldName) {
              // Citim Rect-ul câmpului — zona JOS a celulei din cartuș
              const rObj = f.get(PDFName.of('Rect'));
              if (rObj) {
                const ra = pdfDoc.context.lookup(rObj);
                if (ra?.size && ra.size() >= 4) {
                  widgetRect = [
                    ra.get(0).value(), ra.get(1).value(),
                    ra.get(2).value(), ra.get(3).value(),
                  ];
                }
              }
              // Găsim pagina câmpului
              const pRef = f.get(PDFName.of('P'));
              if (pRef) {
                const pi = pages.findIndex(p =>
                  p.ref?.objectNumber === (pRef.objectNumber ?? pRef?.value?.objectNumber));
                if (pi >= 0) targetPage = pages[pi];
              }
              // Ștergem câmpul vechi — pdflibAddPlaceholder va crea unul nou cu același Rect
              try {
                const fa = pdfDoc.context.lookup(fRef);
                const newFields = [];
                for (let j = 0; j < fa.size(); j++) {
                  const ref = fa.get(j);
                  const ff = pdfDoc.context.lookup(ref);
                  const ft = ff?.get(PDFName.of('T'));
                  const fs = ft?.decodeText ? ft.decodeText() : ft?.asString?.();
                  if (fs !== fieldName) newFields.push(ref);
                }
                acroForm.set(PDFName.of('Fields'),
                  pdfDoc.context.obj(newFields));
              } catch(e2) {}
              break;
            }
          } catch(e2) {}
        }
      }
    }
  }

  // pdflibAddPlaceholder — generează ByteRange/Contents în formatul exact
  // cerut de @signpdf/signpdf. widgetRect = zona JOS a celulei din cartuș.
  pdflibAddPlaceholder({
    pdfDoc,
    pdfPage:         targetPage,
    reason:          'Semnatura electronica calificata QES - DocFlowAI',
    contactInfo:     signer.email || '',
    name:            ro(signer.name || ''),
    location:        'Romania',
    signatureLength: STS_SIGNATURE_LENGTH,
    subFilter:       SUBFILTER_ADOBE_PKCS7_DETACHED,
    widgetRect,    // [0,0,0,0] = invizibil, sau rect celulă = vizibil
  });

  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  logger.info({ signerIdx, fieldName, widgetRect, pdfSize: savedBytes.length },
    'PAdES: placeholder adăugat via pdflibAddPlaceholder');
  return savedBytes;
}


function _addInvisibleField(pdfDoc, page, sigDict, PDFName, PDFNumber, PDFString, signerIdx) {
  let acroForm;
  const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
  if (acroFormRef) {
    acroForm = pdfDoc.context.lookup(acroFormRef);
    try { acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } catch(e) {}
  } else {
    const afObj = pdfDoc.context.obj({ Fields: pdfDoc.context.obj([]), SigFlags: PDFNumber.of(3), DA: PDFString.of('/Helv 0 Tf 0 g') });
    pdfDoc.catalog.set(PDFName.of('AcroForm'), pdfDoc.context.register(afObj));
    acroForm = afObj;
  }
  const widgetRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), FT: PDFName.of('Sig'),
    T: PDFString.of(`SIG_QES_FB_${signerIdx+1}`),
    Rect: pdfDoc.context.obj([0,0,0,0].map(n => PDFNumber.of(n))),
    V: sigDict, F: PDFNumber.of(132), P: page.ref,
  }));
  const ea = page.node.get(PDFName.of('Annots'));
  if (ea) { try { pdfDoc.context.lookup(ea).push(widgetRef); } catch(e2) { page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef])); } }
  else page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef]));
  try {
    const fref = acroForm.get(PDFName.of('Fields'));
    if (fref) pdfDoc.context.lookup(fref).push(widgetRef);
    else acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([widgetRef]));
  } catch(e2) {}
}

// ── calcPadesHash ────────────────────────────────────────────────────────────
/**
 * Reproduce EXACT logica din SignPdf.sign() pentru hash corect.
 *
 * SignPdf.sign() înainte de signer.sign(bytes):
 *   1. Rescrie /ByteRange placeholder cu valorile reale
 *   2. Extrage bytes fără /Contents
 *   3. Apelează signer.sign(bytesExtrase)
 *
 * STSSigner ignoră bytesExtrase și returnează CMS-ul de la STS.
 * Deci STS trebuie să semneze SHA-256(bytesExtrase cu ByteRange real).
 * calcPadesHash reproduce exact pașii 1+2 pentru hash-ul corect.
 */
export function calcPadesHash(pdfBytes) {
  const { removeTrailingNewLine, convertBuffer, findByteRange } = _require('@signpdf/utils');
  let pdf = removeTrailingNewLine(convertBuffer(pdfBytes, 'PDF'));

  const { byteRangePlaceholder, byteRangePlaceholderPosition } = findByteRange(pdf);
  if (!byteRangePlaceholder) {
    logger.warn('PAdES: ByteRange placeholder negăsit — hash simplu');
    return crypto.createHash('sha256').update(pdfBytes).digest('base64');
  }

  // Calculăm poziția /Contents
  const byteRangeEnd            = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const contentsTagPos          = pdf.indexOf('/Contents ', byteRangeEnd);
  const placeholderPos          = pdf.indexOf('<', contentsTagPos);
  const placeholderEnd          = pdf.indexOf('>', placeholderPos);
  const placeholderLenWithBrack = placeholderEnd + 1 - placeholderPos;

  const byteRange = [0, 0, 0, 0];
  byteRange[1] = placeholderPos;
  byteRange[2] = byteRange[1] + placeholderLenWithBrack;
  byteRange[3] = pdf.length - byteRange[2];

  // ── Pasul 1: rescrie /ByteRange cu valorile reale (exact SignPdf.sign) ──
  let actualByteRange = `/ByteRange [${byteRange.join(' ')}]`;
  actualByteRange += ' '.repeat(byteRangePlaceholder.length - actualByteRange.length);
  pdf = Buffer.concat([
    pdf.slice(0, byteRangePlaceholderPosition),
    Buffer.from(actualByteRange),
    pdf.slice(byteRangeEnd),
  ]);

  // ── Pasul 2: extrage bytes fără /Contents (exact SignPdf.sign) ──────────
  const pdfWithoutContents = Buffer.concat([
    pdf.slice(0, byteRange[1]),
    pdf.slice(byteRange[2], byteRange[2] + byteRange[3]),
  ]);

  return crypto.createHash('sha256').update(pdfWithoutContents).digest('base64');
}

// ── buildCmsFromRawSignature ─────────────────────────────────────────────────
/**
 * Construiește un CMS/PKCS#7 SignedData complet din:
 *   - signByte: raw signature bytes de la STS (Base64)
 *   - certPem:  certificatul semnatarului (PEM, din /userinfo STS)
 *   - hashBase64: hash-ul documentului (SHA-256, Base64)
 *
 * STS returnează DOAR signature bytes (nu CMS complet).
 * Adobe verifică /Contents ca CMS DER — trebuie să construim structura.
 */
async function buildCmsFromRawSignature(signByteBase64, certPem, hashBase64) {
  const forge = _require('node-forge');

  // Decodăm certificatul PEM
  const cert = forge.pki.certificateFromPem(certPem);
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');

  const signatureBytes = Buffer.from(signByteBase64, 'base64');
  const hashBytes      = Buffer.from(hashBase64, 'base64');

  // Construim CMS SignedData conform RFC 5652
  // Structura: SEQUENCE { version, digestAlgorithms, encapContentInfo,
  //             certificates, signerInfos }
  const { Asn1, Constructed, Primitive } = (() => {
    // Helper ASN.1 DER encoding
    function encLen(len) {
      if (len < 128) return Buffer.from([len]);
      const hex = len.toString(16).padStart(len > 0xffff ? 6 : 4, '0');
      const b = Buffer.from(hex, 'hex');
      return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
    }
    function seq(content) {
      return Buffer.concat([Buffer.from([0x30]), encLen(content.length), content]);
    }
    function set(content) {
      return Buffer.concat([Buffer.from([0x31]), encLen(content.length), content]);
    }
    function ctx(tag, content, constructed = true) {
      const b = constructed ? (0xa0 | tag) : (0x80 | tag);
      return Buffer.concat([Buffer.from([b]), encLen(content.length), content]);
    }
    function int(val) {
      return Buffer.from([0x02, 0x01, val]);
    }
    function oid(hex) {
      const b = Buffer.from(hex, 'hex');
      return Buffer.concat([Buffer.from([0x06, b.length]), b]);
    }
    function octstr(data) {
      return Buffer.concat([Buffer.from([0x04]), encLen(data.length), data]);
    }
    function bitstr(data) {
      // bit string cu 0 unused bits
      const content = Buffer.concat([Buffer.from([0x00]), data]);
      return Buffer.concat([Buffer.from([0x03]), encLen(content.length), content]);
    }
    function raw(data) { return data; }
    return { seq, set, ctx, int, oid, octstr, bitstr, raw, encLen };
  })();

  // OID-uri
  const OID_PKCS7_SIGNED_DATA   = '2a864886f70d010702'; // 1.2.840.113549.1.7.2
  const OID_PKCS7_DATA           = '2a864886f70d010701'; // 1.2.840.113549.1.7.1
  const OID_SHA256               = '608648016503040201'; // 2.16.840.1.101.3.4.2.1
  const OID_RSA                  = '2a864886f70d010101'; // 1.2.840.113549.1.1.1
  const OID_ECDSA_SHA256         = '2a8648ce3d040302'; // 1.2.840.10045.4.3.2 ecdsa-with-SHA256
  const OID_EC_PUBLIC_KEY        = '2a8648ce3d0201';   // 1.2.840.10045.2.1
  const OID_CONTENT_TYPE         = '2a864886f70d010903'; // 1.2.840.113549.1.9.3
  const OID_MESSAGE_DIGEST       = '2a864886f70d010904'; // 1.2.840.113549.1.9.4
  const OID_SIGNING_TIME         = '2a864886f70d010905'; // 1.2.840.113549.1.9.5

  // Detectăm algoritmul din semnătură:
  // ECDSA DER începe cu 0x30 (SEQUENCE) urmat de length + 0x02 (INTEGER) = r
  // RSA raw bytes nu au această structură DER internă
  // STS returnează ECDSA P-256: 30440220...0220... (68-72 bytes tipic)
  const isECDSA = signatureBytes[0] === 0x30 && signatureBytes[2] === 0x02;
  const sigAlgOid = isECDSA ? OID_ECDSA_SHA256 : OID_RSA;
  logger.info({ sigLen: signatureBytes.length, isECDSA,
    first4Hex: signatureBytes.slice(0,4).toString('hex').toUpperCase(),
  }, 'CMS: algoritm detectat automat');

  function encLen(len) {
    if (len < 128) return Buffer.from([len]);
    const hex = len.toString(16).padStart(len > 0xffff ? 6 : 4, '0');
    const b = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
  }
  function seq(c)  { return Buffer.concat([Buffer.from([0x30]), encLen(c.length), c]); }
  function set(c)  { return Buffer.concat([Buffer.from([0x31]), encLen(c.length), c]); }
  function ctx(t, c, cs=true) { return Buffer.concat([Buffer.from([cs?(0xa0|t):(0x80|t)]), encLen(c.length), c]); }
  function oid(h)  { const b=Buffer.from(h,'hex'); return Buffer.concat([Buffer.from([0x06,b.length]),b]); }
  function int1(v) { return Buffer.from([0x02,0x01,v]); }
  function octstr(d){ return Buffer.concat([Buffer.from([0x04]),encLen(d.length),d]); }
  function bitstr(d){ const c=Buffer.concat([Buffer.from([0x00]),d]); return Buffer.concat([Buffer.from([0x03]),encLen(c.length),c]); }
  function utctime(d){ const s=d.toISOString().replace(/[-:T]/g,'').slice(0,12)+'Z'; return Buffer.concat([Buffer.from([0x17,s.length]),Buffer.from(s)]); }

  // IssuerAndSerialNumber din certificat
  const issuerDer   = Buffer.from(forge.asn1.toDer(cert.issuer.toAsn1()).getBytes(), 'binary');
  const serialBytes = Buffer.from(cert.serialNumber, 'hex');
  // Asigurăm că serial e positive (primul bit 0)
  const serialDer = serialBytes[0] & 0x80
    ? Buffer.concat([Buffer.from([0x02]), encLen(serialBytes.length+1), Buffer.from([0x00]), serialBytes])
    : Buffer.concat([Buffer.from([0x02]), encLen(serialBytes.length), serialBytes]);
  const issuerAndSerial = seq(Buffer.concat([issuerDer, serialDer]));

  // SigningTime
  const signingTime = utctime(new Date());

  // Authenticated attributes (setate explicit — intră în verificarea semnăturii)
  const authAttrs = ctx(0, Buffer.concat([
    // contentType = pkcs7-data
    seq(Buffer.concat([oid(OID_CONTENT_TYPE), set(seq(oid(OID_PKCS7_DATA)))])),
    // signingTime
    seq(Buffer.concat([oid(OID_SIGNING_TIME), set(signingTime)])),
    // messageDigest = SHA-256(document hash)
    seq(Buffer.concat([oid(OID_MESSAGE_DIGEST), set(octstr(hashBytes))])),
  ]));

  // SignerInfo
  const signerInfo = seq(Buffer.concat([
    int1(1),                                              // version
    issuerAndSerial,                                      // sid
    seq(Buffer.concat([oid(OID_SHA256)])),                // digestAlgorithm
    authAttrs,                                            // authenticatedAttributes
    seq(Buffer.concat([oid(sigAlgOid), ...(isECDSA ? [] : [Buffer.from([0x05,0x00])])])), // signatureAlgorithm (RSA cu NULL params, ECDSA fara)
    octstr(signatureBytes),                               // signature (raw bytes de la STS)
  ]));

  // EncapsulatedContentInfo (detached — nu includem documentul)
  const encapCI = seq(oid(OID_PKCS7_DATA));

  // DigestAlgorithmIdentifiers
  const digestAlgs = set(seq(Buffer.concat([oid(OID_SHA256)])));

  // SignedData content
  const signedDataContent = seq(Buffer.concat([
    int1(1),           // version
    digestAlgs,
    encapCI,
    ctx(0, certDer),   // certificates [0] IMPLICIT CertificateSet
    set(signerInfo),   // signerInfos
  ]));

  // ContentInfo (wrapper final)
  const cms = seq(Buffer.concat([
    oid(OID_PKCS7_SIGNED_DATA),
    ctx(0, signedDataContent),
  ]));

  logger.info({ cmsLen: cms.length, sigLen: signatureBytes.length, certLen: certDer.length }, 'CMS: construit din raw signature + certificat STS');
  return cms;
}

// ── injectCms ────────────────────────────────────────────────────────────────
/**
 * Construiește CMS complet din raw signByte (de la STS) + certificat PEM
 * și injectează în placeholder PDF via @signpdf/signpdf.
 *
 * @param {Buffer} pdfBytes      PDF cu placeholder ByteRange
 * @param {string} signByteB64   Raw signature bytes de la STS (Base64)
 * @param {string} certPem       Certificatul semnatarului (PEM, din /userinfo)
 * @param {string} hashBase64    Hash-ul documentului (SHA-256, Base64)
 * @returns {Promise<Buffer>}    PDF semnat final
 */
export async function injectCms(pdfBytes, signByteB64, certPem, hashBase64) {
  if (!certPem) {
    throw new Error('PAdES: certificatul semnatarului lipsă — nu se poate construi CMS');
  }

  const cmsBuffer = await buildCmsFromRawSignature(signByteB64, certPem, hashBase64);

  if (cmsBuffer.length > STS_SIGNATURE_LENGTH) {
    throw new Error(`PAdES: CMS prea mare (${cmsBuffer.length} > ${STS_SIGNATURE_LENGTH} bytes)`);
  }

  const signer    = new STSSigner(cmsBuffer);
  const signPdf   = new SignPdf();
  const signedPdf = await signPdf.sign(pdfBytes, signer);
  logger.info({ cmsLen: cmsBuffer.length, pdfSize: signedPdf.length }, 'PAdES: CMS injectat cu succes');
  return signedPdf;
}
