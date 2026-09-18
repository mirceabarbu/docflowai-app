// server/tests/helpers/flow-doc-name-fixtures.mjs — #222
//
// Fixture-uri PARTAJATE între testul unit (parseGeneratedDocName, JS) și testul DB de
// paritate (generatedDocNameSql, SQL). Ambele forme trebuie să dea ACELAȘI verdict pe
// exact aceste nume — de aceea trăiesc într-un singur loc.

export const FIXTURES_POZITIVE = [
  ['OrdonantarePlata_45301_20260821',        { formType: 'ord', nr: '45301' }],
  ['OrdonantarePlata_45301_20260821.pdf',    { formType: 'ord', nr: '45301' }],
  ['DocumentFundamentare_6744_20260707',     { formType: 'df',  nr: '6744' }],
  ['DocumentFundamentare_6744_20260707.pdf', { formType: 'df',  nr: '6744' }],
  ['OrdonantarePlata_AB_12_20260821',        { formType: 'ord', nr: 'AB_12' }],   // grup lacom
];

export const FIXTURES_NEGATIVE = [
  'raport.pdf',
  'contract-servicii.pdf',
  'OrdonantarePlata_45301',            // fără dată
  'OrdonantarePlata_45301_2026082',    // 7 cifre
  'OrdonantarePlata__20260821',        // nr gol
  'ordonantareplata_45301_20260821',   // case-sensitive (tiparul e generat exact așa)
  'Ordonantare_45301_20260821',        // prefix greșit
];
