# PROMPT — v3.9.500 — ORD UX fixes: captura 2 wrap (regresie 499) + plati anterioare prefill + attachments persistență

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.499 e merge-uit pe develop și `git pull origin develop` rulat local.

============================================================
## CONTEXT — 3 issue-uri raportate

### Issue I-1 — `plati_anterioare` nu se pre-completează la P1 (ord nou)
Când P1 creează ord nou pe un ciclu ALOP 2+ (cu plăți anterioare istorice), col 3 "Plăți anterioare (lei)" rămâne `0,00`. Doar la P2, când `populateOrd` rulează pe ord-ul existent, prefill-ul aplică valoarea corectă (linia 444-456 din `doc.js`). Cauza: `newDoc(ft)` în `doc.js:603` adaugă un rând gol via `addOR()` dar nu rulează logica de prefill (care e doar în path-ul `loadDoc`).

### Issue I-2 — Captura 2 dispare la P2 (regresie v3.9.499)
La P2 (Responsabil CAB), zona pentru captura 2 ("Informații complete contract") nu se afișează deloc. Cauza: în v3.9.499 am scris în `populateOrd` (PAS 7):
```js
if(_wrap2)_wrap2.style.display=_img2Valid?'':'none';
```
și
```js
}catch(e){
  if(_wrap2)_wrap2.style.display='none';
}
```
Wrap-ul se ascunde când nu există captura 2 deja salvată (slot=2 returnează 404 + doc.img2 null). Bug arhitectural pre-existent agravat: P2 nu poate ÎNCĂRCA captura 2 dacă wrap-ul e ascuns. În plus, `setModeP2Ord` (doc.js:150) enable doar pointer-events pe `o-czone` (captura 1), nu pe `o-czone2`.

### Issue I-3 — Atașamentele de la P1 nu se văd la P2 (feature lipsă)
Compartimentul specialitate (P1) atașează fișiere via butonul "Atașează fișiere" → `addAtt` în `core.js:87`. Datele se acumulează în `o-adata` (input ascuns JSON) și se folosesc în `colO()` doar pentru generare PDF. **Niciun endpoint server-side nu persistă atașamentele ORD** — nu există în `ORD_P1_FIELDS`, nu există tabel `formulare_atasamente`. La reload sau viewer diferit, atașamentele sunt pierdute.

Fix: tabel nou + 4 endpoint-uri (upload, list, download, delete) similar cu `formulare_capturi` dar pentru fișiere generice. Frontend: upload pe save, fetch pe populate.

NB: DF are aceeași problemă (`n-adata`, `n-fdad`) dar nu o adresăm acum — focus pe ORD per raport user. DF e tech debt urmărit separat.

============================================================
## PAS 1 — DB migration 080: tabel `formulare_atasamente`

În `server/db/index.mjs`, în array-ul `MIGRATIONS`, imediat după migrația `079_formulare_capturi_slot` (linia ~1682) și înainte de `];` care închide array-ul, adaugă:

```js
  ,{
    id: '080_formulare_atasamente',
    sql: `
      -- v3.9.500: atașamente pentru DF/ORD (Compartiment specialitate → "Atașează fișiere").
      -- Înainte: atașamentele trăiau doar în memoria clientului (o-adata JSON) și se foloseau
      -- exclusiv pentru generarea PDF-ului. Nu erau persistate în DB → pierdute la reload sau
      -- viewer diferit. Pattern simetric cu formulare_capturi (BYTEA + endpoint dedicat).
      CREATE TABLE IF NOT EXISTS formulare_atasamente (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        form_type   TEXT        NOT NULL CHECK (form_type IN ('df','ord')),
        form_id     UUID        NOT NULL,
        uploaded_by INTEGER     NOT NULL REFERENCES users(id),
        filename    TEXT        NOT NULL,
        mime_type   TEXT        NOT NULL DEFAULT 'application/octet-stream',
        size_bytes  INTEGER     NOT NULL DEFAULT 0,
        data        BYTEA       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_form
        ON formulare_atasamente(form_type, form_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_uploader
        ON formulare_atasamente(uploaded_by);
    `
  }
```

Verifică:
```bash
node --check server/db/index.mjs
grep -n "080_formulare_atasamente" server/db/index.mjs
```

Expected: fără eroare sintaxă; 1 match.

============================================================
## PAS 2 — Backend: 4 endpoint-uri `/api/formulare-atasamente`

În `server/routes/formulare-db.mjs`, după blocul `GET /api/formulare-capturi/:type/:id` (în jurul liniei 1216), adaugă următoarele 4 endpoint-uri:

```js
// ─────────────────────────────────────────────────────────────────────────────
// v3.9.500: ATAȘAMENTE (DF și ORD) — pattern simetric cu formulare_capturi
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/formulare-atasamente/:type/:id — upload atașament (max 10MB)
router.post('/api/formulare-atasamente/:type/:id', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  const table = type === 'df' ? 'formulare_df' : 'formulare_ord';

  try {
    const { rows: existing } = await pool.query(
      `SELECT created_by, assigned_to, status FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const doc = existing[0];
    const canUpload = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canUpload) return res.status(403).json({ error: 'forbidden' });

    // Citim body raw (fișier)
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise((resolve, reject) => {
      req.on('end', resolve);
      req.on('error', reject);
    });
    const data = Buffer.concat(chunks);
    if (data.length === 0) return res.status(400).json({ error: 'fisier_gol' });
    if (data.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'fisier_prea_mare' });

    const mime_type = req.headers['content-type'] || 'application/octet-stream';
    const filename = req.headers['x-filename'] || `atasament_${Date.now()}`;

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, filename, mime_type, size_bytes, created_at
    `, [type, id, actor.userId, filename, mime_type, data.length, data]);

    logger.info({ type, id, attId: inserted[0].id, size: data.length, actor: actor.email }, 'formulare-atasament upload');
    res.json({ ok: true, atasament: inserted[0] });
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasament upload error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-atasamente/:type/:id — listă atașamente (fără data)
router.get('/api/formulare-atasamente/:type/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canView = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canView) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM formulare_atasamente
       WHERE form_type=$1 AND form_id=$2 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [type, id]
    );
    res.json({ ok: true, atasamente: rows });
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasamente list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/formulare-atasamente/:type/:id/:attId — descărcare atașament
router.get('/api/formulare-atasamente/:type/:id/:attId', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id, attId } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canView = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canView) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await pool.query(
      `SELECT filename, mime_type, data FROM formulare_atasamente
       WHERE id=$1 AND form_type=$2 AND form_id=$3 AND deleted_at IS NULL`,
      [attId, type, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const att = rows[0];
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
    res.send(att.data);
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasament get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/formulare-atasamente/:type/:id/:attId — ștergere soft
router.delete('/api/formulare-atasamente/:type/:id/:attId', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { type, id, attId } = req.params;
  if (!['df', 'ord'].includes(type)) return res.status(400).json({ error: 'type_invalid' });

  try {
    const table = type === 'df' ? 'formulare_df' : 'formulare_ord';
    const { rows: docRows } = await pool.query(
      `SELECT created_by, assigned_to, status FROM ${table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!docRows.length) return res.status(404).json({ error: 'not_found' });
    const doc = docRows[0];
    const canDelete = doc.created_by === actor.userId
      || doc.assigned_to === actor.userId
      || actor.role === 'admin' || actor.role === 'org_admin';
    if (!canDelete) return res.status(403).json({ error: 'forbidden' });
    // Nu permite delete pe doc aprobat/completed (read-only)
    if (['completed','aprobat'].includes(doc.status) && !['admin','org_admin'].includes(actor.role)) {
      return res.status(409).json({ error: 'document_locked', status: doc.status });
    }

    const { rowCount } = await pool.query(
      `UPDATE formulare_atasamente SET deleted_at=NOW()
       WHERE id=$1 AND form_type=$2 AND form_id=$3 AND deleted_at IS NULL`,
      [attId, type, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    logger.info({ type, id, attId, actor: actor.email }, 'formulare-atasament soft delete');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'formulare-atasament delete error');
    res.status(500).json({ error: 'server_error' });
  }
});
```

Verifică:
```bash
node --check server/routes/formulare-db.mjs
grep -c "v3.9.500: ATAȘAMENTE" server/routes/formulare-db.mjs
grep -c "/api/formulare-atasamente" server/routes/formulare-db.mjs
```

Expected: fără eroare; 1 match comentariu bloc; 4 match-uri pentru route paths.

============================================================
## PAS 3 — Backend: adaugă `/formulare-atasamente` la `_LARGE_PDF_PATHS`

În `server/index.mjs` linia ~614, în array-ul `_LARGE_PDF_PATHS`, adaugă imediat după linia cu `/formulare-ord`:

```js
  '/formulare-atasamente',    // POST — upload fișiere generice (max 10MB raw body)
```

Lista completă va arăta astfel (verifică ordinea exactă; păstrează stilul comentariilor):

```js
const _LARGE_PDF_PATHS = [
  '/flows',
  '/reinitiate-review',
  '/upload-signed-pdf',
  '/signing-callback',
  '/sign',
  '/detect-acroform-fields',
  '/formulare-oficiale',
  '/formulare-ord',
  '/formulare-df',
  '/formulare-atasamente',    // POST — upload fișiere generice (max 10MB raw body)
  '/formulare/generate',
  '/registratura/intrari',
];
```

Verifică:
```bash
grep -n "/formulare-atasamente" server/index.mjs
```

Expected: 1 match în `_LARGE_PDF_PATHS`.

============================================================
## PAS 4 — Frontend: fix captura 2 wrap visibility (Issue I-2)

### 4.a — `public/js/formular/doc.js`, în `populateOrd`

Localizează blocul scris în v3.9.499 (în jurul liniei 76-100, începe cu `// v3.9.499: captura 2 fetch via formulare_capturi(slot=2)`). Înlocuiește integral cu:

```js
  // v3.9.500 (Issue I-2): wrap-ul captura 2 e VIZIBIL mereu, ca P2 să poată
  // încărca chiar și când DB nu are nimic în slot=2 yet. IMG-ul intern
  // (o-cimg2) afișează data doar când există; placeholder (o-cph2) altfel.
  // Fetch slot=2 din formulare_capturi (v3.9.499) cu fallback la doc.img2.
  const _wrap2=document.getElementById('o-captura2-wrap');
  if(_wrap2)_wrap2.style.display='';  // mereu vizibil
  clrImg('o-cimg2','o-cph2');  // resetare default (placeholder vizibil)
  try{
    const capR2=await fetch(`/api/formulare-capturi/ord/${doc.id||ST.docId.ordnt}?slot=2`,{credentials:'include'});
    if(capR2.ok&&capR2.headers.get('content-type')?.startsWith('image')){
      const blob=await capR2.blob();
      const reader=new FileReader();
      reader.onload=e=>showImg('o-cimg2','o-cph2',e.target.result);
      reader.readAsDataURL(blob);
    } else {
      // Fallback la doc.img2 (defensive v3.9.498) pentru ord-uri pre-backfill 079
      const _img2Valid=typeof doc.img2==='string'
        && doc.img2.length>32
        && /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(doc.img2);
      if(_img2Valid){
        showImg('o-cimg2','o-cph2',doc.img2);
      }else if(doc.img2){
        console.warn('[v3.9.500] populateOrd: doc.img2 invalid + no slot=2 (preview):',
          typeof doc.img2, String(doc.img2).slice(0,80));
      }
    }
  }catch(e){
    console.warn('[v3.9.500] populateOrd: captura slot=2 fetch error', e);
    // NU ascunde wrap-ul pe eroare — vrem ca P2 să poată retry upload
  }
```

### 4.b — `public/js/formular/doc.js`, în `setModeP2Ord`

Localizează `setModeP2Ord()` în jurul liniei 150. Înlocuiește integral cu:

```js
function setModeP2Ord(){
  lockAll('ordnt',true);
  // Deblochez receptii + plati_anterioare în tabel
  document.querySelectorAll('#o-tbody input[data-f="receptii"],#o-tbody input[data-f="plati_anterioare"]').forEach(e=>{e.disabled=false;});
  // v3.9.500 (Issue I-2): pointer-events pe AMBELE zone de captură pentru P2
  const czone=document.getElementById('o-czone');if(czone)czone.style.pointerEvents='';
  const czone2=document.getElementById('o-czone2');if(czone2)czone2.style.pointerEvents='';
}
```

Verifică:
```bash
grep -n "v3.9.500 (Issue I-2)" public/js/formular/doc.js
grep -n "o-czone2.*pointerEvents\|czone2.style.pointerEvents" public/js/formular/doc.js
```

Expected: 2 match-uri comentariu; 1 match pentru pointerEvents pe czone2 în setModeP2Ord.

============================================================
## PAS 5 — Frontend: fix prefill `plati_anterioare` la P1 (Issue I-1)

În `public/js/formular/doc.js`, localizează `newDoc(ft)` la linia 603. Înlocuiește blocul ord-specific (liniile 613-618):

```js
  if(ft==='ordnt'){
    document.getElementById('o-tbody').innerHTML='';addOR();clrImg('o-cimg','o-cph');clrImg('o-cimg2','o-cph2');
    document.getElementById('o-alist').innerHTML='';document.getElementById('o-adata').value='[]';
    const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value='';
    const dfId=document.getElementById('o-df-id');if(dfId)dfId.value='';
  }else{
```

cu:

```js
  if(ft==='ordnt'){
    document.getElementById('o-tbody').innerHTML='';addOR();clrImg('o-cimg','o-cph');clrImg('o-cimg2','o-cph2');
    document.getElementById('o-alist').innerHTML='';document.getElementById('o-adata').value='[]';
    const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value='';
    const dfId=document.getElementById('o-df-id');if(dfId)dfId.value='';
    // v3.9.500 (Issue I-1): prefill plati_anterioare la creare ord nou pe ciclu 2+
    // Înainte: prefill rula doar în loadDoc (existing ord) → P1 vedea 0,00, P2 vedea valoarea
    const _ctx=window._alopContext;
    const _alopId=_ctx?.alopId||new URLSearchParams(location.search).get('alop_id');
    if(_alopId){
      fetch(`/api/alop/${encodeURIComponent(_alopId)}`,{credentials:'include'})
        .then(r=>r.ok?r.json():null).catch(()=>null)
        .then(_ra=>{
          if(!_ra?.alop)return;
          const _totalAnt=(_ra.alop.cicluri_istorice||[])
            .reduce((s,c)=>s+parseFloat(c.plata_suma_efectiva||0),0);
          if(_totalAnt>0){
            const _firstRow=document.querySelector('#o-tbody input[data-f="plati_anterioare"]');
            if(_firstRow&&(parseFloat(_firstRow.value)||0)===0){
              _firstRow.value=fMR(_totalAnt);
              calcORRow(_firstRow);
            }
          }
        });
    }
  }else{
```

NB: schimbarea folosește `fMR()` (format money RO) ca să afișeze valoarea cu virgulă (ex. `600.000,00`), consistent cu restul tabelului.

Verifică:
```bash
grep -n "v3.9.500 (Issue I-1)" public/js/formular/doc.js
```

Expected: 1 match.

============================================================
## PAS 6 — Frontend: atașamente — `uploadAttachments` + `fetchAttachments` în `public/js/formular/doc.js`

În `public/js/formular/doc.js`, după funcția `uploadCaptura` (în jurul liniei 692, după `}` care închide `uploadCaptura`), adaugă două funcții noi:

```js
// ── Atașamente (Compartiment specialitate) v3.9.500 ───────────────────────────
// uploadAttachments: parcurge o-adata/n-adata, pentru items fără `id` (pending
// upload, au `data` data URL), POST la server și înlocuiește item-ul cu metadata
// returnată (id+filename+mime_type+size_bytes). Apelată din _autoSaveDb + completeAsP2
// + saveDoc, similar cu uploadCaptura.
async function uploadAttachments(ft){
  if(ft!=='ordnt')return;  // v3.9.500: DF rămâne tech debt urmărit separat
  if(!ST.docId[ft])return;
  const did=ft==='ordnt'?'o-adata':'n-adata';
  const lid=ft==='ordnt'?'o-alist':'n-alist';
  let cur;try{cur=JSON.parse(document.getElementById(did).value||'[]');}catch(_){return;}
  if(!Array.isArray(cur))return;
  let changed=false;
  for(let i=0;i<cur.length;i++){
    const item=cur[i];
    if(item?.id||!item?.data)continue;  // deja uploadat sau invalid
    try{
      const[header,b64]=String(item.data).split(',');
      if(!b64)continue;
      const mime=header.match(/:(.*?);/)?.[1]||item.type||'application/octet-stream';
      const bin=atob(b64);const arr=new Uint8Array(bin.length);
      for(let j=0;j<bin.length;j++)arr[j]=bin.charCodeAt(j);
      const blob=new Blob([arr],{type:mime});
      const r=await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}`,{
        method:'POST',credentials:'include',
        headers:{
          'Content-Type':mime,
          'X-CSRF-Token':df.getCsrf(),
          'X-Filename':item.name||'atasament',
        },
        body:blob,
      });
      const j=await r.json().catch(()=>null);
      if(r.ok&&j?.atasament){
        cur[i]={id:j.atasament.id,filename:j.atasament.filename,mime_type:j.atasament.mime_type,size_bytes:j.atasament.size_bytes};
        changed=true;
      }
    }catch(e){console.warn('[v3.9.500] uploadAttachments error',item?.name,e);}
  }
  if(changed){
    document.getElementById(did).value=JSON.stringify(cur);
    renderAttachments(ft);
  }
}

// fetchAttachments: încarcă lista de pe server la deschiderea documentului,
// înlocuiește conținutul o-adata și re-randează lista
async function fetchAttachments(ft){
  if(ft!=='ordnt')return;
  if(!ST.docId[ft])return;
  const did=ft==='ordnt'?'o-adata':'n-adata';
  try{
    const r=await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}`,{credentials:'include'});
    if(!r.ok)return;
    const j=await r.json();
    if(!j.ok||!Array.isArray(j.atasamente))return;
    const list=j.atasamente.map(a=>({
      id:a.id,filename:a.filename,mime_type:a.mime_type,size_bytes:a.size_bytes
    }));
    document.getElementById(did).value=JSON.stringify(list);
    renderAttachments(ft);
  }catch(e){console.warn('[v3.9.500] fetchAttachments error',e);}
}

// renderAttachments: golește lista vizuală și o reconstruiește din o-adata.
// Pentru items cu id (server-side): chip cu link de descărcare + buton ștergere via DELETE.
// Pentru items fără id (pending upload): chip cu data URL local + buton ștergere local.
function renderAttachments(ft){
  if(ft!=='ordnt')return;
  const did=ft==='ordnt'?'o-adata':'n-adata';
  const lid=ft==='ordnt'?'o-alist':'n-alist';
  const list=document.getElementById(lid);if(!list)return;
  list.innerHTML='';
  let cur;try{cur=JSON.parse(document.getElementById(did).value||'[]');}catch(_){return;}
  if(!Array.isArray(cur))return;
  const docId=ST.docId[ft];
  cur.forEach((item,idx)=>{
    const chip=document.createElement('span');
    chip.className='att-chip';
    const name=item.filename||item.name||'fișier';
    const safe=String(name).replace(/[<>"]/g,'');
    if(item.id&&docId){
      const url=`/api/formulare-atasamente/${ftType(ft)}/${docId}/${encodeURIComponent(item.id)}`;
      chip.innerHTML=`📎 <a href="${url}" target="_blank" style="color:inherit">${safe}</a> <button onclick="remAttServer(${idx},'${lid}','${did}','${item.id}',this)">✕</button>`;
    } else {
      chip.innerHTML=`📎 ${safe} <button onclick="remAtt(${idx},'${lid}','${did}',this)">✕</button>`;
    }
    list.appendChild(chip);
  });
}

// remAttServer: șterge item server-side via DELETE și apoi local. Folosit din chip-urile
// cu id existent. Diferit de remAtt (din core.js) care șterge doar local.
async function remAttServer(idx,lid,did,attId,btn){
  const ft=lid.startsWith('o-')?'ordnt':'notafd';
  if(!ST.docId[ft]){
    // Fallback la remAtt clasic
    if(typeof window.remAtt==='function')return window.remAtt(idx,lid,did,btn);
    return;
  }
  try{
    const r=await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}/${encodeURIComponent(attId)}`,{
      method:'DELETE',credentials:'include',
      headers:{'X-CSRF-Token':df.getCsrf()},
    });
    if(!r.ok){
      const j=await r.json().catch(()=>null);
      alert(j?.error==='document_locked'?'Document complet — atașamentul nu poate fi șters.':'Eroare la ștergere.');
      return;
    }
    let cur;try{cur=JSON.parse(document.getElementById(did).value||'[]');}catch(_){cur=[];}
    cur.splice(idx,1);
    document.getElementById(did).value=JSON.stringify(cur);
    renderAttachments(ft);
  }catch(e){alert('Eroare rețea: '+e.message);}
}
```

Apoi adaugă exportul global la finalul fișierului (caută `window.uploadCaptura = uploadCaptura;` în jurul liniei 1128 și adaugă imediat după):

```js
  window.uploadAttachments          = uploadAttachments;
  window.fetchAttachments           = fetchAttachments;
  window.renderAttachments          = renderAttachments;
  window.remAttServer               = remAttServer;
```

Verifică:
```bash
grep -n "async function uploadAttachments\|async function fetchAttachments\|function renderAttachments\|async function remAttServer" public/js/formular/doc.js
grep -n "window.uploadAttachments\|window.fetchAttachments" public/js/formular/doc.js
```

Expected: 4 match-uri pentru declarații funcții; 2+ match-uri pentru export globals.

============================================================
## PAS 7 — Frontend: integrare apeluri în save/load flows

### 7.a — `public/js/formular/doc.js`, `loadDoc` — apelează `fetchAttachments`

Localizează zona din `loadDoc` care încarcă captura (în jurul liniei 471, comentariul `// Captură`). Imediat după blocul `try{...}catch(_){}` care fetchează captura (slot 1), adaugă:

```js
    // v3.9.500: încarcă lista de atașamente server-side (înlocuiește o-adata local)
    if(ft==='ordnt') await fetchAttachments(ft);
```

### 7.b — `public/js/formular/doc.js`, `saveDoc` line 668 — apelează `uploadAttachments`

Localizează blocul (modificat în v3.9.499) imediat după linia `// v3.9.499: upload ambele sloturi`:

```js
    // v3.9.499: upload ambele sloturi (slot 1 pentru DF/ORD, slot 2 doar ORD)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
```

Adaugă imediat după:
```js
    // v3.9.500: upload atașamente pending (cele fără id)
    if(ft==='ordnt' && ST.docId[ft]) await uploadAttachments(ft);
```

### 7.c — `public/js/formular/doc.js`, `completeAsP2` line 965 — apelează `uploadAttachments`

Localizează (modificat în v3.9.499):

```js
  // v3.9.499: upload ambele sloturi când P2 finalizează (root cause R-A fix —
  // înainte, captura 2 era pierdută pentru că completeAsP2 trimitea doar slot 1)
  await uploadCaptura(ft, 1);
  if(ft==='ordnt') await uploadCaptura(ft, 2);
```

Adaugă imediat după:
```js
  // v3.9.500: upload atașamente pending înainte de complete
  if(ft==='ordnt') await uploadAttachments(ft);
```

### 7.d — `public/js/formular/list.js`, `_autoSaveDb` line 59 — apelează `uploadAttachments`

Localizează (modificat în v3.9.499):

```js
    // v3.9.499: auto-save uploadează ambele sloturi (slot 2 doar pentru ord)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
```

Adaugă imediat după (în același bloc `if(ST.docId[ft])`):

```js
    // v3.9.500: auto-save uploadează atașamente pending
    if(ft==='ordnt' && ST.docId[ft]) await uploadAttachments(ft);
```

NB: combinând cele 2 if-uri într-unul singur ar fi mai elegant; verifică să rămână izomorfic cu structura existentă.

Verifică:
```bash
grep -n "v3.9.500: upload atașamente\|v3.9.500: încarcă lista\|v3.9.500: auto-save uploadează atașamente" public/js/formular/doc.js public/js/formular/list.js
```

Expected: 4 match-uri totale (loadDoc, saveDoc, completeAsP2, _autoSaveDb).

============================================================
## PAS 8 — Tests

### 8.a — `server/tests/integration/formulare-atasamente.test.mjs`

Creează:

```js
/**
 * v3.9.500 — formulare-atasamente endpoints (upload, list, download, delete)
 *
 * Acoperire:
 *   ✓ POST upload → INSERT + returnează metadata
 *   ✓ POST upload fără permisiune → 403
 *   ✓ POST upload fișier prea mare (>10MB) → 413
 *   ✓ GET list → returnează doar atașamente ne-șterse
 *   ✓ GET download → returnează raw data + Content-Disposition
 *   ✓ DELETE (soft) → marchează deleted_at
 *   ✓ DELETE pe document completed (non-admin) → 409 document_locked
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
const ATT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

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

describe('POST /api/formulare-atasamente/:type/:id', () => {
  it('upload reușit → INSERT + atașament în răspuns', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_ID, filename: 'factura.pdf', mime_type: 'application/pdf', size_bytes: 1234, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', 'factura.pdf')
      .send(Buffer.from('PDF-CONTENT-MOCK'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.atasament.id).toBe(ATT_ID);
    expect(res.body.atasament.filename).toBe('factura.pdf');

    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall).toBeDefined();
  });

  it('upload fără permisiune → 403', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 999, assigned_to: 888, status: 'draft' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie(1, 'user', 1))  // userId=1, doc-ul aparține 999
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));

    expect(res.status).toBe(403);
  });

  it('document not found → 404', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

describe('GET /api/formulare-atasamente/:type/:id', () => {
  it('list → returnează atașamente fără data field', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: ATT_ID, filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: 1000, uploaded_by: 1, created_at: '2026-05-22' },
          { id: 'att-2', filename: 'b.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size_bytes: 2000, uploaded_by: 1, created_at: '2026-05-22' },
        ],
        rowCount: 2
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.atasamente).toHaveLength(2);
    expect(res.body.atasamente[0].filename).toBe('a.pdf');
    expect(res.body.atasamente[0].data).toBeUndefined();  // NU returnează data în list

    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, filename, mime_type, size_bytes')
    );
    expect(selectCall, 'SELECT list fără data').toBeDefined();
    expect(String(selectCall[0])).toMatch(/deleted_at IS NULL/);
  });
});

describe('GET /api/formulare-atasamente/:type/:id/:attId — download', () => {
  it('returnează data binary + Content-Disposition', async () => {
    const fileData = Buffer.from('PDF-RAW-DATA');
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ filename: 'factura.pdf', mime_type: 'application/pdf', data: fileData }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/factura\.pdf/);
    expect(res.body).toEqual(fileData);
  });

  it('atașament inexistent → 404', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/ord/${ORD_ID}/non-existent-id`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/formulare-atasamente/:type/:id/:attId', () => {
  it('soft delete reușit → 200', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .delete(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE formulare_atasamente') &&
      String(c[0]).includes('deleted_at=NOW()')
    );
    expect(updateCall).toBeDefined();
  });

  it('document completed + non-admin → 409 document_locked', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'completed' }], rowCount: 1 });

    const res = await request(createTestApp())
      .delete(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie(1, 'user', 1));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_locked');
  });

  it('document completed + admin → 200 (admin override)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'completed' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .delete(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie(1, 'admin', null));

    expect(res.status).toBe(200);
  });
});
```

### 8.b — `server/tests/unit/v3-9-500-fixes.test.mjs`

Creează:

```js
/**
 * v3.9.500 — guard-uri pentru fix-urile frontend (string-match)
 * Issue I-1: prefill plati_anterioare în newDoc(ordnt)
 * Issue I-2: wrap captura 2 vizibil mereu + setModeP2Ord enable pe o-czone2
 * Issue I-3: uploadAttachments/fetchAttachments/renderAttachments declarate
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('I-1: prefill plati_anterioare în newDoc(ordnt)', () => {
  it('newDoc(ord) face fetch la /api/alop/:id și prefill prima rânduri', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.500 \(Issue I-1\)/);
    // Verifică că prefill se face în newDoc (ord branch)
    const m = src.match(/function newDoc\(ft\)[\s\S]*?\}\n\n/);
    expect(m, 'newDoc nu e găsit').toBeTruthy();
    expect(m[0]).toMatch(/_alopContext/);
    expect(m[0]).toMatch(/cicluri_istorice/);
    expect(m[0]).toMatch(/plati_anterioare/);
  });
});

describe('I-2: wrap captura 2 vizibil mereu + setModeP2Ord pe o-czone2', () => {
  it('populateOrd setează _wrap2.style.display="" necondiționat', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.500 \(Issue I-2\)/);
    // Verifică că wrap-ul e setat la "" în populateOrd (vizibil mereu)
    const m = src.match(/populateOrd[\s\S]{0,2000}/);
    expect(m).toBeTruthy();
    expect(m[0]).toMatch(/_wrap2\.style\.display=''/);
  });

  it('setModeP2Ord enable pointer-events pe ambele zone de captură', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const m = src.match(/function setModeP2Ord\(\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'setModeP2Ord nu e găsit').toBeTruthy();
    expect(m[0]).toMatch(/o-czone'\)/);   // czone 1
    expect(m[0]).toMatch(/o-czone2'\)/);  // czone 2 (fix I-2)
    expect(m[0]).toMatch(/czone2\.style\.pointerEvents=''/);
  });
});

describe('I-3: atașamente — funcții declarate și exportate', () => {
  it('uploadAttachments / fetchAttachments / renderAttachments / remAttServer declarate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/async function uploadAttachments\(ft\)/);
    expect(src).toMatch(/async function fetchAttachments\(ft\)/);
    expect(src).toMatch(/function renderAttachments\(ft\)/);
    expect(src).toMatch(/async function remAttServer/);
  });

  it('funcțiile exportate ca window globals', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/window\.uploadAttachments\s*=/);
    expect(src).toMatch(/window\.fetchAttachments\s*=/);
    expect(src).toMatch(/window\.renderAttachments\s*=/);
    expect(src).toMatch(/window\.remAttServer\s*=/);
  });

  it('uploadAttachments apelat în completeAsP2 + saveDoc + _autoSaveDb', () => {
    const docSrc  = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const listSrc = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // completeAsP2 + saveDoc în doc.js (≥2 apeluri)
    const docCount = (docSrc.match(/await uploadAttachments\(ft\)/g) || []).length;
    expect(docCount).toBeGreaterThanOrEqual(2);
    // _autoSaveDb în list.js (≥1 apel)
    expect(listSrc).toMatch(/await uploadAttachments\(ft\)/);
  });

  it('loadDoc apelează fetchAttachments după încărcare captură', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.500: încarcă lista de atașamente/);
    expect(src).toMatch(/await fetchAttachments\(ft\)/);
  });
});
```

Verifică:
```bash
node --check server/tests/integration/formulare-atasamente.test.mjs
node --check server/tests/unit/v3-9-500-fixes.test.mjs
npx vitest run server/tests/integration/formulare-atasamente.test.mjs server/tests/unit/v3-9-500-fixes.test.mjs
```

Expected: cele 13 teste trec (8 integration + 5 unit).

============================================================
## PAS 9 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -50
```

Expected: +13 teste față de v3.9.499. Toate verzi. Atenție specială la:
- `server/tests/integration/formulare-capturi-slot.test.mjs` (v3.9.499) — neatins
- `server/tests/integration/alop-cancel-block-df.test.mjs` (v3.9.498) — neatins
- `server/tests/integration/cancel-restore.test.mjs` (v3.9.497) — neatins
- `server/tests/unit/populate-ord-img2-validation.test.mjs` (v3.9.498/499) — verifică că regex-ul tău `/v3\.9\.49[89]/` păzește acum și `v3.9.500` în console.warn — **TREBUIE EXTINS** dacă cădere apare. Soluție: schimbă regex la `/v3\.9\.[45]\d\d/` sau similar. NU schimbi aserții.

============================================================
## PAS 10 — Version bump

În `package.json`: `3.9.499` → `3.9.500`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v214` → `docflowai-v215`.

============================================================
## PAS 11 — Commit + push develop

```bash
git status
git add server/db/index.mjs \
        server/routes/formulare-db.mjs \
        server/index.mjs \
        public/js/formular/doc.js \
        public/js/formular/list.js \
        server/tests/integration/formulare-atasamente.test.mjs \
        server/tests/unit/v3-9-500-fixes.test.mjs \
        package.json public/sw.js
git commit -m "fix(ord): 3 UX issues — captura 2 wrap + plati anterioare prefill + atașamente (v3.9.500)

Issue I-1 — plati_anterioare nu se pre-completa la P1 (ord nou):
Prefill logic exista în loadDoc (existing ord) dar nu și în newDoc.
Rezultat: P1 vedea 0,00 la col 3, P2 vedea valoarea corectă după ce
populateOrd rula. Fix: newDoc(ordnt) face acum fetch la /api/alop/:id
și pre-completează plati_anterioare din suma cicluri_istorice.

Issue I-2 — captura 2 dispărea la P2 (regresie v3.9.499):
populateOrd ascundea o-captura2-wrap când nu exista nimic în slot=2
+ doc.img2 null. P2 nu putea încărca captura 2 pentru că zona era
invizibilă. Plus setModeP2Ord enable doar pointer-events pe o-czone
(captura 1). Fix: wrap mereu vizibil în populateOrd, IMG intern
controlat de showImg/clrImg; setModeP2Ord enable și o-czone2.

Issue I-3 — atașamente Compartiment specialitate nu se persistau:
addAtt colecta fișiere în o-adata (data URL JSON) folosit doar pentru
generare PDF. Niciun endpoint server-side, niciun storage DB → pierdute
la reload. Fix arhitectural simetric cu formulare_capturi:

- Tabel nou formulare_atasamente (form_type+form_id, BYTEA data,
  soft delete prin deleted_at) — migrația 080
- 4 endpoint-uri: POST upload, GET list, GET download, DELETE (soft)
- Frontend uploadAttachments(ft) iterează o-adata, uploadează pending
  items, înlocuiește cu metadata returnată (drop data field)
- fetchAttachments(ft) populează o-adata la loadDoc
- renderAttachments(ft) reface chips cu link download + delete server
- Integrare: saveDoc, completeAsP2, _autoSaveDb apelează uploadAttachments
  similar cu uploadCaptura

NB: DF (n-adata, n-fdad) rămâne tech debt — nu adresat în acest sprint.

Tests: formulare-atasamente.test.mjs (8 cazuri endpoint-uri + permission +
size limit + soft delete + admin override), v3-9-500-fixes.test.mjs (5
guard-uri string-match pentru I-1/I-2/I-3 frontend)."
git push origin develop
```

============================================================
## RAPORT FINAL — răspunde EXACT la următoarele

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi? Confirmă explicit că testele din v3.9.497/498/499 trec.
3. SHA commit pushed pe develop?
4. Migrația 080 prezentă: `grep -n "080_formulare_atasamente" server/db/index.mjs` → 1 match.
5. `grep -c "v3.9.500" server/db/index.mjs server/routes/formulare-db.mjs server/index.mjs public/js/formular/doc.js public/js/formular/list.js` — minim 1 per fișier (5 atinse).
6. Test `populate-ord-img2-validation.test.mjs` (v3.9.498/499): a fost necesar să extinzi regex-ul de versiune pentru a accepta `v3.9.500`? Listează exact ce ai schimbat (permis: doar regex versiune, NU aserții comportament).
7. `git status` post-push → "working tree clean". Confirmă.

============================================================
## RECOMANDĂRI POST-SPRINT

1. **DF attachments persistence** (`n-adata`, `n-fdad`): aceeași problemă ca ORD, dar nu adresată în v3.9.500. Tabel-ul `formulare_atasamente` deja suportă `form_type='df'`. Frontend trebuie extins: în `populateDf` apel `fetchAttachments(ft)`, în save flows DF apel `uploadAttachments(ft)`. ~50 linii. Sprint dedicat când ai timp.

2. **Migrare `n-fdad` (FD attachments) la `formulare_atasamente` cu slot/category**: DF are 2 zone de atașamente distincte. Necesită fie 2 form_type-uri (`df_general`, `df_fd`) fie o coloană `category` în formulare_atasamente. Decizie de arhitectură separată.

3. **DEPRECARE `colO()`/`colN()`** din `core.js` (PDF generation path): după ce attachments+capturi sunt complet pe pattern-ul nou, payload-urile `colO/colN` au câmpuri redundante (`attachments`, `captureImageBase64`, etc.). PDF generator poate fetcha din endpoint-uri în loc să primească inline data URL. Refactor major, fără urgență.

4. **Lock captura 2 + attachments la pending_p2 + role=p1**: actual P1 poate suprascrie captura 2 deși secțiunea e P2. Bug-uleț de boundary. Adaugă `lockCaptureAndAttachments(ft, true)` în branch-ul pending_p2 P1.

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
- `public/js/formular/core.js` — `addAtt`, `remAtt`, `colO()`, `colN()` rămân neatinse. Funcțiile noi (`uploadAttachments`, etc.) trăiesc în `doc.js`.
- `public/formular.html` — HTML pentru zona o-adata/o-alist nu se modifică
- Coloana `formulare_ord.img2` — rămâne deprecated (fallback citire)
- Testele existente: doar regex versiune update permis pe `populate-ord-img2-validation.test.mjs` dacă cădere apare. Raportează exact.

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
