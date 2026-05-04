# PROMPT — BLOC 4.2 FIX (refactor stiluri concediu/delegare)

## CONTEXT

DocFlowAI v3.9.379+. BLOC 4.2 a fost mergeat dar are **inconsistență vizuală majoră**:
1. Pagina `/setari` folosește CSS custom (`.setari-input`, `.setari-card`) în loc de pattern-urile native (`.frow + label + input`, `.modal`)
2. Secțiunea din modalul „Editează utilizator" (admin.html) folosește un `<details>` accordion cu inline-styles, în loc de aceleași `.frow` ca restul form-ului

**Decizii agreate cu user:**
- **Strategia hibrid**: păstrăm pagina `/setari` ca placeholder pentru viitor (alte setări), DAR feature-ul concediu se mută în **modal accesibil din dropdown user-menu** (top-right) — disponibil de pe orice pagină
- **Refactor design system** (`.frow/.modal/.modal-bg/.modal-acts` mutate global) → **AMÂNAT pentru BLOC 5**. Acum doar copy-paste minimal-invasive (refolosim pattern-ul EXACT din `openChangePwdModal` care are inline-styles consistente cu modal-ul nativ admin)
- **Secțiunea admin** (modal Editează utilizator): **eliminăm `<details>` accordion** și o transformăm în secțiune permanent vizibilă cu structură `.frow` ca restul form-ului

## ⛔ CONSTRÂNGERI ABSOLUTE

1. NU atinge zona STS
2. NU atinge `df-apifetch-shim*.js`, `admin/core.js`
3. NU atinge backend (e deja făcut în 4.1, funcționează corect)
4. NU atinge alte modale existente (Schimbă parola, etc.) — refolosim doar pattern-ul lor
5. NU adăuga reguli CSS noi în `components.css` (refactor-ul global vine în BLOC 5) — folosim inline-styles ca `openChangePwdModal`
6. `npm test` verde

## SCHEMA REFACTOR

### Componenta 1 — Modal nou `openLeaveModal()` în `df-user-modals.js`

Pattern: **identic** cu `openChangePwdModal` (inline-styles, injectat la prima deschidere). Conține:
- Status banner (Niciun concediu / Activ / Programat / Expirat)
- 2 date pickeri (start, end)
- Dropdown delegate
- Textarea reason (max 500)
- 2 butoane: Salvează + Anulează concediul (doar dacă există)

### Componenta 2 — Item nou „Concediu și delegare" în dropdown user-menu

În toate paginile cu df-user-menu **EXCEPT admin.html** (admin are propria sa secțiune în modal Editează):
- `notifications.html`, `templates.html`, `formular.html`, `semdoc-initiator.html`, `semdoc-signer.html`, `flow.html`, `bulk-signer.html`, `notafd-invest-form.html`

### Componenta 3 — Pagină `/setari` simplificată (placeholder pentru viitor)

În loc de UI complex (deja făcut greșit), reducem la un placeholder simplu cu un singur card „În curând: alte setări" + un buton de shortcut spre modal-ul de concediu.

### Componenta 4 — Secțiunea admin (modal Editează utilizator)

Elimin `<details>` + inline-styles. Structură nouă:
- Separator orizontal
- Titlu „Concediu și delegare" (consistent cu restul form-ului)
- Grid cu `.frow` pentru date + delegate + motiv
- Status badge păstrat
- Butoane folosesc `.df-action-btn` ca în restul modalului

---

## FAZA 0 — Pre-checks

```bash
# 0.1 — Confirm BLOC 4.2 e merged și fișierele există
ls public/setari.html public/css/setari/setari.css public/js/setari/setari.js
# Așteptat: toate prezente

grep -c "id=\"eLeaveSection\"" public/admin.html
# Așteptat: 1 (secțiunea <details> existentă, va fi refăcută)

# 0.2 — Versiune curentă
grep '"version"' package.json
# Notează ca <VER>

# 0.3 — Confirm pagini cu df-user-menu (8 fișiere, exclud admin.html)
grep -rln 'id="df-user-menu"' public/*.html | grep -v admin.html
# Așteptat: 8 fișiere

# 0.4 — Confirm pattern openChangePwdModal (modelul nostru)
grep -n "function openChangePwdModal\|window.openChangePwdModal" public/js/df-user-modals.js | head -3
# Așteptat: 1 definiție window.openChangePwdModal

# 0.5 — Endpoint-urile backend funcționale (BLOC 4.1)
curl -sS https://docflowai-app-staging.up.railway.app/health | head -c 50
# Așteptat: {"ok":true,...}
```

---

## FAZA 1 — Adaugă modal `openLeaveModal()` în `public/js/df-user-modals.js`

**Locație:** la sfârșitul fișierului, ÎNAINTE de `})();` (linia ~122).

**Caută** linia `})();` la final și inserează **ÎNAINTE**:

```js

  // ════════════════════════════════════════════════════════════════════════
  // MODAL CONCEDIU ȘI DELEGARE (BLOC 4.2)
  // Pattern identic cu openChangePwdModal — inline-styles consistente.
  // ════════════════════════════════════════════════════════════════════════

  function injectLeaveModal() {
    if (document.getElementById('leaveModal')) return;
    const html = `
<div id="leaveModal" style="display:none;position:fixed;inset:0;
  background:rgba(0,0,0,.6);z-index:1000;align-items:center;
  justify-content:center;">
  <div style="background:var(--df-surface);border:1px solid var(--df-border-2);
    border-radius:12px;padding:24px;width:92%;max-width:520px;
    box-shadow:0 20px 40px rgba(0,0,0,.5);max-height:90vh;overflow-y:auto;">
    <h3 style="font-size:1.05rem;font-weight:600;color:var(--df-text);
      margin:0 0 6px;">🏖️ Concediu și delegare</h3>
    <p style="font-size:.78rem;color:var(--df-text-3);margin:0 0 16px;
      line-height:1.5;">În perioada de concediu, fluxurile noi pe care trebuie
      să le semnezi vor fi atribuite automat delegatului ales.</p>

    <div id="lvStatus" style="font-size:.82rem;padding:9px 12px;border-radius:8px;
      margin-bottom:14px;background:rgba(255,255,255,.04);
      border:1px solid var(--df-border-2);color:var(--df-text-3);
      font-weight:500;">Niciun concediu setat.</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;
      margin-bottom:10px;">
      <div>
        <label style="display:block;font-size:.75rem;color:var(--df-text-3);
          margin-bottom:4px;">Început concediu *</label>
        <input id="lvStart" type="date"
          style="width:100%;padding:9px 11px;background:var(--df-surface-2);
          border:1px solid var(--df-border-2);border-radius:8px;
          color:var(--df-text);font-size:.88rem;outline:none;
          font-family:inherit;box-sizing:border-box;"/>
      </div>
      <div>
        <label style="display:block;font-size:.75rem;color:var(--df-text-3);
          margin-bottom:4px;">Sfârșit concediu *</label>
        <input id="lvEnd" type="date"
          style="width:100%;padding:9px 11px;background:var(--df-surface-2);
          border:1px solid var(--df-border-2);border-radius:8px;
          color:var(--df-text);font-size:.88rem;outline:none;
          font-family:inherit;box-sizing:border-box;"/>
      </div>
    </div>

    <label style="display:block;font-size:.75rem;color:var(--df-text-3);
      margin-bottom:4px;">Delegat (cine semnează în lipsa ta) *</label>
    <select id="lvDelegate"
      style="width:100%;padding:9px 11px;margin-bottom:4px;
      background:var(--df-surface-2);border:1px solid var(--df-border-2);
      border-radius:8px;color:var(--df-text);font-size:.88rem;outline:none;
      font-family:inherit;box-sizing:border-box;">
      <option value="">— Alege delegat —</option>
    </select>
    <small style="display:block;font-size:.72rem;color:var(--df-text-4);
      margin-bottom:12px;">Doar utilizatori din aceeași instituție.
      Persoanele cu propriul delegat nu apar (lanțuri de delegare interzise).</small>

    <label style="display:block;font-size:.75rem;color:var(--df-text-3);
      margin-bottom:4px;">Motiv (opțional)</label>
    <textarea id="lvReason" rows="2" maxlength="500"
      placeholder="Ex: Concediu de odihnă, formare profesională..."
      style="width:100%;padding:9px 11px;margin-bottom:4px;
      background:var(--df-surface-2);border:1px solid var(--df-border-2);
      border-radius:8px;color:var(--df-text);font-size:.88rem;outline:none;
      font-family:inherit;box-sizing:border-box;resize:vertical;
      line-height:1.5;"></textarea>
    <small style="display:block;font-size:.72rem;color:var(--df-text-4);
      margin-bottom:12px;"><span id="lvReasonCount">0</span>/500 caractere</small>

    <div id="lvMsg" style="font-size:.8rem;min-height:18px;margin-bottom:10px;"></div>

    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
      <button onclick="closeLeaveModal()"
        style="padding:8px 16px;background:rgba(255,255,255,.06);
        border:1px solid var(--df-border-2);border-radius:8px;
        color:var(--df-text-2);cursor:pointer;font-size:.85rem;
        font-family:inherit;">Închide</button>
      <button id="lvBtnClear" onclick="submitClearLeave()"
        style="display:none;padding:8px 16px;background:rgba(239,68,68,.15);
        border:1px solid rgba(239,68,68,.3);border-radius:8px;
        color:#fca5a5;cursor:pointer;font-size:.85rem;
        font-family:inherit;font-weight:500;">Anulează concediul</button>
      <button id="lvBtnSave" onclick="submitSaveLeave()"
        style="padding:8px 16px;background:var(--df-primary);border:none;
        border-radius:8px;color:#fff;cursor:pointer;font-size:.85rem;
        font-family:inherit;font-weight:500;">Salvează</button>
    </div>
  </div>
</div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    // Auto: end >= start
    const startEl = document.getElementById('lvStart');
    const endEl = document.getElementById('lvEnd');
    startEl.addEventListener('change', () => {
      if (endEl.value && endEl.value < startEl.value) endEl.value = startEl.value;
      endEl.min = startEl.value;
    });
    // Counter pentru reason
    const reasonEl = document.getElementById('lvReason');
    const countEl = document.getElementById('lvReasonCount');
    reasonEl.addEventListener('input', () => { countEl.textContent = reasonEl.value.length; });
    // Click pe overlay închide
    document.getElementById('leaveModal').addEventListener('click', function(e) {
      if (e.target === this) closeLeaveModal();
    });
  }

  // Cache useri (rezultatul GET /users) — evită 2 fetch-uri la deschidere
  let _lvAllUsers = null;
  let _lvMeUserId = null;

  async function _lvLoadUsers() {
    try {
      const r = await fetch('/users', { credentials: 'include' });
      if (!r.ok) return [];
      _lvAllUsers = await r.json();
      const meEmail = (JSON.parse(localStorage.getItem('docflow_user') || '{}').email || '').toLowerCase();
      const me = _lvAllUsers.find(u => (u.email || '').toLowerCase() === meEmail);
      _lvMeUserId = me?.id || null;
      return _lvAllUsers;
    } catch (e) { return []; }
  }

  function _lvFmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).split('-');
    return `${d}.${m}.${y}`;
  }

  window.openLeaveModal = async function() {
    injectLeaveModal();
    const m = document.getElementById('leaveModal');
    m.style.display = 'flex';
    // Reset
    document.getElementById('lvStart').value = '';
    document.getElementById('lvEnd').value = '';
    document.getElementById('lvReason').value = '';
    document.getElementById('lvReasonCount').textContent = '0';
    document.getElementById('lvMsg').textContent = '';
    document.getElementById('lvMsg').style.color = '';
    document.getElementById('lvBtnClear').style.display = 'none';
    document.getElementById('lvBtnSave').disabled = false;

    // Load useri și pre-fill
    await _lvLoadUsers();
    const sel = document.getElementById('lvDelegate');
    while (sel.options.length > 1) sel.remove(1);
    if (_lvAllUsers && _lvMeUserId) {
      const me = _lvAllUsers.find(u => u.id === _lvMeUserId);
      const candidates = _lvAllUsers.filter(u => {
        if (u.id === _lvMeUserId) return false;       // exclude self
        if (u.org_id !== me?.org_id) return false;    // doar same org
        if (u.leave?.delegate) return false;          // NO CHAIN
        return true;
      });
      candidates.sort((a, b) => (a.nume || '').localeCompare(b.nume || '', 'ro'));
      candidates.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
        sel.appendChild(opt);
      });

      // Pre-fill cu valorile actuale
      const leave = me?.leave;
      if (leave) {
        if (leave.leaveStart) document.getElementById('lvStart').value = leave.leaveStart;
        if (leave.leaveEnd) document.getElementById('lvEnd').value = leave.leaveEnd;
        if (leave.delegate?.id) document.getElementById('lvDelegate').value = leave.delegate.id;
        if (leave.leaveReason) {
          document.getElementById('lvReason').value = leave.leaveReason;
          document.getElementById('lvReasonCount').textContent = leave.leaveReason.length;
        }
        document.getElementById('lvBtnClear').style.display = 'inline-block';

        const today = new Date().toISOString().slice(0, 10);
        const status = document.getElementById('lvStatus');
        if (leave.onLeave) {
          status.textContent = `În concediu până la ${_lvFmtDate(leave.leaveEnd)} · Delegat: ${leave.delegate?.nume || '—'}`;
          status.style.background = 'rgba(255,170,30,.10)';
          status.style.borderColor = 'rgba(255,170,30,.3)';
          status.style.color = '#ffcc44';
        } else if (leave.leaveStart > today) {
          status.textContent = `Concediu programat: ${_lvFmtDate(leave.leaveStart)} → ${_lvFmtDate(leave.leaveEnd)} · Delegat: ${leave.delegate?.nume || '—'}`;
          status.style.background = 'rgba(108,79,240,.10)';
          status.style.borderColor = 'rgba(108,79,240,.3)';
          status.style.color = '#b0a0ff';
        } else {
          status.textContent = `Concediu expirat (${_lvFmtDate(leave.leaveStart)} → ${_lvFmtDate(leave.leaveEnd)}). Setează unul nou sau anulează.`;
          status.style.background = 'rgba(120,120,120,.08)';
          status.style.borderColor = 'var(--df-border-2)';
          status.style.color = 'var(--df-text-4)';
        }
      } else {
        const status = document.getElementById('lvStatus');
        status.textContent = 'Niciun concediu setat.';
        status.style.background = 'rgba(255,255,255,.04)';
        status.style.borderColor = 'var(--df-border-2)';
        status.style.color = 'var(--df-text-3)';
      }
    }
  };

  window.closeLeaveModal = function() {
    const m = document.getElementById('leaveModal');
    if (m) m.style.display = 'none';
  };

  window.submitSaveLeave = async function() {
    const msg = document.getElementById('lvMsg');
    msg.textContent = ''; msg.style.color = '';

    const leave_start = document.getElementById('lvStart').value || null;
    const leave_end = document.getElementById('lvEnd').value || null;
    const delegate_user_id = document.getElementById('lvDelegate').value || null;
    const leave_reason = document.getElementById('lvReason').value.trim() || null;

    if (!leave_start || !leave_end) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Datele de început și sfârșit sunt obligatorii.';
      return;
    }
    if (leave_end < leave_start) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Data sfârșit nu poate fi înainte de data început.';
      return;
    }
    if (!delegate_user_id) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Alege un delegat.';
      return;
    }

    const btn = document.getElementById('lvBtnSave');
    btn.disabled = true; btn.textContent = 'Se salvează...';
    try {
      const headers = { 'Content-Type': 'application/json' };
      const csrfCookie = document.cookie.split('; ')
        .find(r => r.startsWith('csrf_token='));
      if (csrfCookie) headers['x-csrf-token'] = csrfCookie.split('=')[1];

      const r = await fetch('/api/users/me/leave', {
        method: 'PUT',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          leave_start, leave_end,
          delegate_user_id: Number(delegate_user_id),
          leave_reason,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.style.color = '#f28b82';
        msg.textContent = data.message || data.error || 'Eroare la salvare.';
        return;
      }
      msg.style.color = '#4ade80';
      msg.textContent = 'Concediu salvat cu succes.';
      // Re-deschide modal-ul pentru a re-prefill cu datele noi (auto refresh status)
      _lvAllUsers = null; // invalidează cache
      setTimeout(() => { window.openLeaveModal(); }, 1200);
    } catch (e) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Eroare de rețea. Încearcă din nou.';
    } finally {
      btn.disabled = false; btn.textContent = 'Salvează';
    }
  };

  window.submitClearLeave = async function() {
    if (!confirm('Anulezi concediul setat?')) return;
    const msg = document.getElementById('lvMsg');
    msg.textContent = ''; msg.style.color = '';
    const btn = document.getElementById('lvBtnClear');
    btn.disabled = true;
    try {
      const headers = {};
      const csrfCookie = document.cookie.split('; ')
        .find(r => r.startsWith('csrf_token='));
      if (csrfCookie) headers['x-csrf-token'] = csrfCookie.split('=')[1];

      const r = await fetch('/api/users/me/leave', {
        method: 'DELETE', credentials: 'include', headers,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.style.color = '#f28b82';
        msg.textContent = data.message || data.error || 'Eroare la anulare.';
        btn.disabled = false;
        return;
      }
      msg.style.color = '#4ade80';
      msg.textContent = 'Concediu anulat.';
      _lvAllUsers = null;
      setTimeout(() => { closeLeaveModal(); }, 800);
    } catch (e) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Eroare de rețea.';
      btn.disabled = false;
    }
  };
```

**Verificare:**
```bash
grep -c "function openLeaveModal\|window.openLeaveModal" public/js/df-user-modals.js
# Așteptat: 1

node --check public/js/df-user-modals.js && echo "Syntax OK"
```

---

## FAZA 2 — Adaugă item „Concediu și delegare" în dropdown user-menu

**Pagini de modificat (8 fișiere):**
`notifications.html`, `templates.html`, `formular.html`, `semdoc-initiator.html`, `semdoc-signer.html`, `flow.html`, `bulk-signer.html`, `notafd-invest-form.html`

**Strategia:** găsește în fiecare fișier butonul "Schimbă parola" (pattern: `onclick="closeUserMenu();openChangePwdModal()"`) și inserează **ÎNAINTE** un buton nou pentru concediu.

**Pattern de inserat ÎNAINTE de butonul Schimbă parola:**
```html
            <button onclick="closeUserMenu();openLeaveModal()">
              <svg viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-calendar"/></svg>
              Concediu și delegare
            </button>
```

NB: Înlocuiește `<VER>` cu valoarea de la pre-check 0.2.
Verifică în `icons.svg` că există `#ico-calendar`. Dacă nu există, folosește `#ico-clock` sau `#ico-info` ca fallback.

```bash
# Pre-check icon
grep -c 'id="ico-calendar"' public/icons.svg
# Așteptat: 1. Dacă 0 → folosește alt icon (ico-clock, ico-info)
```

**Pentru fiecare din cele 8 fișiere**, caută pattern-ul:
```html
            <button onclick="closeUserMenu();openChangePwdModal()">
              <svg viewBox="0 0 24 24"><use href="/icons.svg?v=<OLD_VER>#ico-key"/></svg>
              Schimbă parola
            </button>
```

Și înlocuiește cu:
```html
            <button onclick="closeUserMenu();openLeaveModal()">
              <svg viewBox="0 0 24 24"><use href="/icons.svg?v=<OLD_VER>#ico-calendar"/></svg>
              Concediu și delegare
            </button>
            <button onclick="closeUserMenu();openChangePwdModal()">
              <svg viewBox="0 0 24 24"><use href="/icons.svg?v=<OLD_VER>#ico-key"/></svg>
              Schimbă parola
            </button>
```

NB: păstrează `<OLD_VER>` exact cum e în fiecare fișier (poate diferi între pagini — `3.9.333`, `3.9.343`, etc — folosește exact ce găsești).

**Verificare:**
```bash
grep -c "openLeaveModal()" public/notifications.html public/templates.html \
  public/formular.html public/semdoc-initiator.html public/semdoc-signer.html \
  public/flow.html public/bulk-signer.html public/notafd-invest-form.html
# Așteptat: 8 linii cu count: 1
```

---

## FAZA 3 — Refactorizare secțiunea admin (modal Editează utilizator)

**Fișier:** `public/admin.html`

### 3.1 — Înlocuiește secțiunea `<details>` cu structură nativă

**Caută** blocul existent (în jur de linia 1283):
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

NB: în zip-ul tău `<VER>` poate fi `3.9.379` sau alt — folosește exact ce e în fișier.

**Înlocuiește cu** (structură nativă, fără accordion, cu separator vizual):
```html
    <!-- Concediu și delegare (BLOC 4.2 fix — structură nativă) -->
    <hr style="border:none;border-top:1px solid var(--df-border);margin:18px 0 14px;"/>
    <h4 style="font-size:.82rem;font-weight:700;color:var(--sub);margin-bottom:12px;letter-spacing:.04em;text-transform:uppercase;">
      Concediu și delegare
      <span id="eLeaveStatusBadge" style="margin-left:8px;font-size:.66rem;font-weight:500;padding:2px 8px;border-radius:12px;background:rgba(120,120,120,.15);color:var(--df-text-3);text-transform:none;letter-spacing:0;">Nesetat</span>
    </h4>
    <div class="grid2">
      <div class="frow"><label>Început concediu</label><input type="date" id="eLeaveStart"/></div>
      <div class="frow"><label>Sfârșit concediu</label><input type="date" id="eLeaveEnd"/></div>
    </div>
    <div class="frow" style="margin-top:12px;">
      <label>Delegat (cine semnează în lipsă)</label>
      <select id="eLeaveDelegate"><option value="">— Niciun delegat —</option></select>
    </div>
    <div class="frow" style="margin-top:12px;">
      <label>Motiv (opțional)</label>
      <textarea id="eLeaveReason" rows="2" maxlength="500" placeholder="Ex: Concediu de odihnă" style="width:100%;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:10px;color:var(--text);font-size:.88rem;outline:none;font-family:inherit;resize:vertical;line-height:1.5;box-sizing:border-box;"></textarea>
    </div>
    <div id="eLeaveMsg" style="margin-top:8px;font-size:.8rem;min-height:18px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
      <button type="button" class="df-action-btn danger sm" onclick="adminClearLeave()">
        <svg class="df-ic"><use href="/icons.svg?v=<VER>#ico-x"/></svg>
        Anulează concediul
      </button>
      <button type="button" class="df-action-btn primary sm" onclick="adminSaveLeave()">
        <svg class="df-ic"><use href="/icons.svg?v=<VER>#ico-save"/></svg>
        Salvează concediu
      </button>
    </div>
```

NB: Folosesc `.grid2` (există deja în admin.css linia 14) pentru row-ul cu 2 date pickeri. Textarea primește inline-styles pentru că `textarea` generic nu e stilat global în admin.css (doar `input,select` sunt — verifică cu `grep -n "^\s*textarea" public/css/admin/admin.css`).

**Verificare:**
```bash
grep -c "id=\"eLeaveSection\"" public/admin.html
# Așteptat: 0 (eliminat)

grep -c "id=\"eLeaveStart\"" public/admin.html
# Așteptat: 1 (păstrat în noua structură)
```

### 3.2 — Logica JS în `admin/users.js` rămâne neschimbată

Funcțiile `adminSaveLeave`, `adminClearLeave`, `_loadLeaveSection` operează pe ID-urile elementelor (`eLeaveStart`, `eLeaveEnd`, etc.), care rămân identice. **NU trebuie modificat nimic în users.js.**

**Verificare:**
```bash
grep -c "_loadLeaveSection\|adminSaveLeave\|adminClearLeave" public/js/admin/users.js
# Așteptat: ≥ 5 (păstrat)
```

---

## FAZA 4 — Simplificare pagină `/setari` (placeholder pentru viitor)

**Fișier:** `public/setari.html`

**Înlocuiește complet conținutul** cu:

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
  </aside>

  <main class="df-main">
    <header class="df-page-header">
      <div>
        <h1 class="df-page-title">Setări</h1>
        <p class="df-page-subtitle">Preferințe cont și opțiuni personale</p>
      </div>
    </header>

    <section class="df-page-body">
      <!-- Card concediu — shortcut spre modal -->
      <div style="background:var(--df-surface);border:1px solid var(--df-border);border-radius:var(--df-radius-xl);padding:24px;max-width:560px;margin-bottom:16px;">
        <h3 style="font-size:1rem;font-weight:600;color:var(--df-text);margin-bottom:6px;">Concediu și delegare</h3>
        <p style="font-size:.84rem;color:var(--df-text-3);margin-bottom:16px;line-height:1.5;">
          Marchează perioada în care nu vei fi disponibil. Fluxurile noi pe care trebuie să le semnezi vor fi atribuite automat delegatului ales.
        </p>
        <button class="df-action-btn primary" onclick="openLeaveModal()">
          <svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=<VER>#ico-calendar"/></svg>
          Configurează concediu
        </button>
      </div>

      <!-- Card placeholder pentru viitor -->
      <div style="background:var(--df-surface);border:1px dashed var(--df-border-2);border-radius:var(--df-radius-xl);padding:24px;max-width:560px;opacity:.7;">
        <h3 style="font-size:1rem;font-weight:600;color:var(--df-text-2);margin-bottom:6px;">În curând: alte setări</h3>
        <p style="font-size:.84rem;color:var(--df-text-4);line-height:1.5;">
          Aici vor fi disponibile preferințe pentru notificări, temă, limbă și alte opțiuni personale.
        </p>
      </div>
    </section>
  </main>
</div>

</body>
</html>
```

NB: dacă `#ico-calendar` nu există (verifică la pre-check), înlocuiește în butonul „Configurează concediu" cu `#ico-clock` sau `#ico-info`.

---

## FAZA 5 — Cleanup fișiere greșite

```bash
# Șterge CSS-ul greșit + JS-ul greșit (le-am înlocuit cu modal în df-user-modals.js)
rm public/css/setari/setari.css
rm public/js/setari/setari.js

# Șterge directoarele goale (dacă au rămas goale după rm)
rmdir public/css/setari 2>/dev/null
rmdir public/js/setari 2>/dev/null
```

---

## FAZA 6 — Verificări finale

```bash
# 6.1 — Modal nou prezent în df-user-modals.js
grep -c "window.openLeaveModal" public/js/df-user-modals.js
# Așteptat: 1

grep -c "window.submitSaveLeave\|window.submitClearLeave" public/js/df-user-modals.js
# Așteptat: 2

# 6.2 — Item dropdown în 8 pagini (NU admin.html)
for f in notifications templates formular semdoc-initiator semdoc-signer flow bulk-signer notafd-invest-form; do
  cnt=$(grep -c "openLeaveModal()" public/$f.html 2>/dev/null)
  echo "$f.html: $cnt"
done
# Așteptat: fiecare = 1

# 6.3 — admin.html nu mai are <details>
grep -c "id=\"eLeaveSection\"" public/admin.html
# Așteptat: 0

grep -c "id=\"eLeaveStart\"" public/admin.html
# Așteptat: 1 (păstrat în noua structură)

# 6.4 — Fișierele greșite șterse
ls public/css/setari/ 2>/dev/null
ls public/js/setari/ 2>/dev/null
# Așteptat: NIMIC sau "No such file or directory"

# 6.5 — setari.html simplificat
grep -c "openLeaveModal()" public/setari.html
# Așteptat: 1 (butonul shortcut)

grep -c "setari-card\|setari-input\|setari-field" public/setari.html
# Așteptat: 0 (clasele vechi eliminate complet)

# 6.6 — Sintaxă JS OK
node --check public/js/df-user-modals.js && echo "df-user-modals OK"
node --check public/js/admin/users.js && echo "admin/users OK"
```

---

## FAZA 7 — Run tests + commit + push

```bash
npm test
# Așteptat: toate verzi

git add public/js/df-user-modals.js \
        public/setari.html \
        public/admin.html \
        public/notifications.html \
        public/templates.html \
        public/formular.html \
        public/semdoc-initiator.html \
        public/semdoc-signer.html \
        public/flow.html \
        public/bulk-signer.html \
        public/notafd-invest-form.html

# Șterge fișierele removed din git
git rm public/css/setari/setari.css public/js/setari/setari.js 2>/dev/null

git commit -m "fix(ui): BLOC 4.2 fix — modal concediu unified style + admin nativ

Refactorizare BLOC 4.2 pentru consistență vizuală:

Probleme rezolvate:
1. Pagina /setari avea CSS custom (.setari-input, .setari-card) inconsistent
   cu pattern-ul restului aplicației (.frow + label + input native).
2. Secțiunea concediu din admin.html folosea <details> accordion cu inline-
   styles, separată vizual de restul form-ului Editează utilizator.

Decizia de design (hibrid):
- Feature concediu mutat în MODAL accesibil din dropdown user-menu
  (top-right) — disponibil de pe orice pagină
- Pagina /setari păstrată ca placeholder pentru viitor (alte setări)
  cu shortcut spre modal-ul de concediu
- Refactor design system (.frow/.modal global) AMÂNAT pentru BLOC 5

Modificări:

df-user-modals.js (NEW openLeaveModal):
- Pattern identic cu openChangePwdModal (inline-styles consistente)
- Status banner dinamic (Nesetat / Activ / Programat / Expirat)
- Date pickeri + dropdown delegate + textarea reason
- Dropdown filtrează: exclude self + cei cu delegat propriu (NO CHAIN)
- Salvează → reload modal cu noile valori; Anulează → confirm + close
- CSRF din cookie; folosește endpoint-urile BLOC 4.1

8 pagini cu df-user-menu primesc item nou 'Concediu și delegare' deasupra
'Schimbă parola': notifications, templates, formular, semdoc-initiator,
semdoc-signer, flow, bulk-signer, notafd-invest-form. Admin.html exclus
(are propria secțiune în modal Editează utilizator).

admin.html (modal Editează utilizator):
- Eliminat <details> accordion + inline-styles custom
- Înlocuit cu structură nativă: <hr> separator + <h4> + .grid2 + .frow
- Status badge păstrat (Nesetat/Activ/Programat/Expirat)
- Butoane folosesc df-action-btn primary/danger ca în restul modalului
- ID-urile elementelor (eLeaveStart, etc.) PĂSTRATE — admin/users.js
  funcționează fără modificări

setari.html simplificat:
- Eliminat tot conținutul custom (form duplicat)
- Înlocuit cu: card shortcut 'Configurează concediu' + card placeholder
  'În curând: alte setări'
- Folosește doar style-uri inline (consistent cu pattern admin/templates)

Cleanup:
- Șterse: public/css/setari/setari.css, public/js/setari/setari.js
- Directoare goale removed

Constrângeri respectate:
- Backend BLOC 4.1 NEMODIFICAT (funcționează corect)
- admin/users.js NEMODIFICAT (operează pe ID-urile păstrate)
- Zero atingeri zona STS
- Zero reguli noi în components.css (refactor global = BLOC 5)
"

git push origin develop
```

---

## REZUMAT BLOC 4.2 fix

**Fișiere modificate:** 11 (1 JS shared + 1 admin.html + 8 pagini cu user-menu + 1 setari.html)
**Fișiere șterse:** 2 (`setari.css`, `setari.js`)
**Fișiere atinse STS:** 0

## Test manual recomandat după deploy

### Test 1 — Modal accesibil de oriunde
1. Login ca user normal pe `/notifications` (sau orice altă pagină)
2. Click pe avatar/nume (top-right) → dropdown se deschide
3. **Verifică:** apare item nou „📅 Concediu și delegare" deasupra „Schimbă parola"
4. Click pe el → modal se deschide
5. **Verifică:** stilul modal-ului e identic cu „Schimbă parola" (font, padding, butoane)
6. Setează concediu → salvează → status banner devine „Concediu programat..."
7. Re-deschide modal → datele sunt pre-completate
8. Click „Anulează concediul" → confirm → modal se închide → re-deschide → form gol

### Test 2 — Admin nativ
1. Login ca admin → Utilizatori → Editează (orice user)
2. Scroll în modal — sub câmpurile de notificări preferate
3. **Verifică:** apare separator + titlu „CONCEDIU ȘI DELEGARE" + badge status
4. **Verifică:** stilul e identic cu restul form-ului (input-uri identice cu Prenume/Email)
5. Setează concediu → Salvează concediu → mesaj verde
6. Reîncarcă modal (ESC + click Edit din nou) → datele apar pre-completate

### Test 3 — Pagina /setari
1. Navigează la `/setari`
2. **Verifică:** 2 carduri (Concediu + Placeholder) cu stil consistent
3. Click „Configurează concediu" → deschide același modal ca din dropdown

### Test 4 — Validări (server respinge corect)
- Setează leave_start = ieri → server respinge cu mesaj
- Setează leave_end < leave_start → blocat client + server
- Alege delegat care are propriu delegat → server respinge cu „Delegatul ales are propriul delegat"

## TODO post-merge (notez pentru BLOC 5)

**BLOC 5 — Consolidare design system** (după BLOC 4.3):
- Mut `.frow + label + input + select`, `.modal-bg + .modal + .modal-acts`, `.grid2 + .grid3` din `admin.css` și `templates.css` în `components.css` cu prefix `df-` (ex: `df-frow`, `df-modal`)
- Refac `admin.html` (24 ocurențe `.frow`), `templates.html` (1× modal), modalele inline din `df-user-modals.js` (Schimbă parola, Concediu) să folosească noile clase
- Beneficii: 1 source of truth, no duplication, ușor de extins în pagini noi (gen `setari.html` viitor)
- Risc: scope mare (~12 fișiere atinse), test vizual atent pe admin (modal STS, Webhook, etc.)
- Estimare: ~60 min Claude Code, sesiune dedicată

Adaugă în CLAUDE.md o notiță scurtă în secțiunea „Roadmap" sau „Known refactors":
```
## BLOC 5 — Consolidare design system (TODO)
Mut .frow/.modal/.modal-bg/.modal-acts/.grid2 din admin.css + templates.css
în components.css cu prefix df-. Eliminare duplicate (definiții ușor diferite
în 2 fișiere). Refac toate paginile să folosească pattern-ul global.
```

După 4.2 fix verde 24h pe staging, atac BLOC 4.3 (dropdown smart în Flux nou + Șabloane).
