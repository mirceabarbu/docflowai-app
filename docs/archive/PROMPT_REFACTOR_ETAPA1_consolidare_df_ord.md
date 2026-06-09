# DocFlowAI — 🧱 Refactor Etapa 1: consolidare lifecycle DF/ORD în `formular-shared.mjs`

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.543 → v3.9.544
Branch: develop
Subiect: refactor(formulare): extrage lifecycle DF/ORD în service parametrizat pe formType
Tip: REFACTOR cod producție — fără schimbare de comportament observabil.
     Backend-only: fără bump CACHE_VERSION, fără atins ?v=.
Precondiție: Etapa 0 (caracterizare DB) e pe develop și VERDE. Fără ea, STOP.
```

---

## 🎯 Scop

`server/routes/formulare-db.mjs` (2159 linii) conține perechi DF/ORD aproape identice pentru
lifecycle. Consolidăm corpul lor într-un **service nou** parametrizat pe `formType`. Rutele rămân
exact unde sunt și cu aceleași path-uri/middleware — devin **wrappers subțiri** care apelează
service-ul. Asimetriile intenționate (probate în Etapa 0) trăiesc **explicit într-un config per tip**,
nu îngropate în `if (ft==='ord')`.

**Regula de aur a etapei:** comportament observabil **identic**. Aceleași status code-uri, aceleași
`body.error`, aceeași stare DB, aceleași notificări, același audit. Plasa Etapei 0
(`caracterizare-{submit,complete,returneaza,revizuieste}-*.test.mjs`) trebuie să rămână verde
**fără să-i modifici aserțiunile**. Dacă un test din Etapa 0 pică, ai schimbat comportament → revino,
nu „ajusta testul".

**Un singur tip de schimbare:** extragere + parametrizare. NU splitezi fișierul (aia e Etapa 2). NU
introduci tranzacții unde nu erau (handler-ele folosesc `pool.query` direct, non-tranzacțional pe
complete — **păstrează** asta). NU „îmbunătăți" nimic pe parcurs.

---

## 🚫 Zone interzise (rămân valabile)

- NU atinge fișierele de signing NO-TOUCH (`STSCloudProvider.mjs`, `cloud-signing.mjs`,
  `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`).
- NU atinge `server/db/migrate.mjs`. NU adăuga migrări. NU modifica schema.
- NU atinge `formular-capabilities.mjs` / `authz-formular.mjs` (le **folosești**, nu le schimbi).
- NU modifica `db-real.mjs` și NU modifica aserțiunile testelor din Etapa 0.

---

## 📋 Pas 0 — verificare precondiție

```bash
git checkout develop && git pull origin develop
git status   # working tree clean

# Etapa 0 prezentă și verde (cu Docker pornit + TEST_DATABASE_URL exportat):
npm run db:test:up   # exportă TEST_DATABASE_URL afișat
npm run test:db
# Așteptat: caracterizare-{submit,complete,returneaza,revizuieste}-*.test.mjs RULATE + PASSED.
# Skipped = nedovedit → STOP, pornește Docker.

npm test   # baseline mock: verde, fără regresii
```

Dacă Etapa 0 nu e verde/rulată → **STOP**. Nu refactoriza fără plasă.

---

## 📋 Pas 1 — citește handler-ele curente (sursa de adevăr)

În `server/routes/formulare-db.mjs`, citește perechile pe care le consolidăm și notează **fiecare**
diferență DF↔ORD:

| Operație | DF | ORD |
|---|---|---|
| `submit` | linia ~359 | linia ~1023 |
| `complete` | linia ~412 | linia ~1075 |
| `returneaza` | linia ~486 | linia ~1157 |
| `link-flow` | linia ~532 | linia ~1203 |
| `sterge` | linia ~754 (`DELETE`) + ~1869 (`POST /sterge`) | ~1269 + ~1948 |

Helperele deja partajate (le **reutilizezi**, nu le rescrii): `sendNotif`, `recordFormularAudit`,
`computeDocCapabilities`, `loadActorComp`, `canEditFormular`, `canViewFormular`, `canDestroyOnly`,
`pick`, `buildUpdate`, `requireDb`, `DF_P2_FIELDS`/`ORD_P2_FIELDS`/`DF_P1_FIELDS`/`ORD_P1_FIELDS`.

Diferențele confirmate care DEVIN config (nu cod condiționat ad-hoc):

- **tabel:** `formulare_df` / `formulare_ord`
- **submit statuses (ASIMETRIE):** DF `['draft','returnat','de_revizuit']` / ORD `['draft','returnat']`
- **budget check la complete (ASIMETRIE):** DF `none` / ORD `hard_col5` (validarea col.5 ≥ 0,
  422 `receptii_neplatite_negative`)
- **update ALOP la complete (ASIMETRIE):** DF actualizează `alop_instances`
  (`df_completed_at`, `draft → angajare`) + audit `legat_alop`; ORD **nu** atinge ALOP la complete
- **câmpuri P2:** `DF_P2_FIELDS` / `ORD_P2_FIELDS`
- **notificări:** type/title/message + câmpul de număr (`nr_unic_inreg` / `nr_ordonant_pl`)
- **capsFt:** `notafd` (DF) / `ordnt` (ORD)
- **revizuieste:** DF-only — NU intră în config-ul partajat, rămâne handler dedicat (vezi Pas 4)

---

## 📋 Pas 2 — creează `server/services/formular-shared.mjs`

### Config per tip — discriminatori EXPLICIȚI

```js
// Sursă unică pentru diferențele DF↔ORD pe lifecycle.
// ASIMETRIILE sunt intenționate și probate în server/tests/db/caracterizare-*.
// NU le uniformiza. Orice buton/regulă nouă: adaugă o cheie aici + un test.
export const FORMULAR_TYPES = {
  df: {
    table: 'formulare_df',
    capsFt: 'notafd',
    p2Fields: DF_P2_FIELDS,
    submitStatuses: ['draft', 'returnat', 'de_revizuit'],
    budgetCheck: 'none',                 // DF: buget = soft-warning DOAR în frontend (by design)
    alopOnComplete: 'df_angajare',       // DF complete → alop_instances draft→angajare + legat_alop
    nrField: 'nr_unic_inreg',
    notif: {
      submitType: 'formulare_df_p2',
      submitTitle: 'Document de Fundamentare — completare solicitată',
      completedType: 'formulare_df_completed',
      completedTitle: 'Document de Fundamentare — completat de Responsabil CAB',
      // ... mesajele exact ca în handler-ul curent
    },
  },
  ord: {
    table: 'formulare_ord',
    capsFt: 'ordnt',
    p2Fields: ORD_P2_FIELDS,
    submitStatuses: ['draft', 'returnat'],   // ASIMETRIE: fără 'de_revizuit'
    budgetCheck: 'hard_col5',                // ORD: validare hard col.5 ≥ 0 → 422
    alopOnComplete: null,                    // ORD complete NU atinge ALOP
    nrField: 'nr_ordonant_pl',
    notif: { /* ... exact ca în handler-ul curent ORD ... */ },
  },
};
```

### Funcții service — contract `{ status, body }` (testabil, fără cuplare la `res`)

Fiecare funcție primește `{ type, id, actor, body }` (+ `pool` injectat) și **returnează**
`{ status: <int>, body: <obj> }`. Wrapper-ul de rută face doar
`const r = await submitFormular(...); return res.status(r.status).json(r.body);`.

Implementează:

- `submitFormular({ type, id, actor, body })`
- `completeFormular({ type, id, actor, body })` — include budget check gated de
  `cfg.budgetCheck === 'hard_col5'` (mută blocul de validare col.5 aici ca helper intern
  `validateOrdCol5(rows)`), și update ALOP gated de `cfg.alopOnComplete`
- `returnFormular({ type, id, actor, body })`  (returneaza)
- `linkFlowFormular({ type, id, actor, body })`
- `stergeFormular({ type, id, actor })`  (acoperit deja de `sterge-df-ord.test.mjs` — păstrează exact)

Mută helperele partajate de care au nevoie (`pick`, `buildUpdate`, etc.) în service SAU importă-le —
alege o singură variantă și fii consistent. Dacă le muți, importă-le înapoi în `formulare-db.mjs`
pentru rutele care le mai folosesc (create, capturi, atașamente).

**Păstrează fidel:** ordinea operațiilor, caracterul non-fatal al update-ului ALOP (`try/catch` +
`logger.warn`), toate event-urile de audit (inclusiv `legat_alop` pe DF), `updated_by`, recalculul
`capabilities` pe răspuns.

---

## 📋 Pas 3 — rescrie rutele DF/ORD ca wrappers subțiri

În `formulare-db.mjs`, fiecare handler din perechile de mai sus devine:

```js
router.post('/api/formulare-df/:id/submit', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const r = await submitFormular({ type: 'df', id: req.params.id, actor, body: req.body });
  res.status(r.status).json(r.body);
});
```

Idem ORD cu `type: 'ord'`. Path-urile, middleware-ul (`_csrf`, `requireModule` pe create — **create
NU intră în această etapă**, are diferențe de `requireModule('df')` vs `requireModule('ord')`; lasă
create neatins), și `try/catch`-ul de top rămân. Mută `try/catch`-ul cu `logger.error` + 500 în
service sau în wrapper — o singură variantă, consistent.

⚠️ `requireAuth` e dual-mode (vezi CLAUDE.md). Aceste rute folosesc **helper mode**
(`const actor = requireAuth(req, res); if (!actor) return;`). Păstrează exact acest pattern în
wrappers — NU amesteca cu middleware mode.

---

## 📋 Pas 4 — Finding #2 (bug preexistent): UUID malformat la `revizuieste` → 404, nu 500

`formulare_df.id` e UUID. Un `:id` non-UUID la `POST /api/formulare-df/:id/revizuieste` (și aliasul
`/revizie`) ajunge în query și Postgres aruncă `invalid input syntax for type uuid` → handler-ul
întoarce **500**. Etapa 0 a marcat asta `it.todo` în `caracterizare-revizuieste-df.test.mjs`.

Fix minimal:
- adaugă un guard `isUuid(id)` (regex UUID standard) la începutul handler-ului `revizuieste` (rămâne
  handler dedicat DF, NU intră în service-ul partajat);
- dacă `:id` nu e UUID → `return res.status(404).json({ error: 'not_found' })` (consistent cu restul
  rutelor care întorc 404 `not_found` pentru document inexistent);
- în `caracterizare-revizuieste-df.test.mjs`, transformă `it.todo(...)` în `it(...)` real care
  afirmă **404** pe id non-UUID. Acesta e singurul test din Etapa 0 pe care ai voie să-l atingi, și
  doar ca să-l activezi (todo → activ), nu ca să-i slăbești o aserțiune existentă.

(Opțional, dacă același pattern apare și pe alte rute DF/ORD cu `:id` UUID și ai un test care-l
prinde — aplică același guard. Dacă nu ai test, NU-l atinge în etapa asta.)

---

## 📋 Pas 5 — verificare verde

```bash
npm run check        # node --check pe toate fișierele (sintaxă)

# DB-tests (Docker pornit + TEST_DATABASE_URL):
npm run test:db
# Așteptat: TOATE caracterizare-* RULATE + PASSED, FĂRĂ aserțiuni modificate
# (excepție: revizuieste todo→activ pe 404). Plus sterge-df-ord, doc-capabilities* verzi.

npm test
# Așteptat: npm test verde, fără regresii.
```

Dacă un test de caracterizare pică → ai schimbat comportament. Citește diff-ul, găsește unde
service-ul deviază de la handler-ul original, **corectează service-ul** până testul trece neschimbat.
NU rescrie testul.

Sanity manual (opțional, dacă ai DB local cu date): un DF submit→complete și un ORD submit→complete
end-to-end, plus un ORD complete cu col.5 negativă (trebuie 422) și un DF complete „peste buget"
(trebuie 200, soft-warning rămâne pe frontend).

---

## 📋 Pas 6 — bump versiune (patch, backend-only)

```bash
# package.json: 3.9.543 → 3.9.544. FĂRĂ CACHE_VERSION în sw.js. FĂRĂ sed pe ?v=.
```

---

## 📋 Pas 7 — commit + push

```bash
git add server/services/formular-shared.mjs server/routes/formulare-db.mjs \
        server/tests/db/caracterizare-revizuieste-df.test.mjs package.json
git commit -m "refactor(formulare): lifecycle DF/ORD în formular-shared.mjs parametrizat pe formType + fix 404 revizuieste id non-UUID"
git push origin develop
```

CI (`push: develop`) rulează ambele niveluri cu `postgres:16` — confirmă DB-tests **passed**, nu sărite.

---

## ✅ Definiție de „gata"

1. `server/services/formular-shared.mjs` nou: `FORMULAR_TYPES` config + funcții lifecycle
   (`submitFormular`/`completeFormular`/`returnFormular`/`linkFlowFormular`/`stergeFormular`).
2. Toate cele 3 asimetrii (submit-status, budget-check, alop-on-complete) sunt **chei de config
   explicite**, nu `if (ft==='ord')` îngropat.
3. Rutele DF/ORD din `formulare-db.mjs` sunt wrappers subțiri; path-uri/middleware neschimbate;
   `requireAuth` rămâne helper mode.
4. Finding #2 reparat: `revizuieste` cu id non-UUID → 404; testul Etapa 0 trecut din `todo` în activ.
5. `npm run check` ok; `npm test` verde fără regresii; `npm run test:db` verde **RULAT**
   (Docker/CI), cu aserțiunile Etapei 0 **neschimbate** (singura excepție: revizuieste todo→activ).
6. Reducere netă de linii duplicate vizibilă în diff (`git diff --stat main..develop -- server/routes/formulare-db.mjs`).
7. Push pe develop; CI verde.
8. Raport scurt: ce funcții s-au extras, câte linii duplicate eliminate, confirmare „comportament
   identic — toate caracterizările verzi neschimbate", confirmare zone NO-TOUCH neatinse.

**Nu raporta „gata" până testele de caracterizare nu trec NESCHIMBATE (RULATE, nu sărite).**

---

## ⛔ Dacă ceva e ambiguu

Dacă întâlnești o a patra diferență DF↔ORD pe care n-am listat-o în Pas 1 (ceva ce nu se mapează
curat pe config), **NU improviza** un `if`. Oprește, adaugă o cheie nouă în `FORMULAR_TYPES` cu nume
descriptiv + comentariu de ce e asimetric, și menționeaz-o în raport ca diferență nou-descoperită.
Niciodată o asimetrie tăcută.
