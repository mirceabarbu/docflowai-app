(function() {
  const $ = id => document.getElementById(id);

  window.toggleUserMenu = function(ev) {
    ev && ev.stopPropagation();
    const m = $('df-user-menu');
    if (!m) return;
    m.classList.toggle('open');
    const btn = m.querySelector('.df-user-trigger');
    if (btn) btn.setAttribute('aria-expanded', m.classList.contains('open') ? 'true' : 'false');
  };

  window.closeUserMenu = function() {
    const m = $('df-user-menu');
    if (!m) return;
    m.classList.remove('open');
    const btn = m.querySelector('.df-user-trigger');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  };

  document.addEventListener('click', function(e) {
    const m = $('df-user-menu');
    if (m && m.classList.contains('open') && !m.contains(e.target)) closeUserMenu();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeUserMenu();
  });

  if (typeof window.logout !== 'function') {
    window.logout = async function() {
      // SEC-01: invalidăm cookie-ul pe server ÎNAINTE de redirect (Safari/mobil anulează fetch-ul în zbor)
      try {
        await Promise.race([
          fetch('/auth/logout', { method: 'POST', credentials: 'include' }),
          new Promise(function(res) { setTimeout(res, 3000); }),
        ]);
      } catch (_) {}
      localStorage.removeItem('docflow_user');
      localStorage.removeItem('docflow_force_pwd');
      location.href = '/login';
    };
  }

  function populateUser(u) {
    const nameEl = $('hdrUser');
    if (nameEl) nameEl.textContent = u.nume || u.email || '—';

    const avatarEl = document.querySelector('.df-user-trigger-avatar');
    if (avatarEl) {
      const initials = (u.nume || u.email || 'U').trim().split(/\s+/).map(function(w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
      avatarEl.textContent = initials;
    }

    const roleEl = document.querySelector('.df-user-trigger-role');
    if (roleEl) {
      var roleMap = { admin: 'Administrator', superadmin: 'Administrator', org_admin: 'Admin organizație', user: 'Utilizator' };
      roleEl.textContent = roleMap[u.role] || u.role || 'Utilizator';
    }
  }

  var SETARI_GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  // Injectează link „Setări" în dropdown-ul profile (prima poziție, înainte de Schimbă parola)
  document.addEventListener('DOMContentLoaded', function() {
    var dropdown = document.querySelector('.df-user-dropdown');
    if (dropdown && !dropdown.querySelector('a[href="/setari"]')) {
      var link = document.createElement('a');
      link.href = '/setari';
      link.style.textDecoration = 'none';
      var btn = document.createElement('button');
      btn.innerHTML = SETARI_GEAR_SVG + ' Setări';
      link.appendChild(btn);
      dropdown.insertBefore(link, dropdown.firstChild);
    }
  });

  // Injectează link „Setări" în sidebar, sub secțiunea „Navigare app", după ultimul item
  document.addEventListener('DOMContentLoaded', function() {
    var labels = document.querySelectorAll('.df-nav-label');
    var navGroup = null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === 'Navigare app') {
        var sib = labels[i].nextElementSibling;
        if (sib && sib.classList.contains('df-nav-group')) { navGroup = sib; break; }
      }
    }
    if (!navGroup) return;
    if (navGroup.querySelector('a[href="/setari"]')) return; // idempotent
    var a = document.createElement('a');
    a.href = '/setari';
    a.className = 'df-nav-item';
    var path = (location.pathname || '').replace(/\/$/, '');
    if (path === '/setari' || path === '/setari.html') a.classList.add('active');
    a.innerHTML = SETARI_GEAR_SVG + ' Setări';
    navGroup.appendChild(a);
  });

  // Injectează link „Registratură" în sidebar (pattern identic cu Setări, idempotent)
  document.addEventListener('DOMContentLoaded', function() {
    var labels = document.querySelectorAll('.df-nav-label');
    var navGroup = null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === 'Navigare app') {
        var sib = labels[i].nextElementSibling;
        if (sib && sib.classList.contains('df-nav-group')) { navGroup = sib; break; }
      }
    }
    if (!navGroup) return;
    if (navGroup.querySelector('a[href="/registratura"]')) return; // idempotent
    var a = document.createElement('a');
    a.href = '/registratura';
    a.className = 'df-nav-item';
    var path = (location.pathname || '').replace(/\/$/, '');
    if (path === '/registratura' || path === '/registratura.html') a.classList.add('active');
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M4 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4z"/><path d="M4 4v16"/><path d="M8 8h6M8 12h6M8 16h4"/></svg> Registratură';
    navGroup.appendChild(a);
  });

  // Injectează link „Primite" în sidebar (pattern identic cu Registratură, idempotent), cu
  // bădge de documente neconfirmate — vezi countUnacknowledgedFor (flow-transmit.mjs).
  document.addEventListener('DOMContentLoaded', function() {
    var labels = document.querySelectorAll('.df-nav-label');
    var navGroup = null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === 'Navigare app') {
        var sib = labels[i].nextElementSibling;
        if (sib && sib.classList.contains('df-nav-group')) { navGroup = sib; break; }
      }
    }
    if (!navGroup) return;
    if (navGroup.querySelector('a[href^="/notifications.html?tab=primite"]')) return; // idempotent

    var a = document.createElement('a');
    a.href = '/notifications.html?tab=primite';
    a.className = 'df-nav-item';
    var path = (location.pathname || '').replace(/\/$/, '');
    var qs = location.search || '';
    if ((path === '/notifications' || path === '/notifications.html') && qs.indexOf('tab=primite') !== -1) {
      a.classList.add('active');
    }
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M2 8l10 6 10-6"/><path d="M22 8l-10-6L2 8"/></svg> <span>Primite</span> <span class="df-nav-badge" id="primiteBadgeCount" style="display:none;margin-left:auto;background:rgba(124,92,255,.35);color:#c4b5fd;border-radius:9px;min-width:18px;height:18px;align-items:center;justify-content:center;font-size:.7rem;font-weight:800;padding:0 5px;"></span>';
    navGroup.appendChild(a);

    // Bădge cu numărul de documente neconfirmate — doar dacă există sesiune activă
    var hasSession = !!localStorage.getItem('docflow_user') || !!localStorage.getItem('docflow_token');
    if (hasSession) {
      fetch('/api/my-received/count', { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          if (!d || !d.count) return;
          var badge = document.getElementById('primiteBadgeCount');
          if (badge) { badge.textContent = String(d.count); badge.style.display = 'inline-flex'; }
        })
        .catch(function() {});
    }
  });

  // Injectează link „Chat" în sidebar, în grupul „Comunicare", ÎNAINTEA linkului
  // Notificări (idempotent, pattern identic cu Registratură/Primite).
  //
  // ⚠️ SELF-GATING — intenționat, NU redundanță: df-entitlements.js (care aplică
  // `data-df-module`) e încărcat pe DOAR 5 din cele 12 pagini cu grupul „Comunicare".
  // Pe celelalte 7 atributul e inert, deci linkul ar fi VIZIBIL cu modulul off. Aici:
  //   • dacă df-entitlements.js e prezent → ne bazăm pe el (+ re-aplicăm la refresh);
  //   • dacă NU → fetch local /api/entitlements/me, fail-closed (ascuns la 401/eroare).
  // Linkul pornește ASCUNS și se arată doar la confirmare explicită „chat = on".
  // Poarta reală rămâne pe server (requireModule('chat') pe /api/chat/*); asta e UI.
  document.addEventListener('DOMContentLoaded', function() {
    var labels = document.querySelectorAll('.df-nav-label');
    var navGroup = null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === 'Comunicare') {
        var sib = labels[i].nextElementSibling;
        if (sib && sib.classList.contains('df-nav-group')) { navGroup = sib; break; }
      }
    }
    if (!navGroup) return;                                    // pagină fără grupul „Comunicare"
    if (navGroup.querySelector('a[href="/chat.html"]')) return; // idempotent (ex. chat.html static)

    var a = document.createElement('a');
    a.href = '/chat.html';
    a.className = 'df-nav-item';
    a.setAttribute('data-df-module', 'chat');
    var path = (location.pathname || '').replace(/\/$/, '');
    if (path === '/chat' || path === '/chat.html') a.classList.add('active');
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Chat';
    a.style.display = 'none';                                 // fail-closed până la confirmare

    var notif = navGroup.querySelector('a[href="/notifications"], a[href="/notifications.html"]');
    if (notif) navGroup.insertBefore(a, notif); else navGroup.appendChild(a);

    function applyChatGate(on) { a.style.display = on ? '' : 'none'; }

    if (window.df && window.df._entitlementsLoaded && window.df.entitlementsReady) {
      // Promise, nu doar evenimentul: `df:entitlements-ready` poate fi deja emis
      // înainte de DOMContentLoaded (fetch-ul pornește la load-ul scriptului).
      window.df.entitlementsReady.then(function() {
        applyChatGate(window.df.canUseModule('chat'));
      }).catch(function() { applyChatGate(false); });
      // Re-aplică după refreshEntitlements() (superadmin schimbă modulele din UI).
      document.addEventListener('df:entitlements-ready', function() {
        applyChatGate(window.df.canUseModule('chat'));
      });
      return;
    }

    // Fallback (paginile fără df-entitlements.js). Gardă de sesiune ca la badge-ul
    // „Primite" — fără sesiune nu interogăm (ar da 401 zgomotos pe pagini publice).
    var hasSession = !!localStorage.getItem('docflow_user') || !!localStorage.getItem('docflow_token');
    if (!hasSession) return;                                  // rămâne ascuns
    fetch('/api/entitlements/me', { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { applyChatGate(!!(d && d.modules && d.modules.chat === true)); })
      .catch(function() { applyChatGate(false); });
  });

  document.addEventListener('DOMContentLoaded', function() {
    // 1. Populate from localStorage cache immediately (no flash)
    var cached = JSON.parse(localStorage.getItem('docflow_user') || '{}');
    if (cached.email || cached.nume) populateUser(cached);

    // 2. Fetch /auth/me → redirect to login if session expired
    fetch('/auth/me', { credentials: 'include' })
      .then(function(r) {
        if (!r.ok) {
          localStorage.removeItem('docflow_user');
          location.href = '/login?next=' + encodeURIComponent(location.pathname);
          return null;
        }
        return r.json();
      })
      .then(function(u) {
        if (!u) return;
        localStorage.setItem('docflow_user', JSON.stringify(u));
        populateUser(u);

        // 3. Role-based sidebar hiding
        var isAdmin = u.role === 'admin' || u.role === 'superadmin';
        var isOrgAdmin = u.role === 'admin' || u.role === 'org_admin' || u.role === 'superadmin';

        if (!isAdmin && !isOrgAdmin) {
          document.querySelectorAll('.df-nav-label').forEach(function(l) {
            if (l.textContent.trim() === 'Administrare') {
              l.style.display = 'none';
              if (l.nextElementSibling) l.nextElementSibling.style.display = 'none';
            }
          });
        }
        if (isOrgAdmin && !isAdmin) {
          document.querySelectorAll('.df-nav-item').forEach(function(item) {
            var href = item.getAttribute('href') || '';
            if (href.indexOf('/admin#organizatii') !== -1) item.style.display = 'none';
          });
        }
        if (!isOrgAdmin) {
          document.querySelectorAll('.df-nav-label').forEach(function(l) {
            if (l.textContent.trim() === 'Organizație') {
              l.style.display = 'none';
              if (l.nextElementSibling) l.nextElementSibling.style.display = 'none';
            }
          });
        }

        // Afișează butonul 2FA în dropdown doar pentru admin/org_admin
        if (isAdmin || isOrgAdmin) {
          var btn2fa = document.getElementById('hdr2faBtn');
          if (btn2fa) btn2fa.style.display = 'inline-flex';
        }

        // Ascunde "Panou admin" din dropdown pentru utilizatori non-admin
        if (!isAdmin && !isOrgAdmin) {
          document.querySelectorAll('.df-admin-link').forEach(function(el) {
            el.style.display = 'none';
          });
        }
      })
      .catch(function() {
        location.href = '/login?next=' + encodeURIComponent(location.pathname);
      });
  });
})();
