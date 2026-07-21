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
  // Gardă de re-intrare (v3.9.681, incident 13.07.2026): dublu-click pe „Completează DF/ORD"
  // deschidea două formulare goale în paralel ⇒ două POST ⇒ document duplicat. Ține cheia
  // operației în curs (`df:<alopId>` / `ord:<alopId>`); al doilea apel pentru aceeași cheie
  // iese imediat. Confort UI — poarta reală e serverul (idempotență) + indexul unic (mig. 095).
  let _dfOpenInFlight = null;
  // Paginare listă ALOP — mirror _lstState din list.js (v3.9.711)
  let _alopState = { page: 1, limit: 20 };

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
    else{
      console.warn(`ALOP ${endpoint} warn:`,j.error);
      // v3.9.554 (A3): eroarea de legare nu mai e silențioasă — fără asta, documentul
      // pare salvat OK dar ALOP-ul rămâne „Fără DF" și utilizatorul nu află.
      setS(`Documentul a fost salvat, dar legarea la dosarul ALOP a eșuat: ${esc(j.message||j.error||('HTTP '+r.status))}. Reîncercați salvarea sau legați documentul din dosarul ALOP.`,'err');
    }
  }catch(e){
    console.warn(`ALOP ${endpoint} error:`,e);
    setS('Documentul a fost salvat, dar legarea la dosarul ALOP a eșuat (eroare de rețea). Reîncercați salvarea.','err');
  }
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

function _alopStatusBadge(status, dfFlowId, a){
  const m={
    'draft':       {icon:'ico-edit-pencil',     text:'Draft',           color:'#64748b'},
    'angajare':    {icon:'ico-clock',           text:'DF în lucru',     color:'#f97316'},
    'lichidare':   {icon:'ico-check-square',    text:'Lichidare',       color:'#f59e0b'},
    'ordonantare': {icon:'ico-file-signature',  text:'Ordonanțare',     color:'#8b5cf6'},
    'plata':       {icon:'ico-send',            text:'Plată',           color:'#f97316'},
    'completed':   {icon:'ico-check-circle',    text:'Finalizat',       color:'#10b981'},
    'cancelled':   {icon:'ico-x-circle',        text:'Anulat',          color:'#ef4444'},
  };
  let s=m[status]||{icon:'ico-clock',text:status,color:'#64748b'};
  if(status==='angajare' && a && a.df_flow_active) s={icon:'ico-pen-tool',text:'Pe flux — semnare',color:'#6366f1'};
  if(a && a.df_revizie_nr>0 && a.df_flow_active && !a.df_aprobat)
    s={icon:'ico-pen-tool', text:'Revizie pe flux', color:'#6366f1'};
  const _ico=`<svg width="11" height="11" style="vertical-align:-1px;margin-right:4px;flex-shrink:0;"><use href="/icons.svg?v=3.9.475#${s.icon}"/></svg>`;
  return`<span style="display:inline-flex;align-items:center;background:${s.color}22;color:${s.color};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600">${_ico}${esc(s.text)}</span>`;
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

// ── Gating buton OPME — server-driven (responsabil_cab în alop_sabloane/instances) ──
let _canImportOpmeCache = null;
async function _canImportOpme(){
  if (_canImportOpmeCache !== null) return _canImportOpmeCache;
  try {
    const r = await fetch('/api/me/can-import-opme', { credentials: 'include' });
    if (!r.ok) return false;
    const j = await r.json();
    _canImportOpmeCache = !!j.can;
    setTimeout(() => { _canImportOpmeCache = null; }, 30000);
    return _canImportOpmeCache;
  } catch { return false; }
}
async function _updateOpmeBtnVisibility(){
  const btn=document.getElementById('btn-opme-import');
  if(!btn)return;
  const can = await _canImportOpme();
  btn.style.display=can?'':'none';
}

// ── Buton OPME în antet ─────────────────────────────────────────────────────
function openOpmeImport(){
  if(!window.DFOpmeImportModal){
    alert('Componenta de import OPME nu s-a încărcat.');
    return;
  }
  window.DFOpmeImportModal.open({
    onSuccess:(rep, importId)=>{
      // Reîncarcă lista ALOP (auto-confirm poate fi avansat ciclurile)
      loadAlop(); loadAlopStats();
      // Dacă suntem pe detaliu, refresh
      if(window._currentAlopId) openAlop(window._currentAlopId);
      // Oferă drawer-ul cu raport
      if(importId && window.DFOpmeReportDrawer){
        setTimeout(()=>window.DFOpmeReportDrawer.open({ importId }), 250);
      }
    }
  });
}
function openOpmeLinesForAlop(alopId){
  if(!window.DFOpmeReportDrawer){ alert('Componenta raport OPME nu s-a încărcat.'); return; }
  // Deschidem drawer-ul în mod „by-alop": deocamdată, dacă există un import
  // identificabil prin liniile cuplate la ALOP, deschidem acel import. Altfel,
  // afișăm doar lista liniilor în cardul Plată (deja prezent).
  // Implementare simplă: dacă există linii cu opme_import_id, deschide primul
  // import distinct (cel mai vechi).
  fetch(`/api/opme/lines/by-alop/${encodeURIComponent(alopId)}`,{credentials:'include'})
    .then(r=>r.json())
    .then(d=>{
      const lines=d?.lines||[];
      const importIds=Array.from(new Set(lines.map(l=>l.opme_import_id).filter(Boolean)));
      if(importIds.length===1){
        window.DFOpmeReportDrawer.open({ importId: importIds[0] });
      }else if(importIds.length>1){
        // Mai multe import-uri — deschide-l pe cel mai recent (prima poziție după sort DESC)
        window.DFOpmeReportDrawer.open({ importId: importIds[0] });
      }else{
        alert('Acest ALOP nu are linii OPME atașate.');
      }
    })
    .catch(e=>alert('Eroare: '+e.message));
}

async function loadAlop(){
  _updateAlopSablonBtnVisibility();
  _updateOpmeBtnVisibility();
  const tb=document.getElementById('alop-tbody');
  const pg=document.getElementById('alop-pagination');
  if(!tb)return;
  if(pg)pg.style.display='none';
  tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--df-text-3)">Se încarcă...</td></tr>';
  try{
    const qs=new URLSearchParams();
    qs.set('page',_alopState.page);
    qs.set('limit',_alopState.limit);
    const r=await fetch(`/api/alop?${qs.toString()}`,{credentials:'include'});
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
      // Ștergere: flag server-side (can_delete din /api/alop). 1:1 cu vechiul active&&!df_id&&!ord_id.
      const canCancel=a.can_delete===true;
      return`<tr onclick="openAlop('${esc(a.id)}')" style="cursor:pointer">
        <td><span style="font-weight:600;color:var(--df-text)">${esc(a.titlu||'—')}</span>
          ${a.compartiment?`<br><span style="font-size:.75rem;color:var(--df-text-3)">${esc(a.compartiment)}</span>`:''}
        </td>
        <td style="font-size:.78rem;color:var(--df-text-3)">${esc(a.creator_name||a.creator_email||'—')}</td>
        <td>${_alopStatusBadge(a.status,a.df_flow_id,a)}</td>
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
          <button class="df-action-btn sm" style="display:none" onclick="openAlop('${esc(a.id)}')">Deschide</button>
          ${a.has_opme_lines?`<button class="df-action-btn sm" style="margin-left:4px" onclick="openOpmeLinesForAlop('${esc(a.id)}')" title="Vezi OP-uri OPME atașate"><svg class="df-ico"><use href="/icons.svg?v=3.9.475#ico-landmark"/></svg></button>`:''}
          ${canCancel?`<button class="df-action-btn danger sm" style="margin-left:4px" onclick="cancelAlop('${esc(a.id)}')" title="Șterge ALOP">🗑</button>`:''}
        </td>
      </tr>`;
    }).join('');
    _renderAlopPagin(data.total||0,_alopState.page,_alopState.limit);
  }catch(e){
    if(tb)tb.innerHTML=`<tr><td colspan="7" style="text-align:center;padding:20px;color:#f87171">Eroare: ${esc(e.message)}</td></tr>`;
  }
}
function _renderAlopPagin(total,page,limit){
  // PAGIN-9 — componentă partajată DFPagin (paginare pe SERVER: onChange refetch).
  const pg=document.getElementById('alop-pagination');
  if(!pg)return;
  if(window.DFPagin && typeof window.DFPagin.render==='function'){
    window.DFPagin.render({
      container:pg,
      total,
      page,
      limit,
      mode: 'numbered',
      onChange:(p)=>{_alopState.page=p;loadAlop();},
    });
  }else{
    console.error('DFPagin indisponibil — paginarea listei ALOP e ascunsă');
    pg.replaceChildren();
    pg.style.display='none';
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

// ── Editare titlu ALOP inline (oricând, fără cascadă) ───────────────────────
function alopEditTitlu(id){
  const disp=document.getElementById('alop-titlu-display');
  if(!disp)return;
  const current=window._alopContext?.titlu||'';
  disp.innerHTML=`
    <input type="text" id="alop-titlu-input" value="${esc(current)}" maxlength="300"
      style="font-size:1rem;font-weight:700;padding:4px 8px;border-radius:6px;border:1px solid var(--df-border-2);background:var(--df-bg-2);color:var(--df-text-2);min-width:240px">
    <button type="button" class="df-action-btn sm primary" onclick="alopSaveTitlu('${esc(id)}')">Salvează</button>
    <button type="button" class="df-action-btn sm" onclick="alopRefreshCurrent()">Anulează</button>
  `;
  document.getElementById('alop-titlu-input')?.focus();
}
async function alopSaveTitlu(id){
  const input=document.getElementById('alop-titlu-input');
  const titlu=(input?.value||'').trim();
  if(!titlu){setS('Titlul nu poate fi gol.','err');return;}
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/titlu`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify({titlu}),
    });
    const j=await r.json();
    if(!r.ok){setS(`Eroare la salvarea titlului: ${esc(j.error||('HTTP '+r.status))}`,'err');return;}
    setS('Titlu actualizat.','ok');
    await alopRefreshCurrent();
  }catch(e){
    setS('Eroare de rețea la salvarea titlului.','err');
  }
}

const _alopIcoBtn = (name) =>
  `<svg class="df-ic"><use href="/icons.svg?v=3.9.475#${name}"/></svg>`;

// ── Format dată plată (acceptă ISO sau YYYY-MM-DD; returnează dd.mm.yyyy) ───
function _fmtPlataData(v){
  if(!v)return '';
  const s=String(v); const datePart=s.substring(0,10);
  const m=datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?`${m[3]}.${m[2]}.${m[1]}`:s;
}

// ── Render listă OP-uri OPME în cardul Plată ────────────────────────────────
// Returnează HTML cu max 3 linii vizibile + buton expand pentru rest.
function _renderOpmeLinesList(lines, cicluKey){
  if(!lines||!lines.length)return '';
  const fmtRON=v=>new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(parseFloat(v||0))+' RON';
  const total=lines.reduce((s,l)=>s+parseFloat(l.suma_op||0),0);
  const visible=lines.slice(0,3);
  const rest=lines.length-visible.length;
  const items=visible.map(l=>`
    <div class="df-opme-line-item">
      <span class="df-opme-line-item__nr">OP ${esc(l.nr_op||'—')}</span>
      <span class="df-opme-line-item__sum">${esc(fmtRON(l.suma_op))}</span>
      <span class="df-opme-line-item__date">${esc(_fmtPlataData(l.import_data_op))}</span>
    </div>`).join('');
  const moreId=`opme-more-${cicluKey}`;
  const hiddenItems=lines.slice(3).map(l=>`
    <div class="df-opme-line-item">
      <span class="df-opme-line-item__nr">OP ${esc(l.nr_op||'—')}</span>
      <span class="df-opme-line-item__sum">${esc(fmtRON(l.suma_op))}</span>
      <span class="df-opme-line-item__date">${esc(_fmtPlataData(l.import_data_op))}</span>
    </div>`).join('');
  return `
    <div style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.08)">
      <div style="font-size:.66rem;color:var(--df-text-4);margin-bottom:3px">${lines.length} OP · total ${esc(fmtRON(total))}</div>
      ${items}
      ${rest>0?`
        <div id="${moreId}" style="display:none">${hiddenItems}</div>
        <button type="button" class="df-opme-line-more" onclick="(()=>{const d=document.getElementById('${moreId}'); if(d){d.style.display=d.style.display==='none'?'':'none'; this.textContent=d.style.display==='none'?'+${rest} mai multe':'Ascunde';}})()">+${rest} mai multe</button>
      `:''}
    </div>`;
}

// ── Render bloc cicluri + augmentare cu OPME ────────────────────────────────
function _fetchOpmeLinesAndRenderCicluri(a, container, isCompleted, isCancelled, fmtV, fmtDate){
  // Default fără OPME — render imediat pentru a evita flicker; după fetch
  // re-randăm cu lista de OP-uri.
  _renderAlopCicluri(a, container, { active: [], byCiclu: {} }, isCompleted, isCancelled, fmtV, fmtDate);
  fetch(`/api/opme/lines/by-alop/${encodeURIComponent(a.id)}`,{credentials:'include'})
    .then(r=>{ if(!r.ok) return null; return r.json(); })
    .then(d=>{
      if(!d) return;
      const groups=d.groups||{active:[],byCiclu:{}};
      _renderAlopCicluri(a, container, groups, isCompleted, isCancelled, fmtV, fmtDate);
    })
    .catch(()=>{ /* non-fatal */ });
}

function _renderAlopCicluri(a, container, opmeGroups, isCompleted, isCancelled, fmtV, fmtDate){
  // Elimină render-ul anterior (pentru re-render după fetch async)
  const existing = container.querySelector('[data-alop-cicluri]');
  if (existing) existing.remove();

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
      nr_ordonant_pl: a.ord_nr,
      plata_suma_efectiva: a.plata_suma_efectiva,
      plata_nr_ordin: a.plata_nr_ordin,
      plata_data: a.plata_data,
      plata_confirmed_at: a.plata_confirmed_at,
      plata_source: a.plata_source,
      _isCurrent: true,
      _status: a.status,
    });
  }
  if (_toate.length === 0) return;

  let _html = `<div data-alop-cicluri style="margin:12px 0 8px"><div style="font-size:.72rem;font-weight:700;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Cicluri</div>`;
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
    const _platDetaliu = _platConfirmat
      ? `${c.plata_nr_ordin ? `OP ${esc(c.plata_nr_ordin)} · ` : ''}${_fmtPlataData(c.plata_data)}`
      : '';
    // Linii OPME asociate acestui ciclu
    const _opmeLines = c._isCurrent
      ? (opmeGroups.active || [])
      : (opmeGroups.byCiclu && opmeGroups.byCiclu[c.id] ? opmeGroups.byCiclu[c.id] : []);
    const _hasOpme = _opmeLines && _opmeLines.length > 0;
    const _source = c.plata_source || 'manual';
    const _badge = _platConfirmat
      ? `<span class="df-opme-badge df-opme-badge--${_source==='opme_auto'?'auto':'manual'}">${_source==='opme_auto'?'Auto':'Manual'}</span>`
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
          ${c.nr_ordonant_pl ? `<div style="font-size:.7rem;color:var(--df-text-3);font-weight:600;margin-top:2px">Nr. ${esc(c.nr_ordonant_pl)}</div>` : ''}
        </div>
        <div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.18);border-radius:6px;padding:6px 10px;position:relative">
          <div style="font-size:.68rem;color:#10b981;margin-bottom:2px;font-weight:600">🏦 Plată ${_badge}</div>
          ${_platConfirmat && _source==='opme_auto' && _hasOpme
            ? `<div style="font-size:.72rem;color:#34d399;font-weight:600;margin-bottom:4px">Plată confirmată automat din OPME${_opmeLines[0]?.import_nr_document ? ' nr.' + esc(_opmeLines[0].import_nr_document) : ''}${_opmeLines[0]?.import_data_op ? ' / ' + esc(_fmtPlataData(_opmeLines[0].import_data_op)) : ''}</div>` : ''}
          ${_hasOpme
            ? _renderOpmeLinesList(_opmeLines, `${a.id}-${c.id||'cur'}`)
            : `<div style="color:${_platConfirmat ? '#34d399' : 'var(--df-text-2)'};font-weight:${_platConfirmat ? '700' : '400'}">${_platAfisare}</div>
               <div style="font-size:.72rem;color:var(--df-text-3)">${_platDetaliu}</div>`}
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
    _vBlock.parentNode.insertBefore(_d.firstChild, _vBlock);
  }
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
  const caps=a.capabilities||{}; // sursă unică server-side (Etapa 3)
  const fmtDate=iso=>iso?new Date(iso).toLocaleString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  const fmtRON=v=>v!=null?new Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON'}).format(v):'—';
  const fmtV=v=>v>0?new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v)+' RON':'—';

  const _dfRevTxt=a.df_id?(()=>{const _n=a.df_revizie_nr||0;const _a=a.df_este_revizie_an_urmator?' · an următor':'';return _n>0?` · Revizia ${_n}${_a}`:` · Revizia 0${_a}`;})():'';
  const phases=[
    {label:'Angajare',   icon:'📋',color:'#3b82f6',
     done:!!a.df_completed_at||isCompleted,
     active:a.status==='angajare',
     sub:(!a.df_id)?'Fără DF'
        :(a.status==='angajare'&&a.df_flow_active)?`🔄 DF pe fluxul de semnare${_dfRevTxt}`
        :(a.df_revizie_nr>0 && a.df_flow_active && !a.df_aprobat)?`🔄 Revizia ${a.df_revizie_nr} pe flux — în curs · ultima aprobată: Revizia ${a.df_revizie_nr-1}`
        :(['lichidare','ordonantare','plata','completed'].includes(a.status)||isCompleted)?`✅ DF aprobat${_dfRevTxt}`
        :(a.status==='angajare'&&!a.df_flow_active)?`📝 DF în lucru${_dfRevTxt}`
        :`DF: ${a.df_nr||a.df_id.slice(0,8)}${_dfRevTxt}`},
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
  {
    const id=esc(a.id);
    // DF action — enum din caps decide butonul; label/icon/onclick = prezentare (1:1 cu vechiul if/else)
    switch(caps.df_action){
      case 'in_lucru_disabled':
        actionsHtml+=`<button class="df-action-btn" disabled title="Există deja o revizie DF în lucru — finalizați revizia curentă">${_alopIcoBtn('ico-file-text')}Revizie DF în lucru...</button>`;
        break;
      case 'completeaza':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}',this)">${_alopIcoBtn('ico-file-text')}Completează Document de Fundamentare</button>`;
        break;
      case 'revizuieste_neaprobat':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}',this)">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF (neaprobat)</button>`;
        break;
      case 'flow_waiting':
        actionsHtml+=`<span style="color:var(--df-text-3);font-size:.85rem"><svg class="df-ic" style="vertical-align:-3px;margin-right:4px;"><use href="/icons.svg?v=3.9.475#ico-clock"/></svg>DF pe fluxul de semnare — în așteptare</span>`;
        break;
      case 'deschide':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}',this)">${_alopIcoBtn('ico-file-text')}Deschide DF</button>`;
        break;
    }
    // Phase action — enum din caps decide butonul primar.
    switch(caps.phase_action){
      case 'confirma_lichidare':
        actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmLichidare('${id}')">${_alopIcoBtn('ico-check-square')}Confirmă Lichidarea</button>`;
        break;
      case 'completeaza_ord':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}',this)">${_alopIcoBtn('ico-file-signature')}Completează Ordonanțare de Plată</button>`;
        break;
      case 'genereaza_lanseaza_ord':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}',this)">${_alopIcoBtn('ico-rocket')}Generează PDF + Lansează flux ORD</button>`;
        break;
      case 'marcheaza_ord_semnat':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopOrdCompleted('${id}')">${_alopIcoBtn('ico-check-circle')}Marchează ORD semnat complet</button>`;
        break;
      case 'confirma_plata':
        actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmPlata('${id}',${parseFloat(a.ord_valoare||0)})">${_alopIcoBtn('ico-landmark')}Confirmă Plata</button>`;
        break;
    }
    // FIX 6: „Revizuiește DF" — randat o SINGURĂ dată, independent de phase_action,
    // gated doar de caps.can_revise_df (true în toate fazele post-angajare + ciclu închis).
    if(caps.can_revise_df){
      actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF</button>`;
    }
    // Ștergere (owner-gated în caps.can_delete)
    if(caps.can_delete){
      actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-trash')}Șterge</button>`;
    }
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
          <div id="alop-titlu-display" style="font-size:1rem;font-weight:700;color:var(--df-text-2);display:flex;align-items:center;gap:6px">
            <span id="alop-titlu-text">${esc(a.titlu||'ALOP')}</span>
            <button type="button" class="df-action-btn sm" style="padding:2px 6px" onclick="alopEditTitlu('${esc(a.id)}')" title="Editează titlul">✎</button>
          </div>
          ${a.compartiment?`<div style="font-size:.8rem;color:var(--df-text-3);margin-top:2px">${esc(a.compartiment)}</div>`:''}
          ${(() => {
            // v3.9.503: în header arătăm valoarea estimată (la creare) + valoarea
            // DF-ului activ (din cea mai recentă revizie). Userul vede ambele în
            // header fără să scrolează la cardul "VALOARE DF" de jos. Util când
            // revizia DF a schimbat valoarea față de estimatul inițial.
            const _vEst = parseFloat(a.valoare_totala || 0);
            const _vDf  = parseFloat(a.df_valoare || 0);
            const _hasEst = _vEst > 0;
            const _hasDf  = _vDf > 0 && !!a.df_id;
            if (!_hasEst && !_hasDf) return '';
            const _est = _hasEst
              ? `<span style="color:#10b981;font-weight:600" title="Valoare estimată la creare ALOP">${fmtRON(_vEst)}<span style="color:var(--df-text-3);font-weight:400;font-size:.78rem;margin-left:4px">estimat</span></span>`
              : '';
            const _df = _hasDf
              ? `<span style="color:#b0a0ff;font-weight:600" title="Valoare din DF activ (cea mai recentă revizie)">${fmtRON(_vDf)}<span style="color:var(--df-text-3);font-weight:400;font-size:.78rem;margin-left:4px">DF actual</span></span>`
              : '';
            // var. B: bugetul exercițiului curent ca linie secundară în header, lângă
            // „estimat"/„DF actual". Aici NU e cifra dominantă → DF legacy/neancorat
            // (an_referinta null) afișează discret „—".
            const _exAn = new Date().getFullYear();
            // fix 12: la „Stingere" bugetul exercițiului = valoarea angajamentului (tabel 1),
            // independent de an_referinta → afișează chiar dacă an_referinta e null.
            const _bugAncorat = (a.df_an_referinta != null || a.df_stingere) && a.df_buget_an_curent != null;
            const _bugTitle = a.df_stingere
              ? 'Buget exercițiu '+_exAn+' (Stingere — valoarea angajamentului, tabel 1)'
              : (a.df_an_referinta ? 'Buget exercițiu '+_exAn+' (DF ancorat pe '+a.df_an_referinta+')' : 'DF fără an de referință — exercițiu nedefinit');
            const _bug = a.df_id
              ? `<span style="color:var(--df-text-2);font-weight:600" title="${_bugTitle}">${_bugAncorat ? fmtRON(parseFloat(a.df_buget_an_curent||0)) : '—'}<span style="color:var(--df-text-3);font-weight:400;font-size:.78rem;margin-left:4px">buget exercitiu ${_exAn}</span></span>`
              : '';
            const _sepHtml = '<span style="color:var(--df-text-4);margin:0 8px">·</span>';
            const _parts = [_est, _df, _bug].filter(Boolean);
            return `<div style="font-size:.85rem;margin-top:4px;display:flex;align-items:center;flex-wrap:wrap">${_parts.join(_sepHtml)}</div>`;
          })()}
          ${a.df_id?`<div style="font-size:.78rem;color:var(--df-text-3);margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">DF activ: <span class="df-revizie-badge${(a.df_revizie_nr||0)>0?' revizie-activa':''}">R${a.df_revizie_nr||0}</span>${(a.df_revizie_nr||0)>0?`<span>Revizia ${a.df_revizie_nr}</span>`:`<span>Revizia inițială</span>`}${a.df_nr?`<span style="color:var(--df-text-2);font-weight:600">· Nr. ${a.df_nr}</span>`:''}${a.df_este_revizie_an_urmator?`<span style="color:#fbbf24;font-size:.72rem">· an următor</span>`:''}</div>`:''}
          <div style="font-size:.74rem;color:var(--df-text-3);margin-top:4px">Creat de ${esc(a.creator_name||'?')} · ${fmtDate(a.created_at)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${_alopStatusBadge(a.status,a.df_flow_id,a)}
          ${caps.can_refresh?`<button class="df-action-btn sm" onclick="alopRefreshCurrent()" title="Actualizează status">↻ Actualizează</button>`:''}
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
        ${(() => {
          // var. B (decizie owner): bugetul exercițiului curent = cifra DOMINANTĂ;
          // angajamentul total multianual trece pe linia secundară. Fallback la
          // angajament total pe DF neancorat (an_referinta null), cu „(exercițiu
          // nedefinit)". Distinge null de 0: DF ancorat cu buget 0 (plăți doar în N+1)
          // afișează legitim „0,00 RON" → fmtRON(0), NU fmtV (care întoarce „—" pe 0).
          // Anul = exercițiul curent (sursa deja folosită aici); an_referinta e DOAR
          // gate-ul ancorării + tooltip, nu eticheta anului.
          const _exAn = new Date().getFullYear();
          const _vDfTot = parseFloat(a.df_valoare || 0);
          // fix 12: „Stingere" bifat → buget exercițiu = tabel 1 (valoarea angajamentului),
          // afișat ca cifră dominantă chiar dacă an_referinta e null (banda rows_plati = 0 la Stingere).
          const _ancorat = (a.df_an_referinta != null || a.df_stingere) && a.df_buget_an_curent != null;
          if (_ancorat) {
            const _bug = parseFloat(a.df_buget_an_curent || 0);
            const _cardTitle = a.df_stingere
              ? 'Stingere bifată — buget exercițiu = valoarea angajamentului (tabel 1)'
              : 'DF ancorat pe an de referință ' + a.df_an_referinta;
            return `
        <div style="font-size:.7rem;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.04em" title="${_cardTitle}">Buget exercițiu ${_exAn}</div>
        <div style="font-size:1.05rem;font-weight:700;color:#b0a0ff;margin-top:4px">${fmtRON(_bug)}</div>
        <div style="font-size:.7rem;color:var(--df-text-3);margin-top:2px">Angajament total DF: ${fmtV(_vDfTot)}</div>`;
          }
          return `
        <div style="font-size:.7rem;color:var(--df-text-3);text-transform:uppercase;letter-spacing:.04em">Angajament total DF</div>
        <div style="font-size:1.05rem;font-weight:700;color:#b0a0ff;margin-top:4px">${fmtRON(_vDfTot)}</div>
        <div style="font-size:.7rem;color:var(--df-text-4);margin-top:2px" title="DF fără an de referință (legacy) — bugetul exercițiului nu poate fi determinat">(exercițiu nedefinit)</div>`;
        })()}
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
    ${caps.can_start_noua_ordonantare?`
      <div style="background:rgba(108,79,240,.08);border:1px solid rgba(108,79,240,.2);border-radius:8px;padding:10px 14px;font-size:.82rem;margin-top:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <span>💰 Rămas de ordonanțat: <strong style="color:#b0a0ff">${fmtRON(a.ramas)}</strong> din DF aprobat (${fmtRON(parseFloat(a.df_valoare||0))})</span>
          <span style="font-size:.78rem;color:var(--df-text-2)">📅 Rămas de ordonanțat (exercițiu ${new Date().getFullYear()}): <strong style="color:#b0a0ff">${a.ramas_an_curent==null?'—':fmtRON(a.ramas_an_curent)}</strong>${a.ramas_an_curent==null?'':` din credite bugetare exercitiu curent (${fmtRON(parseFloat(a.credite_bugetare_an_curent||0))})`}</span>
        </div>
        <button class="df-action-btn primary" onclick="startNouaLichidare('${esc(a.id)}')">🔄 Nouă ordonanțare parțială</button>
      </div>`:''}
    ${_mesajFinal?`<div style="font-size:.78rem;color:var(--df-text-3);margin-top:6px;text-align:center">${_mesajFinal}</div>`:''}
  `;
  // Bloc cicluri — detaliat: istoric + ciclu curent cu aceleași culori ca stepper-ul de sus
  // Culori: Lichidare #f59e0b | Ordonanțare #8b5cf6 | Plată #10b981
  // Pachet C: fetch OPME lines + grupare pe matched_ciclu_id pentru cardul Plată.
  // Rendering-ul ciclurilor a fost extras într-o funcție; aici doar pornim
  // fetch-ul OPME (non-blocant) și apoi delegăm.
  _fetchOpmeLinesAndRenderCicluri(a, container, isCompleted, isCancelled, fmtV, fmtDate);
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
async function alopDeschideDF(alopId,btn){
  if(_dfOpenInFlight===`df:${alopId}`)return;
  _dfOpenInFlight=`df:${alopId}`;
  if(btn)btn.disabled=true;   // 4b: dezactivează butonul cât timp deschiderea e în curs
  try{
    // HOTFIX v3.9.484: ALOP-ul căruia îi aparținea DF-ul din sesiune,
    // capturat ÎNAINTE ca _alopContext să fie suprascris mai jos.
    const _prevCtxAlop = window._alopContext && window._alopContext.alopId;
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
      // FIX 2: DF creat în sesiunea curentă dar link-df nu s-a salvat pe server.
      // HOTFIX v3.9.484: reutilizează DOAR dacă DF-ul din sesiune aparținea
      // ACESTUI ALOP și e cu adevărat în lucru. Altfel (anulat/refuzat/aprobat/
      // alt ALOP/necunoscut) → DF nou gol, NU resuscita un document mort.
      const docStatus=ST.docStatus?.['notafd'];
      const _safeReuse = (_prevCtxAlop===alop.id)
        && ['draft','returnat','de_revizuit'].includes(docStatus);
      if(!_safeReuse){
        // Nu re-lega un DF nesigur — resetează și creează unul nou
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
  finally{_dfOpenInFlight=null;if(btn)btn.disabled=false;}
}
async function alopDeschideORD(alopId,btn){
  if(_dfOpenInFlight===`ord:${alopId}`)return;
  _dfOpenInFlight=`ord:${alopId}`;
  if(btn)btn.disabled=true;   // 4b: dezactivează butonul cât timp deschiderea e în curs
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
      if(alop.df_id)setTimeout(()=>{
        const s=document.getElementById('o-df-sel');
        if(!s)return;
        s.value=alop.df_id;
        // dispatch 'change' ca să trigger-uim onchange="selectDfAprobat()" — set
        // programatic .value NU declanșează handler-ul, ceea ce împiedica
        // auto-popularea rândurilor din DF la prima deschidere.
        s.dispatchEvent(new Event('change'));
      },400);
    }
  }catch(e){console.error('alopDeschideORD',e);}
  finally{_dfOpenInFlight=null;if(btn)btn.disabled=false;}
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
    if(dfId)setTimeout(()=>{
      const s=document.getElementById('o-df-sel');
      if(!s)return;
      s.value=dfId;
      s.dispatchEvent(new Event('change'));
    },400);
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
  ['lich-nr-factura','lich-data-factura','lich-data-factura-display',
   'lich-nr-pv','lich-data-pv','lich-data-pv-display','lich-observatii',
   'lich-valoare-factura']
    .forEach(eid=>{const el=document.getElementById(eid);if(el)el.value='';});
  document.getElementById('modal-lichidare').style.display='flex';
  setTimeout(()=>{document.getElementById('lich-nr-factura')?.focus();},50);
}

function closeLichidareModal(){
  document.getElementById('modal-lichidare').style.display='none';
  _lichidareAlopId=null;
}

function _parseValoareFactura(raw){
  const s = (raw||'').toString().trim();
  if(!s) return null;
  let t = s.replace(/\s/g,'');
  if(t.includes(',') && t.includes('.')) t = t.replace(/\./g,'').replace(',','.'); // RO: 1.234,56
  else t = t.replace(',', '.');                                                    // 1234,56 / 1234.56
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

async function confirmLichidare(){
  if(!_lichidareAlopId)return;
  const body={
    nr_factura:   (document.getElementById('lich-nr-factura')?.value||'').trim(),
    data_factura: document.getElementById('lich-data-factura')?.value||null,
    nr_pv:        (document.getElementById('lich-nr-pv')?.value||'').trim(),
    data_pv:      document.getElementById('lich-data-pv')?.value||null,
    observatii:   (document.getElementById('lich-observatii')?.value||'').trim(),
    valoare_factura: _parseValoareFactura(document.getElementById('lich-valoare-factura')?.value),
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
  ['plata-nr-ordin','plata-data','plata-data-display','plata-suma','plata-observatii']
    .forEach(eid=>{const e=document.getElementById(eid);if(e)e.value='';});
  document.getElementById('modal-plata').classList.add('show');
  setTimeout(()=>{document.getElementById('plata-nr-ordin')?.focus();},50);
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
  if(!confirm('Ștergeți acest ALOP? Operațiunea nu poate fi inversată.'))return;
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/cancel`,{
      method:'POST',credentials:'include',headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const data=await r.json();
    if(!r.ok){
      if(data.error==='cancel_blocked_df_exists'||data.error==='cancel_blocked_ord_exists'){
        alert(data.message||'ALOP nu poate fi șters: are DF/ORD legat.');
        return;
      }
      throw new Error(data.error||'server_error');
    }
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
  window.alopEditTitlu              = alopEditTitlu;
  window.alopSaveTitlu              = alopSaveTitlu;
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
  window.openOpmeImport             = openOpmeImport;
  window.openOpmeLinesForAlop       = openOpmeLinesForAlop;

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
    sef_cab:'VIZAT', director_economic:'VIZĂ ECONOMICĂ',
    ordonator_credite:'APROBAT', cfp_propriu:'VIZĂ CFPP'
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
