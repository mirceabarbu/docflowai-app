# DocFlowAI — 🛡️ Refactor Etapa 0: plasă de siguranță DF/ORD (teste de caracterizare DB)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.542 → v3.9.543
Branch: develop
Subiect: test(formulare): caracterizare DB pentru perechile DF/ORD înainte de consolidare
Tip: TEST-ONLY — zero cod de producție atins. Fără bump SW, fără atins ?v=.
```

---

## 🎯 Scop

Aceasta este **Etapa 0** dintr-o consolidare în mai mulți pași a `server/routes/formulare-db.mjs`
(2159 linii, 34 rute). Handler-ele DF și ORD sunt perechi aproape identice (`submit`/`complete`/
`returneaza`/`link-flow`/`sterge`) — vector principal de regresie: fix pe DF uitat pe ORD, sau
ștergerea accidentală a unei asimetrii intenționate.

**Înainte** de a atinge orice cod de producție în etapele următoare, blocăm comportamentul curent
într-o plasă de teste **la nivel de Postgres real** (`server/tests/db/**`) — singura sursă de adevăr
pentru regresii (mock-urile sunt poziționale, fragile la refactor SQL — vezi CLAUDE.md).

**În această etapă NU se modifică NICIUN fișier din `server/routes/`, `server/services/`,
`server/db/`.** Doar se adaugă fișiere noi de test. Dacă un test nou pică, comportamentul curent
**este** definiția corectă — ajustează testul ca să-l reflecte, NU codul.

---

## 🚫 Zone interzise (rămân valabile)

- NU atinge fișierele de signing NO-TOUCH (`STSCloudProvider.mjs`, `cloud-signing.mjs`,
  `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`).
- NU atinge `server/db/migrate.mjs`.
- NU adăuga migrări. NU modifica schema.
- NU modifica cod de producție de niciun fel. Doar `server/tests/db/**` (+ eventual extinderi de
  seed în `server/tests/helpers/db-real.mjs`, vezi pasul 1).

---

## 📋 Pas 0 — verificare context

```bash
git checkout develop && git pull origin develop
git status   # working tree clean

# Confirmă golurile de acoperire DB pe care le umplem:
for r in submit complete returneaza revizuieste; do \
  echo -n "$r : "; grep -rl "/$r" server/tests/db/ 2>/dev/null | wc -l; done
# Așteptat aprox: complete=0, revizuieste=0 (goluri), submit/returneaza=parțial.

# Confirmă seed-urile existente:
grep -oE "export (async )?function [a-zA-Z0-9_]+" server/tests/helpers/db-real.mjs
```

Rulează plasa DB curentă ca baseline (necesită Docker pentru Postgres efemer):

```bash
npm run db:test:up
# exportă TEST_DATABASE_URL afișat în terminal, apoi:
npm run test:db
npm run db:test:down
```

⚠️ **Skipped ≠ passed.** Dacă rulezi fără Docker, testele DB se *sar* (exit 0) și NU dovedesc nimic.
Confirmă acoperirea reală fie local cu Docker, fie prin CI (push pe `develop`). Nu raporta „verde"
pe baza unor teste sărite.

---

## 📋 Pas 1 — extinde `db-real.mjs` DOAR dacă lipsesc seed-uri/getter-e necesare

Seed-urile existente: `seedOrgUser`, `seedFlowApproved`, `seedDf`, `seedOrd`, `seedAlop`,
`getAlop`, `getDf`, `getOrd`. Pentru testele de mai jos ai nevoie să poți:

- seta un al doilea utilizator (P2) în aceeași organizație și să-l atribui pe `assigned_to`
  (parametru pe `seedDf`/`seedOrd`, dacă nu există deja);
- citi `status`, `assigned_to`, `capabilities` din răspunsul rutei.

Dacă un helper lipsește, **adaugă-l în `db-real.mjs` urmând exact stilul existent** (idempotent,
parametrizat prin obiect `{ orgId, createdBy, status, assignedTo, ... }`). NU schimba semnătura
helperelor existente într-un mod care sparge testele DB curente — adaugă parametri opționali.

---

## 📋 Pas 2 — fișiere de test de caracterizare (NOI)

Model de urmat 1:1: `server/tests/db/sterge-df-ord.test.mjs` (același import din `db-real.mjs`,
`describe.skipIf(!hasTestDb())`, `beforeAll(migrate)`, `beforeEach(truncateAll + seed)`,
`afterAll(pool.end)`). Fiecare test afirmă **status code + stare DB** (NU ordinea apelurilor).

Creează:

### `server/tests/db/caracterizare-submit-df-ord.test.mjs`
Pentru AMBELE tipuri, captează comportamentul curent al `POST /api/formulare-{df|ord}/:id/submit`:
- din `draft` cu `assigned_to` (P2) valid → **200**, `status` devine cel curent din cod, `assigned_to`
  persistă, răspunsul conține `capabilities` cu `capsFt` corect (`notafd` pt DF, `ordnt` pt ORD).
- **ASIMETRIA CRITICĂ:** din status `de_revizuit` → DF acceptă (`['draft','returnat','de_revizuit']`),
  ORD respinge (`['draft','returnat']`). Scrie câte un test explicit per tip care cimentează această
  diferență. Comentariu în test: `// ASIMETRIE INTENȚIONATĂ — NU uniformiza la consolidare`.
- din status invalid (ex. `aprobat`) → codul de eroare curent (verifică ce întoarce: 4xx + `body.error`).
- P2 din altă organizație → comportamentul curent de izolare org.

### `server/tests/db/caracterizare-complete-df-ord.test.mjs`  ← GOL ACUM, prioritate maximă
`POST /api/formulare-{df|ord}/:id/complete` — aici stă logica de buget + recalcul capabilities:
- complete valid de către P2 → **200**, tranziție de status curentă, `capabilities` reîmprospătate.
- (DF) cazul depășire credit buget Secțiunea B → **soft-warning** curent (verifică forma exactă a
  răspunsului: 200 cu flag/warning în body, NU 4xx — captează ce face codul azi).
- complete de către cine NU e P2 atribuit → eroarea de autorizare curentă.
- complete pe status care nu permite → eroarea curentă.

### `server/tests/db/caracterizare-returneaza-df-ord.test.mjs`
`POST /api/formulare-{df|ord}/:id/returneaza` — afirmă status rezultat, cine poate, notificarea
declanșată (verifică efectul observabil în DB/răspuns, nu mock-ul de mailer).

### `server/tests/db/caracterizare-revizuieste-df.test.mjs`  ← GOL ACUM (DF-only)
`POST /api/formulare-df/:id/revizuieste` (și alias `/revizie`):
- pe DF `aprobat` cu flux → creează revizie R1, `revizie_nr` incrementat, parent neatins.
- captează regula „an următor" dacă există (mig. 057) și restricțiile de status.
- ORD **nu are** această rută — adaugă un test care confirmă **404/405** pe `POST
  /api/formulare-ord/:id/revizuieste` (cimentează că reviziile sunt DF-only).

> Pentru fiecare assert pe care nu-l știi din cap: **citește handler-ul curent** în
> `server/routes/formulare-db.mjs` și transcrie comportamentul real. Scopul e o fotografie fidelă a
> prezentului, nu comportamentul „ideal".

---

## 📋 Pas 3 — verificare verde

```bash
# DB-tests (cu Docker pornit + TEST_DATABASE_URL exportat):
npm run test:db
# Așteptat: noile fișiere RULATE (nu sărite) și PASSED. Skipped = nedovedit.

# Suita mock nu trebuie afectată (n-ai atins cod prod):
npm test
# Așteptat: npm test verde, fără regresii.
```

Dacă un test nou pică pentru că ipoteza ta despre comportament era greșită → **corectează testul**
ca să reflecte ce face codul azi (nu codul). Dacă pică pentru că ai descoperit un bug real preexistent
→ NU-l „repara" aici; notează-l în raport ca finding, marchează testul `it.todo(...)` cu descrierea
bug-ului, și continuă. Etapa 0 fotografiază, nu repară.

---

## 📋 Pas 4 — bump versiune (patch, backend/test-only)

```bash
# package.json: 3.9.542 → 3.9.543. FĂRĂ bump CACHE_VERSION în sw.js (n-ai atins frontend).
# FĂRĂ sed pe ?v= (niciun asset public schimbat).
```

---

## 📋 Pas 5 — commit + push (per regula proiectului)

```bash
git add server/tests/db/ server/tests/helpers/db-real.mjs package.json
git commit -m "test(formulare): caracterizare DB DF/ORD (submit/complete/returneaza/revizuieste) — Etapa 0 refactor"
git push origin develop
```

CI (`push: develop`) rulează ambele niveluri cu `postgres:16` — confirmă acolo că DB-tests sunt
**passed**, nu sărite.

---

## ✅ Definiție de „gata"

1. 4 fișiere noi în `server/tests/db/`, fiecare cu DF **și** ORD (unde se aplică).
2. Asimetria `de_revizuit` (DF da / ORD nu) cimentată cu test explicit + comentariu „NU uniformiza".
3. Golurile `complete` și `revizuieste` acoperite.
4. `npm run test:db` verde **cu testele RULATE** (confirmat prin Docker local sau CI), fără skip.
5. `npm test` verde, fără regresii.
6. Push pe `develop` făcut; CI verde.
7. Raport scurt către Mircea: fișiere adăugate, eventuale finding-uri (bug-uri preexistente notate
   `it.todo`), confirmare că zero cod de producție a fost atins.

**Nu raporta „gata" până nu ai confirmat DB-tests RULATE (nu sărite) verzi.**
