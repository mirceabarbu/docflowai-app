---
prompt: 86
revizia: v2 (înlocuiește complet v1 — NU rula v1)
titlu: "SECURITATE P0 — fail-closed: SW network-only pe rute autentificate, identitate tenant după userId, CORS landing separat"
branch: develop
model_suggested: "Opus 4.8 — izolare tenant + authz; risc de regresie pe fixture-urile existente"
depinde_de: prompturile 84 + 85 (rulate, CI verde, v3.9.665)
fisiere_atinse:
  - public/sw.js
  - server/routes/flows/crud.mjs
  - server/utils/cors-config.mjs                            (FIȘIER NOU)
  - server/index.mjs
  - server/tests/unit/cors-config.test.mjs                  (FIȘIER NOU)
  - server/tests/unit/sw-no-auth-cache.test.mjs             (FIȘIER NOU)
  - server/tests/integration/cors-middleware.test.mjs       (FIȘIER NOU)
  - server/tests/integration/sec-p0-fail-closed.test.mjs    (FIȘIER NOU)
  - package.json
versiune: 3.9.665 → 3.9.666
cache_version_sw: docflowai-v283 → docflowai-v284
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

> `main` = **PRODUCȚIE**, gestionat **manual, doar de Mircea**.
> NU face `checkout main`, NU face `merge` în `main`, NU face `push origin main`.

> **NOTĂ v2:** această revizie corectează trei defecte reale din v1, semnalate la
> code review. **`Clear-Site-Data` la logout a fost ELIMINAT** (vezi Anexa A).
> Dacă ai deja v1 aplicat local — `git reset --hard origin/develop` și pornește de aici.

=====================================================================
## PAS 0 — PRECONDIȚII (oprește-te dacă vreuna pică)
=====================================================================

```bash
# 1. Working tree curat — NU face stash automat, NU șterge nimic
git status --porcelain
# Așteptat: ZERO output. Dacă apare orice linie ⇒ OPREȘTE-TE și raportează.

# 2. Branch + pull fără merge accidental
git switch develop
git pull --ff-only origin develop

# 3. Versiunea de bază TREBUIE să fie 3.9.665 (prompturile 84 + 85 aplicate)
test "$(node -p "require('./package.json').version")" = "3.9.665" || {
  echo "STOP: versiunea de bază nu este 3.9.665"; exit 1;
}

# 4. getDefaultOrgId are EXACT un apelant real
grep -rn "getDefaultOrgId(" server/ --include=*.mjs | grep -v tests | grep -v "export async function"
# Așteptat: EXACT 1 rezultat — server/routes/flows/crud.mjs:124
# Dacă sunt mai mulți ⇒ OPREȘTE-TE și raportează.
```

=====================================================================
## CONTEXT — trei defecte fail-open, confirmate în cod
=====================================================================

### P0.1 — Service Worker cache-uiește răspunsuri API autentificate

`public/sw.js:68-70` rutează `/api/`, `/auth/`, `/flows/`, `/admin/` prin `networkFirst()`,
care execută `cache.put(request, response.clone())` (linia 123). Documente DF/ORD, liste
ALOP și date bugetare rămân în **Cache Storage după logout** — pe calculatoare partajate
din primării, următorul utilizator ajunge la datele precedentului.

> Handler-ul `activate` (liniile 47-57) șterge deja cache-urile `docflowai-*` care nu sunt
> `CACHE_STATIC` curent ⇒ **bump-ul de `CACHE_VERSION` purjează automat cache-urile otrăvite**.

### P0.3 — Identitate tenant fragilă + fallback cross-tenant

`server/routes/flows/crud.mjs:116-125` are **două** probleme, nu una:

```js
const ru = await pool.query('SELECT org_id, nume FROM users WHERE email=$1', [...]);
orgId = ru.rows[0]?.org_id || null;
...
} catch(e) {}                                                    // eroare DB înghițită
if (!orgId) { try { orgId = await getDefaultOrgId(); } ... }     // ⇒ PRIMA organizație
```

**(a) Fallback cross-tenant.** `getDefaultOrgId()` face literal
`SELECT id FROM organizations ORDER BY id ASC LIMIT 1`. O eroare tranzitorie de DB
sau un `org_id` lipsă creează fluxul **în prima primărie din tabel**.

**(b) Lookup după email — nedeterminist.** Migrarea **`067_soft_delete_users_orgs`** a
**eliminat constrângerea UNIQUE pe `users.email`** și a înlocuit-o cu una *parțială*
(doar pe conturile active), pentru a permite reutilizarea emailului după soft-delete.
Comentariul din migrare o spune explicit. Consecință: `WHERE email=$1` poate întoarce
**mai multe rânduri** (unul activ + N șterse), iar `rows[0]` **fără `ORDER BY` este
nedeterminist** — se poate citi `org_id`-ul unui cont dezactivat.

Fix corect: lookup după **`id = actor.userId` cu `deleted_at IS NULL`**. JWT-ul conține deja `userId`.

### P0.4 — CORS credentialed prea larg

`server/index.mjs:602-608` adaugă `docflowai.ro` + `www.docflowai.ro` în lista **globală**
cu `credentials: true`. Landing-ul poate trimite cereri **cu cookie de sesiune** către orice
endpoint. Mai mult: dacă `CORS_ORIGIN` din Railway le conține deja, o simplă „neadăugare"
nu rezolvă nimic — **trebuie filtrate activ**.

=====================================================================
## PAS 1 — Citește înainte de orice patch
=====================================================================

```bash
cat public/sw.js
sed -n '105,130p' server/routes/flows/crud.mjs
sed -n '593,612p' server/index.mjs
sed -n '1710,1728p' server/index.mjs
grep -rn "requireAuth" server/middleware/auth.mjs | head -3   # payload JWT: userId, email, orgId, nume, role
```

=====================================================================
## PAS 2 — `public/sw.js`: rute autentificate = network-only
=====================================================================

### 2a. Bump `CACHE_VERSION`

`old_str`:
```js
const CACHE_VERSION = 'docflowai-v283';
```
`new_str`:
```js
// SEC-P0.1: bump obligatoriu — handler-ul `activate` șterge toate cache-urile
// `docflowai-*` diferite de CACHE_STATIC curent, deci acest bump purjează automat
// răspunsurile API autentificate cache-uite de versiunile anterioare.
const CACHE_VERSION = 'docflowai-v284';
```

### 2b. Fetch handler

`old_str`:
```js
  // API calls → Network-first (cu fallback la cache dacă offline)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/flows/') || url.pathname.startsWith('/admin/')) {
    e.respondWith(networkFirst(e.request));
    return;
  }
```
`new_str`:
```js
  // SEC-P0.1: rutele autentificate NU intră NICIODATĂ în Cache Storage.
  // Răspunsurile conțin documente DF/ORD și date bugetare — cache-uirea lor le lăsa
  // accesibile în browser DUPĂ logout (calculatoare partajate în primării).
  // Strategie: NETWORK-ONLY. Fără caches.match(), fără cache.put(). Offline ⇒ 503.
  if (isAuthenticatedRoute(url.pathname)) {
    e.respondWith(networkOnly(e.request));
    return;
  }
```

### 2c. `networkFirst()` → `networkOnly()`

`old_str`:
```js
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch(e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', message: 'Nu există conexiune la internet.' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}
```
`new_str`:
```js
// SEC-P0.1: prefixele care servesc date autentificate. Orice rută care se potrivește
// aici este NETWORK-ONLY — nu se citește și nu se scrie NIMIC în Cache Storage.
const AUTHENTICATED_PREFIXES = ['/api/', '/auth/', '/flows/', '/admin/'];

function isAuthenticatedRoute(pathname) {
  return AUTHENTICATED_PREFIXES.some(p => pathname.startsWith(p));
}

// Network-only: fără caches.match(), fără cache.put(). Offline ⇒ 503 explicit.
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'Nu există conexiune la internet.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
```

> ⛔ **NU atinge** `cacheFirst`, `staleWhileRevalidate`, `networkFirstWithOfflineFallback`
> — servesc CSS/JS/imagini/shell-uri HTML statice, fără date de utilizator.
>
> ⛔ **NU** adăuga header `Clear-Site-Data` la logout. Vezi **Anexa A** pentru motiv.

=====================================================================
## PAS 3 — `crud.mjs`: identitate după `userId`, fail-closed, zero fallback
=====================================================================

`old_str`:
```js
    let orgId = null;
    try {
      const ru = await pool.query('SELECT org_id, nume FROM users WHERE email=$1', [initEmail.trim().toLowerCase()]);
      orgId = ru.rows[0]?.org_id || null;
      const dbNume = String(ru.rows[0]?.nume || '').trim();
      if (dbNume) initName = dbNume; // numele din DB e sursa autoritară, ca emailul (nu body-ul clientului)
    } catch(e) {}
    if (!orgId) {
      try { orgId = await getDefaultOrgId(); } catch(e) { orgId = null; }
    }
```

`new_str`:
```js
    // ── SEC-P0.3: identitate tenant FAIL-CLOSED ────────────────────────────────
    // (a) Lookup după users.id, NU după email. Migrarea 067_soft_delete_users_orgs a
    //     eliminat UNIQUE-ul total pe users.email (l-a înlocuit cu unul PARȚIAL, doar pe
    //     conturile active, ca să permită reutilizarea emailului după soft-delete).
    //     Deci `WHERE email=$1` poate întoarce MAI MULTE rânduri, iar rows[0] fără
    //     ORDER BY este nedeterminist — se putea citi org_id-ul unui cont dezactivat.
    // (b) Zero fallback. Anterior, o eroare de DB sau un org_id lipsă cădea pe
    //     getDefaultOrgId() = PRIMA organizație din tabel ⇒ flux creat în instituția GREȘITĂ.
    //     Un flux nu se creează NICIODATĂ fără tenant confirmat.
    if (!actor.userId) {
      logger.warn({ email: initEmail }, 'createFlow: JWT fără userId — fail-closed (401)');
      return res.status(401).json({
        error: 'session_identity_invalid',
        message: 'Sesiunea nu mai este validă. Reautentifică-te.',
      });
    }

    let userRow = null;
    try {
      const ru = await pool.query(
        `SELECT id, org_id, nume
           FROM users
          WHERE id = $1
            AND deleted_at IS NULL`,
        [actor.userId]
      );
      userRow = ru.rows[0] || null;
    } catch (e) {
      logger.error({ err: e, userId: actor.userId }, 'createFlow: lookup organizație eșuat — fail-closed (503)');
      return res.status(503).json({
        error: 'org_lookup_failed',
        message: 'Baza de date este temporar indisponibilă. Reîncearcă în câteva momente.',
      });
    }

    if (!userRow) {
      logger.warn({ userId: actor.userId }, 'createFlow: actor inexistent sau dezactivat — fail-closed (403)');
      return res.status(403).json({
        error: 'actor_not_found',
        message: 'Contul tău nu a fost găsit sau a fost dezactivat. Reautentifică-te.',
      });
    }

    const orgId = userRow.org_id || null;
    if (!orgId) {
      logger.warn({ userId: actor.userId }, 'createFlow: utilizator fără organizație — fail-closed (409)');
      return res.status(409).json({
        error: 'user_without_org',
        message: 'Contul tău nu este asociat unei instituții. Contactează administratorul.',
      });
    }

    // Sesiune învechită: JWT-ul poartă alt org decât cel curent din DB (utilizator mutat
    // între instituții). DB-ul e autoritar, deci fluxul ar merge oricum în org-ul corect —
    // dar UI-ul clientului (compartimente, semnatari, liste DF) e încărcat din org-ul VECHI.
    // Forțăm reautentificarea în loc să creăm un flux cu date amestecate.
    // ⚠️ Comparație pe String, NU pe Number: orgId poate fi non-numeric în fixture-uri/JWT.
    if (actor.orgId != null && String(actor.orgId) !== String(orgId)) {
      logger.warn({ userId: actor.userId, tokenOrgId: actor.orgId, dbOrgId: orgId },
        'createFlow: organizația din JWT diferă de cea curentă — fail-closed (401)');
      return res.status(401).json({
        error: 'session_org_stale',
        message: 'Asocierea contului cu instituția s-a modificat. Reautentifică-te.',
      });
    }

    const dbNume = String(userRow.nume || '').trim();
    if (dbNume) initName = dbNume; // numele din DB e sursa autoritară, ca emailul (nu body-ul clientului)
```

⚠️ **`let orgId` era declarat aici și e folosit mai jos în funcție.** După patch e `const orgId`.
Verifică prin `node --check` că nu există reasignări ulterioare; dacă există, lasă `let`.

Apoi scoate `getDefaultOrgId` **doar** din import-ul lui `crud.mjs`:

`old_str` (aplică-l **exclusiv** în `server/routes/flows/crud.mjs` — apare identic în 7 fișiere):
```js
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../../db/index.mjs';
```
`new_str`:
```js
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getUserMapForOrg, writeAuditEvent } from '../../db/index.mjs';
```

> ⛔ **NU** șterge `getDefaultOrgId` din `server/db/index.mjs` — e mock-uită de ~10 teste.
> ⛔ **NU** atinge import-urile din celelalte 6 fișiere `flows/*.mjs`.

=====================================================================
## PAS 4 — `server/utils/cors-config.mjs` (FIȘIER NOU)
=====================================================================

```js
/**
 * DocFlowAI — server/utils/cors-config.mjs
 *
 * SEC-P0.4: separă CORS-ul aplicației (credentialed) de CORS-ul landing-ului
 * (fără credențiale, exclusiv pe /api/contact).
 *
 * Anterior, docflowai.ro era adăugat în lista GLOBALĂ cu `credentials: true`, permițându-i
 * să trimită cereri CU COOKIE DE SESIUNE către orice endpoint al aplicației.
 *
 * IMPORTANT: originile landing-ului sunt eliminate ACTIV din lista credentialed, chiar dacă
 * apar (accidental sau istoric) în CORS_ORIGIN / PUBLIC_BASE_URL. „Doar nu le adăugăm" NU e
 * suficient — env-ul de producție le poate conține deja.
 */

import cors from 'cors';

export const LANDING_ORIGINS = Object.freeze([
  'https://docflowai.ro',
  'https://www.docflowai.ro',
]);

export const LANDING_ROUTE = '/api/contact';

const LANDING_SET = new Set(LANDING_ORIGINS);

/** Normalizează la origine canonică ("https://X.ro/" și "https://X.ro" ⇒ același lucru). */
function normalizeOrigin(value) {
  try { return new URL(String(value).trim()).origin; }
  catch { return null; }
}

/**
 * Originile aplicației — singurele care primesc CORS credentialed.
 * Originile landing-ului sunt FILTRATE ACTIV.
 * @returns {string[]|false}  false ⇒ CORS blocat pentru orice origine externă.
 */
export function resolveAppOrigins(env = process.env) {
  const raw = env.CORS_ORIGIN
    ? String(env.CORS_ORIGIN).split(',')
    : (env.PUBLIC_BASE_URL ? [env.PUBLIC_BASE_URL] : []);

  const origins = [...new Set(
    raw.map(normalizeOrigin).filter(Boolean).filter(o => !LANDING_SET.has(o))
  )];

  return origins.length ? origins : false;
}

/** True dacă env-ul conține (greșit) o origine de landing în lista credentialed. */
export function envLeaksLandingOrigin(env = process.env) {
  const raw = [
    ...String(env.CORS_ORIGIN || '').split(','),
    String(env.PUBLIC_BASE_URL || ''),
  ];
  return raw.map(normalizeOrigin).filter(Boolean).some(o => LANDING_SET.has(o));
}

/**
 * Montează ambele politici CORS pe app. Exportat separat ca să fie testabil cu supertest
 * pe un express gol — testul pe `resolveAppOrigins` NU demonstrează ordinea middleware-ului.
 */
export function mountCors(app, env = process.env) {
  const appOrigins  = resolveAppOrigins(env);
  const appCors     = cors({ origin: appOrigins, credentials: true });
  const landingCors = cors({ origin: [...LANDING_ORIGINS], credentials: false, methods: ['POST', 'OPTIONS'] });

  // LANDING_ROUTE primește CORS dedicat FĂRĂ credențiale. Restul primesc CORS credentialed.
  // Ramificarea trebuie făcută AICI: middleware-ul `cors` termină preflight-ul OPTIONS cu 204
  // chiar și când originea nu se potrivește (doar fără header ACAO), deci un CORS montat
  // ulterior pe rută nu ar mai apuca să ruleze.
  app.use((req, res, next) =>
    (req.path === LANDING_ROUTE ? landingCors : appCors)(req, res, next)
  );

  return { appOrigins };
}
```

=====================================================================
## PAS 5 — `server/index.mjs`: cablare
=====================================================================

### 5a. Import (lângă celelalte `./utils/`)
```js
import { mountCors, envLeaksLandingOrigin, LANDING_ORIGINS } from './utils/cors-config.mjs';
```

### 5b. Blocul CORS

`old_str`:
```js
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : (process.env.PUBLIC_BASE_URL ? [process.env.PUBLIC_BASE_URL.replace(/\/$/, '')] : false);
// Adaugam intotdeauna docflowai.ro pentru formularul de contact de pe landing
const corsOriginsWithLanding = Array.isArray(corsOrigins)
  ? [...new Set([...corsOrigins, 'https://docflowai.ro', 'https://www.docflowai.ro'])]
  : corsOrigins;
if (corsOrigins === false) {
  logger.warn('CORS_ORIGIN și PUBLIC_BASE_URL lipsesc — CORS blocat pentru toate originile externe. Setați cel puțin PUBLIC_BASE_URL.');
}
app.use(cors({ origin: corsOriginsWithLanding, credentials: true }));
```

`new_str`:
```js
// SEC-P0.4: CORS credentialed EXCLUSIV pentru originile aplicației. Landing-ul primește
// CORS dedicat, fără credențiale, doar pe /api/contact (vezi utils/cors-config.mjs).
if (envLeaksLandingOrigin()) {
  logger.warn({ landing: LANDING_ORIGINS },
    'SEC-P0.4: originile landing-ului apar în CORS_ORIGIN/PUBLIC_BASE_URL și au fost ELIMINATE din lista credentialed. Curăță variabila de mediu în Railway.');
}
const { appOrigins: corsOrigins } = mountCors(app);
if (corsOrigins === false) {
  logger.warn('CORS_ORIGIN și PUBLIC_BASE_URL lipsesc — CORS blocat pentru toate originile externe. Setați cel puțin PUBLIC_BASE_URL.');
}
```

> ⚠️ Dacă `cors` rămâne importat în `index.mjs` fără alt apelant, lasă-l (inofensiv) sau
> scoate-l — raportează ce ai ales. **NU** modifica ruta `/api/contact`: `mountCors` o
> tratează deja global.

### 5c. `package.json` — adaugă noul fișier în `npm run check`

În scriptul `check`, adaugă `&& node --check server/utils/cors-config.mjs` (după
`node --check server/middleware/auth.mjs`, ca să rămână gruparea logică).

=====================================================================
## PAS 6 — Teste
=====================================================================

### 6a. `server/tests/unit/cors-config.test.mjs` (NOU)

```js
import { describe, it, expect } from 'vitest';
import { resolveAppOrigins, envLeaksLandingOrigin, LANDING_ORIGINS, LANDING_ROUTE }
  from '../../utils/cors-config.mjs';

describe('SEC-P0.4 — resolveAppOrigins', () => {
  it('CORS_ORIGIN are prioritate și se despică pe virgulă', () => {
    expect(resolveAppOrigins({ CORS_ORIGIN: 'https://app.docflowai.ro, https://x.ro' }))
      .toEqual(['https://app.docflowai.ro', 'https://x.ro']);
  });

  it('fallback la PUBLIC_BASE_URL, normalizat (fără slash final)', () => {
    expect(resolveAppOrigins({ PUBLIC_BASE_URL: 'https://app.docflowai.ro/' }))
      .toEqual(['https://app.docflowai.ro']);
  });

  it('fără configurație ⇒ false (CORS blocat), NU true', () => {
    expect(resolveAppOrigins({})).toBe(false);
    expect(resolveAppOrigins({ CORS_ORIGIN: '   ' })).toBe(false);
  });

  // ⭐ TESTUL CRITIC — v1 al fix-ului pica exact aici.
  it('elimină ACTIV originile landing-ului chiar dacă apar în CORS_ORIGIN', () => {
    expect(resolveAppOrigins({
      CORS_ORIGIN: 'https://app.docflowai.ro,https://docflowai.ro,https://www.docflowai.ro',
    })).toEqual(['https://app.docflowai.ro']);
  });

  it('elimină landing-ul și când vine cu slash final sau din PUBLIC_BASE_URL', () => {
    expect(resolveAppOrigins({ CORS_ORIGIN: 'https://docflowai.ro/' })).toBe(false);
    expect(resolveAppOrigins({ PUBLIC_BASE_URL: 'https://www.docflowai.ro' })).toBe(false);
  });

  it('envLeaksLandingOrigin semnalează configurația greșită din Railway', () => {
    expect(envLeaksLandingOrigin({ CORS_ORIGIN: 'https://app.docflowai.ro' })).toBe(false);
    expect(envLeaksLandingOrigin({ CORS_ORIGIN: 'https://app.docflowai.ro,https://docflowai.ro' })).toBe(true);
  });

  it('landing-ul are acces la exact o rută', () => {
    expect(LANDING_ROUTE).toBe('/api/contact');
    expect(LANDING_ORIGINS).toHaveLength(2);
  });
});
```

### 6b. `server/tests/integration/cors-middleware.test.mjs` (NOU)

Testează **middleware-ul real, cu ordinea reală** — ce testul de helper NU poate demonstra.
Construiește un express gol, cheamă `mountCors(app, envFals)`, adaugă două rute-momâie
(`GET /api/my-flows`, `POST /api/contact`) și verifică prin supertest:

| # | Cerere | Așteptat |
|---|--------|----------|
| 1 | `OPTIONS /api/my-flows`, `Origin: https://docflowai.ro` | **fără** `access-control-allow-origin`, **fără** `access-control-allow-credentials` |
| 2 | `OPTIONS /api/contact`, `Origin: https://docflowai.ro` | `access-control-allow-origin: https://docflowai.ro`, **fără** `allow-credentials` |
| 3 | `OPTIONS /api/my-flows`, `Origin: https://app.docflowai.ro` | ACAO exact + `access-control-allow-credentials: true` |
| 4 | `OPTIONS /api/my-flows`, `Origin: https://evil.ro` | **fără** ACAO |
| 5 | env cu `CORS_ORIGIN='https://app.docflowai.ro,https://docflowai.ro'` → `OPTIONS /api/my-flows`, `Origin: https://docflowai.ro` | **fără** ACAO (landing-ul filtrat activ) |

Cazul 5 e cel care demonstrează că regresia din v1 nu se poate reintroduce.

### 6c. `server/tests/unit/sw-no-auth-cache.test.mjs` (NOU)

Test de regresie la nivel de sursă — citește `public/sw.js` cu `fs.readFileSync` și verifică:

- `CACHE_VERSION` este `'docflowai-v284'`;
- fișierul **nu mai conține** identificatorul `networkFirst(` (a fost înlocuit cu `networkOnly`);
- corpul funcției `networkOnly` (extras între `async function networkOnly` și următorul
  `\n}` la nivel zero) **nu conține** `caches.match` și **nu conține** `cache.put`;
- `AUTHENTICATED_PREFIXES` conține toate cele 4 prefixe: `/api/`, `/auth/`, `/flows/`, `/admin/`;
- handler-ul `fetch` rutează prin `isAuthenticatedRoute` + `networkOnly`.

Nu e la fel de puternic ca un Playwright cu SW real, dar **previne reintroducerea accidentală**
— și e exact rolul pe care îl avea `Clear-Site-Data`, fără riscurile lui (Anexa A).

### 6d. `server/tests/integration/sec-p0-fail-closed.test.mjs` (NOU)

Copiază **structura de `vi.mock` ESM din `server/tests/integration/flows.test.mjs`** — citește-l
întâi, nu inventa alta. Cazuri obligatorii pe `POST /flows`:

| # | Situație | Așteptat |
|---|----------|----------|
| 1 | JWT fără `userId` | **401** `session_identity_invalid` |
| 2 | `pool.query` respinge (eroare DB) | **503** `org_lookup_failed` + `expect(mockGetDefaultOrgId).not.toHaveBeenCalled()` |
| 3 | Utilizator inexistent / soft-deleted (`rows: []`) | **403** `actor_not_found` + `expect(mockSaveFlow).not.toHaveBeenCalled()` |
| 4 | Utilizator cu `org_id: null` | **409** `user_without_org` + niciun flux salvat |
| 5 | JWT `orgId: 3`, DB `org_id: 7` | **401** `session_org_stale` + niciun flux salvat |
| 6 | Happy path — JWT `orgId: 7`, DB `org_id: 7` | **succes**, fluxul salvat are `orgId === 7`, și `expect(mockGetDefaultOrgId).not.toHaveBeenCalled()` |
| 7 | **Regresie lookup** — interogarea nu se mai face după email | asertează că `pool.query` a fost chemat cu SQL care conține `WHERE id = $1` și `deleted_at IS NULL`, și **NU** `email=$1` |

### 6e. ⚠️ Fixture-uri existente care se pot rupe

Testele actuale mock-uiesc `getDefaultOrgId` și pot să nu configureze deloc rândul `users`,
bazându-se pe fallback. După fix vor primi **403**. La fel, JWT-uri de test cu `orgId: 'org1'`
(string) versus DB `org_id: 1` (int) — de asta comparația e pe `String(...)`, nu pe `Number(...)`.

**Regula: REPARĂ FIXTURE-UL, nu comportamentul.** Adaugă în mock-ul de `pool.query` rândul
`users` corect (`{ id, org_id, nume }`) pentru actorul de test, aliniat cu `orgId`-ul din JWT.
**NU** reintroduce fallback-ul. **NU** slăbi asserțiile. **NU** scoate testele.

Raportează nominal **fiecare** fișier de test atins și motivul.

=====================================================================
## PAS 7 — Verificare
=====================================================================

```bash
# ── SW ──
grep -n "networkFirst(" public/sw.js
# Așteptat: NICIUN rezultat
grep -n "CACHE_VERSION = " public/sw.js
# Așteptat: 'docflowai-v284'
grep -n "Clear-Site-Data" server/routes/auth.mjs
# Așteptat: NICIUN rezultat (eliminat deliberat — Anexa A)

# ── Tenant ──
grep -rn "getDefaultOrgId" server/routes/flows/crud.mjs
# Așteptat: NICIUN rezultat
grep -rn "getDefaultOrgId(" server/ --include=*.mjs | grep -v tests | grep -v "export async function"
# Așteptat: NICIUN rezultat
grep -n "WHERE email=\$1" server/routes/flows/crud.mjs
# Așteptat: NICIUN rezultat (lookup-ul e după users.id)

# ── CORS ──
grep -n "docflowai.ro" server/index.mjs | grep -i cors
# Așteptat: NICIUN rezultat

# ── Calitate ──
npm run check      # trebuie să includă și server/utils/cors-config.mjs
npm test           # verde, ZERO teste eșuate, ZERO skip-uri noi față de baseline
git diff --check   # fără whitespace stricat

# ── Poarta de commit ──
git diff --name-only
```

⛔ **POARTĂ DE OPRIRE:** dacă `git diff --name-only` conține **orice** fișier din NO-TOUCH ZONE
sau **orice** fișier care nu e în `fisiere_atinse` (plus fixture-urile reparate la 6e, raportate
nominal) ⇒ **OPREȘTE-TE. Fără commit. Fără push.** Raportează lista.

Criteriul pe teste **nu** e un număr fix: *zero eșecuri, zero skip-uri noi, toate testele noi
executate, raportează numărul final*.

=====================================================================
## PAS 8 — Commit
=====================================================================

`sw.js` e încărcat prin `navigator.serviceWorker.register('/sw.js')`, **fără `?v=`** — browserul
detectează schimbarea prin diff de bytes. Deci: bump `package.json` + `CACHE_VERSION`.
**NU** e nevoie de bulk-replace `?v=` (niciun `.js`/`.css` referențiat cu `?v=` nu s-a modificat).

```bash
# package.json: 3.9.665 → 3.9.666
git commit -m "sec(P0): SW network-only pe rute autentificate; identitate tenant dupa userId cu deleted_at, fail-closed, zero fallback cross-tenant; CORS landing separat fara credentiale (v3.9.666)"
git push origin develop
```

=====================================================================
## PAS 9 — Verificare manuală pe staging (raportează comenzile)
=====================================================================

```bash
# Landing-ul NU are acces credentialed la aplicație
curl -si -X OPTIONS https://docflowai-app-staging.up.railway.app/api/my-flows \
  -H 'Origin: https://docflowai.ro' -H 'Access-Control-Request-Method: GET' | grep -i access-control
# Așteptat: NICIUN header access-control-*

# Landing-ul are acces la /api/contact, fără credențiale
curl -si -X OPTIONS https://docflowai-app-staging.up.railway.app/api/contact \
  -H 'Origin: https://docflowai.ro' -H 'Access-Control-Request-Method: POST' | grep -i access-control
# Așteptat: access-control-allow-origin: https://docflowai.ro
#           FĂRĂ access-control-allow-credentials
```

**Browser (SW):** login → DevTools → Application → Cache Storage → `docflowai-v284-static`.
Așteptat: doar CSS/JS/imagini/HTML. **Zero** intrări `/api/…`, `/flows/…`, `/auth/…`.
Verifică și că `docflowai-v283-static` **a dispărut**.

**Regresie de verificat manual (nu e acoperită de teste):** creează un flux nou în
`semdoc-initiator`, cu PDF încărcat → confirmă că draftul din IndexedDB **supraviețuiește**
unui refresh. (Ar fi fost distrus de `Clear-Site-Data`, motiv pentru care l-am scos.)

=====================================================================
## ANEXA A — De ce NU folosim `Clear-Site-Data` la logout
=====================================================================

Varianta v1 a acestui prompt propunea `res.set('Clear-Site-Data', '"cache", "storage"')` pe
`POST /auth/logout`. **A fost eliminată. Nu o reintroduce.** Motive:

1. **Nu există variantă îngustă.** Per spec-ul W3C, **Cache Storage** (exact ce folosește SW-ul)
   este acoperit de tipul **`"storage"`**, nu de `"cache"` — `"cache"` vizează doar cache-ul HTTP.
   Deci ca să purjezi cache-ul SW ești obligat să ceri `"storage"`, care ia cu el tot.
2. **Ar distruge date reale de lucru.** `public/js/semdoc-initiator/main.js` salvează **PDF-ul
   încărcat în IndexedDB** (`idb.save(pdfB64)`) și starea formularului în localStorage
   (`saveFormState()`). `"storage"` le șterge pe amândouă — un logout ar arunca un flux în lucru.
   Mai șterge și înregistrarea Service Worker și abonamentul push.
3. **E redundant după fix-ul principal.** După PAS 2, **nimic autentificat nu mai intră vreodată
   în Cache Storage**. Singura valoare rămasă era protecția contra unei regresii viitoare — iar
   asta o dă mult mai bine testul de la **6c**, cu zero risc la runtime.

Dacă vrei purjare totală la logout (politică rezonabilă pentru calculatoare partajate), aceea e o
**decizie de produs separată** („la logout ștergem toate drafturile locale?"), nu un efect
secundar strecurat într-un prompt de securitate. Task separat.

=====================================================================
## RAPORT FINAL
=====================================================================

1. Output-ul **PAS 0** (toate cele 4 precondiții).
2. **Diff-ul**, pe pași (2–6).
3. Output-ul complet al **PAS 7**, inclusiv `git diff --name-only`.
4. **Lista nominală a fixture-urilor reparate** la 6e, cu motivul fiecăruia. Dacă niciunul nu s-a
   rupt, **spune-o explicit** — înseamnă că fallback-ul cross-tenant nu era exercitat de nicio suită.
5. `npm run check` + `npm test`: rezultat și număr final de teste (fără baseline hardcodat).
6. Versiunea nouă, `CACHE_VERSION`, hash-ul commit-ului.
7. **Orice abatere** de la snippet-uri, cu justificare (fișierul e sursa de adevăr, nu promptul).
8. Confirmarea că **NU** ai atins `main` și niciun fișier din NO-TOUCH ZONE.

=====================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
=====================================================================

- ⛔ **BRANCH `develop` EXCLUSIV.** Fără `checkout`/`merge`/`push` pe `main`.
- ⛔ **NO-TOUCH ZONE:** `server/signing/cloud-signing.mjs`, `server/signing/bulk-signing.mjs`,
  `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`,
  `server/signing/providers/STSCloudProvider.mjs`.
- ⛔ **NU** reintroduce niciun fallback de organizație. Fără `org_id` confirmat ⇒ **fără flux**.
- ⛔ **NU** face lookup de utilizator după `email` în `crud.mjs`. Doar `id` + `deleted_at IS NULL`.
- ⛔ **NU** adăuga `Clear-Site-Data` (Anexa A).
- ⛔ **NU** șterge `getDefaultOrgId` din `server/db/index.mjs`.
- ⛔ **NU** slăbi asserțiile testelor existente ca să treacă. Repară fixture-ul.
- ⛔ **NU** face `git stash`, `git reset`, `git checkout -- .` sau orice comandă care pierde
  modificări locale. Dacă tree-ul e murdar la PAS 0 ⇒ oprește-te și raportează.
- ⛔ **CITEȘTE fișierul înainte de fiecare patch.** Nu presupune conținutul.
- ⛔ Fără migrări DB. Fără fișiere `.sql` noi.
