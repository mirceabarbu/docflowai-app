// public/js/formular/list.js
// DocFlowAI — Modul Lista DF/ORD/ALOP + BENEF autocomplete + AUTO-SAVE DB (BLOC 2.4).
//
// Cross-module exports (window):
//   - switchListTab : apelată din HTML onclick + alte module
//   - showListSection, showFormSection, newDocFromList
//   - loadList, openDocFromList, stergeDoc, debouncedLoadList, resetFilters
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
      // SEC-88.3: sesiune revocată/expirată mid-editare. Autosave-ul în DB folosește fetch()
      // brut (fără shim/notif-widget) → un 401 era înghițit tăcut, iar inspectorul continua să
      // scrie într-un vid, nimic nu se mai salva pe server. NU redirectăm din interiorul unui
      // debounce (am smulge omul din tastare); în schimb forțăm o salvare SINCRONĂ a draftului
      // local (draftSave din draft.js) + un banner persistent cu buton de reautentificare.
      // Doar 401 declanșează bannerul; o eroare de rețea trecătoare rămâne badge-ul '⚠' de mai jos.
      if(r&&r.status===401){
        try{ draftSave(ft); }catch(_){}
        _showSessionExpiredBanner();
        return;
      }
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
      if(ft==='ordnt') await window.uploadCapturaBlocuri?.(ft);
    }
    // v3.9.501: auto-save uploadează atașamente pending pentru ambele sloturi
    // v3.9.554 (B2): eșecurile de upload nu mai sunt mascate de badge-ul 💾
    let _attFailed=[];
    if(ST.docId[ft]){
      _attFailed=_attFailed.concat(await uploadAttachments(ft, 1)||[]);
      if(ft==='notafd') _attFailed=_attFailed.concat(await uploadAttachments(ft, 2)||[]);
      // #128m — atașamentele blocurilor 2+ de furnizor (ORD).
      _attFailed=_attFailed.concat(await window.uploadAttachmentsBlocuri?.(ft)||[]);
    }
    if(_attFailed.length){
      _draftShowBadge(ft,'⚠ '+_attFailed.length+' atașament(e) neîncărcate');
    }else{
      _draftShowBadge(ft,'💾 '+new Date().toLocaleTimeString('ro-RO',{hour:'2-digit',minute:'2-digit'}));
    }
  }catch(_){_draftShowBadge(ft,'⚠');}
}
function _scheduleAutoSaveDb(ft){
  clearTimeout(_autoSaveTimers[ft]);
  _autoSaveTimers[ft]=setTimeout(()=>_autoSaveDb(ft),800);
}

// SEC-88.3: banner persistent la sesiune expirată/revocată pe autosave DB. Refolosește #sBar
// (bara de status a paginii, clasa .status.err din formular.css) — același component pe care
// draft.js îl folosește pentru banner-ul de restore. NU redirectează automat (decizie de UX):
// draftul local e deja păstrat sincron; utilizatorul reia lucrul prin butonul de reautentificare.
let _sessionExpiredShown=false;
function _showSessionExpiredBanner(){
  if(_sessionExpiredShown)return; _sessionExpiredShown=true;
  const bar=document.getElementById('sBar'); if(!bar)return;
  const next=encodeURIComponent(location.pathname+location.search);
  bar.className='status err';
  bar.innerHTML='⚠️ Sesiunea a expirat. Modificările nu se mai salvează pe server. '
    +'Draftul local a fost păstrat. &nbsp;'
    +'<button onclick="location.href=\'/login?next='+next+'\'" '
    +'style="padding:2px 12px;border-radius:6px;border:1px solid rgba(255,80,80,.4);'
    +'background:rgba(255,80,80,.12);color:#ff9090;cursor:pointer;font-size:.82rem">'
    +'Reautentifică-te</button>';
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
  if(!id){document.getElementById('o-nrUnic').value='';if(typeof window._resetOrdBuget==='function')window._resetOrdBuget();if(window.lockDfSelectIfLinked)window.lockDfSelectIfLinked();return;}
  await onDfSelect(id);
  if(window.lockDfSelectIfLinked)window.lockDfSelectIfLinked(); // ORD acum legat de DF → blochează referința
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
    // #128h: un DF nou selectat resetează formularul la UN singur bloc (rândurile blocurilor
    // 2+ ar fi rămas legate de DF-ul precedent), apoi cache-uiește rows_ctrl — blocurile de
    // furnizor adăugate ulterior se pre-populează din ACELAȘI DF, fără un al doilea fetch.
    if(typeof window.resetOrdBlocuri==='function')window.resetOrdBlocuri();
    if(typeof window.setOrdDfCtrlRows==='function')window.setOrdDfCtrlRows(rows);
    const tbody=document.getElementById('o-tbody');
    tbody.innerHTML='';oI=0;
    if(!rows.length){addOR();if(typeof window.lockOrdIdentityCols==='function')window.lockOrdIdentityCols();return;}
    // #128h — pre-popularea rândurilor (inclusiv ștampila `ctrl_idx` din #128g) e EXTRASĂ în
    // prefillOrdRowsFromCtrl (core.js), refolosită identic la crearea unui bloc nou.
    // readOnly-ul coloanelor de identitate rămâne pe seama lui lockOrdIdentityCols pentru
    // blocul 0 (comportament neschimbat).
    prefillOrdRowsFromCtrl(rows,tbody);
    upTot();
    if(typeof window.lockOrdIdentityCols==='function')window.lockOrdIdentityCols(); // ORD legat de DF → coloanele de identitate needitabile
    // Încarcă contextul de buget al DF-ului selectat → atenționare inline ORD (paritate server).
    if(typeof window._loadOrdBuget==='function')window._loadOrdBuget(dfId);
  }catch(_){}
}

// ── Beneficiari autocomplete (#128j — pe TOATE blocurile ORD, prin delegare) ──
// Toate funcțiile de mai jos primesc un BLOC-ȚINTĂ (`[data-bloc]`) și rezolvă câmpurile
// relativ la el (`[data-fld]` / `[data-role]`), NU prin id-uri globale. Default = blocul 0,
// ca apelanții existenți (window.*) să funcționeze neschimbat.
function _blocList(){
  return[...document.querySelectorAll('[data-bloc]')]
    .sort((a,b)=>(Number(a.getAttribute('data-bloc'))||0)-(Number(b.getAttribute('data-bloc'))||0));
}
function _blocOf(el){
  return (el&&el.closest&&el.closest('[data-bloc]'))||document.querySelector('[data-bloc="0"]')||null;
}
function _bFld(bloc,fld){return bloc?bloc.querySelector(`[data-fld="${fld}"]`):null;}
function _bRole(bloc,role){return bloc?bloc.querySelector(`[data-role="${role}"]`):null;}
// Scrie beneficiarul ales în câmpurile blocului și închide dropdown-ul lui.
function _applyBenef(bloc,b){
  const sv2=(fld,val)=>{const e=_bFld(bloc,fld);if(e)e.value=val;};
  sv2('beneficiar',b.den);sv2('cif_beneficiar',b.cif);
  sv2('iban_beneficiar',b.iban);sv2('banca_beneficiar',b.banca);
  const drop=_bRole(bloc,'benef-drop');
  if(drop)drop.style.display='none';
}

// Debounce PER BLOC — un `_benefTimer` global ar face ca tastarea în blocul 2 să anuleze
// căutarea pornită din blocul 1.
const _benefTimers=new WeakMap();
function debouncedBenefSearch(target){
  const bloc=_blocOf(target);
  if(!bloc)return;
  clearTimeout(_benefTimers.get(bloc));
  _benefTimers.set(bloc,setTimeout(()=>_searchBenef(bloc),400));
}
async function _searchBenef(target){
  const bloc=_blocOf(target);
  const drop=_bRole(bloc,'benef-drop');
  if(!drop)return;
  const q=(_bFld(bloc,'beneficiar')?.value||'').trim();
  if(q.length<2){drop.style.display='none';return;}
  try{
    const r=await fetch('/api/beneficiari?q='+encodeURIComponent(q),{credentials:'include'});
    const j=await r.json();
    const list=j.beneficiari||[];
    if(!list.length){drop.style.display='none';return;}
    // Datele beneficiarului merg în `dataset`, NU interpolate într-un șir JS dintr-un atribut
    // `onclick` — acolo `esc()` (escape HTML) nu proteja contextul JS, iar o denumire cu
    // apostrof („Ferma L'Aurora SRL") rupea atributul. Selecția e delegată (`.ac-opt`).
    drop.innerHTML=list.map(b=>`<div class="ac-opt" tabindex="0"
        data-ben-id="${esc(b.id)}" data-ben-den="${esc(b.denumire)}" data-ben-cif="${esc(b.cif||'')}"
        data-ben-iban="${esc(b.iban||'')}" data-ben-banca="${esc(b.banca||'')}">
        <strong>${esc(b.denumire)}</strong><br>
        <small>CIF: ${esc(b.cif||'—')} · IBAN: ${esc(b.iban||'—')}</small>
      </div>`).join('');
    drop.style.display='block';
  }catch(_){drop.style.display='none';}
}
// Păstrată pentru compatibilitate (export window, semnătură neschimbată) — scrie în blocul 0.
// Selecția din dropdown NU mai trece pe aici: e delegată prin dataset.
function selectBenef(id,den,cif,iban,banca){
  _applyBenef(_blocOf(null),{den,cif,iban,banca});
}
// ── v3.9.627: badge stare beneficiar ANAF (oglindește logica din verif.js) ────
function renderBenefStatusBadge(d,target){
  const box = _bRole(_blocOf(target),'benef-status');
  if(!box) return;
  if(!d){ box.innerHTML=''; return; }
  const esc = window.esc || (s=>String(s==null?'':s));
  const red   = 'background:rgba(239,68,68,.15);color:#ff8080;padding:3px 12px;border-radius:10px;font-size:.78rem;font-weight:700;display:inline-flex;align-items:center;gap:6px;';
  const amber = 'background:rgba(251,191,36,.15);color:#fbbf24;padding:3px 12px;border-radius:10px;font-size:.78rem;font-weight:700;display:inline-flex;align-items:center;gap:6px;';
  const green = 'color:#5eead4;font-size:.76rem;font-weight:600;';
  if(d.radiated){
    box.innerHTML = `<span style="${red}">⛔ Beneficiar RADIAT la ANAF${d.radiatedDate?(' — '+esc(d.radiatedDate)):''} · verifică înainte de plată</span>`;
  } else if(d.inactive){
    box.innerHTML = `<span style="${red}">⛔ Beneficiar INACTIV fiscal${d.inactiveDate?(' din '+esc(d.inactiveDate)):''}${d.reactivationDate?(' · reactivat '+esc(d.reactivationDate)):''} · verifică înainte de plată</span>`;
  } else if(d.vat===false && d.vatEndDate){
    box.innerHTML = `<span style="${amber}">⚠ TVA anulat la ANAF${d.vatEndDate?(' la '+esc(d.vatEndDate)):''}</span>`;
  } else {
    box.innerHTML = `<span style="${green}">✓ În funcțiune la ANAF${d.stareInregistrareText?(' · '+esc(d.stareInregistrareText)):''}</span>`;
  }
}
window.renderBenefStatusBadge = renderBenefStatusBadge;

// ── v3.9.504: CIF lookup → auto-fill beneficiar (local → ANAF fallback) ────────
async function _lookupByCif(target){
  const bloc=_blocOf(target);
  const cifEl=_bFld(bloc,'cif_beneficiar');
  if(!cifEl)return;
  const _sb=_bRole(bloc,'benef-status'); if(_sb) _sb.innerHTML='';
  let cif=(cifEl.value||'').trim().toUpperCase().replace(/^RO\s*/,'');
  cifEl.value=cif;
  if(!/^\d{2,10}$/.test(cif))return;

  const spin=_bRole(bloc,'cifb-spin');
  const showSpin=v=>{if(spin)spin.style.display=v?'inline-block':'none';};
  const setF=(fld,val)=>{const e=_bFld(bloc,fld);if(e&&val!=null)e.value=val;};
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
        setF('beneficiar',match.denumire||'');
        setF('iban_beneficiar',match.iban||'');
        setF('banca_beneficiar',match.banca||'');
        _setS('Beneficiar găsit local: '+(match.denumire||cif),'ok');
        resolved=true;
        // DB nu are starea ANAF — verifică starea separat (non-blocant, fail-open)
        const _cifSnapshot = cif;
        fetch('/api/verify/cui?cui='+encodeURIComponent(cif),{credentials:'include'})
          .then(r=>r.ok?r.json():null)
          .then(j=>{
            // Garda de cursă compară cu câmpul BLOCULUI, nu cu #o-cifb.
            const cur=_bFld(bloc,'cif_beneficiar');
            if(!cur || (cur.value||'').trim().toUpperCase().replace(/^RO\s*/,'')!==_cifSnapshot) return;
            if(j&&j.ok&&j.data) renderBenefStatusBadge(j.data,bloc);
          })
          .catch(()=>{});
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
          setF('beneficiar',j.data.name);
          renderBenefStatusBadge(j.data,bloc);
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

// ── #128j — DELEGARE: un singur set de handlere pe #ord-blocuri ───────────────
// Orice bloc — existent, adăugat de utilizator, restaurat din draft sau recreat de
// renderOrdBlocuri — e acoperit AUTOMAT, fără nicio cablare la creare. De aceea nu există
// (și nu trebuie adăugat) niciun apel de „cablare" în addBlocOrd / renderOrdBlocuri / draft.js.
(function _wireBenefDelegation(){
  const host=document.getElementById('ord-blocuri')||document;
  host.addEventListener('input',e=>{
    const t=e.target;
    if(t&&t.matches&&t.matches('[data-fld="beneficiar"]'))debouncedBenefSearch(t);
  });
  // `blur` nu bulează → `focusout`.
  host.addEventListener('focusout',e=>{
    const t=e.target;
    if(t&&t.matches&&t.matches('[data-fld="cif_beneficiar"]'))_lookupByCif(t);
  });
  // #128m — atașamente per furnizor: butonul „Atașează fișiere" și input-ul de fișier ale
  // blocurilor 2+ n-au handler inline (n-au nici id). Delegarea acoperă automat blocurile
  // adăugate manual, restaurate din draft sau recreate de renderOrdBlocuri.
  // ⛔ Blocul 0 e SĂRIT deliberat: are handler inline în formular.html — fără gardă s-ar
  // declanșa de două ori (fiecare fișier ar fi adăugat dublu în listă).
  host.addEventListener('click',e=>{
    const btn=e.target&&e.target.closest&&e.target.closest('[data-role="att-btn"]');
    if(!btn)return;
    const bloc=btn.closest('.ord-bloc');
    if(!bloc||(bloc.getAttribute('data-bloc')||'0')==='0')return;
    const inp=bloc.querySelector('[data-role="att-input"]');
    if(inp&&!inp.disabled)inp.click();
  });
  host.addEventListener('change',e=>{
    const t=e.target;
    if(!t||!t.matches||!t.matches('[data-role="att-input"]'))return;
    const bloc=t.closest('.ord-bloc');
    if(!bloc)return;
    const bi=Number(bloc.getAttribute('data-bloc'))||0;
    if(bi===0)return;  // blocul 0 are onchange inline
    window.addAtt?.(e,window.attKeyBloc(bi,'list'),window.attKeyBloc(bi,'data'));
  });
  // #128n — capturi per furnizor: zonele blocurilor 2+ n-au handler inline (n-au nici id).
  // ⛔ Blocul 0 e SĂRIT: are onchange/ondrop inline în formular.html.
  // ⚠️ Fără handler de `click`: `.cap-zone input[type=file]` e `position:absolute;inset:0;
  // opacity:0` (CSS existent) ⇒ clicul ajunge direct pe input. Un `inp.click()` în plus ar
  // deschide dialogul de două ori.
  const _capBloc=(el)=>{
    const b=el&&el.closest&&el.closest('.ord-bloc');
    if(!b)return null;
    return (b.getAttribute('data-bloc')||'0')==='0'?null:b;
  };
  host.addEventListener('change',e=>{
    const inp=e.target;
    if(!inp||!inp.matches||!inp.matches('[data-role="cap-input"]'))return;
    if(!_capBloc(inp))return;
    const zone=inp.closest('[data-role="cap-zone"]');
    const f=inp.files&&inp.files[0];if(!f||!zone)return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=zone.querySelector('[data-role="cap-img"]');
      const ph=zone.querySelector('[data-role="cap-ph"]');
      if(img){img.setAttribute('src',ev.target.result);img.style.display='block';}
      if(ph)ph.style.display='none';
      window._scheduleAutoSaveDb?.('ordnt');
    };
    rd.readAsDataURL(f);
    inp.value='';
  });
  host.addEventListener('click',e=>{
    const btn=e.target&&e.target.closest&&e.target.closest('[data-role="cap-clr"]');
    if(!btn||!_capBloc(btn))return;
    const bloc=btn.closest('.ord-bloc');
    const slot=btn.getAttribute('data-cap-slot')==='2'?2:1;
    window.capSetBloc?.(bloc,slot,null);
    window._scheduleAutoSaveDb?.('ordnt');
  });
  host.addEventListener('dragover',e=>{
    const z=e.target&&e.target.closest&&e.target.closest('[data-role="cap-zone"]');
    if(!z||!_capBloc(z))return;
    e.preventDefault();z.classList.add('drag-ov');
  });
  host.addEventListener('dragleave',e=>{
    const z=e.target&&e.target.closest&&e.target.closest('[data-role="cap-zone"]');
    if(!z||!_capBloc(z))return;
    z.classList.remove('drag-ov');
  });
  host.addEventListener('drop',e=>{
    const z=e.target&&e.target.closest&&e.target.closest('[data-role="cap-zone"]');
    if(!z||!_capBloc(z))return;
    e.preventDefault();z.classList.remove('drag-ov');
    const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(!f||!f.type.startsWith('image/'))return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=z.querySelector('[data-role="cap-img"]');
      const ph=z.querySelector('[data-role="cap-ph"]');
      if(img){img.setAttribute('src',ev.target.result);img.style.display='block';}
      if(ph)ph.style.display='none';
      window._scheduleAutoSaveDb?.('ordnt');
    };
    rd.readAsDataURL(f);
  });
  host.addEventListener('click',e=>{
    const opt=e.target&&e.target.closest&&e.target.closest('.ac-opt');
    if(!opt)return;
    _applyBenef(_blocOf(opt),{
      den:opt.dataset.benDen||'',cif:opt.dataset.benCif||'',
      iban:opt.dataset.benIban||'',banca:opt.dataset.benBanca||'',
    });
  });
})();

// Închide dropdown-urile TUTUROR blocurilor la click în afară (mai puțin cel care conține ținta).
document.addEventListener('click',e=>{
  document.querySelectorAll('[data-role="benef-drop"]').forEach(drop=>{
    if(drop.contains(e.target))return;
    if(_bFld(_blocOf(drop),'beneficiar')===e.target)return;
    drop.style.display='none';
  });
});

// ── Salvare automată beneficiar la Trimite P2 ─────────────────────────────────
// #128j — salvează beneficiarul FIECĂRUI bloc (sare peste cele cu denumirea goală).
async function _saveBeneficiarIfNew(){
  const blocs=_blocList();
  for(const bloc of blocs){
    const v=fld=>(_bFld(bloc,fld)?.value||'').trim();
    const den=v('beneficiar');
    if(!den)continue;
    try{
      await fetch('/api/beneficiari',{
        method:'POST',credentials:'include',
        headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
        body:JSON.stringify({denumire:den,cif:v('cif_beneficiar'),iban:v('iban_beneficiar'),banca:v('banca_beneficiar')}),
      });
    }catch(_){}
  }
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
    const _listTab=ft==='notafd'?'df':'ord';
    btn.textContent=ft==='notafd'?'← Înapoi la lista DF':'← Înapoi la lista ORD';
    btn.onclick=()=>showListSection(_listTab);
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
  // #130 — o singură decizie controlează antetul ȘI celulele coloanelor de bani (vezi CSS
  // `.lst-table-wrap:not(.lst-tip-ord) .lst-col-ord`) — nu pot desincroniza.
  document.querySelector('.lst-table-wrap')?.classList.toggle('lst-tip-ord',type==='ord');
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
  const ltabFacturi=document.getElementById('ltab-facturi');
  if(ltabFacturi)ltabFacturi.classList.toggle('active',type==='facturi');
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
  const facturiSection=document.getElementById('facturi-section');
  if(type==='alop'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    if(facturiSection)facturiSection.style.display='none';
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
    if(facturiSection)facturiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='clasa8'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='';
    if(facturiSection)facturiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof openClasa8==='function')openClasa8();
  }else if(type==='facturi'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    if(facturiSection)facturiSection.style.display='';
    const _foF=document.getElementById('foList');if(_foF)_foF.style.display='none';
    if(typeof openFacturi==='function')openFacturi();
  }else if(type==='rfn'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    if(facturiSection)facturiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='nfi'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='';
    if(clasa8Section)clasa8Section.style.display='none';
    if(facturiSection)facturiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else{
    if(lstWrap)lstWrap.style.display='';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    if(facturiSection)facturiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof _populateCompartimente==='function')_populateCompartimente();
    loadList();
  }
}
// Acordul numeralului în română: numeralele ≥ 20 cer „de", cu excepția celor ale căror
// ultime două cifre sunt între 1 și 19.
//   0  → „0 documente"      1   → „1 document"       19 → „19 documente"
//   20 → „20 de documente"  83  → „83 de documente"  100 → „100 de documente"
//   101 → „101 documente"   112 → „112 documente"    120 → „120 de documente"
function _lstCountLabel(n){
  if(n === 1) return ' document';
  const lastTwo = n % 100;
  const needsDe = n >= 20 && !(lastTwo >= 1 && lastTwo <= 19);
  return needsDe ? ' de documente' : ' documente';
}

// Afișează/ascunde contorul din antetul listei. `total` vine de la server (nu rows.length —
// acela e doar pagina curentă) și reflectă automat filtrele active.
function _setLstCount(total){
  const box = document.getElementById('lst-count');
  const nEl = document.getElementById('lst-count-n');
  const wEl = document.getElementById('lst-count-w');
  if(!box || !nEl || !wEl) return;
  if(total === null || total === undefined){ box.hidden = true; return; }
  const n = Number(total) || 0;
  nEl.textContent = String(n);
  wEl.textContent = _lstCountLabel(n);
  box.hidden = false;
}
// #132a — DF și ORD NU au aceleași stări. `neaprobat` și `de_revizuit` se scriu exclusiv
// pe formulare_df (garda isNotafd din formular-capabilities.mjs:87-88), iar `transmis_flux`
// e scris brut doar la DF (FORMULAR_TYPES.df.linkFlowSetsStatus; la ORD e null, se derivă).
// ORICE valoare de aici trebuie să aibă ramura ei de filtru în shared.mjs, altfel filtrul
// cade tăcut pe ramura generică și întoarce zero rezultate.
const _LST_STATUS_OPTS={
  df:[['all','Toate'],['draft','Draft'],['pending_p2','La Responsabil CAB'],['returnat','Returnat'],
      ['completed','Completat'],['transmis_flux','Trimis flux'],['de_revizuit','De revizuit'],
      ['aprobat','Aprobat'],['neaprobat','Neaprobat']],
  ord:[['all','Toate'],['draft','Draft'],['pending_p2','La Responsabil CAB'],['returnat','Returnat'],
       ['completed','Completat'],['transmis_flux','Trimis flux'],['aprobat','Aprobat'],
       ['neaprobat','Neaprobat']]
};
function _setLstStatusOpts(type){
  const sel=document.getElementById('flt-status');
  if(!sel)return;
  const opts=_LST_STATUS_OPTS[type];
  if(!opts)return;                        // alte taburi nu folosesc acest select
  if(sel.dataset.lstType===type)return;   // deja populat pentru tipul curent — idempotent
  const prev=sel.value;
  sel.replaceChildren(...opts.map(function(o){
    const el=document.createElement('option');el.value=o[0];el.textContent=o[1];return el;
  }));
  sel.dataset.lstType=type;
  sel.value=opts.some(function(o){return o[0]===prev;})?prev:'all';
}
// #133a — construcția query string-ului listei DF/ORD, PARTAJATĂ între loadList (paginat)
// și exportLista (?all=1, fără page/limit) — o singură sursă pentru filtre, ca să nu se
// poată desincroniza.
function _lstQuery(opts){
  opts=opts||{};
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
  if(opts.all){
    p.push('all=1');
  }else{
    p.push('page='+_lstState.page);
    p.push('limit='+_lstState.limit);
  }
  return p.join('&');
}
async function loadList(){
  // #130 — încărcarea inițială nu trece prin switchListTab, deci comutarea clasei se repetă aici.
  document.querySelector('.lst-table-wrap')?.classList.toggle('lst-tip-ord',_lstState.type==='ord');
  // #132a — din același motiv, opțiunile de Status se sincronizează AICI (nu în switchListTab):
  // e singurul punct prin care trec toate căile de încărcare a listei DF/ORD.
  _setLstStatusOpts(_lstState.type);
  const tb=document.getElementById('lst-tbody');
  const em=document.getElementById('lst-empty');
  const ld=document.getElementById('lst-loading');
  const pg=document.getElementById('lst-pagination');
  if(tb)tb.innerHTML='';
  if(em)em.style.display='none';
  if(ld)ld.style.display='';
  if(pg)pg.style.display='none';
  _setLstCount(null);   // ascuns cât se încarcă — nu lăsăm o cifră veche peste o listă nouă
  try{
    const r=await fetch('/api/formulare/list?'+_lstQuery(),{credentials:'include'});
    if(ld)ld.style.display='none';
    if(!r.ok){if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}_setLstCount(null);return;}
    const j=await r.json();
    const rows=j.rows||[];
    const total=j.total||0;
    _setLstCount(total);   // și pe ramura goală: „0 documente" e exact confirmarea de care are nevoie
    if(!rows.length){if(em)em.style.display='';}
    else{_renderLstTable(rows,_lstState.type);_renderLstPagin(total,_lstState.page,_lstState.limit);}
  }catch(e){if(ld)ld.style.display='none';if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}_setLstCount(null);}
}
// #133a — etichetă în clar (FĂRĂ emoji), sursă unică pentru _stBadge (emoji + culoare)
// ȘI pentru exportLista (Excel-ul primește textul curat, nu cheia tehnică nici emoji-ul).
const _ST_LABELS={draft:'Draft',pending_p2:'La Responsabil CAB',completed:'Completat',
  generat_pdf:'PDF generat',transmis_flux:'Trimis flux',
  aprobat:'Aprobat',respins:'Respins',anulat:'Anulat',returnat:'Returnat',
  neaprobat:'Neaprobat',de_revizuit:'De revizuit'};
function _stBadge(status){
  const emoji={draft:'📝',pending_p2:'📤',completed:'✅',
    generat_pdf:'📄',transmis_flux:'🔄',
    aprobat:'🟢',respins:'❌',anulat:'🚫',returnat:'↩',
    neaprobat:'❌',de_revizuit:'🔄'};
  const cls={draft:'st-draft',pending_p2:'st-transmis_p2',completed:'st-completat',
    generat_pdf:'st-generat_pdf',transmis_flux:'st-transmis_flux',
    aprobat:'st-aprobat',respins:'st-respins',anulat:'st-anulat',returnat:'st-returnat',
    neaprobat:'st-neaprobat',de_revizuit:'st-de-revizuit'};
  const label=_ST_LABELS[status]||status;
  const txt=(emoji[status]?emoji[status]+' ':'')+label;
  return`<span class="stbadge ${cls[status]||'st-draft'}">${esc(txt)}</span>`;
}
function _fmtDate(iso){
  if(!iso)return '—';
  try{return new Date(iso).toLocaleString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
  catch{return iso;}
}
// #130 — formatare monetară pentru coloanele de bani din listă.
function _lstBani(v){
  const n=parseFloat(v);
  if(!isFinite(n))return '—';
  return (typeof fMR==='function'?fMR(n):n.toFixed(2))+' lei';
}
// #130 — „cât s-a plătit". NULL = nu s-a plătit / nu e legat de ALOP ⇒ liniuță, NU „0,00".
// Verde = plătit integral, chihlimbar = plătit parțial. Toleranță 0.01 pentru rotunjiri.
function _lstPlata(plata,valoare){
  if(plata==null)return '<span style="color:var(--df-text-3)">—</span>';
  const p=parseFloat(plata),v=parseFloat(valoare);
  if(!isFinite(p))return '<span style="color:var(--df-text-3)">—</span>';
  const txt=_lstBani(p);
  if(isFinite(v)&&v>0&&p+0.01>=v)return `<span style="color:#22c55e">${txt}</span>`;
  if(p>0)return `<span style="color:#f59e0b" title="Plată parțială">${txt}</span>`;
  return txt;
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
    // #126 A6: semnal discret — alt DOSAR ALOP folosește același număr unic.
    // Calculat server-side (nr_partajat); NU blochează nimic.
    const nrPartajatBadge=(type==='df'&&row.nr_partajat===true)
      ?`<span style="vertical-align:middle;margin-left:4px;padding:1px 7px;border-radius:8px;font-size:.65rem;font-weight:600;background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)" title="Alt document folosește același număr unic — verificați dacă nu trebuia o revizie">⚠ nr. partajat</span>`
      :'';
    return`<tr onclick="openDocFromList('${type}','${safeId}')" style="cursor:pointer">
      <td><a href="#" onclick="openDocFromList('${type}','${safeId}');return false" style="font-weight:500">${nr}${revBadgeLst}${istoricBadgeLst}${nrPartajatBadge}</a><button type="button" class="trasab-inline-btn" onclick="event.stopPropagation();openTrasabilitate('${type}','${safeId}');return false" title="Vezi trasabilitate (lanț DF↔ALOP↔ORD)">🔗</button>${titlu?`<br><small style="color:#666">${titlu}</small>`:''}
      </td>
      <td>${esc(row.initiator||'—')}</td>
      <td>${esc(row.initiator_comp||'—')}</td>
      <td>${row.p2_compartiment
        ? `<span title="Atribuit întregului compartiment — oricine din el poate completa">👥 ${esc(row.p2_compartiment)}</span>`
        : esc(row.p2||'—')}</td>
      <td class="lst-col-ord" style="text-align:right;white-space:nowrap">${_lstBani(row.ord_valoare)}</td>
      <td class="lst-col-ord" style="text-align:right;white-space:nowrap">${_lstPlata(row.plata_suma,row.ord_valoare)}</td>
      <td>${_stBadge(row.badge_status)}</td>
      <td>
        <div>${_fmtDate(row.created_at)}</div>
        ${row.initiator ? `<div style="font-size:.75rem;color:var(--df-text-3);margin-top:2px">${esc(row.initiator)}</div>` : ''}
      </td>
      <td>
        <div>${_fmtDate(row.updated_at)}</div>
        ${row.updated_by_nume ? `<div style="font-size:.75rem;color:var(--df-text-3);margin-top:2px">${esc(row.updated_by_nume)}</div>` : ''}
      </td>
      <td onclick="event.stopPropagation()" style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="df-action-btn sm" style="display:none" onclick="openDocFromList('${type}','${safeId}')">Deschide</button>
        ${auditBtn}
        ${cancelBtn}
      </td>
    </tr>`;
  }).join('');
}
function _renderLstPagin(total,page,limit){
  // PAGIN-8 — componentă partajată DFPagin (paginare pe SERVER: onChange refetch).
  const pg=document.getElementById('lst-pagination');
  if(!pg)return;
  if(window.DFPagin && typeof window.DFPagin.render==='function'){
    window.DFPagin.render({
      container:pg,
      total,
      page,
      limit,
      mode: 'numbered',
      onChange:(p)=>{_lstState.page=p;loadList();},
    });
  }else{
    console.error('DFPagin indisponibil — paginarea listei DF/ORD e ascunsă');
    pg.replaceChildren();
    pg.style.display='none';
  }
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
// #133a — export Excel pe lista FILTRATĂ (nu doar pagina curentă): reia _lstQuery({all:true}),
// care trece prin exact aceleași `conds`/autorizare de pe server ca loadList (?all=1, vezi
// shared.mjs). ⛔ NU construi din DOM/ultimul răspuns memorat — ar exporta o singură pagină.
async function exportLista(){
  const type=_lstState.type;
  if(type!=='df'&&type!=='ord'){
    alert('Exportul este disponibil doar pentru listele DF și ORD.');
    return;
  }
  if(typeof window.DFXlsx==='undefined'){
    console.error('DFXlsx indisponibil — modulul de export nu s-a încărcat');
    alert('Modulul de export nu s-a încărcat. Reîncărcați pagina.');
    return;
  }
  const btn=document.getElementById('btn-lst-export');
  const orig=btn?btn.innerHTML:'';
  if(btn){btn.disabled=true;btn.textContent='⏳ Se pregătește…';}
  try{
    const r=await fetch('/api/formulare/list?'+_lstQuery({all:true}),{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.ok){alert('Eroare la pregătirea exportului.');return;}
    const rows=j.rows||[];
    const total=j.total||0;
    if(!rows.length){alert('Nu există documente pentru filtrele curente');return;}

    const fmtDt=iso=>iso?new Date(iso).toLocaleString('ro-RO'):'';
    const respCab=row=>row.p2_compartiment||row.p2||'';
    const stLabel=row=>_ST_LABELS[row.badge_status]||row.badge_status||'';

    let aoa,numericCols,sheet,filename;
    if(type==='df'){
      aoa=[['Nr.','Titlu','Revizie','Inițiator','Compartiment','Responsabil CAB','Status','Creat la','Actualizat la','Actualizat de']];
      rows.forEach(row=>{
        aoa.push([
          row.nr||'', row.titlu||'', 'R'+(row.revizie_nr||0),
          row.initiator||'', row.initiator_comp||'', respCab(row),
          stLabel(row), fmtDt(row.created_at), fmtDt(row.updated_at), row.updated_by_nume||'',
        ]);
      });
      numericCols=[];
      sheet='Documente de Fundamentare';
      filename='DF_';
    }else{
      aoa=[['Nr.','Furnizor','Inițiator','Compartiment','Responsabil CAB','Valoare ORD','Plată','Status','Creat la','Actualizat la','Actualizat de']];
      rows.forEach(row=>{
        aoa.push([
          row.nr||'', row.titlu||'', row.initiator||'', row.initiator_comp||'', respCab(row),
          Number(row.ord_valoare)||0,
          row.plata_suma==null?'—':Number(row.plata_suma),
          stLabel(row), fmtDt(row.created_at), fmtDt(row.updated_at), row.updated_by_nume||'',
        ]);
      });
      numericCols=[5,6];
      sheet='Ordonanțări de Plată';
      filename='ORD_';
    }

    await window.DFXlsx.save(aoa,{sheet,filename,numericCols});

    if(rows.length<total){
      alert('S-au exportat primele '+rows.length+' din '+total+' documente (plafon de siguranță). Restrângeți filtrele pentru un export complet.');
    }
  }catch(e){
    alert('Export eșuat: '+(e.message||e));
  }finally{
    if(btn){btn.disabled=false;btn.innerHTML=orig;}
  }
}
window.exportLista=exportLista;

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
  window._lstBani                = _lstBani;
  window._lstPlata               = _lstPlata;

  window.df = window.df || {};
  window.df._formularListLoaded = true;
})();
