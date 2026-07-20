---
prompt: 78
titlu: "fix(filtru): STATUS „Trimis flux" prinde și documentele split-path (aliniat cu badge-ul derivat)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: filtru listă DF/ORD (read-only)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Bug (minor, display)
Filtrul STATUS „Trimis flux" folosește `fd.status='transmis_flux'` **brut** (`shared.mjs:444`, ramura `else`). Dar badge-ul „TRANSMIS ÎN FLUX" e **derivat** (linia 485): apare și când `fd.status='completed'` cu flux activ (split-path). Deci un document care arată badge „Trimis flux" **nu e prins** de filtrul „Trimis flux".

## Fix — `server/routes/formulare/shared.mjs`, blocul de filtrare status (~438-446)
Adaugă o ramură `transmis_flux` care replică EXACT condiția din `badge_status` (linia 485-490), pe lângă statusul brut:
```js
      if (status && status !== 'all') {
        if (status === 'aprobat') {
          conds.push(`fd.status='completed' AND f.data->>'status'='completed' AND fd.flow_id IS NOT NULL`);
        } else if (status === 'respins') {
          conds.push(`fd.flow_id IS NOT NULL AND f.data->>'status' IN ('refused','rejected')`);
        } else if (status === 'transmis_flux') {
          conds.push(`(
            fd.status='transmis_flux'
            OR (
              fd.status='completed'
              AND fd.flow_id IS NOT NULL
              AND f.deleted_at IS NULL
              AND (f.data->>'completed') IS DISTINCT FROM 'true'
              AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
            )
          )`);
        } else {
          conds.push(`fd.status=$${params.push(status)}`);
        }
      }
```
(Condiția split-path e identică cu cea care derivă `badge_status='transmis_flux'` → filtrul = badge-ul.)

## Ce NU atingem
- ⛔ `badge_status`, alte ramuri de filtru, orice scriere. Doar ramura `transmis_flux` din filtru.

## Test
`server/tests/**` — extinde testele de filtrare: un DF split-path (`fd.status='completed'`, flux activ) cu badge `transmis_flux` → apare la filtrul `status=transmis_flux`; un DF `completed` fără flux → NU apare. `npm test verde`.

## Cache busting + versiune
Doar server + test ⇒ fără `sw.js`/`?v=`. Bump `package.json`.

## Guardrails diff
EXCLUSIV: `server/routes/formulare/shared.mjs`, testul, `package.json`.
```bash
git diff server/routes/formulare/shared.mjs | grep -iE "badge_status|UPDATE|INSERT|DELETE" && echo "⚠️ verifică: doar ramura de filtru transmis_flux" || echo "✅ doar filtru"
```

## Verificare (owner, staging)
Filtru STATUS = „Trimis flux" → apar și documentele care arată badge „Trimis flux" prin flux activ (split-path), nu doar cele cu `fd.status='transmis_flux'` brut.

## Final
```bash
git add server/routes/formulare/shared.mjs server/tests package.json
git commit -m "fix(filtru): Trimis flux prinde si split-path (aliniat cu badge_status)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
