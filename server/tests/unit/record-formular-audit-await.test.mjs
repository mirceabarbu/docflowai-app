// #194 — recordFormularAudit are FK-uri spre organizations și users (formulare_audit).
// Un apel lansat FĂRĂ `await` poate scrie DUPĂ ce răspunsul HTTP a plecat, ceea ce
// se ciocnește de TRUNCATE-ul dintre testele DB (RECON #193, deadlock 40P01 real).
// Această gardă citește sursele și eșuează dacă apare un apel detașat nou.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dir, '../..');

function listMjsFiles(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'tests') continue; // testele nu produc apeluri reale
      out = out.concat(listMjsFiles(p));
    } else if (name.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

// Toate apelurile `recordFormularAudit(` din server/, EXCLUZÂND definiția funcției
// (server/db/queries/formulare-audit.mjs) și liniile de `import`.
function findCalls() {
  const files = listMjsFiles(SERVER_ROOT);
  const calls = [];
  for (const file of files) {
    if (file.replace(/\\/g, '/').endsWith('server/db/queries/formulare-audit.mjs')) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      if (!/recordFormularAudit\s*\(/.test(line)) return;
      if (/^\s*import\b/.test(line)) return; // `import { recordFormularAudit } from ...`
      if (/function\s+recordFormularAudit\s*\(/.test(line)) return;
      calls.push({ file, lineNo: idx + 1, line: line.trim() });
    });
  }
  return calls;
}

describe('#194 — recordFormularAudit e mereu await-uit', () => {
  it('niciun apel recordFormularAudit( nu e lansat fără await', () => {
    const calls = findCalls();
    expect(calls.length).toBeGreaterThan(0); // sanity: gardul chiar găsește apeluri reale

    const unawaited = calls.filter(c => !/\bawait\s+recordFormularAudit\s*\(/.test(c.line));

    if (unawaited.length > 0) {
      const details = unawaited.map(c => `${c.file}:${c.lineNo} → ${c.line}`).join('\n');
      throw new Error(`recordFormularAudit lansat FĂRĂ await (FK spre organizations/users — vezi #194):\n${details}`);
    }

    expect(unawaited.length).toBe(0);
  });

  it('raportează numărul de apeluri găsite (informativ)', () => {
    const calls = findCalls();
    // eslint-disable-next-line no-console
    console.log(`recordFormularAudit: ${calls.length} apeluri găsite`);
    expect(calls.length).toBeGreaterThan(0);
  });
});
