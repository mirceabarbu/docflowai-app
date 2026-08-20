# PROMPT #128b — fundația de date pentru ORD multi-bloc (migrație fără mutare de date + modul pur)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 · **Target versiune:** `v3.9.762` (de la 3.9.761)
> ⚠️ 760 și 761 au fost consumate de #129 (limita OPME) și #130 (butonul CAB), ambele deja în
> producție. **Citește versiunea curentă din `package.json` înainte de bump** — dacă nu e 3.9.761,
> oprește-te și raportează.
**Fișiere din `public/`:** ZERO ⇒ fără `CACHE_VERSION`, fără `?v=`
**Migrație:** UNA, inline, **fără mutare de date**
**Consumatori noi:** ⛔ **ZERO** — vezi §5, e o poartă obligatorie

---

## 1. Contextul și decizia

Reconul `docs/audits/ORD-128-RECON-2026-08.md` a stabilit varianta de model, iar Mircea a
confirmat cele trei decizii:

1. **Varianta (A)** — `rows` rămâne o listă **PLATĂ**; fiecare rând primește o cheie `bloc_idx`;
   antetul per bloc trece într-o coloană nouă `blocuri JSONB`. Motivul decisiv: toate cele ~15
   agregări `SUM(...)` peste `rows` continuă să funcționeze **neschimbate**. Variantele cu rânduri
   imbricate le-ar rupe pe toate **TĂCUT** (ar număra doar primul bloc) — clasa de bug de la #115.
2. **UN SINGUR DF per ORD** — toate blocurile trimit la același `df_id`. Formularul MF ar permite
   DF-uri diferite per bloc, dar asta ar dărâma modelul ALOP↔DF↔ORD, iar cazul real al primăriei
   e „același DF, mai mulți furnizori, în același ALOP".
3. **Migrație FĂRĂ backfill** — reconul propunea popularea unui bloc „legacy" din coloanele plate;
   asta ar fi mutare de date și ar cere `pg_dump`, care nu e disponibil pe stația curentă.
   În loc: coloana rămâne `NULL` pe toate rândurile existente, iar **`NULL` se interpretează la
   CITIRE ca „un singur bloc, construit din coloanele plate"**. Zero date mutate, reversibil
   instantaneu.

Promptul ăsta livrează DOAR fundația: coloana + un modul PUR de interpretare + teste.
Nicio rută nu îl folosește încă. Cablarea vine la #128c.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ orice fișier din `public/`
⛔ `formulare_df` — DF-ul e mono-bloc în modelul oficial MF și **nu se atinge în tot șantierul #128**
⛔ `server/routes/formulare/ord.mjs`, `services/formular-shared.mjs`, `routes/alop.mjs`,
   `services/clasa8.mjs`, `services/opme-matcher.mjs` — toate vin la #128c/#128d
⛔ Nu adăuga niciun index. Nu adăuga `NOT NULL`. Nu adăuga `DEFAULT`.
⛔ Zero refactorizări în trecere.

---

## 3. Etapa A — migrația inline

### A.1 Verifică ancora și numărul

```bash
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -5
```

**Așteptat:** ultima e `104_alop_clear_dead_ord_pointers`. Dacă e alta, **OPREȘTE-TE și
raportează** — numărul următor se alege din ce e în fișier, nu din prompt.

Convenția confirmată: migrațiile ca fișiere `.sql` se opresc la `015`; tot ce urmează sunt obiecte
`{ id, sql }` inline în `server/db/index.mjs`. ⛔ NU crea niciun fișier în `server/db/migrations/`.

### A.2 Adaugă, imediat după obiectul `104_...`, în același stil

```js
  {
    // #128b — fundația ORD multi-bloc (multi-furnizor / multi-cont), varianta (A) din
    // docs/audits/ORD-128-RECON-2026-08.md.
    // `blocuri` = array de anteturi de bloc (beneficiar/cif/iban/banca/documente/inf plată).
    // Rândurile din `rows` rămân o listă PLATĂ; apartenența la bloc se marchează cu cheia
    // `bloc_idx` PE RÂND (fără schimbare de schemă — `rows` e deja JSONB).
    // ⚠️ FĂRĂ BACKFILL, DELIBERAT: rândurile existente rămân cu `blocuri = NULL`, iar NULL se
    // interpretează la CITIRE ca „un singur bloc, derivat din coloanele plate" (vezi
    // server/services/ord-blocuri.mjs). Zero date mutate ⇒ migrația e reversibilă instantaneu
    // și nu depinde de un backup pg_dump.
    // `formulare_ord` e creată în bootstrap-ul inline (index.mjs ~939), deci NU are nevoie de
    // garda `IF NOT EXISTS (information_schema.tables)` folosită la migrațiile pe tabele V4-only.
    id: '105_formulare_ord_blocuri',
    sql: `
      ALTER TABLE formulare_ord ADD COLUMN IF NOT EXISTS blocuri JSONB;
    `
  },
```

⛔ Atât. Fără index, fără `DEFAULT '[]'`, fără `NOT NULL`, fără `UPDATE`. Un `DEFAULT` ar rescrie
semantica „NULL = legacy" pe care se sprijină tot restul.

---

## 4. Etapa B — modulul pur `server/services/ord-blocuri.mjs`

Fișier NOU. **Funcții pure**: fără `pool`, fără `import` din rute, fără efecte secundare.

Numele cheilor dintr-un bloc trebuie să fie **IDENTICE** cu cele produse azi de
`colO().docFd` în `public/js/formular/core.js` (~424), care la rândul lor sunt numele atributelor
din `ordnt_v0.xsd`. ⛔ Nu inventa nume noi. Verifică-le pe cod înainte să scrii:

```bash
grep -n "docFd:{" -A 5 public/js/formular/core.js
```

Cheile așteptate: `nr_unic_inreg`, `beneficiar`, `documente_justificative`, `iban_beneficiar`,
`cif_beneficiar`, `banca_beneficiar`, `inf_pv_plata`, `inf_pv_plata1`.
(`rowTfd` NU intră în bloc — rândurile rămân în `rows`, plat.)

Exportă exact patru funcții:

- **`blocuriDinOrd(ord)`** → `Array` normalizat, **niciodată gol**.
  - dacă `ord.blocuri` e un array cu ≥ 1 element → îl întoarce, garantând că fiecare element are
    un `bloc_idx` numeric (îl completează cu indexul din array dacă lipsește);
  - altfel (NULL, `[]`, sau tip neașteptat) → întoarce **un singur bloc** cu `bloc_idx: 0`,
    construit din coloanele plate ale ORD-ului. Ăsta e contractul „NULL = legacy".
- **`randuriBloc(rows, blocIdx)`** → rândurile care aparțin blocului dat.
  ⚠️ Un rând **fără** `bloc_idx` (sau cu `null`/`undefined`) aparține blocului **0** — toate
  rândurile din producție sunt în situația asta azi.
- **`randuriPeBlocuri(rows, nrBlocuri)`** → array de array-uri, indexat pe bloc; util pentru
  corelarea pozițională per bloc de la #128c.
- **`oglindaBloc1(blocuri)`** → obiectul de coloane plate care trebuie scris ca **oglindă** a
  blocului 1 (aceleași 8 chei). Va deveni la #128c **singurul** loc din care se scriu coloanele
  plate.

Pune în capul fișierului un comentariu care spune explicit regula de mai jos, fiindcă e cea mai
importantă decizie din tot șantierul:

> Coloanele plate `beneficiar` / `cif_beneficiar` / `iban_beneficiar` / `banca_beneficiar` /
> `documente_justificative` / `inf_pv_plata` / `inf_pv_plata1` / `nr_unic_inreg` de pe
> `formulare_ord` devin, începând cu #128c, o **OGLINDĂ derivată din blocul 1** — scrisă
> într-un singur loc (`oglindaBloc1`) și **niciodată citită** de vreo agregare sau potrivire.
> Sursa de adevăr e `blocuri[]`. Motivul: DocFlowAI a plătit deja de două ori pentru un adevăr
> ținut în două locuri (`orgId` coloană + JSONB pe `flows`; `df.flow_id` față de
> `alop.df_flow_id`, care a produs divergența din 12.08.2026). `opme-matcher.mjs` cheiază azi
> pe coloana plată `cif_beneficiar` — dacă rămâne acolo după ce apar blocuri multiple, potrivirea
> plăților se face pe furnizorul greșit, TĂCUT.

---

## 5. ⛔ POARTA — zero consumatori

Modulul rămâne **DELIBERAT neimportat** de orice cod de producție, exact ca `pagin.js` la PAGIN-1
și `concurrency-gate.mjs` la #107. Verifică:

```bash
grep -rn "ord-blocuri" server/ --include=*.mjs | grep -v "server/tests/" | grep -v "server/services/ord-blocuri.mjs"
# Așteptat: 0 rezultate
```

Dacă ai fost tentat să cablezi ceva „ca să aibă sens", **nu o face** — cablarea e #128c și trebuie
să poată fi revertită independent de fundație.

---

## 6. Etapa C — teste

**C.1 Unitare** — `server/tests/unit/ord-blocuri.test.mjs`, importând din producție (⛔ nu
redeclara logica):

1. `blocuri` NULL → un singur bloc, `bloc_idx: 0`, cu valorile din coloanele plate;
2. `blocuri` `[]` → idem (array gol tratat ca legacy, nu ca „zero blocuri");
3. `blocuri` cu 2 elemente → ambele întoarse, în ordine, cu `bloc_idx` 0 și 1;
4. `blocuri` cu elemente fără `bloc_idx` → completat din poziție;
5. `randuriBloc(rows, 0)` include rândurile **fără** `bloc_idx` (cazul producției de azi);
6. `randuriBloc(rows, 1)` întoarce doar rândurile marcate explicit cu 1;
7. `randuriPeBlocuri` cu rânduri amestecate → distribuție corectă, fără pierderi
   (suma lungimilor = lungimea intrării);
8. `oglindaBloc1` întoarce exact cele 8 chei ale blocului 1, și un obiect cu valori goale (nu
   `undefined`) dacă lista de blocuri e goală;
9. **caz negativ:** un `ord` fără nicio coloană plată completată → tot un bloc, cu valori goale,
   nu excepție.

**C.2 Schemă** — un test DB (oglindește `server/tests/db/organizations-schema.test.mjs`) care
verifică: coloana `blocuri` există pe `formulare_ord`, e `jsonb`, e **nullable**, și un `INSERT`
minimal NU o populează (rămâne `NULL`). Ăsta e testul care apără decizia „fără backfill".

---

## 7. Etapa D — rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed" — fără Docker, rețeta cu instanță PG 17 efemeră din `CLAUDE.md`.
`test:db` e obligatoriu aici: e singurul care chiar rulează migrația nouă.

Apoi: bump `package.json` → `3.9.762`; commit pe `develop` cu
`feat(#128b): fundație ORD multi-bloc — coloana blocuri (fără backfill) + modul pur ord-blocuri`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -n "105_formulare_ord_blocuri" server/db/index.mjs
# Așteptat: exact 1 linie

grep -c "ALTER TABLE formulare_ord ADD COLUMN IF NOT EXISTS blocuri" server/db/index.mjs
# Așteptat: 1

grep -rn "DEFAULT" server/db/index.mjs | grep "blocuri JSONB"
# Așteptat: 0 rezultate — coloana NU are DEFAULT

ls server/db/migrations/ | tail -3
# Așteptat: se termină la 015_* — NU s-a creat niciun fișier .sql nou

grep -rn "ord-blocuri" server/ --include=*.mjs | grep -v "server/tests/" | grep -v "server/services/ord-blocuri.mjs"
# Așteptat: 0 rezultate (poarta „zero consumatori")

git status --short
# Așteptat: package.json, server/db/index.mjs, server/services/ord-blocuri.mjs (nou),
#           cele două fișiere de test (noi). ⚠️ Working tree-ul are ~50 de fișiere netracked
#           din sesiuni anterioare — ignoră-le și CONFIRMĂ că ai stage-uit doar căile de mai sus.
```

> Notă de proces: folosim `git status --short`, nu `git diff --stat` — `git diff` nu vede
> fișierele netracked, iar lotul ăsta adaugă trei.

---

## 9. RAPORT FINAL

- commit hash + intervalul de push
- `npm test`: N fișiere / M teste · `npm run test:db`: **PASSED REAL** sau SKIPPED
- ieșirea celor 6 verificări, verbatim
- confirmarea explicită că migrația **nu conține niciun `UPDATE`, `DEFAULT`, `NOT NULL` sau index**
- confirmarea că poarta „zero consumatori" e respectată
- orice abatere, cu motivul. Dacă găsești o eroare în promptul ăsta — inclusiv un nume de cheie
  care nu se potrivește cu `colO().docFd` — **spune-o, nu o repara tăcut**.
