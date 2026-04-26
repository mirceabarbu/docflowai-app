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
  return{draft:['draft','● Draft'],pending_p2:['pending','⏳ La Responsabil CAB'],completed:['completed','✅ Complet'],aprobat:['aprobat','🟢 Aprobat'],transmis_flux:['transmis_flux','🔄 Pe flux'],returnat:['returnat','↩ Returnat'],respins:['respins','❌ Respins']}[s]||['draft',s];
}

// ── Colectare date formular → DB ──────────────────────────────────────────────
function collectOrdDb(){return{
  cif:g('o-cif'),den_inst_pb:g('o-den'),nr_ordonant_pl:g('o-nr'),data_ordont_pl:g('o-data'),
  nr_unic_inreg:g('o-nrUnic'),beneficiar:g('o-benef'),documente_justificative:g('o-docsj'),
  iban_beneficiar:g('o-iban'),cif_beneficiar:g('o-cifb'),banca_beneficiar:g('o-banca'),
  inf_pv_plata:g('o-inf1'),inf_pv_plata1:g('o-inf2'),rows:getOR(),
  df_id:document.getElementById('o-df-id')?.value||null,
  img2:imgs['o-cimg2']||null,
};}
function collectDfP1Db(){return{
  cif:g('n-cif'),den_inst_pb:g('n-den'),subtitlu_df:g('n-subtitlu'),
  nr_unic_inreg:g('n-nrUnic'),revizuirea:g('n-rev'),data_revizuirii:g('n-data'),
  compartiment_specialitate:g('n-comp'),obiect_fd_reviz_scurt:g('n-scurt'),obiect_fd_reviz_lung:g('n-lung'),
  ckbx_stab_tin_cont:cb('n-ck-stab'),ckbx_ramane_suma:cb('n-ck-ramane'),ramane_suma:g('n-ramana')||'0',
  rows_val_unchanged:!!document.getElementById('n-ck-ramane')?.checked,
  rows_val:getNV(),
  ckbx_fara_ang_emis_ancrt:cb('n-ck-faraang'),ckbx_cu_ang_emis_ancrt:cb('n-ck-cuang'),
  ckbx_sting_ang_in_ancrt:cb('n-ck-sting'),ckbx_fara_plati_ang_in_ancrt:cb('n-ck-faraplati'),
  ckbx_cu_plati_ang_in_mmani:cb('n-ck-cuplati'),ckbx_ang_leg_emise_ct_an_urm:cb('n-ck-anurmatori'),
  rows_plati:getNP(),
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

function populateOrd(doc){
  sv('o-cif',doc.cif);sv('o-den',doc.den_inst_pb);sv('o-nr',doc.nr_ordonant_pl);sv('o-data',doc.data_ordont_pl);
  sv('o-nrUnic',doc.nr_unic_inreg);sv('o-benef',doc.beneficiar);sv('o-docsj',doc.documente_justificative);
  sv('o-iban',doc.iban_beneficiar);sv('o-cifb',doc.cif_beneficiar);sv('o-banca',doc.banca_beneficiar);
  sv('o-inf1',doc.inf_pv_plata);sv('o-inf2',doc.inf_pv_plata1);
  // Restabilește selecția DF legat
  const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value=doc.df_id||'';
  const dfId=document.getElementById('o-df-id');if(dfId)dfId.value=doc.df_id||'';
  const tbody=document.getElementById('o-tbody');tbody.innerHTML='';oI=0;
  (doc.rows||[]).forEach(row=>{addOR();const tr=tbody.querySelector('tr:last-child');Object.entries(row).forEach(([f,v])=>{const inp=tr.querySelector(`[data-f="${f}"]`);if(inp)inp.value=inp.dataset.money?fMR(parseFloat(v)||0):v;});});
  const _wrap2=document.getElementById('o-captura2-wrap');
  if(_wrap2)_wrap2.style.display=doc.img2?'':'none';
  if(doc.img2)showImg('o-cimg2','o-cph2',doc.img2);
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
    const e=document.getElementById(id);if(e){e.disabled=false;e.classList.add('p2-field');}
  });
  document.querySelectorAll('#n-ctbody input').forEach(e=>{e.disabled=false;e.classList.add('p2-field');});
  // Upload captură deblocat
  const czone=document.getElementById('n-czone');if(czone)czone.style.pointerEvents='';
}
function setModeP2Ord(){
  lockAll('ordnt',true);
  document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;e.style.removeProperty('pointer-events');e.style.removeProperty('opacity');e.closest('td')?.style.removeProperty('pointer-events');e.closest('td')?.style.removeProperty('opacity');});
  // Deblochez receptii + plati_anterioare în tabel
  document.querySelectorAll('#o-tbody input[data-f="receptii"],#o-tbody input[data-f="plati_anterioare"]').forEach(e=>{e.disabled=false;e.classList.add('p2-field');});
  const czone=document.getElementById('o-czone');if(czone)czone.style.pointerEvents='';
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
function applyDfRoleState(status,role){
  const secaBody=document.getElementById('seca-body');
  const secbBody=document.getElementById('secb-body');
  const secaLock=document.getElementById('seca-lock');
  const secbLock=document.getElementById('secb-lock');
  if(!secaBody)return;
  secaBody.classList.remove('locked');
  document.querySelectorAll('#seca-body input[type="checkbox"]').forEach(cb=>{cb.disabled=false;});
  if(secbBody)secbBody.classList.remove('locked');
  if(secaLock)secaLock.style.display='none';
  if(secbLock)secbLock.style.display='none';
  if(!status||status==='draft'){
    if(secbBody)secbBody.classList.add('locked');
    if(secbLock){secbLock.style.display='flex';secbLock.className='df-lock-bar df-lock-info';secbLock.textContent='🔒 Secțiunea B se completează de Responsabilul CAB după trimiterea Secțiunii A.';}
    _dfUpdateProgress('notafd','seca');
  }else if(status==='pending_p2'){
    secaBody.classList.add('locked');
    document.querySelectorAll('#seca-body input[type="checkbox"]').forEach(cb=>{cb.disabled=true;});
    if(secaLock){secaLock.style.display='flex';secaLock.className='df-lock-bar df-lock-warn';secaLock.textContent='🔒 Secțiunea A a fost trimisă la Responsabil CAB și nu mai poate fi modificată.';}
    if(role==='p1'&&secbBody)secbBody.classList.add('locked');
    _dfUpdateProgress('notafd','secb');
  }else if(status==='returnat'){
    if(secbBody)secbBody.classList.add('locked');
    if(secbLock){secbLock.style.display='flex';secbLock.className='df-lock-bar df-lock-warn';secbLock.textContent='↩ Secțiunea B nu a fost aprobată — verificați deficiențele și retrimiteți.';}
    _dfUpdateProgress('notafd','seca');
  }else if(status==='completed'||status==='aprobat'){
    secaBody.classList.add('locked');
    document.querySelectorAll('#seca-body input[type="checkbox"]').forEach(cb=>{cb.disabled=true;});
    if(secbBody)secbBody.classList.add('locked');
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
  if(status==='pending_p2'&&role==='p2')prefillSectBFromSectA();
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

// ── Render actions bar ────────────────────────────────────────────────────────
function renderActions(ft){
  const div=document.getElementById('actions-'+ft);if(!div)return;
  const status=ST.docStatus[ft],role=ST.docRole[ft],docId=ST.docId[ft];
  const B=(cls,txt,fn)=>`<button class="df-action-btn ${cls}" onclick="${fn}">${txt}</button>`;
  const BNou='';
  let html='';
  // Banner "an următor" — vizibil doar pentru notafd revizie an următor
  const bannerAnUrm=document.getElementById('banner-an-urmator-notafd');
  if(bannerAnUrm) bannerAnUrm.style.display=(ft==='notafd'&&ST.docRevizieAnUrmator?.[ft])?'':'none';

  if(ST.docAprobat?.[ft]){
    const fid=ST.docFlowId?.[ft];
    const revNr=ST.docRevizieNr?.[ft]||0;
    const isAnUrm=ft==='notafd'&&ST.docRevizieAnUrmator?.[ft];
    const revBadge=ft==='notafd'&&revNr>0?`<span class="df-revizie-badge" style="margin-right:4px">Revizia ${revNr}</span>`:'';
    div.innerHTML=revBadge
      +(fid?B('teal','📄 Descarcă PDF semnat',`viewFlowPdf('${fid}')`):'')
      +(ft==='notafd'?B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`):'');
    return;
  }
  if(!docId){
    html=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +`<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`
      +B('','↺ Resetează',`resetF('${ft}')`);
  }else if(status==='draft'&&role==='p1'){
    html=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +BNou
      +B('','↺ Câmpuri',`resetF('${ft}')`);
  }else if(status==='returnat'&&role==='p1'){
    html=B('teal','📨 Retrimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +BNou;
  }else if(status==='pending_p2'&&role==='p2'){
    html=B('','💾 Salvează',`saveDoc('${ft}')`)
      +B('primary','✅ Finalizez secțiunea',`completeAsP2('${ft}')`)
      +B('danger','↩ Returnează ca neconform',`showReturnModal('${ft}')`);
  }else if(status==='pending_p2'&&role==='p1'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">⏳ Așteptare Responsabil CAB...</span>`
      +BNou;
  }else if(status==='completed'&&role==='p1'){
    const hasPdf=!!(ST[ft]?.pdf);
    html=(hasPdf?B('primary','🔏 Lansează flux semnare',`mkFlow('${ft}')`)
                :`<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`);
  }else if(status==='transmis_flux'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">🔄 Document pe fluxul de semnare...</span>`
      +(ST.docFlowId?.[ft]?B('','📄 Descarcă PDF',`viewFlowPdf('${ST.docFlowId[ft]}')`):'');
  }else if(status==='completed'&&role==='p2'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">✅ Secțiunea ta este completată.</span>`
      +BNou;
  }else{
    html=`<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`
      +B('','↺ Resetează',`resetF('${ft}')`);
  }
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

    // Populare câmpuri
    if(ft==='ordnt')populateOrd(doc);else populateDf(doc);

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

    // Dacă nu avem context ALOP și documentul are alop_id, populează automat contextul
    if(!window._alopContext&&doc.alop_id){
      window._alopContext={alopId:doc.alop_id,titlu:doc.alop_titlu||'',valoare:doc.alop_valoare||null};
      sessionStorage.setItem('_alopContext',JSON.stringify(window._alopContext));
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

    // Ascunde motiv bar implicit; se afișează doar pentru 'returnat'
    const _mb=document.getElementById('motiv-bar-'+ft);
    if(_mb)_mb.style.display='none';

    // Lock / mode
    lockAll(ft,false);
    const status=doc.status,role=ST.docRole[ft];
    if(ST.docAprobat[ft]){
      lockAll(ft,true);
      if(ft==='ordnt')document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;e.style.removeProperty('pointer-events');e.style.removeProperty('opacity');e.closest('td')?.style.removeProperty('pointer-events');e.closest('td')?.style.removeProperty('opacity');});
      lockCaptureAndAttachments(ft,true);
      document.querySelectorAll(`#form-${ft} .p2-field`).forEach(e=>e.classList.remove('p2-field'));
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
      if(ft==='ordnt')document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;e.style.removeProperty('pointer-events');e.style.removeProperty('opacity');e.closest('td')?.style.removeProperty('pointer-events');e.closest('td')?.style.removeProperty('opacity');});
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
      if(ft==='ordnt')document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;e.style.removeProperty('pointer-events');e.style.removeProperty('opacity');e.closest('td')?.style.removeProperty('pointer-events');e.closest('td')?.style.removeProperty('opacity');});
      lockCaptureAndAttachments(ft,true);
      document.querySelectorAll(`#form-${ft} .p2-field`).forEach(e=>e.classList.remove('p2-field'));
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
    const p2info=d.assigned_to_nume?` · Resp. CAB: ${esc(d.assigned_to_nume)}`:'';
    const creator=d.created_by_nume||d.created_by_email||'';
    const creatorInfo=creator?` · ${esc(creator)}`:'';
    const pdfBtn=d.flow_id
      ?`<button class="df-action-btn sm" style="margin-left:4px" onclick="event.stopPropagation();viewFlowPdf('${d.flow_id}')" title="PDF semnat din flux">📄 PDF flux</button>`
      :'';
    return`<div class="doc-card" data-id="${d.id}" onclick="openDoc('${ft}','${d.id}')">
      <div class="doc-card-main">
        <div class="doc-card-title">${title}${revBadge}</div>
        <div class="doc-card-sub">${updated}${p2info}${creatorInfo}</div>
      </div>
      <span class="dst ${cls}">${lbl}</span>${pdfBtn}
    </div>`;
  }).join('');
}

async function viewFlowPdf(flowId){
  try{
    const r=await fetch(`/api/flows/${encodeURIComponent(flowId)}/signed-pdf`,{credentials:'include'});
    if(!r.ok){
      try{
        const r2=await fetch(`/api/flows/${encodeURIComponent(flowId)}/pdf`,{credentials:'include'});
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
  ST.docId[ft]=null;ST.docStatus[ft]=null;ST.docRole[ft]='p1';
  lockAll(ft,false);setLockedBar(ft,'');
  if(ft==='notafd')applyDfRoleState(null,'p1');
  else if(ft==='ordnt')applyOrdRoleState(null,'p1');
  // Golim câmpurile
  document.querySelectorAll(`#form-${ft} input:not([type=file]):not([type=hidden]),#form-${ft} textarea`).forEach(e=>{if(e.type==='checkbox')e.checked=false;else if(e.type==='number')e.value='0';else e.value='';});
  if(ft==='ordnt'){
    document.getElementById('o-tbody').innerHTML='';addOR();clrImg('o-cimg','o-cph');clrImg('o-cimg2','o-cph2');
    document.getElementById('o-alist').innerHTML='';document.getElementById('o-adata').value='[]';
    const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value='';
    const dfId=document.getElementById('o-df-id');if(dfId)dfId.value='';
  }else{['n-vtbody','n-ptbody','n-ctbody'].forEach(tid=>{document.getElementById(tid).innerHTML='';});addNV();addNC();clrImg('n-cimg','n-cph');['n-fdal','n-alist'].forEach(id=>document.getElementById(id).innerHTML='');['n-fdad','n-adata'].forEach(id=>document.getElementById(id).value='[]');}
  document.getElementById('result-'+ft).classList.remove('show');
  ST[ft]={pdf:null,name:null};upTot();clrS();renderActions(ft);
  document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c=>c.classList.remove('active'));
  _updateBackBtn(ft);
}

// _alopLinkDoc → mutat în alop.js (BLOC 2.2)
// ── Salvare în DB ─────────────────────────────────────────────────────────────
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
      if(r.status===409){setS(j.message||'Număr unic duplicat!','err');document.getElementById('n-nrUnic')?.focus();return;}
      if(r.ok&&j.ok){
        ST.docId[ft]=j.document.id;ST.docStatus[ft]='draft';ST.docRole[ft]='p1';
        _alopLinkDoc(ft,j.document.id); // FIX: leagă imediat la ALOP la primul save
      }
    }else{
      r=await fetch(`${ftApi(ft)}/${docId}`,{method:'PUT',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.ok&&j.ok){ST.docStatus[ft]=j.document.status;}
    }
    if(!r.ok||!j.ok){setS(j.error||'Eroare la salvare','err');return;}

    // Upload captură dacă există
    const iid=ft==='ordnt'?'o-cimg':'n-cimg';
    if(imgs[iid]&&ST.docId[ft])await uploadCaptura(ft);

    renderActions(ft);refreshDocs(ft);
    setS('Salvat cu succes.','ok');
  }catch(e){setS('Eroare rețea: '+e.message,'err');}
}

// ── Upload captură ────────────────────────────────────────────────────────────
async function uploadCaptura(ft){
  const iid=ft==='ordnt'?'o-cimg':'n-cimg';
  const dataUrl=imgs[iid];if(!dataUrl||!ST.docId[ft])return;
  try{
    // dataUrl = 'data:image/png;base64,...'
    const[header,b64]=dataUrl.split(',');
    const mime=header.match(/:(.*?);/)?.[1]||'image/png';
    const bin=atob(b64);const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const blob=new Blob([arr],{type:mime});
    await fetch(`/api/formulare-capturi/${ftType(ft)}/${ST.docId[ft]}`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':mime,'X-CSRF-Token':df.getCsrf(),'X-Filename':`captura_${ft}.png`},
      body:blob,
    });
  }catch(_){}
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
      const hasVal=rows.some(tr=>[...tr.querySelectorAll('input[type=number]')].some(i=>(parseFloat(i.value)||0)>0));
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
    if(!ST.docId[ft]){setS('Nu s-a putut salva documentul.','err');return;}
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
      if(r.ok&&j.ok)ST.orgUsers=j.users||[];
    }catch(_){}
  }
  filterModalUsers();
}
function closeModal(){document.getElementById('modal-p2').classList.remove('show');}
function filterModalUsers(){
  const q=(document.getElementById('modal-search')?.value||'').toLowerCase();
  const listEl=document.getElementById('modal-user-list');
  const filtered=ST.orgUsers.filter(u=>(u.nume||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q));
  if(!filtered.length){listEl.innerHTML='<div style="color:var(--df-text-3);font-size:.8rem;text-align:center;padding:10px">Niciun utilizator găsit.</div>';return;}
  listEl.innerHTML=filtered.map(u=>`
    <div class="modal-user${ST.selectedP2Id===u.id?' sel':''}" onclick="selectP2(${u.id})">
      <div style="flex:1">
        <div class="modal-u-name">${(u.nume||u.email||'').replace(/</g,'&lt;')}</div>
        <div class="modal-u-sub">${(u.email||'').replace(/</g,'&lt;')}${u.compartiment?` · ${u.compartiment.replace(/</g,'&lt;')}`:''}</div>
      </div>
    </div>`).join('');
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
    if(!r.ok||!j.ok){setS(j.error||'Eroare la trimitere','err');return;}
    ST.docStatus[ft]='pending_p2';
    // Redirect automat la centralizare după trimite P2
    setTimeout(()=>showListSection(),1200);
    setS(`Trimis la ${j.assigned_to?.nume||j.assigned_to?.email||'Responsabil CAB'}.`,'ok');
  }catch(e){setS('Eroare: '+e.message,'err');}
}

// ── P2 finalizează ────────────────────────────────────────────────────────────
function validateSecB(ft){
  if(ft!=='notafd')return true;
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
  // Upload captură
  await uploadCaptura(ft);
  try{
    setS('Se finalizează...','info');
    const r=await fetch(`${ftApi(ft)}/${ST.docId[ft]}/complete`,{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
      body:JSON.stringify(body),
    });
    const j=await r.json();
    if(!r.ok||!j.ok){setS(j.error||'Eroare','err');return;}
    ST.docStatus[ft]='completed';
    _alopLinkDoc(ft,ST.docId[ft]); // FIX: re-leagă la ALOP după completare (idempotent)
    lockAll(ft,true);
    if(ft==='ordnt')document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;e.style.removeProperty('pointer-events');e.style.removeProperty('opacity');e.closest('td')?.style.removeProperty('pointer-events');e.closest('td')?.style.removeProperty('opacity');});
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
    lockAll(ft,true);
    if(ft==='ordnt')document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;e.style.removeProperty('pointer-events');e.style.removeProperty('opacity');e.closest('td')?.style.removeProperty('pointer-events');e.closest('td')?.style.removeProperty('opacity');});
    setLockedBar(ft,'Document returnat ca neconform. Inițiatorul va fi notificat.','warn');
    renderActions(ft);refreshDocs(ft);
    setS('Document returnat.','ok');
    setTimeout(()=>showListSection(),1500);
  }catch(e){setS('Eroare: '+e.message,'err');}
  finally{if(btn)btn.disabled=false;}
}

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
  if(ft==='ordnt'){document.getElementById('o-tbody').innerHTML='';addOR();clrImg('o-cimg','o-cph');clrImg('o-cimg2','o-cph2');document.getElementById('o-alist').innerHTML='';document.getElementById('o-adata').value='[]';}
  else{document.getElementById('n-vtbody').innerHTML='';document.getElementById('n-ptbody').innerHTML='';document.getElementById('n-ctbody').innerHTML='';addNV();addNC();clrImg('n-cimg','n-cph');['n-fdal','n-alist'].forEach(id=>document.getElementById(id).innerHTML='');['n-fdad','n-adata'].forEach(id=>document.getElementById(id).value='[]');}
  document.getElementById('result-'+ft).classList.remove('show');
  document.getElementById('ff-'+ft).classList.remove('show');
  ST[ft]={pdf:null,name:null};if(ST.docAprobat)ST.docAprobat[ft]=false;clrS();upTot();
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

  window.df = window.df || {};
  window.df._formularDocLoaded = true;
})();
