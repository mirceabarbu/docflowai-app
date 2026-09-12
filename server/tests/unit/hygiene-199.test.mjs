// server/tests/unit/hygiene-199.test.mjs
// Igienă #199 — teste de regresie pe sursă:
//  A. migrația forțată a lui 014_alop la fiecare boot a fost o măsură de o singură dată,
//     consumată — server/db/migrate.mjs nu mai trebuie s-o re-execute.
//  B. `_uploadRateLimit` era definit identic în șase fișiere din server/routes/flows/,
//     dar montat într-unul singur (signing.mjs). Testul prinde și o a șaptea copie viitoare.
//
// ⛔ Teste de caracterizare pe sursă — legitim aici, afirmațiile SUNT despre sursă.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = join(__dir, '../../routes/flows');

describe('#199 Etapa A — migrate.mjs nu mai forțează re-rularea lui 014_alop', () => {
  const src = readFileSync(join(__dir, '../../db/migrate.mjs'), 'utf8');

  it('nu mai conține DELETE FROM schema_migrations', () => {
    expect(src).not.toContain('DELETE FROM schema_migrations');
  });
});

describe('#199 Etapa B — _uploadRateLimit definit o singură dată în server/routes/flows/', () => {
  const files = readdirSync(FLOWS_DIR).filter(f => f.endsWith('.mjs'));

  it('apare exact o dată în tot directorul, în fișierul unde e și montat (signing.mjs)', () => {
    let count = 0;
    const definedIn = [];
    for (const f of files) {
      const src = readFileSync(join(FLOWS_DIR, f), 'utf8');
      const matches = src.match(/const _uploadRateLimit\s*=/g);
      if (matches) { count += matches.length; definedIn.push(f); }
    }
    expect(definedIn).toEqual(['signing.mjs']);
    expect(count).toBe(1);
  });

  it('signing.mjs îl și montează', () => {
    const src = readFileSync(join(FLOWS_DIR, 'signing.mjs'), 'utf8');
    expect(src).toMatch(/router\.use\(['"]\/flows\/:flowId\/upload-signed-pdf['"],\s*_uploadRateLimit\)/);
  });
});
