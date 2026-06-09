# DocFlowAI — 🛡️ Etapa 0-ALOP: plasă de caracterizare a mașinii de stare ALOP

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.545 → v3.9.546
Branch: develop
Subiect: test(alop): caracterizare DB a mașinii de stare ALOP înainte de orice atingere
Tip: TEST-ONLY — ZERO cod de producție atins. Doar fișiere de test (+ eventual seed-uri noi).
     Fără bump CACHE_VERSION, fără ?v=.
```

---

## 🎯 Scop

ALOP (`server/routes/alop.mjs`, 1366 linii, 17 rute) e zona ta cu cel mai mare istoric de regresii:
`df_flow_id` drift, zombie flow, gating `assigned_to` — toate buguri de **stare**, nu de duplicare.
Mock-urile poziționale nu le prind. Înainte de a mai atinge ALOP (fix sau feature), îi punem o plasă
de caracterizare la nivel de **Postgres real** (`server/tests/db/**`), pe modelul Etapei 0 pentru
formulare.

Inima riscului: **`GET /api/alop/:id` face *lazy-resync*** — avansează `status`-ul ca efect secundar
la citire, pe baza `COALESCE(df.flow_id, a.df_flow_id)` și a completării fluxurilor legate. O citire
mutează starea. Acolo au trăit bug-urile de drift. Plasa trebuie să cimenteze acest comportament
exact cum e azi.

**Disciplină identică Etapa 0:** comportamentul CURENT este definiția corectă. Dacă un test pică
fiindcă ipoteza ta despre comportament era greșită → corectează **testul**, nu codul. Dacă pică
fiindcă ai găsit un bug real preexistent → NU-l repara aici; `it.todo(...)` cu descrierea + notează-l
în raport. Etapa asta **fotografiază**, nu repară.

---

## 🚫 Zone interzise

- ZERO cod de producție. NU atinge `server/routes/alop.mjs`, `services/*`, `db/index.mjs`.
- NU atinge fișierele NO-TOUCH de signing. NU atinge `migrate.mjs`. NU adăuga migrări. NU schimba schema.
- Singurele fișiere editabile: `server/tests/db/**` (+ extinderi opționale de seed în
  `server/tests/helpers/db-real.mjs`, doar adăugând parametri opționali / helpere noi, fără a schimba
  semnăturile existente).

---

## ⚠️ Despre rularea testelor (CITEȘTE — contează aici mai mult ca oriunde)

Deliverable-ul ESTE teste DB. Un test DB nerulat nu dovedește nimic — poate afirma greșit fără să știi.
- **Ideal:** rulează local cu Docker (`npm run db:test:up` → exportă `TEST_DATABASE_URL` →
  `npm run test:db`). Bucla rapidă e esențială când *descoperi* comportament.
- **Dacă Docker lipsește pe mașină** (a fost cazul la Etapa 2): iterația se face prin push pe
  `develop` → CI rulează `test:db` cu `postgres:16` real, non-skipped. Mai lent, dar tot validează.
- **Interzis:** să raportezi „gata" cu teste care n-au rulat NICĂIERI (nici local, nici CI). Skipped
  ≠ passed. Confirmarea finală e CI verde non-skipped pe commit-ul tău.

---

## 📋 Pas 0 — context + ce e DEJA acoperit (nu dubla)

```bash
git checkout develop && git pull origin develop
git status   # clean

# Acoperire ALOP DB existentă — NU rescrie astea:
ls server/tests/db/ | grep -iE "alop|zombie"
# alop-cancel.test.mjs (cancel), alop-capabilities.test.mjs (capabilities),
# df-zombie-flow.test.mjs + ord-zombie-flow.test.mjs (garda link-flow pe flux activ).

# Seed-uri disponibile (le reutilizezi):
grep -oE "export async function (seed|get)[A-Za-z]+" server/tests/helpers/db-real.mjs
# seedOrgUser, seedUser, seedFlowApproved, seedDf({flowId,...}), seedOrd({flowId,dfId,...}),
# seedAlop({status, dfId, dfFlowId, ordId, ordFlowId,...}), getAlop, getDf, getOrd.
```

Stările ALOP: `draft → angajare → lichidare → ordonantare → plata → completed` (+ `cancelled`).

**NU acoperi din nou:** cancel, capabilities, garda zombie-flow. Te concentrezi pe **progresia
mașinii de stare**, **lazy-resync-ul din GET /:id**, **ciclul multi-ORD**, și **gărzile de
tranziție**.

---

## 📋 Pas 1 — seed-uri necesare (adaugă în `db-real.mjs` DOAR ce lipsește)

Pentru testele de mai jos s-ar putea să-ți trebuiască:
- un getter `getAlopCicluri(alopId)` care citește `alop_ord_cicluri` (pentru noua-lichidare);
- posibilitatea de a seta câmpuri precum `lichidare_confirmed_by`, `plata_suma_efectiva`,
  `ciclu_curent`, `df_completed_at` pe ALOP-ul seed-uit (adaugă parametri opționali la `seedAlop`,
  fără a-i schimba semnătura existentă).

Adaugă-le urmând stilul existent (idempotent, parametrizat prin obiect). NU schimba semnăturile
helperelor folosite de testele DB curente.

---

## 📋 Pas 2 — fișiere de caracterizare (NOI)

Model 1:1: `server/tests/db/alop-cancel.test.mjs` (import din `db-real.mjs`,
`describe.skipIf(!hasTestDb())`, `beforeAll(migrate)`, `beforeEach(truncateAll + seed)`,
`afterAll` cu grijă la pool partajat — NU închide pool-ul în describe-uri intermediare, lecția din
Etapa 0). Fiecare test afirmă **status code + stare DB** (`getAlop`/`getDf`/`getOrd`), nu ordinea
apelurilor.

### `server/tests/db/alop-progresie-stari.test.mjs` — happy path complet
Parcurge mașina de stare prin rutele de tranziție, afirmând `status` în DB după fiecare pas:
- `POST /api/alop` → `draft`.
- `POST /:id/df-completed` (sau seed DF completed + flux) → `draft|angajare → lichidare`.
- `POST /:id/confirma-lichidare` din `lichidare` → **200**, status devine `ordonantare`, câmpurile
  `lichidare_confirmed_by/at` setate. (Idempotență: din `ordonantare` tot **200** — clauza
  `WHERE status IN ('lichidare','ordonantare')`.)
- `POST /:id/ord-completed` (sau echivalentul) → `ordonantare → plata`.
- `POST /:id/confirma-plata` din `plata` → **200** `{ ok, alop }`, status `completed`,
  `plata_suma_efectiva` setat (via `applyPlataConfirmedSideEffects`).

### `server/tests/db/alop-lazy-resync-get.test.mjs` — INIMA RISCULUI, prioritate maximă
`GET /api/alop/:id` mutează starea. Pentru fiecare scenariu: seed ALOP în stare X cu flux legat
*completed* → GET → afirmă că `getAlop().status` a avansat la Y în DB (nu doar în răspuns):
- ALOP `draft`/`angajare` cu DF aprobat → după GET, status `lichidare`.
- ALOP `ordonantare` cu ORD completat → după GET, status `plata`.
- **AMBELE brațe ale `COALESCE(df.flow_id, a.df_flow_id)`** (autoritatea sursei):
  - braț 1: `seedDf({ flowId: fluxAprobat })` + `seedAlop({ dfId, dfFlowId: null })` → resync din
    `df.flow_id`.
  - braț 2: `seedAlop({ dfFlowId: fluxAprobat, dfId: null })` → resync din `a.df_flow_id`.
  - dacă ambele sunt setate dar diferă → cimentează care câștigă (df.flow_id e prioritar). Comentariu:
    `// COALESCE prioritizează df.flow_id — sursa autoritară. NU inversa.`
- ALOP fără flux legat → GET NU schimbă status (idempotent pe citire).
- ALOP `cancelled` → GET NU resincronizează (verifică comportamentul curent — captează ce face codul).

### `server/tests/db/alop-noua-lichidare-ciclu.test.mjs` — ciclul multi-ORD
`POST /:id/noua-lichidare`:
- din status ≠ `completed` → **400** `status_invalid`.
- din `completed` cu rest disponibil (`df_val - total_platit > 0`) → arhivează ciclul curent în
  `alop_ord_cicluri` (verifică cu `getAlopCicluri`), `ciclu_curent` incrementat, status resetat la
  `lichidare`, câmpurile ORD ale ciclului curent eliberate (verifică ce anume — citește handler-ul
  1180-1256).
- depășire (`ramas <= 0`) → **400** `limita_depasita`.
- ALOP cancelled (`cancelled_at IS NOT NULL`) → **404** `not_found`.

### `server/tests/db/alop-tranzitii-garzi.test.mjs` — gărzi & respingeri
Pentru rutele de tranziție (`confirma-lichidare`, `confirma-plata`, `df-completed`, `ord-completed`,
`noua-lichidare`):
- `:id` = `'null'` / `'undefined'` → **400** `id_invalid` (gardă explicită la începutul handler-elor).
- `:id` inexistent (UUID valid) → **404** `not_found`.
- actor fără drept (alt user, fără rol/assigned/comp) → **403** `forbidden` (via `canEditAlop`).
- tranziție din stare greșită → **400** `status_invalid` (ex. `confirma-plata` din `draft`).
- izolare org: ALOP din altă organizație → **404**.

> Pentru fiecare assert pe care nu-l știi exact: **citește handler-ul** în `server/routes/alop.mjs`
> și transcrie comportamentul real (status code, cheia de `error`, câmpurile actualizate). Fotografie
> fidelă a prezentului.

---

## 📋 Pas 3 — verificare verde

```bash
# Local cu Docker (ideal):
npm run db:test:up   # exportă TEST_DATABASE_URL
npm run test:db      # noile fișiere RULATE + PASSED (nu sărite)

npm test             # mock neafectat (n-ai atins cod prod): verde, fără regresii
```

Dacă Docker lipsește local: push pe develop și confirmă în CI (`test:db` cu postgres:16, non-skipped).

Dacă un test pică:
- ipoteză greșită despre comportament → corectează testul.
- bug real preexistent descoperit → `it.todo(...)` + notează în raport. NU repara aici.

---

## 📋 Pas 4 — bump + commit + push

```bash
# package.json: 3.9.545 → 3.9.546. FĂRĂ CACHE_VERSION, FĂRĂ ?v=.

git add server/tests/db/ server/tests/helpers/db-real.mjs package.json
git commit -m "test(alop): caracterizare DB mașină de stare (progresie, lazy-resync GET, ciclu multi-ORD, gărzi) — plasă pre-refactor"
git push origin develop
```

CI rulează mock + DB real (postgres:16). **Confirmă acolo că noile fișiere ALOP sunt passed,
nu skipped**, pe commit-ul tău.

---

## ✅ Definiție de „gata"

1. 4 fișiere noi în `server/tests/db/`: progresie-stari, lazy-resync-get, noua-lichidare-ciclu,
   tranzitii-garzi.
2. Lazy-resync-ul din GET caracterizat, **ambele brațe COALESCE** cu comentariu „NU inversa".
3. Ciclul multi-ORD (`alop_ord_cicluri`, `ciclu_curent`, `limita_depasita`) acoperit.
4. Gărzile (`id_invalid`/404/403/`status_invalid`/izolare org) acoperite pe rutele de tranziție.
5. NU s-a dublat cancel / capabilities / zombie-flow.
6. `npm run test:db` verde **RULAT** (local sau CI), fără skip; `npm test` verde fără regresii.
7. Push pe develop; CI verde, noile teste passed non-skipped (confirmat).
8. Raport scurt: fișiere adăugate, finding-uri (bug-uri preexistente notate `it.todo`), confirmare
   ZERO cod de producție atins, confirmare NO-TOUCH neatins.

**Nu raporta „gata" până testele ALOP nu trec RULATE (nu sărite) — confirmat în CI dacă n-ai Docker local.**
