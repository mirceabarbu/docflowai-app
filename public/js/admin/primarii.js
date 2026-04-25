// public/js/admin/primarii.js
// DocFlowAI — Modul Primării/Instituții publice (Admin) — BLOC 1.7 v2.
// Toate funcțiile prefixate pr* — gestionează lista de primării pentru import outreach.
//
// Cross-zone reads (din window):
//   - window._orCurrentCampaignId : citit din outreach.js (BLOC 1.6)
//   - window.orLoadDetail         : apelată după prAddSelected (din outreach.js)
//   - window.orLoadCampaigns      : apelată după prAddSelected (din outreach.js)
//
// Local state:
//   - _prPage, _prSelected, _prDebounce

(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;
  const downloadBlob = window.df.downloadBlob;

  // ── Local state ───────────────────────────────────────────────────────────
  let _prPage     = 1;
  let _prSelected = new Set();
  let _prDebounce = null;

  // ── Functions ─────────────────────────────────────────────────────────────

  function prDebouncedLoad() {
    clearTimeout(_prDebounce);
    _prDebounce = setTimeout(() => prLoad(1), 280);
  }

  async function prLoad(page) {
    _prPage = page || 1;
    _prSelected.clear();
    const judet = $('pr-judet')?.value || '';
    const q     = $('pr-q')?.value || '';
    const url   = `/admin/outreach/primarii?judet=${encodeURIComponent(judet)}&q=${encodeURIComponent(q)}&page=${_prPage}&limit=50`;
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();

      // Populăm dropdown județe la prima încărcare
      const judetSel = $('pr-judet');
      if (judetSel && judetSel.options.length <= 1 && d.judete?.length) {
        d.judete.forEach(j => {
          const opt = document.createElement('option');
          opt.value = j; opt.textContent = j;
          if (j === judet) opt.selected = true;
          judetSel.appendChild(opt);
        });
      }

      $('pr-badge').textContent = `${d.total.toLocaleString('ro-RO')} instituții`;
      $('pr-info').textContent  = `Pagina ${d.page} din ${d.pages} · ${d.total} rezultate`;

      const tbody = $('pr-tbody');
      tbody.innerHTML = d.items.length ? d.items.map(p => `
        <tr style="border-bottom:1px solid rgba(255,255,255,.04);">
          <td style="padding:5px 8px;text-align:center;">
            <input type="checkbox" data-id="${p.id}" data-email="${esc(p.email)}" data-inst="${esc(p.institutie)}"
              onchange="prToggle(${p.id})"
              style="cursor:pointer;accent-color:var(--accent2);" />
          </td>
          <td style="padding:5px 8px;color:var(--text);">${esc(p.institutie)}</td>
          <td style="padding:5px 8px;color:var(--muted);">
            ${esc(p.email)}
            ${p.unsubscribed ? '<span title="Dezabonat GDPR" style="margin-left:5px;font-size:.7rem;background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.25);border-radius:4px;color:#ffaaaa;padding:1px 5px;">🚫 dezabonat</span>' : ''}
          </td>
          <td style="padding:5px 8px;color:var(--muted);">${esc(p.judet)}</td>
          <td style="padding:5px 8px;text-align:right;white-space:nowrap;">
            <button onclick="prEditRow(${p.id},'${esc(p.institutie)}','${esc(p.email)}','${esc(p.judet)}','${esc(p.localitate||p.institutie)}')"
              style="padding:3px 9px;font-size:.73rem;background:rgba(157,176,255,.12);border:1px solid rgba(157,176,255,.25);border-radius:6px;color:#9db0ff;cursor:pointer;margin-right:4px;" title="Editează">✏️</button>
            <button onclick="prDeleteRow(${p.id},'${esc(p.institutie)}')"
              style="padding:3px 9px;font-size:.73rem;background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.25);border-radius:6px;color:#ffaaaa;cursor:pointer;" title="Dezactivează">🗑</button>
          </td>
        </tr>`).join('') :
        '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--muted);">Niciun rezultat.</td></tr>';

      // Paginare
      const pager = $('pr-pager');
      if (d.pages <= 1) { pager.innerHTML = ''; return; }
      const btnStyle = (active) =>
        `padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.12);cursor:pointer;font-size:.8rem;font-weight:${active?700:400};background:${active?'rgba(124,92,255,.3)':'rgba(255,255,255,.04)'};color:${active?'#c4b5ff':'var(--muted)'};`;
      let btns = '';
      if (d.page > 1)     btns += `<button onclick="prLoad(${d.page-1})" style="${btnStyle(false)}">‹ Precedent</button>`;
      const start = Math.max(1, d.page-2), end = Math.min(d.pages, d.page+2);
      for (let i = start; i <= end; i++) btns += `<button onclick="prLoad(${i})" style="${btnStyle(i===d.page)}">${i}</button>`;
      if (d.page < d.pages) btns += `<button onclick="prLoad(${d.page+1})" style="${btnStyle(false)}">Următor ›</button>`;
      btns += `<span style="color:var(--muted);font-size:.76rem;align-self:center;">${d.pages} pagini</span>`;
      pager.innerHTML = btns;

    } catch(e) { /* silent */ }
  }

  function prToggle(id) {
    if (_prSelected.has(id)) _prSelected.delete(id);
    else _prSelected.add(id);
  }

  function prSelectAll() {
    document.querySelectorAll('#pr-tbody input[type=checkbox]').forEach(cb => {
      cb.checked = true;
      _prSelected.add(parseInt(cb.dataset.id));
    });
  }

  function prDeselectAll() {
    document.querySelectorAll('#pr-tbody input[type=checkbox]').forEach(cb => {
      cb.checked = false;
    });
    _prSelected.clear();
  }

  async function prRefreshCampaignSelect() {
    try {
      const r = await fetch('/admin/outreach/campaigns', { credentials: 'include' });
      const d = await r.json();
      const sel = $('pr-target-campaign');
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = '<option value="">— selectează campanie —</option>';
      (d.campaigns || []).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `[${c.id}] ${c.name}`;
        if (String(c.id) === String(prev)) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch(e) { /* silent */ }
  }

  async function prAddSelected() {
    const campaignId = $('pr-target-campaign')?.value;
    const st = $('pr-add-status');
    if (!campaignId) { st.textContent = '⚠ Selectează o campanie.'; st.style.color='#ffaaaa'; return; }
    if (!_prSelected.size) { st.textContent = '⚠ Selectează cel puțin o localitate.'; st.style.color='#ffaaaa'; return; }

    // Culegem datele din checkbox-urile vizibile
    const recipients = [];
    document.querySelectorAll('#pr-tbody input[type=checkbox]').forEach(cb => {
      if (_prSelected.has(parseInt(cb.dataset.id))) {
        recipients.push({ email: cb.dataset.email, institutie: cb.dataset.inst });
      }
    });

    if (!recipients.length) { st.textContent = '⚠ Schimbă pagina și reselctează.'; st.style.color='#ffd580'; return; }

    const btn = $('pr-btn-add');
    btn.disabled = true; st.textContent = `⏳ Se adaugă ${recipients.length}...`; st.style.color='var(--muted)';
    try {
      const r = await fetch(`/admin/outreach/campaigns/${campaignId}/recipients`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      st.textContent = `✅ ${d.added} adăugate${d.skipped ? `, ${d.skipped} existau deja` : ''}.`;
      st.style.color = '#a3e6a3';
      prDeselectAll();
      // Dacă e campania curentă deschisă în panou, refresh
      if (window._orCurrentCampaignId && String(window._orCurrentCampaignId) === String(campaignId)) {
        await window.orLoadDetail(window._orCurrentCampaignId);
      }
      await window.orLoadCampaigns();
    } catch(e) {
      st.textContent = '⚠ ' + e.message; st.style.color='#ffaaaa';
    } finally {
      btn.disabled = false;
    }
  }

  // ── CRUD Instituții ──────────────────────────────────────────────────────

  function prShowAddModal() {
    $('pr-edit-id').value = '';
    $('pr-f-institutie').value = '';
    $('pr-f-email').value = '';
    $('pr-f-judet').value = '';
    $('pr-f-localitate').value = '';
    $('pr-modal-msg').textContent = '';
    $('pr-add-modal').style.display = 'flex';
    setTimeout(() => $('pr-f-institutie').focus(), 50);
  }

  function prCloseAddModal() { $('pr-add-modal').style.display = 'none'; }

  function prEditRow(id, institutie, email, judet, localitate) {
    $('pr-edit-id').value = id;
    $('pr-f-institutie').value = institutie;
    $('pr-f-email').value = email;
    $('pr-f-judet').value = judet;
    $('pr-f-localitate').value = localitate;
    $('pr-modal-msg').textContent = '';
    $('pr-add-modal').style.display = 'flex';
    setTimeout(() => $('pr-f-institutie').focus(), 50);
  }

  async function prSaveInstitutie() {
    const id   = $('pr-edit-id').value;
    const body = {
      institutie: $('pr-f-institutie').value.trim(),
      email:      $('pr-f-email').value.trim().toLowerCase(),
      judet:      $('pr-f-judet').value.trim(),
      localitate: $('pr-f-localitate').value.trim(),
    };
    const msgEl = $('pr-modal-msg');
    if (!body.institutie) { msgEl.textContent = '⚠ Completează instituția.'; msgEl.style.color = '#ffaaaa'; return; }
    if (!body.email || !body.email.includes('@')) { msgEl.textContent = '⚠ Email invalid.'; msgEl.style.color = '#ffaaaa'; return; }

    try {
      const url    = id ? `/admin/outreach/primarii/${id}` : '/admin/outreach/primarii';
      const method = id ? 'PUT' : 'POST';
      const r = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { msgEl.textContent = '⚠ ' + (d.message || d.error); msgEl.style.color = '#ffaaaa'; return; }
      prCloseAddModal();
      prLoad(_prPage);
    } catch(e) { msgEl.textContent = '⚠ Eroare rețea.'; msgEl.style.color = '#ffaaaa'; }
  }

  async function prDeleteRow(id, institutie) {
    if (!confirm(`Dezactivează "${institutie}"?\n\nInstituția nu va mai apărea în listă dar nu se șterge definitiv.`)) return;
    try {
      const r = await fetch(`/admin/outreach/primarii/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) { alert('Eroare la dezactivare.'); return; }
      prLoad(_prPage);
    } catch(e) { alert('Eroare rețea.'); }
  }

  function prShowImportModal() {
    $('pr-import-data').value = '';
    $('pr-import-msg').textContent = '';
    $('pr-import-replace').checked = false;
    $('pr-import-modal').style.display = 'flex';
  }

  function prCloseImportModal() { $('pr-import-modal').style.display = 'none'; }

  function prShowExportModal() {
    document.getElementById('pr-export-msg').textContent = '';
    // Populează dropdown județe din cele deja încărcate de prLoad
    const mainJudet = document.getElementById('pr-judet');
    const exportJudet = document.getElementById('pr-export-judet');
    if (mainJudet && exportJudet) {
      exportJudet.innerHTML = '<option value="">— Toate județele —</option>';
      [...mainJudet.options].forEach(opt => {
        if (opt.value) {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.textContent;
          exportJudet.appendChild(o);
        }
      });
    }
    document.getElementById('pr-export-modal').classList.add('dfem-open');
  }

  function prCloseExportModal() {
    document.getElementById('pr-export-modal').classList.remove('dfem-open');
  }

  async function prDoExport() {
    const format = document.getElementById('pr-export-format').value;
    const activ  = document.getElementById('pr-export-activ').value;
    const judet  = document.getElementById('pr-export-judet').value;
    const msgEl  = document.getElementById('pr-export-msg');

    msgEl.textContent = '⏳ Se generează fișierul...';
    msgEl.className = 'dfem-msg';

    const params = new URLSearchParams();
    params.set('format', format);
    if (activ !== 'all') params.set('activ', activ);
    if (judet) params.set('judet', judet);

    try {
      const r = await fetch(`/admin/outreach/primarii/export?${params.toString()}`, {
        credentials: 'include',
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        msgEl.textContent = '⚠ ' + (d.message || d.error || `Eroare ${r.status}`);
        msgEl.className = 'dfem-msg dfem-msg-err';
        return;
      }
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^"]+)"?/);
      const filename = m ? m[1] : `outreach-primarii.${format}`;

      const blob = await r.blob();
      downloadBlob(blob, filename);

      msgEl.textContent = `✓ Descărcat: ${filename}`;
      msgEl.className = 'dfem-msg dfem-msg-ok';
      setTimeout(prCloseExportModal, 1400);
    } catch (e) {
      msgEl.textContent = '⚠ Eroare de rețea.';
      msgEl.className = 'dfem-msg dfem-msg-err';
    }
  }

  function prImportFileChange() {
    const file = $('pr-import-file').files?.[0];
    if (!file) return;
    const nameEl = document.getElementById('pr-import-file-name');
    if (nameEl) nameEl.textContent = file.name;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'json') $('pr-import-format').value = 'json';
    else if (ext === 'csv' || ext === 'txt') $('pr-import-format').value = 'csv';
    const reader = new FileReader();
    reader.onload = e => { $('pr-import-data').value = e.target.result; };
    reader.readAsText(file, 'UTF-8');
  }

  async function prDoImport() {
    const data    = $('pr-import-data').value.trim();
    const format  = $('pr-import-format').value;
    const replace = $('pr-import-replace').checked;
    const msgEl   = $('pr-import-msg');
    if (!data) { msgEl.textContent = '⚠ Paste date sau încarcă fișier.'; msgEl.style.color = '#ffaaaa'; return; }
    if (replace && !confirm('Atenție: Această acțiune va șterge TOATE instituțiile existente și le va înlocui cu cele din fișier. Continui?')) return;

    msgEl.textContent = '⏳ Se importă...'; msgEl.style.color = 'var(--muted)';
    try {
      const r = await fetch('/admin/outreach/primarii/import', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, data, replace }),
      });
      const d = await r.json();
      if (!r.ok) { msgEl.textContent = '⚠ ' + (d.message || d.error); msgEl.style.color = '#ffaaaa'; return; }
      msgEl.textContent = `✅ ${d.added} adăugate / actualizate${d.skipped ? `, ${d.skipped} erori` : ''} din ${d.total} rânduri.`;
      msgEl.style.color = '#a3e6a3';
      // Resetăm dropdown județe (se va repopula la prLoad)
      const judetSel = $('pr-judet');
      while (judetSel.options.length > 1) judetSel.remove(1);
      setTimeout(() => { prCloseImportModal(); prLoad(1); }, 1800);
    } catch(e) { msgEl.textContent = '⚠ Eroare rețea.'; msgEl.style.color = '#ffaaaa'; }
  }

  // ── Export onclick + cross-module global ──────────────────────────────────
  window.prDebouncedLoad         = prDebouncedLoad;
  window.prLoad                  = prLoad;
  window.prToggle                = prToggle;
  window.prSelectAll             = prSelectAll;
  window.prDeselectAll           = prDeselectAll;
  window.prRefreshCampaignSelect = prRefreshCampaignSelect;
  window.prAddSelected           = prAddSelected;
  window.prShowAddModal          = prShowAddModal;
  window.prCloseAddModal         = prCloseAddModal;
  window.prEditRow               = prEditRow;
  window.prSaveInstitutie        = prSaveInstitutie;
  window.prDeleteRow             = prDeleteRow;
  window.prShowImportModal       = prShowImportModal;
  window.prCloseImportModal      = prCloseImportModal;
  window.prImportFileChange      = prImportFileChange;
  window.prDoImport              = prDoImport;
  window.prShowExportModal       = prShowExportModal;
  window.prCloseExportModal      = prCloseExportModal;
  window.prDoExport              = prDoExport;

  window.df = window.df || {};
  window.df._primariiModuleLoaded = true;
})();
