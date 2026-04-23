// JS specific notifications.html — listă notificări + filtre + banner permisiuni.
// Conține logica din 2 blocuri inline originale: main (Block 2) + banner-check (Block 3).
// Block 3 (permission banner check) nu depinde de notif-widget.js — verifică doar
// Notification.permission și setează display pe elementul static #nw-perm-banner.
// Rulează la final de <body>, DUPĂ ce DOM-ul e parsat.

const $ = id => document.getElementById(id);

let allNotifs = [];
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
    const r = await _apiFetch('/api/notifications/with-status');
    if (r.status === 401 || r.status === 403) { location.href = '/login'; return; }
    if (!r.ok) throw new Error('fetch_failed');
    allNotifs = await r.json();
    renderList();
    updateReadAllBtn();
  } catch(e) {
    if (e.message === 'unauthorized') { location.href = '/login'; return; }
    $('listArea').innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Eroare la încărcare</div><div>Încearcă să te <a href="/login" style="color:var(--accent)">reloghezi</a>.</div></div>`;
  }
}

const FORMULARE_TYPES = new Set(['formulare_df_p2','formulare_ord_p2','formulare_df_completed','formulare_ord_completed']);

function typeIcon(type) {
  if (type === 'YOUR_TURN') return '✍️';
  if (type === 'COMPLETED') return '✅';
  if (type === 'REFUSED') return '⛔';
  if (type === 'REVIEW_REQUESTED') return '🔄';
  if (type === 'formulare_df_p2' || type === 'formulare_ord_p2') return '📄';
  if (type === 'formulare_df_completed' || type === 'formulare_ord_completed') return '✅';
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
  };
  const labels = { all:'Toate', unread:'Necitite', urgent:'🚨 Urgente', YOUR_TURN:'De semnat', REVIEW_REQUESTED:'De revizuit', COMPLETED:'Finalizate', REFUSED:'Refuzate', formulare:'📄 Formulare' };
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    const c = counts[f] || 0;
    const color = f==='urgent' ? 'rgba(255,40,40,.4)' : f==='unread'?'rgba(255,180,50,.3)':f==='YOUR_TURN'?'rgba(124,92,255,.4)':f==='REFUSED'?'rgba(255,80,80,.3)':f==='REVIEW_REQUESTED'?'rgba(45,212,191,.3)':'rgba(255,255,255,.15)';
    const textColor = f==='urgent'?'#ffaaaa':f==='unread'?'#ffd580':f==='YOUR_TURN'?'#c4b5fd':f==='REFUSED'?'#ffaaaa':f==='REVIEW_REQUESTED'?'#7cf0e0':'#ccc';
    btn.innerHTML = `${labels[f]} ${c > 0 ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;font-size:.7rem;font-weight:800;margin-left:4px;background:${color};color:${textColor};">${c}</span>` : ''}`;
  });
}

function renderList() {
  const list = filtered();
  const area = $('listArea');
  updateTabCounts();
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
      <button class="notif-del" title="Șterge" onclick="deleteNotif(event,${n.id})"><svg class="df-ic" viewBox="0 0 24 24" style="width:14px;height:14px;"><use href="/icons.svg?v=3.9.298#ico-x"/></svg></button>
    `;
    // Click → marchează citit + navighează
    card.onclick = async (e) => {
      if (e.target.classList.contains('notif-del')) return;
      markRead(n.id);

      // Notificări formulare → deschide formular.html cu documentul auto-loaded
      if (FORMULARE_TYPES.has(n.type) && n.data) {
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
        } else {
          location.href = `/flow.html?flow=${encodeURIComponent(n.flow_id)}`;
        }
      }
    };
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
  const tabMap = { sign: 'YOUR_TURN', done: 'COMPLETED', refused: 'REFUSED', review: 'REVIEW_REQUESTED', urgent: 'urgent', unread: 'unread', all: 'all', formulare: 'formulare' };
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
