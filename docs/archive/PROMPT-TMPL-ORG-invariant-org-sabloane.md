---
task: "TMPL-ORG — șabloanele shared nu mai pot rămâne fără org (PUT + invariant în Postgres)"
branch: develop
model_suggested: Opus 4.8   # migrație cu CHECK pe tabel existent = risc de blocare la boot
target_version: v3.9.739
migrations: DA — inline `100_templates_org_invariant` (următoarea după 099)
cache_version_bump: NO   # templates.js NU e în PRECACHE_ASSETS (verificat)
---

# ⚠️ BRANCH: develop
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. NU face niciodată merge / checkout / push pe `main`.

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE (obligatoriu)
```
git branch --show-current
# Așteptat: develop
# Dacă NU e develop: git checkout develop  (și NU comite nimic pe main)
git fetch origin && git status
```
(Au fost patru sesiuni în care agentul a pornit pe `main`. Verifică, nu presupune.)

===============================================================================
## CONTEXT / BUG
===============================================================================

Un șablon `shared=TRUE` cu `org_id IS NULL` e **invizibil pentru toată lumea**
în afară de proprietar — `GET /api/templates` filtrează
`WHERE user_email=$1 OR (shared=TRUE AND org_id=$2)`, iar `org_id = NULL` nu se
potrivește niciodată. Dacă și proprietarul e șters/fără org, rândul devine
FANTOMĂ: invizibil pentru absolut toți, deci nici măcar butonul „Șterge" adăugat
în v3.9.738 nu-l poate atinge (butonul apare doar pe carduri care ajung în listă).

**Cauza (verificată pe cod):** asimetrie POST vs PUT în `server/routes/templates.mjs`.
- `POST` (linia ~56): `const orgId = actor.org_id || null;` + gardă
  `if (shared && !orgId) return 409 'user_without_org'` + inserează `org_id`.
- `PUT` (linia ~69): folosește `requireAuth` (deci **nu are `org_id` deloc**) și
  `UPDATE templates SET name=$1,signers=$2,shared=$3,updated_at=NOW() …` —
  **nu atinge `org_id`**. Deci un rând vechi cu `org_id NULL` devine `shared=TRUE`
  la apăsarea „Share" și rămâne fără org.

Datele au fost DEJA reparate manual pe staging și producție (22.07). Promptul ăsta
închide gaura în cod ȘI în bază, ca să nu se mai poată produce.

===============================================================================
## PASUL 1 — Migrație inline `100_templates_org_invariant`
===============================================================================

Fișier: `server/db/index.mjs`. Adaugă un obiect NOU în lista de migrații V4,
imediat DUPĂ `099_lichidare_valoare_factura`. Verifică întâi:
```
grep -n "099_lichidare_valoare_factura" server/db/index.mjs
# Așteptat: 1 apariție; migrația nouă se adaugă după blocul ei (obiectul se termină cu `},`)
```

⚠️ **ORDINEA E CRITICĂ — vindecă ÎNTÂI, adaugă CHECK-ul DUPĂ.**
Un `ADD CONSTRAINT CHECK` pe un tabel care conține fie și un singur rând
neconform EȘUEAZĂ, iar migrațiile rulează la boot ⇒ aplicația nu mai pornește.
Asta e exact clasa incidentului din aprilie (migrația 055). Datele de pe prod sunt
curate ACUM, dar migrația trebuie să fie corectă pe ORICE bază (fresh, staging,
o a doua primărie), deci pașii de vindecare rămân în migrație chiar dacă azi sunt no-op.

Conținut (oglindește garda din `093_alop_state_gate` — `DO $g$` + `pg_constraint`):

```js
  {
    // v3.9.739 (#TMPL-ORG): un șablon shared nu poate rămâne fără org.
    // Un rând `shared=TRUE AND org_id IS NULL` e invizibil în GET /api/templates
    // pentru toți în afară de proprietar (rând-fantomă dacă proprietarul e șters).
    // ORDINEA CONTEAZĂ: vindecă rândurile ÎNAINTE de ADD CONSTRAINT, altfel
    // migrația eșuează la boot pe orice bază cu date murdare.
    id: '100_templates_org_invariant',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='templates'
        ) THEN RETURN; END IF;

        -- 1) Vindecare: derivă org_id din proprietarul activ, acolo unde lipsește.
        UPDATE templates t
           SET org_id = u.org_id
          FROM users u
         WHERE lower(u.email) = lower(t.user_email)
           AND u.deleted_at IS NULL
           AND u.org_id IS NOT NULL
           AND t.org_id IS NULL;

        -- 2) Rândurile rămase fără org derivabil: le facem PRIVATE, NU le ștergem.
        --    Rămân vizibile proprietarului (ramura user_email din GET) și devin
        --    conforme cu invariantul. ⛔ Nicio ștergere de date într-o migrație.
        UPDATE templates
           SET shared = FALSE
         WHERE shared = TRUE AND org_id IS NULL;

        -- 3) Invariantul, abia acum.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'templates_shared_needs_org') THEN
          ALTER TABLE templates ADD CONSTRAINT templates_shared_needs_org
            CHECK (NOT (shared AND org_id IS NULL));
        END IF;
      END $g$;
    `
  },
```

Dacă vreo parte din bloc nu se compilă, oprește-te și raportează — nu improviza
pe o migrație care rulează la boot.

Verificare:
```
grep -n "100_templates_org_invariant\|templates_shared_needs_org" server/db/index.mjs
# Așteptat: id-ul o dată, numele constrângerii de două ori (IF NOT EXISTS + ADD CONSTRAINT)
```

===============================================================================
## PASUL 2 — PUT: resolveActorOr + gardă + vindecare la scriere
===============================================================================

Fișier: `server/routes/templates.mjs`, ruta `PUT /api/templates/:id`.

old_str:
```
router.put('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
```
new_str:
```
router.put('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const tokenActor = requireAuth(req, res); if (!tokenActor) return;
  const actor = await resolveActorOr(res, tokenActor, req); if (!actor) return;
  const id = parseInt(req.params.id);
```

Apoi blocul de UPDATE. old_str:
```
  try {
    const { rows } = await pool.query(
      'UPDATE templates SET name=$1,signers=$2,shared=$3,updated_at=NOW() WHERE id=$4 AND user_email=$5 RETURNING *',
      [name?.trim(), JSON.stringify(signers), !!shared, id, actor.email.toLowerCase()]
    );
```
new_str:
```
  const orgId = actor.org_id || null;
  // Aceeași gardă ca la POST: nu poți partaja un șablon dacă nu ai organizație —
  // ar deveni invizibil pentru toți (shared=TRUE + org_id NULL).
  if (shared && !orgId) {
    return res.status(409).json({ error: 'user_without_org', message: 'Contul nu este asociat unei organizații.' });
  }
  try {
    // COALESCE(org_id, $6): vindecă rândurile vechi cu org_id NULL, dar NU re-pointează
    // un șablon care are deja un org (deliberat — evităm mutarea tăcută între organizații).
    const { rows } = await pool.query(
      'UPDATE templates SET name=$1,signers=$2,shared=$3,org_id=COALESCE(org_id,$6),updated_at=NOW() WHERE id=$4 AND user_email=$5 RETURNING *',
      [name?.trim(), JSON.stringify(signers), !!shared, id, actor.email.toLowerCase(), orgId]
    );
```

⛔ NU schimba contractul de eroare al lui PUT — rămâne `404 not_found_or_not_owner`
(owner-only, intenționat diferit de DELETE, care are de la v3.9.738 ramura admin).
⛔ NU atinge GET / POST / DELETE în acest pas.

Verificare:
```
grep -n "COALESCE(org_id" server/routes/templates.mjs
grep -n "user_without_org" server/routes/templates.mjs
# Așteptat: COALESCE o dată (în PUT); user_without_org de DOUĂ ori (POST + PUT)
```

===============================================================================
## PASUL 3 — Frontend: arată mesajul real la 409 pe „Share"
===============================================================================

Fișier: `public/js/templates/templates.js`, funcția `toggleShared` (~linia 346).
Azi înghite orice eroare într-un `alert('Eroare la actualizare.')` generic — cu
noua gardă, un utilizator fără organizație ar primi un mesaj inutil.

old_str:
```
    if(!r.ok) throw new Error(); loadTemplates();
  } catch(e){alert('Eroare la actualizare.');}
```
new_str:
```
    if(!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.message || j.error || ''); }
    loadTemplates();
  } catch(e){alert(e.message ? ('Eroare la actualizare: '+e.message) : 'Eroare la actualizare.');}
```
⛔ Verifică întâi că `old_str` e unic în fișier (`deleteTemplate` are o linie
asemănătoare cu `'Eroare la ștergere.'` — NU o atinge).

===============================================================================
## PASUL 4 — Cache-bust + versiune
===============================================================================
```
sed -i -E "s#(templates/templates\.js\?v=)[0-9.]+#\13.9.739#g" public/templates.html
grep -n "templates/templates.js?v=" public/templates.html
# Așteptat: ?v=3.9.739
```
Bump `package.json` → `3.9.739`.
⛔ NU bumpа `CACHE_VERSION` (templates.js nu e în PRECACHE_ASSETS).
⛔ NU face bulk-sed pe alte `?v=`.

===============================================================================
## PASUL 5 — Teste
===============================================================================

### 5a. Unit — `server/tests/unit/templates.test.mjs`
⚠️ PUT folosește ACUM `resolveActorOr` ⇒ prima interogare mock e user lookup
(`mockResolvedValueOnce({rows:[mockUserRow(...)]})`), apoi UPDATE. Testele PUT
existente trebuie actualizate la noua secvență.

Cazuri:
1. owner cu org, `shared:true` → 200; verifică prin argumentele mock-ului că SQL-ul
   conține `COALESCE(org_id` și că `$6` = org-ul actorului.
2. owner FĂRĂ org (`org_id: null`), `shared:true` → **409 `user_without_org`**,
   fără să atingă UPDATE-ul.
3. owner FĂRĂ org, `shared:false` → 200 (nu se partajează, deci e permis).
4. non-owner → 404 `not_found_or_not_owner` (contract NEschimbat).
5. Testele PUT existente rămân verzi după migrarea secvenței de mock-uri.

### 5b. DB (invariantul chiar contează) — `server/tests/db/templates-org-invariant.test.mjs`
Fișier NOU, pe PG real:
1. `INSERT` cu `shared=TRUE, org_id=NULL` → **respins** de constrângere
   (așteaptă eroare cu `templates_shared_needs_org` / cod `23514`).
2. `INSERT` cu `shared=TRUE, org_id=<org valid>` → reușește.
3. `INSERT` cu `shared=FALSE, org_id=NULL` → reușește (privat fără org e permis).
4. `UPDATE` care ar face `shared=TRUE` pe un rând cu `org_id NULL` → respins.

⛔ Testul IMPORTĂ/folosește schema reală prin helperele existente din
`server/tests/helpers/db-real.mjs` — nu redeclara tabele manual.

===============================================================================
## PASUL 6 — Porți (ÎNAINTE de commit)
===============================================================================
```
npm test
# Așteptat: verde. Baseline la intrare = 108 fișiere / 1394 teste.

npm run test:db     # OBLIGATORIU — migrația e miezul acestui prompt
```
⛔ „Docker absent" NU e motiv de skip. Folosește instanța PG 17 EFEMERĂ
(rețeta din CLAUDE.md, port 55432). `test:db` SKIPPED = prompt NEterminat.

**Poartă suplimentară de migrație — rulează migrațiile de DOUĂ ori pe aceeași bază**
și confirmă că a doua rulare e no-op curat (idempotență). Raportează ieșirea.

===============================================================================
## PASUL 7 — Commit + PUSH
===============================================================================
```
git add server/db/index.mjs server/routes/templates.mjs public/js/templates/templates.js public/templates.html package.json server/tests/unit/templates.test.mjs server/tests/db/templates-org-invariant.test.mjs
git commit -m "fix(templates): șablon shared nu mai poate rămâne fără org — PUT + CHECK în Postgres (migrația 100) — v3.9.739"
git push origin develop
```

===============================================================================
## RAPORT FINAL
===============================================================================
- Commit hash + versiune.
- `npm test` și `npm run test:db`: nr. fișiere / teste, PASS/FAIL. Dacă `test:db` nu a
  rulat REAL, spune-o explicit — nu raporta „verde" pe o suită sărită.
- Rezultatul rulării DUBLE a migrațiilor (a doua = no-op?).
- Ieșirea reală a fiecărui `grep` de verificare.
- Orice abatere + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================
- ⛔ BRANCH: develop. PASUL 0 nu e opțional.
- ⛔ Vindecarea datelor vine ÎNAINTEA `ADD CONSTRAINT`, în aceeași migrație.
- ⛔ Nicio ștergere de rânduri în migrație — rândurile nederivabile devin `shared=FALSE`.
- ⛔ Migrație INLINE în `server/db/index.mjs`, NU fișier `.sql` nou.
- ⛔ Contractul PUT rămâne `404 not_found_or_not_owner` (owner-only).
- ⛔ NU re-pointa un șablon care are deja org (`COALESCE(org_id,$6)`, nu `$6`).
- ⛔ NU bumpа CACHE_VERSION. `?v=` doar pe templates.js.
- ⛔ `git push origin develop` la final. Pe `main` niciodată.
