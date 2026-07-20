---
prompt: 82
titlu: "fix(filtru status, hotfix #81): negare NULL-safe (IS NOT TRUE) — fluxul activ face _dfAprobat=NULL și excludea transmis_flux brut"
model_suggested: Opus 4.8
branch: develop
zona: ⚠️ filtrare listă DF/ORD (read-only) · hotfix la #81 · pică 3 teste DB în CI
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ DOAR filtrare (WHERE). Corecție de logică trei-valori la #81.

## Bug (prins de CI — 3 teste DB roșii)
`server/tests/db/formulare-status-display.test.mjs`:
1. „`status=transmis_flux` brut (persistat) → apare la filtru" — `expected true, received undefined`.
2/3. „filtru = badge pentru aprobat/completed/transmis_flux" (DF și ORD) — setul returnat are cu 1 doc mai puțin (lipsește exact documentul `transmis_flux` brut).

## Cauză — trei-valori (NULL) în negare
Fragmentul `_dfAprobat` (și `_foAprobat`) conține `(f.data->>'completed')::boolean = true`. Pentru un flux **activ** (proaspăt legat, `fd.status='transmis_flux'` brut), `f.data->>'completed'` e NULL:
- `NULL::boolean = true` → **NULL** (unknown), deci `_dfAprobat` = `fd.flow_id IS NOT NULL AND (false OR NULL)` = **NULL**.
- `NOT (_dfAprobat)` = `NOT NULL` = **NULL** → `fd.status='transmis_flux' AND NULL` = **NULL** → WHERE exclude rândul.

`badge_status` NU pățește (în `CASE WHEN <NULL>` cade pe ELSE → 'transmis_flux'), dar **negarea** din filtru propagă NULL-ul → filtru ⟍ badge exact pe cazul negat.

## Fix — negare NULL-safe în AMBELE blocuri (`server/routes/formulare/shared.mjs`)
Înlocuiește fiecare `NOT (<fragment>)` din ramurile de filtru cu `(<fragment>) IS NOT TRUE`.
`(X) IS NOT TRUE` = `NOT X` pentru true/false, dar mapează **NULL → true** (adică „nu e aprobat/transmis"), care e exact semantica dorită (necunoscut ⇒ nu aparține acelui badge).

### Bloc DF (`_dfTransmis` / `_dfAprobat`)
- ramura `transmis_flux`: `... OR (fd.status='transmis_flux' AND NOT (${_dfAprobat}))`
  → `... OR (fd.status='transmis_flux' AND (${_dfAprobat}) IS NOT TRUE)`
- ramura `aprobat`: `NOT (${_dfTransmis}) AND (...)`
  → `(${_dfTransmis}) IS NOT TRUE AND (...)`
- ramura `completed`: `... AND NOT (${_dfTransmis}) AND NOT (${_dfAprobat})`
  → `... AND (${_dfTransmis}) IS NOT TRUE AND (${_dfAprobat}) IS NOT TRUE`

### Bloc ORD (`_foTransmis` / `_foAprobat`)
Identic, pe fragmentele `_fo…`.

> Critic e `_dfAprobat`/`_foAprobat` (au `::boolean = true` → poate fi NULL). `_dfTransmis`/`_foTransmis` folosesc `IS DISTINCT FROM` (deja NULL-safe, dau true/false), dar aplică `IS NOT TRUE` și pe ele — inofensiv și consecvent.
> Ramurile POZITIVE (`_dfAprobat` direct, fără NOT) rămân neschimbate: acolo NULL→exclude e corect (necunoscut ⇒ nu-l pui în „aprobat"), consecvent cu `CASE WHEN` din badge.

## Ce NU atingem
- ⛔ `badge_status` (COALESCE-ul e neschimbat — sursa de afișare). ⛔ Fragmentele în sine (doar negarea lor). ⛔ Orice scriere. ⛔ Ramura `respins` / `else`.

## Test
Testele existente (matricea filtru⟺badge de la #81) trebuie să devină VERZI — inclusiv cazul `transmis_flux` brut cu flux activ. Verifică local DACĂ ai Docker; altfel rulează în CI. Dacă vrei siguranță suplimentară, adaugă un caz explicit: DF cu `fd.status='transmis_flux'` + flux activ (`data` fără `completed`, `status≠'completed'`) → apare la `filtru=transmis_flux` ȘI `badge_status='transmis_flux'`. `npm test verde, fără regresii`.

## Cache busting + versiune
Doar server ⇒ FĂRĂ `?v=`/`sw.js`. Bump `package.json` (următorul patch).

## Guardrails diff
EXCLUSIV: `server/routes/formulare/shared.mjs`, (opțional) testul, `package.json`.
```bash
git diff server/routes/formulare/shared.mjs | grep -c "IS NOT TRUE"   # aștept 6 (3 ramuri × 2 blocuri; sau mai multe dacă completed are 2)
git diff server/routes/formulare/shared.mjs | grep -iE "badge_status|UPDATE|INSERT|DELETE" && echo "⚠️ verifică: doar negări în filtru" || echo "✅ doar filtru"
```

## Verificare (owner, staging + CI)
- CI verde pe push develop (cele 3 teste DB de la #81 trec).
- Filtru „Trimis flux" → apar și documentele `transmis_flux` brute (flux activ), și split-path.
- „Aprobat"/„Completat" — neschimbate față de comportamentul corect de la #81.

## Final
```bash
git add server/routes/formulare/shared.mjs server/tests package.json
git commit -m "fix(filtru-status): negare NULL-safe (IS NOT TRUE) pentru _dfAprobat/_foAprobat (hotfix #81)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
