/**
 * DocFlowAI — server/routes/formulare.mjs
 *
 * Formulare oficiale: Ordonanțare de Plată (ORDNT) + Document de Fundamentare (NOTAFD)
 * Completare date în UI → generare XML datasets → injectare XFA în PDF template → PDF completat
 *
 * REGISTRARE în server/index.mjs (sau routes/index):
 *   import { formulareRouter } from './routes/formulare.mjs';
 *   app.use(formulareRouter);
 *
 * TEMPLATE-URI PDF: puneți fișierele în:
 *   server/formulare/templates/ordnt_template.pdf
 *   server/formulare/templates/notafd_template.pdf
 */

import { Router, json as expressJson } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { logger } from '../middleware/logger.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router   = Router();
const _json5m  = expressJson({ limit: '5mb' });

const TEMPLATES_DIR = path.resolve(__dirname, '../formulare/templates');

// ── Helper: escape XML attributes ─────────────────────────────────────────────

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Builder XML datasets ORDNT ─────────────────────────────────────────────────

function buildOrdntXml(d) {
  const df = d.docFd || {};
  const rows = (df.rowTfd || []).map(r => `
      <rowTfd
        cod_angajament="${esc(r.cod_angajament)}"
        indicator_angajament="${esc(r.indicator_angajament)}"
        program="${esc(r.program)}"
        cod_SSI="${esc(r.cod_SSI)}"
        receptii="${esc(r.receptii || 0)}"
        plati_anterioare="${esc(r.plati_anterioare || 0)}"
        suma_ordonantata_plata="${esc(r.suma_ordonantata_plata || 0)}"
        receptii_neplatite="${esc(r.receptii_neplatite || 0)}"
      />`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">
<xfa:data>
<ORDNT xmlns="mfp:anaf:dgti:ordnt:declaratie:v1"
  Cif="${esc(d.Cif)}"
  DenInstPb="${esc(d.DenInstPb)}"
  NrOrdonantPl="${esc(d.NrOrdonantPl)}"
  DataOrdontPl="${esc(d.DataOrdontPl)}">
  <docFd
    nr_unic_inreg="${esc(df.nr_unic_inreg)}"
    beneficiar="${esc(df.beneficiar)}"
    documente_justificative="${esc(df.documente_justificative)}"
    iban_beneficiar="${esc(df.iban_beneficiar)}"
    cif_beneficiar="${esc(df.cif_beneficiar)}"
    banca_beneficiar="${esc(df.banca_beneficiar)}"
    inf_pv_plata="${esc(df.inf_pv_plata)}"
    inf_pv_plata1="${esc(df.inf_pv_plata1)}"
  >${rows}
  </docFd>
</ORDNT>
</xfa:data>
</xfa:datasets>`;
}

// ── Builder XML datasets NOTAFD ───────────────────────────────────────────────

function buildNotafdXml(d) {
  const sA   = d.sectiuneaA     || {};
  const angV = sA.ang_legale_val   || {};
  const angP = sA.ang_legale_plati || {};
  const sB   = d.sectiuneaB     || {};

  const rowsVal = (angV.rowT_ang_pl_val || []).map(r => `
      <rowT_ang_pl_val
        element_fd="${esc(r.element_fd)}"
        program="${esc(r.program)}"
        codSSI="${esc(r.codSSI)}"
        param_fd="${esc(r.param_fd)}"
        valt_rev_prec="${esc(r.valt_rev_prec || 0)}"
        influente="${esc(r.influente || 0)}"
        valt_actualiz="${esc(r.valt_actualiz || 0)}"
      />`).join('');

  const rowsPlati = (angP.rowT_ang_pl_plati || []).map(r => `
      <rowT_ang_pl_plati
        program="${esc(r.program)}"
        codSSI="${esc(r.codSSI)}"
        plati_ani_precedenti="${esc(r.plati_ani_precedenti || 0)}"
        plati_estim_ancrt="${esc(r.plati_estim_ancrt || 0)}"
        plati_estim_an_np1="${esc(r.plati_estim_an_np1 || 0)}"
        plati_estim_an_np2="${esc(r.plati_estim_an_np2 || 0)}"
        plati_estim_an_np3="${esc(r.plati_estim_an_np3 || 0)}"
        plati_estim_ani_ulter="${esc(r.plati_estim_ani_ulter || 0)}"
      />`).join('');

  const rowsCtrl = (sB.rowT_ang_ctrl_ang || []).map(r => `
    <rowT_ang_ctrl_ang
      cod_angajament="${esc(r.cod_angajament)}"
      indicator_angajament="${esc(r.indicator_angajament)}"
      program="${esc(r.program)}"
      cod_SSI="${esc(r.cod_SSI)}"
      sum_rezv_crdt_ang_af_rvz_prc="${esc(r.sum_rezv_crdt_ang_af_rvz_prc || 0)}"
      influente_c6="${esc(r.influente_c6 || 0)}"
      sum_rezv_crdt_ang_act="${esc(r.sum_rezv_crdt_ang_act || 0)}"
      sum_rezv_crdt_bug_af_rvz_prc="${esc(r.sum_rezv_crdt_bug_af_rvz_prc || 0)}"
      influente_c9="${esc(r.influente_c9 || 0)}"
      sum_rezv_crdt_bug_act="${esc(r.sum_rezv_crdt_bug_act || 0)}"
    />`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">
<xfa:data>
<NOTAFD xmlns="mfp:anaf:dgti:notafd:declaratie:v1"
  Cif="${esc(d.Cif)}"
  DenInstPb="${esc(d.DenInstPb)}"
  SubtitluDF="${esc(d.SubtitluDF)}"
  NrUnicInreg="${esc(d.NrUnicInreg)}"
  Revizuirea="${esc(d.Revizuirea)}"
  DataRevizuirii="${esc(d.DataRevizuirii)}">
  <sectiuneaA
    compartiment_specialitate="${esc(sA.compartiment_specialitate)}"
    obiect_fd_reviz_scurt="${esc(sA.obiect_fd_reviz_scurt)}"
    obiect_fd_reviz_lung="${esc(sA.obiect_fd_reviz_lung)}">
    <ang_legale_val
      ckbx_stab_tin_cont="${esc(angV.ckbx_stab_tin_cont)}"
      ckbx_ramane_suma="${esc(angV.ckbx_ramane_suma)}"
      ramane_suma="${esc(angV.ramane_suma || 0)}"
    >${rowsVal}
    </ang_legale_val>
    <ang_legale_plati
      ckbx_fara_ang_emis_ancrt="${esc(angP.ckbx_fara_ang_emis_ancrt)}"
      ckbx_cu_ang_emis_ancrt="${esc(angP.ckbx_cu_ang_emis_ancrt)}"
      ckbx_sting_ang_in_ancrt="${esc(angP.ckbx_sting_ang_in_ancrt)}"
      ckbx_fara_plati_ang_in_ancrt="${esc(angP.ckbx_fara_plati_ang_in_ancrt)}"
      ckbx_cu_plati_ang_in_mmani="${esc(angP.ckbx_cu_plati_ang_in_mmani)}"
      ckbx_ang_leg_emise_ct_an_urm="${esc(angP.ckbx_ang_leg_emise_ct_an_urm)}"
    >${rowsPlati}
    </ang_legale_plati>
  </sectiuneaA>
  <sectiuneaB
    ckbx_secta_inreg_ctrl_ang="${esc(sB.ckbx_secta_inreg_ctrl_ang)}"
    ckbx_fara_inreg_ctrl_ang="${esc(sB.ckbx_fara_inreg_ctrl_ang)}"
    sum_fara_inreg_ctrl_crdbug="${esc(sB.sum_fara_inreg_ctrl_crdbug || 0)}"
    ckbx_interzis_emit_ang="${esc(sB.ckbx_interzis_emit_ang)}"
    ckbx_interzis_intrucat="${esc(sB.ckbx_interzis_intrucat)}"
    intrucat="${esc(sB.intrucat)}"
  >${rowsCtrl}
  </sectiuneaB>
</NOTAFD>
</xfa:data>
</xfa:datasets>`;
}

// ── XFA injection: găsire datasets xref ───────────────────────────────────────

async function findDatasetsXref(pdfDoc) {
  const { PDFName } = await import('pdf-lib');
  try {
    const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    if (!acroFormRef) return null;
    const acroForm = pdfDoc.context.lookup(acroFormRef);
    const xfaRef   = acroForm.get(PDFName.of('XFA'));
    if (!xfaRef) return null;
    const xfaArr = pdfDoc.context.lookup(xfaRef);

    for (let i = 0; i + 1 < xfaArr.size(); i += 2) {
      try {
        const nameItem = xfaArr.get(i);
        // XFA array alternates: PDFString(name), PDFRef
        const name = nameItem.decodeText?.()
          || nameItem.value
          || nameItem.toString?.()
          || '';
        if (String(name).replace(/[()]/g, '') === 'datasets') {
          const ref = xfaArr.get(i + 1);
          return { objNum: ref.objectNumber, genNum: ref.generationNumber ?? 0 };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ── XFA injection: incremental update (datasets există — ORDNT) ───────────────

function getPrevStartxref(pdfBuffer) {
  // Căutăm ultimul 'startxref' din PDF
  const buf = pdfBuffer;
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0x73 && buf.slice(i, i + 9).toString() === 'startxref') {
      const rest = buf.slice(i + 9).toString('latin1').trimStart();
      const m = rest.match(/^(\d+)/);
      if (m) return parseInt(m[1]);
    }
  }
  throw new Error('startxref negăsit în PDF');
}

function appendObjectUpdate(pdfBuffer, objNum, genNum, xmlContent) {
  const xmlBytes    = Buffer.from(xmlContent, 'utf-8');
  const prevSX      = getPrevStartxref(pdfBuffer);

  // Noul obiect
  const header = Buffer.from(`\n${objNum} ${genNum} obj\n<< /Length ${xmlBytes.length} >>\nstream\n`);
  const footer = Buffer.from(`\nendstream\nendobj\n`);
  const newObj = Buffer.concat([header, xmlBytes, footer]);

  // Offset-ul noului obiect = lungimea bufferului original
  const newObjOffset = pdfBuffer.length;
  const xrefOffset   = newObjOffset + newObj.length;

  const offStr = String(newObjOffset).padStart(10, '0');
  const genStr = String(genNum).padStart(5, '0');

  // Xref cross-reference section + trailer + startxref
  const xrefSection = Buffer.from([
    `xref`,
    `${objNum} 1`,
    `${offStr} ${genStr} n `,
    `trailer`,
    `<< /Size ${objNum + 10} /Prev ${prevSX} >>`,
    `startxref`,
    `${xrefOffset}`,
    `%%EOF`,
    ``
  ].join('\n'));

  return Buffer.concat([pdfBuffer, newObj, xrefSection]);
}

// ── XFA injection: adăugare datasets (nu există — NOTAFD) incremental binar ──
// Nu apelează niciodată pdfDoc.save() — evită blocarea pe template-uri XFA.

async function addDatasetsIncremental(pdfBuffer, pdfDoc, xmlContent) {
  const { PDFName } = await import('pdf-lib');

  // 1. Alocă număr obiect nou (după cel mai mare din PDF)
  const nextObjNum = pdfDoc.context.largestObjectNumber + 1;
  const genNum     = 0;

  // 2. Găsește ref-ul obiectului XFA array
  const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
  const acroForm    = pdfDoc.context.lookup(acroFormRef);
  const xfaRef      = acroForm.get(PDFName.of('XFA'));
  const xfaObjNum   = xfaRef.objectNumber;
  const xfaGenNum   = xfaRef.generationNumber ?? 0;

  // 3. Citește intrările existente din XFA array
  const xfaArr = pdfDoc.context.lookup(xfaRef);
  const entries = [];
  for (let i = 0; i + 1 < xfaArr.size(); i += 2) {
    const name = (() => {
      try { return xfaArr.get(i).decodeText?.() || xfaArr.get(i).value || ''; }
      catch { return ''; }
    })();
    entries.push({ name: String(name).replace(/[()]/g, ''), ref: xfaArr.get(i + 1) });
  }

  // Inserează datasets înainte de xmpmeta sau postamble
  let insertIdx = entries.length;
  for (let i = 0; i < entries.length; i++) {
    if (['xmpmeta', 'postamble'].includes(entries[i].name)) { insertIdx = i; break; }
  }
  entries.splice(insertIdx, 0, { name: 'datasets', newObjNum: nextObjNum });

  // Reconstruiește XFA array ca string PDF
  const xfaArrStr = entries.map(e => {
    const refStr = e.newObjNum
      ? `${e.newObjNum} 0 R`
      : `${e.ref.objectNumber} ${e.ref.generationNumber ?? 0} R`;
    return `(${e.name}) ${refStr}`;
  }).join(' ');
  const newXfaContent = `[ ${xfaArrStr} ]`;

  // 4. Construiește incremental update binar
  const xmlBytes   = Buffer.from(xmlContent, 'utf-8');
  const prevSX     = getPrevStartxref(pdfBuffer);

  // Obiect 1: noul datasets stream (apare primul în buffer)
  const dsHeader = Buffer.from(`\n${nextObjNum} ${genNum} obj\n<< /Length ${xmlBytes.length} >>\nstream\n`);
  const dsFooter = Buffer.from(`\nendstream\nendobj\n`);
  const dsObj    = Buffer.concat([dsHeader, xmlBytes, dsFooter]);

  // Obiect 2: XFA array actualizat
  const xfaUpdated = Buffer.from(`\n${xfaObjNum} ${xfaGenNum} obj\n${newXfaContent}\nendobj\n`);

  const dsOffset   = pdfBuffer.length;
  const xfaOffset  = dsOffset + dsObj.length;
  const xrefOffset = xfaOffset + xfaUpdated.length;

  const pad10 = n => String(n).padStart(10, '0');
  const pad5  = n => String(n).padStart(5, '0');

  // Două subsecțiuni xref separate (objNum-uri neconsecutive)
  const xrefSection = Buffer.from([
    `xref`,
    `${xfaObjNum} 1`,
    `${pad10(xfaOffset)} ${pad5(xfaGenNum)} n `,
    `${nextObjNum} 1`,
    `${pad10(dsOffset)} ${pad5(genNum)} n `,
    `trailer`,
    `<< /Size ${nextObjNum + 1} /Prev ${prevSX} >>`,
    `startxref`,
    `${xrefOffset}`,
    `%%EOF`,
    ``
  ].join('\n'));

  return Buffer.concat([pdfBuffer, dsObj, xfaUpdated, xrefSection]);
}

// ── Funcție principală: fill XFA ──────────────────────────────────────────────

async function fillXfaTemplate(templateBuffer, datasetsXml) {
  const { PDFDocument } = await import('pdf-lib');

  // Parsăm PDF doar pentru a localiza datasets xref
  const pdfDoc     = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const datasetsXr = await findDatasetsXref(pdfDoc);

  if (datasetsXr) {
    // ORDNT: datasets există → incremental update (cel mai sigur)
    logger.info({ objNum: datasetsXr.objNum }, 'formulare: injectare XFA incremental update');
    return appendObjectUpdate(templateBuffer, datasetsXr.objNum, datasetsXr.genNum, datasetsXml);
  } else {
    // NOTAFD: datasets lipsă → injectare binară incrementală (fără pdfDoc.save())
    logger.info('formulare: adăugare datasets XFA (NOTAFD) incremental binar');
    return addDatasetsIncremental(templateBuffer, pdfDoc, datasetsXml);
  }
}

// ── Validare de bază server-side ──────────────────────────────────────────────

function validateOrdnt(d) {
  const errs = [];
  if (!d.Cif)         errs.push('Cif obligatoriu');
  if (!d.DenInstPb)   errs.push('DenInstPb obligatoriu');
  if (!d.NrOrdonantPl) errs.push('NrOrdonantPl obligatoriu');
  if (!d.DataOrdontPl) errs.push('DataOrdontPl obligatoriu');
  if (!/^[1-9]\d{1,9}$/.test(d.Cif || '')) errs.push('Cif format invalid');
  if (!/^([1-9]|0[1-9]|[12][0-9]|3[01])\.([1-9]|0[1-9]|1[012])\.\d{4}$/.test(d.DataOrdontPl || ''))
    errs.push('DataOrdontPl format invalid (DD.MM.YYYY)');
  const df = d.docFd || {};
  if (!df.beneficiar)   errs.push('beneficiar obligatoriu');
  if (!df.iban_beneficiar) errs.push('iban_beneficiar obligatoriu');
  if (!df.cif_beneficiar) errs.push('cif_beneficiar obligatoriu');
  if (!/^[1-9]\d{1,9}$/.test(df.cif_beneficiar || '')) errs.push('cif_beneficiar format invalid');
  if (!Array.isArray(df.rowTfd) || df.rowTfd.length === 0)
    errs.push('Cel puțin un rând rowTfd obligatoriu');
  return errs;
}

function validateNotafd(d) {
  const errs = [];
  if (!d.Cif)           errs.push('Cif obligatoriu');
  if (!d.DenInstPb)     errs.push('DenInstPb obligatoriu');
  if (!d.SubtitluDF)    errs.push('SubtitluDF obligatoriu');
  if (!d.NrUnicInreg)   errs.push('NrUnicInreg obligatoriu');
  if (!d.Revizuirea)    errs.push('Revizuirea obligatorie');
  if (!d.DataRevizuirii) errs.push('DataRevizuirii obligatorie');
  if (!/^[1-9]\d{1,9}$/.test(d.Cif || '')) errs.push('Cif format invalid');
  if (!/^([1-9]|0[1-9]|[12][0-9]|3[01])\.([1-9]|0[1-9]|1[012])\.\d{4}$/.test(d.DataRevizuirii || ''))
    errs.push('DataRevizuirii format invalid (DD.MM.YYYY)');
  const sA = d.sectiuneaA || {};
  if (!sA.compartiment_specialitate) errs.push('compartiment_specialitate obligatoriu');
  if (!sA.obiect_fd_reviz_scurt) errs.push('obiect_fd_reviz_scurt obligatoriu');
  const angV = sA.ang_legale_val || {};
  if (!Array.isArray(angV.rowT_ang_pl_val) || angV.rowT_ang_pl_val.length === 0)
    errs.push('Cel puțin un rând ang_legale_val obligatoriu');
  return errs;
}

// ── POST /api/formulare/generate ─────────────────────────────────────────────

router.post('/api/formulare/generate', requireAuth, _json5m, async (req, res) => {
  try {
    const { formType, data } = req.body || {};
    if (!formType || !data)
      return res.status(400).json({ error: 'formType și data sunt obligatorii' });
    if (!['ordnt', 'notafd'].includes(formType))
      return res.status(400).json({ error: 'formType invalid. Valori: ordnt, notafd' });

    // Validare
    const errs = formType === 'ordnt' ? validateOrdnt(data) : validateNotafd(data);
    if (errs.length > 0)
      return res.status(422).json({ error: 'Validare eșuată', errors: errs });

    // Template PDF
    const tplFile = formType === 'ordnt' ? 'ordnt_template.pdf' : 'notafd_template.pdf';
    const tplPath = path.join(TEMPLATES_DIR, tplFile);
    if (!fs.existsSync(tplPath)) {
      return res.status(404).json({
        error: 'template_not_found',
        message: `Template PDF lipsă. Copiați fișierul PDF în: server/formulare/templates/${tplFile}`,
      });
    }

    const templateBuffer = fs.readFileSync(tplPath);

    // Build XML
    const datasetsXml = formType === 'ordnt'
      ? buildOrdntXml(data)
      : buildNotafdXml(data);

    logger.info({ formType, actor: req.user?.email }, 'formulare: generare PDF');

    // Injectare XFA
    const filledPdf = await fillXfaTemplate(templateBuffer, datasetsXml);

    // Filename
    const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const fileName = formType === 'ordnt'
      ? `OrdonantarePlata_${(data.NrOrdonantPl||'').replace(/[^A-Za-z0-9_-]/g,'_')}_${ts}.pdf`
      : `DocumentFundamentare_${(data.NrUnicInreg||'').replace(/[^A-Za-z0-9_-]/g,'_')}_${ts}.pdf`;

    return res.json({ ok: true, pdfBase64: filledPdf.toString('base64'), fileName });

  } catch (e) {
    logger.error({ err: e }, 'formulare: eroare generare PDF');
    return res.status(500).json({ error: 'Eroare server la generare PDF', message: e.message });
  }
});

// ── GET /api/formulare/templates — verifică dacă template-urile există ────────

router.get('/api/formulare/templates', requireAuth, (req, res) => {
  const status = {};
  for (const [key, file] of [['ordnt','ordnt_template.pdf'],['notafd','notafd_template.pdf']]) {
    const p = path.join(TEMPLATES_DIR, file);
    status[key] = { configured: fs.existsSync(p), path: `server/formulare/templates/${file}` };
  }
  res.json({ templates: status });
});

export { router as formulareRouter };
