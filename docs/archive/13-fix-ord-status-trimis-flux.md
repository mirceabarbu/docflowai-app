---
fix: ORD trimisă pe flux afișează „Completat" în loc de „Trimis flux" — status de afișare derivat în lista ORD
target_branch: develop
model_suggested: Sonnet 4.6 (derivare read-only în query + 1 fallback în badge; bine delimitat)
risk: SCĂZUT — query de listă (read-only) + un fallback în badge; ZERO atingere a coloanei status / lifecycle / asimetriei
version: bump +1 față de versiunea curentă din package.json (verifică — probabil 3.9.592 → 3.9.593)
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH semnare (standard)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`.

## ⛔ NO-TOUCH — asimetria de lifecycle (deliberată)
NU atinge tranzițiile de status și nici asimetria: `server/routes/flows/crud.mjs`, `server/routes/flows/lifecycle.mjs`, `server/routes/flows/signing.mjs`, și config-ul asimetriei din `server/services/formular-shared.mjs` (`linkFlowSetsStatus`). Acest fix **NU schimbă coloana `status` și nicio tranziție** — doar derivă un status DE AFIȘARE în query-ul de listă.

## Context — cauză confirmată
Asimetrie deliberată: la trimiterea pe flux, DF trece la `status='transmis_flux'`, dar ORD **rămâne `completed`** (`formular-shared.mjs`: `linkFlowSetsStatus: null` pentru ORD — păstrează simple porțile de editare pe `completed`). Lista ORD (`GET /api/formulare-ord`, `server/routes/formulare/ord.mjs`) întoarce `fo.status` brut → o ORD pe flux (neaprobată) afișează „✅ Completat" în loc de „🔄 Trimis flux". Eticheta există deja în `_stBadge` (list.js), dar statusul ORD nu ajunge la ea.

Tranziții existente (de păstrat intacte): flux finalizat → `crud.mjs:463` setează ORD `status='aprobat'`; flux șters → `crud.mjs:680` resetează doar `transmis_flux`→`completed` (ORD nu trece pe-acolo, deci rămâne `completed` — corect).

## Soluție — derivare read-only (fără atingerea lifecycle-ului)
Adaugă un câmp `display_status` în query-ul de listă ORD: când ORD e pe un flux activ și nefinalizat, afișează `transmis_flux`; altfel statusul brut. Coloana `status` și porțile de editare rămân neatinse.

## Etapa 0 — caracterizare
```bash
# Query-ul de listă ORD (SELECT-ul care întoarce status/flow_id)
sed -n '70,90p' server/routes/formulare/ord.mjs
# Predicatul de "flux finalizat" folosit deja în detaliu (ca să-l REFOLOSESC identic)
grep -n "data->>'status'\|data->>'completed'\|deleted_at IS NULL\|AS aprobat" server/routes/formulare/ord.mjs | head
# Unde apelează lista badge-ul de status
grep -n "_stBadge(" public/js/formular/list.js
```

## Implementare

### 1. `server/routes/formulare/ord.mjs` — query listă: adaugă `display_status`
- `LEFT JOIN flows fl ON fl.id = fo.flow_id`.
- Adaugă în SELECT un câmp derivat (NU alia `fo.status` — păstrează `fo.status` brut separat):
```sql
CASE
  WHEN fo.status = 'completed'
   AND fo.flow_id IS NOT NULL
   AND fl.deleted_at IS NULL
   AND <flux NEfinalizat>          -- negarea predicatului de finalizare din detaliu
  THEN 'transmis_flux'
  ELSE fo.status
END AS display_status
```
Pentru `<flux NEfinalizat>` **refolosește EXACT predicatul de finalizare** deja folosit la calculul `aprobat` din detaliu (`fl.data->>'status' = 'completed' OR (fl.data->>'completed')::boolean = true`), negat — ca să fie consistent și să nu arunce la cast. Nu inventa alt predicat.
- Lasă `fo.status` în SELECT cum e (alte logici pot depinde de el).

### 2. `public/js/formular/list.js` — badge folosește display_status cu fallback
La apelul din `_renderLstTable`, schimbă `_stBadge(row.status)` → `_stBadge(row.display_status || row.status)`. `_stBadge` e partajat DF/ORD: DF nu întoarce `display_status` → fallback pe `row.status` → DF neafectat. NU modifica `_stBadge` în sine (maparea `transmis_flux → '🔄 Trimis flux'` există deja).

## Teste
Adaugă/extinde un test DB pe lista ORD:
- ORD `status='completed'` + `flow_id` pe flux activ nefinalizat → `display_status='transmis_flux'`.
- ORD `status='aprobat'` (flux finalizat) → `display_status='aprobat'`.
- ORD `status='completed'` fără flux → `display_status='completed'`.
- ORD pe flux **șters** (`deleted_at`) → `display_status='completed'` (nu transmis_flux).
- Asertează că `status` brut (coloana) rămâne `completed` în toate cazurile pe-flux (nu s-a atins lifecycle-ul).
`npm test verde, fără regresii`. `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/formulare/ord.mjs`, `public/js/formular/list.js`, testul, `public/formular.html` (cache-bust), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "flows/crud|flows/lifecycle|flows/signing|formular-shared|STSCloud|cloud-signing|pades" && echo "⛔ STOP: zonă lifecycle/semnare atinsă!" || echo "✅ asimetrie & lifecycle intacte"
```

## Cache busting + versiune
- bump `package.json` +1 (verifică versiunea curentă);
- `CACHE_VERSION` în `public/sw.js`;
- `?v=<noua_versiune>` pe `list.js` în `public/formular.html`.

## La final
```bash
git add server/routes/formulare/ord.mjs public/js/formular/list.js public/formular.html public/sw.js package.json server/tests/...
git commit -m "fix(ord): status de afișare 'Trimis flux' pentru ORD pe flux activ (derivat, lifecycle neatins)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: guardrail (lifecycle/asimetrie intacte), că `status` brut e neschimbat (doar `display_status` derivat), status teste. Confirmare owner pe staging: ORD 321 (pe flux, neaprobată) afișează „🔄 Trimis flux"; ORD aprobată rămâne „🟢 Aprobat"; ORD completată fără flux rămâne „✅ Completat".
