---
prompt: 81
titlu: "fix(filtru status): „Aprobat"/„Completat" aliniate EXACT cu badge_status derivat (DF + ORD) — elimină driftul filtru↔badge"
model_suggested: Opus 4.8
branch: develop
zona: ⚠️ filtrare listă DF/ORD pe producție (read-only) · complement/corecție la #78
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ DOAR filtrare (WHERE). Zero scrieri, zero schimbare de semantică badge afișat.

## Bug (confirmat — capturi owner)
1. Filtru STATUS = „Completat" → apar și documentele cu badge „Aprobat" (și „Trimis flux").
2. Filtru STATUS = „Aprobat" → 0 rezultate (DF **și** ORD).

## Cauză
La finalizarea fluxului, `signing.mjs:389` scrie **`status='aprobat'` brut** pe DF; la link (non-split-path) se scrie `status='transmis_flux'` brut; split-path lasă `status='completed'`. Filtrul actual (`shared.mjs`, blocurile DF ~439 și ORD ~556) NU corespunde derivării `badge_status`:
- ramura `aprobat` cere `fd.status='completed'` (dar aprobatele au `fd.status='aprobat'`) → gol;
- ramura `else` pentru `completed` = `fd.status='completed'` brut → prinde și aprobate (flow_id+flux completat) și transmise.

`badge_status` derivă (neschimbat — sursa de adevăr a ce vede userul):
- `transmis_flux` ⟺ `fd.status='completed' AND fd.flow_id NOT NULL AND flux activ`
- `aprobat` ⟺ (nu transmis) `AND fd.flow_id NOT NULL AND flux completat` … SAU `fd.status='aprobat'` (ELSE)
- `completed` ⟺ `fd.status='completed'` care NU derivă transmis/aprobat
- restul ⟺ `fd.status` brut

## Fix — `server/routes/formulare/shared.mjs`, AMBELE blocuri
Definește fragmentele o singură dată per bloc (imediat înainte de `if (status && status !== 'all')`), IDENTICE cu CASE-urile din `badge_status` (ca să nu mai existe drift), apoi folosește-le în ramuri.

### Bloc DF (aliasuri `fd` / `f`, filtru ~438, badge ~483)
```js
      // Fragmente = aceleași condiții ca în badge_status (linia ~485/492) — sursă unică, fără drift.
      const _dfTransmis = `fd.status='completed' AND fd.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'completed') IS DISTINCT FROM 'true' AND (f.data->>'status') IS DISTINCT FROM 'cancelled'`;
      const _dfAprobat  = `fd.flow_id IS NOT NULL AND ((f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true)`;

      if (status && status !== 'all') {
        if (status === 'transmis_flux') {
          conds.push(`(${_dfTransmis})`);
        } else if (status === 'aprobat') {
          conds.push(`(fd.status='aprobat' OR (${_dfAprobat}))`);
        } else if (status === 'respins') {
          conds.push(`fd.flow_id IS NOT NULL AND f.data->>'status' IN ('refused','rejected')`);
        } else if (status === 'completed') {
          conds.push(`fd.status='completed' AND NOT (${_dfTransmis}) AND NOT (${_dfAprobat})`);
        } else {
          conds.push(`fd.status=$${params.push(status)}`);
        }
      }
```

### Bloc ORD (aliasuri `fo` / `f`, filtru ~555, badge ~585)
Identic, cu `fo` în loc de `fd`:
```js
      const _foTransmis = `fo.status='completed' AND fo.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'completed') IS DISTINCT FROM 'true' AND (f.data->>'status') IS DISTINCT FROM 'cancelled'`;
      const _foAprobat  = `fo.flow_id IS NOT NULL AND ((f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true)`;

      if (status && status !== 'all') {
        if (status === 'transmis_flux') {
          conds.push(`(${_foTransmis})`);
        } else if (status === 'aprobat') {
          conds.push(`(fo.status='aprobat' OR (${_foAprobat}))`);
        } else if (status === 'respins') {
          conds.push(`fo.flow_id IS NOT NULL AND f.data->>'status' IN ('refused','rejected')`);
        } else if (status === 'completed') {
          conds.push(`fo.status='completed' AND NOT (${_foTransmis}) AND NOT (${_foAprobat})`);
        } else {
          conds.push(`fo.status=$${params.push(status)}`);
        }
      }
```

> IMPORTANT: fragmentele TREBUIE să reproducă textual condițiile din `badge_status` (verifică la ~485-493 DF și ~591-599 ORD). Dacă acolo diferă vreo condiție (ex. #76 a adăugat vreun `refused` în derivarea listei), copiaz-o și în fragment, ca filtrul să rămână egal cu badge-ul. NU modifica `badge_status` însuși în acest prompt.

## Verificare mentală (badge ⟺ filtru)
- doc `fd.status='aprobat'` (flux finalizat) → badge „Aprobat" → prins de `aprobat`, exclus de `completed` (NOT `_dfAprobat`? — nu, `fd.status='aprobat'`≠'completed', deci ramura `completed` nici nu se aplică). ✅
- doc `fd.status='completed'`, `flow_id` NULL → badge „Completat" → prins de `completed`, NU de `aprobat`. ✅
- doc `fd.status='completed'` + flux activ → badge „Trimis flux" → prins de `transmis_flux`, exclus de `completed`. ✅

## Ce NU atingem
- ⛔ `badge_status` (rămâne sursa de afișare). ⛔ Orice scriere de status. ⛔ `signing.mjs`. ⛔ Alte filtre (nr/inițiator/dată/comp).

## Test (extinde matricea de badge existentă)
`server/tests/**` — pentru DF și ORD, inserează documente în stările: `aprobat` brut; `completed`+flow_id+flux completat; `completed`+flow_id NULL; `completed`+flux activ; `transmis_flux` brut; `neaprobat`. Aserție cheie: **pentru fiecare valoare V ∈ {aprobat, completed, transmis_flux}, setul returnat de filtrul `status=V` = exact documentele cu `badge_status=V`** (filtru ⟺ badge). `npm test verde, fără regresii`.

## Cache busting + versiune
- Doar server ⇒ FĂRĂ `?v=`/`sw.js`. Bump `package.json` (următorul patch).

## Guardrails diff
EXCLUSIV: `server/routes/formulare/shared.mjs`, `server/tests/**`, `package.json`.
```bash
git diff server/routes/formulare/shared.mjs | grep -iE "UPDATE|INSERT|DELETE|SET status|badge_status" && echo "⚠️ verifică: doar ramurile de filtru, badge_status NEATINS" || echo "✅ doar filtru"
```

## Verificare (owner, staging)
- Filtru „Aprobat" (DF) → apar exact documentele cu badge „Aprobat" (inclusiv ALOP finalizate). ORD la fel.
- Filtru „Completat" → DOAR cele cu badge „Completat" (fără aprobate/transmise). Ex. 2469 „Servicii IT" apare la „Completat", NU la „Aprobat".
- Filtru „Trimis flux" → neschimbat (split-path prins, ca la #78).

## Final
```bash
git add server/routes/formulare/shared.mjs server/tests package.json
git commit -m "fix(filtru-status): Aprobat/Completat aliniate cu badge_status (DF+ORD), fara drift filtru-badge"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
