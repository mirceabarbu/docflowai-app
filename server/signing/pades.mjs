/**
 * DocFlowAI — PAdES (PDF Advanced Electronic Signatures) / adbe.pkcs7.detached
 *
 * Fluxuri suportate:
 *   'tabel' → generează cartuș server-side + câmp PAdES în celula semnătarului curent
 *   'ancore' → câmp PAdES invizibil (vizualul e deja în ancorele PDF-ului)
 *
 * Algoritm (conform ETSI EN 319 132 / ISO 32000-2):
 *   1. buildSignaturePdf(pdfBuf, flowData, signerIdx) → { pdfBytes, byteRange }
 *      • Generează PDF cu cartuș (tabel) sau folosește PDF existent (ancore)
 *      • Adaugă câmp /Sig cu ByteRange placeholder (CAFEBABECAFEBABE + zeros)
 *      • Returnează bytes-ii PDF-ului pregătit + byteRange [b0,b1,b2,b3]
 *
 *   2. calcPadesHash(pdfBytes, byteRange) → base64 SHA-256
 *      • Hash-ul se calculează pe bytes[b0..b1] + bytes[b2..b2+b3]
 *      • Se trimite la STS ca hashByte
 *
 *   3. injectCmsSignature(pdfBytes, byteRange, cmsBase64) → Buffer
 *      • CMS-ul de la STS (base64 DER) e hex-encodat și injectat în placeholder
 *      • Returnează PDF-ul final semnat, verificabil în Adobe Reader/eIDAS
 */

import crypto from 'node:crypto';
import { logger } from '../middleware/logger.mjs';

// Placeholder 32KB = 65536 hex chars (STS QES tipic 4-12KB DER → 8-24K hex)
const PLACEHOLDER_BYTES = 32768;
const PLACEHOLDER_HEX_LEN = PLACEHOLDER_BYTES * 2;

// Marker unic: CAFEBABECAFEBABE + zeros
// pdf-lib serializează PDFHexString.of(str) ca <str> verbatim (nu re-encodează)
const MARKER_VALUE = 'CAFEBABECAFEBABE' + '0'.repeat(PLACEHOLDER_HEX_LEN - 16);
// Căutăm exact această secvență în PDF-ul serializat
const MARKER_SEARCH = Buffer.from('<CAFEBABECAFEBABE');

// Placeholder ByteRange cu valori mari (9 cifre) — spațiu suficient pentru orice PDF < 1GB
const BR_PLACEHOLDER = [0, 999999999, 999999999, 999999999];

function ro(t) {
  const m = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
  return String(t||'').split('').map(c => m[c]||c).join('');
}

// ── buildSignaturePdf ────────────────────────────────────────────────────────
/**
 * @param {Buffer}  pdfBuf    PDF original (din DB)
 * @param {object}  flowData  Date flux (flowType, signers, etc.)
 * @param {number}  signerIdx Index semnătar curent (0-based)
 * @returns {{ pdfBytes: Buffer, byteRange: number[] }}
 */
export async function buildSignaturePdf(pdfBuf, flowData, signerIdx) {
  const { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, rgb, StandardFonts } =
    await import('pdf-lib');

  const flowType = (flowData.flowType || 'tabel').toLowerCase();
  const signers  = Array.isArray(flowData.signers) ? flowData.signers : [];
  const signer   = signers[signerIdx];
  if (!signer) throw new Error(`PAdES: semnătarul la indexul ${signerIdx} lipsește`);

  const pdfDoc  = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const pages   = pdfDoc.getPages();
  const refPage = pages[pages.length - 1];
  const { width: pW, height: pH } = refPage.getSize();
  let drawPage  = refPage;
  let sigRect   = [0, 0, 0, 0]; // Rect câmp PAdES; 0,0,0,0 = invizibil

  // ── FLUX TABEL: cartuș server-side ─────────────────────────────────────
  if (flowType !== 'ancore') {
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const MARGIN  = 40;
    const n       = signers.length;
    const cols    = Math.min(n, 3);
    const rows    = Math.ceil(n / cols);
    const cellW   = (pW - MARGIN * 2) / cols;
    const cellH   = 48;
    const titleH  = 20;
    const cartusBottom = 36;
    const cartusH = rows * cellH + titleH;

    // Server-side: mereu pagină nouă (fără PDF.js pentru detecție spațiu)
    drawPage = pdfDoc.addPage([pW, pH]);

    // Bară titlu
    drawPage.drawRectangle({
      x: MARGIN, y: cartusBottom + cartusH - titleH,
      width: pW - MARGIN * 2, height: titleH,
      color: rgb(1,1,1), borderColor: rgb(0,0,0), borderWidth: 0.8,
    });
    drawPage.drawText('SEMNAT SI APROBAT', {
      x: MARGIN + 8, y: cartusBottom + cartusH - titleH + 6,
      size: 7, font: fontB, color: rgb(0,0,0),
    });

    signers.forEach((s, idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const cx  = MARGIN + col * cellW;
      const cy  = cartusBottom + (rows - 1 - row) * cellH;

      const isSigned = s.status === 'signed' && !!s.pdfUploaded;
      const bgColor  = isSigned ? rgb(.94,.98,.94) : rgb(.96,.96,.96);
      const brd      = rgb(.2,.2,.2);

      drawPage.drawRectangle({ x: cx,     y: cy,     width: cellW,   height: cellH,   color: bgColor, borderColor: brd, borderWidth: 1 });
      drawPage.drawRectangle({ x: cx+1.5, y: cy+1.5, width: cellW-3, height: cellH-3, color: bgColor, borderColor: brd, borderWidth: .35 });

      drawPage.drawText(ro(s.rol) || '—', {
        x: cx+6, y: cy+cellH-13, size: 7, font: fontB, color: rgb(.1,.1,.1), maxWidth: cellW-12,
      });
      const nameFunc = [ro(s.name), ro(s.functie)].filter(Boolean).join(' - ');
      if (nameFunc) drawPage.drawText(nameFunc, {
        x: cx+6, y: cy+cellH-24, size: 7, font: fontR, color: rgb(.1,.1,.1), maxWidth: cellW-12,
      });

      if (isSigned) {
        // Semnătar deja semnat — afișăm timestamp
        const signedTs = s.signedAt ? new Date(s.signedAt).toLocaleString('ro-RO') : '';
        if (signedTs) drawPage.drawText(signedTs, {
          x: cx+6, y: cy+8, size: 5.5, font: fontR, color: rgb(.5,.5,.5), maxWidth: cellW-12,
        });
        drawPage.drawText('QES', { x: cx+cellW-24, y: cy+8, size: 5.5, font: fontB, color: rgb(.0,.4,.0) });
      } else {
        const midY = cy + cellH/2 - 6;
        drawPage.drawText('L.S.', { x: cx+6, y: midY+4, size: 6.5, font: fontB, color: rgb(.5,.5,.6) });
        drawPage.drawText('Semnatura electronica', { x: cx+6, y: midY-5, size: 5.5, font: fontR, color: rgb(.6,.6,.6), maxWidth: cellW-12 });
      }

      if (idx === signerIdx) {
        sigRect = [cx, cy, cx + cellW, cy + cellH];
      }
    });
  }
  // ── FLUX ANCORE: câmp PAdES invizibil (vizualul e în ancorele PDF) ──────
  // sigRect rămâne [0,0,0,0]

  // ── AcroForm ────────────────────────────────────────────────────────────
  let acroForm;
  const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
  if (acroFormRef) {
    acroForm = pdfDoc.context.lookup(acroFormRef);
    try { acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } catch(e) {}
  } else {
    const afObj = pdfDoc.context.obj({
      Fields:   pdfDoc.context.obj([]),
      SigFlags: PDFNumber.of(3),
      DA:       PDFString.of('/Helv 0 Tf 0 g'),
    });
    const afRef = pdfDoc.context.register(afObj);
    pdfDoc.catalog.set(PDFName.of('AcroForm'), afRef);
    acroForm = afObj;
  }

  // Data PDF
  const now = new Date();
  const p2  = n => String(n).padStart(2,'0');
  const pdfDate = `D:${now.getFullYear()}${p2(now.getMonth()+1)}${p2(now.getDate())}` +
                  `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}+00'00'`;

  // Dict /Sig cu MARKER placeholder
  const sigValueRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type:      PDFName.of('Sig'),
    Filter:    PDFName.of('Adobe.PPKLite'),
    SubFilter: PDFName.of('adbe.pkcs7.detached'),
    ByteRange: pdfDoc.context.obj(BR_PLACEHOLDER.map(n => PDFNumber.of(n))),
    Contents:  PDFHexString.of(MARKER_VALUE),
    Reason:    PDFString.of('Semnatura electronica calificata QES - DocFlowAI'),
    Name:      PDFString.of(ro(signer.name || '')),
    Location:  PDFString.of('Romania'),
    M:         PDFString.of(pdfDate),
  }));

  // Widget annotation
  const sigWidgetRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Widget'),
    FT:      PDFName.of('Sig'),
    T:       PDFString.of(`SIG_QES_${signerIdx + 1}`),
    Rect:    pdfDoc.context.obj(sigRect.map(n => PDFNumber.of(n))),
    V:       sigValueRef,
    F:       PDFNumber.of(132),
    P:       drawPage.ref,
  }));

  // Adăugăm la pagina drawPage
  const existingAnnots = drawPage.node.get(PDFName.of('Annots'));
  if (existingAnnots) {
    try {
      const annotsArr = pdfDoc.context.lookup(existingAnnots);
      if (annotsArr && typeof annotsArr.push === 'function') annotsArr.push(sigWidgetRef);
    } catch(e) {
      drawPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([sigWidgetRef]));
    }
  } else {
    drawPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([sigWidgetRef]));
  }

  // Adăugăm la AcroForm.Fields
  try {
    const fieldsRef = acroForm.get(PDFName.of('Fields'));
    if (fieldsRef) {
      const fieldsArr = pdfDoc.context.lookup(fieldsRef);
      if (fieldsArr && typeof fieldsArr.push === 'function') {
        fieldsArr.push(sigWidgetRef);
      }
    } else {
      acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([sigWidgetRef]));
    }
  } catch(e) {
    logger.warn({ err: e }, 'PAdES: eroare la adăugarea câmpului în AcroForm.Fields (non-fatal)');
  }

  // ── Serializăm PDF ───────────────────────────────────────────────────────
  const savedBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  // ── Localizăm marker-ul ──────────────────────────────────────────────────
  const markerIdx = savedBytes.indexOf(MARKER_SEARCH);
  if (markerIdx < 0) {
    throw new Error('PAdES: marker-ul CAFEBABECAFEBABE nu a fost găsit după serializare');
  }

  // Contents în PDF: <CAFEBABECAFEBABE000...000>
  // markerIdx = poziția lui <
  // Hex content: PLACEHOLDER_HEX_LEN chars
  // > la: markerIdx + 1 + PLACEHOLDER_HEX_LEN
  const contentsStart = markerIdx;
  const contentsEnd   = markerIdx + 1 + PLACEHOLDER_HEX_LEN + 1; // poziția după >

  const byteRange = [0, contentsStart, contentsEnd, savedBytes.length - contentsEnd];

  // ── Patch ByteRange ──────────────────────────────────────────────────────
  _patchByteRange(savedBytes, byteRange);

  logger.info({ signerIdx, byteRange, pdfSize: savedBytes.length }, 'PAdES: PDF pregătit cu succes');
  return { pdfBytes: savedBytes, byteRange };
}

// ── calcPadesHash ────────────────────────────────────────────────────────────
/**
 * SHA-256 al bytes-ilor din afara Contents (byteRange[0..1] + byteRange[2..3]).
 * Acesta este hash-ul trimis la STS pentru semnare.
 */
export function calcPadesHash(pdfBytes, byteRange) {
  const [b0, b1, b2, b3] = byteRange;
  const hash = crypto.createHash('sha256');
  hash.update(pdfBytes.slice(b0, b0 + b1));
  hash.update(pdfBytes.slice(b2, b2 + b3));
  return hash.digest('base64');
}

// ── injectCmsSignature ───────────────────────────────────────────────────────
/**
 * Înlocuiește placeholder-ul CAFEBABECAFEBABE cu CMS-ul de la STS.
 * @param {Buffer}  pdfBytes  PDF pregătit (mutable)
 * @param {number[]} byteRange Același byteRange de la buildSignaturePdf
 * @param {string}  cmsBase64 CMS DER base64 de la STS (pollResult.signByte)
 * @returns {Buffer} PDF-ul final semnat PAdES
 */
export function injectCmsSignature(pdfBytes, byteRange, cmsBase64) {
  const cmsHex = Buffer.from(cmsBase64, 'base64').toString('hex').toUpperCase();
  if (cmsHex.length > PLACEHOLDER_HEX_LEN) {
    throw new Error(`PAdES: CMS prea mare (${cmsHex.length} > ${PLACEHOLDER_HEX_LEN} hex chars)`);
  }

  // Padding cu zero-uri
  const paddedHex = cmsHex + '0'.repeat(PLACEHOLDER_HEX_LEN - cmsHex.length);

  // Localizăm marker-ul și înlocuim conținutul (după <)
  const markerIdx = pdfBytes.indexOf(MARKER_SEARCH);
  if (markerIdx < 0) throw new Error('PAdES: marker CAFEBABECAFEBABE nu a fost găsit pentru injecție');

  Buffer.from(paddedHex, 'ascii').copy(pdfBytes, markerIdx + 1);

  logger.info({ cmsHexLen: cmsHex.length, pdfSize: pdfBytes.length }, 'PAdES: CMS injectat cu succes');
  return pdfBytes;
}

// ── Utilitar intern ──────────────────────────────────────────────────────────
function _patchByteRange(pdfBuf, byteRange) {
  const search   = Buffer.from('/ByteRange [');
  const pos      = pdfBuf.indexOf(search);
  if (pos < 0) {
    logger.warn('PAdES: /ByteRange [ nu a fost găsit — ByteRange nu a fost actualizat');
    return;
  }

  const startIdx = pos + search.length;
  let endIdx     = startIdx;
  while (endIdx < pdfBuf.length && pdfBuf[endIdx] !== 0x5D /* ] */) endIdx++;

  const oldLen    = endIdx - startIdx;
  const newContent= ` ${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]} `;

  if (newContent.length <= oldLen) {
    Buffer.from(newContent.padEnd(oldLen, ' '), 'ascii').copy(pdfBuf, startIdx);
  } else {
    // Nu ar trebui să se întâmple cu PDF-uri < 1GB și placeholder de 9 cifre
    logger.error({ oldLen, newLen: newContent.length }, 'PAdES: ByteRange nou prea lung pentru placeholder');
  }
}
