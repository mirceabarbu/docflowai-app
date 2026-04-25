(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;

  let _archiveInstData = null;
  let _archiveFlowIds = [];
  let _archiveJobPollTimer = null;
  let _pendingDeleteBody = null;
  let _pendingDeleteMsgEl = null;

  async function verifyDriveConn() {
    const msg = document.getElementById("archiveMsg");
    msg.textContent = "⏳ Verificare conexiune Drive...";
    try {
      const r = await _apiFetch("/admin/drive/verify", {headers: hdrs()});
      const j = await r.json();
      if (j.ok) msg.innerHTML = `✅ Conexiune OK — folder: <strong>${esc(j.folder||"")}</strong>`;
      else msg.innerHTML = `❌ Eroare: ${esc(j.error||"")}`;
    } catch(e) { msg.textContent = "❌ Eroare: " + e.message; }
  }

  async function loadArchiveInstData() {
    if (_archiveInstData) return;
    if (!window._allFlows) {
      const r = await _apiFetch("/admin/flows/list?limit=500", {headers: hdrs()});
      const resp = await r.json();
      window._allFlows = Array.isArray(resp) ? resp : (resp.flows || []);
    }
    const map = {};
    window._allFlows.forEach(f => {
      const inst = f.institutie||"";
      const dept = f.compartiment||"";
      if (!inst) return;
      if (!map[inst]) map[inst] = new Set();
      if (dept) map[inst].add(dept);
    });
    _archiveInstData = map;
    // Populează instituții arhivare
    const s = document.getElementById("archiveInstFilter");
    const cur = s.value;
    s.innerHTML = '<option value="">Toate instituțiile</option>';
    Object.keys(map).sort().forEach(inst => {
      const o = document.createElement("option"); o.value = inst; o.textContent = inst; s.appendChild(o);
    });
    if (cur) s.value = cur;
    if (window._orgAdminInstitutie) {
      let found=false; for(const o of s.options){if(o.value===window._orgAdminInstitutie){found=true;break;}}
      if(!found){const o=new Option(window._orgAdminInstitutie,window._orgAdminInstitutie);s.appendChild(o);}
      s.value=window._orgAdminInstitutie; s.disabled=true;
      s.style.cssText+=';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;';
      onArchiveInstChange();
    }
    // Populează instituții ștergere
    const s2 = document.getElementById("delInstFilter");
    const cur2 = s2.value;
    s2.innerHTML = '<option value="">Toate instituțiile</option>';
    Object.keys(map).sort().forEach(inst => {
      const o = document.createElement("option"); o.value = inst; o.textContent = inst; s2.appendChild(o);
    });
    if (cur2) s2.value = cur2;
    if (window._orgAdminInstitutie) {
      let found=false; for(const o of s2.options){if(o.value===window._orgAdminInstitutie){found=true;break;}}
      if(!found){const o=new Option(window._orgAdminInstitutie,window._orgAdminInstitutie);s2.appendChild(o);}
      s2.value=window._orgAdminInstitutie; s2.disabled=true;
      s2.style.background='rgba(45,212,191,.08)';s2.style.borderColor='rgba(45,212,191,.3)';s2.style.color='#2dd4bf';s2.style.cursor='not-allowed';
    }
    // Populează instituții ștergere totală
    const s3 = document.getElementById("allInstFilter");
    const cur3 = s3.value;
    s3.innerHTML = '<option value="">Toate instituțiile</option>';
    Object.keys(map).sort().forEach(inst => {
      const o = document.createElement("option"); o.value = inst; o.textContent = inst; s3.appendChild(o);
    });
    if (cur3) s3.value = cur3;
  }

  function _populateDeptFilter(instVal, deptSelId) {
    const deptSel = document.getElementById(deptSelId);
    deptSel.innerHTML = '<option value="">Toate compartimentele</option>';
    if (instVal && _archiveInstData && _archiveInstData[instVal]) {
      const depts = [..._archiveInstData[instVal]].sort();
      depts.forEach(d => { const o = document.createElement("option"); o.value = d; o.textContent = d; deptSel.appendChild(o); });
      deptSel.disabled = depts.length === 0;
    } else { deptSel.disabled = true; }
  }

  function onArchiveInstChange() {
    _populateDeptFilter(document.getElementById("archiveInstFilter").value, "archiveDeptFilter");
  }
  function onDelInstChange() {
    _populateDeptFilter(document.getElementById("delInstFilter").value, "delDeptFilter");
  }

  async function previewArchive() {
    const days = document.getElementById("archiveDays").value || 30;
    const inst = document.getElementById("archiveInstFilter").value;
    const dept = document.getElementById("archiveDeptFilter").value;
    const msg = document.getElementById("archiveMsg");
    const preview = document.getElementById("archivePreview");
    msg.textContent = "⏳ Se calculează...";
    preview.style.display = "none";
    await loadArchiveInstData();
    try {
      let url = `/admin/flows/archive-preview?days=${days}`;
      if (inst) url += `&institutie=${encodeURIComponent(inst)}`;
      if (dept) url += `&compartiment=${encodeURIComponent(dept)}`;
      const r = await _apiFetch(url, {headers: hdrs()});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error||"Eroare server");
      _archiveFlowIds = (j.flows||[]).map(f => f.flowId);
      const summary = document.getElementById("archivePreviewSummary");
      const list = document.getElementById("archivePreviewList");
      const filterLabel = inst ? ` · <span style="color:#9db0ff;">${esc(inst)}${dept?" / "+esc(dept):""}</span>` : "";
      summary.innerHTML = `<span style="color:#2dd4bf;">${esc(String(j.count||0))} fluxuri</span>${filterLabel} eligibile pentru arhivare — eliberează <span style="color:#ffd580;font-weight:700;">${esc(String(j.totalMB||0))} MB</span> din baza de date`;
      list.innerHTML = (j.flows||[]).map(f =>
        `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);">
          📄 ${esc(f.docName||'—')} &nbsp;·&nbsp; ${esc(f.status||'')} &nbsp;·&nbsp; ${new Date(f.createdAt).toLocaleDateString("ro-RO")} &nbsp;·&nbsp; ${f.sizeMB} MB
          ${f.institutie?`<span style="color:var(--muted);margin-left:6px;font-size:.75rem;">${esc(f.institutie)}${f.compartiment?' / '+esc(f.compartiment):''}</span>`:""}
          ${f.initName||f.initEmail?`<span style="color:#9db0ff;margin-left:6px;font-size:.75rem;" title="${esc(f.initEmail||'')}">👤 ${esc(f.initName||f.initEmail)}</span>`:""}
        </div>`
      ).join("") || "<div style='color:var(--muted)'>Niciun flux eligibil.</div>";
      preview.style.display = j.count > 0 ? "block" : "none";
      msg.textContent = j.count === 0 ? "✅ Niciun flux de arhivat pentru perioada selectată." : "";
    } catch(e) { msg.textContent = "❌ " + e.message; }
  }

  async function doArchive() {
    if (!_archiveFlowIds.length) return;
    const btn = document.getElementById("btnDoArchive");
    const msg = document.getElementById("archiveMsg");
    if (!confirm(`Arhivezi ${_archiveFlowIds.length} fluxuri în Google Drive?\n\nCe se întâmplă:\n✅ PDF-urile sunt copiate în Google Drive\n✅ Fluxurile rămân vizibile în platformă (cu link Drive)\n🗑️ PDF-urile (pdfB64 / signedPdfB64 / originalPdfB64) sunt șterse din baza de date PostgreSQL\n\nAcțiunea nu poate fi anulată.`)) return;
    btn.disabled = true;
    msg.textContent = "";
    let totalOk = 0, totalFail = 0, batchIndex = 0, failedFlows = [];
    try {
      while (true) {
        btn.textContent = `⏳ Se arhivează... (${Math.min((batchIndex+1)*10, _archiveFlowIds.length)}/${_archiveFlowIds.length})`;
        const r = await _apiFetch("/admin/flows/archive", {
          method: "POST", headers: hdrs(),
          body: JSON.stringify({flowIds: _archiveFlowIds, batchIndex})
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error||"Eroare server");
        const batchOk = (j.results||[]).filter(x=>x.ok);
        const batchFail = (j.results||[]).filter(x=>!x.ok);
        totalOk += batchOk.length;
        totalFail += batchFail.length;
        failedFlows.push(...batchFail);
        if (!j.hasMore) break;
        batchIndex++;
      }
      let html = `✅ Arhivate: <strong>${totalOk}</strong> fluxuri`;
      if (totalFail) {
        html += ` &nbsp;·&nbsp; ❌ Eșuate: <strong>${totalFail}</strong>`;
        html += `<div style="margin-top:8px;background:rgba(255,80,80,.08);border:1px solid rgba(255,80,80,.2);border-radius:8px;padding:10px;max-height:160px;overflow-y:auto;">`;
        html += failedFlows.map(f => `<div style="font-size:.78rem;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04);">
          <span style="color:#ffaaaa;font-weight:600;">${f.flowId}</span>
          <span style="color:var(--muted);margin-left:8px;">${esc(f.error||'eroare necunoscută')}</span>
        </div>`).join('');
        html += '</div>';
      }
      msg.innerHTML = html;
      document.getElementById("archivePreview").style.display = "none";
      _archiveFlowIds = [];
    } catch(e) { msg.textContent = "❌ " + e.message; }
    btn.disabled = false;
    btn.textContent = "📦 Arhivează în Drive și eliberează DB";
  }

  async function doArchiveAsync() {
    if (!_archiveFlowIds.length) return;
    const btn = document.getElementById("btnDoArchiveAsync");
    const btnSync = document.getElementById("btnDoArchive");
    const msg = document.getElementById("archiveMsg");
    if (!confirm(`Pornești un job de arhivare asincron pentru ${_archiveFlowIds.length} fluxuri?\n\nAvantaje față de arhivarea sincronă:\n✅ Nu blochează UI-ul\n✅ Poți naviga în alt tab în timp ce se procesează\n✅ Potrivit pentru volume mari (>50 fluxuri)\n\nJob-ul pornește în max 30 secunde și poți urmări progresul aici.`)) return;
    btn.disabled = true;
    btnSync.disabled = true;
    btn.textContent = "⏳ Creez job...";
    msg.textContent = "";
    try {
      const r = await _apiFetch("/admin/flows/archive-async", {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ flowIds: _archiveFlowIds })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Eroare server");
      msg.innerHTML = `🚀 Job creat: <strong>#${j.jobId}</strong> pentru ${j.flowCount} fluxuri. ${esc(j.message || 'Procesarea începe în fundal...')}`;
      btn.textContent = "⏳ În procesare...";
      pollArchiveJob(j.jobId);
    } catch (e) {
      msg.innerHTML = `❌ ${esc(e.message)}`;
      btn.disabled = false;
      btnSync.disabled = false;
      btn.textContent = "⚡ Async (fundal)";
    }
  }

  function pollArchiveJob(jobId) {
    clearTimeout(_archiveJobPollTimer);
    _archiveJobPollTimer = setTimeout(async () => {
      try {
        const r = await _apiFetch(`/admin/flows/archive-job/${jobId}`, { headers: hdrs() });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Eroare verificare job");
        const msg = document.getElementById("archiveMsg");
        const btn = document.getElementById("btnDoArchiveAsync");
        const btnSync = document.getElementById("btnDoArchive");
        const statusLabel = {
          pending: "⏸ În coadă",
          running: "⏳ Se procesează",
          done: "✅ Finalizat",
          error: "❌ Eroare",
        }[j.status] || j.status;
        if (j.done) {
          let html = `Job #${j.jobId} — ${statusLabel}<br>Fluxuri: ${j.flowCount}`;
          if (j.status === 'done' && j.result) {
            const ok = j.result.ok || 0;
            const fail = j.result.failed || 0;
            html += `<br>✅ Arhivate: <strong>${ok}</strong>`;
            if (fail) html += ` · ❌ Eșuate: <strong>${fail}</strong>`;
          }
          if (j.error) html += `<br>Eroare: ${esc(j.error)}`;
          msg.innerHTML = html;
          btn.disabled = false;
          btnSync.disabled = false;
          btn.textContent = "⚡ Async (fundal)";
          _archiveFlowIds = [];
          document.getElementById("archivePreview").style.display = "none";
        } else {
          msg.innerHTML = `${statusLabel} — Job #${j.jobId} (${j.flowCount} fluxuri). Actualizare auto la fiecare 3s...`;
          pollArchiveJob(jobId);
        }
      } catch (e) {
        const msg = document.getElementById("archiveMsg");
        if (msg) msg.innerHTML = `❌ Polling oprit: ${esc(e.message)}`;
        const btn = document.getElementById("btnDoArchiveAsync");
        const btnSync = document.getElementById("btnDoArchive");
        if (btn) { btn.disabled = false; btn.textContent = "⚡ Async (fundal)"; }
        if (btnSync) btnSync.disabled = false;
      }
    }, 3000);
  }

  async function runVacuum() {
    const msg = document.getElementById("msgVacuum");
    msg.textContent = "⏳ Se execută VACUUM ANALYZE...";
    try {
      const r = await _apiFetch("/admin/db/vacuum", {method:"POST", headers:hdrs()});
      const j = await r.json();
      if (j.ok) msg.innerHTML = `✅ VACUUM complet. Dimensiune DB: <strong>${esc(j.dbSize||"")}</strong>`;
      else msg.textContent = "❌ " + (j.error||"Eroare");
    } catch(e) { msg.textContent = "❌ " + e.message; }
  }

  async function loadDbStats() {
    const el = document.getElementById("dbStats");
    const msg = document.getElementById("msgVacuum");
    try {
      const r = await _apiFetch("/admin/stats", {headers: hdrs()});
      const j = await r.json();
      if (!r.ok) { if(msg) msg.innerHTML = `❌ ${esc(j.error||'forbidden')}`; return; }
      const s = j.stats||{};
      el.style.display = "block";
      const dbSizeSpan = s.dbSize ? `<span style="color:#2dd4bf;font-weight:700;">💾 DB: ${esc(s.dbSize)}</span>` : '';
      el.innerHTML = `
        <span style="margin-right:16px;">📁 Fluxuri: <strong>${s.flows||0}</strong></span>
        <span style="margin-right:16px;">🗂 Arhivate: <strong>${s.flowsArchived||0}</strong></span>
        <span style="margin-right:16px;">👥 Utilizatori: <strong>${s.users||0}</strong></span>
        <span style="margin-right:16px;">🔔 Notificări necitite: <strong>${s.unreadNotifications||0}</strong></span>
        ${dbSizeSpan}
      `;
      if(msg) msg.textContent = "";
    } catch(e) { if(msg) msg.textContent = "❌ " + e.message; }
  }

  async function _loadCleanPreview(params) {
    const qs = new URLSearchParams(params).toString();
    const r = await _apiFetch(`/admin/flows/clean-preview?${qs}`, { headers: hdrs() });
    if (!r.ok) throw new Error((await r.json()).error || 'Eroare server');
    return r.json();
  }

  function _buildDeleteList(flows) {
    if (!flows.length) return '<div style="color:var(--muted);text-align:center;padding:12px;">Niciun flux găsit.</div>';
    const statusColors = { finalizat:'#2dd4bf', refuzat:'#ff5050', arhivat:'#9db0ff', revizuire:'#ffd580', anulat:'#888888', activ:'#b39dff' };
    return flows.map(f => {
      const col = statusColors[f.status] || '#aaa';
      const dt = new Date(f.createdAt).toLocaleDateString('ro-RO');
      const archived = f.storage === 'drive' ? '💾' : '⚠️';
      return `<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);display:grid;grid-template-columns:1fr 90px 60px 20px;gap:4px;align-items:center;">
        <span title="${esc(f.flowId)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.docName)}</span>
        <span style="font-size:.7rem;color:${col};">${f.status}</span>
        <span style="font-size:.7rem;color:var(--muted);">${dt}</span>
        <span title="${f.storage==='drive'?'Arhivat în Drive':'PDF în DB — se pierde!'}">${archived}</span>
      </div>`;
    }).join('');
  }

  async function previewCleanOld() {
    const days = parseInt($('delDays').value) || 30;
    const inst = $('delInstFilter').value;
    const dept = $('delDeptFilter').value;
    const msgEl = $('msgOldFlows');
    msgEl.innerHTML = '<span style="color:var(--muted);">⏳ Se verifică...</span>';
    try {
      const data = await _loadCleanPreview({ days, ...(inst?{institutie:inst}:{}), ...(dept?{compartiment:dept}:{}) });
      if (!data.count) { msgEl.innerHTML = '<span style="color:#7cf0e0;">✅ Niciun flux eligibil pentru ștergere.</span>'; return; }
      const filterDesc = inst ? ` din ${inst}${dept?' / '+dept:''}` : '';
      _showDeleteModal({
        title: `🗑 Șterge ${data.count} flux(uri) mai vechi de ${days} zile${filterDesc}`,
        desc: `Se vor șterge <strong style="color:#ffaaaa;">${data.count} fluxuri</strong> (${data.totalMB} MB eliberat).
          <br><br><span style="color:rgba(255,170,100,.9);">⚠️ Fluxurile <strong>nearkhivate în Drive</strong> (marcate cu ⚠️) vor pierde PDF-urile definitiv.</span>`,
        flows: data.flows,
        deleteBody: { olderThanDays: days, ...(inst?{institutie:inst}:{}), ...(dept?{compartiment:dept}:{}) },
        msgEl,
      });
    } catch(e) { msgEl.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`; }
  }

  async function previewCleanAll() {
    const inst = $('allInstFilter').value;
    const dept = $('allDeptFilter').value;
    const msgEl = $('msgAllFlows');
    msgEl.innerHTML = '<span style="color:var(--muted);">⏳ Se verifică...</span>';
    try {
      const data = await _loadCleanPreview({ all: 'true', ...(inst?{institutie:inst}:{}), ...(dept?{compartiment:dept}:{}) });
      if (!data.count) { msgEl.innerHTML = '<span style="color:#7cf0e0;">✅ Niciun flux în baza de date.</span>'; return; }
      const filterDesc = inst ? ` din ${inst}${dept?' / '+dept:''}` : '';
      _showDeleteModal({
        title: `💣 Șterge TOATE fluxurile${filterDesc} (${data.count})`,
        desc: `Se vor șterge <strong style="color:#ffaaaa;">TOATE cele ${data.count} fluxuri${filterDesc}</strong> (${data.totalMB} MB).
          <br><br><span style="color:rgba(255,80,80,.9);">🔴 Acțiune ireversibilă — PDF-urile nearkhivate se pierd definitiv!</span>`,
        flows: data.flows,
        deleteBody: { all: true, confirmToken: 'DELETE_ALL_FLOWS', ...(inst?{institutie:inst}:{}), ...(dept?{compartiment:dept}:{}) },
        msgEl,
      });
    } catch(e) { msgEl.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`; }
  }

  function _showDeleteModal({ title, desc, flows, deleteBody, msgEl }) {
    _pendingDeleteBody = deleteBody;
    _pendingDeleteMsgEl = msgEl;
    $('delModalTitle').innerHTML = title;
    $('delModalDesc').innerHTML = desc;
    $('delModalList').innerHTML = _buildDeleteList(flows);
    $('delConfirmInput').value = '';
    $('btnFinalDelete').disabled = true;
    $('btnFinalDelete').style.opacity = '.5';
    const modal = $('deleteConfirmModal');
    modal.style.display = 'flex';
  }

  function closeDeleteModal() {
    $('deleteConfirmModal').style.display = 'none';
    _pendingDeleteBody = null;
    _pendingDeleteMsgEl = null;
  }

  document.addEventListener('input', e => {
    if (e.target.id === 'delConfirmInput') {
      const ok = e.target.value.trim() === 'STERGE';
      $('btnFinalDelete').disabled = !ok;
      $('btnFinalDelete').style.opacity = ok ? '1' : '.5';
    }
  });

  async function executePendingDelete() {
    if (!_pendingDeleteBody) return;
    const btn = $('btnFinalDelete');
    const msgEl = _pendingDeleteMsgEl;
    btn.disabled = true;
    btn.textContent = '⏳ Se șterge...';
    try {
      const r = await _apiFetch('/admin/flows/clean', { method: 'POST', headers: hdrs(), body: JSON.stringify(_pendingDeleteBody) });
      const d = await r.json();
      closeDeleteModal();
      if (r.ok) {
        if (msgEl) msgEl.innerHTML = `<span style="color:#7cf0e0;">✅ ${d.deleted} flux(uri) șterse.</span>`;
        loadFlows();
      } else {
        if (msgEl) msgEl.innerHTML = `<span style="color:#ffaaaa;">Eroare: ${esc(d.error)}</span>`;
      }
    } catch(e) {
      closeDeleteModal();
      if (msgEl) msgEl.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    } finally {
      btn.textContent = '🗑 Șterge definitiv';
    }
  }

  function onAllInstChange() {
    _populateDeptFilter(document.getElementById("allInstFilter").value, "allDeptFilter");
  }

  async function cleanOldFlows() { await previewCleanOld(); }
  async function cleanAllFlows() { await previewCleanAll(); }

  window.verifyDriveConn = verifyDriveConn;
  window.loadArchiveInstData = loadArchiveInstData;
  window.onArchiveInstChange = onArchiveInstChange;
  window.onDelInstChange = onDelInstChange;
  window.previewArchive = previewArchive;
  window.doArchive = doArchive;
  window.doArchiveAsync = doArchiveAsync;
  window.pollArchiveJob = pollArchiveJob;
  window.runVacuum = runVacuum;
  window.loadDbStats = loadDbStats;
  window.previewCleanOld = previewCleanOld;
  window.previewCleanAll = previewCleanAll;
  window.closeDeleteModal = closeDeleteModal;
  window.executePendingDelete = executePendingDelete;
  window.onAllInstChange = onAllInstChange;
  window.cleanOldFlows = cleanOldFlows;
  window.cleanAllFlows = cleanAllFlows;

  window.df._archiveModuleLoaded = true;
})();
