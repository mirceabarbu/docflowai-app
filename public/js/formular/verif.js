// public/js/formular/verif.js
// DocFlowAI — Modul Verificare Furnizor + Formulare oficiale (BLOC 2.1).
// Self-contained: lookup CIF (ANAF), validare IBAN, verificare coerență,
// listare formulare oficiale.
//
// Dependențe externe: niciuna din restul formular.js (zonă izolată).

(function () {
  'use strict';

  // ── Helpers private ───────────────────────────────────────────────────────
  function _vfEsc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _vfFetch(url, opts) {
    const jwt = localStorage.getItem('docflow_token') || localStorage.getItem('jwt') || '';
    return fetch(url, {
      ...opts,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(jwt ? { 'Authorization': 'Bearer ' + jwt } : {}), ...((opts && opts.headers) || {}) },
    });
  }

  function _vfCopyBtn(value, label) {
    const v = _vfEsc(value || '');
    return value ? `<button type="button" onclick="_vfCopy(this, '${v.replace(/'/g, "\\'")}')" title="Copiază ${label}" style="background:rgba(255,255,255,.05);border:1px solid var(--df-border-2);border-radius:4px;padding:2px 8px;font-size:.7rem;cursor:pointer;color:var(--df-text-3);margin-left:6px;">📋</button>` : '';
  }

  window._vfCopy = function(btn, value) {
    navigator.clipboard?.writeText(value).then(() => {
      const t = btn.textContent; btn.textContent = '✓';
      setTimeout(() => btn.textContent = t, 900);
    });
  };

  // ── Lookup CUI (ANAF) ─────────────────────────────────────────────────────
  async function vfLookupCui() {
    const input = document.getElementById('vf-cui-input');
    const resultEl = document.getElementById('vf-cui-result');
    const msgEl = document.getElementById('vf-cui-msg');
    const btn = document.getElementById('vf-cui-btn');
    const cui = (input.value || '').trim();
    if (!cui) { msgEl.textContent = '⚠ Introdu un CUI.'; msgEl.style.color = '#ffaaaa'; return; }
    msgEl.textContent = '⏳ Se verifică la ANAF...'; msgEl.style.color = 'var(--df-text-3)';
    resultEl.style.display = 'none';
    btn.disabled = true;
    try {
      const r = await _vfFetch(`/api/v4/verify/cui?cui=${encodeURIComponent(cui)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) {
        const reasonMap = {
          'upstream_unavailable':      'ANAF nu răspunde momentan. Reîncearcă în câteva secunde.',
          'upstream_timeout':          'ANAF timeout (peste 8 secunde). Reîncearcă.',
          'upstream_waf_blocked':      'ANAF a respins cererea (WAF). Contactează administratorul.',
          'upstream_invalid_response': 'ANAF a returnat un răspuns neașteptat. Reîncearcă sau contactează admin.',
          'upstream_error':            'ANAF a returnat eroare de validare. Verifică CUI-ul.',
          'upstream_empty_response':   'ANAF a returnat un răspuns gol (nici found, nici notFound). Reîncearcă.',
          'cui_invalid_format':        'CUI invalid (doar cifre, 2-10 caractere, opțional prefix RO).',
        };
        const reason = d.reason || '';
        const mapped = reasonMap[reason] || ('Eroare: ' + (reason || 'unknown'));
        const statusMatch = reason.match(/^upstream_status_(\d+)$/);
        const baseMsg = statusMatch ? `ANAF HTTP ${statusMatch[1]}` : mapped;

        const details = [];
        if (d.upstream) {
          if (d.upstream.cod !== undefined) details.push('cod=' + d.upstream.cod);
          if (d.upstream.message) details.push('mesaj=' + d.upstream.message);
          if (Array.isArray(d.upstream.notFound) && d.upstream.notFound.length) details.push('notFound=' + JSON.stringify(d.upstream.notFound));
        }

        let html = '⚠ ' + _vfEsc(baseMsg);
        if (details.length) {
          html += ' <span style="color:var(--df-text-4);font-size:.78rem;">· ' + _vfEsc(details.join(' · ')) + '</span>';
        }
        msgEl.innerHTML = html;
        msgEl.style.color = '#ffaaaa'; return;
      }
      if (d.notFound || !d.data) {
        msgEl.textContent = '❌ CUI-ul nu a fost găsit la ANAF.';
        msgEl.style.color = '#ffaaaa'; return;
      }
      const c = d.data;
      const radiatedBadge = c.radiated ? '<span style="background:rgba(239,68,68,.2);color:#ff8080;padding:2px 10px;border-radius:10px;font-size:.75rem;font-weight:700;margin-left:8px;">⛔ RADIATĂ</span>' : '';
      const inactiveBadge = (!c.radiated && c.inactive) ? '<span style="background:rgba(239,68,68,.2);color:#ff8080;padding:2px 10px;border-radius:10px;font-size:.75rem;font-weight:700;margin-left:8px;">⛔ INACTIVĂ</span>' : '';
      const statusDisplay = c.radiated
        ? `<span style="color:#ff8080;font-weight:700;">⛔ RADIATĂ${c.liquidationDate ? ' la ' + _vfEsc(c.liquidationDate) : ''}</span>`
        : c.inactive
          ? `<span style="color:#ff8080;font-weight:600;">INACTIVĂ${c.inactiveDate ? ' din ' + _vfEsc(c.inactiveDate) : ''}${c.reactivationDate ? ' · reactivat ' + _vfEsc(c.reactivationDate) : ''}</span>`
          : `<span style="color:#5eead4;font-weight:600;">${_vfEsc(c.stareInregistrareText || c.registrationStatus || 'Activ')}</span>`;
      resultEl.innerHTML = `
        <div style="background:rgba(255,255,255,.03);border:1px solid var(--df-border);border-radius:8px;padding:14px;display:grid;grid-template-columns:150px 1fr auto;gap:8px 12px;font-size:.85rem;">
          <div style="color:var(--df-text-4);">Denumire</div><div>${_vfEsc(c.name)}${radiatedBadge}${inactiveBadge}</div>${_vfCopyBtn(c.name,'denumire')}
          <div style="color:var(--df-text-4);">CUI</div><div style="font-family:monospace;">${_vfEsc(c.cui)}</div>${_vfCopyBtn(c.cui,'cui')}
          ${c.tradeRegisterNo ? `<div style="color:var(--df-text-4);">Nr. Reg. Com.</div><div style="font-family:monospace;">${_vfEsc(c.tradeRegisterNo)}</div>${_vfCopyBtn(c.tradeRegisterNo,'reg com')}` : ''}
          <div style="color:var(--df-text-4);">Status</div><div>${statusDisplay}</div><div></div>
          <div style="color:var(--df-text-4);">Adresă</div><div>${_vfEsc(c.address)}</div>${_vfCopyBtn(c.address,'adresa')}
          <div style="color:var(--df-text-4);">Județ</div><div>${_vfEsc(c.county || '—')}${c.countyAuto ? ' <span style="color:var(--df-text-4);">(' + _vfEsc(c.countyAuto) + ')</span>' : ''}</div>${_vfCopyBtn(c.county,'judet')}
          ${c.locality ? `<div style="color:var(--df-text-4);">Localitate</div><div>${_vfEsc(c.locality)}</div>${_vfCopyBtn(c.locality,'localitate')}` : ''}
          ${c.legalForm ? `<div style="color:var(--df-text-4);">Formă juridică</div><div>${_vfEsc(c.legalForm)}</div><div></div>` : ''}
          <div style="color:var(--df-text-4);">Tip entitate</div><div>${_vfEsc(c.entityType)}</div><div></div>
          ${c.caenCode ? `<div style="color:var(--df-text-4);">Cod CAEN</div><div style="font-family:monospace;">${_vfEsc(c.caenCode)}</div><div></div>` : ''}
          <div style="color:var(--df-text-4);">TVA</div><div>${
            c.vat
              ? `✓ <span style="color:#5eead4;">Plătitor TVA</span>${c.vatStartDate ? ' din ' + _vfEsc(c.vatStartDate) : ''}`
              : c.vatEndDate
                ? `✗ <span style="color:#fbbf24;">TVA anulat la ${_vfEsc(c.vatEndDate)}</span>${c.vatStartDate ? ' (înregistrat ' + _vfEsc(c.vatStartDate) + ')' : ''}`
                : '✗ Neplătitor'
          }${c.vatCollected ? ' · TVA la încasare' : ''}${c.splitVat ? ' · plată defalcată' : ''}${
            c.vatPeriods && c.vatPeriods.length > 1
              ? ` <span style="color:var(--df-text-4);font-size:.75rem;">(${c.vatPeriods.length} perioade istoric)</span>`
              : ''
          }</div><div></div>
          ${c.vatCancelReason ? `<div style="color:var(--df-text-4);">Motiv anulare TVA</div><div style="font-size:.78rem;color:var(--df-text-3);grid-column:span 2;">${_vfEsc(c.vatCancelReason)}</div>` : ''}
          ${c.eFactura ? `<div style="color:var(--df-text-4);">e-Factura</div><div style="color:#5eead4;">✓ Înregistrat RO e-Factura</div><div></div>` : ''}
          ${c.anafIban ? `<div style="color:var(--df-text-4);">IBAN ANAF</div><div style="font-family:monospace;font-size:.8rem;">${_vfEsc(c.anafIban)}</div>${_vfCopyBtn(c.anafIban,'iban')}` : ''}
          ${c.fiscalAuthority ? `<div style="color:var(--df-text-4);">Organ fiscal</div><div style="font-size:.8rem;">${_vfEsc(c.fiscalAuthority)}</div><div></div>` : ''}
          <div style="color:var(--df-text-4);">Data înreg.</div><div>${_vfEsc(c.registrationDate || '—')}</div><div></div>
        </div>
      `;

      if (c._raw) {
        const rawSections = [
          { title: '📄 Date generale',           key: 'date_generale' },
          { title: '💰 Înregistrare scop TVA',   key: 'inregistrare_scop_Tva' },
          { title: '📅 TVA la încasare (RTVAI)', key: 'inregistrare_RTVAI' },
          { title: '⚠️ Stare inactiv/radiat',    key: 'stare_inactiv' },
          { title: '🔀 Split TVA',               key: 'inregistrare_SplitTVA' },
          { title: '🏢 Adresă sediu social',     key: 'adresa_sediu_social' },
          { title: '📮 Adresă domiciliu fiscal', key: 'adresa_domiciliu_fiscal' },
        ];
        const renderValue = (v, _depth = 0) => {
          if (v === null || v === undefined || v === '') return '<span style="color:var(--df-text-5);">—</span>';
          if (typeof v === 'boolean') return v
            ? '<span style="color:#5eead4;">✓ true</span>'
            : '<span style="color:var(--df-text-4);">✗ false</span>';
          if (Array.isArray(v)) {
            if (!v.length) return '<span style="color:var(--df-text-5);">[] (gol)</span>';
            if (v.every(x => typeof x !== 'object' || x === null))
              return _vfEsc(v.map(x => x === null ? '—' : String(x)).join(', '));
            if (_depth >= 3) return '<span style="color:var(--df-text-5);font-size:.72rem;">[nested]</span>';
            return v.map((item, idx) => {
              if (!item || typeof item !== 'object') return renderValue(item, _depth + 1);
              const subRows = Object.entries(item).map(([k, val]) =>
                `<tr><td style="color:var(--df-text-4);padding:3px 10px 3px 0;font-size:.75rem;vertical-align:top;white-space:nowrap;">${_vfEsc(k)}</td><td style="padding:3px 0;font-size:.78rem;word-break:break-word;">${renderValue(val, _depth + 1)}</td></tr>`
              ).join('');
              const label = v.length > 1 ? `<div style="font-size:.72rem;color:var(--df-text-4);margin-bottom:4px;font-weight:600;">Perioada ${idx + 1}/${v.length}</div>` : '';
              return `<div style="background:rgba(255,255,255,.02);border:1px solid var(--df-border);border-radius:6px;padding:8px 10px;margin-top:${idx > 0 ? '6px' : '0'};">${label}<table style="width:100%;border-collapse:collapse;"><tbody>${subRows}</tbody></table></div>`;
            }).join('');
          }
          if (typeof v === 'object') {
            const entries = Object.entries(v);
            if (!entries.length) return '<span style="color:var(--df-text-5);">{} (gol)</span>';
            if (_depth >= 3) return '<span style="color:var(--df-text-5);font-size:.72rem;">[nested]</span>';
            const subRows = entries.map(([k, val]) =>
              `<tr><td style="color:var(--df-text-4);padding:3px 10px 3px 0;font-size:.75rem;vertical-align:top;white-space:nowrap;">${_vfEsc(k)}</td><td style="padding:3px 0;font-size:.78rem;word-break:break-word;">${renderValue(val, _depth + 1)}</td></tr>`
            ).join('');
            return `<div style="background:rgba(255,255,255,.02);border:1px solid var(--df-border);border-radius:6px;padding:8px 10px;"><table style="width:100%;border-collapse:collapse;"><tbody>${subRows}</tbody></table></div>`;
          }
          return _vfEsc(String(v));
        };
        const sectionsHtml = rawSections.map(s => {
          const obj = c._raw[s.key];
          if (!obj || typeof obj !== 'object') return '';
          const entries = Object.entries(obj);
          if (!entries.length) return '';
          const rows = entries.map(([k, v]) =>
            `<tr><td style="color:var(--df-text-4);padding:4px 10px 4px 0;font-size:.78rem;vertical-align:top;white-space:nowrap;">${_vfEsc(k)}</td><td style="padding:4px 0;font-size:.8rem;word-break:break-word;">${renderValue(v)}</td></tr>`
          ).join('');
          return `<div style="margin-top:14px;"><div style="font-size:.82rem;font-weight:600;color:var(--df-text-2);margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--df-border);">${s.title}</div><table style="width:100%;border-collapse:collapse;"><tbody>${rows}</tbody></table></div>`;
        }).filter(Boolean).join('');
        resultEl.insertAdjacentHTML('beforeend', `
          <details style="margin-top:14px;">
            <summary style="cursor:pointer;padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid var(--df-border);border-radius:8px;font-size:.85rem;color:var(--df-text-2);font-weight:500;user-select:none;">
              📋 Date complete ANAF (toate câmpurile brute, pentru audit)
            </summary>
            <div style="padding:14px 18px;border:1px solid var(--df-border);border-top:none;border-radius:0 0 8px 8px;background:rgba(0,0,0,.15);margin-top:-1px;">
              ${sectionsHtml}
            </div>
          </details>
        `);
      }

      resultEl.style.display = '';
      msgEl.textContent = d.cached ? '✓ Rezultat din cache (15 min).' : '✓ Rezultat proaspăt de la ANAF.';
      msgEl.style.color = '#5eead4';
    } catch (e) {
      msgEl.textContent = '⚠ Eroare de rețea.'; msgEl.style.color = '#ffaaaa';
    } finally {
      btn.disabled = false;
    }
  }

  // ── Lookup IBAN ───────────────────────────────────────────────────────────
  async function vfLookupIban() {
    const input = document.getElementById('vf-iban-input');
    const resultEl = document.getElementById('vf-iban-result');
    const msgEl = document.getElementById('vf-iban-msg');
    const btn = document.getElementById('vf-iban-btn');
    const iban = (input.value || '').trim();
    if (!iban) { msgEl.textContent = '⚠ Introdu un IBAN.'; msgEl.style.color = '#ffaaaa'; return; }
    msgEl.textContent = '⏳ Se validează...'; msgEl.style.color = 'var(--df-text-3)';
    resultEl.style.display = 'none';
    btn.disabled = true;
    try {
      const r = await _vfFetch(`/api/v4/verify/iban?iban=${encodeURIComponent(iban)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) {
        const reason = d.reason || '';
        msgEl.textContent = '⚠ ' + (reason === 'iban_format_invalid' ? 'IBAN format invalid.' : reason === 'iban_ro_length_invalid' ? 'IBAN RO trebuie să aibă 24 caractere.' : 'Eroare: ' + (reason || 'unknown'));
        msgEl.style.color = '#ffaaaa'; return;
      }
      const i = d.data;
      const validColor = i.valid ? '#5eead4' : '#ff8080';
      const validText  = i.valid ? '✓ IBAN valid (mod-97 OK)' : '✗ IBAN invalid (check digit failed)';
      const trezBadge = i.isTreasury ? '<span style="background:rgba(245,158,11,.2);color:#fbbf24;padding:2px 8px;border-radius:10px;font-size:.72rem;margin-left:6px;">⚠ Trezorerie</span>' : '';
      resultEl.innerHTML = `
        <div style="background:rgba(255,255,255,.03);border:1px solid var(--df-border);border-radius:8px;padding:14px;display:grid;grid-template-columns:140px 1fr;gap:8px 12px;font-size:.85rem;">
          <div style="color:var(--df-text-4);">IBAN</div><div style="font-family:monospace;">${_vfEsc(i.iban)}</div>
          <div style="color:var(--df-text-4);">Validitate</div><div style="color:${validColor};font-weight:600;">${validText}</div>
          <div style="color:var(--df-text-4);">Țară</div><div>${_vfEsc(i.country)}</div>
          <div style="color:var(--df-text-4);">Cod bancă</div><div style="font-family:monospace;">${_vfEsc(i.bankCode || '—')}</div>
          <div style="color:var(--df-text-4);">Instituție</div><div>${_vfEsc(i.bankName || '—')}${trezBadge}</div>
          <div style="color:var(--df-text-4);">Tip cont</div><div>${i.accountType === 'treasury' ? '🏛 Trezorerie' : i.accountType === 'commercial' ? '🏦 Bancă comercială' : i.accountType === 'foreign' ? '🌍 Bancă străină' : '? Necunoscut'}</div>
        </div>
      `;
      resultEl.style.display = '';
      msgEl.textContent = '';
    } catch (e) {
      msgEl.textContent = '⚠ Eroare de rețea.'; msgEl.style.color = '#ffaaaa';
    } finally {
      btn.disabled = false;
    }
  }

  // ── Verificare coerență CUI + IBAN + denumire ─────────────────────────────
  async function vfLookupCoherence() {
    const cui = (document.getElementById('vf-coh-cui').value || '').trim();
    const iban = (document.getElementById('vf-coh-iban').value || '').trim();
    const name = (document.getElementById('vf-coh-name').value || '').trim();
    const resultEl = document.getElementById('vf-coh-result');
    const msgEl = document.getElementById('vf-coh-msg');
    const btn = document.getElementById('vf-coh-btn');
    if (!cui && !iban) { msgEl.textContent = '⚠ Introdu măcar un CUI sau un IBAN.'; msgEl.style.color = '#ffaaaa'; return; }
    msgEl.textContent = '⏳ Se analizează...'; msgEl.style.color = 'var(--df-text-3)';
    resultEl.style.display = 'none';
    btn.disabled = true;
    try {
      const r = await _vfFetch('/api/v4/verify/coherence', {
        method: 'POST',
        body: JSON.stringify({ cui, iban, name }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        msgEl.textContent = '⚠ Eroare: ' + (d.error || 'unknown'); msgEl.style.color = '#ffaaaa'; return;
      }
      const parts = [];
      if (cui && d.company) {
        if (d.company.data) {
          parts.push(`<div style="margin-bottom:10px;"><strong style="color:var(--df-text-2);">Firmă (ANAF):</strong> ${_vfEsc(d.company.data.name)} · ${_vfEsc(d.company.data.entityType)} · ${d.company.data.inactive ? '<span style="color:#ff8080;">inactiv</span>' : '<span style="color:#5eead4;">activ</span>'}</div>`);
        } else if (d.company.notFound) {
          parts.push('<div style="margin-bottom:10px;"><strong>Firmă:</strong> <span style="color:#ff8080;">CUI negăsit la ANAF</span></div>');
        } else {
          parts.push(`<div style="margin-bottom:10px;"><strong>Firmă:</strong> <span style="color:#ff8080;">ANAF indisponibil (${_vfEsc(d.company.reason)})</span></div>`);
        }
      }
      if (iban && d.iban) {
        if (d.iban.ok && d.iban.data) {
          const iv = d.iban.data;
          parts.push(`<div style="margin-bottom:10px;"><strong style="color:var(--df-text-2);">IBAN:</strong> ${iv.valid ? '<span style="color:#5eead4;">valid</span>' : '<span style="color:#ff8080;">invalid</span>'} · ${_vfEsc(iv.bankName || '—')}${iv.isTreasury ? ' <span style="color:#fbbf24;">[Trezorerie]</span>' : ''}</div>`);
        } else {
          parts.push(`<div style="margin-bottom:10px;"><strong>IBAN:</strong> <span style="color:#ff8080;">${_vfEsc(d.iban.reason || 'invalid')}</span></div>`);
        }
      }
      const warns = d.warnings || [];
      if (warns.length === 0) {
        parts.push('<div style="color:#5eead4;padding:10px;background:rgba(45,212,191,.08);border:1px solid rgba(45,212,191,.3);border-radius:8px;">✓ Nicio problemă detectată.</div>');
      } else {
        const VF_WARNING_TITLES = {
          CUI_NOT_FOUND:                'CUI negăsit ANAF',
          COMPANY_INACTIVE:             'Entitate inactivă',
          COMPANY_RADIATED:             'Entitate radiată',
          VAT_CANCELLED:                'TVA anulat',
          VAT_COLLECTED:                'TVA la încasare',
          IBAN_INVALID:                 'IBAN invalid',
          TREASURY_PRIVATE_MISMATCH:    'Cont trezorerie — entitate privată',
          TREASURY_PUBLIC_OK:           'Cont trezorerie — instituție publică',
          COMMERCIAL_BANK_PUBLIC_ENTITY:'Bancă comercială — instituție publică',
          COMPANY_NAME_MATCH:           'Denumire — corespunde cu ANAF',
          COMPANY_NAME_PARTIAL:         'Denumire — corespunde parțial',
          COMPANY_NAME_MISMATCH:        'Denumire — nu corespunde',
        };
        parts.push('<div style="margin-top:6px;">' + warns.map(w => {
          const colors = { info: ['#5eead4','rgba(45,212,191,.08)','rgba(45,212,191,.3)'], warning: ['#fbbf24','rgba(245,158,11,.08)','rgba(245,158,11,.3)'], error: ['#ff8080','rgba(239,68,68,.08)','rgba(239,68,68,.3)'] }[w.level] || ['#fff','rgba(255,255,255,.04)','rgba(255,255,255,.1)'];
          const icon = { info: 'ℹ️', warning: '⚠', error: '❌' }[w.level] || '•';
          const title = VF_WARNING_TITLES[w.code] || w.code;
          return `<div style="padding:10px 12px;margin-bottom:6px;background:${colors[1]};border:1px solid ${colors[2]};border-radius:8px;color:${colors[0]};font-size:.84rem;"><strong>${icon} ${_vfEsc(title)}:</strong> ${_vfEsc(w.message)}</div>`;
        }).join('') + '</div>');
      }
      resultEl.innerHTML = parts.join('');
      resultEl.style.display = '';
      msgEl.textContent = '';
    } catch (e) {
      msgEl.textContent = '⚠ Eroare de rețea.'; msgEl.style.color = '#ffaaaa';
    } finally {
      btn.disabled = false;
    }
  }

  // ── Formulare oficiale ────────────────────────────────────────────────────
  async function foListOpen(formType) {
    const listDiv = document.getElementById('foList');
    const titleEl = document.getElementById('foListTitle');
    const content = document.getElementById('foListContent');
    if (!listDiv || !content) return;

    listDiv.style.display = '';
    if (titleEl) titleEl.textContent = formType === 'REFNEC' ? 'Referate de necesitate' : 'Note de fundamentare';
    content.innerHTML = '<div style="color:var(--df-text-4);padding:20px;text-align:center;">Se încarcă...</div>';

    try {
      const r = await fetch(`/api/formulare-oficiale?form_type=${formType}&limit=50`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const items = Array.isArray(data.items) ? data.items : [];

      if (!items.length) {
        content.innerHTML = `<div style="color:var(--df-text-4);padding:30px;text-align:center;">
          📭 Niciun formular de acest tip încă.<br>
          <span style="font-size:.85rem;">Creează unul nou cu butonul "➕ Formular nou".</span>
        </div>`;
        return;
      }

      const editUrl = formType === 'NOTAFD_INVEST' ? 'notafd-invest-form.html' : 'notafd-invest-form.html';
      const stLabel = s => s==='completed'?'✓ Finalizat':s==='archived'?'🗄 Arhivat':'📝 Draft';
      const stColor = s => s==='completed'?'#5eead4':s==='archived'?'#94a3b8':'#fbbf24';
      const stBg    = s => s==='completed'?'rgba(94,234,212,.15)':s==='archived'?'rgba(148,163,184,.15)':'rgba(251,191,36,.15)';

      const rows = items.map(it => `
        <tr style="border-bottom:1px solid var(--df-border);">
          <td style="padding:8px 10px;font-family:monospace;font-size:.8rem;">${_vfEsc(it.ref_number||'—')}</td>
          <td style="padding:8px 10px;">${_vfEsc(it.title||'(fără titlu)')}</td>
          <td style="padding:8px 10px;">
            <span style="padding:2px 8px;border-radius:10px;font-size:.75rem;background:${stBg(it.status)};color:${stColor(it.status)};">
              ${stLabel(it.status)}
            </span>
          </td>
          <td style="padding:8px 10px;font-size:.85rem;color:var(--df-text-4);">${new Date(it.updated_at).toLocaleDateString('ro-RO')}</td>
          <td style="padding:8px 10px;">
            <a href="/${editUrl}?id=${encodeURIComponent(it.id)}" class="df-action-btn sm">Deschide</a>
          </td>
        </tr>`).join('');

      content.innerHTML = `<table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid var(--df-border-2);">
          <th style="text-align:left;padding:8px 10px;color:var(--df-text-4);font-size:.78rem;font-weight:600;">Nr.</th>
          <th style="text-align:left;padding:8px 10px;color:var(--df-text-4);font-size:.78rem;font-weight:600;">Titlu</th>
          <th style="text-align:left;padding:8px 10px;color:var(--df-text-4);font-size:.78rem;font-weight:600;">Status</th>
          <th style="text-align:left;padding:8px 10px;color:var(--df-text-4);font-size:.78rem;font-weight:600;">Actualizat</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    } catch (err) {
      console.error('[fo-list] Load failed:', err);
      content.innerHTML = `<div style="color:#ff8080;padding:20px;">
        ⚠️ Eroare la încărcare: ${_vfEsc(err.message)}<br>
        <button onclick="foListOpen('${formType}')" class="df-action-btn sm" style="margin-top:10px;">Reîncearcă</button>
      </div>`;
    }
  }

  function foListClose() {
    const el = document.getElementById('foList');
    if (el) el.style.display = 'none';
  }

  // ── Init: Enter key listeners ─────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const ci = document.getElementById('vf-cui-input');
    if (ci) ci.addEventListener('keydown', e => { if (e.key === 'Enter') vfLookupCui(); });
    const ii = document.getElementById('vf-iban-input');
    if (ii) ii.addEventListener('keydown', e => { if (e.key === 'Enter') vfLookupIban(); });
  });

  // ── Export onclick global ─────────────────────────────────────────────────
  window.vfLookupCui       = vfLookupCui;
  window.vfLookupIban      = vfLookupIban;
  window.vfLookupCoherence = vfLookupCoherence;
  window.foListOpen        = foListOpen;
  window.foListClose       = foListClose;

  window.df = window.df || {};
  window.df._formularVerifLoaded = true;
})();
