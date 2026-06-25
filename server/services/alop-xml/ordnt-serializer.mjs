// Serializer PUR: obiect ORD (XSD-shaped) -> XML oficial ORDNT (Ordonanțare de plată).
//
// Obiectul de intrare ESTE `data` JSONB-ul ORD-ului — același obiect pe care generatorul
// PDF (server/routes/formulare.mjs) îl consumă: `ord.Cif`, `ord.DenInstPb`, `ord.NrOrdonantPl`,
// `ord.DataOrdontPl` + `ord.docFd` (obiect sau array). Numele atributelor sunt 1:1 cu
// `schemas/ordnt_v0.xsd`. Serializer-ul DOAR parcurge obiectul și emite XML — nicio regulă
// de business, nicio validare de domeniu.
//
// elementFormDefault="qualified"  -> elementele moștenesc namespace-ul default de pe root.
// attributeFormDefault="unqualified" -> atributele NU au prefix.

import { ronToBani, dateRo, cif, xmlEscape, strClamp } from './format.mjs';

const NS = 'mfp:anaf:dgti:ordnt:declaratie:v1';

// ── Emitere atribute ────────────────────────────────────────────────────────
// String required / mereu emis (escape + verificare lungime). Empty permis ("").
function aStr(name, val, max) {
  return ` ${name}="${xmlEscape(strClamp(val ?? '', max, name))}"`;
}
// Sumă opțională (IntPoz12, bani): OMISĂ când lipsește; "0" emis dacă a fost completată.
function aSum(name, val) {
  const bani = ronToBani(val);
  return bani === null ? '' : ` ${name}="${bani}"`;
}

// IBAN (Str24): scoate spațiile (ghidul îl arată grupat) înainte de verificarea lungimii.
function normIban(val, fieldName) {
  const s = String(val ?? '').trim().replace(/[\s ]/g, '');
  return strClamp(s, 24, fieldName);
}

function rowTfd(r) {
  return '    <rowTfd'
    + aStr('cod_angajament', r.cod_angajament, 11)
    + aStr('indicator_angajament', r.indicator_angajament, 3)
    + aStr('program', r.program, 10)
    + aStr('cod_SSI', r.cod_SSI, 15)
    + aSum('receptii', r.receptii)
    + aSum('plati_anterioare', r.plati_anterioare)
    + aSum('suma_ordonantata_plata', r.suma_ordonantata_plata)
    + aSum('receptii_neplatite', r.receptii_neplatite)
    + '/>';
}

function docFdBlock(df) {
  const rows = Array.isArray(df.rowTfd) ? df.rowTfd : [];
  const out = [];
  out.push('  <docFd'
    + aStr('nr_unic_inreg', df.nr_unic_inreg, 20)
    + aStr('beneficiar', df.beneficiar, 150)
    // documente_justificative / banca_beneficiar / inf_pv_plata / inf_pv_plata1 sunt
    // required în XSD, dar ghidul le marchează "doar dacă e cazul" -> emise mereu, "" când lipsesc.
    + aStr('documente_justificative', df.documente_justificative, 90)
    + ` iban_beneficiar="${xmlEscape(normIban(df.iban_beneficiar, 'iban_beneficiar'))}"`
    + aStr('cif_beneficiar', cif(df.cif_beneficiar), 10)
    + aStr('banca_beneficiar', df.banca_beneficiar, 100)
    + aStr('inf_pv_plata', df.inf_pv_plata, 70)
    + aStr('inf_pv_plata1', df.inf_pv_plata1, 70)
    + '>');
  for (const r of rows) out.push(rowTfd(r));
  out.push('  </docFd>');
  return out;
}

/**
 * Serializează un obiect ORD XSD-shaped la XML ORDNT valid contra ordnt_v0.xsd.
 * @param {object} ord  obiectul `data` al ORD-ului (root + docFd obiect sau array)
 * @returns {string}    XML cu declarație + namespace default
 */
export function serializeOrdnt(ord) {
  if (!ord || typeof ord !== 'object') throw new Error('serializeOrdnt: obiect ord necesar');

  // docFd: XSD permite mai multe (ORD multi-DF). Azi DocFlowAI are unul (obiect) -> normalizăm
  // la array, forward-compat fără rework la multi-DF.
  const docs = Array.isArray(ord.docFd) ? ord.docFd : [ord.docFd || {}];

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<ORDNT xmlns="' + NS + '"'
    + aStr('Cif', cif(ord.Cif), 10)
    + aStr('DenInstPb', ord.DenInstPb, 150)
    + aStr('NrOrdonantPl', ord.NrOrdonantPl, 20)
    + aStr('DataOrdontPl', dateRo(ord.DataOrdontPl) ?? '', 20)
    + '>');

  for (const df of docs) out.push(...docFdBlock(df));

  out.push('</ORDNT>');
  return out.join('\n');
}
