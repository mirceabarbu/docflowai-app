/**
 * server/tests/unit/baza-legala.test.mjs
 *
 * Test STRUCTURAL (citește sursele cu readFileSync, nu execută rutele).
 *
 * Context: trei acte normative citate de platformă în documente livrate terților
 * au fost scoase din vigoare la 8.10.2024 prin Legea nr. 214/2024, iar normele
 * tehnice emise în temeiul lor și-au pierdut temeiul. Codul viu trebuie să
 * citeze DOAR Regulamentul eIDAS (UE) 910/2014, cu modificările ulterioare, și
 * Legea nr. 214/2024.
 *
 * Arhiva (docs/archive, docs/audits) NU e verificată aici: un raport datat
 * citează corect ce era în vigoare la data lui, iar rescrierea lui ar fi
 * falsificare de arhivă.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Fișierele de producție + documentația care descriu cadrul legal curent. */
const FISIERE_VII = [
  'server/services/sign-trust-report.mjs',
  'public/verifica.html',
  'public/js/df-email-modal.js',
  'README.md',
  'CLAUDE.md',
];

/**
 * Acte ABROGATE la 8.10.2024 (primele trei) / rămase fără temei (al patrulea).
 * Sunt căutate ca literali de număr — forma sub care apar în text.
 */
const ACTE_ABROGATE = [
  { literal: '455/2001',  eticheta: 'Legea 455/2001 (semnătura electronică)' },
  { literal: '451/2004',  eticheta: 'Legea 451/2004 (marca temporală)' },
  { literal: '38/2020',   eticheta: 'OUG 38/2020 (înscrisuri electronice)' },
  { literal: '1259/2001', eticheta: 'HG 1259/2001 (norme tehnice)' },
];

const numaraAparitii = (hay, needle) => hay.split(needle).length - 1;

describe('baza legală — acte abrogate scoase din codul viu', () => {
  for (const rel of FISIERE_VII) {
    describe(rel, () => {
      for (const { literal, eticheta } of ACTE_ABROGATE) {
        it(`nu mai citează ${eticheta}`, () => {
          expect(numaraAparitii(read(rel), literal)).toBe(0);
        });
      }
    });
  }
});

describe('baza legală — actele în vigoare sunt citate', () => {
  it('sign-trust-report.mjs citează Legea nr. 214/2024', () => {
    expect(read('server/services/sign-trust-report.mjs')).toContain('214/2024');
  });

  it('sign-trust-report.mjs citează Regulamentul eIDAS 910/2014', () => {
    expect(read('server/services/sign-trust-report.mjs')).toContain('910/2014');
  });

  it('pagina publică de verificare citează ambele acte în vigoare', () => {
    const html = read('public/verifica.html');
    expect(html).toContain('910/2014');
    expect(html).toContain('214/2024');
  });
});

describe('raportul CONSTATĂ, nu certifică', () => {
  /*
   * Verificarea nu validează lanțul până la o ancoră dintr-o Listă de Încredere
   * (`checkChain: false`, iar server/certs/sts-ca-bundle.pem nu conține niciun
   * certificat CA), deci niciun text livrat utilizatorului nu are voie să afirme
   * că raportul atestă/garantează o semnătură calificată.
   *
   * Tiparul prinde verbul urmat de obiectul afirmației („…ă semnăturile",
   * „…ă documentul", „…ă validitatea"), NU substantivele „certificat"/
   * „certificare", care sunt legitime și frecvente.
   */
  const TIPAR_DE_ATESTARE = /certific[ăa]\s+(?:semn|documentul|validitatea)/i;

  for (const rel of ['server/services/sign-trust-report.mjs', 'public/js/df-email-modal.js']) {
    it(`${rel} nu afirmă că atestă semnătura`, () => {
      expect(read(rel)).not.toMatch(TIPAR_DE_ATESTARE);
    });
  }

  it('fraza din raport declară explicit că lanțul nu e validat', () => {
    const src = read('server/services/sign-trust-report.mjs');
    expect(src).toContain('Trusted List');
    expect(src).toContain('NU substituie');
  });
});
