// Serializer PUR: obiect DF (XSD-shaped) -> XML oficial NOTAFD (Notă de Fundamentare).
//
// Obiectul de intrare ESTE `data` JSONB-ul DF-ului — același obiect pe care generatorul
// PDF (server/routes/formulare.mjs) îl consumă: `df.Cif`, `df.DenInstPb`, `df.SubtitluDF`,
// `df.NrUnicInreg`, `df.Revizuirea`, `df.DataRevizuirii`, `df.sectiuneaA`, `df.sectiuneaB`.
// Numele atributelor sunt 1:1 cu `schemas/notafd_v0.xsd`. Serializer-ul DOAR parcurge
// obiectul și emite XML — nicio regulă de business, nicio validare de domeniu.
//
// elementFormDefault="qualified"  -> elementele moștenesc namespace-ul default de pe root.
// attributeFormDefault="unqualified" -> atributele NU au prefix.

import { ronToBani, dateRo, ckbx, cif, xmlEscape, strClamp } from './format.mjs';

const NS = 'mfp:anaf:dgti:notafd:declaratie:v1';

// ── Emitere atribute ────────────────────────────────────────────────────────
// String required / mereu emis (escape + verificare lungime). Empty permis ("").
function aStr(name, val, max) {
  return ` ${name}="${xmlEscape(strClamp(val ?? '', max, name))}"`;
}
// Bifă (Str1): mereu emisă ca "1" / "" — semantica "nebifat = ''" din XSD.
function aCkbx(name, val) {
  return ` ${name}="${ckbx(val)}"`;
}
// String opțional: OMIS când lipsește/empty.
function aStrOpt(name, val, max) {
  if (val === null || val === undefined || String(val).trim() === '') return '';
  return ` ${name}="${xmlEscape(strClamp(String(val), max, name))}"`;
}
// Sumă opțională (IntPoz12, bani): OMISĂ când lipsește; "0" emis dacă a fost completată.
function aSum(name, val) {
  const bani = ronToBani(val);
  return bani === null ? '' : ` ${name}="${bani}"`;
}

function rowAngPlVal(r) {
  return '      <rowT_ang_pl_val'
    + aStr('element_fd', r.element_fd, 150)
    + aStr('program', r.program, 10)
    + aStr('codSSI', r.codSSI, 15)
    + aStr('param_fd', r.param_fd, 500)
    + aSum('valt_rev_prec', r.valt_rev_prec)
    + aSum('influente', r.influente)
    + aSum('valt_actualiz', r.valt_actualiz)
    + '/>';
}

function rowAngPlPlati(r) {
  return '      <rowT_ang_pl_plati'
    + aSum('plati_ani_precedenti', r.plati_ani_precedenti)
    + aSum('plati_estim_ancrt', r.plati_estim_ancrt)
    + aSum('plati_estim_an_np1', r.plati_estim_an_np1)
    + aSum('plati_estim_an_np2', r.plati_estim_an_np2)
    + aSum('plati_estim_an_np3', r.plati_estim_an_np3)
    + aSum('plati_estim_ani_ulter', r.plati_estim_ani_ulter)
    + aStr('program', r.program, 10)
    + aStr('codSSI', r.codSSI, 15)
    + '/>';
}

function rowAngCtrl(r) {
  return '    <rowT_ang_ctrl_ang'
    + aStr('cod_angajament', r.cod_angajament, 11)
    + aStr('indicator_angajament', r.indicator_angajament, 3)
    + aStr('program', r.program, 10)
    + aStr('cod_SSI', r.cod_SSI, 15)
    + aSum('sum_rezv_crdt_ang_af_rvz_prc', r.sum_rezv_crdt_ang_af_rvz_prc)
    + aSum('influente_c6', r.influente_c6)
    + aSum('sum_rezv_crdt_ang_act', r.sum_rezv_crdt_ang_act)
    + aSum('sum_rezv_crdt_bug_af_rvz_prc', r.sum_rezv_crdt_bug_af_rvz_prc)
    + aSum('influente_c9', r.influente_c9)
    + aSum('sum_rezv_crdt_bug_act', r.sum_rezv_crdt_bug_act)
    + '/>';
}

/**
 * Serializează un obiect DF XSD-shaped la XML NOTAFD valid contra notafd_v0.xsd.
 * @param {object} df  obiectul `data` al DF-ului (root + sectiuneaA + sectiuneaB)
 * @returns {string}   XML cu declarație + namespace default
 */
export function serializeNotafd(df) {
  if (!df || typeof df !== 'object') throw new Error('serializeNotafd: obiect df necesar');

  const sA = df.sectiuneaA || {};
  const angV = sA.ang_legale_val || {};
  const angP = sA.ang_legale_plati || {};
  const sB = df.sectiuneaB || {};

  const rowsVal = Array.isArray(angV.rowT_ang_pl_val) ? angV.rowT_ang_pl_val : [];
  const rowsPlati = Array.isArray(angP.rowT_ang_pl_plati) ? angP.rowT_ang_pl_plati : [];
  const rowsCtrl = Array.isArray(sB.rowT_ang_ctrl_ang) ? sB.rowT_ang_ctrl_ang : [];

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<NOTAFD xmlns="' + NS + '"'
    + aStr('Cif', cif(df.Cif), 10)
    + aStr('DenInstPb', df.DenInstPb, 150)
    + aStr('SubtitluDF', df.SubtitluDF, 150)
    + aStr('NrUnicInreg', df.NrUnicInreg, 20)
    + aStr('Revizuirea', df.Revizuirea, 3)
    + aStr('DataRevizuirii', dateRo(df.DataRevizuirii) ?? '', 10)
    + '>');

  // ── Secțiunea A ────────────────────────────────────────────────────────────
  out.push('  <sectiuneaA'
    + aStr('compartiment_specialitate', sA.compartiment_specialitate, 150)
    + aStr('obiect_fd_reviz_scurt', sA.obiect_fd_reviz_scurt, 250)
    + aStr('obiect_fd_reviz_lung', sA.obiect_fd_reviz_lung, 500)
    + '>');

  out.push('    <ang_legale_val'
    + aCkbx('ckbx_stab_tin_cont', angV.ckbx_stab_tin_cont)
    + aCkbx('ckbx_ramane_suma', angV.ckbx_ramane_suma)
    + aSum('ramane_suma', angV.ramane_suma)
    + '>');
  for (const r of rowsVal) out.push(rowAngPlVal(r));
  out.push('    </ang_legale_val>');

  // ang_legale_plati: element required; rândurile sunt minOccurs=0.
  const platiAttrs = aCkbx('ckbx_fara_ang_emis_ancrt', angP.ckbx_fara_ang_emis_ancrt)
    + aCkbx('ckbx_cu_ang_emis_ancrt', angP.ckbx_cu_ang_emis_ancrt)
    + aCkbx('ckbx_sting_ang_in_ancrt', angP.ckbx_sting_ang_in_ancrt)
    + aCkbx('ckbx_fara_plati_ang_in_ancrt', angP.ckbx_fara_plati_ang_in_ancrt)
    + aCkbx('ckbx_cu_plati_ang_in_mmani', angP.ckbx_cu_plati_ang_in_mmani)
    + aCkbx('ckbx_ang_leg_emise_ct_an_urm', angP.ckbx_ang_leg_emise_ct_an_urm);
  if (rowsPlati.length) {
    out.push('    <ang_legale_plati' + platiAttrs + '>');
    for (const r of rowsPlati) out.push(rowAngPlPlati(r));
    out.push('    </ang_legale_plati>');
  } else {
    out.push('    <ang_legale_plati' + platiAttrs + '/>');
  }
  out.push('  </sectiuneaA>');

  // ── Secțiunea B ────────────────────────────────────────────────────────────
  // Emite DOAR sum_fara_inreg_ctrl_crdbug (pereche 1). sum_fara_inreg_ctrl_crd_bug
  // (pereche 2) e câmp INTERN afișaj/PDF — fără corespondent în schema oficială.
  const bAttrs = aCkbx('ckbx_secta_inreg_ctrl_ang', sB.ckbx_secta_inreg_ctrl_ang)
    + aCkbx('ckbx_fara_inreg_ctrl_ang', sB.ckbx_fara_inreg_ctrl_ang)
    + aSum('sum_fara_inreg_ctrl_crdbug', sB.sum_fara_inreg_ctrl_crdbug)
    + aCkbx('ckbx_interzis_emit_ang', sB.ckbx_interzis_emit_ang)
    + aCkbx('ckbx_interzis_intrucat', sB.ckbx_interzis_intrucat)
    + aStrOpt('intrucat', sB.intrucat, 500);
  if (rowsCtrl.length) {
    out.push('  <sectiuneaB' + bAttrs + '>');
    for (const r of rowsCtrl) out.push(rowAngCtrl(r));
    out.push('  </sectiuneaB>');
  } else {
    out.push('  <sectiuneaB' + bAttrs + '/>');
  }

  out.push('</NOTAFD>');
  return out.join('\n');
}
