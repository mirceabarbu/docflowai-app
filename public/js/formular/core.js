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
  actorCompartiment:'', p2FilterByComp:undefined,
};
  window.imgs = {'o-cimg':null,'o-cimg2':null,'n-cimg':null};
  const ST   = window.ST;    // alias local (referință la același obiect)
  const imgs = window.imgs;  // alias local

  // ── Counters tabele — pe window pentru acces din doc.js/list.js ────────────
  window.oI=0;window.nVI=0;window.nPI=0;window.nCI=0;
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
  // v3.9.497 (Finding #1 audit Pas 3): bara de revizie e proprietate doar a DF (notafd).
  // O sincronizăm cu tab-ul: vizibilă doar când suntem pe notafd și avem doc încărcat.
  const _revBar=document.getElementById('df-revizie-header-bar');
  if(_revBar){
    if(tab==='notafd'&&ST?.docId?.notafd) _revBar.style.display='flex';
    else _revBar.style.display='none';
  }
  // locked-bar-ordnt/notafd au fost mutate în back-bar (header compact); curăță
  // bara inactivă ca să nu rămână mesajul vechi vizibil când se schimbă forma.
  const inactiveBar=document.getElementById('locked-bar-'+(tab==='ordnt'?'notafd':'ordnt'));
  if(inactiveBar){inactiveBar.className='locked-bar';inactiveBar.textContent='';}
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
// #128m — „cheia" unei zone de atașamente. Pentru blocul 0 (ORD) și pentru DF rămâne exact
// id-ul de element de azi ('o-alist', 'n-adata'…) ⇒ ZERO schimbare de comportament. Pentru
// blocurile 2+ de furnizor, care n-au id-uri (regula #128h), cheia e un token
// `bloc:<idx>:<rol>` rezolvat prin `data-role` în interiorul containerului `.ord-bloc`.
// `ctx` (elementul care a declanșat acțiunea) are PRIORITATE față de index: la ștergerea
// unui furnizor blocurile se renumerotează, deci un index capturat în onclick poate fi vechi.
function attKeyBloc(idx,rol){return 'bloc:'+idx+':'+rol;}
function isAttBlocKey(key){return typeof key==='string'&&key.indexOf('bloc:')===0;}
function attEl(key,ctx){
  if(!key)return null;
  if(!isAttBlocKey(key))return document.getElementById(key);
  const parts=String(key).split(':');
  const host=(ctx&&ctx.closest&&ctx.closest('.ord-bloc'))||document.querySelector(`.ord-bloc[data-bloc="${parts[1]}"]`);
  return host?host.querySelector(`[data-role="att-${parts[2]}"]`):null;
}
// Blocul căruia îi aparține o cheie de atașamente (0 pentru DF și pentru blocul 0 ORD).
function attBlocOf(key,ctx){
  const host=ctx&&ctx.closest&&ctx.closest('.ord-bloc');
  if(host)return Number(host.getAttribute('data-bloc'))||0;
  if(isAttBlocKey(key))return Number(String(key).split(':')[1])||0;
  return 0;
}
/* Capturi per bloc (#128n) — oglinda helperilor de atașamente de mai sus.
   Blocul 0 și DF-ul NU trec pe aici: ei rămân pe `imgs{}` + id-uri, byte-identic. */
function capZona(blocEl, slot){
  if(!blocEl)return null;
  const s=slot===2?2:1;
  return blocEl.querySelector(`[data-role="cap-zone"][data-cap-slot="${s}"]`);
}
// Data-URL-ul capturii unui bloc, citit din DOM. Întoarce null dacă nu e o captură reală.
function capSrcBloc(blocEl, slot){
  const img=capZona(blocEl,slot)?.querySelector('[data-role="cap-img"]');
  const src=img&&img.getAttribute('src');
  return (typeof src==='string'&&src.indexOf('data:image/')===0)?src:null;
}
function capSetBloc(blocEl, slot, dataUrl){
  const z=capZona(blocEl,slot);if(!z)return;
  const img=z.querySelector('[data-role="cap-img"]');
  const ph=z.querySelector('[data-role="cap-ph"]');
  if(!img)return;
  if(dataUrl){img.setAttribute('src',dataUrl);img.style.display='block';if(ph)ph.style.display='none';}
  else{img.removeAttribute('src');img.style.display='none';if(ph)ph.style.display='';}
}
// Captura blocului `i`, indiferent dacă e blocul 0 (hartă `imgs`) sau 2+ (DOM).
// SURSĂ UNICĂ: colO() și uploadCapturaBlocuri() citesc AMÂNDOUĂ de aici, ca să nu apară
// un al doilea adevăr între payload-ul de PDF și ce se urcă pe server.
function capturaBloc(i, slot){
  if(i===0)return imgs[slot===2?'o-cimg2':'o-cimg']||null;
  return capSrcBloc(blocEl(i), slot);
}
function addAtt(ev,lid,did){
  const files=ev.target.files;if(!files.length)return;
  const list=attEl(lid,ev.target);
  const dataEl=attEl(did,ev.target);
  if(!list||!dataEl)return;
  let cur=JSON.parse(dataEl.value||'[]');
  for(const f of files){
    const rd=new FileReader();
    rd.onload=e=>{
      const idx=cur.length;cur.push({name:f.name,type:f.type,data:e.target.result});
      dataEl.value=JSON.stringify(cur);
      // v3.9.654 (faza 2b): chip nesalvat randat prin renderFileItem (unificat DF/ORD)
      const holder=document.createElement('div');
      holder.innerHTML=renderFileItem({filename:f.name,canPreview:false,downloadHref:null,canDelete:true,deleteOnclick:`remAtt(${idx},'${lid}','${did}',this)`});
      list.appendChild(holder.firstElementChild);
      // v3.9.554 (B3): setarea programatică a input-ului ascuns nu emite 'input'/'change',
      // deci autosave-ul nu pornea — fișier atașat + navigare fără alt edit = pierdut.
      // Derivăm ft din did ('o-*' → ordnt, 'n-*' → notafd), consecvent cu remAttServer.
      // #128m: cheile de bloc ('bloc:N:data') sunt, prin construcție, doar ORD.
      window._scheduleAutoSaveDb?.((did.startsWith('o-')||isAttBlocKey(did))?'ordnt':'notafd');
    };
    rd.readAsDataURL(f);
  }
  ev.target.value='';
}
function remAtt(idx,lid,did,btn){
  const dataEl=attEl(did,btn);if(!dataEl)return;
  const cur=JSON.parse(dataEl.value||'[]');
  cur.splice(idx,1);dataEl.value=JSON.stringify(cur);
  btn.closest('.df-file-item')?.remove();
}

/* Dynamic rows */
let oI=0,nVI=0,nPI=0,nCI=0;
/* ── Formatare monetară ro-RO ─────────────────────────────────────────────── */
const pMR=v=>{if(v===null||v===undefined||v==='')return 0;const s=String(v).trim().replace(/\s/g,'').replace(/\./g,'').replace(',','.');const n=parseFloat(s);return isNaN(n)?0:n;};
const fMR=(v,d=2)=>{const n=typeof v==='string'?pMR(v):Number(v);if(isNaN(n))return'0,00';return n.toLocaleString('ro-RO',{minimumFractionDigits:d,maximumFractionDigits:d});};
function attachMoneyInput(inp,d=2){if(!inp||inp.dataset.moneyAttached==='1')return;inp.dataset.moneyAttached='1';inp.addEventListener('focus',()=>{if(inp.disabled||inp.readOnly)return;const raw=pMR(inp.value);inp.value=raw===0?'0':String(raw).replace('.',',');});inp.addEventListener('blur',()=>{if(inp.value===''||inp.value===null)return;inp.value=fMR(pMR(inp.value),d);});if(inp.value===''||inp.value==='0'){inp.value='0,00';}else if(inp.value!=='0,00'){inp.value=fMR(pMR(inp.value),d);}};
// #128h — tbody-ul țintă al unui rând ORD. `target` poate fi: nimic (blocul 0 — semnătura veche,
// apelată din markup prin onclick și din onDfSelect), un index de bloc, un element de bloc sau
// chiar tbody-ul. Blocul 0 rămâne `#o-tbody` (id-ul e neatins).
function _ordTbody(target){
  if(target===undefined||target===null)
    return document.getElementById('o-tbody')||blocEl(0)?.querySelector('tbody')||null;
  if(typeof target==='number')return blocEl(target)?.querySelector('tbody')||null;
  if(target.tagName==='TBODY')return target;
  const bl=target.closest?.('[data-bloc]')||target;
  return bl.querySelector?.('tbody')||null;
}
function addOR(target){const i=window.oI++;const tr=document.createElement('tr');tr.id='or-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="11" data-f="cod_angajament"/></td><td><input type="text" maxlength="3" data-f="indicator_angajament"/></td><td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="cod_SSI"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="receptii" oninput="calcORRow(this)"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_anterioare" oninput="calcORRow(this)"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="suma_ordonantata_plata" oninput="calcORRow(this)"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="receptii_neplatite" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default" title="5=(col.2)-(col.3)-(col.4) — calculat automat"/></td><td><button class="bdel" onclick="delR('or-${i}');upTot()">✕</button></td>`;
  const _tb=_ordTbody(target);
  if(!_tb)return;
  _tb.appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));
  // Coduri de angajament canonice cu MAJUSCULE la blur — ORD.rows e câmpul potrivit de OPME.
  const oang=tr.querySelector('[data-f="cod_angajament"]');
  const oind=tr.querySelector('[data-f="indicator_angajament"]');
  [oang,oind].forEach(el=>{if(el)el.addEventListener('blur',()=>_upperAng(el));});
  // Col.4 (suma ordonanțată) editabilă pentru P1 DOAR în pending_p2 (anticipare).
  // În draft/returnat P1 are deja lockAll(false) global. În completed/aprobat: blocat.
  if(ST.docRole?.ordnt==='p1'&&ST.docStatus?.ordnt==='pending_p2'){
    tr.querySelectorAll('[data-f="suma_ordonantata_plata"]').forEach(e=>{e.disabled=false;});
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
// #128g: doar rândurile pre-populate din DF poartă ctrl_idx (ștampilat în onDfSelect / la
// reîncărcarea documentului). Un rând adăugat manual prin addOR() rămâne FĂRĂ — serverul
// cade pe derivarea pozițională, exact ca înainte. (Extras în `_ordRowOf`, #128h.)
// getOR() rămâne pe blocul 0 (`#o-tbody`) — e folosită de call-site-uri nemigrate; lista plată
// multi-bloc se ia din getOrdRowsAll().
function getOR(){return[...document.querySelectorAll('#o-tbody tr')].map(_ordRowOf);}

function addNV(){const i=window.nVI++;const tr=document.createElement('tr');tr.id='nv-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="150" data-f="element_fd" style="min-width:90px"/></td><td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="codSSI" list="ssi-codes-list"/></td><td><input type="text" maxlength="500" data-f="param_fd" style="min-width:80px"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="valt_rev_prec"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="influente"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="valt_actualiz" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default"/></td><td><button class="bdel" onclick="delR('nv-${i}');upTot()">✕</button></td>`;
  document.getElementById('n-vtbody').appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));
  const c5=tr.querySelector('[data-f="valt_rev_prec"]');
  const c6=tr.querySelector('[data-f="influente"]');
  if(c5)c5.addEventListener('input',()=>calcNVRow(c5));
  if(c6)c6.addEventListener('input',()=>calcNVRow(c6));
}
function getNV(){return[...document.querySelectorAll('#n-vtbody tr')].map(tr=>{const o={};tr.querySelectorAll('input[data-f]').forEach(i=>o[i.dataset.f]=i.dataset.money?String(pMR(i.value)||0):i.value);return o;});}

function addNP(){const i=window.nPI++;const tr=document.createElement('tr');tr.id='np-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="codSSI" list="ssi-codes-list"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_ani_precedenti" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_ancrt" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_an_np1" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_an_np2" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_an_np3" oninput="upTot()"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="plati_estim_ani_ulter" oninput="upTot()"/></td><td><button class="bdel" onclick="delR('np-${i}');upTot()">✕</button></td>`;
  document.getElementById('n-ptbody').appendChild(tr);
  tr.querySelectorAll('[data-money]').forEach(inp=>attachMoneyInput(inp));}
function getNP(){return[...document.querySelectorAll('#n-ptbody tr')].map(tr=>{const o={};tr.querySelectorAll('input[data-f]').forEach(i=>o[i.dataset.f]=i.dataset.money?String(pMR(i.value)||0):i.value);return o;});}

// Coduri de angajament CANONICE cu MAJUSCULE (col.1/2 din Sec.B rows_ctrl). La BLUR (nu la
// input — ar muta cursorul la fiecare tastă). Serverul e poarta reală (angajament-normalize.mjs);
// asta e doar UX. Dacă valoarea era deja canonică, NU dispecerizăm 'change' → fără autosave degeaba.
function _upperAng(el){
  const v=el.value.trim().toUpperCase();
  if(v===el.value)return;
  el.value=v;
  el.dispatchEvent(new Event('change',{bubbles:true}));  // persistă valoarea canonică (autosave)
}
function addNC(){const i=window.nCI++;const tr=document.createElement('tr');tr.id='nc-'+i;
  tr.innerHTML=`<td><input type="text" maxlength="11" data-f="cod_angajament"/></td><td><input type="text" maxlength="3" data-f="indicator_angajament"/></td><td><input type="text" maxlength="10" data-f="program"/></td><td><input type="text" maxlength="15" data-f="cod_SSI" list="ssi-codes-list"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_ang_af_rvz_prc"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="influente_c6"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_ang_act" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default" title="7=5+6 — calculat automat"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_bug_af_rvz_prc"/></td><td><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="influente_c9"/></td><td style="background:rgba(255,255,255,0.07)"><input type="text" inputmode="decimal" data-money="true" value="0,00" data-f="sum_rezv_crdt_bug_act" readonly tabindex="-1" style="background:rgba(255,255,255,0.07);text-align:right;cursor:default" title="10=8+9 — calculat automat"/></td><td><button class="bdel" onclick="delR('nc-${i}');upTot()">✕</button></td>`;
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
  const cang=tr.querySelector('[data-f="cod_angajament"]');
  const cind=tr.querySelector('[data-f="indicator_angajament"]');
  [cang,cind].forEach(el=>{if(el)el.addEventListener('blur',()=>_upperAng(el));});
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
  _updateSumaPlatiIndicator();
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
  _updateSumaPlatiIndicator();
}

function _prefillPtFromVt() {
  const srcRows = [...document.querySelectorAll('#n-vtbody tr')];
  if (!srcRows.length) return;
  srcRows.forEach((srcTr, i) => {
    // Adaugă rând în ptbody dacă nu există
    const existing = document.querySelectorAll('#n-ptbody tr');
    if (!existing[i]) addNP();
    const dstTr = document.querySelectorAll('#n-ptbody tr')[i];
    if (!dstTr) return;
    const progSrc = srcTr.querySelector('[data-f="program"]');
    const ssiSrc  = srcTr.querySelector('[data-f="codSSI"]');
    const progDst = dstTr.querySelector('[data-f="program"]');
    const ssiDst  = dstTr.querySelector('[data-f="codSSI"]');
    // Completează doar dacă câmpul destinație e gol
    if (progSrc && progDst && !progDst.value) progDst.value = progSrc.value;
    if (ssiSrc  && ssiDst  && !ssiDst.value)  ssiDst.value  = ssiSrc.value;
  });
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
  // Auto-completare Program + Cod SSI din tabelul valori (Pct. 4)
  if(cuplati) _prefillPtFromVt();
  _updateSumaPlatiIndicator();
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
  // Soft-warning depășire credite bugetare la completarea col.10 (CAB). No-op
  // dacă nu suntem în modul de completare Sec.B (buget nu e încărcat).
  if(typeof window._checkSecBBuget==='function')window._checkSecBBuget();
}

/* Totals */
function sf(bid,f){return[...document.querySelectorAll(`#${bid} input[data-f="${f}"]`)].reduce((s,i)=>s+pMR(i.value),0);}
function st2(id,v){const e=document.getElementById(id);if(e)e.textContent=fMR(v,2);}
// #128h — totalurile ORD se calculează PER BLOC, în celulele `[data-tot]` ale blocului.
// Celulele blocului 0 poartă AMBELE (`id="o-t-*"` istoric + `data-tot` nou) ⇒ scrise de
// ambele căi, cu aceeași valoare.
const ORD_TOT_FLD={rec:'receptii',plati:'plati_anterioare',suma:'suma_ordonantata_plata',neplat:'receptii_neplatite'};
function _sfIn(root,f){return[...root.querySelectorAll(`input[data-f="${f}"]`)].reduce((s,i)=>s+pMR(i.value),0);}
function upTotBlocuri(){
  blocEls().forEach(el=>{
    Object.entries(ORD_TOT_FLD).forEach(([k,f])=>{
      const cell=el.querySelector(`[data-tot="${k}"]`);
      if(cell)cell.textContent=fMR(_sfIn(el,f),2);
    });
  });
}
function upTot(){
  st2('o-t-rec',sf('o-tbody','receptii'));st2('o-t-plati',sf('o-tbody','plati_anterioare'));
  st2('o-t-suma',sf('o-tbody','suma_ordonantata_plata'));st2('o-t-neplat',sf('o-tbody','receptii_neplatite'));
  upTotBlocuri();
  st2('n-t-vprec',sf('n-vtbody','valt_rev_prec'));st2('n-t-vinfl',sf('n-vtbody','influente'));st2('n-t-vact',sf('n-vtbody','valt_actualiz'));
  st2('n-t-pprec',sf('n-ptbody','plati_ani_precedenti'));st2('n-t-pancrt',sf('n-ptbody','plati_estim_ancrt'));
  st2('n-t-pnp1',sf('n-ptbody','plati_estim_an_np1'));st2('n-t-pnp2',sf('n-ptbody','plati_estim_an_np2'));
  st2('n-t-pnp3',sf('n-ptbody','plati_estim_an_np3'));st2('n-t-pulter',sf('n-ptbody','plati_estim_ani_ulter'));
  st2('n-t-c5',sf('n-ctbody','sum_rezv_crdt_ang_af_rvz_prc'));st2('n-t-c6',sf('n-ctbody','influente_c6'));
  st2('n-t-c7',sf('n-ctbody','sum_rezv_crdt_ang_act'));st2('n-t-c8',sf('n-ctbody','sum_rezv_crdt_bug_af_rvz_prc'));
  st2('n-t-c9',sf('n-ctbody','influente_c9'));st2('n-t-c10',sf('n-ctbody','sum_rezv_crdt_bug_act'));
  // Atenționare inline buget an exercițiu ORD (soft). No-op dacă nu e încărcat contextul
  // (pagină DF, sau ORD fără df_id). upTot e chokepoint-ul tuturor mutațiilor de rânduri ORD
  // (input col.4 → calcORRow→upTot, add, del), deci o singură inserție acoperă tot.
  if(typeof window._checkOrdBuget==='function')window._checkOrdBuget();
  if(typeof window._updateSumaPlatiIndicator==='function')window._updateSumaPlatiIndicator();
}

/* ── Verificare suma plăți (pct.5) == total angajament actualizat (pct.4) ─────────────
   Conform logicii ALOP / OMF 1140/2025, suma TUTUROR benzilor din tabelul de planificare a
   plăților (pct.5: ani precedenți, an curent, N+1..N+3, ani ulteriori) trebuie să fie egală cu
   totalul „Val. totală actualizată" din pct.4. Verificarea NU se aplică pentru toate bifele pct.5:
   pentru „Stingere angajamente în exercițiul curent" tabelul de planificare e DEZACTIVAT (suma 0)
   → gate-ul s-ar declanșa fals; deci aplicabil=false acolo. */
const _P5_BANDS=['plati_ani_precedenti','plati_estim_ancrt','plati_estim_an_np1','plati_estim_an_np2','plati_estim_an_np3','plati_estim_ani_ulter'];

/*__P5_PURE_START__*/
/* Funcție PURĂ (fără DOM) — decide rezultatul din starea numerică + bifele pct.4/pct.5.
   state: { sumaAngajament, sumaPlati, cuang, cuplati, faraplati, stingere }.
   Întoarce { ok, sumaPlati, sumaAngajament, diferenta, aplicabil }.
   aplicabil=true DOAR când tabelul de plăți e activ/relevant:
     - „Cu angajamente" bifat ȘI NU „Stingere" (tabel disabled),
     - sub-opțiunea „Cu plăți" (tabel garantat populat de validarea ≥1 rând),
       SAU „Fără plăți" dar cu benzi efectiv completate (sumaPlati>0) — altfel un tabel intenționat
       gol ar bloca fals,
     - și există un angajament de comparat (sumaAngajament>0). */
function evalSumaPlatiPure(state){
  const r2=v=>Math.round((Number(v)||0)*100)/100;
  const sumaAngajament=r2(state&&state.sumaAngajament);
  const sumaPlati=r2(state&&state.sumaPlati);
  const diferenta=r2(sumaPlati-sumaAngajament);
  const cuang=!!(state&&state.cuang), stingere=!!(state&&state.stingere);
  const cuplati=!!(state&&state.cuplati), faraplati=!!(state&&state.faraplati);
  const tabelActiv=cuang && !stingere && (cuplati || (faraplati && sumaPlati>0));
  const aplicabil=tabelActiv && sumaAngajament>0;
  const ok=Math.abs(diferenta)<=0.01; // toleranță bani (2 zecimale, floating-point)
  return { ok, sumaPlati, sumaAngajament, diferenta, aplicabil };
}
/*__P5_PURE_END__*/

/* Citește starea din DOM și deleagă la funcția pură. */
function verificaSumaPlati(){
  const cb=id=>!!document.getElementById(id)?.checked;
  // Total angajament actualizat (pct.4): „Se stabilește" → suma col.7 din tabel;
  // „Rămâne în suma de" → valoarea fixă din input.
  const sumaAngajament=cb('n-ck-stab')
    ? sf('n-vtbody','valt_actualiz')
    : (cb('n-ck-ramane') ? pMR(document.getElementById('n-ramana')?.value) : sf('n-vtbody','valt_actualiz'));
  const sumaPlati=_P5_BANDS.reduce((s,f)=>s+sf('n-ptbody',f),0);
  return evalSumaPlatiPure({
    sumaAngajament, sumaPlati,
    cuang:cb('n-ck-cuang'), cuplati:cb('n-ck-cuplati'),
    faraplati:cb('n-ck-faraplati'), stingere:cb('n-ck-sting')
  });
}

/* Actualizează indicatorul vizual sub tabelul pct.5 (verde=coincide / roșu=diferă). */
function _updateSumaPlatiIndicator(){
  const box=document.getElementById('n-p5-check');
  if(!box)return;
  const r=verificaSumaPlati();
  if(!r.aplicabil){box.className='p5-suma-check';box.textContent='';return;}
  if(r.ok){
    box.className='p5-suma-check ok';
    box.textContent=`✓ Plăți planificate (${fMR(r.sumaPlati)} lei) = Angajament total actualizat (${fMR(r.sumaAngajament)} lei).`;
  }else{
    box.className='p5-suma-check bad';
    box.textContent=`⛔ Suma planificării plăților (${fMR(r.sumaPlati)} lei) NU coincide cu totalul angajamentelor actualizat (${fMR(r.sumaAngajament)} lei) — diferență ${fMR(r.diferenta)} lei. Corectați tabelul de plăți înainte de a trimite la P2.`;
  }
}

/* FEATURE buget multi-anual (v3.9.558): etichetele benzilor de plăți afișează anul absolut
   calculat din an_referinta (banda „an curent” = an_referinta; N+1 = +1; etc.). Sincronizat
   la încărcare, la schimbarea câmpului și la creare (default = anul curent). */
function anrefSync(){
  const inp=document.getElementById('n-anref');
  let y=parseInt(inp?.value,10);
  if(!y||isNaN(y)){y=new Date().getFullYear();if(inp&&!inp.value)inp.value=y;}
  const set=(id,txt)=>{const e=document.getElementById(id);if(e)e.textContent=txt;};
  set('n-th-pprec',`Plăți efectuate în anii precedenți (< ${y})`);
  set('n-th-pancrt',`Plăți estimate în anul curent (${y})`);
  set('n-th-pnp1',`Estimări an N+1 (${y+1})`);
  set('n-th-pnp2',`Estimări an N+2 (${y+2})`);
  set('n-th-pnp3',`Estimări an N+3 (${y+3})`);
  set('n-th-pulter',`Ani ulteriori (> ${y+3})`);
}

/* Collect */
const g=id=>(document.getElementById(id)?.value||'').trim();
const cb=id=>document.getElementById(id)?.checked?'1':'';

// #128f — rezolvare pe bloc: colO()/valF() nu mai citesc câmpurile beneficiarului ORD
// după id global, ci în interiorul containerului [data-bloc="i"].
// #128h — containerul e acum `.ord-bloc[data-bloc="i"]` (înfășoară BLOC P1 + BLOC P2), iar
// blocurile 2+ sunt FRAȚI ai lui în `#ord-blocuri`. `#form-ordnt` NU mai poartă `data-bloc`:
// altfel blocurile noi ar fi DESCENDENȚI ai blocului 0 și rândurile lor s-ar scurge în el.
const ORD_BLOC_FLDS=['nr_unic_inreg','beneficiar','documente_justificative','iban_beneficiar',
  'cif_beneficiar','banca_beneficiar','inf_pv_plata','inf_pv_plata1'];
// #128h — `nr_unic_inreg` (#o-nrUnic) e UNIC PE DOCUMENT (un singur DF per ORD) și trăiește în
// BLOCUL ANTET, în afara containerelor de bloc ⇒ se citește global, pentru TOATE blocurile.
// Rezolvarea rămâne „întâi în bloc, apoi global" ca să nu schimbe comportamentul acolo unde
// câmpul chiar există în bloc (fixture-urile #128f).
const ORD_FLD_GLOBAL_ID={nr_unic_inreg:'o-nrUnic'};
const blocEls=()=>[...document.querySelectorAll('[data-bloc]')]
  .sort((a,b)=>(Number(a.getAttribute('data-bloc'))||0)-(Number(b.getAttribute('data-bloc'))||0));
const blocEl=(i)=>document.querySelector(`[data-bloc="${i}"]`);
function blocFldEl(i,fld){
  const el=blocEl(i)?.querySelector(`[data-fld="${fld}"]`);
  if(el)return el;
  const gid=ORD_FLD_GLOBAL_ID[fld];
  return gid?document.getElementById(gid):null;
}
const bg=(i,fld)=>(blocFldEl(i,fld)?.value||'').trim();
// Extragerea unui rând ORD din DOM — sursă UNICĂ pentru getOR()/rowsOfBloc()/getOrdRowsAll().
// `ctrl_idx` e pointer (#128g), nu câmp: nu are input, se citește din dataset.
function _ordRowOf(tr){
  const o={};
  tr.querySelectorAll('input[data-f]').forEach(inp=>o[inp.dataset.f]=inp.dataset.money?String(pMR(inp.value)||0):inp.value);
  const ci=tr.dataset.ctrlIdx;if(ci!==undefined&&ci!=='')o.ctrl_idx=Number(ci);
  return o;
}
function rowsOfBloc(i){
  const el=blocEl(i);if(!el)return[];
  return[...el.querySelectorAll('tbody tr')].map(_ordRowOf);
}
// #128h — lista PLATĂ de rânduri trimisă la server: blocurile concatenate în ordinea `bloc_idx`,
// fiecare rând marcat cu blocul lui. Fallback (niciun container [data-bloc] în DOM) = vechiul
// getOR() cu bloc_idx:0, ca să nu pice pagini/teste fără markup de bloc.
function getOrdRowsAll(){
  const els=blocEls();
  if(!els.length)return getOR().map(r=>({...r,bloc_idx:0}));
  const out=[];
  els.forEach(el=>{
    const bi=Number(el.getAttribute('data-bloc'))||0;
    [...el.querySelectorAll('tbody tr')].forEach(tr=>out.push({..._ordRowOf(tr),bloc_idx:bi}));
  });
  return out;
}

/* ── #128h — blocuri ORD (mai mulți furnizori pe același ORD) ────────────────
 * Blocurile 2+ se construiesc din ȘABLONUL de mai jos, NU prin cloneNode din blocul 0:
 *   - clonarea ar duplica TOATE id-urile (o-benef, o-tbody, o-cimg…) — DOM invalid, iar
 *     restul codului (doc.js/list.js/lockOrdIdentityCols, care caută după id) ar începe să
 *     nimerească aleator;
 *   - șablonul emite EXCLUSIV `data-fld` / `data-f` / `data-tot`, ZERO atribute `id` ⇒ tot
 *     codul nemigrat continuă să vadă exact blocul 0, adică exact comportamentul de azi;
 *   - #128n: șablonul conține ACUM secțiunea de captură, marcată prin `data-role="cap-*"`
 *     (⛔ niciun id). Datele NU trec prin harta globală `imgs{}` — ea rămâne la exact
 *     cele 3 chei istorice (`o-cimg`, `o-cimg2`, `n-cimg`). Pentru blocurile 2+ sursa de
 *     adevăr e `src`-ul elementului `<img data-role="cap-img">`, adică DOM-ul blocului.
 *     Motivul e concret: la ștergerea unui furnizor blocurile se RENUMEROTEAZĂ, iar o hartă
 *     cheiată pe index ar reatribui tăcut captura altui furnizor. Datele care călătoresc cu
 *     nodul DOM nu pot face asta — exact motivul pentru care atașamentele pending stau în
 *     `<input data-role="att-data">`, nu într-o hartă.
 *   - `blocuri` JSONB rămâne la exact 8 chei (atributele XSD): capturile sunt BYTEA în
 *     `formulare_capturi`, cheiate pe (form_type, form_id, slot, bloc_idx).
 */
function _sablonBloc(idx){
  const wrap=document.createElement('div');
  wrap.className='ord-bloc';
  wrap.setAttribute('data-bloc',String(idx));
  wrap.innerHTML=`
<div class="df-block df-block-p1">
  <div class="df-block-hdr">
    <span class="df-badge df-badge-p1">P1</span>
    <span class="df-block-title" data-bloc-title>Furnizor ${idx+1}</span>
    <button type="button" class="df-action-btn ord-bloc-del" data-del-bloc title="Șterge acest furnizor">✕ Șterge furnizorul</button>
  </div>
  <div class="df-block-body">
    <div class="df-row df-row-1">
      <div>
        <div class="dl req">Beneficiar</div>
        <!-- #128j — elementele auxiliare poartă DOAR data-role (fără id): comportamentele
             „vii" (autocomplete, badge ANAF, spinner) le rezolvă prin bloc, nu prin id. -->
        <div class="ac-wrap">
          <textarea class="dt" maxlength="150" rows="2" autocomplete="off" data-fld="beneficiar"></textarea>
          <div class="ac-drop" data-role="benef-drop"></div>
          <div style="margin-top:6px;min-height:0;" aria-live="polite" data-role="benef-status"></div>
        </div>
      </div>
    </div>
    <div class="df-row df-row-1">
      <div>
        <div class="dl req">Documente justificative <span style="font-weight:400;font-size:10px">(max 90 car.)</span></div>
        <input class="di" maxlength="90" data-fld="documente_justificative"/>
      </div>
    </div>
    <!-- #128m — zonă de atașamente per furnizor, identică funcțional cu a blocului 0, dar
         marcată EXCLUSIV prin data-role (⛔ niciun id — regula #128h). Butonul și input-ul
         de fișier NU au handler inline: se leagă prin delegare pe #ord-blocuri (list.js),
         ca blocurile restaurate din draft sau recreate la redeschidere să fie acoperite
         automat, fără cablare la creare. -->
    <div class="att-zone"><div class="att-list" data-role="att-list"></div></div>
    <div class="att-br">
      <button type="button" class="att-btn" data-role="att-btn"><svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-paperclip"/></svg> Atașează fișiere</button>
      <input type="file" class="att-inp" data-role="att-input" multiple/>
    </div>
    <input type="hidden" data-role="att-data" value="[]"/>
    <div class="doc-hr"></div>
    <div class="df-row df-row-3">
      <div>
        <div class="dl req">CIF beneficiar <span data-role="cifb-spin" style="display:none;color:var(--df-text-3);font-size:.78rem;margin-left:6px">⏳</span></div>
        <input class="di" maxlength="12" autocomplete="off" data-fld="cif_beneficiar"/>
      </div>
      <div>
        <div class="dl req">IBAN beneficiar</div>
        <input class="di" maxlength="24" placeholder="RO49AAAA..." data-fld="iban_beneficiar"/>
      </div>
      <div>
        <div class="dl req">Bancă beneficiar</div>
        <input class="di" maxlength="100" data-fld="banca_beneficiar"/>
      </div>
    </div>
    <div class="df-row df-row-2">
      <div>
        <div class="dl">Informații privind plata</div>
        <input class="di" maxlength="70" data-fld="inf_pv_plata"/>
      </div>
      <div>
        <div class="dl">Informații privind plata (cont.)</div>
        <input class="di" maxlength="70" data-fld="inf_pv_plata1"/>
      </div>
    </div>
  </div>
</div>
<div class="df-block df-block-p2">
  <div class="df-block-hdr">
    <span class="df-badge df-badge-p2">P2</span>
    <span class="df-block-title">Tabel angajamente — furnizorul de mai sus</span>
  </div>
  <div class="df-block-body">
    <div style="overflow-x:auto;margin-bottom:6px">
    <table class="doc-t">
      <thead>
        <tr>
          <th>Cod<br>angajament</th><th>Indicator<br>angajament</th><th>Program</th><th>Cod SSI</th>
          <th>Recepții<br>(lei)</th><th>Plăți anterioare<br>(lei)</th>
          <th>Suma ordonantată<br>la plată (lei)</th>
          <th>Recepții neplatite (lei)<br><small style="font-weight:400">5=(col.2)-(col.3)-(col.4)</small></th>
          <th style="width:22px"></th>
        </tr>
      </thead>
      <tbody></tbody>
      <tfoot>
        <tr class="df-total">
          <td class="tot">TOTAL</td><td class="cx">X</td><td class="cx">X</td><td class="cx">X</td>
          <td class="num" data-tot="rec">0,00</td>
          <td class="num" data-tot="plati">0,00</td>
          <td class="num" data-tot="suma">0,00</td>
          <td class="num" data-tot="neplat">0,00</td>
          <td><button type="button" class="badd" data-add-row title="Adaugă rând">+</button></td>
        </tr>
      </tfoot>
    </table>
    </div>
    <!-- #128o — bannerul de depășire de buget, per bloc. Textul e IDENTIC în toate blocurile:
         bugetul e unul singur pe document (un ORD are un singur DF), deci depășirea e a
         documentului. Fără el, utilizatorul din blocul 2 vede doar rânduri roșii fără motiv. -->
    <div class="secb-buget-warn" data-role="buget-warn" style="display:none"></div>
    <!-- #128n — capturi per furnizor. Marcate EXCLUSIV prin data-role (⛔ niciun id — regula
         #128h). Handlerele NU sunt inline: se leagă prin delegare pe #ord-blocuri (list.js),
         ca blocurile adăugate manual sau recreate de renderOrdBlocuri să fie acoperite automat.
         Atributul src al lui <img data-role="cap-img"> ESTE sursa de adevăr a capturii. -->
    <div class="cap-lbl">Captură imagine din sistemul de control al angajamentelor bugetare (anexă la ordonanțarea de plată)</div>
    <div class="cap-zone" data-role="cap-zone" data-cap-slot="1">
      <input type="file" accept="image/*" data-role="cap-input"/>
      <div class="cap-ph" data-role="cap-ph"><div class="ico">🖼</div><p>Clic sau trageți o captură de ecran</p><p style="font-size:10px;margin-top:1px">PNG · JPG · BMP</p></div>
      <img class="cap-img" data-role="cap-img"/>
    </div>
    <div class="cap-br"><button type="button" class="att-btn" data-role="cap-clr" data-cap-slot="1"><svg class="df-ic"><use href="/icons.svg?v=3.9.693#ico-x"/></svg>Șterge imaginea</button></div>
    <div class="cap-lbl" style="margin-top:10px">Captură "Informații complete contract" din sistemul de control al angajamentelor bugetare</div>
    <div class="cap-zone" data-role="cap-zone" data-cap-slot="2">
      <input type="file" accept="image/*" data-role="cap-input"/>
      <div class="cap-ph" data-role="cap-ph"><div class="ico">🖼</div><p>Clic sau trageți o captură de ecran</p><p style="font-size:10px;margin-top:1px">PNG · JPG · BMP</p></div>
      <img class="cap-img" data-role="cap-img"/>
    </div>
    <div class="cap-br"><button type="button" class="att-btn" data-role="cap-clr" data-cap-slot="2"><svg class="df-ic"><use href="/icons.svg?v=3.9.693#ico-x"/></svg>Șterge imaginea</button></div>
  </div>
</div>`;
  const del=wrap.querySelector('[data-del-bloc]');
  if(del)del.addEventListener('click',()=>delBlocOrd(wrap));
  const add=wrap.querySelector('[data-add-row]');
  if(add)add.addEventListener('click',()=>{addOR(wrap);upTot();});
  return wrap;
}

// Rândurile pre-populate din `rows_ctrl`-ul DF-ului legat — EXTRAS din onDfSelect (list.js),
// ca blocurile noi să folosească exact aceeași logică (inclusiv ștampila `ctrl_idx` din #128g).
const ORD_IDENT_FLDS=['cod_angajament','indicator_angajament','program','cod_SSI'];
function prefillOrdRowsFromCtrl(rows,target,opts){
  const tbody=_ordTbody(target);
  if(!tbody)return 0;
  const list=Array.isArray(rows)?rows:[];
  list.forEach((row,idx)=>{
    addOR(tbody);
    const tr=tbody.querySelector('tr:last-child');
    if(!tr)return;
    // #128g: pointer către rândul sursă din rows_ctrl (serverul derivă identitatea din
    // ctrlRows[ctrl_idx], nu din poziția în lista plată — esențial la ORD multi-bloc).
    tr.dataset.ctrlIdx=String(idx);
    ORD_IDENT_FLDS.forEach(f=>{
      const inp=tr.querySelector(`[data-f="${f}"]`);
      if(!inp)return;
      if(row[f]!=null)inp.value=row[f];
      if(opts&&opts.readOnly){
        inp.readOnly=true;inp.tabIndex=-1;
        inp.title='Preluat din DF-ul aprobat — nu poate fi modificat';
      }
    });
  });
  return list.length;
}

// Cache-ul rows_ctrl al DF-ului legat (setat de onDfSelect); folosit la crearea unui bloc nou.
let _ordDfCtrlRows=null;
function setOrdDfCtrlRows(rows){_ordDfCtrlRows=Array.isArray(rows)?rows:null;}
async function _getOrdDfCtrlRows(){
  if(Array.isArray(_ordDfCtrlRows))return _ordDfCtrlRows;
  const dfId=(document.getElementById('o-df-id')?.value||'').trim();
  if(!dfId)return[];
  try{
    const r=await fetch(`/api/formulare-df/${encodeURIComponent(dfId)}`,{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.document)return[];
    const rows=Array.isArray(j.document.rows_ctrl)?j.document.rows_ctrl:JSON.parse(j.document.rows_ctrl||'[]');
    _ordDfCtrlRows=rows;
    return rows;
  }catch(_){return[];}
}

function _ordBlocHost(){return document.getElementById('ord-blocuri');}
function _ordBlocList(){
  const host=_ordBlocHost();
  return[...(host||document).querySelectorAll('.ord-bloc')];
}
// Renumerotare CONTIGUĂ (0,1,2,…) în ordinea din DOM, după orice adăugare/ștergere.
function _renumberOrdBlocuri(){
  _ordBlocList().forEach((el,i)=>{
    el.setAttribute('data-bloc',String(i));
    const t=el.querySelector('[data-bloc-title]');
    if(t)t.textContent=`Furnizor ${i+1}`;
    const d=el.querySelector('[data-del-bloc]');
    if(d)d.style.display=i===0?'none':'';  // blocul 0 NU poate fi șters
  });
}
async function addBlocOrd(){
  const host=_ordBlocHost();
  if(!host)return null;
  // Formular blocat (document completed/aprobat, sau rol fără drept de editare): lockAll()
  // dezactivează input-urile blocului 0 — nu adăugăm furnizori peste un formular blocat.
  const probe=blocEl(0)?.querySelector('[data-fld="beneficiar"]');
  if(probe&&probe.disabled)return null;
  const el=_sablonBloc(_ordBlocList().length);
  host.appendChild(el);
  const rows=await _getOrdDfCtrlRows();
  if(rows.length)prefillOrdRowsFromCtrl(rows,el,{readOnly:true});
  else addOR(el);
  // #128k — blocul adăugat DUPĂ ce prefill-ul a rulat primește și el „plăți anterioare"
  // (col.3 e a angajamentului, nu a furnizorului), din valoarea MEMOIZATĂ în doc.js —
  // fără un al doilea fetch pe /api/alop/:id.
  if(typeof window.applyPlatiAntPrefill==='function')window.applyPlatiAntPrefill(el);
  _renumberOrdBlocuri();
  upTot();
  if(typeof window._draftSchedule==='function')window._draftSchedule('ordnt');
  return el;
}
function delBlocOrd(target){
  const el=target?.closest?.('.ord-bloc')||target;
  if(!el||!el.parentNode)return false;
  if((el.getAttribute('data-bloc')||'0')==='0')return false;  // blocul 0 e neștergibil
  if(typeof confirm==='function'&&!confirm('Ștergeți acest furnizor, împreună cu rândurile lui?'))return false;
  el.parentNode.removeChild(el);
  _renumberOrdBlocuri();
  upTot();
  if(typeof window._draftSchedule==='function')window._draftSchedule('ordnt');
  return true;
}
// Recreează blocurile 2+ (fără rânduri) dintr-o listă `blocuri` (server sau draft) și le umple
// câmpurile. Blocul 0 NU e atins — el se populează în continuare prin id-uri (sv()).
// Întoarce lista de containere, indexată pe bloc.
function renderOrdBlocuri(blocuri){
  const host=_ordBlocHost();
  resetOrdBlocuri();
  const list=Array.isArray(blocuri)?blocuri:[];
  if(host){
    list.slice(1).forEach((b,k)=>{
      const el=_sablonBloc(k+1);
      host.appendChild(el);
      ORD_BLOC_FLDS.forEach(f=>{
        const inp=el.querySelector(`[data-fld="${f}"]`);
        if(inp&&b&&b[f]!=null)inp.value=b[f];
      });
    });
  }
  _renumberOrdBlocuri();
  return _ordBlocList();
}
// Revenire la un singur bloc (document nou / resetare formular). Blocul 0 rămâne intact.
function resetOrdBlocuri(){
  _ordBlocList().slice(1).forEach(el=>el.parentNode&&el.parentNode.removeChild(el));
  setOrdDfCtrlRows(null);
  _renumberOrdBlocuri();
}

function colO(){
  const docFd=blocEls().map((_,i)=>{
    const o={};ORD_BLOC_FLDS.forEach(f=>o[f]=bg(i,f));o.rowTfd=rowsOfBloc(i);return o;
  });
  return{
    Cif:g('o-cif'),DenInstPb:g('o-den'),NrOrdonantPl:g('o-nr'),DataOrdontPl:g('o-data'),
    // #128n — cele două chei istorice rămân în payload (blocul 0), dar sunt derivate din
    // ACEEAȘI funcție ca restul blocurilor ⇒ o singură sursă, două proiecții. Serverul
    // preferă `capturiBlocuri` când există și cade pe ele când lipsește (client din cache).
    captureImageBase64:capturaBloc(0,1),
    captureImageBase64_2:capturaBloc(0,2),
    capturiBlocuri:blocEls().map((_,i)=>({c1:capturaBloc(i,1),c2:capturaBloc(i,2)})),
    attachments:JSON.parse(document.getElementById('o-adata').value||'[]'),
    docFd,
  };
}

function colN(){return{
  Cif:g('n-cif'),DenInstPb:g('n-den'),SubtitluDF:g('n-subtitlu'),
  NrUnicInreg:g('n-nrUnic'),Revizuirea:g('n-rev'),DataRevizuirii:g('n-data'),
  ckbx_oblig_tert:cb('n-ck-oblig'),
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
    sum_fara_inreg_ctrl_crd_bug:String(pMR(g('n-sumfararezvcrbug'))||0),
    ckbx_interzis_emit_ang:cb('n-ck-interzis'),ckbx_interzis_intrucat:cb('n-ck-intrucat'),
    intrucat:g('n-intrucat'),rowT_ang_ctrl_ang:getNC(),
  },
};}

/* Validation */
const DR=/^([1-9]|0[1-9]|[12]\d|3[01])\.([1-9]|0[1-9]|1[012])\.\d{4}$/;
const CR=/^[1-9]\d{1,9}$/;
function markEl(el,bad){if(el)el.classList.toggle('err',bad);}
function markE(id,bad){markEl(document.getElementById(id),bad);}
function valF(ft){
  let ok=true;
  const req=(id,c)=>{markE(id,!c);if(!c)ok=false;};
  if(ft==='ordnt'){
    req('o-den',g('o-den').length>0);req('o-cif',CR.test(g('o-cif')));
    req('o-nr',g('o-nr').length>0);req('o-data',DR.test(g('o-data')));
    // #128f — câmpurile beneficiarului sunt validate PE BLOC: markEl cade pe elementul
    // rezolvat din containerul blocului i, nu pe un id global (scopare reală la bloc 2+).
    blocEls().forEach((_,i)=>{
      const fldEl=(f)=>blocFldEl(i,f);
      const reqFld=(f,c)=>{markEl(fldEl(f),!c);if(!c)ok=false;};
      reqFld('nr_unic_inreg',bg(i,'nr_unic_inreg').length>0);
      reqFld('beneficiar',bg(i,'beneficiar').length>0);
      reqFld('documente_justificative',bg(i,'documente_justificative').length>0);
      reqFld('iban_beneficiar',bg(i,'iban_beneficiar').length>0);
      reqFld('cif_beneficiar',CR.test(bg(i,'cif_beneficiar')));
      reqFld('banca_beneficiar',bg(i,'banca_beneficiar').length>0);
    });
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
    const docId=ST.docId?.[ft]||null;
    const r=await fetch('/api/formulare/generate',{method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({formType:ft,data,docId}),
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

  // ── Datalist Cod SSI — populat din bugetul importat ─────────────────────
  async function loadBugetCodes() {
    try {
      const r = await fetch('/api/clasa8/buget/coduri', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const dl = document.getElementById('ssi-codes-list');
      if (!dl) return;
      dl.innerHTML = (j.items || []).map(x =>
        `<option value="${String(x.cod_ssi).replace(/"/g, '&quot;')}">`
      ).join('');
    } catch (_) { /* silent — fallback = free text */ }
  }
  window.loadBugetCodes = loadBugetCodes;
  loadBugetCodes();

  // ── Avertisment Cod SSI la părăsirea câmpului (semnalizează, NU blochează) ───
  // Compară valoarea cu opțiunile deja încărcate de loadBugetCodes() (fără fetch la
  // fiecare blur). Cod gol → curăță; cod în listă → curăță; cod inexistent → bordură
  // roșie + mesaj discret. textContent + DOM API (fără innerHTML); token --df-danger.
  function _ssiValidSet() {
    const dl = document.getElementById('ssi-codes-list');
    if (!dl) return null;
    return new Set([...dl.querySelectorAll('option')].map(o => (o.value || '').trim()));
  }
  function _clearSsiMark(inp) {
    inp.style.borderColor = '';
    const msg = inp.parentElement && inp.parentElement.querySelector('.ssi-warn');
    if (msg) msg.remove();
  }
  function _markSsiInvalid(inp) {
    inp.style.borderColor = 'var(--df-danger)';
    const cell = inp.parentElement;
    if (!cell) return;
    if (cell.querySelector('.ssi-warn')) return;
    const msg = document.createElement('div');
    msg.className = 'ssi-warn';
    msg.style.color = 'var(--df-danger)';
    msg.style.fontSize = '11px';
    msg.style.marginTop = '2px';
    msg.textContent = 'Cod inexistent în Clasa 8';
    cell.appendChild(msg);
  }
  document.addEventListener('focusout', (e) => {
    const inp = e.target;
    if (!inp || !inp.matches || !inp.matches('input[list="ssi-codes-list"]')) return;
    const val = (inp.value || '').trim();
    if (!val) { _clearSsiMark(inp); return; }
    const valid = _ssiValidSet();
    // Lista neîncărcată (buget neimportat / fetch eșuat) → nu marca (evită fals-pozitive).
    if (!valid || valid.size === 0) { _clearSsiMark(inp); return; }
    if (valid.has(val)) _clearSsiMark(inp); else _markSsiInvalid(inp);
  });
  // Curăță marcajul de îndată ce userul reeditează (mirror _handleDup409).
  document.addEventListener('input', (e) => {
    const inp = e.target;
    if (inp && inp.matches && inp.matches('input[list="ssi-codes-list"]')) _clearSsiMark(inp);
  });

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
  window.blocEls            = blocEls;
  window.blocEl             = blocEl;
  window.bg                 = bg;
  // #128h — blocuri ORD
  window.getOrdRowsAll      = getOrdRowsAll;
  window.addBlocOrd         = addBlocOrd;
  window.delBlocOrd         = delBlocOrd;
  window.resetOrdBlocuri    = resetOrdBlocuri;
  window.renderOrdBlocuri   = renderOrdBlocuri;
  window.prefillOrdRowsFromCtrl = prefillOrdRowsFromCtrl;
  window.setOrdDfCtrlRows   = setOrdDfCtrlRows;
  window._sablonBloc        = _sablonBloc;
  window.upTotBlocuri       = upTotBlocuri;
  window.colN               = colN;
  window.upTot              = upTot;
  window.markE              = markE;
  window.markEl             = markEl;

  window.p4toggle           = p4toggle;
  window.p5toggle           = p5toggle;
  window.p5SubToggle        = p5SubToggle;
  window.verificaSumaPlati  = verificaSumaPlati;
  window._updateSumaPlatiIndicator = _updateSumaPlatiIndicator;

  window.g                  = g;
  window.cb                 = cb;
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
  window.attEl              = attEl;          // #128m
  window.attKeyBloc         = attKeyBloc;     // #128m
  window.isAttBlocKey       = isAttBlocKey;   // #128m
  window.attBlocOf          = attBlocOf;      // #128m
  window.capZona            = capZona;         // #128n
  window.capSrcBloc         = capSrcBloc;      // #128n
  window.capSetBloc         = capSetBloc;      // #128n
  window.capturaBloc        = capturaBloc;     // #128n

  window.df = window.df || {};
  window.df._formularCoreLoaded = true;
})();
