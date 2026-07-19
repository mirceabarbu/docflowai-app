---
fix: REGRESIE — ORD aprobată afișează „Completat" (display_status='completed' scurtcircuitează fallback-ul aprobat); ELSE NULL
target_branch: develop
model_suggested: Sonnet 4.6 (o schimbare de un cuvânt în SQL + întărire teste)
risk: SCĂZUT — `ELSE fo.status` → `ELSE NULL` în display_status; read-only, lifecycle neatins
version: 3.9.595 → 3.9.596
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Semnare + lifecycle (`flows/crud.mjs`, `flows/lifecycle.mjs`, `flows/signing.mjs`, `formular-shared.mjs`). În `shared.mjs` atingi DOAR coloana `display_status` din ramura ORD a `/api/formulare/list` — nimic altceva (NU upload/captură/atașamente).

## Context — regresie introdusă de v3.9.595
Badge-ul listei (list.js) e: `row.display_status || (row.aprobat ? 'aprobat' : row.status)`. `display_status` din ramura ORD a `/api/formulare/list` (`shared.mjs`) are `ELSE fo.status`. Pentru o ORD **aprobată** (flux finalizat), CASE-ul cade pe `ELSE fo.status='completed'` — valoare **truthy** → scurtcircuitează `||` → **sare peste `aprobat`** → afișează „Completat" în loc de „Aprobat". (ORD 12S, ciclul 1, era corect „Aprobat" înainte.)

Cauza e că ramura ELSE returnează o valoare non-null care preia controlul în loc să lase fallback-ul existent (`aprobat ? 'aprobat' : status`) să ruleze.

## Etapa 0 — confirmă lanțul
```bash
# 1. Logica badge-ului (confirmă: display_status || (aprobat ? 'aprobat' : status))
grep -n "display_status\|_stBadge\|aprobat ?" public/js/formular/list.js
# 2. display_status actual din ramura ORD (ELSE fo.status — de schimbat)
grep -n "display_status\|ELSE fo.status\|END AS display_status" server/routes/formulare/shared.mjs
```

## Implementare

### 1. `server/routes/formulare/shared.mjs` — ramura ORD: `ELSE NULL`
Schimbă DOAR ramura ELSE a CASE-ului `display_status` (ramura ORD):
```sql
CASE
  WHEN fo.status = 'completed'
   AND fo.flow_id IS NOT NULL
   AND f.deleted_at IS NULL
   AND (f.data->>'completed') IS DISTINCT FROM 'true'
   AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
  THEN 'transmis_flux'
  ELSE NULL          -- ERA fo.status; NULL lasă fallback-ul frontend (aprobat?:status) să ruleze
END AS display_status
```
Astfel `display_status` e non-null DOAR pentru „pe flux activ"; în rest NULL → badge-ul folosește `aprobat ? 'aprobat' : status` exact ca înainte de v3.9.593. NU atinge predicatul `aprobat` (rămâne cum e). NU atinge ramura DF.

## Stări — verificare completă (toate prin `display_status || (aprobat ? 'aprobat' : status)`)
| Stare | display_status | aprobat | Badge |
|---|---|---|---|
| ORD pe flux activ (321) | `transmis_flux` | false | 🔄 Trimis flux |
| ORD aprobată / flux finalizat (12S) | NULL | true | 🟢 Aprobat |
| ORD completată fără flux | NULL | false | ✅ Completat |
| ORD flux șters/cancelled | NULL | false | ✅ Completat |
| draft / pending_p2 | NULL | false | status brut |

## 2. Teste — ÎNTĂREȘTE aserțiunile (asta a lăsat regresia să treacă)
În testul DB al listei (`/api/formulare/list?type=ord`), pentru cazul „flux finalizat" NU aserta doar „`display_status ≠ 'transmis_flux'`" — **aserția trebuie să fie pe rezultatul real**:
- ORD aprobată (flux `completed:true`) → `display_status` este **NULL/absent** ȘI `aprobat === true` (astfel badge-ul redă „Aprobat"). Aserția slabă veche a permis `'completed'` să treacă — înlocuiește-o.
- ORD pe flux activ (flux fără `completed`) → `display_status === 'transmis_flux'`.
- ORD completată fără flux → `display_status` NULL/absent ȘI `aprobat === false`.
Adaugă un comentariu scurt: „display_status non-null DOAR pentru transmis_flux; restul cade pe fallback-ul aprobat/status".

## Teste
`npm test verde, fără regresii` (asigură-te că `node_modules` e instalat — `xmllint-wasm` prezent). `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/formulare/shared.mjs`, testul DB, `package.json`.
```bash
git diff --name-only | grep -E "flows/|formular-shared\.mjs|list\.js|STSCloud|cloud-signing|pades" && echo "⛔ STOP!" || echo "✅ doar display_status + test"
git diff server/routes/formulare/shared.mjs | grep -iE "atasament|captura|upload|aprobat ?" && echo "⚠️ verifică: ai atins doar ELSE-ul display_status?" || echo "✅"
```

## Versiune
- bump `package.json`: `3.9.595` → `3.9.596`.

## La final
```bash
git add server/routes/formulare/shared.mjs server/tests/... package.json
git commit -m "fix(ord): display_status ELSE NULL — nu mai scurtcircuitează badge-ul aprobat (regresie 595) (v3.9.596)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: schimbarea (`ELSE NULL`), aserțiile întărite, status CI. Confirmare owner pe staging: ORD 321 → „Trimis flux" ȘI ORD 12S → „Aprobat" (ambele corecte simultan).
