# PROMPT — v3.9.498 — ALOP audit fixes: captura 2 broken + cancel-block-when-DF-exists

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** rulează doar după ce v3.9.497 e merge-uit pe develop și `git pull origin develop` l-a adus local.

============================================================
## CONTEXT

Audit ALOP a descoperit 2 issue-uri raportate de utilizator + arhitectura asimetrică captura 1/captura 2 (listată ca tech debt, nu se rezolvă acum).

### Issue R-A — Captura 2 "deteriorată" când ord ajunge la Responsabil CAB

Simptom (screenshot user): zona "Captură 'Informații complete contract'" afișează pictogramă broken-image în loc de placeholder după ce ord-ul tranzitionează P1→pending_p2. P2 (CAB) deschide ord-ul și vede broken icon.

Arhitectură ORD captures:
- **Captura 1** (`o-cimg`): stocată în tabel `formulare_capturi` (BYTEA), upload prin endpoint dedicat `/api/formulare-capturi/:type/:id`, restore prin GET la același endpoint cu blob→FileReader. Robust.
- **Captura 2** (`o-cimg2` / `img2`): stocată în `formulare_ord.img2` TEXT (base64 inline ~6.7MB pentru 5MB imagine), bundled cu form submit. Fragil.

Root cause exact nu poate fi izolat prin analiză statică — fluxul P2 complete nu atinge img2 (whitelist `ORD_P2_FIELDS = ['rows']`). Hipoteze plauzibile: trunchiere transport pentru base64 mari, JSON.stringify accidental pe obiect, valoare "[object Object]" stocată din eroare client.

Simptomul vine din `populateOrd` (`public/js/formular/doc.js:78`):
```js
if(doc.img2) showImg('o-cimg2','o-cph2', doc.img2);
```
`showImg` setează `img.src = doc.img2` și forțează `display='block'`. Pentru orice string truthy dar invalid (nu data URL), browser-ul afișează broken-icon.

Fix defensive low-risk: validează că `doc.img2` începe cu `data:image/` ÎNAINTE de `showImg`. Dacă nu, ascunde wrap-ul (placeholder normal apare) ȘI loghează valoarea coruptă în console + (opțional) trimite la /api/log pentru server-side investigation.

NB: tech debt pentru migrare img2 → pattern formulare_capturi e listat în RAPORT FINAL ca recomandare separată. Nu se face în sprint-ul ăsta.

### Issue R-B — ALOP cu DF emis nu se mai poate anula

Cerință user: dacă ALOP are cel puțin 1 DF emis (`df_id IS NOT NULL` cu DF ne-șters), butonul Anulează ALOP trebuie blocat — atât client-side (UX) cât și server-side (defensive).

Semantic "DF emis": `a.df_id IS NOT NULL` cu existență în `formulare_df` (deleted_at IS NULL). Simetric cu logica refuse din v3.9.497: dacă DF e refuzat (R0 → ALOP eliberat → df_id=NULL), cancel-ul redevine permis.

============================================================
## PAS 1 — Frontend defensive fix img2 în `public/js/formular/doc.js`

Localizează `populateOrd` în jurul liniei 66. Înlocuiește blocul existent de gestionare captura 2 (liniile 76-78):

```js
  const _wrap2=document.getElementById('o-captura2-wrap');
  if(_wrap2)_wrap2.style.display=doc.img2?'':'none';
  if(doc.img2)showImg('o-cimg2','o-cph2',doc.img2);
```

cu:

```js
  // v3.9.498 (Issue R-A): defensive validation img2 — broken icon apărea
  // când doc.img2 era truthy dar nu un data URL valid (string corupt,
  // "[object Object]", "null", base64 trunchiat). Validăm prefixul ÎNAINTE
  // de showImg. Dacă invalid, ascundem wrap-ul (placeholder normal apare)
  // și logăm pentru investigare root cause.
  const _wrap2=document.getElementById('o-captura2-wrap');
  const _img2Valid=typeof doc.img2==='string'
    && doc.img2.length>32
    && /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(doc.img2);
  if(_wrap2)_wrap2.style.display=_img2Valid?'':'none';
  if(_img2Valid){
    showImg('o-cimg2','o-cph2',doc.img2);
  }else if(doc.img2){
    // Valoare truthy dar invalidă — log pentru investigare
    console.warn('[v3.9.498] populateOrd: doc.img2 invalid (preview):',
      typeof doc.img2, String(doc.img2).slice(0,80));
  }
```

Verifică:
```bash
grep -n "v3.9.498 (Issue R-A)" public/js/formular/doc.js
grep -n "_img2Valid" public/js/formular/doc.js
```

Expected: un singur match pentru comentariu, două match-uri pentru `_img2Valid` (declarare + folosire).

============================================================
## PAS 2 — Backend block ALOP cancel când DF există

Localizează handlerul `/api/alop/:id/cancel` în `server/routes/alop.mjs` la linia 1096. Înlocuiește blocul existent UPDATE (liniile 1110-1117):

```js
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET status='cancelled', cancelled_at=NOW(), updated_at=NOW(), updated_by=$3
      WHERE id=$1 AND org_id=$2 AND status != 'completed'
      RETURNING *
    `, [req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(409).json({ error: 'cancel_blocked', message: 'ALOP completat sau deja anulat' });
    res.json({ alop: rows[0] });
```

cu:

```js
    // v3.9.498 (Issue R-B): block cancel dacă ALOP are DF emis (df_id setat
    // și DF ne-șters). Refuze (R0) eliberează df_id=NULL → cancel redevine
    // permis. Simetric cu logica refuse din v3.9.497.
    const { rows: dfCheck } = await pool.query(`
      SELECT a.df_id, fd.nr_unic_inreg, fd.status AS df_status
      FROM alop_instances a
      LEFT JOIN formulare_df fd ON fd.id = a.df_id AND fd.deleted_at IS NULL
      WHERE a.id=$1 AND a.org_id=$2
    `, [req.params.id, actor.orgId]);
    if (dfCheck[0]?.df_id && dfCheck[0]?.df_status) {
      return res.status(409).json({
        error: 'cancel_blocked_df_exists',
        message: `Nu se poate anula ALOP-ul: există un DF emis (${dfCheck[0].nr_unic_inreg || 'fără nr.'}, status: ${dfCheck[0].df_status}). Anulați sau refuzați DF-ul mai întâi.`,
        df_id: dfCheck[0].df_id,
        df_nr: dfCheck[0].nr_unic_inreg,
        df_status: dfCheck[0].df_status,
      });
    }

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET status='cancelled', cancelled_at=NOW(), updated_at=NOW(), updated_by=$3
      WHERE id=$1 AND org_id=$2 AND status != 'completed'
      RETURNING *
    `, [req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(409).json({ error: 'cancel_blocked', message: 'ALOP completat sau deja anulat' });
    res.json({ alop: rows[0] });
```

Verifică:
```bash
node --check server/routes/alop.mjs
grep -n "v3.9.498 (Issue R-B)" server/routes/alop.mjs
grep -n "cancel_blocked_df_exists" server/routes/alop.mjs
```

Expected: fără eroare sintaxă; câte un match per grep.

============================================================
## PAS 3 — Frontend ascunde X / Anulează când DF există

### 3.a — `public/js/formular/alop.js` — butonul X din listă

Localizează linia 181 (`const active = a.status !== 'completed' && a.status !== 'cancelled';`). Înlocuiește cu:

```js
      const active=a.status!=='completed'&&a.status!=='cancelled';
      // v3.9.498 (Issue R-B): blochăm cancel dacă DF emis (df_id setat)
      const canCancel=active&&!a.df_id;
```

Apoi localizează linia 208 (butonul X) și înlocuiește `${active?...}` cu `${canCancel?...}`:

```js
          ${canCancel?`<button class="df-action-btn danger sm" style="margin-left:4px" onclick="cancelAlop('${esc(a.id)}')" title="Anulează ALOP">✕</button>`:''}
```

### 3.b — `public/js/formular/alop.js` — butonul Anulează din detalii

Localizează linia 545 (`actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-x')}Anulează</button>`;`). Adaugă guard imediat înainte:

Caută blocul de context (5-10 linii înainte) ca să identifici variabila DF în detail view. Cel mai probabil e `a.df_id` din obiectul `a` (ALOP) preluat. Înlocuiește linia cu:

```js
    // v3.9.498 (Issue R-B): ascunde Anulează când DF emis (df_id setat)
    if(!a.df_id){
      actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-x')}Anulează</button>`;
    }
```

NB: dacă numele variabilei nu e `a` în acel scope, adaptează (poate fi `alop`, `data`, etc.). Verifică contextul prin `view` pe liniile 530-550 ÎNAINTE de a edita.

### 3.c — `public/js/formular/alop.js` — `cancelAlop` mesaj user-friendly pe 409

Localizează `async function cancelAlop(id)` la linia 934. Înlocuiește gestionarea erorii:

Caută blocul:
```js
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'server_error');
```

Înlocuiește cu:
```js
    const data=await r.json();
    if(!r.ok){
      // v3.9.498 (Issue R-B): mesaj user-friendly pentru block-ul DF
      if(data.error==='cancel_blocked_df_exists'){
        alert(data.message||'ALOP nu poate fi anulat: există DF emis.');
        return;
      }
      throw new Error(data.error||'server_error');
    }
```

Verifică:
```bash
grep -n "v3.9.498 (Issue R-B)" public/js/formular/alop.js
grep -n "canCancel" public/js/formular/alop.js
grep -n "cancel_blocked_df_exists" public/js/formular/alop.js
```

Expected: 3 match-uri pentru comentariul v3.9.498, 2 match-uri pentru `canCancel` (declarare + folosire), 1 match pentru error code.

============================================================
## PAS 4 — Test integration: cancel block + cancel allowed

Creează `server/tests/integration/alop-cancel-block-df.test.mjs`:

```js
/**
 * v3.9.498 (Issue R-B) — POST /api/alop/:id/cancel
 * Block cancel când ALOP are DF emis (df_id setat și DF ne-șters).
 *
 * Acoperire:
 *   ✓ ALOP cu df_id setat + DF activ → 409 cancel_blocked_df_exists
 *   ✓ ALOP cu df_id NULL → cancel permis (200)
 *   ✓ ALOP cu df_id setat dar DF deleted_at IS NOT NULL → cancel permis
 *     (DF șters logic, nu mai e "emis")
 *   ✓ ALOP completed → 409 (regression: comportament vechi păstrat)
 *   ✓ Permission check (canDestroyOnly): non-creator/non-admin → 403
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

vi.mock('../../services/authz-formular.mjs', () => ({
  canDestroyOnly: vi.fn((actor, doc) => {
    if (['admin','org_admin'].includes(actor.role)) return { allowed: true, role: 'admin' };
    if (doc.created_by === actor.userId) return { allowed: true, role: 'creator' };
    return { allowed: false, reason: 'forbidden_destroy_creator_only' };
  }),
  canEditFormular: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfProtection: (req, res, next) => next(),
  _csrf:          (req, res, next) => next(),
}));

import * as dbModule from '../../db/index.mjs';
import alopRouter from '../../routes/alop.mjs';

const ALOP_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const DF_ID   = 'ddddffff-0000-0000-0000-0000000000A1';

const JWT_SECRET = 'test-secret-min-32-chars-long-for-jwt-signing';
process.env.JWT_SECRET = JWT_SECRET;

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const payload = { email: 'test@x.ro', role, orgId, userId };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  return `df_auth=${token}`;
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', alopRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('cancel ALOP cu DF emis → 409', () => {
  it('df_id setat + DF activ (status=draft) → 409 cancel_blocked_df_exists', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })  // SELECT created_by
      .mockResolvedValueOnce({                                              // SELECT df_id JOIN fd
        rows: [{ df_id: DF_ID, nr_unic_inreg: 'DF-2026-001', df_status: 'draft' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked_df_exists');
    expect(res.body.df_id).toBe(DF_ID);
    expect(res.body.df_nr).toBe('DF-2026-001');
    expect(res.body.df_status).toBe('draft');
    // Verificăm că NU s-a încercat UPDATE-ul de cancel
    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes("status='cancelled'")
    );
    expect(updateCall).toBeUndefined();
  });

  it('df_id setat + DF în transmis_flux → 409', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ df_id: DF_ID, nr_unic_inreg: 'DF-2026-002', df_status: 'transmis_flux' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(409);
    expect(res.body.df_status).toBe('transmis_flux');
  });
});

describe('cancel ALOP fără DF → 200', () => {
  it('df_id NULL → cancel permis', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ df_id: null, nr_unic_inreg: null, df_status: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ALOP_ID, status: 'cancelled' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('cancelled');
  });

  it('df_id setat dar DF soft-deleted (df_status NULL via LEFT JOIN) → cancel permis', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({                                              // LEFT JOIN găsește DF dar deleted_at filtrează → df_status=NULL
        rows: [{ df_id: DF_ID, nr_unic_inreg: null, df_status: null }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [{ id: ALOP_ID, status: 'cancelled' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
  });
});

describe('regressions — comportament vechi păstrat', () => {
  it('ALOP completed → 409 cancel_blocked (regression check)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ df_id: null, df_status: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE matches 0 (status='completed')

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked');
  });

  it('non-creator non-admin → 403', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 999 }], rowCount: 1 }); // alt user

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie(1, 'user', 1)); // userId=1, role=user

    expect(res.status).toBe(403);
  });
});
```

Verifică:
```bash
node --check server/tests/integration/alop-cancel-block-df.test.mjs
npx vitest run server/tests/integration/alop-cancel-block-df.test.mjs
```

Expected: cele 6 teste trec.

============================================================
## PAS 5 — Test unit: defensive img2 validation

Creează `server/tests/unit/populate-ord-img2-validation.test.mjs`:

```js
/**
 * v3.9.498 (Issue R-A) — guard că validarea img2 e prezentă în populateOrd.
 * Test string-match pentru a păzi împotriva eliminării accidentale.
 * Comportament vizual al broken-icon-ului e testabil doar manual pe staging.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('populateOrd: defensive img2 validation', () => {
  it('verifică prefix "data:image/" înainte de showImg', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.498.*Issue R-A/);
    // Validarea trebuie să folosească regex pe prefixul data URL
    expect(src).toMatch(/data:image\\\/\(png\|jpe\?g\|webp\|gif\|bmp\)/);
    // _img2Valid trebuie să fie folosit ca guard pentru showImg
    const m = src.match(/_img2Valid\s*=[\s\S]{0,300}showImg\('o-cimg2'/);
    expect(m, 'blocul _img2Valid → showImg lipsește').toBeTruthy();
  });

  it('când invalid, loghează warning cu preview', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/console\.warn\([^)]*v3\.9\.498[^)]*img2/);
  });
});
```

Verifică:
```bash
node --check server/tests/unit/populate-ord-img2-validation.test.mjs
npx vitest run server/tests/unit/populate-ord-img2-validation.test.mjs
```

Expected: cele 2 teste trec.

============================================================
## PAS 6 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -40
```

Expected: suite-ul complet trece. +8 teste față de v3.9.497 (6 din `alop-cancel-block-df.test.mjs` + 2 din `populate-ord-img2-validation.test.mjs`). Dacă pică ceva (în special `alop.test.mjs`, `state-machine.test.mjs`, `df-refuse-restore.test.mjs`), OPREȘTE și raportează exact ce a picat. NU modifica niciun test existent pentru a-l face să treacă.

============================================================
## PAS 7 — Version bump

În `package.json`: `version` `3.9.497` → `3.9.498`.
În `public/sw.js`: `CACHE_VERSION` valoarea curentă (`docflowai-v212`) → `docflowai-v213`.

Verifică:
```bash
grep '"version"' package.json
grep "CACHE_VERSION" public/sw.js | head -1
```

============================================================
## PAS 8 — Commit + push develop

```bash
git status
git add public/js/formular/doc.js \
        public/js/formular/alop.js \
        server/routes/alop.mjs \
        server/tests/integration/alop-cancel-block-df.test.mjs \
        server/tests/unit/populate-ord-img2-validation.test.mjs \
        package.json public/sw.js
git commit -m "fix(alop): captura 2 broken icon + cancel block when DF exists (v3.9.498)

Issue R-A — Captura 2 deteriorată la P2:
populateOrd apela showImg('o-cimg2', ..., doc.img2) fără validare. Pentru
orice doc.img2 truthy dar invalid (string corupt, '[object Object]',
'null' string, base64 trunchiat în tranzit), browser-ul afișa broken-icon.
Root cause server-side neidentificat prin analiză statică — fluxul P2
complete nu atinge img2 (whitelist ORD_P2_FIELDS=['rows']). Hipoteze:
trunchiere transport pentru base64 >X MB, JSON.stringify accidental.

Fix defensive: verifică prefixul 'data:image/(png|jpe?g|webp|gif|bmp);base64,'
înainte de showImg. Dacă invalid, ascunde wrap-ul (placeholder normal apare)
și loghează console.warn cu preview pentru investigation root cause.

Tech debt urmărit separat: migrare img2 → pattern formulare_capturi
(BYTEA + endpoint dedicat, simetric cu captura 1).

Issue R-B — ALOP cu DF emis blocat la cancel:
POST /api/alop/:id/cancel verifică EXISTS(formulare_df WHERE id=alop.df_id
AND deleted_at IS NULL) înainte de UPDATE. Dacă DF există, 409 cu
cancel_blocked_df_exists + detalii (df_id, df_nr, df_status). Refuze R0
eliberează df_id=NULL → cancel redevine permis (simetric cu v3.9.497 refuse).

Frontend: butonul X în lista ALOP și butonul Anulează în detalii sunt
ascunse când a.df_id e setat (canCancel = active && !a.df_id). Mesaj
user-friendly pe 409 din cancelAlop().

Tests:
- alop-cancel-block-df.test.mjs (6 cases: block cu DF activ/transmis_flux,
  permis cu df_id=NULL sau DF soft-deleted, regression completed/permission)
- populate-ord-img2-validation.test.mjs (2 cases: string-match pentru
  validare prefix + console.warn pe valoare invalidă)"
git push origin develop
```

============================================================
## RAPORT FINAL — răspunde EXACT la următoarele

1. Ce versiune e acum în `package.json` și ce `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează în total acum? Toate verzi?
3. SHA-ul commit-ului pushed pe develop (`git rev-parse HEAD`)?
4. Output-ul `grep -c "v3.9.498" public/js/formular/doc.js public/js/formular/alop.js server/routes/alop.mjs` — așteptăm 1 match în doc.js, 3 în alop.js, 1 în alop.mjs (5 total).
5. `git status` după push → "working tree clean". Confirmă.

============================================================
## RECOMANDĂRI POST-SPRINT (nu se implementează acum)

**1. Investigation root cause img2 corupere (Issue R-A defensive a mascat simptomul, NU rezolvă root cause):**
- Pe staging, după deploy, reproduceți scenariul (P1 upload captura 2 + submit → P2 deschide).
- Verificați console-ul browser pentru `[v3.9.498] populateOrd: doc.img2 invalid`.
- Dacă apare warning-ul, valoarea logată (primele 80 caractere + typeof) indică root cause-ul.
- Verificați paralel logs serverul Railway pentru request-ul GET /api/formulare-ord/:id când P2 deschide — uitați-vă la dimensiunea răspunsului JSON.

**2. Migrare img2 la pattern formulare_capturi (refactor structural):**
- Migrație DB nouă: drop column `formulare_ord.img2` (sau păstrare temporară pentru rollback).
- Frontend: înlocuiți `showImg` direct cu fetch GET la `/api/formulare-capturi/ord/:id?slot=2`.
- Server: extindeți endpoint-ul de captura cu parametru `slot=1|2` și coloană `slot SMALLINT` în `formulare_capturi`.
- Beneficii: BYTEA în loc de TEXT base64 (4/3 economie de spațiu), separare upload de doc submit (no large JSON), simetrie cu captura 1.
- Estimare: 1 sprint dedicat. Risc mediu (migrație DB + 2-3 schimbări frontend coordinate).

**3. Cleanup `colO()` vs `collectOrdDb()`:**
- Cele două funcții colectează parțial aceleași date, divergente pe img2. Unificare după rezolvarea recomandării #2 ar elimina inconsistența.

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`
- `server/routes/flows/cloud-signing.mjs`
- `server/routes/flows/bulk-signing.mjs`
- `server/signing/pades.mjs`
- `server/signing/java-pades-client.mjs`
- `server/routes/flows/signing.mjs` și `server/routes/flows/lifecycle.mjs` — niciun fix aici
- `server/utils/convertToPdf.mjs`, `server/utils/pdf-content-detect.mjs` — niciun fix aici
- `server/services/authz-formular.mjs` — `canDestroyOnly` rămâne intact, doar mock-uit în test
- Testele existente: `alop.test.mjs`, `state-machine.test.mjs`, `df-refuse-restore.test.mjs`, `df-workflow.test.mjs`, `flows.test.mjs` — nu se modifică pentru a face să treacă. Dacă pică, raportează.
- `showImg` și `clrImg` în `public/js/formular/core.js` — rămân intacte. Defensive validation se face în populateOrd, ÎNAINTE de showImg.
- Endpoint-ul `/api/formulare-capturi/:type/:id` — neatins. Migrarea img2 acolo e listată ca recomandare separată.

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
