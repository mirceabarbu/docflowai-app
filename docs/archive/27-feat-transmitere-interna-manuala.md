---
feat: Etapa 2b — transmitere internă MANUALĂ (repartizare ad-hoc) pe flux finalizat: rută POST /flows/:id/transmit + buton „📨 Transmite în aplicație" + modal
target_branch: develop
model_suggested: Opus 4.8 (rută nouă cu authz de obiect + wiring de injectare — plus modal frontend)
risk: MEDIU (rută nouă + montare în flows/index + frontend) — aditiv, refolosește motorul din Etapa 1 și pattern-ul DFEmailModal
version: 3.9.606 → 3.9.607
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop
Motorul de transmitere internă (Etapa 1) + auto-transmit la finalizare (2a) sunt livrate. Acum adăugăm varianta **manuală**: pe un flux **finalizat**, inițiatorul/semnatarul/adminul poate repartiza ad-hoc documentul semnat către un **utilizator SAU un compartiment**, cu **rezoluție** — direct prin aplicație (analog cu „Trimite email extern", dar intern). Refolosește serviciul `flow-transmit.mjs` și pattern-ul `DFEmailModal`.

# 🚫 NO-TOUCH
Semnare integral (`cloud-signing.mjs`, `bulk-signing.mjs`, `signing.mjs`, `pades.mjs`, `STSCloudProvider.mjs`, `java-pades-client.mjs`). Financiar ALOP. `flow-transmit.mjs` și `flow-access.mjs` — doar IMPORTATE, neschimbate. `df-email-modal.js` — doar model de citit, NU-l modifica.

# Etapa 0 — caracterizare
```bash
# Pattern injectare deps (oglindă pentru transmit.mjs):
sed -n '28,40p' server/routes/flows/email.mjs
# Montare + injectFlowDeps în flows/index.mjs:
grep -n "_inj\|router.use('/', .*Router)\|injectFlowDeps" server/routes/flows/index.mjs
# Serviciul de transmitere (semnături exacte):
grep -n "export function normalizeRecipients\|export async function transmitFlowTo\|export async function resolveRecipientEmails" server/services/flow-transmit.mjs
# authz de obiect (bara pt trimitere = ca la send-email):
grep -n "export function canActorReadFlow" server/services/flow-access.mjs
# Frontend: butonul email + gating completed + include modal:
grep -n "btnSendEmail\|DFEmailModal.open\|data.completed" public/js/flow/flow.js | head
grep -n "df-email-modal.js\|btnSendEmail\|flow/flow.js?v=" public/flow.html
# Endpointul de useri folosit de initiator (refolosit în picker):
grep -n "_apiFetch('/users')" public/js/semdoc-initiator/main.js | head -1
```
Confirmă: câmpul de id al actorului (`actor.userId` vs `actor.id`) folosit ca `transmittedBy`; forma răspunsului `/users` (are `id`, `nume`/`name`, `email`, `compartiment`).

# Implementare — BACKEND

## 1. `server/routes/flows/transmit.mjs` (NOU)
Oglindește structura `email.mjs` (Router + `_injectDeps` pentru `notify`):
```js
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { pool, requireDb, getFlowData, writeAuditEvent } from '../../db/index.mjs';
import { canActorReadFlow } from '../../services/flow-access.mjs';
import { normalizeRecipients, transmitFlowTo, resolveRecipientEmails } from '../../services/flow-transmit.mjs';
import { logger } from '../../middleware/logger.mjs';

const router = Router();
let _notify;
export function _injectDeps(d) { _notify = d.notify; }

router.post('/flows/:flowId/transmit', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!data.completed && data.status !== 'completed')
      return res.status(409).json({ error: 'not_completed', message: 'Documentul nu este finalizat.' });
    // authz de obiect — aceeași bară ca trimiterea externă (inițiator/semnatar/admin same-org)
    if (!canActorReadFlow(actor, data, null))
      return res.status(403).json({ error: 'forbidden', message: 'Nu ai drept să transmiți acest document.' });

    const recipients = normalizeRecipients(req.body?.recipients);
    if (!recipients.length)
      return res.status(400).json({ error: 'no_recipients', message: 'Lipsesc destinatari valizi.' });

    const newly = await transmitFlowTo(pool, {
      flowId, orgId: data.orgId || null, recipients,
      transmittedBy: actor.userId || actor.id || null, source: 'manual',
    });
    const targets = await resolveRecipientEmails(pool, newly);
    for (const t of targets) {
      if (!t.email) continue;
      await _notify({ userEmail: t.email, flowId, type: 'REPARTIZAT',
        title: '📨 Document repartizat',
        message: `Documentul „${data.docName || 'document'}" v-a fost transmis spre luare la cunoștință.` });
    }
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_TRANSMITTED',
      actorEmail: actor.email, payload: { count: newly.length, source: 'manual' } });

    return res.json({ ok: true, added: newly.length, alreadyPresent: recipients.length - newly.length });
  } catch (e) {
    logger.error({ err: e }, 'POST /flows/:flowId/transmit error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
```
(Adaptează `transmittedBy` la câmpul real confirmat în Etapa 0.)

## 2. `server/routes/flows/index.mjs` — montare + injectare
- import: `import transmitRouter, { _injectDeps as _injTransmit } from './transmit.mjs';`
- montare (după emailRouter): `router.use('/', transmitRouter);`
- în `injectFlowDeps`: adaugă `_injTransmit(deps);`

# Implementare — FRONTEND

## 3. `public/js/df-transmit-modal.js` (NOU — oglindă simplificată a `df-email-modal.js`)
`window.DFTransmitModal = { open, close }`. `open(flowId, { docName, onSuccess })`:
- randează un modal (clasă `dft-open`, backdrop, close pe Escape/click-backdrop — ca `dfem-open`).
- la deschidere, `fetch('/users', { credentials:'include' })` → populează:
  - un `<select>` „Tip destinatar": `Utilizator` / `Compartiment`;
  - `<select>` utilizator: `<option value="<id>">Nume — email</option>` din lista `/users`;
  - `<select>` compartiment: valorile distincte, ne-goale, sortate de `compartiment` din `/users`;
  - `<textarea maxlength="2000">` rezoluție (opțional).
- Submit → `POST /flows/${flowId}/transmit` cu body `{ recipients: [{ type, value, rezolutie }] }`:
  - `type:'user'` → `value: Number(userId)`; `type:'comp'` → `value: <compartiment>`; `rezolutie` din textarea.
  - la 200: mesaj succes („Transmis — N destinatar(i)"), apel `onSuccess?.()`, close.
  - la 400/403/409: afișează mesajul din răspuns.
- CSS minimal scoped `.dft-*` (poți refolosi variabilele/design tokens existente). Fără inline handlers (CSP-safe): `addEventListener`.

## 4. `public/flow.html`
- include (lângă `df-email-modal.js`): `<script src="/js/df-transmit-modal.js?v=3.9.607" defer></script>`
- adaugă un buton lângă butonul de email/raport (în aceeași zonă de acțiuni), inițial ascuns:
  `<button class="df-action-btn" id="btnTransmit" style="display:none;" title="Transmite documentul în aplicație">📨 Transmite în aplicație</button>`

## 5. `public/js/flow/flow.js`
- În zona unde se gestionează vizibilitatea butoanelor pe `data.completed` (lângă logica `btnSendEmail`/`btnTrustReport`, ~639), arată `#btnTransmit` DOAR când `data.completed` (documentul e finalizat).
- Wire (lângă `_btnSendEmail`): 
  ```js
  const _btnTransmit = $("btnTransmit");
  if (_btnTransmit) _btnTransmit.addEventListener("click", () => {
    window.DFTransmitModal?.open(flowId, { docName: d.docName || flowId, onSuccess: () => loadFlow() });
  });
  ```
  (adaptează numele variabilei de date `d`/`data` la ce folosește flow.js în acel scope).

# Teste
## DB — `server/tests/db/flow-transmit-manual.test.mjs` (server/tests/db/**, auto-skip fără TEST_DATABASE_URL)
Pe un flux finalizat:
- inițiator `POST /flows/:id/transmit {recipients:[{type:'user',value:<id>}]}` → 200, `added:1`; rândul apare în `flow_recipients` (source='manual'); destinatarul primește notificare `REPARTIZAT`.
- a doua oară aceiași destinatari → 200, `added:0`, `alreadyPresent:1` (idempotent, ON CONFLICT).
- destinatar tip `comp` → 200; toți userii din compartiment primesc `REPARTIZAT`.
- **străin autentificat → 403**; **flux nefinalizat → 409**; **recipients gol/invalid → 400**; anonim → 401.

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/routes/flows/transmit.mjs` (nou), `server/routes/flows/index.mjs`, `public/js/df-transmit-modal.js` (nou), `public/flow.html`, `public/js/flow/flow.js`, `public/sw.js`, `server/tests/db/flow-transmit-manual.test.mjs` (nou), `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|flow-transmit\.mjs|flow-access\.mjs|df-email-modal\.js|alop\.mjs" && echo "⛔ STOP: zonă interzisă/model!" || echo "✅ NO-TOUCH ok"
```

# Cache busting + versiune
- bump `package.json` 3.9.606 → 3.9.607;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.607` pe `flow/flow.js` și pe noul `df-transmit-modal.js` în `public/flow.html`.

# La final
```bash
git add server/routes/flows/transmit.mjs server/routes/flows/index.mjs public/js/df-transmit-modal.js public/flow.html public/js/flow/flow.js public/sw.js server/tests/db/flow-transmit-manual.test.mjs package.json
git commit -m "feat(flows): transmitere internă manuală (repartizare ad-hoc) pe flux finalizat — rută + buton + modal (v3.9.607)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Ruta montată corect; authz `canActorReadFlow` (străin→403, nefinalizat→409, gol→400); NO-TOUCH respectat.
2. Idempotență (a doua transmitere → added:0); notificare `REPARTIZAT` per destinatar (user + expansiune compartiment).
3. Buton vizibil doar pe flux finalizat; modal fără inline handlers (CSP-safe).
4. Status CI (`npm test` + `npm run check`); versiune 3.9.607.
5. Verificare staging: pe un flux finalizat, apeși „📨 Transmite în aplicație", alegi un compartiment + rezoluție → un user din acel compartiment (ne-semnatar) primește notificarea și deschide documentul.

# Ce urmează (Etapa 2c — prompt separat)
Tab „Primite / Repartizate mie" (`GET /api/my-received`) + buton „Confirm luare la cunoștință" (`POST /flows/:id/acknowledge` → `acknowledged_at`).
