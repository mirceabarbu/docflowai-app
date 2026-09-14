/**
 * #203 (E.2) — poarta pentru #204: anul de exercițiu al PORȚILOR DE SCRIERE nu vine din cerere.
 *
 * #203 a parametrizat `?an=` DOAR pe rutele de raport read-only (`/api/clasa8`,
 * `/buget/disponibil`, `/admin/alop/stats`). Rămân, deliberat, patru expresii care derivă anul
 * din ceasul serverului și alimentează plafonul de ordonanțare/plată:
 *   - routes/alop.mjs         ~126  sqlBandaRowsPlati (banda de afișare)
 *   - routes/alop.mjs         ~175  sumă ordonanțată pe an (intră în plafon)
 *   - routes/alop.mjs        ~1988  plafon ordonanțare/plată (noua-lichidare)
 *   - services/formular-shared.mjs ~344  computeOrdBudgetContext (plafon ORD)
 *
 * Dacă un lot viitor „completează" parametrizarea și citește anul din `req.query`/`req.body`/
 * `req.params` în aceste fișiere, un client care trimite `an=2025` primește plafonul pe 2025
 * calculat peste documente din 2026 — plafonul bugetar devine negociabil din browser, fără
 * eroare, fără log. Testul ăsta pică ÎNAINTE ca asta să ajungă în producție.
 *
 * Verificare prin citirea sursei (regex), nu prin comportament: gaura nu produce niciun rezultat
 * observabil într-un test funcțional — dă doar cifre greșite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const ROOT  = join(__dir, '../../..');

const FISIERE_PORTI_DE_SCRIERE = [
  'server/routes/alop.mjs',
  'server/services/formular-shared.mjs',
];

const MOTIV =
  'Anul de exercițiu al porților de scriere (plafon ordonanțare/plată) nu are voie să vină din ' +
  'cerere — un client ar putea trimite an=2025 și ar primi alt plafon. Vezi #203 Etapa 0 și #204.';

// Forme prin care un an ar putea intra din cerere. Acoperă:
//   req.query.an / req.query?.an / req.body.an / req.params.an (+ an_exercitiu, anExercitiu, year)
//   const { an } = req.query|body|params   (destructurare, cu sau fără alte chei)
//   query.an / body.an / params.an           (după `const { query, body } = req`)
const CHEI_AN = '(?:an|an_exercitiu|anExercitiu|an_curent|anCurent|year|anul)';
const SURSE   = '(?:query|body|params)';
const PATTERNS = [
  new RegExp(`req\\??\\.${SURSE}\\??\\.${CHEI_AN}\\b`),
  new RegExp(`req\\??\\.${SURSE}\\??\\[\\s*['"]${CHEI_AN}['"]\\s*\\]`),
  new RegExp(`\\{[^}]*\\b${CHEI_AN}\\b[^}]*\\}\\s*=\\s*req\\??\\.${SURSE}\\b`),
  new RegExp(`\\b${SURSE}\\??\\.${CHEI_AN}\\b`),
  new RegExp(`_parseAn\\s*\\(`), // helperul de validare al rutelor de raport n-are ce căuta aici
];

describe('#203/E.2 — anul porților de scriere NU vine din cerere (poarta pentru #204)', () => {
  it.each(FISIERE_PORTI_DE_SCRIERE)('%s nu citește un an din req.query / req.body / req.params', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const linii = src.split('\n');
    const gasite = [];
    linii.forEach((linie, i) => {
      const cod = linie.replace(/\/\/.*$/, ''); // ignoră comentariile de linie
      for (const p of PATTERNS) {
        if (p.test(cod)) { gasite.push(`${rel}:${i + 1}: ${linie.trim()}`); break; }
      }
    });
    expect(gasite, `${MOTIV}\n\nCitiri găsite:\n${gasite.join('\n')}`).toEqual([]);
  });

  it('cele patru expresii de ceas rămân pe server (sanity: fișierele încă derivă anul din NOW()/getFullYear)', () => {
    // Nu fixăm numărul lor (#204 le consolidează în anExercitiuCurent()), doar că sursa e ceasul
    // serverului, nu cererea. Dacă dispar complet, cineva a schimbat modelul — de reevaluat explicit.
    const alop   = readFileSync(join(ROOT, 'server/routes/alop.mjs'), 'utf8');
    const shared = readFileSync(join(ROOT, 'server/services/formular-shared.mjs'), 'utf8');
    const CEAS = /new Date\(\)\.getFullYear\(\)|EXTRACT\(YEAR FROM NOW\(\)\)|anExercitiuCurent\(\)/;
    expect(alop,   MOTIV).toMatch(CEAS);
    expect(shared, MOTIV).toMatch(CEAS);
  });

  it('pattern-urile prind formele cunoscute (auto-test al gardei — ca să nu fie o gardă goală)', () => {
    const POZITIVE = [
      'const an = req.query.an;',
      'const an = req.query?.an;',
      "const an = req.body['an'];",
      'const { an } = req.body;',
      'const { foo, an, bar } = req.params;',
      'const anEx = Number(query.an);',
      'const y = req.body.an_exercitiu;',
      'const an = _parseAn(req.query?.an);',
    ];
    for (const s of POZITIVE) {
      expect(PATTERNS.some(p => p.test(s)), s).toBe(true);
    }
    const NEGATIVE = [
      'const anExercitiu = new Date().getFullYear();',
      "const off = `(EXTRACT(YEAR FROM NOW())::int - COALESCE(df.an_referinta, 1))`;",
      'const { alopId } = req.params;',
      'const body = req.body || {};',
      'const an = alop.an_exercitiu;',
    ];
    for (const s of NEGATIVE) {
      expect(PATTERNS.some(p => p.test(s)), s).toBe(false);
    }
  });
});
