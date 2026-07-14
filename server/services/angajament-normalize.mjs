/**
 * DocFlowAI — server/services/angajament-normalize.mjs
 *
 * Coduri de angajament CANONICE cu MAJUSCULE (sursă unică de adevăr).
 *
 * De ce: `server/services/opme-matcher.mjs` potrivește plățile OPME cu angajamentele pe
 * tripletul (cod_angajament, indicator_angajament, cif_beneficiar) prin egalitate STRICTĂ,
 * case-sensitive (opme-matcher.mjs:127, :335). Datele OPME importate sunt cu MAJUSCULE, deci
 * un cod tastat cu minuscule nu se potrivește NICIODATĂ — `'sdgdsgs' = 'SDGDSGS'` e `false` în
 * Postgres. Fără eroare, fără avertisment: o plată care nu se leagă de niciun angajament.
 *
 * ⚠️ LANȚUL REAL: matcher-ul citește codurile din `formulare_ord.rows` (opme-matcher.mjs:127)
 * și `opme_lines`, NICIODATĂ din DF `rows_ctrl`. Codurile ajung în ORD prin prefill DF→ORD
 * (public/js/formular/list.js:180 copiază `doc.rows_ctrl` → `o-tbody`). Deci normalizăm la
 * scriere AMBELE: sursa (DF `rows_ctrl`) ȘI câmpul efectiv potrivit (ORD `rows`). Cele două
 * chei angajament sunt identice în ambele tabele → o singură funcție.
 */

// Ridică un cod de angajament la forma canonică: trim + majuscule.
// null/undefined ⇒ '' (nicio excepție). Idempotent.
export const normAngajamentCode = (v) => String(v ?? '').trim().toUpperCase();

// Cheile normalizate în rows_ctrl (Secțiunea B — coloanele 1 și 2). NIMIC ALTCEVA.
const NORM_KEYS = ['cod_angajament', 'indicator_angajament'];

/**
 * Normalizează un array de rânduri cu coduri de angajament (DF `rows_ctrl` SAU ORD `rows`).
 * Rescrie DOAR `cod_angajament` + `indicator_angajament`, și DOAR pe rândurile care au deja
 * cheia — nu inventează chei pe rânduri care nu le au (ar polua rândurile goale). Toate
 * celelalte câmpuri (`program`, `cod_SSI`, sume, receptii, orice cheie necunoscută) rămân
 * intacte; ORDINEA rândurilor e păstrată. Input non-array ⇒ întors ca atare.
 */
export function normalizeAngajamentRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    let out = row;
    for (const k of NORM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(row, k)) {
        if (out === row) out = { ...row };   // copiază la nevoie, nu muta input-ul
        out[k] = normAngajamentCode(row[k]);
      }
    }
    return out;
  });
}

// Alias istoric pentru calea DF (rows_ctrl). Aceeași logică — cele două chei angajament
// sunt identice în DF `rows_ctrl` și ORD `rows`.
export const normalizeRowsCtrl = normalizeAngajamentRows;
