---
prompt: 205
titlu: "Cursa la încărcarea capturilor (ON CONFLICT) + eșecuri de upload înghițite tăcut"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.857
versiune_tinta: v3.9.858
migratii: NU
scrieri_in_baza: NU (schimbă doar FORMA scrierii existente: DELETE+INSERT → INSERT ON CONFLICT)
fisiere_din_public: DA ⇒ `?v=` ȚINTIT + verificare `CACHE_VERSION`
zona_no_touch_atinsa: NU
tip: bugfix (cursă) + vizibilitatea erorilor
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL — incident real, 14.09.2026, Primăria Zărnești

Din logurile de producție, 14:52:28, două cereri `POST /api/formulare-capturi/df/59d86dc0…`
în zbor **simultan**, pe același document:

```
4b0fd760  POST  status 200  ms 1091   (terminată .384Z)
644c9194  POST  status 500  ms 1556   (terminată .833Z)
          duplicate key value violates unique constraint "uniq_formulare_capturi_form_slot_bloc"
          Key (form_type, form_id, slot, COALESCE(bloc_idx,0))=(df, 59d86dc0…, 1, 0) already exists
```

## Cauza — cursă între două interogări neprotejate

`server/routes/formulare/shared.mjs:87-97` face `DELETE` apoi `INSERT`, ca **două interogări
separate, fără tranzacție**. Cu două cereri în paralel:

```
A: DELETE (slot 1, bloc 0) → 0 rânduri
B: DELETE (slot 1, bloc 0) → 0 rânduri
A: INSERT → OK
B: INSERT → 💥 duplicate key
```

Fereastra e largă: între cele două se citește și se scrie un buffer de imagine (142 kB în
incident). Indexul unic (`107_formulare_capturi_uniq_bloc`) **și-a făcut treaba** — nu există
captură duplicată în bază. Apărarea structurală a funcționat; ce lipsește e ca a doua apăsare
să fie inofensivă.

## ⚠️ Ce NU explică incidentul — citește, ca să nu suprainterpretezi

Utilizatorul a raportat bannerul `Eroare: Unexpected token 'u', "upstream error" is not valid JSON`.
**Cursa asta NU l-a produs**: `uploadCaptura` (`public/js/formular/doc.js:1429`) se termină cu
`catch(_){}`, deci acel 500 a fost înghițit tăcut și n-a ajuns niciodată pe ecran. În loguri, la
ora bannerului nu există **nicio** cerere către aplicație.

**Bannerul rămâne neexplicat. Lotul ăsta nu pretinde că îl repară.** Nu inventa o legătură, nu
„repara" altceva pe baza lui, nu adăuga retry-uri speculative.

## Al doilea bug, mai serios decât cursa

`catch(_){}` înseamnă că **orice** eșec la încărcarea capturii e invizibil: rețea căzută, 413,
403, 500. Documentul se salvează fără captură, iar utilizatorul crede că e acolo. Asta e mai
aproape de pierdere de date decât de o eroare de interfață.

---

# ETAPA 0 — ancore

Raportează **valorile obținute**.

```bash
grep -n "DELETE FROM formulare_capturi" server/routes/formulare/shared.mjs
# Așteptat: 1 linie (în handlerul de upload)

grep -n "uniq_formulare_capturi_form_slot_bloc" -A2 server/db/index.mjs
# Așteptat: migrarea 107, index pe (form_type, form_id, slot, (COALESCE(bloc_idx, 0)))

grep -n "catch(_){}" public/js/formular/doc.js
# ⭐ Inventar. Câte sunt în total? Care aparțin căilor de upload?
#   NU le repara pe toate — doar cele din Etapa C. Restul: RAPORTEAZĂ-LE.

grep -n "doc.js?v=\|df-api.js?v=" public/formular.html
grep -c "doc.js\|df-api.js" public/sw.js
# Dacă 0 ⇒ nu sunt în PRECACHE_ASSETS ⇒ CACHE_VERSION NEATINS. Raportează.
```

---

# ETAPA A — `INSERT ... ON CONFLICT` pe capturi (reparația de fond)

`DELETE` + `INSERT` înseamnă „înlocuiește captura din slot". Postgres face asta **atomic**, într-o
singură instrucțiune. Cursa dispare prin construcție, nu prin sincronizare.

⭐ **Ținta `ON CONFLICT` trebuie să fie EXACT expresia din index**, adică
`(form_type, form_id, slot, (COALESCE(bloc_idx, 0)))` — **nu** `bloc_idx` simplu. E un index pe
expresie; dacă ținta nu se potrivește, Postgres nu găsește constrângerea și aruncă **la execuție**,
nu la scriere, deci greșeala trece de review și cade în producție.

**Verifică definiția reală înainte de a scrie**, pe baza de test locală:

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_formulare_capturi_form_slot_bloc';
```

Înlocuiește `DELETE` + `INSERT` cu:

```js
    // #205 — DELETE+INSERT ca două interogări separate producea o cursă: două cereri
    // paralele pe același (slot, bloc) ștergeau amândouă, apoi a doua lovea indexul unic
    // cu 500. ON CONFLICT face înlocuirea atomic, deci a doua apăsare devine inofensivă.
    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot, bloc_idx)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (form_type, form_id, slot, (COALESCE(bloc_idx, 0)))
      DO UPDATE SET uploaded_by = EXCLUDED.uploaded_by,
                    filename    = EXCLUDED.filename,
                    mimetype    = EXCLUDED.mimetype,
                    size_bytes  = EXCLUDED.size_bytes,
                    data        = EXCLUDED.data,
                    created_at  = NOW()
      RETURNING id, filename, mimetype, size_bytes, slot, bloc_idx, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data, slot, blocIdx]);
```

`DELETE`-ul dispare. Comentariul #128n de deasupra (despre `bloc_idx` în cheie) **rămâne** —
explică de ce blocul face parte din cheie, ceea ce e în continuare adevărat; adaptează-l ca să
descrie `ON CONFLICT`, nu `DELETE`.

## ⛔ Ce NU se atinge

**Atașamentele** (`shared.mjs:214-228`) au alt tipar: `SELECT` de dedup, apoi `INSERT`. E și
acela o cursă (TOCTOU), dar `formulare_atasamente` **nu are index unic** — verificat, zero
rezultate. Deci acolo cursa produce un **atașament duplicat tăcut**, nu un 500.

Reparația ar cere întâi dedup-ul datelor existente, apoi un index unic — alt lot, cu migrare și
`pg_dump`. **Nu o face aici.** Raportează câte duplicate există azi:

```sql
SELECT form_type, form_id, slot, COALESCE(bloc_idx,0) AS bloc, filename, size_bytes, count(*)
  FROM formulare_atasamente WHERE deleted_at IS NULL
 GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1;
```

(Rulează doar pe baza de test — **nu pe producție**.)

---

# ETAPA B — helper pentru răspunsuri non-JSON

În `public/js/shared/df-api.js`, un helper exportat pe `DFApi`:

```js
  // #205 — un răspuns de proxy („upstream error") nu e JSON. Fără garda asta,
  // utilizatorul primește „Unexpected token 'u'" în loc de un mesaj util.
  // Același mod de eșec ca la #125 (STS: „Unexpected end of JSON input").
  async json(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      const err = new Error('Serverul nu a răspuns corect. Reîncarcă pagina și încearcă din nou.');
      err.nonJson = true;
      err.httpStatus = res.status;
      throw err;
    }
    return res.json();
  }
```

⛔ **NU schimba `res.clone().json()`-urile interne** din `df-api.js` (liniile ~111, ~135, ~163).
Alea sunt deja în `try/catch` și servesc altui scop (citirea corpului de eroare). Helper-ul e
pentru **call-site-uri**, nu pentru interiorul lui `DFApi.fetch`.

⛔ **NU migra toate call-site-urile** la `DFApi.json()` în lotul ăsta. Sunt zeci. Doar cele din
Etapa C.

---

# ETAPA C — eșecurile de upload nu se mai înghit

`public/js/formular/doc.js`, `uploadCaptura` — azi:

```js
  }catch(_){}
```

Un eșec aici înseamnă că documentul se salvează **fără captură**, iar utilizatorul nu află.

Devine: verifică `res.ok`, iar la eșec raportează vizibil, **fără să blocheze salvarea**
documentului (captura e accesorie; un upload eșuat nu trebuie să piardă restul muncii).

```js
    const res=await DFApi.fetch(`/api/formulare-capturi/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`,{
      method:'POST',
      headers:{'Content-Type':mime,'X-Filename':`captura_${ft}_${_slot}.png`},
      body:blob,
    });
    if(!res.ok){
      // #205 — înainte era catch(_){}: captura se pierdea tăcut și utilizatorul
      // credea că s-a salvat. Semnalăm, dar NU blocăm salvarea documentului.
      _capturaEsec(ft,_slot,res.status);
      return;
    }
```

`_capturaEsec` afișează un mesaj neblocant (toast / linie inline lângă zona de captură), în
tiparul deja folosit în `doc.js` pentru notificări — **nu inventa un sistem nou de notificări** și
**nu folosi `alert()`**. Textul spune ce s-a întâmplat și ce să facă: că imaginea nu s-a încărcat
și că poate reîncerca.

Idem pentru `uploadCapturaBlocuri` (`doc.js:~1447`), care oglindește aceeași cale.

⚠️ **Atenție la zgomot.** Dacă un cod de status e „normal" în fluxul actual (ex. 403 pe un
document pe care utilizatorul nu-l mai poate edita), mesajul ar apărea des și degeaba. Dacă
găsești un astfel de caz, **raportează-l înainte** și îl tratăm separat, nu-l masca la loc într-un
`catch` gol.

---

# ETAPA D — teste

## D.1 — `server/tests/db/capturi-upload-cursa.test.mjs` (nou) ⭐

1. ⭐ **Testul central**: două `POST` **în paralel** (`Promise.all`) pe același
   `(form_id, slot, bloc)`, cu imagini diferite. **Ambele întorc 200**, iar în bază rămâne
   **exact un rând**, cu conținutul uneia dintre cele două (nu un amestec).
   ⚠️ Rulează-l de mai multe ori (≥5) — o cursă care trece o dată poate pica a doua oară.
2. Înainte de reparație testul 1 trebuie să **PICE** — rulează-l pe codul vechi (stash) și
   confirmă în raport că a picat cu `duplicate key`. Un test care trece și înainte, și după, nu
   ancorează nimic.
3. Încărcare secvențială de două ori pe același slot ⇒ un rând, cu a doua imagine
   (comportamentul „înlocuiește" se păstrează).
4. Sloturi diferite (1 și 2) și blocuri diferite (0 și 1) ⇒ rânduri separate, neafectate.
5. Rânduri legacy cu `bloc_idx` NULL ⇒ tratate ca blocul 0 (`COALESCE`), fără rând nou.

## D.2 — `npm test`

Helper-ul `DFApi.json`: `content-type: text/plain` cu corp `upstream error` ⇒ aruncă cu
`nonJson = true` și **nu** aruncă `SyntaxError`; `application/json` ⇒ parsează normal.

## D.3

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real** (prim-plan sau fișierul de log al rulării),
**niciodată dintr-un sumar de fundal**. `skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.**

---

# ETAPA E — versiune, cache, commit

```bash
npm version 3.9.858 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**`?v=` ȚINTIT**, doar pe fișierele efectiv modificate (`doc.js`, `df-api.js`). ⛔ Fără `sed` în masă.
**`CACHE_VERSION`** doar dacă un fișier din `PRECACHE_ASSETS` s-a schimbat — ancora din Etapa 0
îți spune. Raportează decizia și motivul.

`git add` **explicit**. Arhivează promptul în `docs/archive/`, în același commit.

```
fix(#205): cursa la incarcarea capturilor + esecuri de upload inghitite — v3.9.858

Incident productie 14.09, Zarnesti: doua POST paralele pe acelasi
(form_id, slot, bloc) — DELETE+INSERT ca doua interogari separate faceau ca
ambele sa stearga, apoi a doua sa loveasca indexul unic cu 500. Indexul
(migrarea 107) si-a facut treaba: nicio dublura in baza. ON CONFLICT DO UPDATE
face inlocuirea atomic, deci a doua apasare devine inofensiva.

uploadCaptura se termina cu catch(_){}: ORICE esec de upload era invizibil —
documentul se salva fara captura si utilizatorul credea ca e acolo. Acum se
semnaleaza, fara sa blocheze salvarea.

DFApi.json() verifica content-type: un raspuns de proxy („upstream error") da
un mesaj util in loc de „Unexpected token 'u'". Aplicat DOAR la call-site-urile
de captura; migrarea celorlalte nu intra aici.

NU explica bannerul raportat de utilizator: 500-ul era inghitit de catch(_){},
iar la ora bannerului nu exista nicio cerere in loguri. Ramane deschis.

Atasamentele au aceeasi cursa in forma SELECT-then-INSERT, dar fara index unic
⇒ dublura tacuta, nu 500. Repararea cere dedup + index nou: alt lot, cu migrare.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**. ⭐ Inventarul `catch(_){}` din `doc.js`: câte, unde.
2. ⭐ `indexdef` real al indexului, și confirmarea că ținta `ON CONFLICT` se potrivește **exact**.
3. ⭐ Că testul D.1/1 **PICĂ pe codul vechi** (cu dovada) și trece pe cel nou.
4. De câte ori ai rulat testul de cursă și dacă a fost stabil.
5. Numărul de atașamente duplicate găsite pe baza de test (interogarea din Etapa A).
6. Ce tipar de notificare ai folosit pentru `_capturaEsec` și de ce (care e precedentul în `doc.js`).
7. Dacă ai găsit coduri de status „normale" care ar produce zgomot. (Așteptat: raportate, nu mascate.)
8. Decizia `CACHE_VERSION` + lista `?v=` modificate.
9. Numere reale `npm test` / `npm run test:db`, secvențial, cu sursa verdictului declarată.
10. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
11. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
12. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- `ON CONFLICT` pe expresia **exactă** din index, verificată cu `pg_indexes`.
- **Atașamentele: NEATINSE.** Doar măsurate și raportate.
- `res.clone().json()`-urile interne din `df-api.js`: **neatinse**.
- **Fără migrare de bază de date** în lotul ăsta.
- Nu inventa o explicație pentru bannerul „upstream error". Rămâne deschis.
- `?v=` țintit. `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
