# PROMPT — v3.9.501 — DF attachments persistence (slot pattern, simetric cu capturi)

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.500 e merge-uit pe develop (commit 25943bb3fd6d03f53eaddd47ed183f19a9324564) și `git pull origin develop` rulat local.

============================================================
## CONTEXT

v3.9.500 a rezolvat persistența atașamentelor pentru ORD (single set: `o-adata`/`o-alist`), dar a marcat DF ca tech debt explicit prin guard-ul `if(ft!=='ordnt')return;` în `uploadAttachments`/`fetchAttachments`/`renderAttachments`.

DF are **2 zone distincte de atașamente**:
- **`n-fdad`/`n-fdal`** — atașamente la descrierea pe larg a stării de fapt și de drept (P1, secțiunea A — partea FD). Fișiere justificative pentru conținutul FD.
- **`n-adata`/`n-alist`** — atașamente la motivarea blocării de noi angajamente (P2, secțiunea B — opțional pe `n-ck-intrucat`). Documente justificative pentru decizia P2.

Sunt **independente semantic** și aparțin de roluri diferite. Necesită discriminator (slot) în storage.

**Soluție arhitecturală**: simetric cu pattern-ul `formulare_capturi` din v3.9.499 — adaugă coloană `slot SMALLINT DEFAULT 1` pe `formulare_atasamente`. Mapping:

| `ft`     | `slot` | `did` (input ascuns) | `lid` (lista vizuală) | Semnificație               |
|----------|--------|----------------------|------------------------|------------------------------|
| `ordnt`  | 1      | `o-adata`            | `o-alist`              | Compartiment specialitate (P1) |
| `ordnt`  | 2      | —                    | —                      | nu există (no-op)            |
| `notafd` | 1      | `n-fdad`             | `n-fdal`               | FD documents (P1, sec. A)    |
| `notafd` | 2      | `n-adata`            | `n-alist`              | Section B docs (P2)          |

Rândurile existente în `formulare_atasamente` (toate de la ORD până acum) primesc automat `slot=1` via `DEFAULT 1`. Backend-ul default-uiește la `slot=1` dacă query param lipsește — backward compat cu apelurile v3.9.500.

============================================================
## PAS 1 — DB migration 081: slot column pe `formulare_atasamente`

În `server/db/index.mjs`, în array-ul `MIGRATIONS`, imediat după migrația `080_formulare_atasamente` (linia ~1729) și înainte de `];`, adaugă:

```js
  ,{
    id: '081_formulare_atasamente_slot',
    sql: `
      -- v3.9.501: extindere formulare_atasamente cu slot pentru a permite multiple
      -- seturi de atașamente per formular. ORD folosește doar slot=1 (Compartiment
      -- specialitate). DF folosește slot=1 (n-fdad — FD documents, P1, sec. A) +
      -- slot=2 (n-adata — section B docs, P2). Rândurile existente primesc slot=1
      -- prin DEFAULT — backward compat cu apelurile v3.9.500 (ORD).
      ALTER TABLE formulare_atasamente
        ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;

      -- Index combined pe (form_type, form_id, slot) cu filter deleted_at IS NULL
      -- pentru query-uri rapide de list per slot.
      DROP INDEX IF EXISTS idx_formulare_atasamente_form;
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_form
        ON formulare_atasamente(form_type, form_id, slot) WHERE deleted_at IS NULL;
    `
  }
```

Verifică:
```bash
node --check server/db/index.mjs
grep -n "081_formulare_atasamente_slot" server/db/index.mjs
```

Expected: fără eroare; 1 match.

============================================================
## PAS 2 — Backend: extindere 4 endpoint-uri `formulare-atasamente` cu slot

În `server/routes/formulare-db.mjs`, modifică cele 4 endpoint-uri scrise în v3.9.500.

### 2.a — POST upload: acceptă `slot` din query, default 1

Localizează `router.post('/api/formulare-atasamente/:type/:id', _csrf, ...)`. În interiorul handlerului, **după** validarea `canUpload` și **înainte** de citirea body-ului raw, adaugă parsarea slot-ului:

```js
    // v3.9.501: slot pentru a permite multiple seturi per formular (DF n-fdad vs n-adata)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
```

Apoi în INSERT, schimbă query-ul + parametrii. Înlocuiește:

```js
    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, filename, mime_type, size_bytes, created_at
    `, [type, id, actor.userId, filename, mime_type, data.length, data]);
```

cu:

```js
    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mime_type, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mime_type, data.length, data, slot]);
```

Și schimbă log-ul corespunzător pentru a include slot:

```js
    logger.info({ type, id, slot, attId: inserted[0].id, size: data.length, actor: actor.email }, 'formulare-atasament upload');
```

### 2.b — GET list: acceptă `slot` din query, default 1

Localizează `router.get('/api/formulare-atasamente/:type/:id', ...)` (cea care returnează lista — fără `:attId`). În interior, **după** verificarea de permisiune, **înainte** de SELECT, adaugă parsarea slot-ului:

```js
    // v3.9.501: filtrare per slot (default 1 backward compat)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
```

Apoi schimbă SELECT. Înlocuiește:

```js
    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM formulare_atasamente
       WHERE form_type=$1 AND form_id=$2 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [type, id]
    );
```

cu:

```js
    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, slot, created_at
       FROM formulare_atasamente
       WHERE form_type=$1 AND form_id=$2 AND slot=$3 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [type, id, slot]
    );
```

### 2.c — GET download: neatins

`router.get('/api/formulare-atasamente/:type/:id/:attId', ...)` — descărcarea individuală folosește `:attId` care e unic, deci slot nu trebuie aici. Neatins.

### 2.d — DELETE: neatins

`router.delete('/api/formulare-atasamente/:type/:id/:attId', _csrf, ...)` — ștergerea folosește `:attId` unic, slot redundant. Neatins.

Verifică:
```bash
node --check server/routes/formulare-db.mjs
grep -n "v3.9.501" server/routes/formulare-db.mjs
grep -c "slot" server/routes/formulare-db.mjs
```

Expected: fără eroare; minim 2 match-uri v3.9.501 (POST + GET); slot apare în query INSERT + SELECT + parsare param.

============================================================
## PAS 3 — Frontend: refactor `uploadAttachments(ft, slot)` în `public/js/formular/doc.js`

În `public/js/formular/doc.js`, localizează blocul de atașamente scris în v3.9.500 (în jurul comentariului `// ── Atașamente (Compartiment specialitate) v3.9.500 ──`).

Mai întâi, introduce helper-ul `_attIds` ÎNAINTE de `uploadAttachments` (sub comentariul de bloc):

```js
// ── Atașamente (Compartiment specialitate + secțiunea B) ──────────────────────
// v3.9.501: extins cu slot pentru DF (n-fdad slot=1, n-adata slot=2)
// Mapping (ft, slot) → (did, lid):
//   ordnt + 1 → o-adata / o-alist   (Compartiment specialitate)
//   notafd + 1 → n-fdad / n-fdal    (FD documents — sec. A, P1)
//   notafd + 2 → n-adata / n-alist  (Section B docs — P2)
//   ordnt + 2 → no-op (nu există)
function _attIds(ft, slot) {
  const s = slot === 2 ? 2 : 1;
  if (ft === 'ordnt') return s === 1 ? { did:'o-adata', lid:'o-alist' } : null;
  if (ft === 'notafd') return s === 1 ? { did:'n-fdad',  lid:'n-fdal' }
                                       : { did:'n-adata', lid:'n-alist' };
  return null;
}
```

Apoi înlocuiește integral `uploadAttachments` cu:

```js
async function uploadAttachments(ft, slot = 1){
  const ids = _attIds(ft, slot); if (!ids) return;
  if (!ST.docId[ft]) return;
  const { did, lid } = ids;
  const _slot = slot === 2 ? 2 : 1;
  let cur; try { cur = JSON.parse(document.getElementById(did)?.value || '[]'); } catch (_) { return; }
  if (!Array.isArray(cur)) return;
  let changed = false;
  for (let i = 0; i < cur.length; i++) {
    const item = cur[i];
    if (item?.id || !item?.data) continue;
    try {
      const [header, b64] = String(item.data).split(',');
      if (!b64) continue;
      const mime = header.match(/:(.*?);/)?.[1] || item.type || 'application/octet-stream';
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
      const blob = new Blob([arr], { type: mime });
      const r = await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`, {
        method: 'POST', credentials: 'include',
        headers: {
          'Content-Type': mime,
          'X-CSRF-Token': df.getCsrf(),
          'X-Filename': item.name || 'atasament',
        },
        body: blob,
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.atasament) {
        cur[i] = { id: j.atasament.id, filename: j.atasament.filename, mime_type: j.atasament.mime_type, size_bytes: j.atasament.size_bytes };
        changed = true;
      }
    } catch (e) { console.warn('[v3.9.501] uploadAttachments error', item?.name, e); }
  }
  if (changed) {
    document.getElementById(did).value = JSON.stringify(cur);
    renderAttachments(ft, _slot);
  }
}
```

Apoi `fetchAttachments`:

```js
async function fetchAttachments(ft, slot = 1){
  const ids = _attIds(ft, slot); if (!ids) return;
  if (!ST.docId[ft]) return;
  const { did } = ids;
  const _slot = slot === 2 ? 2 : 1;
  try {
    const r = await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`, { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.atasamente)) return;
    const list = j.atasamente.map(a => ({
      id: a.id, filename: a.filename, mime_type: a.mime_type, size_bytes: a.size_bytes
    }));
    document.getElementById(did).value = JSON.stringify(list);
    renderAttachments(ft, _slot);
  } catch (e) { console.warn('[v3.9.501] fetchAttachments error', e); }
}
```

Apoi `renderAttachments`:

```js
function renderAttachments(ft, slot = 1){
  const ids = _attIds(ft, slot); if (!ids) return;
  const { did, lid } = ids;
  const list = document.getElementById(lid); if (!list) return;
  list.innerHTML = '';
  let cur; try { cur = JSON.parse(document.getElementById(did)?.value || '[]'); } catch (_) { return; }
  if (!Array.isArray(cur)) return;
  const docId = ST.docId[ft];
  cur.forEach((item, idx) => {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    const name = item.filename || item.name || 'fișier';
    const safe = String(name).replace(/[<>"]/g, '');
    if (item.id && docId) {
      const url = `/api/formulare-atasamente/${ftType(ft)}/${docId}/${encodeURIComponent(item.id)}`;
      chip.innerHTML = `📎 <a href="${url}" target="_blank" style="color:inherit">${safe}</a> <button onclick="remAttServer(${idx},'${lid}','${did}','${item.id}',this)">✕</button>`;
    } else {
      chip.innerHTML = `📎 ${safe} <button onclick="remAtt(${idx},'${lid}','${did}',this)">✕</button>`;
    }
    list.appendChild(chip);
  });
}
```

`remAttServer` rămâne neatins — folosește (lid, did, attId) și deduce ft din `lid` prefix. Funcționează la fel pentru DF.

NB: signature schimbă din `uploadAttachments(ft)` → `uploadAttachments(ft, slot=1)`. Toate apelurile vechi (v3.9.500) care nu specifică slot continuă să funcționeze (slot default 1).

Verifică:
```bash
grep -n "v3.9.501" public/js/formular/doc.js
grep -n "function _attIds\|async function uploadAttachments\|async function fetchAttachments\|function renderAttachments" public/js/formular/doc.js
```

Expected: minim 1 match v3.9.501 (comentariu bloc); 4 match-uri pentru funcții.

============================================================
## PAS 4 — Frontend: extinde apelurile pentru DF (slot 1 + slot 2)

### 4.a — `saveDoc` în `public/js/formular/doc.js`

Localizează blocul scris în v3.9.500 (linia ~668-672):

```js
    // v3.9.499: upload ambele sloturi (slot 1 pentru DF/ORD, slot 2 doar ORD)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
    // v3.9.500: upload atașamente pending (cele fără id)
    if(ft==='ordnt' && ST.docId[ft]) await uploadAttachments(ft);
```

Înlocuiește linia v3.9.500 cu:

```js
    // v3.9.501: upload atașamente pending pentru ambele sloturi (ORD slot 1, DF slot 1+2)
    if(ST.docId[ft]){
      await uploadAttachments(ft, 1);
      if(ft==='notafd') await uploadAttachments(ft, 2);
    }
```

### 4.b — `completeAsP2` în `public/js/formular/doc.js`

Localizează (linia ~965-967):

```js
  // v3.9.499: upload ambele sloturi când P2 finalizează (root cause R-A fix —
  // înainte, captura 2 era pierdută pentru că completeAsP2 trimitea doar slot 1)
  await uploadCaptura(ft, 1);
  if(ft==='ordnt') await uploadCaptura(ft, 2);
  // v3.9.500: upload atașamente pending înainte de complete
  if(ft==='ordnt') await uploadAttachments(ft);
```

Înlocuiește linia v3.9.500 cu:

```js
  // v3.9.501: upload atașamente pending (ambele sloturi pentru DF, slot 1 pentru ORD)
  await uploadAttachments(ft, 1);
  if(ft==='notafd') await uploadAttachments(ft, 2);
```

### 4.c — `_autoSaveDb` în `public/js/formular/list.js`

Localizează blocul (linia ~59 area, după v3.9.500):

```js
    // v3.9.499: auto-save uploadează ambele sloturi (slot 2 doar pentru ord)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
    // v3.9.500: auto-save uploadează atașamente pending
    if(ft==='ordnt' && ST.docId[ft]) await uploadAttachments(ft);
```

Înlocuiește linia v3.9.500 cu:

```js
    // v3.9.501: auto-save uploadează atașamente pending pentru ambele sloturi
    if(ST.docId[ft]){
      await uploadAttachments(ft, 1);
      if(ft==='notafd') await uploadAttachments(ft, 2);
    }
```

Verifică:
```bash
grep -n "v3.9.501" public/js/formular/doc.js public/js/formular/list.js
grep -c "uploadAttachments(ft, " public/js/formular/doc.js
grep -c "uploadAttachments(ft, " public/js/formular/list.js
```

Expected: minim 3 match-uri v3.9.501; `doc.js` ≥4 (saveDoc x2 + completeAsP2 x2); `list.js` ≥2.

============================================================
## PAS 5 — Frontend: `loadDoc` apelează `fetchAttachments` pentru DF (ambele sloturi)

Localizează în `loadDoc` linia adăugată în v3.9.500:

```js
    // v3.9.500: încarcă lista de atașamente server-side (înlocuiește o-adata local)
    if(ft==='ordnt') await fetchAttachments(ft);
```

Înlocuiește cu:

```js
    // v3.9.501: încarcă lista de atașamente server-side pentru ambele sloturi
    // (ORD: doar slot 1; DF: slot 1 = n-fdad, slot 2 = n-adata)
    await fetchAttachments(ft, 1);
    if(ft==='notafd') await fetchAttachments(ft, 2);
```

Verifică:
```bash
grep -n "v3.9.501: încarcă lista de atașamente" public/js/formular/doc.js
grep -c "fetchAttachments(ft" public/js/formular/doc.js
```

Expected: 1 match comentariu; ≥2 apeluri fetchAttachments (slot 1 + slot 2).

============================================================
## PAS 6 — Frontend: `newDoc` DF deja resetează ambele liste (verificare)

`newDoc(ft)` la linia ~603 are deja blocul pentru DF (linia 618):

```js
['n-fdad','n-adata'].forEach(id=>document.getElementById(id).value='[]');
['n-fdal','n-alist'].forEach(id=>document.getElementById(id).innerHTML='');
```

Acest cod era acolo deja înainte de v3.9.500 și e corect pentru noul slot system. **NU se modifică**.

Verifică doar că e neschimbat:
```bash
grep -n "'n-fdad','n-adata'" public/js/formular/doc.js
```

Expected: 1-2 match-uri (în `newDoc` și `resetF`).

============================================================
## PAS 7 — Tests

### 7.a — `server/tests/integration/formulare-atasamente-df-slot.test.mjs`

Creează:

```js
/**
 * v3.9.501 — formulare-atasamente cu slot pentru DF
 *
 * Acoperire:
 *   ✓ POST cu ?slot=2 → INSERT cu slot=2
 *   ✓ POST fără query → default slot=1 (backward compat v3.9.500 ORD)
 *   ✓ POST cu slot invalid → cădere la slot=1
 *   ✓ GET list ?slot=2 → SELECT WHERE slot=2
 *   ✓ GET list fără query → SELECT WHERE slot=1
 *   ✓ Replace slot 2 pe DF nu afectează slot 1 (isolation)
 *   ✓ DF cu atașamente pe ambele sloturi: list slot=1 vs slot=2 returnează diferit
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn() },
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

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfProtection: (req, res, next) => next(),
  _csrf:          (req, res, next) => next(),
}));

vi.mock('../../services/authz-formular.mjs', () => ({
  canDestroyOnly:  vi.fn().mockResolvedValue({ allowed: true }),
  canEditFormular: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../services/entitlements.mjs', () => ({
  requireModule: () => (req, res, next) => next(),
}));

import * as dbModule from '../../db/index.mjs';
import dbRouter from '../../routes/formulare-db.mjs';

const DF_ID  = 'aaaadddd-0000-0000-0000-00000000DF01';
const ATT_S1 = 'aaaa1111-1111-1111-1111-111111111111';
const ATT_S2 = 'bbbb2222-2222-2222-2222-222222222222';

const JWT_SECRET = 'test-secret-min-32-chars-long-for-jwt-signing';
process.env.JWT_SECRET = JWT_SECRET;

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const t = jwt.sign({ email: 'p1@x.ro', role, orgId, userId }, JWT_SECRET, { expiresIn: '1h' });
  return `df_auth=${t}`;
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/', dbRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST upload cu slot', () => {
  it('?slot=2 → INSERT cu slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S2, filename: 'sectB.pdf', mime_type: 'application/pdf', size_bytes: 500, slot: 2, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/df/${DF_ID}?slot=2`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', 'sectB.pdf')
      .send(Buffer.from('PDF-CONTENT-MOCK'));

    expect(res.status).toBe(200);
    expect(res.body.atasament.slot).toBe(2);

    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall).toBeDefined();
    // Ultimul param trebuie să fie slot=2
    expect(insertCall[1][7]).toBe(2);
  });

  it('fără ?slot → default slot=1 (backward compat ORD v3.9.500)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 100, slot: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${DF_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall[1][7]).toBe(1);
  });

  it('?slot=99 (invalid) → cădere la slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, slot: 1 }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/df/${DF_ID}?slot=99`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('y'));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall[1][7]).toBe(1);
  });
});

describe('GET list cu slot', () => {
  it('?slot=2 → SELECT WHERE slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S2, filename: 'sectB.pdf', mime_type: 'application/pdf', size_bytes: 500, slot: 2, uploaded_by: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/df/${DF_ID}?slot=2`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.atasamente).toHaveLength(1);
    expect(res.body.atasamente[0].slot).toBe(2);

    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, filename, mime_type') &&
      String(c[0]).includes('slot=$3')
    );
    expect(selectCall, 'SELECT cu slot=$3 nu a fost apelat').toBeDefined();
    expect(selectCall[1]).toEqual(['df', DF_ID, 2]);
  });

  it('fără ?slot → SELECT WHERE slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, filename: 'fd.pdf', mime_type: 'application/pdf', size_bytes: 300, slot: 1, uploaded_by: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/df/${DF_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, filename, mime_type')
    );
    expect(selectCall[1]).toEqual(['df', DF_ID, 1]);
  });

  it('slot 1 list returnează doar slot 1 (izolare slot)', async () => {
    // DF are 1 atașament pe slot 1 și 1 pe slot 2; query-ul slot=1 returnează doar slot 1
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, filename: 'fd.pdf', mime_type: 'application/pdf', size_bytes: 300, slot: 1, uploaded_by: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/df/${DF_ID}?slot=1`)
      .set('Cookie', makeAuthCookie());

    expect(res.body.atasamente).toHaveLength(1);
    expect(res.body.atasamente[0].slot).toBe(1);
    // Niciun atașament cu slot=2 nu trebuie să apară
    expect(res.body.atasamente.find(a => a.slot === 2)).toBeUndefined();
  });
});
```

### 7.b — Actualizare `server/tests/unit/v3-9-500-fixes.test.mjs`

**ATENȚIE: actualizare permisă a unui test existent v3.9.500.** Semnătura `uploadAttachments(ft)` se schimbă în `uploadAttachments(ft, slot=1)` — regex-urile de string-match din v3-9-500-fixes.test.mjs vor cădea pe semnătură.

Localizează în `server/tests/unit/v3-9-500-fixes.test.mjs` blocul "I-3":

```js
  it('uploadAttachments / fetchAttachments / renderAttachments / remAttServer declarate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/async function uploadAttachments\(ft\)/);
    expect(src).toMatch(/async function fetchAttachments\(ft\)/);
    expect(src).toMatch(/function renderAttachments\(ft\)/);
    expect(src).toMatch(/async function remAttServer/);
  });
```

Înlocuiește regex-urile signature pentru a accepta ambele forme (cu sau fără slot):

```js
  it('uploadAttachments / fetchAttachments / renderAttachments / remAttServer declarate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // v3.9.501: signature extinsă cu slot (ft, slot=1)
    expect(src).toMatch(/async function uploadAttachments\(ft(?:,\s*slot\s*=\s*1)?\)/);
    expect(src).toMatch(/async function fetchAttachments\(ft(?:,\s*slot\s*=\s*1)?\)/);
    expect(src).toMatch(/function renderAttachments\(ft(?:,\s*slot\s*=\s*1)?\)/);
    expect(src).toMatch(/async function remAttServer/);
  });
```

Acestea sunt singurele modificări permise în testele existente (regex compatibility, ZERO aserții comportament schimbate).

Verifică:
```bash
node --check server/tests/integration/formulare-atasamente-df-slot.test.mjs
npx vitest run server/tests/integration/formulare-atasamente-df-slot.test.mjs server/tests/unit/v3-9-500-fixes.test.mjs
```

Expected: 6 teste noi DF-slot + 5 teste v3-9-500 actualizate trec.

============================================================
## PAS 8 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -50
```

Expected: +6 teste față de v3.9.500. Toate verzi.

Verifică în special că rămân verzi:
- `server/tests/integration/formulare-atasamente.test.mjs` (v3.9.500) — extensia cu slot param e backward compat (default 1)
- `server/tests/integration/formulare-capturi-slot.test.mjs` (v3.9.499)
- `server/tests/integration/alop-cancel-block-df.test.mjs` (v3.9.498)
- `server/tests/integration/cancel-restore.test.mjs` (v3.9.497)
- `server/tests/unit/populate-ord-img2-validation.test.mjs` (regex `/v3\.9\.[45]\d\d/` deja acceptă v3.9.501)
- `server/tests/unit/v3-9-500-fixes.test.mjs` (actualizat ca mai sus)

============================================================
## PAS 9 — Version bump

În `package.json`: `3.9.500` → `3.9.501`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v215` → `docflowai-v216`.

```bash
grep '"version"' package.json
grep "CACHE_VERSION" public/sw.js | head -1
```

============================================================
## PAS 10 — Commit + push develop

```bash
git status
git add server/db/index.mjs \
        server/routes/formulare-db.mjs \
        public/js/formular/doc.js \
        public/js/formular/list.js \
        server/tests/integration/formulare-atasamente-df-slot.test.mjs \
        server/tests/unit/v3-9-500-fixes.test.mjs \
        package.json public/sw.js
git commit -m "feat(df): atașamente persistență cu slot pentru ambele zone (v3.9.501)

v3.9.500 a rezolvat persistența atașamentelor pentru ORD (single set
o-adata). DF rămăsese tech debt: are 2 zone independente — n-fdad
(FD documents, P1, sec. A) și n-adata (section B docs, P2) — care
trăiau doar în memoria clientului și se pierdeau la reload.

Soluție arhitecturală simetrică cu v3.9.499 (formulare_capturi slot):
- ALTER TABLE formulare_atasamente ADD COLUMN slot SMALLINT DEFAULT 1
  (migrație 081). Rândurile existente primesc slot=1 — backward compat.
- POST + GET list acceptă ?slot=1|2 (default 1).
- POST DELETE neatins (folosesc :attId unic, slot redundant).
- Helper _attIds(ft, slot) → (did, lid) mapping centralizat în doc.js.
- uploadAttachments(ft, slot=1) / fetchAttachments(ft, slot=1) /
  renderAttachments(ft, slot=1) — signature extinsă (backward compat).
- saveDoc, completeAsP2, _autoSaveDb apelează ambele sloturi pentru DF
  (await uploadAttachments(ft, 1); if(notafd) await uploadAttachments(ft, 2);)
- loadDoc apelează fetchAttachments(ft, 1) + (ft, 2 pentru DF).

Mapping final:
  ord  slot=1 → o-adata  / o-alist  (Compartiment specialitate)
  ord  slot=2 → no-op
  df   slot=1 → n-fdad   / n-fdal   (FD documents — sec. A, P1)
  df   slot=2 → n-adata  / n-alist  (Section B docs — P2)

Tests: formulare-atasamente-df-slot.test.mjs (6 cazuri: POST/GET cu
slot, default backward compat, izolare slot). v3-9-500-fixes.test.mjs
actualizat regex signature pentru a accepta forma (ft, slot=1) —
ZERO modificări de aserții comportament."
git push origin develop
```

============================================================
## RAPORT FINAL — răspunde EXACT la următoarele

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi? Confirmă explicit că testele din v3.9.497/498/499/500 trec.
3. SHA commit pushed pe develop?
4. Migrația 081 prezentă: `grep -n "081_formulare_atasamente_slot" server/db/index.mjs` → 1 match.
5. Output `grep -c "v3.9.501" server/db/index.mjs server/routes/formulare-db.mjs public/js/formular/doc.js public/js/formular/list.js` — minim 1 per fișier (4 atinse).
6. Au fost necesare modificări de regex în alte teste existente decât `v3-9-500-fixes.test.mjs` (care e listată ca permis în PAS 7.b)? Dacă DA, listează exact ce ai schimbat.
7. `git status` post-push → "working tree clean". Confirmă.

============================================================
## RECOMANDĂRI POST-SPRINT

1. **UX lock fix**: în `setModeP2Df`, butoanele și file inputs pentru `n-fdai` (slot 1 — FD documents, secțiunea A) ar trebui dezactivate pentru P2 (e responsabilitatea P1). Similar, în branch-ul pending_p2 + role=p1 (line 507-510 doc.js), `n-ainp` (slot 2 — P2's section B) ar trebui dezactivat pentru P1. `lockCaptureAndAttachments` actual folosește `getElementById` hardcodat pe un singur file input — necesită extensie la `querySelectorAll('.att-inp')` cu logică per slot. ~20 linii, sprint UX dedicat.

2. **DEPRECARE `colN()` câmpuri redundante**: după ce DF attachments sunt complet persistate via endpoint dedicat, `attachmentsFd` și `attachments` din `colN()` (linia 320-321 core.js) duplică datele server-side. PDF generator poate fetcha din endpoint la momentul generării. Refactor opțional pentru curățarea data flow-ului.

3. **Test E2E captură + atașamente full flow DF**: combinați populateDf + uploadAttachments(slot=1) + (slot=2) + reload + verificare ambele liste hidratate corect. Test integration cu DB real (testcontainers), fără mock. Util pentru detectarea regresiilor cross-component.

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`
- `server/routes/flows/cloud-signing.mjs`
- `server/routes/flows/bulk-signing.mjs`
- `server/signing/pades.mjs`
- `server/signing/java-pades-client.mjs`
- `server/routes/flows/signing.mjs`, `server/routes/flows/lifecycle.mjs`, `server/routes/flows/crud.mjs`
- `server/utils/convertToPdf.mjs`, `server/utils/pdf-content-detect.mjs`
- `server/services/authz-formular.mjs`
- `public/js/formular/core.js` — `addAtt`, `remAtt`, `colN()`, `colO()` rămân neatinse
- `public/formular.html` — niciun id schimbat (n-fdad, n-fdal, n-adata, n-alist, n-fdai, n-ainp)
- Coloana `formulare_ord.img2` — rămâne deprecated (fallback citire)
- `server/index.mjs` — neatins în acest sprint
- Testele existente: doar `v3-9-500-fixes.test.mjs` PAS 7.b — regex signature update. Niciun alt test. Raportează dacă apar regresii.

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
