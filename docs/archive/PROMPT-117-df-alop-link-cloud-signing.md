---
model_suggested: Opus 4.8   # atinge calea de semnare cloud + legătura DF↔ALOP (risc ridicat)
target_branch: develop
version_bump: 3.9.745 → 3.9.746
cache_bump: NU (backend-only)
qv_bump: NU (niciun asset frontend atins)
---

═══════════════════════════════════════════════════════════════════
⚠️  AVERTISMENT BRANCH
═══════════════════════════════════════════════════════════════════
ȚINTĂ: branch `develop` EXCLUSIV.
NU face checkout/merge/push pe `main`. `main` = PRODUCȚIE, gestionat MANUAL de Mircea.
La final: commit pe `develop` + `git push origin develop`.
═══════════════════════════════════════════════════════════════════

# PROMPT #117 — DF↔ALOP: legătura se pierde pe calea de semnare CLOUD

## CONTEXT — incident real în producție (04.08.2026)

ALOP `e3132d97` („Servicii furnizare Gaze Naturale (Engie)", ORD 42116) a ajuns
„**Fără DF**" deși DF-ul 417 există, are R0 aprobat și R1 pe flux. Trasabilitatea
DF-ului răspunde „Nicio ALOP creată încă". `alop.df_id` = NULL.

Cronologie reconstituită din date (4 rânduri `formulare_df` cu `nr_unic_inreg=417`):

| DF | Rev | status | flow_id | deleted_at |
|---|---|---|---|---|
| `8b508b0e` | R0 | **completed** | PZ_99665BE3BF | — |
| `8a02bd68` | R1 | draft | — | **31.07 13:14:39** |
| `b6a37d5f` | R1 | completed | PZ_746BB0A77F | — |

1. 31.07 **13:14:39** — s-a șters revizia R1 draft. A rulat
   `relinkAlopOnDfDelete` (`server/services/formular-shared.mjs:638`): fiind R1
   cu `parent_df_id`, trebuia să restaureze părintele R0 pe ALOP. Verificarea e
   `parentRows[0].status === 'aprobat'`, dar R0 are `status='completed'` ⇒
   condiția pică ⇒ ramura `else` ⇒ **`df_id = NULL`**.
   (`alop_instances.updated_at` = exact 13:14:39 — proba.)
2. 31.07 **13:15:09** — s-a creat noua R1. `/revizuieste`
   (`routes/formulare/df.mjs:612`) face `UPDATE ... WHERE df_id=$2`; `df_id`
   era deja NULL ⇒ **0 rânduri, în tăcere**.

## CAUZA-MAMĂ (de reparat, altfel se repetă)

`formulare_df.status='aprobat'` se scrie într-un **SINGUR** loc:
`routes/flows/signing.mjs:440` (calea `upload-signed-pdf`).

Calea de semnare **CLOUD (STS)** — `routes/flows/cloud-signing.mjs`, ambele
puncte `allDone` (~537 poll și ~841 callback) — marchează doar `data.completed`
și **NU**:
- setează `formulare_df.status='aprobat'`;
- apelează `selfHealAlopDfLink` (`services/alop-link.mjs`).

Instituția semnează prin STS Cloud ⇒ pe fluxurile REALE `status` rămâne
`completed`, orice comparație `status === 'aprobat'` decide greșit, iar
self-heal-ul DF→ALOP **nu se declanșează niciodată**. Câmpul `aprobat` calculat
la citire (`df.mjs:85,139,200,477`: `flow_id IS NOT NULL AND flux completed`)
arată corect „✓" — de-aia divergența e invizibilă în UI.

⚠️ NU confunda: `server/signing/**` = zonă NO-TOUCH (PAdES).
`server/routes/flows/cloud-signing.mjs` e ALT fișier și E editabil — dar e o
suprafață de semnare, deci chirurgie minimă, fără refactor.

═══════════════════════════════════════════════════════════════════
PAS 0 — CITEȘTE ÎNTÂI (fără modificări)
═══════════════════════════════════════════════════════════════════
- `server/routes/flows/signing.mjs` (~429-450: blocul `allDone` de referință; ~176-200: restore la refuz)
- `server/routes/flows/cloud-signing.mjs` (~528-552 poll; ~828-856 callback)
- `server/services/alop-link.mjs` (integral — `selfHealAlopDfLink`)
- `server/services/formular-shared.mjs` (~635-671: `relinkAlopOnDfDelete`)
- `server/routes/formulare/df.mjs` (~466-630: `/revizuieste`, în special UPDATE-ul de la ~612)
⛔ NU modifica nimic în `server/signing/**`.

═══════════════════════════════════════════════════════════════════
PAS 1 — Helper partajat: marchează DF aprobat + self-heal
═══════════════════════════════════════════════════════════════════
În `server/services/alop-link.mjs`, ADAUGĂ o funcție exportată nouă (păstrează
`selfHealAlopDfLink` neschimbată):

```js
/**
 * finalizeDfOnFlowCompleted — pașii care TREBUIE să ruleze la finalizarea ORICĂRUI
 * flux de semnare DF, indiferent de calea de semnare (upload manual / STS poll /
 * STS callback). Înainte de v3.9.746 existau DOAR pe calea `upload-signed-pdf`,
 * deci fluxurile semnate prin cloud lăsau `formulare_df.status='completed'` și nu
 * declanșau niciodată self-heal-ul legăturii DF↔ALOP.
 * Idempotentă și non-fatală (nu propagă erori — semnarea nu trebuie să pice din cauza asta).
 */
export async function finalizeDfOnFlowCompleted(pool, flowId) {
  if (!pool || !flowId) return;
  try {
    await pool.query(
      `UPDATE formulare_df SET status='aprobat', updated_at=NOW()
        WHERE flow_id=$1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'aprobat'`,
      [flowId]
    );
  } catch (e) {
    logger.error({ err: e, flowId }, 'finalizeDfOnFlowCompleted: marcare aprobat esuata (non-fatal)');
  }
  try {
    await selfHealAlopDfLink(pool, flowId);
  } catch (e) {
    logger.error({ err: e, flowId }, 'finalizeDfOnFlowCompleted: self-heal esuat (non-fatal)');
  }
}
```

⚠️ Gardă `status IS DISTINCT FROM 'aprobat'` = idempotență (re-apelarea nu mai
scrie). Fluxurile ORD nu sunt afectate: `WHERE flow_id=$1` pe `formulare_df` nu
potrivește nimic pentru un flux de ORD.

# Verificare PAS 1:
node --check server/services/alop-link.mjs
grep -n "export async function" server/services/alop-link.mjs
# Așteptat: selfHealAlopDfLink + finalizeDfOnFlowCompleted

═══════════════════════════════════════════════════════════════════
PAS 2 — Cablează helperul pe calea CLOUD (ambele puncte allDone)
═══════════════════════════════════════════════════════════════════
În `server/routes/flows/cloud-signing.mjs`:

(a) adaugă importul lângă celelalte importuri de servicii:
```js
import { finalizeDfOnFlowCompleted } from '../../services/alop-link.mjs';
```

(b) SITUL POLL (~545): imediat DUPĂ `await saveFlow(flowId, data);` și ÎNAINTE de
`res.json({ status: 'signed', completed: allDone, flowId });` inserează:
```js
    if (allDone) await finalizeDfOnFlowCompleted(pool, flowId);
```

(c) SITUL CALLBACK (~845): imediat DUPĂ `await saveFlow(flowId, data);` și ÎNAINTE
de `writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'SIGNED_PDF_UPLOADED',`
inserează aceeași linie:
```js
    if (allDone) await finalizeDfOnFlowCompleted(pool, flowId);
```

⛔ NU muta, NU rescrie și NU „unifica" restul logicii din cele două handlere.
⛔ NU atinge blocul de notificări din `setImmediate`.
⛔ NU adăuga tranziții ALOP aici — auto-tranziția lazy din `alop.mjs` le acoperă.
Dacă `old_str` nu se potrivește exact, CITEȘTE fișierul și adaptează ancora —
nu ghici.

# Verificare PAS 2:
node --check server/routes/flows/cloud-signing.mjs
grep -n "finalizeDfOnFlowCompleted" server/routes/flows/cloud-signing.mjs
# Așteptat: 3 rezultate (1 import + 2 apeluri)
git diff --stat server/signing/
# Așteptat: GOL (zona NO-TOUCH neatinsă)

═══════════════════════════════════════════════════════════════════
PAS 3 — Elimină verificarea fantomă `status === 'aprobat'` (2 situri)
═══════════════════════════════════════════════════════════════════
Ambele locuri decid pe coloana STOCATĂ, care pe calea cloud nu ajunge niciodată
`aprobat`. Trec pe condiția DERIVATĂ (canonică în proiect), acceptând ambele.

(a) `server/services/formular-shared.mjs` ~648 (`relinkAlopOnDfDelete`) — ACESTA
    e cel periculos: ramura `else` golește `df_id`. Înlocuiește SELECT-ul:
```sql
        SELECT fd.id, fd.flow_id, fd.status,
               (fd.flow_id IS NOT NULL
                AND f.deleted_at IS NULL
                AND f.data->>'status' IS DISTINCT FROM 'cancelled'
                AND f.data->>'status' IS DISTINCT FROM 'refused'
                AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
               ) AS aprobat
          FROM formulare_df fd
          LEFT JOIN flows f ON f.id = fd.flow_id
         WHERE fd.id=$1 AND fd.deleted_at IS NULL LIMIT 1
```
    și condiția:
```js
      if (parentRows.length && parentRows[0].flow_id
          && (parentRows[0].aprobat === true || parentRows[0].status === 'aprobat')) {
```

(b) `server/routes/flows/signing.mjs` ~177-181 (restore la REFUZ R1+) — aceeași
    înlocuire de SELECT + condiție. (Aici ramura `else` păstrează `df_id`, deci
    e mai puțin gravă, dar tot decide greșit: nu restaurează părintele.)

⚠️ `IS DISTINCT FROM` obligatoriu (NULL-safe), niciodată `<>` — regula fixată la #115.
⚠️ Excluderea `refused`/`cancelled`/soft-delete: un flux mort NU face părintele aprobat.

# Verificare PAS 3:
grep -rn "status === 'aprobat'" server/ --include=*.mjs | grep -v tests
# Așteptat: 0 rezultate

═══════════════════════════════════════════════════════════════════
PAS 4 — `/revizuieste`: fallback pe `source_alop_id` + log la 0 rânduri
═══════════════════════════════════════════════════════════════════
În `server/routes/formulare/df.mjs`, UPDATE-ul de relink (~612) e singura cale
prin care revizia nouă ajunge pe ALOP, iar când `df_id` e deja rupt nu potrivește
nimic și TACE. Înlocuiește apelul cu:

```js
      // Actualizează linkul ALOP → df_id la noua revizie
      const { rowCount: relinkCount } = await client.query(
        `UPDATE alop_instances SET df_id=$1, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$3
         WHERE df_id=$2 AND cancelled_at IS NULL`,
        [nou.id, req.params.id, actor.userId]
      );
      // Fallback: legătura era deja ruptă (df_id NULL după ștergerea unei revizii
      // sau după un refuz) — reataşează prin proveniență, ca self-heal-ul.
      let relinkFallback = 0;
      if (relinkCount === 0 && nou.source_alop_id) {
        const { rowCount } = await client.query(
          `UPDATE alop_instances SET df_id=$1, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$3
            WHERE id=$2 AND df_id IS NULL AND cancelled_at IS NULL`,
          [nou.id, nou.source_alop_id, actor.userId]
        );
        relinkFallback = rowCount;
        if (rowCount === 0) {
          logger.warn({ dfNou: nou.id, parent: req.params.id, sourceAlopId: nou.source_alop_id },
            'revizuieste: ALOP nerelegat (df_id ocupat de alt document sau ALOP anulat)');
        }
      }
```
și adaugă `relinkCount, relinkFallback` în `logger.info(...)` de la ~626.

⚠️ Garda `df_id IS NULL` din fallback e esențială: NU fura ALOP-ul dacă între timp
a fost legat de alt document.

# Verificare PAS 4:
node --check server/routes/formulare/df.mjs
grep -n "relinkFallback" server/routes/formulare/df.mjs
# Așteptat: 3 rezultate

═══════════════════════════════════════════════════════════════════
PAS 5 — Teste
═══════════════════════════════════════════════════════════════════
Test DB nou `server/tests/db/df-alop-link-resilienta.test.mjs` (PG 17 efemer,
`hasTestDb()`/`describe.skipIf` ca restul din `tests/db/`). Cazuri:

1. **Reproducerea incidentului**: ALOP + DF R0 cu `flow_id` pe un flux COMPLETAT
   dar `status='completed'` (NU `'aprobat'` — exact starea produsă de calea cloud)
   + R1 draft. Șterge R1 → **ALOP păstrează `df_id` = R0** (înainte de fix devenea NULL).
2. **`/revizuieste` cu legătură ruptă**: ALOP cu `df_id=NULL`, DF R0 cu
   `source_alop_id` = ALOP-ul → creează revizia → ALOP relegat pe revizia nouă
   prin fallback.
3. **Fallback NU fură**: același scenariu, dar ALOP-ul are deja `df_id` = alt
   document → fallback-ul NU-l modifică (`rowCount=0`, warn logat).
4. **`finalizeDfOnFlowCompleted`**: DF cu `status='completed'` pe flux completat +
   `source_alop_id` către un ALOP cu `df_id=NULL` → după apel: `status='aprobat'`
   ȘI ALOP relegat. Re-apel = idempotent (fără schimbări).
5. **Flux mort nu aprobă părintele** (regresie #115): părinte cu flux `refused`
   → ștergerea R1 NU restaurează părintele ca aprobat.

6. **REGRESIE AFIȘARE (obligatoriu)**: un DF semnat pe calea cloud, ÎNAINTE
   (`status='completed'`) și DUPĂ (`status='aprobat'`) — pe flux FINALIZAT —
   trebuie să producă **ACELAȘI** `badge_status` și să apară în **ACELEAȘI**
   filtre (`transmis_flux` / `aprobat` / `completed`). Logica din
   `shared.mjs:446-460` acceptă deja ambele (`_dfAprobat OR fd.status='aprobat'`),
   iar `_dfTransmis` cere flux NEfinalizat ⇒ diferența trebuie să fie ZERO.
   Extinde matricea parametrizată existentă din
   `server/tests/db/formulare-status-display.test.mjs` — NU crea alt fișier.
7. **BLOCARE INTENȚIONATĂ**: PUT pe un DF cu `status='aprobat'` întoarce
   **409 `document_locked`** (`df.mjs:346` → ramura else-if), NU îl resetează la
   draft. Comportament DORIT: un document semnat QES nu se readuce în draft
   tăcut — calea corectă e `/revizuieste`.

⚠️ NOTĂ DE COMPORTAMENT (nu bug — de raportat explicit în RAPORT FINAL):
`status='aprobat'` NU e o stare nouă — calea `upload-signed-pdf` o scrie deja,
deci toți consumatorii o gestionează. Fixul doar aliniază calea cloud. Efecte
secundare cunoscute și ACCEPTATE: (1) cazul 7 de mai sus; (2) un DF semnat nu
mai poate fi retrimis pe un flux nou (`formular-shared.mjs:564` cere
`status='completed'`) — reviziile nu sunt afectate (R1 pornește `draft`).

⛔ Testele IMPORTĂ din producție — nu redeclara logica (regula fixată în sprint).

# Verificare PAS 5:
npm test
# Așteptat: verde, fără regresii
npm run test:db
# Așteptat: verde, PASSED (nu SKIPPED), inclusiv noul fișier

═══════════════════════════════════════════════════════════════════
PAS 6 — Bump versiune
═══════════════════════════════════════════════════════════════════
`package.json`: 3.9.745 → 3.9.746. NU atinge `sw.js`. NU rula sed pe `?v=`.

═══════════════════════════════════════════════════════════════════
RAPORT FINAL (obligatoriu)
═══════════════════════════════════════════════════════════════════
- Fișiere/funcții atinse + confirmarea `git diff --stat server/signing/` GOL.
- `grep "status === 'aprobat'"` = 0 rezultate în producție.
- Ieșirea `npm test` și `npm run test:db` (PASSED, nu SKIPPED).
- Cele 5 cazuri noi + rezultatele.
- Hash commit + confirmarea `git push origin develop`.
- ⚠️ Reamintire: ALOP-urile deja rupte NU se auto-repară — reparație SQL separată (Mircea).

═══════════════════════════════════════════════════════════════════
⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════
⛔ NU atinge NICIUN fișier din `server/signing/**` (NO-TOUCH: PAdES/STS).
⛔ NU refactoriza `cloud-signing.mjs` — doar import + 2 linii.
⛔ NU modifica `selfHealAlopDfLink` (invariantul „se aplică și ALOP-urilor completed" rămâne).
⛔ NU adăuga migrații — acest prompt nu are nevoie.
⛔ NU face checkout/merge/push pe `main`. Push DOAR pe `origin develop`.
⛔ Fără `.only`/`.skip` uitate, fără `console.log` de debug.

PAS FINAL: `git add -A && git commit -m "fix(df-alop): finalizare DF + self-heal si pe calea de semnare cloud; relink robust la stergere revizie v3.9.746" && git push origin develop`
