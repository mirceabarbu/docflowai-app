---
fix: 10 — Cauza rădăcină atașamente: guard `already_on_flow` din linkFlowFormular blochează copierea pe ORICE lansare
target_branch: develop
model_suggested: Opus 4.8 (corecție logică de guard + test care reproduce ordinea reală + posibil efect asupra „eroare de rețea")
risk: MEDIU — atinge guard-ul de link; helper-ul de copiere rămâne neatins
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol. Helper `copyFormularAttachmentsToFlow` NEATINS.

## Cauză rădăcină (dovedită în DB + sursă)
Dovadă DB: DF `3ed57eb5…` are atașament (`Asigurare RCA.pdf`), e legat de flux `PT_22DB8A083F`, dar `flow_attachments` pentru acel flux = 0 rânduri. Atașament prezent + flux legat + 0 copiat = copierea NU a rulat.

Cauza, confirmată în sursă:
1. `POST /flows` (`crud.mjs:391-402`) setează el `formulare_df.flow_id` / `formulare_ord.flow_id` din `body.meta.dfId/ordId`, **la creare**, înainte de `link-flow`. (NU setează status, NU copiază — fix 7 a scos copierea de aici.)
2. Apoi frontend-ul cheamă `/api/formulare-{df,ord}/:id/link-flow` → `linkFlowFormular` (`formular-shared.mjs`). Guard-ul de la **506-517** verifică: `if (doc.flow_id)` → fluxul referit e activ (non-terminal)? → DA (tocmai creat) → **`return 409 already_on_flow`**.
3. Copierea de la `formular-shared.mjs:542` NU se atinge niciodată.

Guard-ul menit să blocheze relegarea pe un flux **zombi DIFERIT** se declanșează din greșeală pe **același** flux pe care `crud.mjs` tocmai l-a legat. Deci copierea din `linkFlowFormular` (fix 7) e **moartă pe ORICE lansare**. Fix 8 a salvat doar calea ALOP (copiere în `alop.mjs`); pe DF/ORD standalone nu copiază nimeni.

## Diagnostic de confirmare (înainte de fix — read-only, în cod)
```
# confirmă pre-set-ul flow_id în crud.mjs
grep -n "formulare_df SET flow_id\|formulare_ord SET flow_id\|body.meta" server/routes/flows/crud.mjs | head
# confirmă guard-ul 506 (already_on_flow) și că precede copierea (542)
grep -n "already_on_flow\|alreadyOnFlowError\|doc.flow_id\|copyFormularAttachmentsToFlow" server/services/formular-shared.mjs
```
Confirmă în raport: guard-ul 506 verifică DOAR `doc.flow_id` activ, fără să excludă cazul `doc.flow_id === flow_id` (fluxul curent). Asta e bug-ul.

## Fix — guard-ul să nu trateze fluxul CURENT ca zombi
În `formular-shared.mjs`, guard-ul de la ~506:
```
if (doc.flow_id) {                         // ÎNAINTE
if (doc.flow_id && doc.flow_id !== flow_id) {   // DUPĂ
```
Adică: 409 `already_on_flow` DOAR dacă documentul e deja pe un flux **DIFERIT** activ. Dacă `doc.flow_id === flow_id` (fluxul tocmai creat de `crud.mjs`, pe care tocmai îl legăm), guard-ul se sare → `linkFlowFormular` continuă → setează `status='transmis_flux'` (DF) + **rulează copierea (542)**. Idempotent (NOT EXISTS), deci nu strică nimic dacă crud.mjs a pre-setat exact acel flow_id.

Verifică: `flow_id` (din body) și `doc.flow_id` (din SELECT) sunt ambele disponibile la acel punct (sunt — body la 485, doc.flow_id în `doc`).

## Efect lateral așteptat asupra „eroare de rețea" la ALOP (issue B)
Înainte de fix: `linkFlowFormular` (pas 2) dă 409 → prima copiere reală (mutare bytes) e abia în `alop.mjs link-ord-flow` (pas 4, fix 8), `await`-uită înainte de `res.json` → întârzie răspunsul → frontend-ul raportează „eroare de rețea". DUPĂ fix: pas 2 copiază → pas 4 găsește totul copiat (`NOT EXISTS`) → no-op rapid → B ar trebui să dispară. **NU modifica `alop.mjs` în acest fix** — doar retestează B după fix 10. Dacă B persistă, îl investigăm separat (logurile serverului pe `link-ord-flow`).

## Test — TREBUIE să reproducă ORDINEA REALĂ (altfel „verde dar greșit")
Test DB nou (sau extinde cel existent) care simulează lansarea:
1. creează DF `completed` cu 1 atașament în `formulare_atasamente`;
2. creează flux;
3. **setează `formulare_df.flow_id = flowId` ÎNAINTE** de link (mimează `crud.mjs:393`) — pasul critic care reproduce bug-ul;
4. apelează `linkFlowFormular({ type:'df', id, actor, body:{ flow_id: flowId } })`;
5. assert: răspuns **200** (NU 409 already_on_flow), `formAttachmentsCopied >= 1`, și `flow_attachments` pentru flux conține atașamentul.
- Caz de non-regresie a guard-ului: `doc.flow_id` = un flux DIFERIT activ → tot 409 `already_on_flow` (guard-ul real rămâne funcțional).
- ORD simetric.
⚠️ Fără pasul 3 (flow_id pre-setat la fluxul curent), testul NU reproduce bug-ul și ar trece fals verde. Acesta e exact tiparul de evitat.

## Acceptare
- `npm test` verde, fără regresii — **inclusiv în CI** (testul DB rulează doar în CI; „verde local" nu e suficient pentru un test DB).
- `git diff` NO-TOUCH gol; helper neatins; `alop.mjs` neatins.
- CLAUDE.md: o linie („guard `already_on_flow` din linkFlowFormular exclude fluxul curent (`doc.flow_id !== flow_id`) — altfel `crud.mjs` pre-setează flow_id și guard-ul 409-uie pe propriul flux → copierea nu rula pe nicio lansare").
- Bump `package.json` patch.

## Manual staging (proba reală, după CI verde)
DF cu atașament → lansează flux → „Documente suport" în fluxul creat listează atașamentul. Verifică ȘI că „eroare de rețea" la ALOP NU mai apare. Repetă pe ORD ALOP.

## Finalizare
```
git add <doar fișierele acestei sarcini: formular-shared.mjs, test, CLAUDE.md, package.json>
git commit -m "fix(flux): linkFlowFormular nu mai tratează fluxul curent ca zombi (already_on_flow) — copierea atașamentelor rulează pe orice lansare (cauză rădăcină)"
git push origin develop
```
