---
fix: D — Soft-delete-ul fluxului lasă DF/ORD blocat „pe flux de semnare" (flow_active tratează fluxul șters ca activ)
target_branch: develop
model_suggested: Opus 4.8 (logică de stare ALOP/formular + curățare pointer simetrică la delete)
risk: MEDIU — atinge calculul flow_active (display server-driven) și handler-ul de delete flux; NU atinge semnarea
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele.

## Cauză (confirmată în sursă)
`DELETE /flows/:flowId` (`server/routes/flows/crud.mjs:635`) e **soft-delete**: setează `flows.deleted_at`, șterge `flows_pdfs` + `flow_attachments` + notificări, DAR:
- NU schimbă `data.status` în `cancelled`;
- NU curăță `formulare_{df,ord}.flow_id` sau `alop_instances.{df,ord}_flow_id`.

`flow_active` (`df.mjs:134-137` și `ord.mjs:137-139`) se calculează cu LEFT JOIN la `flows`, fără să excludă `deleted_at`:
```
fd.flow_id IS NOT NULL
  AND (f.data->>'completed') IS DISTINCT FROM 'true'
  AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
```
Fluxul soft-șters rămâne în JOIN (rândul există, doar are `deleted_at`), iar `status` NU e `cancelled` → `flow_active` rămâne TRUE → `is_on_flow` TRUE → DF/ORD blocat „pe flux de semnare" la nesfârșit, pointând spre un flux șters. (Anularea — fix 9 — funcționează fiindcă setează `status='cancelled'`; ștergerea nu.)

## Fix (două straturi — display robust + igienă de date)
### 1. `flow_active` exclude fluxurile soft-șterse (df.mjs + ord.mjs)
În CASE-ul `flow_active`, adaugă condiția ca fluxul să NU fie șters:
```
CASE WHEN fd.flow_id IS NOT NULL
      AND f.deleted_at IS NULL              -- NOU: fluxul șters nu mai e activ
      AND (f.data->>'completed') IS DISTINCT FROM 'true'
      AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
     THEN true ELSE false END AS flow_active
```
Idem în `ord.mjs`. (Asta deblochează imediat orice DF/ORD pointat spre un flux șters, fără a curăța pointerul — display-ul devine corect.)
- Verifică dacă același raționament se aplică la `aprobat` (df.mjs:132 / ord.mjs:134): un flux șters n-ar trebui să marcheze documentul ca `aprobat`. Decide pe baza logicii: dacă un flux completed+șters ar trebui să rămână `aprobat` (semnat valid, doar ascuns), lasă-l; dacă nu, adaugă și acolo `f.deleted_at IS NULL`. Raportează decizia, nu o forța orbește.

### 2. Curățare pointer la delete (simetric cu cancel/fix 9) — `crud.mjs` DELETE handler
După soft-delete (`UPDATE flows SET deleted_at...`, ~linia 654), adaugă curățarea pointerilor (non-fatal), exact cum face cancel-ul:
```
await pool.query(`UPDATE formulare_df  SET flow_id=NULL, updated_at=NOW() WHERE flow_id=$1`, [flowId]).catch(()=>{});
await pool.query(`UPDATE formulare_ord SET flow_id=NULL, updated_at=NOW() WHERE flow_id=$1`, [flowId]).catch(()=>{});
await pool.query(`UPDATE alop_instances SET df_flow_id=NULL,  updated_at=NOW() WHERE df_flow_id=$1  AND cancelled_at IS NULL`, [flowId]).catch(()=>{});
await pool.query(`UPDATE alop_instances SET ord_flow_id=NULL, updated_at=NOW() WHERE ord_flow_id=$1 AND cancelled_at IS NULL`, [flowId]).catch(()=>{});
```
- NU reseta status formular (la fel ca fix 9 pe ORD; pentru DF, dacă era `transmis_flux`, decide dacă-l readuci la `completed` — mirror cancel-ul DF din lifecycle.mjs. Verifică și aliniază, nu presupune).

## Backfill manual (owner, opțional) — pointeri deja morți de la ștergeri anterioare
```sql
UPDATE formulare_df d  SET flow_id=NULL FROM flows f WHERE f.id=d.flow_id AND f.deleted_at IS NOT NULL;
UPDATE formulare_ord o SET flow_id=NULL FROM flows f WHERE f.id=o.flow_id AND f.deleted_at IS NOT NULL;
UPDATE alop_instances a SET df_flow_id=NULL  FROM flows f WHERE f.id=a.df_flow_id  AND f.deleted_at IS NOT NULL;
UPDATE alop_instances a SET ord_flow_id=NULL FROM flows f WHERE f.id=a.ord_flow_id AND f.deleted_at IS NOT NULL;
```

## Teste
- DB caracterizare: DF legat de flux → soft-delete flux → GET DF: `flow_active=false`, `is_on_flow=false` (deblocat); `formulare_df.flow_id=NULL`; `alop_instances.df_flow_id=NULL`. ORD simetric.
- Non-regresie: flux ACTIV (nețters, non-terminal) → `flow_active=true` (guard-ul real rămâne). Flux `cancelled` → `flow_active=false` (fix 9 neatins).
- `node --check`; `npm test` verde — confirmă în CI (testele DB rulează doar acolo).

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH gol.
- DF/ORD pointat spre un flux șters NU mai apare „pe flux"; delete curăță pointerii (simetric cancel).
- Cache-bust dacă s-a atins frontend (nu e cazul — backend) + bump `package.json` patch.
- CLAUDE.md: o linie („`flow_active` exclude fluxurile soft-șterse (`f.deleted_at IS NULL`); `DELETE /flows` curăță `formulare_{df,ord}.flow_id` + `alop_instances.{df,ord}_flow_id` simetric cu cancel").

## Finalizare
```
git add <doar fișierele acestei sarcini: df.mjs, ord.mjs, crud.mjs, test, CLAUDE.md, package.json>
git commit -m "fix(flux): soft-delete-ul fluxului nu mai lasă DF/ORD blocat pe flux (flow_active exclude fluxuri șterse + delete curăță pointerii)"
git push origin develop
```
