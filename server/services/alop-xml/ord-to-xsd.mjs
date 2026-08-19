// Mapper PUR: rând DB `formulare_ord` (coloane PLATE, snake_case) -> obiect ORD XSD-shaped,
// adică EXACT forma pe care `serializeOrdnt` (ordnt-serializer.mjs) o consumă
// (`Cif`/`NrOrdonantPl`/`docFd`).
//
// ⚠️ Portul fidel al `colO()` (public/js/formular/core.js) peste un rând DB. Sursa canonică a
// remapping-ului rămâne `colO()` — schimbi cheile acolo, schimbi-le și aici (teste de echivalență
// în server/tests/unit/alop-xml-ord-to-xsd.test.mjs).
//
// #128e — `docFd` este un ARRAY, câte un element per BLOC (`blocuriDinOrd`), fiindcă un ORD poate
// avea mai mulți beneficiari (multi-furnizor / multi-cont). Sursa de adevăr a blocurilor e coloana
// `blocuri`; coloanele plate (`beneficiar`, `iban_beneficiar`, …) sunt doar oglinda blocului 1
// (#128c). Un ORD legacy (`blocuri` NULL) produce EXACT un element, derivat din acele coloane plate,
// cu toate rândurile — deci ieșirea rămâne identică cu cea de dinainte de #128e. Rândurile (`rowTfd`)
// se împart pe blocuri prin `randuriBloc` (rând fără `bloc_idx` ⇒ blocul 0).
//
// Pur: fără DB, fără I/O. Rândurile (`rows`) folosesc DEJA cheile XSD (vin din `data-f`).

import { blocuriDinOrd, randuriBloc } from '../ord-blocuri.mjs';

function arr(v) { return Array.isArray(v) ? v : []; }

/**
 * @param {object} row  rândul `formulare_ord` (fo.*), coloane plate + `blocuri`.
 * @returns {object}    obiect ORD XSD-shaped pentru serializeOrdnt (`docFd` = array de blocuri).
 */
export function ordRowToXsd(row) {
  if (!row || typeof row !== 'object') throw new Error('ordRowToXsd: rând ord necesar');
  const rows = arr(row.rows);
  return {
    Cif: row.cif ?? '',
    DenInstPb: row.den_inst_pb ?? '',
    NrOrdonantPl: row.nr_ordonant_pl ?? '',
    DataOrdontPl: row.data_ordont_pl ?? '',
    docFd: blocuriDinOrd(row).map((b) => ({
      nr_unic_inreg: b.nr_unic_inreg ?? '',
      beneficiar: b.beneficiar ?? '',
      documente_justificative: b.documente_justificative ?? '',
      iban_beneficiar: b.iban_beneficiar ?? '',
      cif_beneficiar: b.cif_beneficiar ?? '',
      banca_beneficiar: b.banca_beneficiar ?? '',
      inf_pv_plata: b.inf_pv_plata ?? '',
      inf_pv_plata1: b.inf_pv_plata1 ?? '',
      rowTfd: randuriBloc(rows, b.bloc_idx),
    })),
  };
}
