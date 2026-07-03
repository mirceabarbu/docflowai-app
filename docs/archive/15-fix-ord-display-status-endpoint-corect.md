---
fix: ORD pe flux tot afișează „Completat" — display_status a fost pus pe ENDPOINT-UL GREȘIT (ord.mjs); lista reală e /api/formulare/list
target_branch: develop
model_suggested: Sonnet 4.6 (mută derivarea pe endpoint-ul corect + test pe endpoint-ul corect)
risk: SCĂZUT — read-only, lifecycle neatins
version: 3.9.594 → 3.9.595
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Semnare (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`) + lifecycle (`flows/crud.mjs`, `flows/lifecycle.mjs`, `flows/signing.mjs`, `formular-shared.mjs`). În `shared.mjs` atingi DOAR ramura ORD a query-ului din `/api/formulare/list` — NU părțile de upload/captură/atașamente.

## Context — de ce ultimele 2 fix-uri n-au schimbat nimic
Lista din UI cheamă `GET /api/formulare/list` (centralizat DF+ORD, `server/routes/formulare/shared.mjs:385`), `loadList()` în `list.js:437`. Fix-urile v3.9.593/594 au pus `display_status` pe `GET /api/formulare-ord` (`ord.mjs`) — **un endpoint pe care lista NU-l folosește**. De-asta badge-ul tot arată „Completat": ramura ORD din `/api/formulare/list` (`shared.mjs:~567-595`) întoarce `fo.status` + `aprobat`, dar NU `display_status` → badge-ul cade pe `aprobat?…:status`.

Frontend-ul citește deja `row.display_status` (din v3.9.593) — lipsește doar de pe endpoint-ul corect.

## Etapa 0 — caracterizare (confirmă ținta)
```bash
# 1. Endpoint-ul REAL al listei + ramura ORD (alias flows = 'f', join f.id::text = fo.flow_id)
sed -n '560,596p' server/routes/formulare/shared.mjs
# 2. Confirmă că frontend-ul citește display_status în badge
grep -n "display_status\|_stBadge(" public/js/formular/list.js
# 3. Predicatul NULL-safe corect (flow_active din detaliu) — de refolosit identic
grep -n "flow_active\|IS DISTINCT FROM" server/routes/formulare/ord.mjs
```

## Implementare

### 1. `server/routes/formulare/shared.mjs` — ramura ORD din `/api/formulare/list`: adaugă `display_status`
În SELECT-ul ramurii ORD (`FROM formulare_ord fo LEFT JOIN flows f ON f.id::text = fo.flow_id`), adaugă coloana derivată, folosind aliasul existent **`f`** și predicatul **NULL-safe** (identic cu `flow_active` din detaliu):
```sql
CASE
  WHEN fo.status = 'completed'
   AND fo.flow_id IS NOT NULL
   AND f.deleted_at IS NULL
   AND (f.data->>'completed') IS DISTINCT FROM 'true'
   AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
  THEN 'transmis_flux'
  ELSE fo.status
END AS display_status
```
NU alia `fo.status` brut (lasă-l cum e). NU atinge ramura DF. Verifică că `display_status` supraviețuiește prin `rows.map(r => { const { total, ...rest } = r; return rest; })` (da — se păstrează toate câmpurile mai puțin `total`).

### 2. Curățenie — elimină `display_status` mort din `ord.mjs` (endpoint nefolosit de listă)
```bash
# Verifică dacă GET /api/formulare-ord (lista) e folosit undeva în frontend
grep -rn "formulare-ord'" public/js/ | grep -v "formulare-ord/" | grep -iE "fetch|/api/formulare-ord\b" || echo "(lista /api/formulare-ord pare nefolosită de UI)"
```
Dacă lista `/api/formulare-ord` NU e folosită de UI: **revino** la `display_status`-ul + JOIN-ul adăugate în `ord.mjs` la v3.9.593/594 (erau pe endpoint greșit) — evită driftul „două locuri". Dacă ESTE folosită undeva, lasă-l (comportament consistent). Predicatul `aprobat`/`flow_active` din detaliul ord.mjs (`GET /:id`) rămâne neatins în ambele cazuri.

### 3. Test — pe ENDPOINT-UL CORECT
Mută/scrie testul ca să lovească `GET /api/formulare/list?type=ord` (NU `/api/formulare-ord`). Fixture flux **fără** cheia `completed` (flux în curs real). Cazuri:
- ORD `completed` + flux activ (data fără `completed`) → în răspuns `display_status='transmis_flux'`.
- ORD `aprobat` (flux `completed:true`) → `display_status` ≠ transmis_flux.
- ORD `completed` fără flux → `display_status='completed'`.
- ORD pe flux `cancelled` sau șters → `display_status='completed'`.

## Teste
`npm test verde, fără regresii`. (DB auto-skip local; autoritativ în CI.) `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/formulare/shared.mjs`, `server/routes/formulare/ord.mjs` (doar revert curățenie, dacă se aplică), testul, `package.json`. (Fără frontend → fără cache-bust.)
```bash
git diff --name-only | grep -E "flows/|formular-shared\.mjs|list\.js|STSCloud|cloud-signing|pades" && echo "⛔ STOP: zonă interzisă!" || echo "✅ doar lista reală + curățenie"
git diff server/routes/formulare/shared.mjs | grep -iE "atasament|captura|INSERT|upload" && echo "⛔ STOP: ai atins upload/captură în shared.mjs!" || echo "✅ doar query lista"
```

## Versiune
- bump `package.json`: `3.9.594` → `3.9.595`.

## La final
```bash
git add server/routes/formulare/shared.mjs server/routes/formulare/ord.mjs server/tests/... package.json
git commit -m "fix(ord): display_status pe endpoint-ul REAL /api/formulare/list (ramura ORD); curățenie ord.mjs (v3.9.595)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: confirmarea că `/api/formulare/list?type=ord` întoarce acum `display_status`, dacă ai făcut curățenia în ord.mjs, status CI. Confirmare owner pe staging: ORD 321 → „🔄 Trimis flux".
