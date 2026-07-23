# ALOP — Matricea REALĂ de tranziții de status

> **Addendum #113a (2026-07-23, v3.9.741):** matricea porții (migrația **103**, care face
> `CREATE OR REPLACE` pe `alop_status_guard()`) a fost extinsă cu O SINGURĂ tranziție nouă:
> **`plata → ordonantare`**, permisă EXCLUSIV pentru admin-cancel pe ORD
> (`POST /flows/:flowId/admin-cancel` — undo administrativ al unui flux FINALIZAT). Matricea
> completă actuală:
> ```
> draft       → angajare, lichidare, cancelled
> angajare    → lichidare, plata, cancelled
> lichidare   → ordonantare, cancelled
> ordonantare → plata, cancelled
> plata       → completed, cancelled, ordonantare   ← + ordonantare (#113a)
> completed   → lichidare
> cancelled   → (terminal)
> ```
> Poarta rămâne în MOD OBSERVARE (RAISE WARNING + log, apoi RETURN NEW) — #113a NU face flipul
> spre RAISE EXCEPTION. Trigger-ul de audit (093) continuă să înregistreze tranziția.

> **Recon read-only pentru #92.** Extrasă din cod, nu din `VALID_TRANSITIONS`.
> Codul ALOP este specificația (validat manual în producție, OMF 1140/2025 mod. 2037/2025).
> **Acest document NU judecă și NU repară nicio tranziție.** Îl folosim la #92 pentru poartă
> unică + `CHECK` constraint.
>
> Branch: `develop`. Zero modificări în `server/`/`public/`. Generat 2026-07-13.

---

## Rezumat numeric

| Metrică | Valoare |
|---|---|
| Total situri `UPDATE alop_instances` (non-test) | **40** (7 fișiere) |
| **Categoria A** — scriu `status` | **19** |
| **Categoria B** — NU scriu `status` (doar `df_id`/`*_flow_id`/`titlu`/`lichidare_*`/`plata_*`) | **21** |
| Situri A cu `0 rânduri = NO-OP TĂCUT` | 7 |
| Situri A cu `0 rânduri = EROARE 4xx` | 6 |
| Situri A cu `0 rânduri = NECONTROLAT` (rows neinspectate, idempotent) | 5 |
| Situri A speciale (`0 rânduri` imposibil — rând FOR UPDATE-uit) | 1 |
| Situri A **fără nicio gardă de status în `WHERE` SQL** (⚠️) | 5 |
| Situri A în tranzacție reală (`BEGIN/COMMIT`) | 2 |
| Situri A pe `pool.query` liber | 17 |
| Situri A cu audit corespunzător | 1 (parțial) |

**Fișiere atinse (7):** `server/routes/alop.mjs` (17), `server/routes/flows/crud.mjs` (6),
`server/routes/flows/lifecycle.mjs` (2), `server/routes/flows/signing.mjs` (6, NO-TOUCH),
`server/routes/formulare/df.mjs` (1), `server/services/alop-link.mjs` (2),
`server/services/formular-shared.mjs` (6).

---

## PAS 1 — Inventar Categoria B (NU ating `status`) — 21 situri

Aceste situri scriu doar câmpuri de legătură / metadata. **NU intră în poarta #92.**

| # | Locație | SET (fără status) | Scop |
|---|---|---|---|
| B1 | `alop.mjs:885` | `titlu` | edit titlu ALOP |
| B2 | `alop.mjs:972` | `df_flow_id` | link-df-flow |
| B3 | `alop.mjs:1163` | `ord_id` | link-ord |
| B4 | `alop.mjs:1198` | `ord_flow_id` | link-ord-flow |
| B5 | `crud.mjs:433` | `df_flow_id` | auto link-df-flow la creare flux |
| B6 | `crud.mjs:461` | `ord_flow_id` | auto link-ord-flow la creare flux |
| B7 | `crud.mjs:703` | `df_flow_id=NULL, df_completed_at=NULL` | DELETE flux — curăță pointer DF |
| B8 | `crud.mjs:706` | `ord_flow_id=NULL, ord_completed_at=NULL` | DELETE flux — curăță pointer ORD |
| B9 | `lifecycle.mjs:510` | `df_flow_id=NULL, df_completed_at=NULL` | cancel flux — curăță pointer DF |
| B10 | `lifecycle.mjs:535` | `ord_flow_id=NULL, ord_completed_at=NULL` | cancel flux — curăță pointer ORD |
| B11 | `signing.mjs:154` | `df_flow_id=NULL, df_completed_at=NULL` | refuz DF R0 — curăță flux |
| B12 | `signing.mjs:168` | `df_id, df_flow_id, df_completed_at` | refuz DF R1+ — restore parent aprobat |
| B13 | `signing.mjs:176` | `df_flow_id=NULL, df_completed_at=NULL` | refuz DF R1+ fără parent aprobat |
| B14 | `signing.mjs:197` | `ord_flow_id=NULL, ord_completed_at=NULL` | refuz ORD — curăță flux |
| B15 | `df.mjs:553` | `df_id, df_flow_id=NULL, df_completed_at=NULL` | revizie DF — relink df_id la noua revizie (**în tranzacție**) |
| B16 | `alop-link.mjs:48` | `df_id, df_flow_id, df_completed_at` | self-heal relink DF→ALOP |
| B17 | `formular-shared.mjs:534` | `{df,ord}_flow_id` (`cfg.alopFlowField`) | link-flow — sync pointer |
| B18 | `formular-shared.mjs:571` | `df_id=NULL, df_flow_id=NULL, df_completed_at=NULL` | șterge DF R0 — eliberează |
| B19 | `formular-shared.mjs:583` | `df_id, df_flow_id, df_completed_at` | șterge DF R1+ — restore parent |
| B20 | `formular-shared.mjs:590` | `df_id=NULL, df_flow_id=NULL, df_completed_at=NULL` | șterge DF R1+ fără parent |
| B21 | `formular-shared.mjs:606` | `ord_id=NULL, ord_flow_id=NULL, ord_completed_at=NULL` | șterge ORD — eliberează |

> Notă: B7–B14, B16–B21 sunt curățări de pointer / relink. B15 rulează în tranzacție
> (revizie DF). Restul pe `pool.query`.

---

## PAS 2 — Categoria A (scriu `status`) — 16 situri per-instanță

*(cele 3 cazuri speciale — `1523`, `1583`, `1672` — sunt în PAS 3.)*

Legendă „0 rânduri": **NO-OP** = niciun efect, idempotent (self-heal) · **4xx** = eroare HTTP ·
**NECONTROLAT** = nimeni nu inspectează `rows` (idempotent, non-fatal în `try/catch`).

### A1 — `alop.mjs:654` — lazy auto-tranziție STS (draft/angajare → lichidare)
| Câmp | Valoare |
|---|---|
| Trigger | `GET /api/alop/:id` — DF aprobat (`df_aprobat`) dar ALOP rămas în draft/angajare |
| from → to | `draft, angajare → lichidare` |
| Gardă WHERE | `id=$1 AND status IN ('draft','angajare')` |
| 0 rânduri | **NO-OP TĂCUT** (`if (up[0])`; altfel nimic) |
| Tranzacțional | NU — `pool.query`, în `try/catch` non-fatal |
| Audit | **NU** (doar `logger.info`) |

### A2 — `alop.mjs:720` — self-heal #1: orphan ORD auto-link (ordonantare → plata)
| Câmp | Valoare |
|---|---|
| Trigger | `GET /api/alop/:id` — `status='ordonantare' AND ord_id IS NULL`, exact 1 ORD orfan |
| from → to | `ordonantare → plata` (doar dacă ORD-ul orfan e aprobat; altfel doar leagă `ord_id`, status neschimbat) |
| Gardă WHERE | `id=$p AND status='ordonantare' AND ord_id IS NULL` |
| 0 rânduri | **NO-OP TĂCUT** (`if (linked[0])`) |
| Tranzacțional | NU — `pool.query`, `try/catch` non-fatal |
| Audit | **NU** (`logger.info`) |

### A3 — `alop.mjs:786` — self-heal #2: ord_flow_id back-fill (ordonantare → plata)
| Câmp | Valoare |
|---|---|
| Trigger | `GET /api/alop/:id` — `status='ordonantare' AND ord_id SET AND ord_flow_id NULL`, flux ORD ne-anulat |
| from → to | `ordonantare → plata` (doar dacă fluxul ORD e aprobat; altfel doar back-fill `ord_flow_id`) |
| Gardă WHERE | `id=$last AND ord_flow_id IS NULL AND status='ordonantare'` |
| 0 rânduri | **NO-OP TĂCUT** (`if (linked[0])`) |
| Tranzacțional | NU — `pool.query`, `try/catch` non-fatal |
| Audit | **NU** (`logger.info`) |

### A4 — `alop.mjs:825` — lazy auto-tranziție STS (ordonantare → plata)
| Câmp | Valoare |
|---|---|
| Trigger | `GET /api/alop/:id` — `ord_aprobat AND status='ordonantare'` |
| from → to | `ordonantare → plata` |
| Gardă WHERE | `id=$1 AND status='ordonantare'` |
| 0 rânduri | **NO-OP TĂCUT** (`if (up[0])`) |
| Tranzacțional | NU — `pool.query`, `try/catch` non-fatal |
| Audit | **NU** (`logger.info`) |

### A5 — `alop.mjs:933` — link-df (draft → angajare)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/link-df` |
| from → to | `draft → angajare` (via `CASE`; alte stări → neschimbate, dar rândul se întoarce) |
| Gardă WHERE | `id=$2 AND org_id=$3 AND (df_id IS NULL OR df_id=$1)` — **⚠️ fără gardă de status în WHERE** (tranziția e limitată de `CASE`) |
| 0 rânduri | **EROARE 4xx** — `if (!rows[0]) 404 not_found` (0 rânduri = id/org/df_id neconcordant) |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

### A6 — `alop.mjs:1029` — link-df-flow, flux deja completat (draft/angajare → lichidare)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/link-df-flow` când fluxul legat e deja `completed` |
| from → to | `draft, angajare → lichidare` |
| Gardă WHERE | `id=$1 AND org_id=$2 AND status IN ('draft','angajare')` |
| 0 rânduri | **NECONTROLAT** — `rows` neinspectate; `try/catch` non-fatal (idempotent, safe) |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** (`logger.info`; audit DF `transmis_flux` există separat, nu pentru tranziția ALOP) |

### A7 — `alop.mjs:1068` — df-completed (angajare → lichidare)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/df-completed` |
| from → to | `angajare → lichidare` |
| Gardă WHERE | `id=$1 AND org_id=$2 AND df_flow_id IS NOT NULL AND status='angajare'` |
| 0 rânduri | **EROARE 4xx** — `400 df_flow_necesar_sau_status_invalid` |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

### A8 — `alop.mjs:1111` — confirma-lichidare (lichidare → ordonantare)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/confirma-lichidare` |
| from → to | `lichidare → ordonantare` (și `ordonantare → ordonantare` idempotent — re-confirmare) |
| Gardă WHERE | `id=$7 AND org_id=$8 AND status IN ('lichidare','ordonantare')` |
| 0 rânduri | **EROARE 4xx** — `400 status_invalid` |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

### A9 — `alop.mjs:1239` — ord-completed (ordonantare → plata)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/ord-completed` |
| from → to | `ordonantare → plata` |
| Gardă WHERE | `id=$1 AND org_id=$2 AND ord_flow_id IS NOT NULL AND status='ordonantare'` |
| 0 rânduri | **EROARE 4xx** — `400 ord_flow_necesar_sau_status_invalid` |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

### A10 — `alop.mjs:1280` — `applyPlataConfirmedSideEffects` (plata → completed)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/confirma-plata` (manual) **și** matcher OPME (`plata_source='opme_auto'`) |
| from → to | `plata → completed` |
| Gardă WHERE | `id=$7 AND org_id=$8 AND status='plata' AND plata_confirmed_at IS NULL` |
| 0 rânduri | **EROARE 4xx** — `confirma-plata`: `400 status_invalid`. Caller OPME: verifică `row`/`confirmed`. |
| Tranzacțional | **DA** — `confirma-plata` apelează cu `client` sub `BEGIN/COMMIT` + `SELECT ... FOR UPDATE` |
| Audit | **NU** pe calea manuală; calea OPME scrie separat `audit_log 'plata_auto_opme'` (matcher) |

### A11 — `crud.mjs:452` — POST /flows edge, flux deja completed (angajare → lichidare)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /flows` cu `meta.dfId`, fluxul nou-creat deja `completed` |
| from → to | `angajare → lichidare` |
| Gardă WHERE | `df_flow_id=$1 AND status='angajare'` — **⚠️ fără `org_id`/`id`** (țintit pe `df_flow_id`) |
| 0 rânduri | **NECONTROLAT** — `rows` neinspectate; `try/catch` non-fatal |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

### A12 — `crud.mjs:476` — POST /flows edge, flux deja completed (ordonantare → plata)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /flows` cu `meta.ordId`, fluxul nou-creat deja `completed` |
| from → to | `ordonantare → plata` |
| Gardă WHERE | `ord_flow_id=$1 AND status='ordonantare'` — **⚠️ fără `org_id`/`id`** |
| 0 rânduri | **NECONTROLAT** — `rows` neinspectate; `try/catch` non-fatal |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

### A13 — `signing.mjs:437` (⛔ NO-TOUCH) — flux DF semnat (draft/angajare → lichidare)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /flows/:flowId/upload-signed-pdf` — ultimul semnatar (allDone) pe flux DF |
| from → to | `draft, angajare → lichidare` (gardă de status la nivel **app**: `if (['draft','angajare'].includes(al.status))`) |
| Gardă WHERE | **`id=$1` DOAR — ⚠️ fără gardă de status în WHERE SQL** |
| 0 rânduri | **NECONTROLAT** — `rows` neinspectate; `try/catch` non-fatal |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** (`logger.info`) |

### A14 — `signing.mjs:449` (⛔ NO-TOUCH) — flux ORD semnat (ordonantare → plata)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /flows/:flowId/upload-signed-pdf` — allDone pe flux ORD (direct sau via `alop_ord_cicluri`) |
| from → to | `ordonantare → plata` (gardă de status la nivel **app**: `if (alopOrdRow.status === 'ordonantare')`) |
| Gardă WHERE | **`id=$1` DOAR — ⚠️ fără gardă de status în WHERE SQL** |
| 0 rânduri | **NECONTROLAT** — `rows` neinspectate; `try/catch` non-fatal |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** (`logger.info`) |

### A15 — `alop-link.mjs:67` — self-heal relink la aprobare flux (draft/angajare → lichidare)
| Câmp | Valoare |
|---|---|
| Trigger | `selfHealAlopDfLink()` — apelat din `signing.mjs` (allDone) + `crud.mjs` (edge completed) |
| from → to | `draft, angajare → lichidare` |
| Gardă WHERE | `id=$1 AND status IN ('draft','angajare') AND cancelled_at IS NULL` |
| 0 rânduri | **NO-OP TĂCUT** — `rows` neinspectate; funcție idempotentă, `try/catch` non-fatal |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** (`logger.info`) |

### A16 — `formular-shared.mjs:409` — DF P2 complete (draft → angajare)
| Câmp | Valoare |
|---|---|
| Trigger | `completeFormular` (DF) — `cfg.alopOnComplete==='df_angajare'` (asimetrie: ORD nu atinge ALOP) |
| from → to | `draft → angajare` (via `CASE`; `angajare → angajare` idempotent, `WHERE` acceptă ambele) |
| Gardă WHERE | `df_id=$1 AND org_id=$2 AND status IN ('draft','angajare')` |
| 0 rânduri | **NO-OP TĂCUT** (`if (alopRows.length) linkedAlopId=...`) |
| Tranzacțional | NU — `pool.query`, `try/catch` non-fatal |
| Audit | **DA (parțial)** — `recordFormularAudit eventType='legat_alop'` când s-a legat (`meta.alop_id`); e audit de formular, nu `writeAuditEvent` pe ALOP |

---

## PAS 3 — Cazuri speciale (nu sunt tranziții per-instanță simple)

### S1 — `alop.mjs:1523` — noua-lichidare: RESET ciclu (completed → lichidare) ⬅️ ÎNAPOI, INTENȚIONAT
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/noua-lichidare` — pornește un nou ciclu ORD pe același DF |
| from → to | `completed → lichidare` (gardă de status la nivel **app**: `if (alop.status !== 'completed') 400`) |
| Efect | Arhivează ciclul curent în `alop_ord_cicluri`, apoi **golește** toate `ord_*`/`lichidare_*`/`plata_*`, incrementează `ciclu_curent`, resetează `completed_at=NULL` |
| Precondiție business | `ramas = crediteBugetareAnCurent(rows_ctrl col.10) − sumaOrdonantată > 0`; altfel `400 limita_depasita` |
| Gardă WHERE | **`id=$1` DOAR** — rândul e deja `SELECT ... FOR UPDATE`-uit în aceeași tranzacție; status-ul e verificat în app |
| 0 rânduri | **IMPOSIBIL** — rândul e blocat FOR UPDATE anterior; `updated` folosit în răspuns |
| Tranzacțional | **DA** — `client` sub `BEGIN/COMMIT`, `FOR UPDATE` pe ALOP |
| Audit | **NU** (`logger.info`; backfill OPME `matched_ciclu_id` post-commit, non-fatal) |

> **De ce e corect (nu-l atinge):** legea permite reluarea ordonanțării pe același angajament
> (DF) în limita creditelor bugetare rămase. Un ALOP finalizat → revizie DF (valoare mărită) →
> `noua-lichidare` recalculează `ramas` pe revizia nouă → ciclu nou. Tranziția `completed → lichidare`
> este mecanismul multi-ORD, nu un bug. (Invariant relink v3.9.554.)

### S2 — `alop.mjs:1583` — repair-status: resync BULK (multi-rând, admin)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/admin/repair-status` (admin/org_admin; rate-limited) |
| Selectează | `cancelled_at IS NULL AND status IN ('draft','angajare','ordonantare') AND (org scope)` |
| from → to | `CASE`: dacă `ord_flow_id` are flux `completed` → **plata**; altfel dacă `df_flow_id` are flux `completed` → **lichidare**; altfel neschimbat. Deci `{draft,angajare,ordonantare} → {plata, lichidare}` sau neschimbat |
| Idempotent | DA — re-rularea pe rânduri deja avansate nu le mai prinde (nu mai sunt în `status IN (...)` sau `CASE` = ELSE neschimbat) |
| 0 rânduri | **NO-OP TĂCUT** — întoarce `{ repaired: [] }` 200; loop OPME peste rândurile ajunse la `plata` |
| Tranzacțional | NU — `pool.query` (un singur UPDATE bulk atomic) |
| Audit | **NU** (`logger.info` per OPME confirm) |

> Notă: `org_id` scoped prin `($1::integer IS NULL OR a.org_id=$1)` — admin global → toate org-urile.

### S3 — `alop.mjs:1672` — cancel (ORICE non-completed → cancelled)
| Câmp | Valoare |
|---|---|
| Trigger | `POST /api/alop/:id/cancel` |
| from → to | `draft, angajare, lichidare, ordonantare, plata → cancelled` (**⚠️ `status != 'completed'`**) |
| Precondiție business | Blocat 409 dacă are DF legat (`cancel_blocked_df_exists`) sau ORD legat (`cancel_blocked_ord_exists`) pe documente ne-șterse |
| Gardă WHERE | `id=$1 AND org_id=$2 AND status != 'completed'` |
| 0 rânduri | **EROARE 4xx** — `409 cancel_blocked` („completat sau deja anulat") |
| Tranzacțional | NU — `pool.query` |
| Audit | **NU** |

---

## PAS 4 — Adevărul din bază (staging, read-only)

Rulat pe **staging** (`yamanote.proxy.rlwy.net:29213/railway`, confirmat de owner ca staging).
Doar `SELECT`-uri read-only.

```sql
SELECT status, COUNT(*) FROM alop_instances GROUP BY status ORDER BY 2 DESC;
```
| status | n |
|---|---|
| `ordonantare` | 3 |
| `completed` | 2 |
| `angajare` | 1 |

```sql
SELECT status, COUNT(*) FROM alop_instances WHERE cancelled_at IS NOT NULL GROUP BY status;
```
→ **0 rânduri** (niciun ALOP anulat pe staging).

```sql
SELECT DISTINCT status FROM alop_instances ORDER BY 1;
```
→ `angajare, completed, ordonantare`

**Verdict orfani:** ✅ **ZERO orfani.** Toate cele 3 valori sunt în enum-ul
`{draft, angajare, lichidare, ordonantare, plata, completed, cancelled}`. Un
`CHECK (status IN (...))` la #92 **nu ar pica** pe datele de staging.

> ⚠️ Staging ≠ producție. La #92, verifică ACEEAȘI interogare pe producție ÎNAINTE de a
> adăuga `CHECK` — un singur orfan (dintr-o migrare veche) ar declanșa `markDbFailed()` la boot
> și 503 pe toate rutele DB (incidentul 2026-04-19). **Set canonic pentru `CHECK`:**
> `draft, angajare, lichidare, ordonantare, plata, completed, cancelled`.

---

## PAS 5 — Divergențe față de `VALID_TRANSITIONS` (`alop.mjs:159`)

`VALID_TRANSITIONS` are **zero apelanți** — `canTransition()` (`alop.mjs:168`) nu e chemată
nicăieri în producție; testul `alop-state.test.mjs` își redeclară propria copie (linia 31).

```
draft:       [angajare, cancelled]
angajare:    [lichidare, cancelled]
lichidare:   [ordonantare, cancelled]
ordonantare: [plata, cancelled]
plata:       [completed, cancelled]
completed:   []
cancelled:   []
```

| Tranziție reală (din cod) | Permisă de `VALID_TRANSITIONS`? | Verdict |
|---|---|---|
| `draft → angajare` (A5, A16) | ✅ DA | concordă |
| `angajare → lichidare` (A1, A6, A7, A11, A13, A15) | ✅ DA | concordă |
| `draft → lichidare` (A1, A6, A13, A15 — când DF aprobat direct din draft) | ❌ NU | **CODUL E CORECT — tabela e incompletă** |
| `lichidare → ordonantare` (A8) | ✅ DA | concordă |
| `ordonantare → plata` (A2, A3, A4, A9, A12, A14) | ✅ DA | concordă |
| `plata → completed` (A10) | ✅ DA | concordă |
| `completed → lichidare` (S1 noua-lichidare) | ❌ NU (`completed: []`) | **CODUL E CORECT — tabela e incompletă** (reluare ORD legală, multi-ciclu) |
| `angajare → plata` (S2 repair-status: rând `angajare` cu `ord_flow_id` completat) | ❌ NU | **CODUL E CORECT — tabela e incompletă** (edge de reparare bulk) |
| `{draft,angajare,lichidare,ordonantare,plata} → cancelled` (S3) | ✅ parțial (tabela listează `cancelled` din fiecare stare non-terminală) | concordă (tabela permite cancel din toate stările non-terminale) |
| `ordonantare → ordonantare` (A8 re-confirmare), `angajare → angajare` (A16) | n/a (self-loop idempotent) | tolerat de cod, irelevant pentru tabelă |

**Tranziții „moarte" în `VALID_TRANSITIONS` (permise de tabelă, dar codul nu le execută):**
**NICIUNA.** Toate perechile din tabelă au un sit corespunzător în cod.

> Concluzie #92: tabela reală = tabela `VALID_TRANSITIONS` **+** `draft→lichidare`,
> `completed→lichidare`, `angajare→plata`. Poarta trebuie să le includă, altfel rupe producția.

---

## PAS 6 — Audit (pregătire #92)

`writeAuditEvent` (`server/db/index.mjs:2249`) folosește `pool.query` propriu și **înghite
eroarea** în `catch` (fire-and-forget). O tranziție poate face COMMIT fără urmă de audit.

**Din cele 19 situri Categoria A, doar 1 are audit corespunzător:**

| Sit | Audit? |
|---|---|
| A16 (`formular-shared.mjs:409`) | **DA (parțial)** — `recordFormularAudit 'legat_alop'` (audit de formular, nu `writeAuditEvent` pe ALOP) |
| A1–A15, S1–S3 (toate celelalte 18) | **NU** (doar `logger.info`/`logger.warn`) |

> Implicație #92: nicio tranziție de status ALOP nu scrie `audit_log` dedicat astăzi. Dacă
> poarta unică va emite audit, va fi o **capabilitate nouă** (nu regresie de acoperit).
> **Nu am modificat `writeAuditEvent`** — doar constatare.

---

## RAPORT FINAL

1. **Categoria A = 19, Categoria B = 21** (sumă = 40). ✅
2. **Matricea reală, compactă** (`from → to (n situri)`):
   - `draft → angajare` (2: A5, A16)
   - `draft/angajare → lichidare` (6: A1, A6, A7, A11, A13, A15)
   - `draft → lichidare` — subcaz al celor de mai sus (A1/A6/A13/A15 când se sare `angajare`)
   - `lichidare → ordonantare` (1: A8; +self-loop `ordonantare→ordonantare`)
   - `ordonantare → plata` (6: A2, A3, A4, A9, A12, A14)
   - `plata → completed` (1: A10)
   - `completed → lichidare` (1: S1 — reluare ciclu, intenționat)
   - `{draft,angajare,ordonantare} → {plata,lichidare}` (1 bulk: S2)
   - `≠completed → cancelled` (1: S3)
3. **`0 rânduri`:** NO-OP TĂCUT = **7** (A1, A2, A3, A4, A15, A16, S2) · EROARE 4xx = **6**
   (A5, A7, A8, A9, A10, S3) · NECONTROLAT = **5** (A6, A11, A12, A13, A14) · imposibil (FOR UPDATE) = **1** (S1).
4. **Situri fără nicio gardă de status în `WHERE` SQL (⚠️): 5** — A5 (`link-df`, limitat de `CASE`),
   A11 & A12 (`crud.mjs` edge, țintite pe `*_flow_id`), A13 & A14 (`signing.mjs`, status verificat în app),
   plus S1 (`WHERE id=$1`, status verificat în app + `FOR UPDATE`). *(A5/A11/A12/A13/A14 = cele 5 per-instanță; S1 e caz special.)*
5. **Tranzacțional:** 2 în `BEGIN/COMMIT` (A10 via `confirma-plata`, S1 `noua-lichidare`);
   17 pe `pool.query` liber.
6. **`SELECT DISTINCT status` (staging):** `angajare, completed, ordonantare`. **Zero orfani** —
   un `CHECK` nu ar pica pe staging. (Re-verifică pe **producție** înainte de #92.)
7. **Divergențe:** tabela `VALID_TRANSITIONS` e incompletă — lipsesc `draft→lichidare`,
   `completed→lichidare`, `angajare→plata` (toate `CODUL E CORECT — tabela incompletă`).
   Zero tranziții moarte. (Detaliu în PAS 5.)
8. **Audit:** 1 sit cu audit (A16, parțial `legat_alop`) / 18 fără.
9. **Greșeală reală de comportament găsită?** **NU.** Toate tranzițiile „ciudate"
   (`completed→lichidare`, resync bulk, back-transitions) sunt intenționate și documentate.
   Singura observație (nereparată, doar semnalată): **A11/A12** (`crud.mjs:452/476`) au `WHERE`
   pe `*_flow_id` **fără `org_id`** — vezi *Întrebări pentru Mircea*.
10. `git diff --name-only server/ public/` → **gol** (confirmat la PAS 7).

---

## Întrebări pentru Mircea (NU reparat — doar semnalat)

1. **`crud.mjs:452` & `crud.mjs:476`** fac `UPDATE alop_instances SET status=... WHERE df_flow_id=$1 / ord_flow_id=$1 AND status=...` — **fără `org_id` în `WHERE`**. `flow_id` (UUID) e practic unic global, deci coliziunea cross-org e improbabilă, dar toate celelalte scrieri ALOP includ `org_id`. Intenționat (țintit pe pointer unic) sau de aliniat la #92? *Nu am schimbat nimic.*
2. **A13/A14 (`signing.mjs`, NO-TOUCH)** au gardă de status doar în app (`if (['draft','angajare']...)`), nu în `WHERE` SQL (`WHERE id=$1`). La #92, poarta unică ar muta garda în SQL — dar fișierul e NO-TOUCH. Confirmă abordarea pentru zona de semnare înainte de #92.
