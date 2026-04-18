const $=id=>document.getElementById(id);
// SEC-01: token din cookie HttpOnly — nu mai citim din localStorage
// Citim doar datele UI non-sensibile din localStorage
const me=JSON.parse(localStorage.getItem("docflow_user")||"{}");
const hdrEl=$("hdrUser");
if(hdrEl) {
  hdrEl.textContent=me.nume||me.email||"—";
  // Tooltip cu rolul pe containerul span parinte
  const roleLabel = me.role === 'admin' ? 'Super Admin' : me.role === 'org_admin' ? 'Admin Instituție' : 'Utilizator';
  const parentSpan = hdrEl.closest('span');
  if (parentSpan) parentSpan.title = roleLabel + ': ' + (me.email||'');
}
fetch('/auth/me', { credentials: 'include' })
  .then(r => {
    if (!r.ok) {
      localStorage.removeItem('docflow_user');
      localStorage.removeItem('docflow_force_pwd');
      location.href = '/login?next=/admin';
    } else {
      loadActiveFlowsBadge(); // F — b97
    // Stocăm rolul curent pentru onRoleChange
    try {
      const _me = JSON.parse(localStorage.getItem('docflow_user') || '{}');
      window._currentUserRole = _me.role || 'user';
    // Afisam butonul 2FA in header doar pentru conturi privilegiate
    if (_me.role === 'admin' || _me.role === 'org_admin') {
      const btn2fa = document.getElementById('hdr2faBtn');
      if (btn2fa) btn2fa.style.display = 'inline-block';
    }
    } catch(e) { window._currentUserRole = 'user'; }
    // Super-admin: afișăm org selector de la deschiderea modalului
    if (window._currentUserRole === 'admin') {
      onRoleChange(($('nRole')?.value) || 'user');
    }
    }
  })
  .catch(() => { location.href = '/login?next=/admin'; });
function logout(){
  // SEC-01: invalidăm cookie-ul pe server, curățăm localStorage
  fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  localStorage.removeItem('docflow_user');
  localStorage.removeItem('docflow_force_pwd');
  location.href='/login';
}

async function loadActiveFlowsBadge() {
  // Badge-ul vizual a fost eliminat la facelift. Funcție no-op pentru compatibilitate.
  return;
}

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
function hdrs(){const t=window._csrfToken||(()=>{const c=document.cookie.split("; ").find(r=>r.startsWith("csrf_token="));return c?c.split("=")[1]:null;})();const h={"Content-Type":"application/json"};if(t)h["x-csrf-token"]=t;return h;}
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function validatePhoneClient(phone){
  if(!phone||!phone.trim())return{valid:true,normalized:""};
  const p=phone.trim();
  let normalized=null;
  if(/^\+40[0-9]{9}$/.test(p))normalized=p.slice(1);
  else if(/^0040[0-9]{9}$/.test(p))normalized=p.slice(2);
  else if(/^07[0-9]{8}$/.test(p))normalized="4"+p;
  else if(/^02[0-9]{8}$/.test(p))normalized="4"+p;
  else if(/^03[0-9]{8}$/.test(p))normalized="4"+p;
  if(!normalized)return{valid:false,error:"Numar invalid."};
  return{valid:true,normalized,display:"+"+normalized};
}

function showMsg(id,txt,err){
  const el=$(id);el.className="msg "+(err?"err":"ok");el.textContent=txt;
  setTimeout(()=>{el.textContent="";el.className="";},5000);
}

const PAGE_SIZE = 10;
let _currentPage = 1;
let _filteredUsers = [];

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
          <button class="btn btn-sm btn-s" onclick='openEdit(${JSON.stringify(u)})' title="Editează" style="padding:4px 8px">✏</button>
          <button class="btn btn-sm btn-w" id="btnSend_${u.id}" onclick="sendCreds(${u.id},this)" title="Trimite credențiale" style="padding:4px 8px">✉</button>
          ${!u.gws_email?`<button class="btn btn-sm" onclick="gwsRetry(${u.id},this)" title="Creează cont Workspace" style="padding:4px 8px;background:rgba(66,133,244,.15);border-color:rgba(66,133,244,.4);color:#4285F4;">G+</button>`:''}
          ${(window._currentUserRole==='admin' && !u.org_id && u.role!=='admin')?`<button class="btn btn-sm" onclick="openAssignOrg(${u.id},'${esc(u.nume||u.email)}')" title="Asignează organizație (org_id lipsă)" style="padding:4px 8px;background:rgba(255,176,32,.15);border-color:rgba(255,176,32,.4);color:#ffd580;">🏛</button>`:''}
          ${!isMe?`<button class="btn btn-sm btn-d" onclick="delUser(${u.id},'${esc(u.nume||u.email)}')" title="Șterge" style="padding:4px 8px">✕</button>`:""}
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

// Patch: după ce se populează flowInstFilter, re-aplică lock dacă org_admin
const _origPopulateFlowInst = window.onFlowInstChange;

// BUG-FIX: org_admin poate crea/edita utilizatori doar cu rol 'user'.
// Filtrăm dropdown-urile #nRole și #eRole să afișeze/permită doar 'user'.
// Backends-ul enforced la linia 178 din admin.mjs, dar UI-ul trebuie să reflecte corect.
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

let _orgList = []; // cache organizații existente
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
let _gwsPreviewTimer = null;
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
    // Re-applică instituția pentru org_admin după reset form
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

let editU=null;
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

// Cache global pentru fluxuri (pentru filtrare ierarhică)
let _allFlows = null;

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

// Compatibilitate — apelată din loadFlowsList cu flows (ignorată acum, instituțiile vin din server)
function populateFlowInstDropdown(flows) { /* no-op — înlocuit cu loadFlowInstitutions() */ }

function onFlowInstChange() {
  const instF = document.getElementById("flowInstFilter").value;
  const deptSel = document.getElementById("flowDeptFilter");
  deptSel.innerHTML = '<option value="">Toate compartimentele</option>';
  if (instF && _allFlows) {
    const depts = [...new Set(
      _allFlows
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

let _adminFluxPage = 1;
let _adminFluxDebounce = null;

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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `audit_${flowId}.${format}`; a.click();
    URL.revokeObjectURL(url);
  } catch(e) { alert('Eroare descărcare audit: ' + e.message); }
}

async function exportAuditCSV() {
  try {
    const r = await _apiFetch('/admin/flows/audit-export?days=30', { headers: hdrs() });
    if (!r.ok) { const j = await r.json().catch(()=>{}); alert('Eroare export CSV: ' + (j?.error || r.status)); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `audit_export_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
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

async function verifyDriveConn() {
  const msg = document.getElementById("archiveMsg");
  msg.textContent = "⏳ Verificare conexiune Drive...";
  try {
    const r = await _apiFetch("/admin/drive/verify", {headers: hdrs()});
    const j = await r.json();
    if (j.ok) msg.innerHTML = `✅ Conexiune OK — folder: <strong>${escH(j.folder||"")}</strong>`;
    else msg.innerHTML = `❌ Eroare: ${escH(j.error||"")}`;
  } catch(e) { msg.textContent = "❌ Eroare: " + e.message; }
}

// --- Helpers filtre arhivare ---
let _archiveInstData = null; // {inst: [dept,...], ...}

async function loadArchiveInstData() {
  if (_archiveInstData) return;
  if (!_allFlows) {
    const r = await _apiFetch("/admin/flows/list?limit=500", {headers: hdrs()});
    const resp = await r.json();
    _allFlows = Array.isArray(resp) ? resp : (resp.flows || []);
  }
  const map = {};
  _allFlows.forEach(f => {
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
  // org_admin: re-aplică lock pe archiveInstFilter după populare
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
  // org_admin: re-aplică lock pe delInstFilter
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

let _archiveFlowIds = [];
async function previewArchive() {
  const days = document.getElementById("archiveDays").value || 30;
  const inst = document.getElementById("archiveInstFilter").value;
  const dept = document.getElementById("archiveDeptFilter").value;
  const msg = document.getElementById("archiveMsg");
  const preview = document.getElementById("archivePreview");
  msg.textContent = "⏳ Se calculează...";
  preview.style.display = "none";
  // Asigurăm că avem date pentru dropdown-uri
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
    const filterLabel = inst ? ` · <span style="color:#9db0ff;">${escH(inst)}${dept?" / "+escH(dept):""}</span>` : "";
    summary.innerHTML = `<span style="color:#2dd4bf;">${escH(String(j.count||0))} fluxuri</span>${filterLabel} eligibile pentru arhivare — eliberează <span style="color:#ffd580;font-weight:700;">${escH(String(j.totalMB||0))} MB</span> din baza de date`;
    list.innerHTML = (j.flows||[]).map(f =>
      `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);">
        📄 ${escH(f.docName||'—')} &nbsp;·&nbsp; ${escH(f.status||'')} &nbsp;·&nbsp; ${new Date(f.createdAt).toLocaleDateString("ro-RO")} &nbsp;·&nbsp; ${f.sizeMB} MB
        ${f.institutie?`<span style="color:var(--muted);margin-left:6px;font-size:.75rem;">${escH(f.institutie)}${f.compartiment?' / '+escH(f.compartiment):''}</span>`:""}
        ${f.initName||f.initEmail?`<span style="color:#9db0ff;margin-left:6px;font-size:.75rem;" title="${escH(f.initEmail||'')}">👤 ${escH(f.initName||f.initEmail)}</span>`:""}
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
        <span style="color:var(--muted);margin-left:8px;">${escH(f.error||'eroare necunoscută')}</span>
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

// ── Arhivare asincronă cu job tracking (v4 backend feature) ────────────────
let _archiveJobPollTimer = null;

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
    msg.innerHTML = `🚀 Job creat: <strong>#${j.jobId}</strong> pentru ${j.flowCount} fluxuri. ${escH(j.message || 'Procesarea începe în fundal...')}`;
    btn.textContent = "⏳ În procesare...";
    pollArchiveJob(j.jobId);
  } catch (e) {
    msg.innerHTML = `❌ ${escH(e.message)}`;
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
        if (j.error) html += `<br>Eroare: ${escH(j.error)}`;
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
      if (msg) msg.innerHTML = `❌ Polling oprit: ${escH(e.message)}`;
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
    if (j.ok) msg.innerHTML = `✅ VACUUM complet. Dimensiune DB: <strong>${escH(j.dbSize||"")}</strong>`;
    else msg.textContent = "❌ " + (j.error||"Eroare");
  } catch(e) { msg.textContent = "❌ " + e.message; }
}

async function loadDbStats() {
  const el = document.getElementById("dbStats");
  const msg = document.getElementById("msgVacuum");
  try {
    const r = await _apiFetch("/admin/stats", {headers: hdrs()});
    const j = await r.json();
    if (!r.ok) { if(msg) msg.innerHTML = `❌ ${escH(j.error||'forbidden')}`; return; }
    const s = j.stats||{};
    el.style.display = "block";
    const dbSizeSpan = s.dbSize ? `<span style="color:#2dd4bf;font-weight:700;">💾 DB: ${escH(s.dbSize)}</span>` : '';
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

// ── Delete flows — preview + modal confirmare ────────────────────────────

let _pendingDeleteBody = null;
let _pendingDeleteMsgEl = null;

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
      <span title="${escH(f.flowId)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(f.docName)}</span>
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
  } catch(e) { msgEl.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(e.message)}</span>`; }
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
  } catch(e) { msgEl.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(e.message)}</span>`; }
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
      if (msgEl) msgEl.innerHTML = `<span style="color:#ffaaaa;">Eroare: ${escH(d.error)}</span>`;
    }
  } catch(e) {
    closeDeleteModal();
    if (msgEl) msgEl.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(e.message)}</span>`;
  } finally {
    btn.textContent = '🗑 Șterge definitiv';
  }
}

function onAllInstChange() {
  _populateDeptFilter(document.getElementById("allInstFilter").value, "allDeptFilter");
}

// Legacy stubs (not called from UI anymore)
async function cleanOldFlows(){ await previewCleanOld(); }
async function cleanAllFlows(){ await previewCleanAll(); }

async function delUser(id,name){
  if(!confirm('Ștergi utilizatorul "'+name+'"?\nAcțiunea este ireversibilă.'))return;
  const r=await _apiFetch("/admin/users/"+id,{method:"DELETE",headers:hdrs()});
  if(r.ok){const row=$("row_"+id);if(row)row.remove();}
  else alert("Eroare la ștergere.");
}

document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeMod();closePwdModal();closeChangePwdModal();}});
fetch("/auth/me",{headers:hdrs()})
  .then(async r=>{
    if(!r.ok){logout();return;}
    const u=await r.json();
    if(u.role!=="admin" && u.role!=="org_admin"){logout();return;}
    // org_admin fara org_id → eroare configurare, nu delogăm, arătăm mesaj
    if(u.role==="org_admin" && !u.orgId){
      document.body.innerHTML=`<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0e1117;font-family:'Segoe UI',sans-serif;">
        <div style="background:#161b22;border:1px solid rgba(255,100,100,.3);border-radius:16px;padding:48px 40px;max-width:480px;text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:16px;">⚠️</div>
          <h2 style="color:#ffaaaa;margin-bottom:12px;">Cont neconfigurat</h2>
          <p style="color:#8b949e;line-height:1.6;margin-bottom:24px;">Contul de <strong style="color:#ffd580;">Administrator Instituție</strong> nu are o organizație asociată.<br><br>
          Contactați super-administratorul pentru a seta organizația acestui cont.</p>
          <button onclick="fetch('/auth/logout',{method:'POST',credentials:'include'}).finally(()=>location.href='/login.html')"
            style="background:rgba(255,80,80,.2);border:1px solid rgba(255,80,80,.4);color:#ffaaaa;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:.9rem;">
            Înapoi la login
          </button>
        </div>
      </div>`;
      return;
    }
    localStorage.setItem("docflow_user",JSON.stringify({email:u.email,role:u.role,nume:u.nume||"",functie:u.functie||"",institutie:u.institutie||""}));
    if(u.force_password_change) localStorage.setItem("docflow_force_pwd","1");
    if(localStorage.getItem("docflow_force_pwd")==="1"){const b=$("forcePwdBanner");if(b)b.style.display="block";}
    const hEl=$("hdrUser");
    if(hEl) hEl.textContent=u.nume||u.email||"—";
    // Badge diferit pentru org_admin
    const badgeEl=$("adminBadge");
    if(badgeEl && u.role==="org_admin"){
      badgeEl.textContent="🏛 ADMIN INSTITUȚIE";
      badgeEl.style.background="rgba(45,212,191,.15)";
      badgeEl.style.borderColor="rgba(45,212,191,.3)";
      badgeEl.style.color="#2dd4bf";
    }
    // Ascunde tab GWS și operații globale pentru org_admin
    if(u.role==="org_admin"){
      const gwsTab=document.querySelector('[onclick*="gws"]');
      if(gwsTab) gwsTab.style.display="none";
      // Outreach vizibil doar pentru super-admin
      const outreachTabBtn=$('outreach-tab-btn');
      if(outreachTabBtn) outreachTabBtn.style.display="none";
      const orgTabBtn=$('org-tab-btn');
      if(orgTabBtn) orgTabBtn.style.display="none";
    }
    if(u.role==="org_admin") window._orgAdminInstitutie = u.institutie || "";
    // BUG-FIX: org_admin poate vedea/selecta doar rol 'user' — filtrăm dropdown-urile
    if(u.role==="org_admin") _lockRoleDropdownsForOrgAdmin();
    // Hash routing: /admin#tabname → deschide tabul respectiv
    const _validTabs = ['dashboard','utilizatori','fluxuri','rapoarte',
                        'organizatii','outreach','analytics','audit'];
    const _initialTab = (location.hash || '').replace(/^#/,'').trim();
    const _startTab = _validTabs.includes(_initialTab) ? _initialTab : 'dashboard';
    switchTab(_startTab);
    if (_startTab === 'analytics') loadAnalytics();
    loadUsers();
    loadArchiveInstData(); // pre-populează dropdown-urile instituție/compartiment
    loadDbStats(); // auto-încarcă statistici DB
    initActivityReport(); // inițializează raportul de activitate
    if(u.role==="org_admin") lockOrgAdminFilters(u.institutie||"");
  })
  .catch(()=>logout());

// ── Raport activitate utilizatori ────────────────────────────────────────

let _activityData = null;

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(tab) {
  ['dashboard','utilizatori','fluxuri','rapoarte','outreach','organizatii','analytics','audit'].forEach(t => {
    const el = $('tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('.df-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const titles = {dashboard:'Dashboard',utilizatori:'Utilizatori',fluxuri:'Administrare fluxuri',rapoarte:'Rapoarte',outreach:'Outreach',organizatii:'Organizații',analytics:'Analytics',audit:'Log audit'};
  const subtitles = {dashboard:'Privire de ansamblu asupra activității sistemului',utilizatori:'Administrează utilizatorii, rolurile și permisiunile',fluxuri:'Gestionează fluxurile de documente și arhivarea',rapoarte:'Rapoarte și statistici de utilizare',outreach:'Campanii outreach și import primării',organizatii:'Configurare organizații, signing providers și webhook-uri pentru integrarea cu sisteme externe (AvanDoc, iDocNet, aplicații proprii de registratură etc.)',analytics:'Analytics și metrici de adopție',audit:'Log de audit și evenimente de securitate'};
  const titleEl = document.getElementById('dfPageTitle');
  const subEl = document.getElementById('dfPageSubtitle');
  if (titleEl) titleEl.textContent = titles[tab] || 'Admin';
  if (subEl) subEl.textContent = subtitles[tab] || '';

  if (tab === 'dashboard' && !_dashboardLoaded) { loadDashboard(); _dashboardLoaded = true; }
  if (tab === 'fluxuri' && !_fluxuriLoaded) { loadArchiveInstData(); loadFlowInstitutions(); _fluxuriLoaded = true; }
  if (tab === 'outreach' && !_outreachLoaded) { orInit(); _outreachLoaded = true; }
  if (tab === 'organizatii' && !_orgLoaded) { loadOrganizations(); _orgLoaded = true; }
  if (tab === 'audit' && !_auditLoaded) { loadAuditEventTypes(); loadAuditEvents(1); _auditLoaded = true; }
}
let _dashboardLoaded = false;
let _fluxuriLoaded = false;
let _outreachLoaded = false;
let _orgLoaded = false;
let _auditLoaded = false;
let _currentOrgId = null;
let _rptGenerated = false; // true după prima generare raport — activează auto-refresh la filtrare

async function loadDashboard() {
  try {
    const [sR, fR] = await Promise.all([
      _apiFetch('/admin/stats'),
      _apiFetch('/admin/flows/stats'),
    ]);
    const s = sR.ok ? await sR.json() : null;
    const f = fR.ok ? await fR.json() : null;
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = (val != null) ? Number(val).toLocaleString('ro-RO') : '—';
    };
    if (s?.stats) {
      set('dashKpiUsers', s.stats.users);
      set('dashKpiNotif', s.stats.unreadNotifications);
    }
    if (f) {
      set('dashKpiActive', f.active);
      set('dashKpiCompleted', f.completed);
    }
  } catch (e) {
    console.warn('[loadDashboard] failed:', e);
  }
}

// ══════════════════════════════════════════════════════════════════
// AUDIT TRAIL MODULE
// ══════════════════════════════════════════════════════════════════

let _auditCurrentPage = 1;

async function loadAuditEvents(page = 1) {
  _auditCurrentPage = page;
  const eventType = $('audit-event-type')?.value || '';
  const flowId    = $('audit-flow-id')?.value    || '';
  const from      = $('audit-from')?.value       || '';
  const to        = $('audit-to')?.value         || '';

  const params = new URLSearchParams({ page, limit: 50 });
  if (eventType) params.set('event_type', eventType);
  if (flowId)    params.set('flow_id', flowId);
  if (from)      params.set('from', from);
  if (to)        params.set('to', to);

  try {
    const res  = await fetch(`/admin/audit-events?${params}`, { credentials: 'include' });
    const data = await res.json();
    renderAuditTable(data.events || []);
    renderAuditPagination(data.page || 1, data.pages || 1, data.total || 0);
  } catch(e) {
    const tb = $('audit-tbody');
    if (tb) tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#f87171">Eroare la încărcare</td></tr>';
  }
}

function renderAuditTable(events) {
  const tbody = $('audit-tbody');
  if (!tbody) return;
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--muted)">Niciun eveniment găsit</td></tr>';
    return;
  }
  const eventLabels = {
    'FLOW_CREATED':            'Flux creat',
    'SIGNED_PDF_UPLOADED':     'Document semnat încărcat',
    'FLOW_COMPLETED':          'Flux finalizat',
    'FLOW_REFUSED':            'Flux refuzat',
    'FLOW_CANCELLED':          'Flux anulat',
    'USER_LOGIN':              'Autentificare',
    'USER_LOGOUT':             'Deconectare',
    'FLOW_DELEGATED':          'Delegare semnătură',
    'EMAIL_SENT':              'Email trimis',
    'ARCHIVE_COMPLETED':       'Arhivat',
    'TRUST_REPORT_GENERATED':  'Raport trust generat',
    'SIGNER_NOTIFIED':         'Semnatar notificat',
    'FLOW_REINITIATED':        'Flux reinițiat',
  };
  const badgeColor = {
    'FLOW_CREATED':        '#3b82f6',
    'FLOW_COMPLETED':      '#10b981',
    'FLOW_REFUSED':        '#ef4444',
    'FLOW_CANCELLED':      '#f97316',
    'SIGNED_PDF_UPLOADED': '#8b5cf6',
    'USER_LOGIN':          '#06b6d4',
    'USER_LOGOUT':         '#64748b',
  };
  tbody.innerHTML = events.map(e => {
    const date     = new Date(e.created_at).toLocaleString('ro-RO', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const label    = eventLabels[e.event_type] || e.event_type;
    const color    = badgeColor[e.event_type]  || '#64748b';
    const badgeHtml = `<span style="background:${color}22;color:${color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap">${escH(label)}</span>`;
    const flowLink  = e.flow_id
      ? `<a href="/flow.html?id=${encodeURIComponent(e.flow_id)}" style="font-family:monospace;font-size:11px;color:#7c9eff;word-break:break-all;">${escH(e.flow_id)}</a>`
      : '<span style="color:var(--muted)">—</span>';
    const actor = escH(e.actor_name || e.actor_email || '—');
    return `<tr style="border-bottom:1px solid rgba(255,255,255,.05);">
      <td style="padding:8px 10px;white-space:nowrap;color:#9db0ff;">${date}</td>
      <td style="padding:8px 10px;">${badgeHtml}</td>
      <td style="padding:8px 10px;font-size:.8rem;color:#eaf0ff;">${actor}</td>
      <td style="padding:8px 10px;">${flowLink}</td>
      <td style="padding:8px 10px;"><span style="font-size:.76rem;color:var(--muted);">${escH(e.channel || 'api')}</span></td>
      <td style="padding:8px 10px;font-size:.78rem;color:#8899bb;">${escH(e.message || '—')}</td>
    </tr>`;
  }).join('');
}

function renderAuditPagination(page, pages, total) {
  const el = $('audit-pagination');
  if (!el) return;
  el.innerHTML = `
    <button onclick="loadAuditEvents(${page - 1})" ${page <= 1 ? 'disabled' : ''} style="background:rgba(255,255,255,.07);border:none;color:#c4b5ff;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:.8rem;">‹ Anterior</button>
    <span style="color:var(--muted);">Pagina <strong style="color:#eaf0ff;">${page}</strong> din <strong style="color:#eaf0ff;">${pages}</strong> &nbsp;·&nbsp; ${total} înregistrări</span>
    <button onclick="loadAuditEvents(${page + 1})" ${page >= pages ? 'disabled' : ''} style="background:rgba(255,255,255,.07);border:none;color:#c4b5ff;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:.8rem;">Următor ›</button>
  `;
}

async function loadAuditEventTypes() {
  try {
    const res  = await fetch('/admin/audit-events/types', { credentials: 'include' });
    const data = await res.json();
    const sel  = $('audit-event-type');
    if (sel && data.types) {
      data.types.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        sel.appendChild(opt);
      });
    }
  } catch(e) {}
}

function resetAuditFilters() {
  ['audit-event-type','audit-flow-id','audit-from','audit-to'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });
  loadAuditEvents(1);
}

function downloadAuditCsv() {
  const eventType = $('audit-event-type')?.value || '';
  const flowId    = $('audit-flow-id')?.value    || '';
  const from      = $('audit-from')?.value       || '';
  const to        = $('audit-to')?.value         || '';
  const params    = new URLSearchParams({ format: 'csv', limit: 10000 });
  if (eventType) params.set('event_type', eventType);
  if (flowId)    params.set('flow_id', flowId);
  if (from)      params.set('from', from);
  if (to)        params.set('to', to);
  window.location.href = `/admin/audit-events?${params}`;
}

// ══════════════════════════════════════════════════════════════════
// OUTREACH MODULE
// ══════════════════════════════════════════════════════════════════

let _orCurrentCampaignId = null;

const OR_DEFAULT_TEMPLATE = `<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8faff;padding:36px;border-radius:12px;">
  <div style="text-align:center;margin-bottom:28px;">
    <h1 style="font-size:26px;color:#1a1a2e;margin:0;">DocFlow<span style="color:#1A56DB;">AI</span></h1>
    <p style="color:#64748b;font-size:13px;margin-top:4px;">Architecture for Intelligent Workflows</p>
  </div>
  <p style="color:#1e293b;font-size:15px;line-height:1.7;">Stimată <strong>{{institutie}}</strong>,</p>
  <p style="color:#1e293b;font-size:15px;line-height:1.7;">
    Vă transmitem spre prezentare platforma <strong>DocFlowAI</strong> — o soluție digitală completă
    pentru gestionarea și semnarea electronică a documentelor în instituțiile publice din România.
  </p>
  <div style="background:#EEF2FF;border-left:4px solid #1A56DB;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;">
    <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">Ce oferă DocFlowAI:</p>
    <ul style="margin:8px 0 0 0;padding-left:18px;color:#334155;font-size:14px;line-height:1.8;">
      <li>Flux secvențial de semnare electronică (ÎNTOCMIT · VERIFICAT · VIZAT · APROBAT)</li>
      <li>Notificări automate prin email, push și WhatsApp</li>
      <li>Arhivare automată în Google Drive + jurnal de audit complet</li>
      <li>Securitate avansată: JWT HttpOnly, PBKDF2, CSP, GDPR compliant</li>
    </ul>
  </div>
  <p style="color:#1e293b;font-size:15px;line-height:1.7;">
    Vă propunem o <strong>demonstrație online gratuită de 15 minute</strong>, la data și ora convenabilă dumneavoastră.
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="https://www.docflowai.ro" style="background:#1A56DB;color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Aflați mai multe</a>
  </div>
  <p style="color:#64748b;font-size:13px;margin-top:28px;border-top:1px solid #e2e8f0;padding-top:16px;">
    Cu stimă,<br>
    <strong>Departamentul tehnic</strong><br>
    DocFlowAI · <a href="https://www.docflowai.ro" style="color:#1A56DB;">www.docflowai.ro</a> · 0722.663.961
  </p>
</div>`;

// Template conversațional — ton direct, scurt, mai eficient pentru factori de decizie
const OR_CONV_TEMPLATE = `<div style="font-family:Georgia,serif;max-width:580px;margin:0 auto;background:#ffffff;padding:40px 36px;border-radius:4px;border-top:4px solid #1A56DB;">
  <p style="color:#1e293b;font-size:16px;line-height:1.8;margin:0 0 18px 0;">Bună ziua,</p>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    Lucrez cu mai multe instituții publice din România pe o problemă concretă:
    <strong>circuitul intern de documente care necesită semnături multiple</strong> —
    referate, dispoziții, ordine de plată — care circulă în continuare pe hârtie sau prin email,
    fără trasabilitate și fără arhivă sigură.
  </p>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    Am construit <strong>DocFlowAI</strong> ca răspuns la această nevoie:
    un sistem în care inițiatorul încarcă documentul, sistemul îl trimite automat
    fiecărui semnatar în ordine, iar la final totul este arhivat cu jurnal de audit complet.
  </p>
  <div style="background:#f0f4ff;padding:16px 20px;border-radius:8px;margin:20px 0;">
    <p style="margin:0;font-size:14px;color:#1e293b;">
      📋 <strong>{{institutie}}</strong> ar putea digitaliza circuitul de documente în mai puțin de o zi de implementare.
      Nicio infrastructură suplimentară — funcționează complet online, cu certificate calificate eIDAS.
    </p>
  </div>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 24px 0;">
    Vă propun un apel de 15 minute pentru a vedea cum arată concret pentru o instituție ca a dumneavoastră.
    Când ar fi convenabil?
  </p>
  <div style="text-align:left;margin:24px 0;">
    <a href="https://www.docflowai.ro" style="background:#1A56DB;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Programează o demonstrație</a>
  </div>
  <p style="color:#64748b;font-size:13px;margin-top:28px;border-top:1px solid #e8ecf0;padding-top:16px;">
    Departamentul tehnic<br>
    <a href="https://www.docflowai.ro" style="color:#1A56DB;">DocFlowAI</a> · 0722.663.961
  </p>
</div>`;

// Subiecte sugerate — de la generic la personalizat
const OR_SUBJECT_SUGGESTIONS = [
  'Propunere digitalizare flux documente – DocFlowAI',
  'Semnături electronice calificate pentru {{institutie}} — demonstrație gratuită',
  'Cum elimină {{institutie}} hârtia din circuitul intern de documente',
  'DocFlowAI — flux electronic ÎNTOCMIT→VIZAT→APROBAT pentru instituții publice',
  'O întrebare despre circuitul de documente din {{institutie}}',
];

function orFillDefaultTemplate() {
  $('or-c-body').value = OR_DEFAULT_TEMPLATE;
  $('or-c-subject').value = $('or-c-subject').value || OR_SUBJECT_SUGGESTIONS[0];
}

function orFillConvTemplate() {
  $('or-c-body').value = OR_CONV_TEMPLATE;
  $('or-c-subject').value = OR_SUBJECT_SUGGESTIONS[4];
  $('or-c-body').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function orInit() {
  await orLoadStats();
  await orLoadCampaigns();
  await prRefreshCampaignSelect();
  prLoad(1);
}

async function orLoadStats() {
  try {
    const r = await fetch('/admin/outreach/stats', { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    $('or-stat-today').textContent   = d.sentToday ?? '—';
    $('or-stat-total').textContent   = d.total_sent ?? '—';
    $('or-stat-opened').textContent  = d.total_opened ?? '—';
    $('or-limit-display').textContent = `${d.sentToday ?? 0} / ${d.dailyLimit ?? 100}`;
  } catch(e) { /* silent */ }
}

async function orLoadCampaigns() {
  const el = $('or-campaigns-list');
  el.innerHTML = '<div style="color:var(--muted);font-size:.84rem;padding:12px 0;">⏳ Se încarcă...</div>';
  try {
    const r = await fetch('/admin/outreach/campaigns', { credentials: 'include' });
    const d = await r.json();
    const cntCamp = document.getElementById('outreachCampaignsCount'); if (cntCamp) cntCamp.textContent = d.campaigns?.length || 0;
    if (!d.campaigns?.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:.84rem;padding:12px 0;">Nicio campanie. Creează prima campanie mai sus.</div>';
      return;
    }
    el.innerHTML = d.campaigns.map(c => {
      const pct = c.total_recipients > 0 ? Math.round((+c.sent_count / +c.total_recipients) * 100) : 0;
      const openPct = c.sent_count > 0 ? Math.round((+c.opened_count / +c.sent_count) * 100) : 0;
      const clickPct = c.sent_count > 0 ? Math.round((+c.click_count / +c.sent_count) * 100) : 0;
      return `<div onclick="orSelectCampaign(${c.id})" style="display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:${_orCurrentCampaignId===c.id?'rgba(124,92,255,.12)':'rgba(255,255,255,.02)'};cursor:pointer;margin-bottom:8px;transition:background .15s;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:.88rem;color:var(--text);">${escH(c.name)}</div>
          <div style="font-size:.76rem;color:var(--muted);margin-top:3px;">${escH(c.subject)}</div>
          <div style="font-size:.74rem;color:var(--muted);margin-top:2px;">Creat de ${escH(c.created_by)} · ${new Date(c.created_at).toLocaleDateString('ro-RO')}</div>
        </div>
        <div style="display:flex;gap:14px;text-align:center;flex-shrink:0;">
          <div><div style="font-size:1.1rem;font-weight:700;color:#9db0ff;">${c.total_recipients}</div><div style="font-size:.7rem;color:var(--muted);">destinatari</div></div>
          <div><div style="font-size:1.1rem;font-weight:700;color:#7cf0e0;">${c.sent_count}</div><div style="font-size:.7rem;color:var(--muted);">trimiși ${pct}%</div></div>
          <div title="Deschideri via pixel — nesigure, blocate de Gmail/Outlook/Apple Mail"><div style="font-size:1.1rem;font-weight:700;color:#a3e6a3;">${c.opened_count}</div><div style="font-size:.7rem;color:var(--muted);">deschis ${openPct}% ⚠</div></div>
          <div title="Click-uri pe linkuri — metrica reala, fiabila 100%"><div style="font-size:1.1rem;font-weight:700;color:#ffd580;">${c.click_count}</div><div style="font-size:.7rem;color:#ffd580;font-weight:700;">clickuri ${clickPct}% ★</div></div>
          ${+c.pending_count > 0 ? `<div><div style="font-size:1.1rem;font-weight:700;color:#ffd580;">${c.pending_count}</div><div style="font-size:.7rem;color:var(--muted);">pending</div></div>` : ''}
          ${+c.error_count > 0   ? `<div><div style="font-size:1.1rem;font-weight:700;color:#ffaaaa;">${c.error_count}</div><div style="font-size:.7rem;color:var(--muted);">erori</div></div>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="color:#ffaaaa;font-size:.84rem;padding:12px 0;">Eroare la încărcare campanii.</div>';
  }
}

async function orSelectCampaign(id) {
  _orCurrentCampaignId = id;
  await orLoadCampaigns(); // re-render cu highlight
  await orLoadDetail(id);
  $('or-detail-panel').style.display = '';
  $('or-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function orLoadDetail(id) {
  try {
    const r = await fetch(`/admin/outreach/campaigns/${id}`, { credentials: 'include' });
    if (!r.ok) return;
    const { campaign: c, recipients } = await r.json();
    $('or-detail-name').textContent = c.name;

    // Mini stats
    const total   = recipients.length;
    const sent    = recipients.filter(r => r.status === 'sent' || r.status === 'opened').length;
    const opened  = recipients.filter(r => r.status === 'opened').length;
    const clicked = recipients.filter(r => r.clicked_at).length;
    const pending = recipients.filter(r => r.status === 'pending').length;
    const errors  = recipients.filter(r => r.status === 'error').length;
    $('or-detail-stats').innerHTML = [
      ['Total', total, '#9db0ff'],
      ['Pending', pending, '#b0b0b0'],
      ['Trimiși', sent, '#7cf0e0'],
      ['Deschis ⚠', opened, '#a3e6a3'],
      ['Clickuri ★', clicked, '#ffd580'],
      ['Erori', errors, '#ffaaaa'],
    ].map(([l, v, col]) => `<span style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);padding:5px 14px;border-radius:20px;font-size:.8rem;"><strong style="color:${col};">${v}</strong> <span style="color:var(--muted);">${l}</span></span>`).join('');

    // Banner informativ tracking — adăugat o singură dată, NU la fiecare render
    const existingWarning = document.getElementById('or-metrics-warning');
    if (!existingWarning) {
      const statsEl = $('or-detail-stats');
      if (statsEl && statsEl.parentNode) {
        const warn = document.createElement('div');
        warn.id = 'or-metrics-warning';
        warn.style.cssText = 'background:rgba(255,213,128,.07);border:1px solid rgba(255,213,128,.2);border-radius:8px;padding:10px 14px;margin-top:10px;font-size:.78rem;color:#ffd580;line-height:1.5;';
        warn.innerHTML = '<strong>⚠ Despre acuratețea metricilor:</strong> Deschiderile (pixel GIF) sunt blocate de Gmail, Outlook și Apple Mail — cifrele sunt <em>sub-raportate</em>. <strong style="color:#ffd580;">Click-urile ★ sunt metrica fiabilă</strong> — înseamnă că destinatarul a acționat efectiv pe un link din email. Raportul <strong>clickuri/trimiși</strong> este indicatorul real de interes.';
        statsEl.parentNode.insertBefore(warn, statsEl.nextSibling);
      }
    }

    $('or-recip-count').textContent = `${total} destinatar${total !== 1 ? 'i' : ''}`;

    // Tabel
    const tbody = $('or-recip-tbody');
    if (!recipients.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--muted);">Niciun destinatar adăugat încă.</td></tr>';
      return;
    }
    const statusBadge = {
      pending: '<span style="background:rgba(255,213,0,.12);color:#ffd580;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">pending</span>',
      sent:    '<span style="background:rgba(45,212,191,.12);color:#7cf0e0;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">trimis</span>',
      opened:  '<span style="background:rgba(163,230,163,.15);color:#a3e6a3;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">deschis ✓</span>',
      error:   '<span style="background:rgba(255,80,80,.12);color:#ffaaaa;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">eroare</span>',
    };
    tbody.innerHTML = recipients.map(r => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);">
      <td style="padding:7px 10px;color:var(--text);">${escH(r.email)}</td>
      <td style="padding:7px 10px;color:var(--muted);font-size:.8rem;">${escH(r.institutie || '—')}</td>
      <td style="padding:7px 10px;text-align:center;">${statusBadge[r.status] || r.status}</td>
      <td style="padding:7px 10px;text-align:center;color:var(--muted);font-size:.75rem;">${r.sent_at ? new Date(r.sent_at).toLocaleString('ro-RO') : '—'}</td>
      <td style="padding:7px 10px;text-align:center;color:var(--muted);font-size:.75rem;">${r.opened_at ? new Date(r.opened_at).toLocaleString('ro-RO') : '—'}</td>
      <td style="padding:7px 10px;text-align:center;font-size:.75rem;">${r.clicked_at ? `<span style="color:#ffd580;font-weight:700;">★ ${r.click_count}x</span><br><span style="color:var(--muted);font-size:.7rem;">${new Date(r.clicked_at).toLocaleString('ro-RO')}</span>` : '<span style="color:var(--muted);">—</span>'}</td>
      <td style="padding:7px 10px;text-align:center;">${r.status === 'pending' ? `<button onclick="orDeleteRecipient(${r.id})" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:.8rem;" title="Șterge">✕</button>` : ''}</td>
    </tr>`).join('');
  } catch(e) {
    logger.warn?.('orLoadDetail error', e);
  }
}

async function orCreateCampaign() {
  const name     = ($('or-c-name').value || '').trim();
  const subject  = ($('or-c-subject').value || '').trim();
  const html_body = ($('or-c-body').value || '').trim();
  const st = $('or-c-status');
  if (!name || !subject || !html_body) {
    st.textContent = '⚠ Completează toate câmpurile obligatorii.';
    st.style.color = '#ffaaaa';
    return;
  }
  st.textContent = '⏳ Se creează...'; st.style.color = 'var(--muted)';
  try {
    const r = await fetch('/admin/outreach/campaigns', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, subject, html_body }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error);
    st.textContent = '✅ Campanie creată!'; st.style.color = '#a3e6a3';
    $('or-c-name').value = '';
    await orLoadCampaigns();
    await prRefreshCampaignSelect();
    setTimeout(() => orSelectCampaign(d.campaign.id), 300);
  } catch(e) {
    st.textContent = '⚠ ' + e.message; st.style.color = '#ffaaaa';
  }
}

async function orAddRecipients() {
  if (!_orCurrentCampaignId) return;
  const email = ($('or-add-email').value || '').trim();
  const inst  = ($('or-add-inst').value || '').trim();
  const csv   = ($('or-add-csv').value || '').trim();
  const st    = $('or-add-status');

  let body = {};
  if (csv) {
    body = { csv };
  } else if (email) {
    body = { recipients: [{ email, institutie: inst }] };
  } else {
    st.textContent = '⚠ Introdu un email sau CSV.'; st.style.color = '#ffaaaa'; return;
  }

  st.textContent = '⏳...'; st.style.color = 'var(--muted)';
  try {
    const r = await fetch(`/admin/outreach/campaigns/${_orCurrentCampaignId}/recipients`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error);
    st.textContent = `✅ ${d.added} adăugat${d.added !== 1 ? 'e' : ''}${d.skipped ? ` · ${d.skipped} existau deja` : ''}.`;
    st.style.color = '#a3e6a3';
    $('or-add-email').value = ''; $('or-add-inst').value = ''; $('or-add-csv').value = '';
    await orLoadDetail(_orCurrentCampaignId);
    await orLoadCampaigns();
  } catch(e) {
    st.textContent = '⚠ ' + e.message; st.style.color = '#ffaaaa';
  }
}

async function orDeleteRecipient(rid) {
  if (!_orCurrentCampaignId) return;
  try {
    await fetch(`/admin/outreach/campaigns/${_orCurrentCampaignId}/recipients/${rid}`, {
      method: 'DELETE', credentials: 'include',
    });
    await orLoadDetail(_orCurrentCampaignId);
    await orLoadCampaigns();
  } catch(e) { /* silent */ }
}

async function orSendBatch() {
  if (!_orCurrentCampaignId) return;
  const btn = $('or-btn-send');
  const st  = $('or-send-status');
  btn.disabled = true; btn.textContent = '⏳ Se trimite...';
  st.textContent = ''; st.style.color = 'var(--muted)';
  try {
    const r = await fetch(`/admin/outreach/campaigns/${_orCurrentCampaignId}/send`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchSize: 50 }),
    });
    const d = await r.json();
    if (r.status === 429) throw new Error(d.message);
    if (!r.ok) throw new Error(d.message || d.error);
    st.textContent = `✅ ${d.sent} trimise, ${d.errors} erori · Azi: ${d.sentToday}/${d.dailyLimit} · Rămase azi: ${d.remainingToday}`;
    st.style.color = d.errors > 0 ? '#ffd580' : '#a3e6a3';
    await orLoadStats();
    await orLoadDetail(_orCurrentCampaignId);
    await orLoadCampaigns();
  } catch(e) {
    st.textContent = '⚠ ' + e.message; st.style.color = '#ffaaaa';
  } finally {
    btn.disabled = false; btn.textContent = '▶ Trimite batch (50)';
  }
}

async function orResetErrors() {
  if (!_orCurrentCampaignId) return;
  try {
    const r = await fetch(`/admin/outreach/campaigns/${_orCurrentCampaignId}/reset-errors`, {
      method: 'POST', credentials: 'include',
    });
    const d = await r.json();
    $('or-send-status').textContent = `🔁 ${d.reset} erori resetate la pending.`;
    $('or-send-status').style.color = '#ffd580';
    await orLoadDetail(_orCurrentCampaignId);
    await orLoadCampaigns();
  } catch(e) { /* silent */ }
}

async function orDeleteCampaign() {
  if (!_orCurrentCampaignId) return;
  if (!confirm('Ștergi campania și toți destinatarii ei? Acțiune ireversibilă.')) return;
  try {
    await fetch(`/admin/outreach/campaigns/${_orCurrentCampaignId}`, {
      method: 'DELETE', credentials: 'include',
    });
    _orCurrentCampaignId = null;
    $('or-detail-panel').style.display = 'none';
    await orLoadCampaigns();
    await orLoadStats();
    await prRefreshCampaignSelect(); // sync dropdown primarii
  } catch(e) { /* silent */ }
}

// ══════════════════════════════════════════════════════════════════
// PRIMĂRII ROMÂNIA — import dataset
// ══════════════════════════════════════════════════════════════════

let _prPage     = 1;
let _prSelected = new Set(); // Set de id-uri selectate (numere)
let _prDebounce = null;

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
          <input type="checkbox" data-id="${p.id}" data-email="${escH(p.email)}" data-inst="${escH(p.institutie)}"
            onchange="prToggle(${p.id})"
            style="cursor:pointer;accent-color:var(--accent2);" />
        </td>
        <td style="padding:5px 8px;color:var(--text);">${escH(p.institutie)}</td>
        <td style="padding:5px 8px;color:var(--muted);">
          ${escH(p.email)}
          ${p.unsubscribed ? '<span title="Dezabonat GDPR" style="margin-left:5px;font-size:.7rem;background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.25);border-radius:4px;color:#ffaaaa;padding:1px 5px;">🚫 dezabonat</span>' : ''}
        </td>
        <td style="padding:5px 8px;color:var(--muted);">${escH(p.judet)}</td>
        <td style="padding:5px 8px;text-align:right;white-space:nowrap;">
          <button onclick="prEditRow(${p.id},'${escH(p.institutie)}','${escH(p.email)}','${escH(p.judet)}','${escH(p.localitate||p.institutie)}')"
            style="padding:3px 9px;font-size:.73rem;background:rgba(157,176,255,.12);border:1px solid rgba(157,176,255,.25);border-radius:6px;color:#9db0ff;cursor:pointer;margin-right:4px;" title="Editează">✏️</button>
          <button onclick="prDeleteRow(${p.id},'${escH(p.institutie)}')"
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
    if (_orCurrentCampaignId && String(_orCurrentCampaignId) === String(campaignId)) {
      await orLoadDetail(_orCurrentCampaignId);
    }
    await orLoadCampaigns();
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
  if (!confirm(`Dezactivează "${institutie}"?

Instituția nu va mai apărea în listă dar nu se șterge definitiv.`)) return;
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

function prImportFileChange() {
  const file = $('pr-import-file').files?.[0];
  if (!file) return;
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

// ── Date helpers ─────────────────────────────────────────────────────────
/** Escape HTML pentru output sigur în innerHTML */
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
/** Parsează zz.ll.aaaa → YYYY-MM-DD string sau null */
function parseDMYtoISO(s) {
  if (!s || s.length !== 10) return null;
  const [d,m,y] = s.split('.').map(Number);
  if (!d||!m||!y||m>12||d>31||y<2000||y>2100) return null;
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

/** Formatează YYYY-MM-DD → zz.ll.aaaa */
function isoToDMY(iso) {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Formatează Date object → zz.ll.aaaa */
function dateToDMY(d) {
  if (!d || isNaN(d.getTime())) return '';
  return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + d.getFullYear();
}

/** Formatează Date object → YYYY-MM-DD */
function dateToISO(d) {
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** Handler pentru input text zz.ll.aaaa — auto-punctuație + sync către hidden date */
function onDateTextInput(el, hiddenId) {
  let v = el.value.replace(/[^0-9.]/g,'');
  // Auto-inserare puncte
  const digits = v.replace(/\./g,'');
  if (digits.length > 2 && !v.includes('.')) v = digits.slice(0,2) + '.' + digits.slice(2);
  if (digits.length > 4) {
    const parts = v.split('.');
    if (parts.length >= 2 && parts[1].length > 2) {
      v = parts[0] + '.' + parts[1].slice(0,2) + '.' + parts[1].slice(2) + (parts[2]||'');
    }
  }
  v = v.slice(0,10);
  el.value = v;
  // Sincronizează hidden date input
  const iso = parseDMYtoISO(v);
  const hidden = $(hiddenId);
  if (hidden) hidden.value = iso || '';
  el.style.borderColor = v.length === 10 ? (iso ? 'rgba(45,212,191,.5)' : 'rgba(255,80,80,.5)') : '';
}

/** Handler pentru calendar picker — sync înapoi în textbox */
function onDatePickerChange(pickerEl, displayId) {
  const iso = pickerEl.value; // YYYY-MM-DD
  if (iso) { const disp = $(displayId); if (disp) { disp.value = isoToDMY(iso); disp.style.borderColor = 'rgba(45,212,191,.5)'; } }
}

// ── Raport activitate ────────────────────────────────────────────────────
function initActivityReport() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const todayISO = dateToISO(today);
  const fromISO  = dateToISO(firstOfMonth);
  $('rptFrom').value        = fromISO;
  $('rptTo').value          = todayISO;
  $('rptFromDisplay').value = isoToDMY(fromISO);
  $('rptToDisplay').value   = isoToDMY(todayISO);
  _rptGenerated = false; // reset la inițializare — trebuie apăsat Generează prima dată

  // Încarcă toți utilizatorii pentru cascadare
  _apiFetch('/admin/users', { headers: hdrs() }).then(r => r.json()).then(data => {
    _rptGenerated = true; // permite auto-refresh la filtrare ulterioară
    window._rptUsers = data.users || data || [];
    _rebuildRptInst();
  }).catch(() => {});
}

function _rebuildRptInst() {
  const users = window._rptUsers || [];
  const rptInst = $('rptInst');
  // Salvează selecția curentă
  const prevInst = rptInst.value;
  rptInst.innerHTML = '<option value="">— Toate instituțiile —</option>';
  const insts = [...new Set(users.map(u => u.institutie).filter(Boolean))].sort();
  insts.forEach(i => { const o = document.createElement('option'); o.value = i; o.textContent = i; rptInst.appendChild(o); });
  if (prevInst) rptInst.value = prevInst;
  // org_admin: blochează rptInst după populare
  if (window._orgAdminInstitutie) {
    let found=false; for(const o of rptInst.options){if(o.value===window._orgAdminInstitutie){found=true;break;}}
    if(!found){const o=new Option(window._orgAdminInstitutie,window._orgAdminInstitutie);rptInst.appendChild(o);}
    rptInst.value=window._orgAdminInstitutie; rptInst.disabled=true;
    rptInst.style.cssText+=';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;';
  }
  _rebuildRptDept();
}

function onRptInstChange() {
  _rebuildRptDept();
  _rebuildRptUser();
  if (_rptGenerated) loadActivityReport();
}

function _rebuildRptDept() {
  const inst = $('rptInst').value;
  const deptSel = $('rptDept');
  const prevDept = deptSel.value;
  deptSel.innerHTML = '<option value="">— Toate compartimentele —</option>';
  if (inst && window._rptUsers) {
    const depts = [...new Set(window._rptUsers
      .filter(u => u.institutie === inst)
      .map(u => u.compartiment).filter(Boolean))].sort();
    depts.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; deptSel.appendChild(o); });
    deptSel.disabled = depts.length === 0;
    if (prevDept) deptSel.value = prevDept;
  } else {
    deptSel.disabled = true;
  }
  _rebuildRptUser();
}

function onRptDeptChange() { _rebuildRptUser(); if (_rptGenerated) loadActivityReport(); }

function _rebuildRptUser() {
  const inst = $('rptInst').value;
  const dept = $('rptDept').value;
  const userSel = $('rptUser');
  const prevEmail = userSel.value;
  userSel.innerHTML = '<option value="">— Toți utilizatorii —</option>';
  let filtered = window._rptUsers || [];
  if (inst) filtered = filtered.filter(u => u.institutie === inst);
  if (dept) filtered = filtered.filter(u => u.compartiment === dept);
  filtered.sort((a,b) => (a.nume||'').localeCompare(b.nume||''));
  filtered.forEach(u => {
    const o = document.createElement('option');
    o.value = u.email;
    o.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
    userSel.appendChild(o);
  });
  if (prevEmail) userSel.value = prevEmail;
}

function onRptUserChange() {
  // Sincronizează filtrele invers dacă utilizatorul selectat e dintr-o instituție specifică
  const email = $('rptUser').value;
  if (email && window._rptUsers) {
    const u = window._rptUsers.find(x => x.email === email);
    if (u && u.institutie && !$('rptInst').value) {
      $('rptInst').value = u.institutie;
      _rebuildRptDept();
      $('rptUser').value = email; // re-setăm după rebuild
    }
  }
  if (_rptGenerated) loadActivityReport();
}

async function loadActivityReport() {
  const area = $('activityReport');
  // Sincronizăm hidden inputs din display dacă userul a tastat manual
  const fromDisp = ($('rptFromDisplay').value||'').trim();
  const toDisp   = ($('rptToDisplay').value||'').trim();
  if (fromDisp.length === 10) { const iso = parseDMYtoISO(fromDisp); if (iso) $('rptFrom').value = iso; }
  if (toDisp.length === 10)   { const iso = parseDMYtoISO(toDisp);   if (iso) $('rptTo').value = iso; }

  const fromISO = $('rptFrom').value;
  const toISO   = $('rptTo').value;

  if (!fromISO || !toISO) {
    area.innerHTML = '<p style="color:#ffaaaa;font-size:.85rem;">⚠️ Selectează intervalul de date (format: zz.ll.aaaa).</p>';
    return;
  }
  if (fromISO > toISO) {
    area.innerHTML = '<p style="color:#ffaaaa;font-size:.85rem;">⚠️ Data de început trebuie să fie înainte de data de sfârșit.</p>';
    return;
  }

  area.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);">⏳ Se generează raportul...</div>';
  try {
    const params = new URLSearchParams({ from: fromISO, to: toISO });
    const email = $('rptUser').value;   // email direct
    const inst  = $('rptInst').value;
    const dept  = $('rptDept').value;
    if (email) params.set('email', email);
    else if (inst) params.set('institutie', inst);
    if (dept)  params.set('compartiment', dept);
    const r = await _apiFetch(`/admin/user-activity?${params}`, { headers: hdrs() });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || `HTTP ${r.status}`); }
    const data = await r.json();
    _activityData = data;
    renderActivityReport(data);
  } catch(e) {
    area.innerHTML = `<p style="color:#ffaaaa;font-size:.85rem;">❌ ${escH(e.message)}</p>`;
  }
}

// Etichete în română pentru tipurile de operațiuni
const OP_LABELS_RO = {
  FLOW_CREATED:                   'Flux inițiat',
  SIGNED:                         'Semnat și avansat',
  SIGNED_PDF_UPLOADED:            'PDF semnat încărcat',
  REFUSED:                        'Refuzat',
  REVIEW_REQUESTED:               'Trimis la revizuire',
  FLOW_REINITIATED:               'Flux reinițiat după refuz',
  FLOW_REINITIATED_AFTER_REVIEW:  'Reinițiat după revizuire',
  REINITIATED_AFTER_REVIEW:       'Reinițiere marcată',
  FLOW_COMPLETED:                 'Flux finalizat',
  FLOW_CANCELLED:                 'Flux anulat',
  DELEGATE:                       'Delegare semnătură',
  DELEGATED:                      'Delegare semnătură',
  YOUR_TURN:                      'Notificat',
  EMAIL_SENT:                     'Email extern trimis',
};

const OP_COLORS = {
  FLOW_CREATED: '#7c5cff', SIGNED_PDF_UPLOADED: '#2dd4bf', REFUSED: '#ff5050',
  REVIEW_REQUESTED: '#ffd580', FLOW_REINITIATED: '#ff9955', FLOW_REINITIATED_AFTER_REVIEW: '#ff9955',
  FLOW_COMPLETED: '#26d07c', FLOW_CANCELLED: '#888888', DELEGATE: '#9db0ff', YOUR_TURN: '#aaa',
  REINITIATED_AFTER_REVIEW: '#ffaaaa', EMAIL_SENT: '#2dd4bf',
};
const OP_ICONS = {
  FLOW_CREATED: '📝', SIGNED_PDF_UPLOADED: '✅', REFUSED: '⛔',
  REVIEW_REQUESTED: '🔄', FLOW_REINITIATED: '🔁', FLOW_REINITIATED_AFTER_REVIEW: '🔁',
  FLOW_COMPLETED: '🏁', FLOW_CANCELLED: '🚫', DELEGATE: '👥', YOUR_TURN: '🔔',
  REINITIATED_AFTER_REVIEW: '🔁', EMAIL_SENT: '📧',
};

function renderActivityReport(data) {
  const area = $('activityReport');
  const users = (data.users || []).filter(u => u.totalOps > 0 || $('rptUser').value);
  const from = isoToDMY(data.from);
  const to   = isoToDMY(data.to);

  if (!users.length) {
    area.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);">\u{1F4ED} Nicio activitate g\u0103sit\u0103 \u00een intervalul ' + from + ' \u2014 ' + to + '.</div>';
    return;
  }

  let html = '<div style="margin-bottom:16px;font-size:.83rem;color:var(--muted);">Interval: <strong style="color:var(--sub);">' + from + ' \u2014 ' + to + '</strong> &nbsp;\u00b7&nbsp; ' + users.length + ' utilizator(i) cu activitate</div>';
  html += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:24px;">';

  for (const u of users) {
    if (!u.totalOps && !$('rptUser').value) continue;
    const emailKey = u.email.replace(/[^a-z0-9]/gi,'_');
    const emailEsc = u.email.replace(/'/g,"\\'");
    const sub2 = [u.functie||u.email, u.institutie, u.compartiment].filter(Boolean).join(' \u00b7 ');

    const summaryChips = Object.entries(u.counts)
      .sort((a,b) => b[1]-a[1])
      .map(([type, cnt]) => {
        const color = OP_COLORS[type] || '#9db0ff';
        const icon  = OP_ICONS[type]  || '\u2022';
        const label = OP_LABELS_RO[type] || type.replace(/_/g,' ');
        return '<span onclick="toggleUserDetailByType(\'' + emailEsc + '\',\'' + type + '\')" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:.72rem;background:' + color + '22;border:1px solid ' + color + '44;color:' + color + ';margin:2px;cursor:pointer;" title="Click pentru a vedea doar aceste opera\u021biuni">' + icon + ' ' + cnt + '\u00d7 ' + label + '</span>';
      }).join('');

    html += '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">'
      + '<div style="flex:1;min-width:0;">'
      + '<div style="font-weight:700;font-size:.92rem;margin-bottom:2px;">' + escH(u.name||u.email) + '</div>'
      + '<div style="font-size:.76rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escH(u.email) + '">' + escH(sub2) + '</div>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:10px;">'
      + '<div style="font-size:1.4rem;font-weight:800;color:var(--accent);">' + u.totalOps + '</div>'
      + '<button onclick="exportUserPDF(\'' + emailEsc + '\')" style="padding:4px 10px;font-size:.72rem;background:rgba(157,176,255,.12);border:1px solid rgba(157,176,255,.3);border-radius:7px;color:#9db0ff;cursor:pointer;white-space:nowrap;" title="Export raport utilizator">\u{1F4C4} PDF</button>'
      + '</div></div>'
      + '<div>' + (summaryChips || '<span style="font-size:.75rem;color:var(--muted);">Nicio opera\u021biune</span>') + '</div>'
      + '<div onclick="toggleUserDetail(\'' + emailEsc + '\')" style="font-size:.71rem;color:var(--muted);margin-top:8px;text-align:right;cursor:pointer;">\u25bc click pentru detalii</div>'
      + '<div id="detail_' + emailKey + '" style="display:none;margin-top:14px;border-top:1px solid rgba(255,255,255,.06);padding-top:12px;max-height:320px;overflow-y:auto;"></div>'
      + '</div>';
  }
  html += '</div>';
  area.innerHTML = html;
}

function _buildDetailRows(ops, filterType) {
  const filtered = filterType ? ops.filter(op => op.type === filterType) : ops;
  if (!filtered.length) return '<div style="font-size:.8rem;color:var(--muted);">Nicio opera\u021biune de acest tip.</div>';
  return filtered.map(op => {
    const color = OP_COLORS[op.type] || '#9db0ff';
    const icon  = OP_ICONS[op.type]  || '\u2022';
    const labelRO = OP_LABELS_RO[op.type] || escH(op.label || op.type);
    const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone:'Europe/Bucharest', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    return '<div style="display:grid;grid-template-columns:110px 200px 1fr;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);">'
      + '<span style="font-size:.74rem;color:var(--muted);">' + dt + '</span>'
      + '<span style="font-size:.76rem;padding:2px 8px;border-radius:12px;background:' + color + '22;border:1px solid ' + color + '44;color:' + color + ';">' + icon + ' ' + labelRO + '</span>'
      + '<span style="font-size:.76rem;color:var(--sub);" title="' + escH(op.flowId) + '">' + escH(op.docName) + (op.reason ? ' <span style="color:var(--muted);">\u2014 ' + escH(op.reason) + '</span>' : '') + '</span>'
      + '</div>';
  }).join('');
}

function toggleUserDetail(email) {
  const key = email.replace(/[^a-z0-9]/gi,'_');
  const el = document.getElementById('detail_' + key);
  if (!el) return;
  // Daca era deschis pe un tip anume sau complet, toggle
  if (el.style.display !== 'none') { el.style.display = 'none'; el.dataset.activeType = ''; return; }
  const u = (_activityData?.users||[]).find(x => x.email === email);
  if (!u) return;
  el.innerHTML = _buildDetailRows(u.ops || [], null);
  el.dataset.activeType = '';
  el.style.display = '';
}

function toggleUserDetailByType(email, type) {
  const key = email.replace(/[^a-z0-9]/gi,'_');
  const el = document.getElementById('detail_' + key);
  if (!el) return;
  const u = (_activityData?.users||[]).find(x => x.email === email);
  if (!u) return;
  // Daca deja afisat pe acelasi tip, inchide
  if (el.style.display !== 'none' && el.dataset.activeType === type) { el.style.display = 'none'; el.dataset.activeType = ''; return; }
  el.innerHTML = _buildDetailRows(u.ops || [], type);
  el.dataset.activeType = type;
  el.style.display = '';
}

function exportUserPDF(email) {
  const u = (_activityData?.users||[]).find(x => x.email === email);
  if (!u) return;
  const from = isoToDMY(_activityData?.from);
  const to   = isoToDMY(_activityData?.to);

  const rows = (u.ops||[]).map(op => {
    const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone:'Europe/Bucharest', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const labelRO = OP_LABELS_RO[op.type] || op.label || op.type;
    return `<tr><td>${dt}</td><td>${escH(labelRO)}</td><td>${escH(op.docName||'—')}</td><td>${escH(op.reason||'—')}</td></tr>`;
  }).join('');

  const chips = Object.entries(u.counts).map(([type,cnt]) =>
    `<span style="display:inline-block;padding:2px 10px;margin:2px;border-radius:12px;background:#e8eaff;color:#333;font-size:11px;">${OP_ICONS[type]||'•'} ${cnt}× ${escH(OP_LABELS_RO[type]||type)}</span>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Raport activitate — ${escH(u.name||u.email)}</title>
  <style>
    @page { size: A4 landscape; margin: 15mm; }
    body { font-family: Arial, sans-serif; color: #111; font-size: 12px; }
    h1 { font-size: 16px; color: #1a237e; margin-bottom: 4px; }
    .sub { color: #555; font-size: 11px; margin-bottom: 14px; line-height: 1.6; }
    .chips { margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background: #1a237e; color: #fff; padding: 6px 10px; text-align: left; font-size: 11px; }
    td { padding: 5px 10px; border-bottom: 1px solid #e0e0e0; font-size: 11px; }
    tr:nth-child(even) td { background: #f5f6ff; }
    .footer { margin-top: 20px; font-size: 9px; color: #999; border-top: 1px solid #eee; padding-top: 6px; }
  </style>
</head><body>
  <h1>Raport activitate — ${escH(u.name||u.email)}</h1>
  <div class="sub">
    ${escH(u.functie||'')}${u.institutie?' · '+escH(u.institutie):''}${u.compartiment?' / '+escH(u.compartiment):''}<br>
    Email: ${escH(u.email)} &nbsp;|&nbsp; Interval: ${from} — ${to} &nbsp;|&nbsp; Total: <strong>${u.totalOps}</strong> operatiuni
  </div>
  <div class="chips">${chips}</div>
  <table>
    <thead><tr><th>Data si ora</th><th>Operatiune</th><th>Document</th><th>Motiv / Detalii</th></tr></thead>
    <tbody>${rows||'<tr><td colspan="4" style="text-align:center;color:#999;">Nicio operatiune in acest interval.</td></tr>'}</tbody>
  </table>
  <div class="footer">Generat de DocFlowAI · ${new Date().toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})}</div>
  </body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}

// ── Export HTML raport complet ─────────────────────────────────────────────
function exportActivityPDF() {
  if (!_activityData) { alert('Genereaza mai intai un raport.'); return; }
  const from  = isoToDMY(_activityData?.from);
  const to    = isoToDMY(_activityData?.to);
  const users = (_activityData.users||[]).filter(u => u.totalOps > 0);

  const userSections = users.map(u => {
    const chips = Object.entries(u.counts).map(([type,cnt]) =>
      `<span style="display:inline-block;padding:1px 8px;margin:2px;border-radius:10px;background:#e8eaff;color:#333;font-size:10px;">${OP_ICONS[type]||'•'} ${cnt}× ${escH(OP_LABELS_RO[type]||type)}</span>`
    ).join('');
    const rows = (u.ops||[]).map(op => {
      const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone:'Europe/Bucharest', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      return `<tr><td>${dt}</td><td>${escH(OP_LABELS_RO[op.type]||op.label||op.type)}</td><td>${escH(op.docName||'—')}</td><td>${escH(op.reason||'—')}</td></tr>`;
    }).join('');
    const sub = [u.functie, u.institutie, u.compartiment].filter(Boolean).join(' · ');
    return `<div class="user-section">
      <div class="user-header"><strong>${escH(u.name||u.email)}</strong><span class="badge">${u.totalOps} operatiuni</span></div>
      <div class="user-sub">${escH(sub||u.email)}</div>
      <div class="chips">${chips}</div>
      <table><thead><tr><th>Data si ora</th><th>Operatiune</th><th>Document</th><th>Motiv</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="4" style="color:#999;text-align:center;">—</td></tr>'}</tbody></table>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Raport activitate — ${from} — ${to}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    body { font-family: Arial, sans-serif; color: #111; font-size: 11px; }
    h1 { font-size: 18px; color: #1a237e; margin-bottom: 4px; }
    .sub-title { color: #555; margin-bottom: 18px; font-size: 11px; }
    .user-section { margin-bottom: 22px; page-break-inside: avoid; border: 1px solid #dde; border-radius: 4px; padding: 12px; }
    .user-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; font-size: 13px; }
    .badge { background: #1a237e; color: #fff; padding: 2px 10px; border-radius: 12px; font-size: 10px; }
    .user-sub { color: #666; font-size: 10px; margin-bottom: 6px; }
    .chips { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1a237e; color: #fff; padding: 4px 8px; text-align: left; font-size: 10px; }
    td { padding: 3px 8px; border-bottom: 1px solid #eee; font-size: 10px; }
    .footer { margin-top: 16px; font-size: 9px; color: #999; border-top: 1px solid #eee; padding-top: 6px; }
  </style>
</head><body>
  <h1>Raport activitate utilizatori</h1>
  <div class="sub-title">Interval: <strong>${from} — ${to}</strong> &nbsp;|&nbsp; ${users.length} utilizator(i) cu activitate</div>
  ${userSections||'<p style="color:#999;text-align:center;">Nicio activitate in acest interval.</p>'}
  <div class="footer">Generat de DocFlowAI · ${new Date().toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})}</div>
  </body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}


// ── Export CSV ────────────────────────────────────────────────────────────

// ── Export Flows CSV ──────────────────────────────────────────────────────
async function exportFlowsCSV() {
  const search = (document.getElementById('flowSearch').value || '').trim();
  const statusF = document.getElementById('flowStatusFilter').value;
  const instF = document.getElementById('flowInstFilter').value;
  const deptF = document.getElementById('flowDeptFilter').value;
  const statusMap = { active: 'pending', done: 'completed', refused: 'refused', cancelled: 'cancelled', '': 'all' };
  const params = new URLSearchParams({ export: '1', limit: '2000', status: statusMap[statusF] || 'all' });
  if (search) params.set('search', search);
  if (instF) params.set('institutie', instF);
  if (deptF) params.set('compartiment', deptF);
  try {
    const r = await _apiFetch('/admin/flows/list?' + params.toString(), { headers: hdrs() });
    if (!r.ok) throw new Error('Eroare server ' + r.status);
    const resp = await r.json();
    const flows = Array.isArray(resp) ? resp : (resp.flows || []);
    if (!flows.length) { alert('Nu există fluxuri de exportat cu filtrele curente.'); return; }
    const esc = v => '"' + String(v || '').replace(/"/g, '""') + '"';
    const headers = ['ID Flux','Document','Initiator Email','Initiator Nume','Status','Urgent','Institutie','Compartiment','Creat','Nr Semnatari','Semnatari (Nume | Email | Rol | Status | Semnat la)'];
    const rows = flows.map(f => {
      const status = f.completed ? 'finalizat' : f.status === 'refused' ? 'refuzat' : 'activ';
      const signersSummary = (f.signers || []).map(s => {
        const signedAt = s.signedAt ? new Date(s.signedAt).toLocaleDateString('ro-RO') : '-';
        return `${s.name || '-'} | ${s.email || '-'} | ${s.rol || '-'} | ${s.status || '-'} | ${signedAt}`;
      }).join(' // ');
      return [
        f.flowId, f.docName, f.initEmail, f.initName || '-',
        status, f.urgent ? 'DA' : 'Nu',
        f.institutie || '-', f.compartiment || '-',
        f.createdAt ? new Date(f.createdAt).toLocaleDateString('ro-RO') : '-',
        (f.signers || []).length,
        signersSummary
      ].map(esc);
    });
    const csv = [headers.map(h => '"' + h + '"').join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fluxuri_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  } catch(e) { alert('Eroare export CSV: ' + e.message); }
}

async function exportFlowsPDF() {
  const search = (document.getElementById('flowSearch').value || '').trim();
  const statusF = document.getElementById('flowStatusFilter').value;
  const instF = document.getElementById('flowInstFilter').value;
  const deptF = document.getElementById('flowDeptFilter').value;
  const statusMap = { active: 'pending', done: 'completed', refused: 'refused', cancelled: 'cancelled', '': 'all' };
  const params = new URLSearchParams({ export: '1', limit: '2000', status: statusMap[statusF] || 'all' });
  if (search) params.set('search', search);
  if (instF) params.set('institutie', instF);
  if (deptF) params.set('compartiment', deptF);
  try {
    const r = await _apiFetch('/admin/flows/list?' + params.toString(), { headers: hdrs() });
    if (!r.ok) throw new Error('Eroare server ' + r.status);
    const resp = await r.json();
    const flows = Array.isArray(resp) ? resp : (resp.flows || []);
    if (!flows.length) { alert('Nu există fluxuri de exportat cu filtrele curente.'); return; }
    const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
    const filterDesc = [
      search ? `Căutare: „${search}"` : '',
      statusF ? `Status: ${statusF}` : '',
      instF ? `Instituție: ${instF}` : '',
      deptF ? `Compartiment: ${deptF}` : '',
    ].filter(Boolean).join(' &nbsp;|&nbsp; ') || 'Toate fluxurile';
    const escH = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const rows = flows.map((f, idx) => {
      const status = f.completed
        ? '<span class="badge done">✅ finalizat</span>'
        : f.status === 'refused'
        ? '<span class="badge refused">⛔ refuzat</span>'
        : '<span class="badge active">✍ activ</span>';
      const signersHtml = (f.signers || []).map(s => {
        const stClass = s.status === 'signed' ? 'signed' : s.status === 'refused' ? 'ref' : 'pend';
        const signedAt = s.signedAt ? new Date(s.signedAt).toLocaleDateString('ro-RO') : '';
        return `<span class="signer ${stClass}">${escH(s.name || s.email)}${s.rol ? ' (' + escH(s.rol) + ')' : ''}${signedAt ? ' — ' + signedAt : ''}</span>`;
      }).join('');
      return `<tr>
        <td class="idx">${idx + 1}</td>
        <td>${f.urgent ? '<b style="color:#c00;">🚨</b> ' : ''}${escH(f.docName || '—')}<br><small style="color:#888;">${escH(f.flowId)}</small></td>
        <td>${escH(f.initName || '')}${f.initName && f.initEmail ? '<br>' : ''}${f.initEmail ? '<small>' + escH(f.initEmail) + '</small>' : ''}</td>
        <td>${status}</td>
        <td>${escH(f.institutie || '—')}</td>
        <td>${escH(f.compartiment || '—')}</td>
        <td>${f.createdAt ? new Date(f.createdAt).toLocaleDateString('ro-RO') : '—'}</td>
        <td>${signersHtml}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8">
  <title>Fluxuri DocFlowAI — ${new Date().toLocaleDateString('ro-RO')}</title>
  <style>
    @page { size: A4 landscape; margin: 15mm 12mm; }
    body { font-family: Arial, sans-serif; font-size: 10px; color: #111; margin: 0; }
    h2 { color: #1e2a5e; margin: 0 0 4px; font-size: 14px; }
    .meta { color: #555; font-size: 9px; margin-bottom: 4px; }
    .filters { color: #333; font-size: 9px; margin-bottom: 12px; background: #f0f4ff; padding: 4px 8px; border-radius: 4px; display: inline-block; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e2a5e; color: #fff; padding: 5px 6px; text-align: left; font-size: 9px; white-space: nowrap; }
    td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: 9px; }
    tr:nth-child(even) td { background: #f8f9fb; }
    td.idx { color: #aaa; width: 22px; text-align: right; }
    .badge { padding: 2px 6px; border-radius: 8px; font-size: 8px; font-weight: 700; white-space: nowrap; }
    .badge.done { background: #d1fae5; color: #065f46; }
    .badge.refused { background: #fee2e2; color: #991b1b; }
    .badge.active { background: #ede9fe; color: #4c1d95; }
    .signer { display: inline-block; margin: 1px 2px 1px 0; padding: 1px 5px; border-radius: 6px; font-size: 8px; }
    .signer.signed { background: #d1fae5; color: #065f46; }
    .signer.ref { background: #fee2e2; color: #991b1b; }
    .signer.pend { background: #f3f4f6; color: #374151; }
    small { font-size: 8px; color: #888; }
  </style>
</head><body>
  <h2>📋 Fluxuri DocFlowAI</h2>
  <div class="meta">Generat: ${now} &nbsp;|&nbsp; Total: ${flows.length} fluxuri</div>
  <div class="filters">Filtre: ${filterDesc}</div>
  <table>
    <thead><tr>
      <th>#</th><th>Document / ID</th><th>Inițiator</th><th>Status</th>
      <th>Instituție</th><th>Compartiment</th><th>Creat</th><th>Semnatari</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  </body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
  } catch(e) { alert('Eroare export PDF: ' + e.message); }
}

// ── Export Users CSV ──────────────────────────────────────────────────────
function exportUsersCSV() {
  const users = window._filteredUsers || window._allUsers || [];
  if (!users.length) { alert("Nu sunt utilizatori de exportat."); return; }
  // SEC-02: coloana Parola ELIMINATĂ din export — nu se mai stochează/exportă plain_password
  const headers = ["Nume","Functie","Institutie","Compartiment","Email","Telefon","Rol","Notif InApp","Notif Email","Notif WhatsApp","Creat"];
  const esc2 = v => '"' + String(v||"").replace(/"/g,'""') + '"';
  const rows = users.map(u => [
    u.nume, u.functie, u.institutie, u.compartiment, u.email, u.phone, u.role,
    u.notif_inapp!==false?"Da":"Nu",
    u.notif_email?"Da":"Nu",
    u.notif_whatsapp?"Da":"Nu",
    u.created_at ? new Date(u.created_at).toLocaleDateString("ro-RO") : ""
  ].map(esc2));
  const csv = [headers.map(h=>'"'+h+'"').join(","), ...rows.map(r=>r.join(","))].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "utilizatori_" + new Date().toISOString().slice(0,10) + ".csv";
  a.click();
}

function exportUsersPDF() {
  const users = window._filteredUsers || window._allUsers || [];
  if (!users.length) { alert("Nu sunt utilizatori de exportat."); return; }
  const allCount = (window._allUsers || []).length;
  const isFiltered = users.length < allCount;
  const filterNote = isFiltered ? ` (filtrat: ${users.length} din ${allCount})` : ` (${users.length} utilizatori)`;
  const now = new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" });
  const rows = users.map(u => {
    const dt = u.created_at ? new Date(u.created_at).toLocaleDateString("ro-RO") : "-";
    // SEC-04: escaping date user în PDF export — previne HTML injection
    const esc = s => String(s||'-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<tr>
      <td>${esc(u.nume)}</td>
      <td>${esc(u.functie)}</td>
      <td>${esc(u.institutie)}</td>
      <td>${esc(u.compartiment)}</td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.phone)}</td>
      <td><span class="pill ${esc(u.role)}">${u.role==="org_admin"?"Admin Instituție":u.role==="admin"?"Admin":"User"}</span></td>
      <td>${dt}</td>
    </tr>`;
  }).join("");
  const html = `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8">
  <title>Utilizatori DocFlowAI</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 11px; color: #111; margin: 20px; }
    h2 { color: #2d3a5e; margin-bottom: 4px; }
    .sub { color: #888; font-size: 10px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #2d3a5e; color: #fff; padding: 6px 8px; text-align: left; font-size: 10px; }
    td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    tr:nth-child(even) td { background: #f8f9fb; }
    code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 10px; }
    .pill { padding: 2px 7px; border-radius: 10px; font-size: 9px; font-weight: 700; }
    .pill.admin { background: #fef3c7; color: #92400e; }
    .pill.org_admin { background: #fef3c7; color: #b45309; }
    .pill.user { background: #dbeafe; color: #1e40af; }
  </style>
</head><body>
  <h2>📋 Lista Utilizatori — DocFlowAI</h2>
  <div class="sub">Generat: ${now} &nbsp;|&nbsp; Total: ${filterNote}</div>
  <table>
    <thead><tr>
      <th>Nume</th><th>Funcție</th><th>Instituție</th><th>Compartiment</th>
      <th>Email</th><th>Telefon</th><th>Rol</th><th>Creat</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
}

async function exportActivityCSV() {
  if (!_activityData) { alert('Generează mai întâi un raport.'); return; }
  const from = $('rptFrom').value;
  const to   = $('rptTo').value;
  const lines = ['Email,Nume,Functie,Institutie,Compartiment,Data,Operatiune,Document,Motiv'];
  for (const u of _activityData.users || []) {
    for (const op of u.ops || []) {
      const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
      const labelRO = OP_LABELS_RO[op.type] || op.label;
      lines.push(`"${u.email}","${u.name}","${u.functie||''}","${u.institutie||''}","${u.compartiment||''}","${dt}","${labelRO}","${(op.docName||'').replace(/"/g,'""')}","${(op.reason||'').replace(/"/g,'""')}"`);
    }
  }
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `activitate_utilizatori_${isoToDMY($('rptFrom').value)}_${isoToDMY($('rptTo').value)}.csv`;
  a.click();
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
              <div style="font-size:1rem;font-weight:700;color:#eaf0ff;">🏛 ${escH(org.name)}</div>
              ${org.name === 'Default Organization' ? '<span style="font-size:.72rem;padding:2px 8px;background:rgba(255,176,32,.15);border:1px solid rgba(255,176,32,.35);border-radius:10px;color:#ffd580;">⚠ organizație principală — redenumește</span>' : ''}
            </div>
            <div style="font-size:.78rem;color:var(--muted);">
              👥 ${org.user_count} utilizatori &nbsp;·&nbsp; 📁 ${org.flow_count} fluxuri
              &nbsp;·&nbsp; ID: <span style="font-family:monospace;color:#7c5cff;">${org.id}</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button onclick="openRenameOrgModal(${org.id},'${escH(org.name)}')"
              style="padding:7px 12px;background:rgba(45,212,191,.1);border:1px solid rgba(45,212,191,.25);border-radius:8px;color:#7cf0e0;cursor:pointer;font-size:.8rem;font-weight:600;">
              ✏️ Redenumește
            </button>
            <button onclick="openOrgModal(${org.id},'${escH(org.name)}')"
              style="padding:8px 16px;background:rgba(124,92,255,.15);border:1px solid rgba(124,92,255,.3);border-radius:8px;color:#b39dff;cursor:pointer;font-size:.83rem;font-weight:600;white-space:nowrap;">
              ⚙️ Configurare Webhook
            </button>
          </div>
        </div>
        <!-- Status webhook -->
        <div style="margin-top:14px;padding:12px 16px;background:rgba(0,0,0,.2);border-radius:10px;font-size:.8rem;">
          ${org.webhook_url ? `
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="color:${org.webhook_enabled ? '#2dd4bf' : '#ffd580'};">
                ${org.webhook_enabled ? '🟢 Webhook activ' : '🟡 Webhook dezactivat'}
              </span>
              <span style="color:var(--muted);font-family:monospace;font-size:.75rem;overflow:hidden;text-overflow:ellipsis;max-width:340px;" title="${escH(org.webhook_url)}">
                → ${escH(org.webhook_url)}
              </span>
              ${org.webhook_has_secret ? '<span style="color:#2dd4bf;font-size:.72rem;">🔐 HMAC</span>' : '<span style="color:#ffd580;font-size:.72rem;">⚠ fără secret</span>'}
            </div>
            <div style="color:var(--muted);margin-top:6px;">
              Evenimente: ${(org.webhook_events||[]).join(', ') || '—'}
            </div>` : `
            <span style="color:var(--muted);">⚪ Webhook neconfigurat</span>`}
        </div>
      </div>
    `).join('');
  } catch(e) {
    area.innerHTML = `<div style="color:#ffaaaa;">Eroare: ${escH(e.message)}</div>`;
  }
}

// ── Signing Providers — variabile globale (declarate înainte de openOrgModal) ──
let _allProviders      = [];                           // toți providerii din platformă
let _selectedProviders = new Set(['local-upload']);    // provideri activi în org curentă
let _activeConfigProvider = null;                      // providerul configurat activ

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
    // CIF
    $('orgCif').value = org.cif || '';
    // Compartimente
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
let _assignOrgUserId = null;
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
  // Reset
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

    // Succes
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
    btn.onclick = () => { closeOnboardingWizard(); loadOrganizations && loadOrganizations(); };
    msg.textContent = '';
    // Reincarcam lista de organizatii
    setTimeout(() => { loadOrganizations && loadOrganizations(); }, 500);
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
      // Are 2FA activ — oferim optiunea de dezactivare
      if (confirm(`2FA este ACTIV (${d.backupCodesRemaining} coduri backup rămase).

Vrei să îl dezactivezi?`)) {
        open2FADisable();
      }
    } else {
      // Nu are 2FA — deschidem wizard de activare
      open2FASetup();
    }
  } catch(e) { alert('Eroare: ' + e.message); }
}

// ── 2FA TOTP Management ───────────────────────────────────────────────────────
let _totpPendingSecret = null;

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
    // QR code via Google Charts API (nu trimite date sensibile — doar URL-ul otpauth)
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

// ── Analytics Dashboard ──────────────────────────────────────────────────────
let _analyticsData = null;

async function loadAnalytics() {
  const area = document.getElementById('analyticsArea');
  if (!area) return;
  area.innerHTML = '<div style="color:var(--muted);padding:40px;text-align:center;font-size:.9rem;">⏳ Se încarcă datele...</div>';
  try {
    const r = await _apiFetch('/admin/analytics', { headers: hdrs() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error);
    _analyticsData = d;
    renderAnalytics(d, area);
  } catch(e) {
    area.innerHTML = `<div style="color:#ff8080;padding:24px;text-align:center;">❌ ${esc(e.message)}</div>`;
  }
}

function renderAnalytics(d, area) {
  const f = d.flows, s = d.signers, u = d.users;
  const pct = (a,b) => b ? Math.round(a/b*100) : 0;
  // Formatează ore zecimale → "X h și Y min" / "Y min" / "X h"
  const fmtDuration = h => {
    if (h == null) return '—';
    const totalMin = Math.round(h * 60);
    const ore = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    if (ore === 0) return `${min} min`;
    if (min === 0) return `${ore} h`;
    return `${ore} h și ${min} min`;
  };
  const months = ['Ian','Feb','Mar','Apr','Mai','Iun','Iul','Aug','Sep','Oct','Nov','Dec'];
  const fmtMonth = m => { const [y,mo] = m.split('-'); return months[parseInt(mo)-1]+' '+y.slice(2); };

  // Chart bara - max per serie
  const maxCreated = Math.max(...(d.byMonth||[]).map(x=>x.created), 1);

  // Top semnatari pentru tabel
  const topSignersRows = (d.topSigners||[]).map((t,i) => `
    <tr style="${i%2===0?'background:rgba(255,255,255,.02)':''}">
      <td style="padding:7px 10px;color:#eaf0ff;font-size:.83rem;">${esc(t.name||t.email)}</td>
      <td style="padding:7px 10px;color:var(--muted);font-size:.78rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;">${esc(t.email)}</td>
      <td style="padding:7px 10px;text-align:center;color:#9db0ff;font-weight:700;">${t.appearances}</td>
      <td style="padding:7px 10px;text-align:center;color:#2dd4bf;">${t.signed}</td>
      <td style="padding:7px 10px;text-align:center;color:#ff8080;">${t.refused}</td>
      <td style="padding:7px 10px;text-align:center;color:#ffd580;font-size:.8rem;">${t.appearances>0?Math.round(t.signed/t.appearances*100)+'%':'—'}</td>
    </tr>`).join('');

  area.innerHTML = `
    <!-- KPI carduri -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
      ${[
        ['📋','Total',f.total||0,'#9db0ff'],
        ['✅','Finalizate',f.completed||0,'#2dd4bf'],
        ['⚡','Active',f.active||0,'#ffd580'],
        ['⛔','Refuzate',f.refused||0,'#ff8080'],
        ['🚫','Anulate',f.cancelled||0,'#ff9e40'],
        ['🚨','Urgente',(d.urgentStats?.total_urgent||0),'#ff6b6b'],
        ['👥','Utilizatori',u.total||0,'#c4b5ff'],
        ['🆕','Noi (30z)',u.new_last_30||0,'#7cf0e0'],
      ].map(([ic,lbl,val,col])=>`
        <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:14px 12px;text-align:center;">
          <div style="font-size:1.4rem;font-weight:800;color:${col};">${val}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:3px;">${ic} ${lbl}</div>
        </div>`).join('')}
    </div>

    <!-- Metrici performanta -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">⏱ Timp mediu finalizare</div>
        <div style="font-size:1.5rem;font-weight:800;color:#ffd580;">${fmtDuration(f.avg_completion_hours)}</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">📈 Rată finalizare</div>
        <div style="font-size:1.5rem;font-weight:800;color:#2dd4bf;">${pct(f.completed,f.total)}%</div>
        <div style="font-size:.72rem;color:var(--muted);">${f.total||0} total fluxuri</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">📅 Ultimele 30 zile</div>
        <div style="font-size:1.5rem;font-weight:800;color:#9db0ff;">${f.last_30_days||0}</div>
        <div style="font-size:.72rem;color:var(--muted);">fluxuri create</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">🚨 Urgente finalizate</div>
        <div style="font-size:1.5rem;font-weight:800;color:#ff6b6b;">${d.urgentStats?.total_urgent||0}</div>
        <div style="font-size:.72rem;color:var(--muted);">${pct(d.urgentStats?.urgent_completed,d.urgentStats?.total_urgent)}% rezolvate</div>
      </div>
    </div>

    <!-- Chart activitate 6 luni -->
    ${(d.byMonth&&d.byMonth.length) ? `
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:18px;">
      <div style="font-size:.85rem;font-weight:700;color:#9db0ff;margin-bottom:14px;">📅 Activitate — ultimele 6 luni</div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:100px;padding:0 4px;">
        ${d.byMonth.map(m => {
          const barH = Math.max(6, Math.round(m.created/maxCreated*90));
          const compH = m.created ? Math.max(2, Math.round(m.completed/m.created*barH)) : 0;
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;">
            <div style="font-size:.68rem;color:#9db0ff;font-weight:700;">${m.created}</div>
            <div style="width:100%;position:relative;height:${barH}px;background:rgba(157,176,255,.2);border-radius:4px 4px 0 0;overflow:hidden;">
              <div style="position:absolute;bottom:0;width:100%;height:${compH}px;background:#2dd4bf;border-radius:0;"></div>
            </div>
            <div style="font-size:.62rem;color:var(--muted);text-align:center;white-space:nowrap;">${fmtMonth(m.month)}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:16px;margin-top:10px;font-size:.72rem;color:var(--muted);">
        <span style="display:flex;align-items:center;gap:5px;"><span style="width:12px;height:12px;background:rgba(157,176,255,.2);border-radius:2px;display:inline-block;"></span>Create</span>
        <span style="display:flex;align-items:center;gap:5px;"><span style="width:12px;height:12px;background:#2dd4bf;border-radius:2px;display:inline-block;"></span>Finalizate</span>
      </div>
    </div>` : ''}

    <!-- Semnatari + Tip flux -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
        <div style="font-size:.82rem;font-weight:700;color:#9db0ff;margin-bottom:12px;">✍️ Semnatari</div>
        ${[
          ['Semnate',s.signed||0,'#2dd4bf'],
          ['În așteptare',s.pending||0,'#ffd580'],
          ['Refuzate',s.refused||0,'#ff8080'],
        ].map(([lbl,val,col])=>{
          const total = (s.signed||0)+(s.pending||0)+(s.refused||0);
          const w = total ? Math.round(val/total*100) : 0;
          return `<div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:3px;">
              <span style="color:var(--muted);">${lbl}</span>
              <span style="color:${col};font-weight:700;">${val}</span>
            </div>
            <div style="height:6px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${w}%;background:${col};border-radius:3px;transition:width .4s;"></div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
        <div style="font-size:.82rem;font-weight:700;color:#9db0ff;margin-bottom:12px;">📄 Tip flux</div>
        ${(d.byFlowType&&d.byFlowType.length) ? d.byFlowType.map(t => {
          const total = d.flows.total||1;
          const w = Math.round(t.cnt/total*100);
          const col = t.flow_type==='ancore'?'#c4b5ff':'#7cf0e0';
          return `<div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:3px;">
              <span style="color:var(--muted);">${esc(t.flow_type||'tabel')}</span>
              <span style="color:${col};font-weight:700;">${t.cnt} (${w}%)</span>
            </div>
            <div style="height:6px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${w}%;background:${col};border-radius:3px;"></div>
            </div>
          </div>`;
        }).join('') : '<div style="color:var(--muted);font-size:.8rem;">Fără date</div>'}
      </div>
    </div>

    <!-- Top initiatori -->
    ${d.topInitiatori&&d.topInitiatori.length ? `
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
      <div style="font-size:.82rem;font-weight:700;color:#9db0ff;margin-bottom:10px;">🏆 Top inițiatori</div>
      ${d.topInitiatori.map((t,i)=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;${i>0?'border-top:1px solid rgba(255,255,255,.04)':''}">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:.72rem;color:var(--muted);width:16px;text-align:right;">${i+1}.</span>
            <span style="font-size:.83rem;color:#eaf0ff;">${esc(t.name||t.email)}</span>
          </div>
          <span style="font-size:.78rem;color:#ffd580;font-weight:700;">${t.flows} fluxuri</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Top semnatari -->
    ${d.topSigners&&d.topSigners.length ? `
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;">
      <div style="font-size:.82rem;font-weight:700;color:#9db0ff;margin-bottom:10px;">✍️ Top semnatari solicitați</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:.8rem;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,.1);">
              <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600;">Nume</th>
              <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600;display:none;" class="hide-sm">Email</th>
              <th style="padding:6px 10px;text-align:center;color:var(--muted);font-weight:600;">Apariții</th>
              <th style="padding:6px 10px;text-align:center;color:#2dd4bf;font-weight:600;">Semnate</th>
              <th style="padding:6px 10px;text-align:center;color:#ff8080;font-weight:600;">Refuzate</th>
              <th style="padding:6px 10px;text-align:center;color:#ffd580;font-weight:600;">Rată</th>
            </tr>
          </thead>
          <tbody>${topSignersRows}</tbody>
        </table>
      </div>
    </div>` : ''}

    <!-- Footer + Export -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:.72rem;color:var(--muted);">
      <span>Generat la: ${new Date(d.generatedAt).toLocaleString('ro-RO')}</span>
      <div style="display:flex;gap:8px;">
        <button onclick="loadAnalytics()" style="padding:5px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:var(--muted);cursor:pointer;font-size:.72rem;">🔄 Refresh</button>
        <button onclick="exportAnalyticsHTML()" style="padding:5px 12px;background:rgba(45,212,191,.1);border:1px solid rgba(45,212,191,.25);border-radius:6px;color:#2dd4bf;cursor:pointer;font-size:.72rem;font-weight:700;">📄 Export HTML</button>
      </div>
    </div>
  `;
}

function exportAnalyticsHTML() {
  if (!_analyticsData) { alert('Încărcați mai întâi datele.'); return; }
  const d = _analyticsData;
  const f = d.flows, u = d.users;
  const pct = (a,b) => b ? Math.round(a/b*100) : 0;
  const fmtDuration = h => {
    if (h == null) return '—';
    const totalMin = Math.round(h * 60);
    const ore = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    if (ore === 0) return `${min} min`;
    if (min === 0) return `${ore} h`;
    return `${ore} h și ${min} min`;
  };
  const months = ['Ianuarie','Februarie','Martie','Aprilie','Mai','Iunie','Iulie','August','Septembrie','Octombrie','Noiembrie','Decembrie'];
  const fmtMonth = m => { const [y,mo] = m.split('-'); return months[parseInt(mo)-1]+' '+y; };
  const now = new Date(d.generatedAt).toLocaleString('ro-RO', { dateStyle:'full', timeStyle:'short' });
  const orgName = (localStorage.getItem('docflow_user') ? JSON.parse(localStorage.getItem('docflow_user')||'{}').institutie : '') || 'DocFlowAI';

  const html = `<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="UTF-8">
<title>Raport Analytics — ${esc(orgName)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:system-ui,Arial,sans-serif;background:#f8faff;color:#1a2340;padding:40px;}
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #e0e8ff;}
  .logo{font-size:1.4rem;font-weight:900;color:#7c5cff;}
  .subtitle{font-size:.85rem;color:#6b7a99;margin-top:2px;}
  .date{font-size:.8rem;color:#6b7a99;text-align:right;}
  .section{margin-bottom:28px;}
  h2{font-size:1rem;font-weight:700;color:#3a4a6b;margin-bottom:14px;padding-bottom:6px;border-bottom:1px solid #e0e8ff;}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;}
  .kpi{background:#fff;border:1px solid #e0e8ff;border-radius:10px;padding:16px;text-align:center;}
  .kpi-val{font-size:1.8rem;font-weight:800;}
  .kpi-lbl{font-size:.72rem;color:#6b7a99;margin-top:4px;}
  .metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;}
  .metric{background:#fff;border:1px solid #e0e8ff;border-radius:10px;padding:14px;}
  .metric-val{font-size:1.4rem;font-weight:800;margin-top:4px;}
  .metric-lbl{font-size:.75rem;color:#6b7a99;}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e0e8ff;}
  th{padding:10px 14px;text-align:left;background:#f0f4ff;font-size:.78rem;color:#6b7a99;font-weight:600;}
  td{padding:9px 14px;font-size:.83rem;border-top:1px solid #f0f4ff;}
  .bar-wrap{background:#e8eeff;border-radius:4px;height:8px;overflow:hidden;margin-top:4px;}
  .bar-fill{height:100%;border-radius:4px;}
  .chart-row{display:flex;align-items:flex-end;gap:8px;height:120px;padding:0 4px;margin-bottom:8px;}
  .chart-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;}
  .chart-bar-wrap{width:100%;position:relative;background:#e8eeff;border-radius:4px 4px 0 0;}
  .chart-bar-comp{position:absolute;bottom:0;width:100%;background:#2dd4bf;border-radius:0;}
  .chart-lbl{font-size:.65rem;color:#6b7a99;text-align:center;}
  .chart-num{font-size:.7rem;color:#3a4a6b;font-weight:700;}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.72rem;font-weight:600;}
  .footer{margin-top:40px;padding-top:16px;border-top:1px solid #e0e8ff;font-size:.75rem;color:#9ba8c0;text-align:center;}
  @media print{body{padding:20px;}button{display:none!important;}}
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">📊 DocFlowAI — Raport Analytics</div>
    <div class="subtitle">${esc(orgName)}</div>
  </div>
  <div class="date">
    <div>Generat la:</div>
    <strong>${now}</strong>
    <div style="margin-top:8px;">
      <button onclick="window.print()" style="padding:6px 14px;background:#7c5cff;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:.8rem;font-weight:700;">🖨️ Printează / PDF</button>
    </div>
  </div>
</div>

<div class="section">
  <h2>📋 Sumar fluxuri</h2>
  <div class="kpi-grid">
    ${[
      ['Total',f.total||0,'#7c5cff'],
      ['Finalizate',f.completed||0,'#2dd4bf'],
      ['Active',f.active||0,'#f59e0b'],
      ['Refuzate',f.refused||0,'#ef4444'],
      ['Anulate',f.cancelled||0,'#f97316'],
      ['Urgente',d.urgentStats?.total_urgent||0,'#dc2626'],
      ['Utilizatori',u.total||0,'#8b5cf6'],
      ['Noi (30 zile)',u.new_last_30||0,'#0d9488'],
    ].map(([l,v,c])=>`<div class="kpi"><div class="kpi-val" style="color:${c};">${v}</div><div class="kpi-lbl">${l}</div></div>`).join('')}
  </div>
</div>

<div class="section">
  <h2>⚡ Performanță</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-lbl">Timp mediu finalizare</div><div class="metric-val" style="color:#f59e0b;">${fmtDuration(f.avg_completion_hours)}</div></div>
    <div class="metric"><div class="metric-lbl">Rată finalizare</div><div class="metric-val" style="color:#2dd4bf;">${pct(f.completed,f.total)}%</div></div>
    <div class="metric"><div class="metric-lbl">Fluxuri (7 zile)</div><div class="metric-val" style="color:#7c5cff;">${f.last_7_days||0}</div></div>
    <div class="metric"><div class="metric-lbl">Urgente rezolvate</div><div class="metric-val" style="color:#dc2626;">${pct(d.urgentStats?.urgent_completed,d.urgentStats?.total_urgent)}%</div></div>
  </div>
</div>

${d.byMonth&&d.byMonth.length ? `
<div class="section">
  <h2>📅 Activitate — ultimele 6 luni</h2>
  <div class="chart-row">
    ${(() => {
      const maxV = Math.max(...d.byMonth.map(x=>x.created),1);
      return d.byMonth.map(m => {
        const bh = Math.max(8, Math.round(m.created/maxV*110));
        const ch = m.created ? Math.max(2,Math.round(m.completed/m.created*bh)) : 0;
        return `<div class="chart-col">
          <div class="chart-num">${m.created}</div>
          <div class="chart-bar-wrap" style="height:${bh}px;">
            <div class="chart-bar-comp" style="height:${ch}px;"></div>
          </div>
          <div class="chart-lbl">${fmtMonth(m.month)}</div>
        </div>`;
      }).join('');
    })()}
  </div>
  <div style="display:flex;gap:16px;font-size:.75rem;color:#6b7a99;">
    <span>■ <span style="color:#b0bcdd;">Create</span></span>
    <span>■ <span style="color:#2dd4bf;">Finalizate</span></span>
  </div>
</div>` : ''}

${d.topInitiatori&&d.topInitiatori.length ? `
<div class="section">
  <h2>🏆 Top inițiatori</h2>
  <table>
    <thead><tr><th>#</th><th>Nume</th><th>Email</th><th>Fluxuri</th></tr></thead>
    <tbody>${d.topInitiatori.map((t,i)=>`<tr><td>${i+1}</td><td>${esc(t.name||'—')}</td><td>${esc(t.email)}</td><td><strong>${t.flows}</strong></td></tr>`).join('')}</tbody>
  </table>
</div>` : ''}

${d.topSigners&&d.topSigners.length ? `
<div class="section">
  <h2>✍️ Top semnatari solicitați</h2>
  <table>
    <thead><tr><th>Nume</th><th>Email</th><th>Apariții</th><th>Semnate</th><th>Refuzate</th><th>Rată semnare</th></tr></thead>
    <tbody>${d.topSigners.map(t=>`<tr>
      <td>${esc(t.name||'—')}</td>
      <td>${esc(t.email)}</td>
      <td style="text-align:center;">${t.appearances}</td>
      <td style="text-align:center;color:#2dd4bf;font-weight:700;">${t.signed}</td>
      <td style="text-align:center;color:#ef4444;">${t.refused}</td>
      <td style="text-align:center;"><strong>${t.appearances?Math.round(t.signed/t.appearances*100)+'%':'—'}</strong></td>
    </tr>`).join('')}</tbody>
  </table>
</div>` : ''}

<div class="footer">
  DocFlowAI · Raport generat automat la ${now} · Confidențial — uz intern
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `Analytics_DocFlowAI_${dateStr}.html`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


document.addEventListener('keydown', e => {
  if (e.key==='Escape' && document.getElementById('assignOrgModal')?.style.display==='flex') closeAssignOrg();
});

// ── Redenumire organizație ────────────────────────────────────────────────
let _renameOrgId = null;
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
      if (msg) { msg.style.color = '#2dd4bf'; msg.textContent = '✅ Redenumit cu succes.'; }
      setTimeout(() => { closeRenameOrgModal(); loadOrganizations(); }, 700);
    } else {
      if (msg) { msg.style.color = '#ffaaaa'; msg.textContent = '❌ ' + (j.error || 'Eroare.'); }
    }
  } catch(e) {
    if (msg) { msg.style.color='#ffaaaa'; msg.textContent='❌ Eroare rețea.'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvează'; }
  }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('renameOrgModal')?.style.display === 'flex')
    closeRenameOrgModal();
});





// Lista fallback — statică, identică cu ce returnează serverul
const _PROVIDERS_FALLBACK = [
  { id: 'local-upload', label: 'Upload local (orice certificat calificat)', mode: 'upload' },
  { id: 'sts-cloud',   label: 'STS Cloud QES (Serviciul de Telecomunicații Speciale)', mode: 'redirect' },
  { id: 'certsign',   label: 'certSIGN / Paperless QES', mode: 'redirect' },
  { id: 'transsped',  label: 'Trans Sped QES', mode: 'redirect' },
  { id: 'alfatrust',  label: 'AlfaTrust / AlfaSign QES', mode: 'redirect' },
  { id: 'namirial',   label: 'Namirial eSignAnyWhere QES', mode: 'redirect' },
];

async function loadOrgSigningProviders(orgId) {
  try {
    // Încarcă lista tuturor provideri din platformă
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

    // Încarcă config curentă a org-ului (non-fatal dacă migrarea 033 nu e încă aplicată)
    let configSafe = {}, enabledProviders = ['local-upload'];
    try {
      const r2 = await _apiFetch(`/admin/organizations/${orgId}/signing`, { headers: hdrs() });
      if (r2.ok) {
        const j = await r2.json();
        enabledProviders = j.enabled || ['local-upload'];
        configSafe = j.configSafe || {};
      }
    } catch(e2) { /* non-fatal — DB poate nu are încă coloana signing_providers_enabled */ }

    _selectedProviders = new Set(enabledProviders);
    renderOrgProvidersGrid(configSafe);
  } catch(e) { console.warn('[signing] loadOrgSigningProviders error:', e); }
}

function renderOrgProvidersGrid(configSafe = {}) {
  window._orgConfigSafe = configSafe; // FIX: stocat global pentru openProviderConfig
  const grid = document.getElementById('orgProvidersGrid');
  // Dacă _allProviders e gol din orice motiv, folosim fallback-ul direct
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
    // FIX: STS e "configurat" dacă are clientId sau hasPrivateKey
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
  _selectedProviders.add('local-upload'); // întotdeauna prezent
}

function openProviderConfig(providerId, label) {
  _activeConfigProvider = providerId;
  const area  = document.getElementById('orgProviderConfigArea');
  const title = document.getElementById('orgProviderConfigTitle');
  const isSts = providerId === 'sts-cloud';

  if (area)  area.style.display = '';
  if (title) title.textContent = `⚙ Configurare: ${label}`;

  // Afișăm panoul corect
  const configGeneric = document.getElementById('configGeneric');
  const configSts     = document.getElementById('configSts');
  if (configGeneric) configGeneric.style.display = isSts ? 'none' : '';
  if (configSts)     configSts.style.display     = isSts ? ''     : 'none';

  if (isSts) {
    // FIX: repopulăm câmpurile STS din configSafe (non-sensitive)
    const saved = (window._orgConfigSafe || {})['sts-cloud'] || {};
    const el = id => document.getElementById(id);

    if (el('stsClientId'))   el('stsClientId').value   = saved.clientId   || '';
    if (el('stsKid'))        el('stsKid').value         = saved.kid        || '';
    if (el('stsIdpUrl'))     el('stsIdpUrl').value      = saved.idpUrl     || '';
    if (el('stsApiUrl'))     el('stsApiUrl').value      = saved.apiUrl     || '';
    // redirectUri: din config salvat sau fallback la URL curent
    if (el('stsRedirectUri')) el('stsRedirectUri').value = saved.redirectUri || (window.location.origin + '/flows/sts-oauth-callback');
    // Cheia privată nu se returnează din server — afișăm placeholder dacă există
    if (el('stsPrivateKeyPem')) {
      el('stsPrivateKeyPem').value = '';
      el('stsPrivateKeyPem').placeholder = saved.hasPrivateKey
        ? '● ● ● Cheie privată salvată — introduceți o nouă cheie doar dacă doriți să o schimbați'
        : '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----';
    }
    // Cheia publică — non-sensitivă, afișată complet
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

    // Populăm automat cheia privată în câmpul de config
    const privEl = document.getElementById('stsPrivateKeyPem');
    if (privEl) privEl.value = j.privateKeyPem;

    // Afișăm cheia publică pentru copiere
    const pubEl = document.getElementById('stsPublicKeyDisplay');
    if (pubEl) pubEl.value = j.publicKeyPem;
    // Populăm și câmpul de stocare cheie publică
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
      // Daca cheia privata e goala (utilizatorul nu a introdus una noua),
      // semnalam backend-ului sa foloseasca cheia stocata in DB
      if (!config.privateKeyPem) {
        const saved = (window._orgConfigSafe || {})['sts-cloud'] || {};
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

// Salvează providerii activi + config (apelat din saveOrgWebhook)
async function saveOrgSigningProviders(orgId) {
  if (!orgId) return;
  // Asigurăm că local-upload e mereu în listă
  _selectedProviders.add('local-upload');
  const enabled = [..._selectedProviders];
  // Construiește config pentru providerul activ editat
  const config = {};
  if (_activeConfigProvider) {
    if (_activeConfigProvider === 'sts-cloud') {
      // FIX: câmpuri specifice STS — salvate complet
      const clientId     = document.getElementById('stsClientId')?.value?.trim()     || '';
      const kid          = document.getElementById('stsKid')?.value?.trim()           || '';
      const redirectUri  = document.getElementById('stsRedirectUri')?.value?.trim()   || '';
      const privateKeyPem= document.getElementById('stsPrivateKeyPem')?.value?.trim() || '';
      const idpUrl       = document.getElementById('stsIdpUrl')?.value?.trim()        || '';
      const apiUrl       = document.getElementById('stsApiUrl')?.value?.trim()        || '';
      if (clientId || kid || privateKeyPem) {
        // FIX: provider-ul configurat trebuie activat automat în lista enabled
        _selectedProviders.add('sts-cloud');
        config['sts-cloud'] = {};
        if (clientId)      config['sts-cloud'].clientId      = clientId;
        if (kid)           config['sts-cloud'].kid           = kid;
        if (redirectUri)   config['sts-cloud'].redirectUri   = redirectUri;
        // FIX: trimitem privateKeyPem DOAR dacă userul a introdus o valoare nouă
        // Dacă e gol, backend-ul păstrează cheia existentă prin merge
        if (privateKeyPem && !privateKeyPem.startsWith('●')) config['sts-cloud'].privateKeyPem = privateKeyPem;
        // Cheia publică — stocată ca referință, non-sensitivă
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
  } catch(e) { /* non-fatal — webhook e salvat oricum */ }
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

// Extinde saveOrgWebhook să salveze și signing provider
const _origSaveOrgWebhook = typeof saveOrgWebhook === 'function' ? saveOrgWebhook : null;
async function saveOrgWebhookWithSigning() {
  // Salvăm mai întâi webhook-ul (funcția originală)
  if (_origSaveOrgWebhook) await _origSaveOrgWebhook();
  // Salvăm signing provider dacă e selectat și diferit de default
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
  } catch(e) { /* non-fatal — webhook e salvat deja */ }
}


function orgGenSecret() {
  // Generare secret 32 bytes hex pe client
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
  $('orgWebhookSecret').value = hex;
  $('orgWebhookSecret').type = 'text';
  setTimeout(() => { if($('orgWebhookSecret')) $('orgWebhookSecret').type = 'password'; }, 5000);
}

// ── Compartimente org — state + helpers ──────────────────────────────────
let _orgCompartimente = [];

function _renderCompartimente() {
  const el = $('orgCompartimenteList');
  if (!el) return;
  el.innerHTML = _orgCompartimente.map((c, i) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;background:rgba(124,92,255,.18);border:1px solid rgba(124,92,255,.35);color:#c4b5ff;font-size:.78rem;">
      ${escH(c)}
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

async function saveOrgWebhook() {
  if (!_currentOrgId) return;
  const msg = $('orgEditMsg');
  const events = [];
  if ($('evtCompleted').checked) events.push('flow.completed');
  if ($('evtRefused').checked) events.push('flow.refused');
  if ($('evtCancelled').checked) events.push('flow.cancelled');
  // Includem providerii de semnare în același request (atomic — un singur PUT)
  _selectedProviders.add('local-upload');
  // Adaugă compartimentul din input dacă nu s-a apăsat Enter
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
      // Salvăm și config-ul de signing (STS keys etc.) — request separat la /signing
      await saveOrgSigningProviders(_currentOrgId);
      msg.innerHTML = '<span style="color:#2dd4bf;">✅ Salvat cu succes.</span>';
      setTimeout(() => { closeOrgModal(); loadOrganizations(); }, 800);
    } else {
      msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(j.error||'Eroare')}</span>`;
    }
  } catch(e) {
    msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(e.message)}</span>`;
  }
}

async function orgTestWebhook() {
  if (!_currentOrgId) return;
  const msg = $('orgEditMsg');
  // Salvăm mai întâi URL-ul curent dacă s-a modificat
  const url = $('orgWebhookUrl').value.trim();
  if (!url) { msg.innerHTML = '<span style="color:#ffd580;">⚠ Introduceți un URL înainte de test.</span>'; return; }
  msg.textContent = '⏳ Se trimite eveniment de test...';
  try {
    // Salvăm URL-ul temporar pentru test
    await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
      method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_url: url }),
    });
    const r = await _apiFetch(`/admin/organizations/${_currentOrgId}/test-webhook`, {
      method: 'POST', headers: hdrs(),
    });
    const j = await r.json();
    if (j.ok) {
      msg.innerHTML = `<span style="color:#2dd4bf;">✅ ${escH(j.message)} (HTTP ${j.status})</span>`;
    } else {
      msg.innerHTML = `<span style="color:#ffd580;">⚠ ${escH(j.message || j.error)}</span>`;
    }
  } catch(e) {
    msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${escH(e.message)}</span>`;
  }
}

// ── User menu dropdown (page-header) ───────────────────────────────────────
function toggleUserMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('df-user-menu');
  if (!menu) return;
  const isOpen = menu.classList.toggle('open');
  const trig = menu.querySelector('.df-user-trigger');
  if (trig) trig.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}
function closeUserMenu() {
  const menu = document.getElementById('df-user-menu');
  if (menu) menu.classList.remove('open');
  const trig = menu?.querySelector('.df-user-trigger');
  if (trig) trig.setAttribute('aria-expanded', 'false');
}
// Click in afara dropdown-ului → inchide
document.addEventListener('click', (e) => {
  const menu = document.getElementById('df-user-menu');
  if (!menu || !menu.classList.contains('open')) return;
  if (!menu.contains(e.target)) closeUserMenu();
});
// ESC → inchide
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeUserMenu();
});
