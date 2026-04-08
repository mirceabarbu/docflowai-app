/**
 * DocFlowAI — server/routes/formulare.mjs
 *
 * Formulare oficiale: Ordonanțare de Plată (ORDNT) + Document de Fundamentare (NOTAFD)
 * Generare PDF simplu A4 cu pdf-lib (fără injecție XFA/template).
 *
 * REGISTRARE în server/index.mjs:
 *   import { formulareRouter } from './routes/formulare.mjs';
 *   app.use(formulareRouter);
 */

import { Router, json as expressJson } from 'express';
import { requireAuth }                  from '../middleware/auth.mjs';
import { logger }                       from '../middleware/logger.mjs';

const router  = Router();
const _json5m = expressJson({ limit: '5mb' });

// ── Helper: diacritice române → ASCII (Helvetica nu suportă Unicode) ──────────

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

// ── Generare PDF simplu cu pdf-lib ────────────────────────────────────────────

async function generatePdfSimple(formType, data) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const PAGE_W    = 595.28;
  const PAGE_H    = 841.89;
  const MARGIN    = 40;
  const CW        = PAGE_W - 2 * MARGIN;   // content width = 515.28
  const LH        = 16;                     // line height
  const FOOTER_H  = 20;

  const pdfDoc = await PDFDocument.create();
  const fontR  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontI  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // ── State ──────────────────────────────────────────────────────────────────
  const pages = [];
  let page    = null;
  let y       = 0;

  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
  }

  function ensureSpace(needed) {
    if (y - needed < MARGIN + FOOTER_H) newPage();
  }

  // ── Drawing primitives ─────────────────────────────────────────────────────

  function tw(text, font, size) {
    return font.widthOfTextAtSize(text, size);
  }

  function trunc(s, font, size, maxW) {
    let t = ro(String(s ?? ''));
    if (tw(t, font, size) <= maxW) return t;
    while (t.length > 0 && tw(t + '…', font, size) > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function txt(text, x, yy, { font = fontR, size = 9, color = rgb(0,0,0) } = {}) {
    page.drawText(text, { x, y: yy, font, size, color });
  }

  function centered(text, yy, { font = fontR, size = 10 } = {}) {
    const w = tw(text, font, size);
    txt(text, MARGIN + (CW - w) / 2, yy, { font, size });
  }

  function rightAlign(text, yy, { font = fontR, size = 9 } = {}) {
    const w = tw(text, font, size);
    txt(text, MARGIN + CW - w, yy, { font, size });
  }

  function hline(yy, { thickness = 0.5, color = rgb(0.4, 0.4, 0.4) } = {}) {
    page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: MARGIN + CW, y: yy }, thickness, color });
  }

  function field(label, value, { size = 9 } = {}) {
    ensureSpace(LH);
    const lbl = ro(label) + ': ';
    const lw  = tw(lbl, fontB, size);
    txt(lbl,       MARGIN,      y, { font: fontB, size });
    txt(trunc(value, fontR, size, CW - lw), MARGIN + lw, y, { font: fontR, size });
    y -= LH;
  }

  function checkbox(checked, label, { size = 9 } = {}) {
    ensureSpace(LH);
    const on = checked === 'true' || checked === true || checked === 1;
    const mark = on ? '[X]' : '[ ]';
    txt(mark + ' ' + ro(String(label || '')), MARGIN + 6, y, { font: fontR, size });
    y -= LH;
  }

  function sectionHeader(title, { size = 10 } = {}) {
    ensureSpace(LH + 6);
    y -= 4;
    txt(ro(title), MARGIN, y, { font: fontB, size });
    y -= LH;
  }

  // ── Table ──────────────────────────────────────────────────────────────────
  // cols: [{ header: string, key: string, width: number }]
  // widths must sum to CW

  function drawTable(cols, rows, { size = 7.5 } = {}) {
    const ROW_H  = 13;
    const HEAD_H = 15;

    // Header
    ensureSpace(HEAD_H + ROW_H);

    // Header background
    page.drawRectangle({
      x: MARGIN, y: y - HEAD_H, width: CW, height: HEAD_H,
      color: rgb(0.85, 0.85, 0.85),
      borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 0.5,
    });

    // Header text + column dividers
    let cx = MARGIN;
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      txt(trunc(col.header, fontB, size, col.width - 4), cx + 2, y - HEAD_H + 5, { font: fontB, size });
      if (i < cols.length - 1) {
        page.drawLine({
          start: { x: cx + col.width, y: y },
          end:   { x: cx + col.width, y: y - HEAD_H },
          thickness: 0.5, color: rgb(0.5, 0.5, 0.5),
        });
      }
      cx += col.width;
    }

    y -= HEAD_H;

    // Data rows
    const dataRows = rows.length > 0 ? rows : [null];
    for (const row of dataRows) {
      ensureSpace(ROW_H);

      page.drawRectangle({
        x: MARGIN, y: y - ROW_H, width: CW, height: ROW_H,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5,
      });

      if (row === null) {
        txt('(fara inregistrari)', MARGIN + 4, y - ROW_H + 4, { font: fontI, size, color: rgb(0.5,0.5,0.5) });
      } else {
        cx = MARGIN;
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const val = trunc(row[col.key] ?? '', fontR, size, col.width - 4);
          txt(val, cx + 2, y - ROW_H + 4, { font: fontR, size });
          if (i < cols.length - 1) {
            page.drawLine({
              start: { x: cx + col.width, y },
              end:   { x: cx + col.width, y: y - ROW_H },
              thickness: 0.5, color: rgb(0.7, 0.7, 0.7),
            });
          }
          cx += col.width;
        }
      }

      y -= ROW_H;
    }

    y -= 6;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Construcție document
  // ══════════════════════════════════════════════════════════════════════════

  newPage();

  // ── Header comun ──────────────────────────────────────────────────────────

  centered(ro(data.DenInstPb || ''), y, { font: fontB, size: 12 });
  y -= LH;
  centered('CIF: ' + ro(data.Cif || ''), y, { font: fontR, size: 9 });
  y -= LH + 6;

  const docTitle = formType === 'ordnt' ? 'ORDONANTARE DE PLATA' : 'DOCUMENT DE FUNDAMENTARE';
  centered(docTitle, y, { font: fontB, size: 13 });
  y -= LH + 4;

  if (formType === 'ordnt') {
    rightAlign('Nr. ' + ro(data.NrOrdonantPl || '') + '   Data: ' + ro(data.DataOrdontPl || ''), y);
  } else {
    rightAlign('Nr. ' + ro(data.NrUnicInreg || '') + '   Data: ' + ro(data.DataRevizuirii || ''), y);
  }
  y -= LH;

  hline(y);
  y -= 10;

  // ── Conținut specific ─────────────────────────────────────────────────────

  if (formType === 'notafd') {

    if (data.SubtitluDF) {
      centered(ro(data.SubtitluDF), y, { font: fontI, size: 10 });
      y -= LH + 6;
    }

    // Sectiunea A
    sectionHeader('SECTIUNEA A');

    const sA = data.sectiuneaA || {};
    field('Compartiment specialitate', sA.compartiment_specialitate);
    field('Obiect FD (scurt)',          sA.obiect_fd_reviz_scurt);
    if (sA.obiect_fd_reviz_lung) field('Obiect FD (detaliat)', sA.obiect_fd_reviz_lung);
    if (data.Revizuirea)         field('Revizuirea', data.Revizuirea);

    // Pct. 4 — Angajamente legale valori
    y -= 4;
    sectionHeader('Pct. 4 - Angajamente legale - valori');

    const angV = sA.ang_legale_val || {};
    checkbox(angV.ckbx_stab_tin_cont, 'Stabilirea si tinerea in evidenta a angajamentelor legale');
    checkbox(angV.ckbx_ramane_suma,   'Ramane suma de angajat');
    if (angV.ckbx_ramane_suma === 'true' || angV.ckbx_ramane_suma === true) {
      field('  Suma ramasa', angV.ramane_suma || '0');
    }

    const rowsVal = Array.isArray(angV.rowT_ang_pl_val) ? angV.rowT_ang_pl_val : [];
    y -= 4;
    drawTable([
      { header: 'Element FD',    key: 'element_fd',    width: 75 },
      { header: 'Program',       key: 'program',       width: 60 },
      { header: 'Cod SSI',       key: 'codSSI',        width: 55 },
      { header: 'Param FD',      key: 'param_fd',      width: 65 },
      { header: 'Val. prec.',    key: 'valt_rev_prec', width: 65 },
      { header: 'Influente',     key: 'influente',     width: 65 },
      { header: 'Val. actual.',  key: 'valt_actualiz', width: Math.round(CW) - 75 - 60 - 55 - 65 - 65 - 65 },
    ], rowsVal);

    // Pct. 5 — Angajamente legale plati
    sectionHeader('Pct. 5 - Angajamente legale - plati');

    const angP = sA.ang_legale_plati || {};
    checkbox(angP.ckbx_fara_ang_emis_ancrt,    'Fara angajament emis in anul curent');
    checkbox(angP.ckbx_cu_ang_emis_ancrt,      'Cu angajament emis in anul curent');
    checkbox(angP.ckbx_sting_ang_in_ancrt,     'Sting angajamentul in anul curent');
    checkbox(angP.ckbx_fara_plati_ang_in_ancrt,'Fara plati ale angajamentului in anul curent');
    checkbox(angP.ckbx_cu_plati_ang_in_mmani,  'Cu plati ale angajamentului in lunile urmatoare');
    checkbox(angP.ckbx_ang_leg_emise_ct_an_urm,'Angajamente legale emise cu termen in ani urmatori');

    const rowsPlati = Array.isArray(angP.rowT_ang_pl_plati) ? angP.rowT_ang_pl_plati : [];
    if (rowsPlati.length > 0) {
      y -= 4;
      const w = Math.floor(Math.round(CW) / 8);
      drawTable([
        { header: 'Program',      key: 'program',                  width: w },
        { header: 'Cod SSI',      key: 'codSSI',                   width: w },
        { header: 'Plati prec.',  key: 'plati_ani_precedenti',     width: w },
        { header: 'Plati an crt', key: 'plati_estim_ancrt',        width: w },
        { header: 'Plati an+1',   key: 'plati_estim_an_np1',       width: w },
        { header: 'Plati an+2',   key: 'plati_estim_an_np2',       width: w },
        { header: 'Plati an+3',   key: 'plati_estim_an_np3',       width: w },
        { header: 'Plati ulter.', key: 'plati_estim_ani_ulter',    width: Math.round(CW) - w * 7 },
      ], rowsPlati);
    }

    // Sectiunea B
    sectionHeader('SECTIUNEA B');

    const sB = data.sectiuneaB || {};
    checkbox(sB.ckbx_secta_inreg_ctrl_ang, 'Sectiunea A cu inregistrari in controlul angajamentelor');
    checkbox(sB.ckbx_fara_inreg_ctrl_ang,  'Fara inregistrari in controlul angajamentelor');
    if (sB.sum_fara_inreg_ctrl_crdbug) {
      field('Suma fara inregistrari control credit bugetar', sB.sum_fara_inreg_ctrl_crdbug);
    }
    checkbox(sB.ckbx_interzis_emit_ang,  'Interzis a emite angajamente');
    checkbox(sB.ckbx_interzis_intrucat,  'Intrucat');
    if (sB.intrucat) field('  Motivatie', sB.intrucat);

    const rowsCtrl = Array.isArray(sB.rowT_ang_ctrl_ang) ? sB.rowT_ang_ctrl_ang : [];
    if (rowsCtrl.length > 0) {
      y -= 4;
      const w = Math.floor(Math.round(CW) / 10);
      drawTable([
        { header: 'Cod ang.',          key: 'cod_angajament',              width: w },
        { header: 'Indicator',         key: 'indicator_angajament',        width: w },
        { header: 'Program',           key: 'program',                     width: w },
        { header: 'Cod SSI',           key: 'cod_SSI',                     width: w },
        { header: 'Rez.ang.prec',      key: 'sum_rezv_crdt_ang_af_rvz_prc',width: w },
        { header: 'Inf.C6',            key: 'influente_c6',                width: w },
        { header: 'Rez.ang.act',       key: 'sum_rezv_crdt_ang_act',       width: w },
        { header: 'Rez.bug.prec',      key: 'sum_rezv_crdt_bug_af_rvz_prc',width: w },
        { header: 'Inf.C9',            key: 'influente_c9',                width: w },
        { header: 'Rez.bug.act',       key: 'sum_rezv_crdt_bug_act',       width: Math.round(CW) - w * 9 },
      ], rowsCtrl);
    }

  } else {

    // ORDNT
    const df = data.docFd || {};

    sectionHeader('Date ordonantare');
    field('Nr. ordonanta',   data.NrOrdonantPl);
    field('Data ordonantei', data.DataOrdontPl);

    y -= 4;
    sectionHeader('Date beneficiar');
    field('Beneficiar',              df.beneficiar);
    field('IBAN beneficiar',         df.iban_beneficiar);
    field('CIF beneficiar',          df.cif_beneficiar);
    if (df.banca_beneficiar)         field('Banca beneficiar', df.banca_beneficiar);
    if (df.nr_unic_inreg)            field('Nr. unic inregistrare', df.nr_unic_inreg);
    if (df.documente_justificative)  field('Documente justificative', df.documente_justificative);

    y -= 4;
    sectionHeader('Detalii plata');

    const rowsTfd = Array.isArray(df.rowTfd) ? df.rowTfd : [];
    drawTable([
      { header: 'Cod angajament',  key: 'cod_angajament',          width: 82 },
      { header: 'Indicator',       key: 'indicator_angajament',    width: 67 },
      { header: 'Program',         key: 'program',                 width: 55 },
      { header: 'Cod SSI',         key: 'cod_SSI',                 width: 55 },
      { header: 'Receptii',        key: 'receptii',                width: 60 },
      { header: 'Plati ant.',      key: 'plati_anterioare',        width: 60 },
      { header: 'Suma ordon.',     key: 'suma_ordonantata_plata',  width: 68 },
      { header: 'Rec. neplatite',  key: 'receptii_neplatite',      width: Math.round(CW) - 82 - 67 - 55 - 55 - 60 - 60 - 68 },
    ], rowsTfd);

    if (df.inf_pv_plata || df.inf_pv_plata1) {
      sectionHeader('Informatii proces-verbal plata');
      if (df.inf_pv_plata)  field('Informatii PV plata',     df.inf_pv_plata);
      if (df.inf_pv_plata1) field('Informatii PV plata (2)', df.inf_pv_plata1);
    }
  }

  // ── Footer: număr pagină / total pagini ───────────────────────────────────

  const total = pages.length;
  for (let i = 0; i < pages.length; i++) {
    const ft = `Pagina ${i + 1} / ${total}`;
    const fw = tw(ft, fontR, 8);
    pages[i].drawText(ft, {
      x: MARGIN + (CW - fw) / 2,
      y: MARGIN / 2,
      font: fontR, size: 8,
      color: rgb(0.5, 0.5, 0.5),
    });
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

    logger.info({ formType, actor: actor.email }, 'formulare: generare PDF simplu');

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
