// JS specific templates.html — CRUD șabloane flux (creare / editare / ștergere / listare).
// Conține logica din Block 2 inline (fost L260-L652). Folosește _apiFetch (shim global
// din df-apifetch-shim.js) pentru toate mutațiile — CSRF header trimis automat.
// Rulează la final de <body>, DUPĂ ce DOM-ul și df-shell/df-user-modals sunt gata.

const $ = id => document.getElementById(id);
function hdrs() { return { 'Content-Type': 'application/json' }; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const ATRIBUTE = [
  'ÎNTOCMIT','VERIFICAT','VIZAT','AVIZAT','APROBAT',
  'VIZĂ CFPP','VIZĂ JURIDICĂ','VIZĂ TEHNICĂ','VIZĂ ECONOMICĂ',
  'CONTROLAT','CERTIFICAT','CONTRASEMNAT','ÎNSUȘIT','ASUMAT',
  'SEMNAT','LUAT LA CUNOȘTINȚĂ','ÎNREGISTRAT','CONFIRMAT','__alt__'
];
let signerCounter = 0;

// BLOC 4.3: helper care setează value/dataset/textContent pe option,
// detectând concediul și marcând delegarea pentru auto-substituire la submit.
function _tmplApplyUserToOption(opt, u) {
  const onLeave = !!(u.leave?.onLeave);
  const hasDelegate = !!(u.leave?.delegate?.email);

  if (onLeave && hasDelegate) {
    opt.value = u.leave.delegate.nume || u.leave.delegate.email;
    opt.dataset.email = u.leave.delegate.email;
    opt.dataset.functie = u.leave.delegate.functie || u.functie || '';
    opt.dataset.delegateEmail = u.leave.delegate.email;
    opt.dataset.delegateName = u.leave.delegate.nume || '';
    opt.dataset.originalUserId = String(u.id);
    opt.dataset.originalName = u.nume || '';
    opt.dataset.originalEmail = u.email || '';
    opt.textContent = `${u.nume || u.email} (concediu — semnează ${u.leave.delegate.nume})`;
    opt.style.fontStyle = 'italic';
  } else if (onLeave && !hasDelegate) {
    opt.value = u.nume || '';
    opt.dataset.email = u.email || '';
    opt.disabled = true;
    opt.textContent = `${u.nume || u.email} (concediu — fără delegat ⚠)`;
    opt.style.color = '#999';
  } else {
    opt.value = u.nume || '';
    opt.dataset.email = u.email || '';
    opt.dataset.functie = u.functie || '';
    opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
  }
}

function buildAtribOptions(selected) {
  return ATRIBUTE.map(a => {
    const label = a === '__alt__' ? 'Alt atribut...' : a;
    return `<option value="${a}"${a===selected?' selected':''}>${label}</option>`;
  }).join('');
}

// Returnează valorile utilizatorilor deja selectați dintr-un tbody, excluzând rândul curent
function getUsedUsers(tbody, excludeRow) {
  const used = new Set();
  tbody.querySelectorAll('tr').forEach(tr => {
    if (tr === excludeRow) return;
    const sel = tr.querySelector('.s-name-sel');
    if (sel && sel.value && sel.value !== '' && sel.value !== '__manual__') used.add(sel.value);
  });
  return used;
}

// Reîmprospătează toate dropdown-urile dintr-un tbody pentru a ascunde utilizatorii deja selectați
function refreshAllDropdowns(containerId) {
  const container = $(containerId);
  if (!container || !window._tmplUsers) return;
  const rows = container.querySelectorAll('tr');
  rows.forEach(tr => {
    const sel = tr.querySelector('.s-name-sel');
    if (!sel || sel.style.display === 'none') return;
    const currentVal = sel.value;
    const used = getUsedUsers(container, tr);
    // Rebuild options
    while (sel.options.length > 1) sel.remove(1);
    (window._tmplUsers || []).forEach(u => {
      if (used.has(u.nume)) return; // ascunde utilizatorii deja selectați în alte rânduri
      const opt = document.createElement('option');
      _tmplApplyUserToOption(opt, u);
      sel.appendChild(opt);
    });

    // Restaurează selecția curentă dacă nu e folosită în altă parte
    if (currentVal && !used.has(currentVal)) sel.value = currentVal;
  });
}

function addSignerRow(target='create', data={}) {
  const cid = target === 'edit' ? 'editSignersBuilder' : 'signersBuilder';
  const container = $(cid);
  const id = ++signerCounter;
  const tr = document.createElement('tr');
  tr.draggable = true;
  tr.dataset.id = id;

  const selectedAtrib = data.atribut || 'ÎNTOCMIT';
  const isAlt = !ATRIBUTE.includes(selectedAtrib) || selectedAtrib === '__alt__';
  const atribValue = isAlt ? '__alt__' : selectedAtrib;
  const customValue = isAlt ? selectedAtrib : '';

  tr.innerHTML = `
    <td class="drag-handle">⠿</td>
    <td>
      <select class="s-atrib">${buildAtribOptions(atribValue)}</select>
      <input class="s-atrib-custom" type="text" placeholder="Scrie atributul..."
        style="display:${atribValue==='__alt__'?'block':'none'};margin-top:4px;"
        value="${esc(customValue)}"/>
    </td>
    <td><input type="text" class="s-functie" placeholder="—" value="${esc(data.functie||'')}"
      readonly style="opacity:.65;cursor:default;background:rgba(255,255,255,.02);"/></td>
    <td>
      <select class="s-name-sel" style="width:100%;"><option value="">— Alege utilizator —</option></select>
      <input type="hidden" class="s-email" value="${esc(data.email||'')}"/>
    </td>
        <td><button class="df-action-btn danger sm btnDel" type="button">Șterge</button></td>
  `;

  // ── Atrib custom toggle
  const atribSel = tr.querySelector('.s-atrib');
  const atribCustom = tr.querySelector('.s-atrib-custom');
  atribSel.addEventListener('change', () => {
    atribCustom.style.display = atribSel.value === '__alt__' ? 'block' : 'none';
  });

  // ── User dropdown
  const nameSel = tr.querySelector('.s-name-sel');
  const functieIn = tr.querySelector('.s-functie');
  const emailIn = tr.querySelector('.s-email');

  if (window._tmplUsers) {
    refreshAllDropdowns(cid); // rebuild toate + adaugă opțiunile pentru noul rând
    // Populează dropdown-ul noului rând (refresh nu l-a atins că nu era în DOM încă)
    const used = getUsedUsers(container, tr);
    while (nameSel.options.length > 1) nameSel.remove(1);
    (window._tmplUsers || []).forEach(u => {
      if (used.has(u.nume)) return;
      const opt = document.createElement('option');
      opt.value = u.nume || '';
      opt.dataset.email = u.email || '';
      opt.dataset.functie = u.functie || '';
      opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
      nameSel.appendChild(opt);
    });

  }

  nameSel.addEventListener('change', () => {

    const user = (window._tmplUsers||[]).find(u => u.nume === nameSel.value);
    if (user) {
      functieIn.value = user.functie || '';
      emailIn.value = user.email || '';
      functieIn.style.opacity='.65'; functieIn.style.cursor='default';
      emailIn.style.opacity='.65'; emailIn.style.cursor='default';
    } else {
      functieIn.value=''; emailIn.value='';
    }
    // Reîmprospătează celelalte dropdown-uri pentru a ascunde utilizatorul tocmai selectat
    refreshAllDropdowns(cid);
  });

  // ── Pre-selectare dacă datele există
  if (data.name && window._tmplUsers) {
    const found = Array.from(nameSel.options).find(o => o.value === data.name);
    if (found) {
      nameSel.value = data.name;
      const usr = window._tmplUsers.find(u => u.nume === data.name);
      if (usr) { functieIn.value = usr.functie||''; emailIn.value = usr.email||''; }
    }
  }

  // ── Drag & drop
  let dragSrc = null;
  tr.addEventListener('dragstart', e => { dragSrc = tr; e.dataTransfer.effectAllowed='move'; tr.style.opacity='.4'; });
  tr.addEventListener('dragend',   () => { tr.style.opacity=''; });
  tr.addEventListener('dragover',  e => { e.preventDefault(); tr.classList.add('drag-over'); });
  tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
  tr.addEventListener('drop', e => {
    e.preventDefault(); tr.classList.remove('drag-over');
    if (dragSrc && dragSrc !== tr) container.insertBefore(dragSrc, tr);
    dragSrc = null;
  });

  // ── Șterge
  tr.querySelector('.btnDel').addEventListener('click', () => {
    tr.remove();
    refreshAllDropdowns(cid);
  });

  container.appendChild(tr);

  // Auto-fill ÎNTOCMIT cu userul logat pe primul rând
  if (selectedAtrib === 'ÎNTOCMIT' && !data.name) {
    const me = JSON.parse(localStorage.getItem('docflow_user')||'{}');
    if (me.email && window._tmplUsers) {
      const myUser = window._tmplUsers.find(u => u.email && u.email.toLowerCase() === me.email.toLowerCase());
      if (myUser) {
        const opt = Array.from(nameSel.options).find(o => o.value === myUser.nume);
        if (opt) {
          nameSel.value = myUser.nume;
          functieIn.value = myUser.functie||'';
          emailIn.value = myUser.email||'';
          refreshAllDropdowns(cid);
        }
      }
    }
  }
}

function getSigners(cid) {
  return Array.from($(cid).querySelectorAll('tr')).map(r => {
    const atribSel = r.querySelector('.s-atrib');
    const atrib = atribSel.value === '__alt__'
      ? (r.querySelector('.s-atrib-custom')?.value?.trim() || 'ALT ATRIBUT')
      : atribSel.value;
    const nameSel = r.querySelector('.s-name-sel');
    const name = nameSel ? nameSel.value.trim() : '';
    return {
      atribut: atrib,
      functie: r.querySelector('.s-functie').value.trim(),
      name,
      email: r.querySelector('.s-email').value.trim().toLowerCase(),
    };
  });
}

addSignerRow(); // pornește cu un rând

async function saveTemplate() {
  const name = $('tName').value.trim();
  if (!name) { showMsg('createMsg','Completează numele șablonului.',true); return; }
  const signers = getSigners('signersBuilder');
  if (!signers.length) { showMsg('createMsg','Adaugă cel puțin un semnatar.',true); return; }
  if (signers.some(s=>!s.name||!s.email)) { showMsg('createMsg','Completează numele și emailul pentru toți semnatarii.',true); return; }
  const btn=$('btnSave'); btn.disabled=true; btn.textContent='⏳ Se salvează...';
  try {
    const r = await _apiFetch('/api/templates',{method:'POST',headers:hdrs(),body:JSON.stringify({name,signers,shared:$('tShared').checked})});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    showMsg('createMsg','✅ Șablon salvat!',false);
    $('tName').value=''; $('tShared').checked=false;
    $('signersBuilder').innerHTML=''; addSignerRow();
    loadTemplates();
  } catch(e) { showMsg('createMsg','❌ Eroare: '+e.message,true); }
  btn.disabled=false; btn.textContent='💾 Salvează șablonul';
}

let allTemplates = [];

async function loadTemplates() {
  try {
    const r = await _apiFetch('/api/templates');
    if (r.status===401){location.href='/login';return;}
    allTemplates = await r.json();
    renderTemplates();
  } catch(e) {
    $('myGrid').innerHTML=`<div class="empty-state"><div class="empty-icon">⚠️</div><div>Eroare la încărcare</div></div>`;
  }
}

function renderTemplates() {
  const mine = allTemplates.filter(t=>t.isOwner);
  const shared = allTemplates.filter(t=>!t.isOwner);
  $('myCount').textContent=`(${mine.length})`;
  const total = mine.length + (shared && shared.length ? shared.length : 0);
  const subCnt = document.getElementById('tmplListCount');
  if (subCnt) subCnt.textContent = total;
  $('myGrid').innerHTML = mine.length ? '' : `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">Niciun șablon încă</div><div style="font-size:.82rem;margin-top:4px;">Creează primul tău șablon mai sus.</div></div>`;
  mine.forEach((t,i)=>$('myGrid').appendChild(buildCard(t,i)));
  if (shared.length) {
    $('sharedSection').style.display='';
    $('sharedCount').textContent=`(${shared.length})`;
    $('sharedGrid').innerHTML='';
    shared.forEach((t,i)=>$('sharedGrid').appendChild(buildCard(t,i)));
  } else { $('sharedSection').style.display='none'; }
}

function buildCard(t,idx) {
  const div=document.createElement('div');
  div.className='tmpl-card'+((!t.isOwner)?' shared-card':'');
  div.style.animationDelay=(idx*40)+'ms';
  const dt=t.created_at?new Date(t.created_at).toLocaleDateString('ro-RO'):'—';
  const badge = !t.isOwner
    ? '<span class="tmpl-badge badge-extern">instituție</span>'
    : t.shared ? '<span class="tmpl-badge badge-shared">shared</span>'
    : '<span class="tmpl-badge badge-private">privat</span>';
  const signersHtml=(t.signers||[]).map((s,i)=>`
    <div class="tmpl-signer-item">
      <span class="signer-idx">${i+1}.</span>
      <div class="signer-info">
        <div class="signer-name-row">${esc(s.name||'—')} <span class="atrib-pill">${esc(s.atribut||'')}</span></div>
        <div class="signer-sub">${esc(s.functie||'')} · ${esc(s.email||'')}</div>
      </div>
    </div>`).join('');
  const shareBtnContent = t.shared
    ? '<svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-shield"/></svg>Fă privat'
    : '<svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-building"/></svg>Share';
  const actions = t.isOwner ? `
    <button class="df-action-btn sm" onclick='openEdit(${JSON.stringify(t)})'><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-edit"/></svg>Editează</button>
    <button class="df-action-btn sm" onclick="toggleShared(${t.id},${t.shared})">${shareBtnContent}</button>
    <button class="df-action-btn danger sm" onclick="deleteTemplate(${t.id},'${esc(t.name)}')"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-trash"/></svg>Șterge</button>
    <button class="df-action-btn sm" onclick="copyTemplate(${t.id})"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-clipboard"/></svg>Copiază</button>`
  : `<button class="df-action-btn success sm" onclick="copyTemplate(${t.id})"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-clipboard"/></svg>Copiază ca al meu</button>`;
  div.innerHTML=`
    <div class="tmpl-name">${esc(t.name)} ${badge}</div>
    <div class="tmpl-meta">${(t.signers||[]).length} semnatari · ${dt}</div>
    <div class="tmpl-signers">${signersHtml}</div>
    <div class="tmpl-actions">
      <button class="df-action-btn cta sm" onclick="useTemplate(${t.id})"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-play"/></svg>Folosește</button>
      ${actions}
    </div>`;
  return div;
}

function useTemplate(id) {
  const t = allTemplates.find(x=>x.id===id);
  if (!t) return;
  sessionStorage.setItem('applyTemplate', JSON.stringify(t));
  location.href = '/';
}

function openEdit(t) {
  $('eId').value=t.id; $('eName').value=t.name; $('eShared').checked=!!t.shared;
  $('editSignersBuilder').innerHTML='';
  (t.signers||[]).forEach(s=>addSignerRow('edit',s));
  $('editMsg').textContent='';
  $('editModal').classList.add('open');
}
function closeEdit(){$('editModal').classList.remove('open');}

async function saveEdit() {
  const id=$('eId').value, name=$('eName').value.trim();
  if (!name){showMsg('editMsg','Completează numele.',true);return;}
  const signers=getSigners('editSignersBuilder');
  if (signers.some(s=>!s.name||!s.email)){showMsg('editMsg','Completează toți semnatarii.',true);return;}
  try {
    const r=await _apiFetch('/api/templates/'+id,{method:'PUT',headers:hdrs(),body:JSON.stringify({name,signers,shared:$('eShared').checked})});
    if (!r.ok) throw new Error((await r.json()).error);
    closeEdit(); loadTemplates();
  } catch(e){showMsg('editMsg','❌ '+e.message,true);}
}

async function toggleShared(id,currentShared) {
  const t=allTemplates.find(x=>x.id===id); if(!t)return;
  try {
    const r=await _apiFetch('/api/templates/'+id,{method:'PUT',headers:hdrs(),body:JSON.stringify({name:t.name,signers:t.signers,shared:!currentShared})});
    if(!r.ok) throw new Error(); loadTemplates();
  } catch(e){alert('Eroare la actualizare.');}
}

async function deleteTemplate(id,name) {
  if(!confirm(`Ștergi șablonul "${name}"?`))return;
  try {
    const r=await _apiFetch('/api/templates/'+id,{method:'DELETE',headers:hdrs()});
    if(!r.ok) throw new Error(); loadTemplates();
  } catch(e){alert('Eroare la ștergere.');}
}

async function copyTemplate(id) {
  const t = allTemplates.find(x=>x.id===id);
  if (!t) return;
  const newName = t.isOwner
    ? (prompt('Nume pentru copie:', t.name + ' (copie)') || null)
    : (prompt('Salvează ca șablon privat al tău. Nume:', t.name) || null);
  if (!newName) return;
  try {
    const r = await _apiFetch('/api/templates', {method:'POST', headers:hdrs(), body:JSON.stringify({
      name: newName.trim(), signers: t.signers, shared: false
    })});
    if (!r.ok) throw new Error();
    showMsg('createMsg', '✅ Șablon copiat ca privat!', false);
    loadTemplates();
  } catch(e) { alert('Eroare la copiere.'); }
}

function showMsg(id,txt,err) {
  const el=$(id); el.className='msg '+(err?'err':'ok'); el.textContent=txt;
  setTimeout(()=>{el.textContent='';el.className='';},5000);
}

document.addEventListener('keydown',e=>{if(e.key==='Escape')closeEdit();});

// Încarcă utilizatori pentru dropdown-uri
(async function loadUsers() {
  try {
    const r = await _apiFetch('/users');
    if (!r.ok) { console.warn('fetch /users failed:', r.status); return; }
    window._tmplUsers = await r.json();

    // Populează rândul existent
    const firstRow = $('signersBuilder').querySelector('tr');
    if (firstRow) {
      const sel = firstRow.querySelector('.s-name-sel');
      const functieIn = firstRow.querySelector('.s-functie');
      const emailIn = firstRow.querySelector('.s-email');
      if (sel) {
        while (sel.options.length > 1) sel.remove(1);
        window._tmplUsers.forEach(u => {
          const opt = document.createElement('option');
          _tmplApplyUserToOption(opt, u);
          sel.appendChild(opt);
        });

        // Auto-fill cu userul logat dacă ÎNTOCMIT
        const meUser = JSON.parse(localStorage.getItem('docflow_user')||'{}');
        if (meUser.email) {
          const found = window._tmplUsers.find(u => u.email && u.email.toLowerCase() === meUser.email.toLowerCase());
          if (found) {
            sel.value = found.nume||'';
            if (functieIn) { functieIn.value = found.functie||''; }
            if (emailIn)   { emailIn.value = found.email||''; }
            refreshAllDropdowns('signersBuilder');
          }
        }
      }
    }
  } catch(e) { console.warn('Nu s-au putut incarca userii:', e); }
})();

loadTemplates();
