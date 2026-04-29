// public/js/formular/alop.js
// DocFlowAI - Modul ALOP + REVIZIE (BLOC 2.2).
// Cross-module export: window._alopLinkDoc (apelata din saveDoc)
// Local state: _ALOP, ROLE_LABEL, _lichidareAlopId,
//   _plataAlopId, _plataOrdValoare, _revizieTargetId, _revizieAlopId
// Runtime bare deps din formular.js: ST, _escH, pMR, fMR, getCsrf,
//   setS, sw, loadList, switchListTab, newDocFromList, openDocFromList,
//   genPdf, mkFlow, initDateDisplayRo

(function () {
  'use strict';
  const esc = window.df.esc;

  // -- State vars hoistate --------------------------------------------------
  let _lichidareAlopId = null;
  let _plataAlopId = null;
  let _plataOrdValoare = 0;
  let _revizieTargetId = null;
  let _revizieAlopId = null;

  // -- Cross-module: leaga document la ALOP ---------------------------------
// ── Helper: leagă document la ALOP imediat (idempotent, async cu logging) ──────
async function _alopLinkDoc(ft, docId){
  const alopId=window._alopContext?.alopId;
  if(!alopId||!docId)return;
  const endpoint=ft==='notafd'?'link-df':'link-ord';
  const body=ft==='notafd'?{df_id:docId}:{ord_id:docId};
  console.log(`ALOP ${endpoint}: ${alopId} → ${docId}`);
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}/${endpoint}`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify(body),
    });
    const j=await r.json();
    if(r.ok)console.log(`✅ link-df ok:`,alopId,docId);
    else console.warn(`ALOP ${endpoint} warn:`,j.error);
  }catch(e){console.warn(`ALOP ${endpoint} error:`,e);}
}


// ══════════════════════════════════════════════════════════════════════════════
// ALOP MODULE — Ord. 1140/2025
// Faze: draft → angajare → lichidare → ordonantare → plata → completed
// ══════════════════════════════════════════════════════════════════════════════

const _ALOP = {};

const ROLE_LABEL = {
  initiator:         'Inițiator',
  sef_compartiment:  'Șef compartiment',
  responsabil_cab:   'Responsabil CAB',
  sef_cab:           'Șef compartiment CAB',
  director_economic: 'Director Economic',
  ordonator_credite: 'Ordonator de credite',
  cfp_propriu:       'CFP Propriu',
};

function _alopStatusBadge(status, dfFlowId){
  const m={
    'draft':       {label:'📝 Draft',       color:'#64748b'},
    'angajare':    {label:'🟠 DF în lucru',   color:'#f97316'},
    'lichidare':   {label:'🟡 Lichidare',    color:'#f59e0b'},
    'ordonantare': {label:'🟣 Ordonanțare',  color:'#8b5cf6'},
    'plata':       {label:'🟠 Plată',        color:'#f97316'},
    'completed':   {label:'✅ Finalizat',    color:'#10b981'},
    'cancelled':   {label:'🔴 Anulat',       color:'#ef4444'},
  };
  let s=m[status]||{label:status,color:'#64748b'};
  if(status==='angajare'&&dfFlowId) s={label:'⏳ Pe flux — semnare',color:'#6366f1'};
  return`<span style="background:${s.color}22;color:${s.color};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600">${esc(s.label)}</span>`;
}
function _alopFazaLabel(status){
  const m={'draft':'—','angajare':'Faza 1: Angajare','lichidare':'Faza 2: Lichidare',
    'ordonantare':'Faza 3: Ordonanțare','plata':'Faza 4: Plată','completed':'Finalizat','cancelled':'Anulat'};
  return m[status]||status;
}

async function loadAlopStats(){
  try{
    const r=await fetch('/api/alop/stats',{credentials:'include'});
    if(!r.ok)return;
    const d=await r.json();
    const e=id=>document.getElementById(id);
    if(e('alop-kpi-total'))      e('alop-kpi-total').textContent     =d.total||0;
    if(e('alop-kpi-completate')) e('alop-kpi-completate').textContent =d.completate||0;
    if(e('alop-kpi-progres'))    e('alop-kpi-progres').textContent    =d.in_progres||0;
    if(e('alop-kpi-draft'))      e('alop-kpi-draft').textContent      =d.draft||0;
  }catch(_){}
}

function _updateAlopSablonBtnVisibility(){
  const btn=document.getElementById('alop-btn-sablon');
  if(!btn)return;
  const role=ST.user?.role;
  btn.style.display=(role==='admin'||role==='org_admin')?'':'none';
}

async function loadAlop(){
  _updateAlopSablonBtnVisibility();
  const tb=document.getElementById('alop-tbody');
  if(!tb)return;
  tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--df-text-3)">Se încarcă...</td></tr>';
  try{
    const r=await fetch('/api/alop',{credentials:'include'});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'server_error');
    const rows=data.alop||[];
    if(!rows.length){
      tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--df-text-3)">Niciun ALOP creat.</td></tr>';
      return;
    }
    const fmtRON=v=>v!=null?new Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON',maximumFractionDigits:0}).format(v):'—';
    tb.innerHTML=rows.map(a=>{
      const dt=new Date(a.updated_at||a.created_at).toLocaleDateString('ro-RO');
      const active=a.status!=='completed'&&a.status!=='cancelled';
      return`<tr onclick="openAlop('${esc(a.id)}')" style="cursor:pointer">
        <td><span style="font-weight:600;color:var(--df-text)">${esc(a.titlu||'—')}</span>
          ${a.compartiment?`<br><span style="font-size:.75rem;color:var(--df-text-3)">${esc(a.compartiment)}</span>`:''}
        </td>
        <td style="font-size:.78rem;color:var(--df-text-3)">${esc(a.creator_name||a.creator_email||'—')}</td>
        <td>${_alopStatusBadge(a.status,a.df_flow_id)}</td>
        <td style="font-size:.78rem;color:var(--df-text-3)">${esc(_alopFazaLabel(a.status))}</td>
        <td style="font-size:.82rem">
          <div>${fmtRON(a.valoare_totala)}</div>
          ${(() => {
            // FIX v3.9.338: afișează totaluri (toate ciclurile), nu doar ciclul curent
            const _ordTotal = parseFloat(a.total_ord_valoare || a.ord_valoare || 0);
            const _platTotal = parseFloat(a.total_platit || a.op_valoare || 0);
            const _dfVal = parseFloat(a.df_valoare || 0);
            if (_dfVal === 0 && _ordTotal === 0 && _platTotal === 0) return '';
            return `<div style="font-size:.7rem;color:var(--df-text-3);margin-top:2px;white-space:nowrap">
              ${_dfVal?`<span title="Valoare DF" style="color:#b0a0ff">DF ${fmtRON(_dfVal)}</span>`:''}
              ${_ordTotal?`<span title="Valoare ORD (toate ciclurile)" style="color:#5dcaa5;margin-left:6px">ORD ${fmtRON(_ordTotal)}</span>`:''}
              ${_platTotal?`<span title="Sumă plătită (toate ciclurile)" style="color:#f59e0b;margin-left:6px">✓ ${fmtRON(_platTotal)}</span>`:''}
            </div>`;
          })()}
        </td>
        <td style="font-size:.78rem;color:var(--df-text-3)">${dt}</td>
        <td onclick="event.stopPropagation()">
          <button class="df-action-btn sm" onclick="openAlop('${esc(a.id)}')">Deschide</button>
          ${active?`<button class="df-action-btn danger sm" style="margin-left:4px" onclick="cancelAlop('${esc(a.id)}')" title="Anulează ALOP">✕</button>`:''}
        </td>
      </tr>`;
    }).join('');
  }catch(e){
    if(tb)tb.innerHTML=`<tr><td colspan="7" style="text-align:center;padding:20px;color:#f87171">Eroare: ${esc(e.message)}</td></tr>`;
  }
}

// ── Wizard modal ──────────────────────────────────────────────────────────────

async function openAlopModal(){
  ['alop-titlu','alop-compartiment','alop-notes'].forEach(id=>{
    const e=document.getElementById(id);if(e)e.value='';
  });
  const v=document.getElementById('alop-valoare');if(v)v.value='';
  // Pre-completare compartiment din profilul utilizatorului
  const compInput = document.getElementById('alop-compartiment');
  if (compInput && ST.user?.compartiment) {
    compInput.value = ST.user.compartiment;
    compInput.readOnly = true;
    compInput.style.opacity = '0.7';
    compInput.style.cursor = 'default';
  } else if (compInput) {
    compInput.readOnly = false;
    compInput.style.opacity = '';
    compInput.style.cursor = '';
  }
  document.getElementById('alop-modal').style.display='flex';
}
function closeAlopModal(){document.getElementById('alop-modal').style.display='none';}

async function createAlop(){
  const titlu=(document.getElementById('alop-titlu')?.value||'').trim();
  const compartiment=(document.getElementById('alop-compartiment')?.value||'').trim();
  const valoare=pMR(document.getElementById('alop-valoare')?.value)||null;
  const notes=(document.getElementById('alop-notes')?.value||'').trim();
  if(!titlu){alert('Titlul este obligatoriu.');return;}
  try{
    const r=await fetch('/api/alop',{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify({titlu,compartiment,valoare_totala:valoare,notes}),
    });
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'server_error');
    closeAlopModal();
    openAlop(data.alop.id);
    loadAlop();loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}

// ── Detaliu ALOP ──────────────────────────────────────────────────────────────
async function openAlop(id){
  if(!id||id==='null'||id==='undefined'){console.error('openAlop: id invalid:',id);return;}
  window._currentAlopId=id;
  clearInterval(window._alopRefreshInterval);
  const listPanel=document.getElementById('alop-list-panel');
  const detailPanel=document.getElementById('alop-detail-panel');
  const content=document.getElementById('alop-detail-content');
  if(listPanel)listPanel.style.display='none';
  if(detailPanel)detailPanel.style.display='';
  if(content)content.innerHTML='<div style="text-align:center;padding:32px;color:var(--df-text-3)">Se încarcă...</div>';
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}`,{credentials:'include'});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'not_found');
    renderAlopDetail(data.alop,content);
  }catch(e){
    if(content)content.innerHTML=`<div style="color:#f87171;padding:20px">Eroare: ${esc(e.message)}</div>`;
  }
}
function closeAlopDetail(){
  clearInterval(window._alopRefreshInterval);
  window._alopContext=null;
  sessionStorage.removeItem('_alopContext');
  window._currentAlopId=null;
  document.getElementById('alop-list-panel').style.display='';
  document.getElementById('alop-detail-panel').style.display='none';
}
async function alopRefreshCurrent(){
  if(!window._currentAlopId)return;
  await openAlop(window._currentAlopId);
  loadAlop();loadAlopStats();
}

function renderAlopDetail(a,container){
  if(!a||!a.id)return;
  // Suma plătită în ciclurile anterioare — folosită de populateOrd pentru prefill plati_anterioare
  window._alopSumaPlataAnterioara=parseFloat(a.suma_platita_total||0)||0;
  // FIX 1: Resetează contextul DF/ORD din sesiunea anterioară când ALOP-ul se schimbă
  const _prevAlopId=window._alopContext?.alopId;
  if(_prevAlopId&&_prevAlopId!==a.id){
    ST.docId=ST.docId||{};ST.docId['notafd']=null;ST.docId['ordnt']=null;
    ST.docStatus=ST.docStatus||{};ST.docStatus['notafd']=null;ST.docStatus['ordnt']=null;
    ST.docAprobat=ST.docAprobat||{};ST.docAprobat['notafd']=false;ST.docAprobat['ordnt']=false;
  }
  // Stochează contextul ALOP activ pentru mkFlow (pre-populare semnatari)
  window._alopContext={alopId:a.id,titlu:a.titlu||'',valoare:a.valoare_totala||null,dfSemnatari:a.df_semnatari||[],ordSemnatari:a.ord_semnatari||[]};
  sessionStorage.setItem('_alopContext',JSON.stringify(window._alopContext));
  const isCompleted=a.status==='completed';
  const isCancelled=a.status==='cancelled';
  const fmtDate=iso=>iso?new Date(iso).toLocaleString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  const fmtRON=v=>v!=null?new Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON'}).format(v):'—';
  const fmtV=v=>v>0?new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v)+' RON':'—';

  const phases=[
    {label:'Angajare',   icon:'📋',color:'#3b82f6',
     done:!!a.df_completed_at||isCompleted,
     active:a.status==='angajare',
     sub:(!a.df_id)?'Fără DF'
        :(a.status==='angajare'&&a.df_flow_id)?'🔄 DF pe fluxul de semnare — în așteptare'
        :(['lichidare','ordonantare','plata','completed'].includes(a.status)||isCompleted)?'✅ DF aprobat'
        :(a.status==='angajare'&&!a.df_flow_id)?'📝 DF în lucru'
        :`DF: ${a.df_nr||a.df_id.slice(0,8)}`},
    {label:'Lichidare',  icon:'✔️',color:'#f59e0b',
     done:(!!a.lichidare_confirmed_at&&a.status!=='lichidare')||isCompleted,
     active:a.status==='lichidare',
     sub:a.lichidare_confirmed_at?`Confirmat ${fmtDate(a.lichidare_confirmed_at)}`:'În așteptare'},
    {label:'Ordonanțare',icon:'💰',color:'#8b5cf6',
     done:!!a.ord_completed_at||isCompleted,
     active:a.status==='ordonantare',
     sub:a.ord_id?'ORD aprobat':'Fără ORD'},
    {label:'Plată',      icon:'🏦',color:'#10b981',
     done:isCompleted,
     active:a.status==='plata',
     sub:a.plata_confirmed_at?`Confirmat ${fmtDate(a.plata_confirmed_at)}`:'În așteptare'},
  ];

  let stepperHtml=`<div style="display:flex;align-items:stretch;gap:4px;margin-bottom:20px;flex-wrap:wrap">`;
  phases.forEach((p,i)=>{
    const col=p.done?p.color:p.active?p.color:'var(--df-text-3)';
    const bg=p.done?`${p.color}22`:p.active?`${p.color}15`:'rgba(255,255,255,.03)';
    const op=(!p.done&&!p.active&&!isCancelled)?';opacity:.45':'';
    stepperHtml+=`<div style="flex:1;min-width:130px;background:${bg};border:1.5px solid ${col}44;border-radius:10px;padding:12px;text-align:center${op}">
      <div style="font-size:1.2rem">${p.icon}</div>
      <div style="font-size:.79rem;font-weight:700;color:${col};margin-top:4px">${p.done?'✓ ':''}${esc(p.label)}</div>
      <div style="font-size:.71rem;color:var(--df-text-3);margin-top:2px">${esc(p.sub)}</div>
    </div>`;
    if(i<3)stepperHtml+=`<div style="align-self:center;color:var(--df-text-3);font-size:.9rem;padding:0 1px">→</div>`;
  });
  stepperHtml+=`</div>`;

  let actionsHtml='';
  const currentUserId = ST.user?.userId;
  const isAlopOwner = !currentUserId || String(a.created_by) === String(currentUserId)
    || ST.user?.role === 'admin'
    || ST.user?.role === 'org_admin';
  console.log('[ALOP owner check]', {
    currentUserId, aCreatedBy: a.created_by,
    match: String(a.created_by) === String(currentUserId),
    role: ST.user?.role, isAlopOwner
  });
  if(!isCompleted&&!isCancelled&&isAlopOwner){
    const id=esc(a.id);
    const dfInLucru=!!a.df_revizie_in_lucru;
    const dfStatus=a.df_status||'';
    if(dfInLucru){
      actionsHtml+=`<button class="df-action-btn" disabled title="Există deja o revizie DF în lucru — finalizați revizia curentă">📋 Revizie DF în lucru...</button>`;
    }else if(!a.df_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">📋 Completează Document de Fundamentare</button>`;
    }else if(dfStatus==='neaprobat'){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">📋 Revizuiește DF (neaprobat)</button>`;
    }else if(a.status==='angajare'&&a.df_flow_id){
      actionsHtml+=`<span style="color:var(--df-text-3);font-size:.85rem">🔄 DF pe fluxul de semnare — în așteptare</span>`;
    }else if(['aprobat','transmis_flux','de_revizuit'].includes(dfStatus)){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">📋 Deschide DF</button>`;
    }else if(a.df_id&&!a.df_flow_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">📋 Deschide DF</button>`;
    }else{
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">📋 Completează Document de Fundamentare</button>`;
    }
    if(a.status==='lichidare'&&!a.lichidare_confirmed_at){
      actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmLichidare('${id}')">✔️ Confirmă Lichidarea</button>`;
      if(a.df_id)actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">↻ Revizuiește DF</button>`;
    }else if(a.status==='ordonantare'&&!a.ord_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}')">💰 Completează Ordonanțare de Plată</button>`;
      if(a.df_id)actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">↻ Revizuiește DF</button>`;
    }else if(a.status==='ordonantare'&&a.ord_id&&!a.ord_flow_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}')">⚙ Generează PDF + Lansează flux ORD</button>`;
      if(a.df_id)actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">↻ Revizuiește DF</button>`;
    }else if(a.status==='ordonantare'&&a.ord_flow_id&&!a.ord_completed_at){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopOrdCompleted('${id}')">✅ Marchează ORD semnat complet</button>`;
    }else if(a.status==='plata'){
      actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmPlata('${id}',${parseFloat(a.ord_valoare||0)})">🏦 Confirmă Plata</button>`;
    }
    actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">✕ Anulează</button>`;
  }

  const _totalCicluri=(a.cicluri_istorice?.length||0)+1;
  const _mesajFinal=isCompleted&&a.ramas<=0?`${_totalCicluri} ${_totalCicluri===1?'ciclu':'cicluri'} de ordonanțare finalizate · DF integral acoperit`:'';

  // Build semnatari display
  function _semnatariSection(list,label,color){
    if(!list||!list.length)return'';
    const items=list.filter(u=>u.user_id||u.same_as_initiator);
    if(!items.length)return'';
    return`<div style="margin-bottom:6px">
      <div style="font-size:.76rem;font-weight:600;color:${color};margin-bottom:3px">${label}</div>
      ${items.map(u=>`<div style="font-size:.76rem;color:var(--df-text-3)">• ${esc(ROLE_LABEL[u.role]||u.role)}: ${u.same_as_initiator?'(inițiator)':esc(u.name||'—')}</div>`).join('')}
    </div>`;
  }
  container.innerHTML=`
    <div style="background:rgba(255,255,255,.04);border:1px solid var(--df-border-2);border-radius:12px;padding:18px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:1rem;font-weight:700;color:var(--df-text-2)">${esc(a.titlu||'ALOP')}</div>
          ${a.compartiment?`<div style="font-size:.8rem;color:var(--df-text-3);margin-top:2px">${esc(a.compartiment)}</div>`:''}
          ${a.valoare_totala?`<div style="font-size:.85rem;color:#10b981;margin-top:4px;font-weight:600">${fmtRON(a.valoare_totala)}</div>`:''}
          <div style="font-size:.74rem;color:var(--df-text-3);margin-top:4px">Creat de ${esc(a.creator_name||'?')} · ${fmtDate(a.created_at)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${_alopStatusBadge(a.status,a.df_flow_id)}
          ${!isCompleted&&!isCancelled?`<button class="df-action-btn sm" onclick="alopRefreshCurrent()" title="Actualizează status">↻ Actualizează</button>`:''}
        </div>
      </div>
    </div>
    ${stepperHtml}
    ${(() => {
      const _ist = a.cicluri_istorice || [];
      const _totalOrdIst = _ist.reduce((s,c) => s + parseFloat(c.plata_suma_efectiva || 0), 0);
      const _totalOrdGlobal = _totalOrdIst + parseFloat(a.ord_valoare || 0);
      const _totalPlatitGlobal = parseFloat(a.suma_platita_total || 0);
      const _cicluCurent = a.ciclu_curent || 1;
      const _ordCurent = parseFloat(a.ord_valoare || 0);
      const _platCurent = parseFloat(a.op_valoare || a.plata_suma_efectiva || 0);
      const _areCicluriAnterioare = _cicluCurent > 1 || _ist.length > 0;
      return `
    <div data-valori style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:10px 0">
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 14px;text-align:center">
        <div style="font-size:.7rem;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.04em">Valoare DF</div>
        <div style="font-size:1rem;font-weight:700;color:#b0a0ff;margin-top:4px">${fmtV(a.df_valoare||0)}</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 14px;text-align:center">
        <div style="font-size:.7rem;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.04em">Valoare ORD${_areCicluriAnterioare ? ' · Total' : ''}</div>
        <div style="font-size:1rem;font-weight:700;color:#5dcaa5;margin-top:4px">${fmtV(_totalOrdGlobal)}</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 14px;text-align:center">
        <div style="font-size:.7rem;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.04em">Sumă plătită${_areCicluriAnterioare ? ' · Total' : ''}</div>
        <div style="font-size:1rem;font-weight:700;color:#f59e0b;margin-top:4px">${fmtV(_totalPlatitGlobal)}</div>
      </div>
    </div>`;
    })()}
    ${actionsHtml?`<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">${actionsHtml}</div>`:''}
    ${isCompleted?`<div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:10px;padding:14px;text-align:center;color:#10b981;font-weight:600">✅ ALOP finalizat complet — Angajare → Lichidare → Ordonanțare → Plată executată<br><span style="font-size:.8rem;font-weight:400;opacity:.8">${fmtDate(a.completed_at)}</span></div>`:''}
    ${isCompleted&&(a.ramas>0)?`
      <div style="background:rgba(108,79,240,.08);border:1px solid rgba(108,79,240,.2);border-radius:8px;padding:10px 14px;font-size:.82rem;margin-top:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span>💰 Rămas de ordonanțat: <strong style="color:#b0a0ff">${fmtRON(a.ramas)}</strong> din DF aprobat (${fmtRON(parseFloat(a.df_valoare||0))})</span>
        <button class="df-action-btn primary" onclick="startNouaLichidare('${esc(a.id)}')">🔄 Nouă ordonanțare parțială</button>
      </div>`:''}
    ${_mesajFinal?`<div style="font-size:.78rem;color:var(--df-text-3);margin-top:6px;text-align:center">${_mesajFinal}</div>`:''}
  `;
  // Bloc cicluri — detaliat: istoric + ciclu curent cu aceleași culori ca stepper-ul de sus
  // Culori: Lichidare #f59e0b | Ordonanțare #8b5cf6 | Plată #10b981
  {
    const _istorice = a.cicluri_istorice || [];
    const _cicluCurent = a.ciclu_curent || 1;
    const _areCicluCurent = _cicluCurent > 0 && !isCancelled;
    const _toate = [..._istorice];
    if (_areCicluCurent) {
      _toate.push({
        ciclu_nr: _cicluCurent,
        lichidare_nr_factura: a.lichidare_nr_factura,
        lichidare_confirmed_at: a.lichidare_confirmed_at,
        ord_valoare: a.ord_valoare,
        ord_completed_at: a.ord_completed_at,
        plata_suma_efectiva: a.plata_suma_efectiva,
        plata_nr_ordin: a.plata_nr_ordin,
        plata_data: a.plata_data,
        plata_confirmed_at: a.plata_confirmed_at,
        _isCurrent: true,
        _status: a.status,
      });
    }
    if (_toate.length > 0) {
      let _html = `<div style="margin:12px 0 8px"><div style="font-size:.72rem;font-weight:700;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Cicluri</div>`;
      _toate.forEach(c => {
        const _curBadge = c._isCurrent && !isCompleted
          ? `<span style="font-size:.66rem;font-weight:600;color:#38bdf8;background:rgba(56,189,248,.12);padding:2px 8px;border-radius:8px;margin-left:8px">în curs</span>`
          : '';
        const _lichConfirmat = !!c.lichidare_confirmed_at;
        const _lichFact = c.lichidare_nr_factura ? `Fact. ${esc(c.lichidare_nr_factura)}` : (c._isCurrent && !_lichConfirmat ? '⏳ în curs' : '—');
        const _ordVal = parseFloat(c._isCurrent ? (c.ord_valoare || 0) : (c.plata_suma_efectiva || 0));
        const _ordAfisare = c._isCurrent && !c.ord_completed_at && _ordVal === 0 ? '⏳ în curs' : fmtV(_ordVal);
        const _ordData = c._isCurrent ? (c.ord_completed_at || '') : (c.plata_confirmed_at || '');
        const _platConfirmat = !!c.plata_confirmed_at;
        const _platSuma = parseFloat(c.plata_suma_efectiva || 0);
        const _platAfisare = _platConfirmat ? fmtV(_platSuma) : (c._isCurrent ? '⏳ în curs' : '—');
        // FIX v3.9.338: plata_data poate veni ca ISO complet (ciclul curent) sau YYYY-MM-DD (cicluri istorice). Normalizăm la dd.mm.yyyy.
        const _fmtPlataData = (v) => {
          if (!v) return '';
          const s = String(v);
          const datePart = s.substring(0, 10);
          const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
        };
        const _platDetaliu = _platConfirmat
          ? `${c.plata_nr_ordin ? `OP ${esc(c.plata_nr_ordin)} · ` : ''}${_fmtPlataData(c.plata_data)}`
          : '';
        _html += `<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:.8rem">
          <div style="font-weight:700;color:var(--df-text-2);margin-bottom:6px">Ciclu ${c.ciclu_nr}${_curBadge}</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
            <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.18);border-radius:6px;padding:6px 10px">
              <div style="font-size:.68rem;color:#f59e0b;margin-bottom:2px;font-weight:600">✔ Lichidare</div>
              <div style="color:var(--df-text-2)">${_lichFact}</div>
              <div style="font-size:.72rem;color:var(--df-text-3)">${_lichConfirmat ? fmtDate(c.lichidare_confirmed_at) : ''}</div>
            </div>
            <div style="background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.18);border-radius:6px;padding:6px 10px">
              <div style="font-size:.68rem;color:#8b5cf6;margin-bottom:2px;font-weight:600">💰 Ordonanțare</div>
              <div style="color:var(--df-text-2)">${_ordAfisare}</div>
              <div style="font-size:.72rem;color:var(--df-text-3)">${_ordData ? fmtDate(_ordData) : ''}</div>
            </div>
            <div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.18);border-radius:6px;padding:6px 10px">
              <div style="font-size:.68rem;color:#10b981;margin-bottom:2px;font-weight:600">🏦 Plată</div>
              <div style="color:${_platConfirmat ? '#34d399' : 'var(--df-text-2)'};font-weight:${_platConfirmat ? '700' : '400'}">${_platAfisare}</div>
              <div style="font-size:.72rem;color:var(--df-text-3)">${_platDetaliu}</div>
            </div>
          </div>
        </div>`;
      });
      const _totalIst = _istorice.reduce((s,c) => s + parseFloat(c.plata_suma_efectiva || 0), 0);
      const _totalCurentPlatit = parseFloat(a.plata_suma_efectiva || 0);
      const _totalGlobal = _totalIst + _totalCurentPlatit;
      _html += `<div style="text-align:right;font-size:.8rem;color:var(--df-text-3);padding:4px 4px 8px">Total plătit (toate ciclurile): <strong style="color:var(--df-text)">${fmtV(_totalGlobal)}</strong></div></div>`;
      const _vBlock = container.querySelector('[data-valori]');
      if (_vBlock) {
        const _d = document.createElement('div');
        _d.innerHTML = _html;
        _vBlock.parentNode.insertBefore(_d, _vBlock);
      }
    }
  }
  // Auto-refresh status la 15s cât ALOP e activ (detectează tranziții după semnare)
  clearInterval(window._alopRefreshInterval);
  if(!isCompleted&&!isCancelled){
    window._alopRefreshInterval=setInterval(async()=>{
      const alopSec=document.getElementById('alop-section');
      const detailP=document.getElementById('alop-detail-panel');
      if(!alopSec||alopSec.style.display==='none')return;
      if(!detailP||detailP.style.display==='none')return;
      try{
        const r=await fetch(`/api/alop/${encodeURIComponent(a.id)}`,{credentials:'include'});
        if(!r.ok)return;
        const d=await r.json();
        if(d.alop&&d.alop.status!==a.status){openAlop(a.id);loadAlop();loadAlopStats();}
      }catch(_){}
    },15000);
  }
}

// ── Multi-ORD: pornire ciclu nou de ordonanțare ───────────────────────────────
async function startNouaLichidare(alopId){
  if(!alopId||alopId==='null')return;
  if(!confirm('Pornești un nou ciclu Lichidare → Ordonanțare → Plată pentru valoarea rămasă din DF?'))return;
  try{
    const fmtRON=v=>v!=null?new Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON'}).format(v):'—';
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}/noua-lichidare`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()}
    });
    const data=await r.json();
    if(!r.ok){alert(data.message||data.error||'Eroare');return;}
    openAlop(alopId);
    loadAlop();loadAlopStats();
    setS(`Nou ciclu pornit — rămas ${fmtRON(data.ramas)} RON`,'ok');
  }catch(e){alert('Eroare: '+e.message);}
}

// ── Navigare la formulare ─────────────────────────────────────────────────────
async function alopDeschideDF(alopId){
  try{
    // FIX 3: citim starea curentă din server — singura sursă de adevăr pentru df_id
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}`,{credentials:'include'});
    if(!r.ok)return;
    const {alop}=await r.json();
    if(!alop)return;
    window._alopContext={alopId:alop.id,titlu:alop.titlu||'',valoare:alop.valoare_totala||null,dfSemnatari:alop.df_semnatari||[],ordSemnatari:alop.ord_semnatari||[]};
    sessionStorage.setItem('_alopContext',JSON.stringify(window._alopContext));
    if(alop.df_id){
      // DF există pe ALOP → deschide direct
      openDocFromList('df',alop.df_id);
    }else if(ST.docId?.['notafd']){
      // FIX 2: DF creat în sesiunea curentă dar link-df nu s-a salvat pe server
      const docStatus=ST.docStatus?.['notafd'];
      if(docStatus==='aprobat'||docStatus==='transmis_flux'){
        // Nu re-lega un DF aprobat — resetează și creează unul nou
        ST.docId['notafd']=null;
        ST.docStatus['notafd']=null;
        document.getElementById('section-list').style.display='';
        document.getElementById('section-form').style.display='none';
        switchListTab('df');
        await new Promise(res=>setTimeout(res,100));
        try{history.replaceState({},'',`${location.pathname}?tip=df&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
        newDocFromList();
      }else{
        // Re-leagă imediat (link-df e idempotent) și deschide documentul
        fetch(`/api/alop/${encodeURIComponent(alopId)}/link-df`,{
          method:'POST',credentials:'include',
          headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
          body:JSON.stringify({df_id:ST.docId['notafd']}),
        }).then(r=>r.json()).then(j=>{
          if(j.ok)console.log('ALOP re-link-df:',alopId,'→',ST.docId['notafd']);
          else console.warn('ALOP re-link-df warn:',j.error);
        }).catch(e=>console.warn('ALOP re-link-df error:',e));
        openDocFromList('df',ST.docId['notafd']);
      }
    }else{
      // DF nou — resetează contextul doc din sesiunea anterioară și creează formular gol
      ST.docId=ST.docId||{};ST.docId['notafd']=null;
      ST.docStatus=ST.docStatus||{};ST.docStatus['notafd']=null;
      document.getElementById('section-list').style.display='';
      document.getElementById('section-form').style.display='none';
      switchListTab('df');
      await new Promise(res=>setTimeout(res,100));
      try{history.replaceState({},'',`${location.pathname}?tip=df&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
      newDocFromList();
    }
  }catch(e){console.error('alopDeschideDF',e);}
}
async function alopDeschideORD(alopId){
  try{
    // Citim starea curentă din server — singura sursă de adevăr pentru ord_id
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}`,{credentials:'include'});
    if(!r.ok)return;
    const {alop}=await r.json();
    if(!alop)return;
    window._alopContext={alopId:alop.id,titlu:alop.titlu||'',valoare:alop.valoare_totala||null,dfSemnatari:alop.df_semnatari||[],ordSemnatari:alop.ord_semnatari||[]};
    sessionStorage.setItem('_alopContext',JSON.stringify(window._alopContext));
    if(alop.ord_id){
      // ORD există pe ALOP → deschide direct
      openDocFromList('ord',alop.ord_id);
    }else{
      // ORD nou — resetează contextul doc din sesiunea anterioară și creează formular gol
      ST.docId=ST.docId||{};ST.docId['ordnt']=null;
      ST.docStatus=ST.docStatus||{};ST.docStatus['ordnt']=null;
      document.getElementById('section-list').style.display='';
      document.getElementById('section-form').style.display='none';
      switchListTab('ord');
      await new Promise(res=>setTimeout(res,100));
      try{history.replaceState({},'',`${location.pathname}?tip=ord&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
      newDocFromList();
      if(alop.df_id)setTimeout(()=>{const s=document.getElementById('o-df-sel');if(s)s.value=alop.df_id;},400);
    }
  }catch(e){console.error('alopDeschideORD',e);}
}
// Fallback sync (folosit intern de alopLaunchDfFlow/OrdFlow când nu există doc)
function alopGoToDF(alopId){
  document.getElementById('section-list').style.display='';
  document.getElementById('section-form').style.display='none';
  document.getElementById('ltab-df').click();
  try{history.replaceState({},'',`${location.pathname}?tip=df&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
  setTimeout(()=>newDocFromList(),100);
}
function alopGoToORD(alopId,dfId){
  document.getElementById('section-list').style.display='';
  document.getElementById('section-form').style.display='none';
  document.getElementById('ltab-ord').click();
  try{history.replaceState({},'',`${location.pathname}?tip=ord&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
  setTimeout(()=>{
    newDocFromList();
    if(dfId)setTimeout(()=>{const s=document.getElementById('o-df-sel');if(s)s.value=dfId;},400);
  },100);
}

// ── Acțiuni ALOP ──────────────────────────────────────────────────────────────
async function alopLaunchDfFlow(alopId,dfId){
  // Pas 1: leagă df_id la ALOP ÎNAINTE de orice navigare (garantează df_id setat)
  if(dfId){
    try{
      const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}/link-df`,{
        method:'POST',credentials:'include',
        headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
        body:JSON.stringify({df_id:dfId}),
      });
      const j=await r.json();
      if(r.ok)console.log('ALOP link-df (pre-flow):',alopId,'→',dfId);
      else console.warn('ALOP link-df warn:',j.error);
    }catch(e){console.warn('ALOP link-df error:',e);}
  }
  // Pas 2: navighează la semdoc-initiator cu parametri în URL (nu sessionStorage)
  location.href = '/semdoc-initiator.html?action=new_flow_prefill'
    + '&alop_id=' + encodeURIComponent(alopId)
    + '&alop_doc_type=notafd'
    + '&prefill_doc_id=' + encodeURIComponent(dfId||'')
    + '&prefill_doc_type=notafd';
}
async function alopLaunchOrdFlow(alopId,ordId){
  // Pas 0: Generează PDF dacă ORD-ul e deschis în formular
  const hasPdf=ST.docHasPdf?.['ordnt'];
  if(!hasPdf&&ST.docId?.['ordnt']){
    try{
      await genPdf('ordnt');
      await new Promise(r=>setTimeout(r,800));
    }catch(e){console.warn('genPdf ordnt warn:',e);}
  }
  // Pas 1: leagă ord_id la ALOP ÎNAINTE de orice navigare
  if(ordId){
    try{
      const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}/link-ord`,{
        method:'POST',credentials:'include',
        headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
        body:JSON.stringify({ord_id:ordId}),
      });
      const j=await r.json();
      if(r.ok)console.log('ALOP link-ord (pre-flow):',alopId,'→',ordId);
      else console.warn('ALOP link-ord warn:',j.error);
    }catch(e){console.warn('ALOP link-ord error:',e);}
  }
  // Pas 2: navighează la semdoc-initiator cu parametri în URL (nu sessionStorage)
  location.href = '/semdoc-initiator.html?action=new_flow_prefill'
    + '&alop_id=' + encodeURIComponent(alopId)
    + '&alop_doc_type=ordnt'
    + '&prefill_doc_id=' + encodeURIComponent(ordId||'')
    + '&prefill_doc_type=ordnt';
}

async function alopDfCompleted(id){
  if(!confirm('Marchezi DF-ul ca semnat complet? Dosarul trece în faza Lichidare.'))return;
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/df-completed`,{
      method:'POST',credentials:'include',headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'server_error');
    openAlop(id);loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}


function openAlopConfirmLichidare(id){
  if(!id||id==='null')return;
  _lichidareAlopId=id;
  ['lich-nr-factura','lich-data-factura','lich-nr-pv','lich-data-pv','lich-observatii']
    .forEach(eid=>{const el=document.getElementById(eid);if(el){el.value='';if(el.type==='date')el.dispatchEvent(new Event('input'));}});
  document.getElementById('modal-lichidare').style.display='flex';
  setTimeout(()=>{initDateDisplayRo();document.getElementById('lich-nr-factura')?.focus();},50);
}

function closeLichidareModal(){
  document.getElementById('modal-lichidare').style.display='none';
  _lichidareAlopId=null;
}

async function confirmLichidare(){
  if(!_lichidareAlopId)return;
  const body={
    nr_factura:   (document.getElementById('lich-nr-factura')?.value||'').trim(),
    data_factura: document.getElementById('lich-data-factura')?.value||null,
    nr_pv:        (document.getElementById('lich-nr-pv')?.value||'').trim(),
    data_pv:      document.getElementById('lich-data-pv')?.value||null,
    observatii:   (document.getElementById('lich-observatii')?.value||'').trim(),
  };
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(_lichidareAlopId)}/confirma-lichidare`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify(body),
    });
    const data=await r.json();
    if(!r.ok){alert(data.error||'Eroare confirmare lichidare');return;}
    closeLichidareModal();
    openAlop(_lichidareAlopId);
    loadAlop();loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}

async function alopOrdCompleted(id){
  if(!confirm('Marchezi ORD-ul ca semnat complet? Dosarul trece în faza Plată.'))return;
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/ord-completed`,{
      method:'POST',credentials:'include',headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'server_error');
    openAlop(id);loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}


function openAlopConfirmPlata(id,ordValoare){
  if(!id||id==='null')return;
  _plataAlopId=id;
  _plataOrdValoare=parseFloat(ordValoare)||0;
  ['plata-nr-ordin','plata-data','plata-suma','plata-observatii']
    .forEach(eid=>{const e=document.getElementById(eid);if(e){e.value='';if(e.type==='date')e.dispatchEvent(new Event('input'));}});
  document.getElementById('modal-plata').classList.add('show');
  setTimeout(()=>{initDateDisplayRo();document.getElementById('plata-nr-ordin')?.focus();},50);
}

function closePlataModal(){
  document.getElementById('modal-plata').classList.remove('show');
  _plataAlopId=null;
}

async function confirmPlata(){
  if(!_plataAlopId)return;
  const nr=(document.getElementById('plata-nr-ordin')?.value||'').trim();
  const dt=document.getElementById('plata-data')?.value||'';
  const suma=pMR(document.getElementById('plata-suma')?.value)||0;
  if(!nr){alert('Completați numărul ordinului de plată.');return;}
  if(!dt){alert('Completați data plății.');return;}
  if(suma<=0){alert('Completați suma efectiv plătită.');return;}
  if(_plataOrdValoare>0&&suma>_plataOrdValoare){
    alert(`Suma introdusă (${fMR(suma)} RON) depășește suma ordonanțată (${fMR(_plataOrdValoare)} RON). Corectați suma.`);
    return;
  }
  const body={
    nr_ordin_plata:nr,
    data_plata:(document.getElementById('plata-data')?.value||'').trim()||null,
    suma_efectiva:suma,
    observatii:(document.getElementById('plata-observatii')?.value||'').trim(),
  };
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(_plataAlopId)}/confirma-plata`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify(body),
    });
    const data=await r.json();
    if(!r.ok){alert(data.error||'Eroare confirmare plată');return;}
    closePlataModal();
    loadAlop();
    loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}

async function cancelAlop(id){
  if(!confirm('Anulezi acest ALOP? Documentele DF/ORD nu vor fi șterse.'))return;
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/cancel`,{
      method:'POST',credentials:'include',headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'server_error');
    closeAlopDetail();loadAlop();loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}

// ── Revizuiri DF ──────────────────────────────────────────────────────────────

function dfInitiazaRevizie(dfId){
  if(!dfId){setS('ID document lipsă.','err');return;}
  _revizieTargetId = dfId;
  _revizieAlopId = null;
  const el = document.getElementById('revizie-motiv-input');
  const err = document.getElementById('revizie-modal-err');
  if(el) el.value = '';
  if(err) err.textContent = '';
  document.getElementById('modal-revizie').style.display = 'flex';
  setTimeout(()=>el?.focus(), 50);
}

function closeRevizieModal(){
  document.getElementById('modal-revizie').style.display = 'none';
  _revizieTargetId = null;
  _revizieAlopId = null;
}

async function confirmRevizie(){
  const motiv = (document.getElementById('revizie-motiv-input')?.value || '').trim();
  const errEl = document.getElementById('revizie-modal-err');
  if(!motiv){if(errEl) errEl.textContent='Motivul este obligatoriu.';return;}
  if(errEl) errEl.textContent = '';
  try{
    const r=await fetch(`/api/formulare-df/${encodeURIComponent(_revizieTargetId)}/revizuieste`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify({motiv}),
    });
    const j=await r.json();
    if(!r.ok||!j.ok){
      if(errEl) errEl.textContent=j.detail||j.error||'Eroare la creare revizie';
      return;
    }
    closeRevizieModal();
    if(_revizieAlopId){
      // context ALOP — navighează la noul DF în cadrul dosarului
      setS(`Revizia ${j.df.revizie_nr} creată.`,'ok');
      await alopDeschideDF(_revizieAlopId);
    } else {
      setS(`Revizia ${j.df.revizie_nr} creată. Se deschide documentul...`,'ok');
      setTimeout(()=>openDocFromList('df',j.df.id),600);
    }
  }catch(e){if(errEl) errEl.textContent='Eroare: '+e.message;}
}

async function alopRevizuiesteDF(alopId,dfId){
  if(!dfId){alert('Niciun DF legat de acest ALOP.');return;}
  // Reîncarcă contextul ALOP cu date proaspete
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}`,{credentials:'include'});
    const d=await r.json();
    if(d.alop){
      window._alopContext={
        alopId:d.alop.id,titlu:d.alop.titlu||'',valoare:d.alop.valoare_totala||null,
        dfSemnatari:d.alop.df_semnatari||[],ordSemnatari:d.alop.ord_semnatari||[],
      };
      sessionStorage.setItem('_alopContext',JSON.stringify(window._alopContext));
    }
  }catch(_){}
  _revizieTargetId = dfId;
  _revizieAlopId = alopId;
  const el = document.getElementById('revizie-motiv-input');
  const err = document.getElementById('revizie-modal-err');
  if(el) el.value = '';
  if(err) err.textContent = '';
  document.getElementById('modal-revizie').style.display = 'flex';
  setTimeout(()=>el?.focus(), 50);
}


  // -- Export onclick global + cross-module ---------------------------------
  window.loadAlopStats              = loadAlopStats;
  window.loadAlop                   = loadAlop;
  window.openAlopModal              = openAlopModal;
  window.closeAlopModal             = closeAlopModal;
  window.createAlop                 = createAlop;
  window.openAlop                   = openAlop;
  window.closeAlopDetail            = closeAlopDetail;
  window.alopRefreshCurrent         = alopRefreshCurrent;
  window.startNouaLichidare         = startNouaLichidare;
  window.alopDeschideDF             = alopDeschideDF;
  window.alopDeschideORD            = alopDeschideORD;
  window.alopGoToDF                 = alopGoToDF;
  window.alopGoToORD                = alopGoToORD;
  window.alopLaunchDfFlow           = alopLaunchDfFlow;
  window.alopLaunchOrdFlow          = alopLaunchOrdFlow;
  window.alopDfCompleted            = alopDfCompleted;
  window.openAlopConfirmLichidare   = openAlopConfirmLichidare;
  window.closeLichidareModal        = closeLichidareModal;
  window.confirmLichidare           = confirmLichidare;
  window.alopOrdCompleted           = alopOrdCompleted;
  window.openAlopConfirmPlata       = openAlopConfirmPlata;
  window.closePlataModal            = closePlataModal;
  window.confirmPlata               = confirmPlata;
  window.cancelAlop                 = cancelAlop;
  window.dfInitiazaRevizie          = dfInitiazaRevizie;
  window.closeRevizieModal          = closeRevizieModal;
  window.confirmRevizie             = confirmRevizie;
  window.alopRevizuiesteDF          = alopRevizuiesteDF;
  window._alopLinkDoc               = _alopLinkDoc;

  window.df = window.df || {};
  window.df._formularAlopLoaded = true;
})();

// Patch mkFlow dupa ce formular.js a rulat (defer order garanteaza mkFlow definit)
document.addEventListener('DOMContentLoaded', function () {
  const _orig=window.mkFlow;
  if(typeof _orig!=='function')return;
  // Mapare rol ALOP → atribut semnătură în semdoc-initiator
  const ALOP_ROL={
    initiator:'ÎNTOCMIT', sef_compartiment:'VIZAT', responsabil_cab:'VERIFICAT',
    sef_cab:'VIZAT', director_economic:'VIȚĂ ECONOMICĂ',
    ordonator_credite:'APROBAT', cfp_propriu:'VIȚĂ CFPP'
  };
  window.mkFlow=function(ft){
    const ctx=window._alopContext;
    const alopId=new URLSearchParams(location.search).get('alop_id')||ctx?.alopId;
    if(alopId){
      sessionStorage.setItem('alop_id_for_flow',alopId+'|'+ft);
      if(ctx){
        const semnatari=ft==='notafd'?ctx.dfSemnatari:ctx.ordSemnatari;
        const initiatorName=(ctx.dfSemnatari||[]).find(s=>s.role==='initiator')?.name||'';
        const prefillSigners=(semnatari||[])
          .filter(s=>s.user_id||s.same_as_initiator)
          .map(s=>({
            name:s.same_as_initiator?initiatorName:(s.name||''),
            rol:ALOP_ROL[s.role]||'SEMNAT',
            functie:s.functie||''
          }));
        if(prefillSigners.length){
          sessionStorage.setItem('docflow_prefill_signers',JSON.stringify(prefillSigners));
        }
      }
    }
    _orig(ft);
  };
});
