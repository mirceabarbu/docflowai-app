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
