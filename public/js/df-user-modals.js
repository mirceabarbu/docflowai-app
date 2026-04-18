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
})();
