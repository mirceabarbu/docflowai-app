// Validare XSD reală a serializer-ului DF NOTAFD contra `notafd_v0.xsd`, pe exemplele
// din ghidul MF. Validator: xmllint-wasm (pur WASM, fără dependență de sistem — merge în CI).
//
// Obiectele DF de mai jos sunt XSD-shaped (root + sectiuneaA + sectiuneaB), identice cu
// `data` JSONB-ul pe care îl consumă generatorul PDF. Sumele sunt în LEI (decimal) — exact
// formatul stocat real; serializer-ul le emite ca lei ÎNTREGI (rotunjire în sus) pentru
// IntPoz12SType, care e xs:integer în schema oficială MF.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import { serializeNotafd } from '../../services/alop-xml/notafd-serializer.mjs';
import { ronToLeiXml, dateRo, ckbx, cif, xmlEscape, strClamp } from '../../services/alop-xml/format.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XSD_PATH = resolve(__dirname, '../../services/alop-xml/schemas/notafd_v0.xsd');

let xsd;
beforeAll(async () => { xsd = await readFile(XSD_PATH, 'utf8'); });

async function expectValid(df) {
  const xml = serializeNotafd(df);
  const res = await validateXML({ xml, schema: xsd });
  if (!res.valid) {
    throw new Error('XML invalid contra XSD:\n' + JSON.stringify(res.errors, null, 2) + '\n\n' + xml);
  }
  expect(res.valid).toBe(true);
  return xml;
}

// ── Helpers de conversie (puri) ─────────────────────────────────────────────
describe('format.mjs — conversii pure', () => {
  it('ronToLeiXml: format românesc cu mii "." și zecimal "," -> leu întreg (ceiling)', () => {
    expect(ronToLeiXml('11.523.668,69')).toBe('11523669');
  });
  it('ronToLeiXml: decimal JS (formatul stocat real) -> leu întreg (ceiling)', () => {
    expect(ronToLeiXml(11523668.69)).toBe('11523669');
    expect(ronToLeiXml('11523668.69')).toBe('11523669');
  });
  it('ronToLeiXml: bani -> rotunjire în SUS la leu', () => {
    expect(ronToLeiXml(2964.5)).toBe('2965');
    expect(ronToLeiXml('2964,50')).toBe('2965');
    expect(ronToLeiXml(2964.01)).toBe('2965');
    expect(ronToLeiXml(2964)).toBe('2964'); // fără fracție -> neschimbat
  });
  it('ronToLeiXml: întregi și grupare cu mai multe puncte -> lei întregi', () => {
    expect(ronToLeiXml(560)).toBe('560');
    expect(ronToLeiXml('301.000.000')).toBe('301000000');
    expect(ronToLeiXml('27.650.000')).toBe('27650000');
  });
  it('ronToLeiXml: empty/null -> null (atribut omis); 0 completat -> "0"', () => {
    expect(ronToLeiXml('')).toBeNull();
    expect(ronToLeiXml(null)).toBeNull();
    expect(ronToLeiXml(undefined)).toBeNull();
    expect(ronToLeiXml(0)).toBe('0');
  });
  it('ronToLeiXml: păstrează semnul (NU clampază negativele)', () => {
    expect(ronToLeiXml(-10)).toBe('-10');
  });
  it('ronToLeiXml: depășirea IntPoz12 aruncă', () => {
    expect(() => ronToLeiXml(9999999999999)).toThrow();
  });
  it('ckbx: bifat -> "1", nebifat -> ""', () => {
    expect(ckbx('1')).toBe('1');
    expect(ckbx(true)).toBe('1');
    expect(ckbx('on')).toBe('1');
    expect(ckbx('')).toBe('');
    expect(ckbx(undefined)).toBe('');
    expect(ckbx('0')).toBe('');
  });
  it('cif: elimină prefix RO și spații', () => {
    expect(cif('RO4221306')).toBe('4221306');
    expect(cif(' 4221306 ')).toBe('4221306');
    expect(cif(4221306)).toBe('4221306');
  });
  it('dateRo: ISO -> dd.mm.yyyy; pass-through dacă deja românesc', () => {
    expect(dateRo('2026-01-15')).toBe('15.1.2026');
    expect(dateRo('15.01.2026')).toBe('15.01.2026');
    expect(dateRo('')).toBeNull();
  });
  it('xmlEscape: & < > " \'', () => {
    expect(xmlEscape('a & b < c > "d" \'e\'')).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  });
  it('strClamp: aruncă peste maxLength (nu trunchiază silențios)', () => {
    expect(strClamp('abc', 5, 'f')).toBe('abc');
    expect(() => strClamp('abcdef', 3, 'f')).toThrow(/maxLength/);
  });
});

// ── Exemple MF — validare XSD ───────────────────────────────────────────────
describe('serializeNotafd — exemple MF validate contra notafd_v0.xsd', () => {
  // Ex.1 — art.47, credite bugetare 11.523.668,69; col.6 (influențe ang)=0,
  //         col.9 (influențe bug)=11.523.668,69.
  it('Ex.1 — art.47 credite bugetare 11.523.668,69 (col.6=0, col.9=suma)', async () => {
    const df = {
      Cif: '4267117',
      DenInstPb: 'Unitatea Administrativ-Teritorială Exemplu',
      SubtitluDF: 'Rezervare credite bugetare conform art.47',
      NrUnicInreg: 'DF-2026-0001',
      Revizuirea: '0',
      DataRevizuirii: '10.01.2026',
      sectiuneaA: {
        compartiment_specialitate: 'Direcția Economică',
        obiect_fd_reviz_scurt: 'Rezervare credite bugetare art.47',
        obiect_fd_reviz_lung: 'Rezervarea creditelor bugetare necesare conform prevederilor art.47.',
        ang_legale_val: {
          ckbx_stab_tin_cont: '1',
          rowT_ang_pl_val: [
            { element_fd: 'Credite bugetare art.47', program: '5102', codSSI: '71.01.01',
              param_fd: 'conform fundamentare', valt_rev_prec: 0, influente: 11523668.69,
              valt_actualiz: 11523668.69 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: '1',
          ckbx_cu_plati_ang_in_mmani: '1',
          rowT_ang_pl_plati: [
            { program: '5102', codSSI: '71.01.01', plati_estim_ancrt: 11523668.69 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: '1',
        rowT_ang_ctrl_ang: [
          { cod_angajament: '20260001', indicator_angajament: 'A', program: '5102', cod_SSI: '71.01.01',
            sum_rezv_crdt_ang_af_rvz_prc: 0, influente_c6: 0, sum_rezv_crdt_ang_act: 0,
            sum_rezv_crdt_bug_af_rvz_prc: 0, influente_c9: 11523668.69, sum_rezv_crdt_bug_act: 11523668.69 },
        ],
      },
    };
    const xml = await expectValid(df);
    // Lei întregi, ceiling: 11.523.668,69 lei -> "11523669".
    expect(xml).toContain('11523669');
    expect(xml).toContain('influente_c6="0"');
    expect(xml).toContain('influente_c9="11523669"');
  });

  // Ex.2 rev.0 — Achiziție licență IT, 560 lei.
  it('Ex.2 rev.0 — Achiziție licență IT (560)', async () => {
    const df = {
      Cif: '4221306',
      DenInstPb: 'Primăria Comunei Exemplu',
      SubtitluDF: 'Achiziție licență IT',
      NrUnicInreg: 'DF-2026-0002',
      Revizuirea: '0',
      DataRevizuirii: '15.01.2026',
      sectiuneaA: {
        compartiment_specialitate: 'Compartiment IT',
        obiect_fd_reviz_scurt: 'Achiziție licență software',
        obiect_fd_reviz_lung: 'Achiziția unei licențe IT necesară activității curente.',
        ang_legale_val: {
          ckbx_stab_tin_cont: '1',
          rowT_ang_pl_val: [
            { element_fd: 'Licență IT', program: '6102', codSSI: '20.01.30', param_fd: '1 buc',
              valt_rev_prec: 0, influente: 560, valt_actualiz: 560 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: '1',
          ckbx_cu_plati_ang_in_mmani: '1',
          rowT_ang_pl_plati: [
            { program: '6102', codSSI: '20.01.30', plati_estim_ancrt: 560 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: '1',
        rowT_ang_ctrl_ang: [
          { cod_angajament: '20260002', indicator_angajament: 'A', program: '6102', cod_SSI: '20.01.30',
            sum_rezv_crdt_ang_act: 560, sum_rezv_crdt_bug_act: 560 },
        ],
      },
    };
    const xml = await expectValid(df);
    expect(xml).toContain('"560"'); // 560 lei -> întreg, fără zecimale
  });

  // Ex.3 — drepturi de personal, două rânduri 301.000.000 + 27.650.000.
  it('Ex.3 — drepturi de personal, două rânduri (301.000.000 + 27.650.000)', async () => {
    const df = {
      Cif: '4267117',
      DenInstPb: 'Instituția Publică Exemplu',
      SubtitluDF: 'Drepturi de personal',
      NrUnicInreg: 'DF-2026-0003',
      Revizuirea: '0',
      DataRevizuirii: '20.01.2026',
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Resurse Umane',
        obiect_fd_reviz_scurt: 'Asigurarea drepturilor de personal',
        obiect_fd_reviz_lung: 'Asigurarea fondurilor pentru drepturile salariale și contribuțiile aferente.',
        ang_legale_val: {
          ckbx_stab_tin_cont: '1',
          rowT_ang_pl_val: [
            { element_fd: 'Salarii de bază', program: '6502', codSSI: '10.01.01',
              param_fd: 'state de plată', valt_rev_prec: 0, influente: 301000000, valt_actualiz: 301000000 },
            { element_fd: 'Contribuții', program: '6502', codSSI: '10.03.07',
              param_fd: 'state de plată', valt_rev_prec: 0, influente: 27650000, valt_actualiz: 27650000 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: '1',
          ckbx_cu_plati_ang_in_mmani: '1',
          rowT_ang_pl_plati: [
            { program: '6502', codSSI: '10.01.01', plati_estim_ancrt: 301000000 },
            { program: '6502', codSSI: '10.03.07', plati_estim_ancrt: 27650000 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: '1',
        rowT_ang_ctrl_ang: [
          { cod_angajament: '20260003A', indicator_angajament: 'A', program: '6502', cod_SSI: '10.01.01',
            sum_rezv_crdt_ang_act: 301000000, sum_rezv_crdt_bug_act: 301000000 },
          { cod_angajament: '20260003B', indicator_angajament: 'A', program: '6502', cod_SSI: '10.03.07',
            sum_rezv_crdt_ang_act: 27650000, sum_rezv_crdt_bug_act: 27650000 },
        ],
      },
    };
    const xml = await expectValid(df);
    expect(xml).toContain('"301000000"'); // 301.000.000 lei -> lei întregi
    expect(xml).toContain('"27650000"');  // 27.650.000 lei -> lei întregi
  });

  // Ex.4 rev.0 — angajamente legale emise în contul anului următor.
  it('Ex.4 rev.0 — an următor (ckbx_ang_leg_emise_ct_an_urm)', async () => {
    const df = {
      Cif: '4221306',
      DenInstPb: 'Primăria Municipiului Exemplu',
      SubtitluDF: 'Contract servicii an următor',
      NrUnicInreg: 'DF-2026-0004',
      Revizuirea: '0',
      DataRevizuirii: '25.01.2026',
      sectiuneaA: {
        compartiment_specialitate: 'Direcția Achiziții',
        obiect_fd_reviz_scurt: 'Contract de servicii cu execuție în anul următor',
        obiect_fd_reviz_lung: 'Contractarea de servicii ale căror angajamente legale se emit în contul anului următor.',
        ang_legale_val: {
          ckbx_stab_tin_cont: '1',
          rowT_ang_pl_val: [
            { element_fd: 'Servicii an următor', program: '7002', codSSI: '20.01.09',
              param_fd: 'contract cadru', valt_rev_prec: 0, influente: 120000, valt_actualiz: 120000 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: '1',
          ckbx_fara_plati_ang_in_ancrt: '1',
          ckbx_ang_leg_emise_ct_an_urm: '1',
          rowT_ang_pl_plati: [
            { program: '7002', codSSI: '20.01.09', plati_estim_an_np1: 120000 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: '1',
        rowT_ang_ctrl_ang: [
          { cod_angajament: '20260004', indicator_angajament: 'A', program: '7002', cod_SSI: '20.01.09',
            sum_rezv_crdt_ang_act: 120000, sum_rezv_crdt_bug_act: 0 },
        ],
      },
    };
    const xml = await expectValid(df);
    expect(xml).toContain('ckbx_ang_leg_emise_ct_an_urm="1"');
    expect(xml).toContain('plati_estim_an_np1="120000"');
  });

  // Ex.5 — terț / obligație legală, buget insuficient: SecB fără rânduri de control,
  //         ckbx_fara_inreg_ctrl_ang + sum_fara_inreg_ctrl_crdbug + ckbx_interzis_emit_ang.
  it('Ex.5 — buget insuficient (ckbx_fara_inreg_ctrl_ang + interzis_emit_ang)', async () => {
    const df = {
      Cif: '4267117',
      DenInstPb: 'Instituția Publică Exemplu',
      SubtitluDF: 'Obligație legală terț — credite insuficiente',
      NrUnicInreg: 'DF-2026-0005',
      Revizuirea: '0',
      DataRevizuirii: '28.01.2026',
      sectiuneaA: {
        compartiment_specialitate: 'Direcția Juridică',
        obiect_fd_reviz_scurt: 'Plata unei obligații legale stabilite de un terț',
        obiect_fd_reviz_lung: 'Obligație de plată stabilită prin hotărâre, pentru care creditele sunt insuficiente.',
        ang_legale_val: {
          ckbx_stab_tin_cont: '1',
          rowT_ang_pl_val: [
            { element_fd: 'Obligație terț', program: '5402', codSSI: '59.17',
              param_fd: 'hotărâre definitivă', valt_rev_prec: 0, influente: 75000, valt_actualiz: 75000 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: '1',
          ckbx_cu_plati_ang_in_mmani: '1',
          rowT_ang_pl_plati: [
            { program: '5402', codSSI: '59.17', plati_estim_ancrt: 75000 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_fara_inreg_ctrl_ang: '1',
        sum_fara_inreg_ctrl_crdbug: 75000,
        ckbx_interzis_emit_ang: '1',
        // pereche 2 (sum_fara_inreg_ctrl_crd_bug) e câmp INTERN — NU trebuie să apară în XML
        sum_fara_inreg_ctrl_crd_bug: 99999,
      },
    };
    const xml = await expectValid(df);
    expect(xml).toContain('ckbx_fara_inreg_ctrl_ang="1"');
    expect(xml).toContain('sum_fara_inreg_ctrl_crdbug="75000"');
    expect(xml).toContain('ckbx_interzis_emit_ang="1"');
    // SecB fără rânduri de control -> element self-closing, fără rowT_ang_ctrl_ang
    expect(xml).not.toContain('<rowT_ang_ctrl_ang');
    // Pereche 2 NU se emite în XML (câmp intern afișaj/PDF).
    expect(xml).not.toContain('sum_fara_inreg_ctrl_crd_bug');
    expect(xml).not.toContain('"99999"');
  });
});

// ── Limitare cunoscută v0 — influențe negative (revizii cu diminuare) ────────
// `influente`/`influente_c6`/`influente_c9` sunt IntPoz12SType (minInclusive=0), dar
// reviziile cu diminuare au influențe NEGATIVE. Serializer-ul le emite fidel (NU clampază),
// deci XML-ul NU validează contra schemei v0 — conflict de ridicat cu MF / de reluat la
// apariția unui XSD corectat. Marcate explicit it.todo (disciplina "skipped ≠ passed").
describe('serializeNotafd — influențe negative vs schema v0 (it.todo)', () => {
  it.todo('Ex.2 rev.1 — influență −10 lei (diminuare): v0 respinge negativul (minInclusive=0)');
  it.todo('Ex.4 rev.1 — revizie cu diminuare + "rămâne în suma de": idem conflict v0');
});
