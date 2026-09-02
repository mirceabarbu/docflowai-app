# PROMPT #130 — coloane „Valoare ORD" și „Plătit" în lista Ordonanțărilor

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 5 · **Target versiune:** `v3.9.778` (de la 3.9.777 — **citește
`package.json`**) · **Migrații:** ZERO

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## 1. Cererea

În lista „Ordonanțare de Plată" se adaugă două coloane: **valoarea ordonanțării** și **cât s-a
plătit** din ea. Azi lista arată doar nr./titlu, inițiator, compartiment, responsabil CAB,
status și cele două date — nimic despre bani, deși ăsta e primul lucru pe care îl caută cineva
care se uită peste ordonanțări.

## 2. ⚠️ Capcana structurală care decide tot lotul

**DF și ORD împart UN SINGUR tabel HTML.** `switchListTab` doar comută `_lstState.type`, iar
`<thead>`-ul e markup STATIC în `public/formular.html` (~250). Nu există două tabele.

⇒ Dacă adaugi două `<th>` necondiționat, apar și la DF, goale. Dacă emiți `<td>`-urile doar la
ORD, numărul de celule nu mai corespunde antetului și tabelul se strică vizual.

**Soluția impusă — o SINGURĂ comutare controlează și antetul și celulele:** o clasă pe
container, plus o regulă CSS. Antetul și rândurile nu pot să se desincronizeze, fiindcă nu sunt
două decizii, ci una.

⛔ Nu implementa prin `style.display` pus separat pe `<th>`-uri și pe `<td>`-uri: sunt două
puncte de adevăr care vor diverge la primul refactor.

---

## 3. NO-TOUCH

⛔ `server/routes/alop.mjs` — expresia se **copiază** de acolo, fișierul nu se atinge
⛔ Filtrele listei, paginarea (`DFPagin`), `badge_status`, `can_delete`, `COUNT(*) OVER()`
⛔ Ramura DF a listei — randare **byte-identică**
⛔ Nicio migrație, niciun index, nicio coloană nouă în vreun tabel
⛔ Zero refactorizări în trecere

---

## 4. Etapa A — server (`server/routes/formulare/shared.mjs`, ramura ORD din `/api/formulare/list`)

### A.1 Recon obligatoriu

```bash
grep -n "ord_valoare" server/routes/alop.mjs
grep -n "plata_suma_efectiva" server/db/index.mjs
grep -n "alop_ord_cicluri" server/db/index.mjs | head -3
```

Expresia pentru valoare **există deja** la `alop.mjs:386-387`. **Copiaz-o verbatim** — nu o
rescrie „echivalent". Confirmă în raport că e identică, caracter cu caracter, în afară de
aliasul tabelei.

### A.2 Cele două câmpuri noi

În `SELECT`-ul ramurii ORD, imediat **înainte** de `COALESCE(u1.nume, u1.email) AS initiator`:

```sql
          -- #130 — valoarea ordonanțării = suma col.4 peste TOATE rândurile. După #128,
          -- `rows` conține rândurile tuturor blocurilor de furnizor (fiecare cu `bloc_idx`),
          -- deci suma e pe întreaga ordonanțare, nu pe primul furnizor. Expresie IDENTICĂ
          -- cu `ord_valoare` din routes/alop.mjs:386 — sursă unică de formulă.
          (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
             FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r) AS ord_valoare,
          -- #130 — cât s-a plătit din ACEASTĂ ordonanțare. Legătura ORD↔plată trăiește pe
          -- DOUĂ niveluri: ciclul CURENT stă pe `alop_instances.ord_id`, iar ciclurile ÎNCHISE
          -- sunt arhivate în `alop_ord_cicluri` (rând inserat de `noua-lichidare`). Un ORD e
          -- într-unul SAU în celălalt, niciodată în amândouă — dar preferăm rândul arhivat,
          -- fiindcă e valoarea înghețată la închiderea ciclului.
          COALESCE(
            (SELECT c.plata_suma_efectiva FROM alop_ord_cicluri c
              WHERE c.ord_id = fo.id LIMIT 1),
            (SELECT a.plata_suma_efectiva FROM alop_instances a
              WHERE a.ord_id = fo.id AND a.org_id = fo.org_id AND a.cancelled_at IS NULL LIMIT 1)
          ) AS plata_suma,
```

⚠️ **Verifică pe schemă, nu presupune**, și corectează dacă e cazul: (1) numele exact al
coloanei de sumă din `alop_ord_cicluri` — comentariul de mai sus zice `plata_suma_efectiva`,
confirmă în `server/db/index.mjs` (~1198); (2) dacă `alop_ord_cicluri` are `org_id` — dacă are,
adaugă filtrul; dacă nu, `ord_id` e deja cheie străină către `formulare_ord`, deci scoparea vine
prin `fo`. **Spune în raport ce ai găsit.**

⚠️ `plata_suma` poate fi **NULL** — înseamnă „nu s-a plătit / nu e legat de ALOP", NU zero.
⛔ Nu pune `COALESCE(..., 0)` peste tot: distincția null-vs-zero e chiar informația cerută.

⚠️ Cele două subinterogări sunt corelate per rând, dar pagina are 20 de rânduri ⇒ impact
neglijabil. Dacă la `EXPLAIN` vezi un seq-scan urât pe `alop_ord_cicluri`, **raportează**,
nu adăuga index în lotul ăsta.

### A.3 Ramura DF rămâne neatinsă

⛔ Niciun câmp nou în `SELECT`-ul DF. Confirmă prin `git diff` că modificările din `shared.mjs`
sunt strict în interiorul ramurii ORD.

### A.4 Teste — server

1. ⭐ ORD cu rânduri pe **două blocuri** de furnizor ⇒ `ord_valoare` = suma tuturor, nu doar a
   blocului 0. (Fără asta, coloana ar minți exact în cazul pentru care am construit #128.)
2. ORD fără `rows` / cu `rows` gol ⇒ `ord_valoare = 0` (nu NULL, nu eroare).
3. ⭐ ORD legat de ciclul CURENT (`alop_instances.ord_id`) cu plată confirmată ⇒ `plata_suma`
   e valoarea de acolo.
4. ⭐ ORD arhivat într-un ciclu închis (`alop_ord_cicluri.ord_id`) ⇒ `plata_suma` vine din
   rândul de ciclu.
5. ORD fără nicio legătură ALOP ⇒ `plata_suma` este **NULL** (explicit `toBeNull()`, nu `0`).
6. ALOP anulat (`cancelled_at` setat) ⇒ nu contribuie la `plata_suma`.
7. Non-regresie: răspunsul ramurii **DF** nu conține `ord_valoare` sau `plata_suma`.

---

## 5. Etapa B — antet și celule (`public/formular.html` + `public/js/formular/list.js`)

### B.1 Antetul

Adaugă două `<th>` după `<th>Responsabil CAB</th>` (~250), marcate cu clasa comună:

```html
          <th class="lst-col-ord">Valoare ORD</th>
          <th class="lst-col-ord">Plătit</th>
```

### B.2 Comutarea — o singură decizie

Pe containerul tabelului (`.lst-table-wrap` sau `<table>` — **citește markup-ul și alege
elementul care există**), adaugă/scoate clasa `lst-tip-ord` în funcție de `_lstState.type`,
**în același loc în care se comută tab-ul** (`switchListTab`) **și** la intrarea în `loadList`
(pentru încărcarea inițială, unde `switchListTab` nu trece).

CSS, în `public/css/formular/formular.css`, lângă celelalte reguli de listă:

```css
/* #130 — coloanele de bani există în markup pentru ambele tipuri, dar se afișează doar la ORD.
   O SINGURĂ regulă acoperă și <th> și <td> ⇒ antetul nu poate ajunge desincronizat de rânduri. */
.lst-table-wrap:not(.lst-tip-ord) .lst-col-ord { display: none; }
```

### B.3 Celulele

În `_renderLstRows` (list.js ~684), după `<td>${esc(row.p2||'—')}</td>`:

```js
      <td class="lst-col-ord" style="text-align:right;white-space:nowrap">${_lstBani(row.ord_valoare)}</td>
      <td class="lst-col-ord" style="text-align:right;white-space:nowrap">${_lstPlata(row.plata_suma,row.ord_valoare)}</td>
```

⚠️ Cele două `<td>` se emit **NECONDIȚIONAT**, pentru ambele tipuri. Ascunderea o face CSS-ul.
Asta e chiar mecanismul care garantează că numărul de celule corespunde mereu antetului.

### B.4 Cei doi helperi

```js
// #130 — formatare monetară pentru coloanele de bani din listă.
function _lstBani(v){
  const n=parseFloat(v);
  if(!isFinite(n))return '—';
  return (typeof fMR==='function'?fMR(n):n.toFixed(2))+' lei';
}
// #130 — „cât s-a plătit". NULL = nu s-a plătit / nu e legat de ALOP ⇒ liniuță, NU „0,00".
// Verde = plătit integral, chihlimbar = plătit parțial. Toleranță 0.01 pentru rotunjiri.
function _lstPlata(plata,valoare){
  if(plata==null)return '<span style="color:var(--df-text-3)">—</span>';
  const p=parseFloat(plata),v=parseFloat(valoare);
  if(!isFinite(p))return '<span style="color:var(--df-text-3)">—</span>';
  const txt=_lstBani(p);
  if(isFinite(v)&&v>0&&p+0.01>=v)return `<span style="color:#22c55e">${txt}</span>`;
  if(p>0)return `<span style="color:#f59e0b" title="Plată parțială">${txt}</span>`;
  return txt;
}
```

⚠️ Verifică pe cod că `fMR` chiar e accesibilă din `list.js` (e globală din `core.js`, scripturi
clasice) — dacă nu, folosește formatarea deja existentă în `list.js` și **spune care**.
⛔ Nu importa nimic; fișierele din `public/js/` sunt scripturi clasice, nu module.

### B.5 Teste — frontend

8. ⭐ Antetul are exact **două** `<th class="lst-col-ord">`, iar fiecare rând emis are exact
   **două** `<td class="lst-col-ord">` ⇒ numărul de coloane se potrivește pentru ambele tipuri.
9. `_lstPlata(null, 100)` ⇒ liniuță, **NU** „0,00 lei".
10. `_lstPlata(100, 100)` ⇒ verde; `_lstPlata(40, 100)` ⇒ chihlimbar; `_lstPlata(0, 100)` ⇒
    neutru (nu chihlimbar).
11. ⭐ Regula CSS există și e scrisă pe container, nu pe `<th>`/`<td>` separat — aserțiune pe
    sursa CSS, ca mecanismul de sincronizare să nu fie înlocuit tăcut.
12. La `_lstState.type === 'df'`, containerul NU are clasa `lst-tip-ord`; la `'ord'`, o are.

---

## 6. Cache busting

Assete atinse: `public/formular.html`, `public/js/formular/list.js`,
`public/css/formular/formular.css`.

```bash
grep -n "formular/list.js" public/sw.js
# Așteptat: nicio linie ⇒ FĂRĂ bump CACHE_VERSION
```
`?v=3.9.778` țintit pe `list.js` **și** pe `formular.css` (⚠️ `\1`, nu `\g<1>`; `grep` pe linia
atinsă după fiecare `sed` — un `?v=` corupt nu pică niciun test și ajunge în producție cu
pagina moartă).
⛔ `core.js`, `doc.js`, `draft.js` NU se ating.

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` e obligatoriu — Etapa A schimbă o interogare vie, iar
cazurile 3 și 4 cer date reale în `alop_instances` și `alop_ord_cicluri`. Rețeta PG 17 efemer,
instanță proaspătă, e în `CLAUDE.md`.

Bump la `3.9.778`;
`git commit -m "feat(#130): coloane Valoare ORD si Platit in lista ordonantarilor"`;
`git push origin develop`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
# 1 — câmpurile noi, strict în ramura ORD
grep -n "ord_valoare\|plata_suma" server/routes/formulare/shared.mjs

# 2 — alop.mjs neatins
git status --short server/routes/alop.mjs
# Așteptat: nicio linie

# 3 — antet + celule + CSS
grep -n "lst-col-ord" public/formular.html public/js/formular/list.js public/css/formular/formular.css

# 4 — comutarea clasei, în ambele puncte
grep -n "lst-tip-ord" public/js/formular/list.js

# 5 — zero migrații
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -2
# Așteptat: se termină la 107

# 6 — scopul lotului
git status --short
# ⚠️ working tree-ul are fișiere netrackate din sesiuni vechi — confirmă EXPLICIT că ai
# stage-uit doar căile sarcinii

# 7 — ?v= țintit
grep -on "formular/list\.js?v=[0-9.]*\|formular/formular\.css?v=[0-9.]*" public/formular.html
```

---

## 9. RAPORT FINAL

- commit hash + push confirmat; versiunea din `package.json`; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE**
- ieșirea celor 7 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 3, 4, 8 și 11**, menționate separat
- confirmarea că expresia de valoare e **identică** cu `alop.mjs:386` (în afară de alias)
- ce ai găsit la A.2: numele exact al coloanei de sumă din `alop_ord_cicluri` și dacă tabela are
  `org_id` — cu linia din `server/db/index.mjs`
- confirmarea că `plata_suma` rămâne **NULL** când nu există plată (nu `0`)
- confirmarea că ramura DF a listei e byte-identică
- ce ai folosit pentru formatare monetară în `list.js` (`fMR` sau altceva) și de ce
- pe ce element ai pus clasa `lst-tip-ord` și în ce două puncte o comuți
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 10. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ Zero migrații, zero indexuri, zero `CACHE_VERSION`.
⛔ `routes/alop.mjs` neatins — formula se copiază, fișierul nu.
⛔ Ramura DF a listei: randare byte-identică.
⛔ `plata_suma` NULL ≠ 0. Liniuță, nu „0,00 lei".
⛔ Ascunderea coloanelor se face printr-o SINGURĂ clasă pe container + CSS, niciodată prin
   `display` pus separat pe `<th>` și pe `<td>`.
⛔ Zero refactorizări în trecere.
