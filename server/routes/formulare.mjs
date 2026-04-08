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
import fs                               from 'fs';
import path                             from 'path';
import { fileURLToPath }               from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router    = Router();
const _json5m   = expressJson({ limit: '5mb' });
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
    dashed(valX, y - 1.5, ML + CW);
    txt(clamp(val, fR, size, valW), valX, y, { font: fR, size });
    y -= LH;
  }

  function checkItem(checked, label, { size = 8, indent = 0 } = {}) {
    ensureY(LH);
    const cbX = ML + indent;
    drawCheckbox(cbX, y, checked);
    txt(clamp(str(label), fR, size, CW - indent - 14), cbX + 13, y, { font: fR, size });
    y -= LH;
  }

  // Tabel cu header gri, rânduri alternante, borduri 0.4pt
  // cols: [{ header, key, width, numeric? }]
  function drawTable(cols, rows) {
    const RH = 13, HH = 14;
    ensureY(HH + RH * Math.min(Math.max(rows.length, 1), 4));

    // Header
    pg.drawRectangle({ x: ML, y: y - HH, width: CW, height: HH,
      color: rgb(0.88, 0.88, 0.88), borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
    let cx = ML;
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const hdr = clamp(str(col.header), fB, 7, col.width - 3);
      const hw  = tw(hdr, fB, 7);
      pg.drawText(hdr, { x: cx + (col.width - hw) / 2, y: y - HH + 4.5,
        font: fB, size: 7, color: rgb(0, 0, 0) });
      if (i < cols.length - 1)
        pg.drawLine({ start: { x: cx + col.width, y }, end: { x: cx + col.width, y: y - HH },
          thickness: 0.4, color: rgb(0, 0, 0) });
      cx += col.width;
    }
    y -= HH;

    // Rânduri
    const dataRows = rows.length ? rows : [null];
    for (let ri = 0; ri < dataRows.length; ri++) {
      ensureY(RH);
      const row = dataRows[ri];
      const bg  = ri % 2 === 0 ? rgb(1, 1, 1) : rgb(0.96, 0.96, 0.96);
      pg.drawRectangle({ x: ML, y: y - RH, width: CW, height: RH,
        color: bg, borderColor: rgb(0, 0, 0), borderWidth: 0.4 });
      if (row === null) {
        pg.drawText(str('(nicio înregistrare)'), { x: ML + 4, y: y - RH + 4,
          font: fR, size: 7, color: rgb(0.5, 0.5, 0.5) });
      } else {
        cx = ML;
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const val = clamp(str(row[col.key] ?? ''), fR, 7, col.width - 4);
          const vw  = tw(val, fR, 7);
          const tx  = col.numeric ? cx + col.width - 3 - vw : cx + 2;
          pg.drawText(val, { x: tx, y: y - RH + 4, font: fR, size: 7, color: rgb(0, 0, 0) });
          if (i < cols.length - 1)
            pg.drawLine({ start: { x: cx + col.width, y }, end: { x: cx + col.width, y: y - RH },
              thickness: 0.4, color: rgb(0, 0, 0) });
          cx += col.width;
        }
      }
      y -= RH;
    }
    y -= 5;
  }

  // ── Header document ────────────────────────────────────────────────────────

  function drawDocHeader() {
    // Rând 1: instituție stânga | nr. + dată dreapta
    txt(`Instituția publică: ${data.DenInstPb || ''}`, ML, y, { font: fR, size: 9 });
    if (formType === 'notafd') {
      rightTxt(`Nr. înreg.: ${data.NrUnicInreg || ''}   Data: ${data.DataRevizuirii || ''}`, y, { font: fR, size: 8 });
    } else {
      rightTxt(`Nr. ordonanță: ${data.NrOrdonantPl || ''}   Data: ${data.DataOrdontPl || ''}`, y, { font: fR, size: 8 });
    }
    y -= 13;
    // Rând 2: CIF
    txt(`CIF: ${data.Cif || ''}`, ML, y, { font: fR, size: 8 });
    y -= 9;
    // Linie separator
    hline(y, { thickness: 0.5 });
    y -= 9;
    // Titlu centrat bold
    const title = formType === 'ordnt' ? 'ORDONANȚARE DE PLATĂ' : 'DOCUMENT DE FUNDAMENTARE';
    centered(title, y, { font: fB, size: 12 });
    y -= 16;
    // Subtitlu / info revizuire
    if (formType === 'notafd') {
      if (data.SubtitluDF) {
        centered(data.SubtitluDF, y, { font: fR, size: 9 });
        y -= 13;
      }
      centered(`Revizuirea nr. ${data.Revizuirea || '—'} din ${data.DataRevizuirii || ''}`, y, { font: fR, size: 8 });
      y -= 11;
    }
    y -= 6;
  }

  // ── Conținut NOTAFD ────────────────────────────────────────────────────────

  function buildNotafd() {
    secTitle('SECȚIUNEA A');
    const sA = data.sectiuneaA || {};
    fieldLine('1. Compartiment de specialitate', sA.compartiment_specialitate);
    fieldLine('2. Obiect FD (formă scurtă)', sA.obiect_fd_reviz_scurt);
    if (sA.obiect_fd_reviz_lung) fieldLine('3. Obiect FD (formă detaliată)', sA.obiect_fd_reviz_lung);

    // Pct. 4
    y -= 4;
    secTitle('4. Angajamente legale — valori');
    const angV = sA.ang_legale_val || {};
    checkItem(angV.ckbx_stab_tin_cont, 'Stabilirea și ținerea în evidență a angajamentelor legale (valori)');
    checkItem(angV.ckbx_ramane_suma,   'Rămâne suma de angajat');
    if (isChecked(angV.ckbx_ramane_suma) && (angV.ramane_suma || angV.ramane_suma === 0))
      fieldLine('  Suma rămasă de angajat', String(angV.ramane_suma), { indent: 16 });
    y -= 2;
    drawTable([
      { header: 'Element FD',       key: 'element_fd',    width: 80 },
      { header: 'Program',          key: 'program',       width: 60 },
      { header: 'Cod SSI',          key: 'codSSI',        width: 60 },
      { header: 'Param FD',         key: 'param_fd',      width: 70 },
      { header: 'Val. prec.',       key: 'valt_rev_prec', width: 60, numeric: true },
      { header: 'Influențe',        key: 'influente',     width: 60, numeric: true },
      { header: 'Val. actualizată', key: 'valt_actualiz', width: CW - 80 - 60 - 60 - 70 - 60 - 60, numeric: true },
    ], Array.isArray(angV.rowT_ang_pl_val) ? angV.rowT_ang_pl_val : []);

    // Pct. 5
    y -= 4;
    secTitle('5. Angajamente legale — plăți');
    const angP = sA.ang_legale_plati || {};
    checkItem(angP.ckbx_fara_ang_emis_ancrt,    'Fără angajamente emise în anul curent');
    checkItem(angP.ckbx_cu_ang_emis_ancrt,      'Cu angajamente emise în anul curent');
    checkItem(angP.ckbx_sting_ang_in_ancrt,     'Sting angajamentele în anul curent');
    checkItem(angP.ckbx_fara_plati_ang_in_ancrt,'Fără plăți ale angajamentelor în anul curent');
    checkItem(angP.ckbx_cu_plati_ang_in_mmani,  'Cu plăți ale angajamentelor în lunile următoare');
    checkItem(angP.ckbx_ang_leg_emise_ct_an_urm,'Angajamente legale emise cu termen în ani următori');
    const rowsPlati = Array.isArray(angP.rowT_ang_pl_plati) ? angP.rowT_ang_pl_plati : [];
    if (rowsPlati.length) {
      y -= 2;
      const w = Math.floor(CW / 8);
      drawTable([
        { header: 'Program',      key: 'program',                width: w },
        { header: 'Cod SSI',      key: 'codSSI',                 width: w },
        { header: 'Plăți prec.', key: 'plati_ani_precedenti',   width: w, numeric: true },
        { header: 'Plăți an crt.',key: 'plati_estim_ancrt',      width: w, numeric: true },
        { header: 'Plăți an+1',  key: 'plati_estim_an_np1',     width: w, numeric: true },
        { header: 'Plăți an+2',  key: 'plati_estim_an_np2',     width: w, numeric: true },
        { header: 'Plăți an+3',  key: 'plati_estim_an_np3',     width: w, numeric: true },
        { header: 'Plăți ulter.',key: 'plati_estim_ani_ulter',  width: CW - w * 7, numeric: true },
      ], rowsPlati);
    }

    // Secțiunea B
    y -= 4;
    secTitle('SECȚIUNEA B');
    const sB = data.sectiuneaB || {};
    checkItem(sB.ckbx_secta_inreg_ctrl_ang,'Secțiunea A cu înregistrări în controlul angajamentelor');
    checkItem(sB.ckbx_fara_inreg_ctrl_ang, 'Fără înregistrări în controlul angajamentelor');
    if (sB.sum_fara_inreg_ctrl_crdbug)
      fieldLine('  Suma fără înregistrări control credit bugetar', String(sB.sum_fara_inreg_ctrl_crdbug), { indent: 16 });
    checkItem(sB.ckbx_interzis_emit_ang,  'Interzis a emite angajamente');
    checkItem(sB.ckbx_interzis_intrucat,  'Întrucât');
    if (sB.intrucat) fieldLine('  Motivație', sB.intrucat, { indent: 16 });
    const rowsCtrl = Array.isArray(sB.rowT_ang_ctrl_ang) ? sB.rowT_ang_ctrl_ang : [];
    if (rowsCtrl.length) {
      y -= 2;
      const w = Math.floor(CW / 10);
      drawTable([
        { header: 'Cod ang.',          key: 'cod_angajament',               width: w },
        { header: 'Indicator',         key: 'indicator_angajament',         width: w },
        { header: 'Program',           key: 'program',                      width: w },
        { header: 'Cod SSI',           key: 'cod_SSI',                      width: w },
        { header: 'Rez.crdt.ang.prec', key: 'sum_rezv_crdt_ang_af_rvz_prc', width: w, numeric: true },
        { header: 'Inf.C6',            key: 'influente_c6',                 width: w, numeric: true },
        { header: 'Rez.crdt.ang.act',  key: 'sum_rezv_crdt_ang_act',        width: w, numeric: true },
        { header: 'Rez.crdt.bug.prec', key: 'sum_rezv_crdt_bug_af_rvz_prc', width: w, numeric: true },
        { header: 'Inf.C9',            key: 'influente_c9',                 width: w, numeric: true },
        { header: 'Rez.crdt.bug.act',  key: 'sum_rezv_crdt_bug_act',        width: CW - w * 9, numeric: true },
      ], rowsCtrl);
    }
  }

  // ── Conținut ORDNT ─────────────────────────────────────────────────────────

  function buildOrdnt() {
    const df = data.docFd || {};

    secTitle('Date ordonanță');
    fieldLine('Nr. ordonanță', data.NrOrdonantPl);
    fieldLine('Data ordonanței', data.DataOrdontPl);

    y -= 4;
    secTitle('Date beneficiar');
    fieldLine('Beneficiar', df.beneficiar);
    fieldLine('IBAN beneficiar', df.iban_beneficiar);
    fieldLine('CIF beneficiar', df.cif_beneficiar);
    if (df.banca_beneficiar)        fieldLine('Bancă beneficiar', df.banca_beneficiar);
    if (df.nr_unic_inreg)           fieldLine('Nr. unic înregistrare', df.nr_unic_inreg);
    if (df.documente_justificative) fieldLine('Documente justificative', df.documente_justificative);

    y -= 4;
    secTitle('Detalii plată');
    drawTable([
      { header: 'Cod angajament',    key: 'cod_angajament',         width: 80 },
      { header: 'Indicator',         key: 'indicator_angajament',   width: 65 },
      { header: 'Program',           key: 'program',                width: 55 },
      { header: 'Cod SSI',           key: 'cod_SSI',                width: 55 },
      { header: 'Recepții',          key: 'receptii',               width: 57, numeric: true },
      { header: 'Plăți ant.',        key: 'plati_anterioare',       width: 57, numeric: true },
      { header: 'Sumă ordonanțată',  key: 'suma_ordonantata_plata', width: 72, numeric: true },
      { header: 'Rec. neplatite',    key: 'receptii_neplatite',     width: CW - 80 - 65 - 55 - 55 - 57 - 57 - 72, numeric: true },
    ], Array.isArray(df.rowTfd) ? df.rowTfd : []);

    if (df.inf_pv_plata || df.inf_pv_plata1) {
      secTitle('Informații proces-verbal plată');
      if (df.inf_pv_plata)  fieldLine('Informații PV plată', df.inf_pv_plata);
      if (df.inf_pv_plata1) fieldLine('Informații PV plată (2)', df.inf_pv_plata1);
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  newPage();
  drawDocHeader();
  if (formType === 'notafd') buildNotafd(); else buildOrdnt();

  // ── Footer pe fiecare pagină ───────────────────────────────────────────────

  const total = pages.length;
  const genDt = new Date().toLocaleString('ro-RO', {
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

    const { formType, data } = req.body || {};
    if (!formType || !data)
      return res.status(400).json({ error: 'formType si data sunt obligatorii' });
    if (!['ordnt', 'notafd'].includes(formType))
      return res.status(400).json({ error: 'formType invalid. Valori: ordnt, notafd' });

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
