# PROMPT #128k — PARITATE COMPLETĂ a blocurilor ORD (prefill plăți anterioare + inventar închis)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus · **Target versiune:** `v3.9.771` (de la 3.9.770 — **citește
`package.json`**) · **Migrații:** ZERO · **Fișiere din `server/`:** ZERO (în afara testelor)

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o singură linie, **sintaxă bash**.
> ⛔ Fără here-string PowerShell (`@'…'@` a lăsat `@` parazit la #128g, #128h, #128i).

---

## 1. Bugul raportat de Mircea pe staging

> „În blocul 2, în tabel, nu ia automat plăți anterioare (avem același cod de angajament, cod
> indicator, cod SSI). Nu am clonat în totalitate funcțiile din primul bloc."

Are dreptate pe amândouă.

**Cauza directă:** la #128i, tabelul de inventar a lăsat **deliberat** cele trei situri de prefill
`plati_anterioare` (`doc.js` — în `populateOrd`, în `openDoc` și în ramura de creare ORD nou pe
ciclu 2+), cu motivarea „prefill de o singură valoare pe primul rând al documentului; nu e «per
bloc» semantic". **Motivarea e greșită**, și a fost acceptată fără verificare.

Prefill-ul scrie totalul plăților din ciclurile ALOP finalizate anterior
(`cicluri_istorice` însumat pe `plata_suma_efectiva`) în coloana 3 a primului rând. Coloana 3
(„Plăți anterioare") e o proprietate a **ANGAJAMENTULUI**, nu a furnizorului ⇒ același cod de
angajament, aceeași valoare, în oricare bloc apare.

**Sigur intern, verificat:** verificarea de buget și `expected` din `opme-matcher` însumează
exclusiv **coloana 4**, nu coloana 3; iar #128e a stabilit că **nu există total general peste
blocuri** (fiecare bloc are propriul rând de totaluri, ca în formularul MF). Deci valoarea
repetată nu se dublează nicăieri în calcule.

---

## 2. Scopul lotului: nu doar prefill-ul — INVENTAR ÎNCHIS

Partea a doua a observației („nu am clonat în totalitate") e cea care contează pe termen lung.
După #128f…#128j, comportamentul ORD e împrăștiat între trei fișiere, iar decizia
„generalizez / las" a fost luată de mână, lot cu lot, fără nimic care s-o apere.

Lotul ăsta face două lucruri: repară prefill-ul **și încuie inventarul cu un test structural**,
ca următoarea ancorare pe id să fie prinsă automat, nu descoperită pe staging.

---

## 3. NO-TOUCH

⛔ `server/**` cu excepția `server/tests/`
⛔ **Atașamentele** (`o-alist`, `o-ainp`, `o-adata`) și **capturile** (`o-czone`, `o-czone2`,
   `o-captura2-wrap`) — sunt lotul următor, **#128l**, care le face per bloc cu migrație
   (`ADD COLUMN bloc_idx` pe `formulare_atasamente` și `formulare_capturi`). ⛔ Nu le atinge aici
⛔ `o-df-sel` / `o-df-id` — selecția DF-ului e la nivel de DOCUMENT (un singur DF per ORD, decizia
   de la reconul #128a). Rămân globale, corect
⛔ `#o-nrUnic` — unic pe document, rămâne global
⛔ Rutele `/api/alop/:id`, `/api/beneficiari`, `/api/verify/cui` — nu se ating
⛔ Nu schimba regula de buget, `expected`, sau vreo logică de server

---

## 4. Etapa A — reconul (ÎNAINTE de orice patch)

Fă inventarul pe arborele CURENT (post-#128j) și raportează-l ca tabel. Ipoteza mea de plecare,
măsurată pe v3.9.759 (deci înainte de serie — cifrele s-au schimbat):
`doc.js` ~16 ancore `#o-tbody`, plus `o-df-sel`/`o-df-id`, `o-alist`/`o-adata`, zona de capturi;
`core.js` câteva; `list.js` cele de beneficiar (rezolvate la #128j).

Comenzi de plecare:

```bash
grep -on "getElementById('o-[a-z0-9-]*')\|querySelector[All]*('#o-[a-z0-9-]*" \
  public/js/formular/doc.js public/js/formular/core.js public/js/formular/list.js
```

Pentru **fiecare** ancoră: linia, ce face, și decizia — `GENERALIZAT` / `GLOBAL PRIN DESIGN` (cu
motivul) / `AMÂNAT LA #128l` (atașamente, capturi). ⛔ Nicio ancoră nu rămâne fără verdict.

⚠️ Raportează separat orice ancoră care NU intră în niciuna din cele trei categorii — acelea sunt
constatările valoroase.

---

## 5. Etapa B — prefill `plati_anterioare` pe toate blocurile

### 5.1 O singură funcție, trei apelanți

Extrage un helper unic — `applyPlatiAntPrefill(blocEl)`, cu default „toate blocurile" când nu
primește argument — și cheamă-l din cele trei locuri existente. ⛔ Nu duplica logica a treia oară.

Comportament: pentru fiecare bloc, valoarea se scrie pe **primul rând al blocului** (coloana 3),
urmată de `calcORRow` pe acel input, ca coloana 5 să se recalculeze.

### 5.2 ⚠️ Inconsistență preexistentă — de raportat, nu de „reparat" tăcut

Cele trei situri **nu au aceeași gardă**:

- în `populateOrd`: `_antInputs[0].value = fMR(_sumaAnt)` — **suprascrie necondiționat**;
- în `openDoc`: `if(_firstRow && (parseFloat(_firstRow.value)||0)===0)` — **scrie doar dacă e 0**;
- în ramura de ORD nou: aceeași gardă ca `openDoc`.

Consecință latentă: la fiecare redeschidere a documentului, o valoare corectată manual de
utilizator e suprascrisă de cea calculată.

**Ce faci:** păstrează pentru fiecare sit **exact garda pe care o are azi** — extinzi doar
mulțimea de blocuri acoperită. ⛔ Nu unifica gărzile în lotul ăsta; ar schimba comportamentul pe
documentele existente. **Raportează** inconsistența ca datorie separată, cu recomandarea ta.

### 5.3 Blocurile adăugate ULTERIOR

Un bloc adăugat **după** ce prefill-ul a rulat trebuie să-l primească și el. Cheamă
`applyPlatiAntPrefill(blocNou)` din fluxul de adăugare bloc (#128h).

⚠️ Valoarea provine dintr-un `fetch` pe `/api/alop/:id`. ⛔ Nu re-interoga la fiecare bloc nou —
**memoizează** valoarea calculată într-o variabilă de modul și refolosește-o. Raportează unde ai
pus cache-ul și când se invalidează (cel puțin la `newDoc`/`resetF`, ca la #128h).

### 5.4 ⚠️ Al treilea traseu

Regula care a fost uitată de trei ori (`ctrl_idx` la #128g, blocurile la #128h, prefill-ul acum):
**orice comportament are trei trasee — creare, salvare, redeschidere.** Confirmă explicit în raport
că prefill-ul funcționează pe toate trei, cu câte un caz de test pe fiecare.

---

## 6. Etapa C — testul care ÎNCUIE inventarul

Fișier nou `server/tests/unit/ord-bloc-paritate.test.mjs`.

Un test structural care citește sursa celor trei fișiere și asertează că mulțimea ancorelor
`#o-tbody` / `getElementById('o-…')` rămase e **exact** o listă albă explicită, fiecare intrare cu
un comentariu-motiv în test (`'o-df-sel': 'selecția DF e la nivel de document'`, `'o-adata':
'atașamente — #128l'`, …).

Dacă cineva adaugă o ancoră nouă pe id, testul **cade** și forțează o decizie conștientă.
Dacă cineva rezolvă una amânată, testul cade și cere scoaterea din listă.

⚠️ Ăsta e singurul test din proiect căruia îi e permis să fie analiză statică pe sursă — și e
justificat: obiectul verificat **este** forma sursei, nu comportamentul. Scrie motivul în capul
fișierului, ca să nu fie confundat cu tiparul slab pe care l-am respins în alte loturi.

**Restul testelor sunt comportamentale** (happy-dom, modelul din `pagin-component.test.mjs`;
capcana: `dirname(fileURLToPath(import.meta.url))`, NU `new URL('.', import.meta.url)`):

1. ⭐ **NON-REGRESIE:** cu un singur bloc, prefill-ul se comportă exact ca azi (valoare pe primul
   rând, coloana 5 recalculată), pe toate cele trei trasee;
2. ⭐ două blocuri la redeschiderea unui document → **fiecare** bloc primește valoarea pe primul
   rând al lui;
3. ⭐ bloc adăugat **după** ce prefill-ul a rulat → îl primește, **fără** un al doilea `fetch`
   (spionează `fetch`);
4. bloc adăugat când valoarea e 0 / inexistentă → nimic scris, nicio excepție;
5. garda din `openDoc` respectată: un rând cu valoare deja nenulă nu e suprascris;
6. coloana 5 (`5=(col.2)-(col.3)-(col.4)`) se recalculează corect în blocul 2 după prefill;
7. `newDoc`/`resetF` invalidează cache-ul (un document nou nu moștenește valoarea celui anterior).

---

## 7. Cache busting

Verifică pe cod (`grep -n "formular/doc.js\|formular/core.js\|formular/list.js" public/sw.js`).
La #128h–#128j s-a constatat că NU sunt în `PRECACHE_ASSETS` ⇒ probabil doar `?v=3.9.771` țintit pe
fișierele atinse. **Confirmă**, nu presupune.

---

## 8. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.771`;
`git commit -m "fix(#128k): prefill plati anterioare pe toate blocurile ORD + test de paritate"`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 9. Verificări de ieșire (verbatim în raport)

```bash
grep -n "applyPlatiAntPrefill" public/js/formular/doc.js
# Așteptat: 1 declarație + 3 apelanți (populateOrd, openDoc, ramura ORD nou) + 1 din adăugarea de bloc

grep -c "_alopSumaPlataAnterioara\|cicluri_istorice" public/js/formular/doc.js
# Așteptat: sursele valorii, NEschimbate ca semantică

git diff --stat -- server ':(exclude)server/tests'
# Așteptat: GOL — zero fișiere de producție din server/
# (forma corectă; `git diff --stat server/` singur e o poartă imposibilă când lotul adaugă teste)

grep -n "o-alist\|o-adata\|o-czone" public/js/formular/doc.js
# Așteptat: NESCHIMBAT față de înainte — atașamentele și capturile sunt #128l
```

---

## 10. RAPORT FINAL

- commit hash + push; versiunea din `package.json`; `git log -1 --pretty=%s` **fără caractere
  parazite**
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 4 verificări, verbatim
- ⭐ **tabelul complet de inventar din §4** — fiecare ancoră cu verdict; e cea mai importantă
  livrare a lotului
- ⭐ rezultatele cazurilor **1, 2 și 3** menționate separat
- **al treilea traseu:** confirmarea că prefill-ul merge pe creare, salvare ȘI redeschidere
- unde ai pus cache-ul valorii și când se invalidează
- **inconsistența gărzilor din §5.2**, cu recomandarea ta (raportată, nereparată)
- cazul de cache busting
- orice ancoră care nu intră în cele trei categorii de la §4
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
