/**
 * DocFlowAI — PAdES (PDF Advanced Electronic Signatures) / adbe.pkcs7.detached
 *
 * Arhitectura corectă:
 *   - La creare flux: stampFooterOnPdf() generează cartușul O SINGURĂ DATĂ
 *     cu câmpuri AcroForm /Sig per semnatar, salvate în signers[i].padesFieldName
 *   - La semnare STS: buildSignaturePdf() folosește câmpul existent al semnătarului
 *     și adaugă ByteRange placeholder exact în celula lui
 *
 * Algoritm PAdES (ETSI EN 319 132 / ISO 32000-2):
 *   1. buildSignaturePdf(pdfBuf, flowData, signerIdx) → { pdfBytes, byteRange }
 *   2. calcPadesHash(pdfBytes, byteRange) → base64 SHA-256 → trimis la STS
 *   3. injectCmsSignature(pdfBytes, byteRange, cmsBase64) → PDF semnat valid
 */

import crypto from 'node:crypto';
import dns from 'dns';
import { logger } from '../middleware/logger.mjs';

// Forțăm IPv4 pentru toate request-urile STS (gov RO nu suportă IPv6)
dns.setDefaultResultOrder('ipv4first');

// Placeholder 32KB = 65536 hex chars (STS QES tipic 4-12KB DER → 8-24K hex)
const PLACEHOLDER_BYTES = 32768;
const PLACEHOLDER_HEX_LEN = PLACEHOLDER_BYTES * 2;
const MARKER_VALUE  = 'CAFEBABECAFEBABE' + '0'.repeat(PLACEHOLDER_HEX_LEN - 16);
const MARKER_SEARCH = Buffer.from('<CAFEBABECAFEBABE');
const BR_PLACEHOLDER = [0, 999999999, 999999999, 999999999];

function ro(t) {
  const m = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
  return String(t||'').split('').map(c => m[c]||c).join('');
}

// ── buildSignaturePdf ────────────────────────────────────────────────────────
/**
 * Adaugă câmpul /Sig cu ByteRange placeholder în câmpul AcroForm al semnătarului.
 * Câmpul AcroForm (padesFieldName) a fost creat la creare flux de stampFooterOnPdf.
 *
 * @param {Buffer}  pdfBuf    PDF din DB (cu cartuș și câmpuri AcroForm create la flux)
 * @param {object}  flowData  Date flux (signers cu padesFieldName)
 * @param {number}  signerIdx Index semnătar curent
 * @returns {{ pdfBytes: Buffer, byteRange: number[] }}
 */
export async function buildSignaturePdf(pdfBuf, flowData, signerIdx) {
  const { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, rgb, StandardFonts } =
    await import('pdf-lib');

  const signers = Array.isArray(flowData.signers) ? flowData.signers : [];
  const signer  = signers[signerIdx];
  if (!signer) throw new Error(`PAdES: semnătarul la indexul ${signerIdx} lipsește`);

  const fieldName = signer.padesFieldName;
  const pdfDoc    = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const pages     = pdfDoc.getPages();

  // Data PDF
  const now = new Date();
  const p2  = n => String(n).padStart(2,'0');
  const pdfDate = `D:${now.getFullYear()}${p2(now.getMonth()+1)}${p2(now.getDate())}` +
                  `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}+00'00'`;

  if (fieldName) {
    // ── Caz normal: câmpul AcroForm existent (creat la flux) ─────────────
    // Găsim widget-ul câmpului în AcroForm
    const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    if (!acroFormRef) throw new Error(`PAdES: AcroForm lipsă în PDF`);
    const acroForm = pdfDoc.context.lookup(acroFormRef);
    const fieldsRef = acroForm.get(PDFName.of('Fields'));
    if (!fieldsRef) throw new Error(`PAdES: AcroForm.Fields lipsă`);
    const fieldsArr = pdfDoc.context.lookup(fieldsRef);

    // Găsim câmpul cu numele fieldName
    let targetWidget = null;
    for (let i = 0; i < fieldsArr.size(); i++) {
      const ref = fieldsArr.get(i);
      const field = pdfDoc.context.lookup(ref);
      if (!field) continue;
      const tObj = field.get(PDFName.of('T'));
      const tStr = tObj ? (tObj.decodeText ? tObj.decodeText() : tObj.asString ? tObj.asString() : null) : null;
      if (tStr === fieldName) { targetWidget = field; break; }
    }

    if (!targetWidget) {
      logger.warn({ fieldName, signerIdx }, 'PAdES: câmpul AcroForm nu a fost găsit — fallback la câmp nou invizibil');
      // Fallback: câmp invizibil nou
      return _buildWithNewField(pdfDoc, pdfBuf, signer, signerIdx, pdfDate, pages, PDFName, PDFNumber, PDFString, PDFHexString);
    }

    // Actualizăm widget-ul existent cu valorile /Sig
    targetWidget.set(PDFName.of('V'), pdfDoc.context.register(pdfDoc.context.obj({
      Type:      PDFName.of('Sig'),
      Filter:    PDFName.of('Adobe.PPKLite'),
      SubFilter: PDFName.of('adbe.pkcs7.detached'),
      ByteRange: pdfDoc.context.obj(BR_PLACEHOLDER.map(n => PDFNumber.of(n))),
      Contents:  PDFHexString.of(MARKER_VALUE),
      Reason:    PDFString.of('Semnatura electronica calificata QES - DocFlowAI'),
      Name:      PDFString.of(ro(signer.name || '')),
      Location:  PDFString.of('Romania'),
      M:         PDFString.of(pdfDate),
    })));

    logger.info({ signerIdx, fieldName }, 'PAdES: câmp AcroForm existent actualizat cu /Sig placeholder');

  } else {
    // ── Fallback: flux fără padesFieldName (creat înainte de b210) ────────
    return _buildWithNewField(pdfDoc, pdfBuf, signer, signerIdx, pdfDate, pages, PDFName, PDFNumber, PDFString, PDFHexString);
  }

  // ── Serializăm PDF ───────────────────────────────────────────────────────
  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return _finalizeByteRange(savedBytes, signerIdx);
}

// ── Helper: câmp nou invizibil (fallback) ────────────────────────────────────
async function _buildWithNewField(pdfDoc, pdfBuf, signer, signerIdx, pdfDate, pages, PDFName, PDFNumber, PDFString, PDFHexString) {
  logger.info({ signerIdx }, 'PAdES: fallback — câmp nou invizibil');

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

  const now = new Date();
  const p2  = n => String(n).padStart(2,'0');
  const sigValueRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type: PDFName.of('Sig'), Filter: PDFName.of('Adobe.PPKLite'),
    SubFilter: PDFName.of('adbe.pkcs7.detached'),
    ByteRange: pdfDoc.context.obj([0,999999999,999999999,999999999].map(n => PDFNumber.of(n))),
    Contents:  PDFHexString.of('CAFEBABECAFEBABE' + '0'.repeat(PLACEHOLDER_HEX_LEN - 16)),
    Reason:    PDFString.of('Semnatura electronica calificata QES - DocFlowAI'),
    Name:      PDFString.of(ro(signer.name || '')), Location: PDFString.of('Romania'),
    M:         PDFString.of(pdfDate),
  }));

  const drawPage = pages[pages.length - 1];
  const widgetRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), FT: PDFName.of('Sig'),
    T: PDFString.of(`SIG_FB_${signerIdx+1}`),
    Rect: pdfDoc.context.obj([0,0,0,0].map(n => PDFNumber.of(n))),
    V: sigValueRef, F: PDFNumber.of(132), P: drawPage.ref,
  }));
  const existing = drawPage.node.get(PDFName.of('Annots'));
  if (existing) { try { pdfDoc.context.lookup(existing).push(widgetRef); } catch(e) { drawPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef])); } }
  else drawPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef]));
  try { const fref = acroForm.get(PDFName.of('Fields')); if (fref) pdfDoc.context.lookup(fref).push(widgetRef); else acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([widgetRef])); } catch(e) {}

  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return _finalizeByteRange(savedBytes, signerIdx);
}

// ── _finalizeByteRange ───────────────────────────────────────────────────────
function _finalizeByteRange(savedBytes, signerIdx) {
  const markerIdx = savedBytes.indexOf(MARKER_SEARCH);
  if (markerIdx < 0) throw new Error('PAdES: marker CAFEBABECAFEBABE nu a fost găsit după serializare');

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
  if (markerIdx < 0) throw new Error('PAdES: marker CAFEBABECAFEBABE nu a fost găsit pentru injecție');
  Buffer.from(paddedHex, 'ascii').copy(pdfBytes, markerIdx + 1);
  logger.info({ cmsHexLen: cmsHex.length, pdfSize: pdfBytes.length }, 'PAdES: CMS injectat cu succes');
  return pdfBytes;
}

// ── _patchByteRange ──────────────────────────────────────────────────────────
function _patchByteRange(pdfBuf, byteRange) {
  const search = Buffer.from('/ByteRange [');
  const pos    = pdfBuf.indexOf(search);
  if (pos < 0) { logger.warn('PAdES: /ByteRange [ nu a fost găsit'); return; }
  const startIdx  = pos + search.length;
  let endIdx      = startIdx;
  while (endIdx < pdfBuf.length && pdfBuf[endIdx] !== 0x5D) endIdx++;
  const oldLen    = endIdx - startIdx;
  const newContent= ` ${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]} `;
  if (newContent.length <= oldLen) {
    Buffer.from(newContent.padEnd(oldLen, ' '), 'ascii').copy(pdfBuf, startIdx);
  } else {
    logger.error({ oldLen, newLen: newContent.length }, 'PAdES: ByteRange nou prea lung');
  }
}
