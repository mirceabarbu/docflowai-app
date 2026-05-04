# PROMPT — BLOC 4.2 (UI setări concediu/delegare — pagină dedicată + admin tab)

## CONTEXT

DocFlowAI v3.9.379+. BLOC 4.1 (backend) deja merged + verde pe staging. Acum adăugăm UI:
1. **Pagină nouă `setari.html`** — userul își setează singur concediul + delegatul
2. **Secțiune nouă în modal `Editează utilizator`** (admin.html) — admin setează pentru oricine din org
3. **Link spre `/setari`** în profile dropdown (df-user-modals.js sau df-shell.js)

**BLOC 4.2 = doar UI.** Logica de redirect în flux (dropdown smart, auto-redirect fluxuri existente) vine în BLOC 4.3.

**API-ul existent** (din 4.1):
- `GET /users` — return enriched cu `leave: {...}` per user (folosit pentru lista delegați candidați)
- `PUT /api/users/me/leave` — user își setează singur (cu validări)
- `DELETE /api/users/me/leave` — anulare
- `PUT /admin/users/:id/leave` + `DELETE` — admin pentru oricine

## ⛔ CONSTRÂNGERI ABSOLUTE

1. NU atinge zona STS (lista cunoscută)
2. NU atinge `df-apifetch-shim*.js`, `admin/core.js`
3. NU atinge logica de creare flux — vine în BLOC 4.3
4. NU atinge backend (e deja făcut în 4.1)
5. NU folosi `<form>` HTML (folosim `<div>` + butoane cu onClick)
6. **Stil consistent cu BLOC 3** — folosim `df-action-btn` pentru toate butoanele, `df-modal-footer` pentru wrapper-ele de butoane în modal
7. `npm test` verde

## ARHITECTURĂ

### Componenta 1 — Pagină nouă `public/setari.html`

Structura: shell DocFlowAI standard (sidebar + header + content), cu un singur card mare „Concediu și delegare":
- Date pickeri: leave_start, leave_end (`<input type="date">`)
- Searchable dropdown pentru delegate (din useri din aceeași org, exclude self + cei deja în concediu cu propriul delegat)
- Câmp opțional `leave_reason` (textarea, max 500 chars)
- Status curent (banner "Sunteți în concediu" / "Concediu programat" / "Niciun concediu setat")
- 2 butoane: `Salvează` + `Anulează concediul` (al doilea apare doar dacă userul are concediu setat)

### Componenta 2 — Secțiune în modal `Editează utilizator` (admin.html)

Sub blocul existent cu 3 coloane (linia ~1264), adaug o secțiune nouă collapsible cu **același layout** ca pagina setari, dar pentru user-ul în editare. Utilizează endpoint-urile admin (`PUT /admin/users/:id/leave`).

### Componenta 3 — Link în profile dropdown

Identifică cum se afișează profile dropdown-ul (df-shell.js sau df-user-modals.js) și adaugă un item nou „Setări" → `/setari`.

### Rutare

În `server/index.mjs`, adaug 1 linie pentru `app.get('/setari', ...)` lângă celelalte rute clean URL.

---

## FAZA 0 — Pre-checks

```bash
# 0.1 — Confirm BLOC 4.1 e merged
grep -c "063_user_leave_delegate" server/db/index.mjs
# Așteptat: 1

ls server/services/user-leave.mjs 2>/dev/null
# Așteptat: fișier prezent

grep -cE "router\.(put|delete)\([^)]*/leave" server/routes/admin/users.mjs
# Așteptat: 4

# 0.2 — Versiune curentă pentru asset cache busting
grep '"version"' package.json
# Notează valoarea (ex: 3.9.379). Folosește ca <VER> în prompt.

# 0.3 — Verifică structura rute clean URL
grep -nE "app\.get\('/[a-z]+'.*sendFile" server/index.mjs | tail -5
# Așteptat: 5 rute (login, admin, notifications, verifica, templates)

# 0.4 — Verifică unde e profile dropdown (df-shell.js sau df-user-modals.js)
grep -nE "profile|dropdown|menu-item|deconectare|logout" public/js/df-shell.js public/js/df-user-modals.js | head -10

# 0.5 — Confirm modal-bg + .modal pattern admin
grep -nE 'class="modal-bg"|class="modal"' public/admin.html | head -5
```

---

## FAZA 1 — Pagină nouă `public/setari.html`

**Creează fișier nou** cu următorul conținut:

```html
<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>DocFlowAI — Setări</title>
  <link rel="stylesheet" href="/css/df/tokens.css?v=<VER>">
  <link rel="stylesheet" href="/css/df/shell.css?v=<VER>">
  <link rel="stylesheet" href="/css/df/components.css?v=<VER>">
  <link rel="stylesheet" href="/css/setari/setari.css?v=<VER>">

  <script src="/js/df-utils.js?v=<VER>"></script>
  <script src="/js/df-apifetch-shim.js?v=<VER>"></script>
  <link rel="stylesheet" href="/mobile.css?v=<VER>">
  <script src="/js/df-shell.js?v=<VER>"></script>
  <script src="/js/df-user-modals.js?v=<VER>"></script>
</head>
<body>

<div class="df-shell">
  <aside class="df-sidebar">
    <div class="df-sidebar-brand">
      <img src="/Logo.png" alt="DocFlowAI"/>
    </div>

    <div class="df-nav-label">Navigare app</div>
    <div class="df-nav-group">
      <a href="/" class="df-nav-item">
        <svg class="df-nav-icon" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-edit"/></svg>
        Flux nou
      </a>
      <a href="/?tab=flows" class="df-nav-item">
        <svg class="df-nav-icon" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-folder"/></svg>
        Fluxurile mele
      </a>
      <a href="/templates" class="df-nav-item">
        <svg class="df-nav-icon" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-grid"/></svg>
        Șabloane
      </a>
      <a href="/formular.html" class="df-nav-item">
        <svg class="df-nav-icon" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-file-text"/></svg>
        Formulare
      </a>
    </div>

    <div class="df-nav-label">Comunicare</div>
    <div class="df-nav-group">
      <a href="/notifications" class="df-nav-item">
        <svg class="df-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        Notificări
      </a>
    </div>

    <div class="df-nav-label">Cont</div>
    <div class="df-nav-group">
      <a href="/setari" class="df-nav-item active">
        <svg class="df-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        Setări
      </a>
    </div>
  </aside>

  <main class="df-main">
    <header class="df-page-header">
      <div>
        <h1 class="df-page-title">Setări</h1>
        <p class="df-page-subtitle">Configurează concediul și delegatul pentru semnătură</p>
      </div>
      <div class="df-page-actions">
        <div id="userBadge" class="df-user-badge"></div>
      </div>
    </header>

    <section class="df-page-body">
      <!-- Card concediu/delegare -->
      <div class="setari-card">
        <h2 class="setari-card-title">Concediu și delegare</h2>
        <p class="setari-card-desc">Marchează perioada în care nu vei fi disponibil. În acest interval, fluxurile noi pe care trebuie să le semnezi vor fi atribuite automat delegatului ales.</p>

        <!-- Banner status curent -->
        <div id="leaveStatusBanner" class="setari-status setari-status-none">
          <svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-info"/></svg>
          <span id="leaveStatusText">Niciun concediu setat.</span>
        </div>

        <!-- Form -->
        <div class="setari-form">
          <div class="setari-row">
            <div class="setari-field">
              <label for="leaveStart">Data început concediu *</label>
              <input type="date" id="leaveStart" class="setari-input"/>
            </div>
            <div class="setari-field">
              <label for="leaveEnd">Data sfârșit concediu *</label>
              <input type="date" id="leaveEnd" class="setari-input"/>
            </div>
          </div>

          <div class="setari-field">
            <label for="leaveDelegate">Delegat (cine semnează în lipsa ta) *</label>
            <select id="leaveDelegate" class="setari-input">
              <option value="">— Alege delegat —</option>
            </select>
            <small class="setari-hint">Doar utilizatori din aceeași instituție. Persoanele care au deja propriul delegat nu apar în listă (pentru a evita lanțuri de delegare).</small>
          </div>

          <div class="setari-field">
            <label for="leaveReason">Motiv concediu (opțional)</label>
            <textarea id="leaveReason" class="setari-input" rows="3" maxlength="500" placeholder="Ex: Concediu de odihnă, formare profesională, etc."></textarea>
            <small class="setari-hint"><span id="reasonCount">0</span>/500 caractere</small>
          </div>

          <div id="leaveMsg" class="setari-msg"></div>

          <div class="setari-actions">
            <button id="btnClearLeave" class="df-action-btn danger" style="display:none;" onclick="clearLeave()">
              <svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-x"/></svg>
              Anulează concediul
            </button>
            <button id="btnSaveLeave" class="df-action-btn primary" onclick="saveLeave()">
              <svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-save"/></svg>
              Salvează
            </button>
          </div>
        </div>
      </div>
    </section>
  </main>
</div>

<script src="/js/setari/setari.js?v=<VER>"></script>
</body>
</html>
```

NB: Înlocuiește `<VER>` cu valoarea de la pre-check 0.2 (ex. `3.9.379`).

---

## FAZA 2 — CSS dedicat `public/css/setari/setari.css` (NOU)

**Creează director și fișier:** `mkdir -p public/css/setari` apoi creează `public/css/setari/setari.css`:

```css
/* CSS specific setari.html — card concediu/delegare.
   Depinde de: tokens.css, shell.css, components.css. */

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* Card principal */
.setari-card {
  background: var(--df-surface);
  border: 1px solid var(--df-border);
  border-radius: var(--df-radius-xl);
  padding: 28px;
  max-width: 760px;
  margin-bottom: 24px;
}
.setari-card-title {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--df-text);
  margin-bottom: 6px;
}
.setari-card-desc {
  font-size: .85rem;
  color: var(--df-text-3);
  margin-bottom: 22px;
  line-height: 1.5;
}

/* Banner status */
.setari-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--df-radius-md);
  font-size: .88rem;
  font-weight: 500;
  margin-bottom: 22px;
}
.setari-status .df-ic { width: 18px; height: 18px; flex-shrink: 0; }
.setari-status-none {
  background: rgba(255,255,255,.04);
  border: 1px solid var(--df-border-2);
  color: var(--df-text-3);
}
.setari-status-active {
  background: rgba(255,170,30,.10);
  border: 1px solid rgba(255,170,30,.3);
  color: #ffcc44;
}
.setari-status-scheduled {
  background: rgba(108,79,240,.10);
  border: 1px solid rgba(108,79,240,.3);
  color: #b0a0ff;
}
.setari-status-expired {
  background: rgba(120,120,120,.08);
  border: 1px solid var(--df-border-2);
  color: var(--df-text-4);
}

/* Form */
.setari-form { display: flex; flex-direction: column; gap: 16px; }
.setari-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.setari-field { display: flex; flex-direction: column; gap: 5px; }
.setari-field label {
  font-size: .75rem;
  color: var(--df-text-3);
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.setari-input {
  width: 100%;
  padding: 10px 12px;
  background: rgba(0,0,0,.2);
  border: 1px solid var(--df-border-2);
  border-radius: var(--df-radius-md);
  color: var(--df-text);
  font-size: .88rem;
  font-family: inherit;
  outline: none;
  transition: border-color .15s;
  box-sizing: border-box;
}
.setari-input:focus { border-color: var(--df-brand); }
.setari-input:disabled { opacity: .5; cursor: not-allowed; }
.setari-input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(.7); cursor: pointer; }
textarea.setari-input { resize: vertical; min-height: 70px; line-height: 1.5; }

.setari-hint {
  font-size: .75rem;
  color: var(--df-text-4);
  margin-top: 2px;
}

/* Mesaj feedback */
.setari-msg {
  font-size: .85rem;
  min-height: 20px;
  padding: 0 2px;
}
.setari-msg.ok { color: #4ade80; }
.setari-msg.err { color: #f87171; }

/* Acțiuni footer */
.setari-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  align-items: center;
  padding-top: 16px;
  margin-top: 8px;
  border-top: 1px solid var(--df-border);
  flex-wrap: wrap;
}

/* Mobile */
@media (max-width: 640px) {
  .setari-card { padding: 20px; }
  .setari-row { grid-template-columns: 1fr; }
}
```

---

## FAZA 3 — JavaScript `public/js/setari/setari.js` (NOU)

**Creează director și fișier:** `mkdir -p public/js/setari` apoi creează `public/js/setari/setari.js`:

```js
/**
 * setari.js — UI logic pentru pagina /setari (BLOC 4.2).
 *
 * Afișează status concediu curent, populează dropdown-ul de delegați
 * (useri din aceeași instituție, exclude self + cei cu delegat propriu),
 * gestionează SAVE și CLEAR.
 *
 * Endpoint-uri folosite (BLOC 4.1):
 *   GET    /users                       — lista useri (cu info leave)
 *   PUT    /api/users/me/leave          — salvează concediu
 *   DELETE /api/users/me/leave          — anulează concediu
 */

(function() {
  let _allUsers = [];
  let _meUserId = null;
  let _meEmail = null;

  // ── Init ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      _meEmail = JSON.parse(localStorage.getItem('docflow_user') || '{}').email || null;
      await loadUsers();
      await loadCurrentLeave();
      attachListeners();
    } catch (e) {
      console.warn('Init setari failed:', e);
      showMsg('err', 'Eroare la încărcarea paginii. Reîncarcă.');
    }
  });

  // ── Listeners ──────────────────────────────────────────────────────────────
  function attachListeners() {
    const reasonEl = document.getElementById('leaveReason');
    const countEl = document.getElementById('reasonCount');
    if (reasonEl && countEl) {
      reasonEl.addEventListener('input', () => {
        countEl.textContent = reasonEl.value.length;
      });
    }
    // Auto-validate: end >= start
    const startEl = document.getElementById('leaveStart');
    const endEl = document.getElementById('leaveEnd');
    if (startEl && endEl) {
      startEl.addEventListener('change', () => {
        if (endEl.value && endEl.value < startEl.value) {
          endEl.value = startEl.value;
        }
        endEl.min = startEl.value;
      });
    }
  }

  // ── API: încarcă useri (pentru dropdown delegați) ──────────────────────────
  async function loadUsers() {
    const r = await _apiFetch('/users');
    if (!r.ok) throw new Error('users_fetch_failed');
    _allUsers = await r.json();

    // Identifică user-ul curent
    if (_meEmail) {
      const me = _allUsers.find(u => u.email && u.email.toLowerCase() === _meEmail.toLowerCase());
      _meUserId = me?.id || null;
    }

    // Populează dropdown delegate (exclude self + cei cu delegat propriu)
    const sel = document.getElementById('leaveDelegate');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);

    const candidates = _allUsers.filter(u => {
      if (u.id === _meUserId) return false; // exclude self
      if (u.leave?.delegate) return false; // exclude cei cu delegat propriu (NO CHAIN)
      return true;
    });

    candidates.sort((a, b) => (a.nume || '').localeCompare(b.nume || '', 'ro'));
    candidates.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
      sel.appendChild(opt);
    });
  }

  // ── API: încarcă concediul curent al userului ──────────────────────────────
  async function loadCurrentLeave() {
    if (!_meUserId) return;
    const me = _allUsers.find(u => u.id === _meUserId);
    if (!me?.leave) {
      updateStatusBanner('none');
      return;
    }
    // Pre-fill form cu valorile existente
    const { leaveStart, leaveEnd, leaveReason, delegate, onLeave } = me.leave;
    if (leaveStart) document.getElementById('leaveStart').value = leaveStart;
    if (leaveEnd) document.getElementById('leaveEnd').value = leaveEnd;
    if (delegate?.id) document.getElementById('leaveDelegate').value = delegate.id;
    if (leaveReason) {
      document.getElementById('leaveReason').value = leaveReason;
      document.getElementById('reasonCount').textContent = leaveReason.length;
    }

    // Status banner
    const today = new Date().toISOString().slice(0, 10);
    if (onLeave) {
      updateStatusBanner('active', `În concediu până la ${_fmtDate(leaveEnd)}. Delegat: ${delegate?.nume || '—'}.`);
    } else if (leaveStart > today) {
      updateStatusBanner('scheduled', `Concediu programat: ${_fmtDate(leaveStart)} → ${_fmtDate(leaveEnd)}. Delegat: ${delegate?.nume || '—'}.`);
    } else {
      updateStatusBanner('expired', `Concediu expirat (${_fmtDate(leaveStart)} → ${_fmtDate(leaveEnd)}). Setează unul nou sau anulează.`);
    }

    // Arată butonul "Anulează concediul"
    document.getElementById('btnClearLeave').style.display = 'inline-flex';
  }

  function updateStatusBanner(kind, text) {
    const banner = document.getElementById('leaveStatusBanner');
    const txt = document.getElementById('leaveStatusText');
    if (!banner || !txt) return;
    banner.className = 'setari-status setari-status-' + kind;
    if (kind === 'none') {
      txt.textContent = 'Niciun concediu setat.';
    } else {
      txt.textContent = text || '';
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  window.saveLeave = async function() {
    showMsg('', '');
    const leave_start = document.getElementById('leaveStart').value || null;
    const leave_end = document.getElementById('leaveEnd').value || null;
    const delegate_user_id = document.getElementById('leaveDelegate').value || null;
    const leave_reason = document.getElementById('leaveReason').value.trim() || null;

    // Validări client (server le repetă)
    if (!leave_start || !leave_end) {
      return showMsg('err', 'Datele de început și sfârșit sunt obligatorii.');
    }
    if (leave_end < leave_start) {
      return showMsg('err', 'Data sfârșit nu poate fi înainte de data început.');
    }
    if (!delegate_user_id) {
      return showMsg('err', 'Alege un delegat.');
    }

    const btn = document.getElementById('btnSaveLeave');
    btn.disabled = true;
    try {
      const r = await _apiFetch('/api/users/me/leave', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leave_start, leave_end, delegate_user_id: Number(delegate_user_id), leave_reason }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return showMsg('err', data.message || data.error || 'Eroare la salvare.');
      }
      showMsg('ok', 'Concediu salvat cu succes.');
      // Reload UI cu noile valori
      await loadUsers();
      await loadCurrentLeave();
    } catch (e) {
      console.error('saveLeave failed:', e);
      showMsg('err', 'Eroare de rețea. Încearcă din nou.');
    } finally {
      btn.disabled = false;
    }
  };

  // ── Clear ──────────────────────────────────────────────────────────────────
  window.clearLeave = async function() {
    if (!confirm('Anulezi concediul setat?')) return;
    showMsg('', '');
    const btn = document.getElementById('btnClearLeave');
    btn.disabled = true;
    try {
      const r = await _apiFetch('/api/users/me/leave', { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return showMsg('err', data.message || data.error || 'Eroare la anulare.');
      }
      showMsg('ok', 'Concediu anulat.');
      // Reset form + ascunde butonul Clear
      ['leaveStart', 'leaveEnd', 'leaveDelegate', 'leaveReason'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      document.getElementById('reasonCount').textContent = '0';
      document.getElementById('btnClearLeave').style.display = 'none';
      await loadUsers();
      updateStatusBanner('none');
    } catch (e) {
      console.error('clearLeave failed:', e);
      showMsg('err', 'Eroare de rețea. Încearcă din nou.');
    } finally {
      btn.disabled = false;
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showMsg(kind, text) {
    const el = document.getElementById('leaveMsg');
    if (!el) return;
    el.className = 'setari-msg' + (kind ? ' ' + kind : '');
    el.textContent = text;
    if (kind === 'ok') {
      setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'setari-msg'; } }, 4000);
    }
  }

  function _fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
})();
```

---

## FAZA 4 — Rută Express pentru `/setari`

**Fișier:** `server/index.mjs`

**Locație:** după linia `app.get('/templates', ...)` (în jur de linia 693).

**Adaugă imediat după:**
```js
app.get('/setari', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'setari.html')));
```

**Verificare:**
```bash
grep -c "app.get('/setari'" server/index.mjs
# Așteptat: 1
```

---

## FAZA 5 — Link „Setări" în profile dropdown

**Fișier:** `public/js/df-shell.js` (sau `df-user-modals.js`, după ce ai identificat la pre-check 0.4 unde e dropdown-ul)

**Strategia:** găsește pattern-ul cu opțiunile existente (probabil "Schimbă parola", "Deconectare") și adaugă „Setări" deasupra "Schimbă parola" (sau în poziție logică).

**Notă pentru Claude Code:** caută în `df-shell.js` pattern-ul `<a href` sau `<button` care formează items-urile dropdown-ului profile. Adaugă:

```html
<a href="/setari" class="df-dropdown-item">
  <svg class="df-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
  Setări
</a>
```

(Adaptează clasa `df-dropdown-item` la cum sunt clasele reale identificate în pre-check 0.4.)

**Dacă structura dropdown-ului e diferită** (ex. nu există dropdown profile vizibil în df-shell), atunci:
- **Skip Faza 5 complet** — userul accesează `/setari` direct prin URL sau printr-un link din admin.html viitor (BLOC 4.3 o să adauge link contextual)
- Documentează decizia în commit message

---

## FAZA 6 — Secțiune „Concediu și delegare" în modal Editează utilizator (admin.html)

### 6.1 — Adaugă HTML în modal (admin.html, în jur de linia 1283, ÎNAINTE de `<div id="eGwsRow">`)

**Caută** linia exactă:
```html
    <!-- Status Workspace -->
    <div id="eGwsRow" style="display:none;margin-top:12px;background:rgba(66,133,244,.07);border:1px solid rgba(66,133,244,.2);border-radius:10px;padding:10px 14px;font-size:.83rem;">
```

**Inserează ÎNAINTE:**
```html
    <!-- Concediu și delegare -->
    <details id="eLeaveSection" style="margin-top:14px;background:rgba(255,255,255,.02);border:1px solid var(--df-border-2);border-radius:10px;padding:0 14px;">
      <summary style="padding:12px 0;cursor:pointer;font-size:.88rem;font-weight:600;color:var(--df-text-2);user-select:none;">
        🏖️ Concediu și delegare
        <span id="eLeaveStatusBadge" style="margin-left:8px;font-size:.72rem;font-weight:500;padding:2px 8px;border-radius:12px;background:rgba(120,120,120,.15);color:var(--df-text-3);">Nesetat</span>
      </summary>
      <div style="padding:6px 0 14px;display:flex;flex-direction:column;gap:10px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="frow"><label>Început concediu</label><input type="date" id="eLeaveStart"/></div>
          <div class="frow"><label>Sfârșit concediu</label><input type="date" id="eLeaveEnd"/></div>
        </div>
        <div class="frow">
          <label>Delegat (cine semnează în lipsă)</label>
          <select id="eLeaveDelegate"><option value="">— Niciun delegat —</option></select>
        </div>
        <div class="frow">
          <label>Motiv (opțional)</label>
          <textarea id="eLeaveReason" rows="2" maxlength="500" placeholder="Ex: Concediu de odihnă"></textarea>
        </div>
        <div id="eLeaveMsg" style="font-size:.8rem;min-height:18px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="df-action-btn danger sm" onclick="adminClearLeave()">
            <svg class="df-ic"><use href="/icons.svg?v=<VER>#ico-x"/></svg>
            Anulează concediul
          </button>
          <button type="button" class="df-action-btn primary sm" onclick="adminSaveLeave()">
            <svg class="df-ic"><use href="/icons.svg?v=<VER>#ico-save"/></svg>
            Salvează concediu
          </button>
        </div>
      </div>
    </details>

```

NB: `<details>` HTML face accordionul automat (deschis/închis). Browser native, fără JS.

### 6.2 — Adaugă logica JS în `public/js/admin/users.js`

**Strategia:** găsește funcția `openEdit` (sau cum se cheamă funcția care deschide modalul de editare user) și adaugă apel la `_loadLeaveSection(userId)` la final. Apoi adaugă funcțiile `adminSaveLeave` și `adminClearLeave` pe `window`.

**Locație:** la sfârșitul fișierului, ÎNAINTE de exportul/exposure-ul global (caută linia care expune `window.loadUsers = loadUsers;`).

**Adaugă blocul:**
```js

  // ═════════════════════════════════════════════════════════════════════════
  // LEAVE / DELEGATION (BLOC 4.2)
  // ═════════════════════════════════════════════════════════════════════════

  let _leaveTargetUserId = null;
  let _leaveAllUsers = [];

  // Apelată din openEdit() — populează secțiunea concediu cu datele user-ului
  async function _loadLeaveSection(userId, userOrgId) {
    _leaveTargetUserId = userId;
    document.getElementById('eLeaveMsg').textContent = '';
    document.getElementById('eLeaveMsg').className = '';

    // Reload userii pentru dropdown delegat
    try {
      const r = await _apiFetch('/users');
      _leaveAllUsers = r.ok ? await r.json() : [];
    } catch { _leaveAllUsers = []; }

    const sel = document.getElementById('eLeaveDelegate');
    while (sel.options.length > 1) sel.remove(1);
    const candidates = _leaveAllUsers.filter(u => {
      if (u.id === userId) return false; // exclude self
      if (u.org_id !== userOrgId) return false; // doar same org
      if (u.leave?.delegate) return false; // NO CHAIN
      return true;
    });
    candidates.sort((a, b) => (a.nume || '').localeCompare(b.nume || '', 'ro'));
    candidates.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
      sel.appendChild(opt);
    });

    // Pre-fill cu datele existente
    const me = _leaveAllUsers.find(u => u.id === userId);
    const leave = me?.leave;
    document.getElementById('eLeaveStart').value = leave?.leaveStart || '';
    document.getElementById('eLeaveEnd').value = leave?.leaveEnd || '';
    document.getElementById('eLeaveDelegate').value = leave?.delegate?.id || '';
    document.getElementById('eLeaveReason').value = leave?.leaveReason || '';

    // Badge status
    const badge = document.getElementById('eLeaveStatusBadge');
    if (!leave) {
      badge.textContent = 'Nesetat';
      badge.style.background = 'rgba(120,120,120,.15)';
      badge.style.color = 'var(--df-text-3)';
    } else if (leave.onLeave) {
      badge.textContent = 'Activ';
      badge.style.background = 'rgba(255,170,30,.15)';
      badge.style.color = '#ffcc44';
    } else {
      const today = new Date().toISOString().slice(0, 10);
      if (leave.leaveStart > today) {
        badge.textContent = 'Programat';
        badge.style.background = 'rgba(108,79,240,.15)';
        badge.style.color = '#b0a0ff';
      } else {
        badge.textContent = 'Expirat';
        badge.style.background = 'rgba(120,120,120,.15)';
        badge.style.color = 'var(--df-text-4)';
      }
    }
  }

  window.adminSaveLeave = async function() {
    const msg = document.getElementById('eLeaveMsg');
    msg.className = '';
    msg.textContent = '';

    if (!_leaveTargetUserId) return;

    const leave_start = document.getElementById('eLeaveStart').value || null;
    const leave_end = document.getElementById('eLeaveEnd').value || null;
    const delegate_user_id = document.getElementById('eLeaveDelegate').value || null;
    const leave_reason = document.getElementById('eLeaveReason').value.trim() || null;

    if (!leave_start || !leave_end) {
      msg.textContent = 'Datele de început și sfârșit sunt obligatorii.';
      msg.style.color = '#f87171';
      return;
    }
    if (!delegate_user_id) {
      msg.textContent = 'Alege un delegat.';
      msg.style.color = '#f87171';
      return;
    }

    try {
      const r = await _apiFetch(`/admin/users/${_leaveTargetUserId}/leave`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leave_start, leave_end, delegate_user_id: Number(delegate_user_id), leave_reason }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = data.message || data.error || 'Eroare.';
        msg.style.color = '#f87171';
        return;
      }
      msg.textContent = 'Concediu salvat.';
      msg.style.color = '#4ade80';
      // Reload listă utilizatori în background pentru a reflecta schimbarea
      if (typeof loadUsers === 'function') loadUsers();
    } catch (e) {
      msg.textContent = 'Eroare de rețea.';
      msg.style.color = '#f87171';
    }
  };

  window.adminClearLeave = async function() {
    const msg = document.getElementById('eLeaveMsg');
    if (!_leaveTargetUserId) return;
    if (!confirm('Anulezi concediul acestui utilizator?')) return;
    try {
      const r = await _apiFetch(`/admin/users/${_leaveTargetUserId}/leave`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = data.message || data.error || 'Eroare.';
        msg.style.color = '#f87171';
        return;
      }
      msg.textContent = 'Concediu anulat.';
      msg.style.color = '#4ade80';
      // Reset form
      ['eLeaveStart', 'eLeaveEnd', 'eLeaveDelegate', 'eLeaveReason'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const badge = document.getElementById('eLeaveStatusBadge');
      if (badge) {
        badge.textContent = 'Nesetat';
        badge.style.background = 'rgba(120,120,120,.15)';
        badge.style.color = 'var(--df-text-3)';
      }
      if (typeof loadUsers === 'function') loadUsers();
    } catch (e) {
      msg.textContent = 'Eroare de rețea.';
      msg.style.color = '#f87171';
    }
  };

  // Expune helper-ul pentru integrare în openEdit
  window._loadLeaveSection = _loadLeaveSection;
```

### 6.3 — Apel `_loadLeaveSection` din `openEdit`

**Caută** funcția `openEdit` în `public/js/admin/users.js` (probabil cu `function openEdit` sau `const openEdit`). În interiorul ei, după ce sunt populate câmpurile existente (Prenume, Email, etc.) și înainte ca modalul să fie afișat, adaugă:

```js
// BLOC 4.2 — populează secțiunea concediu/delegare
if (typeof _loadLeaveSection === 'function') {
  _loadLeaveSection(u.id, u.org_id);
}
```

NB: `u` e variabila locală din `openEdit` care conține datele user-ului. Adaptează numele dacă e diferit.

---

## FAZA 7 — Verificări finale

```bash
# 7.1 — Fișierele noi există
ls public/setari.html
ls public/css/setari/setari.css
ls public/js/setari/setari.js

# 7.2 — Ruta /setari adăugată
grep -c "app.get('/setari'" server/index.mjs
# Așteptat: 1

# 7.3 — Sintaxă JS OK
node --check public/js/setari/setari.js && echo "setari.js OK"

# 7.4 — Modal admin are secțiunea nouă
grep -c "id=\"eLeaveSection\"" public/admin.html
# Așteptat: 1

# 7.5 — admin/users.js are funcțiile noi
grep -cE "adminSaveLeave|adminClearLeave|_loadLeaveSection" public/js/admin/users.js
# Așteptat: ≥ 5 (definiții + utilizări)

# 7.6 — Sintaxă admin/users.js OK
node --check public/js/admin/users.js && echo "admin/users.js OK"
```

---

## FAZA 8 — Run tests + commit + push

```bash
npm test
# Așteptat: toate verzi

git add public/setari.html \
        public/css/setari/setari.css \
        public/js/setari/setari.js \
        public/admin.html \
        public/js/admin/users.js \
        server/index.mjs

# Adaugă și public/js/df-shell.js dacă a fost modificat la Faza 5

git commit -m "feat(ui): BLOC 4.2 — UI setări concediu/delegare

Componente noi:
- public/setari.html — pagină dedicată pentru user (pattern shell standard)
- public/css/setari/setari.css — styling card + form + status banner
- public/js/setari/setari.js — load currentLeave, save, clear, populate dropdown delegate
- server/index.mjs — rută clean URL /setari

Admin panel (admin.html + js/admin/users.js):
- Secțiune <details> 'Concediu și delegare' în modalul Editează utilizator
- Status badge dinamic (Nesetat / Activ / Programat / Expirat)
- Funcții adminSaveLeave + adminClearLeave folosesc endpoint-urile
  PUT/DELETE /admin/users/:id/leave din BLOC 4.1
- Apel _loadLeaveSection(userId, orgId) integrat în openEdit

Constrângeri respectate:
- Stil consistent BLOC 3 (df-action-btn primary/danger pentru CTAs)
- Dropdown delegați filtrează: exclude self + cei cu delegat propriu (NO CHAIN)
- Validare client-side (end >= start, delegate required) repetă serverul
- Erori server mapate la mesaje RO (din leaveErrMsg map BLOC 4.1)

Endpoint-uri folosite (toate din BLOC 4.1):
- GET /users (cu obiect 'leave' enriched)
- PUT /api/users/me/leave + DELETE
- PUT /admin/users/:id/leave + DELETE

Următorul pas: BLOC 4.3 — integrare dropdown smart în Flux nou + Șabloane,
plus auto-redirect pentru fluxurile EXISTENTE.
"

git push origin develop
```

---

## REZUMAT BLOC 4.2

**Fișiere noi:** 3
- `public/setari.html`
- `public/css/setari/setari.css`
- `public/js/setari/setari.js`

**Fișiere modificate:** 3
- `server/index.mjs` (+1 rută)
- `public/admin.html` (secțiune <details> în modal edit)
- `public/js/admin/users.js` (3 funcții noi + 1 apel în openEdit)

**Fișiere opțional modificate:** 1
- `public/js/df-shell.js` (link „Setări" în profile dropdown — dacă există dropdown)

**Fișiere STS:** 0

## Test manual recomandat după deploy

### Test 1 — Pagină user `/setari`
1. Login ca user normal
2. Navigează la `https://docflowai-app-staging.up.railway.app/setari`
3. Verifică:
   - Pagina se încarcă cu sidebar standard, nav-item „Setări" activ
   - Card „Concediu și delegare" cu form gol
   - Banner status: "Niciun concediu setat"
   - Dropdown delegate populat cu colegi din aceeași instituție
4. Setează: leave_start = mâine, leave_end = +7 zile, delegat = X
5. Click „Salvează" → verifică:
   - Mesaj verde "Concediu salvat cu succes"
   - Banner devine "Concediu programat: ..."
   - Apare butonul „Anulează concediul"
6. Click „Anulează concediul" → confirm → form se resetează, banner revine la "Niciun concediu setat"

### Test 2 — Validări (testează că serverul respinge corect)
- Setează leave_start = ieri → server respinge cu mesaj "Concediu nu poate fi setat retroactiv"
- Setează leave_end < leave_start → server respinge
- Alege ca delegat un user care are deja propriu delegat → respinge cu "Delegatul ales are deja propriul delegat"

### Test 3 — Admin tab
1. Login ca admin
2. Deschide Admin → Utilizatori → Editează (orice user)
3. Verifică:
   - Apare secțiune nouă „🏖️ Concediu și delegare" (collapsable)
   - Click → expandează cu form similar cu /setari
   - Badge "Nesetat" / "Activ" / "Programat" după caz
4. Setează concediu pentru altul → Salvează → verifică reload listă useri

## Atenție / posibile observații

- **Profile dropdown link** — Faza 5 e opțională. Dacă structura dropdown-ului din `df-shell.js` nu e clară, skip și documentează în commit. User-ul accesează `/setari` direct prin URL deocamdată; BLOC 4.3 va adăuga link contextual.
- **Date pickers pe Safari iOS** — `<input type="date">` are UI nativ pe mobile care diferă de desktop. Comportament acceptabil — nu e nevoie de polyfill.
- **Listă useri reload** — după save/clear, se reîncarcă tot dropdown-ul. La instituții cu 100+ useri ar putea fi vizibil întârzierea (~200ms). Nu e un issue în BLOC 4.2 — dacă devine problematic, optimizare în BLOC 4.3.
- **`<details>` accordion** — comportamentul nativ al browser-ului. Funcționează în toate browserele moderne (Chrome, Firefox, Safari, Edge). NU folosi pe IE 11 (dar oricum nu suportăm IE).

După ce 4.2 e verde 24h pe staging, atac BLOC 4.3 (dropdown smart în Flux nou + Șabloane + auto-redirect).
