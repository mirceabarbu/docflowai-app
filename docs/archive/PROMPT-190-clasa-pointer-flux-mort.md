---
prompt: 190
titlu: "Detecția #120 capătă clasa E — document care pointează spre alt flux decât cel semnat"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.844
versiune_tinta: v3.9.845
migratii: NU
fisiere_din_public: DA  (`public/js/admin/audit.js` ⇒ e în PRECACHE_ASSETS ⇒ bump `CACHE_VERSION`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO — modulul e strict de detecție
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## ⚠️ POARTĂ DE PORNIRE — nu începe fără răspunsul lui Mircea

Acest lot ajunge pe cardul „Consistență document↔flux" din dashboard, al cărui întreg rost
e că **zero e normalul**. Un card care arată permanent un număr diferit de zero devine
ignorat în două săptămâni și n-a mai prins niciun incident.

Mircea rulează pe producție **PASUL 5 din `SQL-190b-reparatie-df-45748.sql`** (aceeași
formă de predicat ca lotul ăsta) și îți dă numărul de rânduri.

- **0–5 rânduri** ⇒ pornești.
- **peste 5 rânduri** ⇒ **OPREȘTE-TE și raportează**. Înseamnă că predicatul prinde și
  situații legitime pe care nu le cunoaștem, iar îngustarea lui se decide înainte de cod,
  nu după deploy.

---

## Contextul — ce a scăpat printre clase

Incidentul **DF 45748** (01.09.2026, dosar ALOP „Produse de curățenie"):

- 08:44:02 se creează `PZ_01BA62F89A`; `crud.mjs` pre-setează `formulare_df.flow_id` pe el.
- 08:44:43 se creează `PZ_3E88B4147C` (a doua lansare). Garda #120 face exact ce trebuie:
  primul flux e încă **viu**, deci pointerul **NU** se mută.
- 08:46:21 inițiatorul anulează `PZ_01BA62F89A` — pe cel greșit.
- Semnarea merge cap-coadă pe `PZ_3E88B4147C`, 5/5, `completed=true`.
- `cancel` (`lifecycle.mjs:585`) resetează DF-ul doar când `status='transmis_flux'`; aici era
  `completed` ⇒ 0 rânduri. Iar `formulare_df.flow_id` nu se atinge niciodată la anulare
  (deliberat — proveniență).

Rezultat: documentul rămâne agățat de un flux ANULAT, iar `docAprobatSql` cheiază pe
pointerul documentului ⇒ DF „Completat", dosar blocat în `angajare`, deși artefactul QES
există. Reparat manual prin `SQL-190b`.

**Ce lipsește nu e prevenția.** Recurența e închisă din 02.09 de poarta de lansare #170
(`crud.mjs:135`): un document nu mai poate primi un al doilea flux viu. Lipsește
**vizibilitatea**: cele patru clase din `flow-link-audit.mjs` nu prind forma asta —

- clasa **A** (`doc_fara_flux`) cere `d.flow_id IS NULL`; aici pointerul e NON-NULL, doar greșit;
- clasa **B** cere `alop.{df,ord}_flow_id IS NULL`; aici era setat (pe un al treilea flux, tot anulat);
- clasa **C** cere `df_id`/`ord_id` NULL; aici `df_id` era corect;
- clasa **D** cere ≥2 fluxuri **vii**; aici doar unul mai era viu.

Cardul a arătat **0** în tot acest timp. Lotul adaugă clasa care lipsea.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                       # Așteptat: 3.9.844
grep -n "CLASS_KEYS" server/services/flow-link-audit.mjs
grep -c "validSignedFlowSql" server/services/flow-link-audit.mjs
grep -n "CACHE_VERSION" public/sw.js                              # Așteptat: docflowai-v304
grep -n "js/admin/audit.js" public/sw.js                          # Așteptat: e în PRECACHE_ASSETS
grep -o "audit\.js?v=[0-9.]*" public/*.html                       # Așteptat: 3.9.834
grep -rn "UPDATE\|INSERT\|DELETE" server/services/flow-link-audit.mjs   # Așteptat: 0
```

Citește apoi integral `server/services/flow-link-audit.mjs` și
`server/services/flow-provenance.mjs`. Nu scrie nicio linie până nu poți răspunde:
**ce întoarce `validSignedFlowSql` când fluxul nu are deloc cheia `completed` în `data`?**

---

## ETAPA A — clasa nouă în `server/services/flow-link-audit.mjs`

### A.1 — cheia clasei

`old_str` (unic):
```js
const CLASS_KEYS = ['doc_fara_flux', 'alop_fara_flux', 'alop_fara_document', 'fluxuri_paralele'];
```
`new_str`:
```js
const CLASS_KEYS = ['doc_fara_flux', 'alop_fara_flux', 'alop_fara_document', 'fluxuri_paralele', 'pointer_alt_flux'];
```

### A.2 — cei doi detectori (DF + ORD)

Se adaugă **după** ultimul detector al clasei D. `old_str` trebuie să includă `];` ca să fie
unic — `HAVING COUNT(*) >= 2` apare de două ori în fișier:

```js
       GROUP BY m.doc_id
      HAVING COUNT(*) >= 2` },
  ];
```

`new_str` = același text, cu blocul de mai jos inserat înaintea lui `];`:

```js
    // ── E — pointer_alt_flux ─────────────────────────────────────────────────
    // Documentul are flow_id NON-NULL, dar pointerul NU e pe un flux valid semnat,
    // în timp ce UN ALT flux valid semnat îl revendică prin data->'meta'. Adică
    // artefactul QES există, iar documentul arată spre altceva. (DF 45748, 01.09.2026:
    // dublă lansare, anulat fluxul pe care stătea pointerul, semnat pe celălalt.)
    //
    // ⚠️ `IS NOT TRUE`, NU `NOT (…)`: un flux fără cheia `completed` în `data` face
    //    conjuncția NULL, iar `NOT NULL` = NULL ⇒ rândul ar dispărea TĂCUT. Aici
    //    „nu pot dovedi că pointerul e valid semnat" trebuie să însemne „îl raportez".
    //
    // ⛔ Ce NU intră, deliberat: un document care pointează spre un flux anulat FĂRĂ
    //    să existe un flux semnat care să-l revendice. Aceea e starea NORMALĂ după
    //    orice anulare (pointerul rămâne ca proveniență) — sute de cazuri în producție,
    //    iar cardul n-ar mai ajunge niciodată la 0.
    { clasa: 'pointer_alt_flux', sql: `
      SELECT 'pointer_alt_flux'::text AS clasa, 'df'::text AS tip, d.id::text AS doc_id,
             d.nr_unic_inreg AS doc_nr, NULL::text AS alop_id, fv.id AS flux,
             'DF pointează spre un flux care nu e valid semnat, dar fluxul semnat îl revendică prin meta.dfId'::text AS detaliu
        FROM formulare_df d
        JOIN flows fm ON fm.id = d.flow_id
        JOIN flows fv ON fv.data->'meta'->>'dfId' = d.id::text AND fv.id <> d.flow_id
       WHERE d.deleted_at IS NULL AND d.flow_id IS NOT NULL
         AND (${validSignedFlowSql('fm')}) IS NOT TRUE
         AND ${validSignedFlowSql('fv')}${orgCond('d')}` },
    { clasa: 'pointer_alt_flux', sql: `
      SELECT 'pointer_alt_flux'::text AS clasa, 'ord'::text AS tip, d.id::text AS doc_id,
             d.nr_ordonant_pl AS doc_nr, NULL::text AS alop_id, fv.id AS flux,
             'ORD pointează spre un flux care nu e valid semnat, dar fluxul semnat îl revendică prin meta.ordId'::text AS detaliu
        FROM formulare_ord d
        JOIN flows fm ON fm.id = d.flow_id
        JOIN flows fv ON fv.data->'meta'->>'ordId' = d.id::text AND fv.id <> d.flow_id
       WHERE d.deleted_at IS NULL AND d.flow_id IS NOT NULL
         AND (${validSignedFlowSql('fm')}) IS NOT TRUE
         AND ${validSignedFlowSql('fv')}${orgCond('d')}` },
```

⛔ **Nu redefini predicatul local.** `validSignedFlowSql` se importă deja din
`flow-provenance.mjs` (sursă unică, test anti-drift în `tests/unit/flow-provenance.test.mjs`).
Parantezele din jurul primului apel sunt obligatorii: fragmentul e o conjuncție fără paranteze
proprii, iar `IS NOT TRUE` s-ar lipi altfel doar de ultimul termen.

⛔ **Nu atinge** niciunul dintre cei opt detectori existenți, bucla de numărare, `lim`,
sau semnătura funcției.

### A.3 — docblock

Adaugă la docblock-ul fișierului o singură frază: clasa E acoperă pointerul greșit
(non-NULL), complementara clasei A, care acoperă pointerul lipsă.

---

## ETAPA B — eticheta pe card (`public/js/admin/audit.js`)

Fără etichetă, clasa intră în `total` și apare în drawer cu cheia tehnică. Două locuri:

1. rezumatul de pe card — după linia `fluxuri_paralele`:
```js
                if (_bc.pointer_alt_flux)  _parts.push('pointer greșit: ' + _bc.pointer_alt_flux);
```
2. `CLASS_LABEL` din `showFlowLinkDivergences` — după linia `fluxuri_paralele:`:
```js
        pointer_alt_flux:   'Document legat de alt flux decât cel semnat',
```

⛔ Nimic altceva în `audit.js`. Fără „îmbunătățiri" pe drum.

---

## ETAPA C — teste

Extinde **`server/tests/db/flow-link-audit.test.mjs`** (nu crea fișier nou — pool-ul e
partajat, iar `pool.end()` se face o singură dată, în ultimul `describe`). Cazuri, pe tiparul
celor existente:

1. ⭐ **Pozitiv (DF 45748 reprodus):** DF cu `flow_id` = flux ANULAT + un al doilea flux
   valid semnat care-l revendică prin `meta.dfId` ⇒ **detectat** ca `pointer_alt_flux`.
2. ⭐⭐ **Negativ CRUCIAL:** DF cu `flow_id` = flux ANULAT și **niciun** flux semnat care-l
   revendică ⇒ **NU** e detectat. Ăsta e testul care apără cardul: dacă pică, clasa raportează
   starea normală de după orice anulare și cardul devine zgomot.
3. **Negativ:** DF cu `flow_id` pe un flux valid semnat (starea sănătoasă) ⇒ nedetectat,
   chiar dacă mai există un flux vechi anulat care revendică documentul.
4. **Negativ:** fluxul revendicator e ANULAT dar păstrează `completed=true`
   (`PZ_8C34C4E842`) ⇒ nedetectat. Reia fixtura din cazul (2) al clasei A.
5. **Pointer pe flux fără cheia `completed`** (status `active`, `data` fără `completed`) +
   flux semnat care revendică ⇒ **detectat**. Testul care apără `IS NOT TRUE` față de `NOT (…)`.
6. **ORD, simetric** cazului 1.
7. **Disjuncție față de clasa A:** pe fixtura clasei A (doc cu `flow_id` NULL), `byClass`
   arată clasa A incrementată și `pointer_alt_flux` = 0 — un document nu poate apărea în ambele.
8. **`orgId` respectat** — divergența din org B nu apare la interogarea pe org A.

```bash
npm test
npm run test:db
```

⚠️ **Secvențial, niciodată în paralel** (a produs deja de trei ori eșecuri false prin timeout).
Confirmă în raport că le-ai rulat așa. Test preexistent care pică ⇒ **raportează ÎNAINTE**
de a-l modifica.

---

## ETAPA D — versiune, cache, commit

```bash
npm version 3.9.845 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
```

- `CACHE_VERSION` în `public/sw.js`: `docflowai-v304` → `docflowai-v305`
  (`/js/admin/audit.js` **este** în `PRECACHE_ASSETS` — verifică, nu presupune).
- `?v=` **țintit** doar pe `audit.js` în `admin.html` (azi `3.9.834` — drift intenționat;
  citește valoarea din fișier, nu din `package.json`):
  ```bash
  sed -i -E "s#(audit\.js\?v=)[0-9.]+#\13.9.845#g" public/admin.html
  grep -n "audit.js?v=" public/admin.html
  ```
  ⚠️ După orice `sed` pe HTML, verifică linia atinsă cu `grep`: un `?v=` corupt nu pică
  niciun test și ajunge direct în producție cu pagina moartă. Grupul de captură e `\1`,
  **nu** `\g<1>`.

```bash
git status --short
```
⚠️ Working tree-ul are fișiere netrackate din sesiuni vechi (prompturi, SQL-uri, PDF-uri cu
date reale). `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**
Confirmă în raport ce ai stage-uit.

```
feat(#190): detectia document<->flux capata clasa "pointer pe alt flux" — v3.9.845

Cele patru clase existente cer un pointer LIPSA (flow_id/df_id/ord_id NULL) sau
doua fluxuri vii. DF 45748 a stat trei zile cu pointerul pe un flux ANULAT, cu
artefactul QES pe alt flux, iar cardul a aratat 0.

Clasa E acopera exact forma asta: pointer non-NULL care nu e pe un flux valid
semnat, in timp ce alt flux valid semnat revendica documentul prin data->'meta'.
Predicatul e importat din flow-provenance.mjs, nu rescris. `IS NOT TRUE`, nu
`NOT (...)`: un flux fara cheia `completed` produce NULL si rândul ar disparea tacit.

Starea normala de dupa o anulare (pointer pe flux anulat, fara flux semnat care
sa revendice) ramane NEraportata — un test dedicat o apara.

Zero scrieri: modulul detecteaza, decizia ramane a omului.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE.
2. ⭐ Ce întoarce `validSignedFlowSql` pe un flux fără cheia `completed`, și de ce
   `IS NOT TRUE` e forma corectă.
3. Confirmarea că `flow-link-audit.mjs` are în continuare **zero** `UPDATE/INSERT/DELETE`.
4. Rezultatul fiecărui caz din Etapa C, în special **1, 2, 5 și 7**.
5. `CACHE_VERSION` și `?v=` — valorile de dinainte și de după, cu `grep`-ul de verificare.
6. Numerele reale `npm test` / `npm run test:db`, rulate **secvențial**.
7. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
8. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
9. Constatări colaterale. În special: mai există în `flow-link-audit.mjs` vreo clasă al cărei
   predicat presupune un pointer NULL acolo unde forma reală de rupere e un pointer greșit?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. **Zero scrieri în baza de date** — modulul rămâne pur de detecție.
- ⛔ Nicio reparare automată a pointerilor. Decizia #120(b) rămâne în vigoare: un document
  semnat nu se re-leagă tăcut pe baza unei euristici.
- ⛔ `validSignedFlowSql` **nu** se redefinește local și **nu** se modifică în `flow-provenance.mjs`.
- ⛔ Cei opt detectori existenți, bucla de numărare și semnătura funcției rămân **neatinși**.
- ⛔ În `audit.js` se ating **exact** cele două locuri din Etapa B.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
