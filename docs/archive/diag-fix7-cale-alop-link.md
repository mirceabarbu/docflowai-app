---
DIAGNOSTIC READ-ONLY — fix 7 nu copiază pe flux NOU din ALOP ORD (endpoint de link diferit?)
target_branch: develop (doar inspecție — NU se modifică nimic)
model_suggested: Opus 4.8
risk: ZERO — read-only, fără edit/commit
---

# ⚠️ READ-ONLY — NU MODIFICA NIMIC. NU edita/commit/push. Output = raport + locul propus al fix-ului.
# Branch `develop` doar pentru inspecție. NU atinge `main`.

## Fapt nou
Backfill-ul SQL a reparat fluxul VECHI (`PT_A698690EC0` → 2 rânduri). Dar un flux NOU lansat dintr-un ALOP ORD tot iese cu „Documente suport" gol. Deci hook-ul de copiere din fix 7 (commit bfdb6d5, pus în `linkFlowFormular`) NU se declanșează pe calea reală de lansare din ALOP.

## Ipoteză de verificat
Fix 7 a pus copierea DOAR în `linkFlowFormular` (`formular-shared.mjs`), apelat de `/api/formulare-{df,ord}/:id/link-flow`. Dar lansarea fluxului dintr-un ALOP ORD trece probabil prin `POST /api/alop/:id/link-ord-flow` (`alop.mjs:~1041`) și/sau `link-df-flow` (`alop.mjs:~853`) — endpoint-uri SEPARATE care scriu `alop_instances.ord_flow_id`/`df_flow_id` direct, FĂRĂ să treacă prin `linkFlowFormular`. Dacă da → copierea nu se cheamă niciodată pe calea ALOP.

## De trasat și raportat (fără edit)
```
# 0. Confirmă că deploy-ul rulează bfdb6d5 (exclude deploy vechi)
git log --oneline -3
git show bfdb6d5 --stat | head -20

# 1. La lansare flux din ALOP ORD, CE endpoint cheamă frontend-ul pentru legare?
grep -n "link-ord-flow\|link-df-flow\|formulare-ord/.*link-flow\|formulare-df/.*link-flow\|link-flow\|alopLaunchOrdFlow\|mkFlow" public/js/formular/alop.js public/js/formular/core.js public/js/semdoc-initiator/main.js

# 2. Apelul de copiere (fix 7) — în CE fișiere există acum?
grep -rn "copyFormularAttachmentsToFlow" server/

# 3. Endpoint-urile ALOP de link: cheamă linkFlowFormular SAU scriu direct UPDATE fără copiere?
grep -n "link-ord-flow\|link-df-flow\|linkFlowFormular\|ord_flow_id\|df_flow_id\|copyFormularAttachmentsToFlow\|UPDATE alop_instances" server/routes/alop.mjs

# 4. linkFlowFormular e apelat de pe calea ALOP, sau doar de /api/formulare-*/link-flow?
grep -rn "linkFlowFormular" server/

# 5. Loguri runtime: apare „formular→flux atașamente copiate" la lansarea reală? sau un catch non-fatal înghite o eroare?
grep -rn "formular→flux\|atașamente copiate\|copyFormularAttachmentsToFlow" server/services/formular-shared.mjs server/routes/alop.mjs
```

## Întrebări la care raportul răspunde explicit
1. Deploy-ul activ are bfdb6d5? (dacă nu → cauză = deploy vechi, nu cod.)
2. Lansarea din ALOP ORD cheamă `/api/formulare-ord/:id/link-flow` (→ `linkFlowFormular`, are copierea) SAU `/api/alop/:id/link-ord-flow` (`alop.mjs`, NU are copierea)? Sau ambele?
3. `linkFlowFormular` e efectiv în lanțul de apel al lansării ALOP, sau ALOP scrie legătura direct în `alop.mjs` fără el?
4. Apelul `copyFormularAttachmentsToFlow` există DOAR în `formular-shared.mjs`, sau și în `alop.mjs` link-ord-flow/link-df-flow?
5. Dacă lipsește pe calea ALOP: locul exact (alop.mjs:linie, după UPDATE-ul care setează `ord_flow_id`/`df_flow_id`, unde `ord_id`/`df_id` + `flow_id` sunt cunoscute) unde trebuie adăugat apelul.

## Corroborare DB (manual, util pentru raport)
Lansează un flux NOU din ORD-ul de test, ia `flow_id`-ul nou, apoi:
```sql
-- legătura s-a scris?
SELECT ord_flow_id FROM alop_instances WHERE ord_id = '<ordId test>';
-- ORD-ul are atașamente sursă? (fix 6 livrat → ar trebui DA)
SELECT count(*) FROM formulare_atasamente WHERE form_type='ord' AND form_id='<ordId test>' AND deleted_at IS NULL;
-- s-a copiat în flux? (ipoteza: 0)
SELECT count(*) FROM flow_attachments WHERE flow_id = '<noul ord_flow_id>';
```
Dacă: legătură SETATĂ + sursă ≥ 1 + flux 0 → confirmă că hook-ul runtime nu rulează pe calea ALOP.

## Output cerut
Raport scurt: (a) deploy = bfdb6d5? (b) endpoint-ul real de link la lansare ALOP ORD; (c) dacă `copyFormularAttachmentsToFlow` lipsește pe acea cale; (d) locul exact (fișier:linie) unde trebuie adăugat apelul non-fatal, simetric ORD+DF. NU aplica nimic.
