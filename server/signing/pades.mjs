/**
 * DocFlowAI — PAdES cu @signpdf/signpdf
 *
 * ARHITECTURA CORECTĂ:
 *   1. CREATE FLOW: stampFooterOnPdf → footer only (nemodificat)
 *      Cartușul vizual: buildCartusBlob client-side (upload local, neatins)
 *
 *   2. SIGNER ALEGE STS → POST /initiate-cloud-signing:
 *      preparePadesDoc(pdfBuf, flowData, signerIdx):
 *        a. Adaugă pagina cartuș cu celule + câmp AcroForm /Sig în zona JOS
 *        b. pdflibAddPlaceholder cu widgetRect = zona JOS a celulei semnătarului
 *        c. Returnează pdfBytes cu ByteRange placeholder gata de hash
 *      calcPadesHash(pdfBytes) → SHA-256 → trimis la STS
 *
 *   3. POLL → STS returnează signByte (raw ECDSA/RSA bytes):
 *      buildCmsFromRawSignature(signByte, certPem, hash) → CMS DER complet RFC 5652
 *      injectCms(pdfBytes, signByte, certPem, hash) → PDF semnat final via @signpdf/signpdf
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
  constructor(cmsBuffer) { super(); this._cmsBuffer = cmsBuffer; }
  async sign() { return this._cmsBuffer; }
}

// ── preparePadesDoc ─────────────────────────────────────────────────────────
/**
 * Apelat la initiate-cloud-signing, DUPĂ ce utilizatorul a ales STS.
 * Adaugă cartuș vizual + câmp /Sig + ByteRange placeholder pe PDF-ul cu footer.
 */
export async function preparePadesDoc(pdfBuf, flowData, signerIdx) {
  const { PDFDocument, PDFName, PDFNumber, PDFString, rgb, StandardFonts } =
    await import('pdf-lib');

  const signers  = Array.isArray(flowData.signers) ? flowData.signers : [];
  const signer   = signers[signerIdx];
  if (!signer) throw new Error(`PAdES: semnătarul ${signerIdx} lipsește`);
  const isAncore = (flowData.flowType || 'tabel').toLowerCase() === 'ancore';

  const pdfDoc   = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const fontR    = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages    = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const { width: pW, height: pH } = lastPage.getSize();
  const MARGIN = 40;

  // ── FLUX ANCORE: câmpuri vizuale există deja în PDF — câmp invizibil ──
  if (isAncore) {
    pdflibAddPlaceholder({
      pdfDoc, pdfPage: lastPage,
      reason: 'Semnatura electronica calificata QES - DocFlowAI',
      contactInfo: signer.email || '', name: ro(signer.name || ''),
      location: 'Romania',
      signatureLength: STS_SIGNATURE_LENGTH,
      subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
      widgetRect: [0, 0, 0, 0],
    });
    const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
    logger.info({ signerIdx, pdfSize: savedBytes.length }, 'PAdES: ancore — câmp invizibil');
    return savedBytes;
  }

  // ── FLUX TABEL: cartuș vizual cu celule SUS(text)/JOS(semnătură) ───────
  // Generat ACUM (la semnare STS) — nu la creare flux
  const n     = signers.length;
  const cols  = Math.min(n, 3);
  const rows  = Math.ceil(n / cols);
  const cellW = (pW - MARGIN * 2) / cols;
  const cellH = 64;
  const infoH = cellH * 0.58;
  const sigH  = cellH * 0.42;
  const titleH = 20;
  const cartusBottom = 36;
  const cartusH = rows * cellH + titleH;

  // Dacă e semnatar 2+, cartușul există deja pe ultima pagină — nu adăugăm altul
  const isFirstSigner = signers.slice(0, signerIdx).every(s => s.status !== 'signed');

  let cartusPage;
  if (isFirstSigner) {
    cartusPage = pdfDoc.addPage([pW, pH]);

    // Footer pe pagina cartuș
    const footerY = 14, FS = 7;
    const flowId = flowData.flowId || '';
    cartusPage.drawLine({ start: { x: MARGIN, y: footerY+10 }, end: { x: pW-MARGIN, y: footerY+10 }, thickness: 0.4, color: rgb(.75,.75,.75) });
    cartusPage.drawText(ro(flowId) + '  |  DocFlowAI', { x: pW-MARGIN-fontR.widthOfTextAtSize(ro(flowId)+'  |  DocFlowAI', FS)-2, y: footerY, size: FS, font: fontR, color: rgb(.5,.5,.5), opacity: .8 });

    // Bara titlu
    cartusPage.drawRectangle({ x: MARGIN, y: cartusBottom+cartusH-titleH, width: pW-MARGIN*2, height: titleH, color: rgb(1,1,1), borderColor: rgb(0,0,0), borderWidth: 0.8 });
    cartusPage.drawText('SEMNAT SI APROBAT', { x: MARGIN+8, y: cartusBottom+cartusH-titleH+6, size: 7, font: fontB, color: rgb(0,0,0) });

    // Celule pentru toți semnatarii
    signers.forEach((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx  = MARGIN + col * cellW;
      const cy  = cartusBottom + (rows - 1 - row) * cellH;
      const infoY = cy + sigH;

      cartusPage.drawRectangle({ x: cx, y: cy, width: cellW, height: cellH, color: rgb(.97,.97,.97), borderColor: rgb(.2,.2,.2), borderWidth: 1 });
      cartusPage.drawLine({ start: { x: cx, y: infoY }, end: { x: cx+cellW, y: infoY }, thickness: 0.5, color: rgb(.3,.3,.3) });

      // SUS: text info
      cartusPage.drawText(ro(s.rol)||'—', { x: cx+5, y: infoY+infoH-12, size: 7, font: fontB, color: rgb(.1,.1,.1), maxWidth: cellW-10 });
      const nf = [ro(s.name), ro(s.functie)].filter(Boolean).join(' - ');
      if (nf) cartusPage.drawText(nf, { x: cx+5, y: infoY+infoH-23, size: 6.5, font: fontR, color: rgb(.15,.15,.15), maxWidth: cellW-10 });

      // JOS: text zona semnătură
      cartusPage.drawText('Semnatura electronica calificata', { x: cx+5, y: cy+sigH-10, size: 5.5, font: fontR, color: rgb(.55,.55,.65), maxWidth: cellW-10 });
      cartusPage.drawText('L.S.', { x: cx+5, y: cy+4, size: 7, font: fontB, color: rgb(.5,.5,.6) });
    });
  } else {
    // Semnatar 2+: cartușul există deja — folosim ultima pagină
    cartusPage = pages[pages.length - 1];
  }

  // ── Calculăm rect zona JOS a celulei semnătarului curent ───────────────
  const col = signerIdx % cols;
  const row = Math.floor(signerIdx / cols);
  const cx  = MARGIN + col * cellW;
  const cy  = cartusBottom + (rows - 1 - row) * cellH;
  const widgetRect = [cx + 1, cy + 1, cx + cellW - 1, cy + sigH - 1];

  // ── AcroForm + câmp /Sig ───────────────────────────────────────────────
  let acroForm;
  const afRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
  if (afRef) {
    acroForm = pdfDoc.context.lookup(afRef);
    try { acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } catch(e) {}
  } else {
    const afObj = pdfDoc.context.obj({ Fields: pdfDoc.context.obj([]), SigFlags: PDFNumber.of(3), DA: PDFString.of('/Helv 0 Tf 0 g') });
    pdfDoc.catalog.set(PDFName.of('AcroForm'), pdfDoc.context.register(afObj));
    acroForm = afObj;
  }

  // Curățăm câmpul SIG anterior dacă există (re-semnare)
  const fieldName = `SIG_${(signer.rol||'SEM').replace(/[^A-Za-z0-9]/g,'_').toUpperCase()}_${signerIdx+1}`;
  try {
    const fref = acroForm.get(PDFName.of('Fields'));
    if (fref) {
      const fa = pdfDoc.context.lookup(fref);
      const newF = [];
      for (let i = 0; i < fa.size(); i++) {
        const ref = fa.get(i);
        const f   = pdfDoc.context.lookup(ref);
        const t   = f?.get(PDFName.of('T'));
        const ts  = t?.decodeText ? t.decodeText() : t?.asString?.();
        if (ts !== fieldName) newF.push(ref);
      }
      acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj(newF));
    }
  } catch(e2) {}

  // pdflibAddPlaceholder — format ByteRange corect pentru @signpdf/signpdf
  pdflibAddPlaceholder({
    pdfDoc,
    pdfPage:         cartusPage,
    reason:          'Semnatura electronica calificata QES - DocFlowAI',
    contactInfo:     signer.email || '',
    name:            ro(signer.name || ''),
    location:        'Romania',
    signatureLength: STS_SIGNATURE_LENGTH,
    subFilter:       SUBFILTER_ADOBE_PKCS7_DETACHED,
    widgetRect,
  });

  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  logger.info({ signerIdx, fieldName, widgetRect, pdfSize: savedBytes.length, isFirstSigner },
    'PAdES: cartus + placeholder generat la semnare STS');
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

  const byteRangeEnd            = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const contentsTagPos          = pdf.indexOf('/Contents ', byteRangeEnd);
  const placeholderPos          = pdf.indexOf('<', contentsTagPos);
  const placeholderEnd          = pdf.indexOf('>', placeholderPos);
  const placeholderLenWithBrack = placeholderEnd + 1 - placeholderPos;

  const byteRange = [0, placeholderPos, placeholderPos + placeholderLenWithBrack,
                     pdf.length - placeholderPos - placeholderLenWithBrack];

  let actualByteRange = `/ByteRange [${byteRange.join(' ')}]`;
  actualByteRange += ' '.repeat(byteRangePlaceholder.length - actualByteRange.length);
  pdf = Buffer.concat([
    pdf.slice(0, byteRangePlaceholderPosition),
    Buffer.from(actualByteRange),
    pdf.slice(byteRangeEnd),
  ]);

  return crypto.createHash('sha256').update(
    Buffer.concat([pdf.slice(0, byteRange[1]), pdf.slice(byteRange[2], byteRange[2] + byteRange[3])])
  ).digest('base64');
}

// ── buildCmsFromRawSignature ────────────────────────────────────────────────
async function buildCmsFromRawSignature(signByteBase64, certPem, hashBase64) {
  const forge = _require('node-forge');
  const cert  = forge.pki.certificateFromPem(certPem);
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const signatureBytes = Buffer.from(signByteBase64, 'base64');
  const hashBytes      = Buffer.from(hashBase64, 'base64');

  function encLen(len) {
    if (len < 128) return Buffer.from([len]);
    const hex = len.toString(16).padStart(len > 0xffff ? 6 : 4, '0');
    const b = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
  }
  function seq(c)     { return Buffer.concat([Buffer.from([0x30]), encLen(c.length), c]); }
  function set(c)     { return Buffer.concat([Buffer.from([0x31]), encLen(c.length), c]); }
  function ctx(t,c)   { return Buffer.concat([Buffer.from([0xa0|t]), encLen(c.length), c]); }
  function oid(h)     { const b=Buffer.from(h,'hex'); return Buffer.concat([Buffer.from([0x06,b.length]),b]); }
  function int1(v)    { return Buffer.from([0x02,0x01,v]); }
  function octstr(d)  { return Buffer.concat([Buffer.from([0x04]),encLen(d.length),d]); }
  function utctime(d) { const s=d.toISOString().replace(/[-:T]/g,'').slice(0,12)+'Z'; return Buffer.concat([Buffer.from([0x17,s.length]),Buffer.from(s)]); }

  const OID_SIGNED_DATA  = '2a864886f70d010702';
  const OID_DATA         = '2a864886f70d010701';
  const OID_SHA256       = '608648016503040201';
  const OID_RSA          = '2a864886f70d010101';
  const OID_ECDSA_SHA256 = '2a8648ce3d040302';
  const OID_CTYPE        = '2a864886f70d010903';
  const OID_DIGEST       = '2a864886f70d010904';
  const OID_TIME         = '2a864886f70d010905';

  const isECDSA = signatureBytes[0] === 0x30 && signatureBytes[2] === 0x02;
  const sigAlg  = isECDSA ? OID_ECDSA_SHA256 : OID_RSA;
  logger.info({ isECDSA, sigLen: signatureBytes.length, first4: signatureBytes.slice(0,4).toString('hex') }, 'CMS: algoritm');

  const issuerDer = Buffer.from(forge.asn1.toDer(cert.issuer.toAsn1()).getBytes(), 'binary');
  const serialHex = cert.serialNumber;
  const serialBuf = Buffer.from(serialHex, 'hex');
  const serialDer = (serialBuf[0] & 0x80)
    ? Buffer.concat([Buffer.from([0x02]), encLen(serialBuf.length+1), Buffer.from([0x00]), serialBuf])
    : Buffer.concat([Buffer.from([0x02]), encLen(serialBuf.length), serialBuf]);

  const issuerAndSerial = seq(Buffer.concat([issuerDer, serialDer]));
  const authAttrs = ctx(0, Buffer.concat([
    seq(Buffer.concat([oid(OID_CTYPE),   set(seq(oid(OID_DATA)))])),
    seq(Buffer.concat([oid(OID_TIME),    set(utctime(new Date()))])),
    seq(Buffer.concat([oid(OID_DIGEST),  set(octstr(hashBytes))])),
  ]));

  const signerInfo = seq(Buffer.concat([
    int1(1),
    issuerAndSerial,
    seq(Buffer.concat([oid(OID_SHA256)])),
    authAttrs,
    seq(Buffer.concat([oid(sigAlg), ...(isECDSA ? [] : [Buffer.from([0x05,0x00])])])),
    octstr(signatureBytes),
  ]));

  const signedData = seq(Buffer.concat([
    int1(1),
    set(seq(Buffer.concat([oid(OID_SHA256)]))),
    seq(oid(OID_DATA)),
    ctx(0, certDer),
    set(signerInfo),
  ]));

  const cms = seq(Buffer.concat([oid(OID_SIGNED_DATA), ctx(0, signedData)]));
  logger.info({ cmsLen: cms.length, certLen: certDer.length }, 'CMS: construit');
  return cms;
}

// ── injectCms ───────────────────────────────────────────────────────────────
export async function injectCms(pdfBytes, signByteB64, certPem, hashBase64) {
  if (!certPem) throw new Error('PAdES: certificatul semnatarului lipsă');
  const cmsBuffer = await buildCmsFromRawSignature(signByteB64, certPem, hashBase64);
  if (cmsBuffer.length > STS_SIGNATURE_LENGTH)
    throw new Error(`PAdES: CMS prea mare (${cmsBuffer.length} > ${STS_SIGNATURE_LENGTH})`);
  const signedPdf = await new SignPdf().sign(pdfBytes, new STSSigner(cmsBuffer));
  logger.info({ cmsLen: cmsBuffer.length, pdfSize: signedPdf.length }, 'PAdES: injectat');
  return signedPdf;
}
