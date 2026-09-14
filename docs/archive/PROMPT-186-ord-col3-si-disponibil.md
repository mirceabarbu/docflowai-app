---
prompt: 186
titlu: "ORD — coloana 3 derivată din lanțul de ordonanțări, disponibilul pe ordonanțat, porți la lichidare"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.840
versiune_tinta: v3.9.841
migratii: NU (de confirmat la Etapa 0)
fisiere_din_public: DA   (⇒ bump `?v=` ȚINTIT)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## ⚠️ Zonă financiară. Citește tot înainte de a scrie o linie.

Cifrele din acest lot ajung în documente semnate QES și transmise Ministerului Finanțelor.
O greșeală aici nu produce un badge greșit, ci o ordonanțare de plată eronată.
**Orice `old_str` care nu se potrivește, orice ancoră care nu iese ⇒ OPREȘTE-TE și raportează.**

---

## Regulile, așa cum le-a stabilit Mircea (sursă: OMF 1140/2025, ghidul MF)

Tabelul „Responsabil CAB" al ORD-ului are cinci coloane. Regulile de adevăr:

| col. | ce e | cine o produce |
|---|---|---|
| 2 — Recepții | totalul recepțiilor **din sistemul CAB** pe indicatorul din col.1 | **dată externă**, completată manual de responsabilul CAB, dovedită prin captura anexată. Aplicația NU o derivă niciodată. |
| 3 — Plăți anterioare | `col.3 + col.4` de pe **ultima ORD aprobată a dosarului** | **derivată de aplicație**, ca prefill; rămâne EDITABILĂ |
| 4 — Sumă ordonanțată | suma ordonanțată acum | utilizator |
| 5 — Recepții neplătite | `col.2 − col.3 − col.4`, nu poate fi negativă | calculată, deja implementată |

**Disponibil de ordonanțat** = `col.2 − (col.3 + col.4)` de pe ultima ORD aprobată.

**Card plată, „Total plăți"** = `col.3` + plata confirmată a ciclului curent.

### Nuanța din ghid, cerută explicit (Cap. II.1.2, pct. 3)

> „La înscrierea informațiilor în col.3 nu se va ține cont de cheltuielile care au fost angajate,
> lichidate și ordonanțate anterior și care nu au apărut decontate în extrasul de cont la momentul
> întocmirii formularului."

⇒ Derivarea adaugă `col.4` al predecesorului **numai dacă plata acelui ciclu e CONFIRMATĂ**.
Dacă predecesorul e ordonanțat dar nedecontat, col.3 derivată rămâne **doar `col.3` al lui**.

### Verificarea pe date reale — folosește-o ca test de acceptanță

Dosarul „Iluminat public", DF nr. 6744, valoare **360.424,95**:

| ciclu | ORD | col.2 | col.3 | col.4 | col.3+col.4 |
|---|---|---|---|---|---|
| 1 | 41011 | — | 254.379,63 | 46.045,32 | **300.424,95** |
| 2 | 43759 | 353.688,51 | **300.424,95** | 53.263,56 | **353.688,51** |
| 3 | 47218 | ≥413.096,30 | **353.688,51** | 59.407,79 | 413.096,30 |

Col.3 al ciclului 2 iese exact din ciclul 1. Col.3+col.4 al ciclului 2 e fix col.2 al lui, de aceea
col.5 a ieșit 0,00. Primul ciclu nu are predecesor ⇒ col.3 a fost completată manual (plăți din CAB
dinaintea dosarului). **Regula se verifică pe trei cicluri consecutive.**

---

## Ce e greșit azi, verificat pe cod

**(a) Col.3 e prefill-ată din date interne, din DOUĂ locuri concurente:**
- `public/js/formular/doc.js:253` — `window._alopSumaPlataAnterioara` = `alop.suma_platita_total`
  (= `suma_totala_platita + plata_suma_efectiva`), scrisă cu **`force:true`**, deci suprascrie
  NECONDIȚIONAT valoarea salvată, inclusiv pe un ORD deja aprobat;
- `public/js/formular/doc.js:865` — suma `plata_suma_efectiva` din `cicluri_istorice`, cu gardă.

Ambele derivă din **plățile pe care le știe DocFlowAI**, nu din lanțul ORD-urilor. Pe ORD 43759
asta a produs 99.308,88 peste 300.424,95 — a înlocuit cifra corectă cu una internă.

**(b) Disponibilul afișat se calculează pe PLĂȚI:**
`server/routes/alop.mjs:1101` → `alop.ramas = df_valoare − suma_platita_total`.
Alimentează `can_start_noua_ordonantare` (`services/alop-capabilities.mjs:49`) și textul
„Rămas de ordonanțat" (`public/js/formular/alop.js:902`). Un ORD emis și neplătit nu consumă nimic.

⚠️ **Fapt important, de nu stricat:** poarta de la `POST /api/alop/:id/noua-lichidare`
(`alop.mjs:1890`) e DEJA corectă — plafonează pe `bugetAnCurent − sumaOrdonantata`, unde
`sumaOrdonantata` e Σ col.4 pe ORD-urile anului (arhivate + curent). Deci UI-ul e permisiv, iar
serverul refuză corect la execuție. **Nu slăbi poarta aia.** Lotul aliniază UI-ul la ea și adaugă
porțile noi.

**(c) Cardul de plată** (`public/js/formular/alop.js:625`) însumează `plata_suma_efectiva`
istorice + curent. Trebuie să devină `col.3 + plata confirmată a ciclului curent`.

---

## ETAPA 0 — ancore + recon (READ-ONLY)

Raportează valorile **OBȚINUTE**. Orice nepotrivire ⇒ **OPREȘTE-TE**.

```bash
node -p "require('./package.json').version"          # Așteptat: 3.9.840
grep -n "_alopSumaPlataAnterioara" public/js/formular/*.js
grep -n "applyPlatiAntPrefill" public/js/formular/doc.js
grep -n "alop.ramas = dfVal" server/routes/alop.mjs
grep -n "can_start_noua_ordonantare" server/services/alop-capabilities.mjs
grep -n "ramas = bugetAnCurent - sumaOrdonantata" server/routes/alop.mjs
```

Apoi **răspunde în raport, înainte de a scrie cod**, la:

1. Cum se află lanțul complet de ORD-uri al unui dosar, în ordinea emiterii? `formulare_ord` **nu
   are** coloana `alop_id` (verificat: schema la `db/index.mjs:939`). Legăturile sunt
   `alop_ord_cicluri.alop_id + .ord_id` pentru ciclurile arhivate și `alop_instances.ord_id`
   pentru ciclul curent. Scrie interogarea și verific-o.
2. Ce înseamnă exact „ultima ORD **aprobată**" în termeni de cod? Folosește `docAprobatSql`
   (`services/df-aprobat-sql.mjs`) — nu inventa un al doilea predicat de aprobare.
3. Unde e marcată plata confirmată a unui ciclu (`plata_confirmed_at`? `plata_suma_efectiva`?) și
   care e valoarea de adevăr pentru „decontat".
4. `confirma-lichidare` (`alop.mjs:1349`) are azi vreo verificare de sumă? Raportează ce găsești.

---

## ETAPA A — serviciu nou: lanțul de ordonanțări

`server/services/ord-lant.mjs`, modul **fără** rute, cu `pool` injectat sau importat ca restul
serviciilor (urmează convenția din `services/alop-link.mjs`).

`export async function getOrdPredecesor(alopId, orgId, { excludeOrdId } = {})` → întoarce
predecesorul relevant, cu câmpurile de care depinde derivarea:

```
{ ord_id, nr_ord, aprobat, plata_confirmata, col2, col3, col4, col3_plus_col4 }
```

`export async function derivaCol3(alopId, orgId, { pentruOrdId })` → întoarce:

```
{ col3, sursa: 'lant' | 'prima_ord', predecesor: {...} | null, plata_predecesor_confirmata: bool }
```

Reguli, fără excepție:
- fără predecesor aprobat ⇒ `{ col3: null, sursa: 'prima_ord' }`. **`null`, nu `0`** — „nu se știe"
  și „zero lei" sunt lucruri diferite, iar frontendul trebuie să le trateze diferit.
- predecesor aprobat **cu plata confirmată** ⇒ `col3 = col3_pred + col4_pred`
- predecesor aprobat **fără plata confirmată** ⇒ `col3 = col3_pred` (nuanța din ghid)
- sumele se citesc din `formulare_ord.rows` (JSONB), însumând pe **toate rândurile**; un ORD
  multi-bloc are mai multe rânduri și toate contează. Refolosește parsarea numerică din
  `services/formular-shared.mjs` (`_num`) — **nu scrie a doua** convenție de parsare a banilor.

Test unitar `server/tests/unit/ord-lant-col3.test.mjs`, pe funcții pure (extrage aritmetica dacă e
nevoie): lanțul de trei cicluri din tabelul de mai sus, cu cifrele exacte, în ambele variante
(plata confirmată / neconfirmată pe predecesor).

---

## ETAPA B — endpoint + cablarea în frontend

`GET /api/alop/:id/ord-col3?ord_id=…` → `{ col3, sursa, plata_predecesor_confirmata }`.
Autorizare identică cu restul rutelor ALOP din fișier — copiaz-o, nu o reinventa.

În `public/js/formular/doc.js`:

1. ⭐ **Șterge prefill-ul cu `force:true`** de la `:253` (`populateOrd`) și pe cel de la `:865`
   (`openDoc`). Amândouă derivă din sursa greșită.
2. Prefill nou, dintr-un **singur** loc, cu trei condiții cumulative:
   - documentul e **ORD NOU** (fără `id` salvat) — pe un ORD existent nu se prefill-ează NIMIC;
   - rândul are col.3 la 0;
   - `sursa === 'lant'`.
3. Col.3 rămâne **EDITABILĂ** peste tot, ca azi. Decizia lui Mircea: derivarea e sugestie, nu
   garanție — responsabilul CAB rămâne răspunzător pentru col.1, 2, 3 și 5.
4. Când `sursa === 'prima_ord'`, nu scrie nimic și afișează o notă discretă lângă tabel: prima
   ordonanțare a dosarului, col.3 se completează din CAB.

⛔ **Invariantul cel mai important al lotului:** deschiderea unui ORD existent nu are voie să
schimbe nicio cifră din tabel. Un document aprobat și semnat trebuie să arate exact ce s-a semnat.

---

## ETAPA C — disponibilul

`server/routes/alop.mjs:1101` — `alop.ramas` trece de la plăți la ordonanțat:

```js
// #186 — disponibilul de ordonanțat se raportează la ce s-a ORDONANȚAT, nu la ce s-a plătit.
// Un ORD emis și încă nedecontat angajează suma; forma veche (df_valoare − suma_platita_total)
// îl ignora complet și afișa mai mult decât există. Poarta de la noua-lichidare (:1890)
// plafona deja corect pe ordonanțat — deci UI-ul contrazicea serverul.
```

Reutilizează calculul din `noua-lichidare` (`Σ col.4` pe ORD-urile dosarului) — extrage-l în
`services/ord-lant.mjs` și cheamă-l din ambele locuri, ca să nu existe două definiții.

⚠️ Verifică efectul asupra lui `can_start_noua_ordonantare`
(`services/alop-capabilities.mjs:49`): butonul devine mai restrictiv, ceea ce e intenția. Dar
confirmă că un dosar cu disponibil real pozitiv îl păstrează.

⚠️ `ramas_an_curent` (`sqlRamasAnExercitiu`, `alop.mjs:191`) e o noțiune DIFERITĂ — creditele
bugetare ale anului, nu valoarea DF. **Nu o atinge și nu o amesteca** cu `ramas`.

---

## ETAPA D — porțile la lichidare și la ORD nou

Decizia lui Mircea, două praguri distincte:

- **BLOCARE (400)** dacă suma ar depăși **valoarea DF-ului aprobat**. E limita angajamentului
  legal; peste ea nu se ordonanțează, punct.
- **AVERTISMENT (răspuns 200 cu semnalizare, continuare permisă)** dacă suma se încadrează în DF
  dar depășește **recepțiile** (`col.2 − (col.3 + col.4)` de pe ultima ORD aprobată). Motivul:
  recepțiile pot fi mai mici decât DF-ul pur și simplu fiindcă responsabilul CAB nu a înregistrat
  încă recepția în CAB — și o poate face imediat după.

Locuri: `POST /api/alop/:id/confirma-lichidare` (`:1349`) și calea de creare a unui ORD nou.
⚠️ Poarta existentă de la `noua-lichidare` (`:1890`) **rămâne exact cum e**. Adaugi, nu înlocuiești.

Frontendul afișează avertismentul explicit, cu ambele cifre (disponibil din DF / disponibil din
recepții), ca omul să știe ce ignoră. Nu-l ascunde într-un `console.warn`.

---

## ETAPA E — cardul de plată

`public/js/formular/alop.js:625` — „Total plătit (toate ciclurile)" devine
`col.3 al ORD-ului curent + plata confirmată a ciclului curent`.
Pe dosarul de test, ciclul 2: **353.688,51**, nu 99.308,88.

⚠️ Raportează dacă schimbarea asta afectează alte locuri care afișează totaluri de plăți
(`admin/flows.mjs:101` are un `SUM` pe aceleași coloane, `trasabilitate.mjs:242` la fel).
**Nu le atinge** — doar spune ce ai găsit; sunt lot separat.

---

## ETAPA F — teste

`server/tests/db/ord-col3-lant.test.mjs`, pe Postgres real:

1. ⭐ Lanțul de trei cicluri cu cifrele exacte din tabel; col.3 derivată pentru ciclul 2 = 300.424,95.
2. ⭐ Predecesor aprobat, plată NEconfirmată ⇒ col.3 = col.3 al predecesorului, **fără** col.4.
3. Prima ORD a dosarului ⇒ `sursa='prima_ord'`, `col3=null`.
4. ORD multi-bloc (mai multe rânduri) ⇒ însumarea acoperă toate rândurile.
5. Predecesor NEaprobat ⇒ nu e considerat predecesor.
6. ⭐ Disponibil: dosar cu un ORD emis și neplătit ⇒ `ramas` scade cu suma ordonanțată.
7. ⭐ Poarta de blocare: sumă peste DF ⇒ 400. Poarta de avertisment: sub DF, peste recepții ⇒ 200
   cu semnalizare, operația se execută.
8. **Nedeteriorare:** poarta de la `noua-lichidare` întoarce aceleași rezultate ca înainte.
9. **Invariantul de la Etapa B:** un `GET` pe un ORD existent întoarce exact rândurile salvate.

```bash
npm test
npm run test:db
```

`test:db` COMPLET, REAL. **Skipped ≠ passed.**
Dacă pică un test preexistent ⇒ **raportează ÎNAINTE de a-l modifica**.

---

## ETAPA G — versiune, cache, commit

```bash
npm version 3.9.841 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
```

`?v=` **țintit** pe fișierele din `public/` modificate, în toate paginile care le încarcă.
`CACHE_VERSION` doar dacă atingi ceva din `PRECACHE_ASSETS` — verifică, nu presupune.

`git add` **explicit**. **Niciodată `git add -A`.**

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**, plus răspunsurile la cele 4 întrebări de recon.
2. Interogarea care reconstituie lanțul de ORD-uri și cum ai validat-o.
3. Rezultatul fiecărui caz din Etapa F, în special **1, 2, 6, 7 și 9**.
4. Ce ai găsit la Etapa E despre celelalte locuri cu totaluri de plăți (neatinse).
5. Confirmare explicită că poarta de la `noua-lichidare` (`:1890`) e **neatinsă** și verde.
6. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat COMPLET.
7. Ce ai bumpat la Etapa G.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut. Zona e financiară: dacă o regulă din
   prompt nu se potrivește cu ce vezi în cod, **oprește-te**, nu alege tu.
10. Constatări colaterale. În special: alte locuri care derivă „plăți anterioare" sau „disponibil"
    din `suma_platita_total` și pe care nu le-am enumerat eu.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără migrații (dacă rezultă că sunt necesare, **oprește-te și raportează**).
- **Col.2 nu se derivă NICIODATĂ.** E dată externă din CAB. Dacă vezi cod care o calculează,
  raportează, nu „repara".
- **Deschiderea unui ORD existent nu schimbă nicio cifră.** Prefill DOAR pe ORD nou.
- Col.3 rămâne **editabilă**.
- Poarta de la `noua-lichidare` (`alop.mjs:1890`) rămâne **neatinsă**.
- `ramas_an_curent` nu se amestecă cu `ramas`.
- O singură convenție de parsare a banilor: cea existentă.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
