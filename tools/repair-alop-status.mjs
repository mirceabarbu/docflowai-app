#!/usr/bin/env node
/**
 * One-shot: repair status ALOP pentru fluxuri deja semnate.
 * Rulează: node tools/repair-alop-status.mjs
 * Necesită: DATABASE_URL în .env (sau în environment)
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Încarcă .env manual (fără dependență de dotenv)
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* .env absent — se folosește environment-ul existent */ }

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ DATABASE_URL lipsă.'); process.exit(1); }

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const SQL = `
UPDATE alop_instances a
SET status = CASE
  WHEN a.ord_flow_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM flows f WHERE f.id = a.ord_flow_id AND f.status = 'completed'
  ) THEN 'plata'
  WHEN a.df_flow_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM flows f WHERE f.id = a.df_flow_id AND f.status = 'completed'
  ) THEN 'lichidare'
  ELSE a.status
END,
updated_at = NOW()
WHERE a.cancelled_at IS NULL
  AND a.status IN ('draft', 'angajare', 'ordonantare')
  AND (a.df_flow_id IS NOT NULL OR a.ord_flow_id IS NOT NULL)
RETURNING id, status;
`;

try {
  console.log('🔌 Conectare la baza de date...');
  const { rows } = await pool.query(SQL);
  if (rows.length === 0) {
    console.log('✅ Nicio instanță ALOP de reparat (toate deja corecte).');
  } else {
    console.log(`✅ Reparate ${rows.length} instanțe ALOP:\n`);
    for (const r of rows) console.log(`  • id=${r.id}  →  status=${r.status}`);
  }
} catch (e) {
  console.error('❌ Eroare:', e.message || e.code || String(e));
  process.exit(1);
} finally {
  await pool.end();
}
