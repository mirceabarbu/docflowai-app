---
fix: 11 (B+) — Cursa pe pre-setarea flow_id rupe copierea atașamentelor: await + copiere idempotentă ca plasă în crud.mjs
target_branch: develop
model_suggested: Opus 4.8 (lifecycle flux + idempotență + protecția sursei formulare_atasamente)
risk: MEDIU — atinge POST /flows (crearea fluxului); NU atinge semnarea, NU atinge sursa atașamentelor
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele.

## Cauză rădăcină (CONFIRMATĂ prin audit, nu ipoteză)
Auditul `formulare_audit` pe DF-ul de test arată evenimentele: `legat_alop, completat, trimis_p2, returnat, trimis_p2, creat`. **Lipsește `transmis_flux`** — deci `linkFlowFormular` (formular-shared.mjs) s-a oprit pe guard-ul 409 `already_on_flow` ÎNAINTE de copiere (linia 551), pe ORICE lansare.

De ce, deși fix 10 a reparat guard-ul: `crud.mjs:391-402` (POST /flows) setează `formulare_{df,ord}.flow_id` cu `pool.query(...)` **FĂRĂ `await`** (fire-and-forget, doar `.catch()`). Apoi frontend-ul cheamă `link-flow` → `linkFlowFormular` face SELECT pe DF. Dacă UPDATE-ul ne-așteptat n-a comis încă, `linkFlowFormular` citește `flow_id`-ul VECHI (de la o relansare anterioară) → guard fix 10 (`doc.flow_id !== flow_id`) vede un flux DIFERIT activ → 409 → copierea nu rulează → frontend înghite eroarea (`catch(_){}`). PDF-ul DF ajunge mereu în flux (prin `POST /flows` sincron), dar atașamentele NU (cale separată, fragilă, racy).

Contrast cu `crud.mjs:409-415` (alop df_flow_id) care ESTE `await`-uit. Doar pre-setarea `formulare_X.flow_id` (392, 398) e ne-așteptată.

## Decizie owner: B+ (NU varianta A)
Owner-ul a RESPINS scoaterea pre-setării din crud.mjs (varianta A) — e plasă de siguranță: garantează că DF-ul e legat chiar dacă `link-flow` pică pe rețea. Ales B+:
1. **`await`** pe pre-setarea `flow_id` din crud.mjs (elimină cursa — `flow_id` comis înainte ca POST /flows să răspundă → `linkFlowFormular` citește mereu valoarea corectă → guard fix 10 se sare corect → copiere rulează).
2. **Copiere atașamente idempotentă ȘI în crud.mjs** (după pre-set, unde `meta.dfId/ordId` e disponibil) ca PLASĂ. Logica owner-ului: „dacă DF-ul ajunge în flux prin calea sigură (POST /flows), atunci și atașamentele ajung pe aceeași cale" — exact ca PDF-ul. `linkFlowFormular` RĂMÂNE (redundanță intenționată, idempotentă prin `NOT EXISTS`).
   - Fix 7 scosese copierea de aici pe motiv GREȘIT („meta.dfId/ordId efemer/absent"). DB-ul dovedește că `meta.dfId` CHIAR ajunge (de-aia se setează `flow_id`). Readusă, dar CU `await` și ca PLASĂ, nu unic punct.

## ⚠️ PROTECȚIA SURSEI (cerută explicit de owner) — formulare_atasamente NU se pierde
Atașamentele DF din `formulare_atasamente` trebuie să rămână NEATINSE după copiere, după aprobare, după ștergere flux.
- VERIFICAT deja: nicio cale de flux (`server/routes/flows/`) nu atinge `formulare_atasamente`. Singurul `UPDATE ... deleted_at` pe ea e `formulare/shared.mjs:284` = ștergere MANUALĂ de user (cu lacăt `document_locked` pe completed/aprobat), NEdeclanșată de flux.
- Copierea e `INSERT ... SELECT` (helper `copyFormularAttachmentsToFlow`, formular-flow-attachments.mjs:33) — **DUPLICĂ** bytes-ul în `flow_attachments`, NU mută, NU rereferențiază. Sursa rămâne.
- Helper-ul `copyFormularAttachmentsToFlow` rămâne NEATINS.

## DIAGNOSTIC (read-only, confirmă înainte de fix)
```
grep -n "flow_id = \$1\|body.meta\|\.catch(e =>" server/routes/flows/crud.mjs | head   # confirmă 392/398 ne-await
sed -n '33,70p' server/services/formular-flow-attachments.mjs                          # confirmă INSERT...SELECT (duplică, nu mută; idempotent NOT EXISTS)
grep -rn "formulare_atasamente" server/routes/flows/                                    # trebuie GOL (nimic din flux nu atinge sursa)
```
Raportează: (a) 392/398 ne-await confirmat; (b) helper-ul duplică (INSERT...SELECT) și e idempotent; (c) niciun rezultat la al treilea grep (sursa e sigură).

## Fix — `server/routes/flows/crud.mjs`
1. Import: adaugă `import { copyFormularAttachmentsToFlow } from '../../services/formular-flow-attachments.mjs';` (fix 7 îl scosese).
2. `await` pe pre-setarea flow_id:
   - linia 392: `await pool.query(...)` (formulare_df)
   - linia 398: `await pool.query(...)` (formulare_ord)
3. Copiere idempotentă ca plasă, după pre-set (înlocuiește comentariul fix 7 de la 403-407):
```
// fix 11 (B+): copiere atașamente formular→flux ca PLASĂ, idempotentă (INSERT...SELECT — DUPLICĂ,
// nu mută; NOT EXISTS împiedică dublarea față de linkFlowFormular). Readusă aici fiindcă meta.dfId/
// ordId CHIAR ajunge (de-aia s-a setat flow_id mai sus). Sursa formulare_atasamente rămâne neatinsă.
if (body.meta?.dfId && pool) {
  try { await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: body.meta.dfId }); }
  catch (e) { logger.warn({ err: e }, 'copy df attachments net non-fatal'); }
}
if (body.meta?.ordId && pool) {
  try { await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'ord', formId: body.meta.ordId }); }
  catch (e) { logger.warn({ err: e }, 'copy ord attachments net non-fatal'); }
}
```
4. `linkFlowFormular` (formular-shared.mjs) NEATINS — rămâne ca a doua cale, idempotentă.

## Teste (DB caracterizare)
- **Copiere pe lansare:** POST /flows cu `meta.dfId` pentru un DF cu 2 atașamente → `flow_attachments` pentru flux conține 2; `formAttachmentsCopied`/efect vizibil. ORD simetric.
- **PROTECȚIA SURSEI (cerut owner):** după copiere → `formulare_atasamente` pentru DF NEATINS (aceleași rânduri, `deleted_at` NULL). După tranziție la `aprobat` → `formulare_atasamente` NEATINS. După ștergere flux (soft-delete, care șterge `flow_attachments`) → `formulare_atasamente` TOT acolo, neatins.
- **Idempotență:** POST /flows copiază, apoi `link-flow` (linkFlowFormular) rulează din nou → `flow_attachments` tot 2 (NU 4, `NOT EXISTS` blochează dublarea).
- `npm test` verde — confirmă în CI (testele DB rulează doar acolo).

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH gol; helper `copyFormularAttachmentsToFlow` neatins; `linkFlowFormular` neatins.
- Atașamentele apar în flux pe lansare (DF + ORD, standalone și ALOP); `formulare_atasamente` dovedit neatins după aprobare/ștergere.
- Bump `package.json` patch. (Backend-only → fără cache-bust assets.)
- CLAUDE.md: o linie („POST /flows: pre-setarea `formulare_X.flow_id` e `await`-uită (elimină cursa cu linkFlowFormular) + copiere atașamente idempotentă ca plasă (INSERT...SELECT, nu atinge sursa); linkFlowFormular rămâne a doua cale idempotentă").

## Manual staging (proba reală, după CI verde)
DF cu atașament → lansează flux → „Documente suport" în flux listează fișierul + `SELECT ... FROM flow_attachments WHERE flow_id='<nou>'` îl conține. Verifică ȘI: după aprobare/ștergere flux, `SELECT ... FROM formulare_atasamente WHERE form_id='<df>'` rămâne neatins. „Eroare de rețea" la ALOP ar trebui să dispară (copierea reală se face în POST /flows, calea ALOP devine no-op rapid).

## Finalizare
```
git add <fișierele acestei sarcini: crud.mjs, test, CLAUDE.md, package.json>
git commit -m "fix(flux): await pe pre-setarea flow_id + copiere atașamente idempotentă ca plasă în POST /flows — elimină cursa cu linkFlowFormular; sursa formulare_atasamente neatinsă"
git push origin develop
```
