// public/js/admin/organizations.js
// DocFlowAI — Modul Organizații (Admin) — BLOC 1.8 v2.
//
// Scope: CRUD organizații, webhook, signing providers UI, assign org to user,
//   onboarding wizard, bulk CSV import, 2FA TOTP, change password,
//   rename org, compartimente.
//
// NU conține logică STS Cloud signing efectivă.
//
// Local state (toate INTRA-modul):
//   - _currentOrgId, _allProviders, _selectedProviders, _activeConfigProvider
//   - _assignOrgUserId, _totpPendingSecret, _renameOrgId
//   - _orgCompartimente, _orgConfigSafe, _PROVIDERS_FALLBACK, _origSaveOrgWebhook
//
// Cross-module calls (via window, set by other modules):
//   - window.loadUsers()            : users.js BLOC 1.1
//   - window.loadOrganizationsAutocomplete() : users.js BLOC 1.1

(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;

  // ── Local state ───────────────────────────────────────────────────────────
  let _currentOrgId        = null;
  let _allProviders        = [];
  let _selectedProviders   = new Set(['local-upload']);
  let _activeConfigProvider= null;
  let _assignOrgUserId     = null;
  let _totpPendingSecret   = null;
  let _renameOrgId         = null;
  let _orgCompartimente    = [];
  let _orgConfigSafe       = {};

  const _PROVIDERS_FALLBACK = [
    { id: 'local-upload', label: 'Upload local (orice certificat calificat)', mode: 'upload' },
    { id: 'sts-cloud',   label: 'STS Cloud QES (Serviciul de Telecomunicații Speciale)', mode: 'redirect' },
    { id: 'certsign',   label: 'certSIGN / Paperless QES', mode: 'redirect', stub: true },
    { id: 'transsped',  label: 'Trans Sped QES', mode: 'redirect', stub: true },
    { id: 'alfatrust',  label: 'AlfaTrust / AlfaSign QES', mode: 'redirect', stub: true },
    { id: 'namirial',   label: 'Namirial eSignAnyWhere QES', mode: 'redirect', stub: true },
  ];

  // ── Change Password ───────────────────────────────────────────────────────

  function openChangePwdModal(){
    const m=$('changePwdModal'); m.style.display='flex';
    $('cpCurrent').value=$('cpNew').value=$('cpConfirm').value='';
    $('cpMsg').textContent='';$('cpMsg').style.color='';
    $('cpBtn').disabled=false;$('cpBtn').textContent='Salvează';
    $('cpCurrent').focus();
  }
  function closeChangePwdModal(){$('changePwdModal').style.display='none';}
  async function submitChangePwd(){
    const cur=$('cpCurrent').value, nw=$('cpNew').value, cf=$('cpConfirm').value;
    const msg=$('cpMsg'), btn=$('cpBtn');
    if(!cur||!nw||!cf){msg.style.color='#f28b82';msg.textContent='Completează toate câmpurile.';return;}
    if(nw!==cf){msg.style.color='#f28b82';msg.textContent='Parolele noi nu coincid.';return;}
    if(nw.length<6){msg.style.color='#f28b82';msg.textContent='Parola trebuie să aibă minim 6 caractere.';return;}
    btn.disabled=true;btn.textContent='Se salvează...';
    try{
      const r=await _apiFetch('/auth/change-password',{method:'POST',headers:hdrs(),body:JSON.stringify({current_password:cur,new_password:nw})});
      const d=await r.json();
      if(r.ok){
        msg.style.color='#34A853';msg.textContent='✅ Parola schimbată cu succes!';
        localStorage.removeItem('docflow_force_pwd');
        const b=$('forcePwdBanner');if(b)b.style.display='none';
        setTimeout(closeChangePwdModal,1800);
      }
      else{msg.style.color='#f28b82';msg.textContent=d.message||(d.error==='wrong_password'?'Parola curentă incorectă.':'Eroare.');btn.disabled=false;btn.textContent='Salvează';}
    }catch(e){msg.style.color='#f28b82';msg.textContent='Eroare de rețea.';btn.disabled=false;btn.textContent='Salvează';}
  }

  // ── Tab Organizații & Webhook ─────────────────────────────────────────────

  async function loadOrganizations() {
    const tbody = $('org-table-body');
    if (!tbody) return;
    try {
      const fS = window._orgStatusFilter || 'active';  // active | deactivated | all
      const includeDel = (fS === 'all' || fS === 'deactivated');
      const url = '/admin/organizations' + (includeDel ? '?include_deleted=1' : '');
      const r = await _apiFetch(url, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      let orgs = await r.json();
      // Filtrare client-side pentru opțiunea „doar dezactivate"
      if (fS === 'deactivated') orgs = orgs.filter(o => !!o.deleted_at);

      window._allOrgs = orgs;
      renderOrgsTable(orgs);
    } catch(e) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:#ffaaaa;">Eroare: ${esc(e.message)}</td></tr>`;
    }
  }

  function renderOrgsTable(orgs) {
    const tbody = $('org-table-body');
    const empty = $('org-table-empty');
    if (!tbody) return;
    if (!orgs.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = orgs.map(org => {
      const isDeactivated = !!org.deleted_at;
      const lastAct = org.last_activity ? new Date(org.last_activity).toLocaleDateString('ro-RO') : '—';
      const webhookIcon = org.webhook_url
        ? (org.webhook_enabled ? '<span title="Activ" style="color:#2dd4bf;">●</span>' : '<span title="Configurat dar inactiv" style="color:#ffd580;">●</span>')
        : '<span title="Neconfigurat" style="color:rgba(234,240,255,.25);">○</span>';
      const statusBadge = isDeactivated
        ? '<span style="font-size:.7rem;padding:2px 8px;border-radius:8px;background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.35);color:#ff8a8a;font-weight:700;">DEZACTIVATĂ</span>'
        : '<span style="font-size:.7rem;padding:2px 8px;border-radius:8px;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.3);color:#2dd4bf;font-weight:700;">ACTIVĂ</span>';
      const rowStyle = isDeactivated ? 'opacity:.55;' : '';
      const actions = isDeactivated
        ? `<button class="df-action-btn sm" onclick="event.stopPropagation();reactivateOrg(${org.id},'${esc(org.name)}')" title="Reactivează" style="background:rgba(45,212,191,.15);border-color:rgba(45,212,191,.4);color:#2dd4bf;">↻</button>`
        : `<button class="df-action-btn sm" onclick="event.stopPropagation();openOrgDetail(${org.id})" title="Detalii"><svg class="df-ic"><use href="/icons.svg?v=3.9.473#ico-settings"/></svg></button>
           <button class="df-action-btn danger sm" onclick="event.stopPropagation();openDeleteOrgModal(${org.id},'${esc(org.name)}',${org.user_count||0},${org.flow_count||0})" title="Șterge">🗑</button>`;
      return `
        <tr style="${rowStyle}" onclick="${isDeactivated?'':`openOrgDetail(${org.id})`}">
          <td><strong style="color:#eaf0ff;">${esc(org.name)}</strong>${(org.name === 'Default Organization' && !isDeactivated) ? ' <span style="font-size:.68rem;color:#ffd580;">⚠ redenumește</span>' : ''}</td>
          <td style="color:rgba(234,240,255,.7);">${esc(org.cif || '—')}</td>
          <td style="text-align:right;color:rgba(234,240,255,.85);font-variant-numeric:tabular-nums;">${org.user_count || 0}</td>
          <td style="text-align:right;color:rgba(234,240,255,.85);font-variant-numeric:tabular-nums;">${org.flow_count || 0}</td>
          <td style="text-align:center;font-size:1.2rem;">${webhookIcon}</td>
          <td style="text-align:center;">${statusBadge}</td>
          <td style="color:rgba(234,240,255,.6);font-size:.82rem;">${lastAct}</td>
          <td><div style="display:flex;gap:4px;justify-content:flex-end;">${actions}</div></td>
        </tr>`;
    }).join('');
  }

  function filterOrgsTable() {
    const q = ($('orgSearchInput')?.value || '').toLowerCase().trim();
    const all = window._allOrgs || [];
    if (!q) { renderOrgsTable(all); return; }
    const filtered = all.filter(o =>
      (o.name || '').toLowerCase().includes(q) ||
      (o.cif || '').toLowerCase().includes(q)
    );
    renderOrgsTable(filtered);
  }

  function onOrgStatusChange() {
    window._orgStatusFilter = ($('orgStatusFilter')||{value:'active'}).value;
    loadOrganizations();
  }

  // ── Signing Providers — variabile (IIFE-local, declarate în state block sus) ──

  // ── Detail view: deschide pagina cu sub-tabs pentru o organizație ─
  async function openOrgDetail(id) {
    _currentOrgId = id;
    // Schimbă view-ul
    $('org-list-view').style.display   = 'none';
    $('org-detail-view').style.display = '';
    // Setează hash pentru bookmark + back/forward
    if (location.hash !== `#organizatii/${id}`) {
      history.pushState(null, '', `#organizatii/${id}`);
    }
    // Reset UI states
    $('orgDetailName').textContent          = 'Se încarcă...';
    $('orgDetailStatusBadge').innerHTML     = '';
    $('orgDetailActions').innerHTML         = '';
    $('orgCif').value                       = '';
    $('orgCompartimenteInput').value        = '';
    $('orgWebhookUrl').value                = '';
    $('orgWebhookSecret').value             = '';
    $('orgWebhookEnabled').checked          = false;
    $('evtCompleted').checked               = true;
    $('evtRefused').checked                 = false;
    $('evtCancelled').checked               = false;
    $('orgGeneralMsg').textContent          = '';
    $('orgWebhookMsg').textContent          = '';
    $('orgSigningMsg').textContent          = '';
    _orgCompartimente = [];
    _renderCompartimente();
    // Default tab la deschidere
    switchOrgSubTab('general');
    try {
      const r = await _apiFetch(`/admin/organizations/${id}`, { headers: hdrs() });
      if (!r.ok) throw new Error(`Eroare ${r.status}`);
      const org = await r.json();
      _populateOrgDetail(org);
    } catch(e) {
      $('orgDetailName').textContent = '⚠ Eroare la încărcare';
    }
    // Provideri semnare
    _selectedProviders = new Set(['local-upload']);
    _activeConfigProvider = null;
    loadOrgSigningProviders(id);
  }

  function _populateOrgDetail(org) {
    $('orgDetailName').textContent          = org.name || '—';
    const isDeactivated = !!org.deleted_at;
    $('orgDetailStatusBadge').innerHTML = isDeactivated
      ? '<span style="font-size:.72rem;padding:3px 10px;border-radius:10px;background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.35);color:#ff8a8a;font-weight:700;">DEZACTIVATĂ</span>'
      : '<span style="font-size:.72rem;padding:3px 10px;border-radius:10px;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.3);color:#2dd4bf;font-weight:700;">ACTIVĂ</span>';
    // Acțiuni header (Redenumește + Șterge/Reactivează)
    const actions = [];
    if (!isDeactivated) {
      actions.push(`<button class="df-action-btn" onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')">✏️ Redenumește</button>`);
    }
    $('orgDetailActions').innerHTML = actions.join(' ');
    // Câmpuri General
    $('orgCif').value = org.cif || '';
    _orgCompartimente = Array.isArray(org.compartimente) ? [...org.compartimente] : [];
    _renderCompartimente();
    $('orgDetailCreatedAt').textContent = org.created_at ? new Date(org.created_at).toLocaleString('ro-RO') : '—';
    $('orgDetailUpdatedAt').textContent = org.updated_at ? new Date(org.updated_at).toLocaleString('ro-RO') : '—';
    // Câmpuri Webhook
    $('orgWebhookUrl').value     = org.webhook_url || '';
    $('orgWebhookEnabled').checked = !!org.webhook_enabled;
    const evts = org.webhook_events || [];
    $('evtCompleted').checked = evts.includes('flow.completed');
    $('evtRefused').checked   = evts.includes('flow.refused');
    $('evtCancelled').checked = evts.includes('flow.cancelled');
    // Zona periculoasă
    const dz = $('orgDangerZoneContent');
    if (dz) {
      if (isDeactivated) {
        const delDate = org.deleted_at ? new Date(org.deleted_at).toLocaleDateString('ro-RO') : '—';
        dz.innerHTML = `
          <div style="font-size:.85rem;color:rgba(234,240,255,.75);margin-bottom:10px;">Această organizație a fost dezactivată pe <strong>${delDate}</strong>. Datele sunt păstrate pentru conformitate.</div>
          <button class="df-action-btn" onclick="reactivateOrg(${org.id},'${esc(org.name)}')" style="background:rgba(45,212,191,.15);border-color:rgba(45,212,191,.4);color:#2dd4bf;">↻ Reactivează organizația</button>`;
      } else {
        dz.innerHTML = `
          <div style="font-size:.85rem;color:rgba(234,240,255,.75);margin-bottom:10px;">Ștergerea organizației o ascunde din toate listele. Datele istorice (fluxuri, audit, semnături) rămân în baza de date.</div>
          <button class="df-action-btn danger" onclick="openDeleteOrgModal(${org.id},'${esc(org.name)}',0,0)">🗑 Șterge organizația</button>`;
      }
    }
  }

  function closeOrgDetail() {
    $('org-detail-view').style.display = 'none';
    $('org-list-view').style.display   = '';
    _currentOrgId = null;
    if (location.hash.startsWith('#organizatii/')) {
      history.pushState(null, '', '#organizatii');
    }
    // Refresh listă pentru a reflecta eventuale modificări
    if (typeof loadOrganizations === 'function') loadOrganizations();
  }

  function switchOrgSubTab(name) {
    ['general','users','webhook','signing','stats'].forEach(t => {
      const panel = $('org-subtab-' + t);
      if (panel) panel.style.display = (t === name ? '' : 'none');
    });
    document.querySelectorAll('.df-subtab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.subtab === name);
    });
    if (name === 'users' && _currentOrgId) loadOrgUsersStats(_currentOrgId);
    if (name === 'stats' && _currentOrgId) loadOrgStats(_currentOrgId);
  }

  // Backward-compat: vechiul openOrgModal redirecționează la openOrgDetail
  function openOrgModal(id /*, name*/) { return openOrgDetail(id); }
  function closeOrgModal() { return closeOrgDetail(); }

  // ── Asignare organizație user existent (super-admin) ─────────────────────

  function openAssignOrg(userId, userName) {
    _assignOrgUserId = userId;
    const msg = document.getElementById('assignOrgMsg');
    if (msg) msg.textContent = '';
    const inp = document.getElementById('assignOrgInput');
    if (inp) inp.value = '';
    const title = document.getElementById('assignOrgTitle');
    if (title) title.textContent = `Asignează organizație pentru: ${userName}`;
    loadOrganizationsAutocomplete();
    document.getElementById('assignOrgModal').style.display = 'flex';
    setTimeout(() => inp?.focus(), 100);
  }
  function closeAssignOrg() {
    document.getElementById('assignOrgModal').style.display = 'none';
    _assignOrgUserId = null;
  }
  async function doAssignOrg() {
    const orgName = (document.getElementById('assignOrgInput')?.value || '').trim();
    const msg = document.getElementById('assignOrgMsg');
    if (!orgName) { if (msg) { msg.style.color='#ffaaaa'; msg.textContent='Selectați sau scrieți o organizație.'; } return; }
    if (!_assignOrgUserId) return;
    const btn = document.querySelector('#assignOrgModal button[onclick="doAssignOrg()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
    try {
      const r = await _apiFetch(`/admin/users/${_assignOrgUserId}/assign-org`, {
        method: 'PUT',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_name: orgName }),
      });
      const j = await r.json();
      if (r.ok) {
        if (msg) { msg.style.color='#2dd4bf'; msg.textContent='✅ Organizație asignată cu succes.'; }
        setTimeout(() => { closeAssignOrg(); loadUsers(); }, 700);
      } else {
        if (msg) { msg.style.color='#ffaaaa'; msg.textContent='❌ ' + (j.error || 'Eroare.'); }
      }
    } catch(e) {
      if (msg) { msg.style.color='#ffaaaa'; msg.textContent='❌ Eroare rețea.'; }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='💾 Salvează'; }
    }
  }

  // ── Onboarding Wizard ────────────────────────────────────────────────────────

  function openOnboardingWizard() {
    const m = document.getElementById('onboardingModal');
    if (!m) return;
    ['owOrgName','owAdminEmail','owAdminName','owOrgCif'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    const functieEl = document.getElementById('owAdminFunctie');
    if (functieEl) functieEl.value = 'Administrator Instituție';
    const msg = document.getElementById('owMsg');
    if (msg) msg.textContent = '';
    const result = document.getElementById('owResult');
    if (result) result.style.display = 'none';
    const btn = document.getElementById('owSubmitBtn');
    if (btn) { btn.disabled = false; btn.textContent = '🏛 Creează instituția'; }
    m.style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('owOrgName'); if(el) el.focus(); }, 100);
  }
  function closeOnboardingWizard() {
    const m = document.getElementById('onboardingModal');
    if (m) m.style.display = 'none';
  }
  async function doOnboarding() {
    const orgName    = (document.getElementById('owOrgName')?.value || '').trim();
    const adminEmail = (document.getElementById('owAdminEmail')?.value || '').trim();
    const adminName  = (document.getElementById('owAdminName')?.value || '').trim();
    const adminFunctie = (document.getElementById('owAdminFunctie')?.value || '').trim();
    const cif = (document.getElementById('owOrgCif')?.value || '').trim().replace(/^RO/i, '').replace(/\D/g, '');
    const msg = document.getElementById('owMsg');
    const btn = document.getElementById('owSubmitBtn');

    msg.style.color = '#ff8080'; msg.textContent = '';
    if (!orgName)    { msg.textContent = 'Completați numele instituției.'; return; }
    if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) { msg.textContent = 'Introduceți un email valid.'; return; }
    if (!adminName)  { msg.textContent = 'Completați numele administratorului.'; return; }

    btn.disabled = true; btn.textContent = '⏳ Se creează...';
    try {
      const r = await _apiFetch('/admin/onboarding', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ org_name: orgName, admin_email: adminEmail, admin_name: adminName, admin_functie: adminFunctie, cif: cif || null })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Eroare server');

      const result = document.getElementById('owResult');
      const details = document.getElementById('owResultDetails');
      if (result) result.style.display = 'block';
      if (details) details.innerHTML = `
        <strong>Instituție:</strong> ${esc(d.orgName)} (ID: ${d.orgId})<br>
        <strong>Administrator:</strong> ${esc(adminName)} — ${esc(adminEmail)}<br>
        <strong>Parolă temporară:</strong> <code style="background:rgba(255,255,255,.1);padding:2px 6px;border-radius:4px;">${esc(d.tempPassword)}</code><br>
        <span style="color:#888;font-size:.78rem;">Credențialele au fost trimise și pe email. Administratorul va trebui să schimbe parola la prima logare.</span>
      `;
      btn.textContent = '✅ Creat';
      btn.disabled = false;
      btn.onclick = () => { closeOnboardingWizard(); loadOrganizations(); };
      msg.textContent = '';
      setTimeout(() => { loadOrganizations(); }, 500);
    } catch(e) {
      msg.style.color = '#ff8080';
      msg.textContent = '❌ ' + e.message;
      btn.disabled = false; btn.textContent = '🏛 Creează instituția';
    }
  }

  // ── Bulk Import CSV Utilizatori ──────────────────────────────────────────────

  function openBulkImportModal() {
    const m = document.getElementById('bulkImportModal');
    if (m) { document.getElementById('bulkCsvData').value = '';
      document.getElementById('bulkImportMsg').textContent = '';
      document.getElementById('bulkImportResult').style.display = 'none';
      const btn = document.getElementById('bulkImportBtn');
      if (btn) { btn.disabled = false; btn.textContent = '📤 Importă utilizatori'; }
      m.style.display = 'flex'; }
  }
  function closeBulkImportModal() {
    const m = document.getElementById('bulkImportModal');
    if (m) m.style.display = 'none';
  }
  async function doBulkImport() {
    const csvData = (document.getElementById('bulkCsvData')?.value || '').trim();
    const sendCreds = document.getElementById('bulkSendCreds')?.checked || false;
    const msg = document.getElementById('bulkImportMsg');
    const btn = document.getElementById('bulkImportBtn');
    if (!csvData) { msg.style.color='#ff8080'; msg.textContent='Introduceți datele CSV.'; return; }
    btn.disabled = true; btn.textContent = '⏳ Se importă...';
    try {
      const r = await _apiFetch('/admin/users/bulk-import', {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ csvData, send_credentials: sendCreds })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Eroare server');
      const s = d.summary;
      msg.style.color = '#2dd4bf';
      msg.textContent = `✅ ${s.created} creați, ${s.skipped} existenți, ${s.errors} erori din ${s.total} linii.`;
      const resultDiv = document.getElementById('bulkImportResult');
      let html = '';
      if (d.results.created.length) {
        html += `<div style="color:#2dd4bf;font-weight:700;margin-bottom:6px;">✅ Creați (${d.results.created.length}):</div>`;
        d.results.created.forEach(u => { html += `<div style="font-family:monospace;font-size:.8rem;">${esc(u.email)} — ${esc(u.nume)}${u.tempPassword ? ` <span style="color:#ffd580;">[pwd: ${esc(u.tempPassword)}]</span>` : ''}</div>`; });
      }
      if (d.results.errors.length) {
        html += `<div style="color:#ff8080;font-weight:700;margin:8px 0 4px;">❌ Erori (${d.results.errors.length}):</div>`;
        d.results.errors.forEach(e => { html += `<div style="font-size:.79rem;color:#ff8080;">${esc(e.line)} — ${esc(e.reason)}</div>`; });
      }
      resultDiv.innerHTML = html; resultDiv.style.display = 'block';
      btn.textContent = '✅ Import finalizat';
      loadUsers && loadUsers();
    } catch(e) {
      msg.style.color = '#ff8080'; msg.textContent = '❌ ' + e.message;
      btn.disabled = false; btn.textContent = '📤 Importă utilizatori';
    }
  }

  // ── load2FAStatus ──────────────────────────────────────────────────────────

  async function load2FAStatus() {
    try {
      const r = await _apiFetch('/auth/totp/status', { headers: hdrs() });
      const d = await r.json();
      if (d.enabled) {
        if (confirm(`2FA este ACTIV (${d.backupCodesRemaining} coduri backup rămase).\n\nVrei să îl dezactivezi?`)) {
          open2FADisable();
        }
      } else {
        open2FASetup();
      }
    } catch(e) { alert('Eroare: ' + e.message); }
  }

  // ── 2FA TOTP Management ───────────────────────────────────────────────────────

  async function open2FASetup() {
    const m = document.getElementById('twoFaModal');
    if (!m) return;
    ['twoFaStep1','twoFaStep2','twoFaDisable'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
    document.getElementById('twoFaStep1').style.display = 'block';
    document.getElementById('twoFaCode1').value = '';
    document.getElementById('twoFaMsg1').textContent = '';
    document.getElementById('twoFaQrArea').innerHTML = '<div style="color:var(--muted);font-size:.83rem;">⏳ Se generează...</div>';
    m.style.display = 'flex';
    try {
      const r = await _apiFetch('/auth/totp/setup', { method: 'POST', headers: hdrs() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      _totpPendingSecret = d.secret;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(d.otpauthUrl)}`;
      document.getElementById('twoFaQrArea').innerHTML = `<img src="${qrUrl}" style="border-radius:8px;border:3px solid rgba(124,92,255,.3);" width="180" height="180" alt="QR 2FA"/>`;
      document.getElementById('twoFaSecretText').textContent = d.secret;
      document.getElementById('twoFaSecretArea').style.display = 'block';
      setTimeout(() => document.getElementById('twoFaCode1')?.focus(), 200);
    } catch(e) {
      document.getElementById('twoFaMsg1').style.color = '#ff8080';
      document.getElementById('twoFaMsg1').textContent = '❌ ' + e.message;
    }
  }
  async function confirm2FASetup() {
    const code = (document.getElementById('twoFaCode1')?.value || '').trim();
    const msg = document.getElementById('twoFaMsg1');
    if (!code || code.length < 6) { msg.style.color='#ff8080'; msg.textContent='Introduceți codul de 6 cifre.'; return; }
    try {
      const r = await _apiFetch('/auth/totp/confirm', { method: 'POST', headers: hdrs(), body: JSON.stringify({ code }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      document.getElementById('twoFaStep1').style.display = 'none';
      document.getElementById('twoFaStep2').style.display = 'block';
      const codesDiv = document.getElementById('twoFaBackupCodes');
      if (codesDiv) codesDiv.innerHTML = d.backupCodes.map(c => `<span style="background:rgba(255,255,255,.07);padding:4px 8px;border-radius:4px;">${esc(c)}</span>`).join('');
    } catch(e) { msg.style.color='#ff8080'; msg.textContent='❌ ' + e.message; }
  }
  async function open2FADisable() {
    const m = document.getElementById('twoFaModal');
    if (!m) return;
    ['twoFaStep1','twoFaStep2','twoFaDisable'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
    document.getElementById('twoFaDisable').style.display = 'block';
    document.getElementById('twoFaDisableCode').value = '';
    document.getElementById('twoFaMsgDisable').textContent = '';
    m.style.display = 'flex';
    setTimeout(() => document.getElementById('twoFaDisableCode')?.focus(), 100);
  }
  async function do2FADisable() {
    const code = (document.getElementById('twoFaDisableCode')?.value || '').trim().toUpperCase();
    const msg = document.getElementById('twoFaMsgDisable');
    if (!code) { msg.style.color='#ff8080'; msg.textContent='Introduceți codul.'; return; }
    try {
      const r = await _apiFetch('/auth/totp/disable', { method: 'POST', headers: hdrs(), body: JSON.stringify({ code }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      close2FA(); location.reload();
    } catch(e) { msg.style.color='#ff8080'; msg.textContent='❌ ' + e.message; }
  }
  function close2FA() { const m = document.getElementById('twoFaModal'); if (m) m.style.display = 'none'; }

  // ── Redenumire organizație ────────────────────────────────────────────────

  function openRenameOrgModal(id, currentName) {
    _renameOrgId = id;
    const input = document.getElementById('renameOrgInput');
    if (input) input.value = currentName;
    const msg = document.getElementById('renameOrgMsg');
    if (msg) msg.textContent = '';
    document.getElementById('renameOrgModal').style.display = 'flex';
    setTimeout(() => { input?.focus(); input?.select(); }, 100);
  }
  function closeRenameOrgModal() {
    document.getElementById('renameOrgModal').style.display = 'none';
    _renameOrgId = null;
  }
  async function doRenameOrg() {
    const name = (document.getElementById('renameOrgInput')?.value || '').trim();
    const msg  = document.getElementById('renameOrgMsg');
    if (!name) { if (msg) { msg.style.color='#ffaaaa'; msg.textContent='Numele nu poate fi gol.'; } return; }
    if (!_renameOrgId) return;
    const btn = document.querySelector('#renameOrgModal button[onclick="doRenameOrg()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
    try {
      const r = await _apiFetch(`/admin/organizations/${_renameOrgId}`, {
        method: 'PUT',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (r.ok) {
        if (msg) { msg.style.color='#2dd4bf'; msg.textContent='✅ Redenumit cu succes.'; }
        setTimeout(() => { closeRenameOrgModal(); loadOrganizations(); }, 700);
      } else {
        if (msg) { msg.style.color='#ffaaaa'; msg.textContent='❌ ' + (j.error || 'Eroare.'); }
      }
    } catch(e) {
      if (msg) { msg.style.color='#ffaaaa'; msg.textContent='❌ Eroare rețea.'; }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='💾 Redenumește'; }
    }
  }

  // ── Reactivare organizație (super-admin only) ──────────────────────
  async function reactivateOrg(id, name) {
    if (!confirm('Reactivezi organizația „'+name+'"?')) return;
    try {
      const r = await _apiFetch('/admin/organizations/'+id+'/reactivate', {
        method: 'POST',
        headers: hdrs()
      });
      const data = await r.json().catch(()=>({}));
      if (r.ok) {
        if (typeof loadOrganizations === 'function') loadOrganizations();
      } else {
        alert(data.message || ('Eroare la reactivare: '+(data.error||r.status)));
      }
    } catch(e) {
      alert('Eroare de rețea: '+e.message);
    }
  }

  // ── Ștergere organizație (super-admin only, cu typing-confirm) ─────
  function openDeleteOrgModal(id, name, userCount, flowCount) {
    const m = document.getElementById('deleteOrgModal');
    if (!m) return;
    document.getElementById('delOrgName').textContent     = name;
    document.getElementById('delOrgNameTitle').textContent = name;
    document.getElementById('delOrgUserCount').textContent = userCount || 0;
    document.getElementById('delOrgFlowCount').textContent = flowCount || 0;
    document.getElementById('delOrgConfirmInput').value    = '';
    document.getElementById('delOrgMsg').innerHTML         = '';
    m.dataset.orgId   = id;
    m.dataset.orgName = name;
    m.style.display   = 'flex';
    setTimeout(() => document.getElementById('delOrgConfirmInput').focus(), 50);
  }
  function closeDeleteOrgModal() {
    const m = document.getElementById('deleteOrgModal');
    if (m) m.style.display = 'none';
  }
  async function doDeleteOrg() {
    const m = document.getElementById('deleteOrgModal');
    if (!m) return;
    const id   = parseInt(m.dataset.orgId);
    const name = m.dataset.orgName;
    const typed = (document.getElementById('delOrgConfirmInput').value || '').trim();
    const msg = document.getElementById('delOrgMsg');
    if (typed !== name) {
      msg.innerHTML = '<span style="color:#ffaaaa;">Numele introdus nu corespunde. Tastează exact: <strong>'+esc(name)+'</strong></span>';
      return;
    }
    const btn = document.getElementById('btnDelOrgConfirm');
    btn.disabled = true; btn.textContent = 'Se șterge...';
    try {
      const r = await _apiFetch('/admin/organizations/'+id, {
        method: 'DELETE',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: typed })
      });
      const data = await r.json().catch(()=>({}));
      if (r.ok) {
        closeDeleteOrgModal();
        if (typeof loadOrganizations === 'function') loadOrganizations();
      } else {
        msg.innerHTML = '<span style="color:#ffaaaa;">'+esc(data.message || data.error || ('Eroare '+r.status))+'</span>';
      }
    } catch(e) {
      msg.innerHTML = '<span style="color:#ffaaaa;">Eroare de rețea: '+esc(e.message)+'</span>';
    } finally {
      btn.disabled = false; btn.textContent = '🗑 Șterge organizația';
    }
  }

  // ── Signing Providers ─────────────────────────────────────────────────────

  async function loadOrgSigningProviders(orgId) {
    try {
      if (!_allProviders.length) {
        try {
          const r = await _apiFetch('/admin/signing/providers', { headers: hdrs() });
          if (r.ok) {
            const data = await r.json();
            _allProviders = Array.isArray(data) && data.length ? data : _PROVIDERS_FALLBACK;
          } else {
            _allProviders = _PROVIDERS_FALLBACK;
          }
        } catch(apiErr) {
          console.warn('[signing] /admin/signing/providers fetch error — using fallback:', apiErr);
          _allProviders = _PROVIDERS_FALLBACK;
        }
      }

      let configSafe = {}, enabledProviders = ['local-upload'];
      try {
        const r2 = await _apiFetch(`/admin/organizations/${orgId}/signing`, { headers: hdrs() });
        if (r2.ok) {
          const j = await r2.json();
          enabledProviders = j.enabled || ['local-upload'];
          configSafe = j.configSafe || {};
        }
      } catch(e2) { /* non-fatal */ }

      _selectedProviders = new Set(enabledProviders);
      renderOrgProvidersGrid(configSafe);
    } catch(e) { console.warn('[signing] loadOrgSigningProviders error:', e); }
  }

  function renderOrgProvidersGrid(configSafe = {}) {
    _orgConfigSafe = configSafe;
    const grid = document.getElementById('orgProvidersGrid');
    if (!_allProviders.length) _allProviders = _PROVIDERS_FALLBACK;
    if (!grid) return;
    grid.innerHTML = '';

    const ICONS = {
      'local-upload': '💻', 'sts-cloud': '🏛️', 'certsign': '📜',
      'transsped': '🔏', 'alfatrust': '🛡️', 'namirial': '✍️',
    };

    for (const p of _allProviders) {
      const isEnabled  = _selectedProviders.has(p.id);
      const isLocal    = p.id === 'local-upload';
      const hasConfig  = p.id === 'sts-cloud'
        ? !!(configSafe[p.id]?.clientId || configSafe[p.id]?.hasPrivateKey)
        : !!(configSafe[p.id]?.hasApiKey);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);';

      const checkId = `provChk_${p.id}`;
      const isStub  = !!p.stub;
      const isLocked = isLocal || isStub;
      row.innerHTML = `
        <input type="checkbox" id="${checkId}" ${isEnabled ? 'checked' : ''} ${isLocked ? 'disabled' : ''}
          ${isStub ? 'title="În dezvoltare — nu activați în producție"' : ''}
          style="width:16px;height:16px;accent-color:#7c5cff;flex-shrink:0;cursor:${isLocked?'not-allowed':'pointer'};opacity:${isStub?'.45':'1'};"
          onchange="toggleOrgProvider('${p.id}', this.checked)"/>
        <span style="font-size:1.1rem;">${ICONS[p.id]||'🔐'}</span>
        <span style="flex:1;font-size:.87rem;font-weight:${isEnabled?'700':'400'};color:${isStub?'rgba(234,240,255,.4)':(isEnabled?'#eaf0ff':'rgba(234,240,255,.45)')};">${p.label}${isStub?' <span style="font-size:.68rem;padding:1px 6px;border-radius:8px;background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.25);margin-left:6px;vertical-align:middle;">în dezvoltare</span>':''}</span>
        ${!isLocal ? `
          <span style="font-size:.72rem;padding:2px 8px;border-radius:10px;background:${hasConfig?'rgba(45,212,191,.12)':'rgba(255,255,255,.05)'};color:${hasConfig?'#2dd4bf':'rgba(234,240,255,.35)'};border:1px solid ${hasConfig?'rgba(45,212,191,.3)':'rgba(255,255,255,.08)'};">
            ${hasConfig ? '✓ configurat' : 'neconfigurat'}
          </span>
          ${isEnabled ? `<button class="df-action-btn sm" onclick="openProviderConfig('${p.id}','${p.label}')" style="background:rgba(124,92,255,.15);border-color:rgba(124,92,255,.3);color:#b39dff;white-space:nowrap;">⚙ Config</button>` : ''}
        ` : '<span style="font-size:.72rem;color:rgba(234,240,255,.3);">implicit</span>'}
      `;
      grid.appendChild(row);
    }
  }

  function toggleOrgProvider(providerId, checked) {
    if (checked) _selectedProviders.add(providerId);
    else         _selectedProviders.delete(providerId);
    _selectedProviders.add('local-upload');
  }

  function openProviderConfig(providerId, label) {
    _activeConfigProvider = providerId;
    const area  = document.getElementById('orgProviderConfigArea');
    const title = document.getElementById('orgProviderConfigTitle');
    const isSts = providerId === 'sts-cloud';

    if (area)  area.style.display = '';
    if (title) title.textContent = `⚙ Configurare: ${label}`;

    const configGeneric = document.getElementById('configGeneric');
    const configSts     = document.getElementById('configSts');
    if (configGeneric) configGeneric.style.display = isSts ? 'none' : '';
    if (configSts)     configSts.style.display     = isSts ? ''     : 'none';

    if (isSts) {
      const saved = (_orgConfigSafe || {})['sts-cloud'] || {};
      const el = id => document.getElementById(id);

      if (el('stsClientId'))   el('stsClientId').value   = saved.clientId   || '';
      if (el('stsKid'))        el('stsKid').value         = saved.kid        || '';
      if (el('stsIdpUrl'))     el('stsIdpUrl').value      = saved.idpUrl     || '';
      if (el('stsApiUrl'))     el('stsApiUrl').value      = saved.apiUrl     || '';
      if (el('stsRedirectUri')) el('stsRedirectUri').value = saved.redirectUri || (window.location.origin + '/flows/sts-oauth-callback');
      if (el('stsPrivateKeyPem')) {
        el('stsPrivateKeyPem').value = '';
        el('stsPrivateKeyPem').placeholder = saved.hasPrivateKey
          ? '● ● ● Cheie privată salvată — introduceți o nouă cheie doar dacă doriți să o schimbați'
          : '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----';
      }
      if (el('stsPublicKeyPem')) {
        el('stsPublicKeyPem').value = saved.publicKeyPem || '';
      }

      const keyGenResult = document.getElementById('stsKeyGenResult');
      if (keyGenResult) keyGenResult.style.display = 'none';
    } else {
      ['orgProviderApiUrl','orgProviderApiKey','orgProviderWebhookSecret'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
    }

    const status = document.getElementById('orgProviderVerifyStatus');
    if (status) status.textContent = '';
    area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function generateStsKeyPair() {
    const btn = document.querySelector('button[onclick="generateStsKeyPair()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Se generează...'; }
    try {
      const r = await _apiFetch('/admin/signing/sts/generate-keypair', {
        method: 'POST', headers: hdrs(),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || 'Eroare generare chei');

      const privEl = document.getElementById('stsPrivateKeyPem');
      if (privEl) privEl.value = j.privateKeyPem;

      const pubEl = document.getElementById('stsPublicKeyDisplay');
      if (pubEl) pubEl.value = j.publicKeyPem;
      const pubStoreEl = document.getElementById('stsPublicKeyPem');
      if (pubStoreEl) pubStoreEl.value = j.publicKeyPem;
      const result = document.getElementById('stsKeyGenResult');
      if (result) result.style.display = '';

      const status = document.getElementById('orgProviderVerifyStatus');
      if (status) { status.style.color = '#2dd4bf'; status.textContent = '✅ Chei generate. Copiați cheia publică și trimiteți-o la STS.'; }
    } catch(e) {
      const status = document.getElementById('orgProviderVerifyStatus');
      if (status) { status.style.color = '#ffaaaa'; status.textContent = '❌ ' + e.message; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚙ Generează pereche chei RSA-2048'; }
    }
  }

  function copyPublicKey() {
    const el = document.getElementById('stsPublicKeyDisplay');
    if (!el) return;
    navigator.clipboard.writeText(el.value).then(() => {
      const btn = document.querySelector('button[onclick="copyPublicKey()"]');
      if (btn) { const orig = btn.textContent; btn.textContent = '✅ Copiat!'; setTimeout(() => btn.textContent = orig, 2000); }
    }).catch(() => { el.select(); document.execCommand('copy'); });
  }

  async function verifyProviderConfig() {
    if (!_activeConfigProvider) return;
    const statusEl = document.getElementById('orgProviderVerifyStatus');
    if (statusEl) { statusEl.textContent = '⏳ Se verifică...'; statusEl.style.color = '#9db0ff'; }
    try {
      let config = {};
      if (_activeConfigProvider === 'sts-cloud') {
        config = {
          clientId:      document.getElementById('stsClientId')?.value?.trim()     || '',
          kid:           document.getElementById('stsKid')?.value?.trim()           || '',
          redirectUri:   document.getElementById('stsRedirectUri')?.value?.trim()   || '',
          privateKeyPem: document.getElementById('stsPrivateKeyPem')?.value?.trim() || '',
          idpUrl:        document.getElementById('stsIdpUrl')?.value?.trim()        || '',
          apiUrl:        document.getElementById('stsApiUrl')?.value?.trim()        || '',
        };
        if (!config.privateKeyPem) {
          const saved = (_orgConfigSafe || {})['sts-cloud'] || {};
          if (saved.hasPrivateKey) config._useStoredPrivateKey = true;
        }
      } else {
        config = {
          apiUrl: document.getElementById('orgProviderApiUrl')?.value || '',
          apiKey: document.getElementById('orgProviderApiKey')?.value || '',
        };
      }
      const r = await _apiFetch('/admin/signing/verify', {
        method: 'POST', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: _activeConfigProvider, config }),
      });
      const j = await r.json();
      if (statusEl) {
        statusEl.textContent = j.ok ? ('✅ ' + (j.message || 'Conexiune OK')) : ('❌ ' + (j.message || j.error));
        statusEl.style.color = j.ok ? '#2dd4bf' : '#ff8a94';
      }
    } catch(e) {
      if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = '#ff8a94'; }
    }
  }

  async function saveOrgSigningProviders(orgId) {
    if (!orgId) return;
    _selectedProviders.add('local-upload');
    const enabled = [..._selectedProviders];
    const config = {};
    if (_activeConfigProvider) {
      if (_activeConfigProvider === 'sts-cloud') {
        const clientId     = document.getElementById('stsClientId')?.value?.trim()     || '';
        const kid          = document.getElementById('stsKid')?.value?.trim()           || '';
        const redirectUri  = document.getElementById('stsRedirectUri')?.value?.trim()   || '';
        const privateKeyPem= document.getElementById('stsPrivateKeyPem')?.value?.trim() || '';
        const idpUrl       = document.getElementById('stsIdpUrl')?.value?.trim()        || '';
        const apiUrl       = document.getElementById('stsApiUrl')?.value?.trim()        || '';
        if (clientId || kid || privateKeyPem) {
          _selectedProviders.add('sts-cloud');
          config['sts-cloud'] = {};
          if (clientId)      config['sts-cloud'].clientId      = clientId;
          if (kid)           config['sts-cloud'].kid           = kid;
          if (redirectUri)   config['sts-cloud'].redirectUri   = redirectUri;
          if (privateKeyPem && !privateKeyPem.startsWith('●')) config['sts-cloud'].privateKeyPem = privateKeyPem;
          const publicKeyPem = document.getElementById('stsPublicKeyPem')?.value?.trim() || '';
          if (publicKeyPem && !publicKeyPem.startsWith('●')) config['sts-cloud'].publicKeyPem = publicKeyPem;
          if (idpUrl)        config['sts-cloud'].idpUrl        = idpUrl;
          if (apiUrl)        config['sts-cloud'].apiUrl        = apiUrl;
        }
      } else {
        const apiUrl  = document.getElementById('orgProviderApiUrl')?.value || '';
        const apiKey  = document.getElementById('orgProviderApiKey')?.value || '';
        const wSecret = document.getElementById('orgProviderWebhookSecret')?.value || '';
        if (apiUrl || apiKey) {
          config[_activeConfigProvider] = {};
          if (apiUrl)   config[_activeConfigProvider].apiUrl = apiUrl;
          if (apiKey)   config[_activeConfigProvider].apiKey = apiKey;
          if (wSecret)  config[_activeConfigProvider].webhookSecret = wSecret;
        }
      }
    }
    try {
      await _apiFetch(`/admin/organizations/${orgId}/signing`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, config }),
      });
    } catch(e) { /* non-fatal */ }
  }

  async function verifySigningProvider() {
    const providerId = document.getElementById('orgSigningProvider')?.value;
    const apiKey     = document.getElementById('orgSigningApiKey')?.value || '';
    const apiUrl     = document.getElementById('orgSigningApiUrl')?.value || '';
    const statusEl   = document.getElementById('orgSigningProviderStatus');
    if (!statusEl) return;
    statusEl.textContent = '⏳ Se verifică...'; statusEl.style.color = '#9db0ff';
    try {
      const r = await _apiFetch('/admin/signing/verify', {
        method: 'POST',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, config: { apiKey, apiUrl } })
      });
      const j = await r.json();
      if (j.ok) {
        statusEl.textContent = '✅ ' + (j.details?.message || 'Provider verificat cu succes.');
        statusEl.style.color = '#2dd4bf';
      } else {
        statusEl.textContent = '❌ ' + (j.message || j.error || 'Eroare verificare.');
        statusEl.style.color = '#ff8a94';
      }
    } catch(e) {
      statusEl.textContent = '❌ Eroare rețea: ' + e.message;
      statusEl.style.color = '#ff8a94';
    }
  }

  // Arată/ascunde config area în funcție de provider selectat
  document.addEventListener('change', e => {
    if (e.target.id === 'orgSigningProvider') {
      const area = document.getElementById('orgSigningConfigArea');
      if (area) area.style.display = e.target.value === 'local-upload' ? 'none' : '';
    }
  });

  // Extinde saveOrgWebhook să salveze și signing provider (legacy — funcție internă)
  const _origSaveOrgWebhook = typeof saveOrgWebhook === 'function' ? saveOrgWebhook : null;
  async function saveOrgWebhookWithSigning() {
    if (_origSaveOrgWebhook) await _origSaveOrgWebhook();
    const providerId = document.getElementById('orgSigningProvider')?.value;
    if (!providerId || !_currentOrgId) return;
    const apiKey = document.getElementById('orgSigningApiKey')?.value || '';
    const apiUrl = document.getElementById('orgSigningApiUrl')?.value || '';
    try {
      await _apiFetch(`/admin/organizations/${_currentOrgId}/signing`, {
        method: 'PUT',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signing_provider: providerId,
          signing_provider_config: { apiKey: apiKey || undefined, apiUrl: apiUrl || undefined }
        })
      });
    } catch(e) { /* non-fatal */ }
  }

  // ── Sub-tab Utilizatori ───────────────────────────────────────────
  async function loadOrgUsersStats(orgId) {
    const wrap = $('orgUsersStats');
    if (!wrap) return;
    wrap.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);">⏳ Se încarcă...</div>';
    try {
      const r = await _apiFetch(`/admin/organizations/${orgId}/stats`, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const s = await r.json();
      const u = s.users || {};
      wrap.innerHTML = [
        _kpiCard('Activi',         u.active || 0,        '#2dd4bf'),
        _kpiCard('Dezactivați',    u.deactivated || 0,   '#ff8a8a'),
        _kpiCard('Admin',          u.admins || 0,        '#b39dff'),
        _kpiCard('Admin Inst.',    u.org_admins || 0,    '#7cf0e0'),
        _kpiCard('Useri',          u.users || 0,         '#eaf0ff'),
      ].join('');
    } catch(e) {
      wrap.innerHTML = `<div style="grid-column:1/-1;color:#ffaaaa;">Eroare: ${esc(e.message)}</div>`;
    }
  }

  function goToUsersTabFiltered() {
    if (!_currentOrgId) return;
    const org = (window._allOrgs || []).find(o => o.id === _currentOrgId);
    if (!org) return;
    if (typeof switchTab === 'function') switchTab('utilizatori');
    setTimeout(() => {
      const f = document.getElementById('fInstitutie');
      if (f) { f.value = org.name; if (typeof filterUsers === 'function') filterUsers(); }
    }, 100);
  }

  function goToUsersTabAddNew() {
    if (!_currentOrgId) return;
    const org = (window._allOrgs || []).find(o => o.id === _currentOrgId);
    if (!org) return;
    if (typeof switchTab === 'function') switchTab('utilizatori');
    setTimeout(() => {
      // Pre-completează numele instituției în formul de creare
      const inst = document.getElementById('nInstitutie');
      if (inst) inst.value = org.name;
      // Scroll la formul de creare (caută tab "Utilizator nou")
      const newTabBtn = document.querySelector('[data-utab="new"], #subtab-new-user');
      if (newTabBtn) newTabBtn.click();
      const sec = document.getElementById('createUserCard') || document.getElementById('tab-utilizatori');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }

  // ── Sub-tab Statistici ─────────────────────────────────────────────
  async function loadOrgStats(orgId) {
    const wrap = $('orgStatsContent');
    if (!wrap) return;
    wrap.innerHTML = '<div style="text-align:center;padding:48px 24px;color:var(--muted);">⏳ Se încarcă statisticile...</div>';
    try {
      const r = await _apiFetch(`/admin/organizations/${orgId}/stats`, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const s = await r.json();
      const u = s.users || {};
      const f = s.flows || {};
      const lastAct = f.last_activity ? new Date(f.last_activity).toLocaleString('ro-RO') : '—';
      const avgH = f.avg_completion_hours != null ? `${f.avg_completion_hours} h` : '—';
      wrap.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px;">
          ${_kpiCard('Total fluxuri',   f.total || 0,     '#eaf0ff')}
          ${_kpiCard('Active',          f.active || 0,    '#7cf0e0')}
          ${_kpiCard('Completate',      f.completed || 0, '#2dd4bf')}
          ${_kpiCard('Refuzate',        f.refused || 0,   '#ffd580')}
          ${_kpiCard('Anulate',         f.cancelled || 0, '#ff8a8a')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px;">
          ${_kpiCard('Ultimele 7 zile',  f.last_7_days || 0,  '#b39dff')}
          ${_kpiCard('Ultimele 30 zile', f.last_30_days || 0, '#b39dff')}
          ${_kpiCard('Useri activi',     u.active || 0,       '#2dd4bf')}
          ${_kpiCard('Useri dezactivați', u.deactivated || 0, '#ff8a8a')}
        </div>
        <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:.85rem;">
          <div><span style="color:var(--muted);">Ultima activitate flux:</span><br><strong style="color:#eaf0ff;">${lastAct}</strong></div>
          <div><span style="color:var(--muted);">Timp mediu completare:</span><br><strong style="color:#eaf0ff;">${avgH}</strong></div>
        </div>`;
    } catch(e) {
      wrap.innerHTML = `<div style="text-align:center;padding:48px 24px;color:#ffaaaa;">Eroare: ${esc(e.message)}</div>`;
    }
  }

  function _kpiCard(label, value, color) {
    return `<div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px;text-align:center;">
      <div style="font-size:1.6rem;font-weight:800;color:${color};line-height:1;margin-bottom:4px;font-variant-numeric:tabular-nums;">${value}</div>
      <div style="font-size:.72rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
    </div>`;
  }

  // ── Compartimente org — state + helpers ──────────────────────────────────

  function _renderCompartimente() {
    const el = $('orgCompartimenteList');
    if (!el) return;
    el.innerHTML = _orgCompartimente.map((c, i) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;background:rgba(124,92,255,.18);border:1px solid rgba(124,92,255,.35);color:#c4b5ff;font-size:.78rem;">
        ${esc(c)}
        <button onclick="_removeCompartiment(${i})" style="background:none;border:none;color:#c4b5ff;cursor:pointer;font-size:.82rem;padding:0;line-height:1;">✕</button>
      </span>`
    ).join('');
  }

  function orgAddCompartiment() {
    const inp = $('orgCompartimenteInput');
    if (!inp) return;
    const val = inp.value.trim();
    if (!val || _orgCompartimente.includes(val)) { inp.value = ''; return; }
    _orgCompartimente.push(val);
    inp.value = '';
    _renderCompartimente();
  }

  function _removeCompartiment(idx) {
    _orgCompartimente.splice(idx, 1);
    _renderCompartimente();
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  function orgGenSecret() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
    $('orgWebhookSecret').value = hex;
    $('orgWebhookSecret').type = 'text';
    setTimeout(() => { if($('orgWebhookSecret')) $('orgWebhookSecret').type = 'password'; }, 5000);
  }

  // Salvează DOAR webhook config (din tab Webhook)
  async function saveOrgWebhook() {
    if (!_currentOrgId) return;
    const msg = $('orgWebhookMsg');
    const events = [];
    if ($('evtCompleted').checked) events.push('flow.completed');
    if ($('evtRefused').checked)   events.push('flow.refused');
    if ($('evtCancelled').checked) events.push('flow.cancelled');
    const body = {
      webhook_url:     $('orgWebhookUrl').value.trim() || null,
      webhook_events:  events,
      webhook_enabled: $('orgWebhookEnabled').checked,
    };
    const secret = $('orgWebhookSecret').value.trim();
    if (secret) body.webhook_secret = secret;
    if (msg) msg.textContent = '⏳ Se salvează...';
    try {
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        if (msg) msg.innerHTML = '<span style="color:#2dd4bf;">✅ Webhook salvat.</span>';
        $('orgWebhookSecret').value = '';
      } else {
        if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  // Salvează DOAR General (CIF + compartimente) — din tab General
  async function saveOrgGeneral() {
    if (!_currentOrgId) return;
    const msg = $('orgGeneralMsg');
    const compInp = $('orgCompartimenteInput');
    if (compInp?.value.trim()) orgAddCompartiment();
    const body = {
      cif:           $('orgCif').value.trim() || null,
      compartimente: _orgCompartimente,
    };
    if (msg) msg.textContent = '⏳ Se salvează...';
    try {
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        if (msg) msg.innerHTML = '<span style="color:#2dd4bf;">✅ Date generale salvate.</span>';
      } else {
        if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  // Salvează DOAR signing providers — din tab Signing Providers
  async function saveOrgSigningOnly() {
    if (!_currentOrgId) return;
    const msg = $('orgSigningMsg');
    _selectedProviders.add('local-upload');
    if (msg) msg.textContent = '⏳ Se salvează...';
    try {
      // saveOrgSigningProviders trimite atât config-ul plain cât și
      // signing_providers_enabled prin endpoint-ul dedicat
      await saveOrgSigningProviders(_currentOrgId);
      // Trimitem și flag-urile enabled prin PUT-ul general
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ signing_providers_enabled: [..._selectedProviders] }),
      });
      if (r.ok) {
        if (msg) msg.innerHTML = '<span style="color:#2dd4bf;">✅ Provideri salvați.</span>';
      } else {
        const j = await r.json().catch(()=>({}));
        if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  async function orgTestWebhook() {
    if (!_currentOrgId) return;
    const msg = $('orgWebhookMsg');
    const url = $('orgWebhookUrl').value.trim();
    if (!url) { if (msg) msg.innerHTML = '<span style="color:#ffd580;">⚠ Introduceți un URL înainte de test.</span>'; return; }
    if (msg) msg.textContent = '⏳ Se trimite eveniment de test...';
    try {
      await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: url }),
      });
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}/test-webhook`, {
        method: 'POST', headers: hdrs(),
      });
      const j = await r.json();
      if (msg) {
        if (j.ok) msg.innerHTML = `<span style="color:#2dd4bf;">✅ ${esc(j.message)} (HTTP ${j.status})</span>`;
        else      msg.innerHTML = `<span style="color:#ffd580;">⚠ ${esc(j.message || j.error)}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  // ── ESC closes assignOrgModal ─────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key==='Escape' && document.getElementById('assignOrgModal')?.style.display==='flex') closeAssignOrg();
  });

  // ── Export onclick + cross-module global ──────────────────────────────────
  window.openChangePwdModal      = openChangePwdModal;
  window.closeChangePwdModal     = closeChangePwdModal;
  window.submitChangePwd         = submitChangePwd;
  window.loadOrganizations       = loadOrganizations;
  window.openOrgModal            = openOrgModal;
  window.closeOrgModal           = closeOrgModal;
  window.openAssignOrg           = openAssignOrg;
  window.closeAssignOrg          = closeAssignOrg;
  window.doAssignOrg             = doAssignOrg;
  window.openOnboardingWizard    = openOnboardingWizard;
  window.closeOnboardingWizard   = closeOnboardingWizard;
  window.doOnboarding            = doOnboarding;
  window.openBulkImportModal     = openBulkImportModal;
  window.closeBulkImportModal    = closeBulkImportModal;
  window.doBulkImport            = doBulkImport;
  window.load2FAStatus           = load2FAStatus;
  window.confirm2FASetup         = confirm2FASetup;
  window.close2FA                = close2FA;
  window.do2FADisable            = do2FADisable;
  window.openRenameOrgModal      = openRenameOrgModal;
  window.closeRenameOrgModal     = closeRenameOrgModal;
  window.doRenameOrg             = doRenameOrg;
  window.openDeleteOrgModal      = openDeleteOrgModal;
  window.closeDeleteOrgModal     = closeDeleteOrgModal;
  window.doDeleteOrg             = doDeleteOrg;
  window.reactivateOrg           = reactivateOrg;
  window.filterOrgsTable         = filterOrgsTable;
  window.onOrgStatusChange       = onOrgStatusChange;
  window.renderOrgsTable         = renderOrgsTable;
  window.loadOrgSigningProviders = loadOrgSigningProviders;
  window.toggleOrgProvider       = toggleOrgProvider;
  window.openProviderConfig      = openProviderConfig;
  window.generateStsKeyPair      = generateStsKeyPair;
  window.copyPublicKey           = copyPublicKey;
  window.verifyProviderConfig    = verifyProviderConfig;
  window.orgGenSecret            = orgGenSecret;
  window.saveOrgWebhook          = saveOrgWebhook;
  window.saveOrgGeneral          = saveOrgGeneral;
  window.saveOrgSigningOnly      = saveOrgSigningOnly;
  window.orgTestWebhook          = orgTestWebhook;
  window.orgAddCompartiment      = orgAddCompartiment;
  window._removeCompartiment     = _removeCompartiment;
  window.openOrgDetail           = openOrgDetail;
  window.closeOrgDetail          = closeOrgDetail;
  window.switchOrgSubTab         = switchOrgSubTab;
  window.loadOrgUsersStats       = loadOrgUsersStats;
  window.loadOrgStats            = loadOrgStats;
  window.goToUsersTabFiltered    = goToUsersTabFiltered;
  window.goToUsersTabAddNew      = goToUsersTabAddNew;

  window.df = window.df || {};
  window.df._organizationsModuleLoaded = true;
})();
