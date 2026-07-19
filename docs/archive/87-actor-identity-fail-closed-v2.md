---
prompt: 87
revizia: v2 (înlocuiește complet v1 — NU rula v1)
titlu: "SECURITATE — identitate actor fail-closed: resolveActor() + invalidarea JWT la schimbarea rolului"
branch: develop
model_suggested: "Opus 4.8 — authz + izolare tenant, 5 fișiere de rute, regresii garantate pe fixture-uri"
depinde_de: prompt 86 (rulat, CI verde, v3.9.666)
urmat_obligatoriu_de: prompt 88 (revocare globală de sesiune) — vezi Anexa B
fisiere_atinse:
  - server/services/actor-identity.mjs                        (FIȘIER NOU)
  - server/routes/admin/users.mjs
  - server/routes/templates.mjs
  - server/routes/flows/crud.mjs
  - server/routes/flows/email.mjs
  - server/routes/totp.mjs
  - server/routes/auth.mjs
  - server/tests/unit/actor-identity.test.mjs                 (FIȘIER NOU)
  - server/tests/integration/actor-identity-routes.test.mjs   (FIȘIER NOU)
  - server/tests/db/email-reuse-ambiguity.test.mjs            (FIȘIER NOU — Postgres real)
  - package.json
  - package-lock.json
versiune: 3.9.666 → 3.9.667
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

> `main` = **PRODUCȚIE**, gestionat **manual, doar de Mircea**. Fără `checkout`/`merge`/`push` pe `main`.

=====================================================================
## PAS 0 — PRECONDIȚII (oprește-te dacă vreuna pică)
=====================================================================

```bash
git status --short
# Fișierele .md de prompt untracked sunt acceptabile. ORICE fișier tracked modificat ⇒ OPREȘTE-TE.
# NU face `git add .`, `git stash`, `git reset`, `git clean`.

git switch develop
git pull --ff-only origin develop
test "$(node -p "require('./package.json').version")" = "3.9.666" || { echo "STOP: baza != 3.9.666"; exit 1; }

# Docker/Postgres pentru testele DB — OBLIGATORIU (vezi PAS 12)
npm run db:test:up
# Dacă eșuează ⇒ OPREȘTE-TE. Acest prompt NU se comite fără test:db cu teste efectiv PASSED.
```

=====================================================================
## CONTEXT
=====================================================================

### Cauza rădăcină

Migrarea **`067_soft_delete_users_orgs`** a înlocuit `UNIQUE(email)` cu un index **parțial**:

```sql
CREATE UNIQUE INDEX users_email_active_uniq ON users (lower(email)) WHERE deleted_at IS NULL;
```

⇒ cel mult **un cont ACTIV** per email, dar **oricâte rânduri soft-deleted** cu același email.
Orice `SELECT ... FROM users WHERE email=$1` **fără `deleted_at IS NULL`**:

- **(a)** email reutilizat ⇒ 2+ rânduri, `rows[0]` fără `ORDER BY` = **nedeterminist**;
- **(b)** actor dezactivat, email nereutilizat ⇒ **un singur rând: cel ȘTERS**, returnat ca valid.

Cazul (b) e **activ azi**, pentru că revocarea de sesiune nu funcționează (Anexa B).

### Situri (toate verificate în cod)

| Fișier:linie | Ce decide | Sever. |
|---|---|---|
| `admin/users.mjs:46` | instituția din dropdown-ul de semnatari | **P0** |
| `admin/users.mjs:117` | **tenantul listei de utilizatori** | **P0** |
| `admin/users.mjs:200` | **organizația în care se creează un cont nou** | **P0** |
| `admin/users.mjs:943` + `:1001` | **garda same-org la administrarea concediului** | **P0** |
| `templates.mjs:26` + `:55` | scoping-ul șabloanelor partajate | **P0** |
| `flows/crud.mjs:263` | **`functie` din CARTUȘUL SEMNĂTURII CALIFICATE** + `flows.data` | **P1** |
| `flows/email.mjs:88` | semnătura expeditorului în emailul extern | **P2** |
| `totp.mjs:185` | emite `auth_token` unui cont dezactivat între parolă și cod | **P1** |
| `auth.mjs:158` | fallback pe email ⇒ atribuie profilul contului NOU cu același email | **P1** |

### ⭐ Constatare nouă: rolul nu invalidează JWT-ul

`PUT /admin/users/:id` construiește `UPDATE users SET ${updates.join(',')} WHERE id=$N`, iar
**`role` e printre câmpurile actualizabile** (linia ~525). Dar `token_version` e incrementat în
`admin/users.mjs` **doar** la reset parolă (`:576`, `:794`), soft-delete (`:631`) și reactivare
(`:715`) — **niciodată la schimbarea rolului**.

⇒ **Retrogradezi un admin la `user`, iar JWT-ul lui păstrează `role: 'admin'` până la 8 ore.**
Un administrator revocat rămâne administrator o zi de lucru. Se repară în PAS 4 + PAS 3.

### Risc de regresie verificat și eliminat

`ADMIN_SECRET` (bypass de autentificare din `requireAdmin`) produce un actor fără `userId`, deci
ar primi `401` de la `resolveActor`. **Dar `admin/users.mjs` nu importă deloc `requireAdmin`** —
toate rutele folosesc `requireAuth` (linia 25 nu îl importă). La fel `templates.mjs`. Bypass-ul
**nu poate atinge** nicio rută din acest prompt. Fără risc.

### În afara scopului (deliberat)

- `crud.mjs:216`/`:284`, `lifecycle.mjs:394/402`, `signing.mjs:529/556` — lookup-uri de **alți
  utilizatori** (delegare, redirect la semnare), zonă **signing-sensitive** ⇒ **prompt 89**.
- `flows/cloud-signing.mjs` — **NO-TOUCH**.
- Map-uri de enrichment / join-uri admin / analytics ⇒ **prompt 90**.
- Revocarea globală în `requireAuth` ⇒ **prompt 88** (Anexa B).

=====================================================================
## PAS 1 — Citește înainte de orice patch
=====================================================================

```bash
sed -n '40,60p;110,125p;190,215p;505,555p;935,960p;993,1015p' server/routes/admin/users.mjs
sed -n '20,40p;48,70p'   server/routes/templates.mjs
sed -n '255,275p'        server/routes/flows/crud.mjs
sed -n '82,98p'          server/routes/flows/email.mjs
sed -n '178,200p'        server/routes/totp.mjs
sed -n '145,180p'        server/routes/auth.mjs
```

=====================================================================
## PAS 2 — `server/services/actor-identity.mjs` (FIȘIER NOU)
=====================================================================

```js
/**
 * DocFlowAI — server/services/actor-identity.mjs
 *
 * SEC-87: sursa UNICĂ de adevăr pentru identitatea actorului autentificat.
 *
 * De ce există:
 *   Migrarea 067_soft_delete_users_orgs a înlocuit UNIQUE(email) cu un index PARȚIAL
 *   (`users_email_active_uniq ON users(lower(email)) WHERE deleted_at IS NULL`), ca să permită
 *   reutilizarea emailului după soft-delete. Consecință: orice
 *   `SELECT ... FROM users WHERE email = $1` fără `deleted_at IS NULL` poate întoarce rândul
 *   unui cont ȘTERS (sau, la email reutilizat, un rând nedeterminist dintre mai multe).
 *   Acele rânduri decideau tenantul, garda same-org și funcția din cartușul PAdES.
 *
 * Contract — FAIL-CLOSED pe fiecare condiție:
 *   1. Lookup EXCLUSIV după `users.id = actor.userId`. NICIODATĂ după email.
 *   2. `deleted_at IS NULL`.
 *   3. `token_version` din DB == `actor.tv` (revocare de sesiune).
 *   4. `role` din DB == `actor.role` (retrogradarea nu bump-uiește token_version — vezi PAS 4).
 *   5. `org_id` din DB == `actor.orgId`, comparație null-aware (sesiune învechită).
 *
 * SQL-ul este STATIC. Fără coloane dinamice — numele de coloane nu pot fi parametrizate,
 * iar un apelant viitor ar putea introduce SQL arbitrar.
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

/** @typedef {{ok:true, user:object}|{ok:false, status:number, error:string, message:string}} ActorIdentity */

/**
 * Rezolvă rândul DB al actorului autentificat, fail-closed.
 * @param {object} actor  payload-ul JWT (din requireAuth)
 * @returns {Promise<ActorIdentity>}
 */
export async function resolveActor(actor) {
  if (!actor?.userId) {
    logger.warn({ email: actor?.email }, 'resolveActor: JWT fără userId — fail-closed');
    return { ok: false, status: 401, error: 'session_identity_invalid',
             message: 'Sesiunea nu mai este validă. Reautentifică-te.' };
  }

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT id, email, nume, functie, compartiment, institutie,
              role, org_id, token_version
         FROM users
        WHERE id = $1
          AND deleted_at IS NULL`,
      [actor.userId]
    );
    row = rows[0] || null;
  } catch (e) {
    logger.error({ err: e, userId: actor.userId }, 'resolveActor: lookup eșuat — fail-closed');
    return { ok: false, status: 503, error: 'identity_lookup_failed',
             message: 'Baza de date este temporar indisponibilă. Reîncearcă în câteva momente.' };
  }

  if (!row) {
    logger.warn({ userId: actor.userId }, 'resolveActor: actor inexistent sau dezactivat — fail-closed');
    return { ok: false, status: 403, error: 'actor_not_found',
             message: 'Contul tău nu a fost găsit sau a fost dezactivat. Reautentifică-te.' };
  }

  // (3) Revocare de sesiune — token_version bump-uit la reset parolă / dezactivare / reactivare.
  const dbTv  = row.token_version ?? 1;
  const jwtTv = actor.tv ?? 1;
  if (Number(jwtTv) !== Number(dbTv)) {
    logger.warn({ userId: actor.userId, jwtTv, dbTv }, 'resolveActor: token revocat — fail-closed');
    return { ok: false, status: 401, error: 'token_revoked',
             message: 'Sesiunea a expirat. Te rugăm să te autentifici din nou.' };
  }

  // (4) Rol învechit. PAS 4 face ca schimbarea rolului să bump-uiască token_version, dar
  //     verificăm și aici: apărare în adâncime pentru JWT-urile emise înainte de acel fix.
  if (actor.role != null && String(actor.role) !== String(row.role ?? '')) {
    logger.warn({ userId: actor.userId, tokenRole: actor.role, dbRole: row.role },
      'resolveActor: rolul din JWT diferă de cel curent — fail-closed');
    return { ok: false, status: 401, error: 'session_role_stale',
             message: 'Permisiunile contului tău s-au modificat. Reautentifică-te.' };
  }

  // (5) Organizație învechită — comparație NULL-AWARE.
  //     Respinge și cazurile asimetrice: JWT are org / DB nu, sau invers.
  //     Super-admin (null în JWT, null în DB) rămâne compatibil ('' === '').
  //     ⚠️ Comparație pe String, NU pe Number: orgId poate fi non-numeric în fixture-uri.
  const tokenOrgId = actor.orgId ?? null;
  const dbOrgId    = row.org_id ?? null;
  if (String(tokenOrgId ?? '') !== String(dbOrgId ?? '')) {
    logger.warn({ userId: actor.userId, tokenOrgId, dbOrgId },
      'resolveActor: organizația din JWT diferă de cea curentă — fail-closed');
    return { ok: false, status: 401, error: 'session_org_stale',
             message: 'Asocierea contului cu instituția s-a modificat. Reautentifică-te.' };
  }

  return { ok: true, user: row };
}

/** Helper de rută: rezolvă sau trimite răspunsul de eroare. Returnează `null` dacă a eșuat. */
export async function resolveActorOr(res, actor) {
  const r = await resolveActor(actor);
  if (!r.ok) { res.status(r.status).json({ error: r.error, message: r.message }); return null; }
  return r.user;
}
```

=====================================================================
## PAS 3 — `admin/users.mjs`: cele 5 situri P0
=====================================================================

Import (adaugă lângă cel existent de la linia 25):
```js
import { resolveActorOr } from '../../services/actor-identity.mjs';
```

### 3a. `:46` — instituția actorului

`old_str`:
```js
    // Citim institutia din DB (nu din JWT care poate fi vechi)
    const { rows: selfRows } = await pool.query('SELECT institutie FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = (selfRows[0]?.institutie || actor.institutie || '').trim();
```
`new_str`:
```js
    // SEC-87: identitatea actorului se rezolvă după users.id, cu deleted_at IS NULL.
    // Lookup-ul după email putea întoarce rândul unui cont ȘTERS (index unic doar parțial).
    const self = await resolveActorOr(res, actor); if (!self) return;
    const institutie = String(self.institutie || '').trim();
```

### 3b. `:117` — tenantul listei

`old_str`:
```js
    // Citim orgId din DB — JWT poate fi vechi
    const { rows: selfRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [user.email.toLowerCase()]);
    const orgId = selfRows[0]?.org_id || null;
```
`new_str`:
```js
    // SEC-87: org-ul actorului se rezolvă după users.id, fail-closed.
    const self = await resolveActorOr(res, user); if (!self) return;
    const orgId = self.org_id || null;
```

### 3c. `:200` — organizația noului cont

`old_str`:
```js
    const { rows: actorOrgRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    insertOrgId = actorOrgRows[0]?.org_id || null;
```
`new_str`:
```js
    // SEC-87: un org_admin nu poate crea utilizatori în organizația altcuiva.
    const selfOA = await resolveActorOr(res, actor); if (!selfOA) return;
    insertOrgId = selfOA.org_id || null;
```

### 3d. `:943` și `:1001` — garda same-org (BLOCURI IDENTICE)

⚠️ Blocurile sunt identice ⇒ `old_str` nu e unic. Extinde-l cu liniile din jur (rutele diferă)
sau aplică patch-ul de două ori, verificând contextul de fiecare dată.

Blocul de înlocuit (în **ambele** rute):
```js
    const { rows: orgRows } = await pool.query(
      `SELECT u_actor.org_id AS actor_org, u_target.org_id AS target_org
       FROM users u_actor
       JOIN users u_target ON u_target.id = $2
       WHERE u_actor.email = $1`,
      [actor.email.toLowerCase(), targetUserId]
    );
    if (!orgRows.length) return res.status(404).json({ error: 'user_not_found' });
```
Înlocuiește cu:
```js
    // SEC-87: garda same-org NU se mai construiește pe un lookup ambiguu după email.
    // Actorul: după users.id (fail-closed). Target-ul: după id, doar dacă e ACTIV.
    const selfLv = await resolveActorOr(res, actor); if (!selfLv) return;
    const { rows: tRows } = await pool.query(
      'SELECT id, org_id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [targetUserId]
    );
    if (!tRows.length) return res.status(404).json({ error: 'user_not_found' });
    const orgRows = [{ actor_org: selfLv.org_id, target_org: tRows[0].org_id }];
```

> ⛔ **PĂSTREAZĂ NESCHIMBATĂ** logica de dedesubt care compară `orgRows[0].actor_org` cu
> `orgRows[0].target_org`, inclusiv orice bypass pentru rolul `admin`. Acest prompt schimbă
> **doar sursa datelor**, NU regula de autorizare. Raportează cum arată regula rămasă.

### 3e. ⭐ `PUT /admin/users/:id` — schimbarea rolului trebuie să invalideze JWT-ul

**Constatare:** `role` e actualizabil, dar `token_version` **nu** e incrementat ⇒ un admin
retrogradat păstrează rolul `admin` în JWT până la 8h.

Localizează blocul care construiește `updates` (în jurul liniei 523):
```js
  if (role) {
    const allowedRolesUpd = actor.role === 'admin' ? ['admin', 'org_admin', 'user'] : ['user'];
    if (allowedRolesUpd.includes(role)) { updates.push(`role=$${i++}`); vals.push(role); }
```

**Cerință:** dacă rolul din body **e permis ȘI diferă de rolul curent din DB**, adaugă în același
`UPDATE`:
```js
updates.push('token_version=COALESCE(token_version,1)+1');
```

Implementare (adaptează la structura reală a funcției — fișierul e sursa de adevăr):
1. **Înainte** de a construi `updates`, citește rolul curent:
   `SELECT role FROM users WHERE id=$1 AND deleted_at IS NULL`.
2. Dacă `role` e prezent, permis, și `String(role) !== String(currentRole)` ⇒ adaugă
   `token_version=COALESCE(token_version,1)+1` la `updates`.
3. **NU** bump-ui când rolul e trimis dar identic — altfel deconectezi utilizatorul degeaba
   la fiecare salvare de profil.
4. **NU** schimba regulile `allowedRolesUpd`.

Adaugă un comentariu:
```js
    // SEC-87: retrogradarea/promovarea trebuie să INVALIDEZE sesiunile active. Fără acest bump,
    // un admin retrogradat păstra `role:'admin'` în JWT până la expirare (JWT_EXPIRES = 8h).
```

=====================================================================
## PAS 4 — `templates.mjs`: 2 situri (`:26`, `:55`)
=====================================================================

Import:
```js
import { resolveActorOr } from '../services/actor-identity.mjs';
```

Ambele situri au **același bloc** (extinde `old_str` cu contextul rutei ca să fie unic):
```js
    const { rows: uRows } = await pool.query('SELECT institutie, org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || '';
    const orgId = uRows[0]?.org_id || actor.orgId || null;
```
Înlocuiește (în **ambele**) cu:
```js
    // SEC-87: scoping-ul șabloanelor partajate se face pe identitatea rezolvată după users.id.
    const self = await resolveActorOr(res, actor); if (!self) return;
    const institutie = self.institutie || '';
    const orgId = self.org_id || null;
```

> ⚠️ Fallback-ul `|| actor.orgId` a fost **eliminat intenționat**: DB-ul e autoritar, iar
> `resolveActor` respinge deja sesiunile cu org învechit (`session_org_stale`).

=====================================================================
## PAS 5 — `flows/crud.mjs:263` — metadata din cartușul PAdES
=====================================================================

⭐ **VARIANTA PREFERATĂ:** blocul de identitate din promptul 86 (`userRow`, `WHERE id=$1 AND
deleted_at IS NULL`) rulează **înainte** de linia 263 în `createFlow`. **Extinde acel `SELECT`**
cu `functie, compartiment, institutie` și **elimină complet** query-ul de la 263, refolosind
`userRow`. Zero query suplimentar.

Doar dacă ordinea din fișier nu permite asta, folosește varianta cu import:
```js
import { resolveActorOr } from '../../services/actor-identity.mjs';
```
`old_str`:
```js
    try {
      const uRes = await pool.query('SELECT functie,compartiment,institutie FROM users WHERE email=$1', [initEmail.toLowerCase()]);
      if (uRes.rows[0]) {
        initFunctie = uRes.rows[0].functie || '';
        initCompartiment = uRes.rows[0].compartiment || '';
        initInstitutie = initInstitutie || uRes.rows[0].institutie || '';
      }
```
`new_str`:
```js
    try {
      // SEC-87: `functie` ajunge în CARTUȘUL SEMNĂTURII CALIFICATE (stampFooterOnPdf) și în
      // flows.data. Lookup-ul după email putea prelua funcția unui cont ȘTERS ⇒ metadata
      // greșită pe un act semnat juridic.
      const selfMeta = await resolveActorOr(res, actor); if (!selfMeta) return;
      {
        initFunctie = selfMeta.functie || '';
        initCompartiment = selfMeta.compartiment || '';
        initInstitutie = initInstitutie || selfMeta.institutie || '';
      }
```

**Raportează care variantă ai ales și de ce.**

=====================================================================
## PAS 6 — `flows/email.mjs:88`
=====================================================================

⚠️ **Adaugă importul** (lipsea în v1 a acestui prompt — `npm run check` ar fi picat):
```js
import { resolveActorOr } from '../../services/actor-identity.mjs';
```

`old_str`:
```js
    const { rows: senderRows } = await pool.query(
      'SELECT nume, functie, institutie, compartiment, email FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const sender = senderRows[0] || {};
```
`new_str`:
```js
    // SEC-87: expeditorul se rezolvă după users.id (fail-closed), nu după email ambiguu.
    const sender = await resolveActorOr(res, actor); if (!sender) return;
```

=====================================================================
## PAS 7 — `totp.mjs:185`
=====================================================================

`old_str`:
```js
      'SELECT id,email,role,org_id,totp_secret,totp_enabled,totp_backup_codes,token_version,nume,functie,institutie,compartiment FROM users WHERE id=$1',
```
`new_str`:
```js
      // SEC-87: dacă utilizatorul e soft-deleted ÎNTRE verificarea parolei și codul TOTP,
      // ruta emitea totuși un auth_token complet. Fail-closed.
      'SELECT id,email,role,org_id,totp_secret,totp_enabled,totp_backup_codes,token_version,nume,functie,institutie,compartiment FROM users WHERE id=$1 AND deleted_at IS NULL',
```

=====================================================================
## PAS 8 — `auth.mjs` `/auth/me`: elimină fallback-ul pe email
=====================================================================

`old_str`:
```js
    if (!row && decoded.email) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL', [decoded.email]);
      row = rows[0] || null;
      if (row) logger.warn({ userId: decoded.userId, email: decoded.email, dbId: row.id }, '[auth/me] User gasit prin email (id mismatch)');
    }
    if (!row) {
      logger.warn({ email: decoded.email }, '[auth/me] User negasit in DB - returnez JWT payload');
      return res.json({
        userId: decoded.userId, email: decoded.email, role: decoded.role,
        orgId: decoded.orgId, nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie
      });
    }
```
`new_str`:
```js
    // SEC-87: fallback-ul pe email a fost ELIMINAT. Dacă tokenul poartă un userId care nu mai
    // există (cont șters), lookup-ul pe email găsea contul NOU care reutilizase acel email și îi
    // atribuia profilul — confuzie de identitate. Emailul e reutilizabil (index unic doar parțial,
    // migrarea 067); `id` nu este.
    // De asemenea: nu mai returnăm payload-ul brut din JWT când utilizatorul lipsește din DB —
    // acela făcea frontend-ul să creadă că un cont dezactivat e încă logat. Fail-closed 401.
    if (!row) {
      logger.warn({ userId: decoded.userId, email: decoded.email },
        '[auth/me] utilizator inexistent sau dezactivat — fail-closed (401)');
      return res.status(401).json({
        error: 'actor_not_found',
        message: 'Contul tău nu a fost găsit sau a fost dezactivat. Reautentifică-te.',
      });
    }
```

> ⚠️ **RAPORTEAZĂ (nu modifica):** ce face frontend-ul la `401` pe `/auth/me`? Verifică
> `public/js/df-shell.js` și `public/js/admin/admin.js`. Dacă **nu** redirectează la `/login`,
> semnalează-l ca follow-up obligatoriu. **NU** atinge frontend-ul în acest prompt.

=====================================================================
## PAS 9 — `package.json`: `npm run check`
=====================================================================

Adaugă `&& node --check server/services/actor-identity.mjs` în scriptul `check`.

=====================================================================
## PAS 10 — Teste (mock)
=====================================================================

### 10a. `server/tests/unit/actor-identity.test.mjs` (NOU)

Mock `pool` + `logger`. Cazuri pe `resolveActor(actor)`:

| # | Situație | Așteptat |
|---|---|---|
| 1 | JWT fără `userId` | `401 session_identity_invalid`; `pool.query` **NU** a fost chemat |
| 2 | `pool.query` respinge | `503 identity_lookup_failed` |
| 3 | `rows: []` (inexistent/soft-deleted) | `403 actor_not_found` |
| 4 | `tv` JWT ≠ `token_version` DB | `401 token_revoked` |
| 5 | `role` JWT (`admin`) ≠ `role` DB (`user`) | `401 session_role_stale` |
| 6 | JWT `orgId: 5`, DB `org_id: null` | `401 session_org_stale` (null-aware) |
| 7 | JWT `orgId: null`, DB `org_id: 5` | `401 session_org_stale` (null-aware) |
| 8 | JWT `orgId: null`, DB `org_id: null` (super-admin) | `ok: true` |
| 9 | JWT `orgId: 'org1'`, DB `org_id: 'org1'` | `ok: true` (comparație pe String) |
| 10 | Totul se potrivește | `{ok:true, user}` |

**Caz 11 — regresie SQL.** ⚠️ SQL-ul conține legitim cuvântul `email` (e o coloană în `SELECT`).
Testul trebuie să verifice **doar predicatul de identificare**:
```js
const sql = pool.query.mock.calls[0][0];
expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/i);
expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
expect(sql).not.toMatch(/WHERE\s+(?:lower\s*\(\s*)?email/i);
expect(sql).not.toMatch(/AND\s+(?:lower\s*\(\s*)?email/i);
```

### 10b. `server/tests/integration/actor-identity-routes.test.mjs` (NOU)

Structura de `vi.mock` ESM din `server/tests/integration/flows.test.mjs`.

- `GET /users` — actor soft-deleted ⇒ **403**, fără listă.
- `GET /admin/users` — actor soft-deleted ⇒ **403**; actor valid ⇒ listă scoped pe `org_id`-ul **din DB**.
- `POST /admin/users` (org_admin) — noul cont primește `org_id`-ul **din DB**, nu din JWT.
- `PUT /admin/users/:id/leave` — actor org A, target org B ⇒ **403** cross-tenant.
- `PUT /admin/users/:id` — schimbarea rolului ⇒ `UPDATE` conține `token_version=COALESCE(token_version,1)+1`.
- `PUT /admin/users/:id` — **același** rol retrimis ⇒ **FĂRĂ** bump (nu deconectăm degeaba).
- `GET /api/templates` — actor soft-deleted ⇒ **403**.
- `POST /flows` — `functie`/`compartiment` din `flows.data` vin din rândul **activ**.
- `POST /auth/totp/verify` — user soft-deleted între parolă și cod ⇒ **fără `auth_token`**.
- `GET /auth/me` — token cu `userId` inexistent ⇒ **401**; **NU** payload-ul JWT, **NU** profilul
  altui cont cu același email.
- **Rol învechit:** JWT `role:'admin'`, DB `role:'user'` ⇒ **401 `session_role_stale`**.

=====================================================================
## PAS 11 — Test Postgres REAL (obligatoriu)
=====================================================================

### `server/tests/db/email-reuse-ambiguity.test.mjs` (NOU)

Rulează prin `npm run test:db` (`vitest.config.db.mjs`, Postgres 16 real). **Cu mock-uri bug-ul
original nu poate fi reprodus** — de asta e obligatoriu.

**Fixture — FĂRĂ ID-uri hardcodate.** Folosește `RETURNING id` și păstrează valorile; curăță cu
`TRUNCATE ... RESTART IDENTITY CASCADE` în `beforeEach`/`afterEach`, conform pattern-ului existent
din `server/tests/db/` (vezi `formular-flow-attachments-copy.test.mjs`).

```
users:
  A: email='ion@zarnesti.ro'  org_id=1  functie='Inspector'    deleted_at=NOW()   -- ȘTERS
  B: email='ion@zarnesti.ro'  org_id=2  functie='Sef Serviciu' deleted_at=NULL    -- ACTIV
```
(Indexul parțial permite asta: un singur ACTIV per email.)

**Cazuri:**
1. Query-ul **vechi** (`SELECT ... WHERE email=$1`, fără filtru) întoarce **2 rânduri** — dovada ambiguității.
2. `resolveActor({userId: idB, tv, role, orgId: 2})` ⇒ `org_id=2`, `functie='Sef Serviciu'` —
   determinist, indiferent de ordinea fizică.
3. `resolveActor({userId: idA, ...})` (contul șters) ⇒ **403 `actor_not_found`**.
4. Un al treilea rând soft-deleted cu același email ⇒ rezultatul **nu se schimbă**.
5. Email cu majuscule (`'Ion@Zarnesti.ro'`) nu rupe lookup-ul (identitatea e pe `id`).

=====================================================================
## PAS 12 — Verificare
=====================================================================

```bash
# ── Zero lookup-uri de actor după email ──
grep -n "FROM users WHERE email" server/routes/admin/users.mjs server/routes/templates.mjs server/routes/flows/email.mjs
# Așteptat: NICIUN rezultat
grep -n "u_actor.email" server/routes/admin/users.mjs
# Așteptat: NICIUN rezultat
grep -n "SELECT functie,compartiment,institutie FROM users WHERE email" server/routes/flows/crud.mjs
# Așteptat: NICIUN rezultat
grep -n "User gasit prin email" server/routes/auth.mjs
# Așteptat: NICIUN rezultat
grep -n "totp_secret.*deleted_at IS NULL" server/routes/totp.mjs
# Așteptat: 1 rezultat

# ── Reziduuri lăsate DELIBERAT (prompt 89) — confirmă că sunt EXACT acestea ──
grep -n "users WHERE email" server/routes/flows/crud.mjs
# Raportează numărul exact și liniile

# ── Calitate ──
npm run check
npm test
npm run test:db      # ⛔ POARTĂ DURĂ — vezi mai jos
git diff --check
```

### ⛔ POARTA `test:db` — „skipped ≠ passed"

`CLAUDE.md` documentează incidentul: *„a trecut prin skip două commit-uri la rând, apoi a picat la
primul push în CI."* Fără `TEST_DATABASE_URL`, `test:db` face auto-skip și **iese 0** — verde fals.

**Dacă `npm run test:db` nu raportează teste efectiv PASSED (Docker indisponibil, skip, 0 teste
rulate) ⇒ OPREȘTE-TE ÎNAINTE de commit și push. Raportează. Nu comite.**
Acest prompt atinge izolarea tenantului și autentificarea — nu se comite pe verde-prin-skip.

### ⛔ POARTA DE COMMIT — fișiere noi sunt UNTRACKED

⚠️ `git diff --name-only` **NU arată fișiere untracked** (cele 4 fișiere noi ale acestui prompt).
Poarta trebuie să fie pe **index**, nu pe working tree:

```bash
git status --short          # vezi TOT, inclusiv untracked

git add -- \
  server/services/actor-identity.mjs \
  server/routes/admin/users.mjs \
  server/routes/templates.mjs \
  server/routes/flows/crud.mjs \
  server/routes/flows/email.mjs \
  server/routes/totp.mjs \
  server/routes/auth.mjs \
  server/tests/unit/actor-identity.test.mjs \
  server/tests/integration/actor-identity-routes.test.mjs \
  server/tests/db/email-reuse-ambiguity.test.mjs \
  package.json \
  package-lock.json
# + fixture-urile reparate, NOMINAL (ex.: git add -- server/tests/integration/flows.test.mjs)
# ⛔ NICIODATĂ `git add .`

git diff --cached --name-only
git diff --cached --check
git diff --cached --stat
```

Dacă în index apare **orice** fișier care nu e în `fisiere_atinse` sau în lista de fixture-uri
raportate nominal, ori **orice** fișier din NO-TOUCH ZONE ⇒ **OPREȘTE-TE. Fără commit. Fără push.**

Criteriu pe teste: **zero eșecuri, zero skip-uri noi față de baseline, toate testele noi executate,
`test:db` cu teste PASSED.** Raportează numărul final. **Fără baseline hardcodat.**

=====================================================================
## PAS 13 — Version bump + commit
=====================================================================

`CLAUDE.md:355`: *„Railway folosește `npm ci` — `package.json` și `package-lock.json` trebuie
sincronizate întotdeauna."* Folosește comanda care le actualizează pe **amândouă**:

```bash
npm version 3.9.667 --no-git-tag-version
```

> ℹ️ **Notă:** `package-lock.json` e în prezent la `3.9.595`, iar `package.json` la `3.9.666` —
> derivă de ~70 de versiuni, iar `npm ci` a mers (verifică sincronizarea **arborelui de
> dependențe**, nu câmpul `version`). Deci **nu e blocant**, dar `npm version` repară deriva.
> Va produce un diff pe `package-lock.json` — **este așteptat și corect**. Nu instala pachete noi.

```bash
git commit -m "sec: identitate actor fail-closed prin resolveActor() (users.id + deleted_at + token_version + rol + org); invalidare JWT la schimbarea rolului; anti cross-tenant in admin/users, templates, crud, email, totp, auth/me (v3.9.667)"
git push origin develop
npm run db:test:down
```

=====================================================================
## ANEXA A — Fixture-uri care se VOR rupe (așteptat)
=====================================================================

`resolveActor` verifică **patru** condiții pe care testele existente probabil nu le satisfac:
`deleted_at IS NULL`, `token_version`, `role`, `org_id`.

Simptome tipice:
- Token de test fără `tv` ⇒ `actor.tv ?? 1` = 1; mock-ul DB trebuie să întoarcă `token_version: 1`.
- Mock-ul DB nu întoarce `role` ⇒ `row.role` = `undefined` ⇒ `session_role_stale`. Adaugă `role`.
- Mock-ul DB întoarce `org_id: 1` dar JWT-ul are `orgId: 'org1'` ⇒ `session_org_stale`. **Aliniază fixture-ul.**
- Mock-ul DB nu întoarce deloc rândul actorului ⇒ `403`.

⛔ **REGULA: REPARĂ FIXTURE-UL, NU COMPORTAMENTUL.** Nu slăbi asserțiile. Nu șterge teste.
Raportează **nominal** fiecare fișier de test atins și motivul.

=====================================================================
## ANEXA B — Ce NU rezolvă acest prompt (⇒ prompt 88)
=====================================================================

`checkTokenVersionValid()` (`server/middleware/auth.mjs:111`) are **ZERO apelanți**:
```bash
grep -rn "checkTokenVersionValid" server/ | grep -v tests | grep -v "export async"
# → niciun rezultat
```
`injectTokenVersionChecker` **este** cablat (`index.mjs:1540`), soft-delete-ul **bump-uiește**
corect `token_version` (`admin/users.mjs:631`) — dar nimeni nu verifică. `token_version` e validat
**doar inline**, în `/auth/me` și `/auth/refresh`.

⇒ **Un cont dezactivat păstrează `auth_token` funcțional până la 8h pe TOATE celelalte rute** —
semnare, ALOP, ștergere fluxuri. `requireAuth` verifică doar semnătura JWT.

Promptul 87 închide gaura **doar pe rutele care apelează `resolveActor`**. Semnarea, ALOP-ul și
formularele rămân expuse.

⇒ **Promptul 88 (revocare globală în `requireAuth`, cu cache scurt) e OBLIGATORIU și imediat.**
Nu-l implementa aici: atinge fiecare cerere autentificată și merită diff, teste și deploy proprii.

=====================================================================
## RAPORT FINAL
=====================================================================

1. Output-ul **PAS 0** (inclusiv `db:test:up`).
2. **Diff-ul**, pe pași (2–9).
3. **PAS 3d:** cum arată regula de autorizare rămasă (bypass super-admin?) — confirmă că **nu ai schimbat-o**.
4. **PAS 3e:** cum ai detectat schimbarea de rol; confirmă că un rol identic **nu** produce bump.
5. **PAS 5:** ai refolosit `userRow` din promptul 86 sau ai adăugat un query? De ce?
6. **PAS 8:** ce face frontend-ul la `401` pe `/auth/me`? (doar raportează)
7. Output-ul complet al **PAS 12**, inclusiv `git status --short`, `git diff --cached --name-only`,
   numărul exact de reziduuri `WHERE email` rămase în `crud.mjs`, și **dovada că `test:db` a rulat
   teste PASSED** (nu skip).
8. **Lista nominală** a fixture-urilor reparate (Anexa A), cu motivul fiecăruia.
9. `npm run check`, `npm test`, `npm run test:db`: rezultate + număr final de teste.
10. Versiune + hash commit + confirmarea că `package-lock.json` a fost actualizat.
11. **Orice abatere** de la snippet-uri, cu justificare (fișierul e sursa de adevăr, nu promptul).
12. Confirmarea că **NU** ai atins `main` și niciun fișier din NO-TOUCH ZONE.

=====================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
=====================================================================

- ⛔ **BRANCH `develop` EXCLUSIV.**
- ⛔ **NO-TOUCH ZONE:** `server/signing/cloud-signing.mjs`, `server/signing/bulk-signing.mjs`,
  `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`,
  `server/signing/providers/STSCloudProvider.mjs`, **și `server/routes/flows/cloud-signing.mjs`**
  (are lookup-uri după email — NU le atinge aici).
- ⛔ **NU** atinge `crud.mjs:216`/`:284`, `lifecycle.mjs`, `signing.mjs` — signing-sensitive ⇒ prompt 89.
- ⛔ **NU** schimba regulile de autorizare (cine are voie ce). Schimbi **doar sursa identității**.
- ⛔ **NU** construi SQL cu nume de coloane dinamice. SQL-ul din `resolveActor` e **static**.
- ⛔ **NU** reintroduce niciun fallback pe email pentru identitatea actorului.
- ⛔ **NU** implementa revocarea globală de sesiune aici (Anexa B ⇒ prompt 88).
- ⛔ **NU** modifica frontend-ul. Dacă `401` pe `/auth/me` rupe UX-ul ⇒ **raportează**.
- ⛔ **NU** comite pe `test:db` sărit. Skipped ≠ passed.
- ⛔ **NU** face `git add .`, `git stash`, `git reset`, `git clean`, `git checkout -- .`.
- ⛔ **NU** slăbi asserțiile testelor existente. Repară fixture-ul.
- ⛔ **CITEȘTE fișierul înainte de fiecare patch.**
- ⛔ Fără migrări DB. Fără fișiere `.sql` noi. Fără pachete npm noi.
