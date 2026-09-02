---
prompt_id: 134b
titlu: Plafonul ORD ignoră ciclurile deja ordonanțate — corelarea prin ALOP, nu prin pointerul mobil
branch: develop
model_suggested: Opus 5 (efort medium)
versiune_start: v3.9.785
versiune_tinta: v3.9.786
migratii: NU
cache_version_bump: NU (niciun asset din PRECACHE_ASSETS atins)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.
⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## CONTEXTUL — bug financiar tăcut, găsit la reconul #134a (secțiunea a9/R6)
===============================================================================

`computeOrdBudgetContext` (`server/services/formular-shared.mjs:284`) e **sursa
unică** a plafonului de ordonanțare: o folosesc garda hard 422
(`validateOrdBugetAnCurent`) ȘI cele două rute GET care alimentează atenționarea
inline din UI. Ea întoarce `{ anExercitiu, bugetAnCurent, cicluriArhivate }`.

`cicluriArhivate` = suma deja ORDONANȚATĂ în ciclurile anterioare ale aceluiași
dosar, în același an de exercițiu. Se scade din plafon. Subinterogarea o găsește
așa (`:300`):

```sql
JOIN alop_instances a ON a.id = c.alop_id
…
WHERE a.df_id = df.id AND a.org_id = $2 AND a.cancelled_at IS NULL
```

⚠️ Aici `df` este DF-ul **înghețat** al ORD-ului (`ord.df_id`, revizia de la
momentul emiterii — corect, și trebuie să rămână așa), în timp ce `a.df_id` este
pointerul **mobil** al dosarului ALOP. **În clipa în care cineva creează o
revizie DF, cei doi diverg**, JOIN-ul nu mai potrivește niciun ALOP, iar

> **`cicluriArhivate` devine 0 ⇒ plafonul 422 ignoră TOT ce s-a ordonanțat deja.**

Efectul practic: pe un dosar revizuit, un ORD nou poate depăși creditele bugetare
ale anului fără ca garda hard să se aprindă. Ruperea e **TĂCUTĂ** — aceeași clasă
ca #115 (plata OPME sub-numărată) și #128l.

⚠️ **Acest lot NU decide și NU atinge semantica pointerului `alop_instances.df_id`.**
Decizia A/B/C din reconul #134a e separată și vine în #134e. Bug-ul de aici e
independent: corelarea prin `a.df_id` e greșită **indiferent** de varianta aleasă
— chiar și sub varianta (C), unde pointerul rămâne pe revizia curentă, JOIN-ul
tot ratează. ⛔ Nu „repara" nimic din `df.mjs`, `alop-link.mjs` sau `alop.mjs`.

===============================================================================
## SOLUȚIA — corelarea se face prin DOSARUL ALOP, rezolvat explicit
===============================================================================

ALOP-ul corect NU se deduce din `a.df_id`. Se rezolvă în trei pași, în ordinea
încrederii, ÎNAINTE de interogarea de buget:

1. **Prin ORD**, când îl avem: ALOP-ul care ține acest ORD ca ciclu curent
   (`alop_instances.ord_id = ordId`) sau ca ciclu arhivat
   (`alop_ord_cicluri.ord_id = ordId`). Cea mai sigură cale — ORD-ul e înghețat.
2. **Prin proveniența DF-ului**: `formulare_df.source_alop_id` (migrația 084).
   Imun la pointer, fiindcă e scris la creare și nu se mai mișcă.
3. **Prin pointer**, ca ultim resort pentru documentele vechi fără proveniență:
   `alop_instances.df_id = dfId`. Comportamentul de azi, păstrat doar ca fallback.

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `server/services/formular-shared.mjs` — helperul de rezolvare + interogarea
2. `server/routes/formulare/ord.mjs` — cele două call-site-uri care AU un ORD
3. `server/tests/db/ord-buget-cicluri-corelare.test.mjs` — **FIȘIER NOU**
4. `package.json` — bump versiune

⛔ NU se atinge: `server/routes/alop.mjs`, `server/routes/formulare/df.mjs`,
`server/services/alop-link.mjs`, `public/**`, zona NO-TOUCH de semnare.

===============================================================================
## ETAPA 0 — Test de CARACTERIZARE, ÎNAINTE de orice modificare
===============================================================================

⛔ **Scrie și rulează testele întâi, contra codului NESCHIMBAT.** Vreau să văd
bug-ul reprodus, nu doar reparat — dacă testul trece din prima, ori fixture-ul e
greșit, ori premisa mea e greșită, și în ambele cazuri STOP + raportează.

Fixture minim (pe PG real):
- un ALOP cu un ciclu ARHIVAT în `alop_ord_cicluri`, cu `an_exercitiu` = anul
  curent, al cărui `ord_id` are `rows` cu `suma_ordonantata_plata` = 10.000
- DF-ul R0, aprobat, cu `rows_ctrl` care dă `sum_rezv_crdt_bug_act` total = 50.000
- ORD-ul arhivat are `df_id` = R0

Caz **C0 (înainte de fix, cu pointerul intact):**
`computeOrdBudgetContext({ dfId: R0 })` ⇒ `cicluriArhivate === 10000`. Verde azi.

Caz **C1 (bug-ul):** mută pointerul — `UPDATE alop_instances SET df_id = <R1>`
(simulează revizia; ⛔ NU chema `/revizuieste`, testul trebuie să izoleze exact
corelarea). Reapelează cu `dfId: R0`.
⇒ **azi întoarce `cicluriArhivate === 0`. TREBUIE să pice roșu.**
Consemnează în raport ieșirea BRUTĂ a acestui eșec — e dovada bug-ului.

===============================================================================
## ETAPA 1 — Helperul de rezolvare
===============================================================================

În `server/services/formular-shared.mjs`, exportă:

```js
/**
 * #134b — rezolvă DOSARUL ALOP pentru contextul de buget al unui ORD.
 * NU folosi `alop_instances.df_id` ca sursă principală: e un pointer MOBIL (se mută
 * la crearea unei revizii DF), în timp ce `formulare_ord.df_id` e ÎNGHEȚAT pe revizia
 * de la emitere. Când cei doi diverg, corelarea veche `a.df_id = df.id` nu mai
 * potrivea nimic ⇒ cicluriArhivate = 0 ⇒ plafonul 422 ignora tot ce se ordonanțase.
 * Ordinea = descrescătoare după încredere; fallback-ul pe pointer e doar pentru
 * documentele vechi, fără `source_alop_id`.
 * Întoarce id-ul ALOP sau null.
 */
export async function resolveAlopIdForBudget({ ordId, dfId, orgId }, db = pool) { … }
```

Reguli:
- fiecare pas e o interogare separată, `LIMIT 1`, cu `org_id` și
  `cancelled_at IS NULL` acolo unde tabelul le are;
- pasul 1 caută în AMBELE locuri (`alop_instances.ord_id`, apoi
  `alop_ord_cicluri.ord_id` prin `JOIN alop_instances`);
- ⛔ fără `catch` care înghite — o eroare de DB trebuie să urce;
- parametrul `db` permite injectarea unui client de tranzacție; implicit `pool`.

## ETAPA 2 — `computeOrdBudgetContext` primește `ordId` și folosește ALOP-ul

Semnătura devine `{ dfId, orgId, ordId }` — `ordId` **opțional**, ca ruta
`buget-context` (creare ORD, încă fără document salvat) să funcționeze neschimbat.

În interogare, `old_str`:
```
         WHERE a.df_id = df.id AND a.org_id = $2 AND a.cancelled_at IS NULL
```
`new_str`:
```
         -- #134b — corelare prin DOSARUL ALOP rezolvat explicit (resolveAlopIdForBudget),
         -- NU prin `a.df_id = df.id`: `df` e revizia ÎNGHEȚATĂ a ORD-ului, iar `a.df_id`
         -- e pointerul MOBIL al dosarului. La prima revizie DF cei doi divergeau și
         -- subinterogarea întorcea 0 — plafonul ignora tăcut tot ce se ordonanțase deja.
         WHERE a.id = $4 AND a.org_id = $2 AND a.cancelled_at IS NULL
```

`$4` = rezultatul helperului. ⚠️ **Dacă helperul întoarce `null`**, `a.id = NULL`
nu potrivește nimic — ceea ce ar reintroduce exact bug-ul, tăcut. Deci:
- când `alopId` e `null`, `cicluriArhivate` = 0 este un rezultat LEGITIM (dosar
  fără cicluri arhivate), dar trebuie **logat** `logger.warn` cu `{ dfId, ordId }`
  și mesajul `computeOrdBudgetContext: dosar ALOP nerezolvat — plafon fără cicluri arhivate`;
- ⛔ nu cădea înapoi pe `a.df_id = df.id` — fallback-ul e deja pasul 3 din helper.

## ETAPA 3 — Cele două call-site-uri care AU un ORD

`server/services/formular-shared.mjs`, în `validateOrdBugetAnCurent`:
`computeOrdBudgetContext({ dfId: ordDoc.df_id, orgId })`
→ `computeOrdBudgetContext({ dfId: ordDoc.df_id, orgId, ordId: ordDoc.id })`

`server/routes/formulare/ord.mjs:179` (GET detaliu):
`{ dfId: doc.df_id, orgId: actor.orgId }` → `+ ordId: doc.id`

⛔ `server/routes/formulare/ord.mjs:116` (`GET /buget-context`) rămâne
NESCHIMBAT — acolo ORD-ul încă nu există; se bazează pe pașii 2-3 din helper.

**Verificare Etapele 1-3:**
```bash
grep -c "resolveAlopIdForBudget" server/services/formular-shared.mjs   # Așteptat: 3
grep -c "a.df_id = df.id" server/services/formular-shared.mjs          # Așteptat: 0
grep -c "ordId:" server/routes/formulare/ord.mjs                       # Așteptat: 1
node --check server/services/formular-shared.mjs && node --check server/routes/formulare/ord.mjs
```

===============================================================================
## ETAPA 4 — Testele complete (același fișier nou)
===============================================================================

Rulează pe PG real (instanță 17 efemeră — rețeta din `CLAUDE.md`; absența Docker
NU e motiv de skip). Mock-urile pe `pool.query` confirmă FORMA, nu comportamentul.

1. **C0** rămâne verde (non-regresie: pointer intact ⇒ 10.000)
2. **C1 devine verde** — pointerul mutat, `ordId` dat ⇒ 10.000 (pasul 1)
3. **C2** — pointer mutat, FĂRĂ `ordId`, DF cu `source_alop_id` ⇒ 10.000 (pasul 2)
4. **C3** — pointer mutat, fără `ordId` și fără `source_alop_id` ⇒ 0 **plus**
   `logger.warn` emis (spy). Documentăm limita, nu o ascundem.
5. **C4 — garda hard 422 end-to-end:** cu pointerul mutat, un `PUT`/finalizare de
   ORD care ar depăși `50.000 − 10.000` **TREBUIE respins cu 422**. Azi trece.
   ⭐ Acesta e cazul care contează cel mai mult din tot lotul.
6. **C5** — izolare pe an de exercițiu: un ciclu arhivat cu `an_exercitiu` = anul
   trecut NU intră în `cicluriArhivate`
7. **C6** — izolare pe org: un ALOP din alt `org_id` nu e niciodată rezolvat
8. **C7** — un ALOP `cancelled_at IS NOT NULL` nu e rezolvat de niciunul din pași
9. **C8** — ORD arhivat: `ordId` găsit prin `alop_ord_cicluri`, nu prin
   `alop_instances.ord_id` (ramura a doua a pasului 1)
10. **C9** — paritate: `GET /api/formulare-ord/:id` întoarce același
    `cicluri_arhivate` ca garda hard, pe același fixture (atenționarea inline nu
    are voie să contrazică 422-ul)

```bash
npm test
npm run test:db
```
Ambele verzi, fără regresii. ⚠️ Verifică explicit
`server/tests/db/ord-buget-an-curent*.test.mjs` (dacă există) și
`alop-noua-lichidare-ciclu.test.mjs` — dacă vreunul cimentează comportamentul
vechi, **raportează înainte de a-l modifica**, nu-l rescrie tăcut.

===============================================================================
## ETAPA 5 — Versionare și commit
===============================================================================

```bash
# package.json 3.9.785 → 3.9.786. Zero `?v=`, zero CACHE_VERSION (nimic din public/).
git status --short   # Așteptat: 3 modificate + 1 nou
# ⛔ NU `git add -A` — repo-ul are fișiere netrackuite care nu aparțin acestui commit.
git add server/services/formular-shared.mjs server/routes/formulare/ord.mjs \
        server/tests/db/ord-buget-cicluri-corelare.test.mjs package.json
git commit -m "fix(#134b): plafonul ORD numără ciclurile arhivate prin dosarul ALOP, nu prin pointerul mobil df_id (v3.9.786)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. **Ieșirea BRUTĂ a eșecului C1 din Etapa 0**, contra codului nemodificat —
   dovada că bug-ul e real. Dacă a trecut din prima, spune-o și oprește-te.
2. Ieșirea fiecărei comenzi de verificare (Etapele 1-3, 5).
3. `npm test` / `npm run test:db`: fișiere / teste / eșecuri, cu confirmarea
   „PASSED REAL pe PG 17".
4. Rezultatul fiecăruia dintre cele 10 cazuri, numerotat, cu accent pe **C4**.
5. Câte teste EXISTENTE au trebuit atinse și de ce (așteptat: zero).
6. Hash-ul commit-ului + confirmarea push-ului.
7. Orice loc în care codul real a CONTRAZIS acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Zero atingeri în `alop.mjs`, `df.mjs`, `alop-link.mjs`, `public/**` și zona
  NO-TOUCH (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
  `pades.mjs`, `java-pades-client.mjs`).
- ⛔ NU schimba semantica lui `alop_instances.df_id` — e decizia din #134e.
- ⛔ NU dezgheța `formulare_ord.df_id`. Reconul #134a a confirmat că înghețul e
  CORECT: `deriveOrdIdentityCols` corelează pozițional cu `rows_ctrl` al DF-ului
  legat, iar urmărirea pointerului ar rescrie tăcut codurile de angajament pe un
  ORD deja semnat, inclusiv cheia de match OPME.
- ⛔ Zero migrații, zero `ALTER TABLE`, zero `UPDATE` de date de producție.
- ⛔ NU folosi `git add -A`.
- ⛔ `main` nu se atinge sub nicio formă.
