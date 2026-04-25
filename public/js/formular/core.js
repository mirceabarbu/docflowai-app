// public/js/formular/core.js
// DocFlowAI — Modul CORE formular (BLOC 2.6 — FINAL).
//
// Conține: cross-module state (ST, imgs), init helpers (_applyAutoFill),
//   image/file upload, tables (OR/NV/NP/NC), money input (pMR/fMR),
//   toggles (p4/p5), aggregations (upTot, colO, colN), form core
//   (sw, setS, valF, genPdf, mkFlow, g, cb, DR, CR, markE).
//
// Cross-module state pe window (accesibil ca bare identifier din toate modulele):
//   window.ST   — statusuri, user, orgProfile, docId, docRole etc.
//   window.imgs — imagini upload captură
//
// 32+ onclick + cross-module functions exported on window.

(function() {
  'use strict';

  // ── Cross-module state — inițializat pe window ───────────────────────────
window.ST = window.ST || {
  ordnt:{pdf:null,name:null}, notafd:{pdf:null,name:null}, user:null,
  orgProfile:null,                    // cache org → re-fill la fiecare newDoc din Section 1
  docId:{ordnt:null,notafd:null},
  docStatus:{ordnt:null,notafd:null},
  docRole:{ordnt:null,notafd:null},  // 'p1'|'p2'|'view'
  orgUsers:[], selectedP2Id:null, pendingFt:null,
};
  window.imgs = {'o-cimg':null,'o-cimg2':null,'n-cimg':null};
  const ST   = window.ST;    // alias local (referință la același obiect)
  const imgs = window.imgs;  // alias local

  // ── Counters tabele (local IIFE — capturați de closures addOR/addNV etc.) ──
function _applyAutoFill(ft, resetDate){
  const sf=(id,val)=>{const e=document.getElementById(id);if(e&&val!==undefined&&val!==null&&val!=='')e.value=val;};
  const org=ST.orgProfile;
  const today=new Date();
  const d=`${String(today.getDate()).padStart(2,'0')}.${String(today.getMonth()+1).padStart(2,'0')}.${today.getFullYear()}`;

  if(!ft||ft==='ordnt'){
    if(org?.name) sf('o-den',org.name);
    if(org?.cif)  sf('o-cif',org.cif);
    const od=document.getElementById('o-data');
    if(od&&(resetDate||!od.value))od.value=d;
    sf('ffe-ordnt',ST.user?.nume||ST.user?.name||ST.user?.email||'');
  }
  if(!ft||ft==='notafd'){
    if(org?.name) sf('n-den',org.name);
    if(org?.cif)  sf('n-cif',org.cif);
    const nd=document.getElementById('n-data');
    if(nd&&(resetDate||!nd.value))nd.value=d;
    if(ST.user?.compartiment) sf('n-comp',ST.user.compartiment);
    sf('ffe-notafd',ST.user?.nume||ST.user?.name||ST.user?.email||'');
    if(org?._compList?.length){
      const dl=document.getElementById('comp-list-notafd');
      if(dl) dl.innerHTML=org._compList.map(c=>`<option value="${c.replace(/"/g,'&quot;')}">`).join('');
    }
    const _alopT=window._alopContext?.titlu;
    const _subtEl=document.getElementById('n-subtitlu');
    if(_alopT&&_subtEl&&!_subtEl.value)_subtEl.value=_alopT;
  }
}


function sw(tab){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',(i===0&&tab==='ordnt')||(i===1&&tab==='notafd')));
  document.getElementById('form-ordnt').style.display=tab==='ordnt'?'':'none';
  document.getElementById('form-notafd').style.display=tab==='notafd'?'':'none';
  clrS();
}
function setS(msg,type='info'){const el=document.getElementById('sBar');el.className='status '+type;el.innerHTML=(type==='err'?'❌ ':type==='ok'?'✅ ':'⏳ ')+msg;}
function clrS(){const el=document.getElementById('sBar');el.className='status';el.innerHTML='';}

/* Images */
function showImg(iid,phid,data){const i=document.getElementById(iid),p=document.getElementById(phid);i.src=data;i.style.display='block';if(p)p.style.display='none';imgs[iid]=data;}
function clrImg(iid,phid){const i=document.getElementById(iid),p=document.getElementById(phid);i.src='';i.style.display='none';if(p)p.style.display='';imgs[iid]=null;}
function fimg(ev,iid,phid){const f=ev.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=e=>showImg(iid,phid,e.target.result);r.readAsDataURL(f);}
function dov(ev,zid){ev.preventDefault();document.getElementById(zid).classList.add('drag-ov');}
function dlv(ev,zid){document.getElementById(zid).classList.remove('drag-ov');}
function ddp(ev,iid,zid,phid){ev.preventDefault();document.getElementById(zid).classList.remove('drag-ov');const f=ev.dataTransfer.files?.[0];if(!f||!f.type.startsWith('image/'))return;const r=new FileReader();r.onload=e=>showImg(iid,phid,e.target.result);r.readAsDataURL(f);}

/* Attachments */
function addAtt(ev,lid,did){
  const files=ev.target.files;if(!files.length)return;
  const list=document.getElementById(lid);
  let cur=JSON.parse(document.getElementById(did).value||'[]');
  for(const f of files){
    const rd=new FileReader();
    rd.onload=e=>{
      const idx=cur.length;cur.push({name:f.name,type:f.type,data:e.target.result});
      document.getElementById(did).value=JSON.stringify(cur);
      const chip=document.createElement('span');chip.className='att-chip';
      chip.innerHTML=`📎 ${f.name} <button onclick="remAtt(${idx},'${lid}','${did}',this)">✕</button>`;
      list.appendChild(chip);
    };
    rd.readAsDataURL(f);
  }
  ev.target.value='';
}
function remAtt(idx,lid,did,btn){
  const cur=JSON.parse(document.getElementById(did).value||'[]');
  cur.splice(idx,1);document.getElementById(did).value=JSON.stringify(cur);
  btn.closest('.att-chip').remove();
}

/* Dynamic rows */
let oI=0,nVI=0,nPI=0,nCI=0;
/* ── Formatare monetară ro-RO ─────────────────────────────────────────────── */
const pMR=v=>{if(v===null||v===undefined||v==='')return 0;const s=String(v).trim().replace(/\s/g,'').replace(/\./g,'').replace(',','.');const n=parseFloat(s);return isNaN(n)?0:n;};
const fMR=(v,d=2)=>{const n=typeof v==='string'?pMR(v):Number(v);if(isNaN(n))return'0,00';return n.toLocaleString('ro-RO',{minimumFractionDigits:d,maximumFractionDigits:d});};
function attachMoneyInput(inp,d=2){if(!inp||inp.dataset.moneyAttached==='1')return;inp.dataset.moneyAttached='1';inp.addEventListener('focus',()=>{if(inp.disabled||inp.readOnly)return;const raw=pMR(inp.value);inp.value=raw===0?'0':String(raw).replace('.',',');});inp.addEventListener('blur',()=>{if(inp.value===''||inp.value===null)return;inp.value=fMR(pMR(inp.value),d);});if(inp.value===''||inp.value==='0'){inp.value='0,00';}else if(inp.value!=='0,00'){inp.value=fMR(pMR(inp.value),d);}};
function addOR(){const i=oI++;const tr=document.createElement('tr');tr.id='or-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="11" data-f="cod_angajament"/></td><td><input type="text" maxlength="3" data-f="indicator_angajament"/></td><td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="cod_SSI"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="receptii" oninput="calcORRow(this)"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_anterioare" oninput="calcORRow(this)"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="suma_ordonantata_plata" oninput="calcORRow(this)"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="receptii_neplatite" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default" title="5=(col.2)-(col.3)-(col.4) — calculat automat"/></td><td><button class="bdel" onclick="delR('or-${i}');upTot()">✕</button></td>`;
  document.getElementById('o-tbody').appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));
  // Dacă P1 e în modul completed (col.4 editabil), noile rânduri moștenesc același drept
  if(ST.docRole?.ordnt==='p1'){
    tr.querySelectorAll('[data-f="suma_ordonantata_plata"]').forEach(e=>{
      e.disabled=false;
      e.style.pointerEvents='auto';
      e.closest('td')?.style.setProperty('pointer-events','auto');
    });
  }}
function calcORRow(el){
  const tr=el.closest('tr');
  const c2=pMR(tr.querySelector('[data-f="receptii"]')?.value);
  const c3=pMR(tr.querySelector('[data-f="plati_anterioare"]')?.value);
  const c4=pMR(tr.querySelector('[data-f="suma_ordonantata_plata"]')?.value);
  const c5=tr.querySelector('[data-f="receptii_neplatite"]');
  if(c5)c5.value=fMR(c2-c3-c4);
  upTot();
}
function getOR(){return[...document.querySelectorAll('#o-tbody tr')].map(tr=>{const o={};tr.querySelectorAll('input[data-f]').forEach(i=>o[i.dataset.f]=i.dataset.money?String(pMR(i.value)||0):i.value);return o;});}

function addNV(){const i=nVI++;const tr=document.createElement('tr');tr.id='nv-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="150" data-f="element_fd" style="min-width:90px"/></td><td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="codSSI"/></td><td><input type="text" maxlength="500" data-f="param_fd" style="min-width:80px"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="valt_rev_prec"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="influente"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="valt_actualiz" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default"/></td><td><button class="bdel" onclick="delR('nv-${i}');upTot()">✕</button></td>`;
  document.getElementById('n-vtbody').appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));
  const c5=tr.querySelector('[data-f="valt_rev_prec"]');
  const c6=tr.querySelector('[data-f="influente"]');
  if(c5)c5.addEventListener('input',()=>calcNVRow(c5));
  if(c6)c6.addEventListener('input',()=>calcNVRow(c6));
}
function getNV(){return[...document.querySelectorAll('#n-vtbody tr')].map(tr=>{const o={};tr.querySelectorAll('input[data-f]').forEach(i=>o[i.dataset.f]=i.dataset.money?String(pMR(i.value)||0):i.value);return o;});}

function addNP(){const i=nPI++;const tr=document.createElement('tr');tr.id='np-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="codSSI"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_ani_precedenti" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_ancrt" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_an_np1" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_an_np2" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_an_np3" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_ani_ulter" oninput="upTot()"/></td><td><button class="bdel" onclick="delR('np-${i}');upTot()">✕</button></td>`;
  document.getElementById('n-ptbody').appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));}
function getNP(){return[...document.querySelectorAll('#n-ptbody tr')].map(tr=>{const o={};tr.querySelectorAll('input[data-f]').forEach(i=>o[i.dataset.f]=i.dataset.money?String(pMR(i.value)||0):i.value);return o;});}

function addNC(){const i=nCI++;const tr=document.createElement('tr');tr.id='nc-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="11" data-f="cod_angajament"/></td><td><input type="text" maxlength="3" data-f="indicator_angajament"/></td><td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="cod_SSI"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_ang_af_rvz_prc"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="influente_c6"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_ang_act" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default" title="7=5+6 — calculat automat"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_bug_af_rvz_prc"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="influente_c9"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_bug_act" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default" title="10=8+9 — calculat automat"/></td><td><button class="bdel" onclick="delR('nc-${i}');upTot()">✕</button></td>`;
  document.getElementById('n-ctbody').appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));
  const c5=tr.querySelector('[data-f="sum_rezv_crdt_ang_af_rvz_prc"]');
  const c6=tr.querySelector('[data-f="influente_c6"]');
  const c8=tr.querySelector('[data-f="sum_rezv_crdt_bug_af_rvz_prc"]');
  const c9=tr.querySelector('[data-f="influente_c9"]');
  if(c5)c5.addEventListener('input',()=>calcNCRow(c5));
  if(c6)c6.addEventListener('input',()=>calcNCRow(c6));
  if(c8)c8.addEventListener('input',()=>calcNCRow(c8));
  if(c9)c9.addEventListener('input',()=>calcNCRow(c9));
}
function getNC(){return[...document.querySelectorAll('#n-ctbody tr')].map(tr=>{const o={};tr.querySelectorAll('input[data-f]').forEach(i=>o[i.dataset.f]=i.dataset.money?String(pMR(i.value)||0):i.value);return o;});}

function delR(id){document.getElementById(id)?.remove();}

/* Pct 4 - mutual exclusion Se stabileste / Ramane */
function p4toggle(src){
  const ckStab=document.getElementById('n-ck-stab');
  const ckRam=document.getElementById('n-ck-ramane');
  const tbl=document.getElementById('n-p4-tabel');
  const inp=document.getElementById('n-ramana');
  if(src==='stab'&&ckStab.checked){
    ckRam.checked=false;
    tbl.style.opacity='1';tbl.style.pointerEvents='';
    inp.disabled=true;
  } else if(src==='ramane'&&ckRam.checked){
    ckStab.checked=false;
    tbl.style.opacity='.4';tbl.style.pointerEvents='none';
    inp.disabled=false;
    // Pre-completează cu totalul curent din tabelul pct.4 dacă inputul e 0/gol
    if(!parseFloat(inp.value)){
      const tot=parseFloat(document.getElementById('n-t-vact')?.textContent)||0;
      if(tot>0)inp.value=tot;
    }
  } else {
    tbl.style.opacity='.4';tbl.style.pointerEvents='none';
    inp.disabled=true;
  }
}

/* Pct 5 - Cu angajamente / Fara angajamente mutually exclusive */
function p5toggle(){
  const ckCu=document.getElementById('n-ck-cuang');
  const ckFara=document.getElementById('n-ck-faraang');
  const sub=document.getElementById('n-p5-sub');
  if(ckCu.checked&&ckFara.checked){
    if(event&&event.target===ckCu)ckFara.checked=false;
    else ckCu.checked=false;
  }
  const cuActive=ckCu.checked;
  sub.style.opacity=cuActive?'1':'.4';
  sub.style.pointerEvents=cuActive?'':'none';
  sub.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.disabled=!cuActive);
  if(!cuActive){
    sub.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.checked=false);
  }
  // Activare tabel: orice bifă din pct.5 EXCEPT stingere
  const stingere=document.getElementById('n-ck-sting')?.checked;
  const faraplati=document.getElementById('n-ck-faraplati')?.checked;
  const cuplati=document.getElementById('n-ck-cuplati')?.checked;
  const faraang=document.getElementById('n-ck-faraang')?.checked;
  const anurmatori=document.getElementById('n-ck-anurmatori')?.checked;
  const tabelActiv=(faraplati||cuplati||faraang||anurmatori)&&!stingere;
  const ptSub=document.getElementById('n-p5-tabel');
  if(ptSub){ptSub.style.opacity=tabelActiv?'1':'.4';ptSub.style.pointerEvents=tabelActiv?'':'none';}
}

function p5SubToggle(el){
  const subs=['n-ck-sting','n-ck-faraplati','n-ck-cuplati'];
  if(el.checked){
    subs.forEach(id=>{
      if(id!==el.id){const cb=document.getElementById(id);if(cb)cb.checked=false;}
    });
  }
  // Tabel activ pentru faraplati și cuplati; NU pentru stingere
  const stingere=document.getElementById('n-ck-sting')?.checked;
  const faraplati=document.getElementById('n-ck-faraplati')?.checked;
  const cuplati=document.getElementById('n-ck-cuplati')?.checked;
  const ptSub=document.getElementById('n-p5-tabel');
  if(ptSub){
    const activ=(faraplati||cuplati)&&!stingere;
    ptSub.style.opacity=activ?'1':'.4';ptSub.style.pointerEvents=activ?'':'none';
  }
}

/* Col 7 = Col 5 + Col 6 (auto-calculat) */
function calcNVRow(el){
  const tr=el.closest('tr');
  const c5=pMR(tr.querySelector('[data-f="valt_rev_prec"]')?.value);
  const c6=pMR(tr.querySelector('[data-f="influente"]')?.value);
  const c7=tr.querySelector('[data-f="valt_actualiz"]');
  if(c7)c7.value=fMR(c5+c6);
  upTot();
}

/* Col 7=5+6, Col 10=8+9 — auto-calc Secțiunea B */
function calcNCRow(el){
  const tr=el.closest('tr');
  const c5=pMR(tr.querySelector('[data-f="sum_rezv_crdt_ang_af_rvz_prc"]')?.value);
  const c6=pMR(tr.querySelector('[data-f="influente_c6"]')?.value);
  const c7=tr.querySelector('[data-f="sum_rezv_crdt_ang_act"]');
  if(c7)c7.value=fMR(c5+c6);
  const c8=pMR(tr.querySelector('[data-f="sum_rezv_crdt_bug_af_rvz_prc"]')?.value);
  const c9=pMR(tr.querySelector('[data-f="influente_c9"]')?.value);
  const c10=tr.querySelector('[data-f="sum_rezv_crdt_bug_act"]');
  if(c10)c10.value=fMR(c8+c9);
  upTot();
}

/* Totals */
function sf(bid,f){return[...document.querySelectorAll(`#${bid} input[data-f="${f}"]`)].reduce((s,i)=>s+pMR(i.value),0);}
function st2(id,v){const e=document.getElementById(id);if(e)e.textContent=Math.round(v).toLocaleString('ro-RO');}
function upTot(){
  st2('o-t-rec',sf('o-tbody','receptii'));st2('o-t-plati',sf('o-tbody','plati_anterioare'));
  st2('o-t-suma',sf('o-tbody','suma_ordonantata_plata'));st2('o-t-neplat',sf('o-tbody','receptii_neplatite'));
  st2('n-t-vprec',sf('n-vtbody','valt_rev_prec'));st2('n-t-vinfl',sf('n-vtbody','influente'));st2('n-t-vact',sf('n-vtbody','valt_actualiz'));
  st2('n-t-pprec',sf('n-ptbody','plati_ani_precedenti'));st2('n-t-pancrt',sf('n-ptbody','plati_estim_ancrt'));
  st2('n-t-pnp1',sf('n-ptbody','plati_estim_an_np1'));st2('n-t-pnp2',sf('n-ptbody','plati_estim_an_np2'));
  st2('n-t-pnp3',sf('n-ptbody','plati_estim_an_np3'));st2('n-t-pulter',sf('n-ptbody','plati_estim_ani_ulter'));
  st2('n-t-c5',sf('n-ctbody','sum_rezv_crdt_ang_af_rvz_prc'));st2('n-t-c6',sf('n-ctbody','influente_c6'));
  st2('n-t-c7',sf('n-ctbody','sum_rezv_crdt_ang_act'));st2('n-t-c8',sf('n-ctbody','sum_rezv_crdt_bug_af_rvz_prc'));
  st2('n-t-c9',sf('n-ctbody','influente_c9'));st2('n-t-c10',sf('n-ctbody','sum_rezv_crdt_bug_act'));
}

/* Collect */
const g=id=>(document.getElementById(id)?.value||'').trim();
const cb=id=>document.getElementById(id)?.checked?'1':'';

function colO(){return{
  Cif:g('o-cif'),DenInstPb:g('o-den'),NrOrdonantPl:g('o-nr'),DataOrdontPl:g('o-data'),
  captureImageBase64:imgs['o-cimg']||null,
  captureImageBase64_2:imgs['o-cimg2']||null,
  attachments:JSON.parse(document.getElementById('o-adata').value||'[]'),
  docFd:{nr_unic_inreg:g('o-nrUnic'),beneficiar:g('o-benef'),
    documente_justificative:g('o-docsj'),iban_beneficiar:g('o-iban'),
    cif_beneficiar:g('o-cifb'),banca_beneficiar:g('o-banca'),
    inf_pv_plata:g('o-inf1'),inf_pv_plata1:g('o-inf2'),rowTfd:getOR()},
};}

function colN(){return{
  Cif:g('n-cif'),DenInstPb:g('n-den'),SubtitluDF:g('n-subtitlu'),
  NrUnicInreg:g('n-nrUnic'),Revizuirea:g('n-rev'),DataRevizuirii:g('n-data'),
  captureImageBase64:imgs['n-cimg']||null,
  attachmentsFd:JSON.parse(document.getElementById('n-fdad').value||'[]'),
  attachments:JSON.parse(document.getElementById('n-adata').value||'[]'),
  sectiuneaA:{
    compartiment_specialitate:g('n-comp'),
    obiect_fd_reviz_scurt:g('n-scurt'),obiect_fd_reviz_lung:g('n-lung'),
    ang_legale_val:{ckbx_stab_tin_cont:cb('n-ck-stab'),ckbx_ramane_suma:cb('n-ck-ramane'),
      ramane_suma:String(pMR(g('n-ramana'))||0),rowT_ang_pl_val:getNV()},
    ang_legale_plati:{ckbx_fara_ang_emis_ancrt:cb('n-ck-faraang'),ckbx_cu_ang_emis_ancrt:cb('n-ck-cuang'),
      ckbx_sting_ang_in_ancrt:cb('n-ck-sting'),ckbx_fara_plati_ang_in_ancrt:cb('n-ck-faraplati'),
      ckbx_cu_plati_ang_in_mmani:cb('n-ck-cuplati'),ckbx_ang_leg_emise_ct_an_urm:cb('n-ck-anurmatori'),
      rowT_ang_pl_plati:getNP()},
  },
  sectiuneaB:{
    ckbx_secta_inreg_ctrl_ang:cb('n-ck-seca'),ckbx_fara_inreg_ctrl_ang:cb('n-ck-fararezv'),
    sum_fara_inreg_ctrl_crdbug:String(pMR(g('n-sumfara'))||0),
    ckbx_fara_inreg_ctrl_crd_bug:cb('n-ck-fararezvcrbug'),
    sum_fara_inreg_ctrl_crd_bug:String(pMR(g('n-sumfararezvcrbug'))||0),
    ckbx_interzis_emit_ang:cb('n-ck-interzis'),ckbx_interzis_intrucat:cb('n-ck-intrucat'),
    intrucat:g('n-intrucat'),rowT_ang_ctrl_ang:getNC(),
  },
};}

/* Validation */
const DR=/^([1-9]|0[1-9]|[12]\d|3[01])\.([1-9]|0[1-9]|1[012])\.\d{4}$/;
const CR=/^[1-9]\d{1,9}$/;
function markE(id,bad){const e=document.getElementById(id);if(e)e.classList.toggle('err',bad);}
function valF(ft){
  let ok=true;
  const req=(id,c)=>{markE(id,!c);if(!c)ok=false;};
  if(ft==='ordnt'){
    req('o-den',g('o-den').length>0);req('o-cif',CR.test(g('o-cif')));
    req('o-nr',g('o-nr').length>0);req('o-data',DR.test(g('o-data')));
    req('o-nrUnic',g('o-nrUnic').length>0);req('o-benef',g('o-benef').length>0);
    req('o-docsj',g('o-docsj').length>0);req('o-iban',g('o-iban').length>0);
    req('o-cifb',CR.test(g('o-cifb')));req('o-banca',g('o-banca').length>0);
    if(!getOR().length){setS('Adăugați cel puțin un rând angajament.','err');ok=false;}
  }else{
    req('n-den',g('n-den').length>0);req('n-cif',CR.test(g('n-cif')));
    req('n-nrUnic',g('n-nrUnic').length>0);req('n-rev',g('n-rev').length>0);
    req('n-data',DR.test(g('n-data')));req('n-subtitlu',g('n-subtitlu').length>0);
    req('n-comp',g('n-comp').length>0);req('n-scurt',g('n-scurt').length>0);
    if(!getNV().length){setS('Adăugați cel puțin un rând la pct. 4.','err');ok=false;}
  }
  return ok;
}

/* Generate */
async function genPdf(ft){
  clrS();
  if(!valF(ft)){if(!document.querySelector('.status.err')?.innerHTML.length)setS('Verificați câmpurile marcate.','err');return;}
  const btn=document.getElementById('bgen-'+ft);
  if(!btn){setS('Eroare internă: buton negăsit. Reîncărcați pagina.','err');return;}
  btn.disabled=true;btn.innerHTML='<div class="spinner"></div> <span>Se generează...</span>';
  setS('Se generează PDF-ul...','info');
  const ctrl=new AbortController();
  const timeout=setTimeout(()=>ctrl.abort(),90000); // 90s timeout
  try{
    const data=ft==='ordnt'?colO():colN();
    const r=await fetch('/api/formulare/generate',{method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({formType:ft,data}),
      signal:ctrl.signal});
    clearTimeout(timeout);
    const j=await r.json();
    if(!r.ok||!j.ok){setS(j.errors?j.errors.join('; '):(j.message||j.error||'Eroare'),'err');return;}
    ST[ft].pdf=j.pdfBase64;ST[ft].name=j.fileName;
    const panel=document.getElementById('result-'+ft);panel.classList.add('show');
    document.getElementById('rname-'+ft).textContent=j.fileName;
    panel.scrollIntoView({behavior:'smooth',block:'nearest'});
    const dn=document.getElementById('ffn-'+ft);if(dn&&!dn.value)dn.value=j.fileName.replace('.pdf','');
    setS('PDF generat! Descărcați sau lansați fluxul de semnare.','ok');
  }catch(e){
    clearTimeout(timeout);
    if(e.name==='AbortError')setS('Timeout: generarea PDF a durat prea mult (>90s). Verificați template-ul.','err');
    else setS('Eroare: '+e.message,'err');
  }finally{btn.disabled=false;btn.innerHTML='<span>⚙ Generează PDF</span>';}
}

function dlPdf(ft){
  const{pdf,name}=ST[ft];if(!pdf)return;
  const a=document.createElement('a');a.href='data:application/pdf;base64,'+pdf;
  a.download=name||'formular_'+ft+'.pdf';a.click();
}
function showFF(ft){ mkFlow(ft); }
function mkFlow(ft){
  const{pdf,name}=ST[ft];
  if(!pdf){setS('Generați mai întâi PDF-ul.','err');return;}
  const dn=(g('ffn-'+ft)||'').trim()||(ST[ft]?.name||'').replace('.pdf','')||'Document_'+ft;
  if(!dn){setS('Introduceți numele documentului.','err');return;}
  const user=ST.user;
  if(!user?.email){setS('Utilizator necunoscut. Reîncărcați pagina.','err');return;}
  sessionStorage.setItem('docflow_prefill_name',dn);
  sessionStorage.setItem('docflow_prefill_email',user.email);
  sessionStorage.setItem('docflow_prefill_pdf',pdf);
  sessionStorage.setItem('docflow_prefill_type','tabel');
  sessionStorage.setItem('docflow_prefill_doc_id',ST.docId[ft]||'');
  sessionStorage.setItem('docflow_prefill_doc_type',ft);
  setS('Redirecționare către configurare flux...','info');
  setTimeout(()=>{
    const _alopCtx = window._alopContext;
    let _semUrl = '/semdoc-initiator.html?action=new_flow_prefill';
    if (_alopCtx?.alopId && ST.docId?.[ft]) {
      _semUrl += `&alop_id=${encodeURIComponent(_alopCtx.alopId)}`
               + `&alop_doc_type=${ft==='notafd'?'notafd':'ordnt'}`
               + `&prefill_doc_id=${encodeURIComponent(ST.docId[ft])}`
               + `&prefill_doc_type=${ft==='notafd'?'notafd':'ordnt'}`;
    }
    location.href = _semUrl;
  },600);
}

  // ── Exports onclick + cross-module ──────────────────────────────────────
  window._applyAutoFill     = _applyAutoFill;

  window.sw                 = sw;
  window.setS               = setS;
  window.clrS               = clrS;
  window.valF               = valF;
  window.genPdf             = genPdf;
  window.dlPdf              = dlPdf;
  window.showFF             = showFF;
  window.mkFlow             = mkFlow;

  window.addOR              = addOR;
  window.addNV              = addNV;
  window.addNP              = addNP;
  window.addNC              = addNC;
  window.getOR              = getOR;
  window.getNV              = getNV;
  window.getNP              = getNP;
  window.getNC              = getNC;
  window.calcORRow          = calcORRow;
  window.calcNVRow          = calcNVRow;
  window.calcNCRow          = calcNCRow;
  window.delR               = delR;

  window.colO               = colO;
  window.colN               = colN;
  window.upTot              = upTot;
  window.markE              = markE;

  window.p4toggle           = p4toggle;
  window.p5toggle           = p5toggle;
  window.p5SubToggle        = p5SubToggle;

  window.fMR                = fMR;
  window.pMR                = pMR;
  window.attachMoneyInput   = attachMoneyInput;

  window.showImg            = showImg;
  window.clrImg             = clrImg;
  window.fimg               = fimg;
  window.dov                = dov;
  window.dlv                = dlv;
  window.ddp                = ddp;
  window.addAtt             = addAtt;
  window.remAtt             = remAtt;

  window.df = window.df || {};
  window.df._formularCoreLoaded = true;
})();
