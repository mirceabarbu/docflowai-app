---
prompt: 202
titlu: "Bugetul Clasa 8 capătă dimensiunea AN — importul pe 2027 nu mai șterge 2026"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.854
versiune_tinta: v3.9.855
migratii: DA — inline, `111_clasa8_buget_an` (ADD COLUMN + backfill + swap de UNIQUE)
scrieri_in_baza: DA (backfill pe date existente) ⇒ `pg_dump` OBLIGATORIU înainte de deploy
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
tip: schemă + rute + servicii
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

Nu faci deploy. Nu rulezi nimic pe producție. Migrarea se aplică la boot, pe staging,
după push.

---

# CONTEXTUL — ce e stricat și de ce contează acum

Centralizatorul Clasa 8 compară bugetul importat cu angajamentele / ordonanțările / plățile.
Bugetul importat stă în `clasa8_buget`, cu constrângerea `UNIQUE (org_id, cod_ssi)`.

Din cauza acelei constrângeri, `POST /api/clasa8/buget/import`
(`server/routes/clasa8.mjs`, în interiorul tranzacției) face:

```sql
DELETE FROM clasa8_buget WHERE org_id = $1
```

adică **șterge tot bugetul organizației** și reinserează versiunea nouă.

Consecința, măsurată pe producție (13.09.2026): o singură organizație are buget încărcat,
versiunea activă e `version_no = 6` cu **293 de rânduri**; versiunile 2–5 au **0 rânduri
active**, fiindcă au fost șterse la fiecare import nou. În `clasa8_buget_versions` a rămas
doar metadata (`row_count`, `total_value`), **nu și valorile per cod SSI**.

Deci: în momentul în care cineva încarcă bugetul pe 2027, **bugetul pe 2026 dispare din bază**,
irecuperabil în afara unui `pg_dump`. Asta se întâmplă în decembrie–ianuarie, nu peste un an.

A doua ușă cu același efect: `DELETE /api/clasa8/buget` — comentariul zice „versiunile rămân
în istoric", ceea ce e adevărat doar despre metadate.

**Lotul ăsta adaugă dimensiunea `an` și scopează toate ștergerile și citirile pe ea.**

---

# ⭐ PROPRIETATEA DE SIGURANȚĂ A LOTULUI

După lot, **nicio cifră vizibilă în aplicație nu se schimbă.**

Motivul: după backfill există un singur an în bază (2026), iar toți consumatorii citesc
implicit anul curent. Dacă vreun total din Clasa 8 se modifică, lotul e greșit — nu „diferit",
**greșit**. Etapa E conține testul care ancorează asta.

Selectorul de an în interfață, parametrul `?an=` pe rute și parametrizarea celor cinci
expresii de an din ceasul de perete sunt **#203**, lot separat. Nu le face aici.

---

# ETAPA 0 — ancore, ÎNAINTE de orice modificare

Rulează și **raportează valorile obținute**. Dacă vreuna diferă de ce scrie mai jos, **oprește-te
și raportează** — nu adapta codul la o realitate diferită fără să mă întrebi.

```bash
grep -n "UNIQUE (org_id, cod_ssi)" server/db/index.mjs
# Așteptat: 1 linie, în migrarea 069_clasa8_buget

grep -n "DELETE FROM clasa8_buget" server/routes/clasa8.mjs
# Așteptat: 2 linii (importul și DELETE /buget)

grep -cn "FROM clasa8_buget" server/services/clasa8.mjs
# Așteptat: 2

grep -oE "id: '[0-9]{3}_[a-z0-9_]+'" server/db/index.mjs | tail -1
# Așteptat: id: '110_alop_matrix_undo_df'

grep -rn "clasa8_buget" server --include=*.mjs | grep -v "^server/tests/" | grep -v "db/index.mjs"
# Așteptat: exact 6 fișiere-linii de cod viu —
#   services/clasa8.mjs ×2 · services/cod-ssi-validate.mjs ×1 (+comentarii)
#   routes/clasa8.mjs ×4 (meta EXISTS, coduri, DELETE import, INSERT, DELETE /buget)
```

⛔ Dacă apare un consumator de `clasa8_buget` pe care nu-l enumeră lista de mai sus,
**raportează-l înainte de a scrie o linie**. Un consumator nescopat devine, în momentul în care
există doi ani în bază, o dublare tăcută a bugetului.

---

# ETAPA A — migrarea inline `111_clasa8_buget_an`

În `server/db/index.mjs`, **imediat după** obiectul `110_alop_matrix_undo_df` și **înainte** de
`];` care închide array-ul de migrări.

`clasa8_buget` și `clasa8_buget_versions` sunt create de migrarea inline `069`, deci sunt
**inline-owned**: NU sunt tabele V4, NU au nevoie de garda `IF NOT EXISTS(information_schema…)`
și NU trebuie adăugate în niciun fișier din `migrations/`. Verifică asta singur înainte de a
scrie (caută `clasa8_buget` în `migrations/*.sql` — așteptat: 0 rezultate) și confirmă în raport.

```js
  {
    id: '111_clasa8_buget_an',
    sql: `
      -- #202: bugetul importat capătă AN DE EXERCIȚIU.
      -- Până aici, UNIQUE (org_id, cod_ssi) forța importul să facă
      -- DELETE FROM clasa8_buget WHERE org_id — adică încărcarea bugetului pe anul
      -- următor ȘTERGEA bugetul anului curent, irecuperabil.
      ALTER TABLE clasa8_buget          ADD COLUMN IF NOT EXISTS an INTEGER;
      ALTER TABLE clasa8_buget_versions ADD COLUMN IF NOT EXISTS an INTEGER;

      -- Backfill: anul vine din momentul încărcării versiunii. Măsurat pe producție
      -- (13.09.2026): toate cele 6 versiuni ale singurei organizații cu buget sunt
      -- din 2026, deci backfill-ul e omogen. Derivat, NU hardcodat.
      UPDATE clasa8_buget_versions
         SET an = EXTRACT(YEAR FROM uploaded_at)::int
       WHERE an IS NULL;

      UPDATE clasa8_buget b
         SET an = v.an
        FROM clasa8_buget_versions v
       WHERE b.version_id = v.id
         AND b.an IS NULL;

      -- Plasă: rânduri fără versiune corespondentă (FK ar trebui să le excludă).
      UPDATE clasa8_buget
         SET an = EXTRACT(YEAR FROM NOW())::int
       WHERE an IS NULL;

      ALTER TABLE clasa8_buget          ALTER COLUMN an SET NOT NULL;
      ALTER TABLE clasa8_buget_versions ALTER COLUMN an SET NOT NULL;

      -- Cheia care forța ștergerea. Numele e cel generat de Postgres pentru
      -- UNIQUE (org_id, cod_ssi) din migrarea 069.
      ALTER TABLE clasa8_buget DROP CONSTRAINT IF EXISTS clasa8_buget_org_id_cod_ssi_key;
      ALTER TABLE clasa8_buget
        ADD CONSTRAINT clasa8_buget_org_an_cod_uniq UNIQUE (org_id, an, cod_ssi);

      CREATE INDEX IF NOT EXISTS idx_clasa8_buget_org_an
        ON clasa8_buget(org_id, an);
      CREATE INDEX IF NOT EXISTS idx_clasa8_buget_versions_org_an
        ON clasa8_buget_versions(org_id, an, version_no DESC);
    `
  }
```

## ⛔ Ce NU face migrarea, deliberat

- **NU atinge `UNIQUE (org_id, version_no)`** de pe `clasa8_buget_versions`. `version_no` rămâne
  o secvență globală per organizație. Renumerotarea per an ar fi o a doua schimbare de
  comportament, inutilă pentru obiectivul lotului, și ar face ca istoricul existent (6 versiuni)
  să pară rescris.
- **NU șterge nimic.** Niciun `DELETE`, niciun `DROP TABLE`, niciun `DROP COLUMN`.

⚠️ Numele constrângerii generate automat: dacă `DROP CONSTRAINT IF EXISTS
clasa8_buget_org_id_cod_ssi_key` nu găsește nimic, constrângerea are alt nume, iar `ADD
CONSTRAINT` va eșua pe date reale cu două valori pentru același cod. **Verifică numele real**
înainte de a considera etapa încheiată:

```sql
SELECT conname FROM pg_constraint
 WHERE conrelid = 'clasa8_buget'::regclass AND contype = 'u';
```

Rulează asta pe baza de test locală, după migrare. **Așteptat: exact
`clasa8_buget_org_an_cod_uniq`, și NIMIC altceva.** Dacă apare și cea veche, migrarea n-a
făcut ce credem și raportezi.

---

# ETAPA B — importul și ștergerea, scopate pe an

Fișier: `server/routes/clasa8.mjs`.

## B.1 — validarea anului, o singură dată

Adaugă, imediat după `const router = Router();`:

```js
// #202 — anul de exercițiu al bugetului. Explicit în corp/query, cu implicit anul curent:
// cazul real e „în decembrie încarc bugetul pe anul următor", deci nu se poate deriva din ceas.
const AN_MIN = 2000, AN_MAX = 2100;
function _parseAn(raw) {
  if (raw === undefined || raw === null || raw === '') return new Date().getFullYear();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < AN_MIN || n > AN_MAX) return null; // null = invalid
  return n;
}
```

## B.2 — `POST /buget/import`

Corpul primește `an` opțional. Patch-urile:

`old_str`:
```js
    const { rows: rawRows, filename } = req.body || {};
```
`new_str`:
```js
    const { rows: rawRows, filename } = req.body || {};

    // #202 — anul de exercițiu al acestui import.
    const an = _parseAn(req.body?.an);
    if (an === null)
      return res.status(400).json({ error: 'an_invalid', message: `an trebuie să fie un întreg între ${AN_MIN} și ${AN_MAX}` });
```

`old_str`:
```js
        `INSERT INTO clasa8_buget_versions
           (org_id, version_no, uploaded_by, source_filename, row_count, total_value)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, version_no, uploaded_at`,
        [orgId, nextV, userId, filename || null, count, Math.round(total * 100) / 100]
```
`new_str`:
```js
        `INSERT INTO clasa8_buget_versions
           (org_id, version_no, uploaded_by, source_filename, row_count, total_value, an)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, version_no, uploaded_at, an`,
        [orgId, nextV, userId, filename || null, count, Math.round(total * 100) / 100, an]
```

⭐ Patch-ul central al lotului:

`old_str`:
```js
      await client.query('DELETE FROM clasa8_buget WHERE org_id = $1', [orgId]);
```
`new_str`:
```js
      // #202 — ștergerea e scopată pe AN. Fără `AND an = $2`, importul pe 2027 ar șterge
      // bugetul pe 2026, exact comportamentul pe care lotul ăsta îl repară.
      await client.query('DELETE FROM clasa8_buget WHERE org_id = $1 AND an = $2', [orgId, an]);
```

`old_str`:
```js
        const valueParams = deduped.flatMap(([cod, val]) => [versionId, orgId, cod, val]);
        await client.query(
          `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare) VALUES ${valuePlaceholders}`,
          valueParams
        );
```
`new_str`:
```js
        const valueParams = deduped.flatMap(([cod, val]) => [versionId, orgId, cod, val, an]);
        await client.query(
          `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare, an) VALUES ${valuePlaceholders}`,
          valueParams
        );
```

⚠️ `valuePlaceholders` se generează cu `i * 4 + 1..4`. Odată cu a cincea coloană devine
`i * 5 + 1..5`. **Nu uita patch-ul ăsta** — altfel parametrii se decalează și inserarea fie
crapă, fie scrie valori în coloane greșite:

`old_str`:
```js
        const valuePlaceholders = deduped.map((_, i) =>
          `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
        ).join(', ');
```
`new_str`:
```js
        const valuePlaceholders = deduped.map((_, i) =>
          `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
        ).join(', ');
```

Răspunsul întoarce și anul — `res.json({ ok: true, version_no, uploaded_at, an, count, total })`.

## B.3 — `DELETE /buget`

Acceptă `?an=`, implicit anul curent, ștergere scopată:

`old_str`:
```js
    const { rowCount } = await pool.query(
      'DELETE FROM clasa8_buget WHERE org_id = $1',
      [orgId]
    );

    return res.json({ ok: true, deleted: rowCount });
```
`new_str`:
```js
    const an = _parseAn(req.query?.an);
    if (an === null)
      return res.status(400).json({ error: 'an_invalid' });

    const { rowCount } = await pool.query(
      'DELETE FROM clasa8_buget WHERE org_id = $1 AND an = $2',
      [orgId, an]
    );

    return res.json({ ok: true, deleted: rowCount, an });
```

## B.4 — `GET /buget/meta` și `GET /buget/coduri`

Ambele primesc `?an=` cu implicit anul curent, și filtrează pe el:
- `meta`: `WHERE v.org_id = $1 AND v.an = $2` (restul interogării neatins), iar răspunsul
  include `an`.
- `coduri`: `WHERE org_id = $1 AND an = $2`.

Motivul pentru `coduri`, deși e doar un datalist: cu doi ani în bază și fără filtru, fiecare
cod ar apărea de două ori, cu valori diferite. Azi nu se vede — la prima încărcare pe 2027, da.

---

# ETAPA C — serviciile de raport, scopate pe an

Fișier: `server/services/clasa8.mjs`. Ambele funcții au **același** bloc `buget AS (…)`:

```sql
    buget AS (
      SELECT cod_ssi, valoare AS suma
      FROM clasa8_buget
      WHERE org_id = $1
    ),
```

⚠️ **Textul apare de DOUĂ ori în fișier.** `old_str` trebuie lărgit cu linia dinainte și cea de
după până devine unic în fiecare caz (în `getClasa8Aggregate` urmează comentariul
`-- Universul cod_SSI = unirea celor 4 surse`; în `getBugetDisponibil` urmează direct
`universe AS (`). Dacă `old_str` nu se potrivește **exact o dată**, **oprește-te și raportează** —
nu ghici.

## C.1 — `getClasa8Aggregate(pool, orgId, filters = {})`

Anul intră prin `filters`, ca să nu schimbăm aritatea funcției:

```js
  const an = Number.isInteger(filters.an) ? filters.an : new Date().getFullYear();
```

⚠️ Numerotarea parametrilor din funcția asta e **dinamică** (`++paramIdx`, în funcție de ce
filtre sunt active). **NU folosi `++paramIdx` pentru an.** Împinge-l ULTIMUL și ia indicele din
valoarea de retur a lui `push`, care e chiar poziția 1-based:

```js
  const anIdx = params.push(an); // push() întoarce noua lungime = indicele $N
```

apoi în SQL: `WHERE org_id = $1 AND an = $${anIdx}`.

## C.2 — `getBugetDisponibil(pool, orgId, excludeDfId = null)`

Semnătura devine `(pool, orgId, excludeDfId = null, an = new Date().getFullYear())`.
`params` e `[orgId, excludeDfId || null]`, deci anul e `$3`: `WHERE org_id = $1 AND an = $3`.

Apelanții din `server/routes/clasa8.mjs` **nu se modifică** — implicitul face treaba. Parametrul
ajunge din rută în **#203**.

---

# ⛔ ETAPA D — ce rămâne NEATINS, deliberat

Scrie asta în mesajul de commit, ca un lot viitor să nu „completeze" din reflex:

**`server/services/cod-ssi-validate.mjs:74`** rămâne **exact cum e**, fără filtru de an:

```js
'SELECT cod_ssi FROM clasa8_buget WHERE org_id = $1',
```

E o validare de nomenclator („există codul ăsta la noi?"), nu una de buget. Dacă o scopăm pe
anul curent, o revizie făcută în 2027 pe un DF din 2026 începe să fie respinsă pentru coduri
perfect valide. Câștig zero, regresie garantată. Comentariul din antetul fișierului
(liniile 20–24) descrie mecanismul vechi „tabela ține DOAR versiunea activă" — **actualizează
comentariul** ca să spună că acum ține toate versiunile active per an și că validarea traversează
deliberat anii. Codul rămâne neschimbat.

Neatinse: orice fișier din `public/`, orice fișier din zona NO-TOUCH, `saveFlow`, orice altă
migrare existentă.

---

# ETAPA E — teste

## E.1 — `server/tests/db/clasa8-buget-an.test.mjs` (nou, bază reală)

1. După migrare: coloana `an` există pe ambele tabele, e `NOT NULL`, și **zero rânduri cu
   `an IS NULL`**.
2. Constrângerile de unicitate pe `clasa8_buget`: **exact una**, `clasa8_buget_org_an_cod_uniq`.
   (Interogarea `pg_constraint` din Etapa A.)
3. Același `cod_ssi`, același org, **doi ani diferiți** ⇒ ambele inserări reușesc.
4. ⭐ **Testul central**: seed buget `an=2026`; import prin rută cu `an=2027`; după import,
   rândurile pe **2026 sunt intacte** (număr și sume identice) și cele pe 2027 există.
   Ăsta e bugul pe care îl reparăm — dacă testul ăsta nu există, lotul nu e făcut.
5. `DELETE /api/clasa8/buget?an=2027` lasă 2026 intact.
6. `an` invalid (`"abc"`, `1999`, `2101`, `2026.5`) ⇒ **400 `an_invalid`**, zero scrieri în bază.
7. ⭐ **Neregresie**: cu date DOAR pe 2026 în bază, `getClasa8Aggregate` întoarce exact aceleași
   totaluri ca înainte de lot (`buget`, `ramane_din_buget`). Ancorează proprietatea de siguranță.
8. Cu date pe 2026 **și** 2027, agregatul implicit (anul curent) **nu** le amestecă.

## E.2 — `npm test` (unit)

Validarea lui `_parseAn` și forma răspunsurilor. Fără bază.

```bash
npm test
npm run test:db
```

⚠️ **Secvențial, niciodată în paralel** — a produs deja de mai multe ori eșecuri false prin
timeout. Spune în raport că ai făcut-o.

`test:db` se rulează **local**, pe PostgreSQL 17, conform secțiunii „Mediul local" din
`CLAUDE.md` (#201). **`skipped` nu e `passed`.** Dacă suita nu rulează local, oprește-te și
raportează — nu împinge pe CI ca să afli acolo.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l modifica.** Așteptat: niciunul.

---

# ETAPA F — versiune și commit

```bash
npm version 3.9.855 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
git status --short
```

**Niciun fișier din `public/`** ⇒ `CACHE_VERSION` **neatins**, `?v=` **neatins**. Verifică,
nu presupune.

`git add` **explicit**, pe fișiere numite. **Niciodată `git add -A`.**

Mesaj de commit:

```
feat(#202): bugetul Clasa 8 capata an de exercitiu — importul pe 2027 nu mai sterge 2026 — v3.9.855

UNIQUE (org_id, cod_ssi) forta importul sa faca DELETE FROM clasa8_buget
WHERE org_id, deci incarcarea bugetului pe anul urmator stergea definitiv
valorile per cod SSI ale anului curent (versiunile pastrau doar metadata).

Migrarea 111 adauga `an`, il backfilleaza din anul incarcarii versiunii si
schimba cheia in (org_id, an, cod_ssi). Importul, DELETE /buget, meta si
coduri sunt scopate pe an; serviciile de raport citesc implicit anul curent.

Zero schimbare vizibila: dupa backfill exista un singur an in baza. Testul 7
din clasa8-buget-an ancoreaza asta.

cod-ssi-validate ramane DELIBERAT fara filtru de an — e validare de
nomenclator, nu de buget; scopata pe an ar respinge coduri valide intr-o
revizie facuta peste ani.

Selectorul de an in interfata si parametrul ?an= pe rute = #203.
```

```bash
git push origin develop
```

---

# RAPORT FINAL — obligatoriu

1. Ancorele din **Etapa 0**, cu valorile **OBȚINUTE**, nu cele așteptate.
2. Confirmarea că `clasa8_buget` nu apare în niciun fișier din `migrations/` (deci nu e V4).
3. ⭐ Numele **real** al constrângerii vechi și rezultatul interogării `pg_constraint` **după**
   migrare.
4. Câte rânduri a atins fiecare `UPDATE` din backfill, pe baza de test.
5. Confirmarea explicită că ai schimbat `i * 4` → `i * 5` în `valuePlaceholders`.
6. Cum ai lărgit fiecare dintre cele două `old_str` pentru blocul `buget AS (…)` ca să fie unic.
7. Rezultatul fiecărui test din E.1, **în special 4, 7 și 8**.
8. Numerele reale `npm test` / `npm run test:db`, rulate **secvențial și local**.
9. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
10. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
11. Constatări colaterale: în special orice alt loc care citește sau scrie `clasa8_buget` și
    pe care Etapa 0 nu l-a prins.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără deploy, fără atingerea producției.
- Zero fișiere din `public/`. Zero atingeri în zona NO-TOUCH.
- **Niciun `DELETE` sau `DROP` de date** în migrare. Doar `ADD COLUMN`, `UPDATE`, swap de
  constrângere, `CREATE INDEX`.
- `UNIQUE (org_id, version_no)` de pe `clasa8_buget_versions` rămâne **neatins**.
- `cod-ssi-validate.mjs` — doar comentariul, **niciodată interogarea**.
- Nicio schimbare vizibilă de cifre. Dacă testul 7 pică, **oprește-te și raportează**.
- `old_str` care nu se potrivește **exact o dată** ⇒ **OPREȘTE-TE și raportează**.
- `git add` explicit. `git push origin develop` ca pas final.
