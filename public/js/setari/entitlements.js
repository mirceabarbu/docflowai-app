/**
 * DocFlowAI — Setări: tab „Module & permisiuni" (superadmin only)
 *
 * Lifecycle:
 *   1. La load, /auth/me ne spune dacă userul curent e superadmin
 *      (role='admin' AND org_id==null). Dacă nu, ascundem tab-ul complet.
 *   2. Pentru superadmin, populăm:
 *        - Dropdown 1: tip scope (org / comp / user)
 *        - Dropdown 2: liste dinamice — orgs din /admin/organizations,
 *          comp-uri din `organizations.compartimente` JSONB,
 *          users din /admin/users filtrat pe org_id.
 *   3. La selecție scope:
 *        - GET /api/admin/entitlements/catalog → lista modulelor active
 *        - GET /api/admin/entitlements?scope_type=&scope_id= → override-uri
 *        - Pentru fiecare modul, randăm un rând cu 3 radio: activ/dezactivat/moștenit
 *        - Coloana „Efectiv" se completează din /api/admin/entitlements/resolve
 *          dacă scope='user' (singurul caz în care „efectiv" are sens unic)
 *   4. „Salvează" iterează modulele și aplică:
 *        - radio = activ/dezactivat → PUT (upsert)
 *        - radio = moștenit → DELETE (dacă a existat un override anterior)
 *      La final → invalidează cache-ul local (df.refreshEntitlements).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return (window.df && window.df.esc) ? window.df.esc(s) :
      String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function csrfHeader() {
    const t = (window.df && window.df.getCsrf) ? window.df.getCsrf() : null;
    return t ? { 'x-csrf-token': t } : {};
  }

  let _isSuperadmin = false;
  let _catalog = [];          // module_catalog rows
  let _orgs = [];             // [{id, name, compartimente:[]}]
  let _users = [];            // [{id, email, nume, org_id, compartiment}]
  let _currentRows = [];      // override-urile pentru scope-ul curent
  let _initialState = {};     // module_key → {kind: 'inherit'|'on'|'off', enabled}

  // ── /auth/me — check superadmin ─────────────────────────────────────────────
  async function _checkSuperadmin() {
    try {
      const r = await fetch('/auth/me', { credentials: 'include' });
      if (!r.ok) return false;
      const u = await r.json();
      return (u && u.role === 'admin' && (u.orgId == null || u.org_id == null));
    } catch (_) { return false; }
  }

  async function _loadOrgs() {
    const r = await fetch('/admin/organizations', { credentials: 'include' });
    if (!r.ok) throw new Error('orgs load failed');
    _orgs = await r.json();
  }
  async function _loadUsers() {
    const r = await fetch('/admin/users', { credentials: 'include' });
    if (!r.ok) throw new Error('users load failed');
    _users = await r.json();
  }
  async function _loadCatalog() {
    const r = await fetch('/api/admin/entitlements/catalog', { credentials: 'include' });
    if (!r.ok) throw new Error('catalog load failed');
    const j = await r.json();
    _catalog = (j.modules || []).filter((m) => m.active);
  }

  // ── UI builders ─────────────────────────────────────────────────────────────
  function _populateScopeType() {
    const sel = $('ent-scope-type');
    sel.innerHTML = `
      <option value="">— Alege —</option>
      <option value="org">Organizație</option>
      <option value="comp">Compartiment</option>
      <option value="user">Utilizator</option>
    `;
  }

  function _populateScopeIdForOrg() {
    const sel = $('ent-scope-id');
    sel.innerHTML = '<option value="">— Alege organizația —</option>' +
      _orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    _showOrgPickerExtras(false);
  }

  function _populateScopeIdForComp() {
    // Avem nevoie de un org părinte pentru lista de compartimente
    const sel = $('ent-scope-id');
    sel.innerHTML = '<option value="">— Alege un compartiment (după ce alegi org) —</option>';
    _showOrgPickerExtras(true);
    const orgSel = $('ent-parent-org');
    orgSel.innerHTML = '<option value="">— Alege organizația —</option>' +
      _orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    orgSel.onchange = () => {
      const orgId = orgSel.value;
      const org = _orgs.find((o) => String(o.id) === String(orgId));
      const comp = (org && Array.isArray(org.compartimente)) ? org.compartimente : [];
      sel.innerHTML = '<option value="">— Alege compartimentul —</option>' +
        comp.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    };
  }

  function _populateScopeIdForUser() {
    const sel = $('ent-scope-id');
    sel.innerHTML = '<option value="">— Alege un utilizator (după ce alegi org) —</option>';
    _showOrgPickerExtras(true);
    const orgSel = $('ent-parent-org');
    orgSel.innerHTML = '<option value="">— Alege organizația —</option>' +
      _orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    orgSel.onchange = () => {
      const orgId = orgSel.value;
      const users = _users.filter((u) => String(u.org_id) === String(orgId) && !u.deleted_at);
      sel.innerHTML = '<option value="">— Alege utilizatorul —</option>' +
        users.map((u) => `<option value="${esc(u.id)}">${esc((u.nume || '') + ' — ' + (u.email || ''))}</option>`).join('');
    };
  }

  function _showOrgPickerExtras(show) {
    const wrap = $('ent-parent-org-wrap');
    if (wrap) wrap.style.display = show ? '' : 'none';
  }

  function _onScopeTypeChange() {
    const type = $('ent-scope-type').value;
    _renderTable(null); // golește tabel
    if (!type) { $('ent-scope-id').innerHTML = '<option value="">—</option>'; _showOrgPickerExtras(false); return; }
    if (type === 'org')  _populateScopeIdForOrg();
    if (type === 'comp') _populateScopeIdForComp();
    if (type === 'user') _populateScopeIdForUser();
  }

  async function _onScopeIdChange() {
    const type = $('ent-scope-type').value;
    const id   = $('ent-scope-id').value;
    if (!type || !id) { _renderTable(null); return; }
    try {
      const r = await fetch(`/api/admin/entitlements?scope_type=${encodeURIComponent(type)}&scope_id=${encodeURIComponent(id)}`,
        { credentials: 'include' });
      if (!r.ok) throw new Error('list failed');
      const j = await r.json();
      _currentRows = j.entitlements || [];
      _renderTable({ type, id });
    } catch (e) {
      _renderTable(null);
      $('ent-status').textContent = 'Eroare la încărcarea entitlement-urilor.';
    }
  }

  function _renderTable(scope) {
    const tbody = $('ent-tbody');
    const wrap  = $('ent-table-wrap');
    $('ent-status').textContent = '';
    if (!scope) {
      tbody.innerHTML = '';
      if (wrap) wrap.style.display = 'none';
      $('ent-save-btn').disabled = true;
      return;
    }
    if (wrap) wrap.style.display = '';
    $('ent-save-btn').disabled = false;

    // Map module_key → override curent
    const overrideByKey = {};
    for (const r of _currentRows) overrideByKey[r.module_key] = r;
    _initialState = {};

    tbody.innerHTML = _catalog.map((m) => {
      const ov = overrideByKey[m.module_key];
      const initial = ov ? (ov.enabled ? 'on' : 'off') : 'inherit';
      _initialState[m.module_key] = { kind: initial };
      const name = `ent-r-${esc(m.module_key)}`;
      return `
        <tr>
          <td><strong>${esc(m.display_name)}</strong><div style="font-size:.78rem;color:var(--df-text-4)">${esc(m.module_key)}</div></td>
          <td>${esc(m.category || '')}</td>
          <td style="white-space:nowrap;">
            <label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;cursor:pointer;">
              <input type="radio" name="${name}" value="on" ${initial==='on'?'checked':''}/> Activ
            </label>
            <label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;cursor:pointer;">
              <input type="radio" name="${name}" value="off" ${initial==='off'?'checked':''}/> Dezactivat
            </label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="radio" name="${name}" value="inherit" ${initial==='inherit'?'checked':''}/> Moștenit
            </label>
          </td>
          <td id="ent-eff-${esc(m.module_key)}" style="font-size:.82rem;color:var(--df-text-3)">${ov ? `Override: ${ov.enabled ? 'activ' : 'dezactivat'}` : `Moștenit (default: ${m.default_enabled?'activ':'dezactivat'})`}</td>
        </tr>`;
    }).join('');

    // Pentru scope='user' completăm coloana „Efectiv" cu rezolvarea reală pentru fiecare modul.
    if (scope.type === 'user') {
      _catalog.forEach((m) => {
        fetch(`/api/admin/entitlements/resolve?user_id=${encodeURIComponent(scope.id)}&module_key=${encodeURIComponent(m.module_key)}`,
          { credentials: 'include' })
          .then((r) => r.ok ? r.json() : null)
          .then((j) => {
            if (!j) return;
            const cell = $('ent-eff-' + m.module_key);
            if (!cell) return;
            const label = j.effective ? '✅ Activ' : '❌ Dezactivat';
            const src   = j.source === 'user' ? 'override user' :
                          j.source === 'comp' ? 'moștenit (comp)' :
                          j.source === 'org'  ? 'moștenit (org)' :
                          j.source === 'catalog' ? 'moștenit (catalog)' : '—';
            cell.innerHTML = `${label} <span style="color:var(--df-text-4);font-size:.75rem;">(${esc(src)})</span>`;
            cell.title = `Lanț: user=${j.chain.user==null?'-':j.chain.user} · comp=${j.chain.comp==null?'-':j.chain.comp} · org=${j.chain.org==null?'-':j.chain.org} · default=${j.chain.default==null?'-':j.chain.default}`;
          })
          .catch(() => {});
      });
    }
  }

  async function _onSave() {
    const type = $('ent-scope-type').value;
    const id   = $('ent-scope-id').value;
    if (!type || !id) return;
    const status = $('ent-status');
    status.textContent = 'Se salvează…';
    $('ent-save-btn').disabled = true;
    const ops = [];
    for (const m of _catalog) {
      const radios = document.getElementsByName(`ent-r-${m.module_key}`);
      let chosen = null;
      for (const r of radios) if (r.checked) { chosen = r.value; break; }
      if (!chosen) continue;
      const prev = (_initialState[m.module_key] || {}).kind;
      if (chosen === prev) continue;
      if (chosen === 'inherit') {
        // DELETE override
        ops.push(fetch(`/api/admin/entitlements?module_key=${encodeURIComponent(m.module_key)}&scope_type=${encodeURIComponent(type)}&scope_id=${encodeURIComponent(id)}`, {
          method: 'DELETE', credentials: 'include', headers: csrfHeader(),
        }));
      } else {
        // PUT upsert
        ops.push(fetch('/api/admin/entitlements', {
          method: 'PUT', credentials: 'include',
          headers: Object.assign({ 'content-type': 'application/json' }, csrfHeader()),
          body: JSON.stringify({
            module_key: m.module_key, scope_type: type, scope_id: id, enabled: chosen === 'on',
          }),
        }));
      }
    }
    if (!ops.length) {
      status.textContent = 'Nu există schimbări.';
      $('ent-save-btn').disabled = false;
      return;
    }
    try {
      const results = await Promise.all(ops);
      const fails = results.filter((r) => !r.ok);
      if (fails.length) {
        status.textContent = `Eroare la ${fails.length}/${results.length} operații. Reîncărcați și încercați din nou.`;
      } else {
        status.textContent = `Salvat ${results.length} schimbări.`;
      }
      // Re-fetch tab + entitlements user curent (dacă scope user e userul logat etc.)
      await _onScopeIdChange();
      if (window.df && window.df.refreshEntitlements) window.df.refreshEntitlements();
    } catch (e) {
      status.textContent = 'Eroare rețea la salvare.';
    } finally {
      $('ent-save-btn').disabled = false;
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    const sec = $('ent-section');
    if (!sec) return;
    _isSuperadmin = await _checkSuperadmin();
    if (!_isSuperadmin) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    try {
      await Promise.all([_loadOrgs(), _loadUsers(), _loadCatalog()]);
      _populateScopeType();
      $('ent-scope-type').addEventListener('change', _onScopeTypeChange);
      $('ent-scope-id').addEventListener('change', _onScopeIdChange);
      $('ent-save-btn').addEventListener('click', _onSave);
    } catch (e) {
      $('ent-status').textContent = 'Eroare la inițializare. Verificați conexiunea.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
