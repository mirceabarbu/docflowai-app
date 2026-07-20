---
model_suggested: Opus 4.8
tip: DATE CANONICE — repară potriviri OPME rupte tăcut. NU e o schimbare cosmetică.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.
> **Producția tocmai a fost adusă la v3.9.682.** Pornim de acolo.

> **NO-TOUCH (doar citire):** `signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`

---

## ⛔ CITEȘTE ÎNTÂI — asta NU e o cerință de UX

Cererea a venit ca „ar fi frumos ca textul să devină majuscule la părăsirea câmpului".
**Nu e cosmetică. Repară un bug financiar tăcut.**

`server/services/opme-matcher.mjs` potrivește plățile OPME cu angajamentele pe tripletul
`(cod_angajament, indicator_angajament, cif_beneficiar)`, prin **egalitate strictă,
case-sensitive**:

```js
// opme-matcher.mjs:127-128
WHERE r->>'cod_angajament'        = $3
  AND r->>'indicator_angajament'  = $4
// opme-matcher.mjs:335
AND TRIM(cod_angajament) = $2          // doar TRIM — nicio normalizare de caz
```

**Datele OPME importate sunt cu MAJUSCULE** (confirmat de Mircea). Deci un Responsabil CAB care
tastează `sdgdsgs` în Secțiunea B produce un rând pe care motorul de potrivire **nu-l va găsi
niciodată**. `'sdgdsgs' = 'SDGDSGS'` este `false` în Postgres. Fără eroare, fără avertisment —
doar o plată care nu se leagă de niciun angajament.

**Rândurile scrise cu minuscule sunt, azi, invizibile pentru OPME.** Le reparăm.

---

## Domeniu — exact două câmpuri

| Coloană | Câmp | Acțiune |
|---|---|---|
| 1 | `cod_angajament` | ✅ `trim()` + `toUpperCase()` |
| 2 | `indicator_angajament` | ✅ `trim()` + `toUpperCase()` |
| 3 | `program` | ⛔ **NU atinge** |
| 4 | `cod_SSI` | ⛔ **NU atinge** — validat deja la #98 |
| 5–10 | sume | ⛔ **NU atinge** |

Doar în tabelul **`rows_ctrl`** (Secțiunea B — Responsabil CAB).
⛔ **NU atinge `rows_val` sau `rows_plati`** (Secțiunea A).

---

## PAS 0 — Verificări

```bash
grep -n "id: '0" server/db/index.mjs | tail -2
# Așteptat: 094_alop_state_guard, 095_df_dedup_and_unique → următorul liber: 096

grep -rn "rows_ctrl" server/routes/formulare/df.mjs | grep -iE "insert|update|SET" | head
# rows_ctrl are UN SINGUR punct de scriere (df.mjs). Confirmă și listează rutele.

grep -rn "cod_angajament" server/ --include="*.mjs" | grep -v tests | grep -E "=|ILIKE|UPPER"
# Așteptat: comparațiile case-sensitive sunt DOAR în opme-matcher.mjs (+ un ILIKE în clasa8.mjs:57,
# care e un filtru de căutare — NU-l atinge).
```

---

## PAS 1 — Helper unic (sursa de adevăr)

Fișier nou: `server/services/angajament-normalize.mjs`

```js
// Codurile de angajament sunt CANONICE cu MAJUSCULE. OPME (opme-matcher.mjs:127)
// potrivește prin egalitate strictă, case-sensitive — un cod cu minuscule
// nu se potrivește niciodată. Normalizăm la scriere, în toate căile.
export const normAngajamentCode = (v) => String(v ?? '').trim().toUpperCase();

// Normalizează un array rows_ctrl. Nu atinge alte câmpuri.
export function normalizeRowsCtrl(rows) { ... }
```

⚠️ `normalizeRowsCtrl` **păstrează toate celelalte câmpuri intacte** (`program`, `cod_SSI`,
sumele, orice cheie necunoscută). Rescrie **doar** cele două chei. Un rând fără ele rămâne
neatins. `null`/`undefined` ⇒ nu inventa `''` unde nu era nimic — păstrează comportamentul.

---

## PAS 2 — Server: normalizare la scriere

Aplică `normalizeRowsCtrl()` pe **fiecare** cale care persistă `rows_ctrl`. Le identifici la
PAS 0 — cel puțin `PUT /api/formulare-df/:id` și `POST /:id/complete`.

⚠️ **Atenție la `df.mjs:466-469`** — crearea unei revizii (R1) copiază `rows_ctrl` din revizia
precedentă și îi transformă coloanele. Normalizează și acolo, altfel o revizie a unui DF vechi
reintroduce minusculele.

**Serverul e poarta.** Frontendul se poate ocoli (API direct, extensie, tab vechi din cache).

---

## PAS 3 — Migrare `096_uppercase_angajament_codes`

Ridică la majuscule cele două chei în **toate** `rows_ctrl` existente.

Inline în `server/db/index.mjs`. **Idempotentă** (a doua rulare = no-op — `UPPER` e idempotent).

```sql
UPDATE formulare_df fd
   SET rows_ctrl = (
     SELECT jsonb_agg(
       CASE WHEN jsonb_typeof(elem) = 'object'
            THEN elem
                 || jsonb_build_object('cod_angajament',
                      UPPER(TRIM(COALESCE(elem->>'cod_angajament', ''))))
                 || jsonb_build_object('indicator_angajament',
                      UPPER(TRIM(COALESCE(elem->>'indicator_angajament', ''))))
            ELSE elem END
       ORDER BY ord
     )
     FROM jsonb_array_elements(fd.rows_ctrl) WITH ORDINALITY AS t(elem, ord)
   )
 WHERE jsonb_typeof(fd.rows_ctrl) = 'array'
   AND jsonb_array_length(fd.rows_ctrl) > 0
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(fd.rows_ctrl) e
      WHERE e->>'cod_angajament'       IS DISTINCT FROM UPPER(TRIM(COALESCE(e->>'cod_angajament',''))) 
         OR e->>'indicator_angajament' IS DISTINCT FROM UPPER(TRIM(COALESCE(e->>'indicator_angajament','')))
   );
```

⚠️ **`WITH ORDINALITY` + `ORDER BY ord` sunt OBLIGATORII.** `jsonb_agg` fără ordonare explicită
**poate reordona rândurile din tabel.** Ordinea rândurilor din Secțiunea B are semnificație
contabilă. Dacă le amesteci, ai stricat documente.

⚠️ `WHERE ... EXISTS(...)` face migrarea **selectivă** — atinge doar rândurile care chiar au
nevoie. Nu rescrie 40 de documente ca să schimbe 3.

⚠️ **NU adăuga cheile pe rânduri care nu le au.** Verifică: `elem || jsonb_build_object(...)`
**ADAUGĂ** cheia dacă lipsește. Dacă nu vrei asta (și nu vrei — ar polua rândurile goale),
condiționează cu `elem ? 'cod_angajament'`. **Decide, implementează, și explică în raport ce ai ales.**

📌 **Mircea a acceptat explicit** că asta modifică date din DF-uri deja semnate. PDF-ul semnat
cu QES rămâne neschimbat (e înghețat în semnătură) — poate apărea o diferență între ce scrie în
PDF (`sdgdsgs`) și ce arată UI-ul (`SDGDSGS`). **E o decizie asumată. Nu o pune la îndoială.**

---

## PAS 4 — Frontend: majuscule la `blur`

Inputurile pentru coloanele 1 și 2 din tabelul Secțiunii B (`rows_ctrl`).

La `blur`: `el.value = el.value.trim().toUpperCase()`.

⚠️ **NU la `input`/`keyup`** — ar muta cursorul la fiecare tastă și ar face câmpul inutilizabil.
**Doar `blur`.**

⚠️ Dacă valoarea nu se schimbă (era deja majusculă), **nu declanșa `change`/autosave degeaba**.
Compară înainte de a scrie.

⚠️ Câmpurile sunt **blocate** pentru rolurile non-CAB (Secțiunea B se completează de Responsabilul
CAB). Nu atinge logica de lock — doar adaugă handlerul de `blur`.

⚠️ Zero CSS nou. Zero `innerHTML`.

---

## PAS 5 — OPME matcher: NU-L ATINGE

⛔ **`opme-matcher.mjs` rămâne neschimbat.** Comparația strictă e **corectă** odată ce datele
sunt canonice. O comparație case-insensitive ar fi o cârjă care ascunde date neomogene.

**Datele devin canonice; potrivirea rămâne exactă.**

**Raportează** (fără să modifici): importul OPME normalizează la majuscule la scriere, sau se
bazează pe faptul că fișierele vin deja așa? Dacă se bazează pe noroc, e o gaură — **o
închidem într-un prompt separat**, nu aici.

---

## PAS 6 — Teste

**Unit** (`server/tests/unit/angajament-normalize.test.mjs`), importând din producție:
1. `'sdgdsgs'` ⇒ `'SDGDSGS'`
2. `'  aab  '` ⇒ `'AAB'` (trim + upper)
3. `'AAB'` ⇒ `'AAB'` (idempotent)
4. diacritice: `'ăîâșț'` ⇒ `'ĂÎÂȘȚ'` (verifică `toUpperCase()` pe română — **raportează rezultatul real**)
5. `null` / `undefined` / `''` ⇒ fără excepție
6. `normalizeRowsCtrl` **păstrează** `program`, `cod_SSI`, sumele și cheile necunoscute
7. `normalizeRowsCtrl` **păstrează ORDINEA** rândurilor

**DB** (`server/tests/db/uppercase-angajament.test.mjs`), Postgres real:
8. `PUT` cu `cod_angajament: 'abc'` ⇒ în bază e **`'ABC'`**
9. **Migrarea 096:** inserezi un DF cu `rows_ctrl` minuscule, rulezi migrarea, verifici majuscule
   **și ORDINEA păstrată** (3 rânduri distincte, verifici că nu s-au amestecat)
10. Migrarea e **idempotentă** — a doua rulare nu schimbă nimic
11. **Potrivire OPME end-to-end:** DF cu `cod_angajament` minuscul + linie OPME cu majuscule
    ⇒ **NU se potrivesc** înainte de normalizare; **SE POTRIVESC** după.
    **Ăsta e testul care dovedește că repari un bug, nu că schimbi o culoare.**
12. Revizia (R1) dintr-un DF cu minuscule ⇒ R1 are majuscule (`df.mjs:466`)

⛔ **Testele importă din producție.** Nu redeclara helperul. Pentru migrare, folosește
`MIGRATIONS` exportat din `db/index.mjs` (deja făcut la #97) — rulează SQL-ul real, nu o copie.

---

## PAS 7 — Versiune și cache

`package.json` → **v3.9.683**.

```bash
grep -n "formular/doc.js\|formular/core.js" public/sw.js
# La #98 s-a stabilit: NU sunt în PRECACHE_ASSETS → doar ?v=, fără CACHE_VERSION.
# CONFIRMĂ pentru fișierul pe care îl atingi efectiv.
```

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
fix(df): coduri de angajament canonice cu majuscule — repară potrivirea OPME (v3.9.683)
```

---

## RAPORT FINAL

1. Câte rute persistă `rows_ctrl`? Le-ai acoperit pe toate? (Inclusiv calea de revizie, `df.mjs:466`?)
2. **Migrarea păstrează ORDINEA rândurilor?** `WITH ORDINALITY` + `ORDER BY ord`? Testul #9 o dovedește? (Ăsta e locul unde poți strica documente contabile.)
3. Migrarea **adaugă** cheile pe rândurile care nu le au, sau doar le rescrie pe cele existente? Ce ai ales și de ce?
4. Migrarea e selectivă (`WHERE EXISTS`)? Câte rânduri ar atinge pe staging?
5. Idempotentă? Testul #10 trece?
6. **Testul #11** (potrivire OPME înainte/după) — trece? Lipește rezultatul. **Ăsta e testul care contează.**
7. Diacriticele: `'ăîâșț'.toUpperCase()` — ce dă efectiv? Vreo surpriză?
8. `blur`, nu `input`? Cursorul nu sare? Autosave nu se declanșează degeaba când valoarea era deja majusculă?
9. `opme-matcher.mjs` — **neatins**? Confirmă cu `git diff --name-only`.
10. `rows_val` / `rows_plati` — **neatinse**? Coloanele 3–10 — neatinse?
11. **PAS 5:** importul OPME normalizează la majuscule, sau se bazează pe noroc?
12. `CACHE_VERSION` — bumped sau nu, și de ce? `npm test` + `npm run test:db` separat.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **ORDINEA rândurilor din `rows_ctrl` e sacră.** `jsonb_agg` fără `ORDER BY` le poate amesteca. Are semnificație contabilă.
- ⛔ **Doar `cod_angajament` și `indicator_angajament`.** Coloanele 3–10 neatinse. `rows_val`/`rows_plati` neatinse.
- ⛔ **NU atinge `opme-matcher.mjs`.** Datele devin canonice; potrivirea rămâne exactă.
- ⛔ **NU atinge filtrul `ILIKE` din `clasa8.mjs:57`** — e o căutare, nu o potrivire.
- ⛔ **`blur`, niciodată `input`/`keyup`.**
- ⛔ **NU pune la îndoială** modificarea datelor din DF-uri semnate. Mircea a decis, în cunoștință de cauză.
- ⛔ **NU crea fișiere `.sql`.** Migrații inline, idempotente.
- ⛔ **NU redeclara logica în teste.**
- ⛔ Zonele NO-TOUCH: doar citire. **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, oprește-te și raportează.
