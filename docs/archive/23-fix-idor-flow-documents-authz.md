---
fix(sec): IDOR pe documente de flux — GET signed-pdf / pdf / attachments aplică acum authz la nivel de obiect (canActorReadFlow ∪ destinatar)
target_branch: develop
model_suggested: Opus 4.8 (întărire de authz pe endpointuri care servesc PDF-uri financiare — greșeala taie fie semnatarii legitimi, fie lasă gaura deschisă)
risk: MEDIU-RIDICAT (authz tightening pe servire documente) — mitigat prin caracterizare + teste ACL exhaustive
version: 3.9.602 → 3.9.603
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (IDOR pre-existent)
`GET /flows/:flowId/signed-pdf`, `GET /flows/:flowId/pdf`, `GET /flows/:flowId/attachments` și `GET /flows/:flowId/attachments/:attId` verifică doar „există actor SAU token de semnatar valid". Dacă `actor` e prezent (ORICE user autentificat), servesc PDF-ul semnat / atașamentele **fără** să verifice că acel user are drept pe flux. Rezultat: orice cont autentificat descarcă documente financiare ale oricărui flux dacă știe `flowId`. `GET /flows/:flowId` (metadata) e deja corect (folosește `canActorReadFlow` din v3.9.502) — endpointurile de conținut au rămas în urmă.

# 🎯 Scop
Aliniază cele 4 endpointuri la aceeași poartă ca `GET /flows/:flowId`, extinsă cu ramura „destinatar" din Etapa 1: **acces = `canActorReadFlow(actor, data, signerToken)` ∪ (actor && `isFlowRecipient`)**. Închide IDOR-ul ȘI păstrează accesul destinatarului repartizat.

# 🚫 NO-TOUCH
Semnare integral (`cloud-signing.mjs`, `bulk-signing.mjs`, `signing.mjs`, `pades.mjs`, `STSCloudProvider.mjs`, `java-pades-client.mjs`). Calcule financiare ALOP. `flow-transmit.mjs` (Etapa 1) — doar îl IMPORȚI (`isFlowRecipient`), nu-l modifici. Semnătura publică a `canActorReadFlow` (parametri, semantică) rămâne identică — doar îi schimbi locația.

# ⚠️ Reguli critice de non-regresie (verifică-le explicit)
Poarta NOUĂ trebuie să lase să treacă EXACT cazurile legitime de azi:
- **Semnatar cu token** (pagina semnatarului fetch-uiește `/pdf` și `/signed-pdf` cu `?token=` sau header `X-Signer-Token`) → `canActorReadFlow` întoarce true pe token match. NU rupe asta.
- **Semnatar logat fără token** (după email) → true prin `isSigner`.
- **Inițiator** → true.
- **Admin/org_admin din aceeași org** → true (parametru cu `GET /flows/:flowId` existent — NU acorda cross-org).
- **Destinatar repartizat** (user sau compartiment, ne-semnatar) → true prin `isFlowRecipient`.
- **Orice alt user autentificat / anonim fără token** → 403 (ăsta e fix-ul).

# Etapa 0 — caracterizare (OBLIGATORIU)
```bash
# Corpul actual al celor 4 endpointuri + garda slabă:
sed -n '491,572p' server/routes/flows/crud.mjs
sed -n '93,145p' server/routes/flows/attachments.mjs
# canActorReadFlow (de mutat):
sed -n '44,58p' server/routes/flows/crud.mjs
# import-uri existente în ambele fișiere (pool, getFlowData, getOptionalActor):
grep -n "getOptionalActor\|getFlowData\|^import\|isFlowRecipient\|from '../../db" server/routes/flows/crud.mjs | head
grep -n "getOptionalActor\|getFlowData\|pool\b\|^import\|function getOptionalActor" server/routes/flows/attachments.mjs | head
# Cine mai apelează INTERN aceste rute prin HTTP (nu trebuie să fie nimeni — codul intern folosește getFlowData direct):
grep -rn "/signed-pdf\|/flows/.*/pdf\b\|/attachments" server/ public/js/ 2>/dev/null | grep -v node_modules | grep -iE "fetch|await.*http|axios" | head
# Testul ACL existent (stil de urmat):
sed -n '1,90p' server/tests/integration/flow-acl-canread.test.mjs
```
Raportează: liniile exacte ale gărzii slabe în fiecare rută; dacă `attachments.mjs` are `pool` și `getFlowData` importate; dacă vreun apel INTERN prin HTTP la aceste rute ar putea fi afectat (aștept: niciunul).

# Implementare

## 1. Modul nou `server/services/flow-access.mjs`
Mută `canActorReadFlow` din `crud.mjs` aici (identic, exportat) și adaugă poarta combinată:
```js
import { isFlowRecipient } from './flow-transmit.mjs';

// Mutat din crud.mjs — semantică identică (init | semnatar | admin same-org | signer token)
export function canActorReadFlow(actor, data, signerToken) {
  if (signerToken && (data.signers || []).some(s => s.token === signerToken)) return true;
  if (!actor) return false;
  const email = String(actor.email || '').toLowerCase();
  const isInit = String(data.initEmail || '').toLowerCase() === email;
  const isSigner = (data.signers || []).some(s => String(s.email || '').toLowerCase() === email);
  const sameOrg = actor.orgId && data.orgId && String(actor.orgId) === String(data.orgId);
  const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
  return isInit || isSigner || (isAdmin && sameOrg);
}

// Poarta la nivel de obiect pentru vizualizare flux + conținut (signed-pdf/pdf/attachments)
export async function isFlowAccessAllowed(pool, actor, data, signerToken) {
  if (canActorReadFlow(actor, data, signerToken)) return true;
  if (!actor || !data?.flowId) return false;
  return await isFlowRecipient(pool, data.flowId, actor);
}
```
(Verifică în Etapa 0 că `data.flowId` e câmpul corect — dacă getFlowData întoarce `flowId`, ok; altfel folosește `data.id`.)

## 2. `server/routes/flows/crud.mjs`
- Șterge definiția locală `canActorReadFlow` (liniile ~44–58) și importă din noul modul:
  `import { canActorReadFlow, isFlowAccessAllowed } from '../../services/flow-access.mjs';`
- **GET /flows/:flowId** (handlerul `getFlowHandler`): înlocuiește checkul introdus în Etapa 1 (`canActorReadFlow(...) || isFlowRecipient(...)`) cu forma unificată:
  ```js
  if (!(await isFlowAccessAllowed(pool, actor, data, signerToken))) return res.status(403).json({ error: 'forbidden' });
  ```
  (comportament identic, doar consolidat).
- **GET /flows/:flowId/signed-pdf** și **GET /flows/:flowId/pdf**: după `const data = await getFlowData(...)` și guardul `if (!data) return 404`, ÎNLOCUIEȘTE garda slabă (`if (!actor && signerToken && !tokenMatch) ...` + servirea necondiționată pentru actor) cu:
  ```js
  if (!(await isFlowAccessAllowed(pool, actor, data, signerToken))) {
    return res.status(403).json({ error: 'forbidden', message: 'Acces interzis la acest document.' });
  }
  ```
  Păstrează fast-fail-ul ieftin de la început (`if (!actor && !signerToken) return 403`) ca să eviți o interogare DB pentru anonimi fără token. NU schimba restul (streaming Drive, base64, headers).

## 3. `server/routes/flows/attachments.mjs`
- Importă `isFlowAccessAllowed` din `../../services/flow-access.mjs` și asigură-te că `pool` e disponibil (dacă nu e importat, importă `pool` din `../../db/index.mjs`).
- În **GET /flows/:flowId/attachments** și **GET /flows/:flowId/attachments/:attId**: după încărcarea `data`, înlocuiește garda slabă cu:
  ```js
  if (!(await isFlowAccessAllowed(pool, actor, data, signerToken))) return res.status(403).json({ error: 'forbidden' });
  ```
  Păstrează fast-fail-ul anonim fără token. **NU** atinge rutele POST/DELETE de atașamente (au deja `isInit && isAdmin` — corect pentru scriere).

# Teste
## Unit — `server/tests/unit/flow-access.test.mjs`
`canActorReadFlow` (pur): init→true; semnatar după email→true; token match→true; admin same-org→true; admin cross-org→false; străin→false; anonim fără token→false.

## DB — `server/tests/db/flow-doc-acl.test.mjs` (server/tests/db/**, auto-skip fără TEST_DATABASE_URL — sursă de adevăr CI, per disciplina „No Docker for test:db")
Pentru fiecare din `signed-pdf`, `pdf`, `attachments` (list), `attachments/:attId`:
- **străin autentificat → 403** (înainte de fix era 200 — testul de non-regresie al IDOR-ului; ăsta e miezul).
- inițiator → 200; admin same-org → 200; semnatar via token → 200; **destinatar repartizat (user) → 200**; **destinatar prin compartiment → 200**; anonim fără token → 403.
Folosește helperele de setup din `flow-acl-canread.test.mjs` (flux + org + useri). Include un flux cu `flow_recipients` (insert direct sau via `transmitFlowTo`) pentru cazurile de destinatar.

`npm test verde, fără regresii`. `npm run check` OK. Rulează și `flow-acl-canread.test.mjs` existent — trebuie să rămână verde (mutarea funcției nu-i schimbă comportamentul HTTP).

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/services/flow-access.mjs` (nou), `server/routes/flows/crud.mjs`, `server/routes/flows/attachments.mjs`, `server/tests/unit/flow-access.test.mjs` (nou), `server/tests/db/flow-doc-acl.test.mjs` (nou), `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|flow-transmit\.mjs|alop\.mjs" && echo "⛔ STOP: zonă interzisă!" || echo "✅ NO-TOUCH respectat"
# Verifică echivalența canActorReadFlow (nicio schimbare de logică la mutare):
git diff server/routes/flows/crud.mjs | grep -n "canActorReadFlow" | head
```
Backend-only → **fără** `?v=`/`CACHE_VERSION` în `sw.js`. Doar bump `package.json` (3.9.602 → 3.9.603).

# La final
```bash
git add server/services/flow-access.mjs server/routes/flows/crud.mjs server/routes/flows/attachments.mjs server/tests/unit/flow-access.test.mjs server/tests/db/flow-doc-acl.test.mjs package.json
git commit -m "fix(sec): închide IDOR pe documente flux — signed-pdf/pdf/attachments aplică authz obiect (canActorReadFlow ∪ destinatar) (v3.9.603)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Guardrail NO-TOUCH (semnare + financiar + flow-transmit neatinse).
2. `canActorReadFlow` mutat fără schimbare de semantică (test unit + `flow-acl-canread` verzi).
3. Cele 4 endpointuri: străinul autentificat primește acum 403 (era 200); inițiator/admin-same-org/semnatar-token/destinatar(user+comp) → 200; anonim fără token → 403.
4. Confirmare că niciun apel INTERN prin HTTP la aceste rute nu a fost afectat (semnatarii folosesc token; codul intern folosește getFlowData direct).
5. Status CI (`npm test` verde + `npm run check`).

# Ce urmează (Etapa 2b, prompt separat — NU acum)
Rută manuală `POST /flows/:id/transmit` (repartizare ad-hoc pe fluxuri finalizate) + buton „📨 Transmite în aplicație" în `flow.js` + tab „Primite / Repartizate mie" + „Confirm luare la cunoștință" (`acknowledged_at`).
