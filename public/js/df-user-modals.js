/**
 * DocFlowAI — df-user-modals.js
 * Injectează modalul "Schimbă parola" în <body> la DOMContentLoaded
 * și expune window.openChangePwdModal() + closeChangePwdModal() +
 * submitChangePwd(). Folosit pe paginile cu df-shell, EXCEPȚIE admin.html
 * (are propriul său modal în admin.js).
 */
(function() {
  function injectModal() {
    if (document.getElementById('changePwdModal')) return;
    const html = `
<div id="changePwdModal" class="df-modal-bg" style="z-index:1000;">
  <div class="df-modal" style="max-width:420px;">
    <h3>Schimbă parola</h3>
    <div class="df-frow">
      <label>Parola curentă</label>
      <input id="cpCurrent" type="password"/>
    </div>
    <div class="df-frow">
      <label>Parola nouă</label>
      <input id="cpNew" type="password"/>
    </div>
    <div class="df-frow">
      <label>Confirmă parola nouă</label>
      <input id="cpConfirm" type="password"/>
    </div>
    <div id="cpMsg" class="df-msg" style="margin-top:8px;"></div>
    <div class="df-modal-acts">
      <button class="df-action-btn" onclick="closeChangePwdModal()">Anulează</button>
      <button id="cpBtn" class="df-action-btn primary" onclick="submitChangePwd()">Salvează</button>
    </div>
  </div>
</div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  window.openChangePwdModal = function() {
    injectModal();
    const m = document.getElementById('changePwdModal');
    m.classList.add('open');
    document.getElementById('cpCurrent').value = '';
    document.getElementById('cpNew').value = '';
    document.getElementById('cpConfirm').value = '';
    const msg = document.getElementById('cpMsg');
    msg.textContent = ''; msg.style.color = '';
    const btn = document.getElementById('cpBtn');
    btn.disabled = false; btn.textContent = 'Salvează';
    document.getElementById('cpCurrent').focus();
  };

  window.closeChangePwdModal = function() {
    const m = document.getElementById('changePwdModal');
    if (m) m.classList.remove('open');
  };

  window.submitChangePwd = async function() {
    const cur = document.getElementById('cpCurrent').value;
    const nw = document.getElementById('cpNew').value;
    const cf = document.getElementById('cpConfirm').value;
    const msg = document.getElementById('cpMsg');
    const btn = document.getElementById('cpBtn');
    if (!cur || !nw || !cf) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Completează toate câmpurile.';
      return;
    }
    if (nw !== cf) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Parolele noi nu coincid.';
      return;
    }
    if (nw.length < 6) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Parola trebuie să aibă minim 6 caractere.';
      return;
    }
    btn.disabled = true; btn.textContent = 'Se salvează...';
    try {
      const headers = { 'Content-Type': 'application/json' };
      const csrfCookie = document.cookie.split('; ')
        .find(function(r) { return r.startsWith('csrf_token='); });
      if (csrfCookie) headers['x-csrf-token'] = csrfCookie.split('=')[1];
      const r = await fetch('/auth/change-password', {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({ current_password: cur, new_password: nw })
      });
      const d = await r.json();
      if (r.ok) {
        msg.style.color = '#34A853';
        msg.textContent = '✅ Parola schimbată cu succes!';
        localStorage.removeItem('docflow_force_pwd');
        setTimeout(window.closeChangePwdModal, 1800);
      } else {
        msg.style.color = '#f28b82';
        msg.textContent = d.message ||
          (d.error === 'wrong_password' ? 'Parola curentă incorectă.' : 'Eroare.');
        btn.disabled = false; btn.textContent = 'Salvează';
      }
    } catch(e) {
      msg.style.color = '#f28b82';
      msg.textContent = 'Eroare de rețea.';
      btn.disabled = false; btn.textContent = 'Salvează';
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // MODAL CONCEDIU ȘI DELEGARE (BLOC 4.2)
  // Pattern identic cu openChangePwdModal — inline-styles consistente.
  // ════════════════════════════════════════════════════════════════════════

  function injectLeaveModal() {
    if (document.getElementById('leaveModal')) return;
    const html = `
<div id="leaveModal" class="df-modal-bg" style="z-index:1000;">
  <div class="df-modal" style="max-width:520px;">
    <h3 style="margin:0 0 6px;">🏖️ Concediu și delegare</h3>
    <p style="font-size:.78rem;color:var(--df-text-3);margin:0 0 16px;
      line-height:1.5;">În perioada de concediu, fluxurile noi pe care trebuie
      să le semnezi vor fi atribuite automat delegatului ales.</p>

    <div id="lvStatus" style="font-size:.82rem;padding:9px 12px;border-radius:8px;
      margin-bottom:14px;background:rgba(255,255,255,.04);
      border:1px solid var(--df-border-2);color:var(--df-text-3);
      font-weight:500;">Niciun concediu setat.</div>

    <div class="df-grid-2" style="margin-bottom:10px;">
      <div class="df-frow">
        <label>Început concediu *</label>
        <input id="lvStart" type="date" lang="ro" style="color-scheme:dark;"/>
      </div>
      <div class="df-frow">
        <label>Sfârșit concediu *</label>
        <input id="lvEnd" type="date" lang="ro" style="color-scheme:dark;"/>
      </div>
    </div>

    <div class="df-frow" style="margin-bottom:4px;">
      <label>Delegat (cine semnează în lipsa ta) *</label>
      <select id="lvDelegate">
        <option value="">— Alege delegat —</option>
      </select>
    </div>
    <small style="display:block;font-size:.72rem;color:var(--df-text-4);
      margin-bottom:12px;">Doar utilizatori din aceeași instituție.
      Persoanele cu propriul delegat nu apar (lanțuri de delegare interzise).</small>

    <div class="df-frow" style="margin-bottom:4px;">
      <label>Motiv (opțional)</label>
      <textarea id="lvReason" rows="2" maxlength="500"
        placeholder="Ex: Concediu de odihnă, formare profesională..."
        style="resize:vertical;line-height:1.5;"></textarea>
    </div>
    <small style="display:block;font-size:.72rem;color:var(--df-text-4);
      margin-bottom:12px;"><span id="lvReasonCount">0</span>/500 caractere</small>

    <div id="lvMsg" class="df-msg" style="margin-top:8px;"></div>

    <div class="df-modal-acts">
      <button class="df-action-btn" onclick="closeLeaveModal()">Închide</button>
      <button id="lvBtnClear" class="df-action-btn danger" onclick="submitClearLeave()" style="display:none;">Anulează concediul</button>
      <button id="lvBtnSave" class="df-action-btn primary" onclick="submitSaveLeave()">Salvează</button>
    </div>
  </div>
</div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    const startEl = document.getElementById('lvStart');
    const endEl = document.getElementById('lvEnd');
    startEl.addEventListener('change', () => {
      if (endEl.value && endEl.value < startEl.value) endEl.value = startEl.value;
      endEl.min = startEl.value;
    });
    const reasonEl = document.getElementById('lvReason');
    const countEl = document.getElementById('lvReasonCount');
    reasonEl.addEventListener('input', () => { countEl.textContent = reasonEl.value.length; });
    document.getElementById('leaveModal').addEventListener('click', function(e) {
      if (e.target === this) closeLeaveModal();
    });
  }

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
    const modal = document.getElementById('leaveModal');
    modal.classList.add('open');
    document.getElementById('lvStart').value = '';
    document.getElementById('lvEnd').value = '';
    document.getElementById('lvReason').value = '';
    document.getElementById('lvReasonCount').textContent = '0';
    document.getElementById('lvMsg').textContent = '';
    document.getElementById('lvMsg').style.color = '';
    document.getElementById('lvBtnClear').style.display = 'none';
    document.getElementById('lvBtnSave').disabled = false;

    await _lvLoadUsers();
    const sel = document.getElementById('lvDelegate');
    while (sel.options.length > 1) sel.remove(1);
    if (_lvAllUsers && _lvMeUserId) {
      const me = _lvAllUsers.find(u => u.id === _lvMeUserId);
      const candidates = _lvAllUsers.filter(u => {
        if (u.id === _lvMeUserId) return false;
        if (u.org_id !== me?.org_id) return false;
        if (u.leave?.delegate) return false;
        return true;
      });
      candidates.sort((a, b) => (a.nume || '').localeCompare(b.nume || '', 'ro'));
      candidates.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
        sel.appendChild(opt);
      });

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
      }
    }
  };

  window.closeLeaveModal = function() {
    const m = document.getElementById('leaveModal');
    if (m) m.classList.remove('open');
  };

  window.submitSaveLeave = async function() {
    const msg = document.getElementById('lvMsg');
    msg.textContent = ''; msg.style.color = '';

    const leave_start = document.getElementById('lvStart').value || null;
    const leave_end = document.getElementById('lvEnd').value || null;
    const delegate_user_id = document.getElementById('lvDelegate').value || null;
    const leave_reason = document.getElementById('lvReason').value.trim() || null;

    if (!leave_start || !leave_end) {
      msg.style.color = '#f28b82'; msg.textContent = 'Datele de început și sfârșit sunt obligatorii.'; return;
    }
    if (leave_end < leave_start) {
      msg.style.color = '#f28b82'; msg.textContent = 'Data sfârșit nu poate fi înainte de data început.'; return;
    }
    if (!delegate_user_id) {
      msg.style.color = '#f28b82'; msg.textContent = 'Alege un delegat.'; return;
    }

    const btn = document.getElementById('lvBtnSave');
    btn.disabled = true; btn.textContent = 'Se salvează...';
    try {
      const headers = { 'Content-Type': 'application/json' };
      const csrfCookie = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
      if (csrfCookie) headers['x-csrf-token'] = csrfCookie.split('=')[1];

      const r = await fetch('/api/users/me/leave', {
        method: 'PUT', credentials: 'include', headers,
        body: JSON.stringify({ leave_start, leave_end, delegate_user_id: Number(delegate_user_id), leave_reason }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.style.color = '#f28b82'; msg.textContent = data.message || data.error || 'Eroare la salvare.'; return;
      }
      msg.style.color = '#4ade80'; msg.textContent = 'Concediu salvat cu succes.';
      _lvAllUsers = null;
      // BLOC 4.3 fix: re-fetch _dbUsers în semdoc-initiator ca dropdown să reflecte noua stare
      if (typeof window._refreshDbUsers === 'function') window._refreshDbUsers();
      setTimeout(() => { window.openLeaveModal(); }, 1200);
    } catch (e) {
      msg.style.color = '#f28b82'; msg.textContent = 'Eroare de rețea. Încearcă din nou.';
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
      const csrfCookie = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
      if (csrfCookie) headers['x-csrf-token'] = csrfCookie.split('=')[1];

      const r = await fetch('/api/users/me/leave', { method: 'DELETE', credentials: 'include', headers });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.style.color = '#f28b82'; msg.textContent = data.message || data.error || 'Eroare la anulare.';
        btn.disabled = false; return;
      }
      msg.style.color = '#4ade80'; msg.textContent = 'Concediu anulat.';
      _lvAllUsers = null;
      // BLOC 4.3 fix: re-fetch _dbUsers
      if (typeof window._refreshDbUsers === 'function') window._refreshDbUsers();
      setTimeout(() => { closeLeaveModal(); }, 800);
    } catch (e) {
      msg.style.color = '#f28b82'; msg.textContent = 'Eroare de rețea.';
      btn.disabled = false;
    }
  };

})();
