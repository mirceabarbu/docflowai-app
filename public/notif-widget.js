/**
 * DocFlowAI — Notification Widget
 * Injectează iconița 🔔 în header și gestionează conexiunea WebSocket.
 * Usage: <script src="/notif-widget.js"></script>
 * Se inițializează automat la DOMContentLoaded.
 */

(function() {
  'use strict';

  let ws = null;
  let wsReady = false;
  let reconnectTimer = null;
  let keepaliveTimer = null;
  let reconnectDelay = 2000;
  let unreadCount = 0;
  let badgeEl = null;
  let bellBtn = null;

  // ── CSS injectat ──────────────────────────────────────────
  const STYLE = `
    #nw-bell-btn {
      position: relative;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      width: 38px; height: 38px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      transition: background .18s, transform .12s;
      font-size: 18px;
      text-decoration: none;
      flex-shrink: 0;
    }
    #nw-bell-btn:hover { background: rgba(124,92,255,.22); transform: scale(1.07); }
    #nw-bell-btn:active { transform: scale(.95); }
    #nw-badge {
      position: absolute;
      top: -5px; right: -5px;
      min-width: 18px; height: 18px;
      background: linear-gradient(135deg, #ff5050, #ff8c00);
      border-radius: 9px;
      border: 2px solid #0b1020;
      display: none;
      align-items: center; justify-content: center;
      font-size: 10px; font-weight: 800;
      color: #fff;
      padding: 0 4px;
      line-height: 1;
      animation: nw-pop .25s cubic-bezier(.36,1.6,.58,1) both;
    }
    @keyframes nw-pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    #nw-toast-area {
      position: fixed;
      top: 70px; right: 18px;
      z-index: 9999;
      display: flex; flex-direction: column; gap: 10px;
      pointer-events: none;
    }
    .nw-toast {
      background: #141e3c;
      border: 1px solid rgba(124,92,255,.4);
      border-left: 4px solid #7c5cff;
      border-radius: 12px;
      padding: 12px 16px;
      max-width: 320px;
      box-shadow: 0 8px 32px rgba(0,0,0,.5);
      pointer-events: all;
      cursor: pointer;
      animation: nw-slide-in .3s cubic-bezier(.36,1.4,.58,1) both;
      transition: opacity .3s, transform .3s;
    }
    .nw-toast.nw-exit { opacity: 0; transform: translateX(120%); }
    .nw-toast-title { font-size: .83rem; font-weight: 700; color: #eaf0ff; margin-bottom: 3px; }
    .nw-toast-msg { font-size: .78rem; color: #9db0ff; line-height: 1.4; }
    .nw-toast-type-REFUSED { border-left-color: #ff5050; }
    .nw-toast-type-COMPLETED { border-left-color: #2dd4bf; }
    .nw-toast-type-YOUR_TURN { border-left-color: #7c5cff; }
    @keyframes nw-slide-in { from { opacity:0; transform: translateX(120%); } to { opacity:1; transform: translateX(0); } }
  `;

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function injectBell() {
    // Găsim containerul userBar sau creăm unul
    const userBar = document.getElementById('userBar') || document.getElementById('nw-bell-anchor');
    if (!userBar) return;

    bellBtn = document.createElement('a');
    bellBtn.id = 'nw-bell-btn';
    bellBtn.href = '/notifications';
    bellBtn.title = 'Notificări';
    bellBtn.innerHTML = `🔔<span id="nw-badge"></span>`;
    bellBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      // Daca exista notificari necitite, deschide tabul celei mai recente
      const tok = localStorage.getItem('docflow_token');
      if (!tok || unreadCount === 0) { window.location.href = '/notifications'; return; }
      try {
        const r = await fetch('/api/notifications', { headers: { 'Authorization': 'Bearer ' + tok } });
        const notifs = await r.json();
        const latest = notifs.find(n => !n.read) || notifs[0];
        if (!latest) { window.location.href = '/notifications'; return; }
        const t = (latest.type || '').toUpperCase();
        let tab = 'all';
        if (t === 'YOUR_TURN' || t === 'ASSIGNED' || t === 'SIGNER_TURN') tab = 'sign';
        else if (t === 'COMPLETED' || t === 'DONE' || t === 'FINISHED') tab = 'done';
        else if (t === 'REFUSED') tab = 'refused';
        window.location.href = '/notifications?tab=' + tab;
      } catch(e) {
        window.location.href = '/notifications';
      }
    });

    // Inserează înainte de primul copil al userBar
    userBar.insertBefore(bellBtn, userBar.firstChild);
    badgeEl = document.getElementById('nw-badge');
  }

  function injectToastArea() {
    const t = document.createElement('div');
    t.id = 'nw-toast-area';
    document.body.appendChild(t);
  }

  function updateBadge(count) {
    unreadCount = count;
    if (!badgeEl) return;
    if (count > 0) {
      badgeEl.textContent = count > 99 ? '99+' : count;
      badgeEl.style.display = 'flex';
      badgeEl.style.animation = 'none';
      requestAnimationFrame(() => { badgeEl.style.animation = ''; });
    } else {
      badgeEl.style.display = 'none';
    }
  }


  function buildActionUrl(notif) {
    // Prefer explicit actionUrl sent by backend
    if (notif && notif.actionUrl) return notif.actionUrl;

    const flowId = notif && (notif.flowId || notif.flow || (notif.data && (notif.data.flowId || notif.data.flow)));
    const token = notif && (notif.token || (notif.data && notif.data.token));

    if (!flowId) return '/notifications';

    const t = (notif.type || '').toUpperCase();

    // If it's your turn and we have signer token -> open signer page
    if (t === 'YOUR_TURN' || t === 'ASSIGNED' || t === 'SIGN' || t === 'SIGNER_TURN') {
      if (token) return `/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
      // Fallback: show flow status
      return `/flow.html?flow=${encodeURIComponent(flowId)}`;
    }

    // Completed / refused -> open flow view
    if (t === 'COMPLETED' || t === 'REFUSED' || t === 'DONE' || t === 'FINISHED') {
      return `/flow.html?flow=${encodeURIComponent(flowId)}`;
    }

    // Default: flow view
    return `/flow.html?flow=${encodeURIComponent(flowId)}`;
  }

  function showToast(notif) {
    const area = document.getElementById('nw-toast-area');
    if (!area) return;
    const t = document.createElement('div');
    t.className = `nw-toast nw-toast-type-${notif.type||''}`;
    t.innerHTML = `<div class="nw-toast-title">${notif.title||'Notificare'}</div><div class="nw-toast-msg">${notif.message||''}</div>`;
    t.onclick = () => { window.location.href = buildActionUrl(notif); };
    area.appendChild(t);
    setTimeout(() => {
      t.classList.add('nw-exit');
      setTimeout(() => t.remove(), 350);
    }, 5000);
  }

  function connectWS() {
    const token = localStorage.getItem('docflow_token');
    if (!token) return; // nu conectăm dacă nu e logat

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      wsReady = true;
      ws.send(JSON.stringify({ type: 'auth', token }));
      // ping keepalive la 25s (evită duplicate la reconnect)
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
      reconnectDelay = 2000;
};

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'unread_count') updateBadge(msg.count);
        if (msg.event === 'notification') showToast(msg.data);
      } catch(e) {}
    };

    ws.onclose = () => {
      wsReady = false;
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      // Reconectare cu backoff (max 30s)
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, reconnectDelay);
      reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
    };

    ws.onerror = () => { ws.close(); };
  }

  // Fetch unread count via HTTP (fallback sau la load)
  async function fetchUnreadCount() {
    const token = localStorage.getItem('docflow_token');
    if (!token) return;
    try {
      const r = await fetch('/api/notifications/unread-count', { headers: { 'Authorization': 'Bearer ' + token } });
      if (r.ok) { const d = await r.json(); updateBadge(d.count); }
    } catch(e) {}
  }

  function init() {
    const token = localStorage.getItem('docflow_token');
    if (!token) return; // nu injectăm nimic dacă nu e logat

    injectStyles();
    injectBell();
    injectToastArea();
    fetchUnreadCount();
    connectWS();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Mic delay ca userBar să fie deja în DOM
    setTimeout(init, 100);
  }

  // Expune global pentru debugging
  window._nwWidget = { getUnread: () => unreadCount, ws: () => ws };
})();
