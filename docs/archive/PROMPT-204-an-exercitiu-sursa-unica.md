---
prompt: 204
titlu: "anExercitiuCurent() — sursă unică pentru anul de exercițiu al porților de scriere"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.856
versiune_tinta: v3.9.857
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: NU  (⇒ FĂRĂ `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
tip: consolidare (zero schimbare de comportament) + corectură skill
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `merge --no-ff`, `push main`, deploy.
Pasul final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# ⭐ PROPRIETATEA DE SIGURANȚĂ

**Nicio cifră nu se mișcă.** Toate cele patru locuri întorc azi `new Date().getFullYear()` și
trebuie să întoarcă exact aceeași valoare după lot.

Dacă vreun test de neregresie arată o diferență, lotul e **greșit**, nu „diferit". Aceeași
proprietate a ancorat #202 și #203; a funcționat de două ori.

---

# CONTEXTUL

`alop.mjs` și `formular-shared.mjs` derivă anul de exercițiu din ceasul serverului în patru
locuri distincte. Toate alimentează **porți de scriere** — plafonul de ordonanțare/plată și baza
cardului ALOP. La #203 am stabilit categoric că anul lor **nu are voie** să vină din cerere
(un client care trimite `an=2025` ar primi alt plafon), iar testul
`server/tests/unit/an-nu-din-cerere.test.mjs` apără decizia.

Problema rămasă nu e că pot fi suprascrise. E că **sunt patru**.

Asta devine concret la revizia de început de an: între 1 ianuarie și terminarea reviziei din
primele 3 zile lucrătoare, „exercițiul curent" al unui dosar **nu e** pur și simplu anul
calendaristic. Când logica aia va exista, trebuie schimbată **într-un loc**, nu în patru plus
încă unele pe care le vom fi uitat.

## Cele patru locuri

| # | Locație | Formă azi | Ce alimentează |
|---|---|---|---|
| 1 | `routes/alop.mjs:~126` `sqlBandaRowsPlati` | `EXTRACT(YEAR FROM NOW())::int` ×2 în `off` | baza CARDULUI |
| 2 | `routes/alop.mjs:~175` `sqlOrdonantatAnCurent` | `EXTRACT(YEAR FROM NOW())::int` | sumă ordonanțată an → plafon |
| 3 | `routes/alop.mjs:~1988` | `new Date().getFullYear()` | plafon ordonanțare/plată |
| 4 | `services/formular-shared.mjs:344` `computeOrdBudgetContext` | `new Date().getFullYear()` | context plafon ORD |

⚠️ `alop.mjs` a fost marcat „read-only" într-un task anterior — de aceea există
`sqlCrediteBugetareCol10Admin` ca **copie verbatim** în `admin/flows.mjs`. **În lotul ăsta
`alop.mjs` se deschide**, decizie explicită a lui Mircea. Copia din `admin/flows.mjs` **rămâne
cum e** — consolidarea ei e alt lot, nu se strecoară aici.

---

# ETAPA 0 — ancore, ÎNAINTE de orice modificare

Raportează **valorile obținute**.

```bash
grep -n "EXTRACT(YEAR FROM NOW())" server/routes/alop.mjs
# Așteptat: liniile din sqlBandaRowsPlati (×2 în aceeași expresie) și sqlOrdonantatAnCurent

grep -n "new Date().getFullYear()" server/routes/alop.mjs server/services/formular-shared.mjs
# Așteptat: 1 + 1

grep -n "^export function" server/services/buget-an.mjs
# Așteptat: bandaPentruOffset, bugetPentruAnul, crediteBugetareAnCurent

grep -rn "crediteBugetareAnCurent" server --include=*.mjs | grep -v "^server/tests/"
# Așteptat: definiția + 2 importuri + 2 comentarii

grep -n "sqlBugetAnExercitiu\|sqlRamasAnExercitiu\|sqlOrdonantatAnCurent\|sqlBandaRowsPlati" server/routes/alop.mjs
# Așteptat: definițiile + apelurile de la ~506, ~796, ~798

grep -rn "EXTRACT(YEAR FROM NOW())\|getFullYear()" server --include=*.mjs | grep -v "^server/tests/"
# ⭐ Inventarul COMPLET. Dacă apare un al cincilea loc de an de exercițiu pe care tabelul
#   de mai sus nu-l enumeră, RAPORTEAZĂ-L ÎNAINTE de a scrie o linie — nu-l repara tăcut.
#   (admin/flows.mjs a fost deja rezolvat la #203 prin `?an=` — nu intră aici.)
```

---

# ETAPA A — `anExercitiuCurent()` în `buget-an.mjs`

`buget-an.mjs` e declarat **PUR, fără I/O** în antet. Funcția asta citește ceasul, deci nu e
pură în sens strict. E în regulă că stă aici — e locul unde trăiește semantica anului de
exercițiu — dar **antetul fișierului trebuie actualizat** ca să nu mintă: spune că restul e pur
și că `anExercitiuCurent()` e singura excepție, deliberată.

```js
/**
 * Anul de exercițiu curent al sistemului. SURSĂ UNICĂ (#204).
 *
 * ⛔ Valoarea NU vine niciodată dintr-o cerere HTTP. Locurile care o folosesc alimentează
 *    PORȚI DE SCRIERE (plafon ordonanțare/plată, baza cardului ALOP); dacă anul ar fi
 *    parametru de cerere, un client care trimite an=2025 ar primi alt plafon, tăcut.
 *    Vezi tests/unit/an-nu-din-cerere.test.mjs (#203), care apără regula.
 *
 * Rapoartele READ-ONLY sunt altceva: acolo anul VINE de la utilizator prin `?an=`
 * (/api/clasa8, /admin/alop/stats — #203). Nu confunda cele două.
 *
 * Azi = anul calendaristic. Aici se va schimba când apare revizia de început de an
 * (fereastra primelor 3 zile lucrătoare din ianuarie, în care exercițiul curent al unui
 * dosar poate fi încă anul precedent). ACESTA e motivul pentru care funcția există.
 */
export function anExercitiuCurent() {
  return new Date().getFullYear();
}
```

---

# ETAPA B — locurile 3 și 4 (JS simplu)

Trivial. `import { anExercitiuCurent }` (în `alop.mjs` se adaugă la importul existent din
`buget-an.mjs`, linia ~33) și:

- `alop.mjs:~1988`: `const anExercitiu = anExercitiuCurent();`
- `formular-shared.mjs:344`: `const anExercitiu = anExercitiuCurent();`

⚠️ În `alop.mjs:~1988`, `anExercitiu` e declarat dar verifică dacă e chiar **folosit** mai jos
în handler. Dacă e o variabilă moartă, **spune-o în raport, nu o șterge** — ștergerea e altă
schimbare decât consolidarea și o decidem separat.

---

# ETAPA C — locurile 1 și 2 (fragmente SQL) — partea delicată

## C.1 — De ce aici interpolăm, deși la #203 am interzis-o

La #203 regula a fost: `an` **legat ca parametru, niciodată interpolat**. Motivul era că acolo
anul venea din `req.query`.

Aici nu poate veni din cerere — prin construcție, și cu un test care o apără. Iar alternativa
(legarea ca `$N`) ar însemna ca `sqlBandaRowsPlati` și `sqlOrdonantatAnCurent` să primească
indicele parametrului, deci apelanții de la `~506` și `~796` — **cele două handlere care
randează lista ALOP** — să-și modifice array-ul de parametri. Asta e exact tipul de atingere
care regresează tăcut, pe cel mai circulat ecran din aplicație, pentru un câștig de securitate
egal cu zero.

Deci: **interpolăm, dar cu o gardă care face interpolarea demonstrabil sigură.**

```js
/** Emite un literal SQL întreg pentru anul de exercițiu. Gardă: #204. */
function sqlAn(an) {
  if (!Number.isInteger(an)) {
    throw new Error(`sqlAn: an de exercițiu invalid (${an}). Sursa unică e anExercitiuCurent().`);
  }
  return String(an);
}
```

Garda nu e decor: e ce transformă „interpolăm un număr" în „interpolăm un întreg dovedit".
Testul C.4 o verifică.

## C.2 — `sqlBandaRowsPlati(df)` → `sqlBandaRowsPlati(df, an)`

Azi:
```js
  const off = `(EXTRACT(YEAR FROM NOW())::int - COALESCE(${df}.an_referinta, EXTRACT(YEAR FROM NOW())::int))`;
```

Devine `(${sqlAn(an)} - COALESCE(${df}.an_referinta, ${sqlAn(an)}))`.

⚠️ Anul apare de **două ori** în aceeași expresie. Ambele se înlocuiesc. Dacă una rămâne
`EXTRACT(YEAR FROM NOW())`, rezultatul e identic azi și **divergent în ianuarie** — bugul
perfect: invizibil la testare, apare exact când contează.

⚠️ Comentariul de deasupra spune că banda e **SINCRONIZATĂ MANUAL** cu `bandaPentruOffset()`.
**Păstrează-l** — rămâne adevărat, offset-ul se calculează în continuare în două limbi.

## C.3 — `sqlOrdonantatAnCurent(a)` → `sqlOrdonantatAnCurent(a, an)`

Un singur `EXTRACT(YEAR FROM NOW())::int`, în `COALESCE(c_re.an_exercitiu, EXTRACT(YEAR FROM
c_re.plata_data)::int, EXTRACT(YEAR FROM c_re.created_at)::int) = …`.

⛔ Se înlocuiește **DOAR partea dreaptă** a egalității. Cele două `EXTRACT(YEAR FROM
c_re.plata_data)` / `c_re.created_at` sunt **fallback-uri pe coloane**, nu ceasul serverului —
rămân **exact cum sunt**. Confundarea lor ar rupe ordinea de fallback din mig. 086.

## C.4 — lanțul de apelanți

`sqlBandaRowsPlati` e chemat din `sqlBugetAnExercitiu(df)`; `sqlOrdonantatAnCurent` din
`sqlRamasAnExercitiu(df, a)`. Ambele wrappere primesc `an` și îl pasează. Cele trei call-site-uri
finale (`~506`, `~796`, `~798`) trimit `anExercitiuCurent()`.

⛔ **Fără valoare implicită pe parametrul `an`** în vreuna dintre cele patru funcții. Un
`an = anExercitiuCurent()` implicit ar face ca un apelant viitor care uită parametrul să treacă
tăcut — adică exact tipul de tăcere pe care lotul o elimină. Vrem să crape.

---

# ETAPA D — `crediteBugetareAnCurent` → `crediteBugetareCol10`

Numele minte: funcția nu primește și nu folosește niciun an, doar sumează
`sum_rezv_crdt_bug_act` peste `rows_ctrl`. Într-un lot despre disciplina anului de exercițiu,
un nume care sugerează filtrare pe an e o capcană pentru următorul cititor.

Redenumire pură: definiția (`buget-an.mjs:72`), cele două importuri
(`formular-shared.mjs:21`, `alop.mjs:33`), cele două utilizări (`formular-shared.mjs:382`,
`alop.mjs:1993`), plus cele două comentarii care o citează pe nume.

⛔ **Fără alias de compatibilitate.** Un `export { crediteBugetareCol10 as crediteBugetareAnCurent }`
ar păstra exact numele mincinos pe care îl eliminăm. Toți apelanții sunt în repo; se redenumesc.

Verificare: `grep -rn "crediteBugetareAnCurent" server` ⇒ **0 rezultate**, inclusiv în teste.
Testele care o cheamă pe nume vechi se actualizează — e o redenumire, nu o schimbare de
aserțiune; treci în raport care fișiere de test au fost atinse și de ce.

---

# ETAPA E — corectura skill-ului `docflowai-ui`

`.claude/skills/docflowai-ui/SKILL.md` cere azi bump de `CACHE_VERSION` la **orice** modificare
frontend (linia ~218 + punctul 11 din checklist). Convenția reală din `CLAUDE.md`
(§„Cache busting", ~1044) e condiționată. Divergența a apărut la #203 și a fost rezolvată
corect atunci; lăsată așa, se repetă la fiecare lot cu `public/`.

Corectura, aliniată la `CLAUDE.md`:
- `CACHE_VERSION` se bumpează **doar dacă** un fișier din `PRECACHE_ASSETS` (`public/sw.js`) s-a
  schimbat.
- `?v=` **țintit**, doar pe asset-urile efectiv atinse. Fără `sed` în masă.
- `package.json` se bumpează la orice lot livrabil, ca până acum.

Ambele locuri din skill. ⛔ Nu rescrie restul skill-ului.

---

# ETAPA F — teste

## F.1 — `server/tests/unit/an-exercitiu-sursa-unica.test.mjs` (nou)

1. `anExercitiuCurent()` === `new Date().getFullYear()`.
2. ⭐ `sqlAn` aruncă pentru `'2026'`, `2026.5`, `null`, `undefined`, `NaN`, `[2026]`; acceptă `2026`.
3. ⭐ **Inventar**: `routes/alop.mjs` și `services/formular-shared.mjs` nu mai conțin
   `EXTRACT(YEAR FROM NOW())` și nici `new Date().getFullYear()`.
   ⚠️ Fallback-urile `EXTRACT(YEAR FROM c_re.plata_data)` / `c_re.created_at` **trebuie să
   rămână** — testul verifică explicit că sunt încă acolo. Altfel „curățarea" ar trece cu
   fallback-urile șterse.
4. `sqlBandaRowsPlati(df, 2026)` conține `2026` de **două** ori și zero `EXTRACT(YEAR FROM NOW())`.
5. `crediteBugetareAnCurent` nu mai există ca export; `crediteBugetareCol10` da.

## F.2 — `server/tests/db/an-exercitiu-neregresie.test.mjs` (nou) ⭐ testul care contează

Pe bază reală, cu DF-uri având `an_referinta` **diferit** de anul curent (offset `-1`, `0`, `+1`),
ca banda să fie efectiv exercitată, nu doar ramura `offset = 0`:

6. ⭐ Lista ALOP (`~506`) — `df_buget_an_curent` **identic** cu valoarea produsă de expresia
   pre-lot, rulată live în același test.
7. ⭐ Lista ALOP (`~796`/`~798`) — `df_buget_an_curent` și `ramas_an_curent` identice.
8. ⭐ Cu bifa „Stingere" activă (ramura `sqlTabel1`) — identic.
9. Plafonul de ordonanțare/plată (`~1988`) — identic.
10. `computeOrdBudgetContext` — identic.

Tiparul de la #202/#203: **rulezi expresia veche live în test** și compari, nu compari cu
constante scrise de mână.

## F.3 — poarta de la #203

`server/tests/unit/an-nu-din-cerere.test.mjs` **trebuie să treacă în continuare**, neatins.
Dacă pică, înseamnă că lotul a introdus o cale prin care anul ajunge din cerere în porțile de
scriere — **oprește-te imediat și raportează**.

## F.4

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** ⚠️ Verdictul se citește din **output-ul real** (prim-plan sau fișierul de log
scris de rulare), **niciodată dintr-un sumar de fundal** — la #202 au livrat de trei ori cifre
fantomă. `skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Excepție: testele care
cheamă `crediteBugetareAnCurent` pe nume — acolo redenumești (Etapa D) și treci în raport.

---

# ETAPA G — versiune și commit

```bash
npm version 3.9.857 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**Zero fișiere din `public/`** ⇒ `CACHE_VERSION` neatins, `?v=` neatins. Verifică, nu presupune —
e chiar regula pe care o corectezi la Etapa E.

`git add` **explicit**. **Niciodată `git add -A`.**

Arhivează promptul: `docs/archive/PROMPT-204-an-exercitiu-sursa-unica.md`, în **același commit**.

```
refactor(#204): anExercitiuCurent() — sursa unica pentru anul portilor de scriere — v3.9.857

Patru locuri derivau anul de exercitiu din ceasul serverului: sqlBandaRowsPlati
(x2 in aceeasi expresie), sqlOrdonantatAnCurent, plafonul din alop.mjs si
computeOrdBudgetContext. Toate alimenteaza PORTI DE SCRIERE, deci anul lor NU
vine din cerere (#203, tests/unit/an-nu-din-cerere). Problema nu era ca pot fi
suprascrise, ci ca erau patru.

Conteaza la revizia de inceput de an: in fereastra primelor 3 zile lucratoare
din ianuarie, exercitiul curent al unui dosar poate fi inca anul precedent.
Atunci se schimba UN loc, nu patru.

In fragmentele SQL anul se interpoleaza ca literal, prin garda sqlAn() care
arunca pe orice nu e intreg. Legarea ca $N ar fi cerut modificarea array-ului
de parametri in cele doua handlere care randeaza lista ALOP, pentru un castig
de securitate nul: aici anul nu poate veni din cerere prin constructie.

crediteBugetareAnCurent → crediteBugetareCol10: numele mintea, functia nu
primeste niciun an. Fara alias de compatibilitate.

Skill docflowai-ui aliniat la CLAUDE.md: CACHE_VERSION doar daca s-a schimbat
un fisier din PRECACHE_ASSETS.

Zero schimbare de comportament — ancorat de db/an-exercitiu-neregresie.
alop.mjs deschis deliberat; copia sqlCrediteBugetareCol10Admin din
admin/flows.mjs ramane neatinsa (alt lot).
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**. ⭐ În special inventarul complet: a apărut vreun
   al cincilea loc?
2. Confirmarea că **ambele** apariții din `sqlBandaRowsPlati` au fost înlocuite.
3. ⭐ Confirmarea că fallback-urile `plata_data` / `created_at` din `sqlOrdonantatAnCurent` sunt
   **neatinse**, cu diff-ul liniei.
4. Dacă `anExercitiu` din `alop.mjs:~1988` e variabilă folosită sau moartă. (Nu o șterge.)
5. Confirmarea că **niciuna** dintre cele patru funcții nu are implicit pe `an`.
6. `grep -rn "crediteBugetareAnCurent" server` ⇒ așteptat **0**.
7. Rezultatul fiecărui test din F.1 și F.2, **în special 3, 6, 7, 8**.
8. ⭐ Că `an-nu-din-cerere.test.mjs` (#203) trece **neatins**.
9. Cele două locuri corectate în skill, cu diff.
10. Numere reale `npm test` / `npm run test:db`, secvențial, cu sursa verdictului declarată
    explicit (prim-plan sau fișier de log — **nu** sumar de fundal).
11. Teste preexistente atinse, cu motiv. (Așteptat: doar redenumirea din Etapa D.)
12. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
13. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- **Nicio cifră nu se mișcă.** Dacă F.2 arată o diferență ⇒ **OPREȘTE-TE**.
- Fallback-urile `plata_data` / `created_at`: **NEATINSE**.
- Fără implicit pe parametrul `an`. Fără alias pentru numele vechi.
- `sqlCrediteBugetareCol10Admin` din `admin/flows.mjs`: **NEATINSĂ**.
- `cod-ssi-validate.mjs`, `loadBugetCodes()`, zona NO-TOUCH: **neatinse**.
- Zero fișiere din `public/`.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
