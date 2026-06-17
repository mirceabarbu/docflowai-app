// public/js/formular/doc.js
// DocFlowAI — Modul Document CRUD + Validări + P2 modal (BLOC 2.5).
//
// Scope: openDoc, saveDoc, newDoc, refreshDocs, viewFlowPdf,
//        collect/populate Df/Ord, role-based UI, P2 flow, return flow,
//        validări (_validateDf/Ord), resetF
//
// Cross-module reads (bare identifiers, rezolvate la call time):
//   - ST, setS, clrS, sw, imgs, fMR, pMR, attachMoneyInput (din formular.js core)
//   - valF, mkFlow, getOR, getNV, getNP, getNC, colO, colN (din core)
//   - addOR, addNV, addNP, addNC, upTot, p4toggle, p5toggle, clrImg (din core)
//   - window._alopLinkDoc (alop.js), window.draftSave/draftClear/_draftAttach (draft.js)
//   - window.loadDfAprobate, _autoSaveDb, _scheduleAutoSaveDb (list.js)
//   - window.switchListTab, loadList (list.js)
//
// Cross-module exports: openDoc, saveDoc, newDoc, refreshDocs, viewFlowPdf,
//   populateDf/Ord, applyDf/OrdRoleState, renderActions, lockAll, showP2Modal,
//   confirmP2, completeAsP2, resetDocToP1, showReturnModal, confirmReturn, resetF, ...

(function() {
  'use strict';
  const esc = window.df.esc;

function ftApi(ft){return ft==='ordnt'?'/api/formulare-ord':'/api/formulare-df';}
function ftType(ft){return ft==='ordnt'?'ord':'df';}

// ── Status label ─────────────────────────────────────────────────────────────
function stLabel(s,aprobat){
  if(aprobat)return['aprobat','✔ Aprobat'];
  return{draft:['draft','● Draft'],pending_p2:['pending','⏳ La Responsabil CAB'],completed:['completed','✅ Complet'],aprobat:['aprobat','🟢 Aprobat'],transmis_flux:['transmis_flux','🔄 Pe flux'],returnat:['returnat','↩ Returnat'],respins:['respins','❌ Respins'],neaprobat:['neaprobat','❌ Neaprobat'],de_revizuit:['de_revizuit','🔄 De revizuit']}[s]||['draft',s];
}

// ── Colectare date formular → DB ──────────────────────────────────────────────
// v3.9.499 (Finding D): img2 ELIMINAT din collectOrdDb. Captura 2 se persistă
// exclusiv via /api/formulare-capturi/ord/:id?slot=2 (vezi uploadCaptura).
function collectOrdDb(){return{
  cif:g('o-cif'),den_inst_pb:g('o-den'),nr_ordonant_pl:g('o-nr'),data_ordont_pl:g('o-data'),
  nr_unic_inreg:g('o-nrUnic'),beneficiar:g('o-benef'),documente_justificative:g('o-docsj'),
  iban_beneficiar:g('o-iban'),cif_beneficiar:g('o-cifb'),banca_beneficiar:g('o-banca'),
  inf_pv_plata:g('o-inf1'),inf_pv_plata1:g('o-inf2'),rows:getOR(),
  df_id:document.getElementById('o-df-id')?.value||null,
  // v3.9.554: proveniență ALOP — backend-ul o persistă DOAR la creare (POST);
  // permite self-heal relink dacă link-ord eșuează silențios.
  source_alop_id:window._alopContext?.alopId||null,
};}
function collectDfP1Db(){return{
  cif:g('n-cif'),den_inst_pb:g('n-den'),subtitlu_df:g('n-subtitlu'),
  nr_unic_inreg:g('n-nrUnic'),revizuirea:g('n-rev'),data_revizuirii:g('n-data'),
  compartiment_specialitate:g('n-comp'),obiect_fd_reviz_scurt:g('n-scurt'),obiect_fd_reviz_lung:g('n-lung'),
  ckbx_oblig_tert:cb('n-ck-oblig'),
  ckbx_stab_tin_cont:cb('n-ck-stab'),ckbx_ramane_suma:cb('n-ck-ramane'),ramane_suma:g('n-ramana')||'0',
  rows_val_unchanged:!!document.getElementById('n-ck-ramane')?.checked,
  rows_val:getNV(),
  ckbx_fara_ang_emis_ancrt:cb('n-ck-faraang'),ckbx_cu_ang_emis_ancrt:cb('n-ck-cuang'),
  ckbx_sting_ang_in_ancrt:cb('n-ck-sting'),ckbx_fara_plati_ang_in_ancrt:cb('n-ck-faraplati'),
  ckbx_cu_plati_ang_in_mmani:cb('n-ck-cuplati'),ckbx_ang_leg_emise_ct_an_urm:cb('n-ck-anurmatori'),
  rows_plati:getNP(),
  // FEATURE buget multi-anual (v3.9.558): an absolut care ancorează benzile rows_plati.
  // La creare backend-ul îl default-ează la anul curent dacă lipsește; la revizie e moștenit.
  an_referinta:g('n-anref')||'',
  // v3.9.554: proveniență ALOP — backend-ul o persistă DOAR la creare (POST);
  // permite self-heal relink la aprobare dacă link-df eșuează silențios.
  source_alop_id:window._alopContext?.alopId||null,
};}
function collectDfP2Db(){return{
  ckbx_secta_inreg_ctrl_ang:cb('n-ck-seca'),ckbx_fara_inreg_ctrl_ang:cb('n-ck-fararezv'),
  sum_fara_inreg_ctrl_crdbug:g('n-sumfara')||'0',
  ckbx_interzis_emit_ang:cb('n-ck-interzis'),ckbx_interzis_intrucat:cb('n-ck-intrucat'),
  intrucat:g('n-intrucat'),rows_ctrl:getNC(),
};}

// ── Populare formular din doc DB ──────────────────────────────────────────────
function sv(id,val){const e=document.getElementById(id);if(e&&val!==null&&val!==undefined)e.value=e.dataset.money?fMR(parseFloat(val)||0):val;}
function sc(id,val){const e=document.getElementById(id);if(e)e.checked=val==='1'||val===true;}

async function populateOrd(doc){
  sv('o-cif',doc.cif);sv('o-den',doc.den_inst_pb);sv('o-nr',doc.nr_ordonant_pl);sv('o-data',doc.data_ordont_pl);
  sv('o-nrUnic',doc.nr_unic_inreg);sv('o-benef',doc.beneficiar);sv('o-docsj',doc.documente_justificative);
  sv('o-iban',doc.iban_beneficiar);sv('o-cifb',doc.cif_beneficiar);sv('o-banca',doc.banca_beneficiar);
  sv('o-inf1',doc.inf_pv_plata);sv('o-inf2',doc.inf_pv_plata1);
  // Restabilește selecția DF legat
  const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value=doc.df_id||'';
  const dfId=document.getElementById('o-df-id');if(dfId)dfId.value=doc.df_id||'';
  // Context buget an exercițiu pentru atenționarea inline — REZOLVAT de backend pe GET detaliu
  // (paritate cu garda hard). Setat ÎNAINTE de upTot() ca verificarea live să-l vadă.
  if(doc.buget_an_curent!=null){
    _ordBugetCtx={buget_an_curent:doc.buget_an_curent,cicluri_arhivate:doc.cicluri_arhivate,an_exercitiu:doc.an_exercitiu};
  }else{_ordBugetCtx=null;}
  const tbody=document.getElementById('o-tbody');tbody.innerHTML='';oI=0;
  (doc.rows||[]).forEach(row=>{addOR();const tr=tbody.querySelector('tr:last-child');Object.entries(row).forEach(([f,v])=>{const inp=tr.querySelector(`[data-f="${f}"]`);if(inp)inp.value=inp.dataset.money?fMR(parseFloat(v)||0):v;});});
  // v3.9.500 (Issue I-2): wrap-ul captura 2 e VIZIBIL mereu, ca P2 să poată
  // încărca chiar și când DB nu are nimic în slot=2 yet. IMG-ul intern
  // (o-cimg2) afișează data doar când există; placeholder (o-cph2) altfel.
  // Fetch slot=2 din formulare_capturi (v3.9.499) cu fallback la doc.img2.
  const _wrap2=document.getElementById('o-captura2-wrap');
  if(_wrap2)_wrap2.style.display='';  // mereu vizibil
  clrImg('o-cimg2','o-cph2');  // resetare default (placeholder vizibil)
  try{
    const capR2=await fetch(`/api/formulare-capturi/ord/${doc.id||ST.docId.ordnt}?slot=2`,{credentials:'include'});
    if(capR2.ok&&capR2.headers.get('content-type')?.startsWith('image')){
      const blob=await capR2.blob();
      const reader=new FileReader();
      reader.onload=e=>showImg('o-cimg2','o-cph2',e.target.result);
      reader.readAsDataURL(blob);
    } else {
      // Fallback la doc.img2 (defensive v3.9.498) pentru ord-uri pre-backfill 079
      const _img2Valid=typeof doc.img2==='string'
        && doc.img2.length>32
        && /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(doc.img2);
      if(_img2Valid){
        showImg('o-cimg2','o-cph2',doc.img2);
      }else if(doc.img2){
        console.warn('[v3.9.500] populateOrd: doc.img2 invalid + no slot=2 (preview):',
          typeof doc.img2, String(doc.img2).slice(0,80));
      }
    }
  }catch(e){
    console.warn('[v3.9.500] populateOrd: captura slot=2 fetch error', e);
    // NU ascunde wrap-ul pe eroare — vrem ca P2 să poată retry upload
  }
  upTot();
  // Ciclu 2+: prefill plati_anterioare
  const _sumaAnt=window._alopSumaPlataAnterioara||0;
  if(_sumaAnt>0){
    const _antInputs=document.querySelectorAll('#o-tbody input[data-f="plati_anterioare"]');
    if(_antInputs.length){_antInputs[0].value=fMR(_sumaAnt);calcORRow(_antInputs[0]);}
  }
}
function populateDf(doc){
  sv('n-cif',doc.cif);sv('n-den',doc.den_inst_pb);sv('n-subtitlu',doc.subtitlu_df);
  sv('n-nrUnic',doc.nr_unic_inreg);sv('n-rev',doc.revizuirea);sv('n-data',doc.data_revizuirii);
  sv('n-comp',doc.compartiment_specialitate);sv('n-scurt',doc.obiect_fd_reviz_scurt);sv('n-lung',doc.obiect_fd_reviz_lung);
  sc('n-ck-oblig',doc.ckbx_oblig_tert);
  sc('n-ck-stab',doc.ckbx_stab_tin_cont);sc('n-ck-ramane',doc.ckbx_ramane_suma);sv('n-ramana',doc.ramane_suma||'0');
  if(doc.ckbx_stab_tin_cont==='1')p4toggle('stab');else if(doc.ckbx_ramane_suma==='1')p4toggle('ramane');
  sc('n-ck-faraang',doc.ckbx_fara_ang_emis_ancrt);sc('n-ck-cuang',doc.ckbx_cu_ang_emis_ancrt);
  sc('n-ck-sting',doc.ckbx_sting_ang_in_ancrt);sc('n-ck-faraplati',doc.ckbx_fara_plati_ang_in_ancrt);
  sc('n-ck-cuplati',doc.ckbx_cu_plati_ang_in_mmani);sc('n-ck-anurmatori',doc.ckbx_ang_leg_emise_ct_an_urm);
  p5toggle();
  sc('n-ck-seca',doc.ckbx_secta_inreg_ctrl_ang);sc('n-ck-fararezv',doc.ckbx_fara_inreg_ctrl_ang);
  sv('n-sumfara',doc.sum_fara_inreg_ctrl_crdbug||'0');
  sc('n-ck-interzis',doc.ckbx_interzis_emit_ang);sc('n-ck-intrucat',doc.ckbx_interzis_intrucat);
  sv('n-intrucat',doc.intrucat);
  // FEATURE buget multi-anual (v3.9.558): restabilește an_referinta (NULL legacy → anul curent
  // afișat, fără a-l forța la salvare). La revizie câmpul e read-only (moștenit din părinte).
  sv('n-anref',doc.an_referinta!=null?doc.an_referinta:'');
  { const _ar=document.getElementById('n-anref');
    if(_ar){ _ar.readOnly=!!(doc.este_revizie||doc.parent_df_id||(doc.revizie_nr|0)>0); }
  }
  if(typeof anrefSync==='function')anrefSync();
  ['n-vtbody','n-ptbody','n-ctbody'].forEach(tid=>{const el=document.getElementById(tid);if(el)el.innerHTML='';});
  nVI=nPI=nCI=0;
  (doc.rows_val||[]).forEach(row=>{addNV();const tr=document.getElementById('n-vtbody').querySelector('tr:last-child');Object.entries(row).forEach(([f,v])=>{const inp=tr.querySelector(`[data-f="${f}"]`);if(inp)inp.value=inp.dataset.money?fMR(parseFloat(v)||0):v;});});
  (doc.rows_plati||[]).forEach(row=>{addNP();const tr=document.getElementById('n-ptbody').querySelector('tr:last-child');Object.entries(row).forEach(([f,v])=>{const inp=tr.querySelector(`[data-f="${f}"]`);if(inp)inp.value=inp.dataset.money?fMR(parseFloat(v)||0):v;});});
  (doc.rows_ctrl||[]).forEach(row=>{addNC();const tr=document.getElementById('n-ctbody').querySelector('tr:last-child');Object.entries(row).forEach(([f,v])=>{const inp=tr.querySelector(`[data-f="${f}"]`);if(inp)inp.value=inp.dataset.money?fMR(parseFloat(v)||0):v;});});
  if(!(doc.rows_ctrl||[]).length)addNC();
  document.querySelectorAll('#n-vtbody tr').forEach(tr=>{const c5=pMR(tr.querySelector('[data-f="valt_rev_prec"]')?.value),c6=pMR(tr.querySelector('[data-f="influente"]')?.value),c7=tr.querySelector('[data-f="valt_actualiz"]');if(c7)c7.value=fMR(c5+c6);});
  document.querySelectorAll('#n-ctbody tr').forEach(tr=>{
    const c5=pMR(tr.querySelector('[data-f="sum_rezv_crdt_ang_af_rvz_prc"]')?.value);
    const c6=pMR(tr.querySelector('[data-f="influente_c6"]')?.value);
    const c7=tr.querySelector('[data-f="sum_rezv_crdt_ang_act"]');if(c7)c7.value=fMR(c5+c6);
    const c8=pMR(tr.querySelector('[data-f="sum_rezv_crdt_bug_af_rvz_prc"]')?.value);
    const c9=pMR(tr.querySelector('[data-f="influente_c9"]')?.value);
    const c10=tr.querySelector('[data-f="sum_rezv_crdt_bug_act"]');if(c10)c10.value=fMR(c8+c9);
  });
  upTot();
}

// ── Soft-warning buget Sec.B (depășire credite bugetare, CAB) ─────────────────
// Map(cod_SSI → {buget,angajat_aprobat,disponibil}) sau null când nu suntem în
// modul de completare Sec.B (CAB). Read-only — pură validare client, nimic nu se
// persistă. Sursa: GET /api/clasa8/buget/disponibil (regula Clasa 8, server-side).
let _bugetDisponibil = null;

function _resetSecBBuget(){
  _bugetDisponibil = null;
  document.querySelectorAll('#n-ctbody .secb-buget-badge').forEach(b=>b.remove());
  document.querySelectorAll('#n-ctbody tr.secb-buget-over').forEach(tr=>tr.classList.remove('secb-buget-over'));
  const warn=document.getElementById('secb-buget-warn');
  if(warn){warn.style.display='none';warn.innerHTML='';}
}

async function _loadBugetDisponibil(docId){
  try{
    const qs=docId?`?exclude_df=${encodeURIComponent(docId)}`:'';
    const r=await fetch(`/api/clasa8/buget/disponibil${qs}`,{credentials:'include'});
    if(!r.ok){_bugetDisponibil=new Map();_checkSecBBuget();return;}
    const j=await r.json();
    _bugetDisponibil=new Map();
    (j.items||[]).forEach(it=>{
      _bugetDisponibil.set(String(it.cod_ssi||'').trim(),{
        buget:it.buget,angajat_aprobat:it.angajat_aprobat,disponibil:it.disponibil,
      });
    });
  }catch(e){
    console.warn('[buget] disponibil fetch error',e);
    _bugetDisponibil=new Map();
  }
  _checkSecBBuget();
}

function _checkSecBBuget(){
  const warn=document.getElementById('secb-buget-warn');
  // reset markers
  document.querySelectorAll('#n-ctbody .secb-buget-badge').forEach(b=>b.remove());
  document.querySelectorAll('#n-ctbody tr.secb-buget-over').forEach(tr=>tr.classList.remove('secb-buget-over'));
  if(!_bugetDisponibil){if(warn){warn.style.display='none';warn.innerHTML='';}return;}

  // Σ col.10 per cod_SSI peste TOATE rândurile Sec.B curente
  const sums=new Map(), rowsByCode=new Map();
  document.querySelectorAll('#n-ctbody tr').forEach(tr=>{
    const cod=(tr.querySelector('[data-f="cod_SSI"]')?.value||'').trim();
    if(!cod)return;
    const c10=pMR(tr.querySelector('[data-f="sum_rezv_crdt_bug_act"]')?.value)||0;
    sums.set(cod,(sums.get(cod)||0)+c10);
    if(!rowsByCode.has(cod))rowsByCode.set(cod,[]);
    rowsByCode.get(cod).push(tr);
  });

  const over=[];
  sums.forEach((sum,cod)=>{
    const info=_bugetDisponibil.get(cod);
    if(!info||info.disponibil==null)return; // fără buget importat pentru codul ăsta
    if(sum>info.disponibil+0.005){
      const dep=sum-info.disponibil;
      over.push({cod,dep});
      (rowsByCode.get(cod)||[]).forEach(tr=>{
        tr.classList.add('secb-buget-over');
        const cell=tr.querySelector('[data-f="cod_SSI"]')?.closest('td');
        if(cell&&!cell.querySelector('.secb-buget-badge')){
          const b=document.createElement('span');
          b.className='secb-buget-badge';
          b.textContent='⚠ depășire';
          b.title=`Depășire credite bugetare disponibile: ${fMR(dep)} lei`;
          cell.appendChild(b);
        }
      });
    }
  });

  if(warn){
    if(over.length){
      warn.innerHTML='⚠ Depășire credite bugetare disponibile: '+
        over.map(o=>`SSI ${esc(o.cod)} −${esc(fMR(o.dep))} lei`).join('; ');
      warn.style.display='';
    }else{warn.style.display='none';warn.innerHTML='';}
  }
}

// Expus pentru core.js (recalc live col.10) și re-fetch la schimbarea cod_SSI.
window._checkSecBBuget   = _checkSecBBuget;
window._loadBugetDisponibil = _loadBugetDisponibil;

// Re-fetch buget când CAB schimbă un cod_SSI în Sec.B (delegat, o singură dată).
(function(){
  const tb=document.getElementById('n-ctbody');
  if(!tb)return;
  tb.addEventListener('change',e=>{
    const t=e.target;
    if(_bugetDisponibil&&t&&t.matches&&t.matches('[data-f="cod_SSI"]')){
      _loadBugetDisponibil(ST?.docId?.notafd);
    }
  });
})();

// ── Atenționare inline buget an exercițiu ORD (P1 + P2) ───────────────────────
// PARITATE: verdictul inline reproduce EXACT validateOrdBugetAnCurent (server). Valorile
// `buget_an_curent` + `cicluri_arhivate` (+ `an_exercitiu`) vin REZOLVATE din backend (GET
// detaliu ORD sau /api/formulare-ord/buget-context?df_id=), via computeOrdBudgetContext —
// frontend-ul NU replică geometria benzilor. Soft: marchează vizual, NU blochează tastarea;
// blocajul hard rămâne la submit/complete (server). `null` = ORD fără df_id → fără plafon.
let _ordBugetCtx = null;

function _resetOrdBuget(){
  _ordBugetCtx = null;
  const warn=document.getElementById('ord-buget-warn');
  if(warn){warn.style.display='none';warn.innerHTML='';}
  document.querySelectorAll('#o-tbody tr.ord-buget-over').forEach(tr=>tr.classList.remove('ord-buget-over'));
}

async function _loadOrdBuget(dfId){
  if(!dfId){_ordBugetCtx=null;_checkOrdBuget();return;}
  try{
    const r=await fetch(`/api/formulare-ord/buget-context?df_id=${encodeURIComponent(dfId)}`,{credentials:'include'});
    const j=await r.json();
    _ordBugetCtx=(r.ok&&j.ok&&j.context)?j.context:null;
  }catch(e){
    console.warn('[buget-ord] context fetch error',e);
    _ordBugetCtx=null;
  }
  _checkOrdBuget();
}

function _checkOrdBuget(){
  const warn=document.getElementById('ord-buget-warn');
  document.querySelectorAll('#o-tbody tr.ord-buget-over').forEach(tr=>tr.classList.remove('ord-buget-over'));
  if(!_ordBugetCtx){if(warn){warn.style.display='none';warn.innerHTML='';}return;}
  const buget=Number(_ordBugetCtx.buget_an_curent)||0;
  const arhivat=Number(_ordBugetCtx.cicluri_arhivate)||0;
  const an=_ordBugetCtx.an_exercitiu;
  // Σ col.4 (suma ordonanțată) peste rândurile curente din UI — același input ca newRows server.
  const ordNou=[...document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]')]
    .reduce((s,i)=>s+(pMR(i.value)||0),0);
  const cumul=ordNou+arhivat;
  // ACEEAȘI toleranță ca backend (validateOrdBugetAnCurent): cumul > buget + 0.001 → depășire.
  const over=cumul>buget+0.001;
  if(over){
    document.querySelectorAll('#o-tbody tr').forEach(tr=>tr.classList.add('ord-buget-over'));
    if(warn){
      const dep=cumul-buget;
      warn.innerHTML='⛔ Suma ordonanțată '+(arhivat>0?`cumulată în anul ${esc(an)} (${esc(fMR(cumul))} lei, din care ${esc(fMR(arhivat))} lei deja plătiți în cicluri anterioare)`:`(${esc(fMR(cumul))} lei)`)+
        ` depășește bugetul estimat al anului ${esc(an)} (${esc(fMR(buget))} lei) cu ${esc(fMR(dep))} lei. Finalizarea va fi blocată.`;
      warn.style.display='';
    }
  }else if(warn){warn.style.display='none';warn.innerHTML='';}
}

// Expus pentru core.js (recalc live la fiecare mutație de rând în upTot) + list.js (la DF-select).
window._checkOrdBuget = _checkOrdBuget;
window._loadOrdBuget  = _loadOrdBuget;
window._resetOrdBuget = _resetOrdBuget;

// ── Lock câmpuri pe secțiuni ──────────────────────────────────────────────────
function lockAll(ft,lock){
  document.querySelectorAll(`#form-${ft} input:not([type=file]):not([type=hidden]),#form-${ft} textarea,#form-${ft} select,#form-${ft} .badd,#form-${ft} .bdel`).forEach(e=>e.disabled=lock);
}
function lockCaptureAndAttachments(ft,lock){
  const pe=lock?'none':'';
  const czId=ft==='ordnt'?'o-czone':'n-czone';
  const czone=document.getElementById(czId);
  if(czone)czone.style.pointerEvents=pe;
  document.querySelectorAll(`#form-${ft} .cap-zone input[type=file]`).forEach(e=>e.disabled=lock);
  document.querySelectorAll(`#form-${ft} .cap-br button`).forEach(e=>e.disabled=lock);
  const ainpId=ft==='ordnt'?'o-ainp':'n-fdai';
  const ainp=document.getElementById(ainpId);
  if(ainp)ainp.disabled=lock;
  document.querySelectorAll(`#form-${ft} .att-btn`).forEach(e=>e.disabled=lock);
}
function setModeP2Df(){
  // Blochează P1 (header + sect A), deblochează sect B
  ['n-den','n-cif','n-subtitlu','n-nrUnic','n-rev','n-data','n-ck-oblig','n-comp','n-scurt','n-lung',
   'n-ck-stab','n-ck-ramane','n-ramana','n-ck-cuang','n-ck-faraang','n-ck-sting',
   'n-ck-faraplati','n-ck-cuplati','n-ck-anurmatori'].forEach(id=>{const e=document.getElementById(id);if(e)e.disabled=true;});
  document.querySelectorAll('#n-vtbody input,#n-ptbody input,#n-vtbody .bdel,#n-ptbody .bdel,#n-vtbody .badd,#n-ptbody .badd').forEach(e=>e.disabled=true);
  // Sect B deblocată + highlight
  ['n-ck-seca','n-ck-fararezv','n-sumfara','n-ck-interzis','n-ck-intrucat','n-intrucat'].forEach(id=>{
    const e=document.getElementById(id);if(e){e.disabled=false;}
  });
  document.querySelectorAll('#n-ctbody input').forEach(e=>{e.disabled=false;});
  // Upload captură deblocat
  const czone=document.getElementById('n-czone');if(czone)czone.style.pointerEvents='';
}
function setModeP2Ord(){
  lockAll('ordnt',true);
  // Deblochez receptii + plati_anterioare în tabel
  document.querySelectorAll('#o-tbody input[data-f="receptii"],#o-tbody input[data-f="plati_anterioare"]').forEach(e=>{e.disabled=false;});
  // v3.9.500 (Issue I-2): pointer-events pe AMBELE zone de captură pentru P2
  const czone=document.getElementById('o-czone');if(czone)czone.style.pointerEvents='';
  const czone2=document.getElementById('o-czone2');if(czone2)czone2.style.pointerEvents='';
}

// ── DF/ORD dark redesign — visual role state ──────────────────────────────────
function _dfUpdateProgress(ft,step){
  const isOrd=ft==='ordnt';
  const pfx=isOrd?'ordp':'dfp';
  const order=isOrd?['date','p1','p2','sign']:['date','seca','secb','sign'];
  const idx=order.indexOf(step);
  order.forEach((s,i)=>{
    const el=document.getElementById(pfx+'-'+s);
    if(!el)return;
    el.className='df-step';
    if(i<idx)el.classList.add('done');
    else if(i===idx)el.classList.add('active');
  });
  // Dacă step='sign' și documentul e aprobat, marchează și 'sign' ca done
  if(step==='sign'){
    const signEl=document.getElementById(pfx+'-sign');
    if(signEl) signEl.className='df-step done';
  }
}
function _dfSetAlopCtx(ft){
  const ctx=window._alopContext;
  const el=document.getElementById('alop-ctx-'+ft);
  if(!el)return;
  if(ctx?.alopId){
    let valStr='';
    try{
      const v=parseFloat(ctx.valoare);
      if(!isNaN(v)&&v>0)
        valStr=` · ${new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v)} RON`;
    }catch(_){}
    el.textContent=`📊 ALOP: ${ctx.titlu||ctx.alopId}${valStr}`;
    el.className='df-alop-ctx show';
  }
  else{el.textContent='';el.className='df-alop-ctx';}
  // Butonul Înapoi este actualizat de _updateBackBtn(ft) — centralizat
  _updateBackBtn(ft);
}
function prefillSectBFromSectA(){
  const srcRows=document.querySelectorAll('#n-vtbody tr');
  const dstRows=document.querySelectorAll('#n-ctbody tr');
  srcRows.forEach((srcTr,i)=>{
    if(!dstRows[i])addNC();
    const dst=document.querySelectorAll('#n-ctbody tr')[i];
    if(!dst)return;
    const progSrc=srcTr.querySelector('[data-f="program"]');
    const ssiSrc=srcTr.querySelector('[data-f="codSSI"]');
    const progDst=dst.querySelector('[data-f="program"]');
    const ssiDst=dst.querySelector('[data-f="cod_SSI"]');
    if(progSrc&&progDst&&!progDst.value)progDst.value=progSrc.value;
    if(ssiSrc&&ssiDst&&!ssiDst.value)ssiDst.value=ssiSrc.value;
  });
}
function _secbSetDisabled(disabled) {
  document.querySelectorAll(
    '#secb-body input, #secb-body textarea, #secb-body select, #secb-body .badd, #secb-body .bdel'
  ).forEach(e => e.disabled = disabled);
}
function applyDfRoleState(status,role){
  const secaBody=document.getElementById('seca-body');
  const secbBody=document.getElementById('secb-body');
  const secaLock=document.getElementById('seca-lock');
  const secbLock=document.getElementById('secb-lock');
  if(!secaBody)return;
  const antetBody=document.getElementById('df-antet-body');
  const antetLock=document.getElementById('df-antet-lock');
  const _revNr=ST.docRevizieNr?.notafd||0;
  const _antetEditabil=(_revNr===0&&(!status||status==='draft'));
  if(antetBody){
    antetBody.querySelectorAll('input,textarea').forEach(e=>{e.disabled=!_antetEditabil;});
  }
  if(antetLock){antetLock.style.display=_antetEditabil?'none':'flex';}
  secaBody.classList.remove('locked');
  document.querySelectorAll('#seca-body input[type="checkbox"]').forEach(cb=>{cb.disabled=false;});
  if(secbBody)secbBody.classList.remove('locked');
  _secbSetDisabled(false);
  if(secaLock)secaLock.style.display='none';
  if(secbLock)secbLock.style.display='none';
  if(!status||status==='draft'){
    if(secbBody)secbBody.classList.add('locked');
    _secbSetDisabled(true);
    if(secbLock){secbLock.style.display='flex';secbLock.className='df-lock-bar df-lock-info';secbLock.textContent='🔒 Secțiunea B se completează de Responsabilul CAB după trimiterea Secțiunii A.';}
    _dfUpdateProgress('notafd','seca');
  }else if(status==='pending_p2'){
    secaBody.classList.add('locked');
    document.querySelectorAll('#seca-body input[type="checkbox"]').forEach(cb=>{cb.disabled=true;});
    if(secaLock){secaLock.style.display='flex';secaLock.className='df-lock-bar df-lock-warn';secaLock.textContent='🔒 Secțiunea A a fost trimisă la Responsabil CAB și nu mai poate fi modificată.';}
    if(role==='p1'&&secbBody)secbBody.classList.add('locked');
    if(role==='p1') _secbSetDisabled(true);
    _dfUpdateProgress('notafd','secb');
  }else if(status==='returnat'){
    if(secbBody)secbBody.classList.add('locked');
    _secbSetDisabled(true);
    if(secbLock){secbLock.style.display='flex';secbLock.className='df-lock-bar df-lock-warn';secbLock.textContent='↩ Secțiunea B nu a fost aprobată — verificați deficiențele și retrimiteți.';}
    _dfUpdateProgress('notafd','seca');
  }else if(status==='completed'||status==='aprobat'){
    secaBody.classList.add('locked');
    document.querySelectorAll('#seca-body input[type="checkbox"]').forEach(cb=>{cb.disabled=true;});
    if(secbBody)secbBody.classList.add('locked');
    _secbSetDisabled(true);
    if(secaLock){secaLock.style.display='flex';secaLock.className='df-lock-bar df-lock-ok';secaLock.textContent='✓ Secțiunea A aprobată.';}
    if(secbLock){secbLock.style.display='flex';secbLock.className='df-lock-bar df-lock-ok';secbLock.textContent='✓ Secțiunea B completată de Responsabilul CAB.';}
    _dfUpdateProgress('notafd','sign');
  }
  // Role tags
  const t={p1a:document.getElementById('seca-tag-p1'),p2a:document.getElementById('seca-tag-p2'),
           p1b:document.getElementById('secb-tag-p1'),p2b:document.getElementById('secb-tag-p2')};
  if(status==='pending_p2'){
    if(t.p1a){t.p1a.className='df-role-tag df-role-no';t.p1a.textContent='P1 blocat';}
    if(t.p2b){t.p2b.className='df-role-tag df-role-can';t.p2b.textContent='P2 editează';}
  }else if(status==='completed'||status==='aprobat'){
    Object.values(t).forEach(el=>{if(el)el.className='df-role-tag df-role-done';});
  }else{
    if(t.p1a){t.p1a.className='df-role-tag df-role-can';t.p1a.textContent='P1 editează';}
    if(t.p2a){t.p2a.className='df-role-tag df-role-no';t.p2a.textContent='P2 blocat';}
    if(t.p1b){t.p1b.className='df-role-tag df-role-no';t.p1b.textContent='P1 blocat';}
    if(t.p2b){t.p2b.className='df-role-tag df-role-can';t.p2b.textContent='P2 editează';}
  }
  if(status==='pending_p2'&&role==='p2'){
    prefillSectBFromSectA();
    // Soft-warning depășire credite bugetare — doar când Sec.B e editabilă de CAB.
    _loadBugetDisponibil(ST?.docId?.notafd);
  }else{
    _resetSecBBuget();
  }
  _dfSetAlopCtx('notafd');
}
function applyOrdRoleState(status,role){
  const p1Body=document.getElementById('ord-p1-body');
  const p2Body=document.getElementById('ord-p2-body');
  const p1Lock=document.getElementById('ord-p1-lock');
  const p2Lock=document.getElementById('ord-p2-lock');
  if(!p1Body)return;
  p1Body.classList.remove('locked');
  if(p2Body)p2Body.classList.remove('locked');
  if(p1Lock)p1Lock.style.display='none';
  if(p2Lock)p2Lock.style.display='none';
  if(!status||status==='draft'){
    if(p2Body)p2Body.classList.add('locked');
    if(p2Lock){p2Lock.style.display='flex';p2Lock.className='df-lock-bar df-lock-info';p2Lock.textContent='🔒 Responsabilul CAB completează coloanele 2-3 și captura după primirea ORD.';}
    _dfUpdateProgress('ordnt','p1');
  }else if(status==='pending_p2'){
    if(role==='p1'){
      if(p1Lock){p1Lock.style.display='flex';p1Lock.className='df-lock-bar df-lock-warn';p1Lock.textContent='🔒 Document trimis la Responsabil CAB. Așteptați completarea.';}
    }
    _dfUpdateProgress('ordnt','p2');
  }else if(status==='completed'){
    lockAll('ordnt',true);
    if(p2Body)p2Body.classList.add('locked');
    if(p1Lock){p1Lock.style.display='flex';p1Lock.className='df-lock-bar df-lock-ok';p1Lock.textContent='✓ Date CAB completate — lansați fluxul de semnare.';}
    if(p2Lock){p2Lock.style.display='flex';p2Lock.className='df-lock-bar df-lock-ok';p2Lock.textContent='✓ Date CAB completate.';}
    _dfUpdateProgress('ordnt','sign');
  }else if(status==='aprobat'){
    if(p2Body)p2Body.classList.add('locked');
    if(p1Lock){p1Lock.style.display='flex';p1Lock.className='df-lock-bar df-lock-ok';p1Lock.textContent='✓ Document aprobat.';}
    if(p2Lock){p2Lock.style.display='flex';p2Lock.className='df-lock-bar df-lock-ok';p2Lock.textContent='✓ Date CAB completate.';}
    _dfUpdateProgress('ordnt','sign');
  }
  _dfSetAlopCtx('ordnt');
}

// ── Badge revizie în header / lateral tab ───────────────────────────────────
function updateRevizieHeaderBadge(ft, doc){
  if(ft!=='notafd'){
    // v3.9.497 (Finding #1 audit Pas 3): defensive — dacă suntem invocați pe ft non-notafd,
    // ascundem bara (revizia e proprietate doar a DF).
    const _h=document.getElementById('df-revizie-header-bar');
    if(_h)_h.style.display='none';
    return;
  }
  const nr=doc.revizie_nr??0;
  const isAnUrm=!!doc.este_revizie_an_urmator;
  const hdr=document.getElementById('df-revizie-header-bar');
  const badge=document.getElementById('df-revizie-header-badge');
  const nrEl=document.getElementById('df-revizie-header-nr');
  if(hdr)hdr.style.display='flex';
  if(badge){
    badge.textContent=`R${nr}`;
    badge.className=`df-revizie-badge${nr>0?' revizie-activa':''}`;
  }
  if(nrEl){
    const baseTxt=nr>0?`Revizia ${nr}`:`Revizia 0 (inițială)`;
    nrEl.textContent=isAnUrm?`${baseTxt} · pentru anul bugetar următor`:baseTxt;
  }
}

// ── Render actions bar ────────────────────────────────────────────────────────
function renderActions(ft){
  const div=document.getElementById('actions-'+ft);if(!div)return;
  const status=ST.docStatus[ft],role=ST.docRole[ft],docId=ST.docId[ft];
  const caps=ST.docCapabilities?.[ft]||{};
  const B=(cls,txt,fn)=>`<button class="df-action-btn ${cls}" onclick="${fn}">${txt}</button>`;
  // Banner "an următor" — vizibil doar pentru notafd revizie an următor (prezentare, neschimbat)
  const bannerAnUrm=document.getElementById('banner-an-urmator-notafd');
  if(bannerAnUrm) bannerAnUrm.style.display=(ft==='notafd'&&ST.docRevizieAnUrmator?.[ft])?'':'none';

  // Etichete = prezentare (gated de caps): "Retrimite" doar la returnat&p1; "Câmpuri" doar la draft&p1.
  const lblSend =(status==='returnat'&&role==='p1')?'📨 Retrimite la Responsabil CAB':'📨 Trimite la Responsabil CAB';
  const lblReset=(status==='draft'&&role==='p1')?'↺ Câmpuri':'↺ Resetează';

  // Formular nesalvat (fără docId) → set fix de acțiuni (identic cu vechiul branch !docId)
  if(!docId){
    div.innerHTML=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează',`resetF('${ft}')`);
    return;
  }

  const revNr=ST.docRevizieNr?.[ft]||0;
  const latest=ST.docLatestRevizieNr?.[ft]||0;

  // Stări terminale/informaționale — text identic cu originalul, butoane gated de caps:
  if(caps.is_neaprobat){
    if(caps.is_historic_revision){
      div.innerHTML=`<span style="color:#f87171;font-size:.82rem;margin-right:8px">❌ DF neaprobat de semnatar (R${revNr}).</span>`
        +`<span style="color:var(--df-text-3);font-size:.82rem">🕒 Revizie istorică — revizia curentă este R${latest}.</span>`;
    }else{
      div.innerHTML=`<span style="color:#f87171;font-size:.82rem;margin-right:8px">❌ DF neaprobat de semnatar — fluxul a fost refuzat (R${revNr}).</span>`
        +(caps.can_revise?B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`):'');
    }
    return;
  }
  if(caps.is_de_revizuit){
    div.innerHTML=`<span style="color:#fbbf24;font-size:.82rem;margin-right:8px">🔄 Documentul a fost trimis înapoi din flux pentru revizuire.</span>`
      +B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează câmpuri',`resetF('${ft}')`);
    return;
  }
  if(caps.aprobat){
    const fid=ST.docFlowId?.[ft];
    const revBadge=ft==='notafd'&&revNr>0?`<span class="df-revizie-badge" style="margin-right:4px">Revizia ${revNr}</span>`:'';
    const istoricMsg=caps.is_historic_revision?`<span style="color:var(--df-text-3);font-size:.82rem;margin-left:8px">🕒 Revizie istorică — revizia curentă este R${latest}.</span>`:'';
    div.innerHTML=revBadge
      +(caps.can_download_signed?B('teal','📄 Descarcă PDF semnat',`viewFlowPdf('${fid}')`):'')
      +(caps.can_revise?B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`):'')
      +istoricMsg;
    return;
  }
  if(caps.is_waiting_p2){
    div.innerHTML=`<span style="color:var(--df-text-3);font-size:.82rem">⏳ Așteptare Responsabil CAB...</span>`;
    return;
  }
  if(caps.is_completed_p2){
    div.innerHTML=`<span style="color:var(--df-text-3);font-size:.82rem">✅ Secțiunea ta este completată.</span>`;
    return;
  }
  if(caps.is_on_flow){
    div.innerHTML=`<span style="color:var(--df-text-3);font-size:.82rem">🔄 Document pe fluxul de semnare...</span>`
      +(caps.can_download_flux?B('','📄 Descarcă PDF',`viewFlowPdf('${ST.docFlowId?.[ft]}')`):'');
    return;
  }
  if(caps.can_generate_or_launch){
    const hasPdf=!!(ST[ft]?.pdf);
    div.innerHTML=(hasPdf?B('primary','🔏 Lansează flux semnare',`mkFlow('${ft}')`)
      :`<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`);
    return;
  }

  // Acțiuni „active" (draft/p1, returnat/p1, pending_p2/p2, fallback) — asamblate din caps:
  let html='';
  if(caps.can_send_p2)     html+=B('teal',lblSend,`showP2Modal('${ft}')`);
  if(caps.can_save)        html+=B('','💾 Salvează',`saveDoc('${ft}')`);
  if(caps.can_complete_p2) html+=B('primary','✅ Finalizez secțiunea',`completeAsP2('${ft}')`);
  if(caps.can_return)      html+=B('danger','↩ Returnează ca neconform',`showReturnModal('${ft}')`);
  if(caps.can_reset)       html+=B('',lblReset,`resetF('${ft}')`);
  div.innerHTML=html;
}

// ── Locked bar ───────────────────────────────────────────────────────────────
function setLockedBar(ft,msg,type=''){
  const el=document.getElementById('locked-bar-'+ft);
  if(!el)return;
  if(!msg){el.className='locked-bar';el.textContent='';return;}
  el.className='locked-bar show '+(type||'info');
  el.textContent=msg;
}

// ── Open document ─────────────────────────────────────────────────────────────
async function openDoc(ft,id){
  try{
    const r=await fetch(`${ftApi(ft)}/${id}`,{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.ok){setS(j.error||'Eroare la încărcare','err');return;}
    const doc=j.document;
    ST.docId[ft]=doc.id;
    ST.docStatus[ft]=doc.status;
    const userId=ST.user?.userId;
    ST.docRole[ft]=doc.created_by===userId?'p1':doc.assigned_to===userId?'p2':'view';
    ST.docAprobat=ST.docAprobat||{};
    ST.docAprobat[ft]=doc.aprobat===true||doc.status==='aprobat';
    ST.docFlowId=ST.docFlowId||{};
    ST.docFlowId[ft]=doc.flow_id||null;
    ST.docRevizieNr=ST.docRevizieNr||{};
    ST.docRevizieNr[ft]=doc.revizie_nr||0;
    ST.docRevizieAnUrmator=ST.docRevizieAnUrmator||{};
    ST.docRevizieAnUrmator[ft]=doc.este_revizie_an_urmator||false;
    ST.docAreRevizieNoua=ST.docAreRevizieNoua||{};
    ST.docAreRevizieNoua[ft]=doc.has_newer_revision===true;
    ST.docLatestRevizieNr=ST.docLatestRevizieNr||{};
    ST.docLatestRevizieNr[ft]=doc.latest_revizie_nr||0;
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=doc.capabilities||null;

    // Populare câmpuri
    if(ft==='ordnt')populateOrd(doc);else populateDf(doc);
    updateRevizieHeaderBadge(ft, doc);

    // Prefill plati_anterioare ciclu 2+ — suma din cicluri finalizate anterior
    if(ft==='ordnt'){
      const _ctx=window._alopContext;
      const _alopId=doc.alop_id||_ctx?.alopId||new URLSearchParams(location.search).get('alop_id');
      if(_alopId){
        const _ra=await fetch(`/api/alop/${encodeURIComponent(_alopId)}`,{credentials:'include'}).then(r=>r.json()).catch(()=>null);
        const _totalAnt=(_ra?.alop?.cicluri_istorice||[]).reduce((s,c)=>s+parseFloat(c.plata_suma_efectiva||0),0);
        if(_totalAnt>0){
          const _firstRow=document.querySelector('#o-tbody input[data-f="plati_anterioare"]');
          if(_firstRow&&(parseFloat(_firstRow.value)||0)===0){_firstRow.value=_totalAnt;calcORRow(_firstRow);}
        }
      }
    }

    _dfSetAlopCtx(ft);

    // FIX 3: Precompletare automată pct.4 pentru revizie "an următor" (revizie_nr===1, pct.4 necompletat)
    if(ft==='notafd'&&doc.este_revizie_an_urmator&&doc.revizie_nr===1&&doc.ckbx_ramane_suma!=='1'){
      const ckRam=document.getElementById('n-ck-ramane');
      const inpRam=document.getElementById('n-ramana');
      if(ckRam&&inpRam){
        ckRam.checked=true;
        inpRam.value=doc.total_val_prec!=null?String(doc.total_val_prec):'0';
        p4toggle('ramane');
      }
    }

    // Captură
    try{
      const capR=await fetch(`/api/formulare-capturi/${ftType(ft)}/${id}`,{credentials:'include'});
      if(capR.ok&&capR.headers.get('content-type')?.startsWith('image')){
        const blob=await capR.blob();
        const reader=new FileReader();
        reader.onload=e=>{
          const iid=ft==='ordnt'?'o-cimg':'n-cimg',phid=ft==='ordnt'?'o-cph':'n-cph';
          showImg(iid,phid,e.target.result);
        };
        reader.readAsDataURL(blob);
      }
    }catch(_){}

    // v3.9.501: încarcă lista de atașamente server-side pentru ambele sloturi
    await fetchAttachments(ft, 1);
    if(ft==='notafd') await fetchAttachments(ft, 2);

    // Ascunde motiv bar implicit; se afișează doar pentru 'returnat'
    const _mb=document.getElementById('motiv-bar-'+ft);
    if(_mb)_mb.style.display='none';

    // Lock / mode
    lockAll(ft,false);
    const status=doc.status,role=ST.docRole[ft];
    if(ST.docAprobat[ft]){
      lockAll(ft,true);
      lockCaptureAndAttachments(ft,true);
      // p2-field eliminat (uniformizare vizuală) — nu mai e nimic de curățat
      setLockedBar(ft,'✔ Document aprobat — fluxul de semnare a fost finalizat.','info');
      renderActions(ft);
      if(ft==='notafd')applyDfRoleState('aprobat',ST.docRole[ft]);
      else if(ft==='ordnt')applyOrdRoleState('aprobat',ST.docRole[ft]);
      refreshDocs(ft);
      document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c=>c.classList.toggle('active',c.dataset.id===id));
      setS('Document aprobat','ok');
      return;
    }else if(status==='pending_p2'&&role==='p2'){
      if(ft==='ordnt')setModeP2Ord();else setModeP2Df();
      setLockedBar(ft,'Completați câmpurile dvs. (marcate) și apăsați Finalizez.','info');
    }else if(status==='pending_p2'&&role==='p1'){
      lockAll(ft,true);
      if(ft==='ordnt')document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;});
      setLockedBar(ft,'Document trimis la Responsabil CAB. Așteptați completarea.','warn');
    }else if(status==='returnat'&&role==='p1'){
      lockAll(ft,false);
      setLockedBar(ft,'↩ Document returnat de Responsabil CAB — verificați deficiențele și retrimiteți.','warn');
      const mb=document.getElementById('motiv-bar-'+ft);
      if(mb&&doc.motiv_returnare){
        document.getElementById('motiv-text-'+ft).textContent=doc.motiv_returnare;
        mb.style.display='';
      }
    }else if(status==='completed'){
      lockAll(ft,true);
      lockCaptureAndAttachments(ft,true);
      // p2-field eliminat (uniformizare vizuală) — nu mai e nimic de curățat
      const _revNr=doc.revizie_nr>0?` · Revizia ${doc.revizie_nr}`:'';
      const _completedMsg=ft==='ordnt'&&role==='p1'?' — lansați fluxul de semnare':ft==='notafd'&&role==='p1'?' — puteți genera PDF și lansa fluxul de semnare':'.';
      setLockedBar(ft,`Document complet${_revNr}${_completedMsg}`,'info');
    }else{
      setLockedBar(ft,'');
    }

    renderActions(ft);
    if(ft==='notafd')applyDfRoleState(status,role);
    else if(ft==='ordnt')applyOrdRoleState(status,role);
    refreshDocs(ft);
    // Evidențiere card activ
    document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c=>c.classList.toggle('active',c.dataset.id===id));
    setS(`Document încărcat (${status})`,status==='completed'?'ok':'info');
    _updateBackBtn(ft);
  }catch(e){setS('Eroare rețea: '+e.message,'err');}
}

// ── Lista documente ───────────────────────────────────────────────────────────
async function refreshDocs(ft){
  const list=document.getElementById('docs-list-'+ft);
  if(list)list.innerHTML='<div class="docs-empty">Se încarcă...</div>';
  try{
    const r=await fetch(ftApi(ft),{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.ok){if(list)list.innerHTML='<div class="docs-empty">Eroare la încărcare.</div>';return;}
    renderDocsList(ft,j.documents||[]);
  }catch(e){if(list)list.innerHTML='<div class="docs-empty">Eroare rețea.</div>';}
}
function renderDocsList(ft,docs){
  const list=document.getElementById('docs-list-'+ft);if(!list)return;
  if(!docs.length){list.innerHTML='<div class="docs-empty">Nu există documente salvate.</div>';return;}
  const esc=s=>(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  list.innerHTML=docs.map(d=>{
    const[cls,lbl]=stLabel(d.status,d.aprobat);
    const revBadge=ft==='notafd'&&d.revizie_nr>0?`<span class="df-revizie-badge">Rev. ${d.revizie_nr}</span>`:'';
    const title=ft==='ordnt'
      ?(d.nr_ordonant_pl?`ORD ${esc(d.nr_ordonant_pl)}`:'ORD fără număr')
      :(d.nr_unic_inreg?`DF ${esc(d.nr_unic_inreg)}`:'DF fără număr');
    const updated=new Date(d.updated_at).toLocaleString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const created=new Date(d.created_at).toLocaleString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const p2info=d.assigned_to_nume?` · Resp. CAB: ${esc(d.assigned_to_nume)}`:'';
    const creator=d.created_by_nume||d.created_by_email||'';
    const creatorInfo=creator?`Creat de: <b>${esc(creator)}</b> · `:'';
    const pdfBtn=d.flow_id
      ?`<button class="df-action-btn sm" style="margin-left:4px" onclick="event.stopPropagation();viewFlowPdf('${d.flow_id}')" title="PDF semnat din flux">📄 PDF flux</button>`
      :'';
    return`<div class="doc-card" data-id="${d.id}" onclick="openDoc('${ft}','${d.id}')">
      <div class="doc-card-main">
        <div class="doc-card-title">${title}${revBadge}</div>
        <div class="doc-card-sub">${creatorInfo}Creat: ${created} · Actualizat: ${updated}${p2info}</div>
      </div>
      <span class="dst ${cls}">${lbl}</span>${pdfBtn}
    </div>`;
  }).join('');
}

async function viewFlowPdf(flowId){
  try{
    const r=await fetch(`/flows/${encodeURIComponent(flowId)}/signed-pdf`,{credentials:'include'});
    if(!r.ok){
      try{
        const r2=await fetch(`/flows/${encodeURIComponent(flowId)}/pdf`,{credentials:'include'});
        if(r2.ok){
          const blob2=await r2.blob();
          const url2=URL.createObjectURL(blob2);
          window.open(url2,'_blank');
          return;
        }
      }catch(_){}
      setS('PDF-ul fluxului nu este disponibil încă.','err');
      return;
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    window.open(url,'_blank');
  }catch(e){setS('Eroare: '+e.message,'err');}
}

// ── Nou document ──────────────────────────────────────────────────────────────
function newDoc(ft){
  ST.docAprobat=ST.docAprobat||{};ST.docAprobat[ft]=false;
  ST.docRevizieNr=ST.docRevizieNr||{};ST.docRevizieNr[ft]=0;
  ST.docRevizieAnUrmator=ST.docRevizieAnUrmator||{};ST.docRevizieAnUrmator[ft]=false;
  ST.docId[ft]=null;ST.docStatus[ft]=null;ST.docRole[ft]='p1';
  ST.docCapabilities=ST.docCapabilities||{};ST.docCapabilities[ft]=null;
  lockAll(ft,false);setLockedBar(ft,'');
  if(ft==='notafd'){applyDfRoleState(null,'p1');updateRevizieHeaderBadge('notafd',{revizie_nr:0,este_revizie_an_urmator:false});}
  else if(ft==='ordnt')applyOrdRoleState(null,'p1');
  // Golim câmpurile
  document.querySelectorAll(`#form-${ft} input:not([type=file]):not([type=hidden]),#form-${ft} textarea`).forEach(e=>{if(e.type==='checkbox')e.checked=false;else if(e.type==='number')e.value='0';else e.value='';});
  if(ft==='ordnt'){
    document.getElementById('o-tbody').innerHTML='';addOR();clrImg('o-cimg','o-cph');clrImg('o-cimg2','o-cph2');
    document.getElementById('o-alist').innerHTML='';document.getElementById('o-adata').value='[]';
    const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value='';
    const dfId=document.getElementById('o-df-id');if(dfId)dfId.value='';
    _resetOrdBuget(); // fără DF selectat → fără context de plafon (se încarcă la DF-select)
    // v3.9.500 (Issue I-1): prefill plati_anterioare la creare ord nou pe ciclu 2+
    // Înainte: prefill rula doar în loadDoc (existing ord) → P1 vedea 0,00, P2 vedea valoarea
    const _ctx=window._alopContext;
    const _alopId=_ctx?.alopId||new URLSearchParams(location.search).get('alop_id');
    if(_alopId){
      fetch(`/api/alop/${encodeURIComponent(_alopId)}`,{credentials:'include'})
        .then(r=>r.ok?r.json():null).catch(()=>null)
        .then(_ra=>{
          if(!_ra?.alop)return;
          const _totalAnt=(_ra.alop.cicluri_istorice||[])
            .reduce((s,c)=>s+parseFloat(c.plata_suma_efectiva||0),0);
          if(_totalAnt>0){
            const _firstRow=document.querySelector('#o-tbody input[data-f="plati_anterioare"]');
            if(_firstRow&&(parseFloat(_firstRow.value)||0)===0){
              _firstRow.value=fMR(_totalAnt);
              calcORRow(_firstRow);
            }
          }
        });
    }
  }else{['n-vtbody','n-ptbody','n-ctbody'].forEach(tid=>{document.getElementById(tid).innerHTML='';});addNV();addNC();clrImg('n-cimg','n-cph');['n-fdal','n-alist'].forEach(id=>document.getElementById(id).innerHTML='');['n-fdad','n-adata'].forEach(id=>document.getElementById(id).value='[]');
    // FEATURE buget multi-anual (v3.9.558): DF nou → an de referință = anul curent (editabil).
    { const _ar=document.getElementById('n-anref'); if(_ar){ _ar.value=new Date().getFullYear(); _ar.readOnly=false; } }
    if(typeof anrefSync==='function')anrefSync();
  }
  document.getElementById('result-'+ft).classList.remove('show');
  ST[ft]={pdf:null,name:null};upTot();clrS();renderActions(ft);
  document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c=>c.classList.remove('active'));
  _updateBackBtn(ft);
}

// _alopLinkDoc → mutat în alop.js (BLOC 2.2)
// ── Salvare în DB ─────────────────────────────────────────────────────────────
const _DUP_FIELDS = { nr_ord_duplicat: 'o-nr', nr_unic_duplicat: 'n-nrUnic' };
function _handleDup409(j) {
  const fid = _DUP_FIELDS[j.error];
  if (!fid) return false;
  setS(j.message || 'Număr duplicat!', 'err');
  const el = document.getElementById(fid);
  if (el) {
    el.style.borderColor = '#dc3545';
    el.focus();
    function _clear() { el.style.borderColor = ''; el.removeEventListener('input', _clear); }
    el.addEventListener('input', _clear);
  }
  return true;
}
async function saveDoc(ft){
  if(ST.docAprobat?.[ft])return;
  const docId=ST.docId[ft];
  const body=ft==='ordnt'?collectOrdDb()
    :(ST.docRole[ft]==='p2'?collectDfP2Db():collectDfP1Db());
  const hdrs={'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()};
  try{
    setS('Se salvează...','info');
    let r,j;
    if(!docId){
      r=await fetch(ftApi(ft),{method:'POST',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.status===409&&_handleDup409(j))return;
      if(r.ok&&j.ok){
        ST.docId[ft]=j.document.id;ST.docStatus[ft]='draft';ST.docRole[ft]='p1';
        _alopLinkDoc(ft,j.document.id);
      }
    }else{
      r=await fetch(`${ftApi(ft)}/${docId}`,{method:'PUT',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.status===409&&_handleDup409(j))return;
      if(r.ok&&j.ok){
        ST.docStatus[ft]=j.document.status;
        // v3.9.518: safety net — retry link la save manual chiar dacă docId există deja.
        // Acoperă cazul în care _autoSaveDb a creat ORD-ul cu link ratat, iar user-ul
        // dă click pe "Salvează" manual ulterior. Idempotent prin SQL guard.
        _alopLinkDoc(ft,docId);
      }
    }
    if(!r.ok||!j.ok){setS(j.error||'Eroare la salvare','err');return;}

    // v3.9.499: upload ambele sloturi (slot 1 pentru DF/ORD, slot 2 doar ORD)
    if(ST.docId[ft]){
      if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft, 1);
      if(ft==='ordnt' && imgs['o-cimg2']) await uploadCaptura(ft, 2);
    }
    // v3.9.501: upload atașamente pending pentru ambele sloturi (ORD slot 1, DF slot 1+2)
    // v3.9.554 (B2): colectează eșecurile — nu mai raportăm „Salvat cu succes" peste ele
    let _attFailed=[];
    if(ST.docId[ft]){
      _attFailed=_attFailed.concat(await uploadAttachments(ft, 1)||[]);
      if(ft==='notafd') _attFailed=_attFailed.concat(await uploadAttachments(ft, 2)||[]);
    }

    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    renderActions(ft);refreshDocs(ft);
    if(_attFailed.length){
      setS(`Document salvat, dar ${_attFailed.length} atașament(e) nu au putut fi încărcate: ${df.esc(_attFailed.map(f=>`${f.name} (${f.reason})`).join(', '))}. Se reîncearcă la următoarea salvare.`,'err');
    }else{
      setS('Salvat cu succes.','ok');
    }
  }catch(e){setS('Eroare rețea: '+e.message,'err');}
}

// ── Upload captură ────────────────────────────────────────────────────────────
// v3.9.499: uploadCaptura acceptă slot. Slot 1 = captura principală (DF + ORD),
// slot 2 = captura 2 ORD ("Informații complete contract"). Datele se persistă în
// formulare_capturi via endpoint dedicat (BYTEA), eliminând asimetria veche unde
// captura 2 era inline base64 în coloana formulare_ord.img2.
async function uploadCaptura(ft, slot){
  const _slot=slot===2?2:1;
  // Slot 2 e doar pentru ord. Slot 1 e default pentru ambele.
  if(_slot===2&&ft!=='ordnt')return;
  const iid=_slot===2?'o-cimg2':(ft==='ordnt'?'o-cimg':'n-cimg');
  const dataUrl=imgs[iid];if(!dataUrl||!ST.docId[ft])return;
  try{
    const[header,b64]=dataUrl.split(',');
    const mime=header.match(/:(.*?);/)?.[1]||'image/png';
    const bin=atob(b64);const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const blob=new Blob([arr],{type:mime});
    await fetch(`/api/formulare-capturi/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':mime,'X-CSRF-Token':df.getCsrf(),'X-Filename':`captura_${ft}_${_slot}.png`},
      body:blob,
    });
  }catch(_){}
}

// ── Atașamente (Compartiment specialitate + secțiunea B) ──────────────────────
// v3.9.501: extins cu slot pentru DF (n-fdad slot=1, n-adata slot=2)
function _attIds(ft, slot) {
  const s = slot === 2 ? 2 : 1;
  if (ft === 'ordnt') return s === 1 ? { did:'o-adata', lid:'o-alist' } : null;
  if (ft === 'notafd') return s === 1 ? { did:'n-fdad',  lid:'n-fdal' }
                                       : { did:'n-adata', lid:'n-alist' };
  return null;
}

// v3.9.554 (B2): returnează lista eșecurilor [{name, reason}] — apelanții (saveDoc,
// _autoSaveDb) o folosesc ca să NU raporteze „Salvat cu succes" peste upload-uri picate.
async function uploadAttachments(ft, slot = 1){
  const ids = _attIds(ft, slot); if (!ids) return [];
  if (!ST.docId[ft]) return [];
  const { did, lid } = ids;
  const _slot = slot === 2 ? 2 : 1;
  let cur; try { cur = JSON.parse(document.getElementById(did)?.value || '[]'); } catch (_) { return []; }
  if (!Array.isArray(cur)) return [];
  let changed = false;
  const failed = [];
  for (let i = 0; i < cur.length; i++) {
    const item = cur[i];
    if (item?.id || !item?.data) continue;
    try {
      const [header, b64] = String(item.data).split(',');
      if (!b64) continue;
      const mime = header.match(/:(.*?);/)?.[1] || item.type || 'application/octet-stream';
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
      const blob = new Blob([arr], { type: mime });
      const r = await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`, {
        method: 'POST', credentials: 'include',
        headers: {
          'Content-Type': mime,
          'X-CSRF-Token': df.getCsrf(),
          'X-Filename': item.name || 'atasament',
        },
        body: blob,
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.atasament) {
        cur[i] = { id: j.atasament.id, filename: j.atasament.filename, mime_type: j.atasament.mime_type, size_bytes: j.atasament.size_bytes };
        changed = true;
      } else {
        const reason = j?.error || ('HTTP ' + r.status);
        cur[i]._err = reason;   // marcaj vizual pe chip (att-chip-err); item.data rămâne → retry la următorul save
        failed.push({ name: item.name || 'fișier', reason });
        changed = true;
        console.warn('[v3.9.554] uploadAttachments HTTP fail', item?.name, reason);
      }
    } catch (e) {
      if (cur[i]) cur[i]._err = 'rețea';
      failed.push({ name: item?.name || 'fișier', reason: 'eroare de rețea' });
      changed = true;
      console.warn('[v3.9.501] uploadAttachments error', item?.name, e);
    }
  }
  if (changed) {
    document.getElementById(did).value = JSON.stringify(cur);
    renderAttachments(ft, _slot);
  }
  return failed;
}

async function fetchAttachments(ft, slot = 1){
  const ids = _attIds(ft, slot); if (!ids) return;
  if (!ST.docId[ft]) return;
  const { did } = ids;
  const _slot = slot === 2 ? 2 : 1;
  try {
    const r = await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}?slot=${_slot}`, { credentials: 'include' });
    if (!r.ok) {
      // v3.9.554 (B2): la 403/500 lista nu mai dispare tăcut — indicator discret de eroare
      const jErr = await r.json().catch(() => null);
      console.warn('[v3.9.554] fetchAttachments HTTP', r.status, jErr?.error);
      const listEl = document.getElementById(ids.lid);
      if (listEl) listEl.innerHTML = `<span class="att-chip att-chip-err" title="${df.esc(jErr?.error || ('HTTP ' + r.status))}">⚠ atașamentele nu au putut fi încărcate</span>`;
      return;
    }
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.atasamente)) return;
    const list = j.atasamente.map(a => ({
      id: a.id, filename: a.filename, mime_type: a.mime_type, size_bytes: a.size_bytes
    }));
    document.getElementById(did).value = JSON.stringify(list);
    renderAttachments(ft, _slot);
  } catch (e) { console.warn('[v3.9.501] fetchAttachments error', e); }
}

function renderAttachments(ft, slot = 1){
  const ids = _attIds(ft, slot); if (!ids) return;
  const { did, lid } = ids;
  const list = document.getElementById(lid); if (!list) return;
  list.innerHTML = '';
  let cur; try { cur = JSON.parse(document.getElementById(did)?.value || '[]'); } catch (_) { return; }
  if (!Array.isArray(cur)) return;
  const docId = ST.docId[ft];
  cur.forEach((item, idx) => {
    const chip = document.createElement('span');
    chip.className = 'att-chip' + (item._err ? ' att-chip-err' : '');
    if (item._err) chip.title = 'Upload eșuat: ' + item._err + ' — se reîncearcă la următoarea salvare';
    const name = item.filename || item.name || 'fișier';
    const safe = String(name).replace(/[<>"]/g, '');
    if (item.id && docId) {
      const url = `/api/formulare-atasamente/${ftType(ft)}/${docId}/${encodeURIComponent(item.id)}`;
      chip.innerHTML = `📎 <a href="${url}" target="_blank" style="color:inherit">${safe}</a> <button onclick="remAttServer(${idx},'${lid}','${did}','${item.id}',this)">✕</button>`;
    } else {
      chip.innerHTML = `📎 ${safe} <button onclick="remAtt(${idx},'${lid}','${did}',this)">✕</button>`;
    }
    list.appendChild(chip);
  });
}

async function remAttServer(idx,lid,did,attId,btn){
  const ft=lid.startsWith('o-')?'ordnt':'notafd';
  if(!ST.docId[ft]){
    if(typeof window.remAtt==='function')return window.remAtt(idx,lid,did,btn);
    return;
  }
  try{
    const r=await fetch(`/api/formulare-atasamente/${ftType(ft)}/${ST.docId[ft]}/${encodeURIComponent(attId)}`,{
      method:'DELETE',credentials:'include',
      headers:{'X-CSRF-Token':df.getCsrf()},
    });
    if(!r.ok){
      const j=await r.json().catch(()=>null);
      alert(j?.error==='document_locked'?'Document complet — atașamentul nu poate fi șters.':'Eroare la ștergere.');
      return;
    }
    let cur;try{cur=JSON.parse(document.getElementById(did).value||'[]');}catch(_){cur=[];}
    cur.splice(idx,1);
    document.getElementById(did).value=JSON.stringify(cur);
    renderAttachments(ft);
  }catch(e){alert('Eroare rețea: '+e.message);}
}

// ── Validare câmpuri obligatorii înainte de P2 ───────────────────────────────
function _vf(id){return(document.getElementById(id)?.value||'').trim();}
function _vcb(id){return!!document.getElementById(id)?.checked;}

function _markInvalidEl(el){
  if(!el)return;
  el.classList.add('err');
  const fix=()=>{el.classList.remove('err');el.removeEventListener('input',fix);el.removeEventListener('change',fix);};
  el.addEventListener('input',fix);
  el.addEventListener('change',fix);
}
function _markInvalid(ids){ids.forEach(id=>_markInvalidEl(document.getElementById(id)));}

function _showValErr(msg){
  const bar=document.getElementById('val-err-bar');
  const msgEl=document.getElementById('val-err-msg');
  if(bar)bar.style.display='';
  if(msgEl)msgEl.textContent=msg;
}
function _clearValErr(){
  const bar=document.getElementById('val-err-bar');
  if(bar)bar.style.display='none';
}

function _validateDf(){
  const errs=[];
  const req=(id,label)=>{if(!_vf(id)){errs.push({id,label});return false;}return true;};

  req('n-subtitlu','Subtitlu');
  req('n-nrUnic','Număr unic de înregistrare');
  req('n-rev','Revizuirea (completați 0 dacă este prima versiune)');
  req('n-data','Data');
  req('n-den','Instituția publică');
  req('n-cif','CIF instituție');
  req('n-comp','Compartiment (Pct. 1)');
  req('n-scurt','Descriere scurtă (Pct. 2)');
  req('n-lung','Descriere largă (Pct. 3)');

  // Pct. 4 — obligatoriu una din cele două bife
  const ckStab=_vcb('n-ck-stab'), ckRam=_vcb('n-ck-ramane');
  if(!ckStab&&!ckRam){
    errs.push({id:'n-ck-stab',label:'Pct. 4: bifați una din opțiunile de valoare angajament legal'});
  } else if(ckStab){
    // Tabelul trebuie să aibă cel puțin un rând, cu toate celulele text completate
    const rows=[...document.querySelectorAll('#n-vtbody tr')];
    if(!rows.length){
      errs.push({id:null,label:'Pct. 4: adăugați cel puțin un rând în tabel'});
    } else {
      let tblErr=false;
      rows.forEach((tr,i)=>{
        ['element_fd','program','codSSI','param_fd'].forEach(f=>{
          const inp=tr.querySelector(`[data-f="${f}"]`);
          if(inp&&!inp.value.trim()){
            _markInvalidEl(inp);
            if(!tblErr){errs.push({id:null,label:`Pct. 4: completați toate celulele din tabel (rândul ${i+1})`});tblErr=true;}
          }
        });
      });
    }
  } else if(ckRam){
    const suma=pMR(document.getElementById('n-ramana')?.value)||0;
    if(suma<=0) errs.push({id:'n-ramana',label:'Pct. 4: completați suma (valoare > 0)'});
  }

  // Pct. 5 — obligatoriu una din cele două bife
  const ckCu=_vcb('n-ck-cuang'), ckFara=_vcb('n-ck-faraang');
  if(!ckCu&&!ckFara){
    errs.push({id:'n-ck-cuang',label:'Pct. 5: bifați una din opțiunile de angajamente'});
  } else if(ckCu){
    const ckSting=_vcb('n-ck-sting'), ckFaraPlati=_vcb('n-ck-faraplati'), ckCuPlati=_vcb('n-ck-cuplati');
    if(!ckSting&&!ckFaraPlati&&!ckCuPlati){
      errs.push({id:'n-ck-sting',label:'Pct. 5: bifați una din sub-opțiunile angajamentelor curente'});
    } else if(ckCuPlati){
      const rows=[...document.querySelectorAll('#n-ptbody tr')];
      // Inputurile tabelului de plăți sunt type=text cu data-money="true" și format monetar
      // românesc (virgulă decimală). Folosim pMR pentru parsing — parseFloat pe "4.900,00"
      // returnează 4.9 (incorect — separatorul de mii e luat ca punct zecimal).
      const hasVal=rows.some(tr=>[...tr.querySelectorAll('input[data-money="true"]')].some(i=>(pMR(i.value)||0)>0));
      if(!hasVal) errs.push({id:null,label:'Pct. 5: completați cel puțin un rând în tabelul de plăți'});
    }
  }

  return errs;
}

function _validateOrd(){
  const errs=[];
  const req=(id,label)=>{if(!_vf(id)){errs.push({id,label});return false;}return true;};

  req('o-nr','Număr ORD');
  // DF selectat — validăm selectul vizibil (o-nrUnic e hidden, nu poate fi marcat)
  if(!(document.getElementById('o-df-sel')?.value||'').trim()){
    errs.push({id:'o-df-sel',label:'Selectați un Document de Fundamentare aprobat din lista de mai sus'});
  }
  req('o-den','Instituția publică (auto-fill din DF)');
  req('o-cif','CIF instituție (auto-fill din DF)');

  // Coloana 4 (suma_ordonantata_plata) — cel puțin un rând > 0
  const hasSuma=[...document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]')].some(i=>pMR(i.value)>0);
  if(!hasSuma) errs.push({id:null,label:'Coloana 4 (Suma ordonanțată la plată): cel puțin un rând completat cu valoare > 0'});

  req('o-benef','Beneficiar');
  req('o-docsj','Documente justificative');
  req('o-cifb','CIF beneficiar');
  req('o-iban','IBAN beneficiar');
  req('o-banca','Bancă beneficiar');
  req('o-inf1','Informații privind plata');

  return errs;
}

function _scrollToFirstErr(errs){
  for(const e of errs){
    if(!e.id)continue;
    const el=document.getElementById(e.id);
    if(el){el.scrollIntoView({behavior:'smooth',block:'center'});return;}
  }
  // fallback — scroll la primul element cu clasa err
  const firstErr=document.querySelector('#section-form .err');
  if(firstErr)firstErr.scrollIntoView({behavior:'smooth',block:'center'});
}

// ── Submit la P2 ─────────────────────────────────────────────────────────────
async function showP2Modal(ft){
  // Pre-check rapid pentru ORD — câmpurile obligatorii critice
  if(ft==='ordnt'){
    const missingNr=!_vf('o-nr');
    const missingDf=!(document.getElementById('o-df-sel')?.value||'').trim();
    const missingSuma=![...document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]')].some(i=>pMR(i.value)>0);
    if(missingNr||missingDf||missingSuma){
      alert('Completați Nr. ORD, selectați DF-ul și completați col.4 (Suma ordonantată)');
      return;
    }
  }
  // VALIDARE SINCRONĂ — înainte de orice altceva
  _clearValErr();
  const valErrs = ft==='notafd' ? _validateDf() : _validateOrd();
  if(valErrs.length){
    const fieldIds = valErrs.map(e=>e.id).filter(Boolean);
    _markInvalid(fieldIds);
    _showValErr('Completați câmpurile marcate înainte de a trimite la P2.');
    _scrollToFirstErr(valErrs);
    return;
  }

  // Auto-save înainte de deschiderea modalului (nu mai e nevoie de save manual prealabil)
  if(!ST.docId[ft]){
    setS('Se salvează documentul...','info');
    await saveDoc(ft);
    if(!ST.docId[ft]) return; // eroarea a fost deja afișată de saveDoc
    clrS();
  }
  ST.pendingFt=ft;ST.selectedP2Id=null;
  document.getElementById('modal-confirm').disabled=true;
  document.getElementById('modal-search').value='';
  const listEl=document.getElementById('modal-user-list');
  listEl.innerHTML='<div style="color:var(--df-text-3);font-size:.8rem;text-align:center;padding:10px">Se încarcă...</div>';
  document.getElementById('modal-p2').classList.add('show');
  if(!ST.orgUsers.length){
    try{
      const r=await fetch('/api/formulare/utilizatori-org',{credentials:'include'});
      const j=await r.json();
      if(r.ok&&j.ok){
        ST.orgUsers=j.users||[];
        ST.actorCompartiment=j.actor_compartiment||'';
      }
    }catch(_){}
  }
  if(ST.p2FilterByComp===undefined) ST.p2FilterByComp=!!ST.actorCompartiment;
  _renderP2FilterToggle();
  filterModalUsers();
}

function _renderP2FilterToggle(){
  const searchEl=document.getElementById('modal-search');
  if(!searchEl) return;
  let toggleEl=document.getElementById('modal-p2-comp-toggle');
  if(!ST.actorCompartiment){
    if(toggleEl) toggleEl.style.display='none';
    return;
  }
  if(!toggleEl){
    toggleEl=document.createElement('label');
    toggleEl.id='modal-p2-comp-toggle';
    toggleEl.style.cssText='display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--df-text-2);margin:8px 0;cursor:pointer;user-select:none';
    toggleEl.innerHTML=`
      <input type="checkbox" id="modal-p2-comp-cb" style="cursor:pointer">
      <span>Doar din <b>${(ST.actorCompartiment||'').replace(/</g,'&lt;')}</b></span>`;
    searchEl.parentNode.insertBefore(toggleEl,searchEl.nextSibling);
    document.getElementById('modal-p2-comp-cb').addEventListener('change',(e)=>{
      ST.p2FilterByComp=e.target.checked;
      filterModalUsers();
    });
  }
  toggleEl.style.display='';
  document.getElementById('modal-p2-comp-cb').checked=!!ST.p2FilterByComp;
}
function closeModal(){document.getElementById('modal-p2').classList.remove('show');}
function filterModalUsers(){
  const q=(document.getElementById('modal-search')?.value||'').toLowerCase();
  const listEl=document.getElementById('modal-user-list');
  const actComp=(ST.actorCompartiment||'').trim();
  let filtered=ST.orgUsers.filter(u=>(u.nume||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q));
  if(ST.p2FilterByComp && actComp){
    filtered=filtered.filter(u=>(u.compartiment||'').trim()===actComp);
  }
  if(!filtered.length){
    listEl.innerHTML=`<div style="color:var(--df-text-3);font-size:.8rem;text-align:center;padding:10px">${ST.p2FilterByComp&&actComp?`Niciun utilizator în compartimentul <b>${actComp.replace(/</g,'&lt;')}</b>. Dezactivați filtrul pentru a vedea pe toți.`:'Niciun utilizator găsit.'}</div>`;
    return;
  }
  listEl.innerHTML=filtered.map(u=>{
    const uComp=(u.compartiment||'').trim();
    const otherCompBadge=actComp && uComp && uComp!==actComp
      ? ` <span style="font-size:.66rem;padding:1px 6px;border-radius:8px;background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.25);margin-left:4px">alt compartiment</span>`
      : '';
    return `<div class="modal-user${ST.selectedP2Id===u.id?' sel':''}" onclick="selectP2(${u.id})">
      <div style="flex:1">
        <div class="modal-u-name">${(u.nume||u.email||'').replace(/</g,'&lt;')}${otherCompBadge}</div>
        <div class="modal-u-sub">${(u.email||'').replace(/</g,'&lt;')}${u.compartiment?` · ${u.compartiment.replace(/</g,'&lt;')}`:''}</div>
      </div>
    </div>`;
  }).join('');
}
function selectP2(id){
  ST.selectedP2Id=id;
  document.getElementById('modal-confirm').disabled=false;
  filterModalUsers();
}
async function confirmP2(){
  if(!ST.selectedP2Id||!ST.pendingFt)return;
  const ft=ST.pendingFt;
  // Salvăm mai întâi + salvăm beneficiarul nou (dacă ORD)
  await saveDoc(ft);
  if(ft==='ordnt')await _saveBeneficiarIfNew();
  closeModal();
  try{
    setS('Se trimite la Responsabil CAB...','info');
    const r=await fetch(`${ftApi(ft)}/${ST.docId[ft]}/submit`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify({assigned_to:ST.selectedP2Id}),
    });
    const j=await r.json();
    if(!r.ok||!j.ok){
      // Garda buget la P1 (Varianta A): DOAR plafonul de buget e hard la trimitere (col.5 e
      // strict la P2 — receptii e câmpul lui P2). Mesaj clar pe 422 buget_an_curent_depasit.
      if(j.error==='buget_an_curent_depasit'){
        setS('⛔ '+(j.message||'Suma ordonanțată depășește bugetul anului de exercițiu.'),'err');
      }else{
        setS(j.error||'Eroare la trimitere','err');
      }
      return;
    }
    ST.docStatus[ft]='pending_p2';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    // Redirect automat la centralizare după trimite P2
    setTimeout(()=>showListSection(),1200);
    setS(`Trimis la ${j.assigned_to?.nume||j.assigned_to?.email||'Responsabil CAB'}.`,'ok');
  }catch(e){setS('Eroare: '+e.message,'err');}
}

// ── P2 finalizează ────────────────────────────────────────────────────────────
function validateSecB(ft){
  if(ft==='ordnt'){
    // Validare rânduri ORD — col. 5 (Recepții neplătite) trebuie ≥ 0
    // Formula: c5 = c2(recepții) - c3(plăți anterioare) - c4(suma ordonanțată)
    // c5 < 0 ⇒ ordonanțare > disponibil ⇒ blocat
    const tbody=document.getElementById('o-tbody');
    if(!tbody)return true;
    const rows=[...tbody.querySelectorAll('tr')];
    const negative=[];
    rows.forEach((tr,idx)=>{
      const c2=pMR(tr.querySelector('[data-f="receptii"]')?.value);
      const c3=pMR(tr.querySelector('[data-f="plati_anterioare"]')?.value);
      const c4=pMR(tr.querySelector('[data-f="suma_ordonantata_plata"]')?.value);
      const c5=c2-c3-c4;
      if(c5<-0.001){ // toleranță floating point
        negative.push({idx:idx+1,c5,cell:tr.querySelector('[data-f="receptii_neplatite"]')});
      }
    });
    if(negative.length){
      // Marcaj vizual roșu pe celulele afectate
      negative.forEach(n=>{
        if(n.cell){
          n.cell.style.borderColor='#ef4444';
          n.cell.style.color='#ef4444';
          n.cell.style.fontWeight='600';
          // Curăță marcajul la următoarea modificare a rândului
          const tr=n.cell.closest('tr');
          const clear=()=>{n.cell.style.borderColor='';n.cell.style.color='';n.cell.style.fontWeight='';
            tr.querySelectorAll('input').forEach(i=>i.removeEventListener('input',clear));};
          tr.querySelectorAll('input').forEach(i=>i.addEventListener('input',clear,{once:true}));
        }
      });
      const lst=negative.map(n=>`rândul ${n.idx} (${fMR(n.c5)})`).join(', ');
      setS('⛔ Recepții neplătite negative: '+lst+'. Suma ordonanțată (col.4) depășește disponibilul (col.2 − col.3). Reduceți col.4 sau verificați col.2/col.3.','err');
      negative[0].cell?.scrollIntoView({behavior:'smooth',block:'center'});
      return false;
    }
    return true;
  }
  // DF (notafd)
  const ckSeca=document.getElementById('n-ck-seca');
  if(ckSeca&&!ckSeca.checked){
    setS('Bifați "Propunerile de la secțiunea A au fost înregistrate..." pentru a finaliza.','err');
    ckSeca.scrollIntoView({behavior:'smooth',block:'center'});
    return false;
  }
  const rows=document.querySelectorAll('#n-ctbody tr');
  const hasData=[...rows].some(tr=>{const cod=tr.querySelector('[data-f="cod_angajament"]');return cod&&cod.value.trim()!=='';});
  if(!hasData){
    setS('Completați cel puțin un rând în tabelul Secțiunii B (Cod angajament).','err');
    return false;
  }
  return true;
}

async function completeAsP2(ft){
  if(!validateSecB(ft))return;
  if(!ST.docId[ft])return;
  const body=ft==='ordnt'?{rows:getOR()}:collectDfP2Db();
  // v3.9.499: upload ambele sloturi când P2 finalizează (root cause R-A fix —
  // înainte, captura 2 era pierdută pentru că completeAsP2 trimitea doar slot 1)
  await uploadCaptura(ft, 1);
  if(ft==='ordnt') await uploadCaptura(ft, 2);
  // v3.9.501: upload atașamente pending (ambele sloturi pentru DF, slot 1 pentru ORD)
  await uploadAttachments(ft, 1);
  if(ft==='notafd') await uploadAttachments(ft, 2);
  try{
    setS('Se finalizează...','info');
    const r=await fetch(`${ftApi(ft)}/${ST.docId[ft]}/complete`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify(body),
    });
    const j=await r.json();
    if(!r.ok||!j.ok){
      if(j.error==='receptii_neplatite_negative'){
        const det=Array.isArray(j.rows)?j.rows.map(b=>`r${b.idx}: ${b.c5}`).join(', '):'';
        setS('⛔ '+j.message+(det?' ('+det+')':''),'err');
      }else if(j.error==='buget_an_curent_depasit'){
        // FIX B (v3.9.557) → buget multi-anual (v3.9.558): plafon hard pe bugetul anului de
        // exercițiu (banda rows_plati ancorată pe an_referinta). Mesajul server include anul.
        setS('⛔ '+(j.message||'Suma ordonanțată depășește bugetul anului de exercițiu.'),'err');
      }else{
        setS(j.error||'Eroare','err');
      }
      return;
    }
    ST.docStatus[ft]='completed';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    _alopLinkDoc(ft,ST.docId[ft]); // FIX: re-leagă la ALOP după completare (idempotent)
    lockAll(ft,true);
    setLockedBar(ft,'Secțiunea dvs. a fost finalizată și trimisă înapoi la P1.','info');
    renderActions(ft);refreshDocs(ft);
    setS('Finalizat cu succes! Redirecționare...','ok');
    setTimeout(()=>showListSection(),1500);
  }catch(e){setS('Eroare: '+e.message,'err');}
}

// ── P1 modifică după completare → resetează la draft + version++ ──────────────
async function resetDocToP1(ft){
  if(ST.docAprobat?.[ft]){setS('Document aprobat — nu poate fi modificat.','err');return;}
  if(!confirm('Documentul va fi resetat la draft și P2 va trebui să completeze din nou. Continuați?'))return;
  // Trimitem un câmp dummy de update pentru a triggera reset în backend
  const body=ft==='ordnt'?{cif:g('o-cif')||' '}:{cif:g('n-cif')||' '};
  try{
    const r=await fetch(`${ftApi(ft)}/${ST.docId[ft]}`,{
      method:'PUT',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify(body),
    });
    const j=await r.json();
    if(!r.ok||!j.ok){setS(j.error||'Eroare','err');return;}
    ST.docStatus[ft]='draft';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    lockAll(ft,false);setLockedBar(ft,'');renderActions(ft);refreshDocs(ft);
    setS('Document redeschis pentru modificare.','ok');
  }catch(e){setS('Eroare: '+e.message,'err');}
}

// ── Returnare neconform ───────────────────────────────────────────────────────
function showReturnModal(ft){
  ST.pendingFt=ft;
  document.getElementById('return-motiv').value='';
  document.getElementById('modal-return').classList.add('show');
}
function closeReturnModal(){
  document.getElementById('modal-return').classList.remove('show');
}
async function confirmReturn(){
  const ft=ST.pendingFt;
  const motiv=(document.getElementById('return-motiv').value||'').trim();
  if(!motiv){setS('Menționați deficiențele înainte de returnare.','err');return;}
  const btn=document.getElementById('return-confirm');
  if(btn)btn.disabled=true;
  try{
    const r=await fetch(`${ftApi(ft)}/${ST.docId[ft]}/returneaza`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify({motiv}),
    });
    const j=await r.json();
    if(!r.ok||!j.ok){setS(j.error||'Eroare','err');return;}
    closeReturnModal();
    ST.docStatus[ft]='returnat';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    lockAll(ft,true);
    setLockedBar(ft,'Document returnat ca neconform. Inițiatorul va fi notificat.','warn');
    renderActions(ft);refreshDocs(ft);
    setS('Document returnat.','ok');
    setTimeout(()=>showListSection(),1500);
  }catch(e){setS('Eroare: '+e.message,'err');}
  finally{if(btn)btn.disabled=false;}
}

// ── Audit per formular (admin / org_admin) ──────────────────────────────────────
const _AUDIT_LABELS={creat:'Creat',trimis_p2:'Trimis la Responsabil CAB',completat:'Completat de Responsabil CAB',legat_alop:'Legat de ALOP',returnat:'Returnat',transmis_flux:'Transmis în flux',revizuit:'Revizuit',sters:'Șters'};

async function openFormAudit(type,docId){
  // Apelat per-rând din listă: openFormAudit('df'|'ord', uuid)
  if(!type||!docId){
    const ft=ST.curFt||'notafd';
    type=ftType(ft);docId=ST.docId&&ST.docId[ft];
  }
  if(!docId){setS('Salvați documentul înainte de a vedea auditul.','warn');return;}
  const ov=document.getElementById('audit-modal');if(ov)ov.classList.add('show');
  const tl=document.getElementById('audit-timeline');
  const meta=document.getElementById('audit-doc-meta');
  if(tl)tl.innerHTML='<div style="color:var(--df-text-3);font-size:.84rem">Se încarcă...</div>';
  if(meta)meta.textContent='';
  // Handlere export (download)
  const base=`/api/formulare-audit/${type}/${encodeURIComponent(docId)}`;
  const csvBtn=document.getElementById('audit-export-csv');
  const pdfBtn=document.getElementById('audit-export-pdf');
  if(csvBtn)csvBtn.onclick=()=>{window.open(base+'?format=csv','_blank');closeFormAudit();};
  if(pdfBtn)pdfBtn.onclick=()=>{window.open(base+'?format=pdf','_blank');closeFormAudit();};
  try{
    const r=await fetch(base,{credentials:'include'});
    const j=await r.json();
    if(!r.ok){if(tl)tl.innerHTML=`<div class="err" style="font-size:.84rem">${esc(j.error||'Eroare la încărcare')}</div>`;return;}
    const esc2=window.df?.esc||(s=>(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
    const d=j.document||{};
    if(meta)meta.innerHTML=`${esc2(d.nr||'fără număr')} · ${esc2(d.den_inst_pb||'')}${d.compartiment?' · '+esc2(d.compartiment):''}`;
    const evs=j.events||[];
    if(!evs.length){if(tl)tl.innerHTML='<div style="color:var(--df-text-3);font-size:.84rem">Niciun eveniment înregistrat.</div>';return;}
    const fmt=iso=>iso?new Date(iso).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'}):'—';
    if(tl)tl.innerHTML=evs.map(e=>{
      const lbl=_AUDIT_LABELS[e.event_type]||e.event_type;
      const actor=e.actor_name||e.actor_email||'—';
      const trans=(e.from_status||e.to_status)?`<span style="color:var(--df-text-3)">${esc2(e.from_status||'—')} → ${esc2(e.to_status||'—')}</span>`:'';
      const motiv=e.meta&&e.meta.motiv?`<div style="font-size:.78rem;color:#e0a458;margin-top:2px">Motiv: ${esc2(e.meta.motiv)}</div>`:'';
      return`<div style="padding:8px 0;border-bottom:1px solid var(--df-border)">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
          <span style="font-weight:600;color:var(--df-text-2);font-size:.86rem">${esc2(lbl)}</span>
          <span style="font-size:.74rem;color:var(--df-text-3);white-space:nowrap">${fmt(e.created_at)}</span>
        </div>
        <div style="font-size:.78rem;color:var(--df-text-3);margin-top:2px">de: ${esc2(actor)} ${trans}</div>
        ${motiv}
      </div>`;
    }).join('');
  }catch(e){if(tl)tl.innerHTML='<div class="err" style="font-size:.84rem">Eroare rețea.</div>';}
}
function closeFormAudit(){const ov=document.getElementById('audit-modal');if(ov)ov.classList.remove('show');}

// ── link-flow section show — noop, asocierea se face automat din semdoc-initiator ─
function showLinkFlowSection(ft){}

// ── Init ──────────────────────────────────────────────────────────────────────
(function initDocWorkflow(){
  const waitUser=setInterval(()=>{
    if(!ST.user)return;
    clearInterval(waitUser);
    renderActions('ordnt');
    renderActions('notafd');
    // Afișează filtrul Inițiator și Compartiment doar pentru admin/org_admin
    if(ST.user.role==='admin'||ST.user.role==='org_admin'){
      const ig=document.getElementById('flt-init-grp');
      if(ig)ig.style.display='';
    } else {
      const cw=document.getElementById('flt-comp-wrap');
      if(cw)cw.style.display='none';
    }
    _populateCompartimente();
    loadDfAprobate();
    // Suport ambele formate URL:
    //   nou:    ?id=UUID&tip=df|ord
    //   legacy: ?form_type=df|ord&form_id=UUID  (din notificări)
    const urlParams=new URLSearchParams(location.search);
    const formType=urlParams.get('tip')||urlParams.get('form_type');
    const formId=urlParams.get('id')||urlParams.get('form_id');
    if(formType&&formId){
      const ft=formType==='ord'?'ordnt':'notafd';
      showFormSection(ft);
      setTimeout(()=>openDoc(ft,formId),600);
    } else if(formType&&!formId){
      // Document nou pentru tipul specificat
      const ft=formType==='ord'?'ordnt':'notafd';
      showFormSection(ft);
      newDoc(ft);
      _applyAutoFill(ft,true);
    } else {
      showListSection();
    }
  },100);
})();

function resetF(ft){
  if(!confirm('Resetați formularul? Datele și draft-ul se vor pierde.'))return;
  draftClear(ft);
  document.querySelectorAll(`#form-${ft} input:not([type=file]),#form-${ft} textarea`)
    .forEach(e=>{if(e.type==='checkbox')e.checked=false;else e.value=(e.type==='number'?'0':'');});
  if(ft==='ordnt'){document.getElementById('o-tbody').innerHTML='';addOR();clrImg('o-cimg','o-cph');clrImg('o-cimg2','o-cph2');document.getElementById('o-alist').innerHTML='';document.getElementById('o-adata').value='[]';_resetOrdBuget();}
  else{document.getElementById('n-vtbody').innerHTML='';document.getElementById('n-ptbody').innerHTML='';document.getElementById('n-ctbody').innerHTML='';addNV();addNC();clrImg('n-cimg','n-cph');['n-fdal','n-alist'].forEach(id=>document.getElementById(id).innerHTML='');['n-fdad','n-adata'].forEach(id=>document.getElementById(id).value='[]');}
  document.getElementById('result-'+ft).classList.remove('show');
  document.getElementById('ff-'+ft).classList.remove('show');
  ST[ft]={pdf:null,name:null};if(ST.docAprobat)ST.docAprobat[ft]=false;if(ST.docRevizieNr)ST.docRevizieNr[ft]=0;if(ST.docRevizieAnUrmator)ST.docRevizieAnUrmator[ft]=false;clrS();upTot();
  document.querySelectorAll(`#form-${ft} .err`).forEach(e=>e.classList.remove('err'));
}

  // ── Exports onclick + cross-module ──────────────────────────────────────
  // Helpers
  window.ftApi                      = ftApi;
  window.ftType                     = ftType;
  window.stLabel                    = stLabel;
  window.sv                         = sv;

  // DB collect/populate
  window.collectOrdDb               = collectOrdDb;
  window.collectDfP1Db              = collectDfP1Db;
  window.collectDfP2Db              = collectDfP2Db;
  window.populateOrd                = populateOrd;
  window.populateDf                 = populateDf;

  // Role + UI state
  window.lockAll                    = lockAll;
  window.lockCaptureAndAttachments  = lockCaptureAndAttachments;
  window.setModeP2Df                = setModeP2Df;
  window.setModeP2Ord               = setModeP2Ord;
  window._dfUpdateProgress          = _dfUpdateProgress;
  window._dfSetAlopCtx              = _dfSetAlopCtx;
  window.prefillSectBFromSectA      = prefillSectBFromSectA;
  window.applyDfRoleState           = applyDfRoleState;
  window.applyOrdRoleState          = applyOrdRoleState;
  window.renderActions              = renderActions;
  window.setLockedBar               = setLockedBar;

  // Doc navigation + CRUD
  window.openDoc                    = openDoc;
  window.refreshDocs                = refreshDocs;
  window.renderDocsList             = renderDocsList;
  window.viewFlowPdf                = viewFlowPdf;
  window.newDoc                     = newDoc;
  window.saveDoc                    = saveDoc;
  window.uploadCaptura              = uploadCaptura;
  window.uploadAttachments          = uploadAttachments;
  window.fetchAttachments           = fetchAttachments;
  window.renderAttachments          = renderAttachments;
  window.remAttServer               = remAttServer;

  // Validation
  window._validateDf                = _validateDf;
  window._validateOrd               = _validateOrd;
  window._clearValErr               = _clearValErr;
  window._showValErr                = _showValErr;

  // P2 flow
  window.showP2Modal                = showP2Modal;
  window.closeModal                 = closeModal;
  window.filterModalUsers           = filterModalUsers;
  window.selectP2                   = selectP2;
  window.confirmP2                  = confirmP2;
  window.validateSecB               = validateSecB;
  window.completeAsP2               = completeAsP2;
  window.resetDocToP1               = resetDocToP1;

  // Return flow
  window.showReturnModal            = showReturnModal;
  window.closeReturnModal           = closeReturnModal;
  window.confirmReturn              = confirmReturn;

  // Reset
  window.resetF                     = resetF;

  // Audit per formular
  window.openFormAudit              = openFormAudit;
  window.closeFormAudit             = closeFormAudit;

  window.df = window.df || {};
  window.df._formularDocLoaded = true;
})();
