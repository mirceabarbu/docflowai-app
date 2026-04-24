// server/services/formulare-oficiale/nf-invest-pdf.mjs
// Generare PDF A4 pentru Notă de Fundamentare investiții.
// Folosește pdf-lib + NotoSans TTF (suport diacritice române — același pattern ca formulare.mjs).

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatMoneyRO } from '../format-money.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dir, '../../formulare/fonts');

// Dimensiuni A4 în pt (1pt = 1/72 inch)
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 60;
const CONTENT_W = A4_W - MARGIN * 2;

/**
 * Generează PDF A4 pentru Notă de Fundamentare investiții.
 * @param {Object} formular - rândul din formulare_oficiale cu form_data
 * @returns {Promise<Buffer>}
 */
export async function generateNfInvestPdf(formular) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(formular.title || 'Notă de fundamentare');
  pdfDoc.setAuthor('DocFlowAI');
  pdfDoc.setSubject('Notă de fundamentare investiții');

  let fR, fB;
  try {
    fR = await pdfDoc.embedFont(readFileSync(join(FONTS_DIR, 'NotoSans-Regular.ttf')));
    fB = await pdfDoc.embedFont(readFileSync(join(FONTS_DIR, 'NotoSans-Bold.ttf')));
  } catch {
    fR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  const data = formular.form_data || {};

  // Context de desen — cursor auto
  let page = pdfDoc.addPage([A4_W, A4_H]);
  let y = A4_H - MARGIN;

  const newPage = () => {
    page = pdfDoc.addPage([A4_W, A4_H]);
    y = A4_H - MARGIN;
  };

  const checkSpace = (needed = 20) => {
    if (y < MARGIN + needed) newPage();
  };

  const drawText = (text, { x = MARGIN, font = fR, size = 10, color = rgb(0,0,0), width = CONTENT_W, align = 'left' } = {}) => {
    if (!text) return;
    const str = String(text);
    // Împarte pe cuvinte și wrappează
    const words = str.split(' ');
    let line = '';
    const lines = [];
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      const testW = font.widthOfTextAtSize(test, size);
      if (testW > width && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    for (const ln of lines) {
      checkSpace(size + 4);
      const lnW = font.widthOfTextAtSize(ln, size);
      let drawX = x;
      if (align === 'center') drawX = x + (width - lnW) / 2;
      else if (align === 'right') drawX = x + width - lnW;
      page.drawText(ln, { x: drawX, y, font, size, color });
      y -= size + 4;
    }
  };

  const drawLine = (thickness = 0.5) => {
    checkSpace(8);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4_W - MARGIN, y }, thickness, color: rgb(0.6, 0.6, 0.6) });
    y -= 8;
  };

  const spacer = (h = 8) => { y -= h; };

  // ── HEADER: Nr. înregistrare + Data (stânga) ──────────────────────────────
  drawText(`Nr. de înregistrare: ${data.nr_inregistrare || '_______'}`, { font: fR, size: 9 });
  spacer(2);
  drawText(`Data: ${data.data_inregistrare || '__________________'}`, { font: fR, size: 9 });
  spacer(4);

  // ── APROBAT / VIZAT (dreapta sus) — descompus pe coloane ─────────────────
  // Salvăm Y curent și redesenăm pe coloane dreapta
  const headerY = y + 60; // înapoi la începutul header-ului
  const rightX = A4_W - MARGIN - 170;
  const rightW = 170;

  const drawRightText = (text, { font: f = fR, size: s = 9 } = {}) => {
    const str = String(text || '');
    const tw = f.widthOfTextAtSize(str, s);
    const drawX = rightX + (rightW - tw) / 2;
    page.drawText(str, { x: drawX, y: headerY - 0, font: f, size: s, color: rgb(0, 0, 0) });
  };

  // Bloc APROBAT
  let ry = headerY + 10;
  const rDraw = (text, f = fR, s = 9) => {
    const str = String(text || '');
    const tw = f.widthOfTextAtSize(str, s);
    const drawX = rightX + (rightW - tw) / 2;
    page.drawText(str, { x: drawX, y: ry, font: f, size: s, color: rgb(0, 0, 0) });
    ry -= s + 4;
  };
  rDraw('APROBAT', fB, 11);
  rDraw('Primar', fR, 9);
  rDraw(data.primar_name || '________________________', fB, 9);
  ry -= 8;
  rDraw('VIZAT', fB, 11);
  rDraw('Director Executiv — Direcția Economică', fR, 8);
  rDraw(data.director_executiv_name || '________________________', fB, 9);

  spacer(10);
  drawLine();
  spacer(6);

  // ── TITLU ────────────────────────────────────────────────────────────────
  drawText('NOTĂ DE FUNDAMENTARE', { font: fB, size: 14, align: 'center' });
  spacer(4);
  drawText(
    `privind necesitatea și oportunitatea cuprinderii în programul de investiții pentru anul ${data.an_program || '........'} a obiectivului de investiții:`,
    { font: fR, size: 10, align: 'center' }
  );
  spacer(2);
  drawText(data.tip_obiectiv || '', { font: fB, size: 10, align: 'center' });
  spacer(10);
  drawLine();
  spacer(8);

  // ── Helper secțiune ───────────────────────────────────────────────────────
  const section = (num, title) => {
    checkSpace(24);
    spacer(6);
    drawText(`${num}. ${title}`, { font: fB, size: 11 });
    spacer(4);
  };

  const field = (label, value, indent = 0) => {
    if (!value) return;
    checkSpace(20);
    drawText(`${label}:`, { font: fB, size: 10, x: MARGIN + indent });
    drawText(value, { font: fR, size: 10, x: MARGIN + indent + 8 });
    spacer(2);
  };

  const subLetter = (letter, labelText, value) => {
    checkSpace(20);
    drawText(`${letter}) ${labelText}:`, { font: fB, size: 10 });
    drawText(value || '—', { font: fR, size: 10, x: MARGIN + 12 });
    spacer(2);
  };

  // ── 1. INFORMAȚII GENERALE ───────────────────────────────────────────────
  section(1, 'Informații generale privind obiectivul de investiții propus');
  field('1.1. Denumirea obiectivului de investiții', data.denumire_obiectiv);
  field('1.2. Ordonator principal de credite/investitor', data.ordonator_principal);
  field('1.3. Ordonator de credite (secundar/terțiar)', data.ordonator_secundar);
  field('1.4. Beneficiarul investiției', data.beneficiar);

  // ── 2. NECESITATEA ȘI OPORTUNITATEA ─────────────────────────────────────
  section(2, 'Necesitatea și oportunitatea obiectivului de investiții propus');
  drawText('2.1. Scurtă prezentare privind:', { font: fB, size: 10 });
  spacer(4);
  subLetter('a', 'deficiențe majore ale situației actuale', data.deficiente_actuale);
  subLetter('b', 'așteptări, prognoze și efectul pozitiv previzionat', data.efect_pozitiv);
  subLetter('c', 'impactul negativ previzionat în cazul nerealizării', data.impact_negativ);
  field('2.2. Oportunitatea', data.oportunitate);

  // ── 3. ESTIMAREA SUPORTABILITĂȚII ───────────────────────────────────────
  section(3, 'Estimarea suportabilității investiției publice');
  drawText('3.1. Estimarea cheltuielilor pentru execuția obiectivului de investiții:', { font: fB, size: 10 });
  spacer(4);
  const valoare = data.valoare_totala_mii_lei
    ? `${formatMoneyRO(data.valoare_totala_mii_lei)} mii lei`
    : '—';
  drawText(
    `Fondurile solicitate pentru anul ${data.an_program || '....'} sunt în valoare totală estimată de ${valoare}, valoarea rezultată în urma ${data.sursa_valoare || 'unei cercetări a pieței'}.`,
    { font: fR, size: 10 }
  );
  spacer(4);
  if (data.fonduri_similare) {
    field('Fonduri alocate cu destinații similare', data.fonduri_similare);
  }
  drawText('3.2. Surse identificate pentru finanțarea cheltuielilor estimate:', { font: fB, size: 10 });
  spacer(4);
  drawText(
    data.surse_finantare || 'Finanțarea cheltuielilor de investiții se face din bugetul Primăriei, în limita sumelor aprobate anual cu această destinație, precum și din alte surse legal constituite.',
    { font: fR, size: 10 }
  );

  // ── 4. REGIM JURIDIC ─────────────────────────────────────────────────────
  section(4, 'Informații privind regimul juridic, economic și tehnic al terenului și/sau al construcției existente');
  drawText(data.regim_juridic || 'Nu este cazul.', { font: fR, size: 10 });

  // ── 5. DESCRIERE TEHNICĂ ─────────────────────────────────────────────────
  section(5, 'Descrierea succintă a obiectivului de investiții propus, din punct de vedere tehnic și funcțional');
  subLetter('a', 'destinație și funcțiuni', data.destinatie_functiuni);
  subLetter('b', 'caracteristici, parametri și date specifice preconizate', data.caracteristici_parametri);
  subLetter('c', 'durata minimă de funcționare', data.durata_functionare);
  subLetter('d', 'nevoi/solicitări funcționale specifice', data.nevoi_functionale || 'nu este cazul');
  subLetter('e', 'termen P.I.F.', data.termen_pif || 'nu este cazul');

  // ── 6. DOCUMENTE ATAȘATE ─────────────────────────────────────────────────
  section(6, 'Documente justificative atașate notei de fundamentare');
  drawText(data.documente_atasate || '—', { font: fR, size: 10 });

  // ── FOOTER SEMNATARI ─────────────────────────────────────────────────────
  spacer(20);
  drawLine();
  spacer(8);
  drawText(`Data: ${data.data_semnare || 'dd.ll.aaaa'}`, { font: fR, size: 10 });
  spacer(20);

  // Trei semnatari pe coloane
  const colW = (CONTENT_W - 20) / 3;
  const col1X = MARGIN;
  const col2X = MARGIN + colW + 10;
  const col3X = MARGIN + (colW + 10) * 2;
  const sigY = y;

  const drawSigBlock = (px, label, name) => {
    page.drawText(label, { x: px, y: sigY, font: fR, size: 8, color: rgb(0, 0, 0) });
    page.drawText(name || '___________________', { x: px, y: sigY - 20, font: fB, size: 9, color: rgb(0, 0, 0) });
  };

  drawSigBlock(col1X, 'Șef Structură/Ordonator terțiar,', data.sef_structura_name);
  drawSigBlock(col2X, 'Director financiar-contabil,', data.director_financiar_name);
  drawSigBlock(col3X, 'Întocmit,', data.intocmit_name);

  return Buffer.from(await pdfDoc.save());
}
