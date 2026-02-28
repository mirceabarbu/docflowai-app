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

  function showToast(notif) {
    const area = document.getElementById('nw-toast-area');
    if (!area) return;
    const t = document.createElement('div');
    t.className = `nw-toast nw-toast-type-${notif.type||''}`;
    t.innerHTML = `<div class="nw-toast-title">${notif.title||'Notificare'}</div><div class="nw-toast-msg">${notif.message||''}</div>`;
    t.onclick = () => { window.location.href = '/notifications'; };
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
      // ping keepalive la 25s
      setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
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
      // Reconectare exponențială
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, 5000);
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
