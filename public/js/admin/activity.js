(function() {
  'use strict';
  const $ = window.df.$;
  const esc = window.df.esc;
  const downloadBlob = window.df.downloadBlob;
  const parseDMYtoISO = window.df.parseDMYtoISO;
  const isoToDMY = window.df.isoToDMY;

  let _activityData = null;
  let _rptGenerated = false;

  const OP_LABELS_RO = {
    FLOW_CREATED:                   'Flux inițiat',
    SIGNED:                         'Semnat și avansat',
    SIGNED_PDF_UPLOADED:            'PDF semnat încărcat',
    REFUSED:                        'Refuzat',
    REVIEW_REQUESTED:               'Trimis la revizuire',
    FLOW_REINITIATED:               'Flux reinițiat după refuz',
    FLOW_REINITIATED_AFTER_REVIEW:  'Reinițiat după revizuire',
    REINITIATED_AFTER_REVIEW:       'Reinițiere marcată',
    FLOW_COMPLETED:                 'Flux finalizat',
    FLOW_CANCELLED:                 'Flux anulat',
    DELEGATE:                       'Delegare semnătură',
    DELEGATED:                      'Delegare semnătură',
    YOUR_TURN:                      'Notificat',
    EMAIL_SENT:                     'Email extern trimis',
  };

  const OP_COLORS = {
    FLOW_CREATED: '#7c5cff', SIGNED_PDF_UPLOADED: '#2dd4bf', REFUSED: '#ff5050',
    REVIEW_REQUESTED: '#ffd580', FLOW_REINITIATED: '#ff9955', FLOW_REINITIATED_AFTER_REVIEW: '#ff9955',
    FLOW_COMPLETED: '#26d07c', FLOW_CANCELLED: '#888888', DELEGATE: '#9db0ff', YOUR_TURN: '#aaa',
    REINITIATED_AFTER_REVIEW: '#ffaaaa', EMAIL_SENT: '#2dd4bf',
  };
  const OP_ICONS = {
    FLOW_CREATED: '📝', SIGNED_PDF_UPLOADED: '✅', REFUSED: '⛔',
    REVIEW_REQUESTED: '🔄', FLOW_REINITIATED: '🔁', FLOW_REINITIATED_AFTER_REVIEW: '🔁',
    FLOW_COMPLETED: '🏁', FLOW_CANCELLED: '🚫', DELEGATE: '👥', YOUR_TURN: '🔔',
    REINITIATED_AFTER_REVIEW: '🔁', EMAIL_SENT: '📧',
  };

  /** Formatează Date object → zz.ll.aaaa */
  function dateToDMY(d) {
    if (!d || isNaN(d.getTime())) return '';
    return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + d.getFullYear();
  }

  /** Formatează Date object → YYYY-MM-DD */
  function dateToISO(d) {
    if (!d || isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  /** Handler pentru input text zz.ll.aaaa — auto-punctuație + sync către hidden date */
  function onDateTextInput(el, hiddenId) {
    let v = el.value.replace(/[^0-9.]/g,'');
    const digits = v.replace(/\./g,'');
    if (digits.length > 2 && !v.includes('.')) v = digits.slice(0,2) + '.' + digits.slice(2);
    if (digits.length > 4) {
      const parts = v.split('.');
      if (parts.length >= 2 && parts[1].length > 2) {
        v = parts[0] + '.' + parts[1].slice(0,2) + '.' + parts[1].slice(2) + (parts[2]||'');
      }
    }
    v = v.slice(0,10);
    el.value = v;
    const iso = parseDMYtoISO(v);
    const hidden = $(hiddenId);
    if (hidden) hidden.value = iso || '';
    el.style.borderColor = v.length === 10 ? (iso ? 'rgba(45,212,191,.5)' : 'rgba(255,80,80,.5)') : '';
  }

  /** Handler pentru calendar picker — sync înapoi în textbox */
  function onDatePickerChange(pickerEl, displayId) {
    const iso = pickerEl.value;
    if (iso) { const disp = $(displayId); if (disp) { disp.value = isoToDMY(iso); disp.style.borderColor = 'rgba(45,212,191,.5)'; } }
  }

  function initActivityReport() {
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const todayISO = dateToISO(today);
    const fromISO  = dateToISO(firstOfMonth);
    $('rptFrom').value        = fromISO;
    $('rptTo').value          = todayISO;
    $('rptFromDisplay').value = isoToDMY(fromISO);
    $('rptToDisplay').value   = isoToDMY(todayISO);
    _rptGenerated = false;

    _apiFetch('/admin/users', { headers: hdrs() }).then(r => r.json()).then(data => {
      _rptGenerated = true;
      window._rptUsers = data.users || data || [];
      _rebuildRptInst();
    }).catch(() => {});
  }

  function _rebuildRptInst() {
    const users = window._rptUsers || [];
    const rptInst = $('rptInst');
    const prevInst = rptInst.value;
    rptInst.innerHTML = '<option value="">— Toate instituțiile —</option>';
    const insts = [...new Set(users.map(u => u.institutie).filter(Boolean))].sort();
    insts.forEach(i => { const o = document.createElement('option'); o.value = i; o.textContent = i; rptInst.appendChild(o); });
    if (prevInst) rptInst.value = prevInst;
    if (window._orgAdminInstitutie) {
      let found=false; for(const o of rptInst.options){if(o.value===window._orgAdminInstitutie){found=true;break;}}
      if(!found){const o=new Option(window._orgAdminInstitutie,window._orgAdminInstitutie);rptInst.appendChild(o);}
      rptInst.value=window._orgAdminInstitutie; rptInst.disabled=true;
      rptInst.style.cssText+=';background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3);color:#2dd4bf;cursor:not-allowed;';
    }
    _rebuildRptDept();
  }

  function onRptInstChange() {
    _rebuildRptDept();
    _rebuildRptUser();
    if (_rptGenerated) loadActivityReport();
  }

  function _rebuildRptDept() {
    const inst = $('rptInst').value;
    const deptSel = $('rptDept');
    const prevDept = deptSel.value;
    deptSel.innerHTML = '<option value="">— Toate compartimentele —</option>';
    if (inst && window._rptUsers) {
      const depts = [...new Set(window._rptUsers
        .filter(u => u.institutie === inst)
        .map(u => u.compartiment).filter(Boolean))].sort();
      depts.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; deptSel.appendChild(o); });
      deptSel.disabled = depts.length === 0;
      if (prevDept) deptSel.value = prevDept;
    } else {
      deptSel.disabled = true;
    }
    _rebuildRptUser();
  }

  function onRptDeptChange() { _rebuildRptUser(); if (_rptGenerated) loadActivityReport(); }

  function _rebuildRptUser() {
    const inst = $('rptInst').value;
    const dept = $('rptDept').value;
    const userSel = $('rptUser');
    const prevEmail = userSel.value;
    userSel.innerHTML = '<option value="">— Toți utilizatorii —</option>';
    let filtered = window._rptUsers || [];
    if (inst) filtered = filtered.filter(u => u.institutie === inst);
    if (dept) filtered = filtered.filter(u => u.compartiment === dept);
    filtered.sort((a,b) => (a.nume||'').localeCompare(b.nume||''));
    filtered.forEach(u => {
      const o = document.createElement('option');
      o.value = u.email;
      o.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
      userSel.appendChild(o);
    });
    if (prevEmail) userSel.value = prevEmail;
  }

  function onRptUserChange() {
    const email = $('rptUser').value;
    if (email && window._rptUsers) {
      const u = window._rptUsers.find(x => x.email === email);
      if (u && u.institutie && !$('rptInst').value) {
        $('rptInst').value = u.institutie;
        _rebuildRptDept();
        $('rptUser').value = email;
      }
    }
    if (_rptGenerated) loadActivityReport();
  }

  async function loadActivityReport() {
    const area = $('activityReport');
    const fromDisp = ($('rptFromDisplay').value||'').trim();
    const toDisp   = ($('rptToDisplay').value||'').trim();
    if (fromDisp.length === 10) { const iso = parseDMYtoISO(fromDisp); if (iso) $('rptFrom').value = iso; }
    if (toDisp.length === 10)   { const iso = parseDMYtoISO(toDisp);   if (iso) $('rptTo').value = iso; }

    const fromISO = $('rptFrom').value;
    const toISO   = $('rptTo').value;

    if (!fromISO || !toISO) {
      area.innerHTML = '<p style="color:#ffaaaa;font-size:.85rem;">⚠️ Selectează intervalul de date (format: zz.ll.aaaa).</p>';
      return;
    }
    if (fromISO > toISO) {
      area.innerHTML = '<p style="color:#ffaaaa;font-size:.85rem;">⚠️ Data de început trebuie să fie înainte de data de sfârșit.</p>';
      return;
    }

    area.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);">⏳ Se generează raportul...</div>';
    try {
      const params = new URLSearchParams({ from: fromISO, to: toISO });
      const email = $('rptUser').value;
      const inst  = $('rptInst').value;
      const dept  = $('rptDept').value;
      if (email) params.set('email', email);
      else if (inst) params.set('institutie', inst);
      if (dept)  params.set('compartiment', dept);
      const r = await _apiFetch(`/admin/user-activity?${params}`, { headers: hdrs() });
      if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || `HTTP ${r.status}`); }
      const data = await r.json();
      _activityData = data;
      renderActivityReport(data);
    } catch(e) {
      area.innerHTML = `<p style="color:#ffaaaa;font-size:.85rem;">❌ ${esc(e.message)}</p>`;
    }
  }

  function renderActivityReport(data) {
    const area = $('activityReport');
    const users = (data.users || []).filter(u => u.totalOps > 0 || $('rptUser').value);
    const from = isoToDMY(data.from);
    const to   = isoToDMY(data.to);

    if (!users.length) {
      area.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);">\u{1F4ED} Nicio activitate găsită în intervalul ' + from + ' — ' + to + '.</div>';
      return;
    }

    let html = '<div style="margin-bottom:16px;font-size:.83rem;color:var(--muted);">Interval: <strong style="color:var(--sub);">' + from + ' — ' + to + '</strong> &nbsp;·&nbsp; ' + users.length + ' utilizator(i) cu activitate</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:24px;">';

    for (const u of users) {
      if (!u.totalOps && !$('rptUser').value) continue;
      const emailKey = u.email.replace(/[^a-z0-9]/gi,'_');
      const emailEsc = u.email.replace(/'/g,"\\'");
      const sub2 = [u.functie||u.email, u.institutie, u.compartiment].filter(Boolean).join(' · ');

      const summaryChips = Object.entries(u.counts)
        .sort((a,b) => b[1]-a[1])
        .map(([type, cnt]) => {
          const color = OP_COLORS[type] || '#9db0ff';
          const icon  = OP_ICONS[type]  || '•';
          const label = OP_LABELS_RO[type] || type.replace(/_/g,' ');
          return '<span onclick="toggleUserDetailByType(\'' + emailEsc + '\',\'' + type + '\')" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:.72rem;background:' + color + '22;border:1px solid ' + color + '44;color:' + color + ';margin:2px;cursor:pointer;" title="Click pentru a vedea doar aceste operațiuni">' + icon + ' ' + cnt + '× ' + label + '</span>';
        }).join('');

      html += '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-weight:700;font-size:.92rem;margin-bottom:2px;">' + esc(u.name||u.email) + '</div>'
        + '<div style="font-size:.76rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(u.email) + '">' + esc(sub2) + '</div>'
        + '</div>'
        + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:10px;">'
        + '<div style="font-size:1.4rem;font-weight:800;color:var(--accent);">' + u.totalOps + '</div>'
        + '<button onclick="exportUserPDF(\'' + emailEsc + '\')" style="padding:4px 10px;font-size:.72rem;background:rgba(157,176,255,.12);border:1px solid rgba(157,176,255,.3);border-radius:7px;color:#9db0ff;cursor:pointer;white-space:nowrap;" title="Export raport utilizator">\u{1F4C4} PDF</button>'
        + '</div></div>'
        + '<div>' + (summaryChips || '<span style="font-size:.75rem;color:var(--muted);">Nicio operațiune</span>') + '</div>'
        + '<div onclick="toggleUserDetail(\'' + emailEsc + '\')" style="font-size:.71rem;color:var(--muted);margin-top:8px;text-align:right;cursor:pointer;">▼ click pentru detalii</div>'
        + '<div id="detail_' + emailKey + '" style="display:none;margin-top:14px;border-top:1px solid rgba(255,255,255,.06);padding-top:12px;max-height:320px;overflow-y:auto;"></div>'
        + '</div>';
    }
    html += '</div>';
    area.innerHTML = html;
  }

  function _buildDetailRows(ops, filterType) {
    const filtered = filterType ? ops.filter(op => op.type === filterType) : ops;
    if (!filtered.length) return '<div style="font-size:.8rem;color:var(--muted);">Nicio operațiune de acest tip.</div>';
    return filtered.map(op => {
      const color = OP_COLORS[op.type] || '#9db0ff';
      const icon  = OP_ICONS[op.type]  || '•';
      const labelRO = OP_LABELS_RO[op.type] || esc(op.label || op.type);
      const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone:'Europe/Bucharest', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      return '<div style="display:grid;grid-template-columns:110px 200px 1fr;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);">'
        + '<span style="font-size:.74rem;color:var(--muted);">' + dt + '</span>'
        + '<span style="font-size:.76rem;padding:2px 8px;border-radius:12px;background:' + color + '22;border:1px solid ' + color + '44;color:' + color + ';">' + icon + ' ' + labelRO + '</span>'
        + '<span style="font-size:.76rem;color:var(--sub);" title="' + esc(op.flowId) + '">' + esc(op.docName) + (op.reason ? ' <span style="color:var(--muted);">— ' + esc(op.reason) + '</span>' : '') + '</span>'
        + '</div>';
    }).join('');
  }

  function toggleUserDetail(email) {
    const key = email.replace(/[^a-z0-9]/gi,'_');
    const el = document.getElementById('detail_' + key);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; el.dataset.activeType = ''; return; }
    const u = (_activityData?.users||[]).find(x => x.email === email);
    if (!u) return;
    el.innerHTML = _buildDetailRows(u.ops || [], null);
    el.dataset.activeType = '';
    el.style.display = '';
  }

  function toggleUserDetailByType(email, type) {
    const key = email.replace(/[^a-z0-9]/gi,'_');
    const el = document.getElementById('detail_' + key);
    if (!el) return;
    const u = (_activityData?.users||[]).find(x => x.email === email);
    if (!u) return;
    if (el.style.display !== 'none' && el.dataset.activeType === type) { el.style.display = 'none'; el.dataset.activeType = ''; return; }
    el.innerHTML = _buildDetailRows(u.ops || [], type);
    el.dataset.activeType = type;
    el.style.display = '';
  }

  function exportUserPDF(email) {
    const u = (_activityData?.users||[]).find(x => x.email === email);
    if (!u) return;
    const from = isoToDMY(_activityData?.from);
    const to   = isoToDMY(_activityData?.to);

    const rows = (u.ops||[]).map(op => {
      const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone:'Europe/Bucharest', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const labelRO = OP_LABELS_RO[op.type] || op.label || op.type;
      return `<tr><td>${dt}</td><td>${esc(labelRO)}</td><td>${esc(op.docName||'—')}</td><td>${esc(op.reason||'—')}</td></tr>`;
    }).join('');

    const chips = Object.entries(u.counts).map(([type,cnt]) =>
      `<span style="display:inline-block;padding:2px 10px;margin:2px;border-radius:12px;background:#e8eaff;color:#333;font-size:11px;">${OP_ICONS[type]||'•'} ${cnt}× ${esc(OP_LABELS_RO[type]||type)}</span>`
    ).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Raport activitate — ${esc(u.name||u.email)}</title>
  <style>
    @page { size: A4 landscape; margin: 15mm; }
    body { font-family: Arial, sans-serif; color: #111; font-size: 12px; }
    h1 { font-size: 16px; color: #1a237e; margin-bottom: 4px; }
    .sub { color: #555; font-size: 11px; margin-bottom: 14px; line-height: 1.6; }
    .chips { margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background: #1a237e; color: #fff; padding: 6px 10px; text-align: left; font-size: 11px; }
    td { padding: 5px 10px; border-bottom: 1px solid #e0e0e0; font-size: 11px; }
    tr:nth-child(even) td { background: #f5f6ff; }
    .footer { margin-top: 20px; font-size: 9px; color: #999; border-top: 1px solid #eee; padding-top: 6px; }
  </style>
</head><body>
  <h1>Raport activitate — ${esc(u.name||u.email)}</h1>
  <div class="sub">
    ${esc(u.functie||'')}${u.institutie?' · '+esc(u.institutie):''}${u.compartiment?' / '+esc(u.compartiment):''}<br>
    Email: ${esc(u.email)} &nbsp;|&nbsp; Interval: ${from} — ${to} &nbsp;|&nbsp; Total: <strong>${u.totalOps}</strong> operatiuni
  </div>
  <div class="chips">${chips}</div>
  <table>
    <thead><tr><th>Data si ora</th><th>Operatiune</th><th>Document</th><th>Motiv / Detalii</th></tr></thead>
    <tbody>${rows||'<tr><td colspan="4" style="text-align:center;color:#999;">Nicio operatiune in acest interval.</td></tr>'}</tbody>
  </table>
  <div class="footer">Generat de DocFlowAI · ${new Date().toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})}</div>
  </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  }

  function exportActivityPDF() {
    if (!_activityData) { alert('Genereaza mai intai un raport.'); return; }
    const from  = isoToDMY(_activityData?.from);
    const to    = isoToDMY(_activityData?.to);
    const users = (_activityData.users||[]).filter(u => u.totalOps > 0);

    const userSections = users.map(u => {
      const chips = Object.entries(u.counts).map(([type,cnt]) =>
        `<span style="display:inline-block;padding:1px 8px;margin:2px;border-radius:10px;background:#e8eaff;color:#333;font-size:10px;">${OP_ICONS[type]||'•'} ${cnt}× ${esc(OP_LABELS_RO[type]||type)}</span>`
      ).join('');
      const rows = (u.ops||[]).map(op => {
        const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone:'Europe/Bucharest', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        return `<tr><td>${dt}</td><td>${esc(OP_LABELS_RO[op.type]||op.label||op.type)}</td><td>${esc(op.docName||'—')}</td><td>${esc(op.reason||'—')}</td></tr>`;
      }).join('');
      const sub = [u.functie, u.institutie, u.compartiment].filter(Boolean).join(' · ');
      return `<div class="user-section">
        <div class="user-header"><strong>${esc(u.name||u.email)}</strong><span class="badge">${u.totalOps} operatiuni</span></div>
        <div class="user-sub">${esc(sub||u.email)}</div>
        <div class="chips">${chips}</div>
        <table><thead><tr><th>Data si ora</th><th>Operatiune</th><th>Document</th><th>Motiv</th></tr></thead>
        <tbody>${rows||'<tr><td colspan="4" style="color:#999;text-align:center;">—</td></tr>'}</tbody></table>
      </div>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Raport activitate — ${from} — ${to}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    body { font-family: Arial, sans-serif; color: #111; font-size: 11px; }
    h1 { font-size: 18px; color: #1a237e; margin-bottom: 4px; }
    .sub-title { color: #555; margin-bottom: 18px; font-size: 11px; }
    .user-section { margin-bottom: 22px; page-break-inside: avoid; border: 1px solid #dde; border-radius: 4px; padding: 12px; }
    .user-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; font-size: 13px; }
    .badge { background: #1a237e; color: #fff; padding: 2px 10px; border-radius: 12px; font-size: 10px; }
    .user-sub { color: #666; font-size: 10px; margin-bottom: 6px; }
    .chips { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1a237e; color: #fff; padding: 4px 8px; text-align: left; font-size: 10px; }
    td { padding: 3px 8px; border-bottom: 1px solid #eee; font-size: 10px; }
    .footer { margin-top: 16px; font-size: 9px; color: #999; border-top: 1px solid #eee; padding-top: 6px; }
  </style>
</head><body>
  <h1>Raport activitate utilizatori</h1>
  <div class="sub-title">Interval: <strong>${from} — ${to}</strong> &nbsp;|&nbsp; ${users.length} utilizator(i) cu activitate</div>
  ${userSections||'<p style="color:#999;text-align:center;">Nicio activitate in acest interval.</p>'}
  <div class="footer">Generat de DocFlowAI · ${new Date().toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})}</div>
  </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  }

  async function exportFlowsCSV() {
    const search = (document.getElementById('flowSearch').value || '').trim();
    const statusF = document.getElementById('flowStatusFilter').value;
    const instF = document.getElementById('flowInstFilter').value;
    const deptF = document.getElementById('flowDeptFilter').value;
    const statusMap = { active: 'pending', done: 'completed', refused: 'refused', cancelled: 'cancelled', '': 'all' };
    const params = new URLSearchParams({ export: '1', limit: '2000', status: statusMap[statusF] || 'all' });
    if (search) params.set('search', search);
    if (instF) params.set('institutie', instF);
    if (deptF) params.set('compartiment', deptF);
    try {
      const r = await _apiFetch('/admin/flows/list?' + params.toString(), { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server ' + r.status);
      const resp = await r.json();
      const flows = Array.isArray(resp) ? resp : (resp.flows || []);
      if (!flows.length) { alert('Nu există fluxuri de exportat cu filtrele curente.'); return; }
      const escCsv = v => '"' + String(v || '').replace(/"/g, '""') + '"';
      const headers = ['ID Flux','Document','Initiator Email','Initiator Nume','Status','Urgent','Institutie','Compartiment','Creat','Nr Semnatari','Semnatari (Nume | Email | Rol | Status | Semnat la)'];
      const rows = flows.map(f => {
        const status = f.completed ? 'finalizat' : f.status === 'refused' ? 'refuzat' : 'activ';
        const signersSummary = (f.signers || []).map(s => {
          const signedAt = s.signedAt ? new Date(s.signedAt).toLocaleDateString('ro-RO') : '-';
          return `${s.name || '-'} | ${s.email || '-'} | ${s.rol || '-'} | ${s.status || '-'} | ${signedAt}`;
        }).join(' // ');
        return [
          f.flowId, f.docName, f.initEmail, f.initName || '-',
          status, f.urgent ? 'DA' : 'Nu',
          f.institutie || '-', f.compartiment || '-',
          f.createdAt ? new Date(f.createdAt).toLocaleDateString('ro-RO') : '-',
          (f.signers || []).length,
          signersSummary
        ].map(escCsv);
      });
      const csv = [headers.map(h => '"' + h + '"').join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      downloadBlob(blob, 'fluxuri_' + new Date().toISOString().slice(0, 10) + '.csv');
    } catch(e) { alert('Eroare export CSV: ' + e.message); }
  }

  async function exportFlowsPDF() {
    const search = (document.getElementById('flowSearch').value || '').trim();
    const statusF = document.getElementById('flowStatusFilter').value;
    const instF = document.getElementById('flowInstFilter').value;
    const deptF = document.getElementById('flowDeptFilter').value;
    const statusMap = { active: 'pending', done: 'completed', refused: 'refused', cancelled: 'cancelled', '': 'all' };
    const params = new URLSearchParams({ export: '1', limit: '2000', status: statusMap[statusF] || 'all' });
    if (search) params.set('search', search);
    if (instF) params.set('institutie', instF);
    if (deptF) params.set('compartiment', deptF);
    try {
      const r = await _apiFetch('/admin/flows/list?' + params.toString(), { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server ' + r.status);
      const resp = await r.json();
      const flows = Array.isArray(resp) ? resp : (resp.flows || []);
      if (!flows.length) { alert('Nu există fluxuri de exportat cu filtrele curente.'); return; }
      const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
      const filterDesc = [
        search ? `Căutare: „${search}"` : '',
        statusF ? `Status: ${statusF}` : '',
        instF ? `Instituție: ${instF}` : '',
        deptF ? `Compartiment: ${deptF}` : '',
      ].filter(Boolean).join(' &nbsp;|&nbsp; ') || 'Toate fluxurile';
      const escH = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const rows = flows.map((f, idx) => {
        const status = f.completed
          ? '<span class="badge done">✅ finalizat</span>'
          : f.status === 'refused'
          ? '<span class="badge refused">⛔ refuzat</span>'
          : '<span class="badge active">✍ activ</span>';
        const signersHtml = (f.signers || []).map(s => {
          const stClass = s.status === 'signed' ? 'signed' : s.status === 'refused' ? 'ref' : 'pend';
          const signedAt = s.signedAt ? new Date(s.signedAt).toLocaleDateString('ro-RO') : '';
          return `<span class="signer ${stClass}">${escH(s.name || s.email)}${s.rol ? ' (' + escH(s.rol) + ')' : ''}${signedAt ? ' — ' + signedAt : ''}</span>`;
        }).join('');
        return `<tr>
          <td class="idx">${idx + 1}</td>
          <td>${f.urgent ? '<b style="color:#c00;">🚨</b> ' : ''}${escH(f.docName || '—')}<br><small style="color:#888;">${escH(f.flowId)}</small></td>
          <td>${escH(f.initName || '')}${f.initName && f.initEmail ? '<br>' : ''}${f.initEmail ? '<small>' + escH(f.initEmail) + '</small>' : ''}</td>
          <td>${status}</td>
          <td>${escH(f.institutie || '—')}</td>
          <td>${escH(f.compartiment || '—')}</td>
          <td>${f.createdAt ? new Date(f.createdAt).toLocaleDateString('ro-RO') : '—'}</td>
          <td>${signersHtml}</td>
        </tr>`;
      }).join('');
      const html = `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8">
  <title>Fluxuri DocFlowAI — ${new Date().toLocaleDateString('ro-RO')}</title>
  <style>
    @page { size: A4 landscape; margin: 15mm 12mm; }
    body { font-family: Arial, sans-serif; font-size: 10px; color: #111; margin: 0; }
    h2 { color: #1e2a5e; margin: 0 0 4px; font-size: 14px; }
    .meta { color: #555; font-size: 9px; margin-bottom: 4px; }
    .filters { color: #333; font-size: 9px; margin-bottom: 12px; background: #f0f4ff; padding: 4px 8px; border-radius: 4px; display: inline-block; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e2a5e; color: #fff; padding: 5px 6px; text-align: left; font-size: 9px; white-space: nowrap; }
    td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: 9px; }
    tr:nth-child(even) td { background: #f8f9fb; }
    td.idx { color: #aaa; width: 22px; text-align: right; }
    .badge { padding: 2px 6px; border-radius: 8px; font-size: 8px; font-weight: 700; white-space: nowrap; }
    .badge.done { background: #d1fae5; color: #065f46; }
    .badge.refused { background: #fee2e2; color: #991b1b; }
    .badge.active { background: #ede9fe; color: #4c1d95; }
    .signer { display: inline-block; margin: 1px 2px 1px 0; padding: 1px 5px; border-radius: 6px; font-size: 8px; }
    .signer.signed { background: #d1fae5; color: #065f46; }
    .signer.ref { background: #fee2e2; color: #991b1b; }
    .signer.pend { background: #f3f4f6; color: #374151; }
    small { font-size: 8px; color: #888; }
  </style>
</head><body>
  <h2>📋 Fluxuri DocFlowAI</h2>
  <div class="meta">Generat: ${now} &nbsp;|&nbsp; Total: ${flows.length} fluxuri</div>
  <div class="filters">Filtre: ${filterDesc}</div>
  <table>
    <thead><tr>
      <th>#</th><th>Document / ID</th><th>Inițiator</th><th>Status</th>
      <th>Instituție</th><th>Compartiment</th><th>Creat</th><th>Semnatari</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`;
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    } catch(e) { alert('Eroare export PDF: ' + e.message); }
  }

  function exportUsersCSV() {
    const users = window._filteredUsers || window._allUsers || [];
    if (!users.length) { alert("Nu sunt utilizatori de exportat."); return; }
    const headers = ["Nume","Functie","Institutie","Compartiment","Email","Telefon","Rol","Notif InApp","Notif Email","Notif WhatsApp","Creat"];
    const escCsv = v => '"' + String(v||"").replace(/"/g,'""') + '"';
    const rows = users.map(u => [
      u.nume, u.functie, u.institutie, u.compartiment, u.email, u.phone, u.role,
      u.notif_inapp!==false?"Da":"Nu",
      u.notif_email?"Da":"Nu",
      u.notif_whatsapp?"Da":"Nu",
      u.created_at ? new Date(u.created_at).toLocaleDateString("ro-RO") : ""
    ].map(escCsv));
    const csv = [headers.map(h=>'"'+h+'"').join(","), ...rows.map(r=>r.join(","))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, "utilizatori_" + new Date().toISOString().slice(0,10) + ".csv");
  }

  function exportUsersPDF() {
    const users = window._filteredUsers || window._allUsers || [];
    if (!users.length) { alert("Nu sunt utilizatori de exportat."); return; }
    const allCount = (window._allUsers || []).length;
    const isFiltered = users.length < allCount;
    const filterNote = isFiltered ? ` (filtrat: ${users.length} din ${allCount})` : ` (${users.length} utilizatori)`;
    const now = new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" });
    const rows = users.map(u => {
      const dt = u.created_at ? new Date(u.created_at).toLocaleDateString("ro-RO") : "-";
      const escLocal = s => String(s||'-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<tr>
        <td>${escLocal(u.nume)}</td>
        <td>${escLocal(u.functie)}</td>
        <td>${escLocal(u.institutie)}</td>
        <td>${escLocal(u.compartiment)}</td>
        <td>${escLocal(u.email)}</td>
        <td>${escLocal(u.phone)}</td>
        <td><span class="pill ${escLocal(u.role)}">${u.role==="org_admin"?"Admin Instituție":u.role==="admin"?"Admin":"User"}</span></td>
        <td>${dt}</td>
      </tr>`;
    }).join("");
    const html = `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8">
  <title>Utilizatori DocFlowAI</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 11px; color: #111; margin: 20px; }
    h2 { color: #2d3a5e; margin-bottom: 4px; }
    .sub { color: #888; font-size: 10px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #2d3a5e; color: #fff; padding: 6px 8px; text-align: left; font-size: 10px; }
    td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    tr:nth-child(even) td { background: #f8f9fb; }
    code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 10px; }
    .pill { padding: 2px 7px; border-radius: 10px; font-size: 9px; font-weight: 700; }
    .pill.admin { background: #fef3c7; color: #92400e; }
    .pill.org_admin { background: #fef3c7; color: #b45309; }
    .pill.user { background: #dbeafe; color: #1e40af; }
  </style>
</head><body>
  <h2>📋 Lista Utilizatori — DocFlowAI</h2>
  <div class="sub">Generat: ${now} &nbsp;|&nbsp; Total: ${filterNote}</div>
  <table>
    <thead><tr>
      <th>Nume</th><th>Funcție</th><th>Instituție</th><th>Compartiment</th>
      <th>Email</th><th>Telefon</th><th>Rol</th><th>Creat</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`;
    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
  }

  async function exportActivityCSV() {
    if (!_activityData) { alert('Generează mai întâi un raport.'); return; }
    const lines = ['Email,Nume,Functie,Institutie,Compartiment,Data,Operatiune,Document,Motiv'];
    for (const u of _activityData.users || []) {
      for (const op of u.ops || []) {
        const dt = new Date(op.at).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
        const labelRO = OP_LABELS_RO[op.type] || op.label;
        lines.push(`"${u.email}","${u.name}","${u.functie||''}","${u.institutie||''}","${u.compartiment||''}","${dt}","${labelRO}","${(op.docName||'').replace(/"/g,'""')}","${(op.reason||'').replace(/"/g,'""')}"`);
      }
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `activitate_utilizatori_${isoToDMY($('rptFrom').value)}_${isoToDMY($('rptTo').value)}.csv`);
  }

  window.initActivityReport     = initActivityReport;
  window.loadActivityReport     = loadActivityReport;
  window.exportActivityCSV      = exportActivityCSV;
  window.exportActivityPDF      = exportActivityPDF;
  window.exportFlowsCSV         = exportFlowsCSV;
  window.exportFlowsPDF         = exportFlowsPDF;
  window.exportUsersCSV         = exportUsersCSV;
  window.exportUsersPDF         = exportUsersPDF;
  window.onDateTextInput        = onDateTextInput;
  window.onDatePickerChange     = onDatePickerChange;
  window.onRptInstChange        = onRptInstChange;
  window.onRptDeptChange        = onRptDeptChange;
  window.onRptUserChange        = onRptUserChange;
  window.toggleUserDetail       = toggleUserDetail;
  window.toggleUserDetailByType = toggleUserDetailByType;
  window.exportUserPDF          = exportUserPDF;

  window.df._activityModuleLoaded = true;
})();
