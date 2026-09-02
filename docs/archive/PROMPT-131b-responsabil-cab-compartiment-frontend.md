# PROMPT #131b — Responsabil CAB pe COMPARTIMENT (frontend) + filtrul lipsă de utilizatori activi

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 5 · **Target versiune:** `v3.9.780` (**citește `package.json`**)
**Migrații:** ZERO · **Depinde de:** #131a (`8e8555b`), care a livrat backendul complet

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## 1. Ce livrează lotul

#131a a pus tot backendul: coloana `p2_compartiment`, `POST /submit` acceptă `assigned_comp`,
authz-ul recunoaște membrul compartimentului ca `p2_comp`, listele îl arată și îl fac vizibil.
**Calea e inaccesibilă din interfață** — asta se deschide acum.

Modalul „Selectează Responsabilul Buget" primește două moduri:

- **Persoană** (implicit, comportamentul de azi, byte-identic);
- **Compartiment** — orice membru al compartimentului ales poate completa Secțiunea B.

Plus o reparație găsită la #131a, în același modal.

---

## 2. Etapa A — filtrul lipsă de utilizatori activi (server, 1 linie)

`GET /api/formulare/utilizatori-org` (`server/routes/formulare/shared.mjs:357-368`) — sursa
listei din modal — filtrează doar `WHERE org_id=$1 AND id != $2`. **Nu exclude utilizatorii
soft-șterși** (migrația 067). ⇒ modalul îi listează azi, iar un document poate fi trimis unui
cont dezactivat.

Regula din #52 („utilizatorii dezactivați ies din toate dropdown-urile de semnatari și
destinatari") a ratat ruta asta.

`old_str`:
```js
       FROM users
       WHERE org_id=$1 AND id != $2
```
`new_str`:
```js
       FROM users
       -- #131b: exclude conturile dezactivate (soft-delete, migrația 067). Ruta asta scăpase
       -- de regula #52; fără filtru, modalul de Responsabil CAB listează conturi șterse, iar
       -- lista de compartimente derivată din ea (mai jos) ar oferi compartimente pe care
       -- `submitFormular` le respinge cu `compartiment_fara_membri`.
       WHERE org_id=$1 AND id != $2 AND deleted_at IS NULL
```

⚠️ Acesta e **același predicat** pe care #131a l-a folosit la validarea compartimentului
(`deleted_at IS NULL`) ⇒ clientul nu poate oferi un compartiment pe care serverul îl refuză.
Alinierea e chiar motivul pentru care reparația intră aici, nu într-un lot de igienă.

⛔ Nu atinge `admin/users.mjs` în acest lot, deși are aceeași lipsă — e alt ecran, alt scop.
Menționeaz-o în raport.

**Teste:** un utilizator soft-șters nu apare în răspunsul rutei; unul activ apare.

---

## 3. Etapa B — modalul (`public/formular.html` + `public/js/formular/doc.js`)

### B.1 Comutatorul de mod

Deasupra căsuței de căutare, două butoane-radio (reutilizează stilul existent din proiect —
`.df-subtabs` sau perechea de `df-action-btn` cu unul `primary`; **citește ce există și
folosește**, ⛔ nu inventa componentă nouă):

```
[ Persoană ]  [ Compartiment ]
```

Starea trăiește în `ST.p2Mode` = `'user' | 'comp'`, implicit **`'user'`**.

⚠️ La comutare se golește selecția celuilalt mod (`ST.selectedP2Id = null`,
`ST.selectedP2Comp = null`) și se re-dezactivează butonul de confirmare. Fără asta, cineva
alege o persoană, comută pe compartiment, apasă Trimite — și pleacă persoana.
**Are caz de test dedicat.**

### B.2 Modul „Persoană"

**Byte-identic cu azi**: căutare, bifa „Doar din <compartiment>", badge-urile „alt
compartiment" / „În CO", `selectP2(id)`. ⛔ Zero modificări în `filterModalUsers`,
`_renderP2FilterToggle`, `selectP2`, în afara comutării de vizibilitate.
Scrie asta ca aserțiune de test, nu ca intenție.

### B.3 Modul „Compartiment"

Lista de compartimente se derivă **din `ST.orgUsers`**, nu dintr-o rută nouă:

```js
// #131b — compartimentele se derivă din utilizatorii activi ai organizației. Deliberat:
// lista oferită de client coincide EXACT cu ce acceptă `submitFormular` (compartiment cu cel
// puțin un utilizator activ), deci nu putem oferi o opțiune pe care serverul o respinge cu
// `compartiment_fara_membri`. O rută nouă ar fi introdus un al doilea adevăr.
function _p2Compartimente(){
  const m=new Map();
  (ST.orgUsers||[]).forEach(u=>{
    const c=(u.compartiment||'').trim();
    if(!c)return;
    const e=m.get(c)||{nume:c,total:0,disponibili:0};
    e.total++; if(!u.on_leave)e.disponibili++;
    m.set(c,e);
  });
  return [...m.values()].sort((a,b)=>a.nume.localeCompare(b.nume,'ro'));
}
```

⚠️ **Capcană**: `/api/formulare/utilizatori-org` exclude actorul însuși (`id != $2`). Deci dacă
inițiatorul e singurul din compartimentul X, X **nu apare** în listă. E corect din perspectiva
serverului? **NU** — `submitFormular` numără toți membrii activi, inclusiv inițiatorul, deci ar
accepta X. **Verifică pe cod și raportează divergența; ⛔ nu o repara tăcut într-o direcție sau
alta.** (Judecata mea: e un caz marginal — un compartiment cu un singur om, care e chiar
inițiatorul, n-are sens ca destinatar CAB. Dar vreau să fie o decizie, nu un accident.)

Randare, câte o linie per compartiment, în același `#modal-user-list`:
- numele compartimentului;
- sub el, `N membri` (și `· M disponibili` când `disponibili < total`);
- ⚠️ când `disponibili === 0`, marcaj vizual de avertizare („toți în concediu") — dar
  **selectabil**: serverul nu blochează pe concediu, iar un blocaj în UI ar fi al doilea adevăr.
  ⛔ Nu copia interdicția de la persoane (unde e corectă — acolo alegi un om anume).

Selecția: `selectP2Comp(nume)` → `ST.selectedP2Comp = nume`, activează butonul de confirmare.
Căsuța de căutare filtrează și aici, pe numele compartimentului.

⚠️ Bifa „Doar din <compartiment>" e a modului Persoană ⇒ **ascunde-o** în modul Compartiment.

### B.4 `confirmP2`

`old_str`:
```js
async function confirmP2(){
  if(!ST.selectedP2Id||!ST.pendingFt)return;
```
`new_str`:
```js
async function confirmP2(){
  // #131b — două ținte exclusive: o persoană SAU un compartiment. Backendul (#131a) respinge
  // cu `assigned_ambiguu` dacă primește ambele, deci trimitem exact una.
  const _peComp=ST.p2Mode==='comp';
  if(!ST.pendingFt)return;
  if(_peComp?!ST.selectedP2Comp:!ST.selectedP2Id)return;
```

Corpul cererii:
```js
      body:JSON.stringify(_peComp?{assigned_comp:ST.selectedP2Comp}:{assigned_to:ST.selectedP2Id}),
```

Mesajul de succes: pe calea compartiment, `Trimis la compartimentul ${ST.selectedP2Comp}.`
(pe calea persoană rămâne **exact** textul de azi, care citește `j.assigned_to`).

Tratarea erorilor noi din #131a, pe lângă `buget_an_curent_depasit` existent:
`assigned_ambiguu` și `compartiment_fara_membri` ⇒ afișează `j.message` când există, altfel
`j.error`. Oglindește tiparul deja folosit acolo.

---

## 4. Etapa C — coloana „Responsabil CAB" din listă (`public/js/formular/list.js`)

#131a întoarce deja **două** câmpuri: `p2` (numele persoanei SAU al compartimentului, prin
`COALESCE`) și `p2_compartiment` (non-null doar la atribuire pe compartiment).

⚠️ Folosește `p2_compartiment` ca discriminator, ⛔ **nu** ghici din textul lui `p2` —
un utilizator poate să se numească la fel ca un compartiment.

`old_str`:
```js
      <td>${esc(row.p2||'—')}</td>
```
`new_str`:
```js
      <td>${row.p2_compartiment
        ? `<span title="Atribuit întregului compartiment — oricine din el poate completa">👥 ${esc(row.p2_compartiment)}</span>`
        : esc(row.p2||'—')}</td>
```

⛔ Fără CSS nou. ⛔ Fără schimbări de lățime sau de antet — coloana rămâne cea de azi.

---

## 5. NO-TOUCH

⛔ `server/**` cu excepția UNEI linii din Etapa A
⛔ `formular-capabilities.mjs`, `authz-formular.mjs`, `submitFormular` — livrate la #131a
⛔ `filterModalUsers`, `selectP2`, `_renderP2FilterToggle` — logica lor internă rămâne
⛔ `admin/users.mjs`
⛔ Nicio migrație, nicio rută nouă
⛔ Zero refactorizări în trecere

---

## 6. Teste

1. ⭐ Comutarea pe „Compartiment" golește `ST.selectedP2Id` și dezactivează confirmarea;
   comutarea înapoi golește `ST.selectedP2Comp`. **Fără asta se trimite ținta greșită.**
2. ⭐ `confirmP2` în modul compartiment trimite corpul `{assigned_comp:'…'}` — **fără**
   `assigned_to` în obiect (nu doar `undefined`: verifică `!('assigned_to' in body)`).
3. ⭐ `confirmP2` în modul persoană trimite corp **identic** cu cel de azi.
4. `_p2Compartimente()` grupează corect, numără `total` și `disponibili`, ignoră compartimentele
   goale/spații, sortează cu `localeCompare(…,'ro')`.
5. Un compartiment cu toți membrii în concediu apare, marcat, și **rămâne selectabil**.
6. ⭐ Modul persoană: randarea listei e **byte-identică** cu cea de dinainte de lot (badge-uri
   „alt compartiment"/„În CO", ordinea, `selectP2`).
7. Bifa „Doar din <compartiment>" e ascunsă în modul compartiment, vizibilă în modul persoană.
8. ⭐ Coloana din listă: `p2_compartiment` setat ⇒ marcajul de compartiment; `p2_compartiment`
   null ⇒ **exact** `esc(row.p2||'—')`, ca azi. Inclusiv cazul în care o persoană se numește
   identic cu un compartiment (dovada că discriminatorul nu e textul).
9. Server: utilizatorul soft-șters lipsește din `/api/formulare/utilizatori-org`; cel activ e prezent.

---

## 7. Cache busting

Assete atinse: `public/formular.html`, `public/js/formular/doc.js`,
`public/js/formular/list.js`.
```bash
grep -n "formular/doc.js\|formular/list.js" public/sw.js
# Așteptat: nicio linie ⇒ FĂRĂ bump CACHE_VERSION
```
`?v=3.9.780` țintit pe `doc.js` și `list.js` (⚠️ `\1`, nu `\g<1>`; `grep` pe linia atinsă după
fiecare `sed`). ⛔ `core.js`, `draft.js`, `formular.css` NU se ating.

---

## 8. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` e obligatoriu **integral** de data asta: la #131a a rulat
doar parțial (2 fișiere / 23 teste), iar predicatele de vizibilitate atinse acolo sunt exact
cele pe care le lovește fiecare test de listare. **Dacă suita completă iese roșu, raportează
înainte de orice reparație — poate fi o regresie din #131a, nu din lotul ăsta.**
Instanță PG 17 efemeră **proaspătă** (migrația 108 trebuie să ruleze de la zero).

Bump; `git commit -m "feat(#131b): modal Responsabil CAB pe compartiment + filtru utilizatori activi"`;
`git push origin develop`.

---

## 9. Verificări de ieșire (verbatim în raport)

```bash
# 1 — filtrul de utilizatori activi
grep -n "deleted_at IS NULL" server/routes/formulare/shared.mjs

# 2 — modul și ținta
grep -n "p2Mode\|selectedP2Comp\|assigned_comp" public/js/formular/doc.js

# 3 — discriminatorul din listă e câmpul, nu textul
grep -n "p2_compartiment" public/js/formular/list.js

# 4 — backendul #131a neatins
git status --short server/services/ server/routes/formulare/df.mjs server/routes/formulare/ord.mjs
# Așteptat: nicio linie

# 5 — zero migrații noi
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -2
# Așteptat: se termină la 108

# 6 — scopul lotului
git status --short
# ⚠️ working tree-ul are fișiere netrackate din sesiuni vechi — confirmă EXPLICIT că ai
# stage-uit doar căile sarcinii

# 7 — ?v= țintit
grep -on "formular/\(core\|doc\|list\|draft\)\.js?v=[0-9.]*" public/formular.html
```

---

## 10. RAPORT FINAL

- commit hash + push confirmat; versiunea; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE**, cu comanda instanței efemere, verbatim.
  Dacă suita DB completă n-a rulat, **spune-o explicit** și marchează ce rămâne neverificat
- ieșirea celor 7 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 2, 3, 6 și 8**, menționate separat
- **răspunsul la capcana din §B.3**: apare sau nu compartimentul inițiatorului în listă, ce
  acceptă serverul, și care e divergența — cu liniile de cod. ⛔ Fără reparație în acest lot
- ce componentă ai folosit pentru comutatorul de mod și de unde ai luat-o
- confirmarea că modul „Persoană" e byte-identic (randare + corp de cerere)
- confirmarea că backendul #131a e neatins
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 11. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ Zero migrații, zero rute noi, zero `CACHE_VERSION`.
⛔ O singură linie de server (filtrul `deleted_at`); restul backendului rămâne cum l-a lăsat #131a.
⛔ Modul „Persoană": randare și corp de cerere **byte-identice** cu azi.
⛔ Corpul cererii conține EXACT una dintre `assigned_to` / `assigned_comp`, niciodată ambele.
⛔ Discriminatorul din listă e câmpul `p2_compartiment`, niciodată textul lui `p2`.
⛔ Compartimentele se derivă din `ST.orgUsers`, nu dintr-o rută nouă.
⛔ Un compartiment cu toți membrii în concediu rămâne selectabil.
⛔ Zero refactorizări în trecere.
