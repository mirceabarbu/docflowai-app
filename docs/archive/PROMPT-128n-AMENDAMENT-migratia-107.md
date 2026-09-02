# AMENDAMENT la PROMPT #128n — migrația 107 (indexul unic pe capturi)

> Se aplică PESTE promptul `PROMPT-128n-capturi-per-bloc.md`. Restul lui rămâne valabil.
> **Corecție la promptul original:** §1 declara „Migrații: ZERO". Este **GREȘIT** — am verificat
> tiparul DELETE+INSERT al rutei, dar nu indexele de pe `formulare_capturi`. Constatarea
> agentului e corectă și blocantă: fără înlocuirea indexului, al doilea bloc nici măcar nu se
> inserează (`23505`). **Migrații: UNA.** Devine Etapa A.0, înaintea a tot.

---

## A.0 — Migrația 107

### A.0.1 Verifică ancora

```bash
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -3
```
**Așteptat:** ultima e `106_formulare_binare_bloc_idx`. Dacă e alta, **OPREȘTE-TE și raportează** —
numărul se alege din ce e în fișier, nu din prompt.

### A.0.2 Adaugă, imediat după obiectul `106_...`, în același stil

```js
  {
    // #128n — indexul unic din migrația 079 (`uniq_formulare_capturi_form_slot`) impunea o
    // singură captură per (document, slot) pe TOT documentul. Cu ORD multi-furnizor asta
    // înseamnă că blocul 2 nu poate insera deloc: DELETE-ul (cheiat acum și pe bloc) nu-i
    // atinge rândul, iar INSERT-ul cade pe 23505. Cheia se RELAXEAZĂ, nu se strânge:
    // (t,id,slot) unic  ⇒  (t,id,slot,COALESCE(bloc_idx,0)) unic.
    //
    // ⛔ NU e cazul migrației 095: acolo producția avea deja duplicate și CREATE UNIQUE INDEX
    // eșua TĂCUT. Aici coliziunea e IMPOSIBILĂ prin construcție — indexul vechi garantează deja
    // unicitatea pe (t,id,slot), iar toate rândurile existente au bloc_idx NULL ⇒ COALESCE = 0.
    //
    // Singurul consumator al vechii chei e `ON CONFLICT (form_type, form_id, slot)` din backfill-ul
    // migrației 079. Pe o bază NOUĂ, 079 rulează înaintea acestei migrații ⇒ inferența își găsește
    // indexul. Pe bazele existente, 079 e deja aplicată și nu se re-rulează.
    id: '107_formulare_capturi_uniq_bloc',
    sql: `
      DROP INDEX IF EXISTS uniq_formulare_capturi_form_slot;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_formulare_capturi_form_slot_bloc
        ON formulare_capturi (form_type, form_id, slot, (COALESCE(bloc_idx, 0)));
    `
  }
```

### ⚠️ Două lucruri de respectat literal

**1. Parantezele duble în jurul lui `COALESCE`.** Într-un index multi-coloană, o coloană care e
o EXPRESIE trebuie parantezată separat: `..., slot, (COALESCE(bloc_idx, 0)))`. Fără parantezele
exterioare, riști o eroare de sintaxă la `CREATE INDEX`. Nu „simplifica" scriind
`COALESCE(bloc_idx, 0)` fără ele.

**2. Nume NOU pentru indexul nou.** `uniq_formulare_capturi_form_slot_bloc`, nu reutilizarea
numelui vechi. Motivul e diagnostic: după deploy, o singură interogare pe `pg_indexes` spune
fără ambiguitate care dintre cele două chei e live. Reutilizarea numelui ar face imposibil de
distins „migrația a rulat" de „migrația n-a rulat".

### ⚠️ De ce contează mai mult decât o migrație obișnuită

`initDbOnce()` rulează **TOATE** migrațiile într-un singur `BEGIN`/`COMMIT`. Dacă
`CREATE UNIQUE INDEX` eșuează (sintaxă, versiune PG), se face `ROLLBACK` pe tot și
**`DB_READY` nu se setează niciodată** — aplicația pornește moartă. E exact clasa incidentului
din `docs/incidents/2026-04-19-db-init-failure.md`.

Eșecul e ZGOMOTOS, nu tăcut — dar nu se descoperă în `npm test`. Singura dovadă acceptabilă că
migrația chiar se aplică e `npm run test:db` pe o instanță **efemeră, proaspătă** (rețeta PG 17
din `CLAUDE.md`), unde cele 107 migrații rulează de la zero, în ordine. ⛔ Un `test:db` pe o bază
reutilizată NU dovedește nimic despre migrația asta: e deja în `schema_migrations` și se sare.

---

## Adaos la §9.1 — cazuri de test noi în `capturi-bloc-idx.test.mjs`

Pe lângă cele 7 din promptul original:

**8.** ⭐ **Poarta migrației** — pe baza de test (proaspătă):
   - `SELECT indexname FROM pg_indexes WHERE tablename='formulare_capturi'` conține
     `uniq_formulare_capturi_form_slot_bloc`;
   - **NU** mai conține `uniq_formulare_capturi_form_slot`.
   Dacă vechiul index e încă acolo, migrația n-a rulat sau `DROP`-ul a fost sărit — iar cazul 1
   ar trece din întâmplare pe o bază veche și ar pica în producție.

**9.** ⭐ **Cheia nu s-a slăbit**: două `INSERT`-uri DIRECTE în DB (ocolind ruta) cu același
   `(form_type, form_id, slot, bloc_idx=1)` ⇒ al doilea aruncă `23505`. Împreună cu cazul 1
   (bloc 0 + bloc 1 ⇒ două rânduri), cele două prind cheia din ambele direcții: prea strictă
   și prea largă.

**10.** Rând legacy cu `bloc_idx` **NULL** + `INSERT` direct cu `bloc_idx = 0`, același
   `(form_type, form_id, slot)` ⇒ `23505`. Ăsta e motivul pentru care cheia e
   `COALESCE(bloc_idx, 0)` și nu `bloc_idx` simplu: cu coloana brută, `NULL` e distinct de
   orice în indexurile unice, deci un rând legacy și unul nou pe blocul 0 ar coexista tăcut
   pe același slot — exact bug-ul pe care îl reparăm, reintrodus pe altă ușă.

---

## Adaos la §12 — verificări de ieșire

```bash
# 9 — migrația există, o singură dată
grep -n "107_formulare_capturi_uniq_bloc" server/db/index.mjs
# Așteptat: 1 linie

# 10 — cheia veche e scoasă, cea nouă pusă
grep -n "uniq_formulare_capturi_form_slot" server/db/index.mjs
# Așteptat: 3 linii — CREATE-ul istoric din 079 (NEATINS), DROP-ul și CREATE-ul din 107

# 11 — nicio migrație ca fișier .sql
ls server/db/migrations/ | tail -3
# Așteptat: se termină la 015_*
```

---

## Adaos la §13 — RAPORT FINAL

- confirmarea că `test:db` a rulat pe o instanță **EFEMERĂ, PROASPĂTĂ** (nu pe una reutilizată),
  deci migrația 107 chiar s-a aplicat — cu comanda de creare a instanței, verbatim
- rezultatele cazurilor **8, 9 și 10**, menționate separat
- confirmarea că migrația NU conține `UPDATE`, `DELETE`, `ALTER TABLE`, `NOT NULL` sau `DEFAULT`
  — doar `DROP INDEX` + `CREATE UNIQUE INDEX`
- confirmarea că `ON CONFLICT (form_type, form_id, slot)` din migrația 079 a rămas **NEATINS**

---

## ⛔ Ce NU face amendamentul

⛔ Nu atinge migrația 079 (istoric aplicat — se modifică NICIODATĂ o migrație deja rulată).
⛔ Nu adaugă `ON CONFLICT` în ruta de upload. Cursa a doi utilizatori care încarcă simultan pe
   același `(slot, bloc)` poate da `23505` — dar **exact la fel ca azi**, indexul unic existând
   deja. Lotul nu înrăutățește nimic; o eventuală strategie de upsert e altă discuție.
⛔ Nu schimbă comportamentul „ultima captură câștigă pe slot" — doar îl restrânge la bloc.
