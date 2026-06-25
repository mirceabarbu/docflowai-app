// Validator XSD partajat pentru XML-ul oficial NOTAFD/ORDNT. Rulează la RUNTIME în
// endpoint-ul de export (nu doar în teste) — de aceea `xmllint-wasm` e în `dependencies`.
//
// Pur (fără Express). XSD-urile (`schemas/notafd_v0.xsd` / `schemas/ordnt_v0.xsd`) sunt
// NO-TOUCH (Etapele 1–2); aici DOAR le citim și validăm contra lor. Conținutul XSD se
// cache-uiește în memorie (citire o singură dată per schemă).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMAS = {
  notafd_v0: 'notafd_v0.xsd',
  ordnt_v0: 'ordnt_v0.xsd',
};

const _xsdCache = new Map(); // schemaName -> conținut XSD (string)

async function loadXsd(schemaName) {
  const file = SCHEMAS[schemaName];
  if (!file) throw new Error(`validateXml: schemă necunoscută '${schemaName}'`);
  if (_xsdCache.has(schemaName)) return _xsdCache.get(schemaName);
  const xsd = await readFile(resolve(__dirname, 'schemas', file), 'utf8');
  _xsdCache.set(schemaName, xsd);
  return xsd;
}

/**
 * @param {string} xmlString  XML-ul de validat.
 * @param {'notafd_v0'|'ordnt_v0'} schemaName  numele schemei (fără cale/extensie).
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
export async function validateXml(xmlString, schemaName) {
  const xsd = await loadXsd(schemaName);
  const res = await validateXML({ xml: xmlString, schema: xsd });
  const errors = (res.errors || []).map((e) =>
    typeof e === 'string' ? e : (e.message || JSON.stringify(e))
  );
  return { valid: !!res.valid, errors };
}
