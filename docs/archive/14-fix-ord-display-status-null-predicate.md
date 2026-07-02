---
fix: display_status ORD nu devine „transmis_flux" pe flux activ — capcană NULL în predicat (corectă: IS DISTINCT FROM)
target_branch: develop
model_suggested: Sonnet 4.6 (un singur predicat SQL de corectat + test reprezentativ)
risk: SCĂZUT — corectează predicatul derivat introdus în v3.9.593; tot read-only, lifecycle neatins
version: 3.9.593 → 3.9.594
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Semnare (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`) + lifecycle/asimetrie (`flows/crud.mjs`, `flows/lifecycle.mjs`, `flows/signing.mjs`, `formular-shared.mjs`). Acest fix atinge DOAR predicatul derivat `display_status` din lista ORD + testul.

## Context — cauză confirmată (regresie a fix-ului din v3.9.593)
`display_status` din lista ORD (`GET /api/formulare-ord`, `server/routes/formulare/ord.mjs`) folosește ca „flux nefinalizat" **negarea predicatului `aprobat`** — care conține `(f.data->>'completed')::boolean = true` într-un `OR`. La un flux ÎN CURS, `data.completed` **lipsește** (NULL — e setat doar la finalizare). Negarea lui `(NULL)::boolean = true` → **NULL** (logica three-valued), tot `AND`-ul devine NULL → CASE cade pe ELSE → `display_status='completed'`. De-asta ORD pe flux activ tot afișează „Completat".

Detaliul ORD (`GET /:id`, același fișier, ~l.137-141) folosește deja predicatul corect, **NULL-safe**, numit `flow_active`:
```sql
fo.flow_id IS NOT NULL
AND f.deleted_at IS NULL
AND (f.data->>'completed') IS DISTINCT FROM 'true'
AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
```

## Etapa 0 — caracterizare
```bash
# Predicatul flow_active din detaliu (sursa corectă de copiat)
grep -n "flow_active\|IS DISTINCT FROM\|AS aprobat\|display_status" server/routes/formulare/ord.mjs
# Predicatul greșit (negare aprobat) din lista ORD — de înlocuit
sed -n '70,92p' server/routes/formulare/ord.mjs
```

## Implementare

### 1. `server/routes/formulare/ord.mjs` — corectează predicatul `display_status` din lista ORD
Înlocuiește condiția „flux nefinalizat" (negarea aprobat-ului) cu **exact predicatul `flow_active` din detaliu** (NULL-safe). Rezultatul:
```sql
CASE
  WHEN fo.status = 'completed'
   AND fo.flow_id IS NOT NULL
   AND fl.deleted_at IS NULL
   AND (fl.data->>'completed') IS DISTINCT FROM 'true'
   AND (fl.data->>'status')    IS DISTINCT FROM 'cancelled'
  THEN 'transmis_flux'
  ELSE fo.status
END AS display_status
```
(Folosește aliasul corect al JOIN-ului — `fl` din lista ORD. NU schimba `fo.status` brut din SELECT. NU atinge predicatul `aprobat` din detaliu.)

### 2. Test — fă-l REPREZENTATIV pentru cazul real (asta a lipsit)
În testul DB existent (`server/tests/db/ord-display-status-list.test.mjs`), pentru cazul „flux activ nefinalizat" asigură-te că fixture-ul fluxului are `data` **fără câmpul `completed`** (NU `completed:false`) — exact ca un flux în curs real. Acesta e cazul care trebuie să producă `display_status='transmis_flux'` și care prinde capcana NULL. Adaugă, dacă lipsește:
- flux cu `data = { status: 'pending' }` (fără `completed`) → `display_status='transmis_flux'`.
- flux cu `data = { completed: true }` → `display_status='aprobat'`/`completed` (nu transmis_flux).
- flux cu `data = { status: 'cancelled' }` → NU transmis_flux.

## Teste
`npm test verde, fără regresii`. (DB se auto-skip local fără Postgres — autoritativ în CI.) `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/formulare/ord.mjs`, testul DB, `package.json`. (Fără frontend → fără cache-bust; badge-ul folosește deja `display_status`.)
```bash
git diff --name-only | grep -E "flows/|formular-shared|list\.js|STSCloud|cloud-signing|pades" && echo "⛔ STOP: zonă interzisă!" || echo "✅ doar lista ORD + test"
```

## Versiune
- bump `package.json`: `3.9.593` → `3.9.594`. (Fără frontend → fără `?v=`/`sw.js`.)

## La final
```bash
git add server/routes/formulare/ord.mjs server/tests/db/ord-display-status-list.test.mjs package.json
git commit -m "fix(ord): predicat NULL-safe pentru display_status pe flux activ (IS DISTINCT FROM, ca flow_active) (v3.9.594)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: predicatul nou (identic cu `flow_active` din detaliu), fixture-ul testului fără `completed`, status CI. Confirmare owner pe staging: ORD 321 (flux activ, neaprobată) → „🔄 Trimis flux".
