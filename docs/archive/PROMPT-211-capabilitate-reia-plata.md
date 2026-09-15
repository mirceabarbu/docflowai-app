---
prompt: 211
titlu: "can_reia_plata aliniat la poarta rutei + plasă împotriva divergenței capabilitate ↔ rută"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: v3.9.863
versiune_tinta: v3.9.864
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: NU  (⇒ FĂRĂ `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
tip: corectură de afișare (o capabilitate) + test de echivalență
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL — al treilea caz al aceluiași tipar

#209 a pus poarta pe `isCabDept`. #210 a lărgit-o la `admin OR org_admin OR isCabDept` în **două**
locuri: poarta rutei de acceptare OPME și `can_accept` din raportul OPME. Poarta rutei de reluare
(`alop.mjs:~2007`) a fost și ea lărgită.

**Al treilea loc a fost ratat.** `server/services/alop-capabilities.mjs:83`:

```js
caps.can_reia_plata = caps.is_cab && caps.is_completed && !caps.is_cancelled
  && !!alop.plata_confirmed_at;
```

`caps.is_cab` e pur și simplu `isCabDept(actorComp, cabComp)` (`:77`). Un utilizator `admin`
**nu vede butonul „Reia confirmarea plății"** pe ecranul ALOP, deși ruta l-ar accepta după #210.

Observat în producție (15.09.2026) pe ALOP 8836: ruta acceptă, interfața nu oferă cum s-o chemi.

## De ce contează tiparul, nu doar bugul

E a treia oară în două loturi când **poarta rutei și capabilitatea afișată diverg**:
1. #209 → `can_accept` lipsea adminul (reparat la #210)
2. #210 → `can_reia_plata` lipsea adminul (lotul ăsta)

Modul de eșec e mereu același și mereu tăcut: butonul nu apare, nimic nu dă eroare, utilizatorul
crede că funcționalitatea nu există. Lotul repară cazul **și pune o plasă**.

---

# ETAPA 0 — ancore

```bash
grep -n "caps\.can_[a-z_]* *=" server/services/alop-capabilities.mjs
# Așteptat: can_refresh, can_start_noua_ordonantare, can_revise_df, can_reia_plata, can_delete
# ⭐ can_reia_plata e SINGURA pe caps.is_cab. Confirmă — dacă apare alta, RAPORTEAZĂ.

grep -n "caps.is_cab\b" server/services/alop-capabilities.mjs
grep -n "isAdminLike" server/routes/opme.mjs server/routes/alop.mjs
# Regula introdusă la #210. O refolosim IDENTIC.

grep -n "computeAlopCapabilities" server/routes/alop.mjs
# Ce primește în `actor`? ⭐ Are `role` și `orgId` disponibile acolo? Verifică, nu presupune —
# dacă `actor` e un obiect redus, RAPORTEAZĂ înainte de a scrie.

grep -rn "can_reia_plata" public/js --include=*.js
# Așteptat: alop.js:~790-793 (randarea butonului). Frontendul NU se atinge.
```

---

# ETAPA A — corectura

`server/services/alop-capabilities.mjs`, linia ~83.

`old_str`:
```js
  caps.can_reia_plata = caps.is_cab && caps.is_completed && !caps.is_cancelled
    && !!alop.plata_confirmed_at;
```
`new_str`:
```js
  // #211 — aceeași regulă ca poarta rutei POST /api/alop/:id/plata/reia după #210:
  // admin OR (org_admin cu orgId) OR isCabDept. Înainte era doar `caps.is_cab`, deci un
  // utilizator `admin` nu vedea butonul deși ruta îl accepta — al treilea caz al aceluiași
  // tipar (vezi și can_accept din opme.mjs, reparat la #210).
  // ⚠️ Dacă poarta rutei se schimbă, SE SCHIMBĂ ȘI AICI. Testul de echivalență o apără.
  const _isAdminLike = actor?.role === 'admin' || (actor?.role === 'org_admin' && !!actor?.orgId);
  caps.can_reia_plata = (caps.is_cab || _isAdminLike) && caps.is_completed && !caps.is_cancelled
    && !!alop.plata_confirmed_at;
```

⚠️ Verifică numele real al parametrului cu actorul în `computeAlopCapabilities` (`:10`) și
folosește-l pe acela. Dacă `actor` poate fi `undefined` în vreun apel, opționalele `?.` de mai sus
acoperă cazul — dar confirmă în raport că ai verificat.

⛔ **Restul capabilităților rămân EXACT cum sunt.** `can_refresh`, `can_start_noua_ordonantare`,
`can_revise_df`, `can_delete` nu se ating — niciuna nu e pe `is_cab`, iar `is_owner` e altă
întrebare. Lărgirea lor n-a fost cerută și n-ar avea justificare.

⛔ **Poarta rutei nu se atinge.** A fost deja corectată la #210. Lotul aliniază **afișarea** la
ea, nu invers. `git diff` pe `alop.mjs` la ruta `/plata/reia`: **gol**.

⛔ **Frontendul nu se atinge.** `alop.js` randează deja butonul din `caps.can_reia_plata`. Zero
fișiere din `public/`.

---

# ⭐ ETAPA B — plasa împotriva divergenței

Scopul: să nu mai existe un al patrulea caz.

`server/tests/db/capabilitati-vs-porti.test.mjs` (nou). Pentru fiecare rol din matrice —
`admin`, `org_admin` (cu orgId), `cab_dept`, inspector obișnuit, inițiator necab — pe un ALOP
`completed` cu plată confirmată în ciclul curent:

1. ⭐ Citește `capabilities.can_reia_plata` din `GET /api/alop/:id`.
2. ⭐ Cheamă efectiv `POST /api/alop/:id/plata/reia` cu motiv valid.
3. ⭐ **Verdictele trebuie să coincidă**: `can_reia_plata === true` ⟺ ruta **nu** întoarce 403.

⚠️ Ruta face o scriere. Ca testul să fie repetabil, fiecare rol primește **propriul ALOP** seedat
identic, sau starea se reface între cazuri. **Nu** rula toate rolurile pe același dosar — al
doilea ar primi `409 nu_e_confirmata` și testul ar măsura altceva decât autorizarea.

⚠️ Mesajul de eșec trebuie să spună **ce** a divergut: „`can_reia_plata` spune X pentru rolul R,
dar ruta a răspuns Y — capabilitatea afișată și poarta rutei trebuie să dea același verdict
(#211)". Fără asta, cine îl vede peste un an nu știe de ce există testul.

4. Același tipar pentru perechea din OPME: `can_accept` din `GET /api/opme/imports/:id` față de
   `POST /api/opme/lines/:id/accept`. Dacă testul din #210 acoperă deja asta, **spune-o în raport
   și nu-l duplica** — trimite la el din comentariu.

---

# ETAPA C — teste de comportament

`server/tests/db/reia-plata-capabilitate.test.mjs` (nou) sau extins pe cel existent:

5. ⭐ `admin` pe ALOP completed cu plată confirmată ⇒ `can_reia_plata: true`.
6. ⭐ `org_admin` cu orgId ⇒ `true`.
7. `cab_dept` ⇒ `true` (neregresie #209).
8. ⭐ Inspector obișnuit ⇒ `false`.
9. Inițiator care nu e CAB ⇒ `false`.
10. `org_admin` **fără** orgId ⇒ `false`.
11. ⭐ `admin` pe ALOP **fără** plată confirmată ⇒ `false` (condiția `plata_confirmed_at` rămâne).
12. ⭐ `admin` pe ALOP **anulat** ⇒ `false` (condiția `!is_cancelled` rămâne).
13. `admin` pe ALOP în stare `plata`, necompletat ⇒ `false` (condiția `is_completed` rămâne).

⭐ Testele 11–13 sunt cele care contează la fel de mult ca 5: lărgirea de rol **nu** are voie să
slăbească celelalte trei condiții.

## C.1

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Probabil: teste din #209
care afirmă `can_reia_plata: false` pentru admin. Acelea **descriau comportamentul vechi** — se
actualizează, cu diff în raport.

---

# ETAPA D — versiune și commit

```bash
npm version 3.9.864 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**Zero fișiere din `public/`** ⇒ `CACHE_VERSION` și `?v=` neatinse. Verifică.

`git add` explicit. Arhivează promptul în `docs/archive/`, în același commit.

Dacă `docs/plati-transe-conturi-diferite.md` există acum în repo, adaugă la calea A nota:
**dosarul trebuie să fie în starea „plată" ca să apară în lista din dialogul de acceptare; dacă e
deja închis, reia întâi confirmarea.** (Dialogul filtrează pe `/api/alop?status=plata`, iar
mesajul „Selectați dosarul ALOP" nu explică de ce lipsește dosarul căutat.)

```
fix(#211): can_reia_plata aliniat la poarta rutei — v3.9.864

#210 a largit poarta rutei POST /api/alop/:id/plata/reia la admin/org_admin,
dar capabilitatea de AFISARE din alop-capabilities.mjs:83 a ramas pe
caps.is_cab. Consecinta in productie: un utilizator `admin` nu vedea butonul
„Reia confirmarea platii", desi ruta l-ar fi acceptat.

Al treilea caz al aceluiasi tipar (dupa can_accept, reparat la #210): poarta
rutei si capabilitatea afisata diverg, butonul nu apare, nimic nu da eroare.
De aceea lotul adauga si un test de echivalenta pe toata matricea de roluri.

NEATINSE: celelalte capabilitati (niciuna nu e pe is_cab), poarta rutei (deja
corecta), frontendul (randeaza din caps). Conditiile is_completed,
!is_cancelled si plata_confirmed_at raman — testele 11-13 le apara.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**. ⭐ Confirmarea că `can_reia_plata` e singura
   capabilitate pe `caps.is_cab`.
2. ⭐ Ce conține `actor` în `computeAlopCapabilities` — are `role` și `orgId`? Cum ai verificat?
3. ⭐ Regula din Etapa A, comparată literal cu poarta rutei din `alop.mjs` — confirmă că sunt
   identice.
4. ⭐ `git diff` pe ruta `/plata/reia` și pe `public/` — așteptat **gol** la ambele.
5. Cum ai făcut testul din Etapa B repetabil (ALOP per rol / refacerea stării).
6. Dacă perechea OPME era deja acoperită de #210 sau ai adăugat-o.
7. Rezultatul fiecărui test, **în special 3, 5, 8, 11, 12, 13**.
8. Teste preexistente atinse, cu diff și motiv.
9. Numere reale, secvențial, cu sursa verdictului declarată.
10. Dacă documentul din `docs/` era prezent și ce ai adăugat.
11. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
12. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- Regula: `(is_cab || admin || org_admin-cu-orgId)`, **identică** cu poarta rutei. Nimic mai larg.
- Condițiile `is_completed`, `!is_cancelled`, `plata_confirmed_at`: **neatinse**.
- Celelalte capabilități: **neatinse**.
- Poarta rutei `/plata/reia`: **neatinsă** (corectată la #210).
- Zero fișiere din `public/`.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
