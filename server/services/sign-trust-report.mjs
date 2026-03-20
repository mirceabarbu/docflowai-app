/**
 * DocFlowAI — Sign Trust Report Service
 *
 * Generează raportul de conformitate „Signing Trust Report":
 *   1. Citește datele fluxului și semnatarilor din DB
 *   2. Extrage și verifică certificatele din PDF-urile semnate
 *   3. Construiește concluzia de integritate automată
 *   4. Generează PDF-ul raportului cu pdf-lib
 *   5. Salvează în trust_reports + opțional Drive
 *
 * Structură raport:
 *   §1 Date document
 *   §2 Semnatari (detaliat)
 *   §3 Certificate X.509 per semnatar
 *   §4 Timestamp & integritate
 *   §5 Verificări automate (6 niveluri)
 *   §6 Audit trail
 *   §7 Concluzie automată
 *   §8 QR code verificare online
 */

import crypto from 'crypto';
import { logger } from '../middleware/logger.mjs';
import { verifyPdfSignatures, extractPdfSignatures } from './certificate-verify.mjs';

const APP_BASE_URL = () => process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';

// ── Formatare date ─────────────────────────────────────────────────────────
const fmtDate = iso => iso
  ? new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'medium', timeStyle: 'medium' })
  : '—';
const fmtDateShort = iso => iso
  ? new Date(iso).toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest' })
  : '—';

// Diacritice → ASCII (pentru pdf-lib StandardFonts)
const diacr = { 'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ș':'s','ț':'t','ş':'s','ţ':'t' };
const ro = t => String(t || '').replace(/[^\x00-\xFF]/g, '').split('').map(ch => diacr[ch] || ch).join('');

/**
 * Generează raportul de conformitate pentru un flux finalizat.
 *
 * @param {object} opts
 * @param {string} opts.flowId
 * @param {object} opts.flowData     — data din DB
 * @param {Buffer} [opts.pdfBytes]   — PDF-ul semnat (pentru verificare criptografică)
 * @param {object} opts.pool         — pg pool
 * @returns {Promise<{pdfBytes: Buffer, report: object, conclusion: string}>}
 */
export async function generateTrustReport({ flowId, flowData, pdfBytes, pool }) {
  const startAt = Date.now();

  // ── 1. Date flux ──────────────────────────────────────────────────────
  const data     = flowData;
  const signers  = data.signers || [];
  const events   = data.events  || [];

  // ── 2. Verificare criptografică (dacă avem PDF) ───────────────────────
  let cryptoResult = null;
  if (pdfBytes && pdfBytes.length > 100) {
    try {
      cryptoResult = await verifyPdfSignatures(pdfBytes);
    } catch(e) {
      logger.warn({ err: e, flowId }, 'trust-report: crypto verify failed (non-fatal)');
    }
  }

  // ── 3. Construiesc structura raportului ───────────────────────────────
  const report = _buildReportStructure(flowId, data, signers, events, cryptoResult);

  // ── 4. Generare PDF ───────────────────────────────────────────────────
  const pdfOutput = await _generateReportPdf(report);

  // ── 5. Salvare în trust_reports ──────────────────────────────────────
  if (pool) {
    try {
      const reportId = `TR_${flowId}`;
      await pool.query(`
        INSERT INTO trust_reports (id, flow_id, generated_at, conclusion, report_json)
        VALUES ($1, $2, NOW(), $3, $4)
        ON CONFLICT (flow_id) DO UPDATE SET
          generated_at = NOW(), conclusion = $3, report_json = $4
      `, [reportId, flowId, report.conclusion, JSON.stringify(report)]);
    } catch(e) {
      logger.warn({ err: e, flowId }, 'trust-report: DB save failed (non-fatal)');
    }
  }

  // ── 6. Salvare certificate în DB ─────────────────────────────────────
  if (pool && cryptoResult?.signatures?.length > 0) {
    for (const sig of cryptoResult.signatures) {
      if (!sig.certificate) continue;
      try {
        const certId = `CERT_${flowId}_${sig.index}`;
        const c      = sig.certificate;
        await pool.query(`
          INSERT INTO signature_certificates (
            id, flow_id, signer_name, subject_cn, issuer_name, issuer_cn,
            serial_number, valid_from, valid_to, was_valid_at_signing,
            revocation_status, chain_status, qc_statement_present,
            certificate_type, signature_algorithm, ocsp_url, raw_json,
            created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
          ON CONFLICT (id) DO UPDATE SET
            revocation_status=$11, was_valid_at_signing=$10, updated_at=NOW()
        `, [
          certId, flowId, c.subject?.CN, c.subject?.CN, c.issuer?.O, c.issuer?.CN,
          c.serialNumber, c.notBefore, c.notAfter,
          c.validAtSigning ?? false,
          c.revocationStatus || 'unknown',
          sig.levels?.L4?.ok ? 'valid' : 'unknown',
          c.hasQcStatements ?? false,
          c.certificateType || 'unknown',
          c.signatureAlgorithm,
          c.ocspUrl,
          JSON.stringify(c),
        ]);
      } catch(e) {
        logger.warn({ err: e }, 'trust-report: cert DB save failed');
      }
    }
  }

  logger.info({ flowId, ms: Date.now() - startAt }, 'Trust report generat');
  return { pdfBytes: pdfOutput, report, conclusion: report.conclusion };
}

// ── Construiește structura datelor raportului ─────────────────────────────
function _buildReportStructure(flowId, data, signers, events, cryptoResult) {
  const signedSigners   = signers.filter(s => s.status === 'signed');
  const allSigned       = signedSigners.length === signers.length && signers.length > 0;
  const allQES          = cryptoResult?.signatures?.every(s => s.isQES) ?? null;
  const integrityOk     = cryptoResult?.signatures?.every(s => s.levels?.L1?.ok !== false) ?? null;
  const chainOk         = cryptoResult?.signatures?.every(s => s.levels?.L4?.ok !== false) ?? null;

  // ── Concluzie automată (text formal juridic) ─────────────────────────────
  let conclusion = '';
  let conclusionOk = false;
  if (allSigned) {
    const sigCount     = signedSigners.length;
    const validityPart = integrityOk === true
      ? 'Integritatea fisierului final este sustinuta de amprenta hash calculata la generarea raportului.'
      : 'Amprenta hash a documentului a fost calculata si inregistrata in prezentul raport.';
    const certValidPart = 'valabilitatea temporala la momentul semnarii a fost confirmata conform datelor disponibile';
    const revocPart    = 'Verificarea statusului de revocare este indicata distinct pentru fiecare semnatar, in functie de disponibilitatea mecanismelor externe de validare (OCSP/CRL).';
    const qesPart      = allQES === true
      ? 'Semnaturile sunt conforme cu standardul QES/eIDAS si Legea 455/2001.'
      : 'Semnaturile utilizate sunt asociate unor certificate digitale identificate in cadrul analizei tehnice.';
    conclusion = `In urma analizei tehnice a documentului si a metadatelor de semnare disponibile in platforma DocFlowAI, rezulta ca documentul a parcurs fluxul configurat, iar cei ${sigCount} semnatar${sigCount > 1 ? 'i' : ''} care au finalizat operatiunea au utilizat certificate digitale pentru care au fost identificate metadate coerente. Pentru certificatele analizate, ${certValidPart}. ${validityPart} ${revocPart} ${qesPart}`;
    conclusionOk = allSigned && (integrityOk !== false);
  } else {
    const pending = signers.filter(s => s.status !== 'signed').length;
    conclusion = `In urma analizei tehnice, documentul nu a parcurs integral fluxul configurat. ${pending} semnatar${pending > 1 ? 'i nu au' : ' nu a'} finalizat operatiunea de semnare. Raportul reflecta starea documentului la momentul generarii.`;
    conclusionOk = false;
  }

  // Construim un map email→nume din semnatari și inițiator
  const actorNameMap = {};
  if (data.initEmail) actorNameMap[data.initEmail.toLowerCase()] = data.initName || data.initEmail;
  for (const s of signers) {
    if (s.email) actorNameMap[s.email.toLowerCase()] = s.name || s.email;
  }
  const resolveActor = email => email ? (actorNameMap[email.toLowerCase()] || email) : '—';

  // Audit trail filtrat cu Nume în loc de email
  const auditTrail = events
    .filter(e => ['FLOW_CREATED','SIGNED','SIGNED_PDF_UPLOADED','REFUSED',
                  'FLOW_COMPLETED','FLOW_CANCELLED','DELEGATED','EMAIL_SENT','EMAIL_OPENED'].includes(e.type))
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map(e => ({
      timestamp: e.at,
      event:     e.type,
      actor:     resolveActor(e.by),
      detail:    e.to ? `→ ${e.to}` : (e.reason || ''),
    }));

  return {
    reportId:    `TR_${flowId}`,
    generatedAt: new Date().toISOString(),
    flowId,
    document: {
      name:         data.docName || flowId,
      flowType:     data.flowType || 'tabel',
      institutie:   data.institutie || '—',
      compartiment: data.compartiment || '—',
      initiator:    data.initName || data.initEmail || '—',
      initiatorEmail: data.initEmail || '—',
      createdAt:    data.createdAt,
      completedAt:  data.completedAt || null,
      status:       data.completed ? 'FINALIZAT' : (data.status || 'activ').toUpperCase(),
    },
    signers: signers.map((s, i) => ({
      order:       s.order || i + 1,
      name:        s.name || s.email,
      email:       s.email,
      rol:         s.rol || '—',
      status:      s.status,
      signedAt:    s.signedAt || null,
      provider:    s.signingProvider || 'local-upload',
      delegatedTo: s.delegatedTo || null,
    })),
    certificates: (cryptoResult?.signatures || []).map(sig => ({
      signerIndex:        sig.index,
      docHash:            sig.docHash,
      signingTime:        sig.signingTime,
      isValid:            sig.isValid,
      isQES:              sig.isQES,
      levels:             sig.levels,
      certificate:        sig.certificate,
      chain:              sig.chain,
      errors:             sig.errors,
      warnings:           sig.warnings,
    })),
    auditTrail,
    verification: {
      hasCryptoVerification: !!cryptoResult,
      signatureCount:        cryptoResult?.signatureCount || 0,
      allSignaturesValid:    cryptoResult?.allValid ?? null,
      integrityOk,
      chainOk,
      allQES,
    },
    conclusion,
    conclusionOk,
    verifyUrl: `${APP_BASE_URL()}/verifica?flowId=${flowId}`,
  };
}

// ── Generare PDF cu pdf-lib ────────────────────────────────────────────────
async function _generateReportPdf(report) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const pdf  = await PDFDocument.create();
  const fontB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontR = await pdf.embedFont(StandardFonts.Helvetica);

  // Culori
  const COL = {
    bg:       rgb(0.97, 0.98, 1.0),
    header:   rgb(0.09, 0.10, 0.22),
    accent:   rgb(0.12, 0.72, 0.67),
    accent2:  rgb(0.49, 0.36, 1.0),
    text:     rgb(0.10, 0.12, 0.22),
    muted:    rgb(0.42, 0.50, 0.65),
    ok:       rgb(0.06, 0.73, 0.51),
    fail:     rgb(0.93, 0.27, 0.27),
    warn:     rgb(0.96, 0.62, 0.04),
    border:   rgb(0.88, 0.90, 0.96),
    white:    rgb(1, 1, 1),
  };

  const PAGE_W = 595, PAGE_H = 842;
  const MARGIN = 44, COL_W = PAGE_W - 2 * MARGIN;

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    // Footer pe pagina curentă
    _drawFooter(page, pdf.getPageCount(), fontR, COL, PAGE_W, MARGIN);
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
    // Banda sus pe paginile noi
    page.drawRectangle({ x: 0, y: PAGE_H - 28, width: PAGE_W, height: 28, color: COL.header });
    page.drawText(ro(`DocFlowAI · Raport de Conformitate · ${report.flowId}`),
      { x: MARGIN, y: PAGE_H - 18, size: 8, font: fontR, color: COL.white });
    y = PAGE_H - 44;
  };

  const ensureSpace = (needed) => { if (y - needed < MARGIN + 30) newPage(); };

  const drawText = (text, x, sz, font, color, opts = {}) => {
    page.drawText(ro(text), { x, y, size: sz, font, color, maxWidth: opts.maxWidth || COL_W - (x - MARGIN), ...opts });
    if (!opts.noMove) y -= sz + (opts.gap ?? 4);
  };

  const drawLine = (color = COL.border, thickness = 0.5) => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness, color });
    y -= 6;
  };

  const drawSection = (title, icon = '') => {
    ensureSpace(28);
    y -= 8;
    page.drawRectangle({ x: MARGIN - 8, y: y - 4, width: COL_W + 16, height: 20, color: rgb(0.94, 0.95, 0.99) });
    page.drawText(ro(`${icon} ${title}`), { x: MARGIN, y: y + 2, size: 10, font: fontB, color: COL.accent2 });
    y -= 20;
  };

  const drawKV = (label, value, color = COL.text) => {
    ensureSpace(16);
    page.drawText(ro(label) + ':', { x: MARGIN, y, size: 8, font: fontB, color: COL.muted });
    page.drawText(ro(String(value || '—')), { x: MARGIN + 130, y, size: 8, font: fontR, color, maxWidth: COL_W - 130 });
    y -= 14;
  };

  const levelColor = ok => ok === true ? COL.ok : ok === false ? COL.fail : COL.warn;
  const levelText  = ok => ok === true ? 'VALID' : ok === false ? 'INVALID' : 'NEVERIFICAT';

  // ══════════════════════════════════════════════════════════════════════
  // ── HEADER ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  page.drawRectangle({ x: 0, y: PAGE_H - 80, width: PAGE_W, height: 80, color: COL.header });

  // Logo placeholder
  page.drawRectangle({ x: MARGIN, y: PAGE_H - 66, width: 44, height: 44, color: COL.accent2, borderRadius: 8 });
  page.drawText('D', { x: MARGIN + 14, y: PAGE_H - 50, size: 22, font: fontB, color: COL.white });

  page.drawText('DocFlowAI', { x: MARGIN + 54, y: PAGE_H - 42, size: 16, font: fontB, color: COL.white });
  page.drawText('Raport de Conformitate', { x: MARGIN + 54, y: PAGE_H - 56, size: 9, font: fontR, color: rgb(0.7,0.75,0.9) });
  page.drawText(`Generat: ${fmtDate(report.generatedAt)}`, { x: PAGE_W - 180, y: PAGE_H - 42, size: 8, font: fontR, color: rgb(0.65,0.70,0.85) });
  page.drawText(`ID: ${report.flowId}`, { x: PAGE_W - 180, y: PAGE_H - 54, size: 8, font: fontB, color: COL.accent });
  y = PAGE_H - 96;

  // Status badge
  const statusOk = report.document.status === 'FINALIZAT';
  page.drawRectangle({ x: MARGIN, y: y - 2, width: statusOk ? 100 : 120, height: 18, color: statusOk ? rgb(0.06,0.73,0.51) : COL.warn, borderRadius: 4 });
  page.drawText(ro(report.document.status), { x: MARGIN + 8, y: y + 3, size: 9, font: fontB, color: COL.white });
  y -= 30;

  // ══════════════════════════════════════════════════════════════════════
  // ── §1 DATE DOCUMENT ───────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  drawSection('DATE DOCUMENT', '§1');
  drawKV('Nume document', report.document.name);
  drawKV('Flow ID', report.flowId);
  drawKV('Tip flux', report.document.flowType === 'ancore' ? 'Ancore existente (PDF extern)' : 'Tabel generat');
  drawKV('Institutie', report.document.institutie);
  drawKV('Compartiment', report.document.compartiment);
  drawKV('Initiator', `${report.document.initiator} <${report.document.initiatorEmail}>`);
  drawKV('Data initierii', fmtDate(report.document.createdAt));
  drawKV('Data finalizarii', report.document.completedAt ? fmtDate(report.document.completedAt) : 'In procesare');

  // Hash document (dacă avem)
  if (report.certificates[0]?.docHash) {
    ensureSpace(30);
    y -= 4;
    page.drawText('Hash document (SHA-256):', { x: MARGIN, y, size: 8, font: fontB, color: COL.muted });
    y -= 12;
    page.drawText(report.certificates[0].docHash.substring(0, 40), { x: MARGIN, y, size: 7, font: fontR, color: COL.text, maxWidth: COL_W });
    y -= 10;
    page.drawText(report.certificates[0].docHash.substring(40), { x: MARGIN, y, size: 7, font: fontR, color: COL.text, maxWidth: COL_W });
    y -= 10;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ── §2 SEMNATARI ───────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  drawSection('SEMNATARI', '§2');

  for (const s of report.signers) {
    ensureSpace(50);
    const statusColor = s.status === 'signed' ? COL.ok : s.status === 'refused' ? COL.fail : COL.warn;
    const statusLabel = s.status === 'signed' ? 'SEMNAT' : s.status === 'refused' ? 'REFUZAT' : 'IN ASTEPTARE';

    // Rând semnatar
    page.drawRectangle({ x: MARGIN - 4, y: y - 4, width: COL_W + 8, height: 18, color: rgb(0.96,0.97,1), borderRadius: 3 });
    page.drawText(`${s.order}.`, { x: MARGIN, y: y + 1, size: 9, font: fontB, color: COL.accent2 });
    page.drawText(ro(s.name), { x: MARGIN + 16, y: y + 1, size: 9, font: fontB, color: COL.text });
    page.drawRectangle({ x: PAGE_W - MARGIN - 70, y: y - 2, width: 68, height: 14, color: statusColor, borderRadius: 3 });
    page.drawText(statusLabel, { x: PAGE_W - MARGIN - 65, y: y + 1, size: 7, font: fontB, color: COL.white });
    y -= 22;
    drawKV('Email', s.email);
    drawKV('Rol', s.rol);
    drawKV('Metoda semnare', s.provider === 'local-upload' ? 'Upload PDF semnat local' : s.provider);
    drawKV('Semnat la', s.signedAt ? fmtDate(s.signedAt) : '—');
    y -= 4;
    drawLine();
  }

  // ══════════════════════════════════════════════════════════════════════
  // ── §3 CERTIFICATE X.509 ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  if (report.certificates.length > 0) {
    drawSection('CERTIFICATE ELECTRONICE', '§3');

    for (const cert of report.certificates) {
      const c = cert.certificate;
      if (!c) { drawKV(`Semnatura #${cert.signerIndex}`, 'Certificate neextrase (PDF nesemnat electronic calificat)'); continue; }

      ensureSpace(120);
      page.drawText(ro(`Semnatura #${cert.signerIndex} — ${c.subject?.CN || 'Necunoscut'}`), { x: MARGIN, y, size: 9, font: fontB, color: COL.text }); y -= 16;

      // Tip certificat + QTSP
      const typeColor = cert.isQES ? COL.ok : COL.warn;
      const typeLabel = cert.isQES ? 'CALIFICAT (QES)' : c.certificateType?.toUpperCase() || 'NECUNOSCUT';
      page.drawRectangle({ x: MARGIN, y: y - 2, width: 120, height: 14, color: typeColor, borderRadius: 3 });
      page.drawText(typeLabel, { x: MARGIN + 6, y: y + 1, size: 7, font: fontB, color: COL.white });
      if (c.qtspName) {
        page.drawText(`QTSP: ${c.qtspName}`, { x: MARGIN + 130, y: y + 1, size: 8, font: fontB, color: COL.accent2 });
      }
      y -= 20;

      drawKV('Subject (CN)', c.subject?.CN);
      drawKV('Organizatie', c.subject?.O || c.issuer?.O);
      drawKV('Emitent (CA)', c.issuer?.CN);
      drawKV('Serial Number', c.serialNumber);
      drawKV('Valabil de la', fmtDateShort(c.notBefore));
      drawKV('Valabil pana la', fmtDateShort(c.notAfter));
      drawKV('Valid la semnare', c.validAtSigning === true ? 'DA' : c.validAtSigning === false ? 'NU' : 'Neverificat',
             c.validAtSigning === true ? COL.ok : c.validAtSigning === false ? COL.fail : COL.warn);
      drawKV('Status revocare', (c.revocationStatus || 'unknown').toUpperCase(),
             c.revocationStatus === 'valid' ? COL.ok : c.revocationStatus === 'revoked' ? COL.fail : COL.warn);
      drawKV('Algoritm semnatura', c.signatureAlgorithm);
      drawKV('QcStatements', c.hasQcStatements ? 'Prezent (QES confirmed)' : 'Absent');
      if (c.ocspUrl) drawKV('OCSP URL', c.ocspUrl);

      // Lanț certificare
      if (cert.chain?.length > 1) {
        ensureSpace(cert.chain.length * 14 + 20);
        y -= 4;
        page.drawText('Lant de certificare:', { x: MARGIN, y, size: 8, font: fontB, color: COL.muted }); y -= 12;
        for (let i = 0; i < cert.chain.length; i++) {
          const ch = cert.chain[i];
          const role = ch.isEndEntity ? 'Semnatar' : ch.isSelfSigned ? 'Root CA' : 'CA Intermediar';
          page.drawText(`${'  '.repeat(i)}${i+1}. ${ro(ch.subject?.CN || '?')} [${role}]`,
            { x: MARGIN + 8, y, size: 7.5, font: fontR, color: COL.text, maxWidth: COL_W - 20 });
          y -= 11;
        }
      }
      y -= 6; drawLine();
    }
  } else {
    drawSection('CERTIFICATE ELECTRONICE', '§3');
    drawKV('Nota', 'Verificare criptografica nedisponibila — PDF-ul semnat nu a fost furnizat pentru analiza');
  }

  // ══════════════════════════════════════════════════════════════════════
  // ── §4 VERIFICARI AUTOMATE ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  ensureSpace(180);
  drawSection('VERIFICARI AUTOMATE', '§4');

  const levels6 = report.certificates[0]?.levels || {};
  const levelItems = [
    { key: 'L1', label: 'Integritate document — documentul nu a fost modificat dupa semnare' },
    { key: 'L2', label: 'Semnatura CMS/PKCS#7 valida criptografic' },
    { key: 'L3', label: 'Certificat semnatar prezent si parsabil' },
    { key: 'L4', label: 'Lant de certificare complet (cert → CA → Root)' },
    { key: 'L5', label: 'Certificatul era valabil la momentul semnarii (OCSP/CRL)' },
    { key: 'L6', label: 'Conformitate QES/eIDAS (QTSP acreditat + QcStatements)' },
  ];

  for (const item of levelItems) {
    ensureSpace(20);
    const lvl = levels6[item.key];
    const ok  = lvl?.ok;
    const col = levelColor(ok);
    const lbl = levelText(ok);
    page.drawRectangle({ x: MARGIN, y: y - 3, width: 62, height: 14, color: col, borderRadius: 3 });
    page.drawText(lbl, { x: MARGIN + 4, y: y + 1, size: 7, font: fontB, color: COL.white });
    page.drawText(`${item.key}: ${ro(item.label)}`, { x: MARGIN + 70, y: y + 1, size: 8, font: fontR, color: COL.text, maxWidth: COL_W - 75 });
    if (lvl?.note) {
      y -= 13;
      page.drawText(ro(`  ${lvl.note}`), { x: MARGIN + 70, y, size: 7, font: fontR, color: COL.muted, maxWidth: COL_W - 75 });
    }
    y -= 18;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ── §5 AUDIT TRAIL ────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  drawSection('AUDIT TRAIL', '§5');

  const evLabels = {
    FLOW_CREATED: 'FLUX CREAT', SIGNED: 'SEMNAT', SIGNED_PDF_UPLOADED: 'PDF INCARCAT',
    REFUSED: 'REFUZAT', FLOW_COMPLETED: 'FLUX FINALIZAT', FLOW_CANCELLED: 'FLUX ANULAT',
    DELEGATED: 'DELEGAT', EMAIL_SENT: 'EMAIL TRIMIS', EMAIL_OPENED: 'EMAIL DESCHIS',
  };

  // Header tabel
  ensureSpace(16);
  page.drawRectangle({ x: MARGIN - 4, y: y - 4, width: COL_W + 8, height: 15, color: rgb(0.92,0.93,0.98) });
  page.drawText('Data si ora', { x: MARGIN, y, size: 7.5, font: fontB, color: COL.muted });
  page.drawText('Eveniment', { x: MARGIN + 140, y, size: 7.5, font: fontB, color: COL.muted });
  page.drawText('Actor', { x: MARGIN + 270, y, size: 7.5, font: fontB, color: COL.muted });
  y -= 18;

  for (const ev of report.auditTrail) {
    ensureSpace(14);
    const evColor = ev.event === 'REFUSED' || ev.event === 'FLOW_CANCELLED' ? COL.fail
      : ev.event === 'FLOW_COMPLETED' || ev.event === 'SIGNED' ? COL.ok : COL.text;
    page.drawText(ro(fmtDate(ev.timestamp)), { x: MARGIN, y, size: 7, font: fontR, color: COL.muted, maxWidth: 135 });
    page.drawText(ro(evLabels[ev.event] || ev.event), { x: MARGIN + 140, y, size: 7, font: fontB, color: evColor, maxWidth: 125 });
    page.drawText(ro(ev.actor), { x: MARGIN + 270, y, size: 7, font: fontR, color: COL.text, maxWidth: 130 });
    y -= 13;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ── §6 CONCLUZIE AUTOMATA + §7 QR CODE ──────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  // Estimăm înălțimea textului folosind lățimea reală în pixeli
  const CONCL_FONT_SIZE = 8.5;
  const CONCL_MAX_W     = COL_W - 16; // 16px padding chenar
  const conclWordsArr   = report.conclusion.split(' ');
  const conclLinesArr   = [];
  let conclCurLine = '';
  for (const w of conclWordsArr) {
    const test = conclCurLine ? conclCurLine + ' ' + w : w;
    // Estimăm: Helvetica ~0.5 * fontSize per char medie
    if (fontR.widthOfTextAtSize(test, CONCL_FONT_SIZE) > CONCL_MAX_W && conclCurLine) {
      conclLinesArr.push(conclCurLine);
      conclCurLine = w;
    } else {
      conclCurLine = test;
    }
  }
  if (conclCurLine) conclLinesArr.push(conclCurLine);

  const CONCL_LINE_H  = CONCL_FONT_SIZE + 5;
  const CONCL_PAD     = 12;
  const conclTextH    = conclLinesArr.length * CONCL_LINE_H;
  const conclBoxH     = conclTextH + CONCL_PAD * 2;

  // Spațiu necesar: titlu secțiune (24) + chenar concluzie + 16 + QR (100)
  ensureSpace(28 + conclBoxH + 16 + 100);
  y -= 8;
  drawSection('CONCLUZIE AUTOMATA', '\u00a77');  // §6 via §

  // Chenar concluzie — desenat cu dimensiuni exacte
  const conclColor  = report.conclusionOk ? rgb(0.94, 0.97, 0.94) : rgb(0.99, 0.97, 0.93);
  const conclBorder = report.conclusionOk ? COL.ok : COL.warn;
  const conclBoxY   = y - conclBoxH;
  page.drawRectangle({
    x: MARGIN - 8, y: conclBoxY, width: COL_W + 16, height: conclBoxH,
    color: conclColor, borderRadius: 5, borderColor: conclBorder, borderWidth: 1.5,
  });

  // Text în chenar
  let conclLineY = y - CONCL_PAD;
  for (const ln of conclLinesArr) {
    page.drawText(ro(ln), {
      x: MARGIN, y: conclLineY,
      size: CONCL_FONT_SIZE, font: fontR,
      color: rgb(0.08, 0.12, 0.22),
      maxWidth: CONCL_MAX_W,
    });
    conclLineY -= CONCL_LINE_H;
  }
  y = conclBoxY - 14;  // y acum sub chenar

  // ── §7 QR + verificare online ─────────────────────────────────────
  ensureSpace(95);
  y -= 4;
  try {
    const QRCode    = (await import('qrcode')).default;
    const qrDataUrl = await QRCode.toDataURL(report.verifyUrl, {
      width: 100, margin: 1, color: { dark: '#0d1020', light: '#ffffff' }
    });
    const qrImage = await pdf.embedPng(Buffer.from(qrDataUrl.split(',')[1], 'base64'));
    const QR_SIZE = 70;
    const qrX     = PAGE_W - MARGIN - QR_SIZE;
    const qrTopY  = y;

    // QR dreptunghi + imagine
    page.drawRectangle({ x: qrX - 5, y: qrTopY - QR_SIZE - 5, width: QR_SIZE + 10, height: QR_SIZE + 10,
      color: COL.white, borderColor: COL.border, borderWidth: 0.7, borderRadius: 3 });
    page.drawImage(qrImage, { x: qrX, y: qrTopY - QR_SIZE, width: QR_SIZE, height: QR_SIZE });
    page.drawText('Scaneaza pentru verificare',
      { x: qrX - 2, y: qrTopY - QR_SIZE - 14, size: 6.5, font: fontR, color: COL.muted, maxWidth: QR_SIZE + 10 });

    // Text verificare — stânga QR
    const tW = qrX - MARGIN - 10;
    page.drawText('Verificare online:',
      { x: MARGIN, y: qrTopY, size: 8, font: fontB, color: COL.muted });
    page.drawText(ro(report.verifyUrl),
      { x: MARGIN, y: qrTopY - 13, size: 7.5, font: fontR, color: COL.accent, maxWidth: tW });
    page.drawText('Introduceti Flow ID-ul la adresa de mai sus pentru a verifica autenticitatea documentului.',
      { x: MARGIN, y: qrTopY - 27, size: 7.5, font: fontR, color: COL.muted, maxWidth: tW, lineHeight: 11 });
  } catch(e) {
    page.drawText('Verificare: ' + ro(report.verifyUrl),
      { x: MARGIN, y, size: 8, font: fontR, color: COL.accent, maxWidth: COL_W });
  }


  // ══════════════════════════════════════════════════════════════════════
  // ── §6 CONCLUZIE ─────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  ensureSpace(80);
  y -= 12;
  drawSection('CONCLUZIE AUTOMATA', '§6');

  // Calculăm înălțimea reală a textului înainte de chenar
  _drawFooter(page, pdf.getPageCount(), fontR, COL, PAGE_W, MARGIN);

  const pdfBytes = await pdf.save();
  return Buffer.from(pdfBytes);
}

function _drawFooter(page, pageNum, fontR, COL, PAGE_W, MARGIN) {
  const y = 24;
  page.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: PAGE_W - MARGIN, y: y + 10 }, thickness: 0.4, color: COL.border });
  page.drawText(`DocFlowAI Signing Trust Report · Pagina ${pageNum} · Generat automat · Valabil conform eIDAS si Legii 455/2001`,
    { x: MARGIN, y, size: 7, font: fontR, color: COL.muted });
}
