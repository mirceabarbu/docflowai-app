---
prompt: 76
titlu: "fix(afișare ALOP): fluxul REFUZAT nu mai apare „Pe flux" — df_flow_active exclude refuzatele + badge/stepper folosesc df_flow_active (defense-in-depth)"
model_suggested: Opus 4.8
branch: develop
zona: ALOP display derivation (read-only) · complement la #74
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ DOAR AFIȘARE (read-only). Zero scrieri, zero mașină de stări.

## Context
#74 corectează **evenimentul** de refuz (de acum încolo). Dar înregistrările refuzate sub handler-ul vechi (ex. 2469) au `alop.df_flow_id` încă pe fluxul mort → ALOP arată greșit „Pe flux — semnare". Cauza de afișare (independentă de #74):
1. `df_flow_active` (derivat, #63) exclude `completed`/`cancelled` dar **NU `refused`** (`signing.mjs:97` setează `data.status='refused'`) → fluxul refuzat e considerat „activ".
2. Badge-ul și stepper-ul folosesc `df_flow_id` **brut**, nu `df_flow_active` → orice pointer setat → „Pe flux".

Fix-ul (ca #61/#63): derivă afișarea din starea reală a fluxului. Astfel 2469 & co. arată corect **imediat**, fără backfill.

## 1. Backend `server/routes/alop.mjs` — `df_flow_active` exclude și `refused`
În **ambele** derivări, adaugă condiția lângă cea de `cancelled`:

### Listă (~356, subquery cu `fdf`)
```sql
                      AND (fdf.data->>'status')    IS DISTINCT FROM 'cancelled'
                      AND (fdf.data->>'status')    IS DISTINCT FROM 'refused'
```

### Detaliu (~569, cu `f1`)
```sql
                  AND (f1.data->>'status')    IS DISTINCT FROM 'cancelled'
                  AND (f1.data->>'status')    IS DISTINCT FROM 'refused'
```
(Doar SELECT-uri derivate — fără scrieri.)

## 2. Frontend `public/js/formular/alop.js` — badge & stepper folosesc `df_flow_active`
### Badge (`_alopStatusBadge`, ~linia 78)
```js
  if(status==='angajare' && a && a.df_flow_active) s={icon:'ico-pen-tool',text:'Pe flux — semnare',color:'#6366f1'};
```
(Când fluxul NU e activ → rămâne default-ul `angajare` = „DF în lucru".)

### Stepper (~liniile 514-517) — consecvent pe `df_flow_active`
```js
        :(a.status==='angajare'&&a.df_flow_active)?`🔄 DF pe fluxul de semnare${_dfRevTxt}`
        :(a.df_revizie_nr>0 && a.df_flow_active && !a.df_aprobat)?`🔄 Revizia ${a.df_revizie_nr} pe flux — în curs · ultima aprobată: Revizia ${a.df_revizie_nr-1}`
        :(a.status==='angajare'&&!a.df_flow_active)?`📝 DF în lucru${_dfRevTxt}`
```
(Înlocuiește `a.df_flow_id` cu `a.df_flow_active` în cele două ramuri de „angajare"; ramura de revizie rămâne pe `df_flow_active`.)

## Ce NU atingem
- ⛔ Nicio scriere, niciun handler, nicio mașină de stări. ⛔ #74 (handler refuz) — deja livrat.
- ⛔ NU schimba logica de filtrare pe status (raw fd.status) — doar afișarea derivată.

## Test
`server/tests/db/alop-flux-refuzat-display.test.mjs`:
- ALOP la `angajare` cu `df_flow_id` pe flux `data.status='refused'` → `df_flow_active=false` (listă + detaliu).
- Sanity: flux activ (nici completed/cancelled/refused) → `df_flow_active=true` (non-regresie).
`npm test verde, fără regresii`.

## Cache busting + versiune
- FE atins (`alop.js`) ⇒ bump `?v=` la `alop.js` în `formular.html`.
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `server/routes/alop.mjs`, `public/js/formular/alop.js`, `public/formular.html`, `public/sw.js`, `package.json`, testul.
```bash
git diff server/routes/alop.mjs | grep -iE "UPDATE|INSERT|DELETE|SET " && echo "⛔ STOP: scriere!" || echo "✅ doar SELECT derivat"
```

## Verificare (owner, staging)
- ALOP „Servicii IT" (2469, flux refuzat) → **nu mai arată „Pe flux — semnare"**, ci „DF în lucru" (badge + stepper).
- Un flux activ real (pe semnare) → tot „Pe flux — semnare" (neschimbat).
- `npm test` verde.

## Final
```bash
git add server/routes/alop.mjs public/js/formular/alop.js public/formular.html public/sw.js package.json server/tests
git commit -m "fix(afisare-alop): flux refuzat nu mai apare Pe flux (df_flow_active exclude refused; badge/stepper pe df_flow_active)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
