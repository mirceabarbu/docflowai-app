/**
 * #154 — analiza statică pentru avertizarea „cont NU e de trezorerie" pe ORD, la
 * deschiderea documentului de către Responsabilul CAB.
 *
 * `list.js`/`doc.js` sunt scripturi clasice mari, fără infrastructură de test
 * comportamental azi (același motiv ca la #113b: flag-ul `isTreasury` e deja acoperit
 * de server/services/verify/__tests__/ibanValidator.test.mjs +
 * server/tests/unit/iban-validator.test.mjs). Ce se adaugă azi e strict orchestrare DOM,
 * verificată static, ca în admin-cancel-ui.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const listJsSrc = readPublic('js/formular/list.js');
const docJsSrc = readPublic('js/formular/doc.js');

describe('#154 — ORD trezorerie CAB UI wiring', () => {
  it('list.js conține avertizarea "Cont NU este de trezorerie"', () => {
    expect(listJsSrc).toContain('Cont NU este de trezorerie');
  });

  it('list.js conține funcția _recheckAllOrdIbanuri', () => {
    expect(listJsSrc).toMatch(/function _recheckAllOrdIbanuri/);
  });

  it('doc.js apelează _recheckAllOrdIbanuri()', () => {
    expect(docJsSrc).toContain('_recheckAllOrdIbanuri()');
  });

  it('apelul _recheckAllOrdIbanuri() e în vecinătatea imediată a ramurii pending_p2/p2', () => {
    const idxCall = docJsSrc.indexOf('_recheckAllOrdIbanuri()');
    expect(idxCall).toBeGreaterThan(-1);
    // "status==='pending_p2'&&role==='p2'" apare de două ori în fișier (doc.js) —
    // găsim ocurența cea mai apropiată de call-site (trebuie să fie ÎNAINTE de el).
    const needle = "status==='pending_p2'&&role==='p2'";
    let nearestIdx = -1;
    let searchFrom = 0;
    while (true) {
      const found = docJsSrc.indexOf(needle, searchFrom);
      if (found === -1) break;
      if (found < idxCall) nearestIdx = found;
      searchFrom = found + 1;
    }
    expect(nearestIdx).toBeGreaterThan(-1);
    expect(idxCall - nearestIdx).toBeLessThan(400);
  });
});
