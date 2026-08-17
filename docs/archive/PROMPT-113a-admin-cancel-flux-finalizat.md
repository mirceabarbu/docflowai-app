---
task: "#113a — admin-cancel pentru fluxuri FINALIZATE (backend + matrice ALOP + teste)"
branch: develop
model_suggested: Opus 4.8   # ALOP + mașină de stări + migrație pe trigger de producție
target_version: v3.9.741
migrations: DA — inline `103_alop_matrix_admin_cancel` (următoarea după 102)
cache_version_bump: NO   # #113a e doar backend; UI vine în #113b
---

# ⚠️ BRANCH: develop

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE
```
git branch --show-current      # Așteptat: develop
git fetch origin && git status
```

===============================================================================
## CONTEXT
===============================================================================

Un flux de semnare FINALIZAT nu poate fi desfăcut: `POST /flows/:flowId/cancel`
(`lifecycle.mjs:496`) are `if (data.completed) return 409 already_completed`, iar
„noua lichidare" cere `alop.status='completed'` (plată efectuată). Deliberat — fluxul
poartă un document semnat QES.

Pe 23.07 a fost nevoie de o reparație manuală în producție (ORD semnat doar de
inițiator, ajuns aprobat, neconform). A funcționat, dar a cerut recon + script +
backup. **#113a transformă asta într-o operație suportată, cu motiv și audit.**

⚠️ **DE CE E URGENT:** poarta ALOP (migrația 094) e azi în mod observare
(`RAISE WARNING` + log, apoi `RETURN NEW`). Este planificat flipul spre
`RAISE EXCEPTION`. Matricea e STRICT ÎNAINTE:

```
draft→[angajare,lichidare,cancelled] · angajare→[lichidare,plata,cancelled]
lichidare→[ordonantare,cancelled]   · ordonantare→[plata,cancelled]
plata→[completed,cancelled]         · completed→[lichidare] · cancelled→[]
```

Deci `plata → ordonantare` (tranziția de care are nevoie admin-cancel pe ORD) e azi
o VIOLARE tolerată. După flip ar fi RESPINSĂ ⇒ funcția s-ar rupe. De aceea #113a
adaugă tranziția în matrice, ca să fie legitimă înainte de flip.

===============================================================================
## PASUL 1 — Migrația 103: extinde matricea
===============================================================================

Verifică întâi ultimul id (⚠️ NU presupune — la #TMPL-ORG am cerut greșit 100 când
100/101 erau ocupate):
```
grep -n "id: '1[0-9][0-9]_" server/db/index.mjs
# Așteptat: 100_chat, 101_module_chat, 102_templates_org_invariant ⇒ următorul liber = 103
```

Adaugă un obiect NOU după `102_templates_org_invariant`, care face `CREATE OR REPLACE`
pe funcția `alop_status_guard()` — ⛔ NU recrea trigger-ul, doar funcția — cu matricea
extinsă cu **o singură** tranziție:

```
WHEN 'plata' THEN ARRAY['completed','cancelled','ordonantare']
```

⛔ NU adăuga alte tranziții „ca să fie". Fiecare adăugire slăbește poarta.
Comentariul migrației trebuie să spună explicit: `plata → ordonantare` e permisă
EXCLUSIV pentru admin-cancel pe ORD (undo administrativ al unui flux finalizat), iar
trigger-ul de audit (`trg_alop_status_audit`, migrația 093) continuă să înregistreze
tranziția — deci rămâne trasabilă chiar dacă nu mai e marcată `violation`.

Restul corpului funcției se păstrează IDENTIC (`RAISE WARNING` + INSERT violation +
`RETURN NEW`) — ⛔ acest prompt NU face flipul spre `EXCEPTION`.

Actualizează și `docs/audits/ALOP-STATE-MATRIX.md` (convenția proiectului: codul e
specificația, dar documentul trebuie să rămână sincron).

===============================================================================
## PASUL 2 — Helper nou: `server/services/flow-undo.mjs`
===============================================================================

Fișier NOU. Exportă `undoCompletedFlowLinks(client, flowId)` care, **pe un client de
tranzacție primit ca parametru** (nu pe `pool` — apelantul deține tranzacția):

1. DF: `UPDATE formulare_df SET status='completed' WHERE flow_id=$1 AND status='transmis_flux'`
   → dacă a întors rânduri: `UPDATE alop_instances SET df_flow_id=NULL, df_completed_at=NULL WHERE df_id=$1 AND cancelled_at IS NULL`
2. ORD: `SELECT id FROM formulare_ord WHERE flow_id=$1` → dacă există:
   - `UPDATE formulare_ord SET flow_id=NULL WHERE id=$1`
   - `UPDATE alop_instances SET ord_flow_id=NULL, ord_completed_at=NULL, status = CASE WHEN status='plata' THEN 'ordonantare' ELSE status END WHERE ord_id=$1 AND cancelled_at IS NULL`
3. Întoarce `{ dfId|null, ordId|null, alopId|null, statusChanged:boolean }` pentru audit.

⚠️ **DIFERENȚA CRITICĂ față de `cancel`-ul normal, de documentat în docblock:**
`lifecycle.mjs:543` lasă intenționat `formulare_ord.flow_id` pe loc, pentru că
self-heal-ul din `alop.mjs` sare peste fluxurile `'cancelled'`. **Aici NU e suficient.**
`ord_aprobat` (`alop.mjs:655`) se calculează ca:
```sql
COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL
AND (f2.data->>'status'='completed' OR (f2.data->>'completed')::boolean = true)
```
Pe un flux FINALIZAT, `completed:true` rămâne în JSONB chiar după `status='cancelled'`,
iar `ord_aprobat` NU verifică `deleted_at`. Dacă `formulare_ord.flow_id` rămâne setat,
auto-tranziția lazy (`alop.mjs:901`) împinge ALOP-ul înapoi la `plata` la prima
deschidere — și `needsResync` chiar repopulează `ord_flow_id`. Deci **ambele pointere
trebuie golite**. (Verificat empiric la reparația manuală din 23.07.)

⛔ NU modifica handlerul `cancel` existent în acest prompt. Duplicarea e conștientă și
temporară: notează în docblock că migrarea lui `cancel` pe acest helper e un pas
ULTERIOR, cu teste proprii — nu o strecura într-un prompt de feature.

===============================================================================
## PASUL 3 — Ruta `POST /flows/:flowId/admin-cancel`
===============================================================================

În `server/routes/flows/lifecycle.mjs`, DUPĂ handlerul `cancel` existent.

Gărzi, în ordine (toate ÎNAINTE de orice scriere):
1. `requireAuth` + `isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId)`
   → altfel `403 forbidden`. ⛔ NU inițiatorul: e o operație administrativă.
2. `reason` obligatoriu, minim 10 caractere după trim → altfel `400 reason_required`.
   (Motivul e singura urmă a raționamentului uman; un „ok" nu ajută pe nimeni peste un an.)
3. `if (!data.completed) return 409 not_completed` — pentru fluxuri în derulare există
   `cancel`-ul normal. ⛔ NU slăbi garda `already_completed` de pe ruta `cancel`.
4. `if (data.status === 'cancelled') return 409 already_cancelled`.
5. **Gardă financiară** — dacă fluxul e legat de un ORD, încarcă ALOP-ul și refuză cu
   `409 payment_confirmed` dacă `plata_confirmed_at IS NOT NULL`
   OR `COALESCE(plata_suma_efectiva,0) > 0` OR `COALESCE(suma_totala_platita,0) > 0`.
   Motiv: acolo nu mai e curățare de dată eronată, ci corecție financiară — se face prin
   ciclu nou („noua lichidare"), nu prin rescrierea istoricului.
6. Dacă există cicluri în `alop_ord_cicluri` pentru acel ALOP → `409 has_archived_cycles`.

Efect, într-o **singură tranzacție** (`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`,
model `noua-lichidare` din `alop.mjs:1565`):
- `data.status='cancelled'`, `data.cancelledAt/By`, `data.cancelReason=reason`,
  `data.adminCancelled=true`; push eveniment `FLOW_ADMIN_CANCELLED` în `data.events`; `saveFlow`
- `UPDATE flows SET deleted_at=NOW(), deleted_by=$actor WHERE id=$1` (soft-delete —
  documentul semnat NU se distruge, doar se deconectează)
- `await undoCompletedFlowLinks(client, flowId)`
- `writeAuditEvent({ eventType:'FLOW_ADMIN_CANCELLED', payload:{ reason, dfId, ordId, alopId } })`
  + `recordFormularAudit` pe DF/ORD-ul afectat

⚠️ Eticheta RO pentru `FLOW_ADMIN_CANCELLED` trebuie adăugată în AMBELE dicționare
(`public/js/admin/activity.js` `OP_LABELS_RO` ȘI `public/js/admin/audit.js`
`AUDIT_EVENT_LABELS`) — există un test `audit-labels-sync` care pică altfel. Ambele
fișiere sunt în `PRECACHE_ASSETS` ⇒ **dacă le atingi, CACHE_VERSION TREBUIE bumpat**
(citește valoarea din `public/sw.js`, nu o presupune) + `?v=` țintit.

===============================================================================
## PASUL 4 — Teste
===============================================================================

### 4a. DB — `server/tests/db/admin-cancel-flow.test.mjs` (PG real)
1. org_admin same-org, flux ORD finalizat, motiv valid → 200; verifică în bază:
   `formulare_ord.flow_id` NULL, `alop.ord_flow_id`/`ord_completed_at` NULL,
   `alop.status='ordonantare'`, `flows.deleted_at` nenul.
2. **Non-regresie a capcanei**: după admin-cancel, simulează citirea ALOP-ului
   (aceeași interogare care calculează `ord_aprobat`) și asertează `ord_aprobat=false`
   ⇒ auto-tranziția lazy NU se mai poate declanșa. ← cazul cel mai important.
3. `plata_confirmed_at` setat → `409 payment_confirmed`, zero scrieri.
4. cicluri arhivate prezente → `409 has_archived_cycles`.
5. flux NEfinalizat → `409 not_completed`.
6. `reason` lipsă / sub 10 caractere → `400 reason_required`.
7. utilizator simplu → 403; org_admin din ALTĂ org → 403.
8. flux DF (nu ORD) → DF revine la `completed`, `df_flow_id` NULL.
9. Idempotență: al doilea apel → `409 already_cancelled`.

### 4b. Migrație — extinde testul existent de matrice dacă există, altfel unul nou:
`plata → ordonantare` NU mai scrie `violation=TRUE` în `alop_status_log`;
`plata → draft` (tranziție inventată) încă o scrie.

===============================================================================
## PASUL 5 — Porți
===============================================================================
```
npm test            # baseline la intrare: 108 fișiere / 1396 teste
npm run test:db     # OBLIGATORIU — baseline 76 fișiere / 504
```
⛔ „Docker absent" NU e motiv de skip: PG 17 efemer, port 55432, rețeta din CLAUDE.md.
**Rulează migrațiile de DOUĂ ori** pe aceeași bază și confirmă că a doua e no-op.

===============================================================================
## PASUL 6 — Commit + PUSH
===============================================================================
```
git add -A && git status   # verifică lista înainte de commit
git commit -m "feat(flows): admin-cancel pentru fluxuri finalizate + matrice ALOP plata→ordonantare (migrația 103) — v3.9.741"
git push origin develop
```

===============================================================================
## RAPORT FINAL
===============================================================================
- Commit + versiune. `npm test` / `test:db` reale (dacă test:db n-a rulat, spune-o).
- Ce id de migrație ai folosit și de ce (confirmă că ai listat ID-urile existente).
- Rezultatul rulării DUBLE a migrațiilor.
- Ai atins `activity.js`/`audit.js`? Dacă da: valoarea CACHE_VERSION înainte și după.
- Confirmă: handlerul `cancel` existent NEATINS; garda `already_completed` intactă.
- Orice abatere + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI
===============================================================================
- ⛔ BRANCH develop; PASUL 0 obligatoriu.
- ⛔ NU face flipul porții ALOP spre `RAISE EXCEPTION` (prompt separat, după 7 zile curate).
- ⛔ NU adăuga în matrice alte tranziții decât `plata → ordonantare`.
- ⛔ NU modifica handlerul `cancel` existent, nici garda lui `already_completed`.
- ⛔ NU șterge fizic fluxul — soft-delete; documentul semnat QES se păstrează.
- ⛔ NO-TOUCH: `server/signing/*`.
- ⛔ `git push origin develop`. Pe `main` niciodată.
