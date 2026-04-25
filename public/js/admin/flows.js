// public/js/admin/flows.js
// DocFlowAI — Modul Flows (Admin) — BLOC 1.2 v2 (cu cross-zone safety).
//
// Cross-zone state pe window (folosit și de admin/archive.js — BLOC 1.3):
//   - window._allFlows  : flows cache (citit/scris și de loadArchiveInstData)
//
// Local state (doar în acest modul):
//   - _adminFluxPage, _adminFluxDebounce
//
// Dependențe externe (rămân în admin.js / admin/core.js):
//   - _apiFetch, hdrs(), escH(), esc()

(function() {
  'use strict';
  const $ = window.df.$;
  const downloadBlob = window.df.downloadBlob;

  // ── Cross-zone state — pe window pentru access din archive.js (BLOC 1.3) ─
  if (typeof window._allFlows === 'undefined') window._allFlows = null;

  // ── State local Flows ─────────────────────────────────────────────────────
  let _adminFluxPage = 1;
  let _adminFluxDebounce = null;

  // ── Flows functions ───────────────────────────────────────────────────────

  // FIX b80: dropdown instituții populat din endpoint dedicat (nu din pagina curentă).
  // Apelat o singură dată la init și la reload forțat.
  async function loadFlowInstitutions() {
    const sel = document.getElementById("flowInstFilter");
    const currentVal = sel.value;
    try {
      const r = await _apiFetch('/admin/flows/institutions', { headers: hdrs() });
      if (!r.ok) return;
      const { institutions } = await r.json();
      sel.innerHTML = '<option value="">Toate instituțiile</option>';
      (institutions || []).forEach(inst => {
        const opt = document.createElement("option");
        opt.value = inst;
        opt.textContent = inst;
        sel.appendChild(opt);
      });
      if (currentVal) sel.value = currentVal;
    } catch(e) { console.warn('loadFlowInstitutions error:', e.message); }
    // org_admin: re-aplică lock după populare
    if (window._orgAdminInstitutie) {
      let found=false; for(const o of sel.options){if(o.value===window._orgAdminInstitutie){found=true;break;}}
      if(!found){const o=new Option(window._orgAdminInstitutie,window._orgAdminInstitutie);sel.appendChild(o);}
      sel.value=window._orgAdminInstitutie; sel.disabled=true;
      sel.style.cssText+=';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;';
      onFlowInstChange();
    }
  }

  // Compatibilitate — no-op (instituțiile vin din endpoint dedicat)
  function populateFlowInstDropdown(flows) { /* no-op — înlocuit cu loadFlowInstitutions() */ }

  function onFlowInstChange() {
    const instF = document.getElementById("flowInstFilter").value;
    const deptSel = document.getElementById("flowDeptFilter");
    deptSel.innerHTML = '<option value="">Toate compartimentele</option>';
    if (instF && window._allFlows) {
      const depts = [...new Set(
        window._allFlows
          .filter(f => (f.institutie||"") === instF)
          .map(f => f.compartiment||"")
          .filter(Boolean)
      )].sort();
      depts.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        deptSel.appendChild(opt);
      });
      deptSel.disabled = depts.length === 0;
    } else {
      deptSel.disabled = true;
    }
    // Re-filtrează fără reload din server
    loadFlowsList(false);
  }

  function debounceAdminFlows() {
    clearTimeout(_adminFluxDebounce);
    _adminFluxDebounce = setTimeout(() => loadFlowsList(false, 1), 350);
  }

  async function loadFlowsList(forceReload = true, page) {
    page = Math.max(1, parseInt(page) || _adminFluxPage);
    _adminFluxPage = page;
    const area = document.getElementById("flowsListArea");
    const search = (document.getElementById("flowSearch").value||"").trim();
    const statusF = document.getElementById("flowStatusFilter").value;
    const instF = document.getElementById("flowInstFilter").value;
    const deptF = document.getElementById("flowDeptFilter").value;
    const dateFrom = (document.getElementById("flowDateFrom")?.value || "").trim();
    const dateTo   = (document.getElementById("flowDateTo")?.value   || "").trim();
    area.innerHTML = '<span style="color:var(--muted);">⏳ Se incarca...</span>';

    // Mapeaza valorile locale la parametrii server
    const statusMap = { active: "pending", done: "completed", refused: "refused", cancelled: "cancelled", archived: "all", "": "all" };
    const statusParam = statusMap[statusF] || "all";

    const params = new URLSearchParams({ page, limit: 10, status: statusParam });
    if (statusF === "archived") params.set("storage", "drive");
    if (search) params.set("search", search);
    if (instF) params.set("institutie", instF);
    if (deptF) params.set("compartiment", deptF);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo)   params.set("dateTo",   dateTo);

    try {
      const r = await _apiFetch("/admin/flows/list?" + params.toString(), {headers: hdrs()});
      if (!r.ok) throw new Error("Eroare server");
      const resp = await r.json();
      const flows = Array.isArray(resp) ? resp : (resp.flows || []);
      const total = resp.total || flows.length;
      const pages = resp.pages || 1;
      const cntFlows = document.getElementById('flowsActiveCount'); if (cntFlows) cntFlows.textContent = String(total);

      // Dropdown instituții populat din /admin/flows/institutions (endpoint dedicat)
      // — nu din datele paginii curente (ar arăta doar instituțiile din pag. curentă)

      if (!flows.length) {
        area.innerHTML = '<span style="color:var(--muted);">Niciun flux gasit.</span>';
        const pg = document.getElementById("flowsListPagination"); if (pg) pg.style.display = "none";
        return;
      }
      area.innerHTML = `
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:.8rem;">
          <thead><tr style="color:var(--muted);border-bottom:1px solid rgba(255,255,255,.08);">
            <th style="text-align:left;padding:6px 8px;">Document</th>
            <th style="text-align:left;padding:6px 8px;">Initiator</th>
            <th style="text-align:left;padding:6px 8px;">Status</th>
            <th style="text-align:left;padding:6px 8px;">Semnatar curent</th>
            <th style="text-align:left;padding:6px 8px;">Creat</th>
            <th style="text-align:left;padding:6px 8px;">Actiuni</th>
          </tr></thead>
          <tbody>${flows.map(f => {
            const current = (f.signers||[]).find(s=>s.status==="current");
            const tokenAge = current?.tokenCreatedAt ? Math.floor((Date.now()-new Date(current.tokenCreatedAt).getTime())/(24*3600*1000)) : null;
            const expired = tokenAge !== null && tokenAge >= 90;
            const statusBadge = f.completed
              ? '<span style="color:#7cf0e0;font-size:.75rem;">✅ finalizat</span>'
              : f.status==="refused"
              ? '<span style="color:#ffaaaa;font-size:.75rem;">⛔ refuzat</span>'
              : f.status==="cancelled"
              ? '<span style="color:#aaaaaa;font-size:.75rem;">🚫 anulat</span>'
              : '<span style="color:#b39dff;font-size:.75rem;">✍ activ</span>';
            return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);">
              <td style="padding:7px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escH(f.flowId||'')}"> ${f.urgent ? '<span style="color:#ff8888;font-weight:700;margin-right:4px;">🚨</span>' : ''}${escH(f.docName||"—")}</td>
              <td style="padding:7px 8px;color:var(--muted);" title="${escH(f.initEmail||'')}">${escH(f.initName||f.initEmail||"—")}</td>
              <td style="padding:7px 8px;">${statusBadge}</td>
              <td style="padding:7px 8px;">
                ${current ? `<span style="color:${expired?'#ffaaaa':'var(--sub)'};">${escH(current.name||current.email||"—")}</span>
                ${expired?'<span style="font-size:.72rem;color:#ffaaaa;margin-left:4px;">⚠ link expirat</span>':''}
                ${tokenAge!==null?`<span style="font-size:.7rem;color:var(--muted);margin-left:4px;">${tokenAge}z</span>`:''}` : '<span style="color:var(--muted);">—</span>'}
              </td>
              <td style="padding:7px 8px;color:var(--muted);">${f.createdAt?new Date(f.createdAt).toLocaleDateString("ro-RO"):"—"}</td>
              <td style="padding:7px 8px;">
                <a href="/flow.html?flow=${encodeURIComponent(f.flowId||'')}" target="_blank" style="padding:3px 10px;font-size:.75rem;background:rgba(45,212,191,.1);border:1px solid rgba(45,212,191,.25);border-radius:6px;color:#7cf0e0;text-decoration:none;cursor:pointer;margin-right:4px;" title="Vizualizează flux">🔍</a>
                ${f.storage==='drive' && f.driveFileLinkFinal ? `<a href="${f.driveFileLinkFinal}" target="_blank" style="padding:3px 10px;font-size:.75rem;background:rgba(45,212,191,.08);border:1px solid rgba(45,212,191,.2);border-radius:6px;color:#2dd4bf;text-decoration:none;cursor:pointer;margin-right:4px;" title="Deschide în Google Drive">💾 Drive</a>` : ''}
                ${current&&!f.completed&&f.status!=="refused" ? `
                  <button onclick="resendNotif('${f.flowId}')" style="padding:3px 10px;font-size:.75rem;background:rgba(124,92,255,.2);border:1px solid rgba(124,92,255,.3);border-radius:6px;color:#b39dff;cursor:pointer;margin-right:4px;" title="Retrimite notificare">📨</button>
                  ${expired?`<button onclick="regenerateToken('${escH(f.flowId||'')}','${escH(current.email||'')}')" style="padding:3px 10px;font-size:.75rem;background:rgba(255,170,50,.15);border:1px solid rgba(255,170,50,.3);border-radius:6px;color:#ffd580;cursor:pointer;margin-right:4px;" title="Generează token nou">🔑</button>`:''}
                ` : ''}
                <button onclick="adminDeleteFlow('${escH(f.flowId||'')}')" style="padding:3px 10px;font-size:.75rem;background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.3);border-radius:6px;color:#ffaaaa;cursor:pointer;" title="Șterge flux definitiv (ireversibil)">🗑</button>
                <button onclick="downloadAudit('${escH(f.flowId||'')}','txt')" style="padding:3px 8px;font-size:.72rem;background:rgba(45,212,191,.08);border:1px solid rgba(45,212,191,.2);border-radius:6px;color:#7cf0e0;cursor:pointer;" title="Export audit TXT">📋</button><button onclick="downloadAudit('${escH(f.flowId||'')}','pdf')" style="padding:3px 8px;font-size:.72rem;background:rgba(45,212,191,.08);border:1px solid rgba(45,212,191,.2);border-radius:6px;color:#7cf0e0;cursor:pointer;margin-left:4px;" title="Export audit PDF">📄</button>${f.completed ? `<button onclick="downloadTrustReport('${escH(f.flowId||'')}', this)" style="padding:3px 8px;font-size:.72rem;background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.3);border-radius:6px;color:#b39dff;cursor:pointer;margin-left:4px;" title="Signing Trust Report">📜</button>` : ''}
              </td>
            </tr>`;
          }).join("")}
          </tbody>
        </table></div>
        <div style="margin-top:8px;font-size:.76rem;color:var(--muted);">Pagina ${page} din ${pages} · ${total} flux${total!==1?"uri":""} total</div>`;

      // Paginare fluxuri — același stil cu paginarea utilizatorilor
      const pg = document.getElementById("flowsListPagination");
      if (pg) {
        pg.style.display = pages > 1 ? "" : "none";
        pg.innerHTML = "";
        if (pages > 1) {
          pg.className = "pagination";
          const info = document.createElement("span"); info.className = "pg-info";
          const from = (page - 1) * (resp.limit || 50) + 1;
          const to = Math.min(page * (resp.limit || 50), total);
          info.textContent = `${from}–${to} din ${total}`;
          const prev = document.createElement("button"); prev.className = "pg-btn"; prev.textContent = "◀";
          prev.disabled = page <= 1; prev.onclick = () => loadFlowsList(false, page - 1);
          pg.appendChild(prev); pg.appendChild(info);
          const maxPages = pages;
          for (let p = 1; p <= maxPages; p++) {
            if (maxPages > 7 && Math.abs(p - page) > 2 && p !== 1 && p !== maxPages) {
              if (p === 2 || p === maxPages - 1) { const d = document.createElement("span"); d.className = "pg-info"; d.textContent = "…"; pg.appendChild(d); }
              continue;
            }
            const b = document.createElement("button"); b.className = "pg-btn" + (p === page ? " active" : "");
            b.textContent = p; b.onclick = (pp => () => loadFlowsList(false, pp))(p);
            pg.appendChild(b);
          }
          const next = document.createElement("button"); next.className = "pg-btn"; next.textContent = "▶";
          next.disabled = page >= pages; next.onclick = () => loadFlowsList(false, page + 1);
          pg.appendChild(next);
        }
      }
    } catch(e) { area.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(e.message)}</span>`; }
  }

  async function downloadAudit(flowId, format) {
    try {
      const r = await _apiFetch(`/admin/flows/${encodeURIComponent(flowId)}/audit?format=${format}`, { headers: hdrs() });
      if (!r.ok) { const j = await r.json().catch(()=>{}); alert('Eroare audit: ' + (j?.error || r.status)); return; }
      const blob = await r.blob();
      downloadBlob(blob, `audit_${flowId}.${format}`);
    } catch(e) { alert('Eroare descărcare audit: ' + e.message); }
  }

  async function exportAuditCSV() {
    try {
      const r = await _apiFetch('/admin/flows/audit-export?days=30', { headers: hdrs() });
      if (!r.ok) { const j = await r.json().catch(()=>{}); alert('Eroare export CSV: ' + (j?.error || r.status)); return; }
      const blob = await r.blob();
      downloadBlob(blob, `audit_export_${new Date().toISOString().slice(0,10)}.csv`);
    } catch(e) { alert('Eroare export CSV: ' + e.message); }
  }

  async function adminDeleteFlow(flowId) {
    if (!confirm(`Ești sigur că vrei să ștergi fluxul ${flowId}?\nToate datele asociate (PDF, notificări) vor fi șterse ireversibil.`)) return;
    try {
      const r = await _apiFetch(`/flows/${encodeURIComponent(flowId)}`, { method: "DELETE", headers: hdrs() });
      const j = await r.json();
      if (j.ok) { loadFlowsList(false, _adminFluxPage); }
      else alert("❌ " + (j.message || j.error || "Eroare la ștergere."));
    } catch(e) { alert("❌ " + e.message); }
  }

  async function deleteFlow(flowId, docName) {
    if (!confirm("Stergi definitiv fluxul:\n" + docName + "\n\nAceasta actiune este ireversibila.")) return;
    try {
      const r = await _apiFetch("/flows/" + encodeURIComponent(flowId), { method: "DELETE", headers: hdrs() });
      const j = await r.json();
      if (j.ok) {
        loadFlowsList(true, _adminFluxPage);
      } else {
        alert("❌ " + (j.message || j.error || "Eroare la stergere"));
      }
    } catch(e) { alert("❌ " + e.message); }
  }

  async function resendNotif(flowId) {
    try {
      const r = await _apiFetch(`/flows/${encodeURIComponent(flowId)}/resend`, {method:"POST", headers:hdrs()});
      const j = await r.json();
      if (j.ok) alert(`✅ Notificare retrimisă către ${j.to}`);
      else alert("❌ " + (j.error||"Eroare"));
    } catch(e) { alert("❌ " + e.message); }
  }

  async function regenerateToken(flowId, signerEmail) {
    if (!confirm(`Generezi un token nou pentru ${signerEmail}?\nVechiul link va fi invalid. Semnatarul va primi un email cu noul link.`)) return;
    try {
      const r = await _apiFetch(`/flows/${encodeURIComponent(flowId)}/regenerate-token`, {
        method:"POST", headers:hdrs(),
        body: JSON.stringify({signerEmail})
      });
      const j = await r.json();
      if (j.ok) {
        alert(`✅ Token nou generat și email trimis către ${signerEmail}.`);
        loadFlowsList(true, 1); // refresh
      } else alert("❌ " + (j.message||j.error||"Eroare"));
    } catch(e) { alert("❌ " + e.message); }
  }

  // ── Export onclick global ─────────────────────────────────────────────────
  window.loadFlowInstitutions      = loadFlowInstitutions;
  window.populateFlowInstDropdown  = populateFlowInstDropdown;
  window.onFlowInstChange          = onFlowInstChange;
  window.debounceAdminFlows        = debounceAdminFlows;
  window.loadFlowsList             = loadFlowsList;
  window.downloadAudit             = downloadAudit;
  window.exportAuditCSV            = exportAuditCSV;
  window.adminDeleteFlow           = adminDeleteFlow;
  window.deleteFlow                = deleteFlow;
  window.resendNotif               = resendNotif;
  window.regenerateToken           = regenerateToken;

  window.df = window.df || {};
  window.df._flowsModuleLoaded = true;
})();
