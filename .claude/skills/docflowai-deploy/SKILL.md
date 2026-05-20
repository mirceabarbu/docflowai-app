---
name: docflowai-deploy
description: >
  Procedura OBLIGATORIE pentru deploy DocFlowAI din `develop` în `main`
  (producție: app.docflowai.ro). Folosește acest skill ORI DE CÂTE ORI
  utilizatorul cere „merge develop → main", „dă drumul în producție",
  „deploy prod", „PR develop main", „pornește producția prin merge" sau
  orice cuvânt care implică să atingi branch-ul `main`. Acoperă: gate-uri
  pre-merge (staging healthy, teste verzi, migrări verificate), backup
  obligatoriu `pg_dump` local, secvența de merge `--no-ff`, bump versiune
  + `CACHE_VERSION` în `sw.js`, monitorizare post-deploy 10 min,
  rollback plan. Skill-ul ÎNLOCUIEȘTE interdicția implicită „nu atinge
  main" — dar fiecare pas distructiv (`git push origin main`) cere
  confirmare explicită „DA, merge" de la Mircea. NU folosi acest skill
  pentru a restarta un container mort în Railway — acela e separat
  (dashboard Railway → Restart).
---

# DocFlowAI — Deploy `develop` → `main` (producție)

Scop: livrare controlată în producție, fără 503 `db_not_ready` și fără
pierdere de date. Sursa de adevăr a procesului: lecțiile din
`docs/incidents/2026-04-19-db-init-failure.md` + secțiunile „Deployment
Railway" și „Database Migrations" din `CLAUDE.md`.

## Context branch-uri (FIX)

- `develop` → push automat la **staging** (`docflowai-app-staging.up.railway.app`).
- `main` → push automat la **producție** (`app.docflowai.ro`). **Merge-ul
  în main = deploy în producție**, fără pas separat.
- Producția are clienți reali (primării/direcții). Downtime = stres pentru
  utilizatori care încearcă să semneze QES. Tratează fiecare deploy ca pe
  un eveniment care poate cădea.

## Când NU folosi acest skill

- Container producție mort/unresponsive, dar codul de pe `main` e OK
  (cazul incidentului 2026-05-20: 0 CPU, 0 MEM, requests 502 dial
  timeout). → Restart manual din Railway dashboard. Un merge nu rezolvă
  un proces zombie; doar îl înlocuiește printr-un container nou, dar nu
  diagnostichezi cauza. Întreabă utilizatorul: „producția e jos pentru că
  ai cod nou de livrat, sau pentru că procesul s-a oprit fără cauză din
  cod?". Dacă a doua — refuză skill-ul, redirecționează la Railway.
- Hotfix care n-a trecut prin `develop`. Nu e voie commit direct pe `main`
  fără să existe **întâi** pe `develop` și pe staging. Excepție absolută:
  doar dacă Mircea spune explicit „merge direct main, asum riscul".

## Gate-uri pre-merge (HARD — toate trebuie verificate înainte de orice)

Skill-ul **oprește** la primul „nu". Nu negocia, nu da workaround.

### 1. Staging verde și recent

```bash
# Staging up?
curl -sf -o /dev/null -w "%{http_code}\n" \
  https://docflowai-app-staging.up.railway.app/health
# Așteptat: 200. Dacă nu — nu merge.

# Ultimul commit pe develop e deja pe staging?
git fetch origin
git log -1 --format='%H %s' origin/develop
# Verifică în Railway că deploy-ul staging corespunde acestui SHA.
```

Dacă staging a fost stabil < 24h pe ultimul commit, **întreabă**
utilizatorul: „ultimul push pe develop e mai vechi de 24h pe staging?
Confirmi că ai testat funcțional (login + un workflow end-to-end)?".
Fără confirmare → STOP.

### 2. Branch local curat și sincronizat

```bash
git status                                    # working tree clean
git checkout develop && git pull origin develop
git checkout main    && git pull origin main
git log main..develop --oneline               # ce intră în prod
```

Lista de commit-uri afișată la ultimul pas = exact ce merge live. Dacă
există commit-uri pe care nu le recunoști / nu le-a făcut Mircea →
STOP, întreabă.

### 3. Teste verzi pe `develop`

```bash
git checkout develop
npm test
```

`npm test verde, fără regresii`. Picat = STOP. Nu deploy cu teste roșii
„doar pentru asta".

### 4. Verificare migrări noi (regulile incident 2026-04-19)

Identifică migrările inline + V4 noi față de `main`:

```bash
git diff main..develop -- server/db/index.mjs | grep -E "^\+.*MIGRATIONS|id:\s*'[0-9]+_"
git diff main..develop -- server/db/migrations/ --stat
```

Pentru **fiecare** migrare nouă (inline sau V4) verifică:

- `CREATE TABLE IF NOT EXISTS` (nu `CREATE TABLE` simplu)
- `ADD COLUMN IF NOT EXISTS` (Postgres 9.6+)
- `ADD CONSTRAINT` doar în bloc `DO $$ ... EXCEPTION WHEN duplicate_object`
- `NOT NULL` doar cu `DEFAULT` dacă tabela are date
- `ALTER TABLE <tabelă>` pe tabele V4 (`alop_instances`, `alop_sabloane`,
  ...) — **OBLIGATORIU** wrappată în guard `IF EXISTS`, altfel se repetă
  incidentul: inline rulează **înainte** de V4, tabela nu există pe prod,
  întreaga tranzacție face ROLLBACK, `markDbReady()` nu se apelează,
  toate endpoint-urile returnează 503.
- Zero `DROP` / `TRUNCATE` / `RENAME` fără confirmare explicită Mircea.
- `server/db/migrate.mjs` **NEATINS** (force-rerun pe ID e periculos).

Dacă oricare e încălcat → STOP, fix pe `develop`, reia.

### 5. Bump versiune + cache busting (regula proiectului)

Dacă merge-ul conține schimbări frontend (HTML/JS/CSS în `public/`):

```bash
# Verifică dacă bump-ul e deja făcut pe develop
grep '"version"' package.json
grep 'CACHE_VERSION' public/sw.js
git log -p --since="48 hours ago" -- package.json public/sw.js | head -30
```

Dacă există schimbări frontend dar versiunea n-a fost bump-uită → STOP.
Bump pe `develop` întâi (`package.json` patch +1 + `sw.js` `CACHE_VERSION`
incrementat + `sed` pe `?v=` în HTML-urile atinse), push, așteaptă
redeploy staging, apoi reia skill-ul.

## Backup obligatoriu (OPREȘTE FĂRĂ EL)

Lecția incidentului 2026-04-19: „nu te baza pe Railway backup". Înainte
de **orice** `git push origin main`:

```bash
mkdir -p ~/docflowai-backups
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP=~/docflowai-backups/prod-${TS}-pre-deploy.sql

# Folosește variabila DATABASE_URL din Railway (producție)
# pg_dump full, schema + date, fără owner
pg_dump --no-owner --no-privileges --clean --if-exists \
        "$PROD_DATABASE_URL" > "$DUMP"

ls -lh "$DUMP"   # confirmă că fișierul există și nu e gol
wc -l "$DUMP"    # >0 linii
```

**Cere utilizatorului**: „backup salvat la `$DUMP` (mărime: X MB). Confirmi
că l-ai văzut local înainte să continui?". Răspuns oricare ≠ „da" / „yes"
/ „confirm" → STOP.

Dacă utilizatorul n-are `PROD_DATABASE_URL` la îndemână, oferă
alternativa: `railway run --service Postgres pg_dump > $DUMP` (presupune
că e logat în Railway CLI și a selectat environment-ul corect).

## Secvența de merge (numai după ce TOATE de mai sus au trecut)

```bash
git checkout main
git pull origin main

# Mesaj standard — include versiunea livrată și lista succintă
VERSION=$(node -p "require('./package.json').version")
git merge --no-ff develop \
  -m "deploy: v${VERSION} → producție" \
  -m "Conține: <listă scurtă, max 5 puncte>" \
  -m "Backup: ~/docflowai-backups/prod-${TS}-pre-deploy.sql"
```

`--no-ff` e obligatoriu (păstrează merge commit-ul ca punct de rollback).

**Înainte de push**, afișează:

```bash
git log -1 --stat                # ce s-a făcut commit
git log main@{u}..main --oneline # ce urmează să fie push-at
```

și **cere confirmare explicită**:

> „Sunt gata să fac `git push origin main` — asta declanșează deploy-ul
> automat pe `app.docflowai.ro`. Scrie `DA, merge` ca să continui."

Răspuns ≠ exact `DA, merge` (case-insensitive acceptabil) → STOP, fă
`git reset --hard origin/main` ca să anulezi merge-ul local.

La `DA, merge`:

```bash
git push origin main
```

## Monitorizare post-deploy (OBLIGATORIE 10 min — sarcina nu e terminată fără)

În ordine, la 30s după push, repetă la 1m, 2m, 5m, 10m:

```bash
# 1. Health (cel mai important — confirmă că DB e ready)
curl -sf -w "\nHTTP %{http_code} | %{time_total}s\n" \
  https://app.docflowai.ro/health

# Așteptat: HTTP 200. Orice 5xx (în special 503 db_not_ready) = INCIDENT.

# 2. Pagina de login răspunde
curl -sf -o /dev/null -w "login: HTTP %{http_code}\n" \
  https://app.docflowai.ro/

# 3. Versiunea servită = cea push-ată
curl -sf https://app.docflowai.ro/health | grep -oE '"version":"[^"]+"'
# Trebuie să fie v${VERSION}.
```

În Railway dashboard (sau `railway logs --service docflowai-app`):

- caută `DB ready.` (mesaj scurt din `initDbWithRetry`)
- **NU** trebuie să vezi `DB init failed` / `ROLLBACK` / `relation "..." does not exist`
- la migrări noi: log-ul trebuie să le menționeze fără eroare

Dacă oricare semn de probă pică:

1. **Nu re-merge**. Nu „mai încearcă". 
2. Cere lui Mircea decizia: rollback automat sau diagnostic.
3. Pentru rollback rapid vezi secțiunea următoare.

## Rollback (numai cu confirmare explicită Mircea)

Două căi, în ordinea preferinței:

### A. Revert merge commit (păstrează istoria, safe)

```bash
git checkout main
git pull origin main
git revert -m 1 HEAD                 # -m 1 = păstrează parintele main
git push origin main                 # declanșează redeploy
```

Avantaj: nu pierzi commit-uri, rămâne audit trail. Producția revine la
starea pre-merge după redeploy (~2-5 min). **Bonus**: pe `develop` poți
investiga ce-a stricat fără presiune.

### B. Reset hard la commit-ul anterior (DOAR în caz de catastrofă)

```bash
git checkout main
git reset --hard <SHA-anterior-merge-ului>
git push --force-with-lease origin main
```

**Doar cu confirmare scrisă „DA, force push main"**. Riscant: rescrie
istoria. Folosește doar dacă revert-ul ar lăsa producția în stare proastă
(ex: migrări non-reversibile pe care le-ai aplicat oricum).

### Restore DB din backup (în caz de corupție date)

```bash
psql "$PROD_DATABASE_URL" < ~/docflowai-backups/prod-${TS}-pre-deploy.sql
```

**Doar cu confirmare „DA, restore DB" + Mircea trebuie să fie online**.
Asta înlocuiește datele scrise în interval — pierzi tot ce s-a întâmplat
între backup și restore.

## Zone INTERZISE chiar și în deploy

Reguli din `CLAUDE.md` care rămân valabile:

- Nu „rezolva" o problemă de deploy modificând fișierele de signing
  (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
  `pades.mjs`, `java-pades-client.mjs`). Dacă deploy-ul pică pe semnare,
  rollback și ridică tichet.
- Nu schimba `server/db/migrate.mjs`. Force-rerun ID e interzis.
- Nu rula `DROP` / `TRUNCATE` pe prod „ca să rezolvi" o migrare picată.

## Checklist final (toate „da" înainte să raportezi „deploy făcut")

1. Staging răspunde 200 pe `/health` și e pe SHA-ul livrat? ✅
2. `git status` curat, `git log main..develop` arată exact ce era de
   livrat? ✅
3. `npm test verde, fără regresii` pe `develop`? ✅
4. Migrări noi inspectate manual — toate `IF NOT EXISTS` / `IF EXISTS`,
   zero `DROP`, zero atingere `migrate.mjs`? ✅
5. Bump `package.json` + `CACHE_VERSION` în `sw.js` făcut pe `develop`
   (dacă a fost schimbare frontend)? ✅
6. `pg_dump` salvat local și Mircea a confirmat că-l vede? ✅
7. Merge `--no-ff` cu mesaj standardizat (`deploy: vX → producție`)? ✅
8. Confirmare explicită „DA, merge" primită înainte de `git push origin main`? ✅
9. Monitorizare 10 min: `/health` 200, login OK, `DB ready.` în log,
   zero 503? ✅
10. Versiunea servită de prod = cea push-ată (`curl /health | grep version`)? ✅
11. Raport scurt către Mircea: versiune livrată + lista comiturilor +
    cale backup + status `/health`? ✅

Dacă oricare e „nu" — sarcina nu e terminată. Nu spune „gata, am
deploy-at" până la 11/11.

## Raport final (formatul obligatoriu către Mircea)

```
DEPLOY: v3.9.XXX → producție
Backup:  ~/docflowai-backups/prod-YYYYMMDDTHHMMSSZ-pre-deploy.sql (X MB)
Commits livrate (N):
  - <sha> <subject>
  - ...
Migrări noi (M):
  - inline: 0XX_<nume>
  - V4:     0XX_<nume>.sql
Post-deploy (verificat 10 min):
  - /health: 200 ✅
  - login:   200 ✅
  - DB ready.: da ✅
  - 503 errors: 0 ✅
Versiune servită: v3.9.XXX (confirmat via /health)
```
