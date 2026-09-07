/**
 * server/services/password-policy.mjs — POLITICA DE PAROLE (#181, v3.9.836)
 *
 * Modul PUR, fără dependențe (fără pool, fără express, fără import din db/) — ca să
 * poată fi importat din orice rută fără să tragă după el jumătate din backend.
 *
 * ── De ce există ────────────────────────────────────────────────────────────
 * Aceeași regulă era scrisă în TREI locuri, cu DOUĂ valori diferite:
 *   • auth.mjs        — POST /auth/change-password  → prag 10, refuz 400 (corect)
 *   • admin/users.mjs — creare utilizator           → prag 4, parola adminului
 *                                                     ÎNLOCUITĂ tăcut cu una generată
 *   • admin/users.mjs — PUT utilizator              → prag 4, parola adminului
 *                                                     IGNORATĂ tăcut, răspuns 200
 * Ultimele două nu erau doar o inconsecvență de politică, ci un bug de produs: un
 * admin care tasta o parolă scurtă primea 200 și credea că a schimbat-o.
 *
 * ⛔ Pragul de 10 (nu 12) NU e arbitrar: generatePassword() din middleware/auth.mjs
 *    produce xxx-xxx-xxx = 11 caractere. Un minim de 12 ar invalida TĂCUT chiar
 *    parolele emise de platformă (reset-password, bulk-import, GWS provisioning,
 *    send-credentials, maintenance). Testul 4 din unit/password-policy.test.mjs
 *    ține legătura asta vie: rulează generatePassword() de 50 de ori prin
 *    validatePassword() și cade dacă cineva urcă pragul fără să schimbe generatorul.
 *
 * Fără reguli de compoziție (majuscule/cifre/simboluri) — NIST SP 800-63B le
 * descurajează explicit; lungimea e singurul criteriu.
 */

/** Lungimea minimă acceptată pentru o parolă setată de un om. */
export const MIN_PASSWORD_LEN = 10;

/**
 * Plafon superior. Nu e o regulă de securitate, ci o gardă de disponibilitate:
 * PBKDF2 cu 100k iterații pe o intrare arbitrar de lungă e un vector de DoS.
 */
export const MAX_PASSWORD_LEN = 200;

/**
 * Validează o parolă în clar față de politica platformei.
 *
 * Întoarce { ok: true } sau { ok: false, error, ... } — NICIODATĂ nu aruncă,
 * indiferent ce primește (null, undefined, număr, obiect).
 *
 * Absența (null / undefined / non-string / șir gol) e un caz SEPARAT de
 * "prea scurtă": apelanții tratează câmpul gol ca "nu atinge parola" ori
 * "generează una", deci au nevoie să distingă cele două situații. Șirul gol
 * intră DELIBERAT la password_missing, nu la password_too_short.
 *
 * @param {*} pwd parola în clar
 * @returns {{ok:true}|{ok:false,error:string,message?:string,max?:number}}
 */
export function validatePassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length === 0) {
    return { ok: false, error: 'password_missing' };
  }
  if (pwd.length < MIN_PASSWORD_LEN) {
    // Mesajul se construiește DIN constantă — dacă pragul se schimbă vreodată,
    // textul se schimbă odată cu el, fără o a doua editare uitată.
    return {
      ok: false,
      error: 'password_too_short',
      message: `Parola trebuie să aibă minim ${MIN_PASSWORD_LEN} caractere.`,
    };
  }
  if (pwd.length > MAX_PASSWORD_LEN) {
    return { ok: false, error: 'password_too_long', max: MAX_PASSWORD_LEN };
  }
  return { ok: true };
}
