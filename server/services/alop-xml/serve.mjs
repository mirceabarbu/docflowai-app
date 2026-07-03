// Helper partajat de SERVIRE a XML-ului oficial DF/ORD din endpoint-uri Express.
// Orchestrează: map rând DB -> obiect XSD-shaped -> serialize -> validateXml -> 200/422.
// Validarea blochează (422) orice XML neconform: nu se exportă niciodată XML invalid
// (ex. influențe negative pe revizie, neacceptate de schema v0). Eroare de serializare
// (strClamp overflow, CIF invalid) -> tot 422, cu mesajul erorii.
//
// Separat de validate.mjs (care e PUR, fără Express) fiindcă aici atingem `res`.

import { validateXml } from './validate.mjs';

// Sanitizează o componentă pentru numele de fișier (păstrează doar caractere sigure).
function safeFilePart(v) {
  return String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// Extrage {YYYY,MM,DD} dintr-o dată stocată ca dd.mm.yyyy (românesc) sau yyyy-mm-dd (ISO);
// fallback la data curentă dacă lipsește/invalidă.
function dateParts(raw) {
  const s = String(raw ?? '').trim();
  let y, m, d;
  let mt = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);   // dd.mm.yyyy
  if (mt) { d = mt[1]; m = mt[2]; y = mt[3]; }
  else {
    mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);        // yyyy-mm-dd
    if (mt) { y = mt[1]; m = mt[2]; d = mt[3]; }
  }
  if (!y) { const now = new Date(); y = String(now.getFullYear()); m = String(now.getMonth() + 1); d = String(now.getDate()); }
  return { Y: y, M: String(m).padStart(2, '0'), D: String(d).padStart(2, '0') };
}

/**
 * @param {import('express').Response} res
 * @param {object} opts
 * @param {(row:object)=>object} opts.mapRow     rând DB -> obiect XSD-shaped
 * @param {(obj:object)=>string} opts.serialize  obiect XSD-shaped -> XML
 * @param {'notafd_v0'|'ordnt_v0'} opts.schema   numele schemei XSD
 * @param {object} opts.row        rândul DB
 * @param {string} opts.fileBase   prefix nume MF (ex. 'DocumentFundamentare')
 * @param {string} opts.dateField  coloana DB pentru data din nume
 * @param {string} opts.refField   coloana DB pentru referința din nume (nr unic / nr ord)
 */
export async function serveFormularXml(res, { mapRow, serialize, schema, row, fileBase, dateField, refField }) {
  let xml;
  try {
    xml = serialize(mapRow(row));
  } catch (e) {
    return res.status(422).json({ error: 'xml_invalid', details: [e.message] });
  }

  const { valid, errors } = await validateXml(xml, schema);
  if (!valid) {
    return res.status(422).json({ error: 'xml_invalid', details: errors });
  }

  const { Y, M, D } = dateParts(row[dateField]);
  const ref = safeFilePart(row[refField]) || 'fara_nr';
  const fileName = `${fileBase}_${Y}_${M}_${D}_${ref}.xml`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(xml);
}
