---
fix: 7 — Copierea atașamentelor formular→flux NU rulează pe calea reală de linkare (recuplare la `linkFlowFormular`) + backfill
target_branch: develop
model_suggested: Opus 4.8 (corecție de cuplare server-side + backfill pe date reale + paritate DF/ORD)
risk: MEDIU — atinge calea de linkare flux↔formular și rulează backfill pe producție; helper-ul de copiere rămâne neatins
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele. NU atinge lanțul de semnare. Helper-ul `copyFormularAttachmentsToFlow` (formular-flow-attachments.mjs) rămâne **NEATINS** — doar se recheamă din alt punct.

## Cauză (confirmată în DB producție + raport read-only)
Copierea (fix 3) e agățată exclusiv de `body.meta.ordId`/`body.meta.dfId` în handlerul `POST /flows` (`crud.mjs`). Dar legătura durabilă flux↔formular se scrie pe căi **separate** care rulează DUPĂ crearea fluxului și NU poartă `meta.*`:
- `linkFlowFormular` (`server/services/formular-shared.mjs:520-533`) — canonic, parametrizat DF/ORD; face `UPDATE formulare_X SET flow_id` + `UPDATE alop_instances SET {df,ord}_flow_id`.
- `POST /api/alop/:id/link-ord-flow` (`alop.mjs:1041-1046`) și `link-df-flow` (`alop.mjs:853-858`).

Pe calea de link dedicat, `meta.ordId` lipsește server-side → copierea nu rulează niciodată. Dovadă producție: ORD `fd2e00e3…` are 2 atașamente, ciclul are `ord_flow_id='PT_A698690EC0'`, dar `flow_attachments` pentru acel flux = 0 rânduri. (`flows.form_type='none'` pe toate 378 — coloană moartă, `saveFlow` n-o scrie; irelevantă pentru fix.)

## Fix — recuplare la punctul durabil (un singur loc, simetric DF/ORD)
1. **Mută/dublează apelul de copiere în `linkFlowFormular`** (`server/services/formular-shared.mjs`), **după** UPDATE-urile de legătură (după linia ~533), cu parametrii deja prezenți local:
   ```
   copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: type, formId: id })
   ```
   - `type` e deja `'df'`/`'ord'`, `id` = form_id, `flow_id` = fluxul legat → acoperă automat ȘI DF ȘI ORD dintr-un singur punct.
   - **non-fatal**: înfășoară în try/catch cu log de warning; o eroare la copiere NU trebuie să rupă linkarea fluxului (semnarea e prioritară). Întoarce/loghează numărul copiat.
2. **Curăță cuplarea moartă din `crud.mjs`** (apelul bazat pe `body.meta.ordId/dfId`): fie o elimini (devine redundantă și înșelătoare), fie o lași DAR documentezi că e best-effort și că sursa de adevăr e `linkFlowFormular`. **Preferat: elimin-o**, ca să existe un singur punct de copiere (evită dubla execuție și confuzia viitoare). Idempotența (`NOT EXISTS` pe `flow_id`+`filename`) face oricum sigură eventuala dublă rulare, dar un singur loc = mai curat.
3. **Verifică** că `linkFlowFormular` are acces la `pool` și că importul helper-ului nu creează ciclu de import (formular-shared ↔ formular-flow-attachments). Dacă apare ciclu, injectează `pool` sau importă lazy în interiorul funcției.
4. **Banner frontend**: `formAttachmentsCopied` venea din răspunsul `POST /flows`. Acum copierea se face la link (`/api/formulare-{df,ord}/:id/link-flow`). Asigură-te că răspunsul endpoint-ului de link întoarce numărul copiat și că `semdoc-initiator/main.js` îl citește de acolo (sau acceptă că banner-ul apare după pasul de link, nu de creare). Dacă e complicat, banner-ul e secundar — funcționalitatea (fișierele apar în „Documente suport") e ce contează.

## Backfill ADD-ONLY (repară istoricul, idempotent)
Script de migrare/maintenance ADD-ONLY (nu distructiv, re-rulabil), care pentru fiecare legătură durabilă cu flux dar fără atașamente copiate apelează helper-ul. Sursele de legături (din raport):
```
-- cicluri ORD arhivate
SELECT ord_flow_id AS flow_id, 'ord' AS ft, ord_id AS form_id
  FROM alop_ord_cicluri WHERE ord_flow_id IS NOT NULL AND ord_id IS NOT NULL
UNION ALL
-- ciclul curent (alop_instances) ORD + DF
SELECT ord_flow_id, 'ord', ord_id FROM alop_instances WHERE ord_flow_id IS NOT NULL AND ord_id IS NOT NULL
UNION ALL
SELECT df_flow_id, 'df', df_id   FROM alop_instances WHERE df_flow_id IS NOT NULL AND df_id IS NOT NULL
UNION ALL
-- non-ALOP: formulare_{df,ord}.flow_id direct
SELECT flow_id, 'df', id FROM formulare_df  WHERE flow_id IS NOT NULL
UNION ALL
SELECT flow_id, 'ord', id FROM formulare_ord WHERE flow_id IS NOT NULL;
```
Pentru fiecare rând → `copyFormularAttachmentsToFlow(pool, {flowId, formType:ft, formId})`. `NOT EXISTS` intern sare fluxurile deja populate. Rulează backfill-ul ca task de maintenance separat (NU în migrarea de schemă), idempotent, cu log per rând (copiate N).
- ⚠️ Verifică numele reale ale tabelelor `formulare_df`/`formulare_ord` (sau echivalent) prin schema reală înainte — nu presupune.
- Confirmă pe ciclul cunoscut: după backfill, `flow_attachments WHERE flow_id='PT_A698690EC0'` trebuie să aibă 2 rânduri (declaratie avere + interese).

## Teste / verificări
- Unit/DB caracterizare: apel `linkFlowFormular` pe ORD cu 2 atașamente → 2 rânduri în `flow_attachments`; re-apel → fără duplicate; DF simetric; formular fără atașamente → 0, fără eroare; copierea non-fatal (eroare simulată în copiere NU rupe linkarea).
- Backfill: pe o bază caracterizată cu un ciclu legat + atașamente sursă → după rulare, fluxul are atașamentele; re-rulare → idempotent (fără duplicate).
- `node --check`; `npm test` → verde, fără regresii. (Testele DB rulează în CI; local auto-skip fără Docker — confirmă în CI.)
- **Manual staging (proba reală):** ORD cu atașamente → lansează flux → după link, „Documente suport" listează fișierele. Repetă pe DF.

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH (semnare) gol; `copyFormularAttachmentsToFlow` neatins (doar re-cuplat).
- Un singur punct de copiere (linkFlowFormular); cuplarea moartă din crud.mjs eliminată/documentată.
- Backfill idempotent, ADD-ONLY, rulat ca maintenance (nu în migrarea de schemă).
- Cache-bust țintit dacă s-a atins frontend (`main.js`) + bump `package.json` patch.
- CLAUDE.md: o linie („copierea atașamentelor formular→flux se declanșează din `linkFlowFormular` (sursa durabilă), NU din `meta.ordId/dfId` în crud.mjs — `flows.form_type` e `'none'`/mort; legătura trăiește pe `formulare_X.flow_id` + `alop_instances.{df,ord}_flow_id`").

## Finalizare
```
git add <doar fișierele acestei sarcini>
git commit -m "fix(flux): copierea atașamentelor formular→flux se declanșează la linkFlowFormular (sursa durabilă DF/ORD), nu la meta efemeră + backfill idempotent"
git push origin develop
```
