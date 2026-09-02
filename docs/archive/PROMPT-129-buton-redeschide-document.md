# PROMPT #129 — buton „Redeschide document" pentru DF și ORD (+ garda lipsă pe ORD)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Opus 5 — lotul atinge mașina de stări a unui document financiar și adaugă
un refuz nou pe server.
**Target versiune:** `v3.9.777` (de la 3.9.776 — **citește `package.json`**) · **Migrații:** ZERO

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## 1. Cererea și starea de fapt

Pe un DF sau ORD `completed` (P2 a finalizat) care **nu** e pe flux, P1 sau adminul n-au nicio
cale în interfață să redeschidă documentul. Singurele alternative azi: returnarea de către
Responsabilul CAB, sau `UPDATE` direct în bază.

Verificat pe cod:

- funcția frontend **există** — `resetDocToP1(ft)` (`public/js/formular/doc.js:1853`), expusă pe
  `window` la `:2077`, cu **ZERO apelanți**. E cod mort rămas după refactorul acțiunilor;
- serverul e pregătit pe **ambele** rute: `df.mjs:381` și `ord.mjs:363` resetează
  `status='draft'`, `version+1`, `completed_at=NULL`, `submitted_at=NULL` la un PUT făcut de
  P1/admin pe un document `completed`;
- evenimentul de audit există deja (`eventType: 'revizuit'`, `completed` → `draft`,
  `ord.mjs:451`) ⇒ **nu inventa un tip de eveniment nou**; verifică doar că DF-ul are
  echivalentul și raportează dacă lipsește.

## 2. ⚠️ Ce trebuie reparat ÎNAINTE de a expune butonul

Ramura de redeschidere din `ord.mjs:363` verifică **doar** `doc.status === 'completed'`.

La DF asta e suficient: DF-ul **persistă** `transmis_flux` la legarea de flux, deci un DF în
semnare cade pe ramura `document_locked`. **ORD-ul NU persistă `transmis_flux`** — rămâne
`completed` chiar cu un flux de semnare viu (invariantul cunoscut din asimetria DF/ORD).

⇒ Azi gaura e inaccesibilă fiindcă ruta n-are buton. **În momentul în care butonul apare, un
ORD aflat în semnare poate fi resetat la draft.** Garda se adaugă în ACELAȘI lot cu butonul,
nu după.

⛔ Nu „rezolva" asta ascunzând butonul în frontend. Un `disabled` în DOM nu e un control —
lecția SEC-100.2, scrisă chiar în `formular-shared.mjs:62`.

---

## 3. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/services/flow-provenance.mjs` — se **importă**, nu se modifică (sursă unică din #122)
⛔ Ramura `else if` de `document_locked` din ambele rute — neatinsă
⛔ `/revizuieste`, `/returneaza`, `/complete`, `/submit` — neatinse
⛔ Nicio migrație, niciun index
⛔ Zero refactorizări în trecere; ⛔ `confirm()` rămâne `confirm()`, nu-l muta pe modal

---

## 4. Etapa A — garda pe server (`server/routes/formulare/ord.mjs`)

### A.1 Recon obligatoriu, înainte de patch

```bash
grep -n "liveFlowSql\|validSignedFlowSql" server/services/flow-provenance.mjs
grep -n "flow-provenance" server/routes/formulare/ord.mjs
```

`flow-provenance.mjs` conține predicatele canonice introduse la #122 (exclud `cancelled`,
`refused`, `deleted_at IS NOT NULL`). **Citește semnătura reală a exportului** — dacă e o
funcție care întoarce SQL parametrizat, folosește-o exact așa cum o folosesc apelanții
existenți. ⛔ Nu rescrie predicatul de mână; e exact clasa de drift pe care #122 a închis-o.

Dacă `flow-provenance.mjs` nu exportă nimic direct utilizabil aici, **raportează** și oglindește
predicatul din `df.mjs:369-377` (blocul `semnat`), care e deja scris corect.

### A.2 Patch

`old_str`:
```js
    const extraSets = [];
    const extraVals = [];
    if ((isP1 || isAdmin) && doc.status === 'completed') {
      extraSets.push('status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL');
      extraVals.push('draft', doc.version + 1);
    } else if (isP1 && !['draft', 'returnat'].includes(doc.status)) {
```
`new_str`:
```js
    const extraSets = [];
    const extraVals = [];
    if ((isP1 || isAdmin) && doc.status === 'completed') {
      // #129 — ASIMETRIE DF/ORD, poarta care lipsea: DF-ul persistă `transmis_flux` la legarea
      // de flux, deci un DF în semnare cade pe ramura `document_locked` de mai jos. ORD-ul NU
      // persistă asta — rămâne `completed` chiar cu un flux VIU. Fără verificarea de aici,
      // butonul „Redeschide" ar putea reseta la draft un ORD aflat în semnare.
      // Predicatul de flux viu vine din flow-provenance.mjs (sursă unică, #122).
      if (doc.flow_id) {
        const { rows: fl } = await pool.query(
          `SELECT 1 FROM flows f WHERE f.id = $1 AND ${/* predicat flux VIU sau SEMNAT */ ''} LIMIT 1`,
          [doc.flow_id]
        );
        if (fl.length) {
          return res.status(409).json({
            error: 'document_pe_flux',
            message: 'Documentul are un flux de semnare activ sau finalizat. Anulați fluxul înainte de a-l redeschide.'
          });
        }
      }
      extraSets.push('status=$__', 'version=$__', 'completed_at=NULL', 'submitted_at=NULL');
      extraVals.push('draft', doc.version + 1);
    } else if (isP1 && !['draft', 'returnat'].includes(doc.status)) {
```

⚠️ Interogarea de mai sus e **schelet**: completează predicatul din ce ai găsit la A.1.
Trebuie să prindă **două** situații: flux încă VIU (în semnare) **și** flux DEJA SEMNAT
(documentul a ieșit din aplicație). Fluxurile `cancelled`, `refused` sau șterse **NU** blochează
— altfel un ORD cu un flux anulat ar rămâne blocat pentru totdeauna, regresie mai supărătoare
decât bug-ul.

⚠️ Poziția contează: garda stă **DUPĂ** `canEditFormular` (autorizarea), ca un actor
neîndreptățit să primească 403, nu 409 cu informație despre starea documentului. Scrie un caz
de test dedicat pentru poziție, ca un refactor viitor să n-o mute.

### A.3 DF — verifică, nu presupune

Citește `df.mjs:366-385`. Blocul `semnat` prinde fluxul **finalizat**, iar statusul
`transmis_flux` prinde fluxul **în curs**. **Confirmă în raport că ambele situații sunt
acoperite la DF.** Dacă găsești o fereastră descoperită (ex. `flow_id` setat dar status încă
`completed`), **raporteaz-o și repar-o simetric** — dar spune explicit că ai făcut-o.

---

## 5. Etapa B — capabilitatea (`server/services/formular-capabilities.mjs`)

Funcție **PURĂ**. ⛔ Fără DB, fără I/O.

### B.1 Adaugă în `emptyCaps()`, lângă `can_reset`:
```js
    can_reopen: false,
```

### B.2 Setează-o **înaintea** lanțului de scurtcircuit, imediat după `caps.can_export_xml`

Acolo e locul stabilit pentru flagurile independente de ramură (comentariul existent spune
exact asta: „Set ÎNAINTE de return-urile pe ramuri … deci e role-independent").

```js
  // #129 — „Redeschide document": P1 sau admin, pe un document finalizat de P2 care NU e pe
  // un flux activ și nu e aprobat. Oglindește EXACT poarta de pe server
  // (`(isP1 || isAdmin) && status === 'completed'`, plus garda de flux adăugată la #129):
  // dacă cele două diverg, butonul apare și dă 409, sau nu apare deși acțiunea e permisă.
  // Hint de AFIȘARE — ruta PUT re-verifică independent.
  caps.can_reopen = status === 'completed' && !aprobat && !onActiveFlow
    && (role === 'p1' || actor?.role === 'admin' || actor?.role === 'org_admin');
```

⚠️ `actor?.role` e prima citire a rolului de platformă din acest fișier. E corectă tocmai
fiindcă oglindește `isAdmin` de pe rută (`actor.role === 'admin' || actor.role === 'org_admin'`,
`ord.mjs:359`). **Verifică textul de acolo și copiază-l identic** — nu din memorie.

⛔ Nu atinge nicio altă capabilitate. Nu atinge ordinea ramurilor. Nu atinge ramura
de fallback de la finalul funcției.

### B.3 Teste (fișierul existent de capabilități)

1. ⭐ `completed` + rol p1 + fără flux activ ⇒ `can_reopen === true`.
2. ⭐ `completed` + rol p1 + `flow_active: true` ⇒ `can_reopen === false` (și `is_on_flow` rămâne
   true, ca azi).
3. `aprobat: true` ⇒ `can_reopen === false`, la orice rol.
4. `draft` / `pending_p2` / `returnat` / `transmis_flux` ⇒ `can_reopen === false`.
5. `completed` + rol p2 (simplu utilizator) ⇒ `can_reopen === false`.
6. ⭐ `completed` + actor cu `role: 'admin'` care NU e nici creator nici assignee ⇒
   `can_reopen === true`. Idem `org_admin`.
7. Non-regresie: pentru fiecare caz de mai sus, **toate celelalte capabilități rămân exact ce
   erau înainte de lot**. Dacă fișierul de test are deja un instantaneu al obiectului,
   extinde-l; dacă nu, adaugă cel puțin o aserțiune pe `can_generate_or_launch` și
   `can_export_xml`.

---

## 6. Etapa C — butonul (`public/js/formular/doc.js`, `renderActions`)

Butonul trebuie să apară pe **DF și ORD deopotrivă** — codul e comun, deci nu e nevoie de
ramificare pe `ft`. Confirmă asta în raport.

Sunt **DOUĂ** ramuri cu `return` timpuriu în care un document `completed` poate ateriza:

**C.1** — ramura `caps.can_generate_or_launch` (P1 pe document finalizat, fără flux). Adaugă
butonul lângă cel de generare/lansare:

```js
    const _reopen = caps.can_reopen ? B('','🔓 Redeschide document',`resetDocToP1('${ft}')`) : '';
```
și adaugă-l în `div.innerHTML` al ramurii, **după** butonul principal și **înainte** de `xmlBtn`.

**C.2** — ramura `caps.is_completed_p2` (aici ajunge un admin care e și `assigned_to`). Adaugă
același `_reopen` după mesajul „✅ Secțiunea ta este completată." și înainte de `xmlBtn`.

⚠️ În ambele ramuri, când `can_reopen` e false randarea trebuie să rămână **byte-identică** cu
cea de azi. Scrie asta ca aserțiune de test, nu ca intenție.

⛔ Nu adăuga butonul pe ramurile `is_on_flow`, `aprobat`, `is_historic_revision`,
`is_neaprobat`, `is_de_revizuit` — `can_reopen` e oricum false acolo, iar o randare
necondiționată ar fi un al doilea adevăr.

### C.3 Repară `resetDocToP1` — două defecte mici, ambele reale

**C.3.a — corpul PUT scrie un spațiu peste `cif`.** Azi:
```js
  const body=ft==='ordnt'?{cif:g('o-cif')||' '}:{cif:g('n-cif')||' '};
```
Dacă documentul are `cif` gol, fallback-ul `|| ' '` scrie **un spațiu** în coloană. Câmpul
„dummy" era necesar doar ca `buildUpdate` să aibă ceva de făcut.

**Verifică pe cod** dacă ruta PUT acceptă un corp gol: `buildUpdate` întoarce `sets=[]`, dar
`extraSets` conține deja resetul, deci `UPDATE` rămâne valid — **cu condiția** să nu existe
un guard de tip „`if (!sets.length) return 400`". Dacă nu există:
```js
  const body={};
```
Dacă există, păstrează câmpul dar **fără** fallback-ul care inventează un spațiu:
```js
  const body=ft==='ordnt'?{cif:g('o-cif')}:{cif:g('n-cif')};
```
**Spune în raport care variantă ai ales și de ce**, cu linia de cod care a decis.

**C.3.b — textul confirmării nu spune tot.** Înlocuiește:
```js
  if(!confirm('Documentul va fi resetat la draft și P2 va trebui să completeze din nou. Continuați?'))return;
```
cu:
```js
  if(!confirm('Documentul revine în lucru (draft), versiunea se incrementează, iar Responsabilul CAB va trebui să finalizeze din nou Secțiunea B. Datele completate se păstrează. Continuați?'))return;
```

**C.3.c — tratează refuzul nou.** În ramura de eroare din `resetDocToP1`, mesajul pentru
`j.error === 'document_pe_flux'` trebuie să folosească `j.message` (textul explicativ de pe
server), nu codul brut. Oglindește tiparul deja folosit în `completeAsP2` pentru
`rows_bloc_lipsa`.

### C.4 Teste — Etapa C

8. ⭐ `can_reopen: true` pe ramura `can_generate_or_launch` ⇒ HTML-ul conține
   `resetDocToP1('ordnt')` **și** `resetDocToP1('notafd')` pentru cele două tipuri.
9. ⭐ `can_reopen: false` ⇒ randarea celor două ramuri e **identică** cu cea de dinainte de lot.
10. `resetDocToP1` nu mai conține literalul `|| ' '`.

---

## 7. Etapa D — verificări de consecvență cerute, FĂRĂ cod

Răspunde în raport, cu linia de cod care susține fiecare răspuns. ⛔ **Nu modifica nimic pe
baza lor** — dacă ceva e greșit, raportează și lasă-l pentru un lot separat.

- **ALOP**: la redeschiderea unui DF/ORD `completed`, rămâne dosarul ALOP într-o stare
  coerentă? Un document doar `completed` (P2 finalizat) n-a ajuns pe flux, deci tranziția
  `angajare→lichidare` (care cere `df_flow_id`) n-a avut loc — **confirmă asta pe cod**, nu din
  raționament.
- **Atașamente și capturi**: supraviețuiesc resetului? (Nu se șterg nicăieri în ramura de
  reset — confirmă.)
- **`assigned_to`**: rămâne setat, deci documentul se poate retrimite aceluiași CAB?
- **DF**: are ruta PUT un `recordFormularAudit` pe ramura de reset, ca `ord.mjs:451`? Dacă
  **nu**, spune-o explicit — e o lipsă de urmă de audit pe o operație financiară și devine
  lotul următor.

---

## 8. Cache busting

Asset atins: `public/js/formular/doc.js`.
```bash
grep -n "formular/doc.js" public/sw.js
# Așteptat: nicio linie ⇒ FĂRĂ bump CACHE_VERSION
```
`?v=3.9.777` țintit **doar** pe `doc.js` (⚠️ `\1`, nu `\g<1>`; `grep` pe linia atinsă după `sed`).
⛔ `core.js`, `list.js`, `draft.js`, `semdoc-initiator/main.js` NU se ating.

---

## 9. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` e **obligatoriu** — Etapa A adaugă un refuz pe o rută
vie, iar mock-urile poziționale nu-l pot dovedi (a șasea oară când o spunem). Rețeta PG 17
efemer, instanță **proaspătă**, e în `CLAUDE.md`.

Bump la `3.9.777`;
`git commit -m "feat(#129): buton Redeschide document pentru DF si ORD + garda flux pe reset ORD"`;
`git push origin develop`.

---

## 10. Verificări de ieșire (verbatim în raport)

```bash
# 1 — garda nouă pe ORD
grep -n "document_pe_flux" server/routes/formulare/ord.mjs public/js/formular/doc.js

# 2 — predicatul vine din sursa unică, nu rescris de mână
grep -n "flow-provenance" server/routes/formulare/ord.mjs

# 3 — capabilitatea nouă, o singură dată, înaintea scurtcircuitelor
grep -n "can_reopen" server/services/formular-capabilities.mjs public/js/formular/doc.js

# 4 — funcția moartă are acum apelanți
grep -c "resetDocToP1" public/js/formular/doc.js
# Raportează valoarea; înainte de lot era 2 (definiție + export pe window)

# 5 — fallback-ul care scria un spațiu a dispărut
grep -n "|| ' '" public/js/formular/doc.js
# Așteptat: nicio linie pe resetDocToP1

# 6 — zone neatinse
git status --short server/services/flow-provenance.mjs server/routes/flows/
# Așteptat: nicio linie

# 7 — scopul lotului
git status --short
# ⚠️ working tree-ul are fișiere netrackate din sesiuni vechi — confirmă EXPLICIT că ai
# stage-uit doar căile sarcinii

# 8 — ?v= țintit
grep -on "formular/\(core\|doc\|list\|draft\)\.js?v=[0-9.]*" public/formular.html
```

---

## 11. RAPORT FINAL

- commit hash + push confirmat; versiunea din `package.json`; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE** (fișiere, passed, failed, skipped)
- ieșirea celor 8 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 2, 6, 8 și 9**, menționate separat
- **predicatul exact** pe care l-ai folosit la A.2, copiat din cod, plus de unde l-ai luat
- răspunsul la A.3: e DF-ul acoperit pe ambele situații (flux viu / flux semnat)? Cu liniile
- ce variantă ai ales la C.3.a (`{}` vs `{cif}`) și **care linie de cod a decis**
- confirmarea că butonul apare identic pe DF și ORD, fără ramificare pe `ft`
- confirmarea că, la `can_reopen: false`, randarea celor două ramuri e byte-identică
- cele patru răspunsuri de la Etapa D, fiecare cu linia care îl susține
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 12. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ Zero migrații, zero `CACHE_VERSION`, zero fișiere din `server/routes/flows/`.
⛔ Garda de pe ORD e OBLIGATORIE în acest lot — butonul fără ea e o regresie de integritate.
⛔ Garda stă DUPĂ autorizare (403 înaintea lui 409).
⛔ Fluxurile `cancelled` / `refused` / șterse NU blochează redeschiderea.
⛔ `flow-provenance.mjs` se importă, nu se modifică.
⛔ Zero tipuri noi de eveniment de audit — `'revizuit'` există deja.
⛔ La `can_reopen: false`, interfața rămâne byte-identică.
⛔ Zero refactorizări în trecere.
