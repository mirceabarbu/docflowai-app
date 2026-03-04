/**
 * DocFlowAI — ui.js
 * Helpers comuni: topbar, toast notifications, modal confirm.
 * Include în <head>: <script src="/ui.js"></script>
 * Apelează după DOMContentLoaded: DocFlowUI.initTopbar({ page: 'admin' })
 */

const DocFlowUI = (() => {

  // ── CSS global injectat o singură dată ─────────────────────────────────
  const CSS = `
    /* ── Design tokens ── */
    :root {
      --bg:      #080e1f;
      --card:    #0d1530;
      --card2:   #111d3a;
      --border:  rgba(255,255,255,.09);
      --border2: rgba(255,255,255,.14);
      --text:    #e8f0ff;
      --muted:   #7a94cc;
      --sub:     #b8ccff;
      --accent:  #6c4ff6;
      --accent2: #22c8a8;
      --warn:    #f59e0b;
      --danger:  #ef4444;
      --success: #22c55e;
      --radius:  14px;
      --radius-sm: 8px;
      --shadow:  0 20px 60px rgba(0,0,0,.45);
      --topbar-h: 60px;
    }

    *, *::before, *::after { box-sizing: border-box; }
    /* Nu resetăm margin/padding global — ar sparge tabele și formulare native */
    h1,h2,h3,h4,h5,h6,p,figure,blockquote,dl,dd { margin: 0; }
    #df-topbar *, #df-toasts * { margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background:
        radial-gradient(ellipse 900px 500px at 15% 0%,  rgba(108,79,246,.22), transparent 65%),
        radial-gradient(ellipse 700px 400px at 88% 90%, rgba(34,200,168,.14), transparent 60%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding-top: var(--topbar-h);
    }

    /* ── Topbar ── */
    #df-topbar {
      position: fixed; top: 0; left: 0; right: 0;
      height: var(--topbar-h);
      background: rgba(8,14,31,.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border2);
      display: flex; align-items: center;
      padding: 0 24px;
      gap: 0;
      z-index: 1000;
      box-shadow: 0 2px 24px rgba(0,0,0,.3);
    }
    #df-topbar .df-logo {
      display: flex; align-items: center; gap: 10px;
      text-decoration: none; color: var(--text);
      flex-shrink: 0;
    }
    #df-topbar .df-logo img { height: 38px; width: auto; }
    #df-topbar .df-logo-badge {
      font-size: .68rem; font-weight: 700;
      letter-spacing: .1em; text-transform: uppercase;
      color: var(--muted);
      background: rgba(255,255,255,.06);
      border: 1px solid var(--border);
      padding: 2px 8px; border-radius: 20px;
      margin-left: 4px;
    }
    #df-topbar .df-nav {
      display: flex; align-items: center; gap: 2px;
      margin-left: 28px;
      flex: 1;
    }
    #df-topbar .df-nav a {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 14px; border-radius: 8px;
      text-decoration: none; color: var(--muted);
      font-size: .84rem; font-weight: 500;
      transition: background .15s, color .15s;
      white-space: nowrap;
    }
    #df-topbar .df-nav a:hover { background: rgba(255,255,255,.06); color: var(--sub); }
    #df-topbar .df-nav a.active {
      background: rgba(108,79,246,.18);
      color: #a78fff;
      border: 1px solid rgba(108,79,246,.3);
    }
    #df-topbar .df-nav a .df-nav-icon { font-size: .95rem; }
    #df-topbar .df-right {
      display: flex; align-items: center; gap: 10px;
      margin-left: auto; flex-shrink: 0;
    }
    #df-topbar .df-user-pill {
      display: flex; align-items: center; gap: 8px;
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border);
      padding: 5px 12px 5px 8px; border-radius: 24px;
      font-size: .82rem; color: var(--sub);
    }
    #df-topbar .df-user-pill .df-avatar {
      width: 26px; height: 26px; border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      display: flex; align-items: center; justify-content: center;
      font-size: .75rem; font-weight: 700; color: #fff;
      flex-shrink: 0;
    }
    #df-topbar .df-notif-btn {
      position: relative;
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border);
      color: var(--muted);
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; text-decoration: none; font-size: 1rem;
      transition: background .15s;
    }
    #df-topbar .df-notif-btn:hover { background: rgba(255,255,255,.1); }
    #df-topbar .df-notif-badge {
      position: absolute; top: -3px; right: -3px;
      background: var(--danger); color: #fff;
      font-size: .62rem; font-weight: 700;
      min-width: 16px; height: 16px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 3px; border: 2px solid var(--bg);
    }
    #df-topbar .df-logout {
      background: rgba(239,68,68,.12);
      border: 1px solid rgba(239,68,68,.25);
      color: #fca5a5; padding: 6px 14px; border-radius: 8px;
      cursor: pointer; font-size: .81rem; font-weight: 600;
      transition: background .15s;
    }
    #df-topbar .df-logout:hover { background: rgba(239,68,68,.22); }

    /* ── Main content wrapper ── */
    .df-main { max-width: 1200px; margin: 0 auto; padding: 32px 20px 80px; }

    /* ── Cards ── */
    .df-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 24px;
      margin-bottom: 20px;
    }
    .df-card-title {
      font-size: .9rem; font-weight: 700;
      color: var(--sub); margin-bottom: 16px;
      display: flex; align-items: center; gap: 8px;
    }

    /* ── Stat tiles ── */
    .df-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .df-stat {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 18px 20px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .df-stat-val { font-size: 2rem; font-weight: 800; line-height: 1; }
    .df-stat-label { font-size: .78rem; color: var(--muted); font-weight: 500; }
    .df-stat-accent  { border-top: 3px solid var(--accent); }
    .df-stat-success { border-top: 3px solid var(--success); }
    .df-stat-warn    { border-top: 3px solid var(--warn); }
    .df-stat-danger  { border-top: 3px solid var(--danger); }

    /* ── Buttons ── */
    .df-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 16px; border-radius: var(--radius-sm);
      font-size: .84rem; font-weight: 600; cursor: pointer;
      border: 1px solid var(--border); background: rgba(255,255,255,.05);
      color: var(--sub); transition: background .15s, border-color .15s;
      text-decoration: none;
    }
    .df-btn:hover { background: rgba(255,255,255,.09); border-color: var(--border2); }
    .df-btn:disabled { opacity: .45; cursor: not-allowed; }
    .df-btn.primary {
      background: linear-gradient(135deg, var(--accent), #8b68ff);
      border-color: transparent; color: #fff;
      box-shadow: 0 4px 16px rgba(108,79,246,.35);
    }
    .df-btn.primary:hover { filter: brightness(1.1); }
    .df-btn.success { background: rgba(34,197,94,.15); border-color: rgba(34,197,94,.3); color: #86efac; }
    .df-btn.danger  { background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.25); color: #fca5a5; }
    .df-btn.warn    { background: rgba(245,158,11,.12); border-color: rgba(245,158,11,.3); color: #fcd34d; }
    .df-btn.sm { padding: 5px 11px; font-size: .78rem; }

    /* ── Badges / pills ── */
    .df-badge {
      display: inline-flex; align-items: center;
      padding: 2px 10px; border-radius: 20px;
      font-size: .73rem; font-weight: 700;
    }
    .df-badge.ok      { background: rgba(34,197,94,.15); color: #86efac; border: 1px solid rgba(34,197,94,.3); }
    .df-badge.pending { background: rgba(245,158,11,.12); color: #fcd34d; border: 1px solid rgba(245,158,11,.3); }
    .df-badge.bad     { background: rgba(239,68,68,.12);  color: #fca5a5; border: 1px solid rgba(239,68,68,.25); }
    .df-badge.info    { background: rgba(108,79,246,.15); color: #a78fff; border: 1px solid rgba(108,79,246,.3); }

    /* ── Tables ── */
    .df-table-wrap { overflow-x: auto; }
    .df-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .df-table th {
      text-align: left; padding: 8px 12px;
      color: var(--muted); font-weight: 600; font-size: .76rem;
      border-bottom: 1px solid var(--border2);
      white-space: nowrap;
    }
    .df-table td { padding: 9px 12px; border-bottom: 1px solid var(--border); }
    .df-table tr:last-child td { border-bottom: none; }
    .df-table tr:hover td { background: rgba(255,255,255,.02); }

    /* ── Form inputs ── */
    .df-input {
      width: 100%; padding: 9px 13px;
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border2);
      border-radius: var(--radius-sm);
      color: var(--text); font-size: .88rem; outline: none;
      transition: border-color .15s;
    }
    .df-input:focus { border-color: var(--accent); }
    .df-select {
      padding: 9px 12px;
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border2);
      border-radius: var(--radius-sm);
      color: var(--text); font-size: .85rem; outline: none; cursor: pointer;
    }

    /* ── Pagination ── */
    .df-pagination {
      display: flex; align-items: center; justify-content: space-between;
      margin-top: 16px; flex-wrap: wrap; gap: 8px;
    }
    .df-page-info { color: var(--muted); font-size: .82rem; }

    /* ── Toast container ── */
    #df-toasts {
      position: fixed; bottom: 24px; right: 24px;
      display: flex; flex-direction: column; gap: 10px;
      z-index: 9999; pointer-events: none;
    }
    .df-toast {
      display: flex; align-items: flex-start; gap: 10px;
      background: var(--card2); border: 1px solid var(--border2);
      border-radius: var(--radius-sm); padding: 12px 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,.5);
      min-width: 280px; max-width: 380px;
      pointer-events: all;
      animation: df-toast-in .25s ease;
    }
    .df-toast.removing { animation: df-toast-out .2s ease forwards; }
    .df-toast-icon { font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
    .df-toast-body { flex: 1; }
    .df-toast-title { font-size: .84rem; font-weight: 700; margin-bottom: 2px; }
    .df-toast-msg { font-size: .78rem; color: var(--muted); line-height: 1.4; }
    .df-toast-close { color: var(--muted); cursor: pointer; font-size: 1rem; flex-shrink: 0; }
    .df-toast-close:hover { color: var(--text); }
    .df-toast.ok    { border-left: 3px solid var(--success); }
    .df-toast.error { border-left: 3px solid var(--danger); }
    .df-toast.warn  { border-left: 3px solid var(--warn); }
    .df-toast.info  { border-left: 3px solid var(--accent); }
    @keyframes df-toast-in  { from { opacity:0; transform: translateX(20px); } to { opacity:1; transform: none; } }
    @keyframes df-toast-out { from { opacity:1; transform: none; } to { opacity:0; transform: translateX(20px); } }

    /* ── Loading spinner ── */
    .df-spin {
      display: inline-block; width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,.15);
      border-top-color: var(--sub);
      border-radius: 50%;
      animation: df-spin .65s linear infinite;
    }
    @keyframes df-spin { to { transform: rotate(360deg); } }

    /* ── Alert ── */
    .df-alert {
      padding: 12px 16px; border-radius: var(--radius-sm);
      font-size: .84rem; margin-bottom: 12px;
      border: 1px solid;
    }
    .df-alert.ok    { background: rgba(34,197,94,.08);  border-color: rgba(34,197,94,.25);  color: #86efac; }
    .df-alert.error { background: rgba(239,68,68,.08);  border-color: rgba(239,68,68,.2);   color: #fca5a5; }
    .df-alert.warn  { background: rgba(245,158,11,.08); border-color: rgba(245,158,11,.25); color: #fcd34d; }
    .df-alert.info  { background: rgba(108,79,246,.1);  border-color: rgba(108,79,246,.3);  color: #c4b5fd; }

    /* ── Tabs ── */
    .df-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
    .df-tab {
      padding: 9px 18px; border-radius: 8px 8px 0 0; font-size: .84rem;
      font-weight: 600; cursor: pointer; color: var(--muted);
      background: transparent; border: none;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
      transition: color .15s, border-color .15s;
    }
    .df-tab:hover { color: var(--sub); }
    .df-tab.active { color: var(--text); border-bottom-color: var(--accent); }

    /* ── Chart bar simple ── */
    .df-bar-chart { display: flex; flex-direction: column; gap: 6px; }
    .df-bar-row { display: flex; align-items: center; gap: 10px; font-size: .8rem; }
    .df-bar-label { width: 130px; flex-shrink: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .df-bar-track { flex: 1; height: 8px; background: rgba(255,255,255,.06); border-radius: 4px; overflow: hidden; }
    .df-bar-fill  { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .4s ease; }
    .df-bar-val   { width: 36px; text-align: right; color: var(--sub); font-weight: 600; font-size: .78rem; }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.2); }
  `;

  function injectCSS() {
    if (document.getElementById('df-styles')) return;
    const s = document.createElement('style');
    s.id = 'df-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Nav config ───────────────────────────────────────────────────────────
  const NAV_ITEMS = [
    { label: 'Fluxuri',       icon: '📂', href: '/',              key: 'flows'    },
    { label: 'Notificări',    icon: '🔔', href: '/notifications',  key: 'notif'    },
    { label: 'Templates',     icon: '📋', href: '/templates',      key: 'templates'},
    { label: 'Admin',         icon: '⚙️', href: '/admin',          key: 'admin', adminOnly: true },
  ];

  // ── Topbar render ────────────────────────────────────────────────────────
  function initTopbar({ page = '', hideNav = false } = {}) {
    injectCSS();

    const user  = JSON.parse(localStorage.getItem('docflow_user') || '{}');
    const token = localStorage.getItem('docflow_token');
    if (!token && !window._skipAuthGuard) {
      location.href = '/login'; return;
    }

    const isAdmin = user.role === 'admin';
    const initials = (user.nume || user.email || '?').charAt(0).toUpperCase();
    const navItems = NAV_ITEMS.filter(n => !n.adminOnly || isAdmin);

    const navHTML = hideNav ? '' : `
      <nav class="df-nav">
        ${navItems.map(n => `
          <a href="${n.href}" class="${page === n.key ? 'active' : ''}">
            <span class="df-nav-icon">${n.icon}</span>${n.label}
          </a>`).join('')}
      </nav>`;

    const topbar = document.createElement('div');
    topbar.id = 'df-topbar';
    topbar.innerHTML = `
      <a href="/" class="df-logo">
        <img src="/Logo.png" alt="DocFlowAI" />
        ${page ? `<span class="df-logo-badge">${page}</span>` : ''}
      </a>
      ${navHTML}
      <div class="df-right">
        <a href="/notifications" class="df-notif-btn" id="df-notif-btn" title="Notificări">
          🔔<span class="df-notif-badge" id="df-notif-count" style="display:none"></span>
        </a>
        ${user.email ? `
        <div class="df-user-pill">
          <div class="df-avatar">${initials}</div>
          <span>${user.nume || user.email}</span>
        </div>` : ''}
        <button class="df-logout" onclick="DocFlowUI.logout()">Ieși</button>
      </div>
    `;

    // Inserează topbar la începutul body
    document.body.insertBefore(topbar, document.body.firstChild);

    // Unread count badge
    _updateNotifBadge();
  }

  async function _updateNotifBadge() {
    try {
      const token = localStorage.getItem('docflow_token');
      if (!token) return;
      const r = await fetch('/api/notifications/unread-count', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!r.ok) return;
      const j = await r.json();
      const count = j.count || 0;
      const badge = document.getElementById('df-notif-count');
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    } catch(e) {}
  }

  function logout() {
    localStorage.removeItem('docflow_token');
    localStorage.removeItem('docflow_user');
    location.href = '/login';
  }

  // ── Toast system ─────────────────────────────────────────────────────────
  function _getToastContainer() {
    let c = document.getElementById('df-toasts');
    if (!c) {
      c = document.createElement('div');
      c.id = 'df-toasts';
      document.body.appendChild(c);
    }
    return c;
  }

  const TOAST_ICONS = { ok: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };

  /**
   * Afișează un toast.
   * @param {string} type    — 'ok' | 'error' | 'warn' | 'info'
   * @param {string} title   — titlu scurt
   * @param {string} msg     — mesaj opțional
   * @param {number} duration — ms până la auto-dismiss (0 = manual)
   */
  function toast(type = 'info', title = '', msg = '', duration = 4000) {
    injectCSS();
    const c = _getToastContainer();
    const el = document.createElement('div');
    el.className = `df-toast ${type}`;
    el.innerHTML = `
      <span class="df-toast-icon">${TOAST_ICONS[type] || 'ℹ️'}</span>
      <div class="df-toast-body">
        ${title ? `<div class="df-toast-title">${title}</div>` : ''}
        ${msg   ? `<div class="df-toast-msg">${msg}</div>`   : ''}
      </div>
      <span class="df-toast-close" onclick="this.parentElement.remove()">✕</span>
    `;
    c.appendChild(el);
    if (duration > 0) {
      setTimeout(() => {
        el.classList.add('removing');
        setTimeout(() => el.remove(), 200);
      }, duration);
    }
    return el;
  }

  // ── Confirm modal ────────────────────────────────────────────────────────
  /**
   * Modal confirm async (înlocuiește window.confirm nativ).
   * @returns {Promise<boolean>}
   */
  function confirm(message, { title = 'Confirmare', okLabel = 'Confirm', cancelLabel = 'Anulează', danger = false } = {}) {
    injectCSS();
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);
        z-index:9990;display:flex;align-items:center;justify-content:center;padding:20px;
      `;
      overlay.innerHTML = `
        <div style="background:var(--card2);border:1px solid var(--border2);border-radius:var(--radius);
             padding:28px;max-width:420px;width:100%;box-shadow:var(--shadow);">
          <div style="font-weight:700;font-size:1rem;margin-bottom:10px;">${title}</div>
          <div style="color:var(--muted);font-size:.88rem;line-height:1.5;margin-bottom:20px;">${message}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="df-cancel" class="df-btn">${cancelLabel}</button>
            <button id="df-ok" class="df-btn ${danger ? 'danger' : 'primary'}">${okLabel}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#df-ok').onclick     = () => { overlay.remove(); resolve(true);  };
      overlay.querySelector('#df-cancel').onclick = () => { overlay.remove(); resolve(false); };
      overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
  }

  // ── Bar chart renderer ───────────────────────────────────────────────────
  /**
   * Renderează un bar chart simplu în containerul dat.
   * @param {HTMLElement} container
   * @param {Array<{label, value}>} data
   * @param {string} color — culoare CSS opțional
   */
  function renderBarChart(container, data, color = '') {
    if (!container || !data.length) { container.innerHTML = '<span style="color:var(--muted);font-size:.82rem;">Fără date</span>'; return; }
    const max = Math.max(...data.map(d => d.value), 1);
    container.className = 'df-bar-chart';
    container.innerHTML = data.map(d => `
      <div class="df-bar-row">
        <span class="df-bar-label" title="${d.label}">${d.label}</span>
        <div class="df-bar-track">
          <div class="df-bar-fill" style="width:${Math.round(d.value / max * 100)}%;${color ? 'background:' + color : ''}"></div>
        </div>
        <span class="df-bar-val">${d.value}</span>
      </div>`).join('');
  }

  /**
   * Renderează un mini sparkline pe un canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {number[]} values
   * @param {string} color
   */
  function renderSparkline(canvas, values, color = '#6c4ff6') {
    if (!canvas || !values.length) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(...values, 1);
    const pts = values.map((v, i) => [i / (values.length - 1 || 1) * W, H - (v / max) * (H - 4) - 2]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // Fill
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = color.replace(')', ', .15)').replace('rgb(', 'rgba(').replace('#', 'rgba(').replace(/^rgba\(([0-9a-f]{6})/i, (m, hex) => {
      const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
      return `rgba(${r},${g},${b}`;
    }) + (color.startsWith('#') ? ', .12)' : '');
    try { ctx.fill(); } catch(e) {}
  }

  return { initTopbar, logout, toast, confirm, renderBarChart, renderSparkline, _updateNotifBadge };
})();

window.DocFlowUI = DocFlowUI;
