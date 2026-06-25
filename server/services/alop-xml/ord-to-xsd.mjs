// Mapper PUR: rând DB `formulare_ord` (coloane PLATE, snake_case) -> obiect ORD XSD-shaped,
// adică EXACT forma pe care `serializeOrdnt` (ordnt-serializer.mjs) o consumă
// (`Cif`/`NrOrdonantPl`/`docFd`).
//
// ⚠️ Portul fidel al `colO()` (public/js/formular/core.js) peste un rând DB. Câmpurile blocului
// `docFd` (`nr_unic_inreg`, `beneficiar`, IBAN, …) sunt coloane PLATE top-level în DB; `colO()`
// le nestează sub `docFd`, iar rândurile (`rowTfd`) trăiesc în coloana plată `rows`. Sursa
// canonică a remapping-ului rămâne `colO()` — schimbi cheile acolo, schimbi-le și aici
// (teste de echivalență în server/tests/unit/alop-xml-ord-to-xsd.test.mjs).
//
// Pur: fără DB, fără I/O. Rândurile (`rows`) folosesc DEJA cheile XSD (vin din `data-f`).

function arr(v) { return Array.isArray(v) ? v : []; }

/**
 * @param {object} row  rândul `formulare_ord` (fo.*), coloane plate.
 * @returns {object}    obiect ORD XSD-shaped pentru serializeOrdnt.
 */
export function ordRowToXsd(row) {
  if (!row || typeof row !== 'object') throw new Error('ordRowToXsd: rând ord necesar');
  return {
    Cif: row.cif ?? '',
    DenInstPb: row.den_inst_pb ?? '',
    NrOrdonantPl: row.nr_ordonant_pl ?? '',
    DataOrdontPl: row.data_ordont_pl ?? '',
    docFd: {
      nr_unic_inreg: row.nr_unic_inreg ?? '',
      beneficiar: row.beneficiar ?? '',
      documente_justificative: row.documente_justificative ?? '',
      iban_beneficiar: row.iban_beneficiar ?? '',
      cif_beneficiar: row.cif_beneficiar ?? '',
      banca_beneficiar: row.banca_beneficiar ?? '',
      inf_pv_plata: row.inf_pv_plata ?? '',
      inf_pv_plata1: row.inf_pv_plata1 ?? '',
      rowTfd: arr(row.rows),
    },
  };
}
