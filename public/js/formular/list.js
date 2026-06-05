// public/js/formular/list.js
// DocFlowAI — Modul Lista DF/ORD/ALOP + BENEF autocomplete + AUTO-SAVE DB (BLOC 2.4).
//
// Cross-module exports (window):
//   - switchListTab : apelată din HTML onclick + alte module
//   - showListSection, showFormSection, newDocFromList
//   - loadList, openDocFromList, stergeDoc, changeLstPage, debouncedLoadList, resetFilters
//   - loadDfAprobate, selectDfAprobat, onDfSelect (apelate din DOC BLOC 2.5)
//   - debouncedBenefSearch, selectBenef, _saveBeneficiarIfNew
//   - _autoSaveDb, _scheduleAutoSaveDb
//
// Local state: _autoSaveTimers, _dfAprobate, _benefTimer, _lstState, _lstDebTimer
// Dependențe: df.esc (înlocuiește _escH), df.isoToDMY, ST (global lexical), funcții window.*

(function() {
  'use strict';
  const esc     = window.df.esc;
  const isoToDMY = window.df.isoToDMY;

// ── Auto-save DB (debounce 800ms, silențios) ──────────────────────────────────
const _autoSaveTimers={};
const _DUP_ERRORS = { nr_ord_duplicat: 'o-nr', nr_unic_duplicat: 'n-nrUnic' };
function _markDupField(inputId, msg) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.style.borderColor = '#dc3545';
  el.title = msg;
  function _clear() { el.style.borderColor = ''; el.title = ''; el.removeEventListener('input', _clear); }
  el.addEventListener('input', _clear);
}
async function _autoSaveDb(ft){
  if(!ST.user)return;
  // Dacă documentul e blocat (P1 asteaptă P2 sau completat) → nu auto-salvăm
  const s=ST.docStatus[ft];
  if(s==='pending_p2'||s==='completed'||s==='anulat')return;
  const docId=ST.docId[ft];
  const body=ft==='ordnt'?collectOrdDb():(ST.docRole[ft]==='p2'?collectDfP2Db():collectDfP1Db());
  _draftShowBadge(ft,'⏳');
  try{
    const hdrs={'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()};
    let r,j;
    if(!docId){
      r=await fetch(ftApi(ft),{method:'POST',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.ok&&j.ok){
        ST.docId[ft]=j.document.id;ST.docStatus[ft]='draft';ST.docRole[ft]='p1';
        // FIX v3.9.534 (buton "Trimite la Responsabil CAB" dispărea după auto-save):
        // actualizează capabilities din răspuns ÎNAINTE de renderActions. După ce docId
        // devine setat, renderActions rula cu caps={} (stale) → bara de acțiuni goală.
        ST.docCapabilities=ST.docCapabilities||{};
        ST.docCapabilities[ft]=j.document?.capabilities||null;
        renderActions(ft);
        // v3.9.518 (FIX CAUZA ROOT REGRESIE): leagă documentul la ALOP imediat la auto-save POST.
        // Înainte: doar saveDoc manual făcea linkul; auto-save-ul (debounce 800ms)
        // câștiga cursa și crea ORD-ul fără link → ord_id rămânea NULL pe ALOP.
        window._alopLinkDoc?.(ft,j.document.id);
      }
    }else{
      r=await fetch(`${ftApi(ft)}/${docId}`,{method:'PUT',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.ok&&j.ok){
        ST.docStatus[ft]=j.document.status;
        // FIX v3.9.534: ține capabilities în sincron și pe PUT (status se poate schimba).
        ST.docCapabilities=ST.docCapabilities||{};
        ST.docCapabilities[ft]=j.document?.capabilities||null;
        // v3.9.518: safety net — dacă linkul ratează pe POST (eroare rețea, race
        // condition cu schimbarea de _alopContext), PUT-urile ulterioare retry-uiesc.
        // _alopLinkDoc e idempotent (SQL UPDATE cu guard ord_id IS NULL OR = $1).
        window._alopLinkDoc?.(ft,docId);
      }
    }
    if(!r||!j||!r.ok){
      if(r&&r.status===409&&j&&_DUP_ERRORS[j.error]){
        _markDupField(_DUP_ERRORS[j.error], j.message);
        _draftShowBadge(ft,'🔴 '+j.message);
      }
      return;
    }
    // v3.9.499: auto-save uploadează ambele sloturi (slot 2 doar pentru ord)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
    // v3.9.501: auto-save uploadează atașamente pending pentru ambele sloturi
    if(ST.docId[ft]){
      await uploadAttachments(ft, 1);
      if(ft==='notafd') await uploadAttachments(ft, 2);
    }
    _draftShowBadge(ft,'💾 '+new Date().toLocaleTimeString('ro-RO',{hour:'2-digit',minute:'2-digit'}));
  }catch(_){_draftShowBadge(ft,'⚠');}
}
function _scheduleAutoSaveDb(ft){
  clearTimeout(_autoSaveTimers[ft]);
  _autoSaveTimers[ft]=setTimeout(()=>_autoSaveDb(ft),800);
}

// ── DF Aprobate — dropdown pentru ORD ────────────────────────────────────────
let _dfAprobate=[];
async function loadDfAprobate(){
  try{
    const r=await fetch('/api/formulare-df/aprobate',{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.ok)return;
    _dfAprobate=j.documents||[];
    const sel=document.getElementById('o-df-sel');
    if(!sel)return;
    sel.innerHTML='<option value="" style="background:#0d1630;color:#e8eeff">— selectare DF aprobat —</option>'
      +_dfAprobate.map(d=>{
        const nr=d.nr_unic_inreg?`DF ${esc(d.nr_unic_inreg)}`:'DF fără număr';
        const sub=d.subtitlu_df?` — ${esc(d.subtitlu_df.slice(0,50))}`:'';
        const rev=(d.revizie_nr>0)?` (R${d.revizie_nr})`:'';
        return`<option value="${esc(d.id)}" style="background:#0d1630;color:#e8eeff">${nr}${sub}${rev}</option>`;
      }).join('');
  }catch(_){}
}
async function selectDfAprobat(){
  const sel=document.getElementById('o-df-sel');
  const id=sel?.value||'';
  const hiddenId=document.getElementById('o-df-id');
  if(hiddenId)hiddenId.value=id;
  if(!id){document.getElementById('o-nrUnic').value='';return;}
  await onDfSelect(id);
}

async function onDfSelect(dfId){
  if(!dfId)return;
  try{
    const r=await fetch(`/api/formulare-df/${encodeURIComponent(dfId)}`,{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.document)return;
    const doc=j.document;
    sv('o-nrUnic',doc.nr_unic_inreg||'');
    sv('o-cif',doc.cif||'');
    sv('o-den',doc.den_inst_pb||'');
    // Pre-fill rânduri tabel din rows_ctrl — număr corect de rânduri, fără sume (completate de CAB)
    const rows=Array.isArray(doc.rows_ctrl)?doc.rows_ctrl:JSON.parse(doc.rows_ctrl||'[]');
    const tbody=document.getElementById('o-tbody');
    tbody.innerHTML='';oI=0;
    if(!rows.length){addOR();return;}
    rows.forEach(row=>{
      addOR();
      const tr=tbody.querySelector('tr:last-child');
      if(!tr)return;
      ['cod_angajament','indicator_angajament','program','cod_SSI'].forEach(f=>{
        const inp=tr.querySelector(`[data-f="${f}"]`);
        if(inp&&row[f]!=null)inp.value=row[f];
      });
    });
    upTot();
  }catch(_){}
}

// ── Beneficiari autocomplete ──────────────────────────────────────────────────
let _benefTimer=null;
function debouncedBenefSearch(){
  clearTimeout(_benefTimer);
  _benefTimer=setTimeout(()=>_searchBenef(),400);
}
async function _searchBenef(){
  const q=(document.getElementById('o-benef')?.value||'').trim();
  const drop=document.getElementById('o-benef-drop');
  if(!drop)return;
  if(q.length<2){drop.style.display='none';return;}
  try{
    const r=await fetch('/api/beneficiari?q='+encodeURIComponent(q),{credentials:'include'});
    const j=await r.json();
    const list=j.beneficiari||[];
    if(!list.length){drop.style.display='none';return;}
    drop.innerHTML=list.map(b=>`<div class="ac-opt" tabindex="0"
        onclick="selectBenef(${b.id},'${esc(b.denumire)}','${esc(b.cif||'')}','${esc(b.iban||'')}','${esc(b.banca||'')}')">
        <strong>${esc(b.denumire)}</strong><br>
        <small>CIF: ${esc(b.cif||'—')} · IBAN: ${esc(b.iban||'—')}</small>
      </div>`).join('');
    drop.style.display='block';
  }catch(_){drop.style.display='none';}
}
function selectBenef(id,den,cif,iban,banca){
  const sv2=(eid,val)=>{const e=document.getElementById(eid);if(e)e.value=val;};
  sv2('o-benef',den);sv2('o-cifb',cif);sv2('o-iban',iban);sv2('o-banca',banca);
  const drop=document.getElementById('o-benef-drop');
  if(drop)drop.style.display='none';
}
// ── v3.9.504: CIF lookup → auto-fill beneficiar (local → ANAF fallback) ────────
async function _lookupByCif(){
  const cifEl=document.getElementById('o-cifb');
  if(!cifEl)return;
  let cif=(cifEl.value||'').trim().toUpperCase().replace(/^RO\s*/,'');
  cifEl.value=cif;
  if(!/^\d{2,10}$/.test(cif))return;

  const spin=document.getElementById('o-cifb-spin');
  const showSpin=v=>{if(spin)spin.style.display=v?'inline-block':'none';};
  const setF=(id,val)=>{const e=document.getElementById(id);if(e&&val!=null)e.value=val;};
  const _setS=(msg,type)=>{if(typeof window.setS==='function')window.setS(msg,type);};

  showSpin(true);
  let resolved=false;

  // 1. Caută local întâi (după CIF exact match)
  try{
    const r=await fetch('/api/beneficiari?q='+encodeURIComponent(cif),{credentials:'include'});
    if(r.ok){
      const j=await r.json();
      const match=(j.beneficiari||[]).find(b=>String(b.cif||'')===cif);
      if(match){
        setF('o-benef',match.denumire||'');
        setF('o-iban',match.iban||'');
        setF('o-banca',match.banca||'');
        _setS('Beneficiar găsit local: '+(match.denumire||cif),'ok');
        resolved=true;
      }
    }
  }catch(_){/* fall through to ANAF */}

  // 2. Fallback ANAF doar dacă nu am găsit local
  if(!resolved){
    _setS('Verificare CIF la ANAF...','info');
    try{
      const r=await fetch('/api/verify/cui?cui='+encodeURIComponent(cif),{credentials:'include'});
      if(r.ok){
        const j=await r.json();
        if(j.ok&&j.data&&j.data.name){
          setF('o-benef',j.data.name);
          _setS('Denumire preluată ANAF: '+j.data.name,'ok');
          resolved=true;
        } else {
          _setS('CIF '+cif+' negăsit la ANAF','err');
        }
      } else {
        _setS('Eroare verificare ANAF (HTTP '+r.status+')','err');
      }
    }catch(e){
      _setS('Eroare rețea verificare ANAF','err');
    }
  }

  showSpin(false);
}
window._lookupByCif=_lookupByCif;

// Închide dropdown la click în afară
document.addEventListener('click',e=>{
  const drop=document.getElementById('o-benef-drop');
  if(drop&&!drop.contains(e.target)&&e.target.id!=='o-benef')drop.style.display='none';
});

// ── Salvare automată beneficiar la Trimite P2 ─────────────────────────────────
async function _saveBeneficiarIfNew(){
  const den=(g('o-benef')||'').trim();
  const cif=(g('o-cifb')||'').trim();
  const iban=(g('o-iban')||'').trim();
  const banca=(g('o-banca')||'').trim();
  if(!den)return;
  try{
    await fetch('/api/beneficiari',{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify({denumire:den,cif,iban,banca}),
    });
  }catch(_){}
}

// ── Centralizare: navigare secțiuni ──────────────────────────────────────────
let _lstState={type:'alop',page:1,limit:20};
let _lstDebTimer=null;

function showListSection(tab){
  _clearValErr();
  document.getElementById('section-list').style.display='';
  document.getElementById('section-form').style.display='none';
  const _tEl=document.getElementById('dfPageTitle'),_sEl=document.getElementById('dfPageSubtitle');
  if(_tEl)_tEl.textContent='Formulare oficiale';
  if(_sEl)_sEl.textContent='Document de Fundamentare, Ordonanțare de Plată, ALOP';
  try{history.replaceState({},'',location.pathname);}catch(_){}
  switchListTab(tab||'alop');
  loadList();
}
function _updateBackBtn(ft){
  const btn=document.getElementById('btn-back');
  if(!btn)return;
  const inAlop=!!(window._alopContext?.alopId);
  if(inAlop){
    btn.textContent='← Înapoi la ALOP';
    btn.onclick=()=>{window._alopContext=null;sessionStorage.removeItem('_alopContext');showListSection('alop');};
  }else{
    btn.textContent=ft==='notafd'?'← Înapoi la lista DF':'← Înapoi la lista ORD';
    btn.onclick=()=>showListSection();
  }
}
function showFormSection(ft){
  _clearValErr();
  document.getElementById('section-list').style.display='none';
  document.getElementById('section-form').style.display='';
  const _tEl=document.getElementById('dfPageTitle'),_sEl=document.getElementById('dfPageSubtitle');
  const _titles={'notafd':'Document de Fundamentare','ordnt':'Ordonanțare de Plată','alop':'ALOP — Angajament, Lichidare, Ordonanțare, Plată'};
  const _subs={'notafd':'Completați secțiunile A și B conform rolului dumneavoastră','ordnt':'Completați ordonanțarea asociată documentului de fundamentare','alop':'Centralizator financiar — evidență angajamente bugetare'};
  if(_tEl)_tEl.textContent=_titles[ft]||'Formular';
  if(_sEl)_sEl.textContent=_subs[ft]||'';
  const sb=document.getElementById('form-save-badge');if(sb)sb.textContent='';
  const ti=document.getElementById('form-type-title');
  if(ti)ti.textContent=ft==='ordnt'?'📄 Ordonanțare de Plată':'📋 Document de Fundamentare';
  sw(ft||'ordnt');
  _updateBackBtn(ft);
}
function newDocFromList(){
  const ft=_lstState.type==='ord'?'ordnt':'notafd';
  showFormSection(ft);
  // URL indică document nou
  try{history.replaceState({},'',`${location.pathname}?tip=${_lstState.type}`);}catch(_){}
  newDoc(ft);
  _applyAutoFill(ft,true);
}
function switchListTab(type){
  _lstState.type=type;_lstState.page=1;
  // Curăță contextul ALOP la navigare manuală din/spre alt tab decât DF/ORD
  if(type!=='df'&&type!=='ord'){window._alopContext=null;sessionStorage.removeItem('_alopContext');}
  document.getElementById('ltab-df').classList.toggle('active',type==='df');
  document.getElementById('ltab-ord').classList.toggle('active',type==='ord');
  document.getElementById('ltab-alop').classList.toggle('active',type==='alop');
  const ltabV=document.getElementById('ltab-verify');
  if(ltabV)ltabV.classList.toggle('active',type==='verify');
  const ltabRfn=document.getElementById('ltab-rfn');
  if(ltabRfn)ltabRfn.classList.toggle('active',type==='rfn');
  const ltabNfi=document.getElementById('ltab-nfi');
  if(ltabNfi)ltabNfi.classList.toggle('active',type==='nfi');
  const ltabClasa8=document.getElementById('ltab-clasa8');
  if(ltabClasa8)ltabClasa8.classList.toggle('active',type==='clasa8');
  // Bannere informative pentru DF/ORD
  const bannerDf=document.getElementById('lst-banner-df');
  const bannerOrd=document.getElementById('lst-banner-ord');
  if(bannerDf)bannerDf.style.display=type==='df'?'':'none';
  if(bannerOrd)bannerOrd.style.display=type==='ord'?'':'none';
  // Secțiuni ALOP / Verify / Clasa 8 / Formulare Oficiale
  const lstWrap=document.querySelector('#section-list .lst-wrap');
  const alopSection=document.getElementById('alop-section');
  const verifySection=document.getElementById('verify-section');
  const rfnSection=document.getElementById('rfn-section');
  const nfiSection=document.getElementById('nfi-section');
  const clasa8Section=document.getElementById('clasa8-section');
  if(type==='alop'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    loadAlop();loadAlopStats();
    // Re-fetch detaliu dacă era deschis — statusul poate fi schimbat după semnare
    const _detailP=document.getElementById('alop-detail-panel');
    if(_detailP&&_detailP.style.display!=='none'&&window._currentAlopId){
      openAlop(window._currentAlopId);
    }
  }else if(type==='verify'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='clasa8'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof openClasa8==='function')openClasa8();
  }else if(type==='rfn'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='nfi'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else{
    if(lstWrap)lstWrap.style.display='';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof _populateCompartimente==='function')_populateCompartimente();
    loadList();
  }
}
async function loadList(){
  const tb=document.getElementById('lst-tbody');
  const em=document.getElementById('lst-empty');
  const ld=document.getElementById('lst-loading');
  const pg=document.getElementById('lst-pagination');
  if(tb)tb.innerHTML='';
  if(em)em.style.display='none';
  if(ld)ld.style.display='';
  if(pg)pg.style.display='none';
  const p=[];
  const status=(document.getElementById('flt-status')?.value)||'all';
  const from=(document.getElementById('flt-from')?.value)||'';
  const to=(document.getElementById('flt-to')?.value)||'';
  const comp=(document.getElementById('flt-comp')?.value)||'';
  const init=(document.getElementById('flt-init')?.value)||'';
  const p2=(document.getElementById('flt-p2')?.value)||'';
  const nr=(document.getElementById('flt-nr')?.value)||'';
  p.push('type='+_lstState.type);
  if(status&&status!=='all')p.push('status='+encodeURIComponent(status));
  if(from)p.push('from='+encodeURIComponent(from));
  if(to)p.push('to='+encodeURIComponent(to));
  if(comp)p.push('comp='+encodeURIComponent(comp));
  if(init)p.push('init='+encodeURIComponent(init));
  if(p2)p.push('p2='+encodeURIComponent(p2));
  if(nr)p.push('nr='+encodeURIComponent(nr.trim()));
  p.push('page='+_lstState.page);
  p.push('limit='+_lstState.limit);
  try{
    const r=await fetch('/api/formulare/list?'+p.join('&'),{credentials:'include'});
    if(ld)ld.style.display='none';
    if(!r.ok){if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}return;}
    const j=await r.json();
    const rows=j.rows||[];
    const total=j.total||0;
    if(!rows.length){if(em)em.style.display='';}
    else{_renderLstTable(rows,_lstState.type);_renderLstPagin(total,_lstState.page,_lstState.limit);}
  }catch(e){if(ld)ld.style.display='none';if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}}
}
function _stBadge(status){
  const map={draft:'📝 Draft',pending_p2:'📤 La Responsabil CAB',completed:'✅ Completat',
    generat_pdf:'📄 PDF generat',transmis_flux:'🔄 Trimis flux',
    aprobat:'🟢 Aprobat',respins:'❌ Respins',anulat:'🚫 Anulat',returnat:'↩ Returnat',
    neaprobat:'❌ Neaprobat',de_revizuit:'🔄 De revizuit'};
  const cls={draft:'st-draft',pending_p2:'st-transmis_p2',completed:'st-completat',
    generat_pdf:'st-generat_pdf',transmis_flux:'st-transmis_flux',
    aprobat:'st-aprobat',respins:'st-respins',anulat:'st-anulat',returnat:'st-returnat',
    neaprobat:'st-neaprobat',de_revizuit:'st-de-revizuit'};
  return`<span class="stbadge ${cls[status]||'st-draft'}">${esc(map[status]||status)}</span>`;
}
function _fmtDate(iso){
  if(!iso)return '—';
  try{return new Date(iso).toLocaleString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
  catch{return iso;}
}
function _renderLstTable(rows,type){
  const tb=document.getElementById('lst-tbody');
  if(!tb)return;
  tb.innerHTML=rows.map(row=>{
    const canDelete=row.can_delete===true;
    const cancelBtn=canDelete
      ?`<button class="df-action-btn danger sm" onclick="stergeDoc('${type}','${esc(row.id)}')" title="Șterge">🗑</button>`
      :'';
    const isAdm=window.ST?.user?.role==='admin'||window.ST?.user?.role==='org_admin';
    const auditBtn=isAdm
      ?`<button class="df-action-btn teal sm" onclick="openFormAudit('${type}','${esc(row.id)}')" title="Audit document"><svg class="df-ico"><use href="/icons.svg?v=3.9.540#ico-clipboard"/></svg></button>`
      :'';
    const safeId=esc(row.id);
    const nr=esc(row.nr||row.id.slice(0,8));
    const titlu=esc(row.titlu||'');
    const revBadgeLst=type==='df'
      ?`<span class="df-revizie-badge${(row.revizie_nr||0)>0?' revizie-activa':''}" style="vertical-align:middle;margin-left:4px">R${row.revizie_nr||0}</span>`
      :'';
    const istoricBadgeLst=(type==='df'&&row.has_newer_revision===true)
      ?`<span style="vertical-align:middle;margin-left:4px;padding:1px 7px;border-radius:8px;font-size:.65rem;font-weight:600;background:rgba(148,163,184,.15);color:#94a3b8;border:1px solid rgba(148,163,184,.25);text-transform:uppercase;letter-spacing:.04em" title="Există o revizie mai recentă pentru acest DF">istoric</span>`
      :'';
    return`<tr>
      <td><a href="#" onclick="openDocFromList('${type}','${safeId}');return false" style="font-weight:500">${nr}${revBadgeLst}${istoricBadgeLst}</a><button type="button" class="trasab-inline-btn" onclick="event.stopPropagation();openTrasabilitate('${type}','${safeId}');return false" title="Vezi trasabilitate (lanț DF↔ALOP↔ORD)">🔗</button>${titlu?`<br><small style="color:#666">${titlu}</small>`:''}
      </td>
      <td>${esc(row.initiator||'—')}</td>
      <td>${esc(row.initiator_comp||'—')}</td>
      <td>${esc(row.p2||'—')}</td>
      <td>${_stBadge(row.aprobat ? 'aprobat' : row.status)}</td>
      <td>
        <div>${_fmtDate(row.created_at)}</div>
        ${row.initiator ? `<div style="font-size:.75rem;color:var(--df-text-3);margin-top:2px">${esc(row.initiator)}</div>` : ''}
      </td>
      <td>
        <div>${_fmtDate(row.updated_at)}</div>
        ${row.updated_by_nume ? `<div style="font-size:.75rem;color:var(--df-text-3);margin-top:2px">${esc(row.updated_by_nume)}</div>` : ''}
      </td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="df-action-btn sm" onclick="openDocFromList('${type}','${safeId}')">Deschide</button>
        ${auditBtn}
        ${cancelBtn}
      </td>
    </tr>`;
  }).join('');
}
function _renderLstPagin(total,page,limit){
  const pg=document.getElementById('lst-pagination');
  const info=document.getElementById('lst-page-info');
  const prev=document.getElementById('lst-prev');
  const next=document.getElementById('lst-next');
  if(!pg)return;
  const totalPages=Math.ceil(total/limit)||1;
  if(totalPages<=1){pg.style.display='none';return;}
  pg.style.display='flex';
  if(info)info.textContent=`Pagina ${page} din ${totalPages} (${total} total)`;
  if(prev)prev.disabled=page<=1;
  if(next)next.disabled=page>=totalPages;
}
function changeLstPage(dir){
  _lstState.page=Math.max(1,_lstState.page+dir);
  loadList();
}
function openDocFromList(type,id){
  const ft=type==='ord'?'ordnt':'notafd';
  showFormSection(ft);
  // URL reflectă documentul deschis: /formulare?id=UUID&tip=df
  try{history.replaceState({},'',`${location.pathname}?id=${encodeURIComponent(id)}&tip=${type}`);}catch(_){}
  setTimeout(()=>openDoc(ft,id),200);
}
async function stergeDoc(type,id){
  const eticheta=type==='ord'?'ordonanțare':'document de fundamentare';
  if(!confirm(`Ștergeți acest ${eticheta}? Operațiunea nu poate fi inversată.`))return;
  try{
    const r=await fetch(`/api/formulare-${type}/${id}/sterge`,{
      method:'POST',credentials:'include',
      headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const j=await r.json();
    if(!r.ok||!j.ok){
      const msg=j.message||({
        cannot_delete_on_flow:'Documentul este pe fluxul de semnare și nu poate fi șters.',
        cannot_delete_has_ord:'Există o ORD legată — ștergeți întâi ORD-ul.',
      }[j.error])||j.error||'Eroare la ștergere';
      alert(msg);
      return;
    }
    loadList();
  }catch(e){alert('Eroare: '+e.message);}
}
function debouncedLoadList(){
  clearTimeout(_lstDebTimer);
  _lstDebTimer=setTimeout(()=>loadList(),400);
}
function resetFilters(){
  const st=document.getElementById('flt-status');if(st)st.value='all';
  const cp=document.getElementById('flt-comp');if(cp)cp.value='';
  ['flt-from','flt-to','flt-init','flt-p2','flt-nr','flt-from-display','flt-to-display'].forEach(id=>{
    const e=document.getElementById(id);
    if(e){ e.value=''; e.style.borderColor=''; }
  });
  _lstState.page=1;
  loadList();
}
function _populateCompartimente(){
  const sel=document.getElementById('flt-comp');
  if(!sel)return;
  const list=ST.orgProfile?._compList||[];
  if(!list.length)return;
  sel.innerHTML='<option value="">Toate</option>'+list.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
}


  // ── Exports cross-module ─────────────────────────────────────────────────
  window.switchListTab          = switchListTab;
  window.showListSection        = showListSection;
  window.showFormSection        = showFormSection;
  window.newDocFromList         = newDocFromList;
  window.loadList               = loadList;
  window.openDocFromList        = openDocFromList;
  window.stergeDoc              = stergeDoc;
  window.changeLstPage          = changeLstPage;
  window.debouncedLoadList      = debouncedLoadList;
  window.resetFilters           = resetFilters;

  window.loadDfAprobate         = loadDfAprobate;
  window.selectDfAprobat        = selectDfAprobat;
  window.onDfSelect             = onDfSelect;
  window.debouncedBenefSearch   = debouncedBenefSearch;
  window.selectBenef            = selectBenef;
  window._saveBeneficiarIfNew   = _saveBeneficiarIfNew;

  window._autoSaveDb            = _autoSaveDb;
  window._scheduleAutoSaveDb    = _scheduleAutoSaveDb;
  window._populateCompartimente = _populateCompartimente;
  window._updateBackBtn         = _updateBackBtn;

  window.df = window.df || {};
  window.df._formularListLoaded = true;
})();
