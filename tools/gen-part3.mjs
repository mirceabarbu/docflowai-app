import { readFileSync, writeFileSync } from 'fs';

const schemaFile = process.argv[2];
const schema = readFileSync(schemaFile, 'utf8');
const tables = readFileSync('tools/tables-missing.txt', 'utf8').trim().split(/\r?\n/).filter(Boolean);
const lines = schema.split(/\r?\n/);
let out = [];

out.push('-- === PARTEA 3: Indici + constraints pentru tabele noi ===');
out.push('-- Generat: ' + new Date().toISOString());
out.push('');

// CREATE INDEX IF NOT EXISTS — match by string contains (avoid regex escape issues)
for (const table of tables) {
  out.push('-- Indexes for: ' + table);
  lines
    .filter(l => /^CREATE (UNIQUE )?INDEX /.test(l) && l.includes(' ON ') && l.includes(table))
    .forEach(l => {
      out.push(
        l.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')
         .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
      );
    });
  out.push('');
}

// Join multi-line ALTER TABLE ... ADD CONSTRAINT statements
out.push('-- FK + UNIQUE constraints (each in own DO block)');
out.push('');

const joined = [];
for (let i = 0; i < lines.length; i++) {
  if (/^ALTER TABLE ONLY /.test(lines[i])) {
    let stmt = lines[i];
    while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
      i++;
      stmt += '\n' + lines[i];
      if (lines[i].trim().endsWith(';')) break;
    }
    joined.push(stmt);
  }
}

const EXC = 'EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;';
function emitDo(stmt) {
  out.push('DO $d$ BEGIN');
  stmt.split('\n').forEach(l => out.push('  ' + l));
  out.push(EXC);
  out.push('END $d$;');
  out.push('');
}

function matchesTable(stmt, table) {
  const first = stmt.split('\n')[0];
  return (first === 'ALTER TABLE ONLY public.' + table || first === 'ALTER TABLE ONLY ' + table)
    && stmt.includes('ADD CONSTRAINT') && !stmt.includes('SET DEFAULT');
}

// Phase A: PRIMARY KEY first (all new tables) — required before any FK references them
out.push('-- Phase A: PRIMARY KEY constraints');
out.push('');
for (const table of tables)
  for (const stmt of joined)
    if (matchesTable(stmt, table) && stmt.includes('PRIMARY KEY')) emitDo(stmt);

// Phase B: UNIQUE constraints
out.push('-- Phase B: UNIQUE constraints');
out.push('');
for (const table of tables)
  for (const stmt of joined)
    if (matchesTable(stmt, table) && stmt.includes('UNIQUE') && !stmt.includes('PRIMARY KEY')) emitDo(stmt);

// Phase C: FOREIGN KEY constraints (all PKs guaranteed present)
out.push('-- Phase C: FOREIGN KEY constraints');
out.push('');
for (const table of tables)
  for (const stmt of joined)
    if (matchesTable(stmt, table) && stmt.includes('FOREIGN KEY')) emitDo(stmt);

writeFileSync('tools/part3.sql', out.join('\n'));
const doCount = out.filter(l => l === 'DO $d$ BEGIN').length;
const idxCount = out.filter(l => /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(l)).length;
console.log('Lines:', out.length, '| DO blocks:', doCount, '| Indexes:', idxCount, '| PK:', out.filter(l => l.includes('PRIMARY KEY')).length);
