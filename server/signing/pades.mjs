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

// ── buildCmsFromRawSignature ────────────────────────────────────────────────
/**
 * CMS/PKCS#7 SignedData FĂRĂ signedAttrs — soluția corectă pentru STS.
 *
 * De ce fără signedAttrs:
 *   STS semnează: ECDSA.sign(key, SHA256(pdfBytesOutsideContents))
 *   Adobe verifică fără signedAttrs: ECDSA.verify(key, signByte, SHA256(pdfBytes)) ✅
 *   Adobe verifică cu signedAttrs:   ECDSA.verify(key, signByte, SHA256(DER(attrs))) ✗
 *   → fără signedAttrs e singurul format compatibil cu API-ul STS
 */
async function buildCmsFromRawSignature(signByteBase64, certPem) {
  const signatureBytes = Buffer.from(signByteBase64, 'base64');

  function encLen(len) {
    if (len < 128) return Buffer.from([len]);
    const h = len.toString(16).padStart(len > 0xffff ? 6 : 4, '0');
    const b = Buffer.from(h, 'hex');
    return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
  }
  function seq(c)   { return Buffer.concat([Buffer.from([0x30]), encLen(c.length), c]); }
  function set(c)   { return Buffer.concat([Buffer.from([0x31]), encLen(c.length), c]); }
  function ctx0(c)  { return Buffer.concat([Buffer.from([0xa0]), encLen(c.length), c]); }
  function oid(h)   { const b=Buffer.from(h,'hex'); return Buffer.concat([Buffer.from([0x06,b.length]),b]); }
  function int1(v)  { return Buffer.from([0x02,0x01,v]); }
  function octstr(d){ return Buffer.concat([Buffer.from([0x04]),encLen(d.length),d]); }

  const OID_SIGNED_DATA  = '2a864886f70d010702';
  const OID_DATA         = '2a864886f70d010701';
  const OID_SHA256       = '608648016503040201';
  const OID_RSA          = '2a864886f70d010101';
  const OID_ECDSA_SHA256 = '2a8648ce3d040302';

  const isECDSA = signatureBytes[0] === 0x30 && signatureBytes[2] === 0x02;
  const sigAlg  = isECDSA ? OID_ECDSA_SHA256 : OID_RSA;
  logger.info({ isECDSA, sigLen: signatureBytes.length,
    first4: signatureBytes.slice(0,4).toString('hex') }, 'CMS: algoritm detectat');

  // Construim SignerInfo fără signedAttrs
  // sid: IssuerAndSerialNumber sau SubjectKeyIdentifier
  // Fără cert: folosim placeholder simplu
  let signerInfo;
  if (certPem) {
    const forge = _require('node-forge');
    const cert  = forge.pki.certificateFromPem(certPem);
    const certDer  = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    const issuerDer = Buffer.from(forge.asn1.toDer(cert.issuer.toAsn1()).getBytes(), 'binary');
    const serialBuf = Buffer.from(cert.serialNumber, 'hex');
    const serialDer = (serialBuf[0] & 0x80)
      ? Buffer.concat([Buffer.from([0x02]), encLen(serialBuf.length+1), Buffer.from([0x00]), serialBuf])
      : Buffer.concat([Buffer.from([0x02]), encLen(serialBuf.length), serialBuf]);
    const issuerAndSerial = seq(Buffer.concat([issuerDer, serialDer]));

    signerInfo = seq(Buffer.concat([
      int1(1),
      issuerAndSerial,
      seq(oid(OID_SHA256)),
      // ← fără signedAttrs
      seq(Buffer.concat([oid(sigAlg), ...(isECDSA ? [] : [Buffer.from([0x05,0x00])])])),
      octstr(signatureBytes),
    ]));

    const signedData = seq(Buffer.concat([
      int1(1),
      set(seq(oid(OID_SHA256))),
      seq(oid(OID_DATA)),
      ctx0(certDer),           // certificates
      set(signerInfo),
    ]));
    const cms = seq(Buffer.concat([oid(OID_SIGNED_DATA), ctx0(signedData)]));
    logger.info({ cmsLen: cms.length, hasCert: true }, 'CMS: construit cu certificat');
    return cms;

  } else {
    // Fallback fără certificat — Adobe arată semnătură dar nu poate verifica identitatea
    signerInfo = seq(Buffer.concat([
      int1(1),
      seq(Buffer.concat([        // sid: versiune simplă
        Buffer.from([0x30,0x00]), // issuer gol
        Buffer.from([0x02,0x01,0x01]), // serial = 1
      ])),
      seq(oid(OID_SHA256)),
      seq(Buffer.concat([oid(sigAlg), ...(isECDSA ? [] : [Buffer.from([0x05,0x00])])])),
      octstr(signatureBytes),
    ]));
    const signedData = seq(Buffer.concat([
      int1(1),
      set(seq(oid(OID_SHA256))),
      seq(oid(OID_DATA)),
      set(signerInfo),
    ]));
    const cms = seq(Buffer.concat([oid(OID_SIGNED_DATA), ctx0(signedData)]));
    logger.warn({ cmsLen: cms.length }, 'CMS: construit FĂRĂ certificat — identitate neverificabilă');
    return cms;
  }
}

// ── injectCms ───────────────────────────────────────────────────────────────
export async function injectCms(pdfBytes, signByteB64, certPem) {
  const cmsBuffer = await buildCmsFromRawSignature(signByteB64, certPem);
  if (cmsBuffer.length > STS_SIGNATURE_LENGTH)
    throw new Error(`PAdES: CMS prea mare (${cmsBuffer.length} > ${STS_SIGNATURE_LENGTH})`);
  const signedPdf = await new SignPdf().sign(pdfBytes, new STSSigner(cmsBuffer));
  logger.info({ cmsLen: cmsBuffer.length, pdfSize: signedPdf.length }, 'PAdES: injectat OK');
  return signedPdf;
}
