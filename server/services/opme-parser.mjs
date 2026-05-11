/**
 * DocFlowAI — OPME (F1129) XFA parser
 *
 * Parsează F1129 „Ordin de Plată Multiplă Electronic" (Forexebug) din PDF
 * cu form XFA. Întoarce { header, lines, raw_meta } gata de inserat în
 * opme_imports / opme_lines.
 *
 * Erori (throw) — fiecare e un Error obișnuit cu .code setat:
 *   OPME_NOT_XFA            — PDF-ul nu are AcroForm/XFA (nu e formular electronic)
 *   OPME_INVALID_TEMPLATE   — XFA prezent dar universalCode nu începe cu 'F1129'
 *   OPME_VALIDATION_FAILED  — sumă/contor nu se potrivesc cu antet
 */

import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { XMLParser } from 'fast-xml-parser';

function _err(code, detail) {
  const e = new Error(`${code}: ${detail || ''}`.trim());
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

function _toNumber(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function _toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function _toStr(v) {
  if (v == null) return null;
  if (typeof v === 'object') return null; // self-closing element fără text
  const s = String(v).trim();
  return s === '' ? null : s;
}

// "06.05.2026" → Date UTC midnight; null dacă nu se potrivește DD.MM.YYYY
function _parseDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** Extrage XML-ul din XFA „datasets" stream. Aruncă OPME_NOT_XFA dacă lipsește. */
async function _extractDatasetsXml(pdfBuffer) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer, { throwOnInvalidObject: false });
  } catch (e) {
    throw _err('OPME_NOT_XFA', 'PDF invalid: ' + (e.message || 'load failed'));
  }
  const acroRef = doc.catalog.get(PDFName.of('AcroForm'));
  if (!acroRef) throw _err('OPME_NOT_XFA', 'PDF fără AcroForm');
  const acro = doc.context.lookup(acroRef);
  if (!acro || typeof acro.get !== 'function') throw _err('OPME_NOT_XFA', 'AcroForm invalid');
  const xfaObj = acro.get(PDFName.of('XFA'));
  if (!xfaObj) throw _err('OPME_NOT_XFA', 'AcroForm fără XFA');
  const xfa = doc.context.lookup(xfaObj);
  // XFA poate fi PDFArray (perechi name/stream) sau PDFStream (single packet).
  let dsStream = null;
  if (xfa instanceof PDFArray) {
    for (let i = 0; i + 1 < xfa.size(); i += 2) {
      const nm = doc.context.lookup(xfa.get(i));
      if (nm && String(nm) === '(datasets)') {
        dsStream = doc.context.lookup(xfa.get(i + 1));
        break;
      }
    }
  } else if (xfa instanceof PDFRawStream) {
    // Single packet — conține tot XDP-ul; căutăm <xfa:datasets> înăuntru.
    const all = Buffer.from(decodePDFRawStream(xfa).decode()).toString('utf-8');
    const m = all.match(/<xfa:datasets[\s\S]*?<\/xfa:datasets>/);
    if (!m) throw _err('OPME_NOT_XFA', 'XFA single-packet fără datasets');
    return m[0];
  }
  if (!dsStream) throw _err('OPME_NOT_XFA', 'XFA fără datasets stream');
  const xml = Buffer.from(decodePDFRawStream(dsStream).decode()).toString('utf-8');
  return xml;
}

/** Extrage „creator" din /Info dictionary (raw_meta). Best-effort. */
async function _readCreator(pdfBuffer) {
  try {
    const doc = await PDFDocument.load(pdfBuffer, { throwOnInvalidObject: false });
    return doc.getCreator() || null;
  } catch { return null; }
}

/**
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ header: object, lines: object[], raw_meta: object }>}
 */
export async function parseOpmePdf(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw _err('OPME_NOT_XFA', 'pdfBuffer trebuie să fie Buffer');
  }
  const xml = await _extractDatasetsXml(pdfBuffer);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,         // păstrăm tot ca string — convertim explicit
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    removeNSPrefix: true,         // 'xfa:datasets' → 'datasets'
  });
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw _err('OPME_NOT_XFA', 'XML invalid: ' + (e.message || 'parse failed'));
  }
  const main = doc?.datasets?.data?.form1?.MainForm;
  if (!main) throw _err('OPME_NOT_XFA', 'XFA fără form1/MainForm');

  const antet = main.SubformAntetOP || {};
  const universalCode = _toStr(antet.universalCode) || '';
  if (!/^F1129/i.test(universalCode)) {
    throw _err('OPME_INVALID_TEMPLATE', `universalCode='${universalCode}' (aștept F1129…)`);
  }

  const header = {
    nr_document:     _toStr(antet.NrDocument),
    data_op:         _parseDate(_toStr(antet.DataOP)),
    an_r:            _toInt(antet.an_r),
    luna_r:          _toInt(antet.luna_r),
    cif_platitor:    _toStr(antet.cif),
    den_platitor:    _toStr(antet.DenPlatitor),
    adresa_platitor: _toStr(antet.AdresaPl),
    nr_inregistrari: _toInt(antet.NrInregistrari),
    suma_totala:     _toNumber(antet.Suma_opm),
    universal_code:  universalCode,
  };

  // TableOP > Row1[]; fast-xml-parser produce array doar dacă sunt 2+ elemente.
  const tableRaw = main.TableOP || {};
  let rowsRaw = tableRaw.Row1 || [];
  if (!Array.isArray(rowsRaw)) rowsRaw = [rowsRaw];
  const rowCountRaw = rowsRaw.length;

  const lines = [];
  let idx = 0;
  for (const r of rowsRaw) {
    const nrOp = _toStr(r?.NrOp);
    if (!nrOp) continue; // template Row1 cu toate câmpurile self-closing
    const sumaOp = _toNumber(r?.SumaOp);
    if (sumaOp == null) continue; // suma obligatorie la nivel de linie reală
    lines.push({
      row_index:           idx++,
      nr_op:               nrOp,
      iban_platitor:       _toStr(r?.IbanPlatitor),
      den_trezorerie:      _toStr(r?.DenTrezorerie),
      cod_program:         _toStr(r?.CodProgram),
      cod_angajament:      _toStr(r?.CodAngajament),
      indicator_angajament:_toStr(r?.IndAngajament),
      den_beneficiar:      _toStr(r?.DenBeneficiar),
      cif_beneficiar:      _toStr(r?.CifBeneficiar),
      iban_beneficiar:     _toStr(r?.IbanBeneficiar),
      den_banca_trez:      _toStr(r?.DenBancaTrez),
      suma_op:             sumaOp,
      nr_evid_platii:      _toStr(r?.NrEvidPlatii),
      explicatii:          _toStr(r?.Explicatii),
    });
  }

  // Validare strictă antet vs linii.
  const sumLines = lines.reduce((a, l) => a + l.suma_op, 0);
  const errors = [];
  if (header.nr_inregistrari != null && header.nr_inregistrari !== lines.length) {
    errors.push(`nr_inregistrari=${header.nr_inregistrari} ≠ lines.length=${lines.length}`);
  }
  if (header.suma_totala != null && Math.abs(sumLines - header.suma_totala) > 0.01) {
    errors.push(`suma_totala=${header.suma_totala} ≠ Σ(lines.suma_op)=${sumLines.toFixed(2)}`);
  }
  if (errors.length) {
    throw _err('OPME_VALIDATION_FAILED', errors.join('; '));
  }

  const raw_meta = {
    creator:           await _readCreator(pdfBuffer),
    xfa_universal_code: universalCode,
    row_count_raw:     rowCountRaw,
    row_count_filled:  lines.length,
  };

  return { header, lines, raw_meta };
}
