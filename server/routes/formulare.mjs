/**
 * DocFlowAI — server/routes/formulare.mjs
 *
 * Formulare oficiale: Ordonanțare de Plată (ORDNT) + Document de Fundamentare (NOTAFD)
 * Generare PDF A4 cu pdf-lib + NotoSans TTF (suport Unicode complet, diacritice române).
 *
 * REGISTRARE în server/index.mjs:
 *   import { formulareRouter } from './routes/formulare.mjs';
 *   app.use(formulareRouter);
 */

import { Router, json as expressJson } from 'express';
import { requireAuth }                  from '../middleware/auth.mjs';
import { logger }                       from '../middleware/logger.mjs';
import { pool }                          from '../db/index.mjs';
import fs                               from 'fs';
import path                             from 'path';
import { fileURLToPath }               from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router    = Router();
const _json5m   = expressJson({ limit: '15mb' });
const FONTS_DIR = path.resolve(__dirname, '../formulare/fonts');

// ── Transliterare fallback (folosit doar dacă NotoSans nu e disponibil) ───────

function ro(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/ă/g,'a').replace(/Ă/g,'A')
    .replace(/î/g,'i').replace(/Î/g,'I')
    .replace(/â/g,'a').replace(/Â/g,'A')
    .replace(/ș/g,'s').replace(/Ș/g,'S')
    .replace(/ş/g,'s').replace(/Ş/g,'S')
    .replace(/ț/g,'t').replace(/Ț/g,'T')
    .replace(/ţ/g,'t').replace(/Ţ/g,'T');
}

// ── Validare server-side ──────────────────────────────────────────────────────

function validateOrdnt(d) {
  const errs = [];
  if (!d.Cif)          errs.push('Cif obligatoriu');
  if (!d.DenInstPb)    errs.push('DenInstPb obligatoriu');
  if (!d.NrOrdonantPl) errs.push('NrOrdonantPl obligatoriu');
  if (!d.DataOrdontPl) errs.push('DataOrdontPl obligatoriu');
  if (!/^[1-9]\d{1,9}$/.test(d.Cif || '')) errs.push('Cif format invalid');
  if (!/^([1-9]|0[1-9]|[12][0-9]|3[01])\.([1-9]|0[1-9]|1[012])\.\d{4}$/.test(d.DataOrdontPl || ''))
    errs.push('DataOrdontPl format invalid (DD.MM.YYYY)');
  const df = d.docFd || {};
  if (!df.beneficiar)      errs.push('beneficiar obligatoriu');
  if (!df.iban_beneficiar) errs.push('iban_beneficiar obligatoriu');
  if (!df.cif_beneficiar)  errs.push('cif_beneficiar obligatoriu');
  if (!/^[1-9]\d{1,9}$/.test(df.cif_beneficiar || '')) errs.push('cif_beneficiar format invalid');
  if (!Array.isArray(df.rowTfd) || df.rowTfd.length === 0)
    errs.push('Cel putin un rand rowTfd obligatoriu');
  return errs;
}

function validateNotafd(d) {
  const errs = [];
  if (!d.Cif)            errs.push('Cif obligatoriu');
  if (!d.DenInstPb)      errs.push('DenInstPb obligatoriu');
  if (!d.SubtitluDF)     errs.push('SubtitluDF obligatoriu');
  if (!d.NrUnicInreg)    errs.push('NrUnicInreg obligatoriu');
  if (!d.Revizuirea)     errs.push('Revizuirea obligatorie');
  if (!d.DataRevizuirii) errs.push('DataRevizuirii obligatorie');
  if (!/^[1-9]\d{1,9}$/.test(d.Cif || '')) errs.push('Cif format invalid');
  if (!/^([1-9]|0[1-9]|[12][0-9]|3[01])\.([1-9]|0[1-9]|1[012])\.\d{4}$/.test(d.DataRevizuirii || ''))
    errs.push('DataRevizuirii format invalid (DD.MM.YYYY)');
  const sA = d.sectiuneaA || {};
  if (!sA.compartiment_specialitate) errs.push('compartiment_specialitate obligatoriu');
  if (!sA.obiect_fd_reviz_scurt)     errs.push('obiect_fd_reviz_scurt obligatoriu');
  const angV = sA.ang_legale_val || {};
  if (!Array.isArray(angV.rowT_ang_pl_val) || angV.rowT_ang_pl_val.length === 0)
    errs.push('Cel putin un rand ang_legale_val obligatoriu');
  return errs;
}

// ── Helper bife ───────────────────────────────────────────────────────────────

function isChecked(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

// ── Generare PDF cu pdf-lib + NotoSans ────────────────────────────────────────

async function generatePdfSimple(formType, data) {
  const { PDFDocument, rgb } = await import('pdf-lib');

  // ── Dimensiuni pagină A4 ────────────────────────────────────────────────────
  const W = 595.28, H = 841.89;
  const ML = 40, MR = 40, MT = 40, MB = 55;
  const CW = 515;                          // content width (W - ML - MR, rotunjit)

  // ── Font loading cu fallback la Helvetica ───────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  let fR, fB, unicode = false;
  try {
    const fontkit = await import('@pdf-lib/fontkit').then(m => m.default ?? m);
    pdfDoc.registerFontkit(fontkit);
    fR = await pdfDoc.embedFont(fs.readFileSync(path.join(FONTS_DIR, 'NotoSans-Regular.ttf')));
    fB = await pdfDoc.embedFont(fs.readFileSync(path.join(FONTS_DIR, 'NotoSans-Bold.ttf')));
    unicode = true;
  } catch (_) {
    logger.warn('formulare: NotoSans indisponibil, fallback Helvetica');
    const { StandardFonts } = await import('pdf-lib');
    fR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  // str(): returnează string-ul direct dacă NotoSans e OK, altfel transliterează
  const str = (v) => unicode ? String(v ?? '') : ro(v);

  // fmtNum(): format numeric ro-RO pentru PDF (1234.56 → "1.234,56")
  const fmtNum = (v, d = 2) => {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return String(v ?? '');
    return n.toLocaleString('ro-RO', { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  // ── Stare pagini ───────────────────────────────────────────────────────────
  const pages = [];
  let pg, y, pgNum = 0;
  const LH = 14;

  function drawContHdr() {
    // Header simplificat pentru paginile 2+
    const title = formType === 'ordnt' ? 'ORDONANȚARE DE PLATĂ' : 'DOCUMENT DE FUNDAMENTARE';
    const ref   = formType === 'ordnt' ? (data.NrOrdonantPl || '') : (data.NrUnicInreg || '');
    pg.drawText(str(`${title}${ref ? ' — Nr. ' + ref : ''} (continuare)`),
      { x: ML, y, font: fB, size: 8, color: rgb(0.3, 0.3, 0.3) });
    y -= 11;
    pg.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y },
      thickness: 0.3, color: rgb(0.7, 0.7, 0.7) });
    y -= 8;
  }

  function newPage() {
    pgNum++;
    pg = pdfDoc.addPage([W, H]);
    pages.push(pg);
    y = H - MT;
    if (pgNum > 1) drawContHdr();
  }

  function ensureY(need) {
    if (y - need < MB + 5) newPage();
  }

  // ── Primitive de desenare ──────────────────────────────────────────────────

  function tw(text, font, size) {
    return font.widthOfTextAtSize(String(text ?? ''), size);
  }

  function clamp(s, font, size, maxW) {
    let t = String(s ?? '');
    if (tw(t, font, size) <= maxW) return t;
    while (t.length && tw(t + '…', font, size) > maxW) t = t.slice(0, -1);
    return t.length ? t + '…' : '';
  }

  function txt(text, x, yy, { font = fR, size = 9, color = rgb(0, 0, 0) } = {}) {
    const s = str(text);
    if (!s) return;
    pg.drawText(s, { x, y: yy, font, size, color });
  }

  function centered(text, yy, { font = fR, size = 11 } = {}) {
    const s = str(text);
    txt(s, ML + (CW - tw(s, font, size)) / 2, yy, { font, size });
  }

  function rightTxt(text, yy, { font = fR, size = 9 } = {}) {
    const s = str(text);
    txt(s, ML + CW - tw(s, font, size), yy, { font, size });
  }

  function hline(yy, { thickness = 0.5, color = rgb(0, 0, 0) } = {}) {
    pg.drawLine({ start: { x: ML, y: yy }, end: { x: ML + CW, y: yy }, thickness, color });
  }

  function dashed(x1, yy, x2) {
    const c = rgb(0.65, 0.65, 0.65);
    let cx = x1;
    while (cx < x2 - 1) {
      const ex = Math.min(cx + 3.5, x2);
      pg.drawLine({ start: { x: cx, y: yy }, end: { x: ex, y: yy }, thickness: 0.3, color: c });
      cx += 5.5;
    }
  }

  // Căsuță de bifare vizuală (9×9 pt cu bifă ✓ desenată cu linii)
  function drawCheckbox(x, yy, checked) {
    pg.drawRectangle({
      x, y: yy - 1, width: 9, height: 9,
      borderColor: rgb(0, 0, 0), borderWidth: 0.8, color: rgb(1, 1, 1),
    });
    if (isChecked(checked)) {
      pg.drawLine({ start: { x: x + 1.5, y: yy + 4   }, end: { x: x + 3.5, y: yy + 1.5 }, thickness: 1.2, color: rgb(0, 0, 0) });
      pg.drawLine({ start: { x: x + 3.5, y: yy + 1.5 }, end: { x: x + 8,   y: yy + 7.5 }, thickness: 1.2, color: rgb(0, 0, 0) });
    }
  }

  // ── Elemente compuse ───────────────────────────────────────────────────────

  function secTitle(t, { size = 9.5 } = {}) {
    ensureY(LH + 4);
    y -= 4;
    txt(t, ML, y, { font: fB, size });
    y -= LH;
  }

  function fieldLine(label, value, { size = 8, indent = 0 } = {}) {
    const lbl = str(label) + ': ';
    const lw  = tw(lbl, fB, size);
    const valX = ML + indent + lw;
    const valW = CW - indent - lw;
    const val  = str(value);
    ensureY(LH);
    txt(lbl, ML + indent, y, { font: fB, size });
    txt(clamp(val, fR, size, valW), valX, y, { font: fR, size });
    y -= LH;
  }

  function checkItem(checked, label, { size = 8, indent = 0 } = {}) {
    const cbX = ML + indent;
    const lblW = CW - indent - 14;
    const lines = wrapText(str(label), fR, size, lblW, 4);
    const lineH = size + 2;
    const totalH = Math.max(LH, lines.length * lineH);
    ensureY(totalH);
    drawCheckbox(cbX, y, checked);
    for (let i = 0; i < lines.length; i++) {
      txt(lines[i], cbX + 13, y - i * lineH, { font: fR, size });
    }
    y -= totalH;
  }

  // Tabel cu header gri (poate fi pe 2 rânduri: titlu + numere coloane),
  // rânduri alternante, rând TOTAL opțional, borduri 0.4pt.
  // cols: [{ header, key, width, numeric?, numLabel?, totalText? }]
  //   header   = denumire completă conform ghid OMF (afișat pe rând 1 al header-ului, wrap permis)
  //   numLabel = textul numerotării coloanei (ex. "1", "7=5+6", "5 = (col.2)-(col.3)-(col.4)")
  //   totalText = "X" pentru coloane text marcate, undefined pentru numerice (se calculează suma),
  //               sau string explicit (ex. "TOTAL" pe prima coloană)
  // Dacă cel puțin un col are numLabel → se desenează rândul de numerotare sub headerul cu titluri.
  // Dacă opțiunea totals === true → se desenează rândul TOTAL la final (sume pe coloane numerice,
  //                                  totalText pe coloane text).
  function drawTable(cols, rows, opts = {}) {
    const totals = !!opts.totals;
    const HDR_FS = 6.5;          // font size header
    const HDR_LH = 7.5;          // line height header
    const HDR_PAD = 6;           // padding vertical total în header (3pt sus + 3pt jos)
    const MAX_HDR_LINES = 10;    // suficient pentru SecB DF (header ~92 chars pe ~49pt → ~7 linii)
    const hasNumRow = cols.some(c => c.numLabel != null);
    const HH2 = hasNumRow ? 11 : 0;
    const RH  = 13;
    const TH  = totals ? 13 : 0;

    // ── Pre-calcul: wrap headers + înălțime dinamică HH1 ───────────────────
    let maxHdrLines = 1;
    const wrappedHdrs = cols.map(col => {
      const lines = wrapText(str(col.header), fB, HDR_FS, col.width - 4, MAX_HDR_LINES);
      if (lines.length > maxHdrLines) maxHdrLines = lines.length;
      return lines;
    });
    const HH1 = maxHdrLines * HDR_LH + HDR_PAD;

    ensureY(HH1 + HH2 + RH * Math.min(Math.max(rows.length, 1), 3) + TH);

    // ── Header rând 1: titluri (înălțime dinamică, vertical-centered) ──────
    pg.drawRectangle({ x: ML, y: y - HH1, width: CW, height: HH1,
      color: rgb(0.88, 0.88, 0.88), borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
    let cx = ML;
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const lines = wrappedHdrs[i];
      const blockH = lines.length * HDR_LH;
      const startY = y - HH1 / 2 + blockH / 2 - HDR_LH + 1;
      for (let li = 0; li < lines.length; li++) {
        const lw = tw(lines[li], fB, HDR_FS);
        pg.drawText(lines[li], { x: cx + (col.width - lw) / 2, y: startY - li * HDR_LH,
          font: fB, size: HDR_FS, color: rgb(0, 0, 0) });
      }
      if (i < cols.length - 1)
        pg.drawLine({ start: { x: cx + col.width, y }, end: { x: cx + col.width, y: y - HH1 },
          thickness: 0.4, color: rgb(0, 0, 0) });
      cx += col.width;
    }
    y -= HH1;

    // ── Header rând 2: numerotare coloane (1, 2, ..., 7=5+6) ────────────────
    if (hasNumRow) {
      pg.drawRectangle({ x: ML, y: y - HH2, width: CW, height: HH2,
        color: rgb(0.94, 0.94, 0.94), borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
      cx = ML;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const lbl = col.numLabel != null ? str(col.numLabel) : '';
        if (lbl) {
          const lw = tw(lbl, fB, 6.5);
          pg.drawText(lbl, { x: cx + (col.width - lw) / 2, y: y - HH2 + 3,
            font: fB, size: 6.5, color: rgb(0, 0, 0) });
        }
        if (i < cols.length - 1)
          pg.drawLine({ start: { x: cx + col.width, y }, end: { x: cx + col.width, y: y - HH2 },
            thickness: 0.4, color: rgb(0, 0, 0) });
        cx += col.width;
      }
      y -= HH2;
    }

    // ── Rânduri date (wrap text, înălțime dinamică) ──────────────────────────
    const ROW_LH = 8;
    const ROW_PAD = 5;
    const ROW_FS = 7;
    const dataRows = rows.length ? rows : [null];
    for (let ri = 0; ri < dataRows.length; ri++) {
      const row = dataRows[ri];
      if (row === null) {
        ensureY(RH);
        const bg = rgb(1, 1, 1);
        pg.drawRectangle({ x: ML, y: y - RH, width: CW, height: RH,
          color: bg, borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
        pg.drawText(str('(nicio înregistrare)'), { x: ML + 4, y: y - RH + 4,
          font: fR, size: ROW_FS, color: rgb(0.5, 0.5, 0.5) });
        y -= RH;
        continue;
      }
      const cellWraps = [];
      const cellFonts = [];
      let maxLines = 1;
      for (const col of cols) {
        const rawVal = row[col.key] ?? '';
        const cellPad = col.width - 4;
        let fs = ROW_FS;
        let lines;
        if (col.numeric) {
          const numStr = str(fmtNum(rawVal));
          if (tw(numStr, fR, fs) > cellPad) {
            for (fs = 6.5; fs >= 6; fs -= 0.5) {
              if (tw(numStr, fR, fs) <= cellPad) break;
            }
          }
          lines = tw(numStr, fR, fs) <= cellPad
            ? [numStr]
            : wrapText(numStr, fR, fs, cellPad);
        } else if (col.shrink) {
          // Coloane de cod (Cod SSI, Cod angajament, Program): valoarea trebuie să
          // rămână pe UN SINGUR RÂND. Micșorăm fontul 7 → 5,5pt înainte de a accepta
          // wrap-ul. Niciodată trunchiere (fără „…").
          const codeStr = str(rawVal);
          if (tw(codeStr, fR, fs) > cellPad) {
            for (fs = 6.5; fs >= 5.5; fs -= 0.5) {
              if (tw(codeStr, fR, fs) <= cellPad) break;
            }
          }
          lines = tw(codeStr, fR, fs) <= cellPad
            ? [codeStr]
            : wrapText(codeStr, fR, fs, cellPad);
        } else {
          lines = wrapText(str(rawVal), fR, fs, cellPad);
        }
        cellWraps.push(lines);
        cellFonts.push(fs);
        if (lines.length > maxLines) maxLines = lines.length;
      }
      const rowH = Math.max(RH, maxLines * ROW_LH + ROW_PAD);
      ensureY(rowH);
      const bg = ri % 2 === 0 ? rgb(1, 1, 1) : rgb(0.96, 0.96, 0.96);
      pg.drawRectangle({ x: ML, y: y - rowH, width: CW, height: rowH,
        color: bg, borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
      cx = ML;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const lines = cellWraps[i];
        const fs = cellFonts[i];
        for (let li = 0; li < lines.length; li++) {
          const lw = tw(lines[li], fR, fs);
          const tx = col.numeric ? cx + col.width - 3 - lw : cx + 2;
          pg.drawText(lines[li], { x: tx, y: y - ROW_PAD / 2 - ROW_LH * (li + 1) + 2,
            font: fR, size: fs, color: rgb(0, 0, 0) });
        }
        if (i < cols.length - 1)
          pg.drawLine({ start: { x: cx + col.width, y }, end: { x: cx + col.width, y: y - rowH },
            thickness: 0.4, color: rgb(0, 0, 0) });
        cx += col.width;
      }
      y -= rowH;
    }

    // ── Rând TOTAL ──────────────────────────────────────────────────────────
    if (totals) {
      ensureY(TH);
      pg.drawRectangle({ x: ML, y: y - TH, width: CW, height: TH,
        color: rgb(0.92, 0.92, 0.92), borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
      cx = ML;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        let cellTxt;
        if (col.numeric) {
          const sum = rows.reduce((s, r) => s + (parseFloat(r[col.key]) || 0), 0);
          cellTxt = str(fmtNum(sum));
        } else {
          cellTxt = str(col.totalText || '');
        }
        const cw = tw(cellTxt, fB, 7);
        const tx = col.numeric ? cx + col.width - 3 - cw : cx + (col.width - cw) / 2;
        pg.drawText(cellTxt, { x: tx, y: y - TH + 4, font: fB, size: 7, color: rgb(0, 0, 0) });
        if (i < cols.length - 1)
          pg.drawLine({ start: { x: cx + col.width, y }, end: { x: cx + col.width, y: y - TH },
            thickness: 0.4, color: rgb(0, 0, 0) });
        cx += col.width;
      }
      y -= TH;
    }

    y -= 5;
  }

  // ── Helper: wrap text pe mai multe linii, cu char-level break pt cuvinte lungi
  function wrapText(text, font, size, maxW, maxLines = 999) {
    const t = String(text ?? '');
    if (!t) return [''];
    const words = t.split(/\s+/);
    const lines = [];
    let current = '';
    for (const w of words) {
      if (tw(w, font, size) > maxW) {
        if (current) { lines.push(current); current = ''; }
        if (lines.length >= maxLines) break;
        let chunk = '';
        for (const ch of w) {
          if (tw(chunk + ch, font, size) > maxW && chunk) {
            lines.push(chunk); chunk = ch;
            if (lines.length >= maxLines) break;
          } else { chunk += ch; }
        }
        if (lines.length >= maxLines) break;
        current = chunk;
        continue;
      }
      const trial = current ? current + ' ' + w : w;
      if (tw(trial, font, size) <= maxW) {
        current = trial;
      } else {
        if (current) lines.push(current);
        current = w;
        if (lines.length >= maxLines - 1) break;
      }
    }
    if (current && lines.length < maxLines) lines.push(current);
    return lines.length ? lines : [''];
  }

  // ── Header document ────────────────────────────────────────────────────────

  function drawDocHeader() {
    if (formType === 'notafd') {
      // ── Antet DF conform ghid OMF (Capitolul III) ──────────────────────
      // Rând 1: "Instituția publică:" + valoare (full-width, înrămat)
      const rowH1 = 16;
      pg.drawRectangle({ x: ML, y: y - rowH1, width: CW, height: rowH1,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Instituția publică:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW1 = tw('Instituția publică:', fB, 8.5) + 8;
      txt(clamp(str(data.DenInstPb || ''), fR, 9, CW - lblW1 - 6),
          ML + lblW1, y - 11, { font: fR, size: 9 });
      y -= rowH1 + 2;

      // Rând 2: "Cod de identificare fiscală:" + valoare
      const rowH2 = 16;
      pg.drawRectangle({ x: ML, y: y - rowH2, width: CW, height: rowH2,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Cod de identificare fiscală:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW2 = tw('Cod de identificare fiscală:', fB, 8.5) + 8;
      txt(clamp(str(data.Cif || ''), fR, 9, CW - lblW2 - 6),
          ML + lblW2, y - 11, { font: fR, size: 9 });
      y -= rowH2 + 18;

      // Titlu centrat
      centered('DOCUMENT DE FUNDAMENTARE', y, { font: fB, size: 14 });
      y -= 20;

      // Casetă subtitlu (Obiectul DF) — full-width, încadrat
      const subH = 28;
      pg.drawRectangle({ x: ML, y: y - subH, width: CW, height: subH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const subStr = clamp(str(data.SubtitluDF || ''), fR, 10, CW - 8);
      const subW = tw(subStr, fR, 10);
      txt(subStr, ML + (CW - subW) / 2, y - subH / 2 - 3, { font: fR, size: 10 });
      y -= subH + 8;

      // Rând: "Numar unic de inregistrare" / "revizuirea" / "data" în 3 sub-celule
      const rowH3 = 16;
      pg.drawRectangle({ x: ML, y: y - rowH3, width: CW, height: rowH3,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const cell1W = CW * 0.5;
      txt('Numar unic de inregistrare:', ML + 4, y - 11, { font: fB, size: 8 });
      const lblNr = tw('Numar unic de inregistrare:', fB, 8) + 8;
      txt(clamp(str(data.NrUnicInreg || ''), fR, 8.5, cell1W - lblNr - 6),
          ML + lblNr, y - 11, { font: fR, size: 8.5 });
      pg.drawLine({ start: { x: ML + cell1W, y }, end: { x: ML + cell1W, y: y - rowH3 },
        thickness: 0.4, color: rgb(0, 0, 0) });
      const cell2X = ML + cell1W;
      const cell2W = CW * 0.25;
      txt('revizuirea:', cell2X + 4, y - 11, { font: fB, size: 8 });
      const lblRev = tw('revizuirea:', fB, 8) + 8;
      txt(clamp(str(data.Revizuirea || ''), fR, 8.5, cell2W - lblRev - 6),
          cell2X + lblRev, y - 11, { font: fR, size: 8.5 });
      pg.drawLine({ start: { x: cell2X + cell2W, y }, end: { x: cell2X + cell2W, y: y - rowH3 },
        thickness: 0.4, color: rgb(0, 0, 0) });
      const cell3X = cell2X + cell2W;
      txt('/ data:', cell3X + 4, y - 11, { font: fB, size: 8 });
      const lblData = tw('/ data:', fB, 8) + 8;
      txt(clamp(str(data.DataRevizuirii || ''), fR, 8.5, ML + CW - cell3X - lblData - 6),
          cell3X + lblData, y - 11, { font: fR, size: 8.5 });
      y -= rowH3 + 14;

      // Checkbox "obligație legală terț"
      const cbY = y;
      drawCheckbox(ML, cbY, data.ckbx_oblig_tert);
      const lblObligTxt = 'se referă la angajamente legale care se emit ca urmare a unei obligații legale sau de către un terț';
      txt(clamp(str(lblObligTxt), fR, 8, CW - 16), ML + 14, cbY, { font: fR, size: 8 });
      y -= 14;
    } else {
      // ── Antet ORD conform ghid OMF (Capitolul IV) ───────────────────────
      // Rând 1: "Instituția publică:" + valoare (full-width, încadrat)
      const rowH1o = 16;
      pg.drawRectangle({ x: ML, y: y - rowH1o, width: CW, height: rowH1o,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Instituția publică:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW1o = tw('Instituția publică:', fB, 8.5) + 8;
      txt(clamp(str(data.DenInstPb || ''), fR, 9, CW - lblW1o - 6),
          ML + lblW1o, y - 11, { font: fR, size: 9 });
      y -= rowH1o + 2;

      // Rând 2: "Cod de identificare fiscală:" + valoare
      const rowH2o = 16;
      pg.drawRectangle({ x: ML, y: y - rowH2o, width: CW, height: rowH2o,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Cod de identificare fiscală:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW2o = tw('Cod de identificare fiscală:', fB, 8.5) + 8;
      txt(clamp(str(data.Cif || ''), fR, 9, CW - lblW2o - 6),
          ML + lblW2o, y - 11, { font: fR, size: 9 });
      y -= rowH2o + 18;

      // Titlu centrat
      centered('ORDONANȚARE DE PLATĂ', y, { font: fB, size: 14 });
      y -= 20;

      // Rând "nr." + valoare | "/ data" + valoare (2 sub-celule)
      const rowH3o = 16;
      pg.drawRectangle({ x: ML, y: y - rowH3o, width: CW, height: rowH3o,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const cellNrW = CW * 0.5;
      txt('nr.', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblNrO = tw('nr.', fB, 8.5) + 8;
      txt(clamp(str(data.NrOrdonantPl || ''), fR, 9, cellNrW - lblNrO - 6),
          ML + lblNrO, y - 11, { font: fR, size: 9 });
      pg.drawLine({ start: { x: ML + cellNrW, y }, end: { x: ML + cellNrW, y: y - rowH3o },
        thickness: 0.4, color: rgb(0, 0, 0) });
      txt('/ data', ML + cellNrW + 4, y - 11, { font: fB, size: 8.5 });
      const lblDataO = tw('/ data', fB, 8.5) + 8;
      txt(clamp(str(data.DataOrdontPl || ''), fR, 9, CW - cellNrW - lblDataO - 6),
          ML + cellNrW + lblDataO, y - 11, { font: fR, size: 9 });
      y -= rowH3o + 6;
    }
    y -= 4;
  }

  // ── Conținut NOTAFD ────────────────────────────────────────────────────────

  function buildNotafd() {
    const sA = data.sectiuneaA || {};

    // ── Secțiunea A: Obiectul documentului de fundamentare ─────────────────
    secTitle('Secțiunea A: Obiectul documentului de fundamentare');

    fieldLine('1. Compartiment de specialitate', sA.compartiment_specialitate);
    fieldLine('2. Descrierea pe scurt a obiectului documentului de fundamentare/motivul revizuirii',
              sA.obiect_fd_reviz_scurt);

    // 3. Descrierea pe larg — casetă text mare (multiline)
    if (sA.obiect_fd_reviz_lung) {
      ensureY(LH);
      txt('3. Descrierea pe larg a stării de fapt și de drept:', ML, y, { font: fB, size: 8.5 });
      y -= LH;
      const longTxt = str(sA.obiect_fd_reviz_lung);
      const lines = wrapText(longTxt, fR, 8.5, CW - 8, 12);
      const boxH = Math.max(40, lines.length * 11 + 8);
      ensureY(boxH + 4);
      pg.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      for (let i = 0; i < lines.length; i++) {
        txt(lines[i], ML + 4, y - 8 - i * 11, { font: fR, size: 8.5 });
      }
      y -= boxH + 6;
    }

    // ── 4. Valoarea angajamentelor legale ───────────────────────────────────
    y -= 2;
    ensureY(LH);
    txt('4. Valoarea angajamentelor legale (pe toată perioada de valabilitate a documentului de fundamentare):',
        ML, y, { font: fB, size: 8.5 });
    y -= LH;

    const angV = sA.ang_legale_val || {};
    checkItem(angV.ckbx_stab_tin_cont, 'Se stabilește ținând cont de:');

    y -= 2;
    drawTable([
      { header: 'Element de fundamentare',                  key: 'element_fd',    width: 92,
        numLabel: '1', totalText: 'TOTAL' },
      { header: 'Program',                                  key: 'program',       width: 52,
        numLabel: '2', totalText: 'X', shrink: true },
      { header: 'Cod SSI',                                  key: 'codSSI',        width: 74,
        numLabel: '3', totalText: 'X', shrink: true },
      { header: 'Parametrii de fundamentare',               key: 'param_fd',      width: 72,
        numLabel: '4', totalText: 'X' },
      { header: 'Valoare totală revizie precedentă (lei)',  key: 'valt_rev_prec', width: 65,
        numLabel: '5', numeric: true },
      { header: 'Influențe +/- (lei)',                      key: 'influente',     width: 55,
        numLabel: '6', numeric: true },
      { header: 'Valoarea totală actualizată (lei)',        key: 'valt_actualiz', width: CW - 92 - 52 - 74 - 72 - 65 - 55,
        numLabel: '7=5+6', numeric: true },
    ], Array.isArray(angV.rowT_ang_pl_val) ? angV.rowT_ang_pl_val : [], { totals: true });

    if (isChecked(angV.ckbx_ramane_suma)) {
      ensureY(LH);
      drawCheckbox(ML, y, true);
      const sumStr = (angV.ramane_suma || angV.ramane_suma === 0) ? fmtNum(angV.ramane_suma) : '_____________';
      const lbl = `rămâne în suma de ${sumStr} lei conform fundamentării aprobate într-o revizuire anterioară a prezentului document de fundamentare`;
      txt(clamp(str(lbl), fR, 8, CW - 16), ML + 14, y, { font: fR, size: 8 });
      y -= LH;
    }

    // ── 5. Angajamente legale ───────────────────────────────────────────────
    y -= 4;
    ensureY(LH);
    txt('5. Angajamente legale', ML, y, { font: fB, size: 8.5 });
    y -= LH;

    const angP = sA.ang_legale_plati || {};

    // Opțiunea 1: niciun angajament
    checkItem(angP.ckbx_fara_ang_emis_ancrt,
      'niciun angajament legal nu a fost emis și în anul curent nu se anticipează emiterea niciunui angajament legal');

    // Opțiunea 2: în anul curent se anticipează... (cu 3 sub-opțiuni)
    checkItem(angP.ckbx_cu_ang_emis_ancrt,
      'în anul curent se anticipează emiterea a cel puțin unui angajament legal / au fost emise angajamente legale / se înregistrează creșteri ale valorii angajamentelor legale emise în anii precedenți. În ceea ce privește plățile, intenția este de a:');

    // 3 sub-opțiuni indentate (16pt)
    checkItem(angP.ckbx_sting_ang_in_ancrt,
      'se sting în anul curent toate obligațiile de plată', { indent: 16 });
    checkItem(angP.ckbx_fara_plati_ang_in_ancrt,
      'nu se efectuează plăți în anul curent, planificarea acestora fiind cea din tabelul de mai jos', { indent: 16 });
    checkItem(angP.ckbx_cu_plati_ang_in_mmani,
      'se efectuează plăți timp de mai mulți ani bugetari, planificarea acestora fiind cea din tabelul de mai jos', { indent: 16 });

    // Tabel pct 5 — 8 coloane numerotate + TOTAL
    const rowsPlati = Array.isArray(angP.rowT_ang_pl_plati) ? angP.rowT_ang_pl_plati : [];
    y -= 2;
    const wPlProg = 60;                                        // Program
    const wPlSSI  = 72;                                        // Cod SSI — lățit (cod pe 1 rând)
    const wPl = Math.floor((CW - wPlProg - wPlSSI) / 6);       // 6 coloane numerice
    drawTable([
      { header: 'Program',                              key: 'program',                width: wPlProg,
        numLabel: '1', totalText: 'TOTAL', shrink: true },
      { header: 'Cod SSI',                              key: 'codSSI',                 width: wPlSSI,
        numLabel: '2', totalText: 'X', shrink: true },
      { header: 'Plăți ani precedenți (lei)',           key: 'plati_ani_precedenti',   width: wPl,
        numLabel: '3', numeric: true },
      { header: 'Plăți estimate an curent (lei)',       key: 'plati_estim_ancrt',      width: wPl,
        numLabel: '4', numeric: true },
      { header: 'Plăți estimate an n+1 (lei)',          key: 'plati_estim_an_np1',     width: wPl,
        numLabel: '5', numeric: true },
      { header: 'Plăți estimate an n+2 (lei)',          key: 'plati_estim_an_np2',     width: wPl,
        numLabel: '6', numeric: true },
      { header: 'Plăți estimate an n+3 (lei)',          key: 'plati_estim_an_np3',     width: wPl,
        numLabel: '7', numeric: true },
      { header: 'Plăți estimate ani ulteriori (lei)',   key: 'plati_estim_ani_ulter',  width: CW - wPlProg - wPlSSI - wPl * 5,
        numLabel: '8', numeric: true },
    ], rowsPlati, { totals: true });

    y -= 8;
    // Opțiunea 3 (sub tabel)
    checkItem(angP.ckbx_ang_leg_emise_ct_an_urm,
      'Angajamentele legale se vor emite în contul anului următor');

    // ── Secțiunea B ─────────────────────────────────────────────────────────
    y -= 6;
    secTitle('Secțiunea B: Situația evidențiată în sistemul de control al angajamentelor');

    const sB = data.sectiuneaB || {};

    checkItem(sB.ckbx_secta_inreg_ctrl_ang,
      'Propunerile de la secțiunea A au fost înregistrate în sistemul de control al angajamentelor după cum urmează:');

    // Tabel SecB — 10 coloane numerotate cu 7=5+6 și 10=8+9 + TOTAL
    const rowsCtrl = Array.isArray(sB.rowT_ang_ctrl_ang) ? sB.rowT_ang_ctrl_ang : [];
    y -= 2;
    const wCtAng  = 54;   // Cod angajament
    const wCtInd  = 46;   // Indicator angajament
    const wCtProg = 46;   // Program
    const wCtSSI  = 72;   // Cod SSI — lățit (cod pe 1 rând)
    const wCt = Math.floor((CW - wCtAng - wCtInd - wCtProg - wCtSSI) / 6);  // 6 coloane numerice
    drawTable([
      { header: 'Cod angajament',                                                                              key: 'cod_angajament',               width: wCtAng,
        numLabel: '1', totalText: 'TOTAL', shrink: true },
      { header: 'Indicator angajament',                                                                        key: 'indicator_angajament',         width: wCtInd,
        numLabel: '2', totalText: 'X', shrink: true },
      { header: 'Program',                                                                                     key: 'program',                      width: wCtProg,
        numLabel: '3', totalText: 'X', shrink: true },
      { header: 'Cod SSI',                                                                                     key: 'cod_SSI',                      width: wCtSSI,
        numLabel: '4', totalText: 'X', shrink: true },
      { header: 'Suma rezervată din credite de angajament pentru anul curent aferentă reviziei precedente (lei)', key: 'sum_rezv_crdt_ang_af_rvz_prc', width: wCt,
        numLabel: '5', numeric: true },
      { header: 'Influențe +/- (lei)',                                                                         key: 'influente_c6',                 width: wCt,
        numLabel: '6', numeric: true },
      { header: 'Suma rezervată din credite de angajament pentru anul curent actualizată (lei)',               key: 'sum_rezv_crdt_ang_act',        width: wCt,
        numLabel: '7=5+6', numeric: true },
      { header: 'Suma rezervată din credite bugetare pentru anul curent aferentă reviziei precedente (lei)',   key: 'sum_rezv_crdt_bug_af_rvz_prc', width: wCt,
        numLabel: '8', numeric: true },
      { header: 'Influențe +/- (lei)',                                                                         key: 'influente_c9',                 width: wCt,
        numLabel: '9', numeric: true },
      { header: 'Suma rezervată din credite bugetare pentru anul curent actualizată (lei)',                    key: 'sum_rezv_crdt_bug_act',        width: CW - wCtAng - wCtInd - wCtProg - wCtSSI - wCt * 5,
        numLabel: '10=8+9', numeric: true },
    ], rowsCtrl, { totals: true });

    // ── Caseta finală SecB: "Nu s-au rezervat..." ──────────────────────────
    if (isChecked(sB.ckbx_fara_inreg_ctrl_ang)) {
      ensureY(LH);
      drawCheckbox(ML, y, true);
      const sumCa = sB.sum_fara_inreg_ctrl_crdbug ? fmtNum(sB.sum_fara_inreg_ctrl_crdbug) : '_______';
      const sumCb = sB.sum_fara_inreg_ctrl_crd_bug ? fmtNum(sB.sum_fara_inreg_ctrl_crd_bug) : '_______';
      const lblFara = `Nu s-au rezervat în sistemul de control al angajamentelor credite de angajament în cuantum de ${sumCa} lei, respectiv credite bugetare în cuantum de ${sumCb} lei`;
      const wrappedFara = wrapText(str(lblFara), fR, 8, CW - 16, 3);
      for (let i = 0; i < wrappedFara.length; i++) {
        txt(wrappedFara[i], ML + 14, y - i * 10, { font: fR, size: 8 });
      }
      y -= 10 * wrappedFara.length;

      if (isChecked(sB.ckbx_interzis_emit_ang)) {
        ensureY(LH);
        drawCheckbox(ML + 14, y, true);
        const lblIns = 'întrucât creditele de angajament și/sau creditele bugetare sunt insuficiente. Din acest motiv, este interzisă emiterea de noi angajamente legale din inițiativa instituției publice la codul SSI și programul la care creditele de angajament și/sau bugetare sunt insuficiente';
        const wrappedIns = wrapText(str(lblIns), fR, 8, CW - 30, 3);
        for (let i = 0; i < wrappedIns.length; i++) {
          txt(wrappedIns[i], ML + 28, y - i * 10, { font: fR, size: 8 });
        }
        y -= 10 * wrappedIns.length;
      }

      if (isChecked(sB.ckbx_interzis_intrucat)) {
        ensureY(LH);
        drawCheckbox(ML + 14, y, true);
        txt('întrucât:', ML + 28, y, { font: fR, size: 8 });
        y -= LH;
        if (sB.intrucat) {
          const motivH = 24;
          ensureY(motivH + 2);
          pg.drawRectangle({ x: ML + 14, y: y - motivH, width: CW - 14, height: motivH,
            borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
          const motivLines = wrapText(str(sB.intrucat), fR, 8, CW - 22, 2);
          for (let i = 0; i < motivLines.length; i++) {
            txt(motivLines[i], ML + 18, y - 8 - i * 10, { font: fR, size: 8 });
          }
          y -= motivH + 4;
        }
      }
    }
  }

  // ── Conținut ORDNT ─────────────────────────────────────────────────────────

  function buildOrdnt() {
    const df = data.docFd || {};

    // ── Numar unic de inregistrare al documentului de fundamentare ─────────
    const rowDfH = 16;
    ensureY(rowDfH + 4);
    pg.drawRectangle({ x: ML, y: y - rowDfH, width: CW, height: rowDfH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Numar unic de inregistrare al documentului de fundamentare:',
        ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblNrDf = tw('Numar unic de inregistrare al documentului de fundamentare:', fB, 8.5) + 8;
    txt(clamp(str(df.nr_unic_inreg || ''), fR, 9, CW - lblNrDf - 6),
        ML + lblNrDf, y - 11, { font: fR, size: 9 });
    y -= rowDfH + 6;

    // ── Tabel detalii plată — 8 coloane cu sub-numerotare (1.1-1.4) și (2-5) ──
    drawTable([
      { header: 'Cod angajament',                  key: 'cod_angajament',         width: 66,
        numLabel: '1.1', totalText: 'TOTAL', shrink: true },
      { header: 'Indicator angajament',            key: 'indicator_angajament',   width: 46,
        numLabel: '1.2', totalText: 'X', shrink: true },
      { header: 'Program',                         key: 'program',                width: 48,
        numLabel: '1.3', totalText: 'X', shrink: true },
      { header: 'Cod SSI',                         key: 'cod_SSI',                width: 74,
        numLabel: '1.4', totalText: 'X', shrink: true },
      { header: 'Recepții (lei)',                  key: 'receptii',               width: 56,
        numLabel: '2', numeric: true },
      { header: 'Plăți anterioare (lei)',          key: 'plati_anterioare',       width: 58,
        numLabel: '3', numeric: true },
      { header: 'Suma ordonanțată la plată (lei)', key: 'suma_ordonantata_plata', width: 64,
        numLabel: '4', numeric: true },
      { header: 'Recepții neplătite (lei)',        key: 'receptii_neplatite',     width: CW - 66 - 46 - 48 - 74 - 56 - 58 - 64,
        numLabel: '5 = (col.2)-(col.3)-(col.4)', numeric: true },
    ], Array.isArray(df.rowTfd) ? df.rowTfd : [], { totals: true });

    // ── Beneficiar (rând încadrat) ──────────────────────────────────────────
    const rowBfH = 16;
    ensureY(rowBfH + 2);
    pg.drawRectangle({ x: ML, y: y - rowBfH, width: CW, height: rowBfH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Beneficiar:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblBfW = tw('Beneficiar:', fB, 8.5) + 8;
    txt(clamp(str(df.beneficiar || ''), fR, 9, CW - lblBfW - 6),
        ML + lblBfW, y - 11, { font: fR, size: 9 });
    y -= rowBfH + 2;

    // ── Documente justificative (rând încadrat) ─────────────────────────────
    const rowDjH = 16;
    ensureY(rowDjH + 2);
    pg.drawRectangle({ x: ML, y: y - rowDjH, width: CW, height: rowDjH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Documente justificative:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblDjW = tw('Documente justificative:', fB, 8.5) + 8;
    txt(clamp(str(df.documente_justificative || ''), fR, 9, CW - lblDjW - 6),
        ML + lblDjW, y - 11, { font: fR, size: 9 });
    y -= rowDjH + 2;

    // ── Cod de identificare fiscală beneficiar (rând încadrat) ──────────────
    const rowCifH = 16;
    ensureY(rowCifH + 2);
    pg.drawRectangle({ x: ML, y: y - rowCifH, width: CW, height: rowCifH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Cod de identificare fiscală beneficiar:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblCifW = tw('Cod de identificare fiscală beneficiar:', fB, 8.5) + 8;
    txt(clamp(str(df.cif_beneficiar || ''), fR, 9, CW - lblCifW - 6),
        ML + lblCifW, y - 11, { font: fR, size: 9 });
    y -= rowCifH + 2;

    // ── Cod IBAN beneficiar | Cont deschis la (2 sub-celule) ────────────────
    const rowIbnH = 16;
    ensureY(rowIbnH + 2);
    pg.drawRectangle({ x: ML, y: y - rowIbnH, width: CW, height: rowIbnH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    const cellIbW = CW * 0.6;
    txt('Cod IBAN beneficiar:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblIbW = tw('Cod IBAN beneficiar:', fB, 8.5) + 8;
    txt(clamp(str(df.iban_beneficiar || ''), fR, 9, cellIbW - lblIbW - 6),
        ML + lblIbW, y - 11, { font: fR, size: 9 });
    pg.drawLine({ start: { x: ML + cellIbW, y }, end: { x: ML + cellIbW, y: y - rowIbnH },
      thickness: 0.4, color: rgb(0, 0, 0) });
    txt('Cont deschis la:', ML + cellIbW + 4, y - 11, { font: fB, size: 8.5 });
    const lblCdW = tw('Cont deschis la:', fB, 8.5) + 8;
    txt(clamp(str(df.banca_beneficiar || ''), fR, 9, CW - cellIbW - lblCdW - 6),
        ML + cellIbW + lblCdW, y - 11, { font: fR, size: 9 });
    y -= rowIbnH + 10;

    // ── Informații privind plata (casetă text multiline) ────────────────────
    const infTxt = [df.inf_pv_plata, df.inf_pv_plata1].filter(Boolean).join(' ');
    ensureY(LH);
    txt('Informații privind plata:', ML, y, { font: fB, size: 8.5 });
    y -= LH;
    if (infTxt) {
      const lines = wrapText(str(infTxt), fR, 8.5, CW - 8, 4);
      const boxH = Math.max(28, lines.length * 11 + 8);
      ensureY(boxH + 4);
      pg.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      for (let i = 0; i < lines.length; i++) {
        txt(lines[i], ML + 4, y - 8 - i * 11, { font: fR, size: 8.5 });
      }
      y -= boxH + 4;
    } else {
      const boxH = 28;
      ensureY(boxH + 4);
      pg.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      y -= boxH + 4;
    }
  }

  // ── Embed captură imagine în PDF ──────────────────────────────────────────
  async function embedCapture(b64, title) {
    if (!b64) return;
    const raw = b64.includes(',') ? b64.split(',')[1] : b64;
    const isJpg = b64.startsWith('data:image/jpeg') || b64.startsWith('data:image/jpg');
    let imgEmbed;
    try {
      const bytes = Buffer.from(raw, 'base64');
      imgEmbed = isJpg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
    } catch (_) { return; }  // imagine coruptă — ignorăm, PDF-ul rămâne valid
    // Zoom „cât ține pagina": captura se scalează la lățimea completă a conținutului
    // (CW = 515pt), limitată doar de înălțimea utilă a unei pagini A4. O captură mai
    // mică decât CW este mărită (upscale) — comportament cerut explicit.
    const CAP_HDR = 32;                                  // titlu + linie separatoare + spațiere
    const maxW = CW;
    const maxH = (H - MT - MB) - CAP_HDR - 24;           // ≈ 691pt înălțime utilă
    const sc   = Math.min(maxW / imgEmbed.width, maxH / imgEmbed.height);
    const iw   = Math.round(imgEmbed.width  * sc);
    const ih   = Math.round(imgEmbed.height * sc);

    ensureY(ih + CAP_HDR);
    y -= 10;
    pg.drawText(str(title), { x: ML, y, font: fB, size: 7.5, color: rgb(0.2, 0.2, 0.2) });
    y -= 4;
    pg.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y },
      thickness: 0.3, color: rgb(0.7, 0.7, 0.7) });
    y -= 6 + ih;
    const ix = ML + Math.round((CW - iw) / 2);           // centrat orizontal
    pg.drawImage(imgEmbed, { x: ix, y, width: iw, height: ih });
    pg.drawRectangle({ x: ix, y, width: iw, height: ih,
      borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.4 });
    y -= 8;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  newPage();
  drawDocHeader();
  if (formType === 'notafd') buildNotafd(); else buildOrdnt();

  // ── Capturi imagine (după conținut, înainte de footer) ─────────────────────
  const _capLabel1 = 'Captură imagine din sistemul de control al angajamentelor bugetare';
  const _capLabel2 = 'Captură \u201eInformații complete contract\u201d din sistemul de control al angajamentelor bugetare';
  if (formType === 'ordnt') {
    await embedCapture(data.captureImageBase64,   _capLabel1);
    await embedCapture(data.captureImageBase64_2, _capLabel2);
  } else {
    await embedCapture(data.captureImageBase64, _capLabel1);
  }

  // ── Footer pe fiecare pagină ───────────────────────────────────────────────

  const total = pages.length;
  const genDt = new Date().toLocaleString('ro-RO', {
    timeZone: 'Europe/Bucharest',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  for (let i = 0; i < pages.length; i++) {
    const fp = pages[i];
    const fy = MB - 5;
    fp.drawLine({ start: { x: ML, y: fy }, end: { x: ML + CW, y: fy },
      thickness: 0.4, color: rgb(0.4, 0.4, 0.4) });
    const pgt = str(`Pagina ${i + 1} din ${total}`);
    fp.drawText(pgt, { x: ML + (CW - fR.widthOfTextAtSize(pgt, 7)) / 2,
      y: fy - 12, font: fR, size: 7, color: rgb(0.3, 0.3, 0.3) });
    const gen = str(`DocFlowAI — generat la ${genDt}`);
    fp.drawText(gen, { x: ML + CW - fR.widthOfTextAtSize(gen, 6),
      y: fy - 22, font: fR, size: 6, color: rgb(0.5, 0.5, 0.5) });
  }

  return Buffer.from(await pdfDoc.save());
}

// ── POST /api/formulare/generate ─────────────────────────────────────────────

router.post('/api/formulare/generate', _json5m, async (req, res) => {
  try {
    const actor = requireAuth(req, res); if (!actor) return;

    const { formType, data, docId } = req.body || {};
    if (!formType || !data)
      return res.status(400).json({ error: 'formType si data sunt obligatorii' });
    if (!['ordnt', 'notafd'].includes(formType))
      return res.status(400).json({ error: 'formType invalid. Valori: ordnt, notafd' });

    // Blocare server-side a (re)generării pentru un DF/ORD deja aflat pe flux activ.
    // Frontend-ul trimite docId-ul documentului curent; dacă documentul are un flux
    // de semnare NON-terminal, refuzăm cu același contract ca link-flow (409).
    if (docId && pool && (formType === 'notafd' || formType === 'ordnt')) {
      const tbl = formType === 'notafd' ? 'formulare_df' : 'formulare_ord';
      const errCode = formType === 'notafd' ? 'df_already_on_active_flow' : 'ord_already_on_active_flow';
      const errMsg = formType === 'notafd'
        ? 'Documentul este deja pe un flux de semnare activ. Anulați fluxul curent înainte de a-l retrimite.'
        : 'Ordonanțarea este deja pe un flux de semnare activ. Anulați fluxul curent înainte de a o retrimite.';
      try {
        const { rows: act } = await pool.query(
          `SELECT 1
             FROM ${tbl} fd
             JOIN flows f ON f.id = fd.flow_id
            WHERE fd.id = $1
              AND fd.org_id = $2
              AND fd.deleted_at IS NULL
              AND (f.data->>'completed') IS DISTINCT FROM 'true'
              AND (f.data->>'status') <> 'cancelled'`,
          [docId, actor.orgId]
        );
        if (act.length) {
          return res.status(409).json({ error: errCode, message: errMsg });
        }
      } catch (guardErr) {
        // best-effort: nu blocăm generarea dacă verificarea eșuează (DB hiccup)
        logger.warn({ err: guardErr }, 'formulare generate: guard flux activ a eșuat (non-fatal)');
      }
    }

    const errs = formType === 'ordnt' ? validateOrdnt(data) : validateNotafd(data);
    if (errs.length > 0)
      return res.status(422).json({ error: 'Validare esuata', errors: errs });

    logger.info({ formType, actor: actor.email }, 'formulare: generare PDF');

    const filledPdf = await generatePdfSimple(formType, data);

    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = formType === 'ordnt'
      ? `OrdonantarePlata_${(data.NrOrdonantPl || '').replace(/[^A-Za-z0-9_-]/g, '_')}_${ts}.pdf`
      : `DocumentFundamentare_${(data.NrUnicInreg || '').replace(/[^A-Za-z0-9_-]/g, '_')}_${ts}.pdf`;

    return res.json({ ok: true, pdfBase64: filledPdf.toString('base64'), fileName });

  } catch (e) {
    logger.error({ err: e }, 'formulare: eroare generare PDF');
    return res.status(500).json({ error: 'Eroare server la generare PDF', message: e.message });
  }
});

// ── GET /api/formulare/templates ──────────────────────────────────────────────

router.get('/api/formulare/templates', (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  res.json({ templates: { ordnt: { configured: true }, notafd: { configured: true } } });
});

export { router as formulareRouter };
