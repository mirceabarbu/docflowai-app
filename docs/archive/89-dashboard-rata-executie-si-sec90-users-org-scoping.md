---
prompt: 89
titlu: "Dashboard: Rata de execuție (plătit/angajat) + SEC-90: /users scopat pe org_id, nu pe institutie"
branch: develop
model_suggested: "Opus 4.8 — Partea B e izolare de tenant pe dropdown-ul de semnatari; o greșeală ascunde colegi din listă"
depinde_de: prompt 88.3 (v3.9.673, commit 22b81a2, CI verde)
fisiere_atinse:
  # Partea A — dashboard (pur frontend)
  - public/admin.html
  - public/js/admin/audit.js
  # Partea B — SEC-90 (tenant scoping)
  - server/routes/admin/users.mjs
  - server/tests/integration/actor-identity-routes.test.mjs
  - server/tests/db/users-org-scoping.test.mjs        (FIȘIER NOU — Postgres real)
  # comun
  - public/sw.js                                      (DOAR dacă audit.js e în PRECACHE_ASSETS)
  - package.json
  - package-lock.json
versiune: 3.9.673 → 3.9.674
---

# ⚠️ BRANCH: `develop` — EXCLUSIV. `main` = PRODUCȚIE, manual, doar Mircea.

> **Două teme independente.** Dacă Partea B se complică, **livrează Partea A separat** și
> raportează. NU le amesteca într-un singur commit dacă B are probleme.

=====================================================================
## PAS 0 — Precondiții
=====================================================================

```bash
git status --short
git switch develop
git pull --ff-only origin develop
test "$(node -p "require('./package.json').version")" = "3.9.673" || { echo "STOP"; exit 1; }
git log --oneline -1                       # Așteptat: 22b81a2
grep -n "CACHE_VERSION = " public/sw.js    # Așteptat: 'docflowai-v285'
```

=====================================================================
# ══ PARTEA A — Dashboard: „Rata de execuție" ══
=====================================================================

## Context

Cardul **„ALOP finalizate (an curent)"** se înlocuiește cu **„Rata de execuție"** —
eficiență financiară în loc de volum. Numărul de ALOP finalizate **se păstrează, în subtitlu**.

**Zero modificări pe server.** `/admin/alop/stats` (`server/routes/admin/flows.mjs:88-112`)
întoarce deja tot ce trebuie:
```js
{ alop_active, valoare_angajata_an, valoare_platita_an, alop_finalizate_an }
```

**Decizii de produs (luate de Mircea — NU le renegocia):**
- **FĂRĂ plafonare la 100%.** O rată >100% e un **semnal de anomalie în date** și trebuie să fie
  vizibilă directorului economic, nu ascunsă.
- Numărul de ALOP finalizate rămâne **în subtitlu**.

## A1 — `public/admin.html` (în jurul liniei 212-216)

`old_str`:
```html
    <div class="df-kpi-card">
      <div class="df-kpi-label">ALOP finalizate</div>
      <div class="df-kpi-value" id="dashKpiAlopFinal">—</div>
      <div class="df-kpi-sub">an curent</div>
    </div>
```
`new_str`:
```html
    <div class="df-kpi-card">
      <div class="df-kpi-label">Rata de execuție</div>
      <div class="df-kpi-value" id="dashKpiAlopRata">—</div>
      <div class="df-kpi-sub" id="dashKpiAlopRataSub">plătit / angajat</div>
    </div>
```

## A2 — `public/js/admin/audit.js` (în jurul liniei 123)

`old_str`:
```js
        set('dashKpiAlopFinal', a.alop_finalizate_an);
```
`new_str`:
```js
        // Rata de execuție = plătit / angajat (an curent).
        // FĂRĂ plafonare: o rată >100% înseamnă că datele nu se leagă (plăți peste creditele
        // bugetare angajate) — e exact genul de anomalie pe care directorul economic TREBUIE
        // s-o vadă, nu s-o primească ascunsă sub un „100%".
        // Angajat = 0 ⇒ „—", NU „0%". Sunt lucruri diferite: „n-am plătit nimic" vs „n-am angajat nimic".
        const _ang = Number(a.valoare_angajata_an) || 0;
        const _plt = Number(a.valoare_platita_an)  || 0;
        const _fin = Number(a.alop_finalizate_an)  || 0;
        if (_ang > 0) {
          const _rata = (_plt / _ang) * 100;
          set('dashKpiAlopRata', _rata.toLocaleString('ro-RO', {
            minimumFractionDigits: 1, maximumFractionDigits: 1,
          }) + '%');
        } else {
          set('dashKpiAlopRata', '—');
        }
        set('dashKpiAlopRataSub',
          'plătit / angajat · ' + _fin + (_fin === 1 ? ' ALOP finalizat' : ' ALOP finalizate'));
```

⚠️ **Verifică semnătura reală a lui `set(id, val)`** în `audit.js` (setează `textContent`?).
Adaptează. **Fișierul e sursa de adevăr.**

## A3 — Semnalare vizuală pentru rată >100% (opțional)

Dacă în `public/css/` **există deja** o clasă de avertizare pe KPI-uri (caută
`df-kpi-warn`, `.warn`, `.danger`, tokeni de culoare de eroare), aplic-o pe
`#dashKpiAlopRata` când `_rata > 100`.

⛔ **Dacă nu există, NU inventa un stil nou.** Lasă cifra simplă și **raportează**.

## A4 — Cache busting (Partea A)

```bash
grep -n "PRECACHE_ASSETS" -A25 public/sw.js | grep -n "audit.js"
```
- Dacă `audit.js` **NU** e în `PRECACHE_ASSETS` ⇒ **doar** `?v=3.9.674` pe `audit.js` în `admin.html`.
  **Fără** bump de `CACHE_VERSION`.
- Dacă **este** ⇒ bump `CACHE_VERSION` `'docflowai-v285'` → `'docflowai-v286'`.

⛔ **NU** face bulk-replace pe `?v=`.
⚠️ Dacă bump-ezi `CACHE_VERSION`, **`server/tests/unit/sw-no-auth-cache.test.mjs` va PICA** — el
fixează literal valoarea. **Repar-o corect, o dată pentru totdeauna:** înlocuiește asserțiunea pe
valoare cu una pe **format**:
```js
expect(sw).toMatch(/const CACHE_VERSION = 'docflowai-v\d+'/);
```
Invariantele reale (fără `cache.put`/`caches.match` în `networkOnly`, cele 4 prefixe autentificate)
sunt deja testate separat — **nu le atinge**.

=====================================================================
# ══ PARTEA B — SEC-90: `/users` scopat pe `org_id` ══
=====================================================================

## Context — ce e greșit azi

`server/routes/admin/users.mjs:41-75` — **dropdown-ul de semnatari**. Trei ramuri în cascadă:

```js
if (institutie)        → WHERE institutie = $1     // text LIBER
else if (actor.orgId)  → WHERE org_id = $1
else                   → TOȚI utilizatorii din ÎNTREAGA bază   // 🔴
```

**Două defecte:**

1. **Izolarea de tenant se face pe un string liber.** Două organizații care scriu identic
   `institutie` **își văd reciproc utilizatorii**. Nu se declanșează cu o singură primărie —
   **se declanșează la a doua.**
2. **Ramura a treia returnează TOȚI utilizatorii din sistem.** Nu dintr-o altă primărie — din
   **toate**. Azi nu se poate atinge (toți cei 48 de utilizatori activi au `org_id`), dar primul
   cont creat fără `org_id` o calcă.

## De ce NU folosim `actorOrgFilter()`

`server/routes/admin/_helpers.mjs:14`:
```js
export function actorOrgFilter(actor) {
  if (actor?.role === 'org_admin') return actor.orgId || null;
  return null;   // admin = fără filtru
}
```
E făcut pentru **paginile de administrare**, unde super-adminul trebuie să vadă tot.

**`/users` e altceva:** e lista din care alegi **semnatarii unui flux**. Un flux aparține unei
singure primării ⇒ lista se scopează pe organizația **fluxului**, NU pe privilegiile celui care o
deschide. Un super-admin care creează un DF în primăria X n-are ce căuta cu semnatari din
primăria Y în listă.

⇒ **Scopăm pe `org_id` MEREU, pentru toată lumea, inclusiv `role='admin'`.**

## Datele reale din producție (verificate)

```
total_activi = 48 · fara_org = 0 · organizatii = 1 · valori_institutie = 2
  'Primaria Zarnesti' → 47      (gol) → 1   ← contul de super-admin
```

⇒ Toți au `org_id` ⇒ **nimeni nu dispare din dropdown** la trecerea pe `org_id`. ✅

## ⭐ Decizie de produs (luată de Mircea — NU o renegocia)

Azi, super-adminul e **invizibil accidental** în dropdown (`institutie` goală nu se potrivește cu
`'Primaria Zarnesti'`). După fix ar deveni vizibil pentru toți cei 47.

**Decizie: rămâne EXCLUS.** Discriminatorul e `role <> 'admin'` — în această aplicație `admin` e
**rolul de PLATFORMĂ**, nu unul de primărie (vezi `users.mjs:181`:
`allowedRoles = actor.role === 'admin' ? ['admin','org_admin','user'] : ['user']`).
Personalul real al primăriei are `org_admin` sau `user` ⇒ **rămân toți în listă.**

## B1 — Rescrie scoping-ul din `GET /users`

`old_str`:
```js
    // SEC-87: identitatea actorului se rezolvă după users.id, cu deleted_at IS NULL.
    // Lookup-ul după email putea întoarce rândul unui cont ȘTERS (index unic doar parțial).
    const self = await resolveActorOr(res, actor); if (!self) return;
    const institutie = String(self.institutie || '').trim();

    let query, params;
    if (institutie) {
      // Filtreaza pe institutie — userii din aceeasi institutie
      query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE institutie=$1 AND deleted_at IS NULL ORDER BY nume ASC';
      params = [institutie];
    } else {
      // User fara institutie (ex: admin global) — vede toti userii din org
      const orgId = actor.orgId || null;
      if (orgId) {
        query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE org_id=$1 AND deleted_at IS NULL ORDER BY nume ASC';
        params = [orgId];
      } else {
        query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE deleted_at IS NULL ORDER BY nume ASC';
        params = [];
      }
    }
    const { rows } = await pool.query(query, params);
```

⚠️ **Blocul de mai sus reflectă starea de după promptul 87. CITEȘTE fișierul real** — dacă `old_str`
nu se potrivește exact, fișierul e sursa de adevăr; adaptează și **raportează**.

`new_str`:
```js
    // SEC-87: identitatea actorului se rezolvă după users.id, cu deleted_at IS NULL.
    const self = await resolveActorOr(res, actor); if (!self) return;

    // ── SEC-90: izolare de tenant pe org_id, NU pe `institutie` ────────────────────────
    // Anterior:
    //   1) `WHERE institutie = $1` — `institutie` e TEXT LIBER. Două organizații care scriu
    //      identic acest câmp își vedeau RECIPROC utilizatorii. Cu o singură primărie nu se
    //      declanșa; la a doua, da.
    //   2) Fallback fără `institutie` și fără `org_id` ⇒ `SELECT ... FROM users` FĂRĂ NICIUN
    //      FILTRU — adică TOȚI utilizatorii din ÎNTREAGA bază. Fail-open. Eliminat.
    //
    // NU folosim `actorOrgFilter()`: acela e pentru paginile de ADMINISTRARE (unde super-adminul
    // trebuie să vadă tot). Aici construim lista de SEMNATARI ai unui flux, iar un flux aparține
    // unei singure primării. Se scopează pe organizație pentru TOATĂ lumea, inclusiv `admin`.
    const orgId = self.org_id || null;
    if (!orgId) {
      logger.warn({ userId: self.id }, 'GET /users: actor fără organizație — fail-closed (listă goală)');
      return res.json([]);   // fail-closed: listă GOALĂ, nu „toți utilizatorii"
    }

    // Contul de super-admin al platformei (`role='admin'`) NU e un semnatar — nu apare în
    // dropdown. `admin` e rolul de PLATFORMĂ (vezi allowedRoles mai jos); personalul primăriei
    // are `org_admin` sau `user` și rămâne în listă.
    const { rows } = await pool.query(
      `SELECT id, email, nume, functie, institutie, compartiment, org_id
         FROM users
        WHERE org_id = $1
          AND deleted_at IS NULL
          AND role <> 'admin'
        ORDER BY nume ASC`,
      [orgId]
    );
```

⚠️ Verifică că `logger` e importat în `users.mjs`. Dacă nu, **importă-l** — e singura adăugare
permisă la import-uri.

⚠️ Restul rutei (`batchGetLeaveInfo`, `enriched`, `res.json`) rămâne **NEATINS**.

## B2 — Teste (mock)

**Fișier:** `server/tests/integration/actor-identity-routes.test.mjs` — **adaugă**, nu rescrie.

| # | Situație | Așteptat |
|---|---|---|
| 1 | Actor cu `org_id: 1` | SQL conține `org_id = $1` și `role <> 'admin'`; **NU** conține `institutie=` |
| 2 | Actor cu `org_id: null` | **`[]`** (listă goală); `pool.query` pentru `users` **NU** e chemat pentru listare |
| 3 | Actorul e `role: 'admin'`, `org_id: 1` | tot scopat pe `org_id = 1` (**nu** vede tot sistemul) |
| 4 | Regresie | SQL-ul **NU** conține niciun `SELECT ... FROM users WHERE deleted_at IS NULL` fără filtru de org |

## B3 — ⭐ Test Postgres REAL — `server/tests/db/users-org-scoping.test.mjs` (NOU)

**Ăsta e testul care demonstrează bug-ul.** Cu mock-uri nu poate fi reprodus.

⚠️ **Fixture-ul trece prin contractul de producție:** `hashPassword()` din
`server/middleware/auth.mjs`, email **lowercased**, `RETURNING id` (**fără ID-uri hardcodate**),
curățare cu `TRUNCATE ... RESTART IDENTITY CASCADE`, conform pattern-ului din `server/tests/db/`.
**Verifică fiecare nume de coloană în migrări înainte de a scrie SQL.**

**Fixture — două organizații cu ACEEAȘI `institutie`:**
```
org A (id=?)   users:  A1 (user,      institutie='Primaria Test')
                       A2 (org_admin, institutie='Primaria Test')
org B (id=?)   users:  B1 (user,      institutie='Primaria Test')   ← ACELAȘI text!
super-admin    users:  SA (admin,     institutie='',  org_id = org A)
```

**Cazuri:**
1. ⭐ **A1 apelează `GET /users`** ⇒ vede **A1 și A2**. **NU** îl vede pe **B1**, deși au aceeași
   `institutie`. *(Cu codul vechi, B1 APĂREA — asta e bug-ul.)*
2. **A1 NU îl vede pe SA** (super-adminul, `role='admin'`), deși e în aceeași organizație.
3. **B1 apelează** ⇒ vede **doar pe B1**. Nu vede nimic din org A.
4. **Utilizator soft-deleted** din org A ⇒ **nu apare** la A1.
5. **Actor cu `org_id = NULL`** ⇒ **`[]`**, **NU** lista completă a sistemului.

## B4 — ⚠️ Fixture-uri existente care se pot rupe

Orice test care se aștepta ca `/users` să filtreze pe `institutie` va primi acum altceva.
**REPARĂ FIXTURE-UL, nu comportamentul.** Nu slăbi asserțiile. Raportează **nominal** fiecare
fișier atins.

=====================================================================
## PAS 7 — Verificare
=====================================================================

```bash
# ── Partea A ──
grep -n "dashKpiAlopRata\|dashKpiAlopRataSub" public/admin.html public/js/admin/audit.js
grep -n "dashKpiAlopFinal" public/admin.html public/js/admin/audit.js
# Așteptat: NICIUN rezultat (cardul vechi a dispărut complet)

grep -n "Math.min(100\|> 100 ? 100" public/js/admin/audit.js
# Așteptat: NICIUN rezultat (FĂRĂ plafonare — decizie de produs)

# ── Partea B ──
grep -n "institutie=\$1\|institutie = \$1" server/routes/admin/users.mjs
# Așteptat: NICIUN rezultat

grep -n "role <> 'admin'" server/routes/admin/users.mjs
# Așteptat: 1 rezultat (în GET /users)

grep -n "FROM users WHERE deleted_at IS NULL ORDER BY nume" server/routes/admin/users.mjs
# Așteptat: NICIUN rezultat (ramura „toți utilizatorii din sistem" a dispărut)

# ── Comun ──
npm run check
npm test
npm run test:db      # ⛔ POARTĂ DURĂ — baseline CI: 363 teste / 55 fișiere
git diff --check
git status --short
git diff --name-only
```

⛔ Dacă Docker nu e disponibil local, **spune-o explicit**, comite și lasă CI să verifice.
**NU raporta „verde" pe skip.** Partea B **atinge izolarea de tenant** — `test:db` e obligatoriu.

### Verificare manuală pe staging

- [ ] **Dashboard:** cardul arată **46,0%** (282.000 / 613.000) și subtitlul „plătit / angajat · 2 ALOP finalizate".
- [ ] **Dropdown de semnatari** (flux nou): apar **47 de utilizatori**. **Super-adminul NU apare.**
- [ ] Creează un DF end-to-end ⇒ **poți alege semnatarii normal**. *(Asta e regresia care contează.)*

=====================================================================
## PAS 8 — Commit
=====================================================================

```bash
npm version 3.9.674 --no-git-tag-version
git status --short
git add -- public/admin.html public/js/admin/audit.js \
           server/routes/admin/users.mjs \
           server/tests/integration/actor-identity-routes.test.mjs \
           server/tests/db/users-org-scoping.test.mjs \
           package.json package-lock.json
# + public/sw.js și sw-no-auth-cache.test.mjs DOAR dacă a fost nevoie de bump CACHE_VERSION (A4)
# + fixture-urile reparate, NOMINAL. ⛔ NICIODATĂ `git add .`
git diff --cached --name-only
git commit -m "feat(dashboard): Rata de executie (platit/angajat, fara plafonare, finalizate in subtitlu); sec(90): /users scopat pe org_id nu pe institutie (text liber), fail-closed fara org, super-admin exclus din semnatari (v3.9.674)"
git push origin develop
```

=====================================================================
## RAPORT FINAL
=====================================================================

1. **Partea A:** semnătura reală a lui `set()`. Ai găsit o clasă CSS de avertizare pentru >100%,
   sau ai lăsat cifra simplă?
2. **A4:** `audit.js` e în `PRECACHE_ASSETS`? Ai bump-at `CACHE_VERSION`? Ai reparat
   `sw-no-auth-cache.test.mjs` să verifice **formatul**, nu valoarea?
3. **Partea B:** `old_str`-ul din B1 s-a potrivit exact? Dacă nu, ce ai găsit în fișier?
4. **B4:** lista **nominală** a fixture-urilor reparate, cu motivul. Dacă niciunul nu s-a rupt,
   **spune-o explicit**.
5. Output-ul complet al **PAS 7**.
6. `npm run check`, `npm test`, `npm run test:db`: rezultate + numere finale (baseline DB: 363).
7. Versiune + hash commit + CI.
8. Confirmarea că **NU** ai atins `main`, `server/routes/admin/flows.mjs` (query-ul de stats),
   sau NO-TOUCH ZONE.

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Partea A: FĂRĂ plafonare la 100%.** Decizie de produs. O rată >100% se afișează ca atare.
- ⛔ **Partea A: angajat = 0 ⇒ `—`, NU `0%`.**
- ⛔ **NU** modifica `server/routes/admin/flows.mjs` — query-ul de stats întoarce deja tot.
- ⛔ **Partea B: NU** folosi `actorOrgFilter()` în `/users` — ar da super-adminului vizibilitate
  globală pe dropdown-ul de semnatari.
- ⛔ **Partea B: NU** păstra niciun fallback care întoarce utilizatori din afara organizației.
  Fără `org_id` ⇒ **listă goală**.
- ⛔ **NU** slăbi asserțiile testelor existente. Repară fixture-ul.
- ⛔ **NU** inventa clase CSS. Dacă nu găsești una de avertizare, raportează.
- ⛔ **NU** face bulk-replace pe `?v=`.
- ⛔ **NO-TOUCH ZONE:** `server/signing/*`, `server/routes/flows/cloud-signing.mjs`.
- ⛔ `develop` exclusiv. Fără `git add .`, `stash`, `reset`, `clean`, `revert`, `force-push`.
- ⛔ Fără migrări DB. Fără pachete npm noi.
