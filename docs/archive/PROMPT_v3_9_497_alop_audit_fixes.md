# PROMPT — v3.9.497 — ALOP audit fixes (cancel restore + revizie bar visibility)

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** rulează doar după ce v3.9.496 e merge-uit pe develop și `git pull origin develop` l-a adus local.

============================================================
## CONTEXT

Audit Pas 3-5 ALOP/DF a descoperit 2 gap-uri reale (raport detaliat în chat — Finding #1 cosmetic frontend, Finding #2 data-corruption backend). Le rezolvăm într-un singur sprint v3.9.497.

**Finding #2 (backend, critic — Pas 4 gap):** `POST /flows/:flowId/cancel` în `server/routes/flows/lifecycle.mjs:431-475` setează `data.status='cancelled'` pe flow, dar nu atinge deloc DF-ul legat. Asimetric față de refuse (`signing.mjs:117-182`) și review-request (`lifecycle.mjs:163-170`) care marchează DF + restaurează ALOP linkage.

Repro: P1+P2 completează DF R0 (status=`completed`) → inițiator pornește flux (DF → `transmis_flux`, ALOP pointează la DF) → admin anulează fluxul → flow=`cancelled` ✓, dar `formulare_df.status` rămâne `transmis_flux` ❌, ALOP încă pointează la DF mort. DF e stuck: nu poate fi retrimis (deja legat la flow mort), nu poate fi revizuit (revizia cere status `aprobat` sau `neaprobat`, vezi `formulare-db.mjs:575`).

Decizie semantică pentru cancel: DF `transmis_flux → completed` (revine la starea pre-flux), ALOP `df_flow_id=NULL` + `df_completed_at=NULL` păstrând `df_id` (DF-ul rămâne revizia curentă a ALOP-ului, doar nu mai e în flux). Diferit de refuse (care setează DF → `neaprobat` și pentru R0 eliberează `df_id=NULL`). Justificare: cancel ≠ rejection. Cancel înseamnă "undo putting in flux" — userul poate retrimite același DF fără să creeze revizie nouă. Dacă vrea să marcheze DF ca rejected, are endpoint separat `/api/formulare-df/:id/anuleaza`.

**Finding #1 (frontend, cosmetic — Pas 3 gap):** Bara `#df-revizie-header-bar` rămâne vizibilă când userul comută din tab `notafd` în tab `ordnt` în aceeași secțiune form. `updateRevizieHeaderBadge(ft, doc)` în `doc.js:312` are pe linia 313 `if(ft!=='notafd')return;` — return early pentru ordnt fără a ascunde bara. `sw()` în `core.js:65` nu o atinge. Rezultat: useri văd "Revizia 2" deasupra formularului ORD, deși revizia e proprietate doar a DF-ului.

============================================================
## PAS 1 — Backend fix: cancel restore în `server/routes/flows/lifecycle.mjs`

Localizează handlerul `POST /flows/:flowId/cancel` (linia 432). Imediat după `await saveFlow(flowId, data)` (linia 459) și înainte de `writeAuditEvent` (linia 461), inserează blocul de restaurare DF/ALOP. NU șterge nimic existent.

Adaugă următorul cod între linia 459 (`await saveFlow(flowId, data);`) și linia 460 (`// R-02: audit_log`):

```js
    // FIX state machine v3.9.497 (Finding #2 audit Pas 4):
    // La cancel, DF legat (dacă e în transmis_flux) revine la 'completed' — userul
    // poate retrimite același DF. ALOP păstrează df_id (DF rămâne revizia curentă)
    // dar curăță df_flow_id + df_completed_at (fluxul mort nu mai e activ).
    // Asimetric față de refuse (care setează neaprobat + eliberează df_id pentru R0)
    // pentru că cancel nu e rejection, doar "undo putting in flux".
    try {
      const { rows: dfRows } = await pool.query(
        `UPDATE formulare_df SET status='completed', updated_at=NOW()
         WHERE flow_id=$1 AND status='transmis_flux'
         RETURNING id, revizie_nr, parent_df_id`,
        [flowId]
      );
      if (dfRows.length) {
        const cancelledDf = dfRows[0];
        await pool.query(
          `UPDATE alop_instances
           SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
           WHERE df_id=$1 AND cancelled_at IS NULL`,
          [cancelledDf.id]
        );
        logger.info({ dfId: cancelledDf.id, revizieNr: cancelledDf.revizie_nr, flowId },
          `[ALOP] flow cancelled → DF R${cancelledDf.revizie_nr || 0} revenit la completed, ALOP df_flow_id=NULL`);
      }
    } catch (alopCancelErr) {
      // Non-fatal: cancel-ul fluxului a reușit oricum (data.status='cancelled' salvat).
      logger.error({ err: alopCancelErr, flowId }, '[ALOP] restore on cancel failed (non-fatal)');
    }
```

Verifică:
```bash
node --check server/routes/flows/lifecycle.mjs
grep -n "v3.9.497 (Finding #2 audit Pas 4)" server/routes/flows/lifecycle.mjs
grep -n "flow cancelled → DF R" server/routes/flows/lifecycle.mjs
```

Expected: fără eroare sintaxă; un singur match per grep.

============================================================
## PAS 2 — Backend test: `server/tests/integration/cancel-restore.test.mjs`

Creează fișierul nou:

```js
/**
 * DocFlowAI — Integration tests: handler cancel + restore DF/ALOP
 *
 * v3.9.497 (Finding #2 audit Pas 4): cancel restore — asimetric față de refuse.
 *
 * Acoperire:
 *   ✓ cancel cu DF în transmis_flux → DF=completed, ALOP df_flow_id=NULL, df_id PĂSTRAT
 *   ✓ cancel R1 (revizie) → DF R1=completed, ALOP df_flow_id=NULL, df_id=R1 (nu parent)
 *   ✓ cancel fără DF asociat → success, restore skip (RETURNING 0 rows)
 *   ✓ cancel cu DF în status diferit (ex. de_revizuit) → DF neatins
 *   ✓ Restore eșuat (DB hiccup) → cancel rămâne success (non-fatal)
 *   ✓ Guard: cancel pe flux completed → 409
 *   ✓ Guard: cancel pe flux deja cancelled → 409
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:             { query: vi.fn() },
  DB_READY:         true,
  requireDb:        vi.fn(() => false),
  saveFlow:         vi.fn().mockResolvedValue(undefined),
  getFlowData:      vi.fn(),
  writeAuditEvent:  vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId:  vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:    null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import lifecycleRouter, { _injectDeps } from '../../routes/flows/lifecycle.mjs';

const FLOW_ID  = 'FLOW_CRS001';
const DF_R0_ID = 'ddddffff-0000-0000-0000-0000000000C0';
const DF_R1_ID = 'ddddffff-0000-0000-0000-0000000000C1';

const JWT_SECRET = 'test-secret-min-32-chars-long-for-jwt-signing';
process.env.JWT_SECRET = JWT_SECRET;

function makeFlowData(overrides = {}) {
  return {
    flowId: FLOW_ID, docName: 'DF Test', initEmail: 'init@x.ro', orgId: 1,
    status: 'active', completed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [],
    signers: [{ name: 'P1', email: 'p1@x.ro', token: 'tok', status: 'current', order: 1 }],
    ...overrides,
  };
}

function makeAuthCookie(email = 'init@x.ro', role = 'user', orgId = 1) {
  const payload = { email, role, orgId, userId: 1 };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  return `df_auth=${token}`;
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  _injectDeps({
    notify:               vi.fn().mockResolvedValue(undefined),
    fireWebhook:          null,
    wsPush:               vi.fn(),
    PDFLib:               null,
    stampFooterOnPdf:     vi.fn(),
    isSignerTokenExpired: () => false,
    newFlowId:            () => 'NEW',
    buildSignerLink:      () => '',
    stripSensitive:       x => x,
    stripPdfB64:          x => x,
    sendSignerEmail:      vi.fn().mockResolvedValue(undefined),
  });
  app.use('/', lifecycleRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.getFlowData.mockReset();
  dbModule.saveFlow.mockReset().mockResolvedValue(undefined);
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('cancel cu DF în transmis_flux → DF=completed, ALOP df_flow_id=NULL', () => {
  it('R0 cancel → DF R0 completed, ALOP df_id păstrat, df_flow_id=NULL', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // DELETE notifications
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, revizie_nr: 0, parent_df_id: null }], rowCount: 1 }) // UPDATE formulare_df RETURNING
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE alop_instances

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'test cancel' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dfUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes("UPDATE formulare_df SET status='completed'") &&
      String(c[0]).includes("status='transmis_flux'")
    );
    expect(dfUpdate, 'DF update transmis_flux → completed lipsește').toBeDefined();
    expect(dfUpdate[1]).toEqual([FLOW_ID]);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') &&
      String(c[0]).includes('df_flow_id=NULL') &&
      !String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate, 'ALOP update df_flow_id=NULL (păstrând df_id) lipsește').toBeDefined();
    expect(alopUpdate[1]).toEqual([DF_R0_ID]);
  });

  it('R1 cancel (revizie) → DF R1 completed, ALOP păstrează df_id=R1 (NU restore la parent)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'test cancel R1' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') &&
      String(c[0]).includes('df_flow_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
    // df_id rămâne R1 (NU parent R0 — cancel păstrează revizia curentă)
    expect(alopUpdate[1]).toEqual([DF_R1_ID]);
    // În contrast cu refuse, cancel NU caută parent_df_id
    const parentSelect = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, flow_id, status FROM formulare_df')
    );
    expect(parentSelect, 'cancel NU trebuie să caute parent_df_id').toBeUndefined();
  });
});

describe('cancel fără DF în transmis_flux → restore skip', () => {
  it('cancel cu flow fără DF asociat (RETURNING 0 rows) → success, fără UPDATE alop', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE formulare_df RETURNING [] (no rows matched)

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'no df' });

    expect(res.status).toBe(200);
    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances')
    );
    expect(alopUpdate, 'când nu există DF în transmis_flux, ALOP nu trebuie atins').toBeUndefined();
  });

  it('cancel cu DF în status diferit (ex. de_revizuit) → DF/ALOP neatinse', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    // UPDATE cu WHERE status='transmis_flux' matchează 0 rows → RETURNING []
    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'df in de_revizuit' });

    expect(res.status).toBe(200);
    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances')
    );
    expect(alopUpdate).toBeUndefined();
  });
});

describe('Erori non-fatale', () => {
  it('UPDATE formulare_df aruncă → cancel rămâne success', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(new Error('DB hiccup'));

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'db error' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Guards: cancel pe stări invalide', () => {
  it('cancel pe flux completed → 409', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ completed: true }));
    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_completed');
  });

  it('cancel pe flux deja cancelled → 409', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ status: 'cancelled' }));
    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .set('Cookie', makeAuthCookie())
      .send({ reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_cancelled');
  });
});
```

Verifică:
```bash
node --check server/tests/integration/cancel-restore.test.mjs
npx vitest run server/tests/integration/cancel-restore.test.mjs
```

Expected: cele 7 teste trec.

============================================================
## PAS 3 — Frontend fix: bara revizie în `public/js/formular/core.js` + `doc.js`

### 3.a — `public/js/formular/core.js`

Localizează funcția `sw(tab)` la linia 65. Înlocuiește blocul existent cu:

```js
function sw(tab){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',(i===0&&tab==='ordnt')||(i===1&&tab==='notafd')));
  document.getElementById('form-ordnt').style.display=tab==='ordnt'?'':'none';
  document.getElementById('form-notafd').style.display=tab==='notafd'?'':'none';
  // v3.9.497 (Finding #1 audit Pas 3): bara de revizie e proprietate doar a DF (notafd).
  // O sincronizăm cu tab-ul: vizibilă doar când suntem pe notafd și avem doc încărcat.
  const _revBar=document.getElementById('df-revizie-header-bar');
  if(_revBar){
    if(tab==='notafd'&&ST?.docId?.notafd) _revBar.style.display='flex';
    else _revBar.style.display='none';
  }
  // locked-bar-ordnt/notafd au fost mutate în back-bar (header compact); curăță
  // bara inactivă ca să nu rămână mesajul vechi vizibil când se schimbă forma.
  const inactiveBar=document.getElementById('locked-bar-'+(tab==='ordnt'?'notafd':'ordnt'));
  if(inactiveBar){inactiveBar.className='locked-bar';inactiveBar.textContent='';}
  clrS();
}
```

### 3.b — `public/js/formular/doc.js`

Localizează `updateRevizieHeaderBadge` la linia 312. Înlocuiește linia 313 (`if(ft!=='notafd')return;`) cu:

```js
function updateRevizieHeaderBadge(ft, doc){
  if(ft!=='notafd'){
    // v3.9.497 (Finding #1 audit Pas 3): defensive — dacă suntem invocați pe ft non-notafd,
    // ascundem bara (revizia e proprietate doar a DF).
    const _h=document.getElementById('df-revizie-header-bar');
    if(_h)_h.style.display='none';
    return;
  }
```

(păstrează restul corpului funcției neschimbat — linia 314 `const nr=doc.revizie_nr??0;` etc.)

Verifică:
```bash
grep -n "v3.9.497 (Finding #1 audit Pas 3)" public/js/formular/core.js
grep -n "v3.9.497 (Finding #1 audit Pas 3)" public/js/formular/doc.js
```

Expected: un singur match în fiecare fișier.

============================================================
## PAS 4 — Test guard frontend (string match în sursă)

Creează `server/tests/unit/revizie-bar-visibility.test.mjs`:

```js
/**
 * v3.9.497 (Finding #1 audit Pas 3) — guard că fix-ul de vizibilitate
 * a barei de revizie e prezent în surse. Vizibilitate DOM e testabilă
 * doar manual; aici doar string-match pentru a păzi împotriva eliminării
 * accidentale a fix-ului.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('bara revizie: vizibilitate sincronizată cu tab-ul', () => {
  it('sw() în core.js ascunde bara când tab !== notafd', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/core.js'), 'utf8');
    expect(src).toMatch(/df-revizie-header-bar/);
    expect(src).toMatch(/v3\.9\.497.*Finding #1/);
  });

  it('updateRevizieHeaderBadge în doc.js ascunde bara la early return', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.497.*Finding #1/);
    // Verifică că în blocul if(ft!=='notafd') apare ascunderea barei
    const m = src.match(/if\(ft!=='notafd'\)\s*\{[\s\S]{0,400}\}/);
    expect(m, 'early-return block în updateRevizieHeaderBadge nu a fost găsit').toBeTruthy();
    expect(m[0]).toMatch(/df-revizie-header-bar/);
    expect(m[0]).toMatch(/display='none'/);
  });
});
```

Verifică:
```bash
node --check server/tests/unit/revizie-bar-visibility.test.mjs
npx vitest run server/tests/unit/revizie-bar-visibility.test.mjs
```

Expected: 2 teste trec.

============================================================
## PAS 5 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -40
```

Expected: suite-ul complet trece. +9 teste față de v3.9.496 (7 din `cancel-restore.test.mjs` + 2 din `revizie-bar-visibility.test.mjs`). Dacă există vreun test failed, OPREȘTE și raportează exact ce a picat. NU modifica niciun test existent pentru a-l face să treacă.

În special verifică că rămân verzi:
- `server/tests/integration/df-refuse-restore.test.mjs` (Pas 4 existent)
- `server/tests/integration/df-workflow.test.mjs`
- `server/tests/integration/state-machine.test.mjs`
- `server/tests/integration/flows.test.mjs`

============================================================
## PAS 6 — Version bump

În `package.json`: `version` `3.9.496` → `3.9.497`.
În `public/sw.js`: `CACHE_VERSION` valoarea curentă (`docflowai-v211`) → `docflowai-v212`.

Verifică:
```bash
grep '"version"' package.json
grep "CACHE_VERSION" public/sw.js | head -1
```

============================================================
## PAS 7 — Commit + push develop

```bash
git status
git add server/routes/flows/lifecycle.mjs \
        server/tests/integration/cancel-restore.test.mjs \
        public/js/formular/core.js \
        public/js/formular/doc.js \
        server/tests/unit/revizie-bar-visibility.test.mjs \
        package.json public/sw.js
git commit -m "fix(alop): cancel restore + revizie bar visibility (v3.9.497)

Audit ALOP/DF Pas 3-5 a descoperit 2 gap-uri:

Finding #2 (backend, critic): POST /flows/:flowId/cancel marchează flow
ca cancelled dar nu atinge DF-ul. Asimetric față de refuse + review-request
care actualizează DF + ALOP. Repro: DF în transmis_flux + flow cancel →
DF rămâne stuck în transmis_flux, nu poate fi nici retrimis nici revizuit.

Fix: la cancel, DF transmis_flux → completed (revine la pre-flux), ALOP
df_flow_id=NULL + df_completed_at=NULL păstrând df_id. Semantic diferit
de refuse (care e rejection): cancel = 'undo putting in flux', userul
poate retrimite același DF.

Finding #1 (frontend, cosmetic): bara df-revizie-header-bar rămânea
vizibilă când userul comuta din tab notafd în tab ordnt în secțiunea form.
sw() în core.js nu o atingea; updateRevizieHeaderBadge în doc.js avea
early-return fără să ascundă bara. Rezultat: 'Revizia N' apărea deasupra
formularului ORD, inducând confuzie (revizia e proprietate doar a DF).

Fix: sw() sincronizează bara cu tab-ul (vizibilă doar pe notafd cu doc
încărcat). updateRevizieHeaderBadge ascunde bara la early-return defensiv.

Tests: cancel-restore.test.mjs (7 cases: R0/R1 cancel + skip cases +
DB-error non-fatal + guards 409). revizie-bar-visibility.test.mjs (2
string-match guards pentru fix-ul frontend)."
git push origin develop
```

============================================================
## RAPORT FINAL — răspunde EXACT la următoarele

1. Ce versiune e acum în `package.json` și ce `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează în total acum? Toate verzi?
3. Care e SHA-ul commit-ului pushed pe develop (`git rev-parse HEAD`)?
4. Output-ul `grep -c "v3.9.497" server/routes/flows/lifecycle.mjs public/js/formular/core.js public/js/formular/doc.js` — așteptăm 1 match în fiecare (3 total).
5. `git status` după push → "working tree clean". Confirmă.

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`
- `server/routes/flows/cloud-signing.mjs`
- `server/routes/flows/bulk-signing.mjs`
- `server/signing/pades.mjs`
- `server/signing/java-pades-client.mjs`
- `server/routes/flows/signing.mjs` — handlerul refuse rămâne complet neatins (cancel restore copiază pattern-ul, nu îl modifică)
- `server/utils/convertToPdf.mjs`, `server/utils/pdf-content-detect.mjs` — niciun fix aici
- Testele existente: `df-refuse-restore.test.mjs`, `df-workflow.test.mjs`, `state-machine.test.mjs`, `flows.test.mjs` — nu se modifică pentru a face să treacă. Dacă pică, raportează.
- `server/routes/flows/crud.mjs` și logica de creare flux — neatinse
- `formulare-db.mjs` — neatins (handler-ul `/anuleaza` pentru DF rămâne independent de cancel-ul fluxului)

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
