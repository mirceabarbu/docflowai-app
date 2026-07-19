# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> Modificare **doar documentație** (`CLAUDE.md`) + version bump. NU se atinge cod runtime,
> teste, sau fișiere de semnare. Zero risc de regresie funcțională.

---

## Obiectiv

Actualizăm `CLAUDE.md` cu două lucruri descoperite la Etapa 1 (plasa de siguranță pe Postgres real):

1. **Secțiunea „Testing" e învechită** — afirmă că testele de integrare rulează „contra unei
   baze de date reale", dar în realitate mock-uiesc `pool.query` (`vi.mock('../../db/index.mjs')`).
   O corectăm și documentăm cele **două niveluri** de test + baseline-ul de **758** (confirmat prin
   `npm test`, nu prin grep — exact greșeala de numărătoare de evitat).

2. **Secțiunea „Database Migrations" e corectă dar incompletă** — prescrie garda
   `DO $g$ IF NOT EXISTS` pentru ALTER-e pe tabele V4, însă nu spune că garda **lasă un gol
   tăcut de schemă pe fresh DB** (ALTER-ul sare → coloana nu se adaugă niciodată, fiindcă inline
   rulează ÎNAINTE de V4). Adăugăm constatarea, lista golurilor cunoscute și de ce harness-ul DB
   e acum verificarea autoritară de fresh-provision.

NU se modifică nimic altceva în `CLAUDE.md`.

---

## Patch 1 — `CLAUDE.md`: corectează secțiunea „Testing" (cele două niveluri + baseline 758)

**old_str**
```
## Testing

Teste de integrare în `server/tests/integration/` folosesc Supertest contra unei baze de date reale (configurată în `server/tests/setup.mjs`). PBKDF2 (~200ms) implică timeout de 15s în `vitest.config.mjs`. Coverage exclude: Google Drive, GWS, WhatsApp, Web Push.

**Înainte de orice modificare:** rulează `npm test` și verifică că toate testele trec. Nu livra cod cu teste care pică.
```
**new_str**
```
## Testing — două niveluri

**Nivel 1 — Mock (rapid, default): `npm test`**
- ~758 teste (62 fișiere) în `server/tests/**` + `server/services/**/__tests__/**`.
- `pool.query` este **mock-uit** (`vi.mock('../../db/index.mjs')`) — rulează **fără** Postgres.
  ATENȚIE: testele NU lovesc o DB reală; afirmația veche „contra unei baze de date reale" era greșită.
- Pattern poziţional (`mockResolvedValueOnce` în secvență) → cuplat de implementare, fragil la refactor SQL.
- PBKDF2 (~200ms) → timeout 15s în `vitest.config.mjs`. Coverage exclude: Drive, GWS, WhatsApp, Web Push.

**Nivel 2 — Postgres real (plasă de siguranță): `npm run test:db`**
- `server/tests/db/**` (config separat `vitest.config.db.mjs`, `fileParallelism:false`).
- Rulează routerele REALE peste un Postgres efemer; `db/index.mjs` NU e mock-uit.
- Verifică **rezultatul** (status code + starea din DB), nu ordinea apelurilor → sigur la refactor.
- Local: `npm run db:test:up` (Docker) → exportă `TEST_DATABASE_URL` afișat → `npm run test:db` → `npm run db:test:down`.
- Fără `TEST_DATABASE_URL` se auto-skip (exit 0) — de aceea `npm test` rămâne verde și fără DB.
- CI rulează ambele (serviciu `postgres:16` în GitHub Actions).

**Baseline teste = 758.** Orice modificare care atinge testarea trebuie să confirme numărul exact
prin `npm test` (NU prin `grep it(` — numărătoarea statică ratează al doilea pattern din
`vitest.config.mjs` și testele generate în buclă). După Etapa 1, plus `npm run test:db` verde.

**Înainte de orice modificare:** rulează `npm test` (și `npm run test:db` dacă atingi formulare/ALOP/DB).
Nu livra cod cu teste care pică. Pentru rute de formulare/ALOP (liste, ștergere, cancel, revizii),
adaugă întâi un test de caracterizare în `server/tests/db/**` care captează comportamentul curent,
APOI refactorizează — testele DB sunt sursa de adevăr pentru regresii.
```

---

## Patch 2 — `CLAUDE.md`: completează secțiunea „Database Migrations" cu golul de fresh-provision

Inserează un bloc nou imediat DUPĂ tabelul „Anti-patterns de evitat" (după rândul cu „Migrare inline
care presupune V4 rulat deja"), înainte de `---`-ul care închide secțiunea.

**old_str**
```
| Migrare inline care presupune V4 rulat deja | Race condition garantată | V4 rulează DUPĂ inline, întotdeauna |

---
```
**new_str**
```
| Migrare inline care presupune V4 rulat deja | Race condition garantată | V4 rulează DUPĂ inline, întotdeauna |

### ⚠️ Garda rezolvă 503-ul, dar lasă un GOL TĂCUT de schemă pe fresh DB

Garda `DO $g$ IF NOT EXISTS (table) THEN RETURN` (Regula 1) previne ROLLBACK-ul/503, DAR are un cost
ascuns: pe o **bază fresh**, ALTER-ul gardat **sare** (tabela V4 nu există încă, fiindcă inline rulează
înaintea V4), migrarea se marchează „applied" și **nu se mai reia niciodată**. Coloana/constraint-ul
**nu se adaugă** — fără nicio eroare în log. În prod/staging „merge" doar pentru că bazele s-au construit
incremental (tabela exista deja când a rulat ALTER-ul gardat).

**Goluri de fresh-provision cunoscute (de remediat — task dedicat):**
- `alop_instances`: `updated_by` (+ index), coloanele de semnatari (mig. 055), CHECK `plata_source`,
  tabela-copil `alop_ord_cicluri` (FK spre `alop_instances`) — toate gardate, toate sar pe fresh boot.
- `organizations.slug`: V4 `001_organizations.sql` îl cere `NOT NULL`, dar inline creează `organizations`
  fără slug primul → `CREATE TABLE IF NOT EXISTS` din V4 sare → `slug`/`idx_org_slug` lipsesc pe fresh.

**Consecință runtime:** relink-ul ALOP la ștergere/refuz scrie `alop_instances.updated_by`; pe o schemă
fresh fără coloana asta, scrierea eșuează — și fiindcă relink-ul e în `try/catch` non-fatal, eșuează
**tăcut**. Pe prod merge (coloana există).

**Regula 4 e necesară dar NU suficientă:** „verifică în logs că nu e ROLLBACK" nu prinde golul, fiindcă
o gardă care sare nu produce eroare. Verificarea autoritară de fresh-provision e acum **`npm run test:db`**
(`server/tests/db/**`): construiește schema fresh și rulează rute reale care ar pica dacă o coloană lipsește.
Bootstrap-ul fresh canonic e în `server/tests/helpers/db-real.mjs` (`migrateForTests`): inline-first cu
migrările V4-dependente pre-marcate „applied", apoi `014_alop.sql` + `015_formulare_oficiale.sql`, apoi
re-aplică inline-ul deferred — reconstruind ordinea pe care prod o are din creștere incrementală.

**Regula 5 — coloane care TREBUIE să existe pe tabele V4 NU se pun ca ALTER inline gardat.**
Garda le face opționale de facto (lipsesc pe fresh). Pune-le în migrarea V4 care deține tabela de bază
(ex. o nouă `016_*.sql` lângă `014_alop.sql`), unde tabela există garantat la momentul ALTER-ului.

---
```

---

## Patch 3 — `package.json`: version bump (disciplină per-commit)

> Doc-only, fără implicații de cache (CLAUDE.md nu e asset livrat) — bump doar pentru consistența commit-urilor.

**old_str**
```
  "version": "3.9.520",
```
**new_str**
```
  "version": "3.9.521",
```

---

## Verificări

```bash
# Inserările sunt prezente și unice
grep -n "Testing — două niveluri" CLAUDE.md            # 1 hit
grep -n "GOL TĂCUT de schemă pe fresh DB" CLAUDE.md    # 1 hit
grep -n "Regula 5 — coloane care TREBUIE" CLAUDE.md    # 1 hit
grep -c "Baseline teste = 758" CLAUDE.md               # 1

# Doar CLAUDE.md + package.json în diff (zero cod/teste)
git diff --name-only
#   → trebuie: CLAUDE.md  package.json   (și nimic altceva)

# Sanity: nu s-a atins nimic runtime
git diff --name-only | grep -vE "^(CLAUDE\.md|package\.json)$" ; echo "↑ trebuie GOL"
```

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.520 → 3.9.521 (package.json)
- [ ] Patch 1: secțiunea „Testing" → două niveluri + baseline 758 (corectată afirmația „DB reală")
- [ ] Patch 2: secțiunea „Database Migrations" → gol tăcut fresh-provision + goluri cunoscute + Regula 5
- [ ] grep-uri de verificare: toate 1 hit
- [ ] `git diff --name-only` → DOAR `CLAUDE.md` + `package.json`
- [ ] (opțional, recomandat) `npm test` → 758 verde, ca dovadă că nimic runtime nu s-a atins
- [ ] commit + push **doar pe develop**

Commit sugerat:
```
docs(CLAUDE.md): testing pe două niveluri (758 baseline) + gol tăcut fresh-provision migrări

- Testing: corectat „DB reală" → mock (npm test, 758) + Postgres real (npm run test:db)
- Migrations: garda IF EXISTS previne 503 dar lasă coloane lipsă pe fresh DB
  (alop_instances.updated_by/semnatari/plata_source/alop_ord_cicluri, organizations.slug)
- Regula 5: coloane obligatorii pe tabele V4 → în migrare V4, nu ALTER inline gardat
- harness-ul npm run test:db = verificarea autoritară de fresh-provision
- v3.9.521
```
```
