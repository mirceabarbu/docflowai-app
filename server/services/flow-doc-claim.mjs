/**
 * DocFlowAI — flow-doc-claim.mjs  (#171)
 * -------------------------------------------------------------------------
 * CE DOCUMENTE REVENDICĂ UN FLUX — sursă unică pentru lista de tipuri (DF/ORD)
 * și pentru citirea lor din `data.meta`.
 *
 * De ce există: poarta de lansare (#170, routes/flows/crud.mjs) și garda de
 * reinițiere (#114/#171, routes/flows/lifecycle.mjs) răspund la ACEEAȘI
 * întrebare — „ce document revendică fluxul ăsta?" — dar o scriau separat.
 * Garda de reinițiere o scria pe POINTER (`formulare_X.flow_id`), iar poarta
 * pe `meta` ⇒ un flux ORFAN (are `meta.dfId`, n-a luat pointerul) trecea de
 * gardă și primea un copil, ocolind poarta. Două definiții ale aceleiași
 * noțiuni = drift garantat; aici e una singură.
 *
 * ⛔ ZERO acces la baza de date, zero I/O — funcție pură pe obiectul `data`
 *    al fluxului. Interogările rămân în rute.
 * ⛔ Numele de tabele NU se exportă de aici: rutele le scriu literal, ca să
 *    nu apară tentația de a le interpola în SQL.
 */

export const DOC_KINDS = Object.freeze([
  Object.freeze({ metaKey: 'dfId',  formType: 'df',  eticheta: 'Documentul de Fundamentare' }),
  Object.freeze({ metaKey: 'ordId', formType: 'ord', eticheta: 'Ordonanțarea de plată' }),
]);

/**
 * @param {object|null|undefined} data — blobul JSONB al fluxului
 * @returns {Array<{metaKey:string, formType:string, eticheta:string, docId:string}>}
 *          lista documentelor revendicate; [] dacă fluxul nu revendică niciunul.
 * Tratează ca „nerevendicat": lipsa lui `meta`, `null`, `undefined`, șirul gol
 * și șirul format doar din spații.
 */
export function documenteRevendicate(data) {
  const meta = (data && typeof data === 'object' && data.meta && typeof data.meta === 'object')
    ? data.meta : {};
  const out = [];
  for (const kind of DOC_KINDS) {
    const raw = meta[kind.metaKey];
    if (raw === null || raw === undefined) continue;
    const docId = String(raw).trim();
    if (!docId) continue;
    out.push({ ...kind, docId });
  }
  return out;
}

/** true dacă fluxul revendică vreun formular (DF sau ORD). */
export function revendicaFormular(data) {
  return documenteRevendicate(data).length > 0;
}
