---
model_suggested: Opus 4.8
tip: BUG DE PRODUCȚIE — documente duplicate în evidența oficială. Trei straturi.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire):** `signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`

---

## Context — incident real, 13.07.2026

Un utilizator a dat **dublu-click** pe „Completează DF" dintr-un ALOP. Rezultat: **două
rânduri `formulare_df`**, ambele create la 11:02, ambele `revizie_nr = 0`, ambele cu același
`source_alop_id`. ALOP-ul a rămas legat de cel **gol**, în timp ce utilizatoarea a completat
și a trimis la semnare **celălalt**. ALOP-ul a stat blocat în `angajare` cu buget 0,00 RON,
deși DF-ul real era semnat de toți cei 5 semnatari.

Reparat manual în producție. **Se poate reproduce oricând.**

### Lanțul exact (verificat în cod)

1. `public/js/formular/alop.js:773` — `alopDeschideDF()` citește `alop.df_id` de pe server.
   E `NULL` ⇒ `newDocFromList()` deschide formular gol.
2. Al doilea click, înainte ca primul DF să fie salvat ⇒ citește tot `NULL` ⇒ **al doilea
   formular gol**.
3. `public/js/formular/doc.js:958` — `saveDoc()` face `POST` când `!docId`. Două POST-uri ⇒
   **două rânduri**.
4. `_alopLinkDoc()` (`alop.js:22`) cheamă `link-df` pentru fiecare. Primul câștigă —
   `alop.mjs:938` are garda `AND (df_id IS NULL OR df_id = $1)`. Al doilea primește **404**.

### De ce garda existentă NU a prins

`df.mjs:229` are deja o verificare anti-duplicat pe `nr_unic_inreg`... dar e închisă în:
```js
if (data.nr_unic_inreg) { ... }
```
La POST formularul e **gol** — utilizatorul n-a tastat încă numărul. `nr_unic_inreg` e `''`,
garda nu se execută. Numărul (40781) e introdus **mai târziu, prin PUT**, unde nu există
nicio verificare.

**Ancora corectă nu e numărul — care vine târziu — ci `source_alop_id`, prezent din prima
milisecundă** (`doc.js:60`: `source_alop_id: window._alopContext?.alopId || null`).

---

## ⛔ ORDINEA E OBLIGATORIE

**Indexul unic NU se poate crea cât timp există duplicate în bază.** Migrarea ar pica la boot ⇒
`markDbFailed()` ⇒ `DB_READY=false` ⇒ 503 pe tot. **Exact incidentul din 19.04.2026**
(`docs/incidents/2026-04-19-db-init-failure.md` — citește-l).

Deci: **PAS 1 numără → PAS 2 curăță → PAS 3 indexează.** Nu inversa.

---

## PAS 1 — Numără duplicatele (RECON, fără modificări)

Migrația trebuie să fie **auto-suficientă**: nu presupune că baza e curată. Rulează local/staging:

```sql
SELECT source_alop_id, revizie_nr, COUNT(*) AS n,
       array_agg(id ORDER BY created_at) AS df_ids,
       array_agg(status ORDER BY created_at) AS statusuri
FROM formulare_df
WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL
GROUP BY source_alop_id, revizie_nr
HAVING COUNT(*) > 1;
```

Raportează câte grupuri există pe staging. **Mircea a curățat deja singurul caz din producție**
(a șters draft-ul orfan din UI), dar migrarea trebuie să reziste oricum.

---

## PAS 2 — Migrarea `095_df_dedup_and_unique` (inline în `server/db/index.mjs`)

```bash
grep -n "id: '0" server/db/index.mjs | tail -2
# Așteptat: ultimele sunt 093_alop_state_gate și 094_alop_state_guard (din #95).
# Deci următorul id liber: 095. CONFIRMĂ înainte de a scrie.
```

Migrarea face **două lucruri, în ordine, în aceeași migrare**:

### 2a. Curățare — soft-delete duplicatele goale

Pentru fiecare grup `(source_alop_id, revizie_nr)` cu > 1 rând activ: **păstrează UNUL** și
soft-delete restul. Regula de păstrare, în ordinea asta:

1. cel cu `flow_id IS NOT NULL` (e pe flux — sacru, niciodată șters)
2. altfel, cel cu statusul cel mai avansat
   (`aprobat` > `transmis_flux` > `completed` > `pending_p2` > `returnat` > `draft`)
3. la egalitate, cel mai **vechi** (`created_at ASC`) — a fost primul legat la ALOP

⛔ **NU șterge NICIODATĂ un DF cu `flow_id IS NOT NULL`.** Dacă un grup are **două** rânduri
cu `flow_id` setat, **NU ATINGE GRUPUL** — loghează un `WARNING` și treci mai departe.
Ăla e un caz pe care nu-l putem rezolva automat. Mai bine indexul nu se creează decât să
ștergi un document semnat.

Soft-delete = `deleted_at = NOW()`. **Niciodată `DELETE`.**

### 2b. Indexul unic parțial

```sql
CREATE UNIQUE INDEX IF NOT EXISTS df_source_alop_revizie_uniq
  ON formulare_df (source_alop_id, revizie_nr)
  WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL;
```

⚠️ **`CREATE UNIQUE INDEX` eșuează dacă 2a n-a curățat tot** (ex. cazul „două cu flow_id").
Deci **înfășoară 2b într-un `DO $$ ... EXCEPTION WHEN unique_violation THEN RAISE WARNING ...`**
— migrarea trebuie să **treacă mai departe cu un avertisment**, nu să omoare boot-ul.
Un index care lipsește e o problemă. O aplicație care nu pornește e un incident.

⚠️ Verifică tipul real al `formulare_df.source_alop_id` (UUID) și `revizie_nr` (INTEGER?) cu
grep în migrații. **Nu presupune.** (`alop_instances.id` s-a dovedit UUID, nu INTEGER, la #95.)

---

## PAS 3 — Creare idempotentă pe server (poarta reală)

`server/routes/formulare/df.mjs`, în `POST /api/formulare-df`, **înainte** de `INSERT`.

Dacă `req.body.source_alop_id` e un UUID valid, caută un DF activ existent pentru
`(source_alop_id, revizie_nr)`. `revizie_nr` la creare e efectiv `0` — dar **citește din cod**
cum se stabilește, nu presupune.

Dacă **există** ⇒ **NU crea al doilea. Returnează-l pe cel existent**, cu `200` (nu `201`),
în exact același format ca la creare (`{ ok: true, document: {...} }`, cu `capabilities`
calculate). Frontendul îl va prelua ca și cum tocmai l-ar fi creat — și **exact asta vrem**:
al doilea click primește primul document, nu unul nou.

```js
// Idempotență: al doilea POST din același context ALOP (dublu-click) NU creează un
// al doilea DF — returnează documentul existent. Vezi incidentul 13.07.2026.
```

⚠️ **NU returna 409.** Un 409 ar declanșa `_handleDup409()` (`doc.js:936`) și i-ar arăta
utilizatorului o eroare roșie pentru o acțiune care, din punctul lui de vedere, a reușit.
Returnează documentul. Tăcut și corect.

⚠️ **Nu atinge garda `nr_unic_duplicat` existentă** (`df.mjs:229`). Rămâne. E complementară —
prinde un alt caz (număr introdus manual, duplicat).

⚠️ Idempotența se aplică **DOAR** când `source_alop_id` e prezent. Un DF creat în afara
contextului ALOP (dacă e posibil) nu are ancoră și își păstrează comportamentul actual.

---

## PAS 4 — Frontend: blochează al doilea click

Două locuri, ambele necesare:

### 4a. `public/js/formular/alop.js` — `alopDeschideDF()` (~linia 768)

Adaugă o **gardă de re-intrare**: dacă funcția e deja în execuție pentru acest `alopId`,
al doilea apel iese imediat. Un simplu flag la nivel de modul
(`let _dfOpenInFlight = null;`), curățat în `finally`.

Fă la fel pentru `alopDeschideORD()` — **același bug există și pentru ORD**, doar că n-a
explodat încă.

### 4b. Butonul

Găsește butonul care cheamă `alopDeschideDF` și **dezactivează-l la click**
(`disabled = true`), reactivându-l în `finally`. Vizual: folosește clasele existente
(`.df-action-btn` are deja stare `:disabled`). **Nu inventa CSS.**

⚠️ Frontendul e **confort, nu securitate.** Nu acoperă două taburi, două dispozitive, sau un
refresh la momentul greșit. **Poarta reală e PAS 3 (server) + PAS 2b (index).** Dacă ai timp
limitat, ordinea de importanță e: server > index > frontend.

---

## PAS 5 — Teste DB

Fișier nou: `server/tests/db/df-dedup-idempotent.test.mjs`. **Postgres real.**

1. **Idempotență:** două `POST /api/formulare-df` consecutive cu același `source_alop_id`
   ⇒ **UN SINGUR** rând în `formulare_df`; al doilea răspuns returnează **același `id`**.
2. **Concurență (testul care contează):** două POST-uri **în paralel** (`Promise.all`) cu
   același `source_alop_id` ⇒ tot **un singur** rând. Ăsta exercită indexul unic, nu doar
   verificarea din aplicație — un `SELECT`-apoi-`INSERT` fără index poate pierde cursa.
   ⚠️ Al doilea INSERT va da `unique_violation` — **prinde-o și returnează documentul existent**,
   nu 500. Asta trebuie implementat în PAS 3 (try/catch pe `23505`).
3. **Fără `source_alop_id`** ⇒ comportament neschimbat, se creează normal.
4. **Revizii:** același `source_alop_id`, `revizie_nr` **diferit** ⇒ **DOUĂ** rânduri permise.
   (R1 e o revizie legitimă a aceluiași ALOP — **nu o bloca!**)
5. **Migrarea 095:** creează 2 duplicate goale, rulează migrarea, verifică că unul singur
   rămâne activ, iar cel cu `flow_id` (dacă există) **supraviețuiește întotdeauna**.
6. **Cazul intratabil:** 2 rânduri, **ambele** cu `flow_id` ⇒ migrarea **nu le atinge**,
   nu crapă, doar avertizează. Aplicația pornește.

⛔ **Testele importă din producție.** Nu redeclara logica.

---

## PAS 6 — Versiune

`package.json` → **v3.9.681**.
`public/js/formular/alop.js` — verifică dacă e în `PRECACHE_ASSETS` (`grep alop.js public/sw.js`).
- **Dacă DA** ⇒ bump `CACHE_VERSION` (v289 → v290) + `?v=3.9.681` în HTML-urile care-l încarcă.
- **Dacă NU** ⇒ doar `?v=3.9.681`. Raportează ce ai găsit.

```bash
npm run check
npm test
npm run test:db      # EXPLICIT — npm test NU acoperă suita DB
```

Commit:
```
fix(df): prevenire DF duplicat din ALOP — idempotență server + index unic + gardă UI (v3.9.681)
```

---

## RAPORT FINAL

1. PAS 1 — câte grupuri duplicate pe staging? Vreunul cu 2× `flow_id` (cazul intratabil)?
2. Ce id de migrare ai folosit? (Așteptat: 095 — confirmă că 093/094 din #95 sunt acolo.)
3. Tipurile reale ale `source_alop_id` și `revizie_nr` — verificate cu grep, nu presupuse?
4. Migrarea 2b e înfășurată în `EXCEPTION WHEN unique_violation → RAISE WARNING`? **Boot-ul supraviețuiește dacă indexul nu se poate crea?** Confirmă — ăsta e punctul unde poți provoca un 19-aprilie.
5. Al doilea POST returnează **200 + documentul existent**, nu 409? Confirmă (409 ar arăta eroare roșie utilizatorului).
6. Ai prins `unique_violation` (`23505`) în handler și returnezi documentul existent, nu 500?
7. Testul de **concurență** (`Promise.all`) — trece? Un singur rând?
8. Testul cu `revizie_nr` diferit — **două** rânduri permise? (R1 nu trebuie blocat!)
9. Garda `nr_unic_duplicat` existentă (`df.mjs:229`) — **neatinsă**?
10. `alopDeschideORD()` — a primit și el garda de re-intrare?
11. `alop.js` e în `PRECACHE_ASSETS`? `CACHE_VERSION` bumped sau nu — și de ce?
12. `npm test` **și** `npm run test:db` — raportate separat.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **NU șterge NICIODATĂ un DF cu `flow_id IS NOT NULL`.** E pe flux de semnare.
- ⛔ **NU folosi `DELETE`.** Doar soft-delete (`deleted_at = NOW()`).
- ⛔ **NU lăsa migrarea să omoare boot-ul** dacă indexul nu se poate crea. `RAISE WARNING`, mergi mai departe.
- ⛔ **NU bloca revizii legitime** — același `source_alop_id` cu `revizie_nr` diferit e CORECT.
- ⛔ **NU returna 409** la al doilea POST. Returnează documentul.
- ⛔ **NU atinge garda `nr_unic_duplicat`** existentă.
- ⛔ **NU crea fișiere `.sql` noi.** Migrații inline, idempotente.
- ⛔ **NU presupune tipuri.** Verifică cu grep. (`alop_instances.id` era UUID, nu INTEGER.)
- ⛔ Zonele NO-TOUCH: doar citire. **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, oprește-te și raportează.
