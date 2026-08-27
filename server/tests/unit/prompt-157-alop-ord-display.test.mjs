/**
 * #157 — analiza statică pentru cele două fix-uri din alop.js:
 * (1) sub-textul etapei „Ordonanțare" consumă a.ord_aprobat (server-derived), nu doar a.ord_id
 * (2) alopDeschideORD/alopGoToORD elimină cursa de timing setTimeout(400) și
 *     reîncarcă explicit lista DF aprobate înainte de a seta #o-df-sel.value
 *
 * `alop.js` e script clasic mare, fără infrastructură de test comportamental — verificăm
 * doar cablarea statică, modelul admin-cancel-ui.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const alopJsSrc = readPublic('js/formular/alop.js');

describe('#157 — ALOP: sub-text etapă ORD + cursă timing DF pe ORD nou', () => {
  it('forma veche a sub-textului „ORD aprobat" bazată doar pe a.ord_id NU mai apare', () => {
    expect(alopJsSrc).not.toContain("sub:a.ord_id?'ORD aprobat':'Fără ORD'},");
  });

  it('forma nouă consumă a.ord_aprobat (derivat server-side)', () => {
    expect(alopJsSrc).toContain("sub:!a.ord_id?'Fără ORD':a.ord_aprobat?'ORD aprobat':'ORD în lucru'},");
  });

  it('setTimeout(400) orb pe #o-df-sel din alopDeschideORD NU mai apare', () => {
    expect(alopJsSrc).not.toContain('if(alop.df_id)setTimeout(()=>{');
  });

  it('setTimeout(400) orb pe #o-df-sel din alopGoToORD NU mai apare', () => {
    expect(alopJsSrc).not.toContain('if(dfId)setTimeout(()=>{');
  });

  it('alopGoToORD a devenit async', () => {
    expect(alopJsSrc).toContain('async function alopGoToORD(alopId,dfId){');
  });

  it('ambele funcții apelează await loadDfAprobate() înainte de a seta #o-df-sel.value', () => {
    const count = alopJsSrc.split('await loadDfAprobate();').length - 1;
    expect(count).toBe(2);
  });
});
