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


// ══════════════════════════════════════════════════════════════════
// OUTREACH MODULE
// ══════════════════════════════════════════════════════════════════



// ── Date helpers ─────────────────────────────────────────────────────────
/** Escape HTML pentru output sigur în innerHTML */
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }





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
