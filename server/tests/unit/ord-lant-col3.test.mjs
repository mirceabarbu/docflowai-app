/**
 * #186 — aritmetica derivării col.3 („Plăți anterioare"), pe funcțiile PURE din
 * services/ord-lant.mjs. Fără DB: `col3DinPredecesor` + `sumaColoana`.
 *
 * Cifrele sunt cele REALE din dosarul „Iluminat public" (DF nr. 6744, valoare
 * 360.424,95) — trei cicluri consecutive verificate de owner pe documente semnate:
 *
 *   ciclu | ORD   | col.2       | col.3       | col.4     | col.3+col.4
 *     1   | 41011 | —           | 254.379,63  | 46.045,32 | 300.424,95
 *     2   | 43759 | 353.688,51  | 300.424,95  | 53.263,56 | 353.688,51
 *     3   | 47218 | ≥413.096,30 | 353.688,51  | 59.407,79 | 413.096,30
 */
import { describe, it, expect } from 'vitest';
import { col3DinPredecesor, sumaColoana } from '../../services/ord-lant.mjs';

const CICLU1 = { col2: 0, col3: 254379.63, col4: 46045.32 };
const CICLU2 = { col2: 353688.51, col3: 300424.95, col4: 53263.56 };

describe('#186 col3DinPredecesor — lanțul real de trei cicluri', () => {
  it('ciclul 2 derivă col.3 = col.3+col.4 al ciclului 1 (plată confirmată)', () => {
    const r = col3DinPredecesor({ ...CICLU1, plata_confirmata: true });
    expect(r.sursa).toBe('lant');
    expect(r.plata_predecesor_confirmata).toBe(true);
    expect(r.col3).toBeCloseTo(300424.95, 2);
    // exact col.3 real al ORD 43759
    expect(r.col3).toBeCloseTo(CICLU2.col3, 2);
  });

  it('ciclul 3 derivă col.3 = col.3+col.4 al ciclului 2 (plată confirmată)', () => {
    const r = col3DinPredecesor({ ...CICLU2, plata_confirmata: true });
    expect(r.col3).toBeCloseTo(353688.51, 2);
  });

  it('col.3+col.4 al ciclului 2 e fix col.2 al lui ⇒ col.5 = 0,00', () => {
    const c5 = CICLU2.col2 - CICLU2.col3 - CICLU2.col4;
    expect(c5).toBeCloseTo(0, 2);
  });

  it('NUANȚA DIN GHID: predecesor NEdecontat ⇒ col.4 al lui NU intră', () => {
    const r = col3DinPredecesor({ ...CICLU1, plata_confirmata: false });
    expect(r.sursa).toBe('lant');
    expect(r.plata_predecesor_confirmata).toBe(false);
    expect(r.col3).toBeCloseTo(254379.63, 2);   // doar col.3, fără cei 46.045,32
  });

  it('ciclul 3 cu predecesor NEdecontat ⇒ 300.424,95, nu 353.688,51', () => {
    const r = col3DinPredecesor({ ...CICLU2, plata_confirmata: false });
    expect(r.col3).toBeCloseTo(300424.95, 2);
  });

  it('fără predecesor ⇒ col3 null („nu se știe"), NU 0', () => {
    const r = col3DinPredecesor(null);
    expect(r.col3).toBeNull();
    expect(r.col3).not.toBe(0);
    expect(r.sursa).toBe('prima_ord');
    expect(r.plata_predecesor_confirmata).toBe(false);
  });
});

describe('#186 sumaColoana — însumare peste TOATE rândurile', () => {
  it('ORD multi-bloc: toate rândurile contează', () => {
    const rows = [
      { bloc_idx: 0, suma_ordonantata_plata: '30000.50', receptii: '100000', plati_anterioare: '5000' },
      { bloc_idx: 0, suma_ordonantata_plata: '13263.06', receptii: '20000',  plati_anterioare: '0' },
      { bloc_idx: 1, suma_ordonantata_plata: '10000',    receptii: '15000',  plati_anterioare: '0' },
    ];
    expect(sumaColoana(rows, 'suma_ordonantata_plata')).toBeCloseTo(53263.56, 2);
    expect(sumaColoana(rows, 'receptii')).toBeCloseTo(135000, 2);
    expect(sumaColoana(rows, 'plati_anterioare')).toBeCloseTo(5000, 2);
  });

  it('acceptă JSONB deja parsat, string JSON, sau nimic', () => {
    expect(sumaColoana('[{"suma_ordonantata_plata":"12.34"}]', 'suma_ordonantata_plata')).toBeCloseTo(12.34, 2);
    expect(sumaColoana(null, 'suma_ordonantata_plata')).toBe(0);
    expect(sumaColoana('nu-i json', 'suma_ordonantata_plata')).toBe(0);
    expect(sumaColoana([{}], 'suma_ordonantata_plata')).toBe(0);
  });
});
