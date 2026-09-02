# PROMPT #128l — URGENT: rândurile blocului 2 se PIERD la finalizarea P2

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus — pierdere de date pe document financiar
**Target versiune:** `v3.9.772` (de la 3.9.771 — **citește `package.json`**) · **Migrații:** ZERO

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**. ⛔ Fără here-string.

---

## 1. Bugul — confirmat pe cod, reprodus pe staging

Mircea a creat un ORD cu doi furnizori (blocul 1 = 3.000 lei, blocul 2 = 435 lei, total 3.435).
După finalizare, **tabelul blocului 2 e gol** iar ALOP-ul arată 3.000.

**Cauza rădăcină:** `completeAsP2` (`public/js/formular/doc.js:1726`):

```js
const body = ft==='ordnt' ? {rows:getOR()} : collectDfP2Db();
```

`getOR()` (`core.js:168`) citește **exclusiv `#o-tbody`**, adică blocul 0 — prin design; comentariul
de la `core.js:166` o declară explicit „rămâne pe blocul 0, folosită de call-site-uri nemigrate".
Acesta e call-site-ul care a rămas nemigrat.

`completeFormular` (`server/services/formular-shared.mjs:447`) scrie `data.rows` din corpul cererii,
**înlocuind întregul array** ⇒ rândurile blocurilor 2+ dispar definitiv.

Beneficiarul blocului 2 supraviețuiește pentru că trăiește în coloana `blocuri`, pe care ruta
`/complete` nu o atinge — de aici simptomul „bloc completat, tabel gol".

**ALOP-ul care arată 3.000 NU e un bug separat** — e consecința pierderii. ⛔ Nu adăuga nicio
agregare „pe blocuri" în acest lot; suma peste `rows` e corectă prin construcție (varianta A,
#128b).

---

## 2. Cele două găuri din aceeași familie, amânate greșit la #128k

Reconul #128k le-a raportat, iar eu le-am amânat — greșit, sunt același defect:

- **`doc.js` — pre-checkul `missingSuma` din `showP2Modal`**: calculează doar pe `#o-tbody`. Cu doi
  furnizori, dacă blocul 0 n-are col.4 dar blocul 1 are, utilizatorul e blocat cu un `alert()`
  generic, deși `_validateOrd` (per bloc, #128i) ar fi trecut. **Fals-blocaj.**
- **`doc.js` — `validateSecB`**: garda „cel puțin un rând cu cod angajament" + col.5 ≥ 0 citește doar
  `#o-tbody` ⇒ un bloc 2 fără rânduri trece validarea de client și ajunge la `/complete`. **Exact
  poarta care ar fi trebuit să prindă bugul de mai sus.**

Intră amândouă aici.

---

## 3. NO-TOUCH

⛔ `server/signing/**`, `flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ Atașamentele (`o-alist`, `o-adata`) și capturile (`o-czone*`, `o-captura2-wrap`) — sunt **#128m**
⛔ `getOR()` NU se șterge și NU se schimbă — rămâne funcția „blocul 0", cu apelanții ei legitimi
⛔ Nu atinge agregările din `alop.mjs`, `clasa8.mjs`, `opme-matcher.mjs`
⛔ Nu adăuga defalcare pe furnizori în cardul ALOP — cerință separată
⛔ Nu schimba semantica `expected` / bugetului

---

## 4. Etapa A — clientul trimite TOATE rândurile

`doc.js`, `completeAsP2`: pentru `ordnt`, `{rows: getOR()}` → `{rows: getOrdRowsAll()}`.

⚠️ Verifică pe cod ce formă are ieșirea lui `getOrdRowsAll()` (`core.js:491`) față de `getOR()` —
diferența trebuie să fie **exclusiv** prezența lui `bloc_idx` și acoperirea tuturor blocurilor.
Dacă găsești altă diferență (chei lipsă, formatare de bani diferită), **oprește-te și raportează**:
`/complete` scrie direct în coloana `rows`, deci orice diferență de formă e o schimbare de date.

⚠️ `completeAsP2` e folosită **și pentru DF** (`notafd`) — ramura DF rămâne **byte-identică**.

---

## 5. Etapa B — validările de client acoperă toate blocurile

### 5.1 `validateSecB`

Garda devine per bloc: **fiecare** bloc trebuie să aibă cel puțin un rând cu `cod_angajament`
nevid, iar verificarea col.5 ≥ 0 se aplică rândurilor din toate blocurile.
Mesajele: cu un singur bloc, **byte-identice** cu azi; cu mai multe, prefixate
`` `Furnizor ${i+1} — ` `` (același tipar ca la #128i).

### 5.2 Pre-checkul din `showP2Modal`

`missingSuma` se evaluează pe toate blocurile prin `_ordAllRowInputs` (helper din #128i).
⚠️ Păstrează intenția: e un pre-check rapid înaintea lui `_validateOrd`. Dacă TOATE blocurile
n-au col.4, alertul generic e corect. Dacă doar unul e incomplet, lasă `_validateOrd` să dea
mesajul precis — ⛔ nu înlocui mesajul bun cu alertul generic (motivul pentru care agentul l-a
lăsat la #128k).

---

## 6. Etapa C — apărarea pe SERVER (partea care contează pe termen lung)

Clientul e reparat, dar clasa de bug se poate repeta din **orice** cale care trimite un `rows`
parțial. Serverul nu trebuie să piardă tăcut rânduri.

În `completeFormular` (`server/services/formular-shared.mjs`), pentru `type === 'ord'`, ÎNAINTE de
scriere:

1. citește `blocuri` din documentul existent (ai deja rândul, prin `SELECT`-ul de la ~:422 — dacă
   nu conține coloana, adaug-o în proiecție);
2. calculează mulțimea de `bloc_idx` distincte din `data.rows` primite;
3. dacă documentul are **mai mult de un bloc** iar rândurile primite **nu acoperă toate**
   `bloc_idx`-urile blocurilor declarate → **refuză** cu `409` și codul
   `rows_bloc_lipsa`, mesaj în română care spune care bloc lipsește;
   `logger.warn` cu `{ ordId, blocuriDeclarate, blocIdxPrimite }`.

**De ce fail-closed și nu merge automat:** un merge ar putea învia rânduri șterse intenționat de
utilizator. Un 409 înseamnă „client vechi sau cale nemigrată" — vizibil, nu tăcut. Și e sigur:
după Etapa B, fiecare bloc trebuie să aibă cel puțin un rând, deci un `/complete` legitim acoperă
mereu toate blocurile.

4. normalizează `bloc_idx` pe rândurile primite (numeric, implicit 0) — refolosește
   `pregatesteScriereBlocuri` sau importă helperul din `ord-blocuri.mjs`. ⛔ Nu duplica logica.

⚠️ Verifică dacă `completeFormular` aplică `deriveOrdIdentityCols`. Dacă **nu** — raportează, ⛔ nu
adăuga: e o diferență preexistentă între `/complete` și `PUT`, iar introducerea derivării pe calea
de finalizare e o schimbare de comportament care merită lotul ei.

---

## 7. Teste

**7.1 Client** (happy-dom, modelul din `pagin-component.test.mjs`; capcana:
`dirname(fileURLToPath(import.meta.url))`):

1. ⭐ **REGRESIA:** două blocuri cu rânduri, `completeAsP2('ordnt')` → corpul cererii conține
   rândurile **ambelor** blocuri, cu `bloc_idx` 0 și 1. Fără fix, testul dă doar rândul blocului 0;
2. ⭐ **NON-REGRESIE:** un singur bloc → corpul e echivalent cu cel de dinainte de fix
   (aceleași câmpuri, plus `bloc_idx: 0`);
3. ramura DF (`notafd`) → corp **neschimbat**;
4. `validateSecB` cu blocul 2 fără niciun `cod_angajament` → **respinge**, cu mesaj
   „Furnizor 2 — …"; cu un singur bloc incomplet → mesaj byte-identic cu azi;
5. `validateSecB` cu col.5 negativă în blocul 2 → respinge;
6. pre-checkul din `showP2Modal`: blocul 0 fără col.4 dar blocul 1 cu col.4 → **NU** blochează cu
   alertul generic (fals-blocajul reparat); toate blocurile fără col.4 → blochează.

**7.2 Server (Postgres real):**

7. ⭐ document cu 2 blocuri, `/complete` cu rânduri doar pentru `bloc_idx 0` → **409
   `rows_bloc_lipsa`**, iar `rows` în DB rămâne **NESCHIMBAT** (verifică în bază: „a refuzat" vs
   „a refuzat DUPĂ ce a scris" — lecția de la #123);
8. document cu 2 blocuri, `/complete` cu rânduri pentru ambele → 200, ambele salvate;
9. ⭐ **NON-REGRESIE:** document cu un singur bloc (`blocuri` NULL sau un element) → `/complete`
   se comportă exact ca înainte;
10. rânduri cu `bloc_idx` lipsă / string → normalizate la numeric.

---

## 8. Cache busting

`doc.js` (+ eventual `core.js`) sunt în `public/`. Verifică pe cod
(`grep -n "formular/doc.js\|formular/core.js" public/sw.js`); la #128h–#128k s-a constatat că NU
sunt în `PRECACHE_ASSETS` ⇒ probabil doar `?v=3.9.772` țintit. **Confirmă**, nu presupune.

---

## 9. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed" — `test:db` e obligatoriu, testele 7-10 rulează acolo.

Bump la `3.9.772`;
`git commit -m "fix(#128l): randurile blocurilor 2+ se pierdeau la finalizarea P2 + garda pe server"`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 10. Verificări de ieșire (verbatim în raport)

```bash
grep -n "getOrdRowsAll()" public/js/formular/doc.js
# Așteptat: apelul din completeAsP2 (pe lângă collectOrdDb)

grep -n "rows:getOR()" public/js/formular/doc.js
# Așteptat: 0 rezultate

grep -n "rows_bloc_lipsa" server/services/formular-shared.mjs
# Așteptat: 1 linie

grep -n "'#o-tbody" public/js/formular/doc.js
# Așteptat: DOAR ancorele rămase legitim — comparat cu lista albă din
#           server/tests/unit/ord-bloc-paritate.test.mjs, care trebuie ACTUALIZATĂ

git diff --stat -- server ':(exclude)server/tests'
# Așteptat: DOAR formular-shared.mjs
```

⚠️ Testul de paritate din #128k (`ord-bloc-paritate.test.mjs`) asertează mulțimea exactă de ancore.
Acest lot îi scoate câteva din listă ⇒ **actualizează lista albă** și spune în raport care intrări
au dispărut. Ăsta e chiar mecanismul pentru care testul a fost scris.

---

## 11. RAPORT FINAL

- commit hash + push; versiunea din `package.json`; `git log -1 --pretty=%s` curat
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 2, 7 și 9** menționate separat
- ce intrări au fost scoase din lista albă a testului de paritate
- **răspunsul la §6:** `completeFormular` aplică sau nu `deriveOrdIdentityCols` (raportat, nereparat)
- dacă ai găsit **altă** cale care trimite `rows` parțial (grep după `{rows:` în `public/`) —
  raporteaz-o, e cea mai valoroasă constatare posibilă aici
- cazul de cache busting
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
