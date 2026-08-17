# PROMPT #124e′ — idempotență ORD pe fereastră de timp (fără index, fără migrație)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 · **Target versiune:** `v3.9.758` (de la 3.9.757)
**Migrații:** ZERO · **Index nou:** ZERO · **Fișiere din `public/`:** ZERO ⇒ fără `CACHE_VERSION`, fără `?v=`

---

## 1. Contextul — și de ce NU e o oglindă a fixului de la DF

Reconul #124a propunea pentru ORD „oglinda exactă a `df.mjs:255-305`": `SELECT` de dedup pe
`source_alop_id` + **index unic parțial** + `catch 23505`.

**Interogările rulate pe producție (12.08.2026, #124b) au invalidat partea cu indexul.**
`formulare_ord` are 8 grupuri cu mai multe ORD-uri pe același `source_alop_id`, iar în FIECARE
grup fiecare ORD are alt `nr_ordonant_pl`. Mircea a enunțat invariantul de produs care explică
asta:

> **ORD nu are revizii. Mai multe ordonanțări pe același dosar ALOP TREBUIE să aibă numere
> diferite. Doar DF-ul păstrează același număr, cu `revizie_nr` diferit.**

⇒ un index unic pe `(source_alop_id)` ar interzice comportamentul CORECT al aplicației.
⛔ **NU crea niciun index unic pe `formulare_ord`.** ⛔ **NU adăuga `revizie_nr` la `formulare_ord`.**

Ce arată totuși datele: din cele 8 grupuri, **4 conțin o pereche creată la 109–782 de
milisecunde** distanță. Distanța minimă între două ordonanțări LEGITIME din aceleași date e de
**2 zile și 20 de ore**. Patru ordine de mărime între cele două populații — deci discriminatorul
corect nu e conținutul, ci **timpul**.

Cauza probabilă nu e (doar) dublu-clicul: la 109 ms nu apuci să apeși de două ori. Se potrivește
cu cursa de autosave din `public/js/formular/doc.js:1024`, unde `saveDoc` ramifică pe `if(!docId)`
→ POST; două salvări plecate înainte ca primul răspuns să seteze `docId` creează două documente.
De aceea garda trebuie să fie **pe server** — o gardă de buton nu ar acoperi-o.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/routes/formulare/df.mjs` — DF e deja protejat corect, nu-l atinge
⛔ orice fișier din `public/` — promptul e strict server-side
⛔ `POST /api/alop` — decizia luată pe datele #124b (blocul 3b = 0 perechi ALOP) e „nicio cheie pe
   server". Nu adăuga idempotență acolo.
⛔ Zero refactorizări în trecere, zero redenumiri, zero reformatări.

Se atinge EXCLUSIV handlerul `POST /api/formulare-ord` din `server/routes/formulare/ord.mjs`.

---

## 3. Etapa A — garda

### A.1 Ancora

În `server/routes/formulare/ord.mjs`, handlerul `POST /api/formulare-ord`, imediat **după**
blocul care verifică `nr_ordonant_pl` duplicat și **înainte** de construirea INSERT-ului.

**old_str:**

```js
    const cols = ['org_id', 'created_by'];
    const vals = [actor.orgId, actor.userId];
```

Verifică întâi unicitatea:

```bash
grep -n "const cols = \['org_id', 'created_by'\];" server/routes/formulare/ord.mjs
```

**Așteptat: exact 1 linie.** Dacă sunt mai multe, OPREȘTE-TE și raportează.

**new_str:**

```js
    // #124e′ — idempotență pe FEREASTRĂ DE TIMP (nu pe cheie unică).
    // ⚠️ Spre deosebire de DF, `formulare_ord` NU poate primi un index unic pe
    // `source_alop_id`: ORD nu are revizii, deci mai multe ordonanțări pe același dosar ALOP
    // sunt starea CORECTĂ (fiecare cu alt `nr_ordonant_pl`). Datele din producție (12.08.2026)
    // confirmă: 8 grupuri multi-ORD, distanța minimă între două ordonanțări legitime = 2 zile
    // și 20 de ore; în schimb duplicatele accidentale apar la 109–782 ms. Discriminatorul e
    // timpul, nu conținutul. Fereastra de 10 s e cu peste patru ordine de mărime sub cea mai
    // scurtă distanță legitimă observată.
    // Cauza vizată nu e doar dublu-clicul: `saveDoc` (public/js/formular/doc.js:1024) ramifică
    // pe `if(!docId)` → POST, deci două autosalvări plecate înainte de primul răspuns creează
    // două documente. O gardă de buton nu ar acoperi-o; asta e poarta.
    const srcAlopId = isUuid(body.source_alop_id) ? body.source_alop_id : null;
    if (srcAlopId) {
      const { rows: dup } = await pool.query(
        `SELECT * FROM formulare_ord
          WHERE source_alop_id = $1
            AND org_id         = $2
            AND created_by     = $3
            AND deleted_at IS NULL
            AND created_at > NOW() - INTERVAL '10 seconds'
          ORDER BY created_at ASC
          LIMIT 1`,
        [srcAlopId, actor.orgId, actor.userId]
      );
      if (dup.length) {
        logger.warn({ existingId: dup[0].id, srcAlopId, actor: actor.email },
          'formulare-ord: creare duplicat în fereastra de 10s — s-a returnat documentul existent');
        dup[0].capabilities = computeDocCapabilities(dup[0], actor, 'ordnt');
        return res.json({ ok: true, document: dup[0], deduplicated: true });
      }
    }
    const cols = ['org_id', 'created_by'];
    const vals = [actor.orgId, actor.userId];
```

### A.2 Decizii de proiectare — respectă-le exact, nu „îmbunătăți"

- **200 tăcut, nu 409.** Aceeași semantică ca la DF: al doilea POST primește documentul existent,
  în forma IDENTICĂ a răspunsului de succes (`{ ok: true, document }`). Frontendul continuă
  normal cu `document.id`, deci nu apare nicio eroare pentru utilizator — exact ce vrem, fiindcă
  în cazul autosave nici nu există un utilizator care să vadă eroarea.
- **`deduplicated: true`** e un câmp ADĂUGAT, ignorat azi de client. ⛔ NU modifica frontendul.
- **`created_by = actor.userId` face parte din cheie.** Doi utilizatori diferiți care ar crea
  ordonanțări pe același dosar în aceeași fereastră primesc fiecare documentul lui. Merge-ul
  muncii a doi oameni într-un singur document ar fi mai rău decât un duplicat.
- **`ORDER BY created_at ASC`** — se întoarce cel mai VECHI din fereastră, nu cel mai nou.
- **Fără `flow_id IS NULL` în predicat** — un document creat acum 10 secunde nu poate fi pe flux;
  o condiție în plus ar fi zgomot.
- **Limitare ACCEPTATĂ, de scris în raport:** garda prinde cazul secvențial, nu o cursă strict
  paralelă în care ambele cereri fac `SELECT` înainte ca vreuna să facă `INSERT`. Închiderea
  acelei ferestre ar cere un index unic, care e exclus de invariantul de produs. Cele patru cazuri
  reale din producție (109–782 ms) sunt secvențiale, deci acoperite.
- `isUuid`, `computeDocCapabilities`, `pool` și `logger` sunt DEJA importate în fișier
  (liniile 34, 16 și importurile de sus) — ⛔ nu adăuga importuri.

---

## 4. Etapa B — test pe Postgres real

Fișier nou: `server/tests/db/ord-dedup-fereastra.test.mjs`

Alege ca model unul dintre testele DB existente care lovesc deja `POST /api/formulare-ord`
(de ex. `server/tests/db/ord-derive-ident.test.mjs` sau `doc-capabilities.test.mjs`) și
oglindește-i fidel montarea aplicației, mock-urile (`csrf`, `require-module`, `logger`) și
helperii din `tests/helpers/db-real.mjs`. ⛔ Nu inventa o schelă nouă.

Cazuri obligatorii:

1. **Două POST-uri consecutive**, același `source_alop_id`, același utilizator → al doilea
   întoarce **200** cu **ACELAȘI `document.id`** și `deduplicated: true`;
   `SELECT COUNT(*) FROM formulare_ord WHERE source_alop_id=…` = **1**.
2. ⭐ **În afara ferestrei — cazul care apără invariantul de produs.** După primul POST,
   `UPDATE formulare_ord SET created_at = NOW() - INTERVAL '1 minute'`, apoi al doilea POST →
   se creează un ORD **NOU** (count = 2, id-uri diferite, `deduplicated` absent). Ăsta e testul
   care garantează că nu am interzis ordonanțările multiple legitime; dacă pică, fixul e greșit,
   nu testul.
3. **Alt utilizator, aceeași organizație, în fereastră** → ORD nou (count = 2).
4. **Primul ORD soft-șters** (`deleted_at = NOW()`) → al doilea POST creează unul nou.
5. **Fără `source_alop_id`** → garda nu se aplică; două POST-uri = două documente.
6. **Alt `org_id`** cu același `source_alop_id` în fereastră → ORD nou (garda e org-scopată).

⛔ Testul IMPORTĂ ruta reală. Nu redeclara logica gărzii în test.
⚠️ Dacă un test existent presupunea că două POST-uri consecutive pe același ALOP produc două
documente, **NU slăbi garda** — migrează testul (ca la #122) și raportează explicit care și de ce.

---

## 5. Etapa C — rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ **„Skipped" NU e „passed".** Fără Docker, folosește rețeta cu instanță PG 17 efemeră din
`CLAUDE.md`. Raportează numerele REALE.

Dacă ambele sunt verzi:

1. bump `package.json` → `3.9.758`;
2. commit pe `develop`:
   `fix(#124e): idempotență ORD pe fereastră de 10s — fără index unic (ordonanțările multiple sunt legitime)`;
3. `git push origin develop`.

⛔ Fără `--amend`, fără `--force`.

---

## 6. Verificări de ieșire (pune ieșirea verbatim în raport)

```bash
grep -n "deduplicated" server/routes/formulare/ord.mjs
# Așteptat: exact 1 linie

grep -n "INTERVAL '10 seconds'" server/routes/formulare/ord.mjs
# Așteptat: exact 1 linie

grep -rn "CREATE UNIQUE INDEX\|revizie_nr" server/routes/formulare/ord.mjs server/db/index.mjs | grep -i "formulare_ord"
# Așteptat: 0 rezultate — NU s-a creat niciun index și nu s-a atins schema ORD

git status --short
# Așteptat: EXACT 3 căi — M package.json, M server/routes/formulare/ord.mjs,
#           A/?? server/tests/db/ord-dedup-fereastra.test.mjs. Nimic altceva.
```

> Notă: folosim `git status --short`, nu `git diff --stat` — `git diff` nu vede fișierele
> netracked, deci un fișier de test nou nu apare acolo (eroare din promptul #124f, corectată aici).

---

## 7. RAPORT FINAL — structură obligatorie

- commit hash + intervalul de push
- `npm test`: N fișiere / M teste (passed / failed / todo)
- `npm run test:db`: **PASSED REAL** sau SKIPPED — dacă e skipped, nu declara lotul terminat
- ieșirea celor 4 verificări de mai sus, verbatim
- confirmarea explicită că **NU** s-a creat niciun index pe `formulare_ord` și că nicio migrație
  nu a fost adăugată
- rezultatul cazului 2 (în afara ferestrei) menționat separat — e acceptanța de produs
- orice test preexistent modificat, cu motivul
- orice abatere, cu motivul. Dacă găsești o eroare în promptul ăsta, **spune-o, nu o repara
  tăcut**.
