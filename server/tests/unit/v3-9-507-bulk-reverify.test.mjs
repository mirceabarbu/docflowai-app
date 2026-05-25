/**
 * v3.9.507 — guard pentru re-verificarea automată a items cu status='error'
 * în bulk-signer UI.
 *
 * Test string-match. Comportament dynamic testabil manual pe staging:
 * bulk sign 5+ documente → UI raportează erori false → spinner "Verifică
 * statusul real..." → items reclasificate ca signed cu badge "🔄 Verificat".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('Bulk signer UI re-verify error items (v3.9.507)', () => {
  it('comentariu v3.9.507 prezent în bulk-signer.js', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.507/);
  });

  it('_renderDoneState extras ca funcție separată (re-render după reclassify)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/function _renderDoneState\(j\)/);
  });

  it('_reverifyErrorItems declarat și apelat în showPhaseDone', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/async function _reverifyErrorItems\(j\)/);
    // În showPhaseDone trebuie apelat condiționat de existența items cu status='error'
    const m = src.match(/function showPhaseDone\(j\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'corpul showPhaseDone nu a fost găsit').toBeTruthy();
    expect(m[0]).toMatch(/_reverifyErrorItems/);
    expect(m[0]).toMatch(/status\s*===\s*['"]error['"]/);
  });

  it('criteriul de reclassify: completed === true SAU all signers signed', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    const m = src.match(/async function _reverifyErrorItems\(j\)[\s\S]*?\n\}\s*$/m);
    expect(m).toBeTruthy();
    const body = m[0];
    // Apel către endpoint-ul de flow info
    expect(body).toMatch(/\/flows\/\$\{encodeURIComponent\(item\.flowId\)\}/);
    // Verificare completed
    expect(body).toMatch(/completed\s*===\s*true/);
    // Verificare all signers signed
    expect(body).toMatch(/signers\.every\(s\s*=>\s*s\.status\s*===\s*['"]signed['"]\)/);
    // Promise.allSettled pentru paralelism + fail tolerance
    expect(body).toMatch(/Promise\.allSettled/);
  });

  it('items reclasificați primesc _verifiedAfterError flag', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/_verifiedAfterError\s*=\s*true/);
    // Badge afișat în UI pentru items verificate
    expect(src).toMatch(/Verificat ulterior/);
  });

  it('stats counts actualizate: j.signed și j.errors recalculate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    const m = src.match(/async function _reverifyErrorItems\(j\)[\s\S]*?\n\}\s*$/m);
    expect(m).toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/j\.signed\s*=\s*\(j\.signed\s*\|\|\s*0\)\s*\+\s*reclassified/);
    expect(body).toMatch(/j\.errors\s*=\s*Math\.max\(0,\s*\(j\.errors\s*\|\|\s*0\)\s*-\s*reclassified\)/);
  });
});
