---
task: "TMPL-DEL — ștergere șabloane instituție de către admin/org_admin (inclusiv orfane)"
branch: develop
model_suggested: Opus 4.8   # authz (contract #105 role-only) + guard de ștergere
target_version: v3.9.738
migrations: none
cache_version_bump: NO   # templates.js NU e în PRECACHE_ASSETS (verificat)
---

# ⚠️ BRANCH: develop
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. NU face niciodată merge / checkout / push pe `main`.
Toată munca și `git push origin develop` (pas final obligatoriu).

===============================================================================
## CONTEXT / BUG
===============================================================================

Pagina „Șabloane instituție" (`/templates.html`) arată șabloane shared la nivel de
organizație. Ștergerea e legată EXCLUSIV de proprietar:

`server/routes/templates.mjs`, ruta `DELETE /api/templates/:id`:
```
DELETE FROM templates WHERE id=$1 AND user_email=$2   // $2 = actor.email
```

Când userul-proprietar a fost șters (soft-delete), emailul lui nu mai aparține
niciunui cont activ ⇒ șablonul shared devine ORFAN și NIMENI nu-l mai poate șterge
(nici din UI — cardurile `!isOwner` n-au buton „Șterge" — nici din API).

**Decizie de produs (Mircea, 22.07):** un admin SAU org_admin poate șterge ORICE
șablon SHARED din propria organizație (inclusiv ale colegilor activi, nu doar orfane).
Butonul „Șterge" apare pe cardurile shared pentru admin ȘI org_admin.

Contractul de autz e cel din #105 (role-only), deja cablat în
`server/services/authz-scope.mjs`:
- `isPlatformAdmin(actor)` = `role==='admin'` (contul de platformă, vede tot)
- `isAdminOrOrgAdmin(actor)` = `role==='admin' || role==='org_admin'`
- `actorCanAccessOrg(actor, targetOrgId)` = platform-admin SAU același org (fail-closed)

**INVARIANT:** primăriile folosesc `org_admin`; `role='admin'` = DOAR contul bootstrap
de platformă. Deci „admin șterge orice org" e intenționat (platformă); „org_admin
șterge doar în org-ul lui" e garantat de `actorCanAccessOrg`.

===============================================================================
## FAPTE DE COD VERIFICATE (nu re-descoperi, doar confirmă la nevoie)
===============================================================================

- `server/routes/templates.mjs` — 102 linii. GET(23)/POST(40) folosesc DEJA
  `resolveActorOr` (au `actor.role`, `actor.org_id`, `actor.email`). PUT(69) și
  DELETE(90) folosesc `requireAuth` direct (NU au role/org_id).
- Tabela `templates` (index.mjs:207): `id, user_email, institutie, name, signers,
  shared BOOLEAN, org_id INTEGER, created_at, updated_at`. `org_id` populat pe rânduri
  existente (migrația inline din index.mjs).
- GET întoarce deja `isOwner` per rând (`t.user_email === actor.email.toLowerCase()`).
- `resolveActorOr` întoarce actor cu câmpuri SNAKE din DB: `actor.role`, `actor.org_id`,
  `actor.email`. (`authz-scope` citește `actor.orgId` camelCase — vezi ADAPTARE mai jos.)
- `public/js/templates/templates.js` — `buildCard` (281): ramura `t.isOwner ?` are
  butoanele Editează/Share/Șterge/Copiază; ramura `!isOwner` are DOAR „Copiază ca al meu".
  Există deja global `deleteTemplate(id,name)` (354) care face DELETE + `loadTemplates()`.
- `templates.js` NU e în PRECACHE_ASSETS (`grep templates public/sw.js` = gol) ⇒
  fără bump CACHE_VERSION; doar `?v=` țintit. Actual: `templates.html:254` `?v=3.9.693`.
- Test existent: `server/tests/unit/templates.test.mjs` (14 teste). Mock pe `pool.query`;
  `resolveActorOr` rulează REAL, hrănit cu `mockResolvedValueOnce({rows:[mockUserRow()]})`
  ca PRIMA interogare (user lookup). `makeAuthCookie(email, role)` acceptă rolul.

⚠️ ADAPTARE orgId snake vs camel: `actorCanAccessOrg(actor, target)` citește
`actor.orgId`. Actorul din `resolveActorOr` are `actor.org_id` (snake). NU modifica
authz-scope. În `templates.mjs` construiește un obiect subțire pentru helper:
`const accessActor = { role: actor.role, orgId: actor.org_id };`
(mirror cu ce face email.mjs pe calea `send`, documentat în #105a.)

===============================================================================
## PASUL 1 — Backend: DELETE cu ramură admin/org_admin (fetch-then-authorize)
===============================================================================

Fișier: `server/routes/templates.mjs`

### 1a. Import helper authz-scope (lângă celelalte importuri, după resolveActorOr)

old_str:
```
import { resolveActorOr } from '../services/actor-identity.mjs';
```
new_str:
```
import { resolveActorOr } from '../services/actor-identity.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../services/authz-scope.mjs';
```

### 1b. Rescrie ruta DELETE — resolveActorOr + fetch-then-authorize

Înlocuiește TOT blocul DELETE (liniile ~90-100, de la comentariul separator până la
`});` inclusiv). old_str:
```
// ── DELETE /api/templates/:id ─────────────────────────────────────────────
router.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM templates WHERE id=$1 AND user_email=$2', [id, actor.email.toLowerCase()]);
    if (!rowCount) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});
```
new_str:
```
// ── DELETE /api/templates/:id ─────────────────────────────────────────────
// Owner: își șterge orice șablon propriu (privat sau shared).
// Admin / org_admin: pot șterge orice șablon SHARED din propria organizație
// (curățare de șabloane instituție, inclusiv orfane — proprietar șters din DB).
router.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const tokenActor = requireAuth(req, res); if (!tokenActor) return;
  const actor = await resolveActorOr(res, tokenActor, req); if (!actor) return;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await pool.query(
      'SELECT id, user_email, shared, org_id FROM templates WHERE id=$1',
      [id]
    );
    const tmpl = rows[0];
    if (!tmpl) return res.status(404).json({ error: 'not_found' });

    const isOwner = tmpl.user_email === actor.email.toLowerCase();
    const accessActor = { role: actor.role, orgId: actor.org_id };
    const isOrgManager = isAdminOrOrgAdmin(actor)
      && tmpl.shared === true
      && actorCanAccessOrg(accessActor, tmpl.org_id);

    if (!isOwner && !isOrgManager) {
      return res.status(403).json({ error: 'forbidden' });
    }

    await pool.query('DELETE FROM templates WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch(e) { logger.error({ err: e }, 'DELETE /api/templates error'); res.status(500).json({ error: 'server_error' }); }
});
```

Verificare:
```
grep -n "resolveActorOr\|isOrgManager\|actorCanAccessOrg\|not_found\|forbidden" server/routes/templates.mjs
# Așteptat: DELETE folosește resolveActorOr, isOrgManager, actorCanAccessOrg;
#           404 'not_found', 403 'forbidden'. (GET/POST rămân neatinse.)
```

===============================================================================
## PASUL 2 — Backend: GET adaugă `canDelete` per rând
===============================================================================

Fișier: `server/routes/templates.mjs`, ruta GET. Frontend-ul va desena butonul
„Șterge" pe cardurile shared DOAR dacă `canDelete` (serverul e autoritatea; butonul
e doar cosmetic — DELETE re-verifică oricum).

old_str:
```
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
```
new_str:
```
    const accessActor = { role: actor.role, orgId: actor.org_id };
    res.json(rows.map(t => {
      const isOwner = t.user_email === actor.email.toLowerCase();
      const canDelete = isOwner
        || (isAdminOrOrgAdmin(actor) && t.shared === true && actorCanAccessOrg(accessActor, t.org_id));
      return { ...t, isOwner, canDelete };
    }));
```

Verificare:
```
grep -n "canDelete" server/routes/templates.mjs
# Așteptat: 1 apariție, în GET.
```

===============================================================================
## PASUL 3 — Frontend: buton „Șterge" pe cardurile shared când `canDelete`
===============================================================================

Fișier: `public/js/templates/templates.js`, funcția `buildCard`, ramura `!isOwner`
(linia ~306). `deleteTemplate` există deja și funcționează — doar îl expunem.

old_str:
```
  : `<button class="df-action-btn success sm" onclick="copyTemplate(${t.id})"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-clipboard"/></svg>Copiază ca al meu</button>`;
```
new_str:
```
  : `<button class="df-action-btn success sm" onclick="copyTemplate(${t.id})"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-clipboard"/></svg>Copiază ca al meu</button>${t.canDelete ? `
    <button class="df-action-btn danger sm" onclick="deleteTemplate(${t.id},'${esc(t.name)}')"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-trash"/></svg>Șterge</button>` : ''}`;
```

⛔ NU modifica funcția `deleteTemplate` — merge deja pe noul backend.
⛔ NU atinge ramura `t.isOwner` (are deja Șterge).

Verificare:
```
grep -n "t.canDelete" public/js/templates/templates.js
# Așteptat: 1 apariție, în ramura !isOwner din buildCard.
```

===============================================================================
## PASUL 4 — Cache-bust (?v= țintit, FĂRĂ CACHE_VERSION)
===============================================================================

`templates.js` NU e în PRECACHE ⇒ doar `?v=` pe el în `templates.html`.

```
sed -i -E "s#(templates/templates\.js\?v=)[0-9.]+#\13.9.738#g" public/templates.html
grep -n "templates/templates.js?v=" public/templates.html
# Așteptat: ?v=3.9.738
```
⛔ NU bumpа `CACHE_VERSION` în sw.js (niciun asset PRECACHE atins).
⛔ NU face bulk-sed pe alte `?v=` din HTML.

Bump `package.json` → `3.9.738`.

===============================================================================
## PASUL 5 — Teste (extinde templates.test.mjs)
===============================================================================

Fișier: `server/tests/unit/templates.test.mjs`.

⚠️ ATENȚIE la ordinea interogărilor mock: DELETE folosește ACUM `resolveActorOr`
(deci PRIMA query e user lookup → `mockResolvedValueOnce({rows:[mockUserRow(...)]})`),
apoi SELECT template, apoi (dacă autorizat) DELETE. Testele DELETE existente care
mock-uiau doar `{rowCount}` TREBUIE actualizate la noua secvență.

`mockUserRow` trebuie să accepte `role`/`org_id`/`email` parametrizabile ca actorul
rezolvat să reflecte rolul din cookie (verifică helperul existent; dacă e fix,
extinde-l fără să strici testele curente).

Cazuri de adăugat/ajustat (owner-ul rămâne verde):
1. **owner** șterge propriul șablon → 200 `{ok:true}` (secvență: userRow(owner,user,org1)
   → SELECT template {user_email:owner, shared:false, org_id:1} → DELETE).
2. **org_admin** șterge șablon SHARED din org-ul lui (proprietar ALT email) → 200.
   (userRow(admin@x, org_admin, org1) → SELECT {user_email:'sters@old.ro', shared:true, org_id:1}.)
3. **org_admin** pe șablon shared din ALT org (org_id:2) → 403 `forbidden`.
4. **org_admin** pe șablon NEshared al altcuiva (shared:false, alt user, org1) → 403
   `forbidden` (managerul atinge doar shared).
5. **admin (platformă, role='admin')** pe șablon shared din org 2 → 200 (vede tot).
6. **user oarecare** (nu owner, nu manager) pe șablon shared → 403 `forbidden`.
7. **404** când id-ul nu există (SELECT template → `{rows:[]}`) → 404 `not_found`.
8. id NaN → 400 `invalid_id` (fără query pe template).
9. **GET**: extinde un caz existent să asserteze `canDelete` în răspuns —
   owner→true; org_admin pe shared same-org→true; user pe shared→false.

⛔ Nu redeclara logica din producție în test; testează prin `request(app)` pe router.
⛔ Nu pierde niciun test existent — dacă unul codifică vechiul contract
   (`not_found_or_not_owner` pe DELETE), migrează-l la noul contract (404 `not_found`
   pentru inexistent, 403 `forbidden` pentru neautorizat) și raportează schimbarea.

===============================================================================
## PASUL 6 — Porți (rulează ÎNAINTE de commit)
===============================================================================

```
npm test
# Așteptat: verde, fără regresii. Baseline actual = 108 fișiere / 1387 teste.
#           Noile cazuri DELETE/GET se adaugă la templates.test.mjs.
```

`test:db` NU e necesar (fără migrații, fără cod pe calea DB reală nou-introdusă în
suita db). Dacă totuși îl rulezi: instanță PG 17 EFEMERĂ (rețeta din CLAUDE.md,
port 55432) — „Docker absent" NU e motiv de skip.

===============================================================================
## PASUL 7 — Commit + PUSH (pas final OBLIGATORIU)
===============================================================================

```
git add server/routes/templates.mjs public/js/templates/templates.js public/templates.html package.json server/tests/unit/templates.test.mjs
git commit -m "fix(templates): admin/org_admin pot șterge șabloane instituție shared (inclusiv orfane) — v3.9.738"
git push origin develop
```
⛔ Push pe `origin develop` DA. Pe `main` NICIODATĂ.

===============================================================================
## RAPORT FINAL (completează la sfârșit)
===============================================================================

- Commit hash + versiune (v3.9.738?).
- `npm test`: nr. fișiere / nr. teste, PASS/FAIL.
- `grep` de verificare pentru fiecare pas (ieșirea reală).
- Ai schimbat vreun test existent (ex. `not_found_or_not_owner`)? Care și de ce.
- Confirmă: CACHE_VERSION NEatins; `?v=` bumpat DOAR pe templates.js.
- Orice abatere de la prompt + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================
- ⛔ BRANCH: develop. Niciodată main.
- ⛔ NO-TOUCH: `server/signing/*` (nerelevant aici, dar regula stă).
- ⛔ NU modifica `authz-scope.mjs` (folosește-l ca atare; adaptează orgId în templates.mjs).
- ⛔ NU modifica funcția `deleteTemplate` din frontend.
- ⛔ NU bumpа CACHE_VERSION (niciun asset PRECACHE atins).
- ⛔ NU face bulk-sed pe `?v=`; doar templates.js.
- ⛔ Owner-ul își păstrează dreptul de ștergere pe orice șablon propriu (privat sau shared).
- ⛔ Managerul (admin/org_admin) atinge DOAR șabloane `shared=TRUE` din org-ul lui.
- ⛔ `git push origin develop` la final.
