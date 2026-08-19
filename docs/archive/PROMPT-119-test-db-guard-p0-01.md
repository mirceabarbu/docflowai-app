---
model_suggested: Sonnet 4.6   # modificare mică, chirurgicală, în harness-ul de test
target_branch: develop
version_bump: 3.9.747 → 3.9.748   (dacă #118 nu a rulat încă: 3.9.746 → 3.9.747)
cache_bump: NU
qv_bump: NU
---

═══════════════════════════════════════════════════════════════════
⚠️  AVERTISMENT BRANCH
═══════════════════════════════════════════════════════════════════
ȚINTĂ: branch `develop` EXCLUSIV.
NU face checkout/merge/push pe `main`. `main` = PRODUCȚIE, gestionat MANUAL de Mircea.
La final: commit pe `develop` + `git push origin develop`.
═══════════════════════════════════════════════════════════════════

# PROMPT #119 — Harness-ul de test NU trebuie să poată atinge producția (audit P0-01)

## CONTEXT — cea mai periculoasă constatare a auditului pe v3.9.746

`server/tests/setup.mjs` (~linia 20) redirectează spre baza de test astfel:

```js
if (TEST_DATABASE_URL && !DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}
```

Dacă **AMBELE** variabile sunt setate, `DATABASE_URL` (adică PRODUCȚIA) rămâne
câștigătoare — în timp ce `hasTestDb()` (`server/tests/helpers/db-real.mjs:~17`)
întoarce `true` doar pe prezența lui `TEST_DATABASE_URL`. Suita DB pornește,
se crede pe baza de test, și `truncateAll()` execută:

```sql
TRUNCATE registru_intrari, alop_instances, formulare_ord, formulare_df,
         flows, users, organizations RESTART IDENTITY CASCADE
```

**pe producție.** Un shell Railway are `DATABASE_URL` setat nativ, iar un `.env`
local cu credențiale de producție produce exact aceeași situație. Un singur
`npm run test:db` rulat în contextul greșit distruge baza unei instituții
publice — inclusiv semnături calificate și evidența ALOP.

Nu e teoretic: `npm run test:db` a fost rulat de mai multe ori în ultimele zile.

OBIECTIV: fac imposibil, prin construcție, ca suita de test să șteargă altceva
decât o bază de test — cu eșec ZGOMOTOS, nu tăcut.

═══════════════════════════════════════════════════════════════════
PAS 0 — CITEȘTE ÎNTÂI (fără modificări)
═══════════════════════════════════════════════════════════════════
- `server/tests/setup.mjs` (integral — e scurt)
- `server/tests/helpers/db-real.mjs` (`hasTestDb`, `truncateAll`, crearea pool-ului)
- `package.json` — scripturile `test` și `test:db` (cum se transmite TEST_DATABASE_URL)

⚠️ Ancorele de mai jos sunt orientative (din audit). CITEȘTE fișierele și
adaptează `old_str` la conținutul real. NU ghici.

═══════════════════════════════════════════════════════════════════
PAS 1 — `setup.mjs`: redirectare NECONDIȚIONATĂ + avertisment
═══════════════════════════════════════════════════════════════════
Înlocuiește condiția `if (TEST_DATABASE_URL && !DATABASE_URL)` cu o redirectare
necondiționată: dacă `TEST_DATABASE_URL` există, EL câștigă întotdeauna.

```js
// v3.9.748 (audit P0-01): TEST_DATABASE_URL are ÎNTOTDEAUNA prioritate.
// Varianta veche (`&& !DATABASE_URL`) lăsa DATABASE_URL — adică PRODUCȚIA —
// să câștige când ambele erau setate, în timp ce hasTestDb() raporta „sunt pe
// baza de test" ⇒ truncateAll() ar fi rulat TRUNCATE pe producție.
if (TEST_DATABASE_URL) {
  if (DATABASE_URL && DATABASE_URL !== TEST_DATABASE_URL) {
    console.warn(
      '[tests] DATABASE_URL era setat și DIFERIT de TEST_DATABASE_URL — ' +
      'a fost IGNORAT. Testele rulează exclusiv pe TEST_DATABASE_URL.'
    );
  }
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}
```

# Verificare PAS 1:
node --check server/tests/setup.mjs
grep -n "TEST_DATABASE_URL && !DATABASE_URL" server/tests/setup.mjs
# Așteptat: 0 rezultate

═══════════════════════════════════════════════════════════════════
PAS 2 — `db-real.mjs`: poartă fail-closed ÎNAINTE de orice TRUNCATE
═══════════════════════════════════════════════════════════════════
Redirectarea din PAS 1 nu e suficientă: cine importă `db-real.mjs` fără să
treacă prin `setup.mjs` ocolește complet protecția. Poarta trebuie să fie
lipită de operația distructivă.

(a) ADAUGĂ un helper privat în `server/tests/helpers/db-real.mjs`:

```js
// v3.9.748 (audit P0-01): poartă fail-closed lipită de operația distructivă.
// Se apelează ÎNAINTE de orice TRUNCATE/DROP. Aruncă — niciodată „skip tăcut".
function assertTestDatabase() {
  const test = process.env.TEST_DATABASE_URL;
  const active = process.env.DATABASE_URL;
  if (!test) {
    throw new Error('[tests] REFUZ TRUNCATE: TEST_DATABASE_URL nu este setat.');
  }
  if (active && active !== test) {
    throw new Error(
      '[tests] REFUZ TRUNCATE: DATABASE_URL diferă de TEST_DATABASE_URL. ' +
      'Suita de test NU rulează pe o bază de test. Dezactivează DATABASE_URL ' +
      'din mediu (shell/.env) și reia.'
    );
  }
}
```

(b) În `truncateAll()`, ca **PRIMĂ** instrucțiune (înainte de orice query),
apelează `assertTestDatabase();`, apoi adaugă a doua verificare, la nivel de
conexiune — singura care nu poate fi păcălită de variabile de mediu:

```js
  assertTestDatabase();

  // A doua poartă: întreabă chiar serverul pe ce bază suntem. `pg_database_size`
  // pe o bază de producție cu date reale e cu ordine de mărime peste una de test
  // proaspătă; iar numele bazei de test trebuie să conțină 'test'.
  const { rows: dbInfo } = await pool.query(
    `SELECT current_database() AS db, pg_database_size(current_database()) AS bytes`
  );
  const dbName = String(dbInfo[0]?.db || '');
  if (!/test/i.test(dbName) && process.env.TEST_DB_ALLOW_ANY_NAME !== '1') {
    throw new Error(
      `[tests] REFUZ TRUNCATE: baza conectată se numește "${dbName}" și nu conține "test". ` +
      'Dacă e intenționat (bază efemeră cu alt nume), setează TEST_DB_ALLOW_ANY_NAME=1.'
    );
  }
```

⚠️ `TEST_DB_ALLOW_ANY_NAME` există pentru că instanța efemeră de PG 17 folosită
azi poate avea alt nume. Verifică în `package.json` / scriptul de test cum se
numește baza efemeră: dacă NU conține „test", adaugă variabila în scriptul
`test:db` din `package.json` — ca portița să fie explicită în repo, nu o
surpriză la prima rulare.

⛔ NU transforma eșecul în `return` sau `skip`. Trebuie să ARUNCE și să oprească
suita. Un TRUNCATE sărit tăcut e exact modul în care bug-ul ăsta a supraviețuit.

# Verificare PAS 2:
node --check server/tests/helpers/db-real.mjs
grep -n "assertTestDatabase" server/tests/helpers/db-real.mjs
# Așteptat: 2 (definiție + apel în truncateAll)

═══════════════════════════════════════════════════════════════════
PAS 3 — Test de regresie pe poarta însăși
═══════════════════════════════════════════════════════════════════
Fișier nou `server/tests/unit/test-db-guard.test.mjs` (unit, FĂRĂ conexiune reală):

1. `setup.mjs`: cu `TEST_DATABASE_URL='postgres://test'` ȘI
   `DATABASE_URL='postgres://PRODUCTIE'`, după încărcare `process.env.DATABASE_URL`
   === `'postgres://test'` (producția a fost ignorată). Salvează și restaurează
   `process.env` în `beforeEach`/`afterEach`.
2. `assertTestDatabase` aruncă dacă `TEST_DATABASE_URL` lipsește.
3. `assertTestDatabase` aruncă dacă `DATABASE_URL !== TEST_DATABASE_URL`.
4. `truncateAll` cu un pool stub care întoarce `current_database() = 'railway'`
   aruncă și **NU** emite niciun `TRUNCATE` (verifică textele query-urilor primite
   de stub).
5. Același stub cu `current_database() = 'docflowai_test'` ⇒ TRUNCATE-ul se emite.

Dacă `assertTestDatabase` nu e exportată, exportă-o explicit pentru test
(`export function assertTestDatabase`) — e cod de test, nu suprafață de producție.

# Verificare PAS 3:
npm test
# Așteptat: verde, +5 teste, zero regresii
npm run test:db
# Așteptat: verde, PASSED (nu SKIPPED) — poarta nu trebuie să blocheze rularea normală

═══════════════════════════════════════════════════════════════════
PAS 4 — Bump versiune
═══════════════════════════════════════════════════════════════════
`package.json`: patch +1 față de versiunea curentă din repo (3.9.747 → 3.9.748
dacă #118 a rulat; altfel 3.9.746 → 3.9.747). NU atinge `sw.js`, NU rula sed pe `?v=`.

═══════════════════════════════════════════════════════════════════
RAPORT FINAL (obligatoriu)
═══════════════════════════════════════════════════════════════════
- Fișiere atinse + conținutul REAL al condiției vechi din `setup.mjs` (citat).
- Numele bazei efemere folosite de `test:db` și dacă a fost nevoie de `TEST_DB_ALLOW_ANY_NAME`.
- Ieșirea `npm test` + `npm run test:db` (PASSED, nu SKIPPED).
- Cele 5 cazuri noi + rezultate.
- Hash commit + confirmarea `git push origin develop`.

═══════════════════════════════════════════════════════════════════
⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════
⛔ ZERO modificări în cod de producție (`server/routes/**`, `server/services/**`,
   `server/db/**`, `public/**`). Acest prompt atinge DOAR harness-ul de test
   și `package.json`.
⛔ NU atinge `server/signing/**`, `server/routes/flows/cloud-signing.mjs`,
   `server/routes/flows/bulk-signing.mjs` (zonă NO-TOUCH).
⛔ NU adăuga migrații.
⛔ NU face checkout/merge/push pe `main`. Push DOAR pe `origin develop`.
⛔ Eșecul porții ARUNCĂ — niciodată skip/return tăcut.

PAS FINAL: `git add -A && git commit -m "fix(tests): poarta fail-closed impotriva TRUNCATE pe productie (audit P0-01)" && git push origin develop`
