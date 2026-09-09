import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../../public');

function walkJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// #188: `getCsrf()` neprefixat (nu `df.getCsrf(`, nu `DFApi.getCsrf(`, nu `.getCsrf(` in general)
// aruncă ReferenceError dacă fișierul nu-și definește propria funcție `getCsrf`.
const UNPREFIXED_CALL_RE = /(?<!\.)\bgetCsrf\s*\(/g;
const OWN_DEFINITION_RE = /function\s+getCsrf\s*\(/;

describe('#188 - getCsrf scope guard', () => {
  it('every unprefixed getCsrf() call site defines its own getCsrf', () => {
    const files = walkJsFiles(PUBLIC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders = [];
    let filesWithUnprefixedCalls = 0;

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const matches = src.match(UNPREFIXED_CALL_RE);
      if (!matches) continue;
      filesWithUnprefixedCalls++;

      if (!OWN_DEFINITION_RE.test(src)) {
        const relPath = path.relative(PUBLIC_DIR, file).replace(/\\/g, '/');
        const lineNo = src.slice(0, src.search(UNPREFIXED_CALL_RE)).split('\n').length;
        offenders.push(`${relPath}:${lineNo}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[#188] examinate ${files.length} fișiere .js din public/, ` +
      `${filesWithUnprefixedCalls} cu apeluri getCsrf() neprefixate, ${offenders.length} fără definiție proprie.`
    );

    expect(offenders, `getCsrf() neprefixat fără definiție locală în: ${offenders.join(', ')}`).toEqual([]);
  });
});
