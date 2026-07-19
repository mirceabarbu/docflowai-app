# PROMPT — v3.9.499 — Captura 2 → formulare_capturi (root cause R-A) + audit cleanup C/D/E

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.498 e merge-uit pe develop și `git pull origin develop` e rulat local.

============================================================
## CONTEXT

Re-diagnostic R-A cu workflow-ul corect (P2 încarcă captura 2, NU P1):

`completeAsP2` în `public/js/formular/doc.js:963` trimite `body = {rows: getOR()}` la `/api/formulare-ord/:id/complete` (whitelist `ORD_P2_FIELDS = ['rows']`). Apoi `uploadCaptura(ft)` uploadează doar `o-cimg` (slot 1) la `/api/formulare-capturi/ord/:id`. **`o-cimg2` (captura 2) nu se trimite nicăieri** — trăiește doar în `imgs['o-cimg2']` în memorie. La reload, valoarea e null sau o stare intermediară coruptă din DB (din încercări P1 anterioare). De aceea v3.9.498 defensive fix a mascat simptomul broken-icon, dar root cause-ul real e arhitectural: captura 2 nu are pipeline de persistență.

Defensive fix-ul v3.9.498 rămâne în loc (graceful fallback). Acum implementăm pipeline-ul real, simetric cu captura 1, prin extinderea `formulare_capturi` cu coloană `slot`. Asta rezolvă:

- **R-A real** — captura 2 ajunge în BYTEA prin endpoint dedicat, indiferent cine o încarcă (P1, P2, admin)
- **Finding C** — asimetrie arhitecturală eliminată: ambele capturi prin `formulare_capturi`
- **Finding D** — `collectOrdDb` nu mai are `img2` (eliminat divergență cu `colO`)
- **Finding E** — rate limit pe `/api/alop/admin/repair-status` (low priority dar quick)

`formulare_ord.img2` rămâne ca **coloană deprecated** (fallback citire în populateOrd pentru ord-uri vechi cu img2 stocat inline). Drop-ul coloanei într-un sprint viitor după ce backfill-ul confirmă migrarea completă.

============================================================
## PAS 1 — DB migration: slot column pe `formulare_capturi`

În `server/db/index.mjs`, în array-ul `MIGRATIONS`, adaugă o intrare nouă DUPĂ migrația existentă `'078_registratura_motiv_rezolutie'` (în jurul liniei 1680). Imediat înainte de `];` care închide array-ul:

```js
  ,{
    id: '079_formulare_capturi_slot',
    sql: `
      -- v3.9.499: extindere formulare_capturi cu slot pentru a permite multiple
      -- capturi per formular (ord captura 1 + captura 2). DF folosește doar slot=1.
      ALTER TABLE formulare_capturi
        ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;

      -- Drop indexul vechi non-unique pe (form_type, form_id) ca să facem unique pe triplet
      DROP INDEX IF EXISTS idx_formulare_capturi_form;
      CREATE INDEX IF NOT EXISTS idx_formulare_capturi_form
        ON formulare_capturi(form_type, form_id);

      -- Constraint unic pe triplet pentru a permite upsert per slot
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_formulare_capturi_form_slot
        ON formulare_capturi(form_type, form_id, slot);

      -- Backfill din formulare_ord.img2 → formulare_capturi(slot=2)
      -- Numai rândurile cu img2 valid (data URL format). Idempotent prin ON CONFLICT.
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
      SELECT
        'ord',
        fo.id,
        fo.created_by,
        'captura2_backfill.png',
        COALESCE(substring(fo.img2 from '^data:([^;]+);'), 'image/png'),
        CASE
          WHEN fo.img2 ~ '^data:image\\/[a-z]+;base64,'
          THEN length(decode(split_part(fo.img2, ',', 2), 'base64'))
          ELSE 0
        END,
        CASE
          WHEN fo.img2 ~ '^data:image\\/[a-z]+;base64,'
          THEN decode(split_part(fo.img2, ',', 2), 'base64')
          ELSE NULL
        END,
        2
      FROM formulare_ord fo
      WHERE fo.img2 IS NOT NULL
        AND fo.img2 ~ '^data:image\\/[a-z]+;base64,'
        AND length(fo.img2) > 100
      ON CONFLICT (form_type, form_id, slot) DO NOTHING;

      -- Marchează img2 ca deprecated în comentariu (col rămâne pentru fallback citire)
      COMMENT ON COLUMN formulare_ord.img2 IS 'DEPRECATED v3.9.499 — datele migrate la formulare_capturi(slot=2). Coloană păstrată pentru fallback citire ord-uri vechi.';
    `
  }
```

Verifică:
```bash
node --check server/db/index.mjs
grep -n "079_formulare_capturi_slot" server/db/index.mjs
grep -n "v3.9.499: extindere formulare_capturi" server/db/index.mjs
```

Expected: fără eroare sintaxă; câte un match per grep.

============================================================
## PAS 2 — Backend: extindere endpoint `formulare-capturi` cu slot

În `server/routes/formulare-db.mjs`, localizează blocul `POST /api/formulare-capturi/:type/:id` (linia ~1131) și `GET /api/formulare-capturi/:type/:id` (linia ~1185).

### 2.a — POST: acceptă `slot` din query, DELETE doar același slot

Înlocuiește linia 1167-1168 (DELETE-ul vechi care șterge TOATE capturile pentru form):

```js
    // Ștergem captura anterioară dacă există
    await pool.query(
      'DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2', [type, id]
    );
```

cu:

```js
    // v3.9.499: ștergem doar captura din același slot (default 1 backward compat)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    await pool.query(
      'DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3',
      [type, id, slot]
    );
```

Apoi în INSERT (linia 1170-1174), schimbă semnătura pentru a include slot. Înlocuiește:

```js
    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, filename, mimetype, size_bytes, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data]);
```

cu:

```js
    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mimetype, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data, slot]);
```

Și schimbă log-ul (linia 1176) pentru a include slot:

```js
    logger.info({ type, id, slot, size: data.length, actor: actor.email }, 'formulare-captura upload');
```

### 2.b — GET: acceptă `slot` din query, default 1

Înlocuiește linia 1203-1206 (SELECT-ul):

```js
    const { rows } = await pool.query(
      'SELECT filename, mimetype, data FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 ORDER BY created_at DESC LIMIT 1',
      [type, id]
    );
```

cu:

```js
    // v3.9.499: filtrare pe slot (default 1 backward compat pentru DF + clienti vechi)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    const { rows } = await pool.query(
      'SELECT filename, mimetype, data FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3 ORDER BY created_at DESC LIMIT 1',
      [type, id, slot]
    );
```

Și schimbă mesajul de eroare 404 (linia 1207):

```js
    if (!rows.length) return res.status(404).json({ error: 'no_captura', slot });
```

Verifică:
```bash
node --check server/routes/formulare-db.mjs
grep -n "v3.9.499:" server/routes/formulare-db.mjs
```

Expected: fără eroare; minim 3 match-uri pentru `v3.9.499:` (POST DELETE, POST INSERT log, GET SELECT).

============================================================
## PAS 3 — Backend: remove `img2` din `ORD_P1_FIELDS` (deprecation)

În `server/routes/formulare-db.mjs`, localizează `ORD_P1_FIELDS` la linia 63-69:

```js
const ORD_P1_FIELDS = [
  'cif','den_inst_pb','nr_ordonant_pl','data_ordont_pl',
  'nr_unic_inreg','beneficiar','documente_justificative',
  'iban_beneficiar','cif_beneficiar','banca_beneficiar',
  'inf_pv_plata','inf_pv_plata1','rows','compartiment_specialitate',
  'img2',
];
```

Înlocuiește cu (elimină `img2`):

```js
// v3.9.499: img2 ELIMINAT — captura 2 migrată la formulare_capturi(slot=2)
// via endpoint dedicat /api/formulare-capturi/ord/:id?slot=2. Coloana img2
// rămâne în DB pentru fallback citire ord-uri vechi (vezi populateOrd).
const ORD_P1_FIELDS = [
  'cif','den_inst_pb','nr_ordonant_pl','data_ordont_pl',
  'nr_unic_inreg','beneficiar','documente_justificative',
  'iban_beneficiar','cif_beneficiar','banca_beneficiar',
  'inf_pv_plata','inf_pv_plata1','rows','compartiment_specialitate',
];
```

Verifică:
```bash
grep -n "ORD_P1_FIELDS" server/routes/formulare-db.mjs | head -5
grep -c "'img2'" server/routes/formulare-db.mjs
```

Expected: ORD_P1_FIELDS referit doar de cod, nu definit ca array cu img2. `grep -c "'img2'"` returnează 0 (eliminat complet).

============================================================
## PAS 4 — Backend: rate limit pe `/api/alop/admin/repair-status` (Finding E)

În `server/routes/alop.mjs`, localizează linia 1047 (`router.post('/api/alop/admin/repair-status', _csrf, ...`).

Mai întâi verifică că `createRateLimiter` e importat. Caută în top-ul fișierului:
```bash
grep -n "createRateLimiter\|rateLimiter" server/routes/alop.mjs | head -5
```

Dacă NU e importat, adaugă la lista de import-uri (de obicei după `import { logger } from '../middleware/logger.mjs';`):

```js
import { createRateLimiter } from '../middleware/rateLimiter.mjs';
```

Apoi adaugă rate limiter-ul ÎNAINTE de definirea route-urilor (după import-uri, dacă nu există unul similar deja definit):

```js
// v3.9.499 (Finding E): rate limit pentru endpoint-uri admin destructive
const _alopAdminRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,  // 1 oră
  max: 5,
  message: 'Prea multe încercări de reparare ALOP. Așteptați 1 oră.'
});
```

Schimbă definirea route-ului (linia 1047):

```js
router.post('/api/alop/admin/repair-status', _csrf, async (req, res) => {
```

la:

```js
router.post('/api/alop/admin/repair-status', _alopAdminRateLimit, _csrf, async (req, res) => {
```

Verifică:
```bash
node --check server/routes/alop.mjs
grep -n "v3.9.499 (Finding E)" server/routes/alop.mjs
grep -n "_alopAdminRateLimit" server/routes/alop.mjs
```

Expected: fără eroare; 1 match comentariu; 2 match-uri _alopAdminRateLimit (declarare + folosire).

============================================================
## PAS 5 — Frontend: refactor `uploadCaptura(ft, slot)` în `public/js/formular/doc.js`

Localizează `uploadCaptura` la linia 676. Înlocuiește integral funcția:

```js
async function uploadCaptura(ft){
  const iid=ft==='ordnt'?'o-cimg':'n-cimg';
  const dataUrl=imgs[iid];if(!dataUrl||!ST.docId[ft])return;
  try{
    // dataUrl = 'data:image/png;base64,...'
    const[header,b64]=dataUrl.split(',');
    const mime=header.match(/:(.*?);/)?.[1]||'image/png';
    const bin=atob(b64);const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const blob=new Blob([arr],{type:mime});
    await fetch(`/api/formulare-capturi/${ftType(ft)}/${ST.docId[ft]}`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':mime,'X-CSRF-Token':df.getCsrf(),'X-Filename':`captura_${ft}.png`},
      body:blob,
    });
  }catch(_){}
}
```

cu:

```js
// v3.9.499: uploadCaptura acceptă slot. Slot 1 = captura principală (DF + ORD),
// slot 2 = captura 2 ORD ("Informații complete contract"). Datele se persistă în
// formulare_capturi via endpoint dedicat (BYTEA), eliminând asimetria veche unde
// captura 2 era inline base64 în coloana formulare_ord.img2.
async function uploadCaptura(ft, slot){
  const _slot=slot===2?2:1;
  // Slot 2 e doar pentru ord. Slot 1 e default pentru ambele.
  if(_slot===2&&ft!=='ordnt')return;
  const iid=_slot===2?'o-cimg2':(ft==='ordnt'?'o-cimg':'n-cimg');
  const dataUrl=imgs[iid];if(!dataUrl||!ST.docId[ft])return;
  try{
    const[header,b64]=dataUrl.split(',');
    const mime=header.match(/:(.*?);/)?.[1]||'image/png';
    const bin=atob(b64);const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const blob=new Blob([arr],{type:mime});
    await fetch(`/api/formulare-capturi/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':mime,'X-CSRF-Token':df.getCsrf(),'X-Filename':`captura_${ft}_${_slot}.png`},
      body:blob,
    });
  }catch(_){}
}
```

Verifică:
```bash
grep -n "uploadCaptura(ft, slot)\|uploadCaptura(ft, *2\|uploadCaptura(ft, *1" public/js/formular/doc.js
grep -n "?slot=" public/js/formular/doc.js
```

Expected: signature `(ft, slot)` găsit; query `?slot=` în fetch URL.

============================================================
## PAS 6 — Frontend: call sites uploadCaptura pentru ambele sloturi

### 6.a — `public/js/formular/doc.js` line 668 (saveDoc / manual save)

Localizează blocul:
```js
    // Upload captură dacă există
    const iid=ft==='ordnt'?'o-cimg':'n-cimg';
    if(imgs[iid]&&ST.docId[ft])await uploadCaptura(ft);
```

Înlocuiește cu:
```js
    // v3.9.499: upload ambele sloturi (slot 1 pentru DF/ORD, slot 2 doar ORD)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
```

### 6.b — `public/js/formular/doc.js` line 965 (completeAsP2)

Localizează:
```js
  // Upload captură
  await uploadCaptura(ft);
```

Înlocuiește cu:
```js
  // v3.9.499: upload ambele sloturi când P2 finalizează (root cause R-A fix —
  // înainte, captura 2 era pierdută pentru că completeAsP2 trimitea doar slot 1)
  await uploadCaptura(ft, 1);
  if(ft==='ordnt') await uploadCaptura(ft, 2);
```

### 6.c — `public/js/formular/list.js` line 59 (_autoSaveDb)

Localizează:
```js
    const iid=ft==='ordnt'?'o-cimg':'n-cimg';
    if(imgs[iid]&&ST.docId[ft])await uploadCaptura(ft);
```

Înlocuiește cu:
```js
    // v3.9.499: auto-save uploadează ambele sloturi (slot 2 doar pentru ord)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
```

Verifică:
```bash
grep -n "uploadCaptura(ft," public/js/formular/doc.js public/js/formular/list.js
```

Expected: minim 5 apeluri cu signature `(ft, 1)` sau `(ft, 2)`.

============================================================
## PAS 7 — Frontend: `populateOrd` fetches both slots + fallback

În `public/js/formular/doc.js`, localizează blocul existent de gestionare captura 2 în `populateOrd` (liniile 76-88, ce a rămas după v3.9.498 defensive fix):

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
    console.warn('[v3.9.498] populateOrd: doc.img2 invalid (preview):',
      typeof doc.img2, String(doc.img2).slice(0,80));
  }
```

Înlocuiește cu:

```js
  // v3.9.499: captura 2 fetch via formulare_capturi(slot=2) — sursa primară.
  // Fallback la doc.img2 (defensive validation v3.9.498) pentru ord-uri vechi
  // care încă au valoarea inline în formulare_ord.img2 (pre-migrare 079 backfill).
  const _wrap2=document.getElementById('o-captura2-wrap');
  try{
    const capR2=await fetch(`/api/formulare-capturi/ord/${doc.id||ST.docId.ordnt}?slot=2`,{credentials:'include'});
    if(capR2.ok&&capR2.headers.get('content-type')?.startsWith('image')){
      const blob=await capR2.blob();
      const reader=new FileReader();
      reader.onload=e=>{
        if(_wrap2)_wrap2.style.display='';
        showImg('o-cimg2','o-cph2',e.target.result);
      };
      reader.readAsDataURL(blob);
    } else {
      // Fallback la doc.img2 (defensive v3.9.498)
      const _img2Valid=typeof doc.img2==='string'
        && doc.img2.length>32
        && /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(doc.img2);
      if(_wrap2)_wrap2.style.display=_img2Valid?'':'none';
      if(_img2Valid){
        showImg('o-cimg2','o-cph2',doc.img2);
      }else if(doc.img2){
        console.warn('[v3.9.499] populateOrd: doc.img2 invalid + no slot=2 (preview):',
          typeof doc.img2, String(doc.img2).slice(0,80));
      }
    }
  }catch(e){
    console.warn('[v3.9.499] populateOrd: captura slot=2 fetch error', e);
    if(_wrap2)_wrap2.style.display='none';
  }
```

NB: această schimbare introduce `await` într-un loc unde înainte era sincron. `populateOrd` e deja `async` (verifică) — dacă nu, declar-o async. Verifică:

```bash
grep -n "^function populateOrd\|^async function populateOrd" public/js/formular/doc.js
```

Dacă output e `function populateOrd(doc){`, schimbă-l în `async function populateOrd(doc){`. Caller-ii deja awaitau implicit prin promise chain (verifică `populateOrd(doc)` în context — dacă e folosit în `Promise.all` sau așteptat, fine; dacă e fire-and-forget, fine — efectul vizual e că imaginea apare cu mică întârziere).

Verifică:
```bash
grep -n "v3.9.499: captura 2 fetch" public/js/formular/doc.js
grep -n "?slot=2" public/js/formular/doc.js
```

Expected: 1 match comentariu; 1 match în populateOrd.

============================================================
## PAS 8 — Frontend: cleanup `collectOrdDb` (Finding D) — drop img2

În `public/js/formular/doc.js` line 34-41:

```js
function collectOrdDb(){return{
  cif:g('o-cif'),den_inst_pb:g('o-den'),nr_ordonant_pl:g('o-nr'),data_ordont_pl:g('o-data'),
  nr_unic_inreg:g('o-nrUnic'),beneficiar:g('o-benef'),documente_justificative:g('o-docsj'),
  iban_beneficiar:g('o-iban'),cif_beneficiar:g('o-cifb'),banca_beneficiar:g('o-banca'),
  inf_pv_plata:g('o-inf1'),inf_pv_plata1:g('o-inf2'),rows:getOR(),
  df_id:document.getElementById('o-df-id')?.value||null,
  img2:imgs['o-cimg2']||null,
};}
```

Înlocuiește cu (elimină linia `img2:`):

```js
// v3.9.499 (Finding D): img2 ELIMINAT din collectOrdDb. Captura 2 se persistă
// exclusiv via /api/formulare-capturi/ord/:id?slot=2 (vezi uploadCaptura).
function collectOrdDb(){return{
  cif:g('o-cif'),den_inst_pb:g('o-den'),nr_ordonant_pl:g('o-nr'),data_ordont_pl:g('o-data'),
  nr_unic_inreg:g('o-nrUnic'),beneficiar:g('o-benef'),documente_justificative:g('o-docsj'),
  iban_beneficiar:g('o-iban'),cif_beneficiar:g('o-cifb'),banca_beneficiar:g('o-banca'),
  inf_pv_plata:g('o-inf1'),inf_pv_plata1:g('o-inf2'),rows:getOR(),
  df_id:document.getElementById('o-df-id')?.value||null,
};}
```

NB: NU atinge `colO()` în `core.js` (line 304-313) — acela e pentru PDF generation, separate path. Lăsăm `captureImageBase64_2` acolo (PDF generator are nevoie de data URL inline; nu îl serializăm la DB).

Verifică:
```bash
grep -n "v3.9.499 (Finding D)" public/js/formular/doc.js
grep -n "img2:imgs\['o-cimg2'\]" public/js/formular/doc.js
```

Expected: 1 match comentariu; 0 match-uri pentru `img2:imgs['o-cimg2']` în collectOrdDb (eliminat).

============================================================
## PAS 9 — Tests

### 9.a — `server/tests/integration/formulare-capturi-slot.test.mjs`

Creează:

```js
/**
 * v3.9.499 — formulare-capturi endpoint cu slot parameter
 *
 * Acoperire:
 *   ✓ POST cu ?slot=2 → salvează în slot 2 (nu șterge slot 1)
 *   ✓ POST fără query → default slot=1 (backward compat DF)
 *   ✓ POST cu slot invalid (3, "abc") → cădere la slot=1
 *   ✓ GET ?slot=2 → returnează slot 2 specific
 *   ✓ GET fără query → default slot=1 (backward compat)
 *   ✓ GET ?slot=2 fără date → 404 cu slot:2 în body
 *   ✓ Replace slot 2 nu afectează slot 1 (DELETE pe slot specific)
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

const ORD_ID = 'ddddffff-0000-0000-0000-00000000ABCD';

const JWT_SECRET = 'test-secret-min-32-chars-long-for-jwt-signing';
process.env.JWT_SECRET = JWT_SECRET;

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const t = jwt.sign({ email: 'p2@x.ro', role, orgId, userId }, JWT_SECRET, { expiresIn: '1h' });
  return `df_auth=${t}`;
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  // NB: capturi endpoint citește body raw, NU JSON
  app.use('/', dbRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/formulare-capturi/:type/:id cu slot', () => {
  it('POST cu ?slot=2 → DELETE doar slot=2, INSERT cu slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1, status: 'pending_p2' }], rowCount: 1 })  // SELECT existing
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // DELETE same slot
      .mockResolvedValueOnce({ rows: [{ id: 'cap-new', filename: 'x.png', mimetype: 'image/png', size_bytes: 100, slot: 2, created_at: '2026-05-22' }], rowCount: 1 }); // INSERT

    const res = await request(createTestApp())
      .post(`/api/formulare-capturi/ord/${ORD_ID}?slot=2`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));  // PNG magic bytes

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const deleteCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('DELETE FROM formulare_capturi') &&
      String(c[0]).includes('slot=$3')
    );
    expect(deleteCall, 'DELETE cu slot scope nu a fost apelat').toBeDefined();
    expect(deleteCall[1]).toEqual(['ord', ORD_ID, 2]);

    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_capturi') &&
      String(c[0]).includes('slot')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][7]).toBe(2);  // ultimul param = slot
  });

  it('POST fără ?slot → default slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'cap-x', slot: 1 }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-capturi/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_capturi')
    );
    expect(insertCall[1][7]).toBe(1);
  });

  it('POST cu slot invalid (3) → cădere la slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'cap-x', slot: 1 }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-capturi/ord/${ORD_ID}?slot=3`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50]));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_capturi')
    );
    expect(insertCall[1][7]).toBe(1);
  });
});

describe('GET /api/formulare-capturi/:type/:id cu slot', () => {
  it('GET ?slot=2 → SELECT cu slot=2 în WHERE', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ filename: 'c2.png', mimetype: 'image/png', data: Buffer.from([0x89]) }], rowCount: 1 });

    const res = await request(createTestApp())
      .get(`/api/formulare-capturi/ord/${ORD_ID}?slot=2`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT filename, mimetype, data FROM formulare_capturi') &&
      String(c[0]).includes('slot=$3')
    );
    expect(selectCall, 'SELECT cu slot lipsește').toBeDefined();
    expect(selectCall[1]).toEqual(['ord', ORD_ID, 2]);
  });

  it('GET fără query → default slot=1 (backward compat DF)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ filename: 'c1.png', mimetype: 'image/png', data: Buffer.from([0x89]) }], rowCount: 1 });

    const res = await request(createTestApp())
      .get(`/api/formulare-capturi/df/${ORD_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT filename, mimetype, data FROM formulare_capturi')
    );
    expect(selectCall[1]).toEqual(['df', ORD_ID, 1]);
  });

  it('GET ?slot=2 fără date → 404 cu body.slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .get(`/api/formulare-capturi/ord/${ORD_ID}?slot=2`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_captura');
    expect(res.body.slot).toBe(2);
  });
});
```

### 9.b — `server/tests/unit/ord-p1-fields-no-img2.test.mjs`

Creează:

```js
/**
 * v3.9.499 — guard: img2 nu mai e în ORD_P1_FIELDS.
 * Captura 2 se persistă via /api/formulare-capturi?slot=2, nu prin doc body.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ORD_P1_FIELDS: img2 eliminat (v3.9.499)', () => {
  it('definiția ORD_P1_FIELDS nu conține literalul "img2"', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/formulare-db.mjs'), 'utf8');
    // Localizează declarația ORD_P1_FIELDS și verifică conținutul ei
    const m = src.match(/const ORD_P1_FIELDS\s*=\s*\[([\s\S]*?)\];/);
    expect(m, 'ORD_P1_FIELDS nu e găsit').toBeTruthy();
    const arrayBody = m[1];
    expect(arrayBody, "ORD_P1_FIELDS încă conține 'img2' — trebuia eliminat în v3.9.499")
      .not.toMatch(/'img2'/);
  });

  it('comentariul de deprecare e prezent', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/formulare-db.mjs'), 'utf8');
    expect(src).toMatch(/v3\.9\.499.*img2 ELIMINAT/);
  });

  it('collectOrdDb în doc.js nu mai trimite img2', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const m = src.match(/function collectOrdDb\(\)\s*\{return\s*\{([\s\S]*?)\};\}/);
    expect(m, 'collectOrdDb nu e găsit').toBeTruthy();
    expect(m[1]).not.toMatch(/img2\s*:\s*imgs\['o-cimg2'\]/);
  });
});
```

Verifică:
```bash
node --check server/tests/integration/formulare-capturi-slot.test.mjs
node --check server/tests/unit/ord-p1-fields-no-img2.test.mjs
npx vitest run server/tests/integration/formulare-capturi-slot.test.mjs server/tests/unit/ord-p1-fields-no-img2.test.mjs
```

Expected: cele 9 teste trec (6 integration + 3 unit).

============================================================
## PAS 10 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -50
```

Expected: +9 teste față de v3.9.498. Toate verzi.

În special verifică că rămân verzi:
- `server/tests/integration/alop-cancel-block-df.test.mjs` (v3.9.498)
- `server/tests/integration/cancel-restore.test.mjs` (v3.9.497)
- `server/tests/unit/populate-ord-img2-validation.test.mjs` (v3.9.498)
- `server/tests/integration/state-machine.test.mjs`
- `server/tests/integration/df-refuse-restore.test.mjs`
- `server/tests/integration/df-workflow.test.mjs`

**NB despre testele existente pe `formulare-db.mjs`:** dacă vreun test PUT/POST ord vechi se baza pe `img2` în body, va eșua acum. Permis: extindere mock-uri sau eliminare câmpului `img2` din payload-ul test, FĂRĂ modificare de aserții. Dacă cădere e despre comportament, OPREȘTE și raportează.

============================================================
## PAS 11 — Version bump

În `package.json`: `version` `3.9.498` → `3.9.499`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v213` → `docflowai-v214`.

Verifică:
```bash
grep '"version"' package.json
grep "CACHE_VERSION" public/sw.js | head -1
```

============================================================
## PAS 12 — Commit + push develop

```bash
git status
git add server/db/index.mjs \
        server/routes/formulare-db.mjs \
        server/routes/alop.mjs \
        public/js/formular/doc.js \
        public/js/formular/list.js \
        server/tests/integration/formulare-capturi-slot.test.mjs \
        server/tests/unit/ord-p1-fields-no-img2.test.mjs \
        package.json public/sw.js
git commit -m "feat(captura): root cause R-A + audit cleanup C/D/E (v3.9.499)

Issue R-A root cause:
P2 (Responsabil CAB) încărca captura 2 dar valoarea nu ajungea niciodată în DB:
- completeAsP2 trimitea body={rows:getOR()}, fără img2
- uploadCaptura uploada doar slot 1 (o-cimg)
- /complete server whitelist=['rows'] — img2 oricum ignorat
- PUT server pentru P2 strict whitelist=['rows'] — img2 ignorat și aici
Captura 2 trăia doar în imgs['o-cimg2'] în memorie până la reload, când era
pierdută. v3.9.498 defensive fix maska broken-icon-ul; rezolva simptom, nu cauza.

Finding C / Finding D — asimetrie arhitecturală eliminată:
- Captura 1: formulare_capturi (BYTEA, endpoint dedicat) ✓
- Captura 2: formulare_ord.img2 (TEXT base64 inline, prin doc body) ✗
Inconsistent + fragil. Migrate ambele la pattern formulare_capturi cu coloană
slot SMALLINT (default 1 backward compat DF). Backfill din img2 → slot=2 în
migrația 079. img2 column deprecated (rămâne pentru fallback citire ord-uri
vechi, drop într-un sprint viitor).

Finding E — rate limit pe /api/alop/admin/repair-status (5/oră), simetric cu
celelalte endpoint-uri admin destructive.

Frontend:
- uploadCaptura(ft, slot) — semnătură nouă cu slot
- saveDoc, _autoSaveDb, completeAsP2 apelează uploadCaptura(ft, 1) + (ft, 2)
- populateOrd fetch slot=2 ca sursă primară, fallback la doc.img2 (defensive
  v3.9.498 păstrat pentru ord-uri vechi pre-backfill)
- collectOrdDb fără img2 (Finding D cleanup)

Tests: formulare-capturi-slot.test.mjs (6 cazuri slot routing/fallback),
ord-p1-fields-no-img2.test.mjs (3 cazuri guard că eliminarea img2 e prezentă)."
git push origin develop
```

============================================================
## RAPORT FINAL — răspunde EXACT la următoarele

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează acum? Toate verzi?
3. SHA commit pushed pe develop?
4. Output `grep -c "v3.9.499" server/db/index.mjs server/routes/formulare-db.mjs server/routes/alop.mjs public/js/formular/doc.js public/js/formular/list.js` — așteptăm minim 1 match în fiecare (5 fișiere atinse).
5. Migrația 079 confirmată în listă: `grep -n "079_formulare_capturi_slot" server/db/index.mjs` → 1 match.
6. `git status` după push → "working tree clean". Confirmă.
7. Dacă a fost necesar să modifici teste existente pe `formulare-db.mjs` ca să picare să fie reparată prin eliminarea img2 din payload — listează exact fișierul + ce ai schimbat (permis: cleanup payload, NU schimbare aserții).

============================================================
## RECOMANDĂRI POST-SPRINT

1. **După 30 zile de stabilitate**, verifică pe production că nu mai există ord-uri active care folosesc doar `formulare_ord.img2` (fără backfill în `formulare_capturi`):
   ```sql
   SELECT COUNT(*) FROM formulare_ord fo
   WHERE fo.img2 IS NOT NULL
     AND fo.img2 LIKE 'data:image/%'
     AND NOT EXISTS (
       SELECT 1 FROM formulare_capturi fc
       WHERE fc.form_type='ord' AND fc.form_id=fo.id AND fc.slot=2
     );
   ```
   Dacă rezultatul e 0, planifică sprint pentru `DROP COLUMN formulare_ord.img2` și `populateOrd` fallback removal.

2. **Cleanup `colO()` în `core.js`** (linia 304-313) — funcția pentru PDF generation încă folosește `captureImageBase64` + `captureImageBase64_2` din `imgs[]`. NU se atinge în acest sprint (PDF generation pipeline funcționează). Refactor opțional într-un sprint dedicat dacă vrei centralizare totală.

3. **Eventual GET batch capturi**: `populateOrd` face acum 2 fetch-uri secvențiale (slot 1 deja exista, slot 2 e nou). Pe rețele lente asta înseamnă +50% timp pentru imagini. Optim: endpoint `GET /api/formulare-capturi/:type/:id/all` returnează metadata sloturi + URL-uri individuale, sau zip. Doar dacă apare ca bottleneck real.

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`
- `server/routes/flows/cloud-signing.mjs`
- `server/routes/flows/bulk-signing.mjs`
- `server/signing/pades.mjs`
- `server/signing/java-pades-client.mjs`
- `server/routes/flows/signing.mjs`, `server/routes/flows/lifecycle.mjs`, `server/routes/flows/crud.mjs` — neatinse
- `server/utils/convertToPdf.mjs`, `server/utils/pdf-content-detect.mjs` — neatinse
- `server/services/authz-formular.mjs` — neatins
- `public/js/formular/core.js` — `colO()` rămâne intact (PDF generation path, separate de DB persistence)
- `public/formular.html` — HTML form nu se modifică (id-uri o-cimg2, o-cph2, o-captura2-wrap rămân)
- Coloana `formulare_ord.img2` — NU se face DROP; rămâne deprecated pentru fallback
- Testele existente: modificare doar dacă mock-ul necesită cleanup payload img2 (NU aserții). Raportează explicit.

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
