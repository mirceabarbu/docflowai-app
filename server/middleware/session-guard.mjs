/**
 * DocFlowAI — server/middleware/session-guard.mjs
 *
 * SEC-88: revocare GLOBALĂ de sesiune.
 *
 * Problema:
 *   `requireAuth` verifică doar semnătura JWT. `checkTokenVersionValid()` există dar are ZERO
 *   apelanți. Rezultat: un cont dezactivat / un admin retrogradat / o parolă resetată păstrau
 *   un cookie complet funcțional până la JWT_EXPIRES — pe semnare, ALOP, fluxuri, formulare.
 *
 * Designul:
 *   Middleware Express global, montat ÎNAINTE de routere. NU atinge `requireAuth` (sincron,
 *   ~192 de call-site-uri — un singur `await` uitat ar returna un Promise TRUTHY și ar rupe
 *   autorizarea tăcut).
 *
 * Decizii de produs (luate explicit, NU le schimba):
 *   - domeniu: TOATE cererile autentificate către /api/, /flows/, /admin/
 *   - `/auth/` NU e păzit: altfel un utilizator revocat cu cookie stale n-ar mai putea face
 *     NICIODATĂ login (garda ar respinge POST /auth/login înainte de rută). Rutele din /auth/
 *     își fac deja propria verificare.
 *   - DB indisponibil ⇒ FAIL-CLOSED (503). Majoritatea rutelor fac oricum `requireDb` ⇒ 503,
 *     deci nu adăugăm indisponibilitate nouă.
 *   - FĂRĂ cache. Query-ul e pe cheie primară și e refolosit de `resolveActor` prin `req._actorRow`.
 */

import jwt from 'jsonwebtoken';
import { JWT_SECRET, AUTH_COOKIE } from './auth.mjs';
import { pool, DB_READY } from '../db/index.mjs';
import { logger } from './logger.mjs';

// Prefixele autentificate. Bază: cele din public/sw.js (promptul 86), MINUS /auth/.
//
// SEC-88.1: `/bulk-signing/` și `/my-flows` NU se potriveau cu niciun prefix, deși sunt rute
// autentificate. Capcana: structura de directoare NU reflectă prefixul din URL —
// `server/routes/flows/bulk-signing.mjs` e montat prin `router.use('/', bulkRouter)` în
// `flows/index.mjs:34`, iar `flowsRouter` la rândul lui prin `app.use('/', flowsRouter)`.
// ⇒ calea finală e `/bulk-signing/initiate`, NU `/flows/bulk-signing/initiate`.
// `/bulk-signing/*` e o SUPRAFAȚĂ DE SEMNARE — un cont revocat putea porni semnare în masă.
export const GUARDED_PREFIXES = Object.freeze([
  '/api/',
  '/flows/',
  '/admin/',
  '/bulk-signing/',
  '/my-flows',          // acoperă /my-flows ȘI /my-flows/:flowId/download
]);

// Căi EXACTE (fără slash final) care nu se potrivesc cu niciun prefix de mai sus.
// `POST /flows` are calea exact `/flows` — `startsWith('/flows/')` NU o prinde.
export const GUARDED_EXACT = Object.freeze([
  '/flows',
  '/users',
]);

export function isGuardedPath(pathname) {
  if (GUARDED_EXACT.includes(pathname)) return true;
  return GUARDED_PREFIXES.some(p => pathname.startsWith(p));
}

/** Extrage tokenul exact ca `requireAuth`: cookie, apoi Authorization: Bearer. */
function extractToken(req) {
  const fromCookie = req.cookies?.[AUTH_COOKIE] || null;
  if (fromCookie) return fromCookie;
  const auth = req.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

export function sessionGuard() {
  return async function sessionGuardMw(req, res, next) {
    // 1. Rutele nepăzite trec mai departe neatinse.
    if (!isGuardedPath(req.path)) return next();

    // 2. Fără token ⇒ NU răspundem noi. Lăsăm ruta să decidă: unele rute din /flows/ sunt
    //    publice pentru semnatari externi (signerToken în body/query, fără cookie de auth).
    //    `requireAuth` va da 401 pe rutele care chiar cer autentificare.
    const token = extractToken(req);
    if (!token) return next();

    // 3. Token prezent dar invalid/expirat ⇒ tot lăsăm ruta să decidă (requireAuth dă 401 cu
    //    mesajul corect). Garda nu se ocupă de validitatea semnăturii, ci de REVOCARE.
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch (e) { return next(); }

    // 4. Tokenuri funcționale (upload/signer) nu au userId ⇒ nu sunt sesiuni de utilizator.
    if (!payload?.userId) return next();

    // 5. FAIL-CLOSED dacă DB-ul nu e disponibil. O sesiune revocată NU are voie să treacă
    //    printr-o fereastră de indisponibilitate.
    if (!pool || !DB_READY) {
      logger.error({ userId: payload.userId, path: req.path },
        'sessionGuard: DB indisponibil — fail-closed (503)');
      return res.status(503).json({
        error: 'db_unavailable',
        message: 'Baza de date este temporar indisponibilă. Reîncearcă în câteva momente.',
      });
    }

    let row;
    try {
      const { rows } = await pool.query(
        `SELECT id, email, nume, functie, compartiment, institutie,
                role, org_id, token_version, force_password_change
           FROM users
          WHERE id = $1
            AND deleted_at IS NULL`,
        [payload.userId]
      );
      row = rows[0] || null;
    } catch (e) {
      logger.error({ err: e, userId: payload.userId, path: req.path },
        'sessionGuard: lookup eșuat — fail-closed (503)');
      return res.status(503).json({
        error: 'db_unavailable',
        message: 'Baza de date este temporar indisponibilă. Reîncearcă în câteva momente.',
      });
    }

    // 6. Cont inexistent sau dezactivat.
    if (!row) {
      logger.warn({ userId: payload.userId, path: req.path },
        'sessionGuard: cont inexistent sau dezactivat — sesiune revocată (401)');
      return res.status(401).json({
        error: 'session_revoked',
        message: 'Contul tău a fost dezactivat. Reautentifică-te.',
      });
    }

    // 7. token_version — reset parolă / dezactivare / reactivare / schimbare de rol (#87).
    const dbTv  = row.token_version ?? 1;
    const jwtTv = payload.tv ?? 1;
    if (Number(jwtTv) !== Number(dbTv)) {
      logger.warn({ userId: payload.userId, jwtTv, dbTv, path: req.path },
        'sessionGuard: token revocat (401)');
      return res.status(401).json({
        error: 'token_revoked',
        message: 'Sesiunea a expirat. Te rugăm să te autentifici din nou.',
      });
    }

    // 8. Rol învechit (apărare în adâncime pentru JWT-urile emise înainte de bump-ul din #87).
    if (payload.role != null && String(payload.role) !== String(row.role ?? '')) {
      logger.warn({ userId: payload.userId, tokenRole: payload.role, dbRole: row.role, path: req.path },
        'sessionGuard: rol învechit (401)');
      return res.status(401).json({
        error: 'session_role_stale',
        message: 'Permisiunile contului tău s-au modificat. Reautentifică-te.',
      });
    }

    // 9. Organizație învechită — comparație NULL-AWARE, pe String (orgId poate fi non-numeric).
    const tokenOrgId = payload.orgId ?? null;
    const dbOrgId    = row.org_id ?? null;
    if (String(tokenOrgId ?? '') !== String(dbOrgId ?? '')) {
      logger.warn({ userId: payload.userId, tokenOrgId, dbOrgId, path: req.path },
        'sessionGuard: organizație învechită (401)');
      return res.status(401).json({
        error: 'session_org_stale',
        message: 'Asocierea contului cu instituția s-a modificat. Reautentifică-te.',
      });
    }

    // 10. #182 — schimbarea obligatorie a parolei. Steagul se pune la creare, la bulk-import,
    //     la resetarea parolei și la retrimiterea credențialelor; se stinge EXCLUSIV la
    //     POST /auth/change-password. Până acum era doar un banner desenat din localStorage,
    //     adică o sugestie: contul putea opera nelimitat, inclusiv semna, cu o parolă generată
    //     de administrator și cunoscută de el.
    //
    //     403, nu 401: sesiunea E validă, iar 401 ar declanșa deconectarea în frontend și l-ar
    //     trimite pe om înapoi la logare, într-o buclă — se loghează, e deconectat, se loghează.
    //     403 spune „ești cine zici că ești, dar nu poți face asta încă".
    //
    //     Nu e nevoie de listă albă: `/auth/` NU e printre GUARDED_PREFIXES, deci
    //     change-password, /auth/me, /auth/csrf-token și ieșirea din cont trec pe lângă poartă.
    //     Paginile HTML nu sunt nici ele guarded ⇒ omul își poate încărca pagina, vede
    //     bannerul și își schimbă parola. Dacă adaugi vreodată `/auth/` la GUARDED_PREFIXES,
    //     poarta asta devine o capcană fără ieșire.
    if (row.force_password_change === true) {
      logger.warn({ userId: payload.userId, path: req.path },
        'sessionGuard: schimbarea parolei e obligatorie — acces refuzat (403)');
      return res.status(403).json({
        error: 'password_change_required',
        message: 'Trebuie să îți schimbi parola înainte de a continua.',
      });
    }

    // 11. Rândul validat se pune pe req ⇒ `resolveActor` îl refolosește, fără al doilea query.
    //     Astfel „fără cache" nu adaugă un query pe rutele care chemau deja resolveActor.
    req._actorRow = row;
    return next();
  };
}
