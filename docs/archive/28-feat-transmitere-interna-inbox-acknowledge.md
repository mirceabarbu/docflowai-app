---
feat: Etapa 2c — inbox durabil „📥 Primite / Repartizate mie" + confirmare luare la cunoștință per-persoană
target_branch: develop
model_suggested: Opus 4.8 (migrație + endpointuri authz + tab frontend cu sursă de date separată)
risk: MEDIU (migrație nouă + 2 endpointuri + UI custom) — aditiv, refolosește flow_recipients din Etapa 1
version: 3.9.607 → 3.9.608
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop
Problema: destinatarul ajunge la documentul repartizat DOAR prin notificarea `REPARTIZAT`, care e efemeră — dacă o șterge, nu mai are de unde să-l ia și nici cum să confirme. Datele persistă însă în `flow_recipients` (Etapa 1). Adăugăm:
1. un inbox **durabil** „📥 Primite" (tab în pagina de notificări) care citește `flow_recipients`, independent de notificări;
2. **confirmare de luare la cunoștință per-persoană** (nu per-compartiment) — pentru că o repartizare către compartiment are un singur rând, dar fiecare membru trebuie să confirme individual.

# 🚫 NO-TOUCH
Semnare integral. Financiar ALOP. `flow-access.mjs` — neschimbat. `flow-transmit.mjs` — se **extinde ADITIV** (funcții noi exportate; NU modifica `normalizeRecipients`/`transmitFlowTo`/`isFlowRecipient`/`resolveRecipientEmails` existente).

# Etapa 0 — caracterizare
```bash
grep -oE "id: '[0-9]{3}_[a-z_]+'" server/db/index.mjs | tail -3   # confirmă 088 flow_recipients ultima → 089 liberă
grep -n "export function loadActorComp\|export async function loadActorComp" server/services/authz-formular.mjs
grep -n "export async function isFlowRecipient\|export async function resolveRecipientEmails" server/services/flow-transmit.mjs
grep -n "data-filter\|filter-btn\|FORMULARE_TYPES\|renderList\|updateTabCounts\|_apiFetch('/api/notifications" public/js/notifications/notifications.js | head
grep -n "filter-btn\|data-filter\|notifications.js?v=\|notifications.css?v=" public/notifications.html
grep -n '"version"' package.json | head -1
grep -n "CACHE_VERSION" public/sw.js
```
Confirmă: id-ul de coloană al actorului (`actor.userId` vs `actor.id`); forma butoanelor de tab în `notifications.html`.

# Implementare — BACKEND

## 1. Migrație inline `089_flow_recipient_acks` în `server/db/index.mjs`
Confirmare per-persoană (uniformă pentru țintă user și compartiment):
```sql
CREATE TABLE IF NOT EXISTS flow_recipient_acks (
  flow_id         TEXT        NOT NULL REFERENCES flows(id),
  user_id         INTEGER     NOT NULL REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, user_id)
);
```

## 2. `server/services/flow-transmit.mjs` — funcții noi (ADITIV)
- `async listReceivedFor(pool, userId, actorComp)`:
  ```sql
  SELECT fr.flow_id,
         f.data->>'docName'   AS doc_name,
         fr.rezolutie, fr.transmitted_at, fr.source,
         fr.recipient_compartiment,
         tb.email AS transmitted_by_email, tb.nume AS transmitted_by_name,
         ack.acknowledged_at  AS acknowledged_at
  FROM flow_recipients fr
  JOIN flows f ON f.id = fr.flow_id AND f.deleted_at IS NULL
  LEFT JOIN users tb ON tb.id = fr.transmitted_by
  LEFT JOIN flow_recipient_acks ack ON ack.flow_id = fr.flow_id AND ack.user_id = $1
  WHERE fr.recipient_user_id = $1
     OR ($2 <> '' AND TRIM(fr.recipient_compartiment) = $2)
  ORDER BY fr.transmitted_at DESC
  LIMIT 200
  ```
  (params `[userId, (actorComp||'').trim()]`). Dedup pe `flow_id` dacă un flux apare și pe user și pe compartiment (păstrează un rând).
- `async acknowledgeReceipt(pool, flowId, userId)`:
  `INSERT INTO flow_recipient_acks (flow_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING acknowledged_at;`
  întoarce `acknowledged_at` (nou sau, la conflict, fă un SELECT să întorci valoarea existentă — idempotent).

## 3. `server/routes/flows/transmit.mjs` — 2 endpointuri noi
Importă suplimentar `loadActorComp` din `../../services/authz-formular.mjs` și `isFlowRecipient, listReceivedFor, acknowledgeReceipt` din flow-transmit.

- `GET /api/my-received`:
  ```js
  const actor = requireAuth(req, res); if (!actor) return;
  const comp = await loadActorComp(pool, actor.userId || actor.id);
  const rows = await listReceivedFor(pool, actor.userId || actor.id, comp);
  res.json(rows);
  ```
- `POST /flows/:flowId/acknowledge`:
  ```js
  const actor = requireAuth(req, res); if (!actor) return;
  const { flowId } = req.params;
  if (!(await isFlowRecipient(pool, flowId, actor))) return res.status(403).json({ error: 'forbidden' });
  const acknowledged_at = await acknowledgeReceipt(pool, flowId, actor.userId || actor.id);
  res.json({ ok: true, acknowledged_at });
  ```
  (`isFlowRecipient` garantează că doar un destinatar legitim — user sau membru al compartimentului — poate confirma.)

# Implementare — FRONTEND

## 4. `public/notifications.html`
Adaugă un buton de tab (lângă celelalte `.filter-btn`): `data-filter="primite"` cu textul „📥 Primite". Bump `?v=` pe `notifications.js` și `notifications.css`.

## 5. `public/js/notifications/notifications.js`
- La încărcare, în paralel cu notificările, `fetch('/api/my-received')` → `receivedItems` (array separat de `allNotifs`).
- `filtered()` / `renderList()`: când `currentFilter === 'primite'`, NU folosi `allNotifs`; randează `receivedItems` cu un card dedicat:
  - titlu = `doc_name` (fallback flow_id);
  - meta = „Transmis de {transmitted_by_name||email}` · `{timeAgo(transmitted_at)}`” + `flow_id`;
  - dacă `rezolutie` → afișeaz-o („Rezoluție: …”);
  - badge status: `acknowledged_at ? '✅ Confirmat' : '⏳ Neconfirmat'`;
  - buton „Deschide documentul" → `location.href = '/flow.html?flow=' + encodeURIComponent(flow_id)`;
  - buton „Confirm luare la cunoștință" (afișat doar dacă `!acknowledged_at`) → `POST /flows/${flow_id}/acknowledge` → la 200, setează `item.acknowledged_at` local + re-render.
  - Fără inline handlers noi în codul pe care-l ADAUGI — folosește `addEventListener` (CSP). (Codul existent are `onclick=` inline; nu-l reproduce în ramura nouă.)
- `updateTabCounts()`: adaugă `primite` cu badge = numărul de **neconfirmate** (`receivedItems.filter(r=>!r.acknowledged_at).length`), în hartă de `labels` `primite:'📥 Primite'`.
- `tabMap` (deep-link din URL): adaugă `primite:'primite'` (pentru `?tab=primite`).

## 6. `public/css/notifications/notifications.css`
Stiluri minime pentru cardul „primite" (poți refolosi `.notif-card`), badge confirmat/neconfirmat, cele 2 butoane. Scoped, fără a schimba stilurile existente.

# Teste — `server/tests/db/flow-received-ack.test.mjs` (server/tests/db/**, auto-skip fără TEST_DATABASE_URL)
- `GET /api/my-received`: user cu o repartizare directă → o vede; user dintr-un compartiment repartizat → o vede; user fără nicio repartizare → listă goală. Fluxurile șterse (`deleted_at`) NU apar.
- `POST /flows/:id/acknowledge`: destinatar (user) → 200, apare rând în `flow_recipient_acks`; a doua oară → 200 idempotent (același `acknowledged_at`, fără duplicat); **străin (ne-destinatar) → 403**; anonim → 401.
- Confirmare **per-persoană** pe compartiment: doi useri din același compartiment repartizat — unul confirmă → celălalt vede în continuare `acknowledged_at = null` în `my-received`.

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/db/index.mjs`, `server/services/flow-transmit.mjs`, `server/routes/flows/transmit.mjs`, `public/notifications.html`, `public/js/notifications/notifications.js`, `public/css/notifications/notifications.css`, `public/sw.js`, `server/tests/db/flow-received-ack.test.mjs` (nou), `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|flow-access\.mjs|alop\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
git diff server/services/flow-transmit.mjs | grep -nE "^-.*(normalizeRecipients|transmitFlowTo|isFlowRecipient|resolveRecipientEmails)" && echo "⛔ ai modificat funcții existente!" || echo "✅ doar adăugiri"
```

# Cache busting + versiune
- bump `package.json` 3.9.607 → 3.9.608;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.608` pe `notifications.js` + `notifications.css` în `public/notifications.html`.

# La final
```bash
git add server/db/index.mjs server/services/flow-transmit.mjs server/routes/flows/transmit.mjs public/notifications.html public/js/notifications/notifications.js public/css/notifications/notifications.css public/sw.js server/tests/db/flow-received-ack.test.mjs package.json
git commit -m "feat(flows): inbox durabil Primite + confirmare luare la cunoștință per-persoană (flow_recipient_acks) (v3.9.608)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Migrația 089 idempotentă; `flow-transmit.mjs` doar extins (funcții existente neatinse — guardrail verde).
2. `/api/my-received` întoarce repartizările (user + compartiment), exclude fluxuri șterse; `acknowledge` per-persoană, idempotent, străin→403.
3. Tabul „📥 Primite" citește `flow_recipients` (durabil — ștergerea notificării NU pierde documentul); badge = neconfirmate.
4. Confirmarea pe compartiment e per-persoană (un membru confirmă, ceilalți rămân neconfirmați).
5. Status CI (`npm test` + `npm run check`); versiune 3.9.608.
6. Verificare staging: repartizezi un flux către un compartiment → un membru vede în „📥 Primite", deschide documentul, apasă „Confirm luare la cunoștință" → badge devine „✅ Confirmat" doar pentru el.
