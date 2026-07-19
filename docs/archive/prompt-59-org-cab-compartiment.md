---
prompt: 59
titlu: "feat(org): Compartiment CAB implicit la nivel de organizație — pre-filtrează selecția Responsabilului CAB"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: Organizații (settings) · selecție Responsabil CAB · migrare coloană
---

# ⛔ BRANCH DISCIPLINE — CITEȘTE ÎNTÂI
> **EXCLUSIV pe `develop`.** NU face `merge` / `push` / `checkout` pe `main`.
> `main` = producție, gestionat manual de owner. Deploy staging = push pe `develop`.
> Dacă vreun pas te-ar duce spre `main`, **OPREȘTE-TE** și raportează.

---

## Cerință (owner)
CAB (Control Angajamente Bugetare) e instituțional **un singur serviciu** (ex. „Serviciul Buget"). Vrem un **default la nivel de organizație**: se setează în **Organizații → General** (unde deja se gestionează „Compartimente instituție"), iar modalul „Trimite la Responsabil CAB" se **pre-filtrează** pe acel compartiment (rămâne suprascriabil prin bifă).

## Stare curentă (confirmată în cod)
- Compartimentele org: `organizations.compartimente` (TEXT[]). GET/PUT în `server/routes/admin/organizations.mjs` (PUT ~144, acceptă deja `compartimente`). Coloane permise în `server/db/queries/organizations.mjs:36`.
- Modalul de selecție (`showP2Modal` → `_renderP2FilterToggle` → `filterModalUsers`, `public/js/formular/doc.js`) filtrează acum după **compartimentul actorului logat** (`ST.actorCompartiment`), bifă „Doar din [actorComp]", default ON dacă actorul are compartiment.
- Endpoint `GET /api/formulare/utilizatori-org` (`server/routes/formulare/shared.mjs:303-322`) întoarce `users` + `actor_compartiment`.

## Implementare

### 1. Migrare — coloană nouă `cab_compartiment`
Adaugă coloana prin **convenția existentă** (fișier nou numerotat `server/db/migrations/016_org_cab_compartiment.sql`, în stilul lui `014_alop.sql`):
```sql
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cab_compartiment TEXT;
```
(Verifică cum se aplică migrările la boot — `server/db/index.mjs` — și respectă mecanismul. Idempotent.)

### 2. `server/db/queries/organizations.mjs`
Adaugă `cab_compartiment` în lista de coloane permise (linia ~36) pentru read/update.

### 3. `server/routes/admin/organizations.mjs`
- GET (liniile ~26, ~60): include `cab_compartiment` în SELECT-uri și în răspuns.
- PUT (~144-180): acceptă `cab_compartiment` din body. **Validare:** dacă e non-gol, trebuie să fie unul din `compartimente` ale org-ului (altfel 400 `cab_compartiment_invalid`); gol/`null` → setează NULL (dezactivează default-ul). Adaugă în `updates`/`params` ca la `compartimente`. Include-l în `RETURNING`.

### 4. `server/routes/formulare/shared.mjs` — `/api/formulare/utilizatori-org`
Întoarce și `cab_compartiment` al organizației actorului (un `SELECT cab_compartiment FROM organizations WHERE id=$orgId`). Răspuns: `{ ok, users, actor_compartiment, cab_compartiment }`.

### 5. Frontend — Organizații → General (`public/js/admin/organizations.js` + `public/admin.html`)
Sub „Compartimente instituție", adaugă un select **„Compartiment CAB implicit"** populat din `compartimente` ale org-ului (opțiune goală „— niciunul —" permisă). Valoarea curentă = `org.cab_compartiment`. Se salvează prin PUT-ul existent (adaugă `cab_compartiment` în payload-ul de salvare). Fără CSS nou (reutilizează stilurile din tab).

### 6. Frontend — modal selecție CAB (`public/js/formular/doc.js`)
În `showP2Modal`: după fetch `utilizatori-org`, salvează `ST.cabCompartiment = j.cab_compartiment || ''`.
Logica de filtrare devine: **dacă `ST.cabCompartiment` e setat**, el e compartimentul de filtrare implicit (nu `actorCompartiment`):
- `_renderP2FilterToggle`: dacă `ST.cabCompartiment` → afișează bifa cu label „Doar din **[cabCompartiment]**", default ON.
- `filterModalUsers`: când bifa e ON și `ST.cabCompartiment` setat → filtrează pe `cabCompartiment`; altfel comportamentul actual (actorCompartiment) ca **fallback** când org-ul n-are `cab_compartiment`.
- Default: `ST.p2FilterByComp` inițial = `true` dacă există `cabCompartiment` (sau `actorCompartiment` ca azi).
Păstrează suprascrierea (userul poate debifa → toți utilizatorii instituției).

## Ce NU atingem
- ⛔ Logica de semnare/STS/PAdES, fluxurile, mașina de stări ALOP.
- ⛔ Nu schimba `compartimente` existent — doar adaugi `cab_compartiment` alături.

## Cache busting + versiune
- `public/admin.html`: `organizations.js?v=3.9.518` → `?v=3.9.639`.
- `public/formular.html`: `doc.js?v=3.9.633` → `?v=3.9.639`.
- `public/sw.js`: `CACHE_VERSION` → `docflowai-v268` (dacă rulezi #58 înainte, incrementează de la valoarea curentă).
- `package.json`: → `3.9.639` (sau următorul patch de la versiunea reală curentă).

## Guardrails diff
`git diff --name-only` = EXCLUSIV: `server/db/migrations/016_org_cab_compartiment.sql`, `server/db/queries/organizations.mjs`, `server/routes/admin/organizations.mjs`, `server/routes/formulare/shared.mjs`, `public/js/admin/organizations.js`, `public/admin.html`, `public/js/formular/doc.js`, `public/formular.html`, `public/sw.js`, `package.json` (+ eventual fișierul de test).
```bash
git diff --name-only | grep -iE "signing|pades|cloud-signing|semdoc|flows/lifecycle|alop\.mjs" \
  && echo "⛔ STOP: zonă interzisă!" || echo "✅ ok"
```

## Teste
`npm test verde, fără regresii`. Adaugă test pe PUT organizations: `cab_compartiment` valid (∈ compartimente) → 200 + persistă; invalid (nu e în listă) → 400; gol → NULL. Verifică `utilizatori-org` întoarce `cab_compartiment`.

## Verificare (owner, staging)
- Organizații → General: aleg „Serviciul Buget" ca Compartiment CAB implicit → Salvează.
- La un DF, „Trimite la Responsabil CAB": bifa apare „Doar din **Serviciul Buget**", default ON, lista arată doar userii din Serviciul Buget (indiferent de compartimentul inițiatorului). Debifez → toți.
- Fără CAB implicit setat: comportament ca înainte (compartimentul actorului).

## Final
```bash
git add server/db/migrations/016_org_cab_compartiment.sql server/db/queries/organizations.mjs server/routes/admin/organizations.mjs server/routes/formulare/shared.mjs public/js/admin/organizations.js public/admin.html public/js/formular/doc.js public/formular.html public/sw.js package.json
git commit -m "feat(org): compartiment CAB implicit — pre-filtrare selecție Responsabil CAB (v3.9.639)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- migrarea aplicată corect (coloana există pe staging);
- validarea `cab_compartiment ∈ compartimente` funcțională;
- `npm test` verde, fără regresii;
- confirmare owner pe staging (default „Serviciul Buget" pre-filtrează modalul).
