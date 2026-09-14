---
prompt: 195
titlu: "test:db mai rapid — poarta „bază caldă" în migrateForTests + rețeta Postgres reglată"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.848
versiune_tinta: v3.9.849
migratii: NU (se atinge migrateForTests, NU se adaugă migrații)
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO în producție
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul — unde se duc cele ~13 minute

`migrateForTests()` folosește un flag de modul (`_migrated` în `db-real.mjs`). Vitest
**izolează fiecare fișier de test**, deci flagul se resetează la fiecare dintre cele ~134 de
fișiere, iar funcția rulează din nou de fiecare dată.

Pasul 1 e ieftin (`runMigrations` sare peste ce e deja aplicat). Pasul 3 nu:

```js
await client.query(`DELETE FROM schema_migrations WHERE id = ANY($1::text[])`, [deferredIds]);
await runMigrations(client);
```

Șterge marcajele celor **17 migrații deferred** și le **re-execută**. Printre ele
`093_alop_state_gate`, `094_alop_state_guard`, `109_alop_state_gate_enforce`,
`110_alop_matrix_undo_df` — `CREATE OR REPLACE FUNCTION` plus triggere, adică DDL care ia
`ACCESS EXCLUSIVE`.

**17 × 134 ≈ 2.300 de execuții DDL pe rulare**, toate inutile pe o bază deja migrată.
Dansul deferred există ca să rezolve ordinea de bootstrap pe o bază **proaspătă**.

⚠️ **De ce e sigur să-l sărim pe o bază caldă** (verificat, nu presupus): niciun test nu se
bazează pe re-rularea deferred ca să-și refacă schema. Singurul obiect coborât de teste e
indexul `df_source_alop_revizie_uniq` — migrația **095**, care **nu** e deferred — iar
ambele fișiere care-l coboară (`df-dedup-idempotent`, `df-alop-link-resilienta`) îl refac
ele însele, în `finally`/`afterAll`.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                       # Așteptat: 3.9.848
grep -n "export async function migrateForTests" server/db/index.mjs
grep -n "DELETE FROM schema_migrations WHERE id = ANY" server/db/index.mjs
grep -n "pg_ctl.*listen_addresses" CLAUDE.md
grep -rn "DROP INDEX\|DROP TRIGGER\|DISABLE TRIGGER" server/tests/db/*.mjs
```

⭐ Ultima comandă trebuie să confirme premisa de siguranță: singurele coborâri de schemă din
teste sunt pe `df_source_alop_revizie_uniq`. **Dacă apare orice altceva — un `DROP TRIGGER`,
un `DROP FUNCTION`, un `ALTER TABLE` — OPREȘTE-TE și raportează.** Premisa cade, iar poarta
ar ascunde o reparație tăcută de care depinde vreun test.

---

## ETAPA A — măsurătoarea DINAINTE (obligatorie, altfel nu știm ce am câștigat)

Ridică baza efemeră după rețeta **actuală** din `CLAUDE.md` (nereglată) și rulează suita
completă **o dată**, ca baza să fie caldă. Apoi, **pe aceeași bază**, cronometrează:

```bash
time npx vitest run --config vitest.config.db.mjs server/tests/db/admin-cancel-flow.test.mjs
time npx vitest run --config vitest.config.db.mjs        # suita completă
```

Notează ambele durate. Sunt linia de bază; fără ele, restul raportului e o impresie.

---

## ETAPA B — poarta „bază caldă" în `server/db/index.mjs`

`old_str` (unic):
```js
export async function migrateForTests() {
  if (!pool) throw new Error('migrateForTests: DATABASE_URL/TEST_DATABASE_URL lipsește');
```

`new_str` — inserează **exact** acest text (codul e scris, nu descris; nu-l reformula):
```js
export async function migrateForTests() {
  if (!pool) throw new Error('migrateForTests: DATABASE_URL/TEST_DATABASE_URL lipsește');

  // ── Poartă „bază caldă" (#195) ──────────────────────────────────────────────
  // Vitest izolează fiecare fișier de test, deci flagul _migrated din db-real.mjs se
  // resetează la fiecare dintre cele ~134 de fișiere și funcția asta rulează din nou.
  // Pasul 3 de mai jos ȘTERGE marcajele celor 17 migrații deferred și le RE-EXECUTĂ:
  // CREATE OR REPLACE FUNCTION + triggere (093/094/109/110), adică DDL cu
  // ACCESS EXCLUSIVE, de ~2300 de ori pe rulare — muncă în gol pe o bază deja migrată.
  //
  // Condiția se verifică în BAZĂ, nu în memorie: dacă TOATE migrațiile inline sunt
  // marcate aplicate ȘI tabelele V4 există, nu mai e nimic de făcut. Pe o bază rece sau
  // cu schema incompletă condiția e falsă și parcursul complet de mai jos rulează
  // neschimbat — inclusiv la adăugarea unei migrații noi (numărătoarea nu se mai potrivește).
  //
  // Sigur pentru că niciun test nu se bazează pe re-rularea deferred ca să-și refacă
  // schema: singurul obiect coborât de teste e indexul df_source_alop_revizie_uniq
  // (migrația 095, NEdeferred), iar ambele fișiere care-l coboară îl refac ele însele.
  try {
    const client = await pool.connect();
    try {
      const { rows: t } = await client.query(
        `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS sm,
                to_regclass('public.alop_instances')     IS NOT NULL AS alop,
                to_regclass('public.formulare_oficiale') IS NOT NULL AS fo`
      );
      if (t[0].sm && t[0].alop && t[0].fo) {
        const { rows: m } = await client.query(
          `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE id = ANY($1::text[])`,
          [MIGRATIONS.map((x) => x.id)]
        );
        if (m[0].n === MIGRATIONS.length) { markDbReady(); return; }
      }
    } finally { client.release(); }
  } catch { /* bază rece / schemă incompletă → parcursul complet de mai jos */ }
```

⛔ Nu modifica pașii 1, 2 și 3. Nu atinge `runMigrations`, `MIGRATIONS`, `V4_ONLY`.
⛔ Nu atinge `db-real.mjs`, `vitest.config.db.mjs`, `setup.mjs`.
⛔ Nu porni pe drumul `isolate: false` — fișierele folosesc `vi.mock` diferite și mock-urile
   s-ar scurge între ele.

---

## ETAPA C — `CLAUDE.md`: rețeta reglată + regula de rulare selectivă

### C.1 — Postgres de unică folosință, reglat pentru viteză

`old_str`:
```
      "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p 55432 -c listen_addresses=127.0.0.1" \
```
`new_str`:
```
      # Bază de UNICĂ FOLOSINȚĂ: durabilitatea nu valorează nimic aici, viteza da.
      # fsync/synchronous_commit/full_page_writes off ⇒ scrierile nu mai ating discul.
      # ⛔ Aceste opțiuni sunt EXCLUSIV pentru instanța efemeră de test. Niciodată în producție.
      "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p 55432 -c listen_addresses=127.0.0.1 \
        -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
        -c autovacuum=off -c checkpoint_timeout=60min -c max_wal_size=4GB" \
```

⚠️ Continuarea de linie (`\`) și ghilimelele trebuie să rămână valide în Git Bash. După
editare, **pornește efectiv instanța** și confirmă că urcă — o rețetă ruptă în `CLAUDE.md`
costă fiecare sesiune viitoare.

### C.2 — regula care lipsește

Adaugă un punct nou în aceeași secțiune, imediat după rețetă:

```
- ⭐ **În timpul unui lot, NU rula suita întreagă la fiecare iterație.** Rulează doar
  fișierele atinse:

      npx vitest run --config vitest.config.db.mjs server/tests/db/<fisier>.test.mjs

  Suita completă o singură dată, la final, înainte de commit. Suita întreagă durează
  ~13 minute; un fișier durează secunde.
```

---

## ETAPA D — acceptanța. Două criterii, al doilea e cel important

### D.1 — câștigul (bază caldă)

Cu rețeta reglată, repetă exact măsurătorile din Etapa A, pe o bază caldă. Raportează
tabelar: înainte / după / raport, pentru fișierul singur și pentru suita completă.

### D.2 — ⭐⭐ nicio regresie pe bază RECE

Ăsta e criteriul care contează. Oprește instanța, **șterge `PGDATA`**, ridică una nouă de la
zero și rulează suita completă:

```
Bază complet nouă, prima rulare: 134 fișiere / toate verzi
```

Dacă poarta e greșită, aici se vede: schema nu se construiește și pică zeci de fișiere.
⛔ Dacă pică, **nu ajusta poarta până trece** — raportează ce a picat.

### D.3 — stabilitate

Pe baza rămasă caldă de la D.2, mai rulează o dată suita completă. Trebuie să fie verde
(criteriul de acceptanță moștenit de la #194).

```bash
npm test
```

⚠️ `npm test` și `test:db` **secvențial, niciodată în paralel.**

---

## ETAPA E — versiune, commit

```bash
npm version 3.9.849 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
```

⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=` — lotul nu atinge `public/`.

```bash
git status --short
```
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**

```
perf(#195): test:db nu mai re-executa migratiile la fiecare fisier — v3.9.849

Vitest izoleaza fiecare fisier de test, deci flagul _migrated din db-real.mjs se
reseteaza de ~134 de ori si migrateForTests ruleaza din nou. Pasul 3 sterge
marcajele celor 17 migratii deferred si le RE-EXECUTA: CREATE OR REPLACE FUNCTION
plus triggere ALOP, DDL cu ACCESS EXCLUSIVE, de ~2300 de ori pe rulare. Dansul
deferred exista pentru ordinea de bootstrap pe o baza PROASPATA; pe una calda e
munca in gol.

O poarta verificata IN BAZA (toate migratiile inline marcate aplicate + tabelele
V4 prezente) iese imediat. Pe baza rece conditia e falsa si parcursul complet
ruleaza neschimbat, inclusiv la adaugarea unei migratii noi.

Sigur pentru ca niciun test nu depinde de re-rularea deferred ca sa-si refaca
schema: singurul obiect coborat de teste e indexul df_source_alop_revizie_uniq
(migratia 095, NEdeferred), iar ambele fisiere care-l coboara il refac ele insele.

CLAUDE.md: instanta efemera porneste cu fsync/synchronous_commit/full_page_writes
off — baza e de unica folosinta, durabilitatea ei nu valoreaza nimic. Plus regula
de a rula doar fisierele atinse in timpul unui lot.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0. ⭐ În special: singurele coborâri de schemă din teste sunt pe
   `df_source_alop_revizie_uniq`?
2. ⭐ Tabel înainte/după/raport, pentru un fișier singur și pentru suita completă.
3. ⭐⭐ Rezultatul rulării pe bază **complet nouă** (D.2), cu numere.
4. Rezultatul rulării a doua pe baza caldă (D.3).
5. Confirmarea că rețeta editată din `CLAUDE.md` **pornește efectiv** instanța.
6. `npm test` — numere reale.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale. În special: mai există în harness-ul de test vreo muncă repetată
    la fiecare fișier care ar putea fi făcută o singură dată?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații noi. Zero scrieri în producție.
- ⛔ Opțiunile `fsync=off` & co. sunt **exclusiv** pentru instanța efemeră de test.
  Nu ajung nicăieri lângă configurația de producție.
- ⛔ `db-real.mjs`, `vitest.config.db.mjs`, `setup.mjs` — **neatinse**.
- ⛔ Fără `isolate: false`.
- ⛔ Pașii 1–3 din `migrateForTests` — **neatinși**. Se adaugă doar poarta.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
