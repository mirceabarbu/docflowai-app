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
  it('produce EXACT forma XSD-shaped (docFd nestat din coloane plate)', () => {
    expect(ordRowToXsd(dbRow)).toEqual({
      Cif: '4267117',
      DenInstPb: 'Unitatea Administrativ-Teritorială Exemplu',
      NrOrdonantPl: '121',
      DataOrdontPl: '05.02.2026',
      docFd: {
        nr_unic_inreg: '111', beneficiar: 'Telekom România', documente_justificative: 'Factura',
        iban_beneficiar: 'RO51 RNCB 0080 0029 7151 0001', cif_beneficiar: '427320',
        banca_beneficiar: 'BCR', inf_pv_plata: 'Contravaloare factură aferentă lunii ianuarie', inf_pv_plata1: '',
        rowTfd: dbRow.rows,
      },
    });
  });

  it('coloane lipsă -> stringuri goale / rowTfd gol', () => {
    const xsd = ordRowToXsd({ cif: '4267117' });
    expect(xsd.NrOrdonantPl).toBe('');
    expect(xsd.docFd.rowTfd).toEqual([]);
  });

  it('lanț complet: rând DB -> serializeOrdnt -> validateXml === valid', async () => {
    const xml = serializeOrdnt(ordRowToXsd(dbRow));
    const { valid, errors } = await validateXml(xml, 'ordnt_v0');
    if (!valid) throw new Error('XML invalid:\n' + JSON.stringify(errors, null, 2) + '\n' + xml);
    expect(valid).toBe(true);
    // IBAN normalizat de serializer (fără spații).
    expect(xml).toContain('iban_beneficiar="RO51RNCB0080002971510001"');
  });

  it('aruncă pe input non-obiect', () => {
    expect(() => ordRowToXsd(null)).toThrow();
  });
});
