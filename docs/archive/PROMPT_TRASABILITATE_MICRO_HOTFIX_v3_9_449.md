# DocFlowAI — 🩹 TRASABILITATE MICRO-HOTFIX: scoatem cancelled_reason (v3.9.449)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH: develop ONLY. NU FACE merge / push / checkout pe main.
═══════════════════════════════════════════════════════════
```

> Micro-hotfix peste v3.9.448. Identificat din Railway logs:
> `err.message: column a.cancelled_reason does not exist (err.code: 42703)`
>
> Coloana e listată în migrația 014_alop.sql originală DAR nu există pe BD-ul
> real de pe staging (DROP COLUMN istoric nedocumentat). Trebuie scoasă din
> SELECT-uri. Câmpul oricum NU era afișat în UI — drop curat, fără rework.

```
DocFlowAI v3.9.448 → v3.9.449 (SW v164 → v165)
Branch: develop  ⚠️ EXCLUSIV develop
Subiect: fix(trasabilitate): scoatem a.cancelled_reason inexistent din SELECT-uri

═══════════════════════════════════════════════════════════
PASUL 1 — Service: scoate a.cancelled_reason din ambele Q3
═══════════════════════════════════════════════════════════

În server/services/trasabilitate.mjs sunt 2 query-uri Q3 care selectează
`a.cancelled_reason`. Ambele trebuie modificate.

PASUL 1.1 — Q3 pentru type='df':

old_str:
         a.created_at, a.completed_at, a.cancelled_at, a.cancelled_reason,
         foc.nr_unic_inreg AS ord_curent_nr_unic_inreg,
         foc.beneficiar    AS ord_curent_titlu,
         foc.status        AS ord_curent_status,
         foc.flow_id       AS ord_curent_flow_id,
         CASE WHEN foc.flow_id IS NOT NULL
              AND (foc_f.data->>'status' = 'completed' OR (foc_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_curent_aprobat
       FROM alop_instances a
       LEFT JOIN formulare_ord foc ON foc.id = a.ord_id AND foc.org_id = $1
       LEFT JOIN flows        foc_f ON foc_f.id::text = foc.flow_id
       WHERE a.org_id = $1
         AND a.df_id = ANY($2::uuid[])

new_str:
         a.created_at, a.completed_at, a.cancelled_at,
         foc.nr_unic_inreg AS ord_curent_nr_unic_inreg,
         foc.beneficiar    AS ord_curent_titlu,
         foc.status        AS ord_curent_status,
         foc.flow_id       AS ord_curent_flow_id,
         CASE WHEN foc.flow_id IS NOT NULL
              AND (foc_f.data->>'status' = 'completed' OR (foc_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_curent_aprobat
       FROM alop_instances a
       LEFT JOIN formulare_ord foc ON foc.id = a.ord_id AND foc.org_id = $1
       LEFT JOIN flows        foc_f ON foc_f.id::text = foc.flow_id
       WHERE a.org_id = $1
         AND a.df_id = ANY($2::uuid[])

PASUL 1.2 — Q3 pentru type='ord' (același pattern):

old_str:
         a.created_at, a.completed_at, a.cancelled_at, a.cancelled_reason,
         foc.nr_unic_inreg AS ord_curent_nr_unic_inreg,
         foc.beneficiar    AS ord_curent_titlu,
         foc.status        AS ord_curent_status,
         foc.flow_id       AS ord_curent_flow_id,
         CASE WHEN foc.flow_id IS NOT NULL
              AND (foc_f.data->>'status' = 'completed' OR (foc_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_curent_aprobat
       FROM alop_instances a
       LEFT JOIN formulare_ord foc ON foc.id = a.ord_id AND foc.org_id = $1
       LEFT JOIN flows        foc_f ON foc_f.id::text = foc.flow_id
       WHERE a.org_id = $1
         AND (a.ord_id = $2

new_str:
         a.created_at, a.completed_at, a.cancelled_at,
         foc.nr_unic_inreg AS ord_curent_nr_unic_inreg,
         foc.beneficiar    AS ord_curent_titlu,
         foc.status        AS ord_curent_status,
         foc.flow_id       AS ord_curent_flow_id,
         CASE WHEN foc.flow_id IS NOT NULL
              AND (foc_f.data->>'status' = 'completed' OR (foc_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_curent_aprobat
       FROM alop_instances a
       LEFT JOIN formulare_ord foc ON foc.id = a.ord_id AND foc.org_id = $1
       LEFT JOIN flows        foc_f ON foc_f.id::text = foc.flow_id
       WHERE a.org_id = $1
         AND (a.ord_id = $2

NOTĂ: după ambele str_replace, verifică:
  grep -c "a.cancelled_reason" server/services/trasabilitate.mjs
  → 0 (zero ocurențe)

  grep -c "cancelled_at" server/services/trasabilitate.mjs
  → ≥ 2 (cancelled_at PĂSTRAT în ambele Q3)

═══════════════════════════════════════════════════════════
PASUL 2 — Service: scoate cancelled_reason din map alopuri
═══════════════════════════════════════════════════════════

În aceeași server/services/trasabilitate.mjs, în secțiunea „Asamblare răspuns",
unde construim obiectul alopuri:

old_str:
    cancelled_at:        a.cancelled_at,
    cancelled_reason:    a.cancelled_reason,

new_str:
    cancelled_at:        a.cancelled_at,

═══════════════════════════════════════════════════════════
PASUL 3 — Cache busting (3.9.448 → 3.9.449, SW v164 → v165)
═══════════════════════════════════════════════════════════

3.1 — package.json:
  old_str:   "version": "3.9.448",
  new_str:   "version": "3.9.449",

3.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v164';
  new_str: const CACHE_VERSION = 'docflowai-v165';

3.3 — NU bumpăm referințe HTML. Frontend-ul e neschimbat (doar service.mjs
backend e atins). Cache busting v=3.9.448 din HTML rămâne valid.

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Coloana eliminată complet:
   grep -c "cancelled_reason" server/services/trasabilitate.mjs
   → 0

2. Sintaxă OK:
   node --check server/services/trasabilitate.mjs

3. Teste — atenție: testul „200 DF root cu 2 revizii..." mock-uia raw row-uri
   cu `cancelled_reason: null`. ACUM nu mai e câmp în răspuns. Testul ar
   trebui să continue să treacă (e doar un mock, nu validează shape-ul).
   Dacă pică totuși:
     grep -c "cancelled_reason" server/tests/integration/trasabilitate.test.mjs
   → dacă > 0, scoate-le din mock data și asserts (sunt poate 1-2 ocurențe).

4. npm run check + npm test verde, fără regresii.

═══════════════════════════════════════════════════════════
COMMIT pe develop  ⚠️ NU MAIN!
═══════════════════════════════════════════════════════════
git add server/services/trasabilitate.mjs \
        package.json \
        public/sw.js

git commit -m "fix(trasabilitate): scoatem a.cancelled_reason inexistent din SELECT-uri (v3.9.449)

Bug runtime descoperit din Railway logs:
  err.message: column a.cancelled_reason does not exist
  err.code: 42703 (PostgreSQL undefined_column)

Coloana cancelled_reason apare în migrația originală 014_alop.sql DAR
NU există pe BD-ul real (DROP COLUMN istoric nedocumentat înainte de
forking-ul promptului meu).

Fix:
  - Scoasă a.cancelled_reason din ambele Q3 (DF + ORD)
  - Scoasă cancelled_reason din map-ul alopuri al răspunsului

Câmpul nici nu era afișat în UI (modal Trasabilitate v3.9.448), deci
drop curat fără impact funcțional. Dacă cândva avem nevoie de motivul
anulării, îl putem citi prin alt cale (eventual din meta JSONB).

Toate cele 8 teste integration rămân verzi.

Cache: package 3.9.448 → 3.9.449, SW v164 → v165."

git push origin develop  # ⚠️ NU origin main

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — VALIDARE END-TO-END
═══════════════════════════════════════════════════════════

1. Hard refresh /formular.html (Ctrl+Shift+R) — frontend-ul e neschimbat
   față de v3.9.448, doar API-ul nu mai dă 500.

2. Tab DF → click 🔗 inline pe un DF aprobat:
   → modal se deschide cu ⏳ Se încarcă...
   → DUPĂ ~1-2 secunde apare arborele:
       - Card DF cu badges revizii
       - Săgetă SVG dashed
       - Card ALOP (mov) cu cards ORD interioare (verzi)

3. Test ORD root: tab ORD → click 🔗 → vezi DF parent + ALOP + cicluri.

4. Console DevTools: ZERO erori 500. Doar GET /api/trasabilitate/... → 200.

5. Click pe un nod DF/ORD/ALOP din arbore: navighează corect.

6. ESC sau click overlay: modal se închide.

STOP dacă:
- Tot 500 → încă există referință ascunsă la cancelled_reason; check Railway
  logs pentru noua eroare.
- Modal apare gol → service nu mai întoarce date; check răspuns API direct
  cu curl.
```
