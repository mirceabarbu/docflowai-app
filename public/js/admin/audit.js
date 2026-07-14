(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;

  let _auditCurrentPage = 1;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Dicționar traduceri event-uri audit_log
  // SoT: TREBUIE SĂ FIE IDENTIC între public/js/admin/activity.js și
  //      public/js/admin/audit.js. Sincronizează MANUAL la fiecare modif.
  // Sursa event-urilor: server/ — `grep -rhn "eventType: '" --include="*.mjs"`
  // La adăugarea unui event type nou în backend, COMPLETEAZĂ AMBELE
  // dicționare — altfel apare neredus în UI ca tag raw.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const AUDIT_EVENT_LABELS = {
    // ─── Ciclul de viață al fluxului ──────────────────────────────────
    'FLOW_CREATED':                  'Flux inițiat',
    'FLOW_COMPLETED':                'Flux finalizat',
    'FLOW_CANCELLED':                'Flux anulat',
    'FLOW_TRANSMITTED':              'Document repartizat intern',
    'FLOW_ACKNOWLEDGED':             'Confirmare luare la cunoștință',
    'FLOW_REINITIATED':              'Flux reinițiat după refuz',
    'FLOW_REINITIATED_AFTER_REVIEW': 'Flux reinițiat după revizuire',
    'REINITIATED_AFTER_REVIEW':      'Reinițiere marcată',
    'PRESIGNED_UPLOAD_DETECTED':     'PDF deja semnat — footer omis',

    // ─── Acțiuni semnatari ────────────────────────────────────────────
    'SIGNED':                        'Semnat și avansat',
    'SIGNED_PDF_UPLOADED':           'PDF semnat încărcat',
    'REFUSED':                       'Refuzat',
    'REVIEW_REQUESTED':              'Trimis la revizuire',
    'SIGN_FAILED':                   'Semnare eșuată',

    // ─── Delegări ─────────────────────────────────────────────────────
    'DELEGATE':                      'Delegare semnătură',
    'DELEGATED':                     'Delegare semnătură',
    'DELEGATION_SET':                'Delegare configurată',
    'DELEGATION_REMOVED':            'Delegare anulată',
    'AUTO_DELEGATED_LEAVE':          'Delegare automată (concediu)',

    // ─── Notificări & comunicare ──────────────────────────────────────
    'YOUR_TURN':                     'Notificat — e rândul tău',
    'EMAIL_SENT':                    'Email extern trimis',
    'EMAIL_OPENED':                  'Email deschis',
    'PDF_DOWNLOADED':                'PDF descărcat',
    'ATTACHMENT_ADDED':              'Atașament adăugat',

    // ─── Administrare utilizatori & organizații ──────────────────────
    'USER_DEACTIVATED':              'Utilizator dezactivat',
    'USER_REACTIVATED':              'Utilizator reactivat',
    'ORGANIZATION_DELETED':          'Organizație ștearsă',
    'ORGANIZATION_REACTIVATED':      'Organizație reactivată',
    'ADMIN_SECRET_ACCESS':           'Acces administrator (secrete)',
    'PASSWORD_CHANGED':              'Parolă schimbată',

    // ─── Drepturi & module ───────────────────────────────────────────
    'entitlement_change':            'Modificare drepturi modul',

    // ─── Integrări specializate ──────────────────────────────────────
    'plata_auto_opme':               'Plată confirmată automat (OPME)',

    // ─── Registratură ────────────────────────────────────────────────
    'registratura_intrare_creata':   'Document intrat înregistrat',
    'registratura_intrare_status':   'Status intrare modificat',
    'registratura_legatura_raspuns': 'Răspuns legat de intrare',

    // ─── Validare PAdES & raport trust ────────────────────────────────
    'CERTIFICATE_EXTRACTED':         'Certificat extras',
    'TRUST_REPORT_GENERATED':        'Raport validare generat',
    'TOKEN_REGENERATED':             'Link semnare reînnoit',

    // ─── Autentificare ───────────────────────────────────────────────
    'auth.login.success':            'Autentificare reușită',
    'auth.login.failed':             'Autentificare eșuată',
    'USER_LOGIN':                    'Autentificare',
    'USER_LOGOUT':                   'Deconectare',

    // ─── Formulare DF/ORD (audit per formular) ───────────────────────
    'creat':                         'Document creat',
    'trimis_p2':                     'Trimis la Responsabil CAB',
    'completat':                     'Completat de Responsabil CAB',
    'legat_alop':                    'Legat de ALOP',
    'returnat':                      'Returnat ca neconform',
    'transmis_flux':                 'Transmis în flux de semnare',
    'revizuit':                      'Revizuit',
    'sters':                         'Șters',
    'neaprobat':                     'Neaprobat de semnatar',
    'flux_refuzat':                  'Flux refuzat',
  };

  async function loadDashboard() {
    try {
      const [sR, fR, aR] = await Promise.all([
        _apiFetch('/admin/stats'),
        _apiFetch('/admin/flows/stats'),
        _apiFetch('/admin/alop/stats'),
      ]);
      const s = sR.ok ? await sR.json() : null;
      const f = fR.ok ? await fR.json() : null;
      const a = aR.ok ? await aR.json() : null;
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = (val != null) ? Number(val).toLocaleString('ro-RO') : '—';
      };
      const setRon = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = (val != null)
          ? Number(val).toLocaleString('ro-RO', { style:'currency', currency:'RON' })
          : '—';
      };
      if (s?.stats) {
        set('dashKpiUsers', s.stats.users);
        set('dashKpiNotif', s.stats.unreadNotifications);
      }
      if (f) {
        set('dashKpiActive', f.active);
        set('dashKpiCompleted', f.completed);
      }
      if (a) {
        set('dashKpiAlopActive', a.alop_active);
        setRon('dashKpiAlopAngajat', a.valoare_angajata_an);
        setRon('dashKpiAlopPlatit', a.valoare_platita_an);
        // Rata de execuție = plătit / angajat (an curent).
        // FĂRĂ plafonare: o rată >100% înseamnă că datele nu se leagă (plăți peste creditele
        // bugetare angajate) — e exact genul de anomalie pe care directorul economic TREBUIE
        // s-o vadă, nu s-o primească ascunsă sub un „100%".
        // Angajat = 0 ⇒ „—", NU „0%". Sunt lucruri diferite: „n-am plătit nimic" vs „n-am angajat nimic".
        // NB: `set()` face `Number(val).toLocaleString()` — ar transforma „46,0%" în NaN → „—".
        // Aici valorile sunt string-uri (procent + subtitlu), deci scriem textContent direct.
        const _ang = Number(a.valoare_angajata_an) || 0;
        const _plt = Number(a.valoare_platita_an)  || 0;
        const _fin = Number(a.alop_finalizate_an)  || 0;
        const _rataEl = document.getElementById('dashKpiAlopRata');
        if (_rataEl) {
          if (_ang > 0) {
            const _rata = (_plt / _ang) * 100;
            _rataEl.textContent = _rata.toLocaleString('ro-RO', {
              minimumFractionDigits: 1, maximumFractionDigits: 1,
            }) + '%';
          } else {
            _rataEl.textContent = '—';
          }
        }
        const _rataSubEl = document.getElementById('dashKpiAlopRataSub');
        if (_rataSubEl) {
          _rataSubEl.textContent =
            'plătit / angajat · ' + _fin + (_fin === 1 ? ' ALOP finalizat' : ' ALOP finalizate');
        }
        // #95 — cardul „Poartă ALOP" (mecanism anti-uitare pentru flipul spre blocare).
        // `gate` vine DOAR pentru role='admin' (backend) → cardul rămâne ascuns altfel.
        // Randare cu textContent/DOM API — NICIODATĂ innerHTML cu interpolare (XSS reparat la #93).
        const _gateCard = document.getElementById('dashKpiAlopGateCard');
        const _gateVal  = document.getElementById('dashKpiAlopGate');
        const _gateSub  = document.getElementById('dashKpiAlopGateSub');
        if (_gateCard && _gateVal && _gateSub) {
          if (a.gate) {
            const _viol = Number(a.gate.violations) || 0;
            const _tot  = Number(a.gate.total_transitions) || 0;
            const _days = (a.gate.days_observed == null) ? null : Number(a.gate.days_observed);
            let _color, _valTxt, _subTxt;
            if (_viol > 0) {
              _color  = 'var(--df-danger)';
              _valTxt = '⚠️ ' + _viol.toLocaleString('ro-RO');
              _subTxt = (_viol === 1 ? '1 violare' : _viol.toLocaleString('ro-RO') + ' violări') + ' — NU activa poarta';
            } else if (_tot === 0) {
              _color  = 'var(--df-text-3)';
              _valTxt = '⚪';
              _subTxt = 'Mod observare · nicio tranziție încă';
            } else if (_days != null && _days >= 7) {
              _color  = 'var(--df-success)';
              _valTxt = '✅';
              _subTxt = 'GATA DE ACTIVARE — flipează trigger-ul';
            } else {
              _color  = 'var(--df-warning)';
              _valTxt = '🟡';
              _subTxt = 'Mod observare · 0 violări · ziua ' + (_days == null ? 0 : _days) + '/7';
            }
            _gateVal.style.color = _color;
            _gateVal.textContent = _valTxt;
            _gateSub.textContent = _subTxt;
            _gateCard.style.display = '';
          } else {
            _gateCard.style.display = 'none';
          }
        }
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
