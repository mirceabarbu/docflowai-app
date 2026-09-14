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
// Funcțiile de buget sunt PURE (fără I/O) și acoperite de teste unit. NU le cupla de pool/req.
// SINGURA excepție, deliberată: `anExercitiuCurent()` citește ceasul (#204) — stă aici fiindcă
// aici trăiește semantica anului de exercițiu, nu fiindcă ar fi pură.

/** Mapă offset (an_exercitiu − an_referinta) → cheia benzii din rows_plati. */
export function bandaPentruOffset(offset) {
  if (offset < 0) return 'plati_ani_precedenti';
  if (offset === 0) return 'plati_estim_ancrt';
  if (offset === 1) return 'plati_estim_an_np1';
  if (offset === 2) return 'plati_estim_an_np2';
  if (offset === 3) return 'plati_estim_an_np3';
  return 'plati_estim_ani_ulter'; // offset > 3
}

/**
 * Anul de exercițiu curent al sistemului. SURSĂ UNICĂ (#204).
 *
 * ⛔ Valoarea NU vine niciodată dintr-o cerere HTTP. Locurile care o folosesc alimentează
 *    PORȚI DE SCRIERE (plafon ordonanțare/plată, baza cardului ALOP); dacă anul ar fi
 *    parametru de cerere, un client care trimite an=2025 ar primi alt plafon, tăcut.
 *    Vezi tests/unit/an-nu-din-cerere.test.mjs (#203), care apără regula.
 *
 * Rapoartele READ-ONLY sunt altceva: acolo anul VINE de la utilizator prin `?an=`
 * (/api/clasa8, /admin/alop/stats — #203). Nu confunda cele două.
 *
 * Azi = anul calendaristic. Aici se va schimba când apare revizia de început de an
 * (fereastra primelor 3 zile lucrătoare din ianuarie, în care exercițiul curent al unui
 * dosar poate fi încă anul precedent). ACESTA e motivul pentru care funcția există.
 */
export function anExercitiuCurent() {
  return new Date().getFullYear();
}

/**
 * Emite un literal SQL întreg pentru anul de exercițiu. Gardă: #204.
 * Fragmentele SQL din routes/alop.mjs (sqlBandaRowsPlati, sqlOrdonantatAnCurent) INTERPOLEAZĂ
 * anul (legarea ca $N ar fi cerut modificarea array-ului de parametri în handlerele listei
 * ALOP). Interpolarea e sigură DOAR pentru că valoarea trece prin garda asta: orice non-întreg
 * aruncă, deci în SQL ajunge exclusiv un literal numeric produs de anExercitiuCurent().
 */
export function sqlAn(an) {
  if (!Number.isInteger(an)) {
    throw new Error(`sqlAn: an de exercițiu invalid (${an}). Sursa unică e anExercitiuCurent().`);
  }
  return String(an);
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

/**
 * CREDITE BUGETARE an curent (col.10 „10=8+9", `sum_rezv_crdt_bug_act` din `rows_ctrl` /
 * Secțiunea B CAB) — SUMĂ peste rânduri. Acesta e PLAFONUL de ordonanțare/plată (fix 12,
 * v3.9.582): verificarea la ordonanțare ȘI la noua-lichidare se face pe creditele BUGETARE
 * (col.10), NU pe banda `rows_plati` (care e doar baza CARDULUI), NU pe creditele de
 * angajament (col.7). Se aplică INDIFERENT de bifa „Stingere" (`ckbx_sting_ang_in_ancrt`):
 * când Stingere e bifat banda `rows_plati` a anului curent = 0, dar creditele bugetare rămân.
 *
 * `num()` tolerează formatul RON („150000,00") — în practică `getNC()` (core.js) salvează deja
 * număr-string curat (punct zecimal) prin `String(pMR(...))`, deci JS și fragmentul SQL
 * (`sqlCrediteBugetareCol10` din alop.mjs / `computeOrdBudgetContext`) coincid pe date reale.
 * Funcție PURĂ — fără I/O. NU primește și NU filtrează pe niciun an — sumează col.10 a DF-ului
 * legat; „anul" plafonului e dat de revizia activă a DF-ului, nu de un parametru (#204: fostul
 * nume, cu „AnCurent" în el, sugera o filtrare pe an care nu exista).
 * @param {Array<Object>} rowsCtrl formulare_df.rows_ctrl (Secțiunea B)
 * @returns {number} SUM(sum_rezv_crdt_bug_act) peste rânduri (0 dacă gol/absent)
 */
export function crediteBugetareCol10(rowsCtrl) {
  const rows = Array.isArray(rowsCtrl) ? rowsCtrl : [];
  return rows.reduce((s, r) => s + num(r && r.sum_rezv_crdt_bug_act), 0);
}
