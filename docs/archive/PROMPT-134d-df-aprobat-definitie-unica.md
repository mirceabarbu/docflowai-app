---
prompt_id: 134d
titlu: „DF aprobat" — o singură definiție, plus divergența din alop.mjs
branch: develop
model_suggested: Sonnet 5 (efort medium)
versiune_start: v3.9.787
versiune_tinta: v3.9.788
migratii: NU
cache_version_bump: NU (nimic din public/)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## CONTEXTUL — R4 din reconul #134a
===============================================================================

„DF aprobat" e scris în **cinci forme distincte, neechivalente**, în arbore:

| # | Formă | Notă |
|---|---|---|
| 1 | coloana `formulare_df.status='aprobat'` | scrisă LAZY; pe calea de semnare **cloud** coloana rămâne `'completed'` ⇒ singură e nesigură |
| 2 | derivat din flux, FĂRĂ gărzi | un flux SOFT-ȘTERS încă „aprobă" |
| 3 | derivat + `f.deleted_at IS NULL` | |
| 4 | derivat + `deleted_at` + NOT cancelled + NOT refused | cea mai strictă; deja folosită pe căile care iau **decizii de relegare** |
| 5 | hibrid „derivat SAU coloană" | compensează problema formei 1 |

**Divergența dovedită, cea care justifică lotul:** în `server/routes/alop.mjs`,
`SQL_ALOP_FLUX_DF_ACTIV` conține `fx.deleted_at IS NULL`, iar
`SQL_ALOP_DF_APROBAT`, la câteva linii distanță în ACELAȘI fișier, **nu îl are**.
Consecință: un flux DF soft-șters continuă să „aprobe" dosarul ALOP, deși e
simultan considerat inactiv. #131/fix D a închis exact această gaură pe `df.mjs`
și a ratat `alop.mjs`.

⚠️ **Scop deliberat ÎNGUST.** Acest lot NU aliniază toate cele cinci forme —
trecerea formelor 2/3 la forma 4 e o **înăsprire de comportament** (documente
care azi apar ca aprobate ar putea dispărea din `/aprobate`, iar `/revizuieste`
s-ar putea bloca), și cere teste de caracterizare proprii. Aici facem doar:
(a) o definiție unică exportată, (b) reparăm divergența dovedită din `alop.mjs`,
(c) migrăm pe helper DOAR siturile care folosesc **deja** forma 4 (refactor pur,
zero schimbare de comportament), (d) punem o **plasă anti-drift**.

⚠️ Acest lot NU atinge semantica pointerului `alop_instances.df_id` (decizia
A/B/C vine la #134e).

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `server/services/df-aprobat-sql.mjs` — **FIȘIER NOU**
2. `server/routes/alop.mjs` — DOAR `SQL_ALOP_DF_APROBAT`
3. `server/services/formular-shared.mjs` — `relinkAlopOnDfDelete` (formă 4)
4. `server/routes/flows/signing.mjs` — situl de formă 4
5. `server/services/alop-link.mjs` — situl de formă 4 din `selfHealAlopDfLinkByAlop`
6. `server/tests/unit/df-aprobat-sql.test.mjs` — **FIȘIER NOU**
7. `server/tests/db/alop-df-aprobat-flux-sters.test.mjs` — **FIȘIER NOU**
8. `package.json` — bump versiune

⛔ NU se atinge: `df.mjs`, `formulare/shared.mjs`, `formulare/ord.mjs`,
`clasa8.mjs`, `formular-capabilities.mjs`, `public/**`, zona NO-TOUCH.
Acelea folosesc formele 2/3/5 și rămân **neschimbate** în acest lot.

===============================================================================
## ETAPA 1 — Modulul PUR
===============================================================================

`server/services/df-aprobat-sql.mjs`, pe tiparul lui `df-dosar-key.mjs` (fără
dependențe, nici măcar `pool`):

```js
/**
 * server/services/df-aprobat-sql.mjs — CE INSEAMNA "DF APROBAT" (#134d)
 *
 * Reconul #134a a gasit CINCI forme distincte, neechivalente, in arbore. Aceasta
 * e forma STRICTA (4), cea deja folosita pe caile care iau DECIZII DE RELEGARE.
 *
 * De ce fiecare garda:
 *  - flow_id IS NOT NULL      : fara flux nu exista aprobare derivata
 *  - f.deleted_at IS NULL     : un flux SOFT-STERS nu mai aproba nimic (#131 fix D)
 *  - status != 'cancelled'    : anulat nu e aprobat
 *  - status != 'refused'      : refuzat nu e aprobat
 *  - completed / completed=true: cele doua reprezentari istorice ale finalizarii
 *
 * ⛔ Coloana formulare_df.status='aprobat' NU e sursa de adevar: pe calea de
 *    semnare CLOUD ea ramane 'completed'. E doar cache de afisare.
 * ⛔ Nu adauga backtick-uri in acest fisier in interiorul sirurilor returnate:
 *    rezultatul se interpoleaza in template literal-e SQL.
 */
export const dfAprobatSql = (fd = 'fd', f = 'f') => `(
  ${fd}.flow_id IS NOT NULL
  AND ${f}.deleted_at IS NULL
  AND (${f}.data->>'status') IS DISTINCT FROM 'cancelled'
  AND (${f}.data->>'status') IS DISTINCT FROM 'refused'
  AND ((${f}.data->>'status') = 'completed' OR (${f}.data->>'completed')::boolean = true)
)`;

/**
 * Varianta CORELATA, pentru interogari care NU au flows in FROM (ex. WHERE-ul de
 * COUNT din GET /api/alop, care nu are niciun JOIN — vezi #121/#132b).
 * `flowExpr` = expresia care produce id-ul fluxului (text).
 */
export const dfAprobatExistsSql = (flowExpr, fx = 'fx') => `EXISTS (
  SELECT 1 FROM flows ${fx}
   WHERE ${fx}.id::text = ${flowExpr}
     AND ${fx}.deleted_at IS NULL
     AND (${fx}.data->>'status') IS DISTINCT FROM 'cancelled'
     AND (${fx}.data->>'status') IS DISTINCT FROM 'refused'
     AND ((${fx}.data->>'status') = 'completed' OR (${fx}.data->>'completed')::boolean = true)
)`;
```

Test NOU `server/tests/unit/df-aprobat-sql.test.mjs` (min. 6 cazuri, pur textual):
aliasurile implicite; aliasurile personalizate; cele patru gărzi prezente în
ambele variante; `flowExpr` interpolat corect; **zero backtick** în ieșire;
ieșirea e echilibrată ca paranteze.

===============================================================================
## ETAPA 2 — Divergența din `alop.mjs` (singura schimbare de comportament)
===============================================================================

În `server/routes/alop.mjs`, `SQL_ALOP_DF_APROBAT` (introdus la #132b) e un
`EXISTS` pe `flows fx` cheiat pe `SQL_ALOP_DF_FLOW`, dar **fără** cele trei gărzi
pe care fratele lui `SQL_ALOP_FLUX_DF_ACTIV` le are.

⚠️ Nu ți-am dat `old_str` exact fiindcă textul e cel produs la #132b.
**Localizează constanta prin conținut**, nu prin număr de linie, și rescrie-o ca:

```js
const SQL_ALOP_DF_APROBAT = dfAprobatExistsSql(SQL_ALOP_DF_FLOW);
```

cu importul `import { dfAprobatExistsSql } from '../services/df-aprobat-sql.mjs';`
(⚠️ verifică prefixul real de cale față de `server/routes/`).

⚠️ **Poartă obligatorie:** `SQL_ALOP_DF_APROBAT` intră în `SQL_ALOP_BADGE`, care e
folosit ȘI în `WHERE`-ul de COUNT **fără niciun JOIN**. Expresia nouă TREBUIE să
rămână corelată strict pe `a.*` (un `EXISTS` autonom este). ⛔ Dacă forma
înlocuită diferă de ce descriu aici, **RAPORTEAZĂ și oprește-te** — e o
premisă ruptă, nu o nepotrivire de stil.

Dacă textul rezultat NU e echivalent cu cel vechi plus cele trei gărzi, spune-o.

===============================================================================
## ETAPA 3 — Migrarea siturilor care folosesc DEJA forma 4 (refactor pur)
===============================================================================

Trei situri. Pentru fiecare: înlocuiește fragmentul inline cu apelul helperului,
cu aliasurile potrivite.

- `server/services/formular-shared.mjs` — în `relinkAlopOnDfDelete`
- `server/routes/flows/signing.mjs` — situl de formă 4
- `server/services/alop-link.mjs` — în `selfHealAlopDfLinkByAlop` (interogarea de
  candidați, cu `JOIN flows f`)

⚠️ **Poarta acestei etape: ZERO schimbare de comportament.** După fiecare
înlocuire, compară SQL-ul generat (log/`console.log` temporar, scos înainte de
commit) cu cel vechi și confirmă echivalența semantică. Dacă vreunul dintre cele
trei situri se dovedește a fi de fapt formă 3 sau 5, ⛔ **NU-l converti** — lasă-l
neatins și raportează-l.

===============================================================================
## ETAPA 4 — Plasa anti-drift
===============================================================================

`server/tests/db/alop-df-aprobat-flux-sters.test.mjs`, pe PG real — testul care
apără fixul de la Etapa 2:

1. ALOP cu DF aprobat pe un flux **soft-șters** (`flows.deleted_at` setat) ⇒
   `df_aprobat` = **false** (azi: true). ⛔ Rulează-l ÎNTÂI contra codului
   nemodificat; trebuie să pice roșu. Ieșirea brută în raport.
2. Același fixture: `df_flow_active` = false (neschimbat — deja avea garda)
3. Flux `cancelled` ⇒ `df_aprobat` = false
4. Flux `refused` ⇒ `df_aprobat` = false
5. Flux normal completat ⇒ `df_aprobat` = true (non-regresie)
6. Cu forma `completed = true` în loc de `status='completed'` ⇒ true
7. **`total` din `GET /api/alop` coincide cu `rows.length`** pe fiecare fixture —
   dovada că expresia nouă merge identic în COUNT-ul fără JOIN
8. **Anti-drift textual:** `SQL_ALOP_DF_APROBAT` și `SQL_ALOP_FLUX_DF_ACTIV`
   conțin AMBELE cele patru gărzi (`deleted_at`, cancelled, refused, completed) —
   aserțiune pe sursă, ca divergența să nu poată reapărea

```bash
npm test
npm run test:db
```
Ambele verzi. Absența Docker NU e motiv de skip.

===============================================================================
## ETAPA 5 — Inventarul formelor rămase (documentare, ZERO cod)
===============================================================================

Adaugă la finalul lui `docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md` o secțiune
scurtă „R4-bis — stare după #134d": ce situri au trecut pe helper, ce situri au
rămas pe formele 2/3/5 și **de ce fiecare rămânere e deliberată** (înăsprirea ar
schimba comportamentul și cere caracterizare proprie).

⛔ Fără alte modificări în acel document.

===============================================================================
## ETAPA 6 — Versionare și commit
===============================================================================

```bash
# package.json 3.9.787 → 3.9.788. Zero ?v=, zero CACHE_VERSION.
git status --short   # Așteptat: 5 modificate + 3 noi
# ⛔ NU `git add -A`.
git add server/services/df-aprobat-sql.mjs server/routes/alop.mjs \
        server/services/formular-shared.mjs server/routes/flows/signing.mjs \
        server/services/alop-link.mjs \
        server/tests/unit/df-aprobat-sql.test.mjs \
        server/tests/db/alop-df-aprobat-flux-sters.test.mjs \
        docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md package.json
git commit -m "fix(#134d): definitie unica pentru DF aprobat; alop.mjs primeste gardele lipsa pe flux sters/anulat/refuzat (v3.9.788)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. **Ieșirea BRUTĂ a eșecului cazului 1 din Etapa 4**, contra codului nemodificat.
   Dacă a trecut din prima, spune-o și oprește-te.
2. Textul VECHI și textul NOU al lui `SQL_ALOP_DF_APROBAT`, unul sub altul.
3. Pentru fiecare dintre cele trei situri din Etapa 3: convertit sau lăsat, și de ce.
4. Ieșirea comenzilor de verificare + `npm test` / `npm run test:db` cu
   confirmarea „PASSED REAL pe PG 17".
5. Cele 8 cazuri din Etapa 4 + cele 6 unitare, numerotat, cu accent pe **cazul 7**.
6. Câte teste EXISTENTE au fost atinse și de ce.
7. Hash-ul commit-ului + confirmarea push-ului.
8. Orice contrazicere între cod și acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ NU alinia formele 2/3/5 în acest lot — e înăsprire de comportament, cere
  caracterizare separată.
- ⛔ NU face din coloana `status='aprobat'` o sursă de adevăr.
- ⛔ NU schimba semantica lui `alop_instances.df_id` (decizia e la #134e).
- ⛔ Zero backtick-uri în șirurile returnate de helper sau în comentariile din
  interiorul template literal-elor SQL (lecția #134b: rup string-ul).
- ⛔ Zero migrații, zero index nou, zero `UPDATE` de date.
- ⛔ Zona NO-TOUCH neatinsă: `STSCloudProvider.mjs`, `cloud-signing.mjs`,
  `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `signing.mjs` se
  atinge DOAR în situl de formă 4 identificat la Etapa 3.
- ⛔ NU folosi `git add -A`. `main` nu se atinge sub nicio formă.
