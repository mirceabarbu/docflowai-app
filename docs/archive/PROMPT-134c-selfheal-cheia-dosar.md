---
prompt_id: 134c
titlu: Self-heal-ul de relegare DF↔ALOP cheia pe DOSAR, nu pe numărul de înregistrare (finalizează #126)
branch: develop
model_suggested: Sonnet 5 (efort medium)
versiune_start: v3.9.786
versiune_tinta: v3.9.787
migratii: NU
cache_version_bump: NU (nimic din public/)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.
⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## CONTEXTUL — o rămășiță din #126, găsită la reconul #134a
===============================================================================

`#126` (v3.9.755) a stabilit că identitatea unui lanț de revizii DF este
**DOSARUL**, nu numărul de înregistrare, fiindcă în producție există
`nr_unic_inreg` DUPLICATE între dosare diferite (`docs/incidents/DF-NR-DUPLICAT.md`).
Cheia unică trăiește în `server/services/df-dosar-key.mjs`:

```
dosarKeyExpr(alias) = COALESCE(alias.source_alop_id::text, alias.nr_unic_inreg)
```

Commit-ul `0335cb6` a convertit cinci interogări pe această cheie, dar **a sărit
peste `server/services/alop-link.mjs`**. Acolo, în `selfHealAlopDfLink` (~linia 57),
garda care decide dacă pointerul ALOP poate fi relegat compară încă numere goale:

```
EXISTS (SELECT 1 FROM formulare_df fd
         WHERE fd.id = a.df_id AND fd.org_id = $4 AND fd.nr_unic_inreg = $5)
```

Intenția, scrisă în comentariul de deasupra, e „o altă revizie a **aceluiași
document**". Pe dosarele cu număr partajat, garda acceptă drept „aceeași serie"
un DF din **alt dosar** ⇒ self-heal-ul poate muta pointerul unui ALOP pe DF-ul
altui dosar, la aprobarea unui flux. Rupere TĂCUTĂ, în chiar mecanismul care ar
trebui să repare legăturile.

⚠️ **Acest lot NU schimbă semantica pointerului** (decizia A/B/C din reconul
#134a vine la #134e). Aici doar se corectează cheia de comparație. Fixul rămâne
corect indiferent de varianta aleasă.

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `server/services/alop-link.mjs` — importul + garda
2. `server/tests/db/alop-df-relink-selfheal.test.mjs` — cazuri ADĂUGATE (existent)
3. `package.json` — bump versiune

⛔ NU se atinge `df.mjs`, `alop.mjs`, `formular-shared.mjs`, `public/**`, zona
NO-TOUCH de semnare.

===============================================================================
## ETAPA 0 — Test de CARACTERIZARE, ÎNAINTE de modificare
===============================================================================

⛔ Scrie și rulează întâi, contra codului NESCHIMBAT. Dacă trece din prima, ori
fixture-ul e greșit, ori premisa e greșită — **STOP și raportează**.

Fixture (PG real, un singur org):
- **Dosarul X**: ALOP `AX` cu `source_alop_id = AX` pe DF-urile lui;
  `DX_R0` aprobat, `nr_unic_inreg = '4711'`; ALOP-ul `AX` are `df_id = DX_R0`
- **Dosarul Y**: ALOP `AY`; `DY_R0` cu ACELAȘI `nr_unic_inreg = '4711'`,
  `source_alop_id = AY`; ALOP-ul `AY` are `df_id = DY_R0`
- se aprobă un flux pentru `DX_R1` (revizie a lui `DX_R0`, `source_alop_id = AX`)

Caz **K1 (bug-ul):** rulează `selfHealAlopDfLink(pool, flowId_DX_R1)` și verifică
`AY`. Garda de azi cere doar `fd.nr_unic_inreg = $5`, iar `$5 = '4711'` ⇒ o
potrivire falsă e posibilă.
⚠️ Verifică pe cod dacă `WHERE a.id = $3` (cu `$3 = df.source_alop_id`) restrânge
deja actualizarea la un singur ALOP. **Dacă da, K1 nu poate produce o scriere
greșită** și bug-ul e latent, nu activ.
⭐ **Atunci raportează asta explicit ca prima constatare** și rescrie K1 ca test de
INVARIANT (garda cheiază pe dosar), nu de reproducere. ⛔ Nu inventa un eșec ca
să „confirmi" premisa mea și ⛔ nu abandona lotul: garda tot trebuie corectată,
fiindcă e singura barieră dacă `a.id` se lărgește vreodată.

Caz **K2 (non-regresie):** `AX` primește corect `df_id = DX_R1` și
`df_flow_id = flowId_DX_R1`.

===============================================================================
## ETAPA 1 — Fixul
===============================================================================

Fișier: `server/services/alop-link.mjs`

Adaugă la importuri:
```js
import { dosarKeyExpr, dosarKeyOf } from './df-dosar-key.mjs';
```

Apoi, în `selfHealAlopDfLink`, înlocuiește garda. `old_str`:
```
            OR EXISTS (
              SELECT 1 FROM formulare_df fd
               WHERE fd.id = a.df_id AND fd.org_id = $4 AND fd.nr_unic_inreg = $5
            )
```
`new_str`:
```
            OR EXISTS (
              -- #134c — cheia e DOSARUL, nu numarul de inregistrare. In productie exista
              -- nr_unic_inreg duplicate intre dosare diferite (docs/incidents/DF-NR-DUPLICAT.md),
              -- deci comparatia pe numar accepta drept "aceeasi serie" un DF din alt dosar.
              -- #126 a convertit cinci interogari pe dosarKeyExpr si a sarit peste aceasta.
              SELECT 1 FROM formulare_df fd
               WHERE fd.id = a.df_id AND fd.org_id = $4
                 AND ${dosarKeyExpr('fd')} = $5
            )
```

Și parametrul: `df.nr_unic_inreg` → `dosarKeyOf(df)` în tabloul de argumente.

⚠️ **Capcană plătită deja la #134b:** interogarea e un template literal JS.
⛔ **Zero backtick-uri și zero diacritice în comentariile SQL dictate mai sus** —
un backtick rupe string-ul (`SyntaxError`), iar comentariile de deasupra sunt
scrise deliberat fără ele. Nu le „înfrumuseța".

⚠️ `dosarKeyExpr` întoarce `COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)` =
**TEXT**. `dosarKeyOf(df)` întoarce tot text. Dacă Postgres se plânge de tip pe
`$5`, adaugă `$5::text`, ⛔ nu castui expresia din stânga (ar dezactiva orice index).

**Verificare Etapa 1:**
```bash
grep -c "nr_unic_inreg = \$5" server/services/alop-link.mjs      # Așteptat: 0
grep -c "dosarKeyExpr\|dosarKeyOf" server/services/alop-link.mjs # Așteptat: 3
node --check server/services/alop-link.mjs
```

===============================================================================
## ETAPA 2 — Restul fișierului: inventar, NU modificări
===============================================================================

`selfHealAlopDfLinkByAlop` (~linia 113) cheiază pe `fd.source_alop_id = $1` —
adică deja pe dosar, în forma lui strictă. ⛔ **Nu o atinge.**

Rulează și **raportează** (fără să modifici nimic):
```bash
grep -rn "nr_unic_inreg" server/services/ server/routes/ --include=*.mjs | grep -v tests
```
Pentru fiecare apariție rămasă, o linie: e o comparație de LANȚ (ar trebui pe
dosar) sau o operație legitimă pe număr (afișare, căutare, unicitate la PUT)?
Consemnează în raport; ⛔ nu repara nimic în afara `alop-link.mjs`.

===============================================================================
## ETAPA 3 — Teste
===============================================================================

În `server/tests/db/alop-df-relink-selfheal.test.mjs`, ⛔ fără a slăbi cazurile
existente, adaugă:

1. **K1** din Etapa 0, în forma stabilită acolo (reproducere SAU invariant)
2. **K2** non-regresie — relegarea corectă în cadrul aceluiași dosar
3. **K3** — DF legacy (`source_alop_id IS NULL`) cu același `nr_unic_inreg`:
   fallback-ul pe număr trebuie să funcționeze exact ca înainte (asta apără
   decizia din `df-dosar-key.mjs` de a NU folosi `id` ca fallback)
4. **K4** — un `df_id` care pointează la un DF din alt dosar rămâne **neatins**
   (relegare manuală respectată — invariantul din comentariul existent)
5. **K5** — izolare pe org: un DF cu aceeași cheie din alt `org_id` nu potrivește

```bash
npm test
npm run test:db
```
Ambele verzi. Absența Docker NU e motiv de skip — rețeta cu PG 17 efemer e în
`CLAUDE.md`.

===============================================================================
## ETAPA 4 — Versionare și commit
===============================================================================

```bash
# package.json 3.9.786 → 3.9.787. Zero ?v=, zero CACHE_VERSION.
git status --short   # Așteptat: 3 modificate, 0 noi
# ⛔ NU `git add -A` — repo-ul are fișiere netrackuite care nu aparțin aici.
git add server/services/alop-link.mjs \
        server/tests/db/alop-df-relink-selfheal.test.mjs package.json
git commit -m "fix(#134c): self-heal-ul de relegare DF-ALOP cheiaza pe dosar, nu pe nr_unic_inreg (v3.9.787)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. **Verdictul Etapei 0**: K1 a reprodus o scriere greșită, sau bug-ul e LATENT
   (restrâns de `WHERE a.id = $3`)? Ieșirea brută.
2. Ieșirea comenzilor de verificare (Etapele 1, 4).
3. Inventarul din Etapa 2, o linie per apariție.
4. `npm test` / `npm run test:db`, cu confirmarea „PASSED REAL pe PG 17".
5. Cele 5 cazuri, numerotat. Câte teste EXISTENTE au fost atinse și de ce.
6. Hash-ul commit-ului + confirmarea push-ului.
7. Orice contrazicere între cod și acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Un singur fișier de producție atins: `server/services/alop-link.mjs`.
- ⛔ NU schimba semantica lui `alop_instances.df_id` (decizia e la #134e).
- ⛔ NU atinge `selfHealAlopDfLinkByAlop`.
- ⛔ Zero migrații, zero index nou, zero `UPDATE` de date.
- ⛔ Zero backtick-uri în comentariile din interiorul template literal-elor SQL.
- ⛔ NU folosi `git add -A`. `main` nu se atinge sub nicio formă.
