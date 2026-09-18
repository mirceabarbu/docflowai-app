/**
 * DocFlowAI — flow-doc-name.mjs  (#222)
 * ---------------------------------------------------------------------------
 * CE DOCUMENT GENERAT DE PLATFORMĂ E ÎN SPATELE UNUI `docName`.
 *
 * Tiparul e produs de `routes/formulare.mjs:1048`:
 *     OrdonantarePlata_<NrOrdonantPl>_<YYYYMMDD>.pdf
 *     DocumentFundamentare_<NrUnicInreg>_<YYYYMMDD>.pdf
 * Numărul e igienizat acolo cu /[^A-Za-z0-9_-]/g -> '_', deci poate conține '_';
 * de aceea grupul e LACOM și data (exact 8 cifre) se ancorează la final.
 *
 * ⛔ ZERO acces la baza de date, zero I/O — funcție pură. Interogările stau în rute.
 * ⛔ Fără backtick-uri în șirul SQL returnat: se interpolează în template literal-e
 *    la consumator (poarta tests/unit/sql-fragmente-fara-backtick.test.mjs).
 * ⚠️ Cele două forme (JS + SQL) trebuie să dea ACELAȘI verdict. Există un test DB
 *    care le confruntă pe aceleași fixture-uri — nu modifica una fără cealaltă.
 */

export const GENERATED_DOC_NAME_RE =
  /^(OrdonantarePlata|DocumentFundamentare)_(.+)_(\d{8})(\.pdf)?$/;

/**
 * @param {unknown} docName
 * @returns {{ formType: 'ord'|'df', nr: string }|null}
 */
export function parseGeneratedDocName(docName) {
  if (typeof docName !== 'string') return null;
  const m = GENERATED_DOC_NAME_RE.exec(docName.trim());
  if (!m) return null;
  const nr = String(m[2]).trim();
  if (!nr) return null;
  return { formType: m[1] === 'OrdonantarePlata' ? 'ord' : 'df', nr };
}

/** Fragment SQL: `docName`-ul fluxului e pe tiparul documentelor generate. */
export function generatedDocNameSql(alias = 'f') {
  return '(' + alias + ".data->>'docName') ~ " +
         "'^(OrdonantarePlata|DocumentFundamentare)_.+_[0-9]{8}(\\.pdf)?$'";
}
