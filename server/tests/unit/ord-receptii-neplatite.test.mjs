/**
 * v3.9.516 — Validare col. 5 (Recepții neplătite) ≥ 0 în ORD
 *
 * Verifică prezența logicii în doc.js + că endpoint-ul returnează 422
 * pentru rânduri cu c5 < 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ORD col.5 (Recepții neplătite) ≥ 0 — v3.9.516', () => {
  it('doc.js: validateSecB are ramură pentru ordnt cu verificare c2-c3-c4', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // Verifică ramura ordnt în validateSecB
    expect(src).toMatch(/validateSecB[\s\S]*?ft==='ordnt'[\s\S]*?receptii_neplatite/);
    expect(src).toMatch(/c5\s*=\s*c2\s*-\s*c3\s*-\s*c4/);
    // Toleranță floating point
    expect(src).toMatch(/c5\s*<\s*-?\s*0\.001/);
  });

  it('formulare-db.mjs: complete ORD respinge rânduri cu c5 < 0', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/formulare-db.mjs'), 'utf8');
    expect(src).toMatch(/receptii_neplatite_negative/);
    expect(src).toMatch(/Coloana 5 .*Recepții neplătite/);
    // Status 422 pentru validare semantică
    expect(src).toMatch(/status\(422\)[\s\S]{0,200}receptii_neplatite_negative/);
  });
});
