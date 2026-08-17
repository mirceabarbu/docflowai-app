# PROMPT #124i — atașamente duplicate: dedup la upload + copiere cu adevărat idempotentă

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 · **Target versiune:** `v3.9.759` (de la 3.9.758)
**Migrații:** ZERO · **Index nou:** ZERO · **Fișiere din `public/`:** ZERO ⇒ fără `CACHE_VERSION`, fără `?v=`

---

## 1. Contextul — două defecte, unul îl alimentează pe celălalt

Interogarea de duplicate rulată pe producție (12.08.2026, #124b, blocul 7) a găsit **16 grupuri**.
Capul listei: **25 de copii** ale aceluiași fișier („Referat de necesitate - Tricouri.pdf",
1.112.213 octeți) pe ACELAȘI DF și ACELAȘI slot, încărcate pe parcursul a 6 minute. Aproape
**28 MB de `BYTEA`** în Postgres pentru un singur document.

**Defectul 1 — uploadul n-are nicio deduplicare.** `POST /api/formulare-atasamente/:type/:id`
(`server/routes/formulare/shared.mjs`, INSERT-ul de la ~176) inserează necondiționat. Fără gardă
client, fără gardă server.

**Defectul 2 — copierea spre flux NU e idempotentă, deși comentariul spune că este.**
`copyFormularAttachmentsToFlow` (`server/services/formular-flow-attachments.mjs:39`) face
`INSERT ... SELECT` cu `NOT EXISTS (SELECT 1 FROM flow_attachments WHERE flow_id=$1 AND filename=fa.filename)`
și comentariul „guard NOT EXISTS pe (flow_id, filename) → idempotent". În realitate **`NOT EXISTS`
se evaluează față de starea tabelei la începutul instrucțiunii, nu față de rândurile inserate de
aceeași instrucțiune** — deci dacă sursa are N rânduri cu același `filename`, toate N intră
deodată. De aceea rezultatele #124b arată duplicate ȘI în `flow_attachments`, deși reconul #124a
le declarase imposibile.

Cele două se compun: fiecare duplicat din `formulare_atasamente` se multiplică în pachetul de
semnare. Reparăm ambele.

⛔ **Fără index unic, fără migrație.** Producția are DEJA cele 16 grupuri de duplicate; un index
unic ar eșua la creare (exact ce a pățit migrarea 095, care are `RAISE WARNING` tocmai pentru
asta). Curățarea datelor existente se face separat, prin SQL, DUPĂ ce fixul e în producție —
altfel cureți și apar altele.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ orice fișier din `public/` — promptul e strict server-side
⛔ ruta `DELETE` de atașamente și rutele `GET` (listă / conținut) — nu se ating
⛔ `flow_attachments` ca schemă — nu se adaugă coloane, nu se adaugă indexuri
⛔ Zero refactorizări în trecere, zero redenumiri, zero reformatări

Se ating EXACT două fișiere de producție: `server/routes/formulare/shared.mjs` (handlerul de
upload) și `server/services/formular-flow-attachments.mjs` (`SELECT`-ul din copiere).

---

## 3. Etapa A — dedup la upload

### A.1 Ancora

```bash
grep -n "INSERT INTO formulare_atasamente" server/routes/formulare/shared.mjs
```

**Așteptat: exact 1 linie.** Dacă sunt mai multe, OPREȘTE-TE și raportează.

**old_str** (blocul din handlerul `POST /api/formulare-atasamente/:type/:id`):

```js
    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mime_type, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mime_type, data.length, data, slot]);
```

**new_str:**

```js
    // #124i — deduplicare la upload. Producția avea 16 grupuri de fișiere duplicate, cel mai
    // mare cu 25 de copii ale aceluiași PDF de 1,1 MB pe același document și același slot
    // (~28 MB de BYTEA pentru un singur atașament). Cheia: (form_type, form_id, slot, filename,
    // size_bytes) — același nume ȘI aceeași dimensiune, pe același slot, e același fișier.
    // ⛔ Fără fereastră de timp (spre deosebire de #124e′ la ORD): aici nu există niciun caz
    // legitim de „aceeași anexă de două ori pe același slot", iar duplicatele reale erau
    // împrăștiate pe minute și zeci de minute, deci o fereastră n-ar fi prins nimic.
    // ⛔ Fără index unic: producția are deja duplicate, indexul ar eșua la creare (tiparul 095).
    // Un fișier CORECTAT cu același nume are aproape sigur altă dimensiune, deci trece; dacă
    // vreodată nu trece, calea rămasă e ștergerea atașamentului vechi și reîncărcarea.
    const { rows: dupAtt } = await pool.query(`
      SELECT id, filename, mime_type, size_bytes, slot, created_at
        FROM formulare_atasamente
       WHERE form_type = $1 AND form_id = $2 AND slot = $3
         AND filename = $4 AND size_bytes = $5
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
    `, [type, id, slot, filename, data.length]);
    if (dupAtt.length) {
      logger.warn({ type, id, slot, filename, existingId: dupAtt[0].id, actor: actor.email },
        'formulare-atasament: upload duplicat — s-a returnat atașamentul existent');
      return res.json({ ok: true, atasament: dupAtt[0], deduplicated: true });
    }

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mime_type, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mime_type, data.length, data, slot]);
```

### A.2 Decizii — respectă-le, nu „îmbunătăți"

- **200 tăcut**, cu răspunsul în forma IDENTICĂ a succesului (`{ ok: true, atasament }`) — clientul
  primește `atasament.id` și continuă normal. `deduplicated: true` e un câmp ADĂUGAT, ignorat azi.
  ⛔ NU modifica frontendul.
- `slot` FACE PARTE din cheie: același fișier pe slot 1 și pe slot 2 sunt două atașamente
  legitime (DF are `n-fdad` și `n-adata`).
- `deleted_at IS NULL` în predicat: după o ștergere, reîncărcarea aceluiași fișier trebuie să
  meargă.
- Poziția contează: garda vine **după** citirea completă a corpului (avem nevoie de `data.length`)
  și după verificările de mărime, dar **înainte** de INSERT. ⛔ Nu o muta înainte de citirea
  stream-ului — `data.length` e chiar jumătate din cheie.
- `pool` și `logger` sunt deja importate în fișier — ⛔ nu adăuga importuri.

---

## 4. Etapa B — copierea spre flux devine cu adevărat idempotentă

**old_str** (în `server/services/formular-flow-attachments.mjs`):

```js
  // INSERT...SELECT atomic cu guard NOT EXISTS pe (flow_id, filename) → idempotent.
  // Copiază bytes-ul direct (fa.data → flow_attachments.data), păstrând nume + content-type.
  const { rows } = await pool.query(
    `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
     SELECT $1, fa.filename, fa.mime_type, fa.size_bytes, fa.data
       FROM formulare_atasamente fa
      WHERE fa.form_type = $2
        AND fa.form_id   = $3
        AND fa.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM flow_attachments fla
           WHERE fla.flow_id = $1 AND fla.filename = fa.filename
        )
     RETURNING id, filename`,
    [flowId, formType, formId]
  );
```

**new_str:**

```js
  // INSERT...SELECT atomic. DOUĂ gărzi, pentru două curse diferite:
  //  (1) NOT EXISTS pe (flow_id, filename) — apără RE-RULAREA copierii (a doua chemare a
  //      funcției nu mai adaugă nimic);
  //  (2) #124i: DISTINCT ON (fa.filename, fa.size_bytes) — apără de duplicatele din SURSĂ.
  //      `NOT EXISTS` se evaluează față de starea tabelei la ÎNCEPUTUL instrucțiunii, NU față
  //      de rândurile inserate de aceeași instrucțiune ⇒ înainte de fix, N rânduri sursă cu
  //      același `filename` produceau N rânduri în flow_attachments dintr-o singură execuție.
  //      Comentariul vechi („→ idempotent") era fals; duplicatele găsite în producție pe
  //      flow_attachments (12.08.2026) erau exact asta.
  //      ⚠️ Cheia include `size_bytes` DELIBERAT. Copierea ia atașamentele de pe AMBELE
  //      sloturi ale documentului; două fișiere DIFERITE care împart numele (ex. „Anexa.pdf"
  //      pe slot 1 și pe slot 2) trebuie să ajungă AMÂNDOUĂ în pachetul de semnare. Un
  //      `DISTINCT ON (fa.filename)` singur le-ar topi într-unul și ar scoate tăcut un
  //      document din pachet — regresie mai gravă decât bugul reparat aici. Cu `size_bytes`
  //      în cheie se colapsează doar duplicatele reale (același nume ȘI aceeași dimensiune,
  //      inclusiv aceeași anexă pusă din greșeală pe ambele sloturi). Listarea și
  //      previzualizarea din flux cheiază pe `id` (attachments.mjs:108-112), deci două rânduri
  //      cu același `filename` se afișează corect, separat.
  //      Se păstrează cel mai VECHI rând sursă per (filename, size_bytes).
  const { rows } = await pool.query(
    `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
     SELECT DISTINCT ON (fa.filename, fa.size_bytes)
            $1, fa.filename, fa.mime_type, fa.size_bytes, fa.data
       FROM formulare_atasamente fa
      WHERE fa.form_type = $2
        AND fa.form_id   = $3
        AND fa.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM flow_attachments fla
           WHERE fla.flow_id = $1 AND fla.filename = fa.filename
        )
      ORDER BY fa.filename, fa.size_bytes, fa.created_at ASC
     RETURNING id, filename`,
    [flowId, formType, formId]
  );
```

⚠️ `DISTINCT ON` cere ca `ORDER BY` să înceapă cu exact expresiile din `DISTINCT ON`, în
aceeași ordine — de aceea `ORDER BY fa.filename, fa.size_bytes, fa.created_at ASC`.
⛔ NU scoate `fa.size_bytes` din cheie „ca să fie mai simplu" — motivul e scris în comentariu.

⚠️ **Limitare PREEXISTENTĂ, lăsată neschimbată deliberat:** guard-ul `NOT EXISTS` rămâne pe
`(flow_id, filename)`, nu pe `(flow_id, filename, size_bytes)`. Consecință: dacă fluxul are deja
„Anexa.pdf" și copierea se re-rulează după ce documentul a primit un ALT fișier cu același nume,
al doilea nu mai e adăugat. E comportamentul de azi; nu-l schimba în promptul ăsta — ar modifica
semantica re-rulării, care e altă discuție.

---

## 5. Etapa C — test pe Postgres real

Fișier nou: `server/tests/db/atasamente-dedup.test.mjs`

Model de urmat: un test DB existent care montează rutele de formulare
(de ex. `server/tests/db/formular-link-flow-attachments.test.mjs`, care atinge deja exact zona
asta). Oglindește-i montarea, mock-urile și helperii. ⛔ Nu inventa schelă nouă.

⚠️ **Capcană de test, citește înainte să scrii:** ruta de upload NU folosește `express.json` —
citește corpul brut din stream (`req.on('data')`). În testul cu supertest trimite un `Buffer` cu
un `Content-Type` **non-JSON** (ex. `application/pdf`) și numele în headerul `x-filename`. Dacă
montezi `express.json()` peste ruta asta și trimiți `application/json`, middleware-ul consumă
stream-ul și handlerul primește corp gol (`400 fisier_gol`) — ceea ce ar părea un bug în gardă,
dar e un artefact de test.

Cazuri obligatorii:

**Etapa A (upload):**
1. Același fișier (nume + dimensiune) încărcat de două ori pe același slot → al doilea răspuns
   200 cu **ACELAȘI `atasament.id`**, `deduplicated: true`;
   `SELECT COUNT(*) FROM formulare_atasamente WHERE form_id=… AND deleted_at IS NULL` = **1**.
2. Același nume, **slot diferit** (1 vs 2) → două atașamente (count = 2). Slotul e parte din cheie.
3. Același nume, **dimensiune diferită** (fișier corectat) → două atașamente (count = 2).
4. Primul atașament **soft-șters** (`deleted_at = NOW()`), apoi reîncărcare → se creează unul nou.
5. Alt `form_id` → atașament nou.

**Etapa B (copiere):**
6. ⭐ Sursă cu **3 rânduri identice ca `filename` ȘI `size_bytes`** inserate DIRECT în
   `formulare_atasamente` (bypass rută, ca să simulăm datele legacy din producție) →
   `copyFormularAttachmentsToFlow` creează **EXACT 1** rând în `flow_attachments`. Fără fix,
   testul ăsta dă 3 — e regresia care contează.
7. ⭐⭐ **Două fișiere DIFERITE cu ACELAȘI `filename`** (dimensiuni diferite, ex. slot 1 și
   slot 2) → copierea creează **EXACT 2** rânduri în `flow_attachments`, ambele cu același
   `filename` și cu `size_bytes` diferit. Ăsta e testul care apără pachetul de semnare: dacă dă
   1, cheia de deduplicare e prea largă și un document dispare tăcut din flux.
8. Aceeași funcție rulată **de două ori** → numărul de rânduri rămâne neschimbat (idempotența
   existentă, nepierdută).

⛔ Testele IMPORTĂ codul real de producție. Nu redeclara logica.
⚠️ Dacă un test existent presupunea că două uploaduri identice produc două rânduri, **NU slăbi
garda** — migrează testul și raportează care și de ce.

---

## 6. Etapa D — rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed" — fără Docker, folosește rețeta cu instanță PG 17 efemeră din
`CLAUDE.md`. Raportează numerele REALE.

Dacă ambele sunt verzi:

1. bump `package.json` → `3.9.759`;
2. commit pe `develop`:
   `fix(#124i): dedup atașamente la upload + DISTINCT ON la copierea spre flux`;
3. `git push origin develop`.

⛔ Fără `--amend`, fără `--force`.

---

## 7. Verificări de ieșire (ieșirea verbatim în raport)

```bash
grep -n "deduplicated" server/routes/formulare/shared.mjs
# Așteptat: exact 1 linie

grep -n "DISTINCT ON (fa.filename, fa.size_bytes)" server/services/formular-flow-attachments.mjs
# Așteptat: exact 1 linie

grep -n "ORDER BY fa.filename, fa.size_bytes, fa.created_at ASC" server/services/formular-flow-attachments.mjs
# Așteptat: exact 1 linie

grep -rn "CREATE UNIQUE INDEX" server/db/index.mjs | grep -i "atasamente\|flow_attachments"
# Așteptat: 0 rezultate — niciun index nou, nicio migrație

git status --short
# Așteptat: EXACT 4 căi — package.json, shared.mjs, formular-flow-attachments.mjs,
#           testul nou. ⚠️ Working tree-ul are ~50 de fișiere netracked din sesiuni
#           anterioare (prompturi .md, PDF-uri, scripturi SQL) — ignoră-le, dar
#           CONFIRMĂ în raport că ai stage-uit DOAR cele 4 căi de mai sus.
```

---

## 8. RAPORT FINAL — structură obligatorie

- commit hash + intervalul de push
- `npm test`: N fișiere / M teste (passed / failed / todo)
- `npm run test:db`: **PASSED REAL** sau SKIPPED — dacă e skipped, nu declara lotul terminat
- ieșirea celor 5 verificări de mai sus, verbatim
- rezultatele cazurilor 6 ȘI 7 menționate SEPARAT (3 rânduri identice → 1 rând în flux; două
  fișiere diferite cu același nume → 2 rânduri în flux) — împreună sunt acceptanța Etapei B
- confirmarea explicită că NU s-a creat niciun index și nicio migrație
- orice test preexistent modificat, cu motivul
- orice abatere, cu motivul. Dacă găsești o eroare în promptul ăsta, **spune-o, nu o repara
  tăcut**.
