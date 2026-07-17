// JS specific notifications.html — listă notificări + filtre + banner permisiuni.
// Conține logica din 2 blocuri inline originale: main (Block 2) + banner-check (Block 3).
// Block 3 (permission banner check) nu depinde de notif-widget.js — verifică doar
// Notification.permission și setează display pe elementul static #nw-perm-banner.
// Rulează la final de <body>, DUPĂ ce DOM-ul e parsat.

const $ = id => document.getElementById(id);

let allNotifs = [];
let receivedItems = [];
let currentFilter = 'all';

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderList();
  };
});

// Load notifications
async function loadNotifs() {
  try {
    const [r, rReceived] = await Promise.all([
      _apiFetch('/api/notifications/with-status'),
      _apiFetch('/api/my-received').catch(() => null),
    ]);
    if (r.status === 401 || r.status === 403) { location.href = '/login'; return; }
    if (!r.ok) throw new Error('fetch_failed');
    allNotifs = await r.json();
    if (rReceived && rReceived.ok) receivedItems = await rReceived.json();
    renderList();
    updateReadAllBtn();
  } catch(e) {
    if (e.message === 'unauthorized') { location.href = '/login'; return; }
    $('listArea').innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Eroare la încărcare</div><div>Încearcă să te <a href="/login" style="color:var(--accent)">reloghezi</a>.</div></div>`;
  }
}

const FORMULARE_TYPES = new Set(['formulare_df_p2','formulare_ord_p2','formulare_df_completed','formulare_ord_completed','formulare_df_returnat','formulare_ord_returnat']);

function typeIcon(type) {
  if (type === 'YOUR_TURN') return '✍️';
  if (type === 'COMPLETED') return '✅';
  if (type === 'REFUSED') return '⛔';
  if (type === 'REVIEW_REQUESTED') return '🔄';
  if (type === 'formulare_df_p2' || type === 'formulare_ord_p2') return '📄';
  if (type === 'formulare_df_completed' || type === 'formulare_ord_completed') return '✅';
  if (type === 'formulare_df_returnat' || type === 'formulare_ord_returnat') return '↩';
  return '🔔';
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'acum câteva secunde';
  if (m < 60) return `acum ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `acum ${h}h`;
  const d = Math.floor(h / 24);
  return `acum ${d} ${d===1?'zi':'zile'}`;
}

function filtered() {
  if (currentFilter === 'all') return allNotifs;
  if (currentFilter === 'unread') return allNotifs.filter(n => !n.read);
  if (currentFilter === 'urgent') return allNotifs.filter(n => !!(n.urgent || n.flow_urgent));
  if (currentFilter === 'YOUR_TURN') {
    // Arata doar notificarile de semnat unde userul inca nu a semnat (status === 'current')
    return allNotifs.filter(n => n.type === 'YOUR_TURN' && n.signer_status === 'current');
  }
  if (currentFilter === 'REVIEW_REQUESTED') return allNotifs.filter(n => n.type === 'REVIEW_REQUESTED');
  if (currentFilter === 'formulare') return allNotifs.filter(n => FORMULARE_TYPES.has(n.type));
  if (currentFilter === 'facturi') return allNotifs.filter(n => n.type === 'alop_factura_lichidata');
  return allNotifs.filter(n => n.type === currentFilter);
}

function updateReadAllBtn() {
  const hasUnread = allNotifs.some(n => !n.read);
  $('btnReadAll').style.display = hasUnread ? '' : 'none';
}

function updateTabCounts() {
  const counts = {
    all: allNotifs.length,
    unread: allNotifs.filter(n => !n.read).length,
    urgent: allNotifs.filter(n => !!(n.urgent || n.flow_urgent)).length,
    YOUR_TURN: allNotifs.filter(n => n.type === 'YOUR_TURN' && n.signer_status === 'current').length,
    REVIEW_REQUESTED: allNotifs.filter(n => n.type === 'REVIEW_REQUESTED').length,
    COMPLETED: allNotifs.filter(n => n.type === 'COMPLETED').length,
    REFUSED: allNotifs.filter(n => n.type === 'REFUSED').length,
    formulare: allNotifs.filter(n => FORMULARE_TYPES.has(n.type)).length,
    facturi: allNotifs.filter(n => n.type === 'alop_factura_lichidata').length,
    primite: receivedItems.filter(r => !r.acknowledged_at).length,
  };
  const labels = { all:'Toate', unread:'Necitite', urgent:'🚨 Urgente', YOUR_TURN:'De semnat', REVIEW_REQUESTED:'De revizuit', COMPLETED:'Finalizate', REFUSED:'Refuzate', formulare:'📄 Formulare', facturi:'🧾 Facturi', primite:'📥 Primite' };
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    const c = counts[f] || 0;
    const color = f==='urgent' ? 'rgba(255,40,40,.4)' : f==='unread'?'rgba(255,180,50,.3)':f==='YOUR_TURN'?'rgba(124,92,255,.4)':f==='REFUSED'?'rgba(255,80,80,.3)':f==='REVIEW_REQUESTED'?'rgba(45,212,191,.3)':'rgba(255,255,255,.15)';
    const textColor = f==='urgent'?'#ffaaaa':f==='unread'?'#ffd580':f==='YOUR_TURN'?'#c4b5fd':f==='REFUSED'?'#ffaaaa':f==='REVIEW_REQUESTED'?'#7cf0e0':'#ccc';
    btn.innerHTML = `${labels[f]} ${c > 0 ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;font-size:.7rem;font-weight:800;margin-left:4px;background:${color};color:${textColor};">${c}</span>` : ''}`;
  });
}

function renderList() {
  updateTabCounts();
  if (currentFilter === 'primite') {
    renderReceivedList();
    return;
  }
  const list = filtered();
  const area = $('listArea');
  const _bd = $('btnDeleteCat');
  if (_bd) {
    _bd.style.display = list.length ? 'inline-flex' : 'none';
    const _lbl = $('btnDeleteCatLabel');
    if (_lbl) _lbl.textContent = `Șterge afișate (${list.length})`;
  }
  if (!list.length) {
    area.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔕</div>
      <div class="empty-title">Nicio notificare</div>
      <div>Vei fi notificat când ai documente de semnat sau statusuri noi.</div>
    </div>`;
    return;
  }
  area.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'notif-list';
  list.forEach((n, i) => {
    const card = document.createElement('div');
    const isUrgentNotif = !!(n.urgent || n.flow_urgent);
    card.className = `notif-card type-${n.type||''} ${!n.read?'unread':''} ${isUrgentNotif?'urgent-card':''}`;
    card.style.animationDelay = `${i * 40}ms`;
    card.innerHTML = `
      <div class="notif-icon type-${n.type||''}">${typeIcon(n.type)}</div>
      <div class="notif-body">
        <div class="notif-title">${isUrgentNotif ? '<span style="color:#ff6666;font-weight:800;margin-right:6px;">🚨 URGENT</span>' : ''}${escHtml((n.title||'Notificare').replace(/^\s*🚨\s*\[URGENT\]\s*/i,''))}</div>
        <div class="notif-msg">${escHtml(n.message||'')}</div>
        <div class="notif-meta">
          <span class="notif-time">${timeAgo(n.created_at)}</span>
          ${n.flow_id ? `<span class="notif-flow">${n.flow_id}</span>` : ''}
        </div>
      </div>
      ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
      <button class="notif-del" title="Șterge" onclick="deleteNotif(event,${n.id})"><svg class="df-ic" viewBox="0 0 24 24" style="width:14px;height:14px;"><use href="/icons.svg?v=3.9.475#ico-x"/></svg></button>
    `;
    // Click → marchează citit + navighează
    card.onclick = async (e) => {
      if (e.target.classList.contains('notif-del')) return;
      markRead(n.id);

      // Notificare de chat → deschide conversația
      if (n.type === 'chat_message' || n.type === 'chat_support_new' || (n.data && (typeof n.data === 'string' ? n.data.includes('conv_id') : n.data.conv_id != null))) {
        const dd = n.data ? (typeof n.data === 'string' ? JSON.parse(n.data) : n.data) : {};
        if (dd && dd.conv_id != null) { location.href = `/chat.html?conv=${encodeURIComponent(dd.conv_id)}`; return; }
        location.href = '/chat.html'; return;
      }

      // Notificări formulare → deschide formular.html cu documentul auto-loaded
      if ((FORMULARE_TYPES.has(n.type) || n.type === 'alop_factura_lichidata') && n.data) {
        const d = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
        if (d.form_type && d.form_id) {
          location.href = `/formular.html?form_type=${encodeURIComponent(d.form_type)}&form_id=${encodeURIComponent(d.form_id)}`;
          return;
        }
      }

      if (n.flow_id) {
        if (n.type === 'YOUR_TURN') {
          try {
            const r = await _apiFetch(`/api/my-signer-token/${encodeURIComponent(n.flow_id)}`);
            if (r.ok) {
              const d = await r.json();
              location.href = `/semdoc-signer.html?flow=${encodeURIComponent(n.flow_id)}&token=${encodeURIComponent(d.token)}`;
            } else { location.href = '/'; }
          } catch(e) { location.href = '/'; }
        } else if (n.type === 'REPARTIZAT') {
          // Comută pe tabul Primite IN-PAGE (suntem deja pe notifications.html — fără reload complet)
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          const primiteBtn = document.querySelector('.filter-btn[data-filter="primite"]');
          if (primiteBtn) primiteBtn.classList.add('active');
          currentFilter = 'primite';
          renderList();
        } else {
          location.href = `/flow.html?flow=${encodeURIComponent(n.flow_id)}`;
        }
      }
    };
    div.appendChild(card);
  });
  area.appendChild(div);
}

function renderReceivedList() {
  const list = receivedItems;
  const area = $('listArea');
  const _bd = $('btnDeleteCat');
  if (_bd) _bd.style.display = 'none';
  if (!list.length) {
    area.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📥</div>
      <div class="empty-title">Niciun document primit</div>
      <div>Documentele repartizate ție sau compartimentului tău vor apărea aici.</div>
    </div>`;
    return;
  }
  area.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'notif-list';
  list.forEach((r, i) => {
    const card = document.createElement('div');
    const isAck = !!r.acknowledged_at;
    card.className = `notif-card received-card ${isAck ? 'ack' : 'unack'}`;
    card.style.animationDelay = `${i * 40}ms`;
    const byWho = r.transmitted_by_name || r.transmitted_by_email || '—';
    card.innerHTML = `
      <div class="notif-icon">📥</div>
      <div class="notif-body">
        <div class="notif-title">${escHtml(r.doc_name || r.flow_id)}</div>
        <div class="notif-msg">Transmis de ${escHtml(byWho)} · ${timeAgo(r.transmitted_at)}${r.recipient_compartiment ? ` · compartiment ${escHtml(r.recipient_compartiment)}` : ''}</div>
        ${r.rezolutie ? `<div class="notif-msg">Rezoluție: ${escHtml(r.rezolutie)}</div>` : ''}
        <div class="notif-meta">
          <span class="notif-time">${escHtml(r.flow_id)}</span>
          <span class="received-badge ${isAck ? 'ack' : 'unack'}">${isAck ? '✅ Confirmat' : '⏳ Neconfirmat'}</span>
        </div>
        <div class="received-actions">
          <button type="button" class="df-action-btn received-open-btn" ${isAck ? '' : 'disabled title="Confirmați mai întâi primirea documentului" style="opacity:.5;cursor:not-allowed"'}>Deschide documentul</button>
          ${isAck ? '' : '<button type="button" class="df-action-btn received-ack-btn">Confirm luare la cunoștință</button>'}
        </div>
      </div>
    `;
    card.querySelector('.received-open-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      location.href = `/flow.html?flow=${encodeURIComponent(r.flow_id)}`;
    });
    const ackBtn = card.querySelector('.received-ack-btn');
    if (ackBtn) {
      ackBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        ackBtn.disabled = true;
        try {
          const resp = await _apiFetch(`/flows/${encodeURIComponent(r.flow_id)}/acknowledge`, { method: 'POST' });
          if (resp.ok) {
            const d = await resp.json();
            r.acknowledged_at = d.acknowledged_at || new Date().toISOString();
            renderList();
          } else {
            ackBtn.disabled = false;
          }
        } catch (err) {
          ackBtn.disabled = false;
        }
      });
    }
    div.appendChild(card);
  });
  area.appendChild(div);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function markRead(id) {
  const n = allNotifs.find(x => x.id === id);
  if (!n || n.read) return;
  n.read = true;
  renderList(); updateReadAllBtn(); updateTabCounts();
  await _apiFetch(`/api/notifications/${id}/read`, { method:'POST' }).catch(()=>{});
}

window.deleteNotif = async (e, id) => {
  e.stopPropagation();
  allNotifs = allNotifs.filter(n => n.id !== id);
  renderList(); updateReadAllBtn(); updateTabCounts();
  await _apiFetch(`/api/notifications/${id}`, { method:'DELETE' }).catch(()=>{});
};

$('btnReadAll').onclick = async () => {
  allNotifs.forEach(n => n.read = true);
  updateTabCounts();
  renderList(); updateReadAllBtn();
  await _apiFetch('/api/notifications/read-all', { method:'POST' }).catch(()=>{});
};

const _btnDeleteCat = $('btnDeleteCat');
if (_btnDeleteCat) _btnDeleteCat.onclick = async () => {
  const ids = filtered().map(n => n.id);
  if (!ids.length) return;
  const eticheta = currentFilter === 'all' ? 'toate notificările' : 'notificările din această categorie';
  if (!confirm(`Ștergeți ${eticheta} (${ids.length})? Operațiunea nu poate fi inversată.`)) return;
  const idSet = new Set(ids);
  allNotifs = allNotifs.filter(n => !idSet.has(n.id));
  renderList(); updateReadAllBtn(); updateTabCounts();
  await _apiFetch('/api/notifications/delete-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(()=>{});
};

// ── WebSocket ──────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === 'auth_ok') {
        $('wsDot').className = 'ws-dot connected';
        $('wsLabel').textContent = 'Live';
      }
      if (msg.event === 'notification') {
        // Adaugă la începutul listei
        allNotifs.unshift(msg.data);
        renderList(); updateReadAllBtn();
      }
      if (msg.event === 'unread_count') {
        // Actualizează badge-ul din widget (dacă e injectat)
        // Widgetul gestionează asta, nu facem nimic extra
      }
    } catch(e) {}
  };
  ws.onclose = () => {
    $('wsDot').className = 'ws-dot error';
    $('wsLabel').textContent = 'Deconectat';
    setTimeout(connectWS, 5000);
  };
  ws.onerror = () => { ws.close(); };
}

connectWS();
// Aplica tab din URL daca exista (?tab=sign / done / refused / unread)
(function applyTabFromUrl() {
  const tabMap = { sign: 'YOUR_TURN', done: 'COMPLETED', refused: 'REFUSED', review: 'REVIEW_REQUESTED', urgent: 'urgent', unread: 'unread', all: 'all', formulare: 'formulare', primite: 'primite' };
  const urlTab = new URLSearchParams(location.search).get('tab');
  const filter = tabMap[urlTab] || null;
  if (filter && filter !== 'all') {
    const btn = document.querySelector(`.filter-btn[data-filter="${filter}"]`);
    if (btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = filter;
    }
  }
})();
loadNotifs();

// ─── Banner permisiuni notificări browser (fost Block 3 inline) ───
  if ('Notification' in window && Notification.permission === 'denied') {
    const b = document.getElementById('nw-perm-banner');
    if (b) b.style.display = 'block';
  }
