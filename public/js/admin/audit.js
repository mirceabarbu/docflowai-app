(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;

  let _auditCurrentPage = 1;

  const AUDIT_EVENT_LABELS = {
    'FLOW_CREATED':                  'Flux creat',
    'FLOW_COMPLETED':                'Flux finalizat',
    'FLOW_CANCELLED':                'Flux anulat',
    'FLOW_REFUSED':                  'Flux refuzat',
    'FLOW_REINITIATED':              'Flux reinițiat',
    'FLOW_REINITIATED_AFTER_REVIEW': 'Flux reinițiat după revizuire',
    'FLOW_DELEGATED':                'Delegare semnătură',
    'SIGNED':                        'Semnat',
    'REFUSED':                       'Refuzat',
    'DELEGATED':                     'Delegare semnătură',
    'SIGNED_PDF_UPLOADED':           'Document semnat încărcat',
    'PDF_DOWNLOADED':                'PDF descărcat',
    'ATTACHMENT_ADDED':              'Atașament adăugat',
    'EMAIL_SENT':                    'Email trimis',
    'REVIEW_REQUESTED':              'Revizuire solicitată',
    'SIGNER_NOTIFIED':               'Semnatar notificat',
    'ARCHIVE_COMPLETED':             'Arhivat',
    'TRUST_REPORT_GENERATED':        'Raport trust generat',
    'auth.login.success':            'Autentificare reușită',
    'auth.login.failed':             'Autentificare eșuată',
    'USER_LOGIN':                    'Autentificare',
    'USER_LOGOUT':                   'Deconectare',
  };

  async function loadDashboard() {
    try {
      const [sR, fR] = await Promise.all([
        _apiFetch('/admin/stats'),
        _apiFetch('/admin/flows/stats'),
      ]);
      const s = sR.ok ? await sR.json() : null;
      const f = fR.ok ? await fR.json() : null;
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = (val != null) ? Number(val).toLocaleString('ro-RO') : '—';
      };
      if (s?.stats) {
        set('dashKpiUsers', s.stats.users);
        set('dashKpiNotif', s.stats.unreadNotifications);
      }
      if (f) {
        set('dashKpiActive', f.active);
        set('dashKpiCompleted', f.completed);
      }
    } catch (e) {
      console.warn('[loadDashboard] failed:', e);
    }
  }

  async function loadAuditEvents(page = 1) {
    _auditCurrentPage = page;
    const eventType = $('audit-event-type')?.value || '';
    const flowId    = $('audit-flow-id')?.value    || '';
    const from      = $('audit-from')?.value       || '';
    const to        = $('audit-to')?.value         || '';

    const params = new URLSearchParams({ page, limit: 50 });
    if (eventType) params.set('event_type', eventType);
    if (flowId)    params.set('flow_id', flowId);
    if (from)      params.set('from', from);
    if (to)        params.set('to', to);

    try {
      const res  = await fetch(`/admin/audit-events?${params}`, { credentials: 'include' });
      const data = await res.json();
      renderAuditTable(data.events || []);
      renderAuditPagination(data.page || 1, data.pages || 1, data.total || 0);
    } catch(e) {
      const tb = $('audit-tbody');
      if (tb) tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#f87171">Eroare la încărcare</td></tr>';
    }
  }

  function renderAuditTable(events) {
    const tbody = $('audit-tbody');
    if (!tbody) return;
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--muted)">Niciun eveniment găsit</td></tr>';
      return;
    }
    const badgeColor = {
      'FLOW_CREATED':        '#3b82f6',
      'FLOW_COMPLETED':      '#10b981',
      'FLOW_REFUSED':        '#ef4444',
      'FLOW_CANCELLED':      '#f97316',
      'SIGNED_PDF_UPLOADED': '#8b5cf6',
      'USER_LOGIN':          '#06b6d4',
      'USER_LOGOUT':         '#64748b',
    };
    tbody.innerHTML = events.map(e => {
      const date      = new Date(e.created_at).toLocaleString('ro-RO', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const label     = AUDIT_EVENT_LABELS[e.event_type] || e.event_type;
      const color     = badgeColor[e.event_type] || '#64748b';
      const badgeHtml = `<span style="background:${color}22;color:${color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap">${esc(label)}</span>`;
      const flowLink  = e.flow_id
        ? `<a href="/flow.html?id=${encodeURIComponent(e.flow_id)}" style="font-family:monospace;font-size:11px;color:#7c9eff;word-break:break-all;">${esc(e.flow_id)}</a>`
        : '<span style="color:var(--muted)">—</span>';
      const actor = esc(e.actor_name || e.actor_email || '—');
      return `<tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:8px 10px;white-space:nowrap;color:#9db0ff;">${date}</td>
        <td style="padding:8px 10px;">${badgeHtml}</td>
        <td style="padding:8px 10px;font-size:.8rem;color:#eaf0ff;">${actor}</td>
        <td style="padding:8px 10px;">${flowLink}</td>
        <td style="padding:8px 10px;"><span style="font-size:.76rem;color:var(--muted);">${esc(e.channel || 'api')}</span></td>
        <td style="padding:8px 10px;font-size:.78rem;color:#8899bb;">${esc(e.message || '—')}</td>
      </tr>`;
    }).join('');
  }

  function renderAuditPagination(page, pages, total) {
    const el = $('audit-pagination');
    if (!el) return;
    el.innerHTML = `
      <button class="df-action-btn sm" onclick="loadAuditEvents(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
      <span style="color:var(--muted);">Pagina <strong style="color:#eaf0ff;">${page}</strong> din <strong style="color:#eaf0ff;">${pages}</strong> &nbsp;·&nbsp; ${total} înregistrări</span>
      <button class="df-action-btn sm" onclick="loadAuditEvents(${page + 1})" ${page >= pages ? 'disabled' : ''}>Următor ›</button>
    `;
  }

  async function loadAuditEventTypes() {
    try {
      const res  = await fetch('/admin/audit-events/types', { credentials: 'include' });
      const data = await res.json();
      const sel  = $('audit-event-type');
      if (sel && data.types) {
        const items = data.types
          .map(t => ({ value: t, label: AUDIT_EVENT_LABELS[t] || t }))
          .sort((a, b) => a.label.localeCompare(b.label, 'ro'));
        items.forEach(it => {
          const opt = document.createElement('option');
          opt.value = it.value;
          opt.textContent = it.label;
          sel.appendChild(opt);
        });
      }
    } catch(e) {}
  }

  function resetAuditFilters() {
    ['audit-event-type','audit-flow-id','audit-from','audit-to','audit-from-display','audit-to-display'].forEach(id => {
      const el = $(id);
      if (el) { el.value = ''; el.style.borderColor = ''; }
    });
    loadAuditEvents(1);
  }

  function downloadAuditCsv() {
    const eventType = $('audit-event-type')?.value || '';
    const flowId    = $('audit-flow-id')?.value    || '';
    const from      = $('audit-from')?.value       || '';
    const to        = $('audit-to')?.value         || '';
    const params    = new URLSearchParams({ format: 'csv', limit: 10000 });
    if (eventType) params.set('event_type', eventType);
    if (flowId)    params.set('flow_id', flowId);
    if (from)      params.set('from', from);
    if (to)        params.set('to', to);
    window.location.href = `/admin/audit-events?${params}`;
  }

  window.loadDashboard       = loadDashboard;
  window.loadAuditEvents     = loadAuditEvents;
  window.loadAuditEventTypes = loadAuditEventTypes;
  window.resetAuditFilters   = resetAuditFilters;
  window.downloadAuditCsv    = downloadAuditCsv;

  window.df._auditModuleLoaded = true;
})();
