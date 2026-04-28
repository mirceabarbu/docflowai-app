// public/js/admin/users.js
// DocFlowAI — Modul Users (Admin) — extras din admin.js (BLOC 1.1 v4 frontend).
// Folosește window.df.* (BLOC 0) pentru utilitare comune.
//
// Dependențe externe (presupuse globale, definite în alt fișier):
//   - _apiFetch        : din admin/core.js (shim CSRF + retry)
//   - hdrs()           : din admin.js (helper headers)
//   - escH()           : din admin.js (alias HTML escape)
//   - showMsg(id,t,e)  : din admin.js (mesaje status)
//   - me, _me          : user curent (din bootstrap admin.js)
//   - validatePhoneClient : din admin.js
//
// State pe window (shared cu alte module admin):
//   - window._allUsers, window._filteredUsers, window._currentUserRole
//   - window._lastCreatedId, window._lastCreatedEmail
//   - window._orgAdminInstitutie

(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;

  // ── State local Users ─────────────────────────────────────────────────────
  const PAGE_SIZE = 10;
  let _currentPage = 1;
  let _filteredUsers = [];
  let _orgList = [];
  let _gwsPreviewTimer = null;
  let editU = null;

  // ── Render helpers ────────────────────────────────────────────────────────
  function renderUsers(users){
    _filteredUsers = users;
    window._filteredUsers = users; // export functions read window._filteredUsers
    _currentPage = 1;
    renderPage();
  }

  function renderPage(){
    const tb=$("tb");
    if(!tb)return;
    const users = _filteredUsers;
    const total = users.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if(_currentPage > totalPages) _currentPage = totalPages;
    const start = (_currentPage-1)*PAGE_SIZE;
    const pageUsers = users.slice(start, start+PAGE_SIZE);

    if(!pageUsers.length){tb.innerHTML='<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--muted);">Niciun rezultat.</td></tr>';
      renderPagination(0,1,1);return;}
    tb.innerHTML="";
    pageUsers.forEach(u=>{
      const tr=document.createElement("tr");
      tr.id="row_"+u.id;
      tr.style.cursor="pointer";
      tr.addEventListener("dblclick", ()=>openEdit(u));
      const dt=u.created_at?new Date(u.created_at).toLocaleDateString("ro-RO"):"—";
      const isMe=u.email===me.email;
      const notifIcons = [
        u.notif_inapp!==false ? '🔔' : '',
        u.notif_email ? '✉️' : '',
        u.notif_whatsapp ? '📱' : ''
      ].filter(Boolean).join(' ');
      const gwsBadge = u.gws_email
        ? `<span title="${esc(u.gws_email)}" style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:8px;font-size:.71rem;font-weight:700;background:rgba(52,168,83,.18);border:1px solid rgba(52,168,83,.4);color:#34A853;white-space:nowrap;">
             <svg width="10" height="10" viewBox="0 0 24 24" fill="#34A853"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
             ${esc(u.gws_email.split('@')[0])}
           </span>`
        : (u.gws_status === 'failed'
            ? `<span title="${esc(u.gws_error||'')}" style="padding:2px 7px;border-radius:8px;font-size:.71rem;font-weight:700;background:rgba(234,67,53,.15);border:1px solid rgba(234,67,53,.35);color:#EA4335;">⚠ eșuat</span>`
            : `<span style="color:var(--muted);font-size:.78rem;">—</span>`
          );
      tr.innerHTML=`
        <td><strong>${esc(u.nume||"—")}</strong>${isMe?' <span style="font-size:.71rem;color:var(--muted)">(tu)</span>':''}</td>
        <td style="color:var(--sub)">${esc(u.functie||"—")}</td>
        <td style="color:var(--muted);font-size:.82rem">${esc(u.institutie||"—")}</td>
        <td style="color:var(--muted);font-size:.82rem">${esc(u.compartiment||"—")}</td>
        <td style="color:var(--muted);font-size:.82rem">${esc(u.email)}</td>
        <td style="color:var(--muted);font-size:.82rem">${esc(u.phone||"—")}</td>
        <td style="font-size:.9rem;text-align:center">${notifIcons||'—'}</td>
        <td>${gwsBadge}</td>
        <td><span class="pill ${u.role}">${u.role==="org_admin"?"Admin Instituție":u.role==="admin"?"Admin":"User"}</span></td>
        <td style="color:var(--muted);font-size:.79rem">${dt}</td>
        <td style="text-align:right;white-space:nowrap">
          <div style="display:flex;gap:3px;justify-content:flex-end;">
            <button class="df-action-btn sm" onclick='openEdit(${JSON.stringify(u)})' title="Editează">✏</button>
            <button class="df-action-btn warning sm" id="btnSend_${u.id}" onclick="sendCreds(${u.id},this)" title="Trimite credențiale">✉</button>
            ${!u.gws_email?`<button class="df-action-btn sm" onclick="gwsRetry(${u.id},this)" title="Creează cont Workspace" style="background:rgba(66,133,244,.15);border-color:rgba(66,133,244,.4);color:#4285F4;">G+</button>`:''}
            ${(window._currentUserRole==='admin' && !u.org_id && u.role!=='admin')?`<button class="df-action-btn sm" onclick="openAssignOrg(${u.id},'${esc(u.nume||u.email)}')" title="Asignează organizație (org_id lipsă)" style="background:rgba(255,176,32,.15);border-color:rgba(255,176,32,.4);color:#ffd580;">🏛</button>`:''}
            ${!isMe?`<button class="df-action-btn danger sm" onclick="delUser(${u.id},'${esc(u.nume||u.email)}')" title="Șterge">✕</button>`:""}
          </div>
        </td>`;
      tb.appendChild(tr);
    });
    renderPagination(total, _currentPage, totalPages);
  }

  function renderPagination(total, current, totalPages){
    let pg = $('pgBar');
    if(!pg){ pg=document.createElement('div'); pg.id='pgBar'; pg.className='pagination';
      const wrap=$('pgBarWrapper') || $('tbl'); if(wrap) wrap.appendChild(pg); }
    pg.innerHTML='';
    if(totalPages<=1 && total<=PAGE_SIZE){return;}
    const info=document.createElement('span'); info.className='pg-info';
    info.textContent=`${Math.min((current-1)*PAGE_SIZE+1,total)}–${Math.min(current*PAGE_SIZE,total)} din ${total}`;
    const prev=document.createElement('button'); prev.className='pg-btn'; prev.textContent='◀';
    prev.disabled=current<=1; prev.onclick=()=>{_currentPage--;renderPage();};
    pg.appendChild(prev); pg.appendChild(info);
    for(let p=1;p<=totalPages;p++){
      if(totalPages>7&&Math.abs(p-current)>2&&p!==1&&p!==totalPages){
        if(p===2||p===totalPages-1){const d=document.createElement('span');d.className='pg-info';d.textContent='…';pg.appendChild(d);}
        continue;
      }
      const b=document.createElement('button'); b.className='pg-btn'+(p===current?' active':'');
      b.textContent=p; b.onclick=(pp=>()=>{_currentPage=pp;renderPage();})(p);
      pg.appendChild(b);
    }
    const next=document.createElement('button'); next.className='pg-btn'; next.textContent='▶';
    next.disabled=current>=totalPages; next.onclick=()=>{_currentPage++;renderPage();};
    pg.appendChild(next);
  }

  // ── org_admin: blochează toate filtrele de instituție ─────────────────────
  function lockOrgAdminFilters(institutie) {
    // Ascunde secțiunile periculoase ÎNTOTDEAUNA pentru org_admin,
    // indiferent dacă institutie e populat sau nu.
    // BUG-FIX b80: if (!institutie) return era prea devreme — org_admin fără
    // institutie vedea ⚠ Administrare fluxuri și 🧹 VACUUM.
    const adminFluxSection = $('adminFluxSection');
    if (adminFluxSection) adminFluxSection.style.display = 'none';

    if (!institutie) return;
    const lock = (el, val) => {
      if (!el) return;
      // input
      if (el.tagName === 'INPUT') {
        el.value = val;
        el.readOnly = true;
        el.style.cssText += ';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;';
      }
      // select
      if (el.tagName === 'SELECT') {
        // Adăugăm opțiunea dacă nu există
        let found = false;
        for (const o of el.options) { if (o.value === val) { found = true; break; } }
        if (!found) { const o = new Option(val, val); el.appendChild(o); }
        el.value = val;
        el.disabled = true;
        el.style.cssText += ';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;';
      }
    };
    // Tab Utilizatori — formular creare
    lock($('nInstitutie'), institutie);
    // Tab Utilizatori — filtrul din capul tabelului
    const fI = $('fInstitutie');
    if (fI) { fI.value = institutie; fI.readOnly = true; fI.style.cssText += ';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;'; filterUsers(); }
    // Tab Fluxuri — flowInstFilter
    lock($('flowInstFilter'), institutie);
    // Tab Fluxuri — archiveInstFilter
    lock($('archiveInstFilter'), institutie);
    // Tab Fluxuri — delInstFilter (ștergere vechi)
    lock($('delInstFilter'), institutie);
    // (vacuumCard și delAllCard sunt în interiorul adminFluxSection — ascunse la începutul funcției)
    // Tab Rapoarte — rptInst
    lock($('rptInst'), institutie);
  }

  // BUG-FIX: org_admin poate crea/edita utilizatori doar cu rol 'user'.
  // Filtrăm dropdown-urile #nRole și #eRole să afișeze/permită doar 'user'.
  // Backend-ul enforced la linia 178 din admin.mjs, dar UI-ul trebuie să reflecte corect.
  function _lockRoleDropdownsForOrgAdmin() {
    // Dropdown creare user (#nRole): păstrăm doar 'user', forțăm valoarea
    const nRoleEl = $('nRole');
    if (nRoleEl) {
      // Eliminăm opțiunile 'org_admin' și 'admin'
      for (let i = nRoleEl.options.length - 1; i >= 0; i--) {
        if (nRoleEl.options[i].value !== 'user') nRoleEl.remove(i);
      }
      nRoleEl.value = 'user';
      nRoleEl.disabled = true;
      nRoleEl.style.background = 'rgba(45,212,191,.08)';
      nRoleEl.style.borderColor = 'rgba(45,212,191,.3)';
      nRoleEl.style.color = '#2dd4bf';
      nRoleEl.style.cursor = 'not-allowed';
    }
    // Dropdown editare user (#eRole): eliminăm opțiunile superioare
    const eRoleEl = $('eRole');
    if (eRoleEl) {
      for (let i = eRoleEl.options.length - 1; i >= 0; i--) {
        if (eRoleEl.options[i].value !== 'user') eRoleEl.remove(i);
      }
      eRoleEl.value = 'user';
    }
  }

  function onRoleChange(role) {
    const row = $('nOrgRow');
    if (!row) return;
    // Super-admin vede selectorul de org pentru ORICE rol (user, org_admin, admin)
    // org_admin vede selectorul doar pentru org_admin (nu poate crea în altă org)
    const isSuperAdmin = window._currentUserRole === 'admin';
    if (role === 'org_admin' || isSuperAdmin) {
      row.style.display = '';
      // Actualizăm label-ul — obligatoriu doar pentru org_admin
      const lbl = row.querySelector('label');
      if (lbl) {
        if (role === 'org_admin') {
          lbl.innerHTML = 'Organizație <span style="color:#ff8080;">*</span> <span style="color:var(--muted);font-size:.71rem;">— existentă sau nouă</span>';
        } else {
          lbl.innerHTML = 'Organizație <span style="color:var(--muted);font-size:.71rem;">— opțional, asociază userul la o org</span>';
        }
      }
      loadOrganizationsAutocomplete();
    } else {
      row.style.display = 'none';
      if ($('nOrgName')) $('nOrgName').value = '';
      if ($('nOrgHint')) $('nOrgHint').style.display = 'none';
    }
  }

  async function loadOrganizationsAutocomplete() {
    if (_orgList.length) return; // deja încărcat
    try {
      const r = await _apiFetch('/admin/organizations', { headers: hdrs() });
      if (!r.ok) return;
      _orgList = await r.json();
      const dl = $('orgNameList');
      if (dl) dl.innerHTML = _orgList.map(o => `<option value="${escH(o.name)}">`).join('');
      // Attach input listener pentru hint
      const inp = $('nOrgName');
      if (inp) inp.addEventListener('input', _updateOrgHint);
    } catch(e) { /* ignore */ }
  }

  function _updateOrgHint() {
    const val = ($('nOrgName')?.value || '').trim();
    const hint = $('nOrgHint');
    if (!hint) return;
    if (!val) { hint.style.display = 'none'; return; }
    const existing = _orgList.find(o => o.name.toLowerCase() === val.toLowerCase());
    if (existing) {
      hint.textContent = `✅ Organizație existentă (ID: ${existing.id}) — userul va fi asociat automat`;
      hint.style.color = '#2dd4bf';
    } else {
      hint.textContent = `🆕 Organizație nouă — va fi creată automat la salvare`;
      hint.style.color = '#ffd580';
    }
    hint.style.display = '';
  }

  function filterUsers(){
    if(!window._allUsers)return;
    const fN=($('fNume')||{value:''}).value.toLowerCase();
    const fF=($('fFunctie')||{value:''}).value.toLowerCase();
    const fI=($('fInstitutie')||{value:''}).value.toLowerCase();
    const fE=($('fEmail')||{value:''}).value.toLowerCase();
    const fC=($('fCompartiment')||{value:''}).value.toLowerCase();
    const fR=($('fRol')||{value:''}).value.toLowerCase();
    const filtered=window._allUsers.filter(u=>
      (!fN||( u.nume||'').toLowerCase().includes(fN))&&
      (!fF||(u.functie||'').toLowerCase().includes(fF))&&
      (!fI||(u.institutie||'').toLowerCase().includes(fI))&&
      (!fE||(u.email||'').toLowerCase().includes(fE))&&
      (!fC||(u.compartiment||'').toLowerCase().includes(fC))&&
      (!fR||(u.role||'').toLowerCase()===fR)
    );
    _currentPage=1;
    renderUsers(filtered);
  }

  async function loadUsers(){
    try{
      const r=await _apiFetch("/admin/users",{headers:hdrs()});
      if(r.status===401){logout();return;}
      if(!r.ok){
        const err=await r.json().catch(()=>({}));
        const msg = r.status===403 && err.message ? err.message : (err.error||'Eroare '+r.status);
        $("tbl").innerHTML=`<div class="empty" style="color:#ffaaaa;">⚠️ ${escH(msg)}</div>`;
        return;
      }
      const users=await r.json();
      $("cnt").textContent="("+users.length+")";
      const countEl=$("usersListCount"); if(countEl) countEl.textContent=String(users.length);
      const el=$("tbl");
      if(!users.length){el.innerHTML='<div class="empty">Niciun utilizator.</div>';return;}
      el.innerHTML=`<table><colgroup><col/><col/><col/><col/><col/><col/><col/><col/><col/><col/><col/></colgroup><thead>
        <tr>
          <th>Nume și prenume</th><th>Funcție</th><th>Instituție</th><th>Compartiment</th><th>Email</th><th>Tel.</th><th>Notif.</th><th>Workspace</th><th>Rol</th><th>Creat</th><th style="text-align:right">Acțiuni</th>
        </tr>
        <tr id="filterRow">
          <th><input class="th-filter" placeholder="Filtrează..." oninput="filterUsers()" id="fNume"/></th>
          <th><input class="th-filter" placeholder="Filtrează..." oninput="filterUsers()" id="fFunctie"/></th>
          <th><input class="th-filter" placeholder="Filtrează..." oninput="filterUsers()" id="fInstitutie"/></th>
          <th><input class="th-filter" placeholder="Filtrează..." oninput="filterUsers()" id="fCompartiment"/></th>
          <th><input class="th-filter" placeholder="Filtrează..." oninput="filterUsers()" id="fEmail"/></th>
          <th></th><th></th><th></th>
          <th><select class="th-filter" onchange="filterUsers()" id="fRol" style="padding:4px 6px;">
            <option value="">Toate</option>
            <option value="admin">Admin</option>
            <option value="org_admin">Admin Instituție</option>
            <option value="user">User</option>
          </select></th>
          <th></th><th></th>
        </tr>
      </thead><tbody id="tb"></tbody></table>`;
      window._allUsers = users;
      const tb=$("tb");
      // Populează datalist instituții cu valori unice din useri existenți
      const dl=$("institutieList");
      if(dl){
        const unique=[...new Set(users.map(u=>u.institutie||"").filter(Boolean))].sort();
        dl.innerHTML=unique.map(i=>`<option value="${esc(i)}">`).join("");
      }
      const dlF=$("functieList");
      if(dlF){
        const uniqueF=[...new Set(users.map(u=>u.functie||"").filter(Boolean))].sort();
        dlF.innerHTML=uniqueF.map(f=>`<option value="${esc(f)}">`).join("");
      }
      const dlC=$("compartimentList");
      if(dlC){
        const uniqueC=[...new Set(users.map(u=>u.compartiment||"").filter(Boolean))].sort();
        dlC.innerHTML=uniqueC.map(c=>`<option value="${esc(c)}">`).join("");
      }
      renderUsers(users);
    }catch(e){$("tbl").innerHTML=`<div class="empty" style="color:#ffaaaa;">Eroare: ${escH(e.message)}</div>`;}
  }

  // ── GWS preview live ───────────────────────────────────────────────────────
  function onGwsToggle() {
    const checked = $('nCreateGws').checked;
    $('nForcePwdLabel').style.display = checked ? 'flex' : 'none';
    $('gwsPreview').style.display     = checked ? 'block' : 'none';
    // Când Workspace e activ: emailul de login = cel generat @docflowai.ro → ascundem câmpul manual
    $('nEmailRow').style.display      = checked ? 'none' : '';
    if (checked) {
      // Email personal devine destinația credențialelor
      $('nPersonalEmailHint').textContent = '— credențialele se trimit aici';
      $('nPersonalEmailHint').style.color = '#ffd580';
    } else {
      $('nPersonalEmailHint').textContent = '— opțional';
      $('nPersonalEmailHint').style.color = '';
    }
    if (checked) updateGwsPreview();
  }

  function updateGwsPreview() {
    if (!$('nCreateGws') || !$('nCreateGws').checked) return;
    clearTimeout(_gwsPreviewTimer);
    _gwsPreviewTimer = setTimeout(_fetchGwsPreview, 450);
  }

  async function _fetchGwsPreview() {
    const prenume = ($('nPrenume').value||'').trim();
    const fam     = ($('nNumeFamilie').value||'').trim();
    if (!prenume && !fam) { $('gwsPreviewEmail').textContent = '—'; return; }
    $('gwsPreviewSpin').style.display = 'inline';
    try {
      const r = await _apiFetch(`/admin/gws/preview-email?prenume=${encodeURIComponent(prenume)}&nume_familie=${encodeURIComponent(fam)}`, { headers: hdrs() });
      const d = await r.json();
      if (!r.ok) { $('gwsPreviewEmail').textContent = r.status === 403 ? '⚠️ Acces interzis' : '⚠️ Eroare ' + r.status; }
      else if (!d.configured) { $('gwsPreviewEmail').textContent = '⚠️ GWS neconfigurat'; }
      else if (d.error)  { $('gwsPreviewEmail').textContent = '⚠️ ' + d.error; }
      else               { $('gwsPreviewEmail').textContent = d.email; }
    } catch(e) { $('gwsPreviewEmail').textContent = '—'; }
    finally { $('gwsPreviewSpin').style.display = 'none'; }
  }

  // ── Verificare conectivitate Google Workspace (v4 backend feature) ─────────
  async function verifyGws() {
    const btn = document.getElementById('btnGwsVerify');
    if (!btn) return;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Verificare...';
    try {
      const r = await _apiFetch('/admin/gws/verify', { headers: hdrs() });
      const j = await r.json();
      if (r.status === 403) {
        alert('⚠️ Verificare Google Workspace permisă doar pentru super-admin.');
      } else if (j.ok) {
        const details = [];
        if (j.domain) details.push(`Domeniu: ${j.domain}`);
        if (j.adminEmail) details.push(`Admin: ${j.adminEmail}`);
        if (j.userCount != null) details.push(`Utilizatori existenți: ${j.userCount}`);
        alert(`✅ Google Workspace: conexiune OK\n\n${details.join('\n') || 'Serviciul răspunde corect.'}`);
      } else {
        alert(`❌ Google Workspace: conexiune eșuată\n\n${j.error || j.message || 'Verifică credențialele service account în config.'}`);
      }
    } catch (e) {
      alert(`❌ Eroare verificare: ${e.message}`);
    }
    btn.disabled = false;
    btn.textContent = origText;
  }

  async function createUser(){
    const prenume    = ($('nPrenume')||{value:''}).value.trim();
    const numeFamilie= ($('nNumeFamilie')||{value:''}).value.trim();
    const numeComplet= [numeFamilie, prenume].filter(Boolean).join(' ');
    const functie    = $('nFunctie').value.trim();
    const create_gws = !!($('nCreateGws')?.checked);
    // Dacă Workspace e activ, emailul de login = cel generat @docflowai.ro (trimis de backend)
    // Dacă nu, adminul îl introduce manual
    const emailManual = create_gws ? '' : ($('nEmail')||{value:''}).value.trim();
    const pwd        = $('nPwd').value.trim();
    const role       = $('nRole').value;
    if (!numeComplet) { showMsg('createMsg','Prenumele și numele sunt obligatorii.',true); return; }
    if (!create_gws && !emailManual) { showMsg('createMsg','Completează emailul de login.',true); return; }
    const btn=$('btnCreate'); btn.disabled=true; btn.textContent='Se creează...';
    const institutie  = $('nInstitutie').value.trim();
    const compartiment= $('nCompartiment').value.trim();
    const phone       = $('nPhone').value.trim();
    if (!validatePhoneClient(phone).valid) { alert('Număr de telefon invalid.\nEx: 0712345678 sau +40712345678'); $('nPhone').focus(); btn.disabled=false; btn.textContent='Crează utilizatorul'; return; }
    const notif_inapp    = $('nNotifInapp').checked;
    const notif_email    = $('nNotifEmail').checked;
    const notif_whatsapp = $('nNotifWa').checked;
    const personal_email = ($('nPersonalEmail')||{value:''}).value.trim();
    const force_password_change = !!($('nForcePwd')?.checked);

    const org_name = ($('nOrgName')?.value || '').trim();
    if (role === 'org_admin' && !org_name) { showMsg('createMsg','Completați organizația pentru Admin Instituție.',true); btn.disabled=false; btn.textContent='Crează utilizatorul'; return; }
    const body = {
      email: emailManual,
      password: pwd, nume: numeComplet, prenume, nume_familie: numeFamilie,
      functie, institutie, compartiment, role, phone,
      notif_inapp, notif_email, notif_whatsapp,
      personal_email: personal_email || undefined,
      create_gws, force_password_change,
      gws_as_login: create_gws,
      org_name: org_name || undefined,
    };
    const r = await _apiFetch('/admin/users', {method:'POST', headers:hdrs(), body:JSON.stringify(body)});
    const d = await r.json();
    btn.disabled=false; btn.textContent='Crează utilizatorul';
    if(r.ok){
      window._lastCreatedId    = d.id;
      window._lastCreatedEmail = d.email;  // emailul real din DB (poate fi cel @docflowai.ro)
      $('nPrenume').value=$('nNumeFamilie').value=$('nFunctie').value=
      ($('nEmail')||{}).value=$('nPwd').value=$('nInstitutie').value=
      $('nCompartiment').value=$('nPhone').value=($('nPersonalEmail')||{}).value='';
      if($('nCreateGws')) $('nCreateGws').checked=false;
      if($('nOrgName')) $('nOrgName').value='';
      onGwsToggle();
      onRoleChange('user');
      // Re-aplică instituția pentru org_admin după reset form
      if(window._orgAdminInstitutie && $('nInstitutie')){
        $('nInstitutie').value=window._orgAdminInstitutie;
      }
      loadUsers();
      showPwdModal(d);
    }else{
      const m={
        email_exists:'Emailul există deja.',
        email_and_nume_required:'Completează prenumele, numele și emailul.',
        gws_email_required:'Workspace bifat dar nu s-a putut genera emailul. Verifică prenumele și numele.',
      };
      showMsg('createMsg', m[d.error]||'Eroare: '+(d.detail||d.error), true);
    }
  }

  function showPwdModal(d) {
    // Titlu diferit dacă e retrimis vs creat prima oară
    const isSend = !!d._isSend;
    const titleEl = $('pwdModalBg').querySelector('h3');
    if(titleEl) titleEl.textContent = isSend ? 'Credențiale resetate și trimise' : 'Utilizator creat cu succes';
    const subtitleEl = $('pwdModalBg').querySelector('p');
    if(subtitleEl) subtitleEl.innerHTML = isSend
      ? 'O parolă nouă a fost generată și trimisă pe email.<br>Dacă emailul <strong style="color:#fff;">nu ajunge</strong>, comunică parola de mai jos direct utilizatorului.'
      : 'Parola temporară este afișată <strong style="color:#fff;">o singură dată</strong>.<br>Notează-o sau trimite credențialele pe email.';

    $('pwdModalEmail').textContent = d.email || window._lastCreatedEmail || '';
    // Arată destinația emailului dacă diferă de login
    const dest = d.credentials_sent_to || d.email || window._lastCreatedEmail;
    const login = d.email || window._lastCreatedEmail;
    if (dest && dest !== login) {
      $('pwdModalDestRow').style.display = 'block';
      $('pwdModalDest').textContent = dest;
    } else {
      $('pwdModalDestRow').style.display = 'none';
    }
    const shownPwd = d.tempPassword || d.temporaryPassword || d.password || '';
    $('pwdModalPwd').textContent = shownPwd || '(trimis pe email)';
    // Butonul "Trimite pe email" — ascuns dacă tocmai am trimis
    $('btnPwdModalSend').style.display = isSend ? 'none' : '';
    // GWS status
    if (d.gws && d.gws.ok) {
      $('pwdModalGws').style.display     = 'block';
      $('pwdModalGwsFail').style.display = 'none';
      $('pwdModalGwsEmail').textContent  = d.gws.gws_email;
    } else if (d.gws && !d.gws.ok) {
      $('pwdModalGws').style.display     = 'none';
      $('pwdModalGwsFail').style.display = 'block';
      $('pwdModalGwsErr').textContent    = d.gws.error || 'eroare necunoscută';
    } else {
      $('pwdModalGws').style.display     = 'none';
      $('pwdModalGwsFail').style.display = 'none';
    }
    $('btnCopyPwd').textContent = '📋 Copiază';
    $('pwdModalBg').classList.add('open');
  }

  function closePwdModal() {
    $('pwdModalBg').classList.remove('open');
  }

  function copyPwd() {
    const pwd = $('pwdModalPwd').textContent;
    navigator.clipboard.writeText(pwd).then(() => {
      $('btnCopyPwd').textContent = '✓ Copiat!';
      setTimeout(() => { $('btnCopyPwd').textContent = '📋 Copiază'; }, 2000);
    }).catch(() => {
      // Fallback pentru browsere fără clipboard API
      const ta = document.createElement('textarea');
      ta.value = pwd; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      $('btnCopyPwd').textContent = '✓ Copiat!';
      setTimeout(() => { $('btnCopyPwd').textContent = '📋 Copiază'; }, 2000);
    });
  }

  async function sendCredsFromModal() {
    const id = window._lastCreatedId;
    if (!id) return;
    closePwdModal();
    // sendCreds va deschide din nou modalul cu parola resetată și titlul "Credențiale resetate"
    await sendCreds(id, null);
  }

  async function gwsRetry(userId, btn) {
    if (!confirm('Creează cont Google Workspace pentru acest utilizator?')) return;
    if (btn) { btn.disabled=true; btn.textContent='...'; }
    try {
      const r = await _apiFetch(`/admin/users/${userId}/gws-provision`, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ force_password_change: true })
      });
      const d = await r.json();
      if (r.ok) {
        alert('✅ Cont Workspace creat: ' + d.gws_email);
        loadUsers();
      } else {
        const m = { already_provisioned: 'Userul are deja un cont Workspace: ' + d.gws_email,
                    gws_not_configured: 'Google Workspace nu este configurat (variabile de mediu lipsesc).' };
        alert('⚠️ ' + (m[d.error] || d.detail || d.error));
        if (btn) { btn.disabled=false; btn.textContent='G+'; }
      }
    } catch(e) {
      alert('Eroare: ' + e.message);
      if (btn) { btn.disabled=false; btn.textContent='G+'; }
    }
  }

  function openEdit(u){
    editU=u;
    $("eId").value=u.id;
    $("ePrenume").value=u.prenume||u.nume?.split(' ')[0]||"";
    $("eNumeFamilie").value=u.nume_familie||u.nume?.split(' ').slice(1).join(' ')||"";
    $("eFunctie").value=u.functie||"";
    $("eInstitutie").value=u.institutie||"";
    $("eCompartiment").value=u.compartiment||"";
    $("eEmail").value=u.email;
    $("ePersonalEmail").value=u.personal_email||"";
    $("eRole").value=u.role;
    $("ePwd").value="";
    $("ePhone").value=u.phone||"";
    $("eNotifInapp").checked=u.notif_inapp!==false;
    $("eNotifEmail").checked=!!u.notif_email;
    $("eNotifWa").checked=!!u.notif_whatsapp;
    // org_admin: blochează câmpul Instituție și Rol
    const eInst=$("eInstitutie"); const eRoleEl=$("eRole");
    if(window._orgAdminInstitutie){
      if(eInst){eInst.readOnly=true;eInst.style.background='rgba(45,212,191,.08)';eInst.style.borderColor='rgba(45,212,191,.3)';eInst.style.color='#2dd4bf';eInst.style.cursor='not-allowed';}
      if(eRoleEl){eRoleEl.disabled=true;eRoleEl.style.background='rgba(45,212,191,.08)';eRoleEl.style.borderColor='rgba(45,212,191,.3)';eRoleEl.style.color='#2dd4bf';}
    } else {
      if(eInst){eInst.readOnly=false;eInst.style.background='';eInst.style.borderColor='';eInst.style.color='';eInst.style.cursor='';}
      if(eRoleEl){eRoleEl.disabled=false;eRoleEl.style.background='';eRoleEl.style.borderColor='';eRoleEl.style.color='';}
    }
    // GWS status
    if(u.gws_email){
      $("eGwsRow").style.display="block";
      $("eGwsEmail").textContent=u.gws_email;$("eGwsEmail").style.display="";
      $("eGwsFail").style.display="none";
    } else if(u.gws_status==="failed"){
      $("eGwsRow").style.display="block";
      $("eGwsEmail").style.display="none";
      $("eGwsFail").style.display="";$("eGwsFail").textContent="⚠ Provision eșuat — folosește butonul G+ din tabel";
    } else { $("eGwsRow").style.display="none"; }
    $("eMsg").textContent="";$("eMsg").className="";
    // BLOC 4.2 — populează secțiunea concediu/delegare
    if (typeof _loadLeaveSection === 'function') _loadLeaveSection(u.id, u.org_id);
    $("mBg").classList.add("open");$("ePrenume").focus();
  }

  function closeMod(){$("mBg").classList.remove("open");editU=null;}

  async function genPwd(){
    if(!editU)return;
    const btn = document.querySelector('button[onclick="genPwd()"]');
    if(btn){ btn.disabled=true; btn.textContent='⏳...'; }
    try {
      const r=await _apiFetch("/admin/users/"+editU.id+"/reset-password",{method:"POST",headers:hdrs()});
      const d=await r.json();
      if(r.ok){
        $("ePwd").value = d.tempPassword || d.temporaryPassword || "";
        $("eMsg").className="msg ok";
        $("eMsg").textContent = d.message || "✅ Parolă nouă generată și trimisă pe emailul utilizatorului.";
        window._lastCreatedId = editU.id;
        window._lastCreatedEmail = d.email || editU.email;
        showPwdModal({
          email: d.email || editU.email,
          tempPassword: d.tempPassword || d.temporaryPassword || '',
          credentials_sent_to: d.credentials_sent_to || d.email || editU.email,
          _isSend: true
        });
      } else {
        $("eMsg").className="msg err";
        $("eMsg").textContent = "❌ " + (d.message || d.error || "Eroare la generare parolă.");
      }
    } catch(e) {
      $("eMsg").className="msg err";
      $("eMsg").textContent = "❌ " + e.message;
    } finally {
      if(btn){ btn.disabled=false; btn.textContent='🔄 Generează parolă'; }
    }
  }

  async function saveEdit(){
    const id=$("eId").value;
    const prenume=$("ePrenume").value.trim();
    const numeFamilie=$("eNumeFamilie").value.trim();
    const numeComplet=[numeFamilie,prenume].filter(Boolean).join(' ');
    const body={
      email:$("eEmail").value.trim(),
      nume:numeComplet, prenume, nume_familie:numeFamilie,
      functie:$("eFunctie").value.trim(),
      institutie:$("eInstitutie").value.trim(),
      compartiment:$("eCompartiment").value.trim(),
      role:$("eRole").value,
      phone:$("ePhone").value.trim(),
      personal_email:$("ePersonalEmail").value.trim()||null,
      notif_inapp:$("eNotifInapp").checked,
      notif_email:$("eNotifEmail").checked,
      notif_whatsapp:$("eNotifWa").checked
    };
    const p=$("ePwd").value.trim(); if(p) body.password=p;
    const r=await _apiFetch("/admin/users/"+id,{method:"PUT",headers:hdrs(),body:JSON.stringify(body)});
    const d=await r.json();
    if(r.ok){closeMod();loadUsers();}
    else{$("eMsg").className="msg err";$("eMsg").textContent=d.error==="email_exists"?"Emailul există deja.":"Eroare.";}
  }

  async function sendCreds(id, btn){
    const orig = btn ? btn.textContent : "";
    if(btn){ btn.disabled=true; btn.textContent="Se trimite..."; }
    try{
      const r = await _apiFetch("/admin/users/"+id+"/send-credentials", {method:"POST", headers:hdrs()});
      const d = await r.json();
      if(r.ok){
        if(btn){ btn.textContent="✅"; setTimeout(()=>{ btn.disabled=false; btn.textContent=orig; }, 3000); }
        // Afișăm parola nouă în modal — fallback dacă emailul nu ajunge
        window._lastCreatedId    = id;
        window._lastCreatedEmail = d.email;
        showPwdModal({
          email: d.email,
          tempPassword: d.tempPassword || d.temporaryPassword || '',
          credentials_sent_to: d.credentials_sent_to || d.email,
          _isSend: true
        });
      }else{
        const m = { user_not_found:"Utilizatorul nu a fost găsit." };
        if(btn){ btn.disabled=false; btn.textContent=orig; }
        alert(m[d.error] || "Eroare: " + (d.error||"necunoscută"));
      }
    }catch(e){ if(btn){ btn.disabled=false; btn.textContent=orig; } alert("Eroare de rețea."); }
  }

  async function sendCredsNew(){
    if(!window._lastCreatedId)return;
    await sendCreds(window._lastCreatedId,$("btnSendNew"));
  }

  // ── Export funcții onclick global ─────────────────────────────────────────
  window.lockOrgAdminFilters          = lockOrgAdminFilters;
  window._lockRoleDropdownsForOrgAdmin = _lockRoleDropdownsForOrgAdmin;
  // ═════════════════════════════════════════════════════════════════════════
  // LEAVE / DELEGATION (BLOC 4.2)
  // ═════════════════════════════════════════════════════════════════════════

  var _leaveTargetUserId = null;
  var _leaveAllUsers = [];

  async function _loadLeaveSection(userId, userOrgId) {
    _leaveTargetUserId = userId;
    var msg = document.getElementById('eLeaveMsg');
    if (msg) { msg.textContent = ''; msg.className = ''; msg.style.color = ''; }

    try {
      var r = await _apiFetch('/users');
      _leaveAllUsers = r.ok ? await r.json() : [];
    } catch(e) { _leaveAllUsers = []; }

    var sel = document.getElementById('eLeaveDelegate');
    if (sel) {
      while (sel.options.length > 1) sel.remove(1);
      var candidates = _leaveAllUsers.filter(function(u) {
        if (u.id === userId) return false;
        // org_id nu e filtrat — GET /users returnează deja useri din aceeași instituție
        if (u.leave && u.leave.delegate) return false; // NO CHAIN
        return true;
      });
      candidates.sort(function(a, b) { return (a.nume || '').localeCompare(b.nume || '', 'ro'); });
      candidates.forEach(function(u) {
        var opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
        sel.appendChild(opt);
      });
    }

    var me = _leaveAllUsers.find(function(u) { return u.id === userId; });
    var leave = me ? me.leave : null;
    var eStart = document.getElementById('eLeaveStart');
    var eEnd = document.getElementById('eLeaveEnd');
    var eDel = document.getElementById('eLeaveDelegate');
    var eReason = document.getElementById('eLeaveReason');
    if (eStart) eStart.value = (leave && leave.leaveStart) ? leave.leaveStart : '';
    if (eEnd) eEnd.value = (leave && leave.leaveEnd) ? leave.leaveEnd : '';
    if (eDel) eDel.value = (leave && leave.delegate && leave.delegate.id) ? leave.delegate.id : '';
    if (eReason) eReason.value = (leave && leave.leaveReason) ? leave.leaveReason : '';

    var badge = document.getElementById('eLeaveStatusBadge');
    if (badge) {
      if (!leave) {
        badge.textContent = 'Nesetat';
        badge.style.background = 'rgba(120,120,120,.15)';
        badge.style.color = 'var(--df-text-3)';
      } else if (leave.onLeave) {
        badge.textContent = 'Activ';
        badge.style.background = 'rgba(255,170,30,.15)';
        badge.style.color = '#ffcc44';
      } else {
        var today = new Date().toISOString().slice(0, 10);
        if (leave.leaveStart && leave.leaveStart > today) {
          badge.textContent = 'Programat';
          badge.style.background = 'rgba(108,79,240,.15)';
          badge.style.color = '#b0a0ff';
        } else {
          badge.textContent = 'Expirat';
          badge.style.background = 'rgba(120,120,120,.15)';
          badge.style.color = 'var(--df-text-4)';
        }
      }
    }
  }

  window.adminSaveLeave = async function() {
    var msg = document.getElementById('eLeaveMsg');
    if (msg) { msg.className = ''; msg.textContent = ''; msg.style.color = ''; }
    if (!_leaveTargetUserId) return;

    var leave_start = document.getElementById('eLeaveStart').value || null;
    var leave_end = document.getElementById('eLeaveEnd').value || null;
    var delegate_user_id = document.getElementById('eLeaveDelegate').value || null;
    var leave_reason = document.getElementById('eLeaveReason').value.trim() || null;

    if (!leave_start || !leave_end) {
      if (msg) { msg.textContent = 'Datele de început și sfârșit sunt obligatorii.'; msg.style.color = '#f87171'; }
      return;
    }
    if (!delegate_user_id) {
      if (msg) { msg.textContent = 'Alege un delegat.'; msg.style.color = '#f87171'; }
      return;
    }

    try {
      var r = await _apiFetch('/admin/users/' + _leaveTargetUserId + '/leave', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leave_start: leave_start, leave_end: leave_end, delegate_user_id: Number(delegate_user_id), leave_reason: leave_reason }),
      });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) {
        if (msg) { msg.textContent = data.message || data.error || 'Eroare.'; msg.style.color = '#f87171'; }
        return;
      }
      if (msg) { msg.textContent = 'Concediu salvat.'; msg.style.color = '#4ade80'; }
      if (typeof loadUsers === 'function') loadUsers();
    } catch(e) {
      if (msg) { msg.textContent = 'Eroare de rețea.'; msg.style.color = '#f87171'; }
    }
  };

  window.adminClearLeave = async function() {
    var msg = document.getElementById('eLeaveMsg');
    if (!_leaveTargetUserId) return;
    if (!confirm('Anulezi concediul acestui utilizator?')) return;
    try {
      var r = await _apiFetch('/admin/users/' + _leaveTargetUserId + '/leave', { method: 'DELETE' });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) {
        if (msg) { msg.textContent = data.message || data.error || 'Eroare.'; msg.style.color = '#f87171'; }
        return;
      }
      if (msg) { msg.textContent = 'Concediu anulat.'; msg.style.color = '#4ade80'; }
      ['eLeaveStart', 'eLeaveEnd', 'eLeaveDelegate', 'eLeaveReason'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      var badge = document.getElementById('eLeaveStatusBadge');
      if (badge) {
        badge.textContent = 'Nesetat';
        badge.style.background = 'rgba(120,120,120,.15)';
        badge.style.color = 'var(--df-text-3)';
      }
      if (typeof loadUsers === 'function') loadUsers();
    } catch(e) {
      if (msg) { msg.textContent = 'Eroare de rețea.'; msg.style.color = '#f87171'; }
    }
  };

  window._loadLeaveSection = _loadLeaveSection;

  window.onRoleChange                 = onRoleChange;
  window.filterUsers                  = filterUsers;
  window.loadUsers                    = loadUsers;
  window.onGwsToggle                  = onGwsToggle;
  window.updateGwsPreview             = updateGwsPreview;
  window.verifyGws                    = verifyGws;
  window.createUser                   = createUser;
  window.closePwdModal                = closePwdModal;
  window.copyPwd                      = copyPwd;
  window.sendCredsFromModal           = sendCredsFromModal;
  window.gwsRetry                     = gwsRetry;
  window.openEdit                     = openEdit;
  window.closeMod                     = closeMod;
  window.genPwd                       = genPwd;
  window.saveEdit                     = saveEdit;
  window.sendCreds                    = sendCreds;
  window.sendCredsNew                 = sendCredsNew;
  window.loadOrganizationsAutocomplete = loadOrganizationsAutocomplete;

  // Marker pentru debug
  window.df = window.df || {};
  window.df._usersModuleLoaded = true;
})();
