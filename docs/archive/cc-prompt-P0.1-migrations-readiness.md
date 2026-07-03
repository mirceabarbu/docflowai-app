---
target_branch: develop
model_suggested: Opus 4.8 (plan mode obligatoriu înainte de orice editare)
risk: HIGH — atinge secvența de boot + migrări. Etapa 0 caracterizare obligatorie.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️

> NU face niciodată `checkout`, `merge` sau `push` pe `main`. `main` = producție,
> se gestionează manual de Mircea. Lucrezi DOAR pe `develop`. Dacă te trezești
> că vrei să atingi `main`, OPREȘTE-TE și întreabă.

# Task: migrări fatal-safe + readiness gate separat de liveness

## Context (verificat în cod, NU presupune)

Secvența actuală de boot (`server/index.mjs`, în callback-ul `httpServer.listen`):

1. `httpServer.listen()` pornește — appul răspunde deja la trafic.
2. `initDbWithRetry()` → `initDbOnce()` care cheamă `markDbReady()` (DB_READY=true).
3. abia apoi `runMigrationsV4(pool)` rulează migrările `.sql`, cu `catch` care
   loghează eroarea ca **"Migration error (non-fatal)"**.

Problema reală: `markDbReady()` se cheamă **înainte** de migrările `.sql`. Dacă o
migrare `.sql` pică, DB_READY e deja `true`, `requireDb` lasă traficul să treacă,
iar appul servește pe o schemă ne-migrată. Există incident documentat pe această
clasă de bug: `docs/incidents/2026-04-19-db-init-failure.md` — citește-l ÎNTÂI.

`/health` (în `index.mjs`) e doar liveness — întoarce mereu `ok:true`, nu reflectă
DB_READY. Nu există `/readyz`.

## Zone interzise (din CLAUDE.md)
- NU atinge: `STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
  `pades.mjs`, `java-pades-client.mjs`.
- `server/db/migrate.mjs` e sensibil. Ai voie să adaugi advisory lock în
  `runMigrations` (vezi mai jos), dar **NU** modifica logica de selecție a
  migrărilor și **NU** elimina `DELETE FROM schema_migrations WHERE id='014_alop'`
  fără confirmare explicită de la Mircea (doar semnalează-l în raport).

## Etapa 0 — caracterizare (înainte de orice modificare de producție)
Scrie teste care fixează comportamentul CURENT, ca să detectezi regresii:
- un test care confirmă că `/health` întoarce 200 + `ok:true`;
- un test (DB, `npm run test:db`) care confirmă că după un `runMigrations` reușit
  `DB_READY` e `true` și migrările apar în `schema_migrations`;
- dacă e fezabil cu infra de test existentă, un test care simulează o migrare
  `.sql` invalidă și asertează NOUL comportament dorit (DB_READY rămâne/devine
  `false`). Dacă nu e fezabil curat, notează-l ca TODO, nu forța.

Rulează `npm test` + `npm run test:db` → trebuie verzi pe baseline înainte să treci mai departe.

## Modificări cerute

1. **Ordinea readiness.** Migrările `.sql` (`runMigrationsV4`) trebuie să ruleze
   ÎNAINTE ca DB_READY să devină `true` pentru serviciul de trafic — SAU, dacă o
   migrare `.sql` pică, `DB_READY` trebuie pus pe `false` și `DB_LAST_ERROR`
   populat. Alege varianta cu impact minim asupra `db/index.mjs`, dar rezultatul
   net: **migrare `.sql` picată ⇒ appul NU servește rute DB ca „ready".**

2. **`/readyz` nou**, separat de `/health`:
   - `/health` rămâne liveness pur (proces viu), neschimbat.
   - `/readyz` întoarce `200` doar dacă `DB_READY === true` și un `SELECT 1`
     trece; altfel `503` cu `{ error: 'db_not_ready', dbLastError }`.

3. **Advisory lock în `runMigrations`** (`server/db/migrate.mjs`): la început
   `SELECT pg_advisory_lock(<cheie constantă>)`, la final (în `finally`)
   `pg_advisory_unlock(...)`. Previne cursa între două instanțe la rolling deploy
   Railway. NU schimba nimic altceva din runner.

## Definition of done
- `npm test verde, fără regresii` + `npm run test:db verde`.
- `npm run check` trece.
- `/readyz` returnează 503 când DB nu e ready, 200 când e.
- Raport scurt: ce-ai schimbat, ce NU ai atins (014_alop force-rerun semnalat dar
  neatins), ce TODO-uri rămân.
- Bump `package.json` patch +1. (Fără frontend ⇒ fără `CACHE_VERSION`.)
- Commit pe `develop`, push pe `develop`. STOP înainte de orice gând spre `main`.
