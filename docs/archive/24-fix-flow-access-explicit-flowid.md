---
fix(sec): isFlowAccessAllowed folosește flowId explicit (din URL), nu data.flowId — repară acces destinatar pe fluxuri fără flowId în JSONB
target_branch: develop
model_suggested: Opus 4.8 (authz — mic dar sensibil)
risk: SCĂZUT (fix chirurgical de semnătură + call-sites)
version: 3.9.603 → 3.9.604
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema
Testul `server/tests/db/flow-transmite-interna.test.mjs` (cazul 6: „acces GET /flows/:id — destinatar ne-semnatar 200, străin 403") pică cu `expected 403 to be 200`.

Cauză: `isFlowAccessAllowed(pool, actor, data, signerToken)` din `server/services/flow-access.mjs` derivă id-ul fluxului din `data.flowId`. Dar `getFlowData()` întoarce blob-ul JSONB brut (`f.data`) și **NU** garantează `data.flowId` (există doar dacă a fost persistat la creare; lipsește pentru fluxuri inserate direct în test și pentru fluxuri legacy). Când lipsește, funcția iese cu `false` → destinatarul legitim primește 403. Cheia autoritativă e **id-ul din URL** (`req.params.flowId`), nu JSONB-ul.

# 🚫 NO-TOUCH
Semnare integral. Financiar ALOP. `flow-transmit.mjs` (doar importat). Logica `canActorReadFlow` — neschimbată. **NU** slăbi și **NU** rescrie testul `flow-transmite-interna.test.mjs` (case 6) — fix-ul de cod trebuie să-l facă verde așa cum e.

# Implementare

## 1. `server/services/flow-access.mjs` — primește `flowId` explicit
Schimbă semnătura `isFlowAccessAllowed` să accepte `flowId` ca parametru, cu fallback la `data.flowId` (back-compat pentru apelanți care nu-l pasează încă):
```js
export async function isFlowAccessAllowed(pool, actor, data, signerToken, flowId = null) {
  if (canActorReadFlow(actor, data, signerToken)) return true;
  const fid = flowId || data?.flowId || null;
  if (!actor || !fid) return false;
  return await isFlowRecipient(pool, fid, actor);
}
```
`canActorReadFlow` rămâne exact cum e (nu depinde de flowId).

## 2. Call-sites — pasează `req.params.flowId`
În fiecare apel al `isFlowAccessAllowed`, adaugă id-ul din URL ca ultim argument:

`server/routes/flows/crud.mjs` (3 apeluri): `GET /flows/:flowId`, `GET /flows/:flowId/signed-pdf`, `GET /flows/:flowId/pdf`:
```js
if (!(await isFlowAccessAllowed(pool, actor, data, signerToken, req.params.flowId))) return res.status(403)...;
```

`server/routes/flows/attachments.mjs` (2 apeluri): `GET /flows/:flowId/attachments`, `GET /flows/:flowId/attachments/:attId`:
```js
if (!(await isFlowAccessAllowed(pool, actor, data, signerToken, req.params.flowId))) return res.status(403)...;
```
(La ruta `/attachments/:attId`, `req.params.flowId` e tot disponibil — `attId` e separat.)

# Verificare
```bash
# Trebuie să fie 5 apeluri, toate cu req.params.flowId ca al 5-lea argument:
grep -rn "isFlowAccessAllowed(" server/routes/flows/crud.mjs server/routes/flows/attachments.mjs
```
- `flow-transmite-interna.test.mjs` (case 6) → **verde** (destinatarul primește 200; străinul rămâne 403).
- `flow-doc-acl.test.mjs` → rămâne verde (deja pasa; acum robust indiferent de fixture).
- `flow-access.test.mjs` unit → verde. Dacă vreun caz unit apela `isFlowAccessAllowed` bazându-se pe `data.flowId`, adaugă un caz care pasează `flowId` explicit; nu șterge cazuri.
- `npm test verde, fără regresii`; `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/services/flow-access.mjs`, `server/routes/flows/crud.mjs`, `server/routes/flows/attachments.mjs`, `package.json` (și opțional `server/tests/unit/flow-access.test.mjs` dacă adaugi un caz — NU alte teste).
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|flow-transmit\.mjs|alop\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
```
Backend-only → fără `?v=`/`CACHE_VERSION`. Bump `package.json` 3.9.603 → 3.9.604.

# La final
```bash
git add server/services/flow-access.mjs server/routes/flows/crud.mjs server/routes/flows/attachments.mjs package.json
# adaugă flow-access.test.mjs DOAR dacă l-ai completat
git commit -m "fix(sec): isFlowAccessAllowed primește flowId explicit din URL (repară acces destinatar pe fluxuri fără flowId în JSONB) (v3.9.604)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Cele 5 apeluri pasează `req.params.flowId`.
2. `flow-transmite-interna.test.mjs` case 6 verde fără să fi modificat testul.
3. Status CI complet (DB suite verde: `npm test` fără fail).
