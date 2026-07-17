/**
 * DocFlowAI — Chat Etapa 1 (P3, frontend)
 *
 * Consumă contractele pinate în P1/P2 (server/routes/chat.mjs):
 *   GET  /api/chat/conversations                 → { ok, conversations:[…] }
 *   POST /api/chat/conversations                 → { ok, conversation }
 *   GET  /api/chat/conversations/:id/messages    → { ok, messages:[…], has_more }
 *   POST /api/chat/conversations/:id/messages    → { ok, message }
 *   POST /api/chat/conversations/:id/read        → { ok }
 * Live: WS `event:'chat_message'` cu `data:{ conv_id, message }`.
 *
 * ⛔ XSS-01: `body` e text scris de utilizator → randat EXCLUSIV cu textContent.
 *    Zero innerHTML pe conținut de user, zero onclick inline (delegare + data-*).
 *
 * ⚠️ Socket PROPRIU (nu-l reutilizăm pe cel din notif-widget.js): notif-widget e în
 *    PRECACHE_ASSETS → orice modificare a lui ar cere bump de CACHE_VERSION. Etapa 1
 *    ține logica de chat aici; un singur socket partajat e optimizare pentru Etapa 2.
 */
(function () {
  'use strict';

  const api = (url, opts) => window._apiFetch(url, opts);

  let _me = null;          // userId-ul meu (din /auth/me)
  let _convs = [];         // conversațiile, în ordinea afișată (desc după updated_at)
  let _active = null;      // conv_id deschis
  let _users = [];         // userii org-ului (modal)
  let _picked = new Set(); // participant_ids bifați
  let _sending = false;

  const $ = (id) => document.getElementById(id);

  // ── Utilitare ──────────────────────────────────────────────────────────────
  function fmtTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      return sameDay
        ? d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit' });
    } catch (_) { return ''; }
  }

  function convName(c) {
    if (c.kind === 'platform_support') return 'Suport platformă';
    if (c.is_group) {
      if (c.title) return c.title;
      const others = (c.participants || []).filter(p => Number(p.user_id) !== Number(_me));
      return others.map(p => p.nume || p.email).join(', ') || 'Grup';
    }
    const other = (c.participants || []).find(p => Number(p.user_id) !== Number(_me));
    return other ? (other.nume || other.email) : 'Conversație';
  }

  function toast(text) {
    const el = $('chat-new-msg');
    if (!el) return;
    el.textContent = text;              // textContent — nu innerHTML
    el.style.display = '';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  /** Mesaj discret în capul firului (ex. 429 la trimitere). */
  function threadNote(text) {
    const box = $('chat-messages');
    if (!box) return;
    const n = document.createElement('div');
    n.className = 'chat-hint';
    n.textContent = text;
    box.appendChild(n);
    box.scrollTop = box.scrollHeight;
    setTimeout(() => n.remove(), 4000);
  }

  // ── Lista de conversații ───────────────────────────────────────────────────
  function renderList() {
    const list = $('chat-list');
    if (!list) return;
    if (!_convs.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-hint';
      empty.textContent = 'Nicio conversație încă.';
      list.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const c of _convs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-item' + (Number(c.id) === Number(_active) ? ' active' : '');
      btn.dataset.convId = String(c.id);   // delegare — fără onclick inline

      const top = document.createElement('div');
      top.className = 'chat-item-top';

      const nm = document.createElement('span');
      nm.className = 'chat-item-name';
      nm.textContent = convName(c);        // nume de user — textContent
      top.appendChild(nm);

      if (c.kind === 'platform_support') {
        const k = document.createElement('span');
        k.className = 'chat-kind';
        k.textContent = 'suport';
        top.appendChild(k);
      } else if (c.is_group) {
        const k = document.createElement('span');
        k.className = 'chat-kind';
        k.textContent = 'grup';
        top.appendChild(k);
      }

      const badge = document.createElement('span');
      badge.className = 'chat-badge' + (c.unread > 0 ? ' on' : '');
      badge.dataset.badgeFor = String(c.id);
      badge.textContent = c.unread > 0 ? String(c.unread) : '';
      top.appendChild(badge);

      const tm = document.createElement('span');
      tm.className = 'chat-item-time';
      tm.textContent = fmtTime(c.last_message ? c.last_message.created_at : c.updated_at);
      top.appendChild(tm);

      const prev = document.createElement('div');
      prev.className = 'chat-item-prev';
      prev.textContent = c.last_message ? (c.last_message.body || '') : 'Fără mesaje';
      btn.append(top, prev);
      frag.appendChild(btn);
    }
    list.replaceChildren(frag);
  }

  async function loadConversations() {
    try {
      const r = await api('/api/chat/conversations');
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'load_failed');
      _convs = j.conversations || [];
      renderList();
    } catch (_) {
      const list = $('chat-list');
      if (list) {
        const e = document.createElement('div');
        e.className = 'chat-hint';
        e.textContent = 'Nu s-au putut încărca conversațiile.';
        list.replaceChildren(e);
      }
    }
  }

  // ── Firul de mesaje ────────────────────────────────────────────────────────
  function msgEl(m) {
    const wrap = document.createElement('div');
    const mine = Number(m.from_user) === Number(_me);
    wrap.className = 'chat-msg' + (mine ? ' mine' : '') + (m.deleted_at ? ' deleted' : '');
    wrap.dataset.msgId = String(m.id);

    if (!mine) {
      const from = document.createElement('div');
      from.className = 'chat-msg-from';
      from.textContent = m.from_nume || '';   // nume — textContent
      wrap.appendChild(from);
    }

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    // Tombstone: serverul întoarce rândul șters cu body golit — afișăm marcajul,
    // nu conținutul (pe care oricum nu-l primim).
    body.textContent = m.deleted_at ? 'mesaj șters' : (m.body || '');
    wrap.appendChild(body);

    const t = document.createElement('div');
    t.className = 'chat-msg-time';
    t.textContent = fmtTime(m.created_at);
    wrap.appendChild(t);
    return wrap;
  }

  function appendMsg(m) {
    const box = $('chat-messages');
    if (!box) return;
    box.appendChild(msgEl(m));
    box.scrollTop = box.scrollHeight;
  }

  async function openConversation(id) {
    _active = Number(id);
    renderList();

    const conv = _convs.find(c => Number(c.id) === _active);
    const head = $('chat-thread-head');
    if (conv && head) {
      head.style.display = '';
      $('chat-thread-title').textContent = convName(conv);
      const others = (conv.participants || []).filter(p => Number(p.user_id) !== Number(_me));
      $('chat-thread-sub').textContent = conv.kind === 'platform_support'
        ? 'Echipa DocFlowAI'
        : (conv.is_group ? others.map(p => p.nume || p.email).join(', ') : (others[0] ? (others[0].email || '') : ''));
    }
    $('chat-placeholder').style.display = 'none';
    $('chat-compose').style.display = '';

    const box = $('chat-messages');
    box.replaceChildren();

    try {
      const r = await api('/api/chat/conversations/' + _active + '/messages');
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'load_failed');

      const frag = document.createDocumentFragment();
      for (const m of (j.messages || [])) frag.appendChild(msgEl(m));  // ASC, noile jos
      box.replaceChildren(frag);
      box.scrollTop = box.scrollHeight;

      markRead(_active);
    } catch (_) {
      const e = document.createElement('div');
      e.className = 'chat-hint';
      e.textContent = 'Nu s-au putut încărca mesajele.';
      box.replaceChildren(e);
    }
  }

  /** Marchează citit pe server + scoate badge-ul local. */
  async function markRead(id) {
    const conv = _convs.find(c => Number(c.id) === Number(id));
    if (conv) conv.unread = 0;
    renderList();
    try { await api('/api/chat/conversations/' + id + '/read', { method: 'POST' }); } catch (_) {}
  }

  // ── Trimitere ──────────────────────────────────────────────────────────────
  async function sendMessage() {
    if (_sending || !_active) return;
    const input = $('chat-input');
    const body = (input.value || '').trim();
    if (!body) return;

    _sending = true;
    $('chat-send').disabled = true;
    try {
      const r = await api('/api/chat/conversations/' + _active + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      if (r.status === 429) { threadNote('Prea multe mesaje, așteaptă un moment.'); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'send_failed');

      // Optimist: mesajul propriu apare imediat (serverul NU-l trimite înapoi pe WS —
      // deliverMessage exclude expeditorul).
      appendMsg(j.message);
      input.value = '';
      input.style.height = 'auto';
      bumpConv(_active, j.message, false);
    } catch (_) {
      threadNote('Mesajul nu a putut fi trimis.');
    } finally {
      _sending = false;
      $('chat-send').disabled = false;
    }
  }

  /** Urcă o conversație în capul listei + actualizează preview/unread. */
  function bumpConv(convId, message, incUnread) {
    const i = _convs.findIndex(c => Number(c.id) === Number(convId));
    if (i < 0) { loadConversations(); return; }   // conversație necunoscută → refetch
    const c = _convs[i];
    c.last_message = { body: message.body, from_user: message.from_user, created_at: message.created_at };
    c.updated_at = message.created_at;
    if (incUnread) c.unread = (c.unread || 0) + 1;
    _convs.splice(i, 1);
    _convs.unshift(c);
    renderList();
  }

  // ── Modal „Conversație nouă" ───────────────────────────────────────────────
  function renderUsers() {
    const box = $('chat-new-users');
    if (!box) return;
    const q = ($('chat-new-q').value || '').trim().toLowerCase();
    const list = _users.filter(u => {
      if (!q) return true;
      return String(u.nume || '').toLowerCase().includes(q)
          || String(u.email || '').toLowerCase().includes(q);
    });

    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'chat-hint';
      e.textContent = 'Niciun coleg găsit.';
      box.replaceChildren(e);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const u of list) {
      const row = document.createElement('label');
      row.className = 'chat-user';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.userId = String(u.id);
      cb.checked = _picked.has(Number(u.id));

      const txt = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'chat-user-nm';
      nm.textContent = u.nume || u.email;   // textContent
      const em = document.createElement('div');
      em.className = 'chat-user-em';
      em.textContent = u.email || '';
      txt.append(nm, em);

      row.append(cb, txt);
      frag.appendChild(row);
    }
    box.replaceChildren(frag);
  }

  function syncTitleRow() {
    // Titlu doar la grup (≥2 alți useri ⇒ is_group pe server: actor + 2 = 3 participanți).
    $('chat-new-title-row').style.display = _picked.size >= 2 ? '' : 'none';
  }

  async function openNewModal() {
    _picked.clear();
    $('chat-new-kind').value = 'internal';
    $('chat-new-q').value = '';
    $('chat-new-title').value = '';
    $('chat-new-msg').style.display = 'none';
    syncKind();
    syncTitleRow();
    $('chat-new-modal').classList.add('on');

    if (!_users.length) {
      try {
        // GET /users — userii ORG-ului actorului (org-scoped server-side, SEC-90);
        // exclude rolul de platformă `admin` ⇒ potrivit pentru participanți `internal`.
        const r = await api('/users');
        const j = await r.json();
        _users = Array.isArray(j) ? j.filter(u => Number(u.id) !== Number(_me)) : [];
      } catch (_) { _users = []; }
    }
    renderUsers();
  }

  function syncKind() {
    const support = $('chat-new-kind').value === 'platform_support';
    $('chat-new-internal').style.display = support ? 'none' : '';
    $('chat-new-support-note').style.display = support ? '' : 'none';
  }

  async function createConversation() {
    const kind = $('chat-new-kind').value;
    const payload = { kind };
    if (kind === 'internal') {
      if (!_picked.size) { toast('Alege cel puțin un participant.'); return; }
      payload.participant_ids = [..._picked];
      payload.is_group = _picked.size >= 2;
      const t = ($('chat-new-title').value || '').trim();
      if (payload.is_group && t) payload.title = t;
    }

    $('chat-new-create').disabled = true;
    try {
      const r = await api('/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'create_failed');

      $('chat-new-modal').classList.remove('on');
      // Refetch: acoperă și cazul idempotent 1-la-1 (serverul întoarce una existentă,
      // cu istoricul ei) — lista trebuie să conțină conversația înainte de deschidere.
      await loadConversations();
      openConversation(j.conversation.id);
    } catch (e) {
      toast(e && e.message === 'cross_org_forbidden'
        ? 'Participanții trebuie să fie din aceeași organizație.'
        : 'Conversația nu a putut fi creată.');
    } finally {
      $('chat-new-create').disabled = false;
    }
  }

  // ── WebSocket (socket propriu, doar pe pagina de chat) ─────────────────────
  let ws = null, reconnectTimer = null, reconnectDelay = 2000, keepalive = null, closing = false;

  function connectWS() {
    if (closing) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);   // cookie auth la upgrade (SEC-01)

    ws.onopen = () => {
      reconnectDelay = 2000;
      if (keepalive) clearInterval(keepalive);
      keepalive = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event !== 'chat_message' || !msg.data) return;
        const convId = Number(msg.data.conv_id);
        const m = msg.data.message;
        if (!m) return;
        if (convId === Number(_active)) {
          appendMsg(m);
          bumpConv(convId, m, false);
          markRead(convId);          // fir deschis ⇒ e citit pe loc
        } else {
          bumpConv(convId, m, true); // altă conversație ⇒ badge unread + urcă în cap
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
      if (closing) return;                       // fără reconnect zombi la părăsirea paginii
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, reconnectDelay);
      reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
    };

    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function teardownWS() {
    closing = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    try { if (ws) ws.close(); } catch (_) {}
    ws = null;
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  function wireEvents() {
    // Delegare pe listă — zero onclick inline.
    $('chat-list').addEventListener('click', (e) => {
      const item = e.target.closest('.chat-item');
      if (item && item.dataset.convId) openConversation(item.dataset.convId);
    });

    $('chat-send').addEventListener('click', sendMessage);
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('chat-input').addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
    });

    $('chat-new-btn').addEventListener('click', openNewModal);
    $('chat-new-cancel').addEventListener('click', () => $('chat-new-modal').classList.remove('on'));
    $('chat-new-create').addEventListener('click', createConversation);
    $('chat-new-kind').addEventListener('change', syncKind);
    $('chat-new-q').addEventListener('input', renderUsers);
    $('chat-new-modal').addEventListener('click', (e) => {
      if (e.target === $('chat-new-modal')) $('chat-new-modal').classList.remove('on');
    });
    $('chat-new-users').addEventListener('change', (e) => {
      const cb = e.target;
      if (!cb || !cb.dataset || !cb.dataset.userId) return;
      const id = Number(cb.dataset.userId);
      if (cb.checked) _picked.add(id); else _picked.delete(id);
      syncTitleRow();
    });

    window.addEventListener('beforeunload', teardownWS);
  }

  async function init() {
    // ⛔ Poarta paginii: linkul din nav e ascuns prin data-df-module, dar cineva poate
    // naviga DIRECT la /chat.html → pagina se auto-apără. (Autorizarea reală rămâne pe
    // server: requireModule('chat') pe fiecare rută /api/chat/*.)
    await window.df.entitlementsReady;
    if (!window.df.canUseModule('chat')) {
      $('chat-inactive').style.display = '';
      $('chat-content').style.display = 'none';
      return;
    }
    $('chat-content').style.display = '';

    try {
      const r = await fetch('/auth/me', { credentials: 'include' });
      if (!r.ok) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      const u = await r.json();
      _me = u.userId;
    } catch (_) { return; }

    wireEvents();
    await loadConversations();
    connectWS();

    // Deep-link din notificare: /chat.html?conv=<id>
    const conv = new URLSearchParams(location.search).get('conv');
    if (conv) {
      // Conversație nouă (ex. suport) poate lipsi din lista abia încărcată — refetch o dată.
      if (!_convs.some(c => Number(c.id) === Number(conv))) await loadConversations();
      openConversation(Number(conv));
      history.replaceState(null, '', location.pathname);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
