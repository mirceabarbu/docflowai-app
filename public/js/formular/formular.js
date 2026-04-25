// DocFlowAI — logica completă formular.html (4 module logice în același fișier).
// Extras din formular.html la Pas 2.13 (v3.9.342) BYTE-FOR-BYTE.
//
// CONȚINUT (toate într-un singur fișier, posibil split dedicat la Pas 2.14):
//   - ST (state object) + imgs (signature images state)
//   - _applyAutoFill (org profile → form)
//   - ORDNT / NOTAFD generator PDF (genPdf, mkFlow)
//   - loadList (paginare + filtre documente salvate)
//   - openDoc / newDocFromList / anuleazaDoc / showFF
//   - ALOP wizard (alopDeschideDF, alopDeschideORD, createAlop, openAlopModal,
//     openAlopSablonModal, alopWizNext/Back, confirmLichidare, confirmPlata,
//     confirmRevizie, alopRefreshCurrent, etc. — ~30 funcții)
//   - Plăți (openAlopConfirmPlata, closePlataModal, confirmPlata)
//   - Lookup-uri (vfLookupCui, vfLookupIban, vfLookupCoherence — debounced)
//   - Formular utility (addNC, addNP, addNV, addOR, delR, upTot, calcORRow, _vfCopy)
//   - p4toggle / p5toggle / p5SubToggle (secțiuni dinamice)
//   - Date picker custom (onDatePickerChange, onDateTextInput)
//   - File attachments (addAtt, remAtt)
//
// NU folosește _apiFetch — apeluri fetch() directe cu credentials: 'include'.
//
// Încărcat cu  înainte de </body>, DUPĂ notif-widget.js.
// Dependent de: window.toggleUserMenu / closeUserMenu (df-shell.js),
// window.openChangePwdModal / closeChangePwdModal / submitChangePwd (df-user-modals.js),
// subtabs helpers (df-subtabs.js).

const ST = {
  ordnt:{pdf:null,name:null}, notafd:{pdf:null,name:null}, user:null,
  orgProfile:null,                    // cache org → re-fill la fiecare newDoc din Section 1
  docId:{ordnt:null,notafd:null},
  docStatus:{ordnt:null,notafd:null},
  docRole:{ordnt:null,notafd:null},  // 'p1'|'p2'|'view'
  orgUsers:[], selectedP2Id:null, pendingFt:null,
};
const imgs = {'o-cimg':null,'o-cimg2':null,'n-cimg':null};

// ── _applyAutoFill — aplică date org+user în formular (apelat la init și după newDoc din list)
// ft: 'ordnt'|'notafd' sau absent → ambele; resetDate: dacă true, suprascrie data chiar dacă e completată
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

(async()=>{
  try{
    const r=await fetch('/auth/me',{credentials:'include'});
    if(!r.ok){location.href='/login.html';return;}
    ST.user=await r.json();

    // ── userBar identic cu semdoc-initiator ──────────────────────────────
    const bar=document.getElementById('hUserBar');
    if(bar){
      const u=ST.user;
      const label=u.nume||u.email||'';
      bar.innerHTML=(label?`<span>Conectat: <strong>${label}</strong></span>`:'')
        +((u.role==='admin'||u.role==='org_admin')?`<a href="/admin">⚙ Admin</a>`:'')
        +`<button onclick="fetch('/auth/logout',{method:'POST',credentials:'include'}).finally(()=>{localStorage.removeItem('docflow_user');location.href='/login';})">Ieșire</button>`;
    }
  }catch{location.href='/login.html';return;}

  // ── Fetch profil org → stochează în ST.orgProfile pentru re-fill ulterior ──
  // Dacă utilizatorul nu are org (ex: admin super-user), org va fi null —
  // câmpurile rămân editabile fără eroare; nu e nevoie de fallback în JWT.
  try{
    const orgR=await fetch('/api/org/profile',{credentials:'include'});
    if(orgR.ok){
      const body=await orgR.json();
      const org=body?.org||null;
      if(org){
        const compList=org.compartimente_utilizatori&&org.compartimente_utilizatori.length
          ? org.compartimente_utilizatori
          : (org.compartimente||[]);
        ST.orgProfile={name:org.name||'',cif:org.cif||'',_compList:compList};
      }
      // org null → ST.orgProfile rămâne null; câmpurile vor fi editabile manual
    }
  }catch(e){/* non-fatal — câmpurile rămân editabile */}

  // ── Restaurează _alopContext din sessionStorage după reload ─────────────
  if (!window._alopContext) {
    const _saved = sessionStorage.getItem('_alopContext');
    if (_saved) try { window._alopContext = JSON.parse(_saved); } catch(e) {}
  }

  // ── Aplică auto-fill în ambele formulare (condiție: câmpurile goale) ────
  _applyAutoFill('ordnt');
  _applyAutoFill('notafd');
  addOR(); addNV();
})();

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

/* ── AUTO-SAVE DRAFT ─────────────────────────────────────────────────────────
 * Salvează starea fiecărui formular în localStorage la fiecare 2s de inactivitate.
 * La reload: restaurare automată cu banner de confirmare.
 * La resetF: draft șters.
 * NU salvează: fișiere atașate (prea mari), imaginile de captură. ─────────── */

const DRAFT_VER = '2'; // bump dacă schimbi structura draft-ului

function _draftKey(ft){ return 'dfai_draft_v' + DRAFT_VER + '_' + ft; }

// Colectează starea completă a formularului într-un obiect serializabil
function _draftCollect(ft) {
  const form = document.getElementById('form-' + ft);
  if (!form) return null;
  const state = { inputs:{}, checkboxes:{}, rows:{}, ts: new Date().toISOString() };

  // Inputs și textareas cu ID (exclus file inputs și cele fără ID)
  form.querySelectorAll('input[id]:not([type=file]):not([type=hidden]),textarea[id]').forEach(el => {
    if (el.type === 'checkbox') state.checkboxes[el.id] = el.checked;
    else state.inputs[el.id] = el.value;
  });

  // Rânduri dinamice — salvate ca array de obiecte {data-f: value}
  const tbodies = {
    ordnt: ['o-tbody'],
    notafd: ['n-vtbody','n-ptbody','n-ctbody'],
  };
  (tbodies[ft] || []).forEach(tid => {
    const tbody = document.getElementById(tid);
    if (!tbody) return;
    state.rows[tid] = [...tbody.querySelectorAll('tr')].map(tr => {
      const o = {};
      tr.querySelectorAll('input[data-f]').forEach(inp => { o[inp.dataset.f] = inp.value; });
      return o;
    });
  });

  return state;
}

// Restaurează starea din obiectul salvat
function _draftApply(ft, state) {
  if (!state) return;
  const form = document.getElementById('form-' + ft);
  if (!form) return;

  // Inputs
  Object.entries(state.inputs || {}).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && el.type !== 'file') el.value = val;
  });

  // Checkboxes + re-trigger toggle-uri dependente
  Object.entries(state.checkboxes || {}).forEach(([id, checked]) => {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
  });

  // Re-aplică stările dependente pentru pct 4 și pct 5 (doc fundamentare)
  if (ft === 'notafd') {
    const ckStab = document.getElementById('n-ck-stab');
    const ckRam  = document.getElementById('n-ck-ramane');
    if (ckStab && ckRam) {
      if (ckStab.checked) p4toggle('stab');
      else if (ckRam.checked) p4toggle('ramane');
    }
    p5toggle && p5toggle();
  }

  // Rânduri dinamice
  const addFns = { 'o-tbody': addOR, 'n-vtbody': addNV, 'n-ptbody': addNP, 'n-ctbody': addNC };
  Object.entries(state.rows || {}).forEach(([tid, rows]) => {
    const tbody = document.getElementById(tid);
    if (!tbody || !rows.length) return;
    tbody.innerHTML = '';
    const addFn = addFns[tid];
    rows.forEach(rowData => {
      if (addFn) addFn();
      const tr = tbody.querySelector('tr:last-child');
      if (!tr) return;
      Object.entries(rowData).forEach(([f, v]) => {
        const inp = tr.querySelector(`[data-f="${f}"]`);
        if (inp) inp.value = v;
      });
    });
  });

  // Recalculează totaluri și col 7 după restore
  upTot && upTot();
  // Re-calculează col 7 = col5+col6 pentru fiecare rând NV
  document.querySelectorAll('#n-vtbody tr').forEach(tr => {
    const c5 = parseFloat(tr.querySelector('[data-f="valt_rev_prec"]')?.value) || 0;
    const c6 = parseFloat(tr.querySelector('[data-f="influente"]')?.value) || 0;
    const c7 = tr.querySelector('[data-f="valt_actualiz"]');
    if (c7) c7.value = c5 + c6;
  });
  // Re-calculează col 7=5+6 și col 10=8+9 pentru fiecare rând NC (Secțiunea B)
  document.querySelectorAll('#n-ctbody tr').forEach(tr => {
    const c5 = parseFloat(tr.querySelector('[data-f="sum_rezv_crdt_ang_af_rvz_prc"]')?.value) || 0;
    const c6 = parseFloat(tr.querySelector('[data-f="influente_c6"]')?.value) || 0;
    const c7 = tr.querySelector('[data-f="sum_rezv_crdt_ang_act"]');
    if (c7) c7.value = c5 + c6;
    const c8 = parseFloat(tr.querySelector('[data-f="sum_rezv_crdt_bug_af_rvz_prc"]')?.value) || 0;
    const c9 = parseFloat(tr.querySelector('[data-f="influente_c9"]')?.value) || 0;
    const c10 = tr.querySelector('[data-f="sum_rezv_crdt_bug_act"]');
    if (c10) c10.value = c8 + c9;
  });
  upTot && upTot();
}

// Salvează în localStorage cu gestionare erori quota
function draftSave(ft) {
  try {
    const state = _draftCollect(ft);
    if (!state) return;
    localStorage.setItem(_draftKey(ft), JSON.stringify(state));
    _draftShowBadge(ft, '💾 salvat ' + new Date().toLocaleTimeString('ro-RO', {hour:'2-digit',minute:'2-digit'}));
  } catch(e) {
    // localStorage plin sau indisponibil — ignorăm silențios
    if (e.name === 'QuotaExceededError') _draftShowBadge(ft, '⚠ storage plin');
  }
}

function draftClear(ft) {
  try { localStorage.removeItem(_draftKey(ft)); } catch {}
  _draftHideBadge(ft);
}

function _draftShowBadge(ft, txt) {
  // Actualizează badge-ul vizibil din back-bar (tab-urile sunt ascunse)
  const vis = document.getElementById('form-save-badge');
  if (vis) { vis.textContent = txt; vis.style.display = ''; }
  // Și cel din tabs-wrap (ascuns, backup)
  const el = document.getElementById('db-' + ft);
  if (el) { el.textContent = txt; el.classList.add('show'); }
}
function _draftHideBadge(ft) {
  const vis = document.getElementById('form-save-badge');
  if (vis) vis.textContent = '';
  const el = document.getElementById('db-' + ft);
  if (el) { el.textContent = ''; el.classList.remove('show'); }
}

// Încarc draft la pornire cu banner de confirmare
function draftLoadIfExists(ft) {
  try {
    const raw = localStorage.getItem(_draftKey(ft));
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state || !state.ts) return;

    const age = Math.round((Date.now() - new Date(state.ts)) / 60000);
    const ageStr = age < 1 ? 'acum câteva secunde' : age < 60 ? `acum ${age} min` : `acum ${Math.round(age/60)}h`;

    // Banner de restore
    const bar = document.getElementById('sBar');
    bar.className = 'status info';
    bar.innerHTML = `📋 Draft găsit (${ageStr}). &nbsp;
      <button onclick="_doRestore('${ft}')" style="padding:2px 10px;border-radius:6px;border:1px solid rgba(108,79,240,.4);background:rgba(108,79,240,.12);color:#b0a0ff;cursor:pointer;font-size:.82rem">Restaurează</button>
      <button onclick="draftClear('${ft}');clrS()" style="margin-left:6px;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:none;color:var(--df-text-3);cursor:pointer;font-size:.82rem">Ignoră</button>`;

    // Stocăm starea pentru butonul de restore
    window._pendingDraft = window._pendingDraft || {};
    window._pendingDraft[ft] = state;
  } catch {}
}

function _doRestore(ft) {
  const state = window._pendingDraft?.[ft];
  if (!state) return;
  // Golim rândurile implicite adăugate la init înainte de restore
  ['o-tbody','n-vtbody','n-ptbody','n-ctbody'].forEach(tid => {
    const el = document.getElementById(tid);
    if (el) el.innerHTML = '';
  });
  _draftApply(ft, state);
  delete window._pendingDraft[ft];
  clrS();
  _draftShowBadge(ft, '✅ draft restaurat');
  setTimeout(() => _draftHideBadge(ft), 4000);
}

// Debounce auto-save — 2s după ultima tastă
const _draftTimers = {};
function _draftSchedule(ft) {
  if(ST.docAprobat?.[ft])return;
  clearTimeout(_draftTimers[ft]);
  _draftTimers[ft] = setTimeout(() => draftSave(ft), 2000);
}

// Atașează listeners la toate input-urile din fiecare formular
function _draftAttach(ft) {
  const form = document.getElementById('form-' + ft);
  if (!form) return;
  form.addEventListener('input', () => { _draftSchedule(ft); _scheduleAutoSaveDb(ft); });
  form.addEventListener('change', () => { _draftSchedule(ft); _scheduleAutoSaveDb(ft); });
}

// Init — rulat după ce formularele sunt gata
(function initDraft(){
  ['ordnt','notafd'].forEach(ft => {
    _draftAttach(ft);
    draftLoadIfExists(ft);
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW DB — P1 → P2
// ══════════════════════════════════════════════════════════════════════════════

function getCsrf(){return document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('csrf_token='))?.split('=')[1]||'';}

// ── Date helpers zz.ll.aaaa <-> YYYY-MM-DD (consistent cu admin.js) ──
function parseDMYtoISO(s) {
  if (!s || s.length !== 10) return null;
  const [d,m,y] = s.split('.').map(Number);
  if (!d||!m||!y||m>12||d>31||y<2000||y>2100) return null;
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function isoToDMY(iso) {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function onDateTextInput(el, hiddenId) {
  let v = el.value.replace(/[^0-9.]/g,'');
  const digits = v.replace(/\./g,'');
  if (digits.length > 2 && !v.includes('.')) v = digits.slice(0,2) + '.' + digits.slice(2);
  if (digits.length > 4) {
    const parts = v.split('.');
    if (parts.length >= 2 && parts[1].length > 2) {
      v = parts[0] + '.' + parts[1].slice(0,2) + '.' + parts[1].slice(2) + (parts[2]||'');
    }
  }
  v = v.slice(0,10);
  el.value = v;
  const iso = parseDMYtoISO(v);
  const hidden = document.getElementById(hiddenId);
  if (hidden) { hidden.value = iso || ''; if (iso) hidden.dispatchEvent(new Event('change')); }
  el.style.borderColor = v.length === 10 ? (iso ? 'rgba(45,212,191,.5)' : 'rgba(255,80,80,.5)') : '';
}
function onDatePickerChange(pickerEl, displayId) {
  const iso = pickerEl.value;
  if (iso) { const disp = document.getElementById(displayId); if (disp) { disp.value = isoToDMY(iso); disp.style.borderColor = 'rgba(45,212,191,.5)'; } }
}

// Afișare vizuală dd.mm.yyyy peste input[type=date] (valoarea internă rămâne YYYY-MM-DD)
function initDateDisplayRo(){
  document.querySelectorAll('input[type="date"]').forEach(input=>{
    if(input.dataset.roDate)return;
    input.dataset.roDate='1';
    const wrapper=document.createElement('div');
    wrapper.style.cssText='position:relative;display:inline-block;width:100%';
    input.parentNode.insertBefore(wrapper,input);
    wrapper.appendChild(input);
    const display=document.createElement('span');
    display.style.cssText='position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:inherit;color:inherit;background:transparent;z-index:1';
    wrapper.appendChild(display);
    const update=()=>{
      if(input.value){const[y,m,d]=input.value.split('-');display.textContent=`${d}.${m}.${y}`;input.style.color='transparent';}
      else{display.textContent='';input.style.color='';}
    };
    input.addEventListener('change',update);
    input.addEventListener('input',update);
    update();
  });
}
document.addEventListener('DOMContentLoaded',initDateDisplayRo);

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
  const B=(cls,txt,fn)=>`<button class="btn ${cls}" onclick="${fn}">${txt}</button>`;
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
      +`<button id="bgen-${ft}" class="btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`
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
                :`<button id="bgen-${ft}" class="btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`);
  }else if(status==='transmis_flux'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">🔄 Document pe fluxul de semnare...</span>`
      +(ST.docFlowId?.[ft]?B('','📄 Descarcă PDF',`viewFlowPdf('${ST.docFlowId[ft]}')`):'');
  }else if(status==='completed'&&role==='p2'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">✅ Secțiunea ta este completată.</span>`
      +BNou;
  }else{
    html=`<button id="bgen-${ft}" class="btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`
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
      ?`<button class="btn" style="padding:3px 8px;font-size:.74rem;margin-left:4px" onclick="event.stopPropagation();viewFlowPdf('${d.flow_id}')" title="PDF semnat din flux">📄 PDF flux</button>`
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
  const hdrs={'Content-Type':'application/json','X-CSRF-Token':getCsrf()};
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
      headers:{'Content-Type':mime,'X-CSRF-Token':getCsrf(),'X-Filename':`captura_${ft}.png`},
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
      headers:{'Content-Type':'application/json','X-CSRF-Token':getCsrf()},
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
      headers:{'Content-Type':'application/json','X-CSRF-Token':getCsrf()},
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
      headers:{'Content-Type':'application/json','X-CSRF-Token':getCsrf()},
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
      headers:{'Content-Type':'application/json','X-CSRF-Token':getCsrf()},
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

// ── Auto-save DB (debounce 800ms, silențios) ──────────────────────────────────
const _autoSaveTimers={};
async function _autoSaveDb(ft){
  if(!ST.user)return;
  // Dacă documentul e blocat (P1 asteaptă P2 sau completat) → nu auto-salvăm
  const s=ST.docStatus[ft];
  if(s==='pending_p2'||s==='completed'||s==='anulat')return;
  const docId=ST.docId[ft];
  const body=ft==='ordnt'?collectOrdDb():(ST.docRole[ft]==='p2'?collectDfP2Db():collectDfP1Db());
  _draftShowBadge(ft,'⏳');
  try{
    const hdrs={'Content-Type':'application/json','X-CSRF-Token':getCsrf()};
    let r,j;
    if(!docId){
      r=await fetch(ftApi(ft),{method:'POST',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.ok&&j.ok){ST.docId[ft]=j.document.id;ST.docStatus[ft]='draft';ST.docRole[ft]='p1';renderActions(ft);}
    }else{
      r=await fetch(`${ftApi(ft)}/${docId}`,{method:'PUT',credentials:'include',headers:hdrs,body:JSON.stringify(body)});
      j=await r.json();
      if(r.ok&&j.ok)ST.docStatus[ft]=j.document.status;
    }
    if(!r||!j||!r.ok)return;
    const iid=ft==='ordnt'?'o-cimg':'n-cimg';
    if(imgs[iid]&&ST.docId[ft])await uploadCaptura(ft);
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
        const nr=d.nr_unic_inreg?`DF ${_escH(d.nr_unic_inreg)}`:'DF fără număr';
        const sub=d.subtitlu_df?` — ${_escH(d.subtitlu_df.slice(0,50))}`:'';
        return`<option value="${_escH(d.id)}" style="background:#0d1630;color:#e8eeff">${nr}${sub}</option>`;
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
        onclick="selectBenef(${b.id},'${_escH(b.denumire)}','${_escH(b.cif||'')}','${_escH(b.iban||'')}','${_escH(b.banca||'')}')">
        <strong>${_escH(b.denumire)}</strong><br>
        <small>CIF: ${_escH(b.cif||'—')} · IBAN: ${_escH(b.iban||'—')}</small>
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
      headers:{'Content-Type':'application/json','X-CSRF-Token':getCsrf()},
      body:JSON.stringify({denumire:den,cif,iban,banca}),
    });
  }catch(_){}
}

// ── Centralizare: navigare secțiuni ──────────────────────────────────────────
const _escH=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let _lstState={type:'df',page:1,limit:20};
let _lstDebTimer=null;

function showListSection(tab){
  _clearValErr();
  document.getElementById('section-list').style.display='';
  document.getElementById('section-form').style.display='none';
  const _tEl=document.getElementById('dfPageTitle'),_sEl=document.getElementById('dfPageSubtitle');
  if(_tEl)_tEl.textContent='Formulare oficiale';
  if(_sEl)_sEl.textContent='Document de Fundamentare, Ordonanțare de Plată, ALOP';
  try{history.replaceState({},'',location.pathname);}catch(_){}
  if(tab)switchListTab(tab);
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
  const ltabFo=document.getElementById('ltab-fo');
  if(ltabFo)ltabFo.classList.toggle('active',type==='fo');
  // Bannere informative pentru DF/ORD
  const bannerDf=document.getElementById('lst-banner-df');
  const bannerOrd=document.getElementById('lst-banner-ord');
  if(bannerDf)bannerDf.style.display=type==='df'?'':'none';
  if(bannerOrd)bannerOrd.style.display=type==='ord'?'':'none';
  // Secțiuni ALOP / Verify / Formulare Oficiale
  const lstWrap=document.querySelector('#section-list .lst-wrap');
  const alopSection=document.getElementById('alop-section');
  const verifySection=document.getElementById('verify-section');
  const foSection=document.getElementById('fo-section');
  if(type==='alop'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='';
    if(verifySection)verifySection.style.display='none';
    if(foSection)foSection.style.display='none';
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
    if(foSection)foSection.style.display='none';
  }else if(type==='fo'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(foSection)foSection.style.display='';
  }else{
    if(lstWrap)lstWrap.style.display='';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(foSection)foSection.style.display='none';
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
  p.push('type='+_lstState.type);
  if(status&&status!=='all')p.push('status='+encodeURIComponent(status));
  if(from)p.push('from='+encodeURIComponent(from));
  if(to)p.push('to='+encodeURIComponent(to));
  if(comp)p.push('comp='+encodeURIComponent(comp));
  if(init)p.push('init='+encodeURIComponent(init));
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
    aprobat:'🟢 Aprobat',respins:'❌ Respins',anulat:'🚫 Anulat',returnat:'↩ Returnat'};
  const cls={draft:'st-draft',pending_p2:'st-transmis_p2',completed:'st-completat',
    generat_pdf:'st-generat_pdf',transmis_flux:'st-transmis_flux',
    aprobat:'st-aprobat',respins:'st-respins',anulat:'st-anulat',returnat:'st-returnat'};
  return`<span class="stbadge ${cls[status]||'st-draft'}">${_escH(map[status]||status)}</span>`;
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
    const canCancel=row.status==='draft'||(row.status==='pending_p2'&&row.isP1);
    const cancelBtn=canCancel
      ?`<button class="btn" style="padding:3px 8px;font-size:.74rem;color:#c0392b" onclick="anuleazaDoc('${type}','${_escH(row.id)}')">🚫</button>`
      :'';
    const safeId=_escH(row.id);
    const nr=_escH(row.nr||row.id.slice(0,8));
    const titlu=_escH(row.titlu||'');
    const revBadgeLst=type==='df'&&row.revizie_nr>0?`<span class="df-revizie-badge" style="vertical-align:middle;margin-left:4px">Rev. ${row.revizie_nr}</span>`:'';
    return`<tr>
      <td><a href="#" onclick="openDocFromList('${type}','${safeId}');return false" style="font-weight:500">${nr}${revBadgeLst}</a>${titlu?`<br><small style="color:#666">${titlu}</small>`:''}
      </td>
      <td>${_escH(row.initiator||'—')}</td>
      <td>${_escH(row.p2||'—')}</td>
      <td>${_stBadge(row.aprobat ? 'aprobat' : row.status)}</td>
      <td>${_fmtDate(row.created_at)}</td>
      <td>${_fmtDate(row.updated_at)}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn primary" style="padding:3px 8px;font-size:.74rem" onclick="openDocFromList('${type}','${safeId}')">✏ Deschide</button>
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
async function anuleazaDoc(type,id){
  if(!confirm('Anulați acest document? Operațiunea nu poate fi inversată.'))return;
  try{
    const r=await fetch(`/api/formulare-${type}/${id}/anuleaza`,{
      method:'POST',credentials:'include',
      headers:{'X-CSRF-Token':getCsrf()},
    });
    const j=await r.json();
    if(!r.ok||!j.ok){alert(j.error||'Eroare la anulare');return;}
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
  ['flt-from','flt-to','flt-init','flt-from-display','flt-to-display'].forEach(id=>{
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
  sel.innerHTML='<option value="">Toate</option>'+list.map(c=>`<option value="${_escH(c)}">${_escH(c)}</option>`).join('');
}

// ALOP + REVIZIE → extrase în alop.js (BLOC 2.2)
// Verificare furnizor + Formulare oficiale → extrase în verif.js (BLOC 2.1)



// Attach money inputs standalone (Enter listeners → verif.js)
document.addEventListener('DOMContentLoaded', () => {
  ['n-ramana','n-sumfara','n-sumfararezvcrbug','alop-valoare','plata-suma'].forEach(id=>{
    const el=document.getElementById(id);if(el)attachMoneyInput(el);
  });
});

