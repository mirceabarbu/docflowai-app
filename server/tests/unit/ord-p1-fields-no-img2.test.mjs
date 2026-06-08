/**
 * v3.9.499 — guard: img2 nu mai e în ORD_P1_FIELDS.
 * Captura 2 se persistă via /api/formulare-capturi?slot=2, nu prin doc body.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

// Refactor Etapa 1 (v3.9.544): ORD_P1_FIELDS + comentariul de deprecare s-au mutat
// din server/routes/formulare-db.mjs în server/services/formular-shared.mjs.
const FIELDS_SRC = 'server/services/formular-shared.mjs';

describe('ORD_P1_FIELDS: img2 eliminat (v3.9.499)', () => {
  it('definiția ORD_P1_FIELDS nu conține literalul "img2"', () => {
    const src = readFileSync(path.join(REPO, FIELDS_SRC), 'utf8');
    const m = src.match(/const ORD_P1_FIELDS\s*=\s*\[([\s\S]*?)\];/);
    expect(m, 'ORD_P1_FIELDS nu e găsit').toBeTruthy();
    const arrayBody = m[1];
    expect(arrayBody, "ORD_P1_FIELDS încă conține 'img2' — trebuia eliminat în v3.9.499")
      .not.toMatch(/'img2'/);
  });

  it('comentariul de deprecare e prezent', () => {
    const src = readFileSync(path.join(REPO, FIELDS_SRC), 'utf8');
    expect(src).toMatch(/v3\.9\.499.*img2 ELIMINAT/);
  });

  it('collectOrdDb în doc.js nu mai trimite img2', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const m = src.match(/function collectOrdDb\(\)\s*\{return\s*\{([\s\S]*?)\};\}/);
    expect(m, 'collectOrdDb nu e găsit').toBeTruthy();
    expect(m[1]).not.toMatch(/img2\s*:\s*imgs\['o-cimg2'\]/);
  });
});
