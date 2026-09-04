/**
 * DocFlowAI — Setări: „Semnatari impliciți — dosare ALOP"  (#173)
 * ---------------------------------------------------------------------------
 * `alop_sabloane` era GOL în producție și nu avea niciun ecran: rutele
 * (`GET`/`POST /api/alop/sablon`) existau de mult, dar butonul care le chema
 * fusese scos. Consecință: fiecare dosar nou pornea din rolurile implicite, toate
 * fără persoană, iar prefill-ul (#172) aducea roluri goale în tabelul de semnatari.
 *
 * Locul e „Setări", nu „Organizații": șablonul e o setare de INSTITUȚIE, iar
 * `POST /api/alop/sablon` e deschis pentru `admin` ȘI `org_admin` — gate-ul de
 * vizibilitate de mai jos OGLINDEȘTE exact autorizarea rutei.
 *
 * ⛔ `lichidare_sablon` face parte din ACELAȘI upsert. Se citește la încărcare și se
 *    retrimite NESCHIMBAT: dacă ecranul ar salva fără el, l-ar ȘTERGE — iar
 *    `alop.mjs` îl folosește pentru `lichidare_confirmed_by` la crearea dosarului.
 * ⛔ Un rol PERSONALIZAT cere atribut ales EXPLICIT (validarea server e în
 *    `_validSablonSemnatari`). Fără asta ar ajunge pe o ordonanțare de plată cu
 *    „SEMNAT" — persoana corectă, atributul greșit, nicio eroare nicăieri.
 * ⛔ `__alt__` din `DFAtribute.LIST` e santinela pentru „Alt atribut…", nu un
 *    atribut: aici NU se oferă, fiindcă serverul o respinge.
 *
 * Script CLASIC, cu `defer`. `shared/atribute.js` se încarcă ÎNAINTE, fără `defer`
 * (expune `window.DFAtribute` sincron) — capcana de ordonare tratată la #168.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return (window.df && window.df.esc) ? window.df.esc(s) :
      String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function csrfHeader() {
    var t = (window.df && window.df.getCsrf) ? window.df.getCsrf() : null;
    return t ? { 'x-csrf-token': t } : {};
  }

  // Vocabularul rolurilor — pereche a lui `server/services/alop-roluri.mjs`.
  // Atributul e doar PRESELECȚIE aici; sursa de adevăr a validării e serverul.
  var ROLURI = [
    { key: 'initiator',         eticheta: 'Inițiator',            atribut: 'ÎNTOCMIT' },
    { key: 'sef_compartiment',  eticheta: 'Șef compartiment',     atribut: 'VIZAT' },
    { key: 'responsabil_cab',   eticheta: 'Responsabil CAB',      atribut: 'VERIFICAT' },
    { key: 'sef_cab',           eticheta: 'Șef compartiment CAB', atribut: 'VIZAT' },
    { key: 'director_economic', eticheta: 'Director Economic',    atribut: 'VIZĂ ECONOMICĂ' },
    { key: 'ordonator_credite', eticheta: 'Ordonator de credite', atribut: 'APROBAT' },
    { key: 'cfp_propriu',       eticheta: 'CFP Propriu',          atribut: 'VIZĂ CFPP' },
  ];
  var CUSTOM = '__custom__';   // santinela de UI pentru „Rol personalizat…"
  var MAX_ROLURI = 12;

  function rolCunoscut(key) {
    for (var i = 0; i < ROLURI.length; i++) if (ROLURI[i].key === key) return ROLURI[i];
    return null;
  }
  function atributeList() {
    var L = (window.DFAtribute && window.DFAtribute.LIST) ? window.DFAtribute.LIST : [];
    return L.filter(function (a) { return a !== '__alt__'; });
  }

  var _users = [];            // [{id, email, nume}]
  var _lichidareSablon = {};  // păstrat NESCHIMBAT prin round-trip
  var _rows = { df: [], ord: [] };

  // ── /auth/me — gate identic cu autorizarea rutei: admin SAU org_admin ───────
  function _checkRole() {
    return fetch('/auth/me', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) { return !!(u && (u.role === 'admin' || u.role === 'org_admin')); })
      .catch(function () { return false; });
  }

  function _loadUsers() {
    return fetch('/admin/users', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        _users = (Array.isArray(rows) ? rows : [])
          .filter(function (u) { return !u.deleted_at; })
          .map(function (u) { return { id: u.id, email: u.email, nume: u.nume || u.email }; });
      })
      .catch(function () { _users = []; });
  }

  function _loadSablon() {
    return fetch('/api/alop/sablon', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var s = (j && j.sablon) || {};
        _lichidareSablon = s.lichidare_sablon || {};
        _rows.df  = (s.df_semnatari_sablon  || []).map(_norm);
        _rows.ord = (s.ord_semnatari_sablon || []).map(_norm);
      });
  }

  function _norm(s) {
    var known = rolCunoscut(s.role);
    return {
      role: s.role || '',
      eticheta: s.eticheta || (known ? known.eticheta : ''),
      atribut: s.atribut || (known ? known.atribut : ''),
      user_id: s.user_id == null ? '' : String(s.user_id),
      same_as_initiator: !!s.same_as_initiator,
      custom: !known,
    };
  }

  // ── Randare ────────────────────────────────────────────────────────────────
  function _rowHtml(ft, r, i) {
    var rolOpts = ROLURI.map(function (R) {
      return '<option value="' + R.key + '"' + (R.key === r.role ? ' selected' : '') + '>' + esc(R.eticheta) + '</option>';
    }).join('') +
      '<option value="' + CUSTOM + '"' + (r.custom ? ' selected' : '') + '>Rol personalizat…</option>';

    var atribOpts = '<option value="">— Alege —</option>' + atributeList().map(function (a) {
      return '<option value="' + esc(a) + '"' + (a === r.atribut ? ' selected' : '') + '>' + esc(a) + '</option>';
    }).join('');

    var userOpts = '<option value="">— fără persoană —</option>' + _users.map(function (u) {
      return '<option value="' + esc(String(u.id)) + '"' + (String(u.id) === r.user_id ? ' selected' : '') + '>' +
        esc(u.nume) + ' (' + esc(u.email) + ')</option>';
    }).join('');

    var customFields = r.custom
      ? '<div style="display:flex;gap:4px;margin-top:4px;">' +
          '<input type="text" data-f="key" placeholder="cheie (ex. consilier_juridic)" maxlength="64" value="' + esc(r.custom ? r.role : '') + '">' +
          '<input type="text" data-f="eticheta" placeholder="denumire afișată" maxlength="120" value="' + esc(r.eticheta) + '">' +
        '</div>'
      : '';

    return '<tr data-ft="' + ft + '" data-i="' + i + '">' +
      '<td><select data-f="rol">' + rolOpts + '</select>' + customFields + '</td>' +
      '<td><select data-f="atribut">' + atribOpts + '</select></td>' +
      '<td><select data-f="user">' + userOpts + '</select></td>' +
      '<td style="text-align:right;"><button type="button" class="df-action-btn sm danger" data-f="del">' +
        '<svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.693#ico-trash"/></svg>Șterge</button></td>' +
      '</tr>';
  }

  function _render(ft) {
    var body = $('alop-sem-' + ft + '-body');
    if (!body) return;
    body.innerHTML = _rows[ft].map(function (r, i) { return _rowHtml(ft, r, i); }).join('') ||
      '<tr><td colspan="4" style="color:var(--df-text-4);padding:10px;">Niciun rol configurat.</td></tr>';
    _syncSave();
  }

  function _renderAll() { _render('df'); _render('ord'); }

  // ── Validare de UI — oglindește `_validSablonSemnatari` de pe server ────────
  function _problema() {
    var liste = [['df', 'Document de Fundamentare'], ['ord', 'Ordonanțare de plată']];
    for (var k = 0; k < liste.length; k++) {
      var ft = liste[k][0], label = liste[k][1], rows = _rows[ft];
      if (!rows.length) return label + ': cel puțin un rol.';
      if (rows.length > MAX_ROLURI) return label + ': maximum ' + MAX_ROLURI + ' roluri.';
      var vazute = {}, areInitiator = false;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var key = (r.role || '').trim();
        if (!key) return label + ': un rând nu are rolul completat.';
        if (vazute[key]) return label + ': rolul „' + key + '" apare de două ori.';
        vazute[key] = true;
        if (key === 'initiator') areInitiator = true;
        if (r.custom) {
          if (!r.atribut) return label + ': rolul personalizat „' + key + '" cere un atribut de semnătură.';
          if (!(r.eticheta || '').trim()) return label + ': rolul personalizat „' + key + '" cere o denumire.';
        }
      }
      if (!areInitiator) return label + ': rolul „Inițiator" nu poate lipsi.';
    }
    return null;
  }

  function _syncSave() {
    var btn = $('alop-sem-save');
    if (!btn) return;
    var p = _problema();
    btn.disabled = !!p;
    btn.title = p || '';
  }

  // ── Evenimente (delegate — rândurile se re-randează) ────────────────────────
  function _onChange(e) {
    var tr = e.target.closest ? e.target.closest('tr[data-ft]') : null;
    if (!tr) return;
    var ft = tr.getAttribute('data-ft'), i = Number(tr.getAttribute('data-i'));
    var r = _rows[ft] && _rows[ft][i];
    if (!r) return;
    var f = e.target.getAttribute('data-f');

    if (f === 'rol') {
      var v = e.target.value;
      if (v === CUSTOM) {
        r.custom = true; r.role = ''; r.eticheta = ''; r.atribut = '';
      } else {
        var known = rolCunoscut(v);
        r.custom = false; r.role = v;
        r.eticheta = known ? known.eticheta : '';
        r.atribut = known ? known.atribut : '';
      }
      _render(ft);
      return;
    }
    if (f === 'atribut') { r.atribut = e.target.value; }
    else if (f === 'user') { r.user_id = e.target.value; }
    else if (f === 'key') { r.role = e.target.value.trim(); }
    else if (f === 'eticheta') { r.eticheta = e.target.value; }
    _syncSave();
  }

  function _onClick(e) {
    var btn = e.target.closest ? e.target.closest('button[data-f="del"]') : null;
    if (!btn) return;
    var tr = btn.closest('tr[data-ft]');
    var ft = tr.getAttribute('data-ft'), i = Number(tr.getAttribute('data-i'));
    _rows[ft].splice(i, 1);
    _render(ft);
  }

  function _add(ft) {
    if (_rows[ft].length >= MAX_ROLURI) return;
    // Primul rol încă nefolosit; dacă toate sunt luate, pornim pe „personalizat".
    var luate = {};
    _rows[ft].forEach(function (r) { luate[r.role] = true; });
    var liber = null;
    for (var i = 0; i < ROLURI.length; i++) if (!luate[ROLURI[i].key]) { liber = ROLURI[i]; break; }
    _rows[ft].push(liber
      ? { role: liber.key, eticheta: liber.eticheta, atribut: liber.atribut, user_id: '', custom: false }
      : { role: '', eticheta: '', atribut: '', user_id: '', custom: true });
    _render(ft);
  }

  // ── Salvare ────────────────────────────────────────────────────────────────
  function _payloadFor(ft) {
    return _rows[ft].map(function (r, i) {
      var out = {
        order: i + 1,                 // `order` se recalculează din poziția în tabel
        role: (r.role || '').trim(),
        user_id: r.user_id ? Number(r.user_id) : null,
        name: '',
        atribut: r.atribut || undefined,
      };
      if (r.user_id) {
        var u = _users.filter(function (x) { return String(x.id) === String(r.user_id); })[0];
        if (u) out.name = u.nume;
      }
      if (r.custom) out.eticheta = (r.eticheta || '').trim();
      if (r.same_as_initiator) out.same_as_initiator = true;
      return out;
    });
  }

  function _onSave() {
    var status = $('alop-sem-status');
    var p = _problema();
    if (p) { if (status) window.df.showMsg ? window.df.showMsg(status, p, 'err') : (status.textContent = p); return; }

    var btn = $('alop-sem-save');
    btn.disabled = true;
    fetch('/api/alop/sablon', {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, csrfHeader()),
      body: JSON.stringify({
        df_semnatari_sablon: _payloadFor('df'),
        ord_semnatari_sablon: _payloadFor('ord'),
        // Citit din GET și retrimis NESCHIMBAT — face parte din același upsert.
        lichidare_sablon: _lichidareSablon,
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && (res.j.message || res.j.error)) || 'Eroare la salvare.');
        if (status) window.df.showMsg ? window.df.showMsg(status, 'Șablon salvat.', 'ok') : (status.textContent = 'Șablon salvat.');
      })
      .catch(function (err) {
        if (status) window.df.showMsg ? window.df.showMsg(status, err.message, 'err') : (status.textContent = err.message);
      })
      .finally(function () { _syncSave(); });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    var sec = $('alop-sem-section');
    if (!sec) return;
    _checkRole().then(function (allowed) {
      if (!allowed) { sec.style.display = 'none'; return; }
      sec.style.display = '';
      return Promise.all([_loadUsers(), _loadSablon()]).then(function () {
        _renderAll();
        ['df', 'ord'].forEach(function (ft) {
          var body = $('alop-sem-' + ft + '-body');
          if (body) { body.addEventListener('change', _onChange); body.addEventListener('input', _onChange); body.addEventListener('click', _onClick); }
          var add = $('alop-sem-' + ft + '-add');
          if (add) add.addEventListener('click', function () { _add(ft); });
        });
        $('alop-sem-save').addEventListener('click', _onSave);
      });
    }).catch(function () {
      var st = $('alop-sem-status');
      if (st) st.textContent = 'Eroare la inițializare. Verificați conexiunea.';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
