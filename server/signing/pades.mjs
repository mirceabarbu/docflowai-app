/**
 * DocFlowAI — PAdES cu @signpdf/signpdf
 *
 * ARHITECTURA:
 *   stampFooterOnPdf  → footer only (neatins)
 *   buildCartusBlob   → client-side upload local (neatins)
 *
 *   La semnare STS (initiate-cloud-signing):
 *   preparePadesDoc(pdfBuf, flowData, signerIdx):
 *     TABEL: detectează spațiu pe ultima pagină → cartuș pe aceeași pagină dacă încape,
 *            altfel pagină nouă. Câmp /Sig în zona JOS a celulei semnătarului.
 *     ANCORE: câmp /Sig pe ancora semnătarului (ancoreFieldName) sau invizibil.
 *   calcPadesHash → SHA256(bytesOutsideContents) → trimis la STS
 *   injectCms(pdfBytes, signByte, certPem) → CMS fără signedAttrs → valid Adobe
 */

import crypto from 'node:crypto';
import dns    from 'dns';
import { createRequire } from 'module';
import { logger } from '../middleware/logger.mjs';

dns.setDefaultResultOrder('ipv4first');

const _require = createRequire(import.meta.url);
const { SignPdf }              = _require('@signpdf/signpdf');
const { pdflibAddPlaceholder } = _require('@signpdf/placeholder-pdf-lib');
const { Signer, DEFAULT_BYTE_RANGE_PLACEHOLDER, SUBFILTER_ADOBE_PKCS7_DETACHED } = _require('@signpdf/utils');

const STS_SIGNATURE_LENGTH = 32768;

function ro(t) {
  const m = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
  return String(t||'').split('').map(ch => m[ch]||ch).join('');
}

class STSSigner extends Signer {
  constructor(b) { super(); this._b = b; }
  async sign() { return this._b; }
}

// ── preparePadesDoc ─────────────────────────────────────────────────────────
export async function preparePadesDoc(pdfBuf, flowData, signerIdx) {
  const { PDFDocument, PDFName, PDFNumber, PDFString, rgb, StandardFonts } =
    await import('pdf-lib');

  const signers  = Array.isArray(flowData.signers) ? flowData.signers : [];
  const signer   = signers[signerIdx];
  if (!signer) throw new Error(`PAdES: semnătarul ${signerIdx} lipsește`);
  const isAncore = (flowData.flowType || 'tabel').toLowerCase() === 'ancore';

  const pdfDoc   = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const pages    = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const { width: pW, height: pH } = lastPage.getSize();

  // ════════════════════════════════════════════════════════════════════════
  // FLUX ANCORE: semnătura pe ancora semnătarului (ancoreFieldName)
  // ════════════════════════════════════════════════════════════════════════
  if (isAncore) {
    const ancoreField = signer.ancoreFieldName || null;
    let targetPage = lastPage;
    let widgetRect = [0, 0, 0, 0]; // invizibil fallback

    if (ancoreField) {
      // Găsim pagina și Rect-ul câmpului AcroForm existent
      const afRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
      if (afRef) {
        const acroForm = pdfDoc.context.lookup(afRef);
        const fRef = acroForm.get(PDFName.of('Fields'));
        if (fRef) {
          const fArr = pdfDoc.context.lookup(fRef);
          outer: for (let i = 0; i < (fArr.size ? fArr.size() : 0); i++) {
            try {
              const f = pdfDoc.context.lookup(fArr.get(i));
              const t = f?.get(PDFName.of('T'));
              const s = t?.decodeText ? t.decodeText() : t?.asString?.();
              if (s === ancoreField) {
                const rObj = f.get(PDFName.of('Rect'));
                if (rObj) {
                  const ra = pdfDoc.context.lookup(rObj);
                  if (ra?.size && ra.size() >= 4)
                    widgetRect = [ra.get(0).value(), ra.get(1).value(),
                                  ra.get(2).value(), ra.get(3).value()];
                }
                const pRef = f.get(PDFName.of('P'));
                if (pRef) {
                  const pi = pages.findIndex(p =>
                    p.ref?.objectNumber === (pRef.objectNumber ?? pRef?.value?.objectNumber));
                  if (pi >= 0) targetPage = pages[pi];
                }
                break outer;
              }
            } catch(e2) {}
          }
        }
      }
      logger.info({ signerIdx, ancoreField, widgetRect }, 'PAdES ancore: câmp găsit');
    }

    pdflibAddPlaceholder({
      pdfDoc, pdfPage: targetPage,
      reason: 'Semnatura electronica calificata QES - DocFlowAI',
      contactInfo: signer.email || '', name: ro(signer.name || ''),
      location: 'Romania',
      signatureLength: STS_SIGNATURE_LENGTH,
      subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
      widgetRect,
    });

    const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
    logger.info({ signerIdx, ancoreField, pdfSize: savedBytes.length }, 'PAdES ancore: gata');
    return savedBytes;
  }

  // ════════════════════════════════════════════════════════════════════════
  // FLUX TABEL: cartuș ca la buildCartusBlob — pe aceeași pagină dacă încape
  // ════════════════════════════════════════════════════════════════════════
  const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const MARGIN = 40;
  const n     = signers.length;
  const cols  = Math.min(n, 3);
  const rows  = Math.ceil(n / cols);
  const cellW = (pW - MARGIN * 2) / cols;
  const cellH = 64;
  const infoH = cellH * 0.58;
  const sigH  = cellH * 0.42;
  const titleH    = 20;
  const cartusH   = rows * cellH + titleH;
  const footerH   = 28;  // spațiu footer jos
  const cartusBottom = footerH + 8;
  const cartusTotal  = cartusH + cartusBottom + 10;  // înălțime totală cartuș

  // Detectăm spațiu disponibil pe ultima pagină (ca buildCartusBlob)
  // Estimăm conținutul textual al ultimei pagini: PDF.js nu e disponibil server-side
  // dar putem verifica dacă pagina are suficient spațiu în zona de jos
  const isFirstSigner = signers.slice(0, signerIdx).every(s => s.status !== 'signed');
  let cartusPage;

  if (!isFirstSigner) {
    // Semnatar 2+: cartușul există deja pe ultima pagină
    cartusPage = lastPage;
  } else {
    // Semnatar 1: detectăm spațiu disponibil
    // Verificăm dacă ultima pagină are suficient spațiu în zona de jos
    // Pragul: dacă pagina e mai înaltă de 400pt și cartușul încape în ultimii 25%
    const freeSpace = pH * 0.25; // ~25% din pagina de jos ca estimare conservatoare
    const hasSpace  = freeSpace >= cartusTotal;

    if (hasSpace) {
      cartusPage = lastPage;
      logger.info({ signerIdx, pdfSize: pdfBuf.length, freeSpace, cartusTotal },
        'PAdES tabel: cartuș pe ultima pagină existentă');
    } else {
      cartusPage = pdfDoc.addPage([pW, pH]);
      logger.info({ signerIdx }, 'PAdES tabel: pagină nouă pentru cartuș');
    }

    const footerY = footerH - 14;
    const flowId  = flowData.flowId || '';
    const rTxt    = ro(flowId) + '  |  DocFlowAI';
    const rW      = fontR.widthOfTextAtSize(rTxt, 7);
    cartusPage.drawLine({ start: { x: MARGIN, y: footerY + 10 },
      end: { x: pW - MARGIN, y: footerY + 10 }, thickness: 0.4, color: rgb(.75,.75,.75) });
    cartusPage.drawText(rTxt, { x: pW-MARGIN-rW, y: footerY, size: 7, font: fontR,
      color: rgb(.5,.5,.5), opacity: .8 });

    // Bara titlu
    cartusPage.drawRectangle({ x: MARGIN, y: cartusBottom + cartusH - titleH,
      width: pW - MARGIN * 2, height: titleH,
      color: rgb(1,1,1), borderColor: rgb(0,0,0), borderWidth: 0.8 });
    cartusPage.drawText('SEMNAT SI APROBAT', {
      x: MARGIN + 8, y: cartusBottom + cartusH - titleH + 6,
      size: 7, font: fontB, color: rgb(0,0,0) });

    // Celule pentru toți semnatarii
    signers.forEach((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx  = MARGIN + col * cellW;
      const cy  = cartusBottom + (rows - 1 - row) * cellH;
      const infoY = cy + sigH;

      cartusPage.drawRectangle({ x: cx, y: cy, width: cellW, height: cellH,
        color: rgb(.97,.97,.97), borderColor: rgb(.2,.2,.2), borderWidth: 1 });
      cartusPage.drawLine({ start: { x: cx, y: infoY }, end: { x: cx+cellW, y: infoY },
        thickness: 0.5, color: rgb(.3,.3,.3) });
      cartusPage.drawText(ro(s.rol)||'—', {
        x: cx+5, y: infoY+infoH-12, size: 7, font: fontB,
        color: rgb(.1,.1,.1), maxWidth: cellW-10 });
      const nf = [ro(s.name), ro(s.functie)].filter(Boolean).join(' - ');
      if (nf) cartusPage.drawText(nf, {
        x: cx+5, y: infoY+infoH-23, size: 6.5, font: fontR,
        color: rgb(.15,.15,.15), maxWidth: cellW-10 });
      cartusPage.drawText('Semnatura electronica calificata', {
        x: cx+5, y: cy+sigH-10, size: 5.5, font: fontR,
        color: rgb(.55,.55,.65), maxWidth: cellW-10 });
      cartusPage.drawText('L.S.', { x: cx+5, y: cy+4, size: 7, font: fontB,
        color: rgb(.5,.5,.6) });
    });
  }

  // Rect zona JOS a celulei semnătarului curent
  const col = signerIdx % cols;
  const row = Math.floor(signerIdx / cols);
  const cx  = MARGIN + col * cellW;
  const cy  = cartusBottom + (rows - 1 - row) * cellH;
  const widgetRect = [cx+1, cy+1, cx+cellW-1, cy+sigH-1];

  pdflibAddPlaceholder({
    pdfDoc, pdfPage: cartusPage,
    reason: 'Semnatura electronica calificata QES - DocFlowAI',
    contactInfo: signer.email || '', name: ro(signer.name || ''),
    location: 'Romania',
    signatureLength: STS_SIGNATURE_LENGTH,
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
    widgetRect,
  });

  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  logger.info({ signerIdx, widgetRect, pdfSize: savedBytes.length, isFirstSigner },
    'PAdES tabel: gata');
  return savedBytes;
}

// ── calcPadesHash ───────────────────────────────────────────────────────────
export function calcPadesHash(pdfBytes) {
  const { removeTrailingNewLine, convertBuffer, findByteRange } = _require('@signpdf/utils');
  let pdf = removeTrailingNewLine(convertBuffer(pdfBytes, 'PDF'));
  const { byteRangePlaceholder, byteRangePlaceholderPosition } = findByteRange(pdf);
  if (!byteRangePlaceholder) {
    logger.warn('PAdES: ByteRange placeholder negăsit — hash simplu');
    return crypto.createHash('sha256').update(pdfBytes).digest('base64');
  }
  const brEnd   = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const ctPos   = pdf.indexOf('/Contents ', brEnd);
  const phPos   = pdf.indexOf('<', ctPos);
  const phEnd   = pdf.indexOf('>', phPos);
  const phLen   = phEnd + 1 - phPos;
  const byteRange = [0, phPos, phPos + phLen, pdf.length - phPos - phLen];
  let abr = `/ByteRange [${byteRange.join(' ')}]`;
  abr += ' '.repeat(byteRangePlaceholder.length - abr.length);
  pdf = Buffer.concat([
    pdf.slice(0, byteRangePlaceholderPosition),
    Buffer.from(abr),
    pdf.slice(brEnd),
  ]);
  return crypto.createHash('sha256').update(
    Buffer.concat([pdf.slice(0, byteRange[1]), pdf.slice(byteRange[2], byteRange[2]+byteRange[3])])
  ).digest('base64');
}

// ── parseCertComponents — extrage issuer+serial direct din DER, fără re-encodare ──
// MOTIVUL EXISTENȚEI: node-forge.pki.certificateFromPem() → toDer() NU produce bytes
// identici cu certificatul original. Adobe validează IssuerAndSerialNumber exact byte-cu-byte
// față de certificatul din CMS. Orice diferență → "formatting errors" → semnătură invalidă.
function parseCertComponents(certDer) {
  let pos = 0;

  function readLen() {
    let b = certDer[pos++];
    if (!(b & 0x80)) return b;
    const n = b & 0x7f; let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | certDer[pos++];
    return len;
  }
  function skipTlv() {
    const start = pos++;
    const len = readLen(); pos += len;
    return certDer.slice(start, pos);
  }
  function readTlvSlice() {
    const start = pos++; readLen(); return certDer.slice(start, pos += (certDer.readUInt8 ? 0 : 0));
  }

  try {
    // — Refacem cu abordare mai robustă —
    pos = 0;
    function tlvSkip() { pos++; const l = readLen(); pos += l; }
    function tlvRead() {
      const s = pos; pos++; const l = readLen(); pos += l;
      return certDer.slice(s, pos);
    }

    tlvRead();  // Certificate SEQUENCE — consumăm tot, reîncepem din TBS
    pos = 0;

    // Intrăm în Certificate SEQUENCE
    pos++;       // tag 0x30
    readLen();   // certificate length

    // Intrăm în TBSCertificate SEQUENCE
    pos++;       // tag 0x30
    readLen();   // TBS length

    // Optional version [0] EXPLICIT
    if (certDer[pos] === 0xa0) tlvSkip();

    // serialNumber INTEGER — citim bytes exacți din cert (incluzând tag 0x02 + length)
    const serialBytes = tlvRead();

    // signature AlgorithmIdentifier — skip
    tlvSkip();

    // issuer Name — citim bytes exacți (incluzând tag 0x30 + length)
    const issuerBytes = tlvRead();

    return { serialBytes, issuerBytes };
  } catch(e) {
    logger.warn({ err: e.message }, 'parseCertComponents: eroare parsing DER (non-fatal)');
    return null;
  }
}

// ── buildCmsFromRawSignature ────────────────────────────────────────────────
/**
 * Construiește CMS/PKCS#7 SignedData pentru injectare în PDF PAdES.
 *
 * ARHITECTURA CORECTĂ (fără signedAttrs — compatibil cu API-ul STS):
 *   STS primește: SHA256(bytesOutsideContents) = documentDigest
 *   STS produce:  RSA_PKCS1v15_sign(privKey, documentDigest)
 *   CMS fără signedAttrs: signatureValue acoperă documentDigest direct
 *   Adobe verifică: RSA_verify(pubKey, SHA256(bytesOutsideContents), signatureValue) ✓
 *
 * CERT EMBEDDING:
 *   Certificatul se extrage direct din PEM (base64 decode) → bytes identici cu originalul.
 *   Issuer și serial se parsează din DER → bytes identici, fără re-encodare prin forge.
 *   Aceasta asigură că Adobe poate găsi semnătarul în CMS.certificates prin IssuerAndSerialNumber.
 *
 * @param {string} signByteBase64 - signByte de la STS (Base64)
 * @param {string|null} certPem   - certificat PEM din /userinfo
 */
async function buildCmsFromRawSignature(signByteBase64, certPem) {
  const signatureBytes = Buffer.from(signByteBase64, 'base64');

  // ── Helpers DER minimali ─────────────────────────────────────────────────
  function encLen(len) {
    if (len < 128) return Buffer.from([len]);
    const h = len.toString(16).padStart(len > 0xffff ? 6 : 4, '0');
    const b = Buffer.from(h, 'hex');
    return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
  }
  function tlv(tag, c) { return Buffer.concat([Buffer.from([tag]), encLen(c.length), c]); }
  const seq   = c => tlv(0x30, c);
  const set   = c => tlv(0x31, c);
  const ctx0  = c => tlv(0xa0, c);
  const oid   = h => { const b = Buffer.from(h, 'hex'); return Buffer.concat([Buffer.from([0x06, b.length]), b]); };
  const int1  = v => Buffer.from([0x02, 0x01, v]);
  const octst = d => Buffer.concat([Buffer.from([0x04]), encLen(d.length), d]);
  const algId = h => seq(Buffer.concat([oid(h), Buffer.from([0x05, 0x00])])); // AlgorithmIdentifier cu NULL params

  const OID_SIGNED_DATA  = '2a864886f70d010702';
  const OID_DATA         = '2a864886f70d010701';
  const OID_SHA256       = '608648016503040201';
  const OID_RSA          = '2a864886f70d010101';
  const OID_ECDSA_SHA256 = '2a8648ce3d040302';

  // Detectăm algoritmul: ECDSA DER = SEQUENCE { INTEGER r, INTEGER s } → byte[0]=0x30, byte[2]=0x02
  // RSA raw = bytes plain (nu DER), < 200 bytes mai rare, de obicei 256 (RSA-2048)
  const isECDSA = signatureBytes[0] === 0x30 && signatureBytes[2] === 0x02 && signatureBytes.length < 200;
  const sigAlgOid = isECDSA ? OID_ECDSA_SHA256 : OID_RSA;
  // Pentru ECDSA: signatureAlgorithm fără NULL (absent params per RFC 5480)
  // Pentru RSA:   signatureAlgorithm cu NULL (required per RFC 3279)
  const sigAlgId = isECDSA
    ? seq(oid(sigAlgOid))
    : algId(sigAlgOid);

  logger.info({
    isECDSA, sigLen: signatureBytes.length,
    first4: signatureBytes.slice(0, 4).toString('hex').toUpperCase(),
    hasCert: !!certPem,
  }, 'CMS: construire PAdES signature');

  if (certPem) {
    try {
      // ── Cert DER: extragere directă din PEM (fără forge re-encodare) ────
      const pemBody = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\r?\n/g, '');
      const certDer = Buffer.from(pemBody, 'base64');

      if (!certDer.length) throw new Error('Cert DER gol după base64 decode');

      // ── Issuer + Serial: parsate direct din DER (bytes identici cu cert original) ─
      const parsed = parseCertComponents(certDer);
      let issuerAndSerial;

      if (parsed) {
        // issuerBytes și serialBytes sunt slices EXACTE din certDer — nicio re-encodare
        issuerAndSerial = seq(Buffer.concat([parsed.issuerBytes, parsed.serialBytes]));
        logger.info({
          issuerLen: parsed.issuerBytes.length,
          serialLen: parsed.serialBytes.length,
          serialHex: parsed.serialBytes.toString('hex').substring(0, 20),
        }, 'CMS: issuer+serial extrase direct din DER');
      } else {
        // Fallback: issuer și serial gol — CMS valid dar Adobe nu găsește cert-ul prin sid
        // Totuși, certificatul e prezent în CMS.certificates, Adobe poate să-l găsească
        logger.warn('CMS: parseCertComponents a eșuat — sid gol, cert în certificates');
        issuerAndSerial = seq(Buffer.concat([
          Buffer.from([0x30, 0x00]),   // issuer: SEQUENCE gol
          Buffer.from([0x02, 0x01, 0x01]),  // serial: INTEGER 1
        ]));
      }

      // ── SignerInfo — fără signedAttrs (SHA256(doc) trimis la STS) ────────
      const signerInfo = seq(Buffer.concat([
        int1(1),                                    // version CMSVersion
        issuerAndSerial,                            // sid IssuerAndSerialNumber
        algId(OID_SHA256),                          // digestAlgorithm cu NULL
        // ← fără signedAttrs — STS a semnat SHA256(doc) direct
        sigAlgId,                                   // signatureAlgorithm
        octst(signatureBytes),                      // signature
      ]));

      // ── SignedData ────────────────────────────────────────────────────────
      const signedData = seq(Buffer.concat([
        int1(1),                                    // version
        set(algId(OID_SHA256)),                     // digestAlgorithms SET
        seq(oid(OID_DATA)),                         // encapContentInfo (detached)
        ctx0(certDer),                              // certificates [0] — bytes ORIGINALI
        set(signerInfo),                            // signerInfos
      ]));

      const cms = seq(Buffer.concat([oid(OID_SIGNED_DATA), ctx0(signedData)]));
      logger.info({ cmsLen: cms.length, certDerLen: certDer.length }, 'CMS: construit cu succes ✓');
      return cms;

    } catch(e) {
      logger.error({ err: e.message }, 'CMS: eroare construire cu cert — fallback fără cert');
      // Cade în fallback de mai jos
    }
  }

  // ── Fallback fără certificat ──────────────────────────────────────────────
  logger.warn('CMS: construire FĂRĂ certificat — semnătura e prezentă dar identitatea neverificabilă');
  const signerInfo = seq(Buffer.concat([
    int1(1),
    seq(Buffer.concat([Buffer.from([0x30, 0x00]), Buffer.from([0x02, 0x01, 0x01])])),
    algId(OID_SHA256),
    sigAlgId,
    octst(signatureBytes),
  ]));
  const signedData = seq(Buffer.concat([
    int1(1),
    set(algId(OID_SHA256)),
    seq(oid(OID_DATA)),
    set(signerInfo),
  ]));
  return seq(Buffer.concat([oid(OID_SIGNED_DATA), ctx0(signedData)]));
}

// ── injectCms ───────────────────────────────────────────────────────────────
export async function injectCms(pdfBytes, signByteB64, certPem) {
  const cmsBuffer = await buildCmsFromRawSignature(signByteB64, certPem);
  if (cmsBuffer.length > STS_SIGNATURE_LENGTH)
    throw new Error(`PAdES: CMS prea mare (${cmsBuffer.length} > ${STS_SIGNATURE_LENGTH})`);
  const signedPdf = await new SignPdf().sign(pdfBytes, new STSSigner(cmsBuffer));
  logger.info({ cmsLen: cmsBuffer.length, pdfSize: signedPdf.length }, 'PAdES: injectat OK ✓');
}
