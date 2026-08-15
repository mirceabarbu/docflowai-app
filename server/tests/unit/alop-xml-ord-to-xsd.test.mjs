// Mapper rând DB plat -> obiect ORD XSD-shaped (ord-to-xsd.mjs), PORTUL backend al `colO()`.
// Dovedim echivalența structurală (câmpurile docFd sunt coloane PLATE top-level în DB, nestate
// sub `docFd`; `rowTfd` = coloana plată `rows`) + lanțul complet valid contra ordnt_v0.xsd.

import { describe, it, expect } from 'vitest';
import { ordRowToXsd } from '../../services/alop-xml/ord-to-xsd.mjs';
import { serializeOrdnt } from '../../services/alop-xml/ordnt-serializer.mjs';
import { validateXml } from '../../services/alop-xml/validate.mjs';

const dbRow = {
  id: 'ord-1', org_id: 1, status: 'completed',
  cif: '4267117', den_inst_pb: 'Unitatea Administrativ-Teritorială Exemplu',
  nr_ordonant_pl: '121', data_ordont_pl: '05.02.2026',
  // câmpuri docFd = coloane plate top-level în formulare_ord
  nr_unic_inreg: '111', beneficiar: 'Telekom România', documente_justificative: 'Factura',
  iban_beneficiar: 'RO51 RNCB 0080 0029 7151 0001', cif_beneficiar: '427320',
  banca_beneficiar: 'BCR', inf_pv_plata: 'Contravaloare factură aferentă lunii ianuarie', inf_pv_plata1: '',
  rows: [
    { cod_angajament: 'AABBD7P9XP6', indicator_angajament: 'AAB', program: '0000000541',
      cod_SSI: '01A510103200108', receptii: '50', plati_anterioare: '0',
      suma_ordonantata_plata: '50', receptii_neplatite: '0' },
  ],
};

describe('ordRowToXsd — echivalență cu forma colO() + lanț valid XSD', () => {
  // ⭐ #128e — `docFd` e ARRAY, dar un ORD legacy (`blocuri` NULL) dă EXACT un element, cu
  // conținut identic cu obiectul produs înainte de patch (comparat cheie cu cheie).
  it('produce EXACT forma XSD-shaped (docFd = array cu UN bloc din coloane plate)', () => {
    expect(ordRowToXsd(dbRow)).toEqual({
      Cif: '4267117',
      DenInstPb: 'Unitatea Administrativ-Teritorială Exemplu',
      NrOrdonantPl: '121',
      DataOrdontPl: '05.02.2026',
      docFd: [{
        nr_unic_inreg: '111', beneficiar: 'Telekom România', documente_justificative: 'Factura',
        iban_beneficiar: 'RO51 RNCB 0080 0029 7151 0001', cif_beneficiar: '427320',
        banca_beneficiar: 'BCR', inf_pv_plata: 'Contravaloare factură aferentă lunii ianuarie', inf_pv_plata1: '',
        rowTfd: dbRow.rows,
      }],
    });
    // cheile blocului rămân EXACT cele de dinainte de #128e (nici una în plus, nici una în minus)
    expect(Object.keys(ordRowToXsd(dbRow).docFd[0]).sort()).toEqual([
      'banca_beneficiar', 'beneficiar', 'cif_beneficiar', 'documente_justificative',
      'iban_beneficiar', 'inf_pv_plata', 'inf_pv_plata1', 'nr_unic_inreg', 'rowTfd',
    ]);
  });

  it('coloane lipsă -> stringuri goale / rowTfd gol', () => {
    const xsd = ordRowToXsd({ cif: '4267117' });
    expect(xsd.NrOrdonantPl).toBe('');
    expect(xsd.docFd).toHaveLength(1);
    expect(xsd.docFd[0].rowTfd).toEqual([]);
  });

  it('lanț complet: rând DB -> serializeOrdnt -> validateXml === valid', async () => {
    const xml = serializeOrdnt(ordRowToXsd(dbRow));
    const { valid, errors } = await validateXml(xml, 'ordnt_v0');
    if (!valid) throw new Error('XML invalid:\n' + JSON.stringify(errors, null, 2) + '\n' + xml);
    expect(valid).toBe(true);
    // IBAN normalizat de serializer (fără spații), delimitat cu apostrof (parser XFA MF).
    expect(xml).toContain("iban_beneficiar='RO51RNCB0080002971510001'");
  });

  it('aruncă pe input non-obiect', () => {
    expect(() => ordRowToXsd(null)).toThrow();
  });
});

// ── #128e — N blocuri ────────────────────────────────────────────────────────
// Sursa de adevăr sunt `blocuri[]` (#128c); coloanele plate rămân oglinda blocului 1.

const XML_MONO_BLOC = `<?xml version="1.0" encoding="UTF-8"?>
<ORDNT xmlns="mfp:anaf:dgti:ordnt:declaratie:v1" Cif='4267117' DenInstPb='Unitatea Administrativ-Teritorială Exemplu' NrOrdonantPl='121' DataOrdontPl='05.02.2026'>
  <docFd nr_unic_inreg='111' beneficiar='Telekom România' documente_justificative='Factura' iban_beneficiar='RO51RNCB0080002971510001' cif_beneficiar='427320' banca_beneficiar='BCR' inf_pv_plata='Contravaloare factură aferentă lunii ianuarie' inf_pv_plata1=''>
    <rowTfd cod_angajament='AABBD7P9XP6' indicator_angajament='AAB' program='0000000541' cod_SSI='01A510103200108' receptii='50' plati_anterioare='0' suma_ordonantata_plata='50' receptii_neplatite='0'></rowTfd>
  </docFd>
</ORDNT>`;

const dbRow2Blocuri = {
  ...dbRow,
  blocuri: [
    { bloc_idx: 0, nr_unic_inreg: '111', beneficiar: 'Telekom România',
      documente_justificative: 'Factura T', iban_beneficiar: 'RO51RNCB0080002971510001',
      cif_beneficiar: '427320', banca_beneficiar: 'BCR', inf_pv_plata: 'plata T', inf_pv_plata1: '' },
    { bloc_idx: 1, nr_unic_inreg: '111', beneficiar: 'Furnizor Secund SRL',
      documente_justificative: 'Factura S', iban_beneficiar: 'RO49AAAA1B31007593840000',
      cif_beneficiar: '1234567', banca_beneficiar: 'Trezoreria', inf_pv_plata: 'plata S', inf_pv_plata1: '' },
  ],
  rows: [
    { bloc_idx: 0, cod_angajament: 'AABBD7P9XP6', indicator_angajament: 'AAB', program: '0000000541',
      cod_SSI: '01A510103200108', receptii: '50', plati_anterioare: '0',
      suma_ordonantata_plata: '50', receptii_neplatite: '0' },
    { bloc_idx: 1, cod_angajament: 'BBCCE8Q0YQ7', indicator_angajament: 'BBC', program: '0000000542',
      cod_SSI: '01A510103200109', receptii: '70', plati_anterioare: '0',
      suma_ordonantata_plata: '70', receptii_neplatite: '0' },
    { bloc_idx: 1, cod_angajament: 'CCDDF9R1ZR8', indicator_angajament: 'CCD', program: '0000000543',
      cod_SSI: '01A510103200110', receptii: '30', plati_anterioare: '0',
      suma_ordonantata_plata: '30', receptii_neplatite: '0' },
  ],
};

describe('ordRowToXsd — N blocuri (#128e)', () => {
  it('2 blocuri -> 2 elemente docFd, fiecare cu beneficiarul și RÂNDURILE lui', () => {
    const xsd = ordRowToXsd(dbRow2Blocuri);
    expect(xsd.docFd).toHaveLength(2);

    expect(xsd.docFd[0].beneficiar).toBe('Telekom România');
    expect(xsd.docFd[0].cif_beneficiar).toBe('427320');
    expect(xsd.docFd[0].rowTfd.map(r => r.bloc_idx)).toEqual([0]);
    expect(xsd.docFd[0].rowTfd.map(r => r.cod_angajament)).toEqual(['AABBD7P9XP6']);

    expect(xsd.docFd[1].beneficiar).toBe('Furnizor Secund SRL');
    expect(xsd.docFd[1].cif_beneficiar).toBe('1234567');
    expect(xsd.docFd[1].rowTfd.map(r => r.bloc_idx)).toEqual([1, 1]);
    expect(xsd.docFd[1].rowTfd.map(r => r.cod_angajament)).toEqual(['BBCCE8Q0YQ7', 'CCDDF9R1ZR8']);
  });

  it('rânduri fără bloc_idx + 2 blocuri -> toate pe blocul 0, blocul 2 cu rowTfd gol', () => {
    const xsd = ordRowToXsd({ ...dbRow2Blocuri, rows: dbRow.rows });   // rânduri fără bloc_idx
    expect(xsd.docFd).toHaveLength(2);
    expect(xsd.docFd[0].rowTfd).toEqual(dbRow.rows);
    expect(xsd.docFd[1].rowTfd).toEqual([]);
  });

  it('⭐ un bloc -> XML IDENTIC cu cel de dinainte de #128e (string exact)', () => {
    expect(serializeOrdnt(ordRowToXsd(dbRow))).toBe(XML_MONO_BLOC);
  });

  it('2 blocuri -> DOUĂ elemente <docFd> cu beneficiar/cif/iban proprii, XML valid XSD', async () => {
    const xml = serializeOrdnt(ordRowToXsd(dbRow2Blocuri));
    expect((xml.match(/<docFd /g) || []).length).toBe(2);
    expect(xml).toContain("beneficiar='Telekom România'");
    expect(xml).toContain("beneficiar='Furnizor Secund SRL'");
    expect(xml).toContain("cif_beneficiar='427320'");
    expect(xml).toContain("cif_beneficiar='1234567'");
    expect(xml).toContain("iban_beneficiar='RO51RNCB0080002971510001'");
    expect(xml).toContain("iban_beneficiar='RO49AAAA1B31007593840000'");
    // rândurile blocului 2 sunt EMISE în blocul 2, nu în primul
    const [, bloc1, bloc2] = xml.split('<docFd ');
    expect(bloc1).toContain("cod_angajament='AABBD7P9XP6'");
    expect(bloc1).not.toContain("cod_angajament='BBCCE8Q0YQ7'");
    expect(bloc2).toContain("cod_angajament='BBCCE8Q0YQ7'");
    expect(bloc2).toContain("cod_angajament='CCDDF9R1ZR8'");

    const { valid, errors } = await validateXml(xml, 'ordnt_v0');
    if (!valid) throw new Error('XML invalid:\n' + JSON.stringify(errors, null, 2) + '\n' + xml);
    expect(valid).toBe(true);
  });
});
