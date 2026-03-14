/**
 * DocFlowAI — CSP Nonce middleware (FIX-07 v3.3.8)
 *
 * Generează un nonce criptografic unic per request, injectat în:
 *  - Header Content-Security-Policy (scriptSrc, styleSrc)
 *  - res.locals.cspNonce — disponibil în orice handler pentru inline scripts
 *
 * PROBLEMĂ REZOLVATĂ:
 *  Anterior: scriptSrc conținea 'unsafe-inline' — orice script injectat în DOM
 *  se executa, anulând complet protecția XSS oferită de CSP.
 *
 *  Acum: fiecare <script> inline din HTML trebuie să aibă atributul nonce="<val>"
 *  unde <val> vine din window.__CSP_NONCE__ injectat de server.
 *
 * STRATEGIE DE MIGRARE (fără a rescrie tot HTML-ul):
 *  1. Serverul injectează window.__CSP_NONCE__ = '<nonce>' ca primul script pe pagină
 *  2. HTML-urile existente primesc nonce pe script-urile inline existente via
 *     transformare în middleware serveWithNonce()
 *  3. CDN-urile externe (unpkg, jsdelivr, cdnjs) rămân în allowlist explicit
 *
 * NOTĂ: Paginile HTML statice (servite via express.static) NU primesc nonce automat.
 * Ele trebuie servite prin serveWithNonce() sau migrate la fișiere .js externe.
 * Această migrare completă e documentată ca FIX-07b pentru sprint-ul următor.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Middleware care generează nonce per request și îl pune în res.locals.
 * Trebuie aplicat ÎNAINTE de helmet pentru a putea folosi nonce-ul în CSP config.
 */
export function cspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

/**
 * Construiește directiva scriptSrc cu nonce și CDN-uri permise.
 * 'unsafe-inline' este ELIMINAT — singurul inline permis e cel cu nonce corect.
 */
export function buildScriptSrc(req, res) {
  const nonce = res.locals.cspNonce;
  return [
    "'self'",
    `'nonce-${nonce}'`,
    'https://unpkg.com',
    'https://cdn.jsdelivr.net',
    'https://cdnjs.cloudflare.com',
  ];
}

/**
 * serveWithNonce — servește un fișier HTML static cu nonce injectat.
 *
 * Strategia: adaugă un <script nonce="..."> în <head> care setează
 * window.__CSP_NONCE__ și re-adaugă nonce pe toate <script> inline existente.
 *
 * Această funcție este un SHIM de tranziție — obiectivul final este ca
 * toate script-urile inline să fie migrate în fișiere .js externe.
 *
 * @param {string} filePath - Calea absolută la fișierul HTML
 * @returns {express.RequestHandler}
 */
export function serveWithNonce(filePath) {
  return (req, res) => {
    try {
      let html = fs.readFileSync(filePath, 'utf8');
      const nonce = res.locals.cspNonce;

      // 1. Injectează nonce pe toate <script> inline (fără src=)
      //    Regex: <script> sau <script type="..."> fără atribut src
      html = html.replace(
        /<script(?![^>]*\bsrc=)([^>]*)>/g,
        (match, attrs) => {
          // Evită să adăugăm nonce de două ori
          if (attrs.includes('nonce=')) return match;
          return `<script nonce="${nonce}"${attrs}>`;
        }
      );

      // 2. Injectează window.__CSP_NONCE__ ca primul script în <head>
      //    Util pentru cod dinamic care creează <script> elements runtime
      const nonceScript = `<script nonce="${nonce}">window.__CSP_NONCE__="${nonce}";</script>`;
      html = html.replace('<head>', `<head>\n  ${nonceScript}`);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); // HTML dinamic nu se cacheaza
      res.send(html);
    } catch(e) {
      res.status(500).send('Internal Server Error');
    }
  };
}
