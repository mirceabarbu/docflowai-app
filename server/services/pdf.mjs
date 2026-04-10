/**
 * server/services/pdf.mjs — PDF stamping service (v4 wrapper)
 *
 * Wraps server/pdf/stamp.mjs (v3) with a Buffer-in / Buffer-out API.
 * The underlying stampFooterOnPdf works with base64 and requires pdf-lib injection.
 */

import { stampFooterOnPdf as _stampFooter } from '../pdf/stamp.mjs';

// Lazy-import pdf-lib (already in dependencies, avoid top-level await in ES modules)
let _PDFLib = null;

async function _getPDFLib() {
  if (!_PDFLib) _PDFLib = await import('pdf-lib');
  return _PDFLib;
}

/**
 * stampFooterOnPdf — agegă footer pe PDF.
 *
 * @param {Buffer} pdfBuffer   — PDF original
 * @param {{ flowId, docName, orgName }} opts
 * @returns {Promise<Buffer>}
 */
export async function stampFooterOnPdf(pdfBuffer, { flowId = '', docName = '', orgName = '' } = {}) {
  const PDFLib  = await _getPDFLib();
  const pdfB64  = pdfBuffer.toString('base64');

  const flowData = {
    flowId,
    docName,
    initName:     orgName || docName,
    initFunctie:  '',
    institutie:   orgName || '',
    compartiment: '',
    createdAt:    new Date().toISOString(),
    flowType:     'tabel',
  };

  const resultB64 = await _stampFooter(pdfB64, flowData, PDFLib);
  return Buffer.from(resultB64, 'base64');
}
