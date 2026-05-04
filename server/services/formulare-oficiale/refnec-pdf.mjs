// server/services/formulare-oficiale/refnec-pdf.mjs
// Generare PDF A4 pentru Referat de Necesitate (REFNEC).
// Pattern identic cu nf-invest-pdf.mjs — pdf-lib + NotoSans TTF (diacritice).

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync }                     from 'fs';
import { join, dirname }                    from 'path';
import { fileURLToPath }                    from 'url';

const __dir    = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dir, '../../formulare/fonts');

const A4_W  = 595.28;
const A4_H  = 841.89;
const ML    = 50;          // margin left/right
const MT    = 50;          // margin top/bottom
const CW    = A4_W - ML * 2;

const C_BLACK = rgb(0, 0, 0);
const C_GREY  = rgb(0.5, 0.5, 0.5);
const C_LIGHT = rgb(0.93, 0.93, 0.93);

/**
 * Generează PDF A4 pentru Referat de Necesitate.
 * @param {Object} formular — rândul din formulare_oficiale cu form_data
 * @returns {Promise<Buffer>}
 */
export async function generateRefnecPdf(formular) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(formular.title || 'Referat de necesitate');
  pdfDoc.setAuthor('DocFlowAI');
  pdfDoc.setSubject('Referat de necesitate — achiziții publice');

  let fR, fB;
  try {
    fR = await pdfDoc.embedFont(readFileSync(join(FONTS_DIR, 'NotoSans-Regular.ttf')));
    fB = await pdfDoc.embedFont(readFileSync(join(FONTS_DIR, 'NotoSans-Bold.ttf')));
  } catch {
    fR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  const data    = formular.form_data || {};
  const front   = data.front || {};
  const refNum  = formular.ref_number || '';
  const title   = formular.title || 'Referat de necesitate';

  let pg, y, pageNum = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  const str  = (v) => (v == null ? '' : String(v));
  const bool = (v) => !!v;

  const newPage = () => {
    pg = pdfDoc.addPage([A4_W, A4_H]);
    pageNum++;
    y = A4_H - MT;
    // Footer
    pg.drawLine({
      start: { x: ML, y: MT - 6 }, end: { x: A4_W - ML, y: MT - 6 },
      thickness: 0.3, color: C_GREY,
    });
    const footL = refNum ? `Nr. ${refNum}` : title.slice(0, 60);
    pg.drawText(footL, { x: ML, y: MT - 16, font: fR, size: 7, color: C_GREY });
    const footR = `Pag. ${pageNum}`;
    const footRW = fR.widthOfTextAtSize(footR, 7);
    pg.drawText(footR, { x: A4_W - ML - footRW, y: MT - 16, font: fR, size: 7, color: C_GREY });
  };

  newPage();

  const ensureY = (needed = 20) => {
    if (y < MT + needed) newPage();
  };

  /** Scrie text cu wrap automat pe lățimea `maxW`. */
  const txt = (text, { x = ML, font = fR, size = 10, color = C_BLACK,
                       maxW = CW, lineH = null } = {}) => {
    if (!text) return;
    const s   = str(text);
    const lh  = lineH || size + 3;
    const words = s.split(' ');
    let line = '';
    const lines = [];
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) {
        lines.push(line); line = w;
      } else { line = test; }
    }
    if (line) lines.push(line);
    for (const ln of lines) {
      ensureY(lh + 2);
      pg.drawText(ln, { x, y, font, size, color });
      y -= lh;
    }
  };

  const hline = (thickness = 0.4, color = C_GREY) => {
    ensureY(6);
    pg.drawLine({ start: { x: ML, y }, end: { x: A4_W - ML, y }, thickness, color });
    y -= 6;
  };

  const spacer = (h = 6) => { y -= h; };

  /** Titlu secțiune cu fundal gri deschis. */
  const secTitle = (label) => {
    ensureY(20);
    spacer(4);
    pg.drawRectangle({ x: ML, y: y - 14, width: CW, height: 16,
      color: C_LIGHT, borderColor: C_GREY, borderWidth: 0.3 });
    pg.drawText(label, { x: ML + 4, y: y - 11, font: fB, size: 9, color: C_BLACK });
    y -= 18;
  };

  /** Câmp etichetă + valoare pe același rând sau pe rândul următor. */
  const field = (label, value, { size = 9, indent = 0 } = {}) => {
    if (!value && value !== 0) return;
    ensureY(16);
    const lw = fB.widthOfTextAtSize(label + ': ', size);
    const avail = CW - indent - lw;
    if (fR.widthOfTextAtSize(str(value), size) <= avail) {
      pg.drawText(label + ': ', { x: ML + indent, y, font: fB, size, color: C_BLACK });
      pg.drawText(str(value), { x: ML + indent + lw, y, font: fR, size, color: C_BLACK });
      y -= size + 4;
    } else {
      txt(label + ':', { font: fB, size, x: ML + indent });
      txt(str(value), { font: fR, size, x: ML + indent + 8, maxW: CW - indent - 8 });
    }
  };

  /** Checkbox vizual: pătrățel desenat + bifă dacă val=true. */
  const checkbox = (label, val, { size = 9, indent = 0 } = {}) => {
    ensureY(14);
    const bx = ML + indent;
    const bs = 8;
    pg.drawRectangle({ x: bx, y: y - bs + 2, width: bs, height: bs,
      borderColor: C_BLACK, borderWidth: 0.6, color: rgb(1,1,1) });
    if (bool(val)) {
      pg.drawLine({ start: { x: bx + 1, y: y - 2 }, end: { x: bx + 3, y: y - bs + 3 },
        thickness: 1, color: C_BLACK });
      pg.drawLine({ start: { x: bx + 3, y: y - bs + 3 }, end: { x: bx + bs - 1, y: y + 1 },
        thickness: 1, color: C_BLACK });
    }
    pg.drawText(str(label), { x: bx + bs + 4, y, font: fR, size, color: C_BLACK });
    y -= size + 4;
  };

  /** Rând casetă full-width cu etichetă bold + valoare inline. */
  const rowBox = (label, value, { hh = 16 } = {}) => {
    ensureY(hh + 2);
    pg.drawRectangle({ x: ML, y: y - hh, width: CW, height: hh,
      borderColor: C_BLACK, borderWidth: 0.4, color: rgb(1,1,1) });
    const lw = fB.widthOfTextAtSize(label + ': ', 8.5);
    pg.drawText(label + ': ', { x: ML + 4, y: y - 11, font: fB, size: 8.5, color: C_BLACK });
    const valStr = str(value);
    const avail  = CW - lw - 10;
    const disp   = fR.widthOfTextAtSize(valStr, 9) > avail
      ? valStr.slice(0, Math.floor(valStr.length * avail /
          fR.widthOfTextAtSize(valStr, 9))) + '…'
      : valStr;
    pg.drawText(disp, { x: ML + 4 + lw, y: y - 11, font: fR, size: 9, color: C_BLACK });
    y -= hh + 2;
  };

  /** Tabel generic cu coloane definite ca [{header, width, key?}]. */
  const drawTable = (cols, rows, { rowH = 16, headerBg = C_LIGHT } = {}) => {
    const totalW = cols.reduce((s, c) => s + c.width, 0);
    const scale  = CW / totalW;
    const widths = cols.map(c => c.width * scale);

    // Header
    ensureY(rowH + 4);
    let cx = ML;
    pg.drawRectangle({ x: ML, y: y - rowH, width: CW, height: rowH,
      color: headerBg, borderColor: C_BLACK, borderWidth: 0.4 });
    cols.forEach((col, i) => {
      const hw = fB.widthOfTextAtSize(col.header, 7.5);
      pg.drawText(col.header, {
        x: cx + Math.max(2, (widths[i] - hw) / 2),
        y: y - rowH + (rowH - 7.5) / 2,
        font: fB, size: 7.5, color: C_BLACK,
      });
      if (i < cols.length - 1) {
        pg.drawLine({ start: { x: cx + widths[i], y },
                      end:   { x: cx + widths[i], y: y - rowH },
                      thickness: 0.3, color: C_BLACK });
      }
      cx += widths[i];
    });
    y -= rowH;

    if (!rows || !rows.length) {
      // Rând gol
      ensureY(rowH);
      pg.drawRectangle({ x: ML, y: y - rowH, width: CW, height: rowH,
        borderColor: C_BLACK, borderWidth: 0.3, color: rgb(1,1,1) });
      pg.drawText('—', { x: ML + 4, y: y - rowH + (rowH - 8) / 2,
        font: fR, size: 8, color: C_GREY });
      y -= rowH;
      return;
    }

    rows.forEach(row => {
      ensureY(rowH + 2);
      let rx = ML;
      pg.drawRectangle({ x: ML, y: y - rowH, width: CW, height: rowH,
        borderColor: C_BLACK, borderWidth: 0.3, color: rgb(1,1,1) });
      cols.forEach((col, i) => {
        const val = str(col.key ? row[col.key] : '');
        if (val) {
          const disp = fR.widthOfTextAtSize(val, 8) > widths[i] - 4
            ? val.slice(0, Math.floor(val.length * (widths[i]-4) /
                fR.widthOfTextAtSize(val, 8))) + '…'
            : val;
          pg.drawText(disp, { x: rx + 3, y: y - rowH + (rowH - 8) / 2,
            font: fR, size: 8, color: C_BLACK });
        }
        if (i < cols.length - 1) {
          pg.drawLine({ start: { x: rx + widths[i], y },
                        end:   { x: rx + widths[i], y: y - rowH },
                        thickness: 0.3, color: C_BLACK });
        }
        rx += widths[i];
      });
      y -= rowH;
    });
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HEADER — Titlu + Date generale
  // ══════════════════════════════════════════════════════════════════════════

  // Titlu principal
  const titleW = fB.widthOfTextAtSize('REFERAT DE NECESITATE', 14);
  pg.drawText('REFERAT DE NECESITATE', {
    x: ML + (CW - titleW) / 2, y, font: fB, size: 14, color: C_BLACK,
  });
  y -= 20;
  if (title) {
    const subW = fR.widthOfTextAtSize(title, 10);
    if (subW <= CW) {
      pg.drawText(title, { x: ML + (CW - subW) / 2, y, font: fR, size: 10, color: C_GREY });
    } else {
      txt(title, { font: fR, size: 10, color: C_GREY });
    }
    y -= 6;
  }
  hline(0.6, C_BLACK);
  spacer(4);

  // Casetă date generale — 2 coloane
  const hdrH = 15;
  const col1W = CW * 0.55;
  const col2W = CW - col1W;

  const hdrRow = (l1, v1, l2, v2) => {
    ensureY(hdrH + 2);
    pg.drawRectangle({ x: ML, y: y - hdrH, width: col1W, height: hdrH,
      borderColor: C_BLACK, borderWidth: 0.4, color: rgb(1,1,1) });
    pg.drawRectangle({ x: ML + col1W, y: y - hdrH, width: col2W, height: hdrH,
      borderColor: C_BLACK, borderWidth: 0.4, color: rgb(1,1,1) });
    const draw = (lbl, val, ox) => {
      const lw = fB.widthOfTextAtSize(lbl + ': ', 8);
      pg.drawText(lbl + ': ', { x: ox + 3, y: y - 10, font: fB, size: 8, color: C_BLACK });
      pg.drawText(str(val), { x: ox + 3 + lw, y: y - 10, font: fR, size: 8, color: C_BLACK });
    };
    draw(l1, v1, ML);
    if (l2) draw(l2, v2, ML + col1W);
    y -= hdrH;
  };

  hdrRow('Autoritate contractantă', front.autoritate, 'Nr. referat', refNum);
  hdrRow('Emis de', front.emis_de, 'Data emiterii', front.data_emiterii);
  hdrRow('Aprobat de', front.aprobat_de, 'Data aprobării', front.data_aprobarii);
  if (front.adresa_autoritate) {
    rowBox('Adresa autorității', front.adresa_autoritate);
  }

  // Contact
  const ct = front.contact || {};
  if (ct.nume || ct.prenume || ct.email) {
    spacer(4);
    secTitle('Persoana de contact');
    const ctName = [ct.prenume, ct.nume].filter(Boolean).join(' ');
    if (ctName)   field('Nume', ctName);
    if (ct.functie)      field('Funcție', ct.functie);
    if (ct.compartiment) field('Compartiment', ct.compartiment);
    if (ct.email)        field('Email', ct.email);
    if (ct.telefon)      field('Telefon', ct.telefon);
  }

  // Scop + Forma + Revizuire
  spacer(4);
  const scopMap = { ACHIZITIE_NOUA: 'Achiziție nouă', REINNOIRE: 'Reînnoire contract',
                    SUPLIMENTARE: 'Suplimentare cantități', MODIFICARE: 'Modificare contract' };
  const formaMap = { INITIALA: 'Formă inițială', REVIZUITA: 'Formă revizuită' };
  if (front.scop) field('Scopul referatului', scopMap[front.scop] || front.scop);
  if (front.scop_an)    field('An achiziție', front.scop_an);
  if (front.forma)      field('Forma', formaMap[front.forma] || front.forma);
  if (front.nr_revizuirii) field('Nr. revizuirii', front.nr_revizuirii);

  // Tabel revizuiri (dacă există)
  const revRows = Array.isArray(front.istoric_revizuiri) ? front.istoric_revizuiri : [];
  if (revRows.length) {
    spacer(4);
    secTitle('Istoricul revizuirilor');
    drawTable([
      { header: 'Nr.',       width: 25,  key: 'nr' },
      { header: 'Tip',       width: 55,  key: 'tip' },
      { header: 'Data',      width: 50,  key: 'data' },
      { header: 'Capitol',   width: 60,  key: 'capitol' },
      { header: 'Motiv',     width: 120, key: 'motiv' },
      { header: 'Revizuit',  width: 80,  key: 'persoana_rev' },
      { header: 'Aprobat',   width: 80,  key: 'persoana_aprob' },
      { header: 'Data apr.', width: 50,  key: 'data_aprob' },
    ], revRows);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA A — Descrierea necesității
  // ══════════════════════════════════════════════════════════════════════════
  const A = data.A || {};
  secTitle('A. Descrierea necesității');
  if (A.obiect) txt(A.obiect, { font: fR, size: 9, maxW: CW });
  const destMap = { BUNURI_MOBILE: 'Bunuri mobile', BUNURI_IMOBILE: 'Bunuri imobile',
                    LUCRARI: 'Lucrări', SERVICII: 'Servicii' };
  if (A.destinatie) field('Destinația achiziției', destMap[A.destinatie] || A.destinatie);

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA B — Fundamentarea necesității
  // ══════════════════════════════════════════════════════════════════════════
  const B = data.B || {};
  secTitle('B. Fundamentarea necesității');
  if (B.fundamentare) txt(B.fundamentare, { font: fR, size: 9, maxW: CW });

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA C — Contribuția la obiectivele AC
  // ══════════════════════════════════════════════════════════════════════════
  const C = data.C || {};
  secTitle('C. Contribuția la obiectivele autorității contractante');
  if (C.necesitate_identificata) field('Necesitate identificată', C.necesitate_identificata, { size: 9 });
  if (C.obiectiv_ac)      field('Obiectiv AC', C.obiectiv_ac, { size: 9 });
  if (C.obiectiv_proiect) field('Obiectiv proiect', C.obiectiv_proiect, { size: 9 });
  if (C.obiectiv_strategic) field('Obiectiv strategic', C.obiectiv_strategic, { size: 9 });
  if (C.beneficii) field('Beneficii preconizate', C.beneficii, { size: 9 });

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA D — Justificarea modalității
  // ══════════════════════════════════════════════════════════════════════════
  const D = data.D || {};
  secTitle('D. Justificarea modalității de satisfacere a necesității');
  if (D.justificare) txt(D.justificare, { font: fR, size: 9, maxW: CW });

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA E — Tipul achiziției
  // ══════════════════════════════════════════════════════════════════════════
  const E = data.E || {};
  secTitle('E. Tipul achiziției și obiectul contractului');
  const tipMap = { LUCRARI: 'Lucrări', PRODUSE: 'Produse / Bunuri', SERVICII: 'Servicii' };
  if (E.tip) field('Tip achiziție', tipMap[E.tip] || E.tip);
  if (E.tip === 'LUCRARI') {
    if (E.obiect_lucrari)   field('Obiect contract lucrări', E.obiect_lucrari, { size: 9 });
    if (E.cpv_lucrari)      field('Cod CPV', E.cpv_lucrari, { size: 9 });
    if (E.amplasament)      field('Amplasament', E.amplasament, { size: 9 });
  } else if (E.tip === 'PRODUSE') {
    if (E.obiect_produse)    field('Obiect contract produse', E.obiect_produse, { size: 9 });
    if (E.cpv_produse)       field('Cod CPV', E.cpv_produse, { size: 9 });
    if (E.cantitate_produse) field('Cantitate', E.cantitate_produse, { size: 9 });
  } else if (E.tip === 'SERVICII') {
    if (E.obiect_servicii)  field('Obiect contract servicii', E.obiect_servicii, { size: 9 });
    if (E.cpv_servicii)     field('Cod CPV', E.cpv_servicii, { size: 9 });
    if (E.durata_servicii)  field('Durată contract', E.durata_servicii, { size: 9 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA F — Valoarea estimată
  // ══════════════════════════════════════════════════════════════════════════
  const F = data.F || {};
  secTitle('F. Valoarea estimată');
  if (E.tip === 'LUCRARI') {
    if (F.valoare_lucrari) field('Valoare estimată lucrări',
      `${F.valoare_lucrari} ${F.moneda_lucrari || 'RON'}`, { size: 9 });
    if (F.sursa_lucrari) field('Sursa valorii', F.sursa_lucrari, { size: 9 });
  } else if (E.tip === 'PRODUSE') {
    if (F.valoare_produse) field('Valoare estimată produse',
      `${F.valoare_produse} ${F.moneda_produse || 'RON'}`, { size: 9 });
    if (F.sursa_produse) field('Sursa valorii', F.sursa_produse, { size: 9 });
  } else if (E.tip === 'SERVICII') {
    if (F.valoare_servicii) field('Valoare estimată servicii',
      `${F.valoare_servicii} ${F.moneda_servicii || 'RON'}`, { size: 9 });
    if (F.sursa_servicii) field('Sursa valorii', F.sursa_servicii, { size: 9 });
  } else {
    if (F.valoare_lucrari)  field('Valoare lucrări',  `${F.valoare_lucrari} ${F.moneda_lucrari || 'RON'}`, { size: 9 });
    if (F.valoare_produse)  field('Valoare produse',  `${F.valoare_produse} ${F.moneda_produse || 'RON'}`, { size: 9 });
    if (F.valoare_servicii) field('Valoare servicii', `${F.valoare_servicii} ${F.moneda_servicii || 'RON'}`, { size: 9 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA G — Calendarul procesului de achiziție
  // ══════════════════════════════════════════════════════════════════════════
  const G = data.G || {};
  secTitle('G. Calendarul procesului de achiziție');
  if (G.semnare_contract)   field('Termen semnare contract', G.semnare_contract, { size: 9 });
  if (G.primul_subsecvent)  field('Primul act subsecvent', G.primul_subsecvent, { size: 9 });
  if (G.finalizare)         field('Termen finalizare', G.finalizare, { size: 9 });
  if (G.evaluare_obligatii) field('Evaluare obligații', G.evaluare_obligatii, { size: 9 });
  if (G.evaluare_beneficii) field('Evaluare beneficii', G.evaluare_beneficii, { size: 9 });
  if (G.just_semnare)       field('Justificare termen semnare', G.just_semnare, { size: 9 });
  if (G.just_subsecvent)    field('Justificare subsecvent', G.just_subsecvent, { size: 9 });
  if (G.just_finalizare)    field('Justificare finalizare', G.just_finalizare, { size: 9 });
  if (bool(G.cb_sinergie) || bool(G.cb_fonduri_eu) || bool(G.cb_proiect_amplu)) {
    spacer(3);
    txt('Considerente calendar:', { font: fB, size: 9 });
    checkbox('Sinergie cu alte proiecte / contracte',      G.cb_sinergie);
    checkbox('Fonduri europene — respectare termene-limită', G.cb_fonduri_eu);
    checkbox('Proiect amplu — etapizare necesară',         G.cb_proiect_amplu);
  }
  if (G.considerente) field('Alte considerente', G.considerente, { size: 9 });

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA H — Perspectiva pe termen scurt — fonduri alocate
  // ══════════════════════════════════════════════════════════════════════════
  const H = data.H || {};
  secTitle('H. Perspectiva pe termen scurt — fonduri alocate');
  if (H.valoare)    field('Valoare fonduri', `${H.valoare} ${H.moneda || 'RON'}`, { size: 9 });
  if (H.sursa)      field('Sursa finanțare', H.sursa, { size: 9 });
  if (H.pozitie)    field('Poziția bugetară', H.pozitie, { size: 9 });
  if (H.cod_ssi)    field('Cod SSI', H.cod_ssi, { size: 9 });
  if (H.program)    field('Program', H.program, { size: 9 });
  if (H.observatii) field('Observații', H.observatii, { size: 9 });

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA I — Resurse complementare
  // ══════════════════════════════════════════════════════════════════════════
  const I = data.I || {};
  secTitle('I. Resurse complementare');
  checkbox('Există resurse complementare identificate', I.aplicabil);
  if (bool(I.aplicabil)) {
    if (I.surse)   field('Surse complementare', I.surse, { size: 9 });
    if (I.detalii) field('Detalii', I.detalii, { size: 9 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA J — Caiet de sarcini / Documentație descriptivă
  // ══════════════════════════════════════════════════════════════════════════
  const J = data.J || {};
  secTitle('J. Caiet de sarcini / Documentație descriptivă');
  const sitMap = {
    EXISTA_CAIET: 'Există Caiet de sarcini elaborat și aprobat',
    FARA_CAIET: 'Nu există Caiet de sarcini — elaborare ulterioară',
  };
  if (J.situatie) field('Situație', sitMap[J.situatie] || J.situatie, { size: 9 });

  if (J.situatie === 'EXISTA_CAIET' && J.j1) {
    const j1 = J.j1;
    const modMap = {
      PERFORMANTA: 'Cerințe de performanță / funcționale',
      SPEC_TEHNICE_ECHIVALENT: 'Specificații tehnice + „sau echivalent"',
      MIXT_PERFORMANTA_SPEC: 'Mixt: performanță + specificații',
      MIXT_SPEC_PERFORMANTA: 'Mixt: specificații + performanță',
    };
    if (j1.modalitate)      field('Modalitate specificații tehnice', modMap[j1.modalitate] || j1.modalitate, { size: 9 });
    if (j1.modalitate_just) field('Justificare modalitate', j1.modalitate_just, { size: 9 });
    if (j1.spec_referinte)  field('Referințe utilizate', j1.spec_referinte, { size: 9 });

    const std = j1.standarde || {};
    const standarDeList = [
      [std.sr_en_iso,        'SR EN ISO'],
      [std.eval_tehnice_eu,  'Evaluări tehnice europene'],
      [std.spec_comune,      'Specificații tehnice comune'],
      [std.internationale,   'Standarde internaționale'],
      [std.sist_referinta,   'Sisteme de referință tehnice europene'],
      [std.nationale,        'Norme naționale'],
    ].filter(([v]) => bool(v));
    if (standarDeList.length) {
      spacer(3);
      txt('Standarde utilizate:', { font: fB, size: 9 });
      standarDeList.forEach(([, lbl]) => {
        ensureY(12); spacer(-2);
        pg.drawText('• ' + lbl, { x: ML + 10, y, font: fR, size: 9, color: C_BLACK });
        y -= 12;
      });
    }

    const ipMap = { DA_TRANSFER: 'Solicită transferul drepturilor IP', NU_TRANSFER: 'Nu solicită transfer IP' };
    if (j1.ip?.decizie) field('Drepturi IP (Caiet de sarcini)', ipMap[j1.ip.decizie] || j1.ip.decizie, { size: 9 });
    if (j1.ip?.just)    field('Justificare IP', j1.ip.just, { size: 9 });

    const duMap = { DA_DESIGN_UNIV: 'Aplică design universal', NU_DESIGN_UNIV: 'Nu aplică design universal' };
    if (j1.design_univ?.decizie) field('Design universal', duMap[j1.design_univ.decizie] || j1.design_univ.decizie, { size: 9 });
  }

  if (J.situatie === 'FARA_CAIET' && J.j2) {
    const j2 = J.j2;
    if (j2.elaborare)  field('Responsabil elaborare', j2.elaborare, { size: 9 });
    if (j2.orientare)  field('Orientare achiziție', j2.orientare, { size: 9 });
    if (j2.termen)     field('Termen elaborare', j2.termen, { size: 9 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA K — Factori cheie de succes
  // ══════════════════════════════════════════════════════════════════════════
  const K = data.K || {};
  secTitle('K. Factori cheie de succes');
  drawTable([
    { header: 'Factor cheie de succes',   width: 180, key: 'factor' },
    { header: 'Modalitate de măsurare',   width: 155, key: 'masurare' },
    { header: 'Indicatorul utilizat',     width: 155, key: 'indicator' },
  ], Array.isArray(K.factori) ? K.factori : []);

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA L — Factori interesați
  // ══════════════════════════════════════════════════════════════════════════
  const L = data.L || {};
  secTitle('L. Factori interesați relevanți');
  if (L.factori_interesati) txt(L.factori_interesati, { font: fR, size: 9, maxW: CW });
  else { ensureY(14); txt('—', { font: fR, size: 9, color: C_GREY }); }

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA M — Competențe pe etape
  // ══════════════════════════════════════════════════════════════════════════
  const M = data.M || {};
  secTitle('M. Competențe necesare pe etape de derulare');
  drawTable([
    { header: 'Etapă derulare',           width: 110, key: 'etapa' },
    { header: 'Comp. necesare',           width: 90,  key: 'necesare' },
    { header: 'Disponibile',             width: 80,  key: 'disponibile' },
    { header: 'Acces la comp.',           width: 90,  key: 'acces' },
    { header: 'Persoane atrase',          width: 120, key: 'atrase' },
  ], Array.isArray(M.competente) ? M.competente : []);

  // ══════════════════════════════════════════════════════════════════════════
  // SECȚIUNEA N — Anexe + Listă de verificare
  // ══════════════════════════════════════════════════════════════════════════
  const N = data.N || {};
  secTitle('N. Anexe și listă de verificare');

  // Anexe
  const anx = N.anexe || {};
  const anexeList = [
    [anx.caiet,          'Caiet de sarcini / Documentație descriptivă'],
    [anx.caracteristici, 'Definirea caracteristicilor tehnice și de calitate'],
    [anx.conditii,       'Condiții tehnice speciale'],
    [anx.criterii,       'Criterii de atribuire'],
    [anx.cercetare,      'Studiu de piață / cercetare de piață'],
  ].filter(([v]) => bool(v));
  if (N.anexe?.altele) {
    anexeList.push([true, 'Altele: ' + N.anexe.altele]);
  }
  if (anexeList.length) {
    txt('Documente anexate:', { font: fB, size: 9 });
    anexeList.forEach(([, lbl]) => {
      ensureY(12); spacer(-2);
      pg.drawText('• ' + lbl, { x: ML + 10, y, font: fR, size: 9, color: C_BLACK });
      y -= 12;
    });
    spacer(4);
  }

  // Listă de verificare DA/NU
  const checklist = Array.isArray(N.checklist) ? N.checklist : [];
  if (checklist.length) {
    ensureY(20);
    txt('Listă de verificare:', { font: fB, size: 9 });
    spacer(2);

    const clRowH = 18;
    const colNrW   = 22;
    const colDescW = CW - colNrW - 42 - 42;
    const colDaW   = 42;
    const colNuW   = 42;

    // Header checklist
    ensureY(clRowH + 2);
    pg.drawRectangle({ x: ML, y: y - clRowH, width: CW, height: clRowH,
      color: C_LIGHT, borderColor: C_BLACK, borderWidth: 0.4 });
    const hItems = [
      { lbl: 'Nr.', w: colNrW },
      { lbl: 'Criteriu de verificare', w: colDescW },
      { lbl: 'DA', w: colDaW },
      { lbl: 'NU', w: colNuW },
    ];
    let hx = ML;
    hItems.forEach(({ lbl, w }, i) => {
      const lw = fB.widthOfTextAtSize(lbl, 8);
      pg.drawText(lbl, { x: hx + (w - lw) / 2, y: y - 12, font: fB, size: 8, color: C_BLACK });
      if (i < hItems.length - 1) {
        pg.drawLine({ start: { x: hx + w, y }, end: { x: hx + w, y: y - clRowH },
          thickness: 0.3, color: C_BLACK });
      }
      hx += w;
    });
    y -= clRowH;

    // Rânduri checklist
    checklist.forEach((item) => {
      const label = str(item.label);
      const words = label.split(' ');
      let line = '';
      const lines = [];
      const maxDescW = colDescW - 6;
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (fR.widthOfTextAtSize(test, 8) > maxDescW && line) {
          lines.push(line); line = w;
        } else { line = test; }
      }
      if (line) lines.push(line);
      const rH = Math.max(clRowH, lines.length * 11 + 4);

      ensureY(rH + 2);
      pg.drawRectangle({ x: ML, y: y - rH, width: CW, height: rH,
        borderColor: C_BLACK, borderWidth: 0.3, color: rgb(1,1,1) });

      // Nr.
      const nrStr = str((item.idx ?? 0) + 1);
      pg.drawText(nrStr, {
        x: ML + (colNrW - fR.widthOfTextAtSize(nrStr, 8)) / 2,
        y: y - rH / 2 - 4, font: fR, size: 8, color: C_BLACK,
      });
      pg.drawLine({ start: { x: ML + colNrW, y }, end: { x: ML + colNrW, y: y - rH },
        thickness: 0.3, color: C_BLACK });

      // Descriere
      let ly = y - 10;
      lines.forEach((ln) => {
        pg.drawText(ln, { x: ML + colNrW + 3, y: ly, font: fR, size: 8, color: C_BLACK });
        ly -= 11;
      });
      pg.drawLine({ start: { x: ML + colNrW + colDescW, y },
                    end:   { x: ML + colNrW + colDescW, y: y - rH },
                    thickness: 0.3, color: C_BLACK });

      // Coloane DA / NU cu bifă
      const drawClBox = (ox, active) => {
        const bs = 9;
        const bx = ox + (colDaW - bs) / 2;
        const by = y - rH / 2 - bs / 2;
        pg.drawRectangle({ x: bx, y: by, width: bs, height: bs,
          borderColor: C_BLACK, borderWidth: 0.6, color: rgb(1,1,1) });
        if (active) {
          pg.drawLine({ start: { x: bx + 1.5, y: by + 3 }, end: { x: bx + 3.5, y: by + 1 },
            thickness: 1.2, color: C_BLACK });
          pg.drawLine({ start: { x: bx + 3.5, y: by + 1 }, end: { x: bx + bs - 0.5, y: by + bs - 0.5 },
            thickness: 1.2, color: C_BLACK });
        }
      };

      const daX  = ML + colNrW + colDescW;
      const nuX  = daX + colDaW;
      drawClBox(daX, item.raspuns === 'DA');
      pg.drawLine({ start: { x: nuX, y }, end: { x: nuX, y: y - rH },
        thickness: 0.3, color: C_BLACK });
      drawClBox(nuX, item.raspuns === 'NU');

      y -= rH;
    });
  }

  if (N.observatii) {
    spacer(4);
    field('Observații finale', N.observatii, { size: 9 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FOOTER SEMNĂTURĂ
  // ══════════════════════════════════════════════════════════════════════════
  spacer(16);
  hline(0.4);
  spacer(4);

  const sigDate = front.data_emiterii || '....................';
  txt(`Data: ${sigDate}`, { font: fR, size: 9 });
  spacer(14);

  const sw = (CW - 20) / 2;
  const s1x = ML;
  const s2x = ML + sw + 20;
  const sy  = y;

  const drawSig = (ox, lbl, name) => {
    pg.drawText(lbl, { x: ox, y: sy, font: fR, size: 8, color: C_GREY });
    pg.drawText(str(name) || '______________________________',
      { x: ox, y: sy - 18, font: fB, size: 9, color: C_BLACK });
  };

  const emis  = front.emis_de    || '';
  const aprob = front.aprobat_de || '';
  drawSig(s1x, 'Întocmit / Emis de:', emis);
  drawSig(s2x, 'Aprobat de:', aprob);

  return Buffer.from(await pdfDoc.save());
}
