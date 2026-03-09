/**
 * DocFlowAI — Notification Widget
 * Injectează iconița 🔔 în header și gestionează conexiunea WebSocket.
 * Include și logica de refresh automat JWT (token refresh transparent).
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
  let _refreshPromise = null; // deduplică cererile simultane de refresh

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

  // ══════════════════════════════════════════════════════════
  // TOKEN REFRESH — logic centralizată
  // ══════════════════════════════════════════════════════════

  /** Parsează payload JWT fără verificare criptografică (client-side only) */
  function parseJwtPayload(token) {
    try {
      return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch(e) { return null; }
  }

  /** Returnează ms până la expirarea tokenului (negativ = deja expirat) */
  function msUntilExpiry(token) {
    const p = parseJwtPayload(token);
    if (!p || !p.exp) return -1;
    return (p.exp * 1000) - Date.now();
  }

  /**
   * Încearcă refresh token. Dacă reușește, salvează noul token și returnează true.
   * Dacă eșuează → șterge sesiunea și redirectează la login.
   * Apelurile simultane sunt deduplicate (un singur request în zbor).
   */
  async function refreshToken() {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
      try {
        // SEC-01: /auth/refresh folosește cookie HttpOnly — nu mai trimitem token în header
        const r = await fetch('/auth/refresh', {
          method: 'POST',
          credentials: 'include',      // trimite cookie-ul auth_token
          headers: { 'Content-Type': 'application/json' },
        });
        if (r.ok) {
          const d = await r.json();
          // SEC-01: token-ul NU mai este stocat în localStorage
          // Actualizează datele user (non-sensibile) pentru UI
          const existing = JSON.parse(localStorage.getItem('docflow_user') || '{}');
          localStorage.setItem('docflow_user', JSON.stringify({
            ...existing,
            email: d.email, role: d.role, nume: d.nume,
            functie: d.functie, institutie: d.institutie || existing.institutie || ''
          }));
          console.log('[DocFlowAI] Token reînnoit cu succes (cookie).');
          if (ws) { ws.close(); }
          return true;
        } else {
          redirectLogin();
          return false;
        }
      } catch(e) {
        console.warn('[DocFlowAI] Refresh eșuat:', e.message);
        return false;
      } finally {
        _refreshPromise = null;
      }
    })();
    return _refreshPromise;
  }

  function redirectLogin() {
    // SEC-01: token-ul e în cookie HttpOnly — nu mai e în localStorage
    // Apelăm /auth/logout pentru a curăța cookie-ul pe server
    fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    localStorage.removeItem('docflow_user');
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = '/login?next=' + next;
  }

  /**
   * apiFetch — înlocuitor pentru fetch() cu refresh automat la 401.
   * Folosit intern de widget; expus pe window.docflow.apiFetch pentru pagini.
   *
   * La 401 token_invalid_or_expired: încearcă refresh, repetă request-ul o dată.
   * La 401 după refresh eșuat: redirect login.
   */
  async function apiFetch(url, options = {}) {
    // SEC-01: token-ul e în cookie HttpOnly — trimis automat cu credentials: 'include'
    // Nu mai citim/scriem localStorage pentru token
    const headers = { ...(options.headers || {}) };
    // Eliminăm Authorization header dacă a rămas din cod vechi (tranziție)
    delete headers['Authorization'];

    // Refresh proactiv periodic (bazat pe timp, nu pe token local)
    // La fiecare 10 min, scheduleProactiveRefresh() apelează refreshToken()

    let res = await fetch(url, { ...options, headers, credentials: 'include' });

    // Refresh reactiv la 401
    if (res.status === 401) {
      let body = {};
      try { body = await res.clone().json(); } catch(e) {}
      const err = body?.error || '';
      if (err === 'token_invalid_or_expired' || err === 'unauthorized' || err === 'token_invalid') {
        const ok = await refreshToken();
        if (ok) {
          // Cookie nou setat de /auth/refresh — retry automat
          res = await fetch(url, { ...options, headers, credentials: 'include' });
        }
      }
    }

    return res;
  }

  // ── Refresh proactiv periodic (la fiecare 10 minute verifică dacă mai are < 20 min) ──
  function scheduleProactiveRefresh() {
    // SEC-01: nu mai avem token în localStorage — refresh la fiecare 25 minute (înainte de expirare 2h)
    setInterval(async () => {
      // Încearcă refresh silențios; dacă cookie-ul e valid, serverul emite unul nou
      await refreshToken();
    }, 25 * 60 * 1000); // la fiecare 25 minute
  }

  // ══════════════════════════════════════════════════════════
  // BELL + TOAST
  // ══════════════════════════════════════════════════════════

  function injectBell() {
    const userBar = document.getElementById('userBar') || document.getElementById('nw-bell-anchor');
    if (!userBar) return;

    bellBtn = document.createElement('a');
    bellBtn.id = 'nw-bell-btn';
    bellBtn.href = '/notifications';
    bellBtn.title = 'Notificări';
    bellBtn.innerHTML = `🔔<span id="nw-badge"></span>`;
    bellBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      // SEC-01: nu mai verificăm token din localStorage — cookie trimis automat
      if (unreadCount === 0) { window.location.href = '/notifications'; return; }
      try {
        const r = await apiFetch('/api/notifications');
        const notifs = await r.json();
        const latest = notifs.find(n => !n.read) || notifs[0];
        if (!latest) { window.location.href = '/notifications'; return; }
        const t = (latest.type || '').toUpperCase();
        const isUrgent = !!(latest.urgent || latest.flow_urgent);
        let tab = 'all';
        if (isUrgent) tab = 'urgent'; // flux urgent → deschide tab Urgente
        else if (t === 'YOUR_TURN' || t === 'ASSIGNED' || t === 'SIGNER_TURN') tab = 'sign';
        else if (t === 'COMPLETED' || t === 'DONE' || t === 'FINISHED') tab = 'done';
        else if (t === 'REFUSED') tab = 'refused';
        else if (t === 'REVIEW_REQUESTED') tab = 'review';
        window.location.href = '/notifications?tab=' + tab;
      } catch(e) {
        window.location.href = '/notifications';
      }
    });

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
    if (notif && notif.actionUrl) return notif.actionUrl;
    const flowId = notif && (notif.flowId || notif.flow || (notif.data && (notif.data.flowId || notif.data.flow)));
    const token = notif && (notif.token || (notif.data && notif.data.token));
    if (!flowId) return '/notifications';
    const t = (notif.type || '').toUpperCase();
    if (t === 'YOUR_TURN' || t === 'ASSIGNED' || t === 'SIGN' || t === 'SIGNER_TURN') {
      if (token) return `/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
      return `/flow.html?flow=${encodeURIComponent(flowId)}`;
    }
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

  // ══════════════════════════════════════════════════════════
  // WEBSOCKET
  // ══════════════════════════════════════════════════════════

  function connectWS() {
    // SEC-01: cookie-ul auth_token e trimis automat la WS upgrade (același origin)
    // Serverul face auto-auth din cookie — nu mai trimitem token explicit

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      wsReady = true;
      // SEC-01: nu mai trimitem token explicit — serverul l-a verificat din cookie la upgrade
      // Trimitem ping pentru a confirma conexiunea
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
        // Serverul poate trimite auth_error dacă tokenul WS a expirat → refresh + reconect
        if (msg.event === 'auth_error') {
          refreshToken().then(ok => { if (ok) connectWS(); });
        }
      } catch(e) {}
    };

    ws.onclose = () => {
      wsReady = false;
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, reconnectDelay);
      reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
    };

    ws.onerror = () => { ws.close(); };
  }

  async function fetchUnreadCount() {
    try {
      const r = await apiFetch('/api/notifications/unread-count');
      if (r.ok) { const d = await r.json(); updateBadge(d.count); }
    } catch(e) {}
  }

  // ══════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════

  function init() {
    // SEC-01: verificăm autentificarea prin /auth/me (cookie trimis automat)
    // Nu mai verificăm localStorage pentru token

    injectStyles();
    injectBell();
    injectToastArea();
    fetchUnreadCount();
    connectWS();
    scheduleProactiveRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

  // ── API global expus paginilor ────────────────────────────
  // Paginile pot folosi window.docflow.apiFetch() în loc de fetch()
  // pentru refresh automat transparent.
  window.docflow = window.docflow || {};
  window.docflow.apiFetch = apiFetch;
  window.docflow.refreshToken = refreshToken;

  // Compatibilitate debugging
  window._nwWidget = { getUnread: () => unreadCount, ws: () => ws };
})();

// ═══════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS — Service Worker + VAPID subscription
// ═══════════════════════════════════════════════════════════════════
(async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    // Înregistrează Service Worker
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    // Verifică dacă push e configurat pe server
    const vapidRes = await fetch('/api/push/vapid-public-key').catch(() => null);
    if (!vapidRes || !vapidRes.ok) return; // Push nu e configurat
    const { key: vapidPublicKey } = await vapidRes.json();
    if (!vapidPublicKey) return;

    // Verifică permisiunile actuale
    const permission = await Notification.permission;
    if (permission === 'denied') return;

    // Dacă nu avem permisiune încă, oferă butonul de activare
    if (permission === 'default') {
      exposePushActivate(reg, vapidPublicKey);
      return;
    }

    // Avem permisiune — subscribe imediat
    await subscribePush(reg, vapidPublicKey);
  } catch(e) {
    console.warn('Push init error:', e.message);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  async function subscribePush(reg, vapidKey) {
    try {
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }
      // Trimite abonamentul la server — SEC-01: cookie trimis automat cu credentials: include
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))), auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))) } })
      });
      console.log('✅ Push notifications activate.');
      window.docflow = window.docflow || {};
      window.docflow.pushActive = true;
    } catch(e) {
      console.warn('Push subscribe error:', e.message);
    }
  }

  function exposePushActivate(reg, vapidKey) {
    // Expune o funcție pe care paginile o pot chema (ex: la click pe un buton)
    window.docflow = window.docflow || {};
    window.docflow.enablePush = async () => {
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          await subscribePush(reg, vapidKey);
          return true;
        }
        return false;
      } catch(e) { return false; }
    };
  }
})();
