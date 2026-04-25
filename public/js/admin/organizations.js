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
    { id: 'certsign',   label: 'certSIGN / Paperless QES', mode: 'redirect' },
    { id: 'transsped',  label: 'Trans Sped QES', mode: 'redirect' },
    { id: 'alfatrust',  label: 'AlfaTrust / AlfaSign QES', mode: 'redirect' },
    { id: 'namirial',   label: 'Namirial eSignAnyWhere QES', mode: 'redirect' },
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
    const area = $('org-list-area');
    if (!area) return;
    try {
      const r = await _apiFetch('/admin/organizations', { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const orgs = await r.json();
      if (!orgs.length) {
        area.innerHTML = '<div style="color:var(--muted);padding:24px;text-align:center;">Nicio organizație găsită.</div>';
        return;
      }
      area.innerHTML = orgs.map(org => `
        <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
                <div style="font-size:1rem;font-weight:700;color:#eaf0ff;">🏛 ${esc(org.name)}</div>
                ${org.name === 'Default Organization' ? '<span style="font-size:.72rem;padding:2px 8px;background:rgba(255,176,32,.15);border:1px solid rgba(255,176,32,.35);border-radius:10px;color:#ffd580;">⚠ organizație principală — redenumește</span>' : ''}
              </div>
              <div style="font-size:.78rem;color:var(--muted);">
                👥 ${org.user_count} utilizatori &nbsp;·&nbsp; 📁 ${org.flow_count} fluxuri
                ${org.cif ? `&nbsp;·&nbsp; CIF: ${esc(org.cif)}` : ''}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')"
                style="padding:6px 14px;font-size:.78rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:var(--muted);cursor:pointer;">✏️ Redenumește</button>
              <button onclick="openOrgModal(${org.id},'${esc(org.name)}')"
                style="padding:6px 14px;font-size:.78rem;background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.3);border-radius:8px;color:#b39dff;cursor:pointer;">⚙ Configurare</button>
            </div>
          </div>
          <div style="margin-top:14px;font-size:.8rem;">
            ${org.webhook_url ? `
            <div style="color:rgba(234,240,255,.55);">
              🔗 Webhook: <code style="font-size:.76rem;background:rgba(255,255,255,.04);padding:2px 6px;border-radius:4px;">${esc(org.webhook_url)}</code>
              <span style="margin-left:6px;font-size:.7rem;padding:1px 7px;border-radius:8px;background:${org.webhook_enabled?'rgba(45,212,191,.12)':'rgba(255,255,255,.05)'};color:${org.webhook_enabled?'#2dd4bf':'rgba(234,240,255,.35)'};border:1px solid ${org.webhook_enabled?'rgba(45,212,191,.3)':'rgba(255,255,255,.08)'};">${org.webhook_enabled?'activ':'inactiv'}</span>
            </div>
            <div style="color:var(--muted);margin-top:6px;">
              Evenimente: ${(org.webhook_events||[]).join(', ') || '—'}
            </div>` : `
            <span style="color:var(--muted);">⚪ Webhook neconfigurat</span>`}
          </div>
        </div>
      `).join('');
    } catch(e) {
      area.innerHTML = `<div style="color:#ffaaaa;">Eroare: ${esc(e.message)}</div>`;
    }
  }

  // ── Signing Providers — variabile (IIFE-local, declarate în state block sus) ──

  function openOrgModal(id, name) {
    _currentOrgId = id;
    $('orgEditName').textContent = name;
    $('orgWebhookUrl').value = '';
    $('orgWebhookSecret').value = '';
    $('orgWebhookEnabled').checked = false;
    $('evtCompleted').checked = true;
    $('evtRefused').checked = false;
    $('evtCancelled').checked = false;
    $('orgEditMsg').textContent = '';
    $('orgCif').value = '';
    $('orgCompartimenteInput').value = '';
    _orgCompartimente = [];
    _renderCompartimente();
    // Încarcă config curentă
    _apiFetch('/admin/organizations', { headers: hdrs() }).then(r => r.json()).then(orgs => {
      const org = orgs.find(o => o.id === id);
      if (!org) return;
      $('orgWebhookUrl').value = org.webhook_url || '';
      $('orgWebhookEnabled').checked = !!org.webhook_enabled;
      const evts = org.webhook_events || [];
      $('evtCompleted').checked = evts.includes('flow.completed');
      $('evtRefused').checked = evts.includes('flow.refused');
      $('evtCancelled').checked = evts.includes('flow.cancelled');
      $('orgCif').value = org.cif || '';
      _orgCompartimente = Array.isArray(org.compartimente) ? [...org.compartimente] : [];
      _renderCompartimente();
    }).catch(() => {});
    // Încarcă providerii de semnare ai org-ului
    _selectedProviders = new Set(['local-upload']);
    _activeConfigProvider = null;
    loadOrgSigningProviders(id);
    $('orgEditModal').style.display = 'flex';
  }

  function closeOrgModal() {
    $('orgEditModal').style.display = 'none';
    _currentOrgId = null;
  }

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
      row.innerHTML = `
        <input type="checkbox" id="${checkId}" ${isEnabled ? 'checked' : ''} ${isLocal ? 'disabled' : ''}
          style="width:16px;height:16px;accent-color:#7c5cff;flex-shrink:0;cursor:${isLocal?'not-allowed':'pointer'};"
          onchange="toggleOrgProvider('${p.id}', this.checked)"/>
        <span style="font-size:1.1rem;">${ICONS[p.id]||'🔐'}</span>
        <span style="flex:1;font-size:.87rem;font-weight:${isEnabled?'700':'400'};color:${isEnabled?'#eaf0ff':'rgba(234,240,255,.45)'};">${p.label}</span>
        ${!isLocal ? `
          <span style="font-size:.72rem;padding:2px 8px;border-radius:10px;background:${hasConfig?'rgba(45,212,191,.12)':'rgba(255,255,255,.05)'};color:${hasConfig?'#2dd4bf':'rgba(234,240,255,.35)'};border:1px solid ${hasConfig?'rgba(45,212,191,.3)':'rgba(255,255,255,.08)'};">
            ${hasConfig ? '✓ configurat' : 'neconfigurat'}
          </span>
          ${isEnabled ? `<button onclick="openProviderConfig('${p.id}','${p.label}')"
            style="padding:4px 10px;background:rgba(124,92,255,.15);border:1px solid rgba(124,92,255,.3);border-radius:6px;color:#b39dff;cursor:pointer;font-size:.78rem;white-space:nowrap;">⚙ Config</button>` : ''}
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

  async function saveOrgWebhook() {
    if (!_currentOrgId) return;
    const msg = $('orgEditMsg');
    const events = [];
    if ($('evtCompleted').checked) events.push('flow.completed');
    if ($('evtRefused').checked) events.push('flow.refused');
    if ($('evtCancelled').checked) events.push('flow.cancelled');
    _selectedProviders.add('local-upload');
    const compInp = $('orgCompartimenteInput');
    if (compInp?.value.trim()) orgAddCompartiment();
    const body = {
      webhook_url:               $('orgWebhookUrl').value.trim() || null,
      webhook_events:            events,
      webhook_enabled:           $('orgWebhookEnabled').checked,
      signing_providers_enabled: [..._selectedProviders],
      cif:                       $('orgCif').value.trim() || null,
      compartimente:             _orgCompartimente,
    };
    const secret = $('orgWebhookSecret').value.trim();
    if (secret) body.webhook_secret = secret;
    msg.textContent = '⏳ Se salvează...';
    try {
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        await saveOrgSigningProviders(_currentOrgId);
        msg.innerHTML = '<span style="color:#2dd4bf;">✅ Salvat cu succes.</span>';
        setTimeout(() => { closeOrgModal(); loadOrganizations(); }, 800);
      } else {
        msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  async function orgTestWebhook() {
    if (!_currentOrgId) return;
    const msg = $('orgEditMsg');
    const url = $('orgWebhookUrl').value.trim();
    if (!url) { msg.innerHTML = '<span style="color:#ffd580;">⚠ Introduceți un URL înainte de test.</span>'; return; }
    msg.textContent = '⏳ Se trimite eveniment de test...';
    try {
      await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: url }),
      });
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}/test-webhook`, {
        method: 'POST', headers: hdrs(),
      });
      const j = await r.json();
      if (j.ok) {
        msg.innerHTML = `<span style="color:#2dd4bf;">✅ ${esc(j.message)} (HTTP ${j.status})</span>`;
      } else {
        msg.innerHTML = `<span style="color:#ffd580;">⚠ ${esc(j.message || j.error)}</span>`;
      }
    } catch(e) {
      msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
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
  window.loadOrgSigningProviders = loadOrgSigningProviders;
  window.toggleOrgProvider       = toggleOrgProvider;
  window.openProviderConfig      = openProviderConfig;
  window.generateStsKeyPair      = generateStsKeyPair;
  window.copyPublicKey           = copyPublicKey;
  window.verifyProviderConfig    = verifyProviderConfig;
  window.orgGenSecret            = orgGenSecret;
  window.saveOrgWebhook          = saveOrgWebhook;
  window.orgTestWebhook          = orgTestWebhook;
  window.orgAddCompartiment      = orgAddCompartiment;
  window._removeCompartiment     = _removeCompartiment;

  window.df = window.df || {};
  window.df._organizationsModuleLoaded = true;
})();
