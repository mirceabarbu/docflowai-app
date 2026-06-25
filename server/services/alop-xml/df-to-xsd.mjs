// Mapper PUR: rând DB `formulare_df` (coloane PLATE, snake_case) -> obiect DF XSD-shaped,
// adică EXACT forma pe care `serializeNotafd` (notafd-serializer.mjs) o consumă
// (`Cif`/`sectiuneaA`/`sectiuneaB`).
//
// ⚠️ De ce există: forma XSD-shaped (`Cif`, `sectiuneaA.ang_legale_val.rowT_ang_pl_val`, …)
// e construită azi DOAR în frontend (`public/js/formular/core.js` → `colN()`), din DOM.
// Backend-ul stochează coloane plate (`cif`, `den_inst_pb`, `rows_val`, …). Acest mapper e
// PORTUL FIDEL al `colN()` peste un rând DB, ca să putem serializa XML din endpoint fără să
// depindem de un payload client. Sursa canonică a remapping-ului rămâne `colN()` —
// schimbi cheile XSD acolo, schimbi-le și aici (teste de echivalență în
// server/tests/unit/alop-xml-df-to-xsd.test.mjs).
//
// Pur: fără DB, fără I/O. Rândurile (`rows_val`/`rows_plati`/`rows_ctrl`) folosesc DEJA cheile
// XSD (vin din `data-f`), deci se trec direct. Conversiile de format (lei->bani, bifă, dată)
// rămân responsabilitatea serializer-ului/`format.mjs` — mapper-ul DOAR re-așază câmpurile.

function arr(v) { return Array.isArray(v) ? v : []; }

/**
 * @param {object} row  rândul `formulare_df` (fd.*), coloane plate.
 * @returns {object}    obiect DF XSD-shaped pentru serializeNotafd.
 */
export function dfRowToXsd(row) {
  if (!row || typeof row !== 'object') throw new Error('dfRowToXsd: rând df necesar');
  return {
    Cif: row.cif ?? '',
    DenInstPb: row.den_inst_pb ?? '',
    SubtitluDF: row.subtitlu_df ?? '',
    NrUnicInreg: row.nr_unic_inreg ?? '',
    Revizuirea: row.revizuirea ?? '',
    DataRevizuirii: row.data_revizuirii ?? '',
    sectiuneaA: {
      compartiment_specialitate: row.compartiment_specialitate ?? '',
      obiect_fd_reviz_scurt: row.obiect_fd_reviz_scurt ?? '',
      obiect_fd_reviz_lung: row.obiect_fd_reviz_lung ?? '',
      ang_legale_val: {
        ckbx_stab_tin_cont: row.ckbx_stab_tin_cont ?? '',
        ckbx_ramane_suma: row.ckbx_ramane_suma ?? '',
        ramane_suma: row.ramane_suma ?? '',
        rowT_ang_pl_val: arr(row.rows_val),
      },
      ang_legale_plati: {
        ckbx_fara_ang_emis_ancrt: row.ckbx_fara_ang_emis_ancrt ?? '',
        ckbx_cu_ang_emis_ancrt: row.ckbx_cu_ang_emis_ancrt ?? '',
        ckbx_sting_ang_in_ancrt: row.ckbx_sting_ang_in_ancrt ?? '',
        ckbx_fara_plati_ang_in_ancrt: row.ckbx_fara_plati_ang_in_ancrt ?? '',
        ckbx_cu_plati_ang_in_mmani: row.ckbx_cu_plati_ang_in_mmani ?? '',
        ckbx_ang_leg_emise_ct_an_urm: row.ckbx_ang_leg_emise_ct_an_urm ?? '',
        rowT_ang_pl_plati: arr(row.rows_plati),
      },
    },
    sectiuneaB: {
      ckbx_secta_inreg_ctrl_ang: row.ckbx_secta_inreg_ctrl_ang ?? '',
      ckbx_fara_inreg_ctrl_ang: row.ckbx_fara_inreg_ctrl_ang ?? '',
      // Pereche 1 (credite bugetare) — singura cu corespondent în schema oficială.
      // `sum_fara_inreg_ctrl_crd_bug` (pereche 2) e câmp intern PDF/afișaj — fără echivalent XSD,
      // NU se mapează (vezi comentariul din notafd-serializer.mjs).
      sum_fara_inreg_ctrl_crdbug: row.sum_fara_inreg_ctrl_crdbug ?? '',
      ckbx_interzis_emit_ang: row.ckbx_interzis_emit_ang ?? '',
      ckbx_interzis_intrucat: row.ckbx_interzis_intrucat ?? '',
      intrucat: row.intrucat ?? '',
      rowT_ang_ctrl_ang: arr(row.rows_ctrl),
    },
  };
}
