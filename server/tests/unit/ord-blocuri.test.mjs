// server/tests/unit/ord-blocuri.test.mjs
// FEATURE #128b — fundația ORD multi-bloc. Teste pure pentru modulul de interpretare.
import { describe, it, expect } from 'vitest';
import { blocuriDinOrd, randuriBloc, randuriPeBlocuri, oglindaBloc1 } from '../../services/ord-blocuri.mjs';

const ORD_LEGACY = {
  nr_unic_inreg: 'NR-1',
  beneficiar: 'SC Exemplu SRL',
  documente_justificative: 'Factura 1',
  iban_beneficiar: 'RO49AAAA1B31007593840000',
  cif_beneficiar: 'RO123456',
  banca_beneficiar: 'Banca X',
  inf_pv_plata: 'PV 1',
  inf_pv_plata1: 'PV 2',
  blocuri: null,
};

describe('blocuriDinOrd', () => {
  it('blocuri NULL → un singur bloc legacy, bloc_idx 0, din coloanele plate', () => {
    const result = blocuriDinOrd(ORD_LEGACY);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bloc_idx: 0,
      nr_unic_inreg: 'NR-1',
      beneficiar: 'SC Exemplu SRL',
      documente_justificative: 'Factura 1',
      iban_beneficiar: 'RO49AAAA1B31007593840000',
      cif_beneficiar: 'RO123456',
      banca_beneficiar: 'Banca X',
      inf_pv_plata: 'PV 1',
      inf_pv_plata1: 'PV 2',
    });
  });

  it('blocuri [] → tratat identic ca legacy (array gol ≠ zero blocuri)', () => {
    const result = blocuriDinOrd({ ...ORD_LEGACY, blocuri: [] });
    expect(result).toHaveLength(1);
    expect(result[0].bloc_idx).toBe(0);
    expect(result[0].beneficiar).toBe('SC Exemplu SRL');
  });

  it('blocuri cu 2 elemente → ambele întoarse, în ordine, bloc_idx 0 și 1', () => {
    const ord = {
      blocuri: [
        { bloc_idx: 0, beneficiar: 'Furnizor A' },
        { bloc_idx: 1, beneficiar: 'Furnizor B' },
      ],
    };
    const result = blocuriDinOrd(ord);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ bloc_idx: 0, beneficiar: 'Furnizor A' });
    expect(result[1]).toMatchObject({ bloc_idx: 1, beneficiar: 'Furnizor B' });
  });

  it('blocuri cu elemente fără bloc_idx → completat din poziția în array', () => {
    const ord = {
      blocuri: [
        { beneficiar: 'Furnizor A' },
        { beneficiar: 'Furnizor B' },
      ],
    };
    const result = blocuriDinOrd(ord);
    expect(result[0].bloc_idx).toBe(0);
    expect(result[1].bloc_idx).toBe(1);
  });

  it('caz negativ: ord fără nicio coloană plată completată → tot un bloc, valori goale, fără excepție', () => {
    expect(() => blocuriDinOrd({})).not.toThrow();
    const result = blocuriDinOrd({});
    expect(result).toHaveLength(1);
    expect(result[0].bloc_idx).toBe(0);
    expect(result[0].beneficiar).toBe('');
    expect(result[0].nr_unic_inreg).toBe('');
  });

  it('caz negativ: ord null/undefined → tot un bloc legacy, fără excepție', () => {
    expect(() => blocuriDinOrd(null)).not.toThrow();
    expect(blocuriDinOrd(null)).toHaveLength(1);
    expect(blocuriDinOrd(undefined)).toHaveLength(1);
  });
});

describe('randuriBloc', () => {
  const rows = [
    { id: 1 },                 // fără bloc_idx → bloc 0
    { id: 2, bloc_idx: null }, // null → bloc 0
    { id: 3, bloc_idx: 0 },
    { id: 4, bloc_idx: 1 },
    { id: 5, bloc_idx: 1 },
  ];

  it('include rândurile fără bloc_idx (sau null) în blocul 0 — cazul producției de azi', () => {
    const bloc0 = randuriBloc(rows, 0);
    expect(bloc0.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('întoarce doar rândurile marcate explicit cu blocul cerut', () => {
    const bloc1 = randuriBloc(rows, 1);
    expect(bloc1.map((r) => r.id)).toEqual([4, 5]);
  });
});

describe('randuriPeBlocuri', () => {
  it('distribuie rândurile amestecate pe blocuri, fără pierderi', () => {
    const rows = [
      { id: 1 },
      { id: 2, bloc_idx: 1 },
      { id: 3, bloc_idx: 0 },
      { id: 4, bloc_idx: 2 },
      { id: 5, bloc_idx: 1 },
    ];
    const result = randuriPeBlocuri(rows, 3);
    expect(result).toHaveLength(3);
    expect(result[0].map((r) => r.id)).toEqual([1, 3]);
    expect(result[1].map((r) => r.id)).toEqual([2, 5]);
    expect(result[2].map((r) => r.id)).toEqual([4]);
    const total = result.reduce((sum, blk) => sum + blk.length, 0);
    expect(total).toBe(rows.length);
  });
});

describe('oglindaBloc1', () => {
  it('întoarce exact cele 8 chei ale blocului 1', () => {
    const blocuri = [
      {
        bloc_idx: 0,
        nr_unic_inreg: 'NR-1',
        beneficiar: 'Furnizor A',
        documente_justificative: 'Factura 1',
        iban_beneficiar: 'RO1',
        cif_beneficiar: 'RO123',
        banca_beneficiar: 'Banca A',
        inf_pv_plata: 'PV1',
        inf_pv_plata1: 'PV2',
      },
      { bloc_idx: 1, beneficiar: 'Furnizor B' },
    ];
    const result = oglindaBloc1(blocuri);
    expect(Object.keys(result).sort()).toEqual([
      'banca_beneficiar',
      'beneficiar',
      'cif_beneficiar',
      'documente_justificative',
      'iban_beneficiar',
      'inf_pv_plata',
      'inf_pv_plata1',
      'nr_unic_inreg',
    ].sort());
    expect(result.beneficiar).toBe('Furnizor A');
  });

  it('listă de blocuri goală → obiect cu valori goale (nu undefined)', () => {
    const result = oglindaBloc1([]);
    expect(result.beneficiar).toBe('');
    expect(result.nr_unic_inreg).toBe('');
    for (const v of Object.values(result)) {
      expect(v).not.toBeUndefined();
      expect(v).toBe('');
    }
  });
});
