/**
 * DocFlowAI — PAdES (PDF Advanced Electronic Signatures) / adbe.pkcs7.detached
 *
 * Arhitectura simplificată (compatibilă cu pdf-lib care nu suportă incremental update):
 *
 * La creare flux (stampFooterOnPdf):
 *   - Footer vizual + câmpuri AcroForm /Sig invizibile (Rect=[0,0,0,0]) per semnatar
 *   - signers[i].padesFieldName = 'SIG_ROL_N'
 *
 * La semnare STS (buildSignaturePdf):
 *   - Folosim câmpul existent sau creăm unul nou invizibil
 *   - Adăugăm ByteRange placeholder CAFEBABECAFEBABE
 *   - calcPadesHash → hash trimis la STS
 *   - injectCmsSignature → CMS embedded → PDF valid în Adobe
 *
 * Fiecare semnare e independentă (nu chain) → semnăturile nu se invalidează reciproc.
 * Cartușul vizual cu celulele e generat client-side (buildCartusBlob + PDF.js detecție spațiu).
 */

import crypto from 'node:crypto';
import dns from 'dns';
import { logger } from '../middleware/logger.mjs';

dns.setDefaultResultOrder('ipv4first');

const PLACEHOLDER_BYTES   = 32768;
const PLACEHOLDER_HEX_LEN = PLACEHOLDER_BYTES * 2;
const MARKER_VALUE        = 'CAFEBABECAFEBABE' + '0'.repeat(PLACEHOLDER_HEX_LEN - 16);
const MARKER_SEARCH       = Buffer.from('<CAFEBABECAFEBABE');

function ro(t) {
  const m = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
  return String(t||'').split('').map(c => m[c]||c).join('');
}

// ── buildSignaturePdf ────────────────────────────────────────────────────────
export async function buildSignaturePdf(pdfBuf, flowData, signerIdx) {
  const { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString } =
    await import('pdf-lib');

  const signers = Array.isArray(flowData.signers) ? flowData.signers : [];
  const signer  = signers[signerIdx];
  if (!signer) throw new Error(`PAdES: semnătarul la indexul ${signerIdx} lipsește`);

  const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const pages  = pdfDoc.getPages();
  const page   = pages[pages.length - 1];

  const now = new Date();
  const p2  = n => String(n).padStart(2,'0');
  const pdfDate = `D:${now.getFullYear()}${p2(now.getMonth()+1)}${p2(now.getDate())}` +
                  `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}+00'00'`;

  // AcroForm
  let acroForm;
  const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
  if (acroFormRef) {
    acroForm = pdfDoc.context.lookup(acroFormRef);
    try { acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } catch(e) {}
  } else {
    const afObj = pdfDoc.context.obj({
      Fields: pdfDoc.context.obj([]), SigFlags: PDFNumber.of(3),
      DA: PDFString.of('/Helv 0 Tf 0 g'),
    });
    pdfDoc.catalog.set(PDFName.of('AcroForm'), pdfDoc.context.register(afObj));
    acroForm = afObj;
  }

  // Găsim câmpul existent (padesFieldName) sau creăm unul nou invizibil
  const fieldName = signer.padesFieldName || `SIG_QES_${signerIdx+1}_${Date.now()}`;
  let existingWidget = null;

  if (signer.padesFieldName) {
    const fref = acroForm.get(PDFName.of('Fields'));
    if (fref) {
      const farr = pdfDoc.context.lookup(fref);
      for (let i = 0; i < (farr.size ? farr.size() : 0); i++) {
        try {
          const f = pdfDoc.context.lookup(farr.get(i));
          const tObj = f?.get(PDFName.of('T'));
          const tStr = tObj?.decodeText ? tObj.decodeText() : tObj?.asString?.();
          if (tStr === signer.padesFieldName) { existingWidget = f; break; }
        } catch(e2) {}
      }
    }
  }

  // Dict /Sig cu placeholder
  const sigValRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type:      PDFName.of('Sig'),
    Filter:    PDFName.of('Adobe.PPKLite'),
    SubFilter: PDFName.of('adbe.pkcs7.detached'),
    ByteRange: pdfDoc.context.obj([0,999999999,999999999,999999999].map(n => PDFNumber.of(n))),
    Contents:  PDFHexString.of(MARKER_VALUE),
    Reason:    PDFString.of('Semnatura electronica calificata QES - DocFlowAI'),
    Name:      PDFString.of(ro(signer.name || '')),
    Location:  PDFString.of('Romania'),
    M:         PDFString.of(pdfDate),
  }));

  if (existingWidget) {
    // Actualizăm câmpul existent cu /V = dict Sig
    existingWidget.set(PDFName.of('V'), sigValRef);
    logger.info({ signerIdx, fieldName }, 'PAdES: câmp existent actualizat');
  } else {
    // Câmp nou invizibil
    const widgetRef = pdfDoc.context.register(pdfDoc.context.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), FT: PDFName.of('Sig'),
      T: PDFString.of(fieldName),
      Rect: pdfDoc.context.obj([0,0,0,0].map(n => PDFNumber.of(n))),
      V: sigValRef, F: PDFNumber.of(132), P: page.ref,
    }));
    const ea = page.node.get(PDFName.of('Annots'));
    if (ea) { try { pdfDoc.context.lookup(ea).push(widgetRef); } catch(e2) { page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef])); } }
    else page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef]));
    try {
      const fref = acroForm.get(PDFName.of('Fields'));
      if (fref) pdfDoc.context.lookup(fref).push(widgetRef);
      else acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([widgetRef]));
    } catch(e2) {}
    logger.info({ signerIdx, fieldName }, 'PAdES: câmp nou invizibil creat');
  }

  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  const markerIdx = savedBytes.indexOf(MARKER_SEARCH);
  if (markerIdx < 0) throw new Error('PAdES: marker CAFEBABECAFEBABE nu a fost găsit');

  const contentsStart = markerIdx;
  const contentsEnd   = markerIdx + 1 + PLACEHOLDER_HEX_LEN + 1;
  const byteRange     = [0, contentsStart, contentsEnd, savedBytes.length - contentsEnd];

  _patchByteRange(savedBytes, byteRange);
  logger.info({ signerIdx, byteRange, pdfSize: savedBytes.length }, 'PAdES: PDF pregătit cu succes');
  return { pdfBytes: savedBytes, byteRange };
}

// ── calcPadesHash ────────────────────────────────────────────────────────────
export function calcPadesHash(pdfBytes, byteRange) {
  const [b0, b1, b2, b3] = byteRange;
  const hash = crypto.createHash('sha256');
  hash.update(pdfBytes.slice(b0, b0 + b1));
  hash.update(pdfBytes.slice(b2, b2 + b3));
  return hash.digest('base64');
}

// ── injectCmsSignature ───────────────────────────────────────────────────────
export function injectCmsSignature(pdfBytes, byteRange, cmsBase64) {
  const cmsHex = Buffer.from(cmsBase64, 'base64').toString('hex').toUpperCase();
  if (cmsHex.length > PLACEHOLDER_HEX_LEN) {
    throw new Error(`PAdES: CMS prea mare (${cmsHex.length} > ${PLACEHOLDER_HEX_LEN} hex chars)`);
  }
  const paddedHex = cmsHex + '0'.repeat(PLACEHOLDER_HEX_LEN - cmsHex.length);
  const markerIdx = pdfBytes.indexOf(MARKER_SEARCH);
  if (markerIdx < 0) throw new Error('PAdES: marker CAFEBABECAFEBABE nu a fost găsit');
  Buffer.from(paddedHex, 'ascii').copy(pdfBytes, markerIdx + 1);
  logger.info({ cmsHexLen: cmsHex.length, pdfSize: pdfBytes.length }, 'PAdES: CMS injectat cu succes');
  return pdfBytes;
}

function _patchByteRange(pdfBuf, byteRange) {
  const search = Buffer.from('/ByteRange [');
  const pos    = pdfBuf.indexOf(search);
  if (pos < 0) { logger.warn('PAdES: /ByteRange [ nu a fost găsit'); return; }
  const startIdx = pos + search.length;
  let endIdx = startIdx;
  while (endIdx < pdfBuf.length && pdfBuf[endIdx] !== 0x5D) endIdx++;
  const oldLen = endIdx - startIdx;
  const newContent = ` ${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]} `;
  if (newContent.length <= oldLen) {
    Buffer.from(newContent.padEnd(oldLen, ' '), 'ascii').copy(pdfBuf, startIdx);
  } else {
    logger.error({ oldLen, newLen: newContent.length }, 'PAdES: ByteRange nou prea lung');
  }
}
