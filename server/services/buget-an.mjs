// server/services/buget-an.mjs
// FEATURE buget multi-anual (v3.9.558) — helper PUR de buget pe an de exercițiu.
//
// `rows_plati` are benzi RELATIVE la momentul completării DF-ului:
//   plati_ani_precedenti | plati_estim_ancrt | plati_estim_an_np1 |
//   plati_estim_an_np2 | plati_estim_an_np3 | plati_estim_ani_ulter
// `an_referinta` (INTEGER, pe formulare_df) ancorează banda `ancrt` la un AN ABSOLUT.
// Cu el, „bugetul anului X" = banda corectă în funcție de offset = X − an_referinta:
//   offset  0 → plati_estim_ancrt
//   offset  1 → plati_estim_an_np1
//   offset  2 → plati_estim_an_np2
//   offset  3 → plati_estim_an_np3
//   offset >3 → plati_estim_ani_ulter
//   offset <0 → plati_ani_precedenti   (band literal; relevanța pentru ordonanțare
//                                        nouă o decide apelantul — vezi formular-shared)
//
// `an_referinta` NULL/absent (DF legacy, create înainte de migrarea 085) → return null
// („nedeclarat"), ca apelantul să aplice decizia owner (block mono-an pe `ancrt`).
//
// Funcția e PURĂ (fără I/O) și acoperită de teste unit. NU o cupla de pool/req.

/** Mapă offset (an_exercitiu − an_referinta) → cheia benzii din rows_plati. */
export function bandaPentruOffset(offset) {
  if (offset < 0) return 'plati_ani_precedenti';
  if (offset === 0) return 'plati_estim_ancrt';
  if (offset === 1) return 'plati_estim_an_np1';
  if (offset === 2) return 'plati_estim_an_np2';
  if (offset === 3) return 'plati_estim_an_np3';
  return 'plati_estim_ani_ulter'; // offset > 3
}

/** Parsare numerică tolerantă (string cu spații/virgulă zecimală → number; gol/invalid → 0). */
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Bugetul anului `anExercitiu` dintr-un DF ancorat pe `anReferinta`.
 * @param {Array<Object>} rowsPlati   formulare_df.rows_plati
 * @param {number|null}   anReferinta an absolut al benzii `ancrt` (NULL = legacy)
 * @param {number}        anExercitiu anul de exercițiu pentru care vrem plafonul
 * @returns {number|null} SUM peste rânduri pe banda corectă, sau null dacă an_referinta nedeclarat
 */
export function bugetPentruAnul(rowsPlati, anReferinta, anExercitiu) {
  if (anReferinta === null || anReferinta === undefined || anReferinta === '') return null;
  const ref = Number(anReferinta);
  const ex = Number(anExercitiu);
  if (Number.isNaN(ref) || Number.isNaN(ex)) return null;

  const banda = bandaPentruOffset(ex - ref);
  const rows = Array.isArray(rowsPlati) ? rowsPlati : [];
  return rows.reduce((s, r) => s + num(r && r[banda]), 0);
}
