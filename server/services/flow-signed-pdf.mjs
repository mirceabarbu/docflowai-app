/**
 * #220 — Livrează PDF-ul SEMNAT al unui flux. Sursă unică pentru:
 *   GET /flows/:flowId/signed-pdf              (flows/crud.mjs)
 *   GET /api/formulare-ord/:id/df-aprobat.pdf  (formulare/ord.mjs)
 * NU face autorizare — apelantul a decis deja accesul. `data` = rezultatul `getFlowData(flowId)`.
 *
 * Comportament bit-identic cu fostul corp inline din crud.mjs: bytes din `flows_pdfs`
 * (`signedPdfB64`), altfel stream din Drive (`storage==='drive'` + `driveFileIdFinal`),
 * altfel 404 `signed_pdf_missing`.
 *
 * @param {import('express').Response} res
 * @param {object} data
 * @param {string} flowId
 * @param {{ filename?: string }} [opts]
 */
export async function sendFlowSignedPdf(res, data, flowId, { filename } = {}) {
  const name = String(filename || `DocFlowAI_${flowId}_signed.pdf`).replace(/["\r\n]/g, '');
  const b64 = data?.signedPdfB64;
  if (!b64 || typeof b64 !== 'string') {
    if (data?.storage === 'drive' && data?.driveFileIdFinal) {
      try {
        const { streamFromDrive } = await import('../drive.mjs');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        await streamFromDrive(data.driveFileIdFinal, res);
        return;
      } catch (driveErr) {
        return res.status(502).json({ error: 'drive_unavailable' });
      }
    }
    return res.status(404).json({ error: 'signed_pdf_missing' });
  }
  const raw = b64.includes('base64,') ? b64.split('base64,')[1] : b64;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.status(200).send(Buffer.from(raw, 'base64'));
}
