/**
 * server/modules/forms/pdf-renderer.mjs — PDF generation for form instances.
 *
 * Strategy 1 (preferred): Fill an existing AcroForm PDF template using pdf-lib.
 * Strategy 2 (fallback):  Programmatic generation with NotoSans TTF.
 *
 * pdf_mapping_json schema:
 * {
 *   template: 'notafd' | 'ordnt' | null,   // name of PDF template in server/formulare/templates/
 *   fields: { [formFieldName]: 'pdfFieldName' }  // maps form data keys to AcroForm field names
 * }
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname }            from 'path';
import { fileURLToPath }            from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR     = join(__dir, '../../formulare/fonts');
const TEMPLATES_DIR = join(__dir, '../../formulare/templates');

// Lazy-import pdf-lib to avoid top-level await in ES modules
let _PDFLib = null;
async function getPDFLib() {
  if (!_PDFLib) _PDFLib = await import('pdf-lib');
  return _PDFLib;
}

// ── AcroForm fill ─────────────────────────────────────────────────────────────

/**
 * Fills an existing AcroForm PDF template with form data.
 *
 * @param {string}  templateName  — filename without extension (e.g. 'notafd')
 * @param {object}  fieldMap      — { [formDataKey]: 'pdfFieldName' }
 * @param {object}  data          — form instance data_json
 * @returns {Promise<Buffer>}
 */
async function fillAcroForm(templateName, fieldMap, data) {
  const templatePath = join(TEMPLATES_DIR, `${templateName}_template.pdf`);
  if (!existsSync(templatePath)) {
    throw new Error(`PDF template not found: ${templateName}_template.pdf`);
  }

  const { PDFDocument } = await getPDFLib();
  const templateBytes   = readFileSync(templatePath);
  const pdfDoc          = await PDFDocument.load(templateBytes);
  const form            = pdfDoc.getForm();

  for (const [dataKey, pdfFieldName] of Object.entries(fieldMap ?? {})) {
    const value = data[dataKey];
    if (value == null) continue;
    try {
      const field = form.getTextField(pdfFieldName);
      field.setText(String(value));
    } catch {
      // Field may not exist in this template version — skip silently
    }
  }

  form.flatten();
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ── Programmatic generation ───────────────────────────────────────────────────

const FONT_REGULAR_PATH = join(FONTS_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD_PATH    = join(FONTS_DIR, 'NotoSans-Bold.ttf');

/**
 * Generates a simple two-column table PDF with form data.
 *
 * @param {object} schema        — form_versions.schema_json
 * @param {object} data          — form instance data_json
 * @param {string} [title]       — document title
 * @returns {Promise<Buffer>}
 */
async function generateProgrammatic(schema, data, title = 'Formular') {
  const { PDFDocument, rgb, StandardFonts } = await getPDFLib();
  const pdfDoc = await PDFDocument.create();

  // Embed fonts — try NotoSans TTF first, fall back to Helvetica
  let regularFont, boldFont;
  try {
    const regularBytes = readFileSync(FONT_REGULAR_PATH);
    const boldBytes    = readFileSync(FONT_BOLD_PATH);
    regularFont = await pdfDoc.embedFont(regularBytes);
    boldFont    = await pdfDoc.embedFont(boldBytes);
  } catch {
    regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  const PAGE_WIDTH  = 595;
  const PAGE_HEIGHT = 842;
  const MARGIN      = 40;
  const LINE_H      = 18;
  const LABEL_W     = 220;
  const VALUE_X     = MARGIN + LABEL_W + 10;
  const VALUE_W     = PAGE_WIDTH - MARGIN - VALUE_X - MARGIN;

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y    = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y    = PAGE_HEIGHT - MARGIN;
  };

  const ensure = (needed) => { if (y - needed < MARGIN) newPage(); };

  // Title
  ensure(40);
  page.drawText(title, {
    x: MARGIN, y, size: 14,
    font: boldFont, color: rgb(0.1, 0.1, 0.4),
  });
  y -= 28;

  // Date
  page.drawText(new Date().toLocaleDateString('ro-RO'), {
    x: MARGIN, y, size: 9, font: regularFont, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 20;

  // Divider
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 12;

  const fields = schema?.fields ?? Object.keys(data).map(k => ({ name: k, label: k }));

  for (const field of fields) {
    const value = data[field.name ?? field];
    if (value == null) continue;

    const label    = field.label ?? field.name ?? field;
    const valueStr = String(value);
    ensure(LINE_H + 4);

    // Shaded row background on alternating rows
    page.drawRectangle({
      x: MARGIN, y: y - 4, width: PAGE_WIDTH - MARGIN * 2, height: LINE_H,
      color: rgb(0.96, 0.96, 0.96), opacity: 0.5,
    });

    page.drawText(label, { x: MARGIN + 4, y, size: 9, font: boldFont, color: rgb(0.2, 0.2, 0.2), maxWidth: LABEL_W - 4 });
    page.drawText(valueStr, { x: VALUE_X, y, size: 9, font: regularFont, color: rgb(0.1, 0.1, 0.1), maxWidth: VALUE_W });

    y -= LINE_H;
  }

  // Footer
  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    p.drawText(`Pagina ${i + 1} din ${pages.length} — generat automat de DocFlowAI`, {
      x: MARGIN, y: 20, size: 7, font: regularFont, color: rgb(0.6, 0.6, 0.6),
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ── renderFormPdf (public API) ────────────────────────────────────────────────

/**
 * Renders a form instance as PDF.
 *
 * @param {object} version       — form_versions row (schema_json, pdf_mapping_json)
 * @param {object} data          — instance.data_json
 * @param {string} [title]       — document title for programmatic mode
 * @returns {Promise<Buffer>}
 */
export async function renderFormPdf(version, data, title = 'Formular') {
  const mapping = version.pdf_mapping_json ?? {};

  if (mapping.template && mapping.fields) {
    try {
      return await fillAcroForm(mapping.template, mapping.fields, data);
    } catch (err) {
      // Fall through to programmatic generation
    }
  }

  return generateProgrammatic(version.schema_json ?? {}, data, title);
}
