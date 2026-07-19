# PROMPT — v3.9.502 — Security P0 audit fixes: STS fail-closed + download fix + ACL leak + CSRF gap

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.501 e merge-uit pe develop și `git pull origin develop` rulat local.

---

## ⚠️ AUTORIZARE EXPRESĂ NO-TOUCH OVERRIDE

Acest sprint atinge `server/routes/flows/cloud-signing.mjs` — în lista NO-TOUCH istorică. Autorizare expresă acordată de utilizator pentru acest sprint specific, ÎNGUST.

**Ce e PERMIS modificat în `cloud-signing.mjs`:**
- EXCLUSIV blocul `catch(padesErr) {...}` din handlerul `/sts-poll` (linii 446-448 actual, 5 linii)

**Ce rămâne ABSOLUT INTACT în `cloud-signing.mjs`:**
- Blocul `try { if (hasJavaSigningService()) {...} else {...} }` (linii 403-445)
- Apelurile `javaFinalizePades`, `injectCms`, manipularea certPem/certChainPem
- `_finalizeFieldName` logic, `fieldAlreadyExists`, ECDSA r‖s → DER, ByteRange
- Curățarea `delete data[\`_padesPdf_${idx}\`]` etc. în finally
- Restul rutei (poll status, signer state machine, advance flow, FLOW_COMPLETED)

Modificare totală în cloud-signing.mjs: ~15 linii (înlocuim 5 linii cu 20).

---

## CONTEXT — 4 issue-uri P0/P1 din audit

### Issue A-1 (P0 CRITIC) — STS PAdES fallback periculos
`cloud-signing.mjs:446-448` actual:
```js
} catch(padesErr) {
  logger.error({ err: padesErr, flowId }, 'PAdES finalize error — fallback la pdfB64 (cu tabel)');
  signedPdfB64 = (data.pdfB64 || '').includes(',') ? data.pdfB64.split(',')[1] : (data.pdfB64 || '');
}
```
Dacă Java service eșuează / `injectCms` throw → `signedPdfB64` devine PDF-ul ORIGINAL nesemnat. Apoi liniile 454-502 marchează `signers[idx].status='signed'`, adaugă event SIGNED, salvează PDF, eventual FLOW_COMPLETED. **Pentru un produs QES, marchează semnătură calificată reușită fără ca PDF-ul să conțină vreo semnătură.** Prejudiciu juridic real în producție.

Fix: fail closed — status=`error`, event SIGN_FAILED, response 502, lasă semnatarul/admin să reîncerce. NICIODATĂ nu salvăm PDF nesemnat ca signed.

### Issue A-2 (P0) — Download endpoint rupt + runtime error
`crud.mjs:728-750` actual:
```js
const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [req.params.flowId]);
const d = rows[0]?.data;
...
const safeName = safeDocName(data.docName, req.params.flowId || data.flowId || '');  // ❌ data nedefinit
```
Două bug-uri compuse: query direct ratează arhitectura `flows_pdfs` (signedPdfB64 separat), iar `data` în loc de `d` aruncă `ReferenceError` garantat la runtime → 500. Plus: `safeName` calculat dar nefolosit în Content-Disposition.

Fix: `getFlowData()` rehidratează corect; `d` consecvent; folosește `safeName` în filename.

### Issue A-3 (P0) — ACL leak GET /flows/:flowId
`crud.mjs:500-507`: dacă există `actor` autentificat, NU se verifică nimic suplimentar. **Orice user logged-in din orice organizație poate cere orice flowId** și primește metadata (signers, events, institutie, compartiment) — PDF/tokens strippate. Leak GDPR pentru platformă government.

Fix: helper `canActorReadFlow(actor, data, signerToken)` aplicat în handler. Reguli:
- Signer token valid → permis
- Actor === initiator → permis
- Actor în lista de signers → permis
- Actor admin/org_admin **și** orgId-uri match → permis
- Altfel → 403

### Issue A-4 (P1) — CSRF lipsă pe `/auth/change-password`
`auth.mjs:262`: `router.post('/auth/change-password', async (req, res) => {` — fără `_csrf` middleware. Vector CSRF pentru schimbare parolă.

Fix: adaugă `_csrf` ca middleware. Una linie.

============================================================
## PAS 1 — Fix STS fail-closed în `server/routes/flows/cloud-signing.mjs`

Localizează blocul `catch(padesErr) { ... }` la linia 446-448. Cod actual:

```js
    } catch(padesErr) {
      logger.error({ err: padesErr, flowId }, 'PAdES finalize error — fallback la pdfB64 (cu tabel)');
      signedPdfB64 = (data.pdfB64 || '').includes(',') ? data.pdfB64.split(',')[1] : (data.pdfB64 || '');
    } finally {
      delete data[`_padesPdf_${idx}`];
      delete data[`_signedAttrs_${idx}`];
    }
```

Înlocuiește **DOAR** acest bloc (cu păstrarea integrală a blocului `finally`) cu:

```js
    } catch(padesErr) {
      // v3.9.502 (A-1 P0 CRITIC): fail CLOSED. Înainte: fallback la pdfB64 original
      // (nesemnat) + marcare 'signed' — produsul QES marca semnături calificate
      // reușite pentru documente fără nicio semnătură embedată. Prejudiciu juridic.
      // Acum: status='error' pe semnatar, event SIGN_FAILED, response 502.
      // Semnatarul/adminul pot reîncerca. PDF-ul NU se salvează ca signed.
      logger.error({ err: padesErr, flowId, signerIdx: idx, signerEmail: signer.email },
        'PAdES finalize FAILED — fail closed, semnătura NU se înregistrează');

      signers[idx].stsPending     = false;
      signers[idx].status         = 'error';
      signers[idx].signError      = 'pades_finalize_failed';
      signers[idx].signErrorAt    = new Date().toISOString();
      signers[idx].signErrorMessage = String(padesErr?.message || padesErr).slice(0, 500);

      data.signers    = signers;
      data.updatedAt  = new Date().toISOString();
      if (!Array.isArray(data.events)) data.events = [];
      data.events.push({
        at: new Date().toISOString(),
        type: 'SIGN_FAILED',
        by: signer.email,
        order: signer.order,
        provider: 'sts-cloud',
        reason: 'pades_finalize_failed',
        message: signers[idx].signErrorMessage,
      });

      // Cleanup PAdES temp data (același comportament ca în finally — îl facem
      // explicit aici pentru că vom face return înainte de finally să ruleze)
      delete data[`_padesPdf_${idx}`];
      delete data[`_signedAttrs_${idx}`];

      await saveFlow(flowId, data);
      writeAuditEvent({
        flowId, orgId: data.orgId, eventType: 'SIGN_FAILED',
        actorEmail: signer.email,
        payload: { provider: 'sts-cloud', reason: 'pades_finalize_failed', message: signers[idx].signErrorMessage }
      });

      return res.status(502).json({
        error: 'pades_finalize_failed',
        message: 'Semnătura STS a fost primită, dar PDF-ul PAdES nu a putut fi finalizat. Reîncercați sau contactați adminul.',
      });
    } finally {
      delete data[`_padesPdf_${idx}`];
      delete data[`_signedAttrs_${idx}`];
    }
```

NB: blocul `finally` rămâne IDENTIC (același 2 delete-uri). Cleanup-ul e dublat — explicit în catch (înainte de return) ȘI în finally (rulează după return). E idempotent (delete pe câmp deja absent = no-op). Asta e intenționat — vrem cleanup garantat indiferent de execution path.

Restul rutei `/sts-poll` (liniile 454-510: marcare signed, evenimente SIGNED, advance flow, FLOW_COMPLETED) **rămâne ATINSĂ** doar dacă `try { ... } catch { return 502; }` nu a returnat. Cu fix-ul, catch return-ează 502 → liniile 454+ nu mai rulează când PAdES eșuează. Comportament corect.

Verifică:
```bash
node --check server/routes/flows/cloud-signing.mjs
grep -n "v3.9.502 (A-1 P0 CRITIC)" server/routes/flows/cloud-signing.mjs
grep -n "fail CLOSED\|pades_finalize_failed" server/routes/flows/cloud-signing.mjs
grep -c "signedPdfB64 = (data.pdfB64" server/routes/flows/cloud-signing.mjs
```

Expected: fără eroare sintaxă; 1 match comentariu; minim 2 match-uri pentru fail-closed concepts; **0 match-uri** pentru fallback-ul vechi `signedPdfB64 = (data.pdfB64` (eliminat complet).

============================================================
## PAS 2 — Fix download endpoint în `server/routes/flows/crud.mjs`

Localizează endpointul de download la linia 723-751. Înlocuiește integral blocul `try { ... } catch(e) { ... }` (de la linia 727 până la 750) cu:

```js
  try {
    // v3.9.502 (A-2 P0): folosim getFlowData() care rehidratează signedPdfB64
    // din flows_pdfs (arhitectură nouă), nu SELECT direct care ratează coloana.
    // Plus fix typo: variabila e `d`, nu `data` (cauza ReferenceError la runtime).
    const d = await getFlowData(req.params.flowId);
    if (!d) return res.status(404).json({ error: 'not_found' });

    const email = (actor.email || '').toLowerCase();
    const isInit = (d.initEmail || '').toLowerCase() === email;
    const isSigner = (d.signers || []).some(s => (s.email || '').toLowerCase() === email);
    const sameOrg = actor.orgId && d.orgId && String(actor.orgId) === String(d.orgId);
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    if (!isInit && !isSigner && !(isAdmin && sameOrg)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    if (!d.signedPdfB64) {
      if (d.storage === 'drive' && d.driveFileIdFinal) {
        try {
          const { streamFromDrive } = await import('../../drive.mjs');
          const safeName = safeDocName(d.docName, req.params.flowId || d.flowId || '');
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
          await streamFromDrive(d.driveFileIdFinal, res);
          return;
        } catch(driveErr) {
          logger.error({ err: driveErr, flowId: req.params.flowId }, 'drive stream failed');
          return res.status(502).json({ error: 'drive_unavailable' });
        }
      }
      return res.status(404).json({ error: 'no_signed_pdf' });
    }

    const buf = Buffer.from(d.signedPdfB64.split(',')[1] || d.signedPdfB64, 'base64');
    const safeName = safeDocName(d.docName, req.params.flowId || d.flowId || '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buf);
  } catch(e) {
    logger.error({ err: e, flowId: req.params.flowId }, 'download endpoint error');
    res.status(500).json({ error: 'server_error' });
  }
```

NB: această implementare include și un ACL check (sameOrg + isAdmin) — anterior download permitea doar isInit||isSigner, blocând adminii din aceeași org. Auditul punctul 3 sugerează consistență. Adăugarea isAdmin+sameOrg e backward compat (mai permisivă, nu mai restrictivă).

Verifică:
```bash
node --check server/routes/flows/crud.mjs
grep -n "v3.9.502 (A-2 P0)" server/routes/flows/crud.mjs
grep -c "data\.docName\|data\.flowId" server/routes/flows/crud.mjs
```

Expected: fără eroare; 1 match comentariu; verificare `data.docName/data.flowId` — count poate fi >0 dacă există alte path-uri legitime cu `data` definit (verifică context). În endpoint-ul download specific, trebuie să NU mai apară `data.docName` sau `data.flowId`.

============================================================
## PAS 3 — Fix ACL pe GET /flows/:flowId în `server/routes/flows/crud.mjs`

Adaugă helper `canActorReadFlow` în fișier, ÎNAINTE de definirea `getFlowHandler` (linia ~497). Caută un loc bun după import-uri și înainte de prima rută. Recomandare: după linia 35 (după `injectFlowDeps`):

```js
// v3.9.502 (A-3 P0): helper centralizat pentru verificare ACL pe flow read access.
// Înainte: GET /flows/:flowId permitea citire pentru ORICE user autentificat → leak
// metadata cross-org (signers, events, institutie). Acum: doar initiator, signer,
// sau admin/org_admin din aceeași org. Plus signer token (pentru semnatari neînregistrați).
function canActorReadFlow(actor, data, signerToken) {
  if (signerToken && (data.signers || []).some(s => s.token === signerToken)) return true;
  if (!actor) return false;
  const email = String(actor.email || '').toLowerCase();
  const isInit = String(data.initEmail || '').toLowerCase() === email;
  const isSigner = (data.signers || []).some(s => String(s.email || '').toLowerCase() === email);
  const sameOrg = actor.orgId && data.orgId && String(actor.orgId) === String(data.orgId);
  const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
  return isInit || isSigner || (isAdmin && sameOrg);
}
```

Apoi în `getFlowHandler` (linia ~497), modifică blocul de verificare actor + signerToken. Înlocuiește:

```js
    const actor = getOptionalActor(req);
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken) {
      if (!(data.signers || []).some(s => s.token === signerToken)) return res.status(403).json({ error: 'forbidden' });
    } else if (!actor) {
      return res.status(401).json({ error: 'unauthorized' });
    }
```

cu:

```js
    const actor = getOptionalActor(req);
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    // v3.9.502 (A-3 P0): verificare ACL prin canActorReadFlow — nu mai e "any logged in user"
    if (!actor && !signerToken) return res.status(401).json({ error: 'unauthorized' });
    if (!canActorReadFlow(actor, data, signerToken)) return res.status(403).json({ error: 'forbidden' });
```

NB: `signerToken` e deja extras din `req.query.token || req.headers['x-signer-token']` mai sus în handler (verifică ~linia 498 context). Dacă nu, citește-l: `const signerToken = req.query.token || req.headers['x-signer-token'];`

Verifică:
```bash
node --check server/routes/flows/crud.mjs
grep -n "function canActorReadFlow\|v3.9.502 (A-3 P0)" server/routes/flows/crud.mjs
```

Expected: fără eroare; 1 match helper; 2 match-uri comentariu v3.9.502 A-3 (declaration + folosire).

============================================================
## PAS 4 — Fix CSRF pe `/auth/change-password` în `server/routes/auth.mjs`

Localizează linia 262: `router.post('/auth/change-password', async (req, res) => {`.

Mai întâi verifică că `_csrf` e importat în fișier:
```bash
grep -n "_csrf\|csrfProtection" server/routes/auth.mjs | head -5
```

Dacă NU e importat, adaugă la lista de import-uri (de obicei după middleware-uri):
```js
import { _csrf } from '../middleware/csrf.mjs';
```

Apoi modifică ruta. Înlocuiește:
```js
router.post('/auth/change-password', async (req, res) => {
```

cu:
```js
// v3.9.502 (A-4 P1): adăugare CSRF — endpoint sensibil (schimbare parolă) lipsea
// protecție anti-CSRF. Vector real pentru attacker care cunoaște email targetului.
router.post('/auth/change-password', _csrf, async (req, res) => {
```

Verifică:
```bash
node --check server/routes/auth.mjs
grep -n "v3.9.502 (A-4 P1)" server/routes/auth.mjs
grep -n "'/auth/change-password'" server/routes/auth.mjs
```

Expected: fără eroare; 1 match comentariu; route conține `_csrf` middleware.

============================================================
## PAS 5 — Tests

### 5.a — `server/tests/integration/sts-pades-failclosed.test.mjs`

Creează:

```js
/**
 * v3.9.502 (A-1 P0 CRITIC) — STS PAdES finalize fail closed
 *
 * Înainte: dacă javaFinalizePades / injectCms throw, blocul catch făcea
 * `signedPdfB64 = data.pdfB64` (PDF original nesemnat), apoi marca
 * signers[idx].status='signed' + event SIGNED + posibil FLOW_COMPLETED.
 * Rezultat: produs QES marca semnături calificate reușite pentru documente
 * complet nesemnate.
 *
 * Acum: catch return 502, status='error', event SIGN_FAILED, fără SIGNED.
 *
 * Acoperire:
 *   ✓ javaFinalizePades throw → 502, signers[idx].status='error', SIGN_FAILED event
 *   ✓ injectCms throw (fallback local) → același comportament
 *   ✓ PDF original NU se salvează ca signedPdfB64
 *   ✓ Niciun event SIGNED, niciun FLOW_COMPLETED
 *   ✓ signError, signErrorAt, signErrorMessage setate pe semnatar
 *   ✓ Happy path (javaFinalizePades success) — flow continuă normal
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId: vi.fn().mockResolvedValue(1),
  DB_LAST_ERROR:   null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

// STSCloudProvider mock — polling returnează semnătura
vi.mock('../../signing/providers/STSCloudProvider.mjs', () => ({
  STSCloudProvider: vi.fn().mockImplementation(() => ({
    pollSignatureResult: vi.fn().mockResolvedValue({
      ready: true,
      signByte: 'AAAA',  // base64 mock
    }),
  })),
}));

// Java client mock — config schimbabil per test
const _javaFinalize = vi.fn();
vi.mock('../../signing/java-pades-client.mjs', () => ({
  javaFinalizePades: (...args) => _javaFinalize(...args),
  hasJavaSigningService: () => true,
}));

import * as dbModule from '../../db/index.mjs';
import cloudSigningRouter from '../../routes/flows/cloud-signing.mjs';

const FLOW_ID = 'FLOW_SF001';
const SIGNER_TOKEN = 'tok-sf-001';

function makeFlowData(overrides = {}) {
  return {
    flowId: FLOW_ID, docName: 'Test', initEmail: 'init@x.ro', orgId: 1,
    status: 'active', completed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [],
    pdfB64: 'data:application/pdf;base64,JVBERi0xLjQK',  // PDF mock original
    signers: [{
      name: 'P1', email: 'p1@x.ro', token: SIGNER_TOKEN,
      status: 'current', order: 1,
      stsPending: true, stsOpId: 'op-1', stsToken: 'st-1', stsSignUrl: 'http://sts.test/u',
      stsCertPem: '-----BEGIN CERTIFICATE-----MOCK-----END CERTIFICATE-----',
      stsCertChain: [],
    }],
    [`_padesPdf_0`]: 'JVBERi0xLjQK',
    [`_signedAttrs_0`]: '3081a3',
    ...overrides,
  };
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/', cloudSigningRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.saveFlow.mockResolvedValue(undefined);
  dbModule.getFlowData.mockReset();
  _javaFinalize.mockReset();
});

describe('STS poll — PAdES fail CLOSED (A-1 P0)', () => {
  it('javaFinalizePades throw → 502 + signers[idx].status=error', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    _javaFinalize.mockRejectedValue(new Error('Java service unreachable'));

    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}/sts-poll?token=${SIGNER_TOKEN}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('pades_finalize_failed');

    // Verificăm că saveFlow a fost apelat cu signer în status='error'
    const saveCalls = dbModule.saveFlow.mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    const lastSave = saveCalls[saveCalls.length - 1];
    const savedData = lastSave[1];
    expect(savedData.signers[0].status).toBe('error');
    expect(savedData.signers[0].signError).toBe('pades_finalize_failed');
    expect(savedData.signers[0].signErrorMessage).toMatch(/Java service unreachable/);
    expect(savedData.signers[0].stsPending).toBe(false);
  });

  it('PDF original NU se salvează ca signedPdfB64 când Java fail', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    _javaFinalize.mockRejectedValue(new Error('boom'));

    await request(createTestApp())
      .get(`/flows/${FLOW_ID}/sts-poll?token=${SIGNER_TOKEN}`);

    const lastSave = dbModule.saveFlow.mock.calls[dbModule.saveFlow.mock.calls.length - 1];
    const savedData = lastSave[1];
    // signedPdfB64 fie nedefinit, fie undefined — în orice caz NU egal cu pdfB64 original
    expect(savedData.signedPdfB64).toBeFalsy();
    expect(savedData.completed).toBeFalsy();
  });

  it('niciun event SIGNED când finalize fail, doar SIGN_FAILED', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    _javaFinalize.mockRejectedValue(new Error('boom'));

    await request(createTestApp())
      .get(`/flows/${FLOW_ID}/sts-poll?token=${SIGNER_TOKEN}`);

    const lastSave = dbModule.saveFlow.mock.calls[dbModule.saveFlow.mock.calls.length - 1];
    const events = lastSave[1].events || [];
    expect(events.some(e => e.type === 'SIGNED')).toBe(false);
    expect(events.some(e => e.type === 'SIGNED_PDF_UPLOADED')).toBe(false);
    expect(events.some(e => e.type === 'FLOW_COMPLETED')).toBe(false);
    const failed = events.find(e => e.type === 'SIGN_FAILED');
    expect(failed).toBeDefined();
    expect(failed.reason).toBe('pades_finalize_failed');
    expect(failed.provider).toBe('sts-cloud');
  });

  it('javaFinalizePades returns no signedPdfBase64 → 502 (throw treated as failure)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    _javaFinalize.mockResolvedValue({});  // răspuns gol, fără signedPdfBase64

    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}/sts-poll?token=${SIGNER_TOKEN}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('pades_finalize_failed');
  });

  it('happy path: javaFinalizePades success → 200, status=signed', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    _javaFinalize.mockResolvedValue({ signedPdfBase64: 'JVBERi0xLjQKU0lHTkVE' });

    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}/sts-poll?token=${SIGNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed');

    const lastSave = dbModule.saveFlow.mock.calls[dbModule.saveFlow.mock.calls.length - 1];
    const savedData = lastSave[1];
    expect(savedData.signers[0].status).toBe('signed');
    expect(savedData.signedPdfB64).toBe('JVBERi0xLjQKU0lHTkVE');
    expect(savedData.events.some(e => e.type === 'SIGNED')).toBe(true);
  });
});
```

### 5.b — `server/tests/integration/download-flow-getfowdata.test.mjs`

Creează:

```js
/**
 * v3.9.502 (A-2 P0) — download endpoint folosește getFlowData + d (nu data)
 *
 * Înainte: SELECT direct ratează flows_pdfs (signedPdfB64 separat),
 * iar referința `data.docName` → ReferenceError la runtime → 500.
 *
 * Acoperire:
 *   ✓ getFlowData rehidratează signedPdfB64 → 200 download
 *   ✓ flow fără signed PDF → 404 no_signed_pdf
 *   ✓ user non-init non-signer non-admin → 403 forbidden
 *   ✓ admin same org → 200 (ACL extins față de versiunea veche)
 *   ✓ filename folosește safeName (nu pattern hardcoded fără docName)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId: vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:   null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import crudRouter, { injectFlowDeps } from '../../routes/flows/crud.mjs';

const FLOW_ID = 'FLOW_DL001';
const JWT_SECRET = 'test-secret-min-32-chars-long-for-jwt-signing';
process.env.JWT_SECRET = JWT_SECRET;

function makeAuth(email = 'init@x.ro', userId = 1, role = 'user', orgId = 1) {
  return `df_auth=${jwt.sign({ email, userId, role, orgId }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function makeFlowData(overrides = {}) {
  return {
    flowId: FLOW_ID, docName: 'Contract Test', initEmail: 'init@x.ro', orgId: 1,
    status: 'completed', completed: true,
    signers: [{ name: 'S1', email: 'sig@x.ro', token: 'tk', status: 'signed', order: 1 }],
    signedPdfB64: 'JVBERi0xLjQK',  // PDF mock din flows_pdfs (rehidratat de getFlowData)
    ...overrides,
  };
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  injectFlowDeps({
    notify: vi.fn(), wsPush: vi.fn(), PDFLib: null,
    stampFooterOnPdf: vi.fn(), isSignerTokenExpired: () => false,
    newFlowId: () => 'NEW', buildSignerLink: () => '',
    stripSensitive: x => x, stripPdfB64: x => x,
    sendSignerEmail: vi.fn(), fireWebhook: vi.fn(),
  });
  app.use('/', crudRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.getFlowData.mockReset();
});

describe('GET /my-flows/:flowId/download — A-2', () => {
  it('initiator + getFlowData returnează signedPdfB64 → 200 application/pdf', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('init@x.ro'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/filename=/);
    expect(dbModule.getFlowData).toHaveBeenCalledWith(FLOW_ID);
  });

  it('signer din flow → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('sig@x.ro'));

    expect(res.status).toBe(200);
  });

  it('user random same-org non-admin → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('intruder@x.ro', 999, 'user', 1));

    expect(res.status).toBe(403);
  });

  it('admin same-org → 200 (extended ACL)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('admin@x.ro', 1, 'org_admin', 1));

    expect(res.status).toBe(200);
  });

  it('admin different-org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ orgId: 99 }));

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('admin@x.ro', 1, 'org_admin', 1));

    expect(res.status).toBe(403);
  });

  it('no signedPdfB64 + no drive → 404 no_signed_pdf', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ signedPdfB64: null }));

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('init@x.ro'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_signed_pdf');
  });
});
```

### 5.c — `server/tests/integration/flow-acl-canread.test.mjs`

Creează:

```js
/**
 * v3.9.502 (A-3 P0) — GET /flows/:flowId folosește canActorReadFlow
 *
 * Înainte: orice user autentificat putea citi metadata flow-ului (signers,
 * events, institutie, compartiment). Leak cross-org.
 *
 * Acoperire (canActorReadFlow):
 *   ✓ Signer token valid → 200 (fără actor)
 *   ✓ Initiator → 200
 *   ✓ Signer email → 200
 *   ✓ Admin same org → 200
 *   ✓ Admin different org → 403 (cross-org blocat)
 *   ✓ User same org non-init non-signer → 403
 *   ✓ User different org → 403
 *   ✓ Fără actor și fără token → 401
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId: vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:   null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import crudRouter, { injectFlowDeps } from '../../routes/flows/crud.mjs';

const FLOW_ID = 'FLOW_ACL01';
const SIGNER_TOKEN = 'sig-token-001';
const JWT_SECRET = 'test-secret-min-32-chars-long-for-jwt-signing';
process.env.JWT_SECRET = JWT_SECRET;

function makeAuth(email, userId, role, orgId) {
  return `df_auth=${jwt.sign({ email, userId, role, orgId }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function makeFlowData() {
  return {
    flowId: FLOW_ID, docName: 'X', initEmail: 'init@x.ro', orgId: 1,
    status: 'active', completed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [],
    signers: [{ name: 'S', email: 'sig@x.ro', token: SIGNER_TOKEN, status: 'current', order: 1 }],
  };
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  injectFlowDeps({
    notify: vi.fn(), wsPush: vi.fn(), PDFLib: null,
    stampFooterOnPdf: vi.fn(), isSignerTokenExpired: () => false,
    newFlowId: () => 'NEW', buildSignerLink: () => '',
    stripSensitive: x => x, stripPdfB64: x => x,
    sendSignerEmail: vi.fn(), fireWebhook: vi.fn(),
  });
  app.use('/', crudRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.getFlowData.mockReset();
});

describe('GET /flows/:flowId — canActorReadFlow (A-3)', () => {
  it('signer token valid fără actor → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}?token=${SIGNER_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('initiator → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('init@x.ro', 1, 'user', 1));
    expect(res.status).toBe(200);
  });

  it('signer email → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('sig@x.ro', 2, 'user', 1));
    expect(res.status).toBe(200);
  });

  it('admin same org → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('admin@x.ro', 3, 'org_admin', 1));
    expect(res.status).toBe(200);
  });

  it('admin different org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('admin@y.ro', 99, 'org_admin', 99));
    expect(res.status).toBe(403);
  });

  it('user same org dar non-init non-signer → 403 (cel mai important fix)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('intruder@x.ro', 99, 'user', 1));
    expect(res.status).toBe(403);
  });

  it('user different org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('other@y.ro', 88, 'user', 99));
    expect(res.status).toBe(403);
  });

  it('fără actor și fără token → 401', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`);
    expect(res.status).toBe(401);
  });
});
```

### 5.d — `server/tests/unit/auth-change-password-csrf.test.mjs`

Creează:

```js
/**
 * v3.9.502 (A-4 P1) — guard că change-password are _csrf middleware
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('auth /change-password CSRF', () => {
  it('ruta POST /auth/change-password include _csrf middleware', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/auth.mjs'), 'utf8');
    // Match: router.post('/auth/change-password', _csrf, ...)
    expect(src).toMatch(/router\.post\(\s*['"]\/auth\/change-password['"]\s*,\s*_csrf\s*,/);
  });

  it('comentariul v3.9.502 A-4 e prezent', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/auth.mjs'), 'utf8');
    expect(src).toMatch(/v3\.9\.502 \(A-4 P1\)/);
  });
});
```

Verifică:
```bash
node --check server/tests/integration/sts-pades-failclosed.test.mjs
node --check server/tests/integration/download-flow-getfowdata.test.mjs
node --check server/tests/integration/flow-acl-canread.test.mjs
node --check server/tests/unit/auth-change-password-csrf.test.mjs
npx vitest run server/tests/integration/sts-pades-failclosed.test.mjs server/tests/integration/download-flow-getfowdata.test.mjs server/tests/integration/flow-acl-canread.test.mjs server/tests/unit/auth-change-password-csrf.test.mjs
```

Expected: cele 22 teste noi trec (5+6+8+2+1 = 22).

NB: numărul exact de teste pe descrieri vs ramuri describe poate varia ușor. Important: toate trec.

============================================================
## PAS 6 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -50
```

Expected: +~22 teste față de v3.9.501. Toate verzi.

**Verifică explicit că rămân verzi (regresii potențiale):**
- Toate testele integration din flows/* (signing.mjs, lifecycle.mjs, cloud-signing.mjs — primele 2 neatinse, al treilea atins doar în catch branch)
- `server/tests/integration/cancel-restore.test.mjs` (v3.9.497)
- `server/tests/integration/alop-cancel-block-df.test.mjs` (v3.9.498)
- `server/tests/integration/formulare-capturi-slot.test.mjs` (v3.9.499)
- `server/tests/integration/formulare-atasamente.test.mjs` (v3.9.500)
- `server/tests/integration/formulare-atasamente-df-slot.test.mjs` (v3.9.501)
- `server/tests/integration/flows.test.mjs` — verifică în special că rutele GET /flows/:flowId nu sunt afectate de helper-ul nou (mock-urile existente probabil setează role=admin/userId match, deci nu cădere)
- `server/tests/integration/state-machine.test.mjs`, `df-refuse-restore.test.mjs`, `df-workflow.test.mjs`

**Dacă vreun test cade din cauza ACL-ului mai strict (ex. test setat user random care înainte primea 200, acum primește 403):** raportează **EXACT** numele testului, asertarea care cade, și mock-ul de auth folosit. NU modifica testul. Suntem într-o zonă de securitate — orice asertare care contează pe ACL permisiv era de fapt confirmarea bug-ului A-3.

============================================================
## PAS 7 — Version bump

În `package.json`: `3.9.501` → `3.9.502`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v216` → `docflowai-v217`.

============================================================
## PAS 8 — Commit + push develop

```bash
git status
git add server/routes/flows/cloud-signing.mjs \
        server/routes/flows/crud.mjs \
        server/routes/auth.mjs \
        server/tests/integration/sts-pades-failclosed.test.mjs \
        server/tests/integration/download-flow-getfowdata.test.mjs \
        server/tests/integration/flow-acl-canread.test.mjs \
        server/tests/unit/auth-change-password-csrf.test.mjs \
        package.json public/sw.js
git commit -m "security(P0): STS fail-closed + download fix + ACL leak + CSRF (v3.9.502)

CRITICAL security audit P0/P1 fixes — autorizare expresă pentru NO-TOUCH
override pe cloud-signing.mjs (DOAR catch(padesErr) branch).

A-1 (P0 CRITIC) — STS PAdES fail closed:
cloud-signing.mjs:446 catch(padesErr) făcea fallback la pdfB64 original
(nesemnat) + marca signers[idx].status='signed' + adăuga event SIGNED +
posibil FLOW_COMPLETED. Pentru produs QES marca semnături calificate
reușite pe documente complet nesemnate — prejudiciu juridic real.
Fix: fail CLOSED — status='error', event SIGN_FAILED, response 502.
Atinge EXCLUSIV catch branch (5 linii → 20 linii). Restul cloud-signing
(Java service, iText, ByteRange, CMS injection) NEATINS.

A-2 (P0) — download endpoint rupt + ReferenceError:
crud.mjs:728 SELECT direct ratează flows_pdfs (signedPdfB64 separat în
arhitectura nouă). Liniile 739, 747 referă variabila 'data' (nedefinită)
în loc de 'd' → ReferenceError → 500 garantat la fiecare download.
Fix: getFlowData() rehidratează corect; consecvent 'd'; folosește safeName
în Content-Disposition (era calculat dar neutilizat).

A-3 (P0) — ACL leak cross-org pe GET /flows/:flowId:
crud.mjs:500-507 verifica DOAR token signer când actor lipsește. Dacă
actor există, returna datele fără verificare → orice user autentificat
din ORICE org primea metadata flow-ului (signers, events, institutie).
Leak GDPR pentru platformă government.
Fix: helper canActorReadFlow centralizat — doar initiator/signer/admin
same-org + signer-token. Aplicat și pe download (mai permisiv decât
înainte: include isAdmin+sameOrg, înainte doar isInit||isSigner).

A-4 (P1) — CSRF lipsă pe /auth/change-password:
auth.mjs:262 router.post fără _csrf middleware → vector CSRF pentru
schimbare parolă pe user logged in target.
Fix: una linie — adăugare _csrf.

Tests (22 noi):
- sts-pades-failclosed.test.mjs (5): catch fail closed + happy path
- download-flow-getfowdata.test.mjs (6): getFlowData + ACL extins
- flow-acl-canread.test.mjs (8): canActorReadFlow toate combinațiile
- auth-change-password-csrf.test.mjs (2): string match guard CSRF

Niciun test existent modificat. Dacă vreun test cădea din ACL mai
strict, era de fapt confirmarea bug-ului A-3 — raportat dacă apare."
git push origin develop
```

============================================================
## RAPORT FINAL — răspunde EXACT la următoarele

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi? Confirmă explicit că testele din v3.9.497-501 trec.
3. SHA commit pushed pe develop?
4. Output `grep -c "v3.9.502" server/routes/flows/cloud-signing.mjs server/routes/flows/crud.mjs server/routes/auth.mjs` — așteptăm minim 1 per fișier (3 atinse).
5. Confirmare modificare îngustă pe cloud-signing.mjs:
   - `grep -c "signedPdfB64 = (data.pdfB64" server/routes/flows/cloud-signing.mjs` → trebuie să fie **0** (fallback eliminat).
   - `grep -c "javaFinalizePades\|injectCms" server/routes/flows/cloud-signing.mjs` → trebuie să fie **neschimbat** față de înainte (restul cloud-signing NEATINS).
6. A picat vreun test existent din cauza ACL-ului mai strict? Dacă DA, listează exact (nume test + asertare). NU modificat nimic.
7. `git status` post-push → "working tree clean". Confirmă.

============================================================
## RECOMANDĂRI POST-SPRINT (din audit, NU se implementează acum)

1. **Punctul 4 (concurrency) — sprint v3.9.503 separat**: helper `withLockedFlow(flowId, async (data) => {...})` cu PG `SELECT ... FOR UPDATE`. Refactor signing.mjs + cloud-signing.mjs + lifecycle.mjs să folosească helper-ul. Teste de race cu Promise.all. Estimat 500-600 linii. Risc mediu (atinge multe path-uri).

2. **Punctul 5 (tokens în URL) — refactor mare**: migrate la one-time-code + cookie HttpOnly session. Sprint dedicat, ~300 linii. Mitigare temporară imediat: adaugă `Referrer-Policy: no-referrer` în Helmet config pe rutele signer (1 linie).

3. **Punctul 6 (rate limiter in-memory)**: dacă rămâi pe single-instance Railway, nu blocant. La scale-out → Redis sau PG-backed limiter.

4. **Punctul 7 (validare doar pe extensie)**: magic bytes check pentru DOCX/XLSX (`PK\x03\x04` zip header) în `convertToPdf.mjs`. ~10 linii. Sprint mic.

5. **Punctul 8 (CSRF selectiv) — audit full**: verifică ALTE endpoint-uri sensibile fără CSRF (auth/*, admin/*, settings/*). v3.9.502 acoperă DOAR change-password din audit. Probabil mai sunt găuri similare.

6. **Punctele 9-12 (CSP unsafe-inline, migrații, DB startup, PDF storage)**: roadmap arhitectural, sprint-uri dedicate când ai capacitate.

7. **Punctul 13 (teste suplimentare)**: v3.9.502 acoperă STS fail, download, ACL. Concurrency vine cu v3.9.503. PDF integrity post-signing (test PAdES validation după footer) — sprint dedicat.

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs` — neatins
- `server/routes/flows/bulk-signing.mjs` — neatins
- `server/signing/pades.mjs` — neatins
- `server/signing/java-pades-client.mjs` — neatins
- `server/routes/flows/cloud-signing.mjs` — **AUTORIZARE EXPRESĂ DOAR pentru blocul catch(padesErr) din /sts-poll (liniile 446-448 actual)**. Orice altă modificare în acest fișier interzisă. Restul rutei (try block cu Java/injectCms, marcare signed, advance flow, FLOW_COMPLETED, restul endpoint-urilor cloud-signing-callback, initiate-cloud-signing) NEATINS.
- `server/routes/flows/signing.mjs`, `server/routes/flows/lifecycle.mjs` — neatins în acest sprint
- `server/utils/convertToPdf.mjs`, `server/utils/pdf-content-detect.mjs` — neatinse
- `server/services/authz-formular.mjs` — neatins (helper canActorReadFlow trăiește în crud.mjs, NU duplicat aici)
- Coloana `formulare_ord.img2` — rămâne deprecated
- Testele existente: NU se modifică. Dacă cădere din ACL strict, raportează — e foarte probabil confirmare bug A-3 vechi.

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
