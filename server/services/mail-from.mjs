/**
 * DocFlowAI — mail-from.mjs  (#180)
 * -------------------------------------------------------------------------
 * Compune antetul `From` al emailurilor EXTERNE: numele instituției +
 * adresa platformei. Destinatarii externi nu cunosc platforma, iar un mail
 * de la „DocFlowAI" pare să vină de la un terț necunoscut.
 *
 * ⛔ Adresa NU se schimbă — Resend semnează DKIM pe domeniul din adresă.
 *    Se schimbă doar numele afișat, care nu intră în semnătură.
 * ⛔ Numele organizației e editabil din admin și ajunge într-un ANTET.
 *    `curataNumeExpeditor` există ca un nume cu CRLF sau ghilimele să nu
 *    poată rupe antetul ori injecta altele (email header injection).
 * ⛔ Zero acces la baza de date aici — funcții pure. Interogarea rămâne în rută.
 */

/** Extrage adresa dintr-un MAIL_FROM de forma `Nume <a@b.c>` sau `a@b.c`. */
export function adresaDin(mailFrom) {
  const s = String(mailFrom || '').trim();
  const m = s.match(/<([^>]+)>/);
  const adresa = (m ? m[1] : s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adresa) ? adresa : '';
}

/** Curăță un nume pentru antetul From. Întoarce '' dacă nu rămâne nimic utilizabil. */
export function curataNumeExpeditor(nume) {
  return String(nume || '')
    .replace(/[\r\n]+/g, ' ')          // CRLF = vectorul de injecție de antete
    .replace(/["<>,;:\\]/g, '')        // caractere cu înțeles în gramatica antetului
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 78);
}

/**
 * @param {string} numeOrg   — `organizations.name`
 * @param {string} mailFrom  — valoarea configurată (env sau implicit)
 * @returns {string} antetul `From`. Cade pe `mailFrom` neschimbat dacă numele
 *          e gol după curățare sau dacă adresa nu poate fi extrasă.
 */
export function expeditorExtern(numeOrg, mailFrom) {
  const adresa = adresaDin(mailFrom);
  const nume = curataNumeExpeditor(numeOrg);
  if (!adresa || !nume) return String(mailFrom || '');
  return `${nume} <${adresa}>`;
}
