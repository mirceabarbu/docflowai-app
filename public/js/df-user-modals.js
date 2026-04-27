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
<div id="changePwdModal" style="display:none;position:fixed;inset:0;
  background:rgba(0,0,0,.6);z-index:1000;align-items:center;
  justify-content:center;">
  <div style="background:var(--df-surface);border:1px solid var(--df-border-2);
    border-radius:12px;padding:24px;width:92%;max-width:420px;
    box-shadow:0 20px 40px rgba(0,0,0,.5);">
    <h3 style="font-size:1.05rem;font-weight:600;color:var(--df-text);
      margin:0 0 14px;">Schimbă parola</h3>
    <label style="display:block;font-size:.75rem;color:var(--df-text-3);
      margin-bottom:4px;">Parola curentă</label>
    <input id="cpCurrent" type="password"
      style="width:100%;padding:9px 11px;margin-bottom:10px;
      background:var(--df-surface-2);border:1px solid var(--df-border-2);
      border-radius:8px;color:var(--df-text);font-size:.88rem;outline:none;"/>
    <label style="display:block;font-size:.75rem;color:var(--df-text-3);
      margin-bottom:4px;">Parola nouă</label>
    <input id="cpNew" type="password"
      style="width:100%;padding:9px 11px;margin-bottom:10px;
      background:var(--df-surface-2);border:1px solid var(--df-border-2);
      border-radius:8px;color:var(--df-text);font-size:.88rem;outline:none;"/>
    <label style="display:block;font-size:.75rem;color:var(--df-text-3);
      margin-bottom:4px;">Confirmă parola nouă</label>
    <input id="cpConfirm" type="password"
      style="width:100%;padding:9px 11px;margin-bottom:14px;
      background:var(--df-surface-2);border:1px solid var(--df-border-2);
      border-radius:8px;color:var(--df-text);font-size:.88rem;outline:none;"/>
    <div id="cpMsg" style="font-size:.8rem;min-height:18px;margin-bottom:10px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button onclick="closeChangePwdModal()"
        style="padding:8px 16px;background:rgba(255,255,255,.06);
        border:1px solid var(--df-border-2);border-radius:8px;
        color:var(--df-text-2);cursor:pointer;font-size:.85rem;">Anulează</button>
      <button id="cpBtn" onclick="submitChangePwd()"
        style="padding:8px 16px;background:var(--df-primary);border:none;
        border-radius:8px;color:#fff;cursor:pointer;font-size:.85rem;
        font-weight:500;">Salvează</button>
    </div>
  </div>
</div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  window.openChangePwdModal = function() {
    injectModal();
    const m = document.getElementById('changePwdModal');
    m.style.display = 'flex';
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
    if (m) m.style.display = 'none';
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
    modal.style.display = 'flex';
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
      setTimeout(() => { closeLeaveModal(); }, 800);
    } catch (e) {
      msg.style.color = '#f28b82'; msg.textContent = 'Eroare de rețea.';
      btn.disabled = false;
    }
  };

})();
