/**
 * #143b — D1/D2: `narrowCanDeleteRows` (pur, fără DB) + gardă structurală pentru
 * `canDestroyOnly` (devenit async la #143 — un apel neawait-uit ar închide tăcut
 * ștergerea pentru TOATĂ lumea, inclusiv creator și admin).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { narrowCanDeleteRows } from '../../services/formular-capabilities.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');

describe('#143b — narrowCanDeleteRows', () => {
  it('1. colegul de compartiment primește dreptul', () => {
    const rows = [{ can_delete: true, isP1: false, initiator_comp: 'Serviciul Buget' }];
    narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: 'Serviciul Buget' });
    expect(rows[0].can_delete).toBe(true);
  });

  it('2. ⭐⭐ străinul de compartiment NU primește dreptul (granița)', () => {
    const rows = [{ can_delete: true, isP1: false, initiator_comp: 'Serviciul Buget' }];
    narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: 'Serviciul Tehnic' });
    expect(rows[0].can_delete).toBe(false);
  });

  it('3. starea are prioritate — can_delete:false rămâne false chiar pentru coleg', () => {
    const rows = [{ can_delete: false, isP1: false, initiator_comp: 'Serviciul Buget' }];
    narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: 'Serviciul Buget' });
    expect(rows[0].can_delete).toBe(false);
  });

  it('4. creatorul (isP1) primește dreptul indiferent de compartiment', () => {
    const rows = [{ can_delete: true, isP1: true, initiator_comp: 'Serviciul Buget' }];
    narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: '' });
    expect(rows[0].can_delete).toBe(true);
  });

  it('5. isOrgManager: true primește dreptul chiar cu compartiment diferit', () => {
    const rows = [{ can_delete: true, isP1: false, initiator_comp: 'Serviciul Buget' }];
    narrowCanDeleteRows(rows, { isOrgManager: true, actorComp: 'Serviciul Tehnic' });
    expect(rows[0].can_delete).toBe(true);
  });

  it('6. fail-safe: actorComp gol NU moștenește nimic', () => {
    const rows = [{ can_delete: true, isP1: false, initiator_comp: 'Serviciul Buget' }];
    narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: '' });
    expect(rows[0].can_delete).toBe(false);
  });

  it('7. initiator_comp null/undefined nu aruncă excepție', () => {
    const rows = [
      { can_delete: true, isP1: false, initiator_comp: null },
      { can_delete: true, isP1: false, initiator_comp: undefined },
    ];
    expect(() => narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: 'Serviciul Buget' })).not.toThrow();
    expect(rows[0].can_delete).toBe(false);
    expect(rows[1].can_delete).toBe(false);
  });

  it('8. TRIM pe ambele părți', () => {
    const rows = [{ can_delete: true, isP1: false, initiator_comp: '  Serviciul Buget  ' }];
    narrowCanDeleteRows(rows, { isOrgManager: false, actorComp: 'Serviciul Buget' });
    expect(rows[0].can_delete).toBe(true);
  });
});

describe('#143b — D2: canDestroyOnly e await-uit peste tot', () => {
  it('9. ⭐ fiecare apel din codul de producție e precedat de `await` (min. 4 call-site-uri)', () => {
    const files = [
      'server/routes/alop.mjs',
      'server/routes/formulare/df.mjs',
      'server/routes/formulare/ord.mjs',
      'server/services/formular-shared.mjs',
    ];
    // canDestroyOnly a devenit `async` la #143: un apel neawait-uit întoarce o promisiune,
    // `.allowed` iese `undefined`, iar ștergerea se închide tăcut PENTRU TOATĂ LUMEA,
    // inclusiv creator și admin. `authz-formular.mjs` (definiția) e exclusă din scanare.
    let totalCalls = 0;
    for (const rel of files) {
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      const re = /canDestroyOnly\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        totalCalls++;
        const before = src.slice(0, m.index);
        const lastLine = before.slice(before.lastIndexOf('\n') + 1);
        expect(/\bawait\s*$/.test(lastLine)).toBe(true);
      }
    }
    expect(totalCalls).toBeGreaterThanOrEqual(4);
  });
});
