---
fix: 8 — Copierea atașamentelor NU rulează pe calea ALOP (linkFlowFormular dă 409 → guard; ALOP leagă necondiționat fără copiere)
target_branch: develop
model_suggested: Opus 4.8 (corecție pe calea de link ALOP + paritate ORD/DF + test)
risk: MEDIU — atinge endpoint-urile de link ALOP; helper-ul de copiere rămâne neatins
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele. Helper-ul `copyFormularAttachmentsToFlow` (formular-flow-attachments.mjs) rămâne **NEATINS**.

## Cauză (confirmată în sursă)
Fix 7 a pus copierea în `linkFlowFormular` (`formular-shared.mjs:542`), DUPĂ două guard-uri care fac `return` mai devreme:
- `formular-shared.mjs:499` → `if (doc.status !== 'completed') return 409 document_not_completed`
- `formular-shared.mjs:506-517` → document deja pe un flux non-terminal → `409 already_on_flow`

Frontend-ul (`semdoc-initiator/main.js`) cheamă AMBELE endpoint-uri la lansare: `/api/formulare-{df,ord}/:id/link-flow` (→ `linkFlowFormular`, are copierea, dar dă 409 înghițit) ȘI `/api/alop/:id/link-{ord,df}-flow` (`alop.mjs`, setează `{df,ord}_flow_id` **NECONDIȚIONAT**, FĂRĂ copiere). Rezultat: flux legat (pointer ALOP setat), copiere niciodată rulată. `copyFormularAttachmentsToFlow` există EXCLUSIV în `formular-shared.mjs:542`; lipsește din `alop.mjs`.

## Fix — adaugă copierea pe calea ALOP necondiționată (simetric ORD + DF)
Import la capul `server/routes/alop.mjs` (verifică să nu existe deja):
```
import { copyFormularAttachmentsToFlow } from '../services/formular-flow-attachments.mjs';
```

**1. `link-ord-flow`** (`alop.mjs`, după UPDATE-ul de la 1041-1046, după `if (!rows[0]) return ...` ~1048, înainte de `res.json`):
```
if (alopRows[0].ord_id) {
  try {
    await copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: 'ord', formId: alopRows[0].ord_id });
  } catch (e) { logger.warn({ err: e, alopId: req.params.id }, '[ALOP] copiere atașamente ORD→flux non-fatal'); }
}
```

**2. `link-df-flow`** (`alop.mjs`, după UPDATE-ul de la 853-858, după `if (!rows[0]) return ...` ~860; poate fi înainte de check-ul de auto-lichidare):
```
if (alopRows[0].df_id) {
  try {
    await copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: 'df', formId: alopRows[0].df_id });
  } catch (e) { logger.warn({ err: e, alopId: req.params.id }, '[ALOP] copiere atașamente DF→flux non-fatal'); }
}
```

Note:
- `alopRows[0].df_id`/`ord_id` sunt deja selectate în query-ul de la începutul fiecărui handler (`SELECT ... df_id, ord_id ...`); `flow_id` vine din body. Confirmă în sursă înainte (sunt la 842-845 resp. 1030-1033).
- **Idempotent**: dacă `linkFlowFormular` a copiat deja pe calea fericită, guard-ul `NOT EXISTS (flow_id, filename)` din helper face ca al doilea apel să insereze 0 — fără dublură. Pe calea reală ALOP (unde linkFlowFormular a dat 409), acesta e singurul care copiază.
- **Non-fatal**: o eroare la copiere NU trebuie să rupă linkarea/tranziția ALOP.
- NU muta/slăbi guard-urile din `linkFlowFormular` — ele există din motive corecte (nu lega documente needitate, nu dubla pe fluxuri zombi). Copierea pe calea ALOP e complementară, nu înlocuiește.

## Curățenie documentație
`formular-flow-attachments.mjs:~20` — comentariul antet încă spune „Apelată din crud.mjs (createFlow)". Actualizează-l: declanșată din `linkFlowFormular` (calea fericită) ȘI din `alop.mjs` `link-{ord,df}-flow` (calea ALOP necondiționată).

## Teste
- DB caracterizare NOU pe calea ALOP: apel `link-ord-flow` cu ORD care are 2 atașamente → 2 rânduri în `flow_attachments`; re-apel → fără duplicate; DF simetric prin `link-df-flow`; ORD fără atașamente → 0, link reușește; copiere non-fatal (eroare simulată NU rupe răspunsul `ok:true`).
- Verifică explicit scenariul cauză: când `linkFlowFormular` ar da 409 (doc not completed / already_on_flow) dar `link-ord-flow` rulează → atașamentele ajung totuși în flux.
- `node --check server/routes/alop.mjs`; `npm test` verde, fără regresii. (DB tests în CI; local auto-skip fără Docker.)
- **Manual staging (proba reală):** ORD ALOP cu atașamente → lansează flux → „Documente suport" listează fișierele. Repetă DF.

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH gol; helper neatins.
- `copyFormularAttachmentsToFlow` prezent acum pe AMBELE căi (linkFlowFormular + cele 2 handler-e ALOP), idempotent.
- Cache-bust dacă s-a atins frontend (nu e cazul aici — doar backend) + bump `package.json` patch.
- CLAUDE.md: o linie („copierea atașamentelor formular→flux rulează pe 2 căi: `linkFlowFormular` (happy path, post-guards) și `alop.mjs` `link-{ord,df}-flow` (calea ALOP necondiționată, fiindcă linkFlowFormular dă 409 când docul nu e completed / e deja pe flux). Idempotent prin NOT EXISTS").

## Notă de urmărit (NU în scope acum)
Când `linkFlowFormular` dă 409, `formulare_{df,ord}.flow_id` NU se setează, dar `alop_instances.{df,ord}_flow_id` DA → posibil drift de pointer flux între cele două surse. Self-heal #2 (`alop.mjs:675`) acoperă parțial ord. De evaluat separat dacă merită un guard de consistență; nu-l atinge în acest fix.

## Finalizare
```
git add <doar fișierele acestei sarcini: server/routes/alop.mjs, formular-flow-attachments.mjs (comentariu), test nou, CLAUDE.md, package.json>
git commit -m "fix(alop): copiază atașamentele formular→flux și pe calea ALOP (link-ord-flow/link-df-flow), unde linkFlowFormular dă 409 → guard"
git push origin develop
```
