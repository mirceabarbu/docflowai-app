#!/usr/bin/env node
/**
 * P0-06, pasul 1 — DIAGNOSTIC STRICT READ-ONLY.
 *
 * Scop: găsește retroactiv câte fluxuri deja `completed` din producție au un
 * `signedPdfB64` care nu conține NICIO semnătură reală (zero apariții `/ByteRange`),
 * folosind exact același extractor ca aplicația (`extractPdfSignatures`).
 *
 * Nu modifică NIMIC — zero UPDATE/INSERT/DELETE.
 *
 * Cum se rulează:
 *   DATABASE_URL=postgres://... node tools/diagnostic-p0-06-byterange-check.mjs
 *   opțional: --batch=200 --delay=300 --limit=50   (--limit pentru un test rapid întâi)
 *
 * Recomandare operațională: rulează SEARA, în afara orelor de program — scriptul
 * decodează efectiv PDF-uri (potențial multe MB fiecare) în loturi. Nu e instant,
 * dar nu blochează baza (SELECT-uri simple + decodare în Node, nimic costisitor
 * pe partea de Postgres).
 */
import pg from 'pg';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractPdfSignatures } from '../server/services/certificate-verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Încarcă .env manual (fără dependență de dotenv)
const envPath = resolve(__dirname, '../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* .env absent — se folosește environment-ul existent */ }

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ DATABASE_URL lipsă.'); process.exit(1); }

function parseArg(name, def) {
  const pfx = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(pfx));
  if (!arg) return def;
  const n = Number(arg.slice(pfx.length));
  return Number.isFinite(n) && n > 0 ? n : def;
}

const BATCH_SIZE = parseArg('batch', 200);
const DELAY_MS = parseArg('delay', 300);
const LIMIT = parseArg('limit', Infinity);

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const CANDIDATES_SQL = `
  SELECT f.id, f.data->>'docName' AS doc_name, f.data->>'completedAt' AS completed_at
  FROM flows f
  WHERE (f.data->>'status'='completed' OR (f.data->>'completed')::boolean=true)
    AND f.data->>'status' IS DISTINCT FROM 'cancelled'
    AND f.data->>'status' IS DISTINCT FROM 'refused'
    AND f.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM flows_pdfs p WHERE p.flow_id=f.id AND p.key='signedPdfB64')
  ORDER BY f.id
`;

const MISSING_SIGNED_PDF_SQL = `
  SELECT COUNT(*) FROM flows f
  WHERE (f.data->>'status'='completed' OR (f.data->>'completed')::boolean=true)
    AND f.data->>'status' IS DISTINCT FROM 'cancelled'
    AND f.data->>'status' IS DISTINCT FROM 'refused'
    AND f.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM flows_pdfs p WHERE p.flow_id=f.id AND p.key='signedPdfB64')
`;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('🔌 Conectare la baza de date...');

  const missingRes = await pool.query(MISSING_SIGNED_PDF_SQL);
  const missingCount = Number(missingRes.rows[0].count);

  const candRes = await pool.query(CANDIDATES_SQL);
  let candidates = candRes.rows;
  if (candidates.length > LIMIT) candidates = candidates.slice(0, LIMIT);

  console.log(`📋 Candidați de verificat: ${candidates.length} (loturi de ${BATCH_SIZE}, pauză ${DELAY_MS}ms)`);
  console.log(`⚠️  Completate FĂRĂ niciun signedPdfB64 stocat: ${missingCount}`);

  const suspects = [];
  let healthy = 0;
  let processed = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const ids = batch.map(r => r.id);
    const { rows: pdfRows } = await pool.query(
      `SELECT flow_id, data FROM flows_pdfs WHERE key='signedPdfB64' AND flow_id = ANY($1::text[])`,
      [ids]
    );
    const pdfByFlowId = new Map(pdfRows.map(r => [r.flow_id, r.data]));

    for (const row of batch) {
      const b64 = pdfByFlowId.get(row.id);
      if (!b64) continue; // nu ar trebui să se întâmple (EXISTS în query), dar defensiv
      const buf = Buffer.from(b64, 'base64');
      let sigCount = 0;
      try {
        sigCount = extractPdfSignatures(buf).length;
      } catch (e) {
        console.error(`  ⚠️  eroare la extractPdfSignatures pentru flow ${row.id}: ${e.message || e}`);
      }
      processed++;
      if (sigCount === 0) {
        suspects.push(row);
      } else {
        healthy++;
      }
    }

    console.log(`  ... lot ${Math.floor(i / BATCH_SIZE) + 1}: procesate ${processed}/${candidates.length} (suspecți până acum: ${suspects.length})`);

    if (i + BATCH_SIZE < candidates.length && DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n===== SUMAR =====');
  console.log(`Total candidați verificați: ${processed}`);
  console.log(`SUSPECȚI (0 semnături reale găsite): ${suspects.length}`);
  console.log(`SĂNĂTOȘI (≥1 semnătură reală găsită): ${healthy}`);
  console.log(`Completate fără niciun signedPdfB64 stocat: ${missingCount}`);

  if (suspects.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = resolve(__dirname, '../docs/audits');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `P0-06-DIAGNOSTIC-${today}.md`);
    const lines = [
      `# P0-06 — Diagnostic fluxuri SUSPECTE (fără semnătură reală în signedPdfB64)`,
      ``,
      `Generat: ${new Date().toISOString()}`,
      ``,
      `Total candidați verificați: ${processed}`,
      `Suspecți: ${suspects.length}`,
      `Sănătoși: ${healthy}`,
      `Completate fără niciun signedPdfB64 stocat: ${missingCount}`,
      ``,
      `| flow_id | doc_name | completed_at |`,
      `|---|---|---|`,
      ...suspects.map(s => `| ${s.id} | ${(s.doc_name || '').replace(/\|/g, '\\|')} | ${s.completed_at || ''} |`),
      ``,
    ];
    writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`\n📝 Lista suspecților scrisă în: ${outPath}`);
  }
}

try {
  await main();
} catch (e) {
  console.error('❌ Eroare:', e.message || e.code || String(e));
  process.exit(1);
} finally {
  await pool.end();
}
