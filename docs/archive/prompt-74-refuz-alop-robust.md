---
prompt: 74
titlu: "fix(state-machine): refuz flux DF → neaprobat + ALOP „DF în lucru" (rezolvare ROBUSTĂ prin df_flow_id) + audit — B2"
model_suggested: Opus 4.8
branch: develop
zona: ⚠️ PRODUCȚIE · mașină de stări ALOP · handler refuz
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`. `main` = producție, manual.

---

# ⚠️ SUPRAFAȚĂ CRITICĂ (producție + ALOP)
> Se atinge DOAR handler-ul de refuz din `signing.mjs`. NU atinge: notificările/webhook-ul de refuz (liniile ~96-116), semnarea, STS/PAdES, alte endpoint-uri. Wrapping-ul non-fatal se păstrează.

---

## Bug (owner, producție)
DF „Servicii IT" (2469, R0) refuzat în flux: statusul DF a devenit corect (dar prin split-path a rămas `completed`), însă **ALOP a rămas „Pe flux — semnare"** — starea nu s-a reactualizat.

## Root cause (confirmat)
Handler-ul de refuz (`signing.mjs:118-183`) rezolvă DF-ul/ALOP-ul **prin `formulare_df`**, condiționat pe `flow_id=$1 AND status='transmis_flux'`. Pentru DF-uri lansate pe calea ALOP (split-path: `status='completed'`, `fd.flow_id` NULL), condiția nu prinde → blocul de eliberare ALOP **nu rulează** → `alop.df_flow_id` rămâne pe fluxul mort. Singurul pointer sigur e `alop_instances.df_flow_id = flowId`.

## Comportament țintă (B2 — confirmat de owner)
- Rezolvare **robustă** a DF-ului: prin `fd.flow_id=$1` **SAU** prin `alop.df_flow_id=$1`.
- DF refuzat → **`neaprobat`** (păstrează trasabilitatea vizibilă: badge „❌ Neaprobat", mesajul „DF neaprobat de semnatar", butonul „Revizuiește DF (neaprobat)").
- **R0 refuzat: `df_id` RĂMÂNE** legat (păstrezi munca + atașamentele), se curăță doar `df_flow_id` + `df_completed_at` → ALOP „DF în lucru".
- **R1+ refuzat: restore la revizia anterioară APROBATĂ** (comportament existent, păstrat), acum robust.
- **Audit**: eveniment `neaprobat` pe DF (trasabilitate în stare ȘI în log).

## Fix — `server/routes/flows/signing.mjs`

### 1. Import (sus, lângă celelalte importuri)
```js
import { recordFormularAudit } from '../../db/queries/formulare-audit.mjs';
```
(Verifică calea relativă corectă față de `signing.mjs`.)

### 2. Înlocuiește TOT blocul de refuz-DF+ALOP (de la comentariul „FIX state machine: marchează DF ca neaprobat…" până la finalul `catch (alopRestoreErr)`, ~liniile 118-183) cu:
```js
    // ── Refuz: DF → neaprobat + ALOP actualizat, ROBUST prin pointerul df_flow_id ──
    // Acoperă split-path (DF lansat pe calea ALOP: status='completed', fd.flow_id NULL).
    try {
      const { rows: dfRows } = await pool.query(
        `SELECT id, revizie_nr, parent_df_id, status
           FROM formulare_df
          WHERE deleted_at IS NULL
            AND ( flow_id = $1
                  OR id = (SELECT df_id FROM alop_instances WHERE df_flow_id = $1 AND cancelled_at IS NULL LIMIT 1) )
          ORDER BY (flow_id = $1) DESC
          LIMIT 1`,
        [flowId]
      );
      if (dfRows.length) {
        const refDf = dfRows[0];
        const fromStatus = refDf.status;
        // DF → neaprobat (doar dintr-o stare pre-aprobare)
        await pool.query(
          `UPDATE formulare_df SET status='neaprobat', updated_at=NOW()
           WHERE id=$1 AND status IN ('transmis_flux','completed')`,
          [refDf.id]
        );
        // Audit (trasabilitate refuz)
        try {
          await recordFormularAudit({
            orgId: data.orgId, formType: 'df', formId: refDf.id,
            actorEmail: (signers[idx]?.email || null),
            eventType: 'neaprobat', fromStatus, toStatus: 'neaprobat',
            meta: { flowId, via: 'flux_refuzat' },
          });
        } catch (_) { /* non-fatal */ }

        if ((refDf.revizie_nr || 0) === 0 || !refDf.parent_df_id) {
          // R0 (B2): PĂSTREAZĂ df_id, curăță doar fluxul → ALOP „DF în lucru / neaprobat"
          await pool.query(
            `UPDATE alop_instances SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
             WHERE df_id=$1 AND cancelled_at IS NULL`,
            [refDf.id]
          );
          logger.info({ dfId: refDf.id, flowId }, '[ALOP] DF R0 refuzat → neaprobat, ALOP „DF în lucru" (df_id păstrat)');
        } else {
          // R1+: restore la parent APROBAT (existent)
          const { rows: parentRows } = await pool.query(
            `SELECT id, flow_id, status FROM formulare_df WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
            [refDf.parent_df_id]
          );
          if (parentRows.length && parentRows[0].status === 'aprobat' && parentRows[0].flow_id) {
            const parent = parentRows[0];
            await pool.query(
              `UPDATE alop_instances SET df_id=$1, df_flow_id=$2, df_completed_at=NOW(), updated_at=NOW()
               WHERE df_id=$3 AND cancelled_at IS NULL`,
              [parent.id, parent.flow_id, refDf.id]
            );
            logger.info({ refDfId: refDf.id, parentId: parent.id, flowId }, `[ALOP] R${refDf.revizie_nr} refuzat → restore la parent aprobat`);
          } else {
            // Fără parent aprobat: păstrează df_id (neaprobat), curăță fluxul
            await pool.query(
              `UPDATE alop_instances SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
               WHERE df_id=$1 AND cancelled_at IS NULL`,
              [refDf.id]
            );
            logger.warn({ refDfId: refDf.id, flowId }, `[ALOP] R${refDf.revizie_nr} refuzat, parent neaprobat → neaprobat, ALOP „DF în lucru"`);
          }
        }
      }
    } catch (alopRefuseErr) {
      logger.error({ err: alopRefuseErr, flowId }, '[ALOP] procesare refuz DF eșuată (non-fatal)');
    }
```
**Verifică:** variabila care ține semnatarul care a refuzat (în cod e `signers[idx]` la linia ~96) — folosește `.email` de acolo pentru `actorEmail`; dacă numele variabilei diferă, adaptează.

## Ce NU atingem
- ⛔ Notificările/webhook de refuz (96-116), semnarea, `att-preview`, STS/PAdES, alte fișiere.
- ⛔ NU schimbi calea ORD (dacă există bug analog la ORD, îl tratăm separat — semnalează dar nu-l atinge).

## Test (anti-regresie, DB)
Adaugă `server/tests/db/refuz-alop-robust.test.mjs`:
1. **R0 split-path** (DF `completed`, `fd.flow_id` NULL, ALOP cu `df_flow_id=flow`) → refuz → DF `neaprobat`, `alop.df_flow_id` NULL, `df_id` **păstrat**, audit `neaprobat` scris.
2. **R0 normal** (DF `transmis_flux`, `fd.flow_id=flow`) → refuz → identic (neaprobat, df_id păstrat, flux curățat).
3. **R1 cu parent aprobat** → refuz → ALOP restore la parent (df_id=parent, df_flow_id=parent.flow_id).
`npm test verde, fără regresii`. `npm run check` OK.

## Guardrails diff
EXCLUSIV: `server/routes/flows/signing.mjs`, testul nou, `package.json`.
```bash
git diff server/routes/flows/signing.mjs | grep -iE "_notify|_fireWebhook|signers\[idx\].status = 'refused'" && echo "⚠️ verifică: notificările/marcarea refuzului NU trebuie schimbate (doar blocul DF/ALOP)" || echo "✅ doar blocul DF/ALOP"
```

## Cache busting + versiune
Doar server + test ⇒ fără `sw.js`/`?v=`. Bump `package.json` următorul patch.

## Verificare (owner, staging) — producție-adjacent
- DF R0 pe flux → refuz → **ALOP nu mai arată „Pe flux"**, ci „DF în lucru" cu **„Revizuiește DF (neaprobat)"**; DF-ul apare „❌ Neaprobat", editabil/revizuibil, cu atașamentele intacte.
- Auditul DF conține evenimentul de refuz.
- R1 refuzat → ALOP revine la revizia aprobată anterioară.

## Final
```bash
git add server/routes/flows/signing.mjs server/tests/db/refuz-alop-robust.test.mjs package.json
git commit -m "fix(state-machine): refuz DF -> neaprobat + ALOP DF-in-lucru, rezolvare robusta prin df_flow_id + audit (B2)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- confirmarea că notificările/webhook/marcarea `refused` sunt neatinse;
- că rezolvarea DF folosește pointerul `alop.df_flow_id` (split-path acoperit);
- `npm test` verde; dacă vezi cale analogă la ORD, semnaleaz-o (fără s-o atingi).
