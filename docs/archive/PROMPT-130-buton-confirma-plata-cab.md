# PROMPT #130 — URGENT: butonul „Confirmă Plata" invizibil pentru compartimentul CAB

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 · **Migrații:** ZERO
**Target versiune:** următorul număr liber — `3.9.760` dacă rulezi promptul ăsta primul,
`3.9.761` dacă ai rulat #129 (limita OPME) înainte. **Citește versiunea din `package.json`, nu
o presupune.**

---

## 1. Bugul, verificat pe cod (arhiva v3.9.759)

Utilizatorii din compartimentul CAB reclamă că **nu pot confirma plata**. Datele din producție
sunt curate: `organizations.cab_compartiment = 'Serviciul Buget'`, iar utilizatorii din Buget au
`compartiment` identic (potrivire exactă, verificată în SQL). Deci nu e nici configurare, nici
comparație de șiruri.

**Cauza reală — un return devreme în `server/services/alop-capabilities.mjs:41`:**

```js
if (caps.is_completed || caps.is_cancelled || !caps.is_owner) return caps;
```

`caps.is_owner` = creatorul ALOP-ului SAU `admin`/`org_admin`. Pentru oricine altcineva funcția
iese ÎNAINTE de blocul „Phase action", deci `caps.phase_action` rămâne `null`. Frontendul
(`public/js/formular/alop.js:651`, `case 'confirma_plata'`) randează butonul DOAR pe acea ramură
⇒ pentru un membru CAB care nu e creatorul, butonul **nu există în DOM**.

În paralel, garda #126 B1 (`routes/alop.mjs:1565-1584`) rezervă confirmarea manuală
compartimentului CAB și **nu exceptează `org_admin`** (separare de atribuții).

**Intersecția celor două = nimeni nu poate confirma**, în afară de cineva care e SIMULTAN creatorul
dosarului ȘI membru CAB:

| Cine | Ce pățește azi |
|---|---|
| membru CAB, **nu** e creatorul | butonul nu se randează deloc |
| creatorul, **nu** e din CAB | vede butonul → 403 `doar_cab` |
| `org_admin` | vede butonul → 403 `doar_cab` |

**Nu extindem privilegii — reparăm interfața.** `canEditAlop` (`server/services/authz-formular.mjs:165`)
întoarce deja `{ allowed: true, role: 'cab_dept' }` pentru orice membru CAB pe orice ALOP al
organizației, din #ALOP-CAB (v3.9.690). Serverul autorizează; doar `computeAlopCapabilities` n-a
aflat niciodată.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ **Garda #126 B1 din `routes/alop.mjs` (~1565-1584) NU se atinge.** E corectă și e poarta reală.
   Nu adăuga excepție pentru `org_admin`, nu slăbi comparația, nu o muta.
⛔ `canEditAlop` / `isCabDept` din `authz-formular.mjs` — nu se modifică semantica lor
⛔ Nu schimba comparația de compartimente ca să devină case-insensitive — datele din producție
   se potrivesc EXACT; ar fi un fix pentru o problemă care nu există și ar masca datoria reală
   (validarea `users.compartiment`, alt lot)
⛔ Zero refactorizări în trecere

---

## 3. Etapa A — `computeAlopCapabilities` află despre CAB

Fișier: `server/services/alop-capabilities.mjs`

### A.1 Semnătura primește un al treilea parametru

`export function computeAlopCapabilities(alop, actor)` →
`export function computeAlopCapabilities(alop, actor, opts = {})`, unde
`opts = { actorComp, cabComp }`. Parametrul e **opțional cu default gol**, ca apelurile existente
din teste să nu se rupă (comportamentul lor rămâne identic: fără `cabComp`, `is_cab` e `false`).

Importă `isCabDept` din `./authz-formular.mjs` (verifică pe cod că e exportat de acolo — dacă nu
e, raportează, nu duplica logica).

### A.2 Câmp nou în obiectul `caps`

Adaugă `is_cab: false` în inițializarea lui `caps`, lângă `is_owner`.

### A.3 Calculul și gardul

Înainte de return-ul devreme:

```js
  // #130: membrul compartimentului CAB are DEJA drept de editare pe orice ALOP al organizației
  // (canEditAlop → role 'cab_dept', din #ALOP-CAB v3.9.690). `computeAlopCapabilities` nu aflase
  // niciodată, deci ieșea devreme pe `!is_owner` și `phase_action` rămânea null ⇒ butonul
  // „Confirmă Plata" nu se randa DELOC pentru CAB, în timp ce garda #126 B1 îl rezervă tocmai
  // lor. Rezultat: nimeni nu putea confirma plata, în afară de cineva simultan creator ȘI CAB.
  caps.is_cab = isCabDept(opts.actorComp, opts.cabComp);
```

Apoi return-ul devreme devine:

```js
  if (caps.is_completed || caps.is_cancelled || (!caps.is_owner && !caps.is_cab)) return caps;
```

### A.4 ⚠️ Regresia pe care extinderea o introduce — tratează-o EXPLICIT

`caps.can_delete` e azi `!alop.df_id && !alop.ord_id`, owner-gated **doar prin efectul
return-ului devreme**. După extindere, un membru CAB non-creator ar primi `can_delete: true` — dar
serverul refuză: `canDestroyOnly` (`authz-formular.mjs:170`) permite DOAR creatorul și
`admin`/`org_admin`. Ar apărea un buton care eșuează la clic.

Fix obligatoriu, în același patch:

```js
  caps.can_delete = caps.is_owner && !alop.df_id && !alop.ord_id;
```

Verifică la fel, **una câte una**, și celelalte câmpuri calculate după return-ul devreme
(`df_action`, celelalte `phase_action`, `can_start_noua_ordonantare`, `can_revise_df`): pentru
fiecare, confirmă pe cod dacă ruta corespunzătoare acceptă `cab_dept` prin `canEditAlop`. Dacă
DA → se lasă. Dacă NU → se owner-gatează explicit, ca `can_delete`.
**Raportează tabelul acestei verificări** — e partea cea mai importantă a lotului.

---

## 4. Etapa B — apelantul trimite compartimentele

Fișier: `server/routes/alop.mjs`, `GET /api/alop/:id`, apelul de la ~981
(`alop.capabilities = computeAlopCapabilities(alop, actor);`).

Ruta încarcă deja `actorComp` printr-o interogare directă pe `users.compartiment` (~linia 870,
în același handler), dar **nu** încarcă `cab_compartiment`. Înlocuiește acea interogare cu
helperul existent `loadActorCompAndCab(pool, actor.userId, actor.orgId)` din
`server/services/authz-formular.mjs`, care întoarce ambele într-o singură rundă la DB și aplică
același `trim()` ca garda #126 B1 — astfel interfața și poarta folosesc EXACT aceleași valori.

⚠️ `actorComp` e folosit mai jos în handler pentru filtrarea de vizibilitate (`detailParams.push`).
Păstrează acel comportament identic — schimbi doar SURSA valorii, nu felul în care e folosită.

Apoi: `computeAlopCapabilities(alop, actor, { actorComp, cabComp })`.

---

## 5. Etapa C — frontendul preferă adevărul serverului

Fișier: `public/js/formular/alop.js`, ~656-660.

Logica actuală ghicește apartenența la CAB din `window.ST.cabCompartiment` și
`ST.user.compartiment`, care se populează abia după `/api/formulare/utilizatori-org` — de unde și
comentariul defensiv existent. Acum serverul trimite adevărul în `caps.is_cab`.

Schimbă DOAR calculul lui `_blocatCab` ca să prefere valoarea de la server când e prezentă,
păstrând ghicitul ca fallback:

```js
        const _isAdm=window.ST?.user?.role==='admin';
        const _cabC=(window.ST?.cabCompartiment||'').trim();
        const _actC=(window.ST?.user?.compartiment||window.ST?.actorCompartiment||'').trim();
        // #130: serverul trimite acum `is_cab` în capabilities — sursă autoritară, aliniată cu
        // garda #126 B1. Ghicitul din ST rămâne doar ca fallback pentru răspunsuri vechi.
        const _blocatCab = (typeof caps.is_cab === 'boolean')
          ? (!_isAdm && !caps.is_cab)
          : (!_isAdm && !!_cabC && !!_actC && _actC !== _cabC);
```

⚠️ Verifică pe cod că variabila care ține capabilities în acel scope se numește chiar `caps`
(la ~669 apare `if(caps.can_revise_df)`). Dacă e alt nume, folosește-l pe acela.

⚠️ `public/js/formular/alop.js` e fișier din `public/`. Verifică, **nu presupune**:
`grep -n "formular/alop.js" public/sw.js` — dacă e în `PRECACHE_ASSETS`, `CACHE_VERSION` e
OBLIGATORIU bumpat (citește valoarea curentă din fișier); dacă nu e, ajunge `?v=` țintit pe
referința din `formular.html`. Raportează care caz e.

---

## 6. Etapa D — teste

Extinde suita existentă a capabilităților (`grep -rln "computeAlopCapabilities" server/tests/`).
⛔ Testul IMPORTĂ funcția reală; nu redeclara logica.

Cazuri obligatorii:

1. **Membru CAB, NU e creatorul, ALOP în `plata`** → `phase_action === 'confirma_plata'`,
   `is_cab === true`. Fără fix: `phase_action` e `null` — ăsta e testul care prinde bugul.
2. **Membru CAB, NU e creatorul** → `can_delete === false` (regresia de la A.4).
3. **Creatorul, NU e din CAB, ALOP în `plata`** → `phase_action === 'confirma_plata'`,
   `is_cab === false` (butonul se randează dezactivat, cu tooltip — comportament păstrat).
4. **Nici creator, nici CAB** → toate `null`/`false`, exact ca înainte (non-regresie).
5. **Apel FĂRĂ al treilea parametru** (compatibilitate) → `is_cab === false`, restul identic cu
   comportamentul de azi.
6. **`cabComp` gol / `actorComp` gol** → `is_cab === false`, fără excepție.
7. ALOP `completed` sau `cancelled` + membru CAB → tot return devreme (starea terminală bate).

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed" — rețeta cu PG 17 efemer din `CLAUDE.md`.

Bump `package.json` la următorul număr liber; commit pe `develop`:
`fix(#130): butonul „Confirmă Plata" invizibil pentru CAB — capabilities află de cab_dept`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -n "is_cab" server/services/alop-capabilities.mjs
# Așteptat: inițializarea, calculul, și folosirea în return-ul devreme

grep -n "caps.can_delete = " server/services/alop-capabilities.mjs
# Așteptat: 1 linie, care ÎNCEPE cu caps.is_owner &&

grep -n "computeAlopCapabilities(alop, actor" server/routes/alop.mjs
# Așteptat: 1 linie, cu al treilea argument { actorComp, cabComp }

grep -n "doar_cab\|cab_compartiment_nesetat" server/routes/alop.mjs
# Așteptat: NESCHIMBAT față de înainte — garda #126 B1 e intactă

git status --short
# ⚠️ ~50 de fișiere netracked din sesiuni anterioare — ignoră-le și CONFIRMĂ ce ai stage-uit
```

---

## 9. RAPORT FINAL

- commit hash + intervalul de push, versiunea aleasă și de ce
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ **tabelul de la A.4**: pentru fiecare câmp calculat după return-ul devreme, dacă ruta
  corespunzătoare acceptă `cab_dept` (rămâne) sau nu (owner-gatat explicit) — cu fișier și linie
- cazul de cache busting pentru `alop.js`
- rezultatul cazului 1 menționat separat — e acceptanța bugului
- orice abatere, cu motivul. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
