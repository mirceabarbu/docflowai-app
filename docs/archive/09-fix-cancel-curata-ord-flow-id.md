---
fix: 9 — Anularea fluxului nu curăță pointerul ALOP pentru ORD (asimetrie față de DF) → drift `ord_flow_id`
target_branch: develop
model_suggested: Opus 4.8 (logică de lifecycle ALOP + paritate DF/ORD + posibil revert de status)
risk: MEDIU — atinge handler-ul de cancel flux (lifecycle.mjs); NU atinge semnarea
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele. Nu atinge logica de semnare — doar curățarea pointerilor la cancel.

## Cauză (confirmată în sursă)
La `POST /flows/:flowId/cancel` (`server/routes/flows/lifecycle.mjs:466`), blocul de cleanup (`~501-518`) tratează DOAR DF:
```
UPDATE formulare_df SET status='completed' WHERE flow_id=$1 AND status='transmis_flux' RETURNING id...
UPDATE alop_instances SET df_flow_id=NULL, df_completed_at=NULL WHERE df_id=$1 AND cancelled_at IS NULL
```
**Nu există echivalent pentru ORD.** După anularea unui flux de ORD, `alop_instances.ord_flow_id` rămâne agățat de fluxul anulat (pointer mort). Formularul ORD se deblochează corect (fiindcă `flow_active` din `ord.mjs:139` verifică statusul fluxului real → cancelled → false), dar cardul ALOP rămâne cu `ord_flow_id` stale → asimetric față de DF.

Notă asimetrie: ORD NU trece niciodată prin `status='transmis_flux'` (la link-flow ORD se setează doar `flow_id`, nu status). Deci la ORD NU se resetează status formular (rămâne `completed`) — se curăță DOAR pointerii ALOP.

## Fix — adaugă cleanup ORD simetric, în același handler de cancel
În `lifecycle.mjs`, după blocul de cleanup DF (`~518`), adaugă un bloc ORD non-fatal:
```
// Simetric DF (fix 9): la cancel, curăță pointerul ORD pe ALOP. ORD nu are status
// 'transmis_flux' (link-flow ORD setează doar flow_id), deci NU resetăm status formular —
// doar eliberăm ord_flow_id/ord_completed_at pe ALOP (fluxul mort nu mai e activ).
try {
  const { rows: ordRows } = await pool.query(
    `SELECT id FROM formulare_ord WHERE flow_id=$1`,
    [flowId]
  );
  if (ordRows.length) {
    const ordId = ordRows[0].id;
    await pool.query(
      `UPDATE alop_instances
         SET ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW()
       WHERE ord_id=$1 AND cancelled_at IS NULL`,
      [ordId]
    );
    logger.info({ ordId, flowId }, '[ALOP] flow cancelled → ord_flow_id=NULL (simetric DF)');
  }
} catch (ordCancelErr) {
  logger.error({ err: ordCancelErr, flowId }, '[ALOP] ORD restore on cancel failed (non-fatal)');
}
```

## DE VERIFICAT în implementare (nu presupune — confirmă în cod)
1. **Revert de status ALOP?** La DF, cancel readuce DF la `completed` și ALOP rămâne pe `df_id`. Pentru ORD: dacă ALOP era pe `status='plata'` sau `'ordonantare'` din cauza acestui flux, trebuie ALOP revenit la `'ordonantare'` (sau starea corectă) la anularea fluxului ORD? Verifică logica de tranziție ALOP (`ord-completed`, `confirma-lichidare`) și self-heal #2 (`alop.mjs:675`) ca să decizi dacă e nevoie de revert sau dacă `flow_active=false` rezolvă singur afișarea. **Dacă reverting-ul de status nu e clar corect, NU-l face — limitează-te la curățarea pointerului** (sigură) și raportează separat.
2. **`alop_ord_cicluri.ord_flow_id`** — tabela de cicluri ține și ea `ord_flow_id` per ciclu. Decizie de design (NU o implementa fără confirmare): la cancel, se curăță și `ord_flow_id` din ciclul respectiv, sau se păstrează ca istoric? DF nu are echivalent de ciclu în cancel. **Lasă `alop_ord_cicluri` neatins în acest fix** (păstrează istoricul) și notează întrebarea pentru owner.
3. Confirmă că `flowId` e variabila corectă în scope la acel punct din handler (e folosită deja în blocul DF).

## Backfill / unstick pentru înregistrarea curentă blocată (manual, separat)
Pentru ORD-ul deja blocat (flux abandonat, neanulat): owner-ul anulează fluxul (UI/`POST /flows/:flowId/cancel`) → după fix 9, cancel-ul curăță automat `ord_flow_id`. Pentru pointerii deja drift-uiți de la cancel-uri ANTERIOARE fix-ului, un UPDATE ADD-ONLY opțional:
```sql
-- curăță ord_flow_id pe ALOP unde fluxul referit e cancelled
UPDATE alop_instances a
   SET ord_flow_id=NULL, updated_at=NOW()
  FROM flows f
 WHERE f.id = a.ord_flow_id
   AND (f.data->>'status') = 'cancelled'
   AND a.cancelled_at IS NULL;
```
(rulat de owner în consolă, idempotent — doar pe fluxuri efectiv cancelled).

## Teste
- DB caracterizare: creează ORD legat de flux → cancel flux → `alop_instances.ord_flow_id` devine NULL; `flow_active` ORD = false; formularul se deblochează. Paritate: același test DF rămâne verde (nu strici cleanup-ul DF existent).
- Cancel pe flux fără ORD legat → no-op, fără eroare.
- `node --check server/routes/flows/lifecycle.mjs`; `npm test` verde, fără regresii.

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH gol.
- Cleanup la cancel simetric DF↔ORD (ambele curăță pointerul ALOP).
- `alop_ord_cicluri` neatins (decizie owner separată).
- Cache-bust dacă s-a atins frontend (nu e cazul — backend) + bump `package.json` patch.
- CLAUDE.md: o linie („`POST /flows/:flowId/cancel` curăță pointerul ALOP simetric DF (`df_flow_id`) și ORD (`ord_flow_id`); ORD nu resetează status formular fiindcă nu trece prin `transmis_flux`").

## Finalizare
```
git add <doar fișierele acestei sarcini: lifecycle.mjs, test, CLAUDE.md, package.json>
git commit -m "fix(alop): anularea fluxului curăță ord_flow_id simetric DF — fără pointer ALOP mort pe ORD după cancel"
git push origin develop
```
