// Validare XSD reală a serializer-ului ORD ORDNT contra `ordnt_v0.xsd`, pe exemplul din
// ghidul MF (Cap.IV). Validator: xmllint-wasm (pur WASM, fără dependență de sistem — merge în CI).
//
// Obiectul ORD de mai jos este XSD-shaped (root + docFd), identic cu `data` JSONB-ul pe care
// îl consumă generatorul PDF. Sumele sunt în LEI (decimal) — exact formatul stocat real;
// serializer-ul le emite ca lei ÎNTREGI (rotunjire în sus) pentru IntPoz12SType, care e
// xs:integer în schema oficială MF. ORD n-are influențe negative, deci toate exemplele
// validează (fără it.todo).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import { serializeOrdnt } from '../../services/alop-xml/ordnt-serializer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XSD_PATH = resolve(__dirname, '../../services/alop-xml/schemas/ordnt_v0.xsd');

let xsd;
beforeAll(async () => { xsd = await readFile(XSD_PATH, 'utf8'); });

async function expectValid(ord) {
  const xml = serializeOrdnt(ord);
  const res = await validateXML({ xml, schema: xsd });
  if (!res.valid) {
    throw new Error('XML invalid contra XSD:\n' + JSON.stringify(res.errors, null, 2) + '\n\n' + xml);
  }
  expect(res.valid).toBe(true);
  // Format cerut de parserul XFA al formularului MF (vezi serializer): niciun element
  // auto-închis — `__Load_rowTfd` delimitează rândul până la `</rowTfd>`, iar un rând
  // auto-închis lasă tabelul gol la import. Verificat pe FIECARE exemplu.
  expect(xml).not.toMatch(/\/>/);
  return xml;
}

// Bloc docFd din ghid Cap.IV (refolosit în testele de mai jos).
function docFdGhid(overrides = {}) {
  return {
    nr_unic_inreg: '111',
    beneficiar: 'Telekom România',
    documente_justificative: 'Factura',
    iban_beneficiar: 'RO51 RNCB 0080 0029 7151 0001',
    cif_beneficiar: '427320',
    banca_beneficiar: 'BCR',
    inf_pv_plata: 'Contravaloare factură aferentă lunii ianuarie',
    inf_pv_plata1: '',
    rowTfd: [
      { cod_angajament: 'AABBD7P9XP6', indicator_angajament: 'AAB', program: '0000000541',
        cod_SSI: '01A510103200108', receptii: 50, plati_anterioare: 0,
        suma_ordonantata_plata: 50, receptii_neplatite: 0 },
    ],
    ...overrides,
  };
}

function ordGhid(docFd) {
  return {
    Cif: '4267117',
    DenInstPb: 'Unitatea Administrativ-Teritorială Exemplu',
    NrOrdonantPl: '121',
    DataOrdontPl: '05.02.2026',
    docFd: docFd ?? docFdGhid(),
  };
}

describe('serializeOrdnt — exemplu MF (Cap.IV) validat contra ordnt_v0.xsd', () => {
  it('Cap.IV — Telekom România, IBAN normalizat, lei întregi (50 -> 50)', async () => {
    const xml = await expectValid(ordGhid());
    expect(xml).toContain("NrOrdonantPl='121'");
    expect(xml).toContain("DataOrdontPl='05.02.2026'");
    // IBAN fără spații, ≤24 caractere.
    expect(xml).toContain("iban_beneficiar='RO51RNCB0080002971510001'");
    expect(xml).not.toContain('RO51 RNCB');
    // receptii 50 lei -> "50" (fără zecimale).
    expect(xml).toContain("receptii='50'");
    expect(xml).toContain("suma_ordonantata_plata='50'");
    expect(xml).toContain("receptii_neplatite='0'");
    expect(xml).toContain("cif_beneficiar='427320'");
    // Rândul are tag de închidere -> `__Load_rowTfd` îl citește (altfel tabelul rămâne gol).
    expect(xml).toContain('</rowTfd>');
    expect(xml).toContain('</docFd>');
  });

  it('sume cu bani -> lei întregi rotunjiți în SUS (2964,50 -> 2965)', async () => {
    const ord = ordGhid(docFdGhid({
      rowTfd: [
        { cod_angajament: 'AABBD7P9XP6', indicator_angajament: 'AAB', program: '0000000541',
          cod_SSI: '01A510103200108', receptii: 2964.5, plati_anterioare: 0,
          suma_ordonantata_plata: 2964.5, receptii_neplatite: 0 },
      ],
    }));
    const xml = await expectValid(ord);
    expect(xml).toContain("receptii='2965'");
    expect(xml).toContain("suma_ordonantata_plata='2965'");
  });

  it('docFd ca array de 2 -> două blocuri <docFd> (forward-compat multi-DF)', async () => {
    const ord = ordGhid([
      docFdGhid(),
      docFdGhid({ nr_unic_inreg: '222', beneficiar: 'Furnizor Secund SRL' }),
    ]);
    const xml = await expectValid(ord);
    const count = (xml.match(/<docFd /g) || []).length;
    expect(count).toBe(2);
    expect(xml).toContain("nr_unic_inreg='111'");
    expect(xml).toContain("nr_unic_inreg='222'");
    expect(xml).toContain("beneficiar='Furnizor Secund SRL'");
  });

  it('câmpuri opționale goale (documente_justificative="") -> atribut prezent, gol, valid XSD', async () => {
    const ord = ordGhid(docFdGhid({ documente_justificative: '', banca_beneficiar: '', inf_pv_plata: '' }));
    const xml = await expectValid(ord);
    expect(xml).toContain("documente_justificative=''");
    expect(xml).toContain("banca_beneficiar=''");
    expect(xml).toContain("inf_pv_plata=''");
  });
});
