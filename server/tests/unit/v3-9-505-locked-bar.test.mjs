/**
 * v3.9.505 — guard că:
 * - locked-bar.ok CSS rule e prezent
 * - setLockedBar pentru status aprobat folosește tip 'ok' (nu 'info')
 * - setS('Document aprobat','ok') a fost eliminat (redundanță cu locked-bar)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('Document aprobat — consolidare pe un singur rând (v3.9.505)', () => {
  it('CSS: .locked-bar.ok rule e prezent cu culoarea teal/verde', () => {
    const css = readFileSync(path.join(REPO, 'public/css/formular/formular.css'), 'utf8');
    expect(css).toMatch(/\.locked-bar\.ok\s*\{[^}]*background:\s*rgba\(29,200,174/);
    expect(css).toMatch(/\.locked-bar\.ok\s*\{[^}]*color:\s*#5dcaa5/);
  });

  it('doc.js: setLockedBar pentru aprobat folosește tip "ok"', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.505/);
    expect(src).toMatch(/setLockedBar\(ft,\s*'✔ Document aprobat[^']*','ok'\)/);
  });

  it('doc.js: setS("Document aprobat","ok") a fost eliminat (redundanță)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).not.toMatch(/setS\(['"]Document aprobat['"],['"]ok['"]\)/);
  });

  it('doc.js: alte folosiri ale setS rămân intacte (regression check)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/setS\('Document aprobat — nu poate fi modificat\./);
  });
});
