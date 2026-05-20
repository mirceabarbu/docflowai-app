# DocFlowAI — 🔧 FIX SAVE RN + NF INVESTIȚII + ATAȘAMENTE SECT F & J (v3.9.442)

> **Re-adaptare 08.05.2026** a `PROMPT_RN_FIX_ATTACHMENTS_v3_9_438.md` — extins cu fix simetric pe NF Investiții (același bug body limit + fără AbortController), bumps ajustate la versiunea curentă a develop (3.9.441 → 3.9.442, SW v157 → v158), cache busting `v=3.9.407` → `v=3.9.442` în toate cele 3 formulare HTML.

```
DocFlowAI v3.9.441 → v3.9.442 (SW v157 → v158)
Branch: develop
Subiect: fix(formulare): salvare blocată RN+NF + atașamente Caiet sarcini și Estimare valoare

═══════════════════════════════════════════════════════════
CONTEXT — 4 PROBLEME REZOLVATE
═══════════════════════════════════════════════════════════

P1 (BUG) — Salvare RN blocată la „⏳ Se salvează..."
  Cauză root: server/index.mjs middleware adaptiv (linia ~608) aplică
  body limit 1MB pentru orice path NU LISTAT în _LARGE_PDF_PATHS.
  POST/PUT /api/formulare-oficiale NU este în listă → la formulare RN
  bogate în textareas, checklist și revizuiri, payload-ul poate depăși
  1MB → express respinge cu 413 ÎNAINTE ca route-handler-ul să ruleze
  → pe Railway cu HTTP/2 multiplexing, răspunsul nu ajunge corect la
  browser → fetch atârnă → finally never runs → button rămâne stuck.
  FIX: adaugă /formulare-oficiale în _LARGE_PDF_PATHS (limită 50MB)
  ȘI adaugă timeout explicit + error UX mai bun în rfnSave().

P1B (BUG) — Salvare NF Investiții POATE fi afectată de aceeași cauză
  Buton „Salvează" din notafd-invest-form.html apelează nfSave() care
  postează la EXACT același endpoint /api/formulare-oficiale. Deși NF
  e formular MAI MIC decât RN (rar depășește 1MB), fix-ul backend din
  P1 îl protejează automat. SUPLIMENTAR aplicăm același pattern de-
  fensiv: AbortController + handling 413/401/403 + buton cu ID +
  estimare dimensiune payload.

P2 (FEATURE) — Atașament Caiet de sarcini la Secțiunea J din RN
  Secțiunea J are deja radio EXISTA_CAIET / FARA_CAIET dar NU permite
  upload-ul fișierului efectiv. Trebuie buton de încărcare PDF/ZIP
  vizibil când este selectat „EXISTA_CAIET".

P3 (FEATURE) — Atașament demonstrare estimare valoare la Secțiunea F din RN
  Secțiunea F are 3 textarea-uri „Sursa estimării" (per Lucrări/Produse/
  Servicii). Trebuie posibilitatea de a urca un fișier (deviz, oferte
  PDF, studiu de piață) care demonstrează modul de estimare a valorii.

Ambele atașamente folosesc o tabelă nouă formular_attachments (pattern
identic cu flow_attachments din migr 012), cu coloana `category` care
distinge tipul: 'caiet_sarcini' (sect J) sau 'estimare_valoare' (sect F).

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH (verifică `git status` înainte de commit!)
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- server/services/formulare-oficiale/refnec-pdf.mjs (generare PDF)
- server/services/formulare-oficiale/nf-invest-pdf.mjs (generare PDF)
- public/refnec-form.html în secțiunile A-E, G-I, K-N — schimbăm DOAR
  secțiunile F și J + funcția rfnSave + helper-urile noi de attachment.
- public/notafd-invest-form.html — schimbăm DOAR funcția nfSave +
  butonul „Salvează" (adăugăm `id="nf-btn-save"`).

═══════════════════════════════════════════════════════════
PASUL 1 — Backend fix: body limit 50MB pentru /formulare-oficiale
═══════════════════════════════════════════════════════════

În server/index.mjs, în array-ul _LARGE_PDF_PATHS:

old_str:
const _LARGE_PDF_PATHS = [
  '/flows',                   // POST/PUT — creare/editare flux cu pdfB64
  '/reinitiate-review',       // POST — upload document revizuit după review
  '/upload-signed-pdf',       // POST — upload PDF semnat de semnatar
  '/signing-callback',        // POST — callback provider cloud signing
  '/sign',                    // POST — poate conține signedPdfB64
  '/detect-acroform-fields',  // POST — detectare câmpuri AcroForm/XFA din PDF
];

new_str:
const _LARGE_PDF_PATHS = [
  '/flows',                   // POST/PUT — creare/editare flux cu pdfB64
  '/reinitiate-review',       // POST — upload document revizuit după review
  '/upload-signed-pdf',       // POST — upload PDF semnat de semnatar
  '/signing-callback',        // POST — callback provider cloud signing
  '/sign',                    // POST — poate conține signedPdfB64
  '/detect-acroform-fields',  // POST — detectare câmpuri AcroForm/XFA din PDF
  '/formulare-oficiale',      // POST/PUT/attachments — RN/NF cu form_data JSONB extins + atașamente base64
];

═══════════════════════════════════════════════════════════
PASUL 2 — Frontend fix RN: timeout 60s + error UX în rfnSave
═══════════════════════════════════════════════════════════

În public/refnec-form.html, înlocuiește funcția rfnSave existentă:

old_str:
// ── Salvare ───────────────────────────────────────────────────────────────────
async function rfnSave(){
  clearErr();
  const title = document.getElementById('rfn-title')?.value.trim();
  if(!title){ showErr('Titlul referatului este obligatoriu.'); return; }

  const payload = {
    form_type:  'REFNEC',
    title:      title,
    ref_number: document.getElementById('rfn-ref-number')?.value.trim() || null,
    form_data:  _readForm(),
  };

  const btn = document.getElementById('rfn-btn-save');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Se salvează...'; }

  try{
    const method = _rfnId ? 'PUT' : 'POST';
    const url    = _rfnId ? `/api/formulare-oficiale/${_rfnId}` : '/api/formulare-oficiale';
    const r = await fetch(url, {
      method, credentials:'include',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':getCsrf() },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if(!r.ok){ showErr(j.error || 'Eroare la salvare.'); return; }
    if(!_rfnId && j.formular?.id){
      _rfnId = j.formular.id;
      history.replaceState({}, '', `/refnec-form.html?id=${_rfnId}`);
    }
    ['rfn-saved-badge','rfn-saved-badge2'].forEach(id=>{
      const badge = document.getElementById(id);
      if(badge){ badge.textContent='✅ Salvat'; badge.classList.add('show');
        setTimeout(()=>badge.classList.remove('show'), 3000); }
    });
  }catch(e){
    showErr('Eroare rețea la salvare.');
  }finally{
    if(btn){ btn.disabled=false; btn.innerHTML='<svg class="df-ic"><use href="/icons.svg?v=3.9.407#ico-save"/></svg> Salvează draft'; }
  }
}

new_str:
// ── Salvare ───────────────────────────────────────────────────────────────────
async function rfnSave(){
  clearErr();
  const title = document.getElementById('rfn-title')?.value.trim();
  if(!title){ showErr('Titlul referatului este obligatoriu.'); return; }

  let payload;
  try {
    payload = {
      form_type:  'REFNEC',
      title:      title,
      ref_number: document.getElementById('rfn-ref-number')?.value.trim() || null,
      form_data:  _readForm(),
    };
  } catch(e) {
    showErr('Eroare la citirea formularului: ' + (e.message || e));
    return;
  }

  // Estimare dimensiune payload (defensiv — limita server e 50MB după fix backend)
  const payloadStr = JSON.stringify(payload);
  const sizeKB = Math.round(payloadStr.length / 1024);
  if (sizeKB > 30 * 1024) {  // > 30 MB
    showErr(`Formular foarte mare (${sizeKB} KB). Mutați paragrafele lungi în atașamente.`);
    return;
  }

  const btn = document.getElementById('rfn-btn-save');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Se salvează...'; }

  // Timeout explicit 60s — previne stuck la infinit dacă serverul/proxy nu răspunde
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 60_000);

  try{
    const method = _rfnId ? 'PUT' : 'POST';
    const url    = _rfnId ? `/api/formulare-oficiale/${_rfnId}` : '/api/formulare-oficiale';
    const r = await fetch(url, {
      method, credentials:'include',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':getCsrf() },
      body: payloadStr,
      signal: ctrl.signal,
    });

    // Răspunsul poate să NU fie JSON dacă serverul respinge cu 413/500 fără body JSON
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('application/json') ? await r.json().catch(()=>({})) : {};

    if(!r.ok){
      let msg;
      if (r.status === 413)      msg = `Formular prea mare (${sizeKB} KB). Server a respins cu 413 Payload Too Large. Mutați conținut în atașamente.`;
      else if (r.status === 403) msg = 'Sesiune expirată sau token CSRF invalid. Reîncărcați pagina (Ctrl+F5).';
      else if (r.status === 401) msg = 'Nu sunteți autentificat. Reîncărcați pagina.';
      else                       msg = j.error || j.message || `Eroare ${r.status} la salvare.`;
      showErr(msg);
      return;
    }
    if(!_rfnId && j.formular?.id){
      _rfnId = j.formular.id;
      history.replaceState({}, '', `/refnec-form.html?id=${_rfnId}`);
      // Notifică tab-ul attachments că formularul are acum un ID
      if (typeof rfnAttRefreshAll === 'function') rfnAttRefreshAll();
    }
    ['rfn-saved-badge','rfn-saved-badge2'].forEach(id=>{
      const badge = document.getElementById(id);
      if(badge){ badge.textContent='✅ Salvat'; badge.classList.add('show');
        setTimeout(()=>badge.classList.remove('show'), 3000); }
    });
  }catch(e){
    if (e.name === 'AbortError') {
      showErr('Salvarea a depășit 60 de secunde. Verificați conexiunea sau încărcarea serverului și reîncercați.');
    } else {
      showErr('Eroare rețea la salvare: ' + (e.message || e));
    }
  }finally{
    clearTimeout(timeoutId);
    if(btn){ btn.disabled=false; btn.innerHTML='<svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-save"/></svg> Salvează draft'; }
  }
}

═══════════════════════════════════════════════════════════
PASUL 2B — Frontend fix NF Investiții: ID buton + AbortController + 413
═══════════════════════════════════════════════════════════

2B.1 — Adaugă id pe butonul Salvează din notafd-invest-form.html:

old_str:
        <button class="df-action-btn primary" onclick="nfSave()"><svg class="df-ic"><use href="/icons.svg?v=3.9.407#ico-save"/></svg>Salvează</button>

new_str:
        <button class="df-action-btn primary" id="nf-btn-save" onclick="nfSave()"><svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-save"/></svg>Salvează</button>

2B.2 — Înlocuiește funcția nfSave existentă:

old_str:
// ── Salvare ──────────────────────────────────────────────────────────────────
async function nfSave(){
  showErr('');
  const title = document.getElementById('nf-title').value.trim();
  if(!title){ showErr('Titlul este obligatoriu.'); return; }

  const payload = {
    form_type:  'NOTAFD_INVEST',
    title:      title,
    ref_number: document.getElementById('nf-ref_number').value.trim() || null,
    form_data:  _readForm(),
  };

  const csrf = getCsrf();
  try{
    let r, method, url;
    if(_nfId){
      method = 'PUT';
      url    = `/api/formulare-oficiale/${_nfId}`;
    }else{
      method = 'POST';
      url    = '/api/formulare-oficiale';
    }
    r = await fetch(url, {
      method, credentials:'include',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':csrf },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if(!r.ok){ showErr(j.error || 'Eroare la salvare.'); return; }
    if(!_nfId && j.formular?.id){
      _nfId = j.formular.id;
      history.replaceState({},'', `/notafd-invest-form.html?id=${_nfId}`);
    }
    const badge = document.getElementById('nf-saved-badge');
    if(badge){
      badge.textContent = '✅ Salvat';
      badge.classList.add('show');
      setTimeout(()=>badge.classList.remove('show'), 3000);
    }
  }catch(e){
    showErr('Eroare rețea la salvare.');
  }
}

new_str:
// ── Salvare ──────────────────────────────────────────────────────────────────
async function nfSave(){
  showErr('');
  const title = document.getElementById('nf-title').value.trim();
  if(!title){ showErr('Titlul este obligatoriu.'); return; }

  let payload;
  try {
    payload = {
      form_type:  'NOTAFD_INVEST',
      title:      title,
      ref_number: document.getElementById('nf-ref_number').value.trim() || null,
      form_data:  _readForm(),
    };
  } catch(e) {
    showErr('Eroare la citirea formularului: ' + (e.message || e));
    return;
  }

  const payloadStr = JSON.stringify(payload);
  const sizeKB = Math.round(payloadStr.length / 1024);
  if (sizeKB > 30 * 1024) {
    showErr(`Formular foarte mare (${sizeKB} KB). Reduceți conținutul.`);
    return;
  }

  const btn = document.getElementById('nf-btn-save');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Se salvează...'; }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 60_000);

  const csrf = getCsrf();
  try{
    const method = _nfId ? 'PUT' : 'POST';
    const url    = _nfId ? `/api/formulare-oficiale/${_nfId}` : '/api/formulare-oficiale';
    const r = await fetch(url, {
      method, credentials:'include',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':csrf },
      body: payloadStr,
      signal: ctrl.signal,
    });

    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('application/json') ? await r.json().catch(()=>({})) : {};

    if(!r.ok){
      let msg;
      if (r.status === 413)      msg = `Formular prea mare (${sizeKB} KB). Server a respins cu 413 Payload Too Large.`;
      else if (r.status === 403) msg = 'Sesiune expirată sau token CSRF invalid. Reîncărcați pagina (Ctrl+F5).';
      else if (r.status === 401) msg = 'Nu sunteți autentificat. Reîncărcați pagina.';
      else                       msg = j.error || j.message || `Eroare ${r.status} la salvare.`;
      showErr(msg);
      return;
    }
    if(!_nfId && j.formular?.id){
      _nfId = j.formular.id;
      history.replaceState({},'', `/notafd-invest-form.html?id=${_nfId}`);
    }
    const badge = document.getElementById('nf-saved-badge');
    if(badge){
      badge.textContent = '✅ Salvat';
      badge.classList.add('show');
      setTimeout(()=>badge.classList.remove('show'), 3000);
    }
  }catch(e){
    if (e.name === 'AbortError') {
      showErr('Salvarea a depășit 60 de secunde. Verificați conexiunea și reîncercați.');
    } else {
      showErr('Eroare rețea la salvare: ' + (e.message || e));
    }
  }finally{
    clearTimeout(timeoutId);
    if(btn){ btn.disabled = false; btn.innerHTML = '<svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-save"/></svg>Salvează'; }
  }
}

═══════════════════════════════════════════════════════════
PASUL 3 — Migrare DB 068 (formular_attachments)
═══════════════════════════════════════════════════════════

În server/db/index.mjs, după blocul migrației '067_soft_delete_users_orgs',
adaugă o nouă migrare:

  {
    id: '068_formular_attachments',
    sql: `
      CREATE TABLE IF NOT EXISTS formular_attachments (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        formular_id   UUID        NOT NULL REFERENCES formulare_oficiale(id) ON DELETE CASCADE,
        category      TEXT        NOT NULL CHECK (category IN ('caiet_sarcini','estimare_valoare','altele')),
        uploaded_by   INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        filename      TEXT        NOT NULL,
        mime_type     TEXT        NOT NULL DEFAULT 'application/octet-stream',
        size_bytes    INTEGER     NOT NULL DEFAULT 0,
        data          BYTEA       NOT NULL,
        notes         TEXT,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_formular_att_formular
        ON formular_attachments(formular_id, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_formular_att_category
        ON formular_attachments(formular_id, category, deleted_at);
    `
  },

═══════════════════════════════════════════════════════════
PASUL 4 — Backend: 4 endpoint-uri pentru attachment
═══════════════════════════════════════════════════════════

În server/routes/formulare-oficiale.mjs, IMEDIAT DUPĂ handler-ul
POST /:id/generate-pdf existent (înainte de export default router),
adaugă:

  // ═══════════════════════════════════════════════════════
  // ATTACHMENTS — Caiet sarcini (sect J), Estimare valoare (sect F), altele
  // ═══════════════════════════════════════════════════════

  const ATT_ALLOWED_MIME = new Set([
    'application/pdf',
    'application/zip', 'application/x-zip-compressed', 'application/x-zip',
    'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png',
  ]);
  const ATT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per fișier
  const ATT_CATEGORIES = ['caiet_sarcini', 'estimare_valoare', 'altele'];

  // POST /api/formulare-oficiale/:id/attachments — upload
  router.post('/:id/attachments', requireAuth, csrfMiddleware, _json, async (req, res) => {
    try {
      const { orgId, userId } = req.actor;
      const { id } = req.params;
      const { filename, mimeType, dataB64, category, notes } = req.body || {};

      if (!filename || !dataB64) return res.status(400).json({ error: 'filename_and_data_required' });
      if (!ATT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'invalid_category', message: 'Categorie invalidă.' });

      // Verifică formularul există și aparține org-ului
      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
        [id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

      // MIME detection
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const mimeByExt = {
        pdf: 'application/pdf',
        zip: 'application/zip',
        rar: 'application/x-rar-compressed',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      };
      const resolvedMime = (mimeType && ATT_ALLOWED_MIME.has(mimeType)) ? mimeType : (mimeByExt[ext] || mimeType || 'application/octet-stream');
      if (!ATT_ALLOWED_MIME.has(resolvedMime)) {
        return res.status(400).json({ error: 'invalid_type', message: 'Tipuri acceptate: PDF, DOC(X), XLS(X), ZIP, RAR, JPG, PNG.' });
      }

      const raw = dataB64.includes(',') ? dataB64.split(',')[1] : dataB64;
      const buf = Buffer.from(raw, 'base64');
      if (buf.length > ATT_MAX_BYTES) return res.status(413).json({ error: 'too_large', message: 'Fișierul depășește 25 MB.' });

      const { rows } = await pool.query(
        `INSERT INTO formular_attachments
           (formular_id, category, uploaded_by, filename, mime_type, size_bytes, data, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, category, filename, mime_type, size_bytes, notes, uploaded_at`,
        [id, category, userId, filename.slice(0, 255), resolvedMime, buf.length, buf, notes || null]
      );
      return res.status(201).json({ ok: true, attachment: rows[0] });
    } catch(e) {
      logger.error({ err: e }, 'formular attachment upload error');
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // GET /api/formulare-oficiale/:id/attachments — listă (opțional ?category=X)
  router.get('/:id/attachments', requireAuth, async (req, res) => {
    try {
      const { orgId } = req.actor;
      const { id } = req.params;
      const { category } = req.query;

      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
        [id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

      const params = [id];
      let where = 'formular_id=$1 AND deleted_at IS NULL';
      if (category && ATT_CATEGORIES.includes(category)) {
        params.push(category);
        where += ` AND category=$${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, category, filename, mime_type, size_bytes, notes, uploaded_at, uploaded_by
           FROM formular_attachments
          WHERE ${where}
          ORDER BY uploaded_at DESC`,
        params
      );
      return res.json(rows);
    } catch(e) {
      logger.error({ err: e }, 'formular attachments list error');
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // GET /api/formulare-oficiale/:id/attachments/:attId — descarcă
  router.get('/:id/attachments/:attId', requireAuth, async (req, res) => {
    try {
      const { orgId } = req.actor;
      const { id, attId } = req.params;

      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
        [id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

      const { rows } = await pool.query(
        `SELECT filename, mime_type, data
           FROM formular_attachments
          WHERE id=$1 AND formular_id=$2 AND deleted_at IS NULL`,
        [attId, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'attachment_not_found' });
      const att = rows[0];
      res.setHeader('Content-Type', att.mime_type);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
      res.setHeader('Content-Length', att.data.length);
      return res.send(att.data);
    } catch(e) {
      logger.error({ err: e }, 'formular attachment download error');
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // DELETE /api/formulare-oficiale/:id/attachments/:attId — soft-delete
  router.delete('/:id/attachments/:attId', requireAuth, csrfMiddleware, async (req, res) => {
    try {
      const { orgId } = req.actor;
      const { id, attId } = req.params;

      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare_oficiale WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
        [id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular_not_found' });

      const { rowCount } = await pool.query(
        `UPDATE formular_attachments SET deleted_at = NOW()
          WHERE id=$1 AND formular_id=$2 AND deleted_at IS NULL`,
        [attId, id]
      );
      if (!rowCount) return res.status(404).json({ error: 'attachment_not_found' });
      return res.json({ ok: true, deleted: true });
    } catch(e) {
      logger.error({ err: e }, 'formular attachment delete error');
      return res.status(500).json({ error: 'server_error' });
    }
  });

═══════════════════════════════════════════════════════════
PASUL 5 — Frontend RN: widget atașament Caiet sarcini (Sect J)
═══════════════════════════════════════════════════════════

În public/refnec-form.html, în interiorul secțiunii J, identifică
blocul `EXISTA_CAIET` (probabil un radio + label) și ADAUGĂ după el
un container „verde" cu lista atașamentelor + buton „Adaugă Caiet
de sarcini":

Locație: caută cu
  grep -n 'EXISTA_CAIET\|FARA_CAIET\|caiet de sarcini\|caiet-sarcini' public/refnec-form.html

Imediat sub blocul de radio EXISTA_CAIET (sau în div-ul condițional
care se afișează când EXISTA_CAIET e selectat), adaugă:

<!-- Atașament Caiet de sarcini (vizibil doar la EXISTA_CAIET) -->
<div id="rfn-j-caiet-attachments" style="margin-top:12px;padding:12px;
     background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);
     border-radius:8px;">
  <div style="display:flex;align-items:center;justify-content:space-between;
              margin-bottom:8px;">
    <strong style="color:#86efac;font-size:.92rem;">
      📎 Caiet de sarcini (atașament)
    </strong>
    <button type="button" class="df-action-btn sm" onclick="rfnAttUpload('caiet_sarcini')">
      <svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-paperclip"/></svg>
      Adaugă Caiet de sarcini
    </button>
  </div>
  <div id="rfn-j-attachments-list" style="font-size:.88rem;color:var(--df-text-3);">
    <em>— niciun fișier încărcat —</em>
  </div>
</div>

═══════════════════════════════════════════════════════════
PASUL 6 — Frontend RN: widget atașament Estimare valoare (Sect F)
═══════════════════════════════════════════════════════════

În public/refnec-form.html, identifică finalul accordionului F
(sub cele 3 textareas „Sursa estimării") și adaugă:

Locație: caută cu
  grep -n 'sursa-estim\|sursa_estim\|sect-f\|Estimare valoare\|rfn-f-' public/refnec-form.html

La FINALUL secțiunii F (înainte de închiderea div-ului accordionului):

<!-- Atașament Demonstrare estimare valoare -->
<div id="rfn-f-estimare-attachments" style="margin-top:16px;padding:12px;
     background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.25);
     border-radius:8px;">
  <div style="display:flex;align-items:center;justify-content:space-between;
              margin-bottom:8px;">
    <strong style="color:#c4b5fd;font-size:.92rem;">
      📎 Documente justificative — modul de estimare
    </strong>
    <button type="button" class="df-action-btn sm" onclick="rfnAttUpload('estimare_valoare')">
      <svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-paperclip"/></svg>
      Adaugă atașament
    </button>
  </div>
  <div style="font-size:.82rem;color:var(--df-text-4);margin-bottom:8px;">
    Devize, oferte, studii de piață care demonstrează modul de estimare a valorii.
  </div>
  <div id="rfn-f-attachments-list" style="font-size:.88rem;color:var(--df-text-3);">
    <em>— niciun fișier încărcat —</em>
  </div>
</div>

═══════════════════════════════════════════════════════════
PASUL 7 — Frontend RN: helper functions pentru attachments
═══════════════════════════════════════════════════════════

În public/refnec-form.html, în zona de scripturi (înainte de
window.rfnSave = rfnSave; sau echivalent), adaugă:

// ── Attachments helpers ───────────────────────────────────────────────────────
const _RFN_ATT_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.jpg,.jpeg,.png';
const _RFN_ATT_MAX_MB = 25;

function _rfnFmtSize(bytes){
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1024*1024) return Math.round(bytes/1024) + ' KB';
  return (bytes/(1024*1024)).toFixed(2) + ' MB';
}

function _rfnAttListEl(category){
  return document.getElementById(category === 'caiet_sarcini' ? 'rfn-j-attachments-list' : 'rfn-f-attachments-list');
}

async function rfnAttRefresh(category){
  const el = _rfnAttListEl(category);
  if(!el) return;
  if(!_rfnId){
    el.innerHTML = '<em style="color:var(--df-text-5);">Salvați referatul mai întâi pentru a încărca atașamente.</em>';
    return;
  }
  try{
    const r = await fetch(`/api/formulare-oficiale/${_rfnId}/attachments?category=${encodeURIComponent(category)}`,
      { credentials:'include' });
    if(!r.ok){ el.innerHTML = '<em style="color:#fca5a5;">Eroare la încărcarea listei.</em>'; return; }
    const list = await r.json();
    if(!Array.isArray(list) || list.length === 0){
      el.innerHTML = '<em>— niciun fișier încărcat —</em>';
      return;
    }
    el.innerHTML = list.map(a => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 8px;
                  border:1px solid var(--df-border-2);border-radius:6px;margin-top:6px;
                  background:rgba(255,255,255,.03);">
        <svg class="df-ic" style="flex-shrink:0;"><use href="/icons.svg?v=3.9.442#ico-file-text"/></svg>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:var(--df-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${_rfnEsc(a.filename)}
          </div>
          <div style="font-size:.78rem;color:var(--df-text-5);">
            ${_rfnFmtSize(a.size_bytes)} · ${new Date(a.uploaded_at).toLocaleString('ro-RO')}
          </div>
        </div>
        <a href="/api/formulare-oficiale/${_rfnId}/attachments/${a.id}" download
           class="df-action-btn sm" style="text-decoration:none;">
          <svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-download"/></svg>
        </a>
        <button type="button" class="df-action-btn sm danger"
                onclick="rfnAttDelete('${a.id}', '${category}')">
          <svg class="df-ic"><use href="/icons.svg?v=3.9.442#ico-trash"/></svg>
        </button>
      </div>
    `).join('');
  }catch(e){
    el.innerHTML = '<em style="color:#fca5a5;">Eroare rețea.</em>';
  }
}

function _rfnEsc(s){ return String(s||'').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function rfnAttRefreshAll(){
  await rfnAttRefresh('caiet_sarcini');
  await rfnAttRefresh('estimare_valoare');
}

async function rfnAttUpload(category){
  if(!_rfnId){
    alert('Salvați referatul (click Salvează draft) înainte de a încărca atașamente.');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = _RFN_ATT_ACCEPT;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if(!f) return;
    if(f.size > _RFN_ATT_MAX_MB * 1024 * 1024){
      alert(`Fișier prea mare (${(f.size/(1024*1024)).toFixed(1)} MB). Limită: ${_RFN_ATT_MAX_MB} MB.`);
      return;
    }
    const el = _rfnAttListEl(category);
    if(el){ el.innerHTML = '<em style="color:#fbbf24;">⏳ Se încarcă...</em>'; }

    try{
      const dataB64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.onerror = () => reject(new Error('read error'));
        fr.readAsDataURL(f);
      });

      const r = await fetch(`/api/formulare-oficiale/${_rfnId}/attachments`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type':'application/json', 'X-CSRF-Token': getCsrf() },
        body: JSON.stringify({ filename: f.name, mimeType: f.type, dataB64, category }),
      });
      const j = await r.json().catch(()=>({}));
      if(!r.ok){
        const msg = r.status === 413 ? 'Fișier prea mare (server).' :
                    r.status === 400 ? (j.message || 'Tip fișier invalid.') :
                    (j.error || 'Eroare la upload.');
        alert(msg);
      }
    }catch(e){
      alert('Eroare rețea la upload: ' + (e.message || e));
    }finally{
      await rfnAttRefresh(category);
    }
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 1000);
}

async function rfnAttDelete(attId, category){
  if(!confirm('Ștergeți acest atașament?')) return;
  try{
    const r = await fetch(`/api/formulare-oficiale/${_rfnId}/attachments/${attId}`, {
      method: 'DELETE', credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrf() },
    });
    if(!r.ok){
      const j = await r.json().catch(()=>({}));
      alert(j.error || 'Eroare la ștergere.');
    }
  }catch(e){
    alert('Eroare rețea: ' + (e.message || e));
  }finally{
    await rfnAttRefresh(category);
  }
}

// Expune global pentru handlere onclick din HTML
window.rfnAttUpload     = rfnAttUpload;
window.rfnAttDelete     = rfnAttDelete;
window.rfnAttRefresh    = rfnAttRefresh;
window.rfnAttRefreshAll = rfnAttRefreshAll;

═══════════════════════════════════════════════════════════
PASUL 8 — Frontend RN: încărcare auto attachments la deschidere form
═══════════════════════════════════════════════════════════

Trebuie să apelăm rfnAttRefreshAll() după ce formularul este încărcat
(_writeForm a rulat și _rfnId este setat).

Caută în refnec-form.html funcția care se rulează la load:
  grep -n "URLSearchParams\|window.addEventListener.*DOMContentLoaded\|init()\|_rfnId =" public/refnec-form.html | head -10

Identifică LOCUL în init/load handler unde se setează _rfnId și se
apelează _writeForm(data). IMEDIAT DUPĂ acel apel _writeForm, adaugă:

  // Încarcă lista de atașamente după ce form-ul e populat
  if (typeof rfnAttRefreshAll === 'function') rfnAttRefreshAll();

NOTĂ: dacă nu găsești locul exact, adaugă și un fallback safety:
la finalul funcției _writeForm(data) adaugă:
  if (typeof rfnAttRefreshAll === 'function') rfnAttRefreshAll();

═══════════════════════════════════════════════════════════
PASUL 9 — Cache busting (3.9.441 → 3.9.442, SW v157 → v158)
═══════════════════════════════════════════════════════════

9.1 — package.json:
  old_str:   "version": "3.9.441",
  new_str:   "version": "3.9.442",

9.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v157';
  new_str: const CACHE_VERSION = 'docflowai-v158';

9.3 — public/admin.html (dacă conține referințe vechi):
  grep -c "v=3\.9\.4" public/admin.html
  → dacă nenule și ≥ 1, sed pentru standardizare:
  sed -i 's/v=3\.9\.\(40[0-9]\|4[01][0-9]\|44[01]\)/v=3.9.442/g' public/admin.html

9.4 — public/refnec-form.html: bump v=3.9.407 → v=3.9.442:
  sed -i 's/v=3\.9\.407/v=3.9.442/g' public/refnec-form.html
  Verifică: grep -c "v=3.9.407" public/refnec-form.html → 0

9.5 — public/notafd-invest-form.html: bump v=3.9.407 → v=3.9.442:
  sed -i 's/v=3\.9\.407/v=3.9.442/g' public/notafd-invest-form.html
  Verifică: grep -c "v=3.9.407" public/notafd-invest-form.html → 0

9.6 — public/formular.html: bump v=3.9.407 → v=3.9.442:
  sed -i 's/v=3\.9\.407/v=3.9.442/g' public/formular.html
  Verifică: grep -c "v=3.9.407" public/formular.html → 0

9.7 — public/sw.js: dacă /refnec-form.html sau /notafd-invest-form.html
       sunt în PRECACHE_ASSETS, sunt invalidate prin CACHE_VERSION bump.
  grep -E "refnec-form|notafd-invest-form" public/sw.js

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Backend body limit aplicat:
   grep -c "/formulare-oficiale" server/index.mjs
   → ≥ 2 (în _LARGE_PDF_PATHS + în app.use mount)

2. Migrarea există:
   grep -A 2 "068_formular_attachments" server/db/index.mjs | head -5

3. 4 endpoint-uri attachment:
   grep -cE "router\.(post|get|delete).*'/:id/attachments" server/routes/formulare-oficiale.mjs
   → 4

4. Frontend rfnSave are AbortController:
   grep -c "AbortController\|ctrl.abort" public/refnec-form.html
   → ≥ 2

5. Frontend nfSave are AbortController:
   grep -c "AbortController\|ctrl.abort" public/notafd-invest-form.html
   → ≥ 2

6. Buton NF are id:
   grep -c 'id="nf-btn-save"' public/notafd-invest-form.html
   → 1

7. Widget-uri în formular RN:
   grep -c 'id="rfn-f-attachments-list"\|id="rfn-j-attachments-list"' public/refnec-form.html
   → 2

8. Helper functions RN:
   grep -cE "function (rfnAttUpload|rfnAttRefresh|rfnAttDelete)" public/refnec-form.html
   → 3

9. Window exports RN:
   grep -cE "window\.(rfnAttUpload|rfnAttDelete|rfnAttRefresh)" public/refnec-form.html
   → 3

10. Cache busting:
    grep -c "v=3.9.442" public/refnec-form.html         → ≥ 5
    grep -c "v=3.9.442" public/notafd-invest-form.html  → ≥ 5
    grep -c "v=3.9.442" public/formular.html            → ≥ 50
    grep -c "v=3.9.407" public/refnec-form.html         → 0
    grep -c "v=3.9.407" public/notafd-invest-form.html  → 0
    grep -c "v=3.9.407" public/formular.html            → 0

11. Sintaxă:
    node --check public/sw.js
    npm run check

12. TESTE:
    npm test verde, fără regresii

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/index.mjs \
        server/db/index.mjs \
        server/routes/formulare-oficiale.mjs \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/formular.html \
        public/sw.js \
        package.json

git commit -m "fix(formulare): salvare blocata RN+NF + atasamente sect F si J (v3.9.442)

P1 (BUG) — Salvare RN blocata la 'Se salveaza...'
  Cauza: middleware adaptiv body limit 1MB pentru paths ne-PDF.
  POST/PUT /api/formulare-oficiale lipsea din _LARGE_PDF_PATHS →
  payloads >1MB respinse cu 413 inainte de route handler. Pe Railway
  cu HTTP/2, raspunsul nu ajungea corect la browser → fetch atarna.
  Fix: adaugat /formulare-oficiale in _LARGE_PDF_PATHS (limita 50MB).
  Defensive: timeout explicit 60s + AbortController in rfnSave +
  mesaje de eroare specifice pe coduri 401/403/413/altele.

P1B (BUG) — Salvare NF Investitii afectata de aceeasi cauza
  Acelasi pattern defensiv aplicat pe nfSave: id='nf-btn-save' adaugat,
  AbortController + 413/401/403 handling, estimare dimensiune payload.
  Functional verificat: butonul Salveaza din notafd-invest-form.html
  acum ofera feedback consistent cu RN.

P2 (FEATURE) — Atasament Caiet de sarcini la Sectiunea J din RN
  In blocul EXISTA_CAIET adaugat widget upload PDF/DOC/DOCX/XLS/ZIP/RAR
  cu listare + download + soft-delete.

P3 (FEATURE) — Atasament demonstrare estimare valoare la Sectiunea F din RN
  La final-ul accordionului F, widget upload pentru devize/oferte/
  studii de piata care demonstreaza modul de estimare a valorii.

Migrare 068 — formular_attachments (BYTEA, max 25MB/fisier, soft-delete,
category enum: caiet_sarcini/estimare_valoare/altele).

4 endpoint-uri noi: POST/GET/GET-download/DELETE pe
/api/formulare-oficiale/:id/attachments cu org_id verification +
CSRF pe POST/DELETE + auth pe toate.

Cache: package 3.9.441 -> 3.9.442, SW v157 -> v158.
ico-uri din toate cele 3 formulare HTML bump-ate de la v=3.9.407
(stale) la v=3.9.442 (refnec-form, notafd-invest-form, formular)."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging)
═══════════════════════════════════════════════════════════

1. Verifică migrarea s-a aplicat:
   railway run psql $DATABASE_URL -c "SELECT id FROM migrations WHERE id='068_formular_attachments'"
   → o linie returnată

2. Hard refresh /refnec-form.html?id=X (sau form nou)
   → Sect F: vezi „📎 Documente justificative — modul de estimare"
     cu buton „Adaugă atașament"
   → Sect J → bifează „Există Caiet de sarcini" → vezi căsuța verde
     cu „📎 Caiet de sarcini" și buton „Adaugă Caiet de sarcini"

3. Hard refresh /notafd-invest-form.html?id=X (sau form nou)
   → Buton „Salvează" are acum stare disabled + spinner '⏳ Se salvează...'
   → Test consola: payload mare (300+ cuvinte/textarea) → salvare reușită
     fără să atârne (era 1MB limit înainte; acum 50MB)

4. Încearcă upload ÎNAINTE de prima salvare a RN:
   → Click „Adaugă Caiet de sarcini" cu form nou (fără ID) →
     alert: „Salvați referatul (click Salvează draft) înainte..."

5. Salvează draft → upload Caiet sarcini PDF de ~2MB:
   → Status: „⏳ Se încarcă..." apoi listă populată
   → Apare în listă cu nume + dimensiune + dată + butoane Download + Șterge

6. Test salvare „grea" RN (verifică P1 fix):
   → Completează TOATE secțiunile cu paragrafe lungi (300+ cuvinte
     în fiecare textarea principală)
   → Click Salvează → ar trebui să meargă fără să atârne

7. Test timeout RN (verifică P1 fallback):
   → DevTools → Network → throttle „Slow 3G"
   → Click Salvează → după 60s vezi mesaj „Salvarea a depășit
     60 de secunde..." (nu rămâne stuck la infinit)

8. Test NF Investiții (verifică P1B fix):
   → Deschide /notafd-invest-form.html
   → Completează titlu + valori + descriere lungă
   → Click „Salvează" → vezi feedback '⏳ Se salvează...' apoi '✅ Salvat'
   → Reîncarcă pagina cu ?id=X → datele se reîncarcă corect

9. Test cross-org:
   → Creează un user în alt org
   → Încearcă să descarci attachment-ul cu URL hardcoded
   → Răspuns 404 „formular_not_found"

STOP dacă:
- Migrarea eșuează → verifică log Railway pentru cauza
- Upload eșuează cu „413 too_large" pe fișiere <25MB → verifică că
  /api/formulare-oficiale ajunge la _LARGE_PDF_PATHS check
- Salvarea încă blochează la RN sau NF → check Railway logs pentru
  request-ul /api/formulare-oficiale; posibil conexiunea PostgreSQL
  pool epuizată
```
