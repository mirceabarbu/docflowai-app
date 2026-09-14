/**
 * #204 — `anExercitiuCurent()` e SURSA UNICĂ a anului de exercițiu pentru porțile de scriere.
 *
 * Patru locuri derivau anul din ceasul serverului (alop.mjs ×3 — dintre care sqlBandaRowsPlati
 * de DOUĂ ori în aceeași expresie — și computeOrdBudgetContext). Toate trec acum prin
 * `anExercitiuCurent()`; în fragmentele SQL anul se interpolează ca literal DOAR prin garda
 * `sqlAn()`, care aruncă pe orice nu e întreg.
 *
 * Testul apără: (1) echivalența cu ceasul azi; (2) garda; (3) inventarul — fișierele nu mai
 * conțin NICIO expresie de ceas, dar fallback-urile pe COLOANE (`plata_data`/`created_at`,
 * ordinea din mig. 086) SUNT încă acolo; (4) ambele apariții din bandă înlocuite; (5) numele
 * mincinos `crediteBugetareAnCurent` nu mai există (fără alias).
 */
import { vi, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// alop.mjs trage pool/logger/csrf la import — mock minimal, ca în integration/alop.test.mjs.
vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  DB_READY: true,
  requireDb: vi.fn(() => false),
  DB_LAST_ERROR: null,
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));
vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_q, _s, n) => n() }));
vi.mock('../../middleware/require-module.mjs', () => ({ requireModule: () => (_q, _s, n) => n() }));

import * as bugetAn from '../../services/buget-an.mjs';
import { sqlBandaRowsPlati } from '../../routes/alop.mjs';

const { anExercitiuCurent, sqlAn } = bugetAn;

const __dir = fileURLToPath(new URL('.', import.meta.url));
const ROOT  = join(__dir, '../../..');
const src   = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const ALOP   = 'server/routes/alop.mjs';
const SHARED = 'server/services/formular-shared.mjs';

describe('#204 — anExercitiuCurent(): sursă unică pentru anul porților de scriere', () => {
  it('1. anExercitiuCurent() === new Date().getFullYear() (zero schimbare de comportament azi)', () => {
    expect(anExercitiuCurent()).toBe(new Date().getFullYear());
    expect(Number.isInteger(anExercitiuCurent())).toBe(true);
  });

  it('2. ⭐ sqlAn aruncă pe orice nu e întreg și acceptă întregul', () => {
    for (const rau of ['2026', 2026.5, null, undefined, NaN, [2026], {}, Infinity, true]) {
      expect(() => sqlAn(rau), `sqlAn(${JSON.stringify(rau)}) trebuia să arunce`).toThrow(/an de exercițiu invalid/);
    }
    expect(sqlAn(2026)).toBe('2026');
    expect(sqlAn(anExercitiuCurent())).toBe(String(new Date().getFullYear()));
  });

  it('3. ⭐ inventar: alop.mjs și formular-shared.mjs nu mai conțin nicio expresie de ceas', () => {
    for (const rel of [ALOP, SHARED]) {
      const s = src(rel);
      expect(s, `${rel}: EXTRACT(YEAR FROM NOW()) trebuie să fi dispărut`).not.toMatch(/EXTRACT\(YEAR FROM NOW\(\)\)/);
      expect(s, `${rel}: new Date().getFullYear() trebuie să fi dispărut`).not.toMatch(/new Date\(\)\.getFullYear\(\)/);
      expect(s, `${rel}: trebuie să consume anExercitiuCurent()`).toMatch(/anExercitiuCurent\(\)/);
    }
  });

  it('3b. ⭐ fallback-urile pe COLOANE (plata_data / created_at, mig. 086) sunt NEATINSE', () => {
    // „Curățarea" ar putea trece cu fallback-urile șterse — testul cere explicit prezența lor,
    // în ordinea din mig. 086: an_exercitiu → plata_data → created_at.
    const alop = src(ALOP);
    expect(alop).toMatch(/COALESCE\(c_re\.an_exercitiu,\s*EXTRACT\(YEAR FROM c_re\.plata_data\)::int,\s*EXTRACT\(YEAR FROM c_re\.created_at\)::int\)\s*=\s*\$\{sqlAn\(an\)\}/);
    const shared = src(SHARED);
    expect(shared).toMatch(/COALESCE\(\s*c\.an_exercitiu,\s*EXTRACT\(YEAR FROM c\.plata_data\)::int,\s*EXTRACT\(YEAR FROM c\.created_at\)::int\s*\)\s*=\s*\$3/);
  });

  it('4. sqlBandaRowsPlati(df, 2026): AMBELE sloturi ale expresiei `off` poartă anul, zero NOW()', () => {
    const frag = sqlBandaRowsPlati('df', 2026);
    expect(frag).not.toMatch(/NOW\(\)/);
    // Expresia `off` = `(an - COALESCE(df.an_referinta, an))` are DOUĂ sloturi de an. E inlined
    // de 5 ori în CASE, iar banda apare de 2 ori în fragment ⇒ 10 × 2 = 20 apariții. Ce contează
    // nu e numărul absolut, ci că NICIUN slot n-a rămas pe ceas: fiecare `2026` din fragment
    // trebuie să facă parte dintr-o pereche completă. (Un slot uitat = identic azi, divergent
    // în ianuarie — exact bugul invizibil la testare.)
    const perechi = (frag.match(/\(2026 - COALESCE\(df\.an_referinta, 2026\)\)/g) || []).length;
    const total   = (frag.match(/\b2026\b/g) || []).length;
    expect(perechi).toBeGreaterThan(0);
    expect(total).toBe(perechi * 2);
    expect(frag).not.toMatch(/COALESCE\(df\.an_referinta, (?!2026\))/); // al doilea slot, explicit
    // și garda e chiar pe drum: un an invalid nu ajunge niciodată în SQL
    expect(() => sqlBandaRowsPlati('df', '2026')).toThrow(/an de exercițiu invalid/);
    expect(() => sqlBandaRowsPlati('df')).toThrow(/an de exercițiu invalid/); // fără implicit
  });

  it('4b. niciuna dintre cele patru funcții SQL nu are valoare implicită pe `an`', () => {
    const alop = src(ALOP);
    for (const fn of ['sqlBandaRowsPlati', 'sqlBugetAnExercitiu', 'sqlOrdonantatAnCurent', 'sqlRamasAnExercitiu']) {
      const m = alop.match(new RegExp(`function ${fn}\(([^)]*)\)`));
      expect(m, `${fn} trebuie definită`).toBeTruthy();
      expect(m[1], `${fn}: parametrul \`an\` NU are voie să aibă implicit`).not.toMatch(/an\s*=/);
      expect(m[1].split(',').map(s => s.trim()).at(-1)).toBe('an');
    }
    // și cele trei call-site-uri finale trimit anExercitiuCurent()
    expect((alop.match(/sqlBugetAnExercitiu\('df', anExercitiuCurent\(\)\)/g) || []).length).toBe(2);
    expect((alop.match(/sqlRamasAnExercitiu\('df','a', anExercitiuCurent\(\)\)/g) || []).length).toBe(1);
  });

  it('5. crediteBugetareAnCurent nu mai există ca export (fără alias); crediteBugetareCol10 da', () => {
    expect(bugetAn.crediteBugetareAnCurent).toBeUndefined();
    expect(typeof bugetAn.crediteBugetareCol10).toBe('function');
    expect(bugetAn.crediteBugetareCol10([{ sum_rezv_crdt_bug_act: '100' }, { sum_rezv_crdt_bug_act: '50.5' }])).toBe(150.5);
    for (const rel of [ALOP, SHARED, 'server/services/buget-an.mjs']) {
      expect(src(rel), `${rel} mai citează numele vechi`).not.toMatch(/crediteBugetareAnCurent/);
    }
  });
});
