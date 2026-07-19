---
prompt: 88
titlu: "SECURITATE P0 — revocare globală de sesiune: gardă pe fiecare cerere autentificată"
branch: develop
model_suggested: "Opus 4.8 — atinge FIECARE cerere autentificată. Cel mai mare blast radius din tot sprintul."
depinde_de: prompt 87 + 87.1 (CI verde, v3.9.669, commit e8380cd)
fisiere_atinse:
  - server/middleware/session-guard.mjs                        (FIȘIER NOU)
  - server/services/actor-identity.mjs
  - server/index.mjs
  - server/tests/unit/session-guard.test.mjs                   (FIȘIER NOU)
  - server/tests/integration/session-revocation.test.mjs       (FIȘIER NOU)
  - server/tests/db/session-revocation-live.test.mjs           (FIȘIER NOU — Postgres real)
  - package.json
  - package-lock.json
versiune: 3.9.669 → 3.9.670
decizii_de_produs (luate de Mircea, NU le renegocia):
  - domeniu: TOATE cererile autentificate (nu doar cele mutante)
  - DB indisponibil: FAIL-CLOSED (503) — NU fail-open
  - cache: FĂRĂ CACHE — verificare la fiecare cerere
---

# ⚠️ BRANCH: `develop` — EXCLUSIV. `main` = PRODUCȚIE, manual, doar Mircea.

=====================================================================
## CONTEXT — ultima gaură mare
=====================================================================

`requireAuth` (`server/middleware/auth.mjs:80`) verifică **exclusiv semnătura JWT**:

```js
export function requireAuth(req, res, next) {
  ...
  const payload = jwt.verify(token, JWT_SECRET);
  return payload;              // ← atât. Zero interogare DB.
}
```

`checkTokenVersionValid()` (`middleware/auth.mjs:111`) există, e documentată, injectorul e cablat
(`index.mjs:1540`), soft-delete-ul bump-uiește `token_version` (`admin/users.mjs:631`), iar #87 a
adăugat bump și la schimbarea rolului — **dar funcția are ZERO apelanți**:

```bash
grep -rn "checkTokenVersionValid" server/ | grep -v tests | grep -v "export async"
# → niciun rezultat
```

`token_version` e validat **doar inline**, în `/auth/me` și `/auth/refresh`.

**Consecință, azi, în producție:** dezactivezi un utilizator, retrogradezi un admin, resetezi o
parolă — iar cookie-ul vechi **semnează în continuare documente, mișcă ALOP-uri și șterge fluxuri
până la 8 ore** (`JWT_EXPIRES`).

Promptul 87 a închis gaura **doar** pe rutele care cheamă `resolveActor` (admin/users, templates,
createFlow, email, TOTP, /auth/me). **Semnarea, ALOP-ul și formularele rămân expuse.** Acest prompt
le închide pe toate.

=====================================================================
## DESIGN — și de ce NU atingem `requireAuth`
=====================================================================

### ⛔ Capcana pe care trebuie s-o eviți

`requireAuth` este **SINCRON** și are **192 de call-site-uri**:
```js
const actor = requireAuth(req, res); if (!actor) return;
```

Ca să interogheze DB-ul ar trebui să devină `async` ⇒ `await` la toate cele 192. **Un singur
`await` uitat returnează un `Promise`, care este TRUTHY** ⇒ `if (!actor) return;` trece ⇒
`actor.userId` e `undefined` ⇒ ruta se rupe **tăcut**, în producție, pe autorizare.

⛔ **NU transforma `requireAuth` în `async`. NU atinge `server/middleware/auth.mjs` deloc.**
⛔ **NU modifica niciun call-site de `requireAuth`.**

### ✅ Designul corect: un middleware Express global

Un singur punct de inserție în `index.mjs`, între `express.static` (linia ~705) și montarea
routerelor (linia ~1553). Zero modificări la cele 192 de apeluri.

```
cererea → cookieParser (538)
        → express.static (705)          ← assets, NU trec prin gardă
        → healthRouter (792)            ← /health, /readyz, NU trec prin gardă
        → ⭐ sessionGuard (NOU)          ← garda de revocare
        → authRouter, adminRouter, flowsRouter... (1553+)
```

### Prefixele păzite

Exact aceleași prefixe declarate „autentificate" în promptul 86 (`sw.js`), **minus `/auth/`**:

```js
const GUARDED_PREFIXES = ['/api/', '/flows/', '/admin/'];
```

### ⭐ De ce `/auth/` NU e păzit (capcană care ar bloca aplicația definitiv)

Dacă garda ar acoperi `/auth/`, un utilizator revocat care are încă cookie-ul vechi în browser
**nu s-ar mai putea loga NICIODATĂ**: `POST /auth/login` ar fi respins de gardă, din cauza
cookie-ului stale, **înainte** să ajungă la rută. Blocaj permanent.

E și corect conceptual — rutele din `/auth/` își fac deja singure verificarea:
- `/auth/login` filtrează `deleted_at IS NULL` (`auth.mjs:53`);
- `/auth/me` a devenit fail-closed în #87;
- `/auth/refresh` verifică `token_version` (`auth.mjs:217`).

### Fără cache — și de ce nu costă

Garda pune rândul citit pe `req` (`req._actorRow`). `resolveActor` îl **refolosește** în loc să
interogheze din nou. Pe rutele care deja chemau `resolveActor`, query-ul **nu se adaugă — se mută**.
Pe restul, e un `SELECT` pe cheie primară, sub o milisecundă, pe o cerere care oricum lovește DB-ul.

Cel mai agresiv polling din frontend e `bulk-signer.js:202` (`setInterval(doPoll, 3000)`) — un PK
lookup la 3 secunde per tab. Nesemnificativ.

=====================================================================
## PAS 0 — Precondiții
=====================================================================

```bash
git status --short          # tracked modificate ⇒ OPREȘTE-TE
git switch develop
git pull --ff-only origin develop
test "$(node -p "require('./package.json').version")" = "3.9.669" || { echo "STOP"; exit 1; }
git log --oneline -1        # Așteptat: e8380cd
```

=====================================================================
## PAS 1 — Citește înainte de orice patch
=====================================================================

```bash
sed -n '75,100p'   server/middleware/auth.mjs      # requireAuth — DOAR ca referință, NU-l modifica
sed -n '700,715p'  server/index.mjs                # express.static
sed -n '788,800p'  server/index.mjs                # healthRouter
sed -n '1548,1565p' server/index.mjs               # montarea routerelor
cat server/services/actor-identity.mjs             # resolveActor din #87
grep -n "AUTH_COOKIE" server/middleware/auth.mjs   # numele exact al cookie-ului
```

=====================================================================
## PAS 2 — `server/middleware/session-guard.mjs` (FIȘIER NOU)
=====================================================================

```js
/**
 * DocFlowAI — server/middleware/session-guard.mjs
 *
 * SEC-88: revocare GLOBALĂ de sesiune.
 *
 * Problema:
 *   `requireAuth` verifică doar semnătura JWT. `checkTokenVersionValid()` există dar are ZERO
 *   apelanți. Rezultat: un cont dezactivat / un admin retrogradat / o parolă resetată păstrau
 *   un cookie complet funcțional până la JWT_EXPIRES (8h) — pe semnare, ALOP, fluxuri, formulare.
 *
 * Designul:
 *   Middleware Express global, montat ÎNAINTE de routere. NU atinge `requireAuth` (sincron,
 *   192 de call-site-uri — un singur `await` uitat ar returna un Promise TRUTHY și ar rupe
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

// Aceleași prefixe declarate „autentificate" în public/sw.js (promptul 86), MINUS /auth/.
export const GUARDED_PREFIXES = Object.freeze(['/api/', '/flows/', '/admin/']);

export function isGuardedPath(pathname) {
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
                role, org_id, token_version
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

    // 10. Rândul validat se pune pe req ⇒ `resolveActor` îl refolosește, fără al doilea query.
    //     Astfel „fără cache" nu adaugă un query pe rutele care chemau deja resolveActor.
    req._actorRow = row;
    return next();
  };
}
```

> ⚠️ **Verifică exporturile reale** din `server/middleware/auth.mjs` (`JWT_SECRET`, `AUTH_COOKIE`)
> și din `server/middleware/logger.mjs`. **Nu ghici numele.** Dacă `AUTH_COOKIE` nu e exportat,
> **exportă-l** — asta e singura modificare permisă în `auth.mjs`, și doar dacă e strict necesară.
> Raportează dacă a fost nevoie.

=====================================================================
## PAS 3 — `resolveActor` refolosește rândul (evită al doilea query)
=====================================================================

`resolveActor(actor)` primește azi doar payload-ul JWT. Adaugă un al doilea parametru opțional.

**Fișier:** `server/services/actor-identity.mjs`

1. Schimbă semnătura în `resolveActor(actor, req = null)` și `resolveActorOr(res, actor, req = null)`
   (`resolveActorOr` pasează `req` mai departe).
2. **La începutul lui `resolveActor`**, imediat după verificarea `actor?.userId`:
   ```js
   // SEC-88: dacă sessionGuard a rulat deja pe această cerere, rândul e validat și proaspăt
   // (fără cache — a fost citit în acest request). Îl refolosim: zero query suplimentar.
   // Garda a verificat DEJA deleted_at, token_version, rol și org — nu le reverificăm.
   if (req?._actorRow && String(req._actorRow.id) === String(actor.userId)) {
     return { ok: true, user: req._actorRow };
   }
   ```
3. **Actualizează cele ~9 call-site-uri** din #87 ca să paseze `req`:
   `await resolveActorOr(res, actor, req)`.
   ```bash
   grep -rn "resolveActorOr(" server/routes/ --include=*.mjs
   ```
   ⚠️ Dacă vreun call-site **nu** primește `req`, comportamentul rămâne corect (face query-ul) —
   dar raportează-l, ca să știm unde am pierdut optimizarea.

> ⚠️ `resolveActor` **rămâne complet funcțional și fără `req`** (rutele din `/auth/`, testele
> unitare, orice apelant viitor). Fallback-ul pe query e obligatoriu. **NU** face `req` obligatoriu.

=====================================================================
## PAS 4 — `server/index.mjs`: montarea gărzii
=====================================================================

Import:
```js
import { sessionGuard } from './middleware/session-guard.mjs';
```

**Poziția e critică.** Montează garda **DUPĂ** `healthRouter` (linia ~792) și **ÎNAINTE** de
`app.use('/', authRouter)` (linia ~1553):

```js
// SEC-88: revocare globală de sesiune. Montată DUPĂ express.static și healthRouter (assets,
// /health și /readyz nu trec prin gardă), ÎNAINTE de toate routerele de aplicație.
// Păzește /api/, /flows/, /admin/ — NU /auth/ (altfel un utilizator revocat cu cookie stale
// n-ar mai putea face niciodată login).
app.use(sessionGuard());
```

⚠️ **Verifică vizual** că între `express.static` și punctul de montare nu există alte rute de
aplicație care ar trebui păzite. Raportează ce ai găsit între liniile 705 și 1553.

=====================================================================
## PAS 5 — Teste
=====================================================================

### 5a. `server/tests/unit/session-guard.test.mjs` (NOU)

Mock `pool`, `DB_READY`, `logger`. Cazuri pe middleware:

| # | Situație | Așteptat |
|---|---|---|
| 1 | `GET /login` (nepăzit) | `next()`; `pool.query` **NU** chemat |
| 2 | `POST /auth/login` (nepăzit — capcana!) | `next()`; `pool.query` **NU** chemat |
| 3 | `GET /api/x` fără token | `next()` (ruta decide); fără query |
| 4 | `GET /api/x`, token invalid | `next()` (requireAuth va da 401); fără query |
| 5 | Token de upload (fără `userId`) | `next()`; fără query |
| 6 | `DB_READY = false` | **503 `db_unavailable`**; **fără** `next()` |
| 7 | `pool.query` respinge | **503 `db_unavailable`**; **fără** `next()` |
| 8 | `rows: []` (cont dezactivat) | **401 `session_revoked`**; **fără** `next()` |
| 9 | `tv` JWT ≠ `token_version` DB | **401 `token_revoked`** |
| 10 | `role` JWT (`admin`) ≠ DB (`user`) | **401 `session_role_stale`** |
| 11 | `orgId` JWT `5`, DB `null` | **401 `session_org_stale`** (null-aware) |
| 12 | `orgId` JWT `null`, DB `null` (super-admin) | `next()` |
| 13 | Totul OK | `next()`; **`req._actorRow` setat** |
| 14 | Regresie SQL | `WHERE id = $1` + `deleted_at IS NULL`; predicatul **NU** e pe email |

### 5b. `server/tests/integration/session-revocation.test.mjs` (NOU)

Prin supertest, pe app-ul real:

- Cont dezactivat + cookie valid ⇒ **401** pe `POST /flows`, pe o rută **ALOP**, și pe o rută de
  **semnare**. ⭐ Astea sunt exact rutele pe care #87 **nu** le acoperea.
- Admin retrogradat (`token_version` bump-uit) + cookie vechi ⇒ **401**.
- Parolă resetată (`token_version` bump-uit) ⇒ **401**.
- `POST /auth/login` cu un cookie **revocat** în cerere ⇒ **200** (loginul funcționează!). ⭐ Testul
  care demonstrează că nu am blocat definitiv utilizatorii revocați.
- `GET /health` și `GET /readyz` ⇒ **200**, fără query pe `users`.
- Un asset static ⇒ **200**, fără query.
- Utilizator valid ⇒ ruta merge normal, iar `resolveActor` **NU** face al doilea query
  (asertează `pool.query` chemat **o singură dată** pe `users` într-o rută care folosește
  `resolveActorOr`).

### 5c. `server/tests/db/session-revocation-live.test.mjs` (NOU — Postgres real)

⚠️ **Fixture-urile trec prin contractul de producție.** Folosește `hashPassword()` din
`server/middleware/auth.mjs`, email **lowercased**, `RETURNING id` (fără ID-uri hardcodate), și
verifică **fiecare nume de coloană** în migrări înainte de a scrie SQL:
```bash
grep -n "ADD COLUMN IF NOT EXISTS" server/db/index.mjs | grep -i "token_version\|deleted_at"
```
*(Cele trei eșecuri din #87 au fost exact asta: o coloană inventată, un injector necablat, un email
nenormalizat.)*

Scenarii, end-to-end pe Postgres real:
1. Login ⇒ cookie valid ⇒ `GET /api/...` **200**.
2. `UPDATE users SET deleted_at=NOW(), token_version=token_version+1` ⇒ **aceeași cerere, același
   cookie** ⇒ **401 `session_revoked`**. **Fără repornirea app-ului. Fără cache de așteptat.**
3. Al doilea utilizator, activ ⇒ **neafectat**, tot 200.
4. Reactivare (`deleted_at=NULL`, tv bump) ⇒ cookie-ul vechi rămâne **401**; după re-login ⇒ 200.
5. Schimbare de rol prin `PUT /admin/users/:id` (bump-ul din #87) ⇒ cookie-ul vechi ⇒ **401**.

=====================================================================
## PAS 6 — `package.json`
=====================================================================

Adaugă în scriptul `check`:
```
&& node --check server/middleware/session-guard.mjs
```

=====================================================================
## PAS 7 — Verificare
=====================================================================

```bash
# ⛔ requireAuth NEATINS — cea mai importantă verificare din tot promptul
git diff --stat server/middleware/auth.mjs
# Așteptat: NICIUN fișier modificat.
# EXCEPȚIE unică: exportul lui AUTH_COOKIE, dacă lipsea. Raportează dacă a fost necesar.

grep -c "await requireAuth" server/ -r --include=*.mjs
# Așteptat: 0 — requireAuth rămâne SINCRON

# Garda e montată în poziția corectă
grep -n "sessionGuard()\|express.static\|makeHealthRouter\|app.use('/', authRouter)" server/index.mjs
# Așteptat, în ordinea asta: express.static < makeHealthRouter < sessionGuard() < authRouter

# /auth/ NU e păzit
grep -n "GUARDED_PREFIXES" server/middleware/session-guard.mjs
# Așteptat: ['/api/', '/flows/', '/admin/'] — FĂRĂ '/auth/'

# Fără cache
grep -in "cache\|ttl\|setTimeout\|Map()" server/middleware/session-guard.mjs
# Așteptat: NICIUN mecanism de cache

npm run check
npm test
npm run test:db      # ⛔ POARTĂ DURĂ — vezi mai jos
git diff --check
```

### ⛔ POARTA `test:db`

`npm test` **NU rulează suita DB**. Un raport „X passed / 0 fail" nu spune **nimic** despre
`server/tests/db/`. Baseline CI curent: **54 fișiere, 359 teste, toate verzi.**

Dacă Docker e disponibil local ⇒ rulează `npm run db:test:up && npm run test:db` **înainte** de
commit. Dacă nu ⇒ **spune-o explicit**, comite și lasă CI să verifice (CLAUDE.md autorizează
CI-on-push). **Dar NU raporta „verde" pe skip.**

### ⛔ POARTA DE COMMIT (fișierele noi sunt untracked)

```bash
git status --short
git add -- server/middleware/session-guard.mjs \
           server/services/actor-identity.mjs \
           server/index.mjs \
           server/tests/unit/session-guard.test.mjs \
           server/tests/integration/session-revocation.test.mjs \
           server/tests/db/session-revocation-live.test.mjs \
           package.json package-lock.json
# + fixture-urile reparate, NOMINAL. ⛔ NICIODATĂ `git add .`
git diff --cached --name-only
git diff --cached --check
```

=====================================================================
## PAS 8 — Commit
=====================================================================

```bash
npm version 3.9.670 --no-git-tag-version
git commit -m "sec(P0): revocare globala de sesiune — sessionGuard pe /api,/flows,/admin verifica deleted_at, token_version, rol si org la FIECARE cerere; /auth exceptat; fail-closed pe DB; fara cache (v3.9.670)"
git push origin develop
```

**După push:** raportează **numărul exact** de teste `test:db` rulate și trecute. Baseline: 359.

=====================================================================
## ⚠️ FOLLOW-UP DE RAPORTAT (nu repara aici)
=====================================================================

1. **WebSocket.** `wsPush` menține conexiuni deschise. Garda e HTTP-only ⇒ conexiunea WS a unui
   utilizator revocat **rămâne deschisă**. Verifică dacă handshake-ul WS validează JWT-ul și
   **raportează** — e material pentru un prompt separat.
2. **`checkTokenVersionValid()`** devine complet redundantă (garda face acum verificarea global).
   **NU o șterge în acest prompt** — e mock-uită în teste. Raportează dacă mai are rost să existe.
3. **Frontend pe 401.** `df-shell.js:167` redirectează la `/login` pe orice `!r.ok` de la `/auth/me`.
   Dar acum **orice** rută `/api/` poate întoarce 401 `session_revoked`. Verifică dacă handler-ul
   generic de fetch din frontend tratează 401 cu redirect la login, sau dacă utilizatorul rămâne pe
   un ecran mort. **Doar raportează — nu modifica frontend-ul.**

=====================================================================
## RAPORT FINAL
=====================================================================

1. Output-ul **PAS 0**.
2. Diff-ul, pe pași (2–6).
3. ⭐ **Dovada că `server/middleware/auth.mjs` e neatins** (`git diff --stat`). Dacă a fost nevoie
   să exporți `AUTH_COOKIE`, arată exact acel diff și nimic altceva.
4. Ce ai găsit între liniile 705 și 1553 din `index.mjs` — rute de aplicație care ar fi trebuit păzite?
5. Câte call-site-uri `resolveActorOr` au primit `req`? Care nu, și de ce?
6. Output-ul complet al **PAS 7**.
7. Cele 3 follow-up-uri de mai sus.
8. `npm run check`, `npm test`, `npm run test:db`: rezultate + numere finale.
9. Versiune + hash commit + rezultat CI.
10. Orice abatere de la snippet-uri, cu justificare.
11. Confirmarea că **NU** ai atins `main` și niciun fișier din NO-TOUCH ZONE.

=====================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
=====================================================================

- ⛔ **NU** transforma `requireAuth` în `async`. **NU** modifica niciunul dintre cele 192 de
  call-site-uri. **NU** atinge `server/middleware/auth.mjs` (excepție unică: exportul lui
  `AUTH_COOKIE`, dacă lipsește).
- ⛔ **NU** adăuga `/auth/` în `GUARDED_PREFIXES` — ar bloca definitiv loginul utilizatorilor revocați.
- ⛔ **NU** adăuga cache. Decizie de produs luată explicit: verificare la fiecare cerere.
- ⛔ **NU** face fail-open pe eroare de DB. Decizie de produs: **503**.
- ⛔ **NU** face garda să răspundă 401 când tokenul lipsește sau e invalid — lasă `requireAuth`
  să decidă. Garda se ocupă de **revocare**, nu de autentificare.
- ⛔ **NO-TOUCH ZONE:** `server/signing/cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`,
  `java-pades-client.mjs`, `providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`.
- ⛔ **NU** modifica frontend-ul. Raportează.
- ⛔ **NU** șterge `checkTokenVersionValid()`.
- ⛔ **NU** slăbi asserțiile testelor existente. Repară fixture-ul.
- ⛔ Fixture-urile DB folosesc funcțiile reale (`hashPassword`), email lowercased, `RETURNING id`.
  **Verifică numele coloanelor în migrări. Nu ghici.**
- ⛔ `develop` exclusiv. Fără `git add .`, `stash`, `reset`, `clean`, `revert`, `force-push`.
- ⛔ Fără migrări DB. Fără pachete npm noi.
