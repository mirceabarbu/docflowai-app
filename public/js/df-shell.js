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
    window.logout = function() {
      fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(function() {});
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

  // Injectează link „Setări" în dropdown-ul profile (prima poziție, înainte de Schimbă parola)
  document.addEventListener('DOMContentLoaded', function() {
    var dropdown = document.querySelector('.df-user-dropdown');
    if (dropdown && !dropdown.querySelector('a[href="/setari"]')) {
      var link = document.createElement('a');
      link.href = '/setari';
      link.style.textDecoration = 'none';
      var btn = document.createElement('button');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Setări';
      link.appendChild(btn);
      dropdown.insertBefore(link, dropdown.firstChild);
    }
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

        if (!isAdmin) {
          document.querySelectorAll('.df-nav-label').forEach(function(l) {
            if (l.textContent.trim() === 'Administrare') {
              l.style.display = 'none';
              if (l.nextElementSibling) l.nextElementSibling.style.display = 'none';
            }
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
