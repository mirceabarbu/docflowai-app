/**
 * Regresie: openDoc trebuie să reseteze slotul PRINCIPAL de captură ÎNAINTE de a
 * încărca documentul, altfel captura documentului anterior se scurge în cel nou
 * (bug raportat CAB, v3.9.725). Invariantă structurală ⇒ analiză pe sursă.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const docJs = readFileSync(join(__dir, '../../../public/js/formular/doc.js'), 'utf8');

describe('openDoc — reset captură principală (anti-leak între documente)', () => {
  it('clrImg pe slotul principal apare chiar înaintea fetch-ului de captură din openDoc', () => {
    // Marker unic pentru fetch-ul din openDoc (slotul 2 folosește un URL diferit, cu ?slot=2)
    const marker = 'formulare-capturi/${ftType(ft)}';
    const idx = docJs.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    // În fereastra imediat dinaintea fetch-ului trebuie să existe resetul slotului principal.
    const before = docJs.slice(Math.max(0, idx - 300), idx);
    expect(before).toMatch(/clrImg\(_capIid\s*,\s*_capPh\)/);
  });

  it('slotul 2 ORD (o-cimg2) rămâne resetat separat (neatins)', () => {
    expect(docJs).toContain("clrImg('o-cimg2','o-cph2')");
  });
});
