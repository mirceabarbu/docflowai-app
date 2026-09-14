---
prompt: 187
titlu: "Corecție #186 — coloana 3 se derivă PER CHEIE din coloana 1, niciodată însumată pe document"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.841
versiune_tinta: v3.9.842
migratii: NU
fisiere_din_public: DA   (⇒ bump `?v=` ȚINTIT)
zona_no_touch_atinsa: NU
blocheaza_deploy: DA — v3.9.841 NU se duce în producție fără acest lot
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## ⚠️ Zonă financiară. Acesta e un lot de CORECȚIE a unui defect introdus de #186.

Cifrele ajung în ordonanțări de plată semnate QES și transmise Ministerului Finanțelor.
Orice ancoră care nu iese, orice `old_str` care nu se potrivește ⇒ **OPREȘTE-TE și raportează**.

---

## Ce e greșit în v3.9.841

Ai semnalat-o singur, la punctul (b) din raportul lui #186, și ai făcut exact ce trebuia: ai
implementat ce cerea promptul și ai lăsat tensiunea vizibilă în loc să decizi. Mircea a decis.

`doc.js:87-92`, comentariul lui **#128k**, spune două lucruri, iar al doilea e cheia:

> coloana 3 e o proprietate a ANGAJAMENTULUI (`cod_angajament` / `indicator` / `cod_SSI`), NU a
> furnizorului ⇒ aceeași valoare în ORICE bloc. […] verificarea de buget și `expected` din
> `opme-matcher` însumează EXCLUSIV col.4 […] ⇒ valoarea repetată **nu se dublează în niciun calcul**.

Repetarea col.3 în fiecare bloc era sigură **fiindcă nimic nu o însuma**. #186 a introdus primul
consumator care o însumează, deci a desfăcut invariantul pe care se sprijinea #128k.

Efectul: pe un ORD cu două blocuri și col.3 = 300.424,95 în fiecare, derivarea pentru ORD-ul
următor întoarce **600.849,90** în loc de 300.424,95. O eroare de sute de mii de lei, într-o cifră
semnată. Cele zece teste de la #186 sunt verzi doar fiindcă dosarul de referință are un singur bloc.

---

## Regula corectă (decizia lui Mircea, sursă: ghidul MF, Cap. II.1.2 pct. 2-3)

> „Recepții (lei)" / „Plăți anterioare (lei)" se completează cu totalul din sistemul de control al
> angajamentelor **aferent fiecărui indicator din coloana 1**.

1. **Col.3 nu se însumează NICIODATĂ pe document.** Se derivă **per cheie din coloana 1**.
2. Cheia = `(cod_angajament, indicator_angajament, program, cod_ssi)`, normalizată: `trim`, spații
   interne colapsate, comparație case-insensitive. Scrie normalizarea într-un singur loc.
3. Pentru o cheie K: `col3(K) = Σ col3(rânduri predecesor cu cheia K) + Σ col4(rânduri predecesor
   cu cheia K)` — dar ⚠️ col.3 e repetată identic pe rândurile aceleiași chei (asta e chiar #128k),
   deci **col.3 se ia O SINGURĂ DATĂ per cheie**, nu însumată peste rândurile ei. Col.4 **se
   însumează** peste rândurile cheii.
   ⇒ `col3(K) = col3_distinct(K) + Σ col4(K)`.
   Dacă rândurile aceleiași chei au col.3 DIFERITE la predecesor, e o anomalie de date: nu alege
   tu, întoarce cheia marcată `col3_inconsistent: true`, nu prefill-a nimic pentru ea, și
   **raportează câte cazuri ai găsit în teste**.
4. **Nuanța din ghid rămâne neschimbată** de la #186: `Σ col4(K)` se adaugă **numai dacă plata
   ciclului predecesor e confirmată** (`plata_confirmed_at IS NOT NULL`). Altfel `col3(K) = col3_distinct(K)`.
5. **Indicator nou** — cheie prezentă pe ORD-ul curent, absentă la predecesor ⇒ col.3 rămâne
   **NEGOLITĂ**, `sursa: 'indicator_nou'`, `col3: null`. **Nu 0.** Decizia lui Mircea: aplicația nu
   știe nimic despre acel angajament în CAB, iar un zero prefill-at arată ca o valoare validată.
6. **Col.4 rămâne însumată global** acolo unde e azi — disponibil, plafoane, `sumaOrdonantataDosar`,
   `validateOrdBugetAnCurent`. ⛔ **Nu atinge nimic din calea col.4.** Acolo însumarea e corectă și
   verificată.

---

## Prefill-ul în frontend — regula care păstrează UX-ul de azi

Problemă reală: la un ORD **nou**, rândurile sunt goale, deci col.1 nu există încă și cheia nu se
poate potrivi. Soluția cerută, în două ramuri:

- **Predecesorul are o SINGURĂ cheie distinctă** (cazul real de azi) ⇒ acea valoare se prefill-ează
  în toate rândurile, exact ca azi. Zero schimbare de comportament vizibil.
- **Predecesorul are mai multe chei distincte** ⇒ se prefill-ează **doar** rândurile a căror cheie
  col.1 se potrivește deja; restul rămân negolite. Pe măsură ce utilizatorul completează col.1,
  prefill-ul se poate aplica la acel rând — **dar numai dacă col.3 al rândului e încă 0**.

⛔ Invariantul de la #186 rămâne intact și e mai important decât orice: **deschiderea unui ORD
existent nu schimbă nicio cifră.** Prefill DOAR pe ORD nou. Col.3 rămâne editabilă peste tot.

---

## ETAPA 0 — recon pe codul TĂU de la #186 (READ-ONLY)

Eu nu am codul livrat la #186. **Citește-l și raportează forma reală înainte de a schimba ceva.**

```bash
node -p "require('./package.json').version"          # Așteptat: 3.9.841
grep -n "export" server/services/ord-lant.mjs
grep -n "sumaColoana\|SQL_LANT_ORD\|derivaCol3\|getOrdPredecesor" server/services/ord-lant.mjs
grep -rn "ord-col3" server public --include=*.mjs --include=*.js | grep -v tests
grep -n "numMoney" server/services/*.mjs | head
```

Raportează, înainte de orice modificare:
1. Semnătura actuală a lui `derivaCol3` și forma exactă a răspunsului endpointului.
2. Unde anume se face azi însumarea col.3 (funcția și linia).
3. Cine consumă răspunsul în frontend și cum îl scrie în rânduri.
4. Ce câmpuri din `formulare_ord.rows` poartă cele patru componente ale cheii — numele exacte,
   citite din cod, nu presupuse. (`cod_angajament`? `indicator_angajament`? `program`? `cod_ssi`?)

---

## ETAPA A — serviciul

`server/services/ord-lant.mjs`:

- Funcție nouă `cheieRand(r)` → cheia normalizată (string canonic). Un singur loc.
- `derivaCol3` întoarce de acum o **hartă pe cheie**, nu un scalar:

```
{
  sursa: 'lant' | 'prima_ord',
  plata_predecesor_confirmata: bool,
  chei: {
    "<cheie canonica>": { col3: number|null, col3_inconsistent?: true, componente: {...} }
  },
  cheie_unica: "<cheie>" | null   // setat DOAR când predecesorul are exact o cheie distinctă
}
```

`cheie_unica` e ce permite ramura simplă din frontend fără să reintroducem însumarea.

⛔ Nu schimba `sumaOrdonantataDosar` și nici nimic de pe calea col.4.

## ETAPA B — endpoint + frontend

`GET /api/alop/:id/ord-col3` întoarce noua formă. Frontendul aplică cele două ramuri de mai sus.
`sursa: 'prima_ord'` și `col3: null` se tratează la fel ca la #186: nu se scrie nimic, se afișează
nota discretă. Pentru `indicator_nou`, aceeași tăcere — dar nota spune că e un angajament care nu
apare pe ordonanțarea anterioară.

## ETAPA C — poarta de la crearea ORD-ului (punctul (c) din raportul tău)

Ai avut dreptate: `POST /api/formulare-ord` e chemată de autosalvare cu rânduri de regulă goale,
deci poarta e decorativă acolo. **Mut-o pe traseul de trimitere spre semnare**, unde suma există
sigur. O poți lăsa și la creare — e inofensivă când suma e 0 — dar cea care contează trebuie să fie
pe submit. Raportează unde exact ai pus-o și de ce ai ales acel punct.

---

## ETAPA D — teste

În `server/tests/db/ord-col3-lant.test.mjs` (extinde, nu rescrie):

1. ⭐ **Cazul care ar fi picat:** predecesor cu **DOUĂ blocuri, aceeași cheie**, col.3 = 300.424,95
   repetată, col.4 = 30.000 + 23.263,56. Derivarea ⇒ **353.688,51**, NU 600.849,90.
   Ăsta e testul care apără invariantul lui #128k. Numele lui să spună asta.
2. ⭐ Predecesor cu **două chei DIFERITE** ⇒ două intrări în hartă, fiecare cu propria valoare,
   `cheie_unica === null`. Nicio însumare între chei.
3. ⭐ **Indicator nou:** cheie pe ORD-ul curent, absentă la predecesor ⇒ `col3 === null`,
   `sursa: 'indicator_nou'`. Asertează `toBeNull()`, nu `toBe(0)`.
4. Rânduri ale aceleiași chei cu col.3 DIFERITE la predecesor ⇒ `col3_inconsistent: true`, fără
   prefill.
5. Normalizarea cheii: `" AAB2XFH596K "` și `"aab2xfh596k"` sunt aceeași cheie.
6. **Nedeteriorare — lanțul real:** cele trei cicluri „Iluminat public" (300.424,95 → 353.688,51)
   dau exact aceleași cifre ca la #186. Cazul cu un singur bloc nu se schimbă cu nimic.
7. **Nedeteriorare:** nuanța plății neconfirmate (cazul 2 de la #186) ⇒ neschimbată.
8. **Nedeteriorare:** disponibilul și poarta de la `noua-lichidare` ⇒ identice cu #186.
9. **Invariantul:** `GET` pe un ORD existent nu schimbă nicio cifră.

```bash
npm test
npm run test:db
```

`test:db` COMPLET, REAL. **Skipped ≠ passed.** Test preexistent care pică ⇒ **raportează ÎNAINTE**.

---

## ETAPA E — versiune, cache, commit

```bash
npm version 3.9.842 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
```

`?v=` țintit pe fișierele din `public/` modificate, în `formular.html`. `CACHE_VERSION` doar dacă
atingi `PRECACHE_ASSETS` — verifică.

`git add` **explicit**. **Niciodată `git add -A`.**

Commit:
```
fix(#187): coloana 3 se derivă per cheie din coloana 1, nu însumată pe document — v3.9.842

#186 a introdus primul consumator care insuma coloana 3 peste randurile unui ORD.
Repetarea ei in fiecare bloc era sigura tocmai fiindca nimic nu o insuma (#128k):
coloana 3 e o proprietate a angajamentului, nu a furnizorului. Pe un ORD cu doua
blocuri, derivarea intorcea valoarea dublata — sute de mii de lei intr-o cifra
semnata si transmisa la MF.

Derivarea se face acum per cheie (cod_angajament / indicator / program / cod_SSI),
conform ghidului MF Cap. II.1.2: coloana 3 e aferenta fiecarui indicator din
coloana 1. Coloana 3 se ia o singura data per cheie, coloana 4 se insumeaza peste
randurile cheii. Un indicator absent la predecesor ramane negolit, nu zero.

Calea coloanei 4 — disponibil, plafoane, validari de buget — e neatinsa.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Recon-ul din Etapa 0, cu răspunsurile la cele 4 întrebări.
2. Forma finală a lui `derivaCol3` și a răspunsului endpointului.
3. Rezultatul fiecărui caz din Etapa D, în special **1, 2, 3 și 6**.
4. Câte cazuri de `col3_inconsistent` ai găsit construind testele.
5. Unde ai pus poarta de la Etapa C și de ce.
6. Confirmare explicită că nimic de pe calea col.4 nu a fost atins.
7. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat COMPLET.
8. Teste preexistente atinse, cu motivul fiecăruia.
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale. În special: mai există alt loc care însumează col.3 sau col.2 peste
    rânduri, introdus de #186 sau mai vechi?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații.
- **Col.3 nu se însumează niciodată peste chei diferite, și nici peste rândurile aceleiași chei.**
- **Col.2 nu se derivă niciodată** — dată externă din CAB.
- **Indicator absent la predecesor ⇒ `null`, nu `0`.**
- Calea col.4 (disponibil, plafoane, `noua-lichidare`) — **neatinsă**.
- Deschiderea unui ORD existent nu schimbă nicio cifră. Prefill doar pe ORD nou.
- Col.3 rămâne editabilă.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
