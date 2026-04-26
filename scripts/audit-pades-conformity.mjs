#!/usr/bin/env node
/**
 * DocFlowAI — PAdES Conformity Audit (Tranche 4 / Faza 1)
 *
 * Read-only diagnostic tool. Rulează SELECT pe document_revisions,
 * analizează fiecare PDF semnat 'signed_final', și generează raport markdown
 * cu nivelul PAdES atins efectiv conform ETSI EN 319 142-1.
 *
 * Niveluri PAdES standard:
 *   B-B   — Basic: doar CMS signature + signer cert
 *   B-T   — + Signature Timestamp (RFC 3161 timestamp în unsignedAttrs)
 *   B-LT  — + DSS (Document Security Store) cu OCSP/CRL pentru LTV
 *   B-LTA — + Document Timestamp peste DSS (archive timestamp)
 *
 * Usage:
 *   node scripts/audit-pades-conformity.mjs [--limit N] [--out PATH]
 *
 * Defaults:
 *   --limit  10           ultimele 10 PDF-uri semnate final
 *   --out    docs/PADES_CONFORMITY_AUDIT.md
 *
 * Environment:
 *   DATABASE_URL — folosit de pool-ul existent din server/db/index.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pool } from '../server/db/index.mjs';
import {
  extractPdfSignatures,
  verifyPdfSignatures,
} from '../server/services/certificate-verify.mjs';

// ── CLI args ──────────────────────────────────────────────────────────────
function parseArgs() {
  const args = { limit: 10, out: 'docs/PADES_CONFORMITY_AUDIT.md' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--limit') args.limit = parseInt(process.argv[++i], 10);
    else if (a === '--out') args.out = process.argv[++i];
  }
  return args;
}

// ── PAdES level detection (ETSI EN 319 142-1 mapping) ────────────────────
//
// OID-uri relevante pentru detecție:
//   id-aa-signatureTimeStampToken: 1.2.840.113549.1.9.16.2.14
//
// PDF DSS detection: prezența `/DSS` în PDF Catalog.
// Document Timestamp detection: prezența unei semnături cu `/SubFilter /ETSI.RFC3161`
//   sau `/Type /DocTimeStamp` într-o secțiune Sig.

function detectDssPresence(pdfBytes) {
  const pdfStr = pdfBytes.toString('binary');
  // DSS poate apărea ca /DSS direct în Catalog sau ca obj separat referit prin /DSS
  // Pattern conservativ: căutăm `/DSS` urmat de << sau de spațiu/cifră (ref indirect)
  return /\/DSS\s*(<<|\d)/.test(pdfStr);
}

function detectDssContent(pdfBytes) {
  const pdfStr = pdfBytes.toString('binary');
  return {
    has_certs:  /\/Certs\s*\[/.test(pdfStr),
    has_ocsps:  /\/OCSPs\s*\[/.test(pdfStr),
    has_crls:   /\/CRLs\s*\[/.test(pdfStr),
    has_vri:    /\/VRI\s*<</.test(pdfStr),
  };
}

function detectDocumentTimestamps(pdfBytes) {
  const pdfStr = pdfBytes.toString('binary');
  // Document timestamps au /SubFilter /ETSI.RFC3161 sau /Type /DocTimeStamp
  const etsiRfc = (pdfStr.match(/\/SubFilter\s*\/ETSI\.RFC3161/g) || []).length;
  const docTs   = (pdfStr.match(/\/Type\s*\/DocTimeStamp/g) || []).length;
  return Math.max(etsiRfc, docTs);
}

async function detectSignatureTimestamp(cmsHex) {
  // Detectează prezența id-aa-signatureTimeStampToken OID în CMS unsignedAttrs.
  // OID 1.2.840.113549.1.9.16.2.14 = 06 0B 2A 86 48 86 F7 0D 01 09 10 02 0E (DER)
  const TS_OID_HEX = '060b2a864886f70d010910020e';
  return cmsHex.toLowerCase().includes(TS_OID_HEX);
}

function inferPadesLevel({ has_dss, has_sig_timestamp, document_timestamps }) {
  if (document_timestamps > 0 && has_dss) return 'B-LTA';
  if (has_dss)                             return 'B-LT';
  if (has_sig_timestamp)                   return 'B-T';
  return 'B-B';
}

// ── Main audit logic ─────────────────────────────────────────────────────

async function auditOnePdf(row) {
  const pdfBytes = Buffer.from(row.pdf_base64, 'base64');

  const result = {
    flow_id:       row.flow_id,
    revision_id:   row.id,
    created_at:    row.created_at,
    size_bytes:    pdfBytes.length,
    sha256:        row.sha256,
    signatures:    [],
    pades_level:   'unknown',
    dss:           null,
    document_timestamps: 0,
    error:         null,
  };

  try {
    // 1. Extract raw signatures (ByteRange + CMS hex)
    const sigs = extractPdfSignatures(pdfBytes);
    if (sigs.length === 0) {
      result.error = 'no_signatures_found';
      return result;
    }

    // 2. Run existing L1-L6 verification
    const verifyOut = await verifyPdfSignatures(pdfBytes);

    // 3. PAdES-specific detections
    const has_dss = detectDssPresence(pdfBytes);
    const dss     = has_dss ? detectDssContent(pdfBytes) : null;
    const document_timestamps = detectDocumentTimestamps(pdfBytes);

    // 4. Per-signature analysis
    let any_sig_ts = false;
    for (let i = 0; i < sigs.length; i++) {
      const sig = sigs[i];
      const has_sig_ts = await detectSignatureTimestamp(sig.cmsHex);
      if (has_sig_ts) any_sig_ts = true;
      const verifyEntry = (verifyOut?.signatures || [])[i] || {};
      result.signatures.push({
        index: i,
        signer_cn:        verifyEntry.signerCN || null,
        signer_org:       verifyEntry.signerO  || null,
        issuer_cn:        verifyEntry.issuerCN || null,
        signing_time:     verifyEntry.signingTime || null,
        has_signature_timestamp: has_sig_ts,
        levels:           verifyEntry.levels || null,
        ltv_ready:        verifyEntry.ltv_ready || false,
        qtsp_detected:    verifyEntry.qtsp || null,
      });
    }

    // 5. Infer overall PAdES level
    result.pades_level = inferPadesLevel({
      has_dss,
      has_sig_timestamp: any_sig_ts,
      document_timestamps,
    });
    result.dss = dss;
    result.document_timestamps = document_timestamps;

  } catch (err) {
    result.error = err.message || String(err);
  }

  return result;
}

// ── Markdown report generation ───────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}

function generateReport(audits, meta) {
  const lines = [];
  const now = new Date().toISOString();

  lines.push(`# PAdES Conformity Audit — DocFlowAI`);
  lines.push('');
  lines.push(`**Generat:** ${now}`);
  lines.push(`**Versiune aplicație:** ${meta.appVersion}`);
  lines.push(`**Documente analizate:** ${audits.length}`);
  lines.push(`**Sursă:** \`document_revisions\` WHERE \`revision_type='signed_final'\` ORDER BY \`created_at\` DESC LIMIT ${meta.limit}`);
  lines.push('');
  lines.push(`## Distribuție niveluri PAdES (ETSI EN 319 142-1)`);
  lines.push('');

  const dist = {};
  for (const a of audits) {
    const lvl = a.error ? 'ERROR' : a.pades_level;
    dist[lvl] = (dist[lvl] || 0) + 1;
  }
  lines.push('| Nivel | Documente | % | Semantică |');
  lines.push('|---|---|---|---|');
  const semantics = {
    'B-B':   'Basic — doar CMS, fără timestamp și fără DSS. NU e LTV.',
    'B-T':   '+ Signature Timestamp. Dovadă temporală, dar fără date de revocare în doc.',
    'B-LT':  '+ DSS cu OCSP/CRL. Long-Term — validabil chiar după expirare cert.',
    'B-LTA': '+ Document Timestamp peste DSS. Long-Term Archival, conform arhivare 10+ ani.',
    'ERROR': 'Eroare la procesare — vezi detaliu document.',
  };
  for (const lvl of ['B-B', 'B-T', 'B-LT', 'B-LTA', 'ERROR']) {
    const count = dist[lvl] || 0;
    if (count === 0) continue;
    const pct = ((count / audits.length) * 100).toFixed(0);
    lines.push(`| **${lvl}** | ${count} | ${pct}% | ${semantics[lvl]} |`);
  }
  lines.push('');

  lines.push(`## QTSP detectați (Issuer CN)`);
  lines.push('');
  const qtsps = {};
  for (const a of audits) {
    for (const s of a.signatures || []) {
      const k = s.qtsp_detected || s.issuer_cn || 'Unknown';
      qtsps[k] = (qtsps[k] || 0) + 1;
    }
  }
  if (Object.keys(qtsps).length === 0) {
    lines.push('_Nicio semnătură procesată cu succes._');
  } else {
    lines.push('| Issuer / QTSP | Apariții |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(qtsps).sort((a,b) => b[1]-a[1])) {
      lines.push(`| ${k} | ${v} |`);
    }
  }
  lines.push('');

  lines.push(`## DSS prezent + conținut`);
  lines.push('');
  let withDss = 0, withCerts = 0, withOcsps = 0, withCrls = 0, withVri = 0;
  for (const a of audits) {
    if (a.dss) {
      withDss++;
      if (a.dss.has_certs) withCerts++;
      if (a.dss.has_ocsps) withOcsps++;
      if (a.dss.has_crls)  withCrls++;
      if (a.dss.has_vri)   withVri++;
    }
  }
  lines.push(`- Documente cu DSS: **${withDss} / ${audits.length}**`);
  lines.push(`  - cu /Certs: ${withCerts}`);
  lines.push(`  - cu /OCSPs: ${withOcsps}`);
  lines.push(`  - cu /CRLs: ${withCrls}`);
  lines.push(`  - cu /VRI (Validation Related Information): ${withVri}`);
  lines.push('');

  lines.push(`## Detaliu per document`);
  lines.push('');
  for (let i = 0; i < audits.length; i++) {
    const a = audits[i];
    lines.push(`### Doc ${i+1} — flow \`${a.flow_id}\``);
    lines.push('');
    lines.push(`- **Revision ID:** \`${a.revision_id}\``);
    lines.push(`- **Created:** ${a.created_at}`);
    lines.push(`- **Size:** ${formatBytes(a.size_bytes)}`);
    lines.push(`- **SHA-256:** \`${a.sha256 || '(missing)'}\``);
    if (a.error) {
      lines.push(`- **Eroare:** \`${a.error}\``);
      lines.push('');
      continue;
    }
    lines.push(`- **Nivel PAdES inferat:** **${a.pades_level}**`);
    lines.push(`- **DSS prezent:** ${a.dss ? `da (certs:${a.dss.has_certs}, ocsps:${a.dss.has_ocsps}, crls:${a.dss.has_crls}, vri:${a.dss.has_vri})` : 'nu'}`);
    lines.push(`- **Document timestamps:** ${a.document_timestamps}`);
    lines.push(`- **Semnături:** ${a.signatures.length}`);
    for (const s of a.signatures) {
      lines.push(`  - **#${s.index}** — ${s.signer_cn || '(no CN)'} / org: ${s.signer_org || '(no O)'}`);
      lines.push(`    - issuer: ${s.issuer_cn || '(unknown)'}`);
      lines.push(`    - signing time: ${s.signing_time || 'unknown'}`);
      lines.push(`    - signature timestamp: ${s.has_signature_timestamp ? 'da' : 'nu'}`);
      lines.push(`    - LTV ready: ${s.ltv_ready ? 'da' : 'nu'}`);
      lines.push(`    - QTSP: ${s.qtsp_detected || '(undetected)'}`);
      if (s.levels) {
        const lvlSummary = Object.entries(s.levels)
          .map(([k,v]) => `${k}:${v?.ok === true ? '✓' : v?.ok === false ? '✗' : '?'}`)
          .join(' ');
        lines.push(`    - L1-L6: ${lvlSummary}`);
      }
    }
    lines.push('');
  }

  lines.push(`## Concluzii și recomandări`);
  lines.push('');
  lines.push(`> Aceste recomandări sunt automate, bazate pe distribuția găsită. Validare manuală recomandată înainte de orice schimbare în pipeline-ul de signing.`);
  lines.push('');

  const tot = audits.length;
  const errors = dist.ERROR || 0;
  const validForLtv = (dist['B-LT'] || 0) + (dist['B-LTA'] || 0);
  const noLtv = (dist['B-B'] || 0) + (dist['B-T'] || 0);

  if (errors > 0) {
    lines.push(`- ⚠️ **${errors} document(e) au eșuat la procesare.** Verifică log-uri și PDF-urile asociate manual.`);
  }
  if (validForLtv === tot - errors && tot > 0) {
    lines.push(`- ✅ **Toate documentele ating nivel B-LT sau superior.** STS produce LTV-ready signatures. Recomandare: trecere directă la **FAZA 2** (extindere validator cu raportare nivel PAdES).`);
  } else if (noLtv > 0) {
    lines.push(`- 📋 **${noLtv} document(e) NU sunt LTV (B-B/B-T)**. Pentru conformitate eIDAS pe arhivare lungă (10+ ani), aceste documente ar avea nevoie de post-procesare către B-LT prin adăugare DSS.`);
    lines.push(`  - Investigare necesară: STS Cloud QES generează B-LT direct? Dacă nu, considerare pas LTV-extension în Java microservice (scope FAZA 5, decizie viitoare).`);
  }
  if ((dist['B-LTA'] || 0) === 0 && tot > 0) {
    lines.push(`- ℹ️ **Niciun document nu e B-LTA** (Long-Term Archival). Pentru conformitate arhivare 20+ ani, document timestamp post-DSS ar fi necesar. Decizie: poate fi obținut prin re-timestamp anual peste DSS existent.`);
  }
  if (Object.keys(qtsps).length > 1) {
    lines.push(`- 🔍 **Multipli QTSP detectați** (${Object.keys(qtsps).length} issuer-i unici). Verifică dacă toți sunt în Trusted List Romania (https://www.tl.ro). Pentru eIDAS cross-border, verifică Trusted List EU.`);
  }
  if (withDss < tot && tot > 0) {
    lines.push(`- 📊 **${tot - withDss} / ${tot} documente fără DSS.** Acestea NU pot fi validate offline după expirare certificat. Recomandare: investigare cauză (STS configurație? bypass în anumite flow-uri?).`);
  }

  lines.push('');
  lines.push(`---`);
  lines.push(`_Audit generat de \`scripts/audit-pades-conformity.mjs\` — Tranche 4 / Faza 1._`);

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log(`[audit-pades] Starting — limit=${args.limit}, out=${args.out}`);

  let pkgVersion = '?';
  try {
    const pkg = await import('../package.json', { assert: { type: 'json' } });
    pkgVersion = pkg.default.version;
  } catch (_) {}

  console.log(`[audit-pades] Querying document_revisions...`);
  const { rows } = await pool.query(`
    SELECT id, flow_id, revision_type, pdf_base64, sha256, created_at
    FROM document_revisions
    WHERE revision_type = 'signed_final'
      AND pdf_base64 IS NOT NULL
      AND length(pdf_base64) > 1000
    ORDER BY created_at DESC
    LIMIT $1
  `, [args.limit]);

  console.log(`[audit-pades] Found ${rows.length} signed_final documents.`);

  if (rows.length === 0) {
    console.error('[audit-pades] No documents to audit. Exit 1.');
    await pool.end();
    process.exit(1);
  }

  const audits = [];
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(`[audit-pades] Processing ${i+1}/${rows.length} (flow ${rows[i].flow_id})... `);
    try {
      const audit = await auditOnePdf(rows[i]);
      audits.push(audit);
      process.stdout.write(`${audit.error ? 'ERROR' : audit.pades_level}\n`);
    } catch (err) {
      audits.push({
        flow_id: rows[i].flow_id,
        revision_id: rows[i].id,
        created_at: rows[i].created_at,
        error: err.message || String(err),
        signatures: [],
      });
      process.stdout.write(`FATAL: ${err.message}\n`);
    }
  }

  const md = generateReport(audits, { appVersion: pkgVersion, limit: args.limit });

  const outPath = resolve(process.cwd(), args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, md, 'utf8');

  console.log(`[audit-pades] Report written: ${outPath} (${md.length} bytes)`);
  console.log(`[audit-pades] Summary:`);
  const dist = {};
  for (const a of audits) {
    const lvl = a.error ? 'ERROR' : a.pades_level;
    dist[lvl] = (dist[lvl] || 0) + 1;
  }
  for (const [k, v] of Object.entries(dist)) {
    console.log(`  ${k}: ${v}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('[audit-pades] Fatal:', err);
  process.exit(2);
});
