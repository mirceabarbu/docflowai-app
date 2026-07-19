---
fix: Consolidare status — câmp unic autoritar `badge_status` server-side în /api/formulare/list (DF+ORD); frontend doar prezintă
target_branch: develop
model_suggested: Sonnet 4.6 (refactor compoziție status într-o sursă unică; plasă de 14 teste dedesubt)
risk: SCĂZUT — `badge_status` = echivalentul EXACT al compoziției actuale; testul parametrizat confirmă zero schimbare
version: 3.9.597 → 3.9.598
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Semnare + lifecycle (`flows/crud.mjs`, `flows/lifecycle.mjs`, `flows/signing.mjs`, `formular-shared.mjs`). În `shared.mjs` atingi DOAR coloanele de status din query-ul `/api/formulare/list` (ambele ramuri) — NU upload/captură/atașamente. NU atinge detaliul (`GET /:id`) — rămâne pe pasul următor.

## Scop & proprietatea de siguranță
Statusul afișat se compune azi în 3 locuri: server (`display_status` + `aprobat`) → frontend (`list.js:489` combină) → test (oglindește). Unificăm într-un singur câmp autoritar **`badge_status`** calculat server-side. Frontend-ul doar îl mapează la etichetă+culoare.

**CRITIC — zero schimbare de comportament:** `badge_status` se definește ca echivalentul EXACT al compoziției frontend `display_status || (aprobat ? 'aprobat' : status)`, **reutilizând aceleași sub-expresii SQL** (`COALESCE` ține locul lui `||`). NU re-deriva de la zero. Matricea de 14 cazuri (mutată să aserteze `badge_status`) trebuie să rămână verde cu aceleași badge-uri așteptate.

## Etapa 0 — caracterizare
```bash
# Sub-expresiile existente de reutilizat (display_status ORD + aprobat ambele ramuri)
grep -n "display_status\|AS aprobat\|END AS" server/routes/formulare/shared.mjs
# Logica badge-ului din frontend (de înlocuit cu row.badge_status)
grep -n "display_status\|aprobat ?\|_stBadge(" public/js/formular/list.js
# aprobat e folosit în frontend DINCOLO de badge? (decide dacă-l păstrăm)
grep -rn "\.aprobat\b" public/js/formular/*.js | grep -v "display_status" | head
```

## Implementare

### 1. `server/routes/formulare/shared.mjs` — `badge_status` în ambele ramuri din `/api/formulare/list`
**Ramura ORD** — înlocuiește coloana `display_status` cu `badge_status` = COALESCE(derivarea transmis_flux, aprobat?:status), reutilizând sub-expresiile existente:
```sql
COALESCE(
  CASE WHEN fo.status='completed' AND fo.flow_id IS NOT NULL AND f.deleted_at IS NULL
            AND (f.data->>'completed') IS DISTINCT FROM 'true'
            AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
       THEN 'transmis_flux' END,                         -- fără ELSE → NULL → COALESCE trece mai departe
  CASE WHEN fo.flow_id IS NOT NULL
            AND (f.data->>'status'='completed' OR (f.data->>'completed')::boolean = true)
       THEN 'aprobat' ELSE fo.status END
) AS badge_status
```
**Ramura DF** — adaugă `badge_status` (DF nu are display_status; transmis_flux e în status brut):
```sql
CASE WHEN fd.flow_id IS NOT NULL
          AND (f.data->>'status'='completed' OR (f.data->>'completed')::boolean = true)
     THEN 'aprobat' ELSE fd.status END AS badge_status
```
Note:
- Predicatele `transmis_flux` și `aprobat` rămân IDENTICE cu cele existente (nu le rescrie semantic — le compui). `COALESCE` = `||`.
- `aprobat`: **păstrează** coloana `aprobat` în SELECT dacă Etapa 0 arată că e folosită în frontend dincolo de badge (gating acțiuni etc.). Dacă e folosită DOAR de badge → o poți elimina. La dubiu, păstreaz-o (e flag semantic, nu duplică `badge_status`).
- `display_status` (ORD) se ELIMINĂ din SELECT (subsumat de `badge_status`).

### 2. `public/js/formular/list.js` — frontend doar prezintă
Înlocuiește compoziția `row.display_status || (row.aprobat ? 'aprobat' : row.status)` cu **`row.badge_status`** la apelul `_stBadge(...)`. NU modifica maparea din `_stBadge` (etichetă/culoare) — acoperă deja toate valorile. `_stBadge(row.badge_status)`.

### 3. `server/tests/db/formulare-status-display.test.mjs` — asertează sursa unică
- Elimină helper-ul `effectiveBadge`. Asertează direct `expect(row.badge_status).toBe(<așteptat>)` pentru toate cele 14 cazuri (aceleași badge-uri așteptate ca acum — dacă vreunul se schimbă, ai stricat ceva).
- Actualizează aserțiile diagnostice: `display_status` nu mai există → asertează în schimb pe `badge_status`. Pentru DF, înlocuiește `not.toHaveProperty('display_status')` cu o aserție că DF expune `badge_status` și că badge-ul DF pe flux vine corect (`transmis_flux` din status brut → `badge_status==='transmis_flux'`).
- Adaugă o aserție generală: niciun rând nu mai expune `display_status` (curățenie confirmată).

## Teste
`npm test verde, fără regresii` (`node_modules` instalat). Matricea de 14 cazuri verde cu badge-uri NEschimbate. `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/formulare/shared.mjs`, `public/js/formular/list.js`, `server/tests/db/formulare-status-display.test.mjs`, `public/formular.html` (cache-bust), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "flows/|formular-shared\.mjs|formulare/(df|ord)\.mjs|STSCloud|cloud-signing|pades" && echo "⛔ STOP: zonă interzisă / detaliu atins!" || echo "✅ doar lista + frontend + test"
git diff server/routes/formulare/shared.mjs | grep -iE "atasament|captura|upload" && echo "⚠️ verifică: doar query-ul listei?" || echo "✅"
```

## Cache busting + versiune
- bump `package.json`: `3.9.597` → `3.9.598`;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.598` pe `list.js` în `public/formular.html`.

## La final
```bash
git add server/routes/formulare/shared.mjs public/js/formular/list.js server/tests/db/formulare-status-display.test.mjs public/formular.html public/sw.js package.json
git commit -m "refactor(status): badge_status unic server-side în /api/formulare/list; frontend doar prezintă (v3.9.598)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: confirmarea că matricea de 14 cazuri e verde cu aceleași badge-uri (zero schimbare de comportament), că `list.js` folosește acum doar `row.badge_status`, și dacă ai păstrat sau eliminat `aprobat`. Confirmare owner pe staging: 321 → „Trimis flux", 12S → „Aprobat", DF-urile neschimbate. (Pas viitor opțional: același `badge_status` și pe detaliu `GET /:id`.)
