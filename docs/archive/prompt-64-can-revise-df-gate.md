---
prompt: 64
titlu: "fix(ALOP): „Revizuiește DF" activ doar dacă DF-ul curent e aprobat ȘI nu există deja o revizie în lucru"
model_suggested: Opus 4.8
branch: develop
zona: ALOP capabilities · gard acțiune revizie
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Simptom (owner)
Butonul „Revizuiește DF" din detaliul ALOP e activ chiar și când DF-ul curent **nu e aprobat** (ex. e o revizie în draft) sau când există deja o revizie în lucru. Regula corectă: **activ doar dacă avem un DF aprobat ȘI nu este generat niciun alt DF în lucru** (draft/în completare/transmis/pe flux).

## Cauză (confirmată în cod)
`server/services/alop-capabilities.mjs:36`:
```js
caps.can_revise_df = caps.is_owner && !caps.is_cancelled && !!alop.df_id && !['draft', 'angajare'].includes(status);
```
Nu verifică nici `df_aprobat`, nici `df_revizie_in_lucru`. Fiindcă `/revizuieste` mută `alop.df_id` la noua revizie (draft), un ALOP post-angajare cu `df_id` = revizie draft are `can_revise_df=true` — greșit.

Ambele semnale există deja pe rândul trimis la `computeAlopCapabilities` (detaliu `alop.mjs`):
- `df_aprobat` (linia ~555) — DF-ul curent are flux completat.
- `df_revizie_in_lucru` (linia ~579) — `EXISTS` DF-copil cu status `draft/pending_p2/completed/returnat/transmis_flux/de_revizuit`.

## Fix (o singură expresie)
`server/services/alop-capabilities.mjs:36` — adaugă cele două condiții:
```js
  caps.can_revise_df = caps.is_owner && !caps.is_cancelled && !!alop.df_id
    && !['draft', 'angajare'].includes(status)
    && alop.df_aprobat === true          // doar dacă DF-ul curent e APROBAT
    && !alop.df_revizie_in_lucru;        // și nu există deja o revizie în lucru
```

**Corectitudine (verifică):**
- Caz legitim (DF R0 aprobat, fără revizie în lucru, status post-angajare) → `can_revise_df=true` (buton vizibil). NU se strică fluxul normal de revizie.
- Caz raportat (DF curent = revizie draft, `df_aprobat=false`) → `can_revise_df=false` (buton ascuns). ✓
- Edge (df_id=R0 aprobat dar există copil în lucru) → `df_revizie_in_lucru=true` → ascuns. ✓
- Server-ul deja blochează revizuirea unui draft (`df.mjs:434` → 400 „Doar documentele aprobate sau neaprobate pot fi revizuite") — fix-ul aliniază UI-ul cu serverul (defense-in-depth). ⛔ NU modifica serverul.

## Ce NU atingem
- ⛔ `/revizuieste` și orice scriere/tranziție. ⛔ `df_action` (garda pentru draft/angajare rămâne). ⛔ Nicio altă capability.
- Doar linia `can_revise_df`.

## Test — `server/tests/**/alop-capabilities.test.mjs`
Adaugă cazuri (fără DB, e funcție pură):
1. `status='plata'`, `df_aprobat=true`, `df_revizie_in_lucru=false`, owner → `can_revise_df=true`.
2. `status='plata'`, `df_aprobat=false` → `can_revise_df=false`.
3. `status='plata'`, `df_aprobat=true`, `df_revizie_in_lucru=true` → `can_revise_df=false`.
4. Non-owner → `can_revise_df=false` (neschimbat).
`npm test verde, fără regresii`. `npm run check` OK.

## Cache busting + versiune
Doar server + test (fără FE) ⇒ **fără** bump `sw.js`/`?v=`. Bump `package.json` la următorul patch.

## Guardrails diff
`git diff --name-only` = EXCLUSIV: `server/services/alop-capabilities.mjs`, testul, `package.json`.
```bash
git diff server/services/alop-capabilities.mjs | grep -iE "UPDATE|INSERT|DELETE|df_action|revizuieste" && echo "⛔ STOP: dincolo de can_revise_df!" || echo "✅ doar can_revise_df"
```

## Verificare (owner, staging)
- ALOP cu DF curent = revizie draft → „Revizuiește DF" **dispare**.
- ALOP cu DF R0 aprobat, fără revizie în lucru → butonul **rămâne** (revizie legitimă posibilă).
- După ce revizia curentă e aprobată → butonul reapare.

## Final
```bash
git add server/services/alop-capabilities.mjs server/tests package.json
git commit -m "fix(alop): can_revise_df gated de df_aprobat + !df_revizie_in_lucru"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
