/**
 * plata-ordin.mjs — helpere PURE pentru confirmarea manuală a plății (#209, Etapa C).
 *
 * `plata_nr_ordin` e TEXT și ține deja LISTE de ordine de plată — matcher-ul OPME scrie
 * „2745, 2746, 2747, …" (opme-matcher.mjs, `nrOps.join(', ')`). Formatul e suportat de
 * schemă și de afișare; doar interfața de confirmare manuală nu-l oferea.
 *
 * Fără I/O, fără DB. Acoperit de `server/tests/unit/plata-ordin.test.mjs`.
 */

// Un token = un ordin de plată: alfanumeric, cu `-`, `_`, `.`, `/` permise în interior.
// Formatul istoric din producție („OP-2026-042" — placeholder-ul UI de dinainte de #209) și
// fixture-urile testelor preexistente („OP-1", „OP-X", „OP-A") rămân ACCEPTATE — o regulă
// „doar cifre" ar fi rupt 4 fișiere de test și obiceiul utilizatorilor. Separatorul de listă
// e EXCLUSIV virgula; `;`, `|`, spațiile în interiorul unui token și orice alt semn sunt refuzate.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

/**
 * Normalizează și validează o listă de numere de OP separate prin virgulă.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: string, tokens: string[] } | { ok: false, error: string, message: string }}
 */
export function parseNrOrdinList(raw) {
  const s = String(raw ?? '').trim();
  if (!s) {
    return { ok: false, error: 'nr_ordin_lipsa', message: 'Completați numărul ordinului de plată.' };
  }
  if (/[;|]/.test(s)) {
    return {
      ok: false, error: 'nr_ordin_invalid',
      message: 'Numerele ordinelor de plată se separă prin virgulă (ex: 2791, 2792).',
    };
  }
  const tokens = s.split(',').map(t => t.trim()).filter(Boolean);
  if (!tokens.length) {
    return { ok: false, error: 'nr_ordin_lipsa', message: 'Completați numărul ordinului de plată.' };
  }
  for (const t of tokens) {
    if (!TOKEN_RE.test(t)) {
      return {
        ok: false, error: 'nr_ordin_invalid',
        message: `Ordinul de plată „${t}" nu e valid: folosiți numere (ex: 2791), separate prin virgulă.`,
      };
    }
  }
  return { ok: true, value: tokens.join(', '), tokens };
}

/**
 * Diferența dintre suma introdusă și valoarea totală a ORD-ului. INFORMATIV — nu blochează:
 * plățile parțiale (tranșe, conturi diferite) sunt legitime (#209).
 *
 * @param {number|string} suma
 * @param {number|string} ordTotal
 * @returns {{ diferenta: number, sub: boolean, peste: boolean, egal: boolean, mesaj: string|null }}
 */
export function diferentaSuma(suma, ordTotal) {
  const s = Number(suma) || 0;
  const t = Number(ordTotal) || 0;
  const diferenta = Math.round((s - t) * 100) / 100;
  if (t <= 0 || Math.abs(diferenta) < 0.005) {
    return { diferenta: 0, sub: false, peste: false, egal: true, mesaj: null };
  }
  const fmt = (v) => v.toFixed(2);
  if (diferenta < 0) {
    return {
      diferenta, sub: true, peste: false, egal: false,
      mesaj: `Suma introdusă (${fmt(s)} RON) e cu ${fmt(-diferenta)} RON sub valoarea ORD-ului de ${fmt(t)} RON.`,
    };
  }
  return {
    diferenta, sub: false, peste: true, egal: false,
    mesaj: `Suma introdusă (${fmt(s)} RON) e cu ${fmt(diferenta)} RON peste valoarea ORD-ului de ${fmt(t)} RON.`,
  };
}
