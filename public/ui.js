/**
 * DocFlowAI — ui.js  (utilități comune pentru toate paginile)
 *
 * Exportă: toast, apiFetch, getToken, getUser, requireAuth,
 *          logout, renderHeader, formatDate, esc
 *
 * Inclus ca <script src="/ui.js"></script> în fiecare pagină.
 * Funcțiile sunt disponibile global (window.*).
 */

// ── Token / user ───────────────────────────────────────────────────────────
function getToken()  { return localStorage.getItem('docflow_token') || ''; }
function getUser()   {
  try { return JSON.parse(localStorage.getItem('docflow_user') || '{}'); } catch { return {}; }
}
function setUser(u)  { localStorage.setItem('docflow_user', JSON.stringify(u)); }
function clearAuth() { localStorage.removeItem('docflow_token'); localStorage.removeItem('docflow_user'); }

// ── Logout ─────────────────────────────────────────────────────────────────
function logout() {
  clearAuth();
  location.href = '/login';
}

// ── JWT refresh silențios ──────────────────────────────────────────────────
let _refreshPromise = null;
async function silentRefresh() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const r = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
      });
      if (!r.ok) return false;
      const d = await r.json();
      if (d.token) {
        localStorage.setItem('docflow_token', d.token);
        setUser(d);
        return true;
      }
      return false;
    } catch { return false; }
    finally { _refreshPromise = null; }
  })();
  return _refreshPromise;
}

// ── apiFetch — fetch cu JWT auto-refresh ───────────────────────────────────
async function _apiFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res = await fetch(url, { ...opts, headers });

  // Token expirat → încearcă refresh o singură dată
  if (res.status === 401) {
    const refreshed = await silentRefresh();
    if (refreshed) {
      headers['Authorization'] = 'Bearer ' + getToken();
      res = await fetch(url, { ...opts, headers });
    } else {
      clearAuth();
      location.href = '/login';
      return null;
    }
  }

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try { const d = await res.json(); errMsg = d.message || d.error || errMsg; } catch {}
    throw Object.assign(new Error(errMsg), { status: res.status });
  }

  try { return await res.json(); } catch { return null; }
}

// ── requireAuth — redirect la login dacă nu e autentificat ────────────────
async function requireAuth(adminOnly = false) {
  const token = getToken();
  if (!token) { location.href = '/login'; return null; }
  try {
    const user = await _apiFetch('/auth/me');
    if (!user) return null;
    setUser(user);
    if (adminOnly && user.role !== 'admin') {
      location.href = '/';
      return null;
    }
    return user;
  } catch {
    clearAuth();
    location.href = '/login';
    return null;
  }
}

// ── renderHeader — populează elementele din header ────────────────────────
function renderHeader(user) {
  const el = document.getElementById('hdrUser');
  if (el) el.textContent = user?.nume || user?.email || '';
}

// ── Toast ──────────────────────────────────────────────────────────────────
function _ensureToastContainer() {
  let c = document.getElementById('df-toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'df-toast-container';
    document.body.appendChild(c);
  }
  return c;
}

function toast(message, type = 'ok', duration = 3500) {
  const c = _ensureToastContainer();
  const t = document.createElement('div');
  t.className = 'df-toast ' + type;
  const icon = type === 'ok' ? '✅' : type === 'err' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
  t.textContent = icon + ' ' + message;
  c.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 280);
  }, duration);
}

// Alias-uri uzuale
const toastOk   = (m) => toast(m, 'ok');
const toastErr  = (m) => toast(m, 'err');
const toastWarn = (m) => toast(m, 'warn');

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso, opts) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ro-RO', opts || { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}

function formatDateShort(iso) {
  return formatDate(iso, { day:'2-digit', month:'2-digit', year:'numeric' });
}

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'acum';
  if (m < 60) return `acum ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `acum ${h}h`;
  const d = Math.floor(h / 24);
  return `acum ${d} ${d === 1 ? 'zi' : 'zile'}`;
}

function copyToClipboard(text, label) {
  navigator.clipboard?.writeText(text).then(() => toast(`${label || 'Text'} copiat`, 'ok')).catch(() => {});
}

// ── Expune global ──────────────────────────────────────────────────────────
Object.assign(window, {
  getToken, getUser, setUser, clearAuth,
  logout, silentRefresh,
  _apiFetch, requireAuth, renderHeader,
  toast, toastOk, toastErr, toastWarn,
  esc, formatDate, formatDateShort, relativeTime, copyToClipboard,
});
