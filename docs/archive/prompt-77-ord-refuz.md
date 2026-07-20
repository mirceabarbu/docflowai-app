---
prompt: 77
titlu: "fix(state-machine): refuz flux ORD → curăță ord_flow_id (re-lansare disponibilă) + audit — geamănul lui #74"
model_suggested: Opus 4.8
branch: develop
zona: ⚠️ PRODUCȚIE · mașină de stări ALOP · handler refuz (bloc ORD)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ SUPRAFAȚĂ CRITICĂ (producție + ALOP)
> Se atinge DOAR handler-ul de refuz din `signing.mjs` (se ADAUGĂ un bloc ORD lângă blocul DF din #74). NU atinge: notificările/webhook, semnarea, STS/PAdES, blocul DF din #74.

## Bug (confirmat în cod)
Handler-ul de refuz tratează doar DF. La refuz **ORD**, `alop.ord_flow_id` **nu se curăță**. Capabilitățile ordonanțării (`alop-capabilities.mjs:63-65`):
- `ordonantare && ord_id && !ord_flow_id` → „Generează + Lansează flux ORD"
- `ordonantare && ord_flow_id && !ord_completed_at` → „Marchează ORD semnat complet"

Deci după refuz ORD, ALOP rămâne blocat pe „**Marchează ORD semnat complet**" (pentru un flux refuzat) și userul **nu poate re-lansa** ORD-ul. Geamănul lui #74, dar funcțional (buton greșit), nu vizual.

## Comportament țintă (confirmat de owner: re-lansare curată + audit)
- Rezolvă ALOP-ul robust prin `alop.ord_flow_id = flowId`.
- Curăță `ord_flow_id` + `ord_completed_at` → ALOP oferă din nou „Generează + Lansează flux ORD" (ORD-ul rămâne, regenerabil).
- Audit `flux_refuzat` pe ORD (trasabilitate).

## Fix — `server/routes/flows/signing.mjs`
`recordFormularAudit` e deja importat (din #74). **După** blocul DF de refuz (cel care se termină cu `catch (alopRefuseErr)`), adaugă un bloc ORD independent:
```js
    // ── Refuz ORD: curăță ord_flow_id → ALOP oferă re-lansare + audit ──
    try {
      const { rows: ordAlopRows } = await pool.query(
        `SELECT id, ord_id FROM alop_instances WHERE ord_flow_id=$1 AND cancelled_at IS NULL LIMIT 1`,
        [flowId]
      );
      if (ordAlopRows.length) {
        const aRow = ordAlopRows[0];
        await pool.query(
          `UPDATE alop_instances SET ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW()
           WHERE id=$1 AND cancelled_at IS NULL`,
          [aRow.id]
        );
        if (aRow.ord_id) {
          try {
            await recordFormularAudit({
              orgId: data.orgId, formType: 'ord', formId: aRow.ord_id,
              actorEmail: (signers[idx]?.email || null),
              eventType: 'flux_refuzat', toStatus: null,
              meta: { flowId, via: 'ord_flux_refuzat' },
            });
          } catch (_) { /* non-fatal */ }
        }
        logger.info({ alopId: aRow.id, flowId }, '[ALOP] flux ORD refuzat → ord_flow_id curățat, re-lansare disponibilă');
      }
    } catch (ordRefuseErr) {
      logger.error({ err: ordRefuseErr, flowId }, '[ALOP] procesare refuz ORD eșuată (non-fatal)');
    }
```
> Blocul DF (#74) rezolvă prin `formulare_df`/`alop.df_flow_id`; blocul ORD prin `alop.ord_flow_id`. Un flux e ori DF, ori ORD → blocurile sunt mutual exclusive (celălalt e no-op).

## Label audit nou (obligatoriu — altfel pică `audit-labels-sync.test.mjs`)
Adaugă traducerea pentru `flux_refuzat` în dicționarele de label-uri (ca la `neaprobat` în #74): `public/js/admin/activity.js` și `public/js/admin/audit.js` → ex. „Flux refuzat". Bump `?v=` pe ambele în `admin.html`.

## Ce NU atingem
- ⛔ Blocul DF din #74. ⛔ Notificări/webhook/semnare/STS/PAdES. ⛔ Statusul documentului ORD (rămâne — re-lansare curată).

## Test
`server/tests/db/refuz-ord-alop.test.mjs`: ALOP la `ordonantare` cu `ord_flow_id=flow` refuzat → după refuz `ord_flow_id` NULL, `ord_completed_at` NULL, audit `flux_refuzat` scris; capabilitatea redevine `genereaza_lanseaza_ord`. `npm test verde`.

## Guardrails diff
EXCLUSIV: `server/routes/flows/signing.mjs`, `public/js/admin/activity.js`, `public/js/admin/audit.js`, `admin.html`, testul, `package.json` (+ `sw.js` dacă bump `?v=` pe admin.js-uri).
```bash
git diff server/routes/flows/signing.mjs | grep -iE "_notify|_fireWebhook|signers\[idx\].status = 'refused'|-- bloc DF" && echo "⚠️ verifică: blocul DF (#74) și notificările NU se schimbă" || echo "✅ doar bloc ORD adăugat"
```

## Verificare (owner, staging)
- Refuz flux ORD → ALOP nu mai arată „Marchează ORD semnat"; apare „Generează + Lansează flux ORD" → poți re-lansa.
- Auditul ORD conține „Flux refuzat".
- Refuz DF (din #74) → neschimbat.

## Final
```bash
git add server/routes/flows/signing.mjs public/js/admin/activity.js public/js/admin/audit.js public/admin.html server/tests package.json public/sw.js
git commit -m "fix(state-machine): refuz ORD curata ord_flow_id (re-lansare) + audit flux_refuzat"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
