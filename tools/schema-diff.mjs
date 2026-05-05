/**
 * Schema diff: staging vs production
 * READ-ONLY — only SELECT queries against information_schema and pg_catalog
 * Usage: node tools/schema-diff.mjs
 */
import pg from 'pg';
const { Client } = pg;

const STAGING_URL = process.env.STAGING_DB;
const PROD_URL = process.env.PROD_DB;

if (!STAGING_URL || !PROD_URL) {
  console.error('Missing STAGING_DB or PROD_DB env vars');
  process.exit(1);
}

async function getSchema(connectionString, label) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
  await client.connect();
  console.error(`Connected to ${label}`);

  // Tables + columns
  const tablesRes = await client.query(`
    SELECT
      t.table_name,
      c.column_name,
      c.ordinal_position,
      c.column_default,
      c.is_nullable,
      c.data_type,
      c.character_maximum_length,
      c.numeric_precision,
      c.numeric_scale,
      c.udt_name
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema = t.table_schema AND c.table_name = t.table_name
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name, c.ordinal_position
  `);

  // Indexes
  const indexRes = await client.query(`
    SELECT
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);

  // Primary keys + unique constraints
  const constraintRes = await client.query(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    GROUP BY tc.table_name, tc.constraint_name, tc.constraint_type
    ORDER BY tc.table_name, tc.constraint_name
  `);

  // Foreign keys
  const fkRes = await client.query(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      kcu.column_name,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name, tc.constraint_name
  `);

  await client.end();

  // Build structured representation
  const tables = {};
  for (const row of tablesRes.rows) {
    if (!tables[row.table_name]) tables[row.table_name] = { columns: [], indexes: [], constraints: [], fks: [] };
    tables[row.table_name].columns.push(row);
  }
  for (const row of indexRes.rows) {
    if (tables[row.tablename]) tables[row.tablename].indexes.push(row);
  }
  for (const row of constraintRes.rows) {
    if (tables[row.table_name]) tables[row.table_name].constraints.push(row);
  }
  for (const row of fkRes.rows) {
    if (tables[row.table_name]) tables[row.table_name].fks.push(row);
  }

  return tables;
}

function formatTable(name, info) {
  const lines = [`CREATE TABLE ${name} (`];
  for (const col of info.columns) {
    const nullable = col.is_nullable === 'YES' ? '' : ' NOT NULL';
    const def = col.column_default ? ` DEFAULT ${col.column_default}` : '';
    const type = col.udt_name.startsWith('_') ? `${col.udt_name.slice(1)}[]` : col.data_type;
    lines.push(`  ${col.column_name} ${type}${nullable}${def}`);
  }
  lines.push(');');
  for (const idx of info.indexes) lines.push(idx.indexdef + ';');
  for (const con of info.constraints) lines.push(`-- CONSTRAINT ${con.constraint_name} ${con.constraint_type} (${con.columns})`);
  for (const fk of info.fks) lines.push(`-- FK ${fk.constraint_name}: ${fk.column_name} -> ${fk.foreign_table}(${fk.foreign_column})`);
  return lines;
}

async function main() {
  const [staging, prod] = await Promise.all([
    getSchema(STAGING_URL, 'STAGING'),
    getSchema(PROD_URL, 'PRODUCTION'),
  ]);

  const stagingTables = new Set(Object.keys(staging));
  const prodTables = new Set(Object.keys(prod));

  const allTables = [...new Set([...stagingTables, ...prodTables])].sort();

  const diffLines = [];
  let missingOnProd = [];
  let missingOnStaging = [];
  let tablesWithDrift = [];

  for (const table of allTables) {
    const inStaging = stagingTables.has(table);
    const inProd = prodTables.has(table);

    if (inStaging && !inProd) {
      missingOnProd.push(table);
      diffLines.push(`+++ TABLE MISSING ON PRODUCTION: ${table}`);
      for (const line of formatTable(table, staging[table])) {
        diffLines.push(`+${line}`);
      }
      diffLines.push('');
    } else if (!inStaging && inProd) {
      missingOnStaging.push(table);
      diffLines.push(`--- TABLE MISSING ON STAGING: ${table}`);
      for (const line of formatTable(table, prod[table])) {
        diffLines.push(`-${line}`);
      }
      diffLines.push('');
    } else {
      // Both exist — diff columns
      const sColMap = Object.fromEntries(staging[table].columns.map(c => [c.column_name, c]));
      const pColMap = Object.fromEntries(prod[table].columns.map(c => [c.column_name, c]));
      const allCols = [...new Set([...Object.keys(sColMap), ...Object.keys(pColMap)])].sort();
      const tableDiff = [];

      for (const col of allCols) {
        if (sColMap[col] && !pColMap[col]) {
          tableDiff.push(`+  COLUMN MISSING ON PROD: ${col} (${sColMap[col].data_type})`);
        } else if (!sColMap[col] && pColMap[col]) {
          tableDiff.push(`-  COLUMN MISSING ON STAGING: ${col} (${pColMap[col].data_type})`);
        } else {
          // Check type drift
          const s = sColMap[col], p = pColMap[col];
          if (s.data_type !== p.data_type || s.is_nullable !== p.is_nullable) {
            tableDiff.push(`~  COLUMN DRIFT: ${col} | staging: ${s.data_type} nullable=${s.is_nullable} | prod: ${p.data_type} nullable=${p.is_nullable}`);
          }
        }
      }

      // Diff indexes
      const sIdxMap = Object.fromEntries(staging[table].indexes.map(i => [i.indexname, i.indexdef]));
      const pIdxMap = Object.fromEntries(prod[table].indexes.map(i => [i.indexname, i.indexdef]));
      for (const idx of Object.keys(sIdxMap)) {
        if (!pIdxMap[idx]) tableDiff.push(`+  INDEX MISSING ON PROD: ${idx}`);
      }
      for (const idx of Object.keys(pIdxMap)) {
        if (!sIdxMap[idx]) tableDiff.push(`-  INDEX MISSING ON STAGING: ${idx}`);
      }

      if (tableDiff.length > 0) {
        tablesWithDrift.push(table);
        diffLines.push(`~~~ TABLE DRIFT: ${table}`);
        for (const l of tableDiff) diffLines.push(l);
        diffLines.push('');
      }
    }
  }

  // Summary
  console.log('='.repeat(70));
  console.log('SCHEMA DIFF SUMMARY: STAGING vs PRODUCTION');
  console.log('='.repeat(70));
  console.log(`Total tables staging:    ${stagingTables.size}`);
  console.log(`Total tables production: ${prodTables.size}`);
  console.log(`Tables MISSING on PROD:  ${missingOnProd.length}`);
  console.log(`Tables MISSING on STAGING: ${missingOnStaging.length}`);
  console.log(`Tables with column/index drift: ${tablesWithDrift.length}`);
  console.log(`Total diff lines: ${diffLines.length}`);
  console.log('');

  if (missingOnProd.length > 0) {
    console.log('TABELE LIPSĂ PE PRODUCTION (există pe staging):');
    for (const t of missingOnProd) console.log(`  + ${t}`);
    console.log('');
  }

  if (missingOnStaging.length > 0) {
    console.log('TABELE LIPSĂ PE STAGING (există pe production):');
    for (const t of missingOnStaging) console.log(`  - ${t}`);
    console.log('');
  }

  if (tablesWithDrift.length > 0) {
    console.log('TABELE CU DRIFT (coloane/indexuri diferite):');
    for (const t of tablesWithDrift) console.log(`  ~ ${t}`);
    console.log('');
  }

  console.log('='.repeat(70));
  console.log('DIFF COMPLET:');
  console.log('='.repeat(70));
  for (const line of diffLines) console.log(line);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
