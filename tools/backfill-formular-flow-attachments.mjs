#!/usr/bin/env node
/**
 * Backfill ADD-ONLY (fix 7) — copiază retroactiv atașamentele formular→flux pentru fluxurile
 * deja legate înainte ca declanșarea să fie mutată în linkFlowFormular.
 *
 * Repară istoricul: pentru fiecare legătură DURABILĂ flux↔formular (DF/ORD), dacă fluxul nu are
 * încă atașamentele copiate, le copiază via helper-ul canonic `copyFormularAttachmentsToFlow`.
 *
 * NU e o migrare de schemă — rulează ca task de maintenance separat, idempotent, re-rulabil.
 * Guard-ul `NOT EXISTS (flow_id, filename)` din helper sare fluxurile deja populate → ZERO
 * duplicate la re-rulare. Non-distructiv (doar INSERT condiționat).
 *
 * Rulează: node tools/backfill-formular-flow-attachments.mjs
 * Necesită: DATABASE_URL în .env (sau în environment).
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFormularAttachmentsToFlow } from '../server/services/formular-flow-attachments.mjs';

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

// Toate sursele de legături DURABILE flux↔formular (DF/ORD). DISTINCT ca să nu prelucrăm
// aceeași pereche de două ori (ex. un flux prezent și pe alop_instances și pe formulare_X).
const SQL_LINKS = `
  SELECT DISTINCT flow_id, ft, form_id::text AS form_id FROM (
    -- cicluri ORD arhivate
    SELECT ord_flow_id AS flow_id, 'ord' AS ft, ord_id AS form_id
      FROM alop_ord_cicluri WHERE ord_flow_id IS NOT NULL AND ord_id IS NOT NULL
    UNION ALL
    -- ciclul curent (alop_instances) ORD + DF
    SELECT ord_flow_id, 'ord', ord_id FROM alop_instances WHERE ord_flow_id IS NOT NULL AND ord_id IS NOT NULL
    UNION ALL
    SELECT df_flow_id, 'df', df_id   FROM alop_instances WHERE df_flow_id IS NOT NULL AND df_id IS NOT NULL
    UNION ALL
    -- non-ALOP: formulare_{df,ord}.flow_id direct
    SELECT flow_id, 'df', id FROM formulare_df  WHERE flow_id IS NOT NULL
    UNION ALL
    SELECT flow_id, 'ord', id FROM formulare_ord WHERE flow_id IS NOT NULL
  ) s
  WHERE flow_id IS NOT NULL AND form_id IS NOT NULL;
`;

try {
  console.log('🔌 Conectare la baza de date...');
  const { rows } = await pool.query(SQL_LINKS);
  console.log(`🔎 ${rows.length} legături durabile flux↔formular de verificat.\n`);

  let totalCopied = 0;
  let touchedFlows = 0;
  for (const { flow_id, ft, form_id } of rows) {
    try {
      const copied = await copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: ft, formId: form_id });
      if (copied > 0) {
        touchedFlows++;
        totalCopied += copied;
        console.log(`  • ${ft} ${form_id} → flux ${flow_id}: ${copied} atașament(e) copiate`);
      }
    } catch (e) {
      console.error(`  ✗ ${ft} ${form_id} → flux ${flow_id}: ${e.message || e.code || String(e)}`);
    }
  }

  if (totalCopied === 0) {
    console.log('✅ Nimic de copiat — toate fluxurile legate au deja atașamentele (idempotent).');
  } else {
    console.log(`\n✅ Backfill complet: ${totalCopied} atașament(e) copiate pe ${touchedFlows} flux(uri).`);
  }
} catch (e) {
  console.error('❌ Eroare:', e.message || e.code || String(e));
  process.exit(1);
} finally {
  await pool.end();
}
