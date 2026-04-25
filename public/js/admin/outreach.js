(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;

  if (typeof window._orCurrentCampaignId === 'undefined') window._orCurrentCampaignId = null;

  const OR_DEFAULT_TEMPLATE = `<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8faff;padding:36px;border-radius:12px;">
  <div style="text-align:center;margin-bottom:28px;">
    <h1 style="font-size:26px;color:#1a1a2e;margin:0;">DocFlow<span style="color:#1A56DB;">AI</span></h1>
    <p style="color:#64748b;font-size:13px;margin-top:4px;">Architecture for Intelligent Workflows</p>
  </div>
  <p style="color:#1e293b;font-size:15px;line-height:1.7;">Stimată <strong>{{institutie}}</strong>,</p>
  <p style="color:#1e293b;font-size:15px;line-height:1.7;">
    Vă transmitem spre prezentare platforma <strong>DocFlowAI</strong> — o soluție digitală completă
    pentru gestionarea și semnarea electronică a documentelor în instituțiile publice din România.
  </p>
  <div style="background:#EEF2FF;border-left:4px solid #1A56DB;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;">
    <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">Ce oferă DocFlowAI:</p>
    <ul style="margin:8px 0 0 0;padding-left:18px;color:#334155;font-size:14px;line-height:1.8;">
      <li>Flux secvențial de semnare electronică (ÎNTOCMIT · VERIFICAT · VIZAT · APROBAT)</li>
      <li>Notificări automate prin email, push și WhatsApp</li>
      <li>Arhivare automată în Google Drive + jurnal de audit complet</li>
      <li>Securitate avansată: JWT HttpOnly, PBKDF2, CSP, GDPR compliant</li>
    </ul>
  </div>
  <p style="color:#1e293b;font-size:15px;line-height:1.7;">
    Vă propunem o <strong>demonstrație online gratuită de 15 minute</strong>, la data și ora convenabilă dumneavoastră.
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="https://www.docflowai.ro" style="background:#1A56DB;color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Aflați mai multe</a>
  </div>
  <p style="color:#64748b;font-size:13px;margin-top:28px;border-top:1px solid #e2e8f0;padding-top:16px;">
    Cu stimă,<br>
    <strong>Departamentul tehnic</strong><br>
    DocFlowAI · <a href="https://www.docflowai.ro" style="color:#1A56DB;">www.docflowai.ro</a> · 0722.663.961
  </p>
</div>`;

  const OR_CONV_TEMPLATE = `<div style="font-family:Georgia,serif;max-width:580px;margin:0 auto;background:#ffffff;padding:40px 36px;border-radius:4px;border-top:4px solid #1A56DB;">
  <p style="color:#1e293b;font-size:16px;line-height:1.8;margin:0 0 18px 0;">Bună ziua,</p>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    Lucrez cu mai multe instituții publice din România pe o problemă concretă:
    <strong>circuitul intern de documente care necesită semnături multiple</strong> —
    referate, dispoziții, ordine de plată — care circulă în continuare pe hârtie sau prin email,
    fără trasabilitate și fără arhivă sigură.
  </p>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    Am construit <strong>DocFlowAI</strong> ca răspuns la această nevoie:
    un sistem în care inițiatorul încarcă documentul, sistemul îl trimite automat
    fiecărui semnatar în ordine, iar la final totul este arhivat cu jurnal de audit complet.
  </p>
  <div style="background:#f0f4ff;padding:16px 20px;border-radius:8px;margin:20px 0;">
    <p style="margin:0;font-size:14px;color:#1e293b;">
      📋 <strong>{{institutie}}</strong> ar putea digitaliza circuitul de documente în mai puțin de o zi de implementare.
      Nicio infrastructură suplimentară — funcționează complet online, cu certificate calificate eIDAS.
    </p>
  </div>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 24px 0;">
    Vă propun un apel de 15 minute pentru a vedea cum arată concret pentru o instituție ca a dumneavoastră.
    Când ar fi convenabil?
  </p>
  <div style="text-align:left;margin:24px 0;">
    <a href="https://www.docflowai.ro" style="background:#1A56DB;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Programează o demonstrație</a>
  </div>
  <p style="color:#64748b;font-size:13px;margin-top:28px;border-top:1px solid #e8ecf0;padding-top:16px;">
    Departamentul tehnic<br>
    <a href="https://www.docflowai.ro" style="color:#1A56DB;">DocFlowAI</a> · 0722.663.961
  </p>
</div>`;

  const OR_SUBJECT_SUGGESTIONS = [
    'Propunere digitalizare flux documente – DocFlowAI',
    'Semnături electronice calificate pentru {{institutie}} — demonstrație gratuită',
    'Cum elimină {{institutie}} hârtia din circuitul intern de documente',
    'DocFlowAI — flux electronic ÎNTOCMIT→VIZAT→APROBAT pentru instituții publice',
    'O întrebare despre circuitul de documente din {{institutie}}',
  ];

  function orFillDefaultTemplate() {
    $('or-c-body').value = OR_DEFAULT_TEMPLATE;
    $('or-c-subject').value = $('or-c-subject').value || OR_SUBJECT_SUGGESTIONS[0];
  }

  function orFillConvTemplate() {
    $('or-c-body').value = OR_CONV_TEMPLATE;
    $('or-c-subject').value = OR_SUBJECT_SUGGESTIONS[4];
    $('or-c-body').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function orInit() {
    await orLoadStats();
    await orLoadCampaigns();
    await prRefreshCampaignSelect();
    prLoad(1);
  }

  async function orLoadStats() {
    try {
      const r = await fetch('/admin/outreach/stats', { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      $('or-stat-today').textContent    = d.sentToday ?? '—';
      $('or-stat-total').textContent    = d.total_sent ?? '—';
      $('or-stat-opened').textContent   = d.total_opened ?? '—';
      $('or-limit-display').textContent = `${d.sentToday ?? 0} / ${d.dailyLimit ?? 100}`;
    } catch(e) { /* silent */ }
  }

  async function orLoadCampaigns() {
    const el = $('or-campaigns-list');
    el.innerHTML = '<div style="color:var(--muted);font-size:.84rem;padding:12px 0;">⏳ Se încarcă...</div>';
    try {
      const r = await fetch('/admin/outreach/campaigns', { credentials: 'include' });
      const d = await r.json();
      const cntCamp = document.getElementById('outreachCampaignsCount'); if (cntCamp) cntCamp.textContent = d.campaigns?.length || 0;
      if (!d.campaigns?.length) {
        el.innerHTML = '<div style="color:var(--muted);font-size:.84rem;padding:12px 0;">Nicio campanie. Creează prima campanie mai sus.</div>';
        return;
      }
      el.innerHTML = d.campaigns.map(c => {
        const pct = c.total_recipients > 0 ? Math.round((+c.sent_count / +c.total_recipients) * 100) : 0;
        const openPct = c.sent_count > 0 ? Math.round((+c.opened_count / +c.sent_count) * 100) : 0;
        const clickPct = c.sent_count > 0 ? Math.round((+c.click_count / +c.sent_count) * 100) : 0;
        return `<div onclick="orSelectCampaign(${c.id})" style="display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:${window._orCurrentCampaignId===c.id?'rgba(124,92,255,.12)':'rgba(255,255,255,.02)'};cursor:pointer;margin-bottom:8px;transition:background .15s;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:.88rem;color:var(--text);">${esc(c.name)}</div>
            <div style="font-size:.76rem;color:var(--muted);margin-top:3px;">${esc(c.subject)}</div>
            <div style="font-size:.74rem;color:var(--muted);margin-top:2px;">Creat de ${esc(c.created_by)} · ${new Date(c.created_at).toLocaleDateString('ro-RO')}</div>
          </div>
          <div style="display:flex;gap:14px;text-align:center;flex-shrink:0;">
            <div><div style="font-size:1.1rem;font-weight:700;color:#9db0ff;">${c.total_recipients}</div><div style="font-size:.7rem;color:var(--muted);">destinatari</div></div>
            <div><div style="font-size:1.1rem;font-weight:700;color:#7cf0e0;">${c.sent_count}</div><div style="font-size:.7rem;color:var(--muted);">trimiși ${pct}%</div></div>
            <div title="Deschideri via pixel — nesigure, blocate de Gmail/Outlook/Apple Mail"><div style="font-size:1.1rem;font-weight:700;color:#a3e6a3;">${c.opened_count}</div><div style="font-size:.7rem;color:var(--muted);">deschis ${openPct}% ⚠</div></div>
            <div title="Click-uri pe linkuri — metrica reala, fiabila 100%"><div style="font-size:1.1rem;font-weight:700;color:#ffd580;">${c.click_count}</div><div style="font-size:.7rem;color:#ffd580;font-weight:700;">clickuri ${clickPct}% ★</div></div>
            ${+c.pending_count > 0 ? `<div><div style="font-size:1.1rem;font-weight:700;color:#ffd580;">${c.pending_count}</div><div style="font-size:.7rem;color:var(--muted);">pending</div></div>` : ''}
            ${+c.error_count > 0   ? `<div><div style="font-size:1.1rem;font-weight:700;color:#ffaaaa;">${c.error_count}</div><div style="font-size:.7rem;color:var(--muted);">erori</div></div>` : ''}
          </div>
        </div>`;
      }).join('');
    } catch(e) {
      el.innerHTML = '<div style="color:#ffaaaa;font-size:.84rem;padding:12px 0;">Eroare la încărcare campanii.</div>';
    }
  }

  async function orSelectCampaign(id) {
    window._orCurrentCampaignId = id;
    await orLoadCampaigns();
    await orLoadDetail(id);
    $('or-detail-panel').style.display = '';
    $('or-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function orLoadDetail(id) {
    try {
      const r = await fetch(`/admin/outreach/campaigns/${id}`, { credentials: 'include' });
      if (!r.ok) return;
      const { campaign: c, recipients } = await r.json();
      $('or-detail-name').textContent = c.name;

      const total   = recipients.length;
      const sent    = recipients.filter(r => r.status === 'sent' || r.status === 'opened').length;
      const opened  = recipients.filter(r => r.status === 'opened').length;
      const clicked = recipients.filter(r => r.clicked_at).length;
      const pending = recipients.filter(r => r.status === 'pending').length;
      const errors  = recipients.filter(r => r.status === 'error').length;
      $('or-detail-stats').innerHTML = [
        ['Total', total, '#9db0ff'],
        ['Pending', pending, '#b0b0b0'],
        ['Trimiși', sent, '#7cf0e0'],
        ['Deschis ⚠', opened, '#a3e6a3'],
        ['Clickuri ★', clicked, '#ffd580'],
        ['Erori', errors, '#ffaaaa'],
      ].map(([l, v, col]) => `<span style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);padding:5px 14px;border-radius:20px;font-size:.8rem;"><strong style="color:${col};">${v}</strong> <span style="color:var(--muted);">${l}</span></span>`).join('');

      const existingWarning = document.getElementById('or-metrics-warning');
      if (!existingWarning) {
        const statsEl = $('or-detail-stats');
        if (statsEl && statsEl.parentNode) {
          const warn = document.createElement('div');
          warn.id = 'or-metrics-warning';
          warn.style.cssText = 'background:rgba(255,213,128,.07);border:1px solid rgba(255,213,128,.2);border-radius:8px;padding:10px 14px;margin-top:10px;font-size:.78rem;color:#ffd580;line-height:1.5;';
          warn.innerHTML = '<strong>⚠ Despre acuratețea metricilor:</strong> Deschiderile (pixel GIF) sunt blocate de Gmail, Outlook și Apple Mail — cifrele sunt <em>sub-raportate</em>. <strong style="color:#ffd580;">Click-urile ★ sunt metrica fiabilă</strong> — înseamnă că destinatarul a acționat efectiv pe un link din email. Raportul <strong>clickuri/trimiși</strong> este indicatorul real de interes.';
          statsEl.parentNode.insertBefore(warn, statsEl.nextSibling);
        }
      }

      $('or-recip-count').textContent = `${total} destinatar${total !== 1 ? 'i' : ''}`;

      const tbody = $('or-recip-tbody');
      if (!recipients.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--muted);">Niciun destinatar adăugat încă.</td></tr>';
        return;
      }
      const statusBadge = {
        pending: '<span style="background:rgba(255,213,0,.12);color:#ffd580;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">pending</span>',
        sent:    '<span style="background:rgba(45,212,191,.12);color:#7cf0e0;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">trimis</span>',
        opened:  '<span style="background:rgba(163,230,163,.15);color:#a3e6a3;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">deschis ✓</span>',
        error:   '<span style="background:rgba(255,80,80,.12);color:#ffaaaa;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;">eroare</span>',
      };
      tbody.innerHTML = recipients.map(r => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:7px 10px;color:var(--text);">${esc(r.email)}</td>
        <td style="padding:7px 10px;color:var(--muted);font-size:.8rem;">${esc(r.institutie || '—')}</td>
        <td style="padding:7px 10px;text-align:center;">${statusBadge[r.status] || r.status}</td>
        <td style="padding:7px 10px;text-align:center;color:var(--muted);font-size:.75rem;">${r.sent_at ? new Date(r.sent_at).toLocaleString('ro-RO') : '—'}</td>
        <td style="padding:7px 10px;text-align:center;color:var(--muted);font-size:.75rem;">${r.opened_at ? new Date(r.opened_at).toLocaleString('ro-RO') : '—'}</td>
        <td style="padding:7px 10px;text-align:center;font-size:.75rem;">${r.clicked_at ? `<span style="color:#ffd580;font-weight:700;">★ ${r.click_count}x</span><br><span style="color:var(--muted);font-size:.7rem;">${new Date(r.clicked_at).toLocaleString('ro-RO')}</span>` : '<span style="color:var(--muted);">—</span>'}</td>
        <td style="padding:7px 10px;text-align:center;">${r.status === 'pending' ? `<button onclick="orDeleteRecipient(${r.id})" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:.8rem;" title="Șterge">✕</button>` : ''}</td>
      </tr>`).join('');
    } catch(e) {
      console.warn('[orLoadDetail]', e);
    }
  }

  async function orCreateCampaign() {
    const name      = ($('or-c-name').value || '').trim();
    const subject   = ($('or-c-subject').value || '').trim();
    const html_body = ($('or-c-body').value || '').trim();
    const st = $('or-c-status');
    if (!name || !subject || !html_body) {
      st.textContent = '⚠ Completează toate câmpurile obligatorii.';
      st.style.color = '#ffaaaa';
      return;
    }
    st.textContent = '⏳ Se creează...'; st.style.color = 'var(--muted)';
    try {
      const r = await fetch('/admin/outreach/campaigns', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, subject, html_body }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      st.textContent = '✅ Campanie creată!'; st.style.color = '#a3e6a3';
      $('or-c-name').value = '';
      await orLoadCampaigns();
      await prRefreshCampaignSelect();
      setTimeout(() => orSelectCampaign(d.campaign.id), 300);
    } catch(e) {
      st.textContent = '⚠ ' + e.message; st.style.color = '#ffaaaa';
    }
  }

  async function orAddRecipients() {
    if (!window._orCurrentCampaignId) return;
    const email = ($('or-add-email').value || '').trim();
    const inst  = ($('or-add-inst').value || '').trim();
    const csv   = ($('or-add-csv').value || '').trim();
    const st    = $('or-add-status');

    let body = {};
    if (csv) {
      body = { csv };
    } else if (email) {
      body = { recipients: [{ email, institutie: inst }] };
    } else {
      st.textContent = '⚠ Introdu un email sau CSV.'; st.style.color = '#ffaaaa'; return;
    }

    st.textContent = '⏳...'; st.style.color = 'var(--muted)';
    try {
      const r = await fetch(`/admin/outreach/campaigns/${window._orCurrentCampaignId}/recipients`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      st.textContent = `✅ ${d.added} adăugat${d.added !== 1 ? 'e' : ''}${d.skipped ? ` · ${d.skipped} existau deja` : ''}.`;
      st.style.color = '#a3e6a3';
      $('or-add-email').value = ''; $('or-add-inst').value = ''; $('or-add-csv').value = '';
      await orLoadDetail(window._orCurrentCampaignId);
      await orLoadCampaigns();
    } catch(e) {
      st.textContent = '⚠ ' + e.message; st.style.color = '#ffaaaa';
    }
  }

  async function orDeleteRecipient(rid) {
    if (!window._orCurrentCampaignId) return;
    try {
      await fetch(`/admin/outreach/campaigns/${window._orCurrentCampaignId}/recipients/${rid}`, {
        method: 'DELETE', credentials: 'include',
      });
      await orLoadDetail(window._orCurrentCampaignId);
      await orLoadCampaigns();
    } catch(e) { /* silent */ }
  }

  async function orSendBatch() {
    if (!window._orCurrentCampaignId) return;
    const btn = $('or-btn-send');
    const st  = $('or-send-status');
    btn.disabled = true; btn.textContent = '⏳ Se trimite...';
    st.textContent = ''; st.style.color = 'var(--muted)';
    try {
      const r = await fetch(`/admin/outreach/campaigns/${window._orCurrentCampaignId}/send`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchSize: 50 }),
      });
      const d = await r.json();
      if (r.status === 429) throw new Error(d.message);
      if (!r.ok) throw new Error(d.message || d.error);
      st.textContent = `✅ ${d.sent} trimise, ${d.errors} erori · Azi: ${d.sentToday}/${d.dailyLimit} · Rămase azi: ${d.remainingToday}`;
      st.style.color = d.errors > 0 ? '#ffd580' : '#a3e6a3';
      await orLoadStats();
      await orLoadDetail(window._orCurrentCampaignId);
      await orLoadCampaigns();
    } catch(e) {
      st.textContent = '⚠ ' + e.message; st.style.color = '#ffaaaa';
    } finally {
      btn.disabled = false; btn.textContent = '▶ Trimite batch (50)';
    }
  }

  async function orResetErrors() {
    if (!window._orCurrentCampaignId) return;
    try {
      const r = await fetch(`/admin/outreach/campaigns/${window._orCurrentCampaignId}/reset-errors`, {
        method: 'POST', credentials: 'include',
      });
      const d = await r.json();
      $('or-send-status').textContent = `🔁 ${d.reset} erori resetate la pending.`;
      $('or-send-status').style.color = '#ffd580';
      await orLoadDetail(window._orCurrentCampaignId);
      await orLoadCampaigns();
    } catch(e) { /* silent */ }
  }

  async function orDeleteCampaign() {
    if (!window._orCurrentCampaignId) return;
    if (!confirm('Ștergi campania și toți destinatarii ei? Acțiune ireversibilă.')) return;
    try {
      await fetch(`/admin/outreach/campaigns/${window._orCurrentCampaignId}`, {
        method: 'DELETE', credentials: 'include',
      });
      window._orCurrentCampaignId = null;
      $('or-detail-panel').style.display = 'none';
      await orLoadCampaigns();
      await orLoadStats();
      await prRefreshCampaignSelect();
    } catch(e) { /* silent */ }
  }

  window.orFillDefaultTemplate = orFillDefaultTemplate;
  window.orFillConvTemplate    = orFillConvTemplate;
  window.orInit                = orInit;
  window.orLoadStats           = orLoadStats;
  window.orLoadCampaigns       = orLoadCampaigns;
  window.orSelectCampaign      = orSelectCampaign;
  window.orLoadDetail          = orLoadDetail;
  window.orCreateCampaign      = orCreateCampaign;
  window.orAddRecipients       = orAddRecipients;
  window.orDeleteRecipient     = orDeleteRecipient;
  window.orSendBatch           = orSendBatch;
  window.orResetErrors         = orResetErrors;
  window.orDeleteCampaign      = orDeleteCampaign;

  window.df._outreachModuleLoaded = true;
})();
