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
  const { PDFDocument, PDFName, PDFArray, PDFNumber, PDFHexString, PDFString } = await import('pdf-lib');
  const { DEFAULT_BYTE_RANGE_PLACEHOLDER } = _require('@signpdf/utils');

  const pdfDoc   = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const pages    = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const fieldName = signer.padesFieldName;

  // ── Construim dict /Sig cu ByteRange placeholder ─────────────────────────
  // Același format pe care @signpdf/signpdf îl caută în PDF bytes
  const byteRangeArr = PDFArray.withContext(pdfDoc.context);
  byteRangeArr.push(PDFNumber.of(0));
  byteRangeArr.push(PDFName.of(DEFAULT_BYTE_RANGE_PLACEHOLDER));
  byteRangeArr.push(PDFName.of(DEFAULT_BYTE_RANGE_PLACEHOLDER));
  byteRangeArr.push(PDFName.of(DEFAULT_BYTE_RANGE_PLACEHOLDER));

  const sigDict = pdfDoc.context.register(pdfDoc.context.obj({
    Type:        PDFName.of('Sig'),
    Filter:      PDFName.of('Adobe.PPKLite'),
    SubFilter:   PDFName.of('adbe.pkcs7.detached'),
    ByteRange:   byteRangeArr,
    Contents:    PDFHexString.of(String.fromCharCode(0).repeat(STS_SIGNATURE_LENGTH)),
    Reason:      PDFString.of('Semnatura electronica calificata QES - DocFlowAI'),
    Name:        PDFString.of(ro(signer.name || '')),
    Location:    PDFString.of('Romania'),
    M:           PDFString.fromDate(new Date()),
    ContactInfo: PDFString.of(signer.email || ''),
  }));

  if (fieldName) {
    // ── Caz NORMAL: setăm /V pe câmpul existent din cartuș (SIG_ROL_N) ────
    // Semnătura apare în celula vizuală din cartuș în Adobe Signature Panel
    let found = false;
    const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    if (acroFormRef) {
      const acroForm = pdfDoc.context.lookup(acroFormRef);
      try { acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } catch(e2) {}
      const fRef = acroForm.get(PDFName.of('Fields'));
      if (fRef) {
        const fArr = pdfDoc.context.lookup(fRef);
        for (let i = 0; i < (fArr.size ? fArr.size() : 0); i++) {
          try {
            const f    = pdfDoc.context.lookup(fArr.get(i));
            const tObj = f?.get(PDFName.of('T'));
            const tStr = tObj?.decodeText ? tObj.decodeText() : tObj?.asString?.();
            if (tStr === fieldName) {
              f.set(PDFName.of('V'), sigDict);
              found = true;
              logger.info({ signerIdx, fieldName }, 'PAdES: /V setat pe câmpul existent din cartuș');
              break;
            }
          } catch(e2) {}
        }
      }
    }
    if (!found) {
      logger.warn({ signerIdx, fieldName }, 'PAdES: câmpul nu a fost găsit — fallback câmp nou invizibil');
      _addInvisibleField(pdfDoc, lastPage, sigDict, PDFName, PDFNumber, PDFString, signerIdx);
    }
  } else {
    // ── FALLBACK: flux fără padesFieldName (creat înainte de b214) ─────────
    logger.info({ signerIdx }, 'PAdES: fără padesFieldName — câmp nou invizibil');
    _addInvisibleField(pdfDoc, lastPage, sigDict, PDFName, PDFNumber, PDFString, signerIdx);
  }

  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  logger.info({ signerIdx, fieldName, pdfSize: savedBytes.length }, 'PAdES: placeholder adăugat');
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
 * SHA-256 al bytes-ilor din afara placeholder-ului /Contents.
 * @signpdf/signpdf localizează automat ByteRange — calculăm la fel.
 */
export function calcPadesHash(pdfBytes) {
  // Găsim ByteRange în PDF (patternat de pdflibAddPlaceholder)
  // @signpdf/signpdf calculeaza ByteRange astfel:
  // 1. Gaseste /ByteRange cu placeholder-ul
  // 2. Dupa ByteRange gaseste /Contents <...placeholder zeros...>
  // 3. Hash = bytes[0..contentsStart] + bytes[contentsEnd..end]
  // Reproducem exact aceeasi logica pentru hash-ul trimis la STS

  const { removeTrailingNewLine, convertBuffer, findByteRange } = _require('@signpdf/utils');
  let pdf = removeTrailingNewLine(convertBuffer(pdfBytes, 'PDF'));

  const { byteRangePlaceholder, byteRangePlaceholderPosition } = findByteRange(pdf);
  if (!byteRangePlaceholder) {
    logger.warn('PAdES: ByteRange placeholder negăsit — hash simplu');
    return crypto.createHash('sha256').update(pdfBytes).digest('base64');
  }

  // Exact aceeasi logica ca SignPdf.sign pentru a determina pozitia /Contents
  const byteRangeEnd   = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const contentsTagPos = pdf.indexOf('/Contents ', byteRangeEnd);
  const placeholderPos = pdf.indexOf('<', contentsTagPos);
  const placeholderEnd = pdf.indexOf('>', placeholderPos);

  const b1 = placeholderPos;
  const b2 = placeholderEnd + 1;
  const b3 = pdf.length - b2;

  // PDF-ul fara /Contents placeholder (exact ce semneaza STS)
  const hash = crypto.createHash('sha256');
  hash.update(pdf.slice(0, b1));
  hash.update(pdf.slice(b2, b2 + b3));
  return hash.digest('base64');
}

// ── injectCms ────────────────────────────────────────────────────────────────
/**
 * Injectează CMS-ul de la STS în placeholder.
 * Folosește @signpdf/signpdf care face incremental update corect.
 * @param {Buffer} pdfBytes  PDF cu placeholder
 * @param {string} cmsBase64 CMS DER base64 de la STS
 * @returns {Promise<Buffer>} PDF semnat final
 */
export async function injectCms(pdfBytes, cmsBase64) {
  const cmsBuffer = Buffer.from(cmsBase64, 'base64');
  if (cmsBuffer.length > STS_SIGNATURE_LENGTH) {
    throw new Error(`PAdES: CMS prea mare (${cmsBuffer.length} > ${STS_SIGNATURE_LENGTH} bytes)`);
  }
  const signer    = new STSSigner(cmsBuffer);
  const signPdf   = new SignPdf();
  const signedPdf = await signPdf.sign(pdfBytes, signer);
  logger.info({ cmsLen: cmsBuffer.length, pdfSize: signedPdf.length }, 'PAdES: CMS injectat cu succes');
  return signedPdf;
}
