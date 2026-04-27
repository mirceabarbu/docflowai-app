(function() {
  let _allUsers = [];
  let _meUserId = null;
  let _meEmail = null;

  // ── Init ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async function() {
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
    var reasonEl = document.getElementById('leaveReason');
    var countEl = document.getElementById('reasonCount');
    if (reasonEl && countEl) {
      reasonEl.addEventListener('input', function() {
        countEl.textContent = reasonEl.value.length;
      });
    }
    var startEl = document.getElementById('leaveStart');
    var endEl = document.getElementById('leaveEnd');
    if (startEl && endEl) {
      startEl.addEventListener('change', function() {
        if (endEl.value && endEl.value < startEl.value) {
          endEl.value = startEl.value;
        }
        endEl.min = startEl.value;
      });
    }
  }

  // ── API: încarcă useri (pentru dropdown delegați) ──────────────────────────
  async function loadUsers() {
    var r = await _apiFetch('/users');
    if (!r.ok) throw new Error('users_fetch_failed');
    _allUsers = await r.json();

    if (_meEmail) {
      var me = _allUsers.find(function(u) {
        return u.email && u.email.toLowerCase() === _meEmail.toLowerCase();
      });
      _meUserId = me ? me.id : null;
    }

    var sel = document.getElementById('leaveDelegate');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);

    var candidates = _allUsers.filter(function(u) {
      if (u.id === _meUserId) return false;
      if (u.leave && u.leave.delegate) return false; // NO CHAIN
      return true;
    });

    candidates.sort(function(a, b) {
      return (a.nume || '').localeCompare(b.nume || '', 'ro');
    });
    candidates.forEach(function(u) {
      var opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
      sel.appendChild(opt);
    });
  }

  // ── API: încarcă concediul curent al userului ──────────────────────────────
  async function loadCurrentLeave() {
    if (!_meUserId) return;
    var me = _allUsers.find(function(u) { return u.id === _meUserId; });
    if (!me || !me.leave) {
      updateStatusBanner('none');
      return;
    }
    var leave = me.leave;
    var leaveStart = leave.leaveStart;
    var leaveEnd = leave.leaveEnd;
    var leaveReason = leave.leaveReason;
    var delegate = leave.delegate;
    var onLeave = leave.onLeave;

    if (leaveStart) document.getElementById('leaveStart').value = leaveStart;
    if (leaveEnd) document.getElementById('leaveEnd').value = leaveEnd;
    if (delegate && delegate.id) document.getElementById('leaveDelegate').value = delegate.id;
    if (leaveReason) {
      document.getElementById('leaveReason').value = leaveReason;
      document.getElementById('reasonCount').textContent = leaveReason.length;
    }

    var today = new Date().toISOString().slice(0, 10);
    if (onLeave) {
      updateStatusBanner('active', 'În concediu până la ' + _fmtDate(leaveEnd) + '. Delegat: ' + (delegate ? delegate.nume : '—') + '.');
    } else if (leaveStart > today) {
      updateStatusBanner('scheduled', 'Concediu programat: ' + _fmtDate(leaveStart) + ' → ' + _fmtDate(leaveEnd) + '. Delegat: ' + (delegate ? delegate.nume : '—') + '.');
    } else {
      updateStatusBanner('expired', 'Concediu expirat (' + _fmtDate(leaveStart) + ' → ' + _fmtDate(leaveEnd) + '). Setează unul nou sau anulează.');
    }

    document.getElementById('btnClearLeave').style.display = 'inline-flex';
  }

  function updateStatusBanner(kind, text) {
    var banner = document.getElementById('leaveStatusBanner');
    var txt = document.getElementById('leaveStatusText');
    if (!banner || !txt) return;
    banner.className = 'setari-status setari-status-' + kind;
    txt.textContent = (kind === 'none') ? 'Niciun concediu setat.' : (text || '');
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  window.saveLeave = async function() {
    showMsg('', '');
    var leave_start = document.getElementById('leaveStart').value || null;
    var leave_end = document.getElementById('leaveEnd').value || null;
    var delegate_user_id = document.getElementById('leaveDelegate').value || null;
    var leave_reason = document.getElementById('leaveReason').value.trim() || null;

    if (!leave_start || !leave_end) {
      return showMsg('err', 'Datele de început și sfârșit sunt obligatorii.');
    }
    if (leave_end < leave_start) {
      return showMsg('err', 'Data sfârșit nu poate fi înainte de data început.');
    }
    if (!delegate_user_id) {
      return showMsg('err', 'Alege un delegat.');
    }

    var btn = document.getElementById('btnSaveLeave');
    btn.disabled = true;
    try {
      var r = await _apiFetch('/api/users/me/leave', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leave_start: leave_start, leave_end: leave_end, delegate_user_id: Number(delegate_user_id), leave_reason: leave_reason }),
      });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) {
        return showMsg('err', data.message || data.error || 'Eroare la salvare.');
      }
      showMsg('ok', 'Concediu salvat cu succes.');
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
    var btn = document.getElementById('btnClearLeave');
    btn.disabled = true;
    try {
      var r = await _apiFetch('/api/users/me/leave', { method: 'DELETE' });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) {
        return showMsg('err', data.message || data.error || 'Eroare la anulare.');
      }
      showMsg('ok', 'Concediu anulat.');
      ['leaveStart', 'leaveEnd', 'leaveDelegate', 'leaveReason'].forEach(function(id) {
        var el = document.getElementById(id);
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
    var el = document.getElementById('leaveMsg');
    if (!el) return;
    el.className = 'setari-msg' + (kind ? ' ' + kind : '');
    el.textContent = text;
    if (kind === 'ok') {
      setTimeout(function() {
        if (el.textContent === text) { el.textContent = ''; el.className = 'setari-msg'; }
      }, 4000);
    }
  }

  function _fmtDate(iso) {
    if (!iso) return '—';
    var parts = iso.split('-');
    return parts[2] + '.' + parts[1] + '.' + parts[0];
  }
})();
