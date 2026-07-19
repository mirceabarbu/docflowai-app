---
prompt: 101
titlu: "sec(tenant): TENANT-01 — getUserMapForOrg fail-closed + citirile ne-scopate din admin"
model_suggested: Opus 4.8
branch: develop
zona: server/db/index.mjs, server/routes/admin/{flows,analytics}.mjs, teste
versiune_tinta: v3.9.687
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.682)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.
>
> ⚠️ **ATENȚIE LA NUME:** zona NO-TOUCH e `server/signing/*` (cloud-signing, bulk-signing, pades,
> java-pades-client, STSCloudProvider). Fișierele `server/routes/flows/signing.mjs` și
> `server/routes/flows/cloud-signing.mjs` sunt **alte fișiere** — dar **nici pe alea nu le atingi la
> acest prompt.** Ele intră la #102, cu recon propriu.

---

## CONTEXT

### TENANT-01 — `getUserMapForOrg` e fail-**open**

`server/db/index.mjs:2539-2556`:

```js
export async function getUserMapForOrg(orgId) {
  const cacheKey = (orgId && orgId > 0) ? String(orgId) : 'all';
  ...
  if (orgId && orgId > 0) {
    query = 'SELECT email,functie,compartiment,institutie FROM users WHERE org_id=$1';
  } else {
    query = 'SELECT email,functie,compartiment,institutie FROM users';   // ← TOȚI. Din TOATE org-urile.
  }
```

Două defecte, nu unul:

1. **Fallback-ul pe `orgId` lipsă returnează întreaga tabelă `users`** — și o cachează 60s sub cheia
   `'all'`. Comentariul din cod îl numește „backward compat pentru admini fără org". Nu e backward
   compat, e fail-open.
2. **Niciun `deleted_at IS NULL`.** Migrația 067 a înlocuit `UNIQUE(email)` cu un index parțial
   `WHERE deleted_at IS NULL` ⇒ un email **se poate reutiliza** după soft-delete ⇒ harta poate primi
   rândul utilizatorului **șters** (sau, mai rău, nedeterminist pe cel șters *sau* pe cel nou).

Apelanți reali: **doar doi** — `crud.mjs:622` (`GET /flows/:id`) și `crud.mjs:782` (`GET /my-flows`).
Celelalte 6 fișiere de rute îl **importă fără să-l apeleze** (import mort — nu-l curăța acum).

### Aceeași clasă, în admin: citiri fără niciun scope

```
server/routes/admin/flows.mjs:148    SELECT email,institutie,compartiment FROM users          ← fără org
server/routes/admin/flows.mjs:220    SELECT email,institutie,compartiment FROM users          ← fără org
server/routes/admin/flows.mjs:271    ... : await pool.query('SELECT ... FROM users')          ← ramura else = fără org
server/routes/admin/analytics.mjs:294  SELECT ... FROM users ORDER BY nume                    ← ramura else = fără org
```

Exact tiparul reparat la #89 pe `GET /users` (unde ramura de fallback returna **fiecare utilizator
din bază**). A rămas în alte patru locuri.

⚠️ **În producție nu poate declanșa azi**: 48 useri, 0 fără `org_id`, 1 organizație. E **latent**, nu
live. Îl reparăm pentru că e exact tiparul care explodează la al doilea client — nu pentru că arde acum.

---

## PAS 0 — RECON (read-only). **Poartă**: nu scrie cod până nu răspunzi.

```bash
sed -n '2528,2565p' server/db/index.mjs
grep -rn "getUserMapForOrg(" server/routes/ server/services/     # apelanți REALI (cu paranteză)
sed -n '615,625p' server/routes/flows/crud.mjs                   # de unde vine orgId
sed -n '140,155p;215,225p;265,275p' server/routes/admin/flows.mjs
sed -n '285,300p' server/routes/admin/analytics.mjs
```

**Query-ul-poartă — rulează-l pe producție (read-only):**

```sql
-- Există fluxuri FĂRĂ orgId? Ele sunt singurele care ar pierde îmbogățirea la fail-closed.
SELECT COUNT(*) AS flows_fara_org FROM flows WHERE data->>'orgId' IS NULL AND deleted_at IS NULL;

-- Există utilizatori fără org_id? (Ei ar primi hartă goală.)
SELECT COUNT(*) AS useri_fara_org FROM users WHERE org_id IS NULL AND deleted_at IS NULL;

-- Există emailuri reutilizate (un email pe un user activ ȘI pe unul șters)?
SELECT lower(email) AS e, COUNT(*) FILTER (WHERE deleted_at IS NULL) AS activi,
                           COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS sterși
  FROM users GROUP BY 1 HAVING COUNT(*) > 1;
```

**Raportează cele trei cifre.**
- `flows_fara_org > 0` ⇒ acele fluxuri vor afișa semnatarii **fără funcție/compartiment** după fix.
  **OPREȘTE-TE și raportează** — owner-ul decide dacă e acceptabil.
- `useri_fara_org > 0` ⇒ idem, oprește-te.
- Emailuri reutilizate > 0 ⇒ raportează care; înseamnă că bug-ul nr. 2 **e deja activ**, nu latent.

---

## PAS 1 — `getUserMapForOrg` fail-closed

```js
/**
 * Map de useri (email → {functie, compartiment, institutie}), STRICT pe org.
 *
 * SEC-101 (TENANT-01): fail-CLOSED. Fără org ⇒ hartă GOALĂ, nu întreaga tabelă `users`.
 * Vechiul fallback („backward compat pentru admini fără org") returna toți utilizatorii din
 * toate organizațiile și îi cacheța 60s sub cheia 'all'.
 *
 * SEC-101 (email-reuse): `deleted_at IS NULL`. Migrația 067 a înlocuit UNIQUE(email) cu un index
 * parțial pe utilizatorii activi ⇒ un email poate exista de mai multe ori în tabelă. Fără filtru,
 * harta putea prelua rândul utilizatorului ȘTERS.
 */
export async function getUserMapForOrg(orgId) {
  const oid = Number(orgId);
  if (!oid || oid <= 0) {
    logger.warn('getUserMapForOrg fără org_id — hartă goală (fail-closed, SEC-101)');
    return {};                                  // NU se cachează: e o condiție de eroare, nu o valoare
  }

  const cacheKey = String(oid);
  const cached = _userMapCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < USER_MAP_CACHE_TTL) return cached.map;

  const { rows } = await pool.query(
    `SELECT email, functie, compartiment, institutie
       FROM users
      WHERE org_id = $1
        AND deleted_at IS NULL`,
    [oid]
  );
  const map = {};
  rows.forEach(u => { map[(u.email || '').toLowerCase()] = u; });
  _userMapCache.set(cacheKey, { map, cachedAt: Date.now() });
  return map;
}
```

⚠️ **Harta goală NU se cachează.** Altfel o cerere fără org otrăvește cache-ul… iar cheia `'all'`
dispare oricum. Verifică restul funcției (liniile 2556+) și scoate orice scriere reziduală în cache
sub cheia `'all'`.

⚠️ **Invalidarea cache-ului:** caută unde se golește `_userMapCache` (`grep -n "_userMapCache" server/db/index.mjs`).
Dacă un `UPDATE users` invalidează azi cheia `'all'`, acel cod trebuie ajustat — altfel invalidezi o
cheie care nu mai există și cache-ul pe org rămâne rânced 60s. **Raportează ce ai găsit.**

---

## PAS 2 — Cele patru citiri ne-scopate din admin

Aceeași regulă în toate patru: **scope pe `org_id` + `deleted_at IS NULL`; fără org ⇒ rezultat gol,
nu „tot".**

- `admin/flows.mjs:148` și `:220` — adaugă `WHERE org_id = $1 AND deleted_at IS NULL`. Găsește de
  unde vine org-ul actorului în handlerul respectiv (`actor.orgId`). Dacă lipsește ⇒ `[]`, fail-closed.
- `admin/flows.mjs:270-271` — ramura ternară: șterge branch-ul `else` care citește toți userii.
  Fără `apOrgId` ⇒ `{ rows: [] }`.
- `admin/analytics.mjs:291-294` — idem: șterge ramura fără `org_id`.

⚠️ **NU atinge `role='admin'` / logica de super-admin.** La #89 s-a decis deja că super-adminul
platformei e exclus din listele de semnatari — nu extinde acea decizie aici și nu inventa alta.
Dacă un handler pare să depindă de „adminul vede tot", **oprește-te și raportează**; nu decide singur.

---

## PAS 3 — Ce NU faci

- ⛔ **Nu atinge `WHERE email=$1`** nicăieri (`crud.mjs:216`, `lifecycle.mjs:394,402`,
  `signing.mjs:529,556`, `cloud-signing.mjs:612,881`, `transmit.mjs`, `flow-transmit.mjs`).
  Aia e clasa „email = identitate" și intră la **#102**, cu recon propriu — jumătate e pe calea de
  semnare, iar o greșeală acolo strică semnături, nu doar un afișaj.
- ⛔ Nu curăța importurile moarte de `getUserMapForOrg` din cele 6 fișiere de rute. Alt commit.
- ⛔ Nu schimba `USER_MAP_CACHE_TTL`.
- ⛔ Zero modificări în `public/`.

---

## PAS 4 — Inventar pentru #102 (DOAR raport, zero cod)

Rulează și lipește ieșirea **în raport** — nu o pune în cod, nu repara nimic:

```bash
grep -rn "FROM users" server/ --include=*.mjs \
  | grep -v "/tests/" | grep -vi "deleted_at" \
  | sed 's/^\(.\{130\}\).*/\1…/'
```

Pentru fiecare sit, notează într-un tabel: **fișier:linie · cheia de căutare (`email` sau `id`) ·
ce se face cu rezultatul** (rezolvare semnatar / metadate cartuș PAdES / afișaj / notificare).
Ăsta e input-ul pentru #102. Căutările pe `id=$1` sunt mult mai puțin periculoase decât cele pe
`email=$1` — separă-le clar.

---

## PAS 5 — Teste (⛔ IMPORTĂ din producție — nu redeclara logica)

**Unit** — `server/tests/unit/user-map-tenant.test.mjs`, cu `pool` mock:

1. `getUserMapForOrg(null)` ⇒ `{}` **și `pool.query` NU e apelat** ← *testul care dovedește fail-closed*
2. `getUserMapForOrg(0)` / `getUserMapForOrg(undefined)` ⇒ idem
3. `getUserMapForOrg(7)` ⇒ query-ul conține `org_id` **și** `deleted_at IS NULL` (aserție pe SQL-ul primit de mock)
4. harta goală **nu** intră în cache: două apeluri cu `null` ⇒ tot `{}`, iar un apel ulterior cu org valid **interoghează** DB-ul

**DB** — `server/tests/db/user-map-tenant.test.mjs`, Postgres real.
⚠️ Ai nevoie de **două** organizații — folosește tiparul deja existent
(`seedOrgUser({ orgName: 'Org 2', email: '…', role: 'user' })`, vezi `alop-tranzitii-garzi.test.mjs:97`).
**Nume de org distinct ȘI email distinct** — `organizations.name` e UNIQUE (a picat CI-ul la #100.2 exact aici).

5. user în Org A + user în Org B ⇒ `getUserMapForOrg(orgA)` conține **doar** emailul din A
6. user soft-șters în Org A (`UPDATE users SET deleted_at=NOW()`) ⇒ **absent** din hartă
7. **email reutilizat**: user vechi în Org A soft-șters cu `x@y.ro`, user nou activ în Org A cu **același** `x@y.ro`
   ⇒ harta conține rândul celui **activ** (verifică prin `functie`, care diferă) ← *testul care dovedește bug-ul nr. 2*

---

## PAS 6 — Versiune

`package.json` → **v3.9.687**. Zero fișiere în `public/` ⇒ fără `?v=`, fără `CACHE_VERSION`.

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
sec(tenant): TENANT-01 — getUserMapForOrg fail-closed + deleted_at; scope pe org în admin/flows și analytics (v3.9.687)
```

---

## RAPORT FINAL

1. **Cele trei cifre din PAS 0.** `flows_fara_org`, `useri_fara_org`, emailuri reutilizate. Dacă vreuna e > 0 — te-ai oprit?
2. `_userMapCache` — cine îl invalidează azi și ce ai făcut cu referințele la cheia `'all'`?
3. Testul #1 (fail-closed **fără** apel la DB) și testul #7 (email reutilizat ⇒ rândul activ) — verzi? Lipește.
4. Cele patru situri din admin: le-ai scopat pe toate patru? `grep -rn "FROM users" server/routes/admin/{flows,analytics}.mjs` — lipește ieșirea.
5. Ai atins vreun `WHERE email=$1`? (**Răspunsul corect e NU.**)
6. **Tabelul-inventar din PAS 4** — lipește-l integral. E singurul livrabil care contează pentru #102.
7. Ai atins `role='admin'` / logica de super-admin? (**NU.**)
8. `git diff --name-only` — lipește. Nimic din `public/`, nimic din `server/signing/`, nimic din `server/routes/flows/`.
9. `npm test` și `npm run test:db` — **separat**, ambele verzi.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Fail-closed peste tot.** Fără org ⇒ **gol**. Niciodată „toți".
- ⛔ **Zero atingeri pe `WHERE email=$1`** — aia e #102.
- ⛔ **Zero atingeri în `server/routes/flows/`** la acest prompt.
- ⛔ Zona NO-TOUCH `server/signing/*` — neatinsă.
- ⛔ PAS 4 e **raport**, nu cod. Dacă „repari" ceva din inventar, ai depășit sarcina.
