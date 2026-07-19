---
prompt: 87
revizia: final-v3
titlu: "SECURITATE — identitatea actorului fail-closed: users.id + cont activ + tenant + rol + token_version"
branch: develop
model_suggested: "gpt-5.6 / Opus — authz, multi-tenant, sesiuni și teste PostgreSQL reale"
depinde_de:
  - prompt 86 aplicat
  - CI verde
  - versiune de bază 3.9.666
urmat_obligatoriu_de:
  - prompt 88 — revocarea globală a sesiunii în requireAuth și bump atomic la schimbarea rolului
promovare_productie:
  - "Prompturile 87 și 88 NU se promovează separat în main."
fisiere_principale_permisen:
  - server/services/actor-identity.mjs
  - server/routes/admin/users.mjs
  - server/routes/templates.mjs
  - server/routes/flows/crud.mjs
  - server/routes/flows/email.mjs
  - server/routes/totp.mjs
  - server/routes/auth.mjs
  - server/tests/unit/actor-identity.test.mjs
  - server/tests/integration/actor-identity-routes.test.mjs
  - server/tests/db/user-email-reuse-authz.test.mjs
  - server/tests/integration/users-list-exclude-deleted.test.mjs
  - server/tests/unit/templates.test.mjs
  - package.json
  - package-lock.json
versiune:
  de_la: 3.9.666
  la: 3.9.667
---

# ⚠️ BRANCH `develop` EXCLUSIV

`main` este PRODUCȚIE și este gestionat manual, exclusiv de Mircea.

Interdicții absolute:

- NU face checkout/merge/push pe `main`.
- NU folosi `git add .`, `git add -A` sau staging global.
- NU folosi `git stash`, `git reset --hard`, `git clean`, `git checkout -- .` ori force-push.
- NU modifica secrete, `.env`, date reale, Railway sau baza de producție.
- NU modifica fișierele din NO-TOUCH ZONE.
- NU declara taskul încheiat dacă testele PostgreSQL reale au fost doar `skipped`.

Acest prompt este pentru Windows + PowerShell. Folosește `npm.cmd` și `npx.cmd`, nu `npm`/`npx`,
deoarece politica PowerShell poate bloca scripturile `.ps1`.

=====================================================================
## 0. SCOPUL EXACT
=====================================================================

Migrarea `067_soft_delete_users_orgs` a înlocuit unicitatea totală pe email cu:

```sql
CREATE UNIQUE INDEX users_email_active_uniq
ON users (lower(email))
WHERE deleted_at IS NULL;
```

Consecință:

- poate exista un singur cont ACTIV pentru un email;
- pot exista oricâte conturi SOFT-DELETED cu același email;
- `SELECT ... FROM users WHERE email=$1` fără `deleted_at IS NULL` poate întoarce mai multe rânduri;
- `rows[0]` fără `ORDER BY` este nedeterminist;
- un JWT vechi poate păstra `role`, `orgId` și `tv` diferite de starea curentă din DB.

Acest prompt introduce o sursă unică de identitate a actorului autentificat:

```text
JWT semnat
→ users.id = actor.userId
→ deleted_at IS NULL
→ token_version egal
→ org_id egal
→ role egal
→ abia apoi autorizare și operațiunea business
```

Se repară numai actorul autentificat și rutele enumerate mai jos.

### În scope

1. `GET /users`
2. `GET /admin/users`
3. `POST /admin/users`
4. `PUT /api/users/me/leave`
5. `DELETE /api/users/me/leave`
6. `PUT /admin/users/:id/leave`
7. `DELETE /admin/users/:id/leave`
8. `GET /api/templates`
9. `POST /api/templates`
10. metadata actorului la `POST /flows`
11. expeditorul din ruta de email extern a fluxului
12. `POST /auth/totp/verify`
13. `GET /auth/me`

### În afara scope-ului — NU modifica

- schimbarea globală a rolului și bump-ul `token_version` în `PUT /admin/users/:id` — prompt 88;
- verificarea globală a sesiunii în `requireAuth` — prompt 88;
- delegarea/redirectul altor utilizatori din `crud.mjs`, `lifecycle.mjs`, `signing.mjs` — prompt 89;
- analytics, audit, cleanup, map-uri și join-uri istorice — prompt 90;
- lookup-urile din cloud signing — NO-TOUCH;
- schema DB și migrările aplicate;
- PDF-uri deja semnate.

=====================================================================
## 1. NO-TOUCH ZONE
=====================================================================

Nu modifica sub nicio formă:

```text
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/cloud-signing.mjs
server/signing/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/routes/flows/signing.mjs
server/routes/flows/lifecycle.mjs
```

Nu modifica:

- hash-uri;
- ByteRange;
- CMS;
- PKCE/OAuth STS;
- câmpuri iText;
- callback-uri de semnare;
- PDF-uri deja semnate;
- geometria cartușelor;
- logica delegării altor semnatari.

=====================================================================
## 2. PASUL 0 — PRECONDIȚII
=====================================================================

Rulează exact, read-only:

```powershell
git status --porcelain
git branch --show-current
git status -sb
node -p "require('./package.json').version"
git log -3 --oneline
```

Așteptări:

- working tree curat;
- branch `develop`;
- versiune `3.9.666`;
- este permis ca branch-ul să fie `ahead 1` prin commitul local `AGENTS.md`;
- nu sunt permise modificări tracked sau untracked neprevăzute.

Apoi:

```powershell
git pull --ff-only origin develop
```

Verifică din nou:

```powershell
$version = node -p "require('./package.json').version"
if ($version -ne "3.9.666") {
  throw "STOP: versiunea de bază este $version, nu 3.9.666"
}
```

Dacă working tree-ul nu este curat, branch-ul nu este `develop`, pull-ul nu este fast-forward
sau versiunea nu este 3.9.666:

**OPREȘTE-TE. Nu modifica nimic. Raportează.**

=====================================================================
## 3. CITEȘTE ÎNAINTE DE PATCH
=====================================================================

Citește integral:

```text
AGENTS.md
CLAUDE.md
server/middleware/auth.mjs
server/routes/admin/users.mjs
server/routes/templates.mjs
server/routes/flows/crud.mjs
server/routes/flows/email.mjs
server/routes/totp.mjs
server/routes/auth.mjs
server/tests/integration/users-list-exclude-deleted.test.mjs
server/tests/unit/templates.test.mjs
server/tests/integration/flows.test.mjs
server/tests/integration/login.test.mjs
server/tests/helpers/db-real.mjs
vitest.config.mjs
vitest.config.db.mjs
package.json
package-lock.json
```

Înainte de fiecare modificare, recitește blocul exact din fișier.

Nu presupune că numerele de linie din audit sunt încă identice.

=====================================================================
## 4. SERVICIU NOU — `server/services/actor-identity.mjs`
=====================================================================

Creează un helper cu SQL FIX, fără listă dinamică de coloane.

### Contract obligatoriu

`resolveActor(actor)`:

1. cere `actor.userId`;
2. caută exclusiv după `users.id`;
3. cere `deleted_at IS NULL`;
4. recitește rolul și tenantul curent din DB;
5. compară `actor.tv` cu `users.token_version`;
6. compară null-aware `actor.orgId` cu `users.org_id`;
7. compară `actor.role` cu `users.role`;
8. nu face niciodată fallback pe email;
9. orice eroare/mismatch este fail-closed;
10. nu construiește SQL din valori sau nume de coloane venite prin opțiuni.

### Implementare cerută

```js
/**
 * DocFlowAI — identitatea autoritară a actorului autentificat.
 *
 * Emailul este reutilizabil după soft-delete. ID-ul utilizatorului nu este.
 * Autorizarea se face numai după confirmarea stării curente din DB.
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

/**
 * @typedef {{
 *   ok: true,
 *   user: {
 *     id: number|string,
 *     email: string,
 *     nume?: string,
 *     functie?: string,
 *     compartiment?: string,
 *     institutie?: string,
 *     role: string,
 *     org_id: number|string|null,
 *     token_version: number,
 *     force_password_change?: boolean
 *   }
 * } | {
 *   ok: false,
 *   status: number,
 *   error: string,
 *   message: string
 * }} ActorIdentityResult
 */

/**
 * @param {object|null|undefined} actor
 * @returns {Promise<ActorIdentityResult>}
 */
export async function resolveActor(actor) {
  if (!actor?.userId) {
    logger.warn(
      { email: actor?.email },
      'resolveActor: JWT fără userId — fail-closed'
    );

    return {
      ok: false,
      status: 401,
      error: 'session_identity_invalid',
      message: 'Sesiunea nu mai este validă. Reautentifică-te.',
    };
  }

  let row;

  try {
    const { rows } = await pool.query(
      `SELECT id,
              email,
              nume,
              functie,
              compartiment,
              institutie,
              role,
              org_id,
              token_version,
              force_password_change
         FROM users
        WHERE id = $1
          AND deleted_at IS NULL`,
      [actor.userId]
    );

    row = rows[0] || null;
  } catch (err) {
    logger.error(
      { err, userId: actor.userId },
      'resolveActor: lookup DB eșuat — fail-closed'
    );

    return {
      ok: false,
      status: 503,
      error: 'identity_lookup_failed',
      message:
        'Baza de date este temporar indisponibilă. Reîncearcă în câteva momente.',
    };
  }

  if (!row) {
    logger.warn(
      { userId: actor.userId },
      'resolveActor: actor inexistent sau dezactivat — fail-closed'
    );

    return {
      ok: false,
      status: 403,
      error: 'actor_not_found',
      message:
        'Contul tău nu a fost găsit sau a fost dezactivat. Reautentifică-te.',
    };
  }

  const jwtTv = Number(actor.tv ?? 1);
  const dbTv = Number(row.token_version ?? 1);

  if (!Number.isFinite(jwtTv) || !Number.isFinite(dbTv) || jwtTv !== dbTv) {
    logger.warn(
      { userId: actor.userId, jwtTv: actor.tv, dbTv: row.token_version },
      'resolveActor: token_version diferit — fail-closed'
    );

    return {
      ok: false,
      status: 401,
      error: 'token_revoked',
      message: 'Sesiunea a expirat. Reautentifică-te.',
    };
  }

  const tokenOrgId = actor.orgId ?? null;
  const dbOrgId = row.org_id ?? null;

  if (String(tokenOrgId ?? '') !== String(dbOrgId ?? '')) {
    logger.warn(
      { userId: actor.userId, tokenOrgId, dbOrgId },
      'resolveActor: organizația JWT diferă de DB — fail-closed'
    );

    return {
      ok: false,
      status: 401,
      error: 'session_org_stale',
      message:
        'Asocierea contului cu instituția s-a modificat. Reautentifică-te.',
    };
  }

  const tokenRole = String(actor.role || '');
  const dbRole = String(row.role || '');

  if (!tokenRole || tokenRole !== dbRole) {
    logger.warn(
      { userId: actor.userId, tokenRole, dbRole },
      'resolveActor: rolul JWT diferă de DB — fail-closed'
    );

    return {
      ok: false,
      status: 401,
      error: 'session_role_stale',
      message:
        'Drepturile contului s-au modificat. Reautentifică-te.',
    };
  }

  return { ok: true, user: row };
}

/**
 * Helper pentru rute.
 * Trimite răspunsul standard și returnează null dacă identitatea nu este validă.
 */
export async function resolveActorOr(res, actor) {
  const result = await resolveActor(actor);

  if (!result.ok) {
    res.status(result.status).json({
      error: result.error,
      message: result.message,
    });
    return null;
  }

  return result.user;
}
```

### Reguli

- Nu adăuga `opts.columns`.
- Nu interpolă nume de coloane.
- Nu verifica identitatea prin email.
- Nu slăbi verificarea rolului.
- Nu transforma mismatch-ul de rol într-un simplu warning.
- `null` JWT org și `null` DB org sunt compatibile.
- `null` pe o parte și valoare pe cealaltă sunt mismatch.

=====================================================================
## 5. ORDINEA OBLIGATORIE ÎN RUTE
=====================================================================

Pentru orice rută atinsă:

```text
requireAuth
→ resolveActorOr
→ autorizare folosind EXCLUSIV actorul DB
→ operațiunea business
```

Este interzis:

```text
requireAuth
→ autorizare pe actor.role din JWT
→ resolveActorOr
```

Pattern:

```js
const tokenActor = requireAuth(req, res);
if (!tokenActor) return;

const actor = await resolveActorOr(res, tokenActor);
if (!actor) return;

// de aici în jos:
// actor.role
// actor.org_id
// actor.id
// actor.email
// sunt valorile autoritare din DB.
```

După rezolvare:

- folosește `actor.id`, nu `tokenActor.userId`;
- folosește `actor.org_id`, nu `tokenActor.orgId`;
- folosește `actor.role`, nu `tokenActor.role`;
- folosește `actor.email`, nu emailul din body/JWT;
- nu reciti actorul încă o dată după email.

=====================================================================
## 6. `server/routes/admin/users.mjs`
=====================================================================

Adaugă:

```js
import { resolveActorOr } from '../../services/actor-identity.mjs';
```

### 6.1 `GET /users`

Problema actuală:

- actorul este identificat după email;
- lista poate fi filtrată numai după `institutie`;
- există fallback global;
- un rând soft-deleted poate schimba instituția/tenantul.

Implementare:

1. `requireAuth`;
2. `resolveActorOr`;
3. pentru `user` și `org_admin`:
   - `actor.org_id` este obligatoriu;
   - lista este limitată obligatoriu prin `org_id`;
   - dacă se păstrează și instituția, filtrul trebuie să fie:

```sql
WHERE org_id = $1
  AND institutie = $2
  AND deleted_at IS NULL
```

   Nu este permis `institutie=$1` fără `org_id`.

4. elimină fallback-ul global pentru `user` și `org_admin`;
5. pentru `admin`, păstrează numai comportamentul global care există explicit în cod/teste;
6. dacă nu există o ramură explicită de super-admin, nu inventa una;
7. rezultatul nu poate conține utilizatori activi din alt `org_id`.

### 6.2 `GET /admin/users`

1. rezolvă actorul înainte de `isAdminOrOrgAdmin`;
2. apelează `isAdminOrOrgAdmin(actor)` cu actorul DB;
3. pentru `org_admin`, folosește exclusiv `actor.org_id`;
4. pentru `admin`, păstrează comportamentul global existent;
5. include_deleted nu poate extinde un `org_admin` în alt tenant.

### 6.3 `POST /admin/users`

1. rezolvă actorul înainte de autorizare;
2. calculează `allowedRoles` folosind `actor.role` din DB;
3. pentru `org_admin`, `insertOrgId = actor.org_id`;
4. un `org_admin` nu poate furniza/forța alt `org_id`;
5. mismatch/stale/deleted produce răspuns înainte de:
   - PBKDF2;
   - INSERT;
   - GWS;
   - email/notificări.

Nu modifica încă logica generală a `PUT /admin/users/:id` care schimbă rolul.
Aceasta aparține promptului 88.

### 6.4 Self leave

Rute:

```text
PUT    /api/users/me/leave
DELETE /api/users/me/leave
```

Reguli:

1. `requireAuth`;
2. `resolveActorOr`;
3. `targetUserId = actor.id`;
4. nu executa niciun `SELECT id FROM users WHERE email=$1`;
5. orice validare/audit folosește actorul DB;
6. contul soft-deleted sau sesiunea stale este refuzată înainte de mutație.

### 6.5 Concedii administrate

Rute:

```text
PUT    /admin/users/:id/leave
DELETE /admin/users/:id/leave
```

Reguli:

1. `requireAuth`;
2. `resolveActorOr`;
3. autorizare cu `actor.role` DB;
4. citește targetul:

```sql
SELECT id, org_id
FROM users
WHERE id = $1
  AND deleted_at IS NULL
```

5. păstrează semantica actuală:
   - super-admin `admin` își păstrează bypass-ul explicit existent;
   - `org_admin` poate modifica numai target din același tenant;
6. compară ID-urile de organizație în mod type-safe, de exemplu prin `String(...)`;
7. nu modifica alte reguli de concediu;
8. target soft-deleted → 404/user_not_found;
9. nu construi garda same-org prin `u_actor.email`.

### 6.6 Nu modifica în acest prompt

- rol update/bump;
- bulk import;
- onboarding;
- recovery;
- startup admin recovery;
- logica delegării semnăturii.

=====================================================================
## 7. `server/routes/templates.mjs`
=====================================================================

Adaugă:

```js
import { resolveActorOr } from '../services/actor-identity.mjs';
```

Pentru `GET /api/templates` și `POST /api/templates`:

1. `requireAuth`;
2. `resolveActorOr`;
3. folosește:
   - `actor.email`;
   - `actor.institutie`;
   - `actor.org_id`;
4. șabloanele shared se filtrează/inseră exclusiv în `actor.org_id`;
5. nu există fallback pe JWT;
6. nu există lookup actor după email;
7. actor deleted/stale → fail-closed.

### Limitare cunoscută, fără migrare în promptul 87

`templates.user_email` poate identifica șabloanele personale după email.
După reutilizarea unui email, există posibilitatea ca noul cont să vadă șabloane personale istorice.

În acest prompt:

- NU adăuga migrare;
- NU schimba schema;
- NU rescrie ownership-ul istoric;
- raportează explicit această limitare ca follow-up separat.

=====================================================================
## 8. `server/routes/flows/crud.mjs`
=====================================================================

Adaugă:

```js
import { resolveActorOr } from '../../services/actor-identity.mjs';
```

### Cerința principală

Folosește o singură rezolvare autoritară a actorului.

Varianta preferată:

1. după `requireAuth`, apelează `resolveActorOr`;
2. folosește rândul întors pentru:
   - `initName`;
   - `initEmail`;
   - `orgId`;
   - `initFunctie`;
   - `initCompartiment`;
   - `initInstitutie`;
3. elimină query-ul separat:

```sql
SELECT functie, compartiment, institutie
FROM users
WHERE email=$1
```

4. elimină orice query redundant al actorului după email;
5. păstrează:
   - `user_without_org` pentru actor tenant-scoped fără org;
   - identitatea ÎNTOCMIT blocată la actor;
   - footer-ul și cartușul existente;
   - comportamentul PDF pre-signed;
   - toate regulile din promptul 86.

### Important

Nu atinge:

- lookup-ul primului semnatar/delegat;
- `crud.mjs` blocurile signing-sensitive indicate în audit;
- `getActiveSigner`;
- `padesRect`;
- orice call-site de semnare.

### Metadata oficială

Funcția/compartimentul/instituția care ajung în:

- `stampFooterOnPdf`;
- `flows.data`;
- cartușul ÎNTOCMIT;
- notificări ulterioare;

trebuie să provină exclusiv din rândul DB activ al actorului.

Nu rescrie și nu repară retroactiv PDF-uri deja semnate.

=====================================================================
## 9. `server/routes/flows/email.mjs`
=====================================================================

Adaugă importul lipsă:

```js
import { resolveActorOr } from '../../services/actor-identity.mjs';
```

În ruta de trimitere email extern:

1. `requireAuth`;
2. `resolveActorOr`;
3. sender = actorul DB;
4. elimină:

```sql
SELECT nume, functie, institutie, compartiment, email
FROM users
WHERE email=$1
```

5. păstrează neschimbate:
   - destinatarii;
   - template-ul emailului;
   - tracking-ul;
   - rate limiting;
   - logica de flow access.

=====================================================================
## 10. `server/routes/totp.mjs`
=====================================================================

În `POST /auth/totp/verify`:

1. `pending_token` trebuie să conțină `userId`;
2. query-ul devine:

```sql
SELECT id,
       email,
       role,
       org_id,
       totp_secret,
       totp_enabled,
       totp_backup_codes,
       token_version,
       nume,
       functie,
       institutie,
       compartiment
FROM users
WHERE id = $1
  AND deleted_at IS NULL
```

3. zero rânduri:
   - 401;
   - niciun `auth_token`;
   - nu seta cookie complet;
4. compară pending payload cu DB:
   - `userId`;
   - `orgId` null-aware;
   - `role`;
   - `tv/token_version`;
5. orice mismatch:
   - 401;
   - niciun cookie complet;
6. abia după aceste verificări validează codul și emite `auth_token`;
7. nu modifica algoritmul TOTP sau backup codes în afara condițiilor necesare.

=====================================================================
## 11. `server/routes/auth.mjs` — `GET /auth/me`
=====================================================================

Elimină complet:

- fallback-ul pe email;
- fallback-ul la payload-ul brut JWT;
- „vindecarea” unui userId lipsă prin contul nou cu același email.

Poți folosi `resolveActor(decoded)` sau aceeași logică, fără query redundant.

### Contract

- user activ și claims concordante → 200 cu profil DB;
- user inexistent/deleted → clear cookie + 401;
- token_version mismatch → clear cookie + 401;
- org mismatch → clear cookie + 401;
- role mismatch → clear cookie + 401;
- eroare DB → 503 fail-closed;
- la 503 nu șterge obligatoriu cookie-ul, fiind posibilă o problemă tranzitorie.

Folosește helperul existent `clearAuthCookie(res)` din fișier.

Exemplu de mapare:

```js
const identity = await resolveActor(decoded);

if (!identity.ok) {
  if (identity.status !== 503) {
    clearAuthCookie(res);
  }

  const status = identity.status === 403 ? 401 : identity.status;

  return res.status(status).json({
    error: identity.error,
    message: identity.message,
  });
}

const row = identity.user;
```

Nu returna profil din email și nu returna JWT-ul ca profil.

### Verificare frontend — numai raport

Verifică:

```text
public/js/df-shell.js
public/js/admin/admin.js
```

și orice helper comun folosit pentru `/auth/me`.

Raportează dacă un `401` produce redirect la login.

Nu modifica frontend-ul în promptul 87.

=====================================================================
## 12. `package.json` ȘI `package-lock.json`
=====================================================================

Adaugă în `npm run check`:

```text
node --check server/services/actor-identity.mjs
```

Actualizează versiunea sincronizat:

```powershell
npm.cmd version 3.9.667 --no-git-tag-version
```

Aceasta trebuie să actualizeze:

- `package.json`;
- `package-lock.json`.

Nu crea tag Git.

=====================================================================
## 13. TESTE UNIT
=====================================================================

Creează:

```text
server/tests/unit/actor-identity.test.mjs
```

Mock-uiește pool și logger folosind patternurile existente.

Cazuri obligatorii:

1. JWT fără `userId`
   - 401 `session_identity_invalid`;
   - pool.query nu este apelat.

2. eroare DB
   - 503 `identity_lookup_failed`.

3. `rows: []`
   - 403 `actor_not_found`.

4. `tv` JWT diferit de DB
   - 401 `token_revoked`.

5. org JWT diferit de DB
   - 401 `session_org_stale`.

6. JWT org `null`, DB org `null`
   - ok.

7. JWT org `null`, DB org nenul
   - 401.

8. JWT org nenul, DB org `null`
   - 401.

9. rol JWT diferit de DB
   - 401 `session_role_stale`.

10. rol JWT gol/lipsă
    - 401 `session_role_stale`.

11. totul concordant
    - `{ ok:true, user }`.

12. org string vs aceeași valoare DB
    - ok.

13. regresie SQL
    - SQL conține `WHERE id = $1`;
    - SQL conține `deleted_at IS NULL`;
    - predicatul de identificare NU folosește email.

Testul NU trebuie să interzică simpla coloană `email` din SELECT.

Exemplu corect:

```js
expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/i);
expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
expect(sql).not.toMatch(/WHERE\s+(?:lower\s*\(\s*)?email/i);
expect(sql).not.toMatch(/AND\s+(?:lower\s*\(\s*)?email/i);
```

=====================================================================
## 14. TESTE INTEGRATION / SUPERTEST
=====================================================================

Creează sau organizează coerent:

```text
server/tests/integration/actor-identity-routes.test.mjs
```

Este permisă actualizarea fixture-urilor în:

```text
server/tests/integration/users-list-exclude-deleted.test.mjs
server/tests/unit/templates.test.mjs
```

Numai dacă se rup din cauza noii identități fail-closed.

### Cazuri obligatorii

#### `/users`

- actor activ org 200 → numai utilizatori org 200;
- rând soft-deleted cu același email în org 100 nu influențează rezultatul;
- actor fără org tenant-scoped → fail-closed;
- actor stale role/org/tv → niciun query de listare business;
- fără fallback global pentru user/org_admin.

#### `/admin/users`

- JWT admin + DB user, aceeași versiune → 401 `session_role_stale`;
- org_admin activ org 200 → nu vede org 100;
- include_deleted nu traversează tenantul;
- actor soft-deleted → refuz.

#### `POST /admin/users`

- org_admin activ creează user numai cu `org_id` din DB;
- orgId stale în JWT → refuz înainte de hash/INSERT;
- rol stale admin→user → refuz înainte de allowedRoles/INSERT;
- admin DB poate păstra rolurile permise existente.

#### Self leave

- folosește `actor.id`;
- nu caută actorul după email;
- modifică numai contul activ;
- actor soft-deleted/stale → fără mutație.

#### Admin leave

- org_admin A + target B → 403;
- target soft-deleted → 404;
- super-admin DB păstrează bypass-ul existent;
- rol stale admin→user → 401 înainte de mutație.

#### Templates

- shared din org 100 nu apare actorului org 200;
- template shared nou se salvează în org 200;
- actor deleted/stale → fail-closed;
- actualizează `makeAuthCookie` cu `userId`, `orgId`, `role`, `tv`.

#### `POST /flows`

- nume, funcție, compartiment, instituție și org provin din actorul DB activ;
- rândul soft-deleted cu același email nu influențează `flows.data`;
- funcția veche nu ajunge în metadata/cartuş;
- nu se apelează lookup actor după email;
- nu se atinge delegarea semnatarilor.

#### Flow external email

- expeditorul vine din actorul DB;
- actor deleted/stale → nu trimite email;
- nu există lookup sender după email.

#### TOTP

- pending token pentru user soft-deleted → 401, fără `auth_token`;
- pending token role/org/tv stale → 401, fără `auth_token`;
- user activ concordant → auth_token complet cu userId/orgId/role/tv.

#### `/auth/me`

- token userId șters + email reutilizat → 401;
- nu întoarce profilul noului cont;
- nu întoarce payload-ul JWT;
- cookie auth este șters la invalidare;
- eroare DB → 503 fail-closed;
- user activ concordant → profil DB corect.

### Regula fixture-urilor

Dacă testele existente se rup:

- repară JWT-urile de test cu `userId`, `orgId`, `role`, `tv`;
- repară mock-ul actorului activ;
- nu slăbi verificările;
- nu reintroduce fallback-ul;
- raportează nominal fiecare test modificat.

=====================================================================
## 15. TEST POSTGRESQL REAL
=====================================================================

Creează:

```text
server/tests/db/user-email-reuse-authz.test.mjs
```

Folosește helperii real-DB existenți și patternul de izolare/cleanup din `server/tests/db/**`.

Nu hardcoda ID-uri precum 101/202.

Folosește:

```sql
INSERT ... RETURNING id
```

sau factory/helper existent.

### Fixture

- org A;
- org B;
- user soft-deleted în org A:
  - email comun;
  - funcție `Inspector vechi`;
- user activ în org B:
  - același lower(email);
  - funcție `Șef Serviciu`;
- target activ în org A;
- target activ în org B;
- template shared în fiecare org;
- utilizatori activi în fiecare org.

### Cazuri obligatorii

1. Query-ul vechi fără filtru poate demonstra două rânduri pentru email.
2. `resolveActor(user activ B)` returnează numai rândul activ B.
3. `resolveActor(user șters A)` refuză.
4. `/users` pentru B nu returnează utilizatori A.
5. `/admin/users` pentru org_admin B nu expune A.
6. `POST /admin/users` prin org_admin B inserează `org_id=B`.
7. self leave modifică numai userul activ B.
8. admin leave org_admin B → target A este 403.
9. GET templates B nu returnează shared A.
10. POST template B salvează `org_id=B`.
11. loginul cu emailul comun autentifică userul activ B.
12. `/auth/me` cu JWT vechi pentru userul șters A este 401.
13. TOTP pending pentru userul șters A nu emite auth_token.
14. metadata `POST /flows` folosește funcția userului activ B.
15. JWT `role=admin`, DB `role=user`, aceeași `tv` → rutele 87 refuză `session_role_stale`.
16. adăugarea unui al treilea rând soft-deleted nu schimbă rezultatul.

Testul trebuie să verifice efectul prin HTTP și/sau starea reală din DB, nu ordinea mock-urilor.

=====================================================================
## 16. VERIFICARE STATICĂ
=====================================================================

Folosește `git grep`/`Select-String`, adaptat PowerShell.

Exemple:

```powershell
git grep -n "FROM users WHERE email" -- `
  server/routes/admin/users.mjs `
  server/routes/templates.mjs `
  server/routes/flows/email.mjs
```

Așteptat: niciun lookup al actorului în fișierele atinse.

```powershell
git grep -n "u_actor.email" -- server/routes/admin/users.mjs
```

Așteptat: zero.

```powershell
git grep -n "SELECT functie,compartiment,institutie FROM users WHERE email" -- server/routes/flows/crud.mjs
```

Așteptat: zero.

```powershell
git grep -n "deleted_at IS NULL" -- server/routes/totp.mjs
```

Confirmă query-ul TOTP.

```powershell
git grep -n "User gasit prin email" -- server/routes/auth.mjs
```

Așteptat: zero.

Confirmă separat reziduurile deliberate pentru promptul 89.
Nu le modifica.

=====================================================================
## 17. TESTARE
=====================================================================

Rulează:

```powershell
npm.cmd run check
npm.cmd test
git diff --check
git status --short
```

Criterii:

- zero teste eșuate;
- zero skip-uri noi în suita normală;
- toate testele noi executate;
- `git diff --check` curat.

### PostgreSQL real

Varianta A — Docker/Postgres disponibil local:

```powershell
npm.cmd run db:test:up
npm.cmd run test:db
npm.cmd run db:test:down
```

Testele trebuie să fie efectiv `passed`, nu `skipped`.

Varianta B — local nu există Docker/Postgres:

1. raportează explicit că DB tests locale nu au fost executate;
2. nu le numi „verzi”;
3. după ce `npm.cmd run check` și `npm.cmd test` sunt verzi, este permis commit + push numai pe `develop`;
4. monitorizează workflow-ul GitHub Actions care rulează PostgreSQL real;
5. taskul nu este considerat finalizat până când jobul DB din CI este efectiv verde;
6. dacă nu poți verifica CI, raportează „implementare împinsă pe staging, validare DB în așteptare”;
7. nu promova în `main`.

=====================================================================
## 18. POARTA DE FIȘIERE
=====================================================================

Rulează:

```powershell
git status --short
git diff --name-only
```

Sunt permise numai:

```text
server/services/actor-identity.mjs
server/routes/admin/users.mjs
server/routes/templates.mjs
server/routes/flows/crud.mjs
server/routes/flows/email.mjs
server/routes/totp.mjs
server/routes/auth.mjs
server/tests/unit/actor-identity.test.mjs
server/tests/integration/actor-identity-routes.test.mjs
server/tests/db/user-email-reuse-authz.test.mjs
server/tests/integration/users-list-exclude-deleted.test.mjs
server/tests/unit/templates.test.mjs
package.json
package-lock.json
```

Este permis un fixture suplimentar numai dacă:

- s-a rupt strict din cauza noului contract;
- este raportat nominal;
- modificarea aliniază fixture-ul, nu slăbește comportamentul.

Dacă apare orice fișier NO-TOUCH sau neautorizat:

**OPREȘTE-TE. Fără staging, commit sau push.**

=====================================================================
## 19. VERSION BUMP
=====================================================================

După implementare și înaintea testelor finale:

```powershell
npm.cmd version 3.9.667 --no-git-tag-version
```

Verifică:

```powershell
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
```

Ambele trebuie să fie `3.9.667`.

=====================================================================
## 20. STAGING GIT EXPLICIT
=====================================================================

Nu folosi `git add .`.

Stage explicit:

```powershell
git add -- `
  server/services/actor-identity.mjs `
  server/routes/admin/users.mjs `
  server/routes/templates.mjs `
  server/routes/flows/crud.mjs `
  server/routes/flows/email.mjs `
  server/routes/totp.mjs `
  server/routes/auth.mjs `
  server/tests/unit/actor-identity.test.mjs `
  server/tests/integration/actor-identity-routes.test.mjs `
  server/tests/db/user-email-reuse-authz.test.mjs `
  server/tests/integration/users-list-exclude-deleted.test.mjs `
  server/tests/unit/templates.test.mjs `
  package.json `
  package-lock.json
```

Dacă un fișier permis nu a fost modificat, adaptează lista explicită numai după verificarea
`git status --short`.

Pentru fixture-uri suplimentare:

```powershell
git add -- path\explicit\fixture.test.mjs
```

Verifică:

```powershell
git diff --cached --name-only
git diff --cached --check
git diff --cached --stat
```

Poarta finală:

- toate fișierele noi obligatorii sunt staged;
- niciun fișier neautorizat;
- niciun fișier NO-TOUCH;
- niciun prompt `.md`;
- niciun secret;
- niciun fișier local Claude/Codex.

=====================================================================
## 21. COMMIT ȘI PUSH
=====================================================================

Numai după ce porțile sunt verzi:

```powershell
git commit -m "sec: actor identity fail-closed by userId, active account, tenant, role and token version (v3.9.667)"
git push origin develop
```

Este interzis push pe `main`.

După push:

```powershell
git branch --show-current
git rev-parse --short HEAD
git status -sb
git status --short
```

Așteptat:

- branch `develop`;
- working tree curat;
- fără ahead local după push;
- commit pe origin/develop.

Dacă DB tests locale nu au rulat, verifică workflow-ul CI real-DB înainte de a declara taskul finalizat.

=====================================================================
## 22. FOLLOW-UP OBLIGATORIU — PROMPT 88
=====================================================================

Promptul 87 nu rezolvă revocarea globală.

Constatări deja demonstrate:

- `requireAuth()` verifică numai semnătura/expirarea JWT;
- `checkTokenVersionValid()` nu are apelanți runtime;
- `PUT /admin/users/:id` poate schimba rolul fără bump;
- recovery development/startup poate schimba rolul fără bump;
- un cont dezactivat poate folosi alte rute până la expirarea JWT;
- rutele neatinse de promptul 87 rămân expuse.

Promptul 88 trebuie să implementeze separat:

1. verificarea globală a sesiunii active;
2. validarea `token_version` pe toate requesturile autentificate;
3. bump atomic la schimbarea rolului;
4. invalidarea sesiunilor la demotare/promovare;
5. recovery determinist numai pe cont activ;
6. cache scurt/strategie performantă;
7. teste de concurență și DB real.

**Prompturile 87 și 88 pot fi testate separat pe staging, dar nu se promovează separat în producție.**

=====================================================================
## 23. RAPORT FINAL OBLIGATORIU
=====================================================================

Raportează:

1. output-ul precondițiilor;
2. cauza tehnică;
3. diff-ul pe fiecare rută;
4. implementarea exactă a `resolveActor`;
5. confirmarea că autorizarea rulează după actorul DB;
6. comportamentul `/users` pentru user/org_admin/admin;
7. comportamentul self-leave și admin-leave;
8. cum ai refolosit actorul DB în `crud.mjs`;
9. confirmarea că funcția contului șters nu mai ajunge în `flows.data`;
10. comportamentul `/auth/me` la 401 și 503;
11. comportamentul frontend observat la 401 `/auth/me`, fără modificare frontend;
12. rezultatele TOTP;
13. lista nominală a fixture-urilor reparate;
14. `npm.cmd run check`;
15. `npm.cmd test` și numărul final de teste;
16. `npm.cmd run test:db`:
    - număr efectiv passed;
    - sau CI real-DB și rezultatul jobului;
17. output `git diff --cached --name-only`;
18. versiunea `package.json` + `package-lock.json`;
19. hash commit;
20. starea CI;
21. orice abatere de la prompt, cu justificare;
22. limitarea personal templates keyed by `user_email`;
23. confirmarea că:
    - `main` nu a fost atins;
    - NO-TOUCH nu a fost atins;
    - nu au fost create migrări;
    - nu au fost rescrise PDF-uri;
    - nu au fost executate comenzi Railway;
    - repository-ul este curat.

=====================================================================
## 24. CONSTRÂNGERI ABSOLUTE — RECAPITULARE
=====================================================================

- BRANCH `develop` exclusiv.
- Fără `main`.
- Fără `git add .`.
- Fără comenzi Git destructive.
- Fără migrări.
- Fără SQL dinamic pentru coloane în `resolveActor`.
- Fără fallback pe email pentru actor.
- Fără autorizare pe rol JWT înainte de actor DB.
- Fără fallback global `/users` pentru user/org_admin.
- Fără modificarea delegării/semnării.
- Fără NO-TOUCH.
- Fără frontend.
- Fără rescrierea documentelor semnate.
- Fără relaxarea testelor.
- Fără „DB tests verzi” dacă au fost skipped.
- Fără promovare în producție înainte de promptul 88.
