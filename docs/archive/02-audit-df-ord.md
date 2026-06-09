# FEATURE: Audit DF/ORD per formular individual (timeline + export CSV + PDF)

> ⚠️ **BRANCH: `develop` EXCLUSIV.** NU face checkout/merge/push pe `main`.
> `main` = producție, gestionat manual de Mircea. Toată munca rămâne pe `develop`.
>
> ⚠️ **NO-TOUCH:** `server/signing/pades.mjs`, `STSCloudProvider.mjs`,
> `cloud-signing.mjs`, `bulk-signing.mjs`, `java-pades-client.mjs`. Nimic din
> acest task nu le atinge.

---

## Context

Fluxurile au audit complet (`events[]` în `flows.data`, export TXT/PDF/CSV pe
`GET /admin/flows/:flowId/audit` — vezi `server/routes/admin/flows.mjs` liniile
~448-650 pentru patternul PDF). **DF/ORD nu au niciun istoric** — tranzițiile de
status doar suprascriu coloana `status` (singura urmă: `updated_by`, migrația 066).

Obiectiv: trail de audit pentru fiecare DF/ORD individual, cu timeline în UI +
export **CSV și PDF**, **identic ca experiență cu fluxurile**.

**Acces (strict):** doar `role='admin'` (superadmin, vede tot) și `role='org_admin'`
(doar `org_id`-ul propriu). Utilizatorii normali (P1/P2) NU au acces. Folosește
patternul existent din `server/routes/admin/_helpers.mjs`:
`isAdminOrOrgAdmin(actor)` + `actorOrgFilter(actor)`.

---

## 1. Migrație — tabel dedicat polimorfic

În `server/db/index.mjs`, adaugă în array-ul de migrații (după `082_formulare_ord_df_id_idx`):

```js
{
  id: '083_formulare_audit',
  sql: `
    CREATE TABLE IF NOT EXISTS formulare_audit (
      id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id      INTEGER NOT NULL REFERENCES organizations(id),
      form_type   TEXT    NOT NULL,   -- 'df' | 'ord'
      form_id     UUID    NOT NULL,
      actor_id    INTEGER REFERENCES users(id),
      actor_email TEXT,
      event_type  TEXT    NOT NULL,
      from_status TEXT,
      to_status   TEXT,
      meta        JSONB   NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_formulare_audit_form ON formulare_audit(form_type, form_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_formulare_audit_org  ON formulare_audit(org_id, created_at DESC);
  `
},
```

## 2. Helper de scriere/citire

Fișier nou `server/db/queries/formulare-audit.mjs`:

- `recordFormularAudit({ orgId, formType, formId, actorId, actorEmail, eventType, fromStatus = null, toStatus = null, meta = {} })`
  — INSERT în `formulare_audit`. Import lazy al `pool` (ca în `queries/audit.mjs`,
  pentru a evita dependency cycle). **Best-effort**: wrap intern în try/catch,
  `logger.warn` non-fatal la eroare — NU trebuie să blocheze niciodată tranziția.
- `listFormularAudit(formType, formId)` — `SELECT ... ORDER BY created_at DESC`,
  cu JOIN pe `users` pentru `actor_name` (`COALESCE(NULLIF(u.nume,''), actor_email)`).

## 3. Hook-uri în `server/routes/formulare-db.mjs`

Adaugă apel `recordFormularAudit(...)` (best-effort, după UPDATE-ul reușit) DOAR
la tranzițiile de lifecycle de mai jos — **NU** pe PUT-ul de salvare/autosave
(`PUT /api/formulare-df/:id`, `PUT /api/formulare-ord/:id`), care e zgomotos.

| Endpoint (DF la `:id`, simetric ORD)        | event_type            | to_status / meta                     |
|---------------------------------------------|-----------------------|--------------------------------------|
| `POST /api/formulare-df` (create)           | `creat`               | to=`draft`                           |
| `POST /api/formulare-df/:id/submit`         | `trimis_p2`           | to=`pending_p2`, meta:{assigned_to}  |
| `POST /api/formulare-df/:id/complete`       | `completat`           | to=`completed`                       |
| `POST .../complete` (la link ALOP, ~l.436)  | `legat_alop`          | meta:{alop_id} (dacă se leagă)       |
| `POST /api/formulare-df/:id/returneaza`     | `returnat`            | to=`returnat`, meta:{motiv}          |
| `POST /api/formulare-df/:id/link-flow`      | `transmis_flux`       | to=`transmis_flux`, meta:{flow_id}   |
| `POST .../revizuieste` (+ reopen completed→draft din PUT) | `revizuit` | meta:{version_nou}                   |
| `POST /api/formulare-df/:id/sterge` + `DELETE /:id` | `sters`       | meta:{}                              |

Pentru `from_status`: citește statusul curent al documentului ÎNAINTE de UPDATE
(majoritatea handler-elor încarcă deja `doc`/`rows[0]`). Dacă nu e disponibil,
trimite `null`.

ORD: aceleași 7 evenimente pe rutele simetrice `/api/formulare-ord/:id/...`
(fără `legat_alop` dacă ORD nu face link ALOP direct — verifică în cod).

## 4. Endpoint de citire/export

În `server/routes/formulare-db.mjs`, adaugă (mounted deja la `/`):

```
GET /api/formulare-audit/:type/:id?format=json|csv|pdf
```

- `:type` ∈ {`df`,`ord`}; `:id` = UUID formular. Validează `:type`.
- `requireAuth` + **`isAdminOrOrgAdmin(actor)`** (altfel 403).
- Încarcă documentul (`formulare_df`/`formulare_ord` după type) pentru
  header-ul exportului (nr_unic_inreg, den_inst_pb, compartiment_specialitate,
  status, created_at, updated_at, inițiator din `users`).
- **Scoping org_admin:** dacă `actor.role==='org_admin'` și `doc.org_id !== actor.orgId` → 403.
  Dacă documentul nu există → 404.
- `format=json` (default): `{ document:{...header...}, events:[...] }` din `listFormularAudit`.
- `format=csv`: header `timestamp,event,actor,from,to,meta` + UTF-8 BOM
  (`\uFEFF`), separator zecimal românesc N/A aici; `Content-Disposition: attachment`.
- `format=pdf`: **mirror exact al patternului din `admin/flows.mjs`**
  (`PDFLibAdmin`, funcția `ro()` de eliminat diacritice/non-WinAnsi, dreptunghi
  header albastru `rgb(0.1,0.1,0.25)`, titlu "AUDIT FORMULAR", apoi blocul de
  metadate document, apoi tabelul de evenimente cu etichete RO). Reutilizează
  importul pdf-lib existent; NU duplica fonturi. Filename:
  `audit_<type>_<id>.pdf`.

**Etichete RO evenimente** (definește un map local în endpoint, pt. PDF/CSV):
`creat`→"CREAT", `trimis_p2`→"TRIMIS LA RESPONSABIL CAB",
`completat`→"COMPLETAT DE RESPONSABIL CAB", `legat_alop`→"LEGAT DE ALOP",
`returnat`→"RETURNAT", `transmis_flux`→"TRANSMIS ÎN FLUX",
`revizuit`→"REVIZUIT", `sters`→"ȘTERS".

## 5. UI — iconiță audit per rând în listă (ca la fluxuri) + modal

Auditul se accesează **din lista DF/ORD**, ca iconiță în coloana ACȚIUNI
(lângă "Deschide" / 🗑 / 🔗), NU din header-ul formularului. Identic ca pattern
cu fluxurile (iconiță, fără text).

### `public/js/formular/list.js`

- În `_renderLstTable(rows,type)`, în celula de acțiuni (acolo unde se randează
  acum `Deschide` + `cancelBtn`), adaugă o iconiță de audit **gated pe rol**:
  ```js
  const isAdm = window.ST?.user?.role==='admin' || window.ST?.user?.role==='org_admin';
  const auditBtn = isAdm
    ? `<button class="df-action-btn teal sm" onclick="openFormAudit('${type}','${safeId}')" title="Audit document"><svg class="df-ic"><use href="/icons.svg?v=VERSION#ico-scroll"/></svg></button>`
    : '';
  ```
  și include `${auditBtn}` în celulă, după butonul `Deschide`.

### `public/formular.html`

- Adaugă un modal `#audit-modal` (reutilizează stilul modalelor existente din
  pagină — ex. modalul P2 / trasabilitate) cu: titlu, `#audit-timeline` (listă
  evenimente), și două butoane "📄 Export PDF" / "📋 Export CSV".

### `public/js/formular/doc.js` (sau list.js — alege locul cu acces la `openFormAudit`)

- Funcție globală `openFormAudit(type, id)`:
  `fetch('/api/formulare-audit/'+type+'/'+id)` → randează timeline-ul în
  `#audit-timeline` (etichete RO + `actor_name` + dată `ro-RO`,
  `timeZone:'Europe/Bucharest'` + `from→to` + `meta.motiv` când există;
  evenimentele cu `meta.backfill===true` primesc un mic tag „dedus" — vezi §9);
  setează handler-ele pe butoanele de export (download
  `/api/formulare-audit/<type>/<id>?format=pdf|csv`); deschide modalul.
  Expune `window.openFormAudit = openFormAudit;`.

## 6. Sincronizare dicționar i18n audit (admin)

Adaugă noile `event_type`-uri (`creat`, `trimis_p2`, `completat`, `legat_alop`,
`returnat`, `transmis_flux`, `revizuit`, `sters`) cu etichete RO în **AMBELE**
dicționare sincronizate manual:
- `public/js/admin/audit.js` (`AUDIT_EVENT_LABELS`)
- `public/js/admin/activity.js` (dicționarul echivalent)

(astfel încât, dacă vreodată sunt agregate global, să nu apară ca tag raw).

## 7. Teste

Adaugă în `server/tests/` (integration) cazuri pentru:
- scriere audit la fiecare tranziție DF și ORD (mock pool, assert INSERT
  `formulare_audit` cu `event_type` corect);
- endpoint `GET /api/formulare-audit/:type/:id`: 403 pentru user normal,
  200 pentru admin, 403 pentru org_admin pe alt org, 404 pe id inexistent;
- best-effort: o eroare la `recordFormularAudit` NU propagă 500 pe tranziție.

## 8. Cache-busting

- Bumpează `version` în `package.json` la următoarea valoare patch
  (ex. `3.9.539` dacă `538` e deja aplicat — verifică valoarea curentă).
- Bumpează `?v=` doar pe referințele din `public/formular.html` către fișierele
  atinse (`doc.js`, `icons.svg`).

## 9. Backfill istoric (documente deja inițiate) — INCLUS

Tabelul fiind nou, DF/ORD existente ar avea timeline gol. Reconstruiește un trail
aproximativ, **o singură dată**, din coloanele de timp existente. Rulează ca pas
final în migrația `083` (DUPĂ `CREATE TABLE`), idempotent.

Pentru fiecare `formulare_df` / `formulare_ord` cu `deleted_at IS NULL` care **nu
are deja** evenimente în `formulare_audit`, inserează evenimente deduse:
- `created_at` + `created_by` → `creat` (to=`draft`)
- `submitted_at` (dacă NOT NULL) → `trimis_p2` (to=`pending_p2`)
- `completed_at` (dacă NOT NULL) → `completat` (to=`completed`)
- `flow_id` (dacă NOT NULL) → `transmis_flux`
- `status='returnat'` + `motiv_returnare` → `returnat` (meta:{motiv})

Toate evenimentele backfill primesc **`meta` cu `{"backfill": true}`** (în UI/PDF
le marcăm cu tag „dedus din date", nu capturate live). `actor_id` = `created_by`
acolo unde nu avem actor real (avem doar `updated_by` = ultimul editor).
`created_at` al evenimentului = coloana de timp corespunzătoare (NU `NOW()`), ca
ordinea cronologică să fie corectă.

Idempotență: `WHERE NOT EXISTS (SELECT 1 FROM formulare_audit a WHERE a.form_type=... AND a.form_id=...)`.

> Dacă NU vrei backfill (preferi istoric gol pe documentele vechi), șterge
> integral acest §9 înainte de rulare.

## Verificare

- `npm test` → **verde, fără regresii.**
- `npm run check` → fără erori de sintaxă.
- Manual: în lista DF ca admin → iconița audit apare pe fiecare rând → click →
  modal cu timeline (documentele vechi au evenimente marcate „dedus") → export
  PDF arată ca auditul de flux; ca user normal iconița lipsește și endpoint-ul
  dă 403.

## Finalizare (obligatoriu)

```bash
git add .
git commit -m "feat(formulare): audit DF/ORD per formular cu timeline + export CSV/PDF (admin/org_admin) v3.9.539"
git push origin develop
```
