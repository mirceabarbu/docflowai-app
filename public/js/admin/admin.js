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


// ══════════════════════════════════════════════════════════════════
// OUTREACH MODULE
// ══════════════════════════════════════════════════════════════════


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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

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

// ── Date helpers ─────────────────────────────────────────────────────────
/** Escape HTML pentru output sigur în innerHTML */
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
