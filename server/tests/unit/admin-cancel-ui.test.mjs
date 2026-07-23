/**
 * #113b — analiza statică pentru butonul „Anulare administrativă" pe pagina fluxului.
 *
 * `flow.js` e un script clasic mare, cu multe dependențe de DOM și de starea paginii;
 * încărcarea lui în happy-dom ar cere un schelet artificial care ar testa schelet, nu
 * comportament. Comportamentul real (gărzile server-side) e acoperit de cele 9 cazuri
 * DB din #113a. Aici verificăm doar cablarea UI — tiparul din pagin-wiring.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const flowHtmlSrc = readPublic('flow.html');
const flowJsSrc = readPublic('js/flow/flow.js');

const countOccurrences = (src, needle) => src.split(needle).length - 1;

describe('#113b — admin-cancel UI wiring', () => {
  it('flow.html conține butonul btnAdminCancelFlow exact o dată, cu clasa danger', () => {
    expect(countOccurrences(flowHtmlSrc, 'id="btnAdminCancelFlow"')).toBe(1);
    expect(flowHtmlSrc).toMatch(/class="df-action-btn danger" id="btnAdminCancelFlow"/);
  });

  it('flow.js conține canAdminCancel și include data.completed în condiția de vizibilitate', () => {
    const m = flowJsSrc.match(/const canAdminCancel = ([^;]+);/);
    expect(m).toBeTruthy();
    expect(m[1]).toContain('data.completed');
  });

  it('poarta canAdminCancel NU include isInitiator (operație administrativă, nu a inițiatorului)', () => {
    const m = flowJsSrc.match(/const canAdminCancel = ([^;]+);/);
    expect(m).toBeTruthy();
    expect(m[1]).not.toContain('isInitiator');
  });

  it('endpoint-ul /admin-cancel apare exact o dată în flow.js', () => {
    expect(countOccurrences(flowJsSrc, '/admin-cancel')).toBe(1);
  });

  it('toate cele 6 coduri de eroare din contractul rutei sunt mapate la mesaje umane', () => {
    const codes = [
      'payment_confirmed',
      'has_archived_cycles',
      'not_completed',
      'already_cancelled',
      'reason_required',
      'forbidden',
    ];
    for (const code of codes) {
      expect(flowJsSrc).toContain(`${code}:`);
    }
  });

  it('motivul este validat client-side la minim 10 caractere înainte de request', () => {
    expect(flowJsSrc).toMatch(/reason\.length < 10/);
  });

  it('#btnCancelFlow și canCancel rămân neschimbate', () => {
    expect(countOccurrences(flowHtmlSrc, 'id="btnCancelFlow"')).toBe(1);
    expect(flowJsSrc).toContain("const canCancel = !data.completed && computedStatus !== 'cancelled' && computedStatus !== 'refused' && (isInitiator || isAdmin);");
  });
});
