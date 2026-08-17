// server/tests/unit/ord-derive-ident.test.mjs
// SEC-100.2 — cele 4 coloane de identitate ale ORD-ului se DERIVĂ din DF-ul legat, nu se cred de la
// client. Teste PURE, importate din producție (`deriveOrdIdentityCols` din formular-shared.mjs).
import { describe, it, expect } from 'vitest';
import { deriveOrdIdentityCols, ORD_IDENT_COLS } from '../../services/formular-shared.mjs';

describe('deriveOrdIdentityCols', () => {
  it('1. client trimite cod_SSI fabricat ⇒ rezultatul e valoarea DF-ului', () => {
    const client = [{ cod_SSI: '99.99.99', suma_ordonantata_plata: '100' }];
    const ctrl   = [{ cod_SSI: '20.01.30' }];
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(out[0].cod_SSI).toBe('20.01.30');
  });

  it('2. toate cele 4 coloane se suprascriu, nu doar cod_SSI', () => {
    const client = [{ cod_angajament: 'FAKE', indicator_angajament: 'FAKE', program: 'FAKE', cod_SSI: 'FAKE' }];
    const ctrl   = [{ cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' }];
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(out[0]).toMatchObject({ cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' });
    // exact cele 4 chei din config, nimic în plus derivat
    expect(ORD_IDENT_COLS).toEqual(['cod_angajament', 'indicator_angajament', 'program', 'cod_SSI']);
  });

  it('3. coloanele de sume rămân neatinse', () => {
    const client = [{ cod_SSI: 'x', receptii: '50', plati_anterioare: '10', suma_ordonantata_plata: '40' }];
    const ctrl   = [{ cod_SSI: 'REAL', receptii: '999', plati_anterioare: '999', suma_ordonantata_plata: '999' }];
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(out[0].receptii).toBe('50');
    expect(out[0].plati_anterioare).toBe('10');
    expect(out[0].suma_ordonantata_plata).toBe('40');
    expect(out[0].cod_SSI).toBe('REAL');
  });

  it('4. DF cu câmp gol/absent ⇒ ORD primește null, NU valoarea clientului', () => {
    const client = [{ cod_angajament: 'CLIENT_A', cod_SSI: 'CLIENT_S' }];
    const ctrl   = [{ cod_angajament: '' }];   // cod_angajament gol, cod_SSI absent
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(out[0].cod_angajament).toBe('');    // '' ?? null ⇒ '' (nu CLIENT_A)
    expect(out[0].cod_SSI).toBe(null);         // absent ⇒ null (nu CLIENT_S)
    expect(out[0].program).toBe(null);
  });

  it('5. ctrlRows gol sau null ⇒ rândurile clientului se întorc neschimbate', () => {
    const client = [{ cod_SSI: 'CLIENT' }];
    expect(deriveOrdIdentityCols(client, [])).toBe(client);
    expect(deriveOrdIdentityCols(client, null)).toBe(client);
    expect(deriveOrdIdentityCols(client, undefined)).toBe(client);
  });

  it('6. clientul are mai multe rânduri decât rows_ctrl ⇒ surplusul rămâne neatins, fără crash', () => {
    const client = [
      { cod_SSI: 'CLIENT_1' },
      { cod_SSI: 'CLIENT_2', suma_ordonantata_plata: '7' },
    ];
    const ctrl = [{ cod_SSI: 'DF_1' }];   // doar 1 rând sursă
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(out[0].cod_SSI).toBe('DF_1');            // derivat
    expect(out[1].cod_SSI).toBe('CLIENT_2');        // surplus neatins
    expect(out[1].suma_ordonantata_plata).toBe('7');
  });

  it('7. input-ul NU e mutat (întoarce obiecte noi)', () => {
    const client = [{ cod_SSI: 'CLIENT' }];
    const ctrl   = [{ cod_SSI: 'DF' }];
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(client[0].cod_SSI).toBe('CLIENT');       // input neatins
    expect(out[0].cod_SSI).toBe('DF');
    expect(out[0]).not.toBe(client[0]);             // obiect nou
  });

  it('clientRows non-array ⇒ întors ca atare', () => {
    expect(deriveOrdIdentityCols(null, [{ cod_SSI: 'x' }])).toBe(null);
    expect(deriveOrdIdentityCols('nope', [{ cod_SSI: 'x' }])).toBe('nope');
  });

  // ── #128g — `ctrl_idx` face explicit ce era implicit (corelarea cu rândul sursă din DF) ──

  it('#128g 1. ⭐ NON-REGRESIE: rânduri FĂRĂ ctrl_idx ⇒ derivare pozițională, toate cele 4 coloane', () => {
    const client = [{ cod_SSI: 'X' }, { cod_SSI: 'Y' }, { cod_SSI: 'Z' }];
    const ctrl = [
      { cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: 'S0' },
      { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' },
      { cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2' },
    ];
    const out = deriveOrdIdentityCols(client, ctrl);
    out.forEach((row, i) => {
      for (const k of ORD_IDENT_COLS) expect(row[k]).toBe(ctrl[i][k]);
    });
  });

  it('#128g 2. ctrl_idx care coincide cu poziția ⇒ rezultat identic cu derivarea pozițională', () => {
    const ctrl = [
      { cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: 'S0' },
      { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' },
    ];
    const fara = deriveOrdIdentityCols([{ receptii: '1' }, { receptii: '2' }], ctrl);
    const cu = deriveOrdIdentityCols(
      [{ receptii: '1', ctrl_idx: 0 }, { receptii: '2', ctrl_idx: 1 }], ctrl);
    cu.forEach((row, i) => {
      for (const k of ORD_IDENT_COLS) expect(row[k]).toBe(fara[i][k]);
    });
  });

  it('#128g 3. ⭐ ORD multi-bloc: blocul 2 pe aceleași angajamente ⇒ identitate din rows_ctrl[0] și [1], NU [2]/[3]', () => {
    const ctrl = [
      { cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: 'S0' },
      { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' },
      { cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2' },
      { cod_angajament: 'A3', indicator_angajament: 'I3', program: 'P3', cod_SSI: 'S3' },
    ];
    const client = [
      { bloc_idx: 0, ctrl_idx: 0 }, { bloc_idx: 0, ctrl_idx: 1 },
      { bloc_idx: 1, ctrl_idx: 0 }, { bloc_idx: 1, ctrl_idx: 1 },
    ];
    const out = deriveOrdIdentityCols(client, ctrl);
    expect(out[2].cod_angajament).toBe('A0');
    expect(out[2].cod_SSI).toBe('S0');
    expect(out[3].cod_angajament).toBe('A1');
    expect(out[3].cod_SSI).toBe('S1');
    // ⛔ NU rândurile pe care le-ar fi ales corelarea pozițională
    expect(out[2].cod_angajament).not.toBe('A2');
    expect(out[3].cod_angajament).not.toBe('A3');
  });

  it('#128g 4. ⭐ FAIL-SAFE: ctrl_idx în afara intervalului ⇒ cădere pe poziție, valorile clientului SUPRASCRISE', () => {
    const ctrl = [
      { cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: 'S0' },
      { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' },
    ];
    const client = [
      { ctrl_idx: 999, cod_angajament: 'HACK', indicator_angajament: 'HACK', program: 'HACK', cod_SSI: 'HACK' },
      { ctrl_idx: 999, cod_angajament: 'HACK', indicator_angajament: 'HACK', program: 'HACK', cod_SSI: 'HACK' },
    ];
    const out = deriveOrdIdentityCols(client, ctrl);
    out.forEach((row, i) => {
      for (const k of ORD_IDENT_COLS) {
        expect(row[k]).toBe(ctrl[i][k]);
        expect(row[k]).not.toBe('HACK');
      }
    });
  });

  it('#128g 5. ctrl_idx ca ȘIR (vine din dataset DOM) ⇒ funcționează', () => {
    const ctrl = [{ cod_SSI: 'S0' }, { cod_SSI: 'S1' }, { cod_SSI: 'S2' }];
    const out = deriveOrdIdentityCols([{ ctrl_idx: '2' }], ctrl);
    expect(out[0].cod_SSI).toBe('S2');
  });

  it('#128g 6. ctrl_idx negativ/null/vid/fracționar/nenumeric ⇒ ignorat, cădere pe poziție', () => {
    const ctrl = [{ cod_SSI: 'S0' }, { cod_SSI: 'S1' }];
    for (const bad of [-1, null, '', 1.5, 'abc', NaN, undefined, {}, true]) {
      const out = deriveOrdIdentityCols([{ ctrl_idx: bad }, { ctrl_idx: bad }], ctrl);
      expect(out[0].cod_SSI).toBe('S0');
      expect(out[1].cod_SSI).toBe('S1');
    }
  });

  it('#128g 7. ctrlRows gol ⇒ clientRows întors neatins, chiar cu ctrl_idx prezent', () => {
    const client = [{ ctrl_idx: 0, cod_SSI: 'CLIENT' }];
    expect(deriveOrdIdentityCols(client, [])).toBe(client);
  });

  it('#128g 8. ctrl_idx însuși e PĂSTRAT pe rândul derivat (e nevoie de el la salvarea următoare)', () => {
    const ctrl = [{ cod_SSI: 'S0' }, { cod_SSI: 'S1' }];
    const out = deriveOrdIdentityCols([{ ctrl_idx: 1, receptii: '5' }], ctrl);
    expect(out[0].ctrl_idx).toBe(1);
    expect(out[0].cod_SSI).toBe('S1');
  });

  it('rânduri client non-obiect rămân neatinse (rândul-obiect primește toate cele 4 chei)', () => {
    const client = [null, 'x', 42, { cod_SSI: 'CLIENT' }];
    const ctrl   = [{ cod_SSI: 'A' }, { cod_SSI: 'B' }, { cod_SSI: 'C' }, { cod_SSI: 'D' }];
    const out = deriveOrdIdentityCols(client, ctrl);
    // non-obiectele trec neatinse; rândul-obiect are cele 4 coloane derivate (absentele ⇒ null)
    expect(out.slice(0, 3)).toEqual([null, 'x', 42]);
    expect(out[3]).toEqual({ cod_SSI: 'D', cod_angajament: null, indicator_angajament: null, program: null });
  });
});
