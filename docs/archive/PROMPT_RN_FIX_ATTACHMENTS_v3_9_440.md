# DocFlowAI — 🔧 FIX SAVE RN + ATAȘAMENTE SECT F \& J (v3.9.438)

```
DocFlowAI v3.9.439 → v3.9.440 (SW v155 → v156)
Branch: develop
Subiect: fix(refnec): salvare blocată + atașamente Caiet sarcini (J) și Estimare valoare (F)

═══════════════════════════════════════════════════════════
CONTEXT — 3 PROBLEME REZOLVATE
═══════════════════════════════════════════════════════════

P1 (BUG) — Salvare RN blocată la „⏳ Se salvează..."
  Cauză root: server/index.mjs middleware adaptiv (linia \~618) aplică
  body limit 1MB pentru orice path NU LISTAT în \_LARGE\_PDF\_PATHS.
  POST/PUT /api/formulare-oficiale NU este în listă → la formulare RN
  bogate în textareas, checklist și revizuiri, payload-ul poate depăși
  1MB → express respinge cu 413 ÎNAINTE ca route-handler-ul să ruleze
  → pe Railway cu HTTP/2 multiplexing, răspunsul nu ajunge corect la
  browser → fetch atârnă → finally never runs → button rămâne stuck.
  FIX: adaugă /formulare-oficiale în \_LARGE\_PDF\_PATHS (limită 50MB)
  ȘI adaugă timeout explicit + error UX mai bun în rfnSave().

P2 (FEATURE) — Atașament Caiet de sarcini la Secțiunea J
  Secțiunea J are deja radio EXISTA\_CAIET / FARA\_CAIET dar NU permite
  upload-ul fișierului efectiv. Trebuie buton de încărcare PDF/ZIP
  vizibil când este selectat „EXISTA\_CAIET".

P3 (FEATURE) — Atașament demonstrare estimare valoare la Secțiunea F
  Secțiunea F are 3 textarea-uri „Sursa estimării" (per Lucrări/Produse/
  Servicii). Trebuie posibilitatea de a urca un fișier (deviz, oferte
  PDF, studiu de piață) care demonstrează modul de estimare a valorii.

Ambele atașamente folosesc o tabelă nouă formular\_attachments (pattern
identic cu flow\_attachments din migr 012), cu coloana `category` care
distinge tipul: 'caiet\_sarcini' (sect J) sau 'estimare\_valoare' (sect F).

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- server/services/formulare-oficiale/refnec-pdf.mjs (generare PDF)
- public/refnec-form.html în secțiunile A-E, G-I, K-N — schimbăm DOAR
  secțiunile F și J + funcțiile rfnSave + helper-urile noi de attachment.

═══════════════════════════════════════════════════════════
PASUL 1 — Backend fix: body limit 50MB pentru /formulare-oficiale
═══════════════════════════════════════════════════════════

În server/index.mjs, în array-ul \_LARGE\_PDF\_PATHS:

old\_str:
const \_LARGE\_PDF\_PATHS = \[
  '/flows',                   // POST/PUT — creare/editare flux cu pdfB64
  '/reinitiate-review',       // POST — upload document revizuit după review
  '/upload-signed-pdf',       // POST — upload PDF semnat de semnatar
  '/signing-callback',        // POST — callback provider cloud signing
  '/sign',                    // POST — poate conține signedPdfB64
  '/detect-acroform-fields',  // POST — detectare câmpuri AcroForm/XFA din PDF
];

new\_str:
const \_LARGE\_PDF\_PATHS = \[
  '/flows',                   // POST/PUT — creare/editare flux cu pdfB64
  '/reinitiate-review',       // POST — upload document revizuit după review
  '/upload-signed-pdf',       // POST — upload PDF semnat de semnatar
  '/signing-callback',        // POST — callback provider cloud signing
  '/sign',                    // POST — poate conține signedPdfB64
  '/detect-acroform-fields',  // POST — detectare câmpuri AcroForm/XFA din PDF
  '/formulare-oficiale',      // POST/PUT — RN/NF cu form\_data JSONB extins + atașamente base64
];

═══════════════════════════════════════════════════════════
PASUL 2 — Frontend fix: timeout 60s + error UX în rfnSave
═══════════════════════════════════════════════════════════

În public/refnec-form.html, înlocuiește funcția rfnSave existentă:

old\_str:
// ── Salvare ───────────────────────────────────────────────────────────────────
async function rfnSave(){
  clearErr();
  const title = document.getElementById('rfn-title')?.value.trim();
  if(!title){ showErr('Titlul referatului este obligatoriu.'); return; }

  const payload = {
    form\_type:  'REFNEC',
    title:      title,
    ref\_number: document.getElementById('rfn-ref-number')?.value.trim() || null,
    form\_data:  \_readForm(),
  };

  const btn = document.getElementById('rfn-btn-save');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Se salvează...'; }

  try{
    const method = \_rfnId ? 'PUT' : 'POST';
    const url    = \_rfnId ? `/api/formulare-oficiale/${\_rfnId}` : '/api/formulare-oficiale';
    const r = await fetch(url, {
      method, credentials:'include',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':getCsrf() },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if(!r.ok){ showErr(j.error || 'Eroare la salvare.'); return; }
    if(!\_rfnId \&\& j.formular?.id){
      \_rfnId = j.formular.id;
      history.replaceState({}, '', `/refnec-form.html?id=${\_rfnId}`);
    }
    \['rfn-saved-badge','rfn-saved-badge2'].forEach(id=>{
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

new\_str:
// ── Salvare ───────────────────────────────────────────────────────────────────
async function rfnSave(){
  clearErr();
  const title = document.getElementById('rfn-title')?.value.trim();
  if(!title){ showErr('Titlul referatului este obligatoriu.'); return; }

  let payload;
  try {
    payload = {
      form\_type:  'REFNEC',
      title:      title,
      ref\_number: document.getElementById('rfn-ref-number')?.value.trim() || null,
      form\_data:  \_readForm(),
    };
  } catch(e) {
    showErr('Eroare la citirea formularului: ' + (e.message || e));
    return;
  }

  // Estimare dimensiune payload (defensiv — limita server e 50MB după fix-ul backend)
  const payloadStr = JSON.stringify(payload);
  const sizeKB = Math.round(payloadStr.length / 1024);
  if (sizeKB > 30 \* 1024) {  // > 30 MB
    showErr(`Formular foarte mare (${sizeKB} KB). Mutați paragrafele lungi în atașamente.`);
    return;
  }

  const btn = document.getElementById('rfn-btn-save');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Se salvează...'; }

  // Timeout explicit 60s — previne stuck la infinit dacă serverul/proxy nu răspunde
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 60\_000);

  try{
    const method = \_rfnId ? 'PUT' : 'POST';
    const url    = \_rfnId ? `/api/formulare-oficiale/${\_rfnId}` : '/api/formulare-oficiale';
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
    if(!\_rfnId \&\& j.formular?.id){
      \_rfnId = j.formular.id;
      history.replaceState({}, '', `/refnec-form.html?id=${\_rfnId}`);
      // Notifică tab-ul attachments că formularul are acum un ID
      if (typeof rfnAttRefreshAll === 'function') rfnAttRefreshAll();
    }
    \['rfn-saved-badge','rfn-saved-badge2'].forEach(id=>{
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
    if(btn){ btn.disabled=false; btn.innerHTML='<svg class="df-ic"><use href="/icons.svg?v=3.9.438#ico-save"/></svg> Salvează draft'; }
  }
}

═══════════════════════════════════════════════════════════
PASUL 3 — Migrare DB 068 (formular\_attachments)
═══════════════════════════════════════════════════════════

În server/db/index.mjs, după blocul migrației '067\_soft\_delete\_users\_orgs',
adaugă o nouă migrare:

  {
    id: '068\_formular\_attachments',
    sql: `
      CREATE TABLE IF NOT EXISTS formular\_attachments (
        id            UUID        PRIMARY KEY DEFAULT gen\_random\_uuid(),
        formular\_id   UUID        NOT NULL REFERENCES formulare\_oficiale(id) ON DELETE CASCADE,
        category      TEXT        NOT NULL CHECK (category IN ('caiet\_sarcini','estimare\_valoare','altele')),
        uploaded\_by   INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        filename      TEXT        NOT NULL,
        mime\_type     TEXT        NOT NULL DEFAULT 'application/octet-stream',
        size\_bytes    INTEGER     NOT NULL DEFAULT 0,
        data          BYTEA       NOT NULL,
        notes         TEXT,
        uploaded\_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted\_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx\_formular\_att\_formular
        ON formular\_attachments(formular\_id, deleted\_at);
      CREATE INDEX IF NOT EXISTS idx\_formular\_att\_category
        ON formular\_attachments(formular\_id, category, deleted\_at);
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

  const ATT\_ALLOWED\_MIME = new Set(\[
    'application/pdf',
    'application/zip', 'application/x-zip-compressed', 'application/x-zip',
    'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png',
  ]);
  const ATT\_MAX\_BYTES = 25 \* 1024 \* 1024; // 25 MB per fișier
  const ATT\_CATEGORIES = \['caiet\_sarcini', 'estimare\_valoare', 'altele'];

  // POST /api/formulare-oficiale/:id/attachments — upload
  router.post('/:id/attachments', requireAuth, csrfMiddleware, \_json, async (req, res) => {
    try {
      const { orgId, userId } = req.actor;
      const { id } = req.params;
      const { filename, mimeType, dataB64, category, notes } = req.body || {};

      if (!filename || !dataB64) return res.status(400).json({ error: 'filename\_and\_data\_required' });
      if (!ATT\_CATEGORIES.includes(category)) return res.status(400).json({ error: 'invalid\_category', message: 'Categorie invalidă.' });

      // Verifică formularul există și aparține org-ului
      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare\_oficiale WHERE id=$1 AND org\_id=$2 AND deleted\_at IS NULL`,
        \[id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular\_not\_found' });

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
      const resolvedMime = (mimeType \&\& ATT\_ALLOWED\_MIME.has(mimeType)) ? mimeType : (mimeByExt\[ext] || mimeType || 'application/octet-stream');
      if (!ATT\_ALLOWED\_MIME.has(resolvedMime)) {
        return res.status(400).json({ error: 'invalid\_type', message: 'Tipuri acceptate: PDF, DOC(X), XLS(X), ZIP, RAR, JPG, PNG.' });
      }

      const raw = dataB64.includes(',') ? dataB64.split(',')\[1] : dataB64;
      const buf = Buffer.from(raw, 'base64');
      if (buf.length > ATT\_MAX\_BYTES) return res.status(413).json({ error: 'too\_large', message: 'Fișierul depășește 25 MB.' });

      const { rows } = await pool.query(
        `INSERT INTO formular\_attachments
           (formular\_id, category, uploaded\_by, filename, mime\_type, size\_bytes, data, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, category, filename, mime\_type, size\_bytes, notes, uploaded\_at`,
        \[id, category, userId, filename.slice(0, 255), resolvedMime, buf.length, buf, notes || null]
      );
      return res.status(201).json({ ok: true, attachment: rows\[0] });
    } catch(e) {
      logger.error({ err: e }, 'formular attachment upload error');
      return res.status(500).json({ error: 'server\_error' });
    }
  });

  // GET /api/formulare-oficiale/:id/attachments — listă (opțional ?category=X)
  router.get('/:id/attachments', requireAuth, async (req, res) => {
    try {
      const { orgId } = req.actor;
      const { id } = req.params;
      const { category } = req.query;

      // Verifică formularul aparține org-ului
      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare\_oficiale WHERE id=$1 AND org\_id=$2 AND deleted\_at IS NULL`,
        \[id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular\_not\_found' });

      const params = \[id];
      let where = 'formular\_id=$1 AND deleted\_at IS NULL';
      if (category \&\& ATT\_CATEGORIES.includes(category)) {
        params.push(category);
        where += ` AND category=$${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, category, filename, mime\_type, size\_bytes, notes, uploaded\_at, uploaded\_by
           FROM formular\_attachments
          WHERE ${where}
          ORDER BY uploaded\_at DESC`,
        params
      );
      return res.json(rows);
    } catch(e) {
      logger.error({ err: e }, 'formular attachments list error');
      return res.status(500).json({ error: 'server\_error' });
    }
  });

  // GET /api/formulare-oficiale/:id/attachments/:attId — descarcă
  router.get('/:id/attachments/:attId', requireAuth, async (req, res) => {
    try {
      const { orgId } = req.actor;
      const { id, attId } = req.params;

      // Verifică formularul aparține org-ului
      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare\_oficiale WHERE id=$1 AND org\_id=$2 AND deleted\_at IS NULL`,
        \[id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular\_not\_found' });

      const { rows } = await pool.query(
        `SELECT filename, mime\_type, data
           FROM formular\_attachments
          WHERE id=$1 AND formular\_id=$2 AND deleted\_at IS NULL`,
        \[attId, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'attachment\_not\_found' });
      const att = rows\[0];
      res.setHeader('Content-Type', att.mime\_type);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
      res.setHeader('Content-Length', att.data.length);
      return res.send(att.data);
    } catch(e) {
      logger.error({ err: e }, 'formular attachment download error');
      return res.status(500).json({ error: 'server\_error' });
    }
  });

  // DELETE /api/formulare-oficiale/:id/attachments/:attId — soft-delete
  router.delete('/:id/attachments/:attId', requireAuth, csrfMiddleware, async (req, res) => {
    try {
      const { orgId } = req.actor;
      const { id, attId } = req.params;

      const { rows: fRows } = await pool.query(
        `SELECT id FROM formulare\_oficiale WHERE id=$1 AND org\_id=$2 AND deleted\_at IS NULL`,
        \[id, orgId]
      );
      if (!fRows.length) return res.status(404).json({ error: 'formular\_not\_found' });

      const { rowCount } = await pool.query(
        `UPDATE formular\_attachments SET deleted\_at = NOW()
          WHERE id=$1 AND formular\_id=$2 AND deleted\_at IS NULL`,
        \[attId, id]
      );
      if (!rowCount) return res.status(404).json({ error: 'attachment\_not\_found' });
      return res.json({ ok: true, deleted: true });
    } catch(e) {
      logger.error({ err: e }, 'formular attachment delete error');
      return res.status(500).json({ error: 'server\_error' });
    }
  });

═══════════════════════════════════════════════════════════
PASUL 5 — Frontend section F: widget upload „Estimare valoare"
═══════════════════════════════════════════════════════════

În public/refnec-form.html, în secțiunea F (după ultimul `<div class="rfn-cond" data-tip="SERVICII"...>` și ÎNAINTE de `</div>` care închide `.rfn-acc-body` al lui rfn-acc-f):

old\_str:
          <div class="rfn-cond" data-tip="SERVICII" id="rfn-f-cond-servicii">
            <div class="nf-form-grid">
              <div class="nf-field">
                <label for="rfn-f-valoare-servicii">Valoare estimată — servicii</label>
                <input type="number" id="rfn-f-valoare-servicii" min="0" step="0.01" placeholder="0.00">
              </div>
              <div class="nf-field">
                <label for="rfn-f-moneda-servicii">Monedă</label>
                <select id="rfn-f-moneda-servicii">
                  <option value="RON">RON</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div class="nf-field full">
                <label for="rfn-f-sursa-servicii">Sursa estimării</label>
                <textarea id="rfn-f-sursa-servicii" rows="2" placeholder="Studiu de piață, oferte orientative..."></textarea>
              </div>
            </div>
          </div>
        </div>
      </div>

new\_str:
          <div class="rfn-cond" data-tip="SERVICII" id="rfn-f-cond-servicii">
            <div class="nf-form-grid">
              <div class="nf-field">
                <label for="rfn-f-valoare-servicii">Valoare estimată — servicii</label>
                <input type="number" id="rfn-f-valoare-servicii" min="0" step="0.01" placeholder="0.00">
              </div>
              <div class="nf-field">
                <label for="rfn-f-moneda-servicii">Monedă</label>
                <select id="rfn-f-moneda-servicii">
                  <option value="RON">RON</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div class="nf-field full">
                <label for="rfn-f-sursa-servicii">Sursa estimării</label>
                <textarea id="rfn-f-sursa-servicii" rows="2" placeholder="Studiu de piață, oferte orientative..."></textarea>
              </div>
            </div>
          </div>

          <!-- Atașamente: documente justificative pentru estimarea valorii -->
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);">
            <div style="font-size:.85rem;color:var(--df-text);font-weight:600;margin-bottom:6px;">📎 Documente justificative — modul de estimare a valorii</div>
            <div style="font-size:.78rem;color:var(--df-text-3);margin-bottom:10px;line-height:1.5;">
              Atașați documentele care demonstrează modul în care a fost estimată valoarea: <strong>devize estimative</strong>, <strong>oferte orientative</strong>, <strong>studii de piață</strong>, <strong>cataloage de prețuri</strong> etc.
            </div>
            <div id="rfn-f-attachments-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;"></div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <input type="file" id="rfn-f-att-input" accept=".pdf,.zip,.rar,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" style="display:none;" onchange="rfnAttUpload('estimare\_valoare', this)"/>
              <button type="button" class="df-action-btn" onclick="document.getElementById('rfn-f-att-input').click()">
                <svg class="df-ic"><use href="/icons.svg?v=3.9.438#ico-paperclip"/></svg> Adaugă atașament
              </button>
              <span id="rfn-f-att-status" style="font-size:.78rem;color:var(--df-text-3);"></span>
            </div>
          </div>
        </div>
      </div>

═══════════════════════════════════════════════════════════
PASUL 6 — Frontend section J: widget upload „Caiet sarcini"
═══════════════════════════════════════════════════════════

În public/refnec-form.html, în secțiunea J, în interiorul blocului
„rfn-j-bloc-existent" (data-j-situatie="EXISTA\_CAIET"). Locul cel mai
potrivit este la ÎNCEPUTUL blocului, înainte de „J1.1 Modalitatea utilizată"
ca să fie primul lucru pe care utilizatorul îl vede când selectează
„Există Caiet de sarcini".

Caută în secțiunea J (după linia \~903):

old\_str:
          <!-- ──────────── J1: există Caiet de sarcini ──────────── -->
          <div class="rfn-cond" id="rfn-j-bloc-existent" data-j-situatie="EXISTA\_CAIET">

            <!-- J1.1 Modalitatea utilizată pentru descrierea caracteristicilor -->
            <h4 style="margin:8px 0 8px;font-size:.92rem;color:var(--df-text);">1. Modalitatea de descriere a caracteristicilor</h4>

new\_str:
          <!-- ──────────── J1: există Caiet de sarcini ──────────── -->
          <div class="rfn-cond" id="rfn-j-bloc-existent" data-j-situatie="EXISTA\_CAIET">

            <!-- Atașament obligatoriu: Caiet de sarcini / Documentație descriptivă -->
            <div style="background:rgba(45,212,191,.05);border:1px solid rgba(45,212,191,.18);border-radius:10px;padding:14px 16px;margin-bottom:16px;">
              <div style="font-size:.88rem;color:var(--df-text);font-weight:600;margin-bottom:4px;">📎 Caiet de sarcini / Documentație descriptivă</div>
              <div style="font-size:.78rem;color:var(--df-text-3);margin-bottom:10px;line-height:1.5;">
                Atașați aici Caietul de sarcini elaborat și aprobat la nivel de compartiment (PDF, DOC(X), ZIP).
              </div>
              <div id="rfn-j-attachments-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;"></div>
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <input type="file" id="rfn-j-att-input" accept=".pdf,.zip,.rar,.doc,.docx,.xls,.xlsx" style="display:none;" onchange="rfnAttUpload('caiet\_sarcini', this)"/>
                <button type="button" class="df-action-btn" onclick="document.getElementById('rfn-j-att-input').click()">
                  <svg class="df-ic"><use href="/icons.svg?v=3.9.438#ico-paperclip"/></svg> Adaugă Caiet de sarcini
                </button>
                <span id="rfn-j-att-status" style="font-size:.78rem;color:var(--df-text-3);"></span>
              </div>
            </div>

            <!-- J1.1 Modalitatea utilizată pentru descrierea caracteristicilor -->
            <h4 style="margin:8px 0 8px;font-size:.92rem;color:var(--df-text);">1. Modalitatea de descriere a caracteristicilor</h4>

═══════════════════════════════════════════════════════════
PASUL 7 — Frontend: helper functions pentru attachments
═══════════════════════════════════════════════════════════

În public/refnec-form.html, ÎNAINTE de funcția rfnSave (deci după
funcția \_writeForm), adaugă întreg blocul de helper-uri:

ADAUGĂ ÎNAINTE de „// ── Salvare ──":

// ── Atașamente formular (Caiet sarcini sect J + Estimare valoare sect F) ──
const RFN\_ATT\_CATEGORIES = {
  'caiet\_sarcini':    { listId: 'rfn-j-attachments-list', statusId: 'rfn-j-att-status', inputId: 'rfn-j-att-input' },
  'estimare\_valoare': { listId: 'rfn-f-attachments-list', statusId: 'rfn-f-att-status', inputId: 'rfn-f-att-input' },
};

function \_rfnAttFmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024\*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024\*1024)).toFixed(1) + ' MB';
}

async function rfnAttUpload(category, fileInput) {
  if (!\_rfnId) {
    alert('Salvați referatul (click Salvează draft) înainte de a atașa documente.');
    fileInput.value = '';
    return;
  }
  const file = fileInput.files?.\[0];
  if (!file) return;
  const cfg = RFN\_ATT\_CATEGORIES\[category];
  const status = document.getElementById(cfg.statusId);
  if (file.size > 25 \* 1024 \* 1024) {
    if (status) status.textContent = '❌ Fișier prea mare (max 25 MB)';
    fileInput.value = '';
    return;
  }
  if (status) status.textContent = `⏳ Se încarcă ${file.name} (${\_rfnAttFmtSize(file.size)})...`;

  try {
    const dataB64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload  = () => res(fr.result.split(',')\[1]);
      fr.onerror = () => rej(new Error('Eroare citire fișier'));
      fr.readAsDataURL(file);
    });
    const r = await fetch(`/api/formulare-oficiale/${\_rfnId}/attachments`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        category: category,
        dataB64:  dataB64,
      }),
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) {
      if (status) status.textContent = '❌ ' + (j.message || j.error || `Eroare ${r.status}`);
      return;
    }
    if (status) status.textContent = '✅ Atașament salvat';
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    await rfnAttRefresh(category);
  } catch(e) {
    if (status) status.textContent = '❌ Eroare rețea: ' + (e.message || e);
  } finally {
    fileInput.value = '';
  }
}

async function rfnAttRefresh(category) {
  if (!\_rfnId) return;
  const cfg = RFN\_ATT\_CATEGORIES\[category];
  const list = document.getElementById(cfg.listId);
  if (!list) return;
  try {
    const r = await fetch(`/api/formulare-oficiale/${\_rfnId}/attachments?category=${encodeURIComponent(category)}`, {
      credentials: 'include',
    });
    if (!r.ok) {
      list.innerHTML = '';
      return;
    }
    const items = await r.json();
    if (!items.length) {
      list.innerHTML = '<div style="font-size:.78rem;color:var(--df-text-3);font-style:italic;">Niciun atașament încărcat.</div>';
      return;
    }
    list.innerHTML = items.map(a => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:6px;">
        <svg class="df-ic" style="flex-shrink:0;color:#7cf0e0;"><use href="/icons.svg?v=3.9.438#ico-file-text"/></svg>
        <div style="flex:1;min-width:0;">
          <div style="font-size:.85rem;color:var(--df-text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${\_escHtml(a.filename)}</div>
          <div style="font-size:.72rem;color:var(--df-text-3);">${\_rfnAttFmtSize(a.size\_bytes)} · ${new Date(a.uploaded\_at).toLocaleString('ro-RO')}</div>
        </div>
        <a href="/api/formulare-oficiale/${\_rfnId}/attachments/${a.id}" target="\_blank" class="df-action-btn sm" title="Descarcă">
          <svg class="df-ic"><use href="/icons.svg?v=3.9.438#ico-download"/></svg>
        </a>
        <button type="button" class="df-action-btn danger sm" onclick="rfnAttDelete('${a.id}','${category}')" title="Șterge">
          <svg class="df-ic"><use href="/icons.svg?v=3.9.438#ico-trash"/></svg>
        </button>
      </div>
    `).join('');
  } catch(e) {
    list.innerHTML = `<div style="font-size:.78rem;color:#ffaaaa;">Eroare la încărcare lista: ${\_escHtml(e.message)}</div>`;
  }
}

async function rfnAttDelete(attId, category) {
  if (!\_rfnId) return;
  if (!confirm('Ștergeți acest atașament? Acțiunea este reversibilă (soft-delete) dar fișierul nu va mai apărea în listă.')) return;
  try {
    const r = await fetch(`/api/formulare-oficiale/${\_rfnId}/attachments/${attId}`, {
      method: 'DELETE', credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrf() },
    });
    if (!r.ok) { alert('Eroare la ștergere'); return; }
    await rfnAttRefresh(category);
  } catch(e) {
    alert('Eroare rețea: ' + (e.message || e));
  }
}

function rfnAttRefreshAll() {
  if (!\_rfnId) return;
  Object.keys(RFN\_ATT\_CATEGORIES).forEach(cat => rfnAttRefresh(cat));
}

function \_escHtml(s) {
  return String(s||'').replace(/\[\&<>"']/g, c => ({'\&':'\&amp;','<':'\&lt;','>':'\&gt;','"':'\&quot;',"'":'\&#39;'}\[c]));
}

// Expune global pentru handlere onclick din HTML
window.rfnAttUpload     = rfnAttUpload;
window.rfnAttDelete     = rfnAttDelete;
window.rfnAttRefresh    = rfnAttRefresh;
window.rfnAttRefreshAll = rfnAttRefreshAll;

═══════════════════════════════════════════════════════════
PASUL 8 — Frontend: încărcare auto attachments la deschidere form
═══════════════════════════════════════════════════════════

Trebuie să apelăm rfnAttRefreshAll() după ce formularul este încărcat
(\_writeForm a rulat și \_rfnId este setat).

Caută în refnec-form.html funcția care se rulează la load. Probabil
există un bloc cu URL params id sau init() function:

  grep -n "URLSearchParams\\|window.addEventListener.\*DOMContentLoaded\\|init()\\|\_rfnId =" public/refnec-form.html | head -10

Identifică LOCUL în init/load handler unde se setează \_rfnId și se
apelează \_writeForm(data). IMEDIAT DUPĂ acel apel \_writeForm, adaugă:

  // Încarcă lista de atașamente după ce form-ul e populat
  if (typeof rfnAttRefreshAll === 'function') rfnAttRefreshAll();

NOTĂ: dacă nu găsești locul exact, adaugă și un fallback safety:
la finalul funcției \_writeForm(data) adaugă:
  if (typeof rfnAttRefreshAll === 'function') rfnAttRefreshAll();

═══════════════════════════════════════════════════════════
PASUL 9 — Cache busting (3.9.439 → 3.9.440, SW v155 → v156)
═══════════════════════════════════════════════════════════

9.1 — package.json:
  old\_str:   "version": "3.9.439",
  new\_str:   "version": "3.9.440",

9.2 — public/sw.js:
  old\_str: const CACHE\_VERSION = 'docflowai-v155';
  new\_str: const CACHE\_VERSION = 'docflowai-v156';

9.3 — public/admin.html:
  sed -i 's/v=3\\.9\\.439/v=3.9.440/g' public/admin.html

9.4 — public/refnec-form.html (icon-urile vechi referă v=3.9.407, dar
       am adăugat referințe noi cu v=3.9.440):
  sed -i 's/v=3\\.9\\.407/v=3.9.440/g' public/refnec-form.html

9.5 — public/sw.js: dacă /refnec-form.html este în PRECACHE\_ASSETS,
       e deja invalidat prin CACHE\_VERSION bump. Verifică:
  grep "refnec-form" public/sw.js

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Backend body limit aplicat:
   grep -c "/formulare-oficiale" server/index.mjs
   → ≥ 1 (în \_LARGE\_PDF\_PATHS)

2. Migrarea există:
   grep -A 2 "068\_formular\_attachments" server/db/index.mjs | head -5

3. 4 endpoint-uri attachment:
   grep -c "router\\.\\(post\\|get\\|delete\\).\*'/:id/attachments" server/routes/formulare-oficiale.mjs
   → 4

4. Frontend rfnSave are timeout:
   grep -c "AbortController\\|ctrl.abort" public/refnec-form.html
   → ≥ 2

5. Widget-uri în formular:
   grep -c 'id="rfn-f-attachments-list"\\|id="rfn-j-attachments-list"' public/refnec-form.html
   → 2

6. Helper functions:
   grep -c "function rfnAttUpload\\|function rfnAttRefresh\\|function rfnAttDelete" public/refnec-form.html
   → 3

7. Window exports:
   grep -c "window.rfnAttUpload\\|window.rfnAttDelete\\|window.rfnAttRefresh" public/refnec-form.html
   → 3

8. Cache busting:
   grep -c "v=3.9.438" public/refnec-form.html
   → ≥ 5 (Salvează draft + ico-paperclip x2 + ico-file-text + ico-download + ico-trash)
   grep -c "v=3.9.407" public/refnec-form.html
   → 0

9. Sintaxă:
   node --check public/sw.js
   npm run check

10. TESTE:
    npm test
    ATENȚIE: testele de integrare pe formulare-oficiale nu sunt
    afectate (endpoint-urile existente neatinse). Dacă există un
    test care verifică EXACT lista de routes pe acest router, va
    trebui actualizat să includă noile 4 routes.

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/index.mjs \\
        server/db/index.mjs \\
        server/routes/formulare-oficiale.mjs \\
        public/refnec-form.html \\
        public/sw.js \\
        package.json

git commit -m "fix(refnec): salvare blocata + atasamente Caiet sarcini si Estimare valoare (v3.9.438)

P1 (BUG) — Salvare RN blocata la 'Se salveaza...'
  Cauza: middleware adaptiv body limit 1MB pentru paths ne-PDF.
  POST/PUT /api/formulare-oficiale lipsea din \_LARGE\_PDF\_PATHS →
  payloads >1MB respinse cu 413 inainte de route handler. Pe Railway
  cu HTTP/2, raspunsul nu ajungea corect la browser → fetch atarna.
  Fix: adaugat /formulare-oficiale in \_LARGE\_PDF\_PATHS (limita 50MB).
  Defensive: timeout explicit 60s + AbortController in rfnSave +
  mesaje de eroare specifice pe coduri 401/403/413/altele.

P2 (FEATURE) — Atasament Caiet de sarcini la Sectiunea J
  In blocul EXISTA\_CAIET adaugat widget upload PDF/DOC/DOCX/XLS/ZIP/RAR
  cu listare + download + soft-delete.

P3 (FEATURE) — Atasament demonstrare estimare valoare la Sectiunea F
  La final-ul accordionului F, widget upload pentru devize/oferte/
  studii de piata care demonstreaza modul de estimare a valorii.

Migrare 068 — formular\_attachments (BYTEA, max 25MB/fisier, soft-delete,
category enum: caiet\_sarcini/estimare\_valoare/altele).

4 endpoint-uri noi: POST/GET/GET-download/DELETE pe
/api/formulare-oficiale/:id/attachments cu org\_id verification +
CSRF pe POST/DELETE + auth pe toate.

Cache: package 3.9.437 -> 3.9.438, SW v153 -> v154.
ico-uri din refnec-form.html bump-ate de la v=3.9.407 (stale)
la v=3.9.438."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging)
═══════════════════════════════════════════════════════════

1. Verifică migrarea s-a aplicat:
   railway run psql $DATABASE\_URL -c "SELECT id FROM migrations WHERE id='068\_formular\_attachments'"
   → o linie returnată

2. Hard refresh /refnec-form.html?id=X (sau form nou)
   → Sect F: vezi „📎 Documente justificative — modul de estimare"
     cu buton „Adaugă atașament"
   → Sect J → bifează „Există Caiet de sarcini" → vezi căsuța verde
     cu „📎 Caiet de sarcini" și buton „Adaugă Caiet de sarcini"

3. Încearcă upload ÎNAINTE de prima salvare:
   → Click „Adaugă Caiet de sarcini" cu form nou (fără ID) →
     alert: „Salvați referatul (click Salvează draft) înainte..."

4. Salvează draft → upload Caiet sarcini PDF de \~2MB:
   → Status: „⏳ Se încarcă..." apoi „✅ Atașament salvat"
   → Apare în listă cu nume + dimensiune + dată + butoane Download + Șterge

5. Test salvare „grea" (verifică P1 fix):
   → Completează TOATE secțiunile cu paragrafe lungi (300+ cuvinte
     în fiecare textarea principală)
   → Click Salvează → ar trebui să meargă fără să atârne (era 1MB
     limit înainte; acum 50MB)

6. Test timeout (verifică P1 fallback):
   → DevTools → Network → throttle „Slow 3G"
   → Click Salvează → după 60s vezi mesaj „Salvarea a depășit
     60 de secunde..." (nu rămâne stuck la infinit)

7. Test categorie wrong:
   → DevTools → tries POST cu category='invalid'
   → Răspuns 400 cu „invalid\_category"

8. Test cross-org:
   → Creează un user în alt org
   → Încearcă să descarci attachment-ul cu URL hardcoded
   → Răspuns 404 „formular\_not\_found"

STOP dacă:
- Migrarea eșuează → verifică log Railway pentru cauza (probabil
  formulare\_oficiale referă users.id care nu există în schema curentă;
  dar e improbabil)
- Upload eșuează cu „413 too\_large" pe fișiere <25MB → verifică că
  /api/formulare-oficiale ajunge la \_LARGE\_PDF\_PATHS check (path-ul
  exact rendat în Express poate diferi de cel din browser)
- Salvarea încă blochează → check Railway logs pentru request-ul
  /api/formulare-oficiale; posibil conexiunea PostgreSQL pool epuizată
```

