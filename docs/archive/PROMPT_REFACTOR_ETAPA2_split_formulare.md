# DocFlowAI — 🗂️ Refactor Etapa 2: split mecanic `formulare-db.mjs` → `routes/formulare/`

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.544 → v3.9.545
Branch: develop
Subiect: refactor(formulare): split formulare-db.mjs în routes/formulare/{df,ord,shared,index}
Tip: SPLIT MECANIC — mutare de cod între fișiere. ZERO schimbare de comportament,
     ZERO schimbare de logică, ZERO path nou. Backend-only: fără CACHE_VERSION, fără ?v=.
Precondiție: Etapa 1 (formular-shared.mjs) e pe develop și CI verde. Fără ea, STOP.
```

---

## 🎯 Scop

După Etapa 1, `server/routes/formulare-db.mjs` mai are ~1572 linii: rute DF-specifice, rute
ORD-specifice, rute shared (`:type`), plus wrappers subțiri către `formular-shared.mjs`. Le împărțim
pe modelul existent `server/routes/flows/` (orchestrator + sub-routere).

**Aceasta este o operație de MUTARE, nu de rescriere.** Fiecare handler ajunge într-un fișier nou
**byte-identic** cu ce era (cu excepția importurilor ajustate). NU rescrii niciun handler. NU
„cureți" pe parcurs. NU schimbi niciun path, niciun middleware, niciun status code. Dacă te tentează
o îmbunătățire — notează-o în raport, nu o face aici.

Plasa de regresie e aceeași: caracterizările Etapei 0/1 (`server/tests/db/caracterizare-*`,
`sterge-df-ord`, `doc-capabilities*`) lovesc **path-urile reale** → orice rută rătăcită sau ascunsă
apare ca test picat. Trebuie să rămână verzi, **neschimbate**.

---

## 🚫 Zone interzise (rămân valabile)

- NU atinge fișierele de signing NO-TOUCH (`STSCloudProvider.mjs`, `cloud-signing.mjs`,
  `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`).
- NU atinge `server/db/migrate.mjs`. NU adăuga migrări. NU modifica schema.
- NU atinge `formular-shared.mjs`, `formular-capabilities.mjs`, `authz-formular.mjs` (le **imporți**,
  nu le modifici).
- NU modifica aserțiunile testelor de caracterizare.

---

## ⚠️ CAPCANA #1 — ordinea static vs `:id` (CITEȘTE ÎNAINTE DE ORICE)

Express potrivește rutele **în ordinea înregistrării**, la aceeași adâncime de path. În blocul DF:

```
GET /api/formulare-df            (listă)
GET /api/formulare-df/aprobate   ← STATIC, trebuie ÎNAINTEA lui :id
GET /api/formulare-df/:id        ← PARAM, prinde orice segment dacă e primul
```

Dacă `:id` se înregistrează înaintea lui `aprobate`, `GET /api/formulare-df/aprobate` ajunge la
handler-ul `:id` cu `id="aprobate"` → 404/eroare. **În `df.mjs`, păstrează ordinea: listă →
`aprobate` → `:id` → restul.** Verifică la final cu un test explicit (vezi Pas 4).

ORD nu are sibling static la `:id`, dar păstrează oricum ordinea relativă din fișierul curent.
Între fișiere (df.mjs ↔ ord.mjs ↔ shared.mjs) nu există coliziune — prefixe diferite
(`-df` / `-ord` / `-capturi` / `-atasamente` / `-audit` / `/formulare/` / `/beneficiari`).

---

## 📋 Pas 0 — verificare precondiție + inventar

```bash
git checkout develop && git pull origin develop
git status   # clean

# Etapa 1 prezentă:
test -f server/services/formular-shared.mjs && echo "✓ Etapa 1 prezentă" || { echo "✗ STOP — lipsește formular-shared.mjs"; exit 1; }

# Cine importă formulare-db.mjs (trebuie actualizați TOȚI la final):
grep -rn "routes/formulare-db" server/ | grep -v "formulare-db.mjs:"

# Baseline verde (Docker pornit + TEST_DATABASE_URL):
npm run db:test:up   # exportă TEST_DATABASE_URL
npm run test:db      # caracterizările RULATE + PASSED
npm test             # mock verde, fără regresii
```

---

## 📋 Pas 1 — repartizarea rutelor (mapă fixă)

Toate path-urile rămân **identice**. Doar fișierul-gazdă se schimbă.

**`server/routes/formulare/df.mjs`** — tot ce e `/api/formulare-df*`:
`GET /api/formulare-df` (listă) → `GET .../aprobate` → `GET .../:id` → `POST /api/formulare-df`
(create, cu `requireModule('alop')`+`requireModule('df')`) → `PUT .../:id` → wrappers
`submit`/`complete`/`returneaza`/`link-flow` (apel `formular-shared.mjs`) → `GET .../:id/revizii` →
`POST [.../:id/revizuieste, .../:id/revizie]` (cu guard `isUuid` din Etapa 1) → `DELETE .../:id` →
`POST .../:id/sterge` (wrapper).

**`server/routes/formulare/ord.mjs`** — tot ce e `/api/formulare-ord*`:
`GET /api/formulare-ord` → `GET .../:id` → `POST` (create, `requireModule('alop')`+
`requireModule('ord')`) → `PUT .../:id` → wrappers `submit`/`complete`/`returneaza`/`link-flow` →
`DELETE .../:id` → `POST .../:id/sterge`.

**`server/routes/formulare/shared.mjs`** — rutele care servesc AMBELE tipuri (`:type`) sau sunt
cross-cutting:
`POST/GET /api/formulare-capturi/:type/:id` · `POST/GET /api/formulare-atasamente/:type/:id` ·
`GET/DELETE /api/formulare-atasamente/:type/:id/:attId` · `GET /api/formulare/utilizatori-org` ·
`GET/POST /api/beneficiari` · `GET /api/formulare/list` · `GET /api/formulare-audit/:type/:id`.

**`server/routes/formulare/index.mjs`** — orchestrator:
```js
import { Router } from 'express';
import dfRoutes from './df.mjs';
import ordRoutes from './ord.mjs';
import sharedRoutes from './shared.mjs';

const router = Router();
router.use(dfRoutes);
router.use(ordRoutes);
router.use(sharedRoutes);

export const formulareDbRouter = router;   // numele de export PĂSTRAT identic
```

(Modelul exact: `server/routes/flows/index.mjs`.)

---

## 📋 Pas 2 — mutarea efectivă (handler-e verbatim)

Pentru fiecare fișier nou:

1. **Header de import** — fiecare fișier declară `const router = Router();` și `export default router;`,
   plus DOAR importurile de care au nevoie rutele lui. Sursele:
   - `requireAuth` ← `../../middleware/auth.mjs` (helper-mode, păstrat)
   - `csrfMiddleware` ← `../../middleware/csrf.mjs`  (`const _csrf = csrfMiddleware;`)
   - `requireModule` ← `../../middleware/require-module.mjs` (doar df.mjs/ord.mjs, pe create)
   - `logger` ← `../../middleware/logger.mjs`
   - `pool` ← `../../db/index.mjs`
   - authz/caps/audit helpers ← din `../../services/...` și `../../db/queries/...` ca în original
   - lifecycle wrappers + config + field-uri ← `../../services/formular-shared.mjs`
   - `isAdminOrOrgAdmin` ← `../admin/_helpers.mjs` (atenție la noua adâncime: `../admin/`, nu `./admin/`)

2. **Helperele file-local** (ex. `requireDb`, `isUuid`, eventuali alți consts definiți în
   `formulare-db.mjs` care NU au plecat în Etapa 1): dacă sunt folosiți de mai multe fișiere noi,
   pune-i într-un `server/routes/formulare/_helpers.mjs` și importă-i. Dacă-s folosiți de unul singur,
   pune-i local în acel fișier. **NU schimba implementarea lor** — copiere verbatim. (Dacă `requireDb`
   local e identic cu cel exportat din `db/index.mjs`, poți importa pe-acela, dar DOAR dacă verifici
   că-s identici; altfel copiază-l verbatim.)

3. **Copiază fiecare handler exact** — corp neschimbat, doar căile de import ajustate la noua adâncime
   (`../../` în loc de `../`). Verifică fiecare `import`/`require` relativ.

4. Ajustează adâncimea în importuri: fișierele noi sunt în `server/routes/formulare/`, deci `../../`
   pentru `server/`-root, `../` pentru `routes/`-siblings (ex. `../admin/_helpers.mjs`).

---

## 📋 Pas 3 — racordare orchestrator + curățare importatori

Decide între două variante (alege A dacă importatorii sunt puțini; B dacă vrei zero atingere de
`server/index.mjs`):

**Varianta A (curată, preferată) — actualizează importatorii:**
- În `server/index.mjs`, schimbă DOAR linia de import:
  `import { formulareDbRouter } from './routes/formulare-db.mjs';`
  → `import { formulareDbRouter } from './routes/formulare/index.mjs';`
  (mount-ul `app.use('/', formulareDbRouter)` rămâne neatins.)
- Actualizează orice alt importator găsit la Pas 0 (ex. teste de integrare care importă din
  `formulare-db.mjs`) la noua cale.
- Șterge `server/routes/formulare-db.mjs`.

**Varianta B (shim, zero atingere orchestrator) — dacă importatorii sunt mulți/riscanți:**
- Înlocuiește conținutul `formulare-db.mjs` cu un re-export:
  `export { formulareDbRouter } from './formulare/index.mjs';`
- Niciun importator nu se schimbă. (Cost: rămâne un fișier-shim vestigial — notează-l în raport ca
  datorie de curățat ulterior.)

Indiferent de variantă, numele exportului `formulareDbRouter` rămâne identic.

> NOTĂ `npm run check`: scriptul `check` din `package.json` NU referențiază `formulare-db.mjs`, deci
> nu trebuie editat. OPȚIONAL poți adăuga noile fișiere `formulare/*.mjs` la `check` pentru completitudine;
> nu e obligatoriu (prebuild + teste le acoperă). Dacă le adaugi, păstrează ordinea alfabetică.

---

## 📋 Pas 4 — verificare verde (+ test anti-shadowing)

```bash
npm run check     # sintaxă

# DB-tests (Docker + TEST_DATABASE_URL):
npm run test:db
# Așteptat: TOATE caracterizările RULATE + PASSED, aserțiuni NESCHIMBATE.

npm test
# Așteptat: verde, fără regresii (851).
```

**Test anti-shadowing OBLIGATORIU** — adaugă în `server/tests/db/` (sau extinde un fișier existent de
caracterizare DF) un test care confirmă că `aprobate` NU e prins de `:id`:

```js
it('GET /api/formulare-df/aprobate NU e prins de :id (anti-shadowing)', async () => {
  const res = await request(app).get('/api/formulare-df/aprobate').set('Cookie', cookie());
  expect(res.status).toBe(200);            // handler-ul corect (listă aprobate), nu 404/eroare de :id
  expect(Array.isArray(res.body) || Array.isArray(res.body?.items)).toBe(true); // formă de listă, nu document unic
});
```

(Adaptează aserțiunea la forma reală a răspunsului `aprobate` — citește handler-ul. Scopul: dovedește
că rămâne ruta-listă, nu handler-ul de document unic.)

Dacă orice caracterizare pică → ai rătăcit o rută sau ai schimbat un import. NU modifica testul;
găsește ruta lipsă/ordinea greșită și repar-o.

---

## 📋 Pas 5 — bump + commit + push

```bash
# package.json: 3.9.544 → 3.9.545. FĂRĂ CACHE_VERSION. FĂRĂ ?v=.

git add server/routes/formulare/ server/routes/formulare-db.mjs server/index.mjs \
        server/tests/db/ package.json
# (la varianta A: formulare-db.mjs apare ca șters; la B: ca modificat în shim)
git commit -m "refactor(formulare): split formulare-db.mjs în routes/formulare/{df,ord,shared,index} (mecanic, zero comportament)"
git push origin develop
```

CI (`push: develop`) rulează mock + DB real cu `postgres:16` — confirmă caracterizările **passed**, nu sărite.

---

## ✅ Definiție de „gata"

1. 4 fișiere noi: `routes/formulare/{df,ord,shared,index}.mjs` (+ opțional `_helpers.mjs`).
2. Toate path-urile **identice** cu înainte; export `formulareDbRouter` păstrat.
3. Ordinea `listă → aprobate → :id` păstrată în `df.mjs`; test anti-shadowing verde.
4. Toți importatorii lui `formulare-db.mjs` actualizați (varianta A) SAU shim funcțional (varianta B).
5. Handler-ele mutate **verbatim** — niciun corp rescris, niciun path/middleware/status schimbat.
6. `npm run check` ok; `npm test` verde fără regresii; `npm run test:db` verde **RULAT**, caracterizări
   **neschimbate** (plus noul test anti-shadowing).
7. `git diff --stat` arată mutare (linii ies din `formulare-db.mjs`, intră în `formulare/*`), nu rescriere.
8. Push pe develop; CI verde.
9. Raport scurt: structura nouă, varianta aleasă (A/B), lista importatorilor actualizați, confirmare
   „toate caracterizările verzi neschimbate", confirmare NO-TOUCH neatins, eventuale îmbunătățiri
   observate dar NEfăcute (notate pentru o etapă viitoare).

**Nu raporta „gata" până caracterizările + testul anti-shadowing nu trec RULATE (nu sărite).**
