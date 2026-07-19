# DocFlowAI — 🔗 TRASABILITATE (PASUL 2: UI Modal + Butoane) v3.9.448

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH: develop ONLY. NU FACE merge / push / checkout pe main.
   main = producție; deploy-ul pe main se face MANUAL de utilizator.
═══════════════════════════════════════════════════════════
```

> **PASUL 2 din 2** — UI complet pentru modal Trasabilitate. Backend e gata din v3.9.447 (verificat verde pe staging).

```
DocFlowAI v3.9.447 → v3.9.448 (SW v163 → v164)
Branch: develop  ⚠️ EXCLUSIV develop
Subiect: feat(trasabilitate): UI modal + butoane DF↔ALOP↔ORD (PASUL 2 din 2)

═══════════════════════════════════════════════════════════
CONTEXT — ce livrăm
═══════════════════════════════════════════════════════════

Backend-ul GET /api/trasabilitate/:type/:id e operațional din v3.9.447.
Acum adăugăm UI:

  - Buton 🔗 mic lângă numărul DF/ORD în lista (descoperibilitate)
  - Buton 🔗 standard în coloana „Acțiuni" alături de butoanele existente
    (consistență cu pattern-ul actual de butoane)
  - Modal nou #trasabilitate-modal cu arbore vizual:
      DF (cu badges revizii) → ALOP (cards) → ORD curent + cicluri arhivate
      Cards cu chenare colorate (DF=albastru, ALOP=mov, ORD=verde) +
      conectori SVG verticali între nivele.
  - Click pe orice nod → închide modal-ul + deschide documentul respectiv
    (DF/ORD în formular existent prin openDocFromList; ALOP în detail panel
    prin openAlop; switchListTab automat)
  - Marcaj „TU EȘTI AICI" pe nodul de unde a pornit utilizatorul
    (border galben + badge auriu, folosește flag-urile is_root_* din backend)

DECIZII LUATE ÎMPREUNĂ:
  1. Plasament buton: AMBELE (lângă număr + în Acțiuni) pentru
     descoperibilitate maximă pe desktop și mobile
  2. Tip arbore: cards verticale cu chenare + linii SVG (look enterprise)
  3. Click pe nod: deschide documentul + închide modal automat
  4. Cicluri arhivate vs ord curent: separat vizual (cards ord curent au
     border verde plin, cele arhivate au opacity 0.85 + background subtil)

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- TOATE fișierele de signing (STSCloudProvider, cloud-signing, pades, etc.)
- server/middleware/auth.mjs
- server/services/trasabilitate.mjs (backend din PASUL 1, NU modifica)
- server/routes/trasabilitate.mjs (backend din PASUL 1, NU modifica)
- public/js/formular/clasa8.js (UI Clasa 8 OK din v3.9.444+)

═══════════════════════════════════════════════════════════
PASUL 2.1 — Modul JS nou: public/js/formular/trasabilitate.js (FIȘIER NOU)
═══════════════════════════════════════════════════════════

Creează public/js/formular/trasabilitate.js cu următorul conținut EXACT:

// public/js/formular/trasabilitate.js
// DocFlowAI — Modul Trasabilitate: modal cu arbore DF↔ALOP↔ORD.
//
// Cross-module exports (window):
//   - openTrasabilitate(type, id)  : deschide modal + fetch arbore
//   - closeTrasabilitate()         : închide modal
//   - _trasabOpenNode(type, id)    : intern, pentru onclick din HTML rendat dinamic
//
// Dependențe:
//   - switchListTab(type)   : pentru navigare la tab-ul corect (DF/ORD/ALOP)
//   - openDocFromList(type, id) : pentru deschidere DF/ORD în lista
//   - openAlop(id)          : pentru deschidere ALOP în detail panel
//   - window.df.esc (cu fallback inline)

(function () {
  'use strict';
  const esc = (window.df && window.df.esc)
    ? window.df.esc
    : s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const _state = {
    currentType: null,
    currentId: null,
    data: null,
    loading: false,
    error: null,
  };

  function _formatRO(n) {
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (isNaN(num)) return '—';
    return num.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return iso; }
  }

  function _statusBadgeAlop(status) {
    const map = {
      'draft':       '<span class="trasab-status trasab-status-draft">📝 Draft</span>',
      'in_progress': '<span class="trasab-status trasab-status-progress">🔄 În curs</span>',
      'completed':   '<span class="trasab-status trasab-status-done">✓ Completat</span>',
      'cancelled':   '<span class="trasab-status trasab-status-cancel">🚫 Anulat</span>',
    };
    return map[status] || '<span class="trasab-status">' + esc(status||'?') + '</span>';
  }

  // ── Modal control ───────────────────────────────────────────────────────────
  async function openTrasabilitate(type, id) {
    if (type !== 'df' && type !== 'ord') {
      console.warn('openTrasabilitate: type invalid', type);
      return;
    }
    _state.currentType = type;
    _state.currentId = id;
    _state.loading = true;
    _state.error = null;
    _state.data = null;

    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.style.display = '';
    document.body.style.overflow = 'hidden';

    _showLoading();

    try {
      const r = await fetch('/api/trasabilitate/' + type + '/' + encodeURIComponent(id),
                            { credentials: 'include' });
      if (r.status === 401) { closeTrasabilitate(); location.href = '/'; return; }
      if (r.status === 404) { _showError('Document negăsit (poate a fost șters între timp).'); return; }
      if (!r.ok)            throw new Error('HTTP ' + r.status);
      const data = await r.json();
      _state.data = data;
      _render();
    } catch(e) {
      _showError('Eroare la încărcarea trasabilității: ' + (e.message || e));
    } finally {
      _state.loading = false;
    }
  }

  function closeTrasabilitate() {
    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    _state.data = null;
  }

  // ── Render — loading / error / empty ────────────────────────────────────────
  function _showLoading() {
    const loading = document.getElementById('trasabilitate-loading');
    const errEl   = document.getElementById('trasabilitate-error');
    const content = document.getElementById('trasabilitate-content');
    if (loading) loading.style.display = '';
    if (errEl)   errEl.style.display = 'none';
    if (content) content.style.display = 'none';
  }

  function _showError(msg) {
    const loading = document.getElementById('trasabilitate-loading');
    const errEl   = document.getElementById('trasabilitate-error');
    const content = document.getElementById('trasabilitate-content');
    if (loading) loading.style.display = 'none';
    if (errEl)   { errEl.textContent = '⚠ ' + msg; errEl.style.display = ''; }
    if (content) content.style.display = 'none';
  }

  // ── Render — arbore principal ───────────────────────────────────────────────
  function _render() {
    const data = _state.data;
    if (!data) return;

    const loading = document.getElementById('trasabilitate-loading');
    const errEl   = document.getElementById('trasabilitate-error');
    const content = document.getElementById('trasabilitate-content');
    if (loading) loading.style.display = 'none';
    if (errEl)   errEl.style.display = 'none';
    if (!content) return;
    content.style.display = '';

    let html = '';

    // Card DF (cu badges pentru toate reviziile)
    if (data.df_revizii && data.df_revizii.length) {
      html += _renderDFCard(data.df_revizii);
      // Connector spre ALOP-uri
      if (data.alopuri && data.alopuri.length) {
        html += _renderConnector();
      }
    }

    // Cards ALOP-uri
    if (data.alopuri && data.alopuri.length) {
      data.alopuri.forEach((alop, i) => {
        if (i > 0) html += _renderConnector();
        html += _renderAlopCard(alop);
      });
    } else if (data.df_revizii && data.df_revizii.length) {
      html += '<div class="trasab-empty">Nicio ALOP creată încă pentru acest DF.</div>';
    } else {
      html += '<div class="trasab-empty">Niciun document asociat găsit. Probabil ORD-ul nu are df_id setat (date legacy).</div>';
    }

    content.innerHTML = html;
  }

  // ── Render — card DF cu badges revizii ──────────────────────────────────────
  function _renderDFCard(revizii) {
    // Folosim ultima revizie ca sursă pentru titlu/nr
    const last = revizii[revizii.length - 1];
    const titlu = last.titlu || '(fără subtitlu)';

    const badgesHtml = revizii.map(rv => {
      const isRoot = rv.is_root_df || rv.is_root_df_link;
      const cls = isRoot ? 'trasab-rev-badge trasab-rev-badge-root' : 'trasab-rev-badge';
      const aprobIcon = rv.aprobat ? '✓' : '⏳';
      const tooltip = (rv.titlu||'') + (rv.aprobat ? ' (aprobat)' : ' (în curs)');
      return '<button type="button" class="' + cls + '"'
           + ' onclick="_trasabOpenNode(\\'df\\', \\'' + esc(rv.id) + '\\')"'
           + ' title="' + esc(tooltip) + '">'
           + 'R' + rv.revizie_nr + ' ' + aprobIcon
           + (isRoot ? ' <span class="trasab-here">●</span>' : '')
           + '</button>';
    }).join('');

    return '<div class="trasab-card trasab-card-df">'
         +   '<div class="trasab-card-icon">📄</div>'
         +   '<div class="trasab-card-body">'
         +     '<div class="trasab-card-kicker">DOCUMENT DE FUNDAMENTARE</div>'
         +     '<div class="trasab-card-title">' + esc(last.nr_unic_inreg || '—') + '</div>'
         +     '<div class="trasab-card-subtitle">' + esc(titlu) + '</div>'
         +     '<div class="trasab-card-badges-row">'
         +       '<span class="trasab-card-badges-label">Revizii:</span> '
         +       badgesHtml
         +     '</div>'
         +   '</div>'
         + '</div>';
  }

  // ── Render — connector SVG vertical între cards ─────────────────────────────
  function _renderConnector() {
    return '<div class="trasab-connector">'
         +   '<svg width="40" height="32" viewBox="0 0 40 32" xmlns="http://www.w3.org/2000/svg">'
         +     '<line x1="20" y1="0" x2="20" y2="32"'
         +           ' stroke="rgba(124,58,237,0.4)" stroke-width="2" stroke-dasharray="4 3"/>'
         +     '<polygon points="16,24 24,24 20,32" fill="rgba(124,58,237,0.6)"/>'
         +   '</svg>'
         + '</div>';
  }

  // ── Render — card ALOP cu copii (ord curent + cicluri arhivate) ─────────────
  function _renderAlopCard(alop) {
    const titlu = alop.titlu || '(fără titlu)';
    const valTotal = alop.valoare_totala !== null ? _formatRO(alop.valoare_totala) : '—';
    const platit   = alop.suma_totala_platita !== null ? _formatRO(alop.suma_totala_platita) : '0,00';

    let metaParts = [
      _statusBadgeAlop(alop.status),
      'Valoare: <strong>' + valTotal + ' lei</strong>',
      'Plătit: <strong>' + platit + ' lei</strong>',
    ];
    if (alop.ciclu_curent && alop.ciclu_curent > 1) {
      metaParts.push('Ciclu curent: <strong>' + alop.ciclu_curent + '</strong>');
    }

    // Construim cards copii: cicluri arhivate (sortate ASC) + ord curent la final
    let copiHtml = '';
    if (alop.cicluri_arhivate && alop.cicluri_arhivate.length) {
      alop.cicluri_arhivate.forEach(c => { copiHtml += _renderArchivedCicluCard(c); });
    }
    if (alop.ord_curent) {
      copiHtml += _renderCurrentOrdCard(alop.ord_curent, alop.ciclu_curent || 1);
    }
    if (!copiHtml) {
      copiHtml = '<div class="trasab-empty-inline">Niciun ORD generat încă (ALOP în stadiu Angajare).</div>';
    }

    return '<div class="trasab-card trasab-card-alop">'
         +   '<div class="trasab-card-header" onclick="_trasabOpenNode(\\'alop\\', \\'' + esc(alop.id) + '\\')">'
         +     '<div class="trasab-card-icon">🏛</div>'
         +     '<div class="trasab-card-body">'
         +       '<div class="trasab-card-kicker">ALOP</div>'
         +       '<div class="trasab-card-title">' + esc(titlu) + '</div>'
         +       '<div class="trasab-card-meta">' + metaParts.join(' · ') + '</div>'
         +     '</div>'
         +     '<div class="trasab-card-arrow">▶</div>'
         +   '</div>'
         +   '<div class="trasab-card-children">'
         +     copiHtml
         +   '</div>'
         + '</div>';
  }

  // ── Render — card ORD curent (în interiorul unui ALOP card) ─────────────────
  function _renderCurrentOrdCard(ord, cicluNr) {
    const nr = ord.nr_unic_inreg || '(fără număr)';
    const titlu = ord.titlu || '(beneficiar nedefinit)';
    const isRoot = !!ord.is_root_ord;
    const aprobLabel = ord.aprobat ? '✓ Aprobat'
                     : (ord.status === 'completed' ? '⏳ În așteptare semnături'
                     : '📝 Draft');

    const lichidat = ord.lichidare_confirmed_at
      ? '<div class="trasab-step trasab-step-done">✓ Lichidat ' + _formatDate(ord.lichidare_confirmed_at)
        + (ord.lichidare_nr_factura ? ' · F-' + esc(ord.lichidare_nr_factura) : '')
        + (ord.lichidare_nr_pv      ? ' · PV ' + esc(ord.lichidare_nr_pv)     : '')
        + '</div>'
      : '<div class="trasab-step trasab-step-pending">⏳ Lichidare în curs</div>';

    const platit = ord.plata_confirmed_at
      ? '<div class="trasab-step trasab-step-done">✓ Plătit ' + _formatDate(ord.plata_confirmed_at)
        + (ord.plata_nr_ordin ? ' · OP-' + esc(ord.plata_nr_ordin) : '')
        + (ord.plata_suma_efectiva !== null ? ' · <strong>' + _formatRO(ord.plata_suma_efectiva) + ' lei</strong>' : '')
        + '</div>'
      : '<div class="trasab-step trasab-step-pending">⏳ Plata în curs</div>';

    const cls = 'trasab-card-ord trasab-card-ord-curent' + (isRoot ? ' trasab-card-root' : '');

    return '<div class="' + cls + '" onclick="event.stopPropagation();_trasabOpenNode(\\'ord\\', \\'' + esc(ord.id) + '\\')">'
         +   '<div class="trasab-card-ord-header">'
         +     '<span class="trasab-card-ord-kicker">📦 Ciclu ' + cicluNr + ' (curent)</span>'
         +     (isRoot ? ' <span class="trasab-here-badge">● TU EȘTI AICI</span>' : '')
         +   '</div>'
         +   '<div class="trasab-card-ord-title">'
         +     'ORD: ' + esc(nr) + ' <span class="trasab-card-ord-aprob">· ' + aprobLabel + '</span>'
         +   '</div>'
         +   '<div class="trasab-card-ord-subtitle">' + esc(titlu) + '</div>'
         +   lichidat
         +   platit
         + '</div>';
  }

  // ── Render — card ORD din ciclu arhivat ─────────────────────────────────────
  function _renderArchivedCicluCard(ciclu) {
    const nr = ciclu.ord_nr_unic_inreg || '(fără număr)';
    const titlu = ciclu.ord_titlu || '(beneficiar nedefinit)';
    const isRoot = !!ciclu.is_root_ord;
    const aprobLabel = ciclu.ord_aprobat ? '✓ Aprobat' : '📝 ' + esc(ciclu.ord_status || '?');

    const lichidat = ciclu.lichidare_confirmed_at
      ? '<div class="trasab-step trasab-step-done">✓ Lichidat ' + _formatDate(ciclu.lichidare_confirmed_at)
        + (ciclu.lichidare_nr_factura ? ' · F-' + esc(ciclu.lichidare_nr_factura) : '')
        + (ciclu.lichidare_nr_pv      ? ' · PV ' + esc(ciclu.lichidare_nr_pv)     : '')
        + '</div>'
      : '';

    const platit = ciclu.plata_confirmed_at
      ? '<div class="trasab-step trasab-step-done">✓ Plătit ' + _formatDate(ciclu.plata_confirmed_at)
        + (ciclu.plata_nr_ordin ? ' · OP-' + esc(ciclu.plata_nr_ordin) : '')
        + (ciclu.plata_suma_efectiva !== null ? ' · <strong>' + _formatRO(ciclu.plata_suma_efectiva) + ' lei</strong>' : '')
        + '</div>'
      : '';

    const cls = 'trasab-card-ord trasab-card-ord-archived' + (isRoot ? ' trasab-card-root' : '');

    return '<div class="' + cls + '" onclick="event.stopPropagation();_trasabOpenNode(\\'ord\\', \\'' + esc(ciclu.ord_id) + '\\')">'
         +   '<div class="trasab-card-ord-header">'
         +     '<span class="trasab-card-ord-kicker">📦 Ciclu ' + ciclu.ciclu_nr + ' (arhivat)</span>'
         +     (isRoot ? ' <span class="trasab-here-badge">● TU EȘTI AICI</span>' : '')
         +   '</div>'
         +   '<div class="trasab-card-ord-title">'
         +     'ORD: ' + esc(nr) + ' <span class="trasab-card-ord-aprob">· ' + aprobLabel + '</span>'
         +   '</div>'
         +   '<div class="trasab-card-ord-subtitle">' + esc(titlu) + '</div>'
         +   lichidat
         +   platit
         + '</div>';
  }

  // ── Click pe nod: închide modal + deschide documentul ───────────────────────
  function _trasabOpenNode(type, id) {
    closeTrasabilitate();
    setTimeout(() => {
      try {
        if (type === 'alop') {
          if (typeof switchListTab === 'function') switchListTab('alop');
          if (typeof openAlop === 'function') openAlop(id);
        } else if (type === 'df' || type === 'ord') {
          if (typeof switchListTab === 'function') switchListTab(type);
          if (typeof openDocFromList === 'function') openDocFromList(type, id);
        }
      } catch(e) {
        console.error('trasab open node error:', e);
      }
    }, 50); // mic delay ca să se închidă modal-ul curat înainte de deschiderea documentului
  }

  // ── ESC pentru închidere ────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('trasabilitate-modal');
      if (modal && modal.style.display !== 'none') closeTrasabilitate();
    }
  });

  // ── Click pe overlay pentru închidere ───────────────────────────────────────
  document.addEventListener('click', e => {
    const modal = document.getElementById('trasabilitate-modal');
    if (modal && e.target === modal) closeTrasabilitate();
  });

  // Public API
  window.openTrasabilitate  = openTrasabilitate;
  window.closeTrasabilitate = closeTrasabilitate;
  window._trasabOpenNode    = _trasabOpenNode;
})();

═══════════════════════════════════════════════════════════
PASUL 2.2 — Modal HTML + CSS în public/formular.html
═══════════════════════════════════════════════════════════

Adaugă modal-ul ÎNAINTE de tag-ul de închidere </body>.

Caută cu:
  grep -n "</body>" public/formular.html
și folosește str_replace cu old_str = `</body>` și new_str adaugă modal
ÎNAINTE de </body>.

old_str:
</body>

new_str:
<!-- ════════════ TRASABILITATE MODAL ════════════════════════════════════════ -->
<style>
  /* Overlay + container modal */
  #trasabilitate-modal {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.72);
    display: none;
    align-items: flex-start; justify-content: center;
    z-index: 9999; padding: 32px 16px;
    overflow-y: auto;
  }
  #trasabilitate-modal[style*="display: "],
  #trasabilitate-modal[style*="display:"] { display: flex !important; }
  #trasabilitate-modal[style*="display: none"],
  #trasabilitate-modal[style*="display:none"] { display: none !important; }
  .trasab-modal-card {
    background: var(--df-bg-2, #1a1f2e);
    border: 1px solid var(--df-border-2, rgba(255,255,255,0.1));
    border-radius: 16px;
    max-width: 920px; width: 100%;
    max-height: calc(100vh - 64px);
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
    margin: auto 0;
  }
  .trasab-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 24px;
    border-bottom: 1px solid var(--df-border-2);
    background: rgba(124,58,237,0.06);
    border-radius: 16px 16px 0 0;
    flex-shrink: 0;
  }
  .trasab-modal-title { font-size: 1.1rem; font-weight: 700; color: var(--df-text-2, #e2e8f0); margin: 0; }
  .trasab-modal-close {
    background: transparent; border: 1px solid var(--df-border-2);
    color: var(--df-text-3, #94a3b8);
    width: 32px; height: 32px; border-radius: 8px;
    cursor: pointer; font-size: 1.2rem; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, color 0.15s;
  }
  .trasab-modal-close:hover { background: rgba(239,68,68,0.15); color: #fca5a5; border-color: rgba(239,68,68,0.4); }
  .trasab-modal-body {
    padding: 20px 24px;
    overflow-y: auto;
    flex: 1;
  }
  .trasab-modal-footer {
    padding: 12px 24px;
    border-top: 1px solid var(--df-border-2);
    display: flex; justify-content: flex-end;
    flex-shrink: 0;
  }

  /* Loading + error */
  #trasabilitate-loading {
    text-align: center; padding: 48px 16px; color: var(--df-text-3); font-size: 0.95rem;
  }
  #trasabilitate-error {
    background: rgba(239,68,68,0.12); color: #fca5a5;
    border: 1px solid rgba(239,68,68,0.3); border-radius: 10px;
    padding: 14px 18px; font-size: 0.92rem; margin-bottom: 12px;
  }

  /* Tree cards */
  .trasab-card {
    background: var(--df-surface, rgba(255,255,255,0.03));
    border: 1px solid var(--df-border-2);
    border-radius: 12px; padding: 14px 18px;
    transition: background 0.2s, border-color 0.2s;
  }
  .trasab-card-df {
    border-left: 4px solid #3b82f6;
    display: flex; gap: 14px;
  }
  .trasab-card-alop {
    border-left: 4px solid #a855f7;
    padding: 0;
  }
  .trasab-card-alop .trasab-card-header {
    display: flex; gap: 14px; padding: 14px 18px;
    cursor: pointer;
    border-bottom: 1px solid var(--df-border-2);
    transition: background 0.15s;
  }
  .trasab-card-alop .trasab-card-header:hover { background: rgba(168,85,247,0.06); }
  .trasab-card-alop .trasab-card-arrow {
    align-self: center; color: var(--df-text-5); font-size: 0.8rem; flex-shrink: 0;
  }
  .trasab-card-alop .trasab-card-children {
    padding: 12px 18px 14px 36px;
    background: rgba(0,0,0,0.15);
    border-radius: 0 0 12px 12px;
  }

  .trasab-card-icon { font-size: 1.5rem; flex-shrink: 0; }
  .trasab-card-body { flex: 1; min-width: 0; }
  .trasab-card-kicker {
    text-transform: uppercase; letter-spacing: 0.05em;
    font-size: 0.68rem; color: var(--df-text-5, #64748b);
    font-weight: 700; margin-bottom: 2px;
  }
  .trasab-card-title { font-weight: 700; color: var(--df-text-2); font-size: 1.02rem; margin-bottom: 3px; font-family: monospace; }
  .trasab-card-subtitle { color: var(--df-text-3); font-size: 0.88rem; }
  .trasab-card-meta { font-size: 0.85rem; color: var(--df-text-3); margin-top: 6px; }
  .trasab-card-meta strong { color: var(--df-text-2); }
  .trasab-card-badges-row { margin-top: 10px; font-size: 0.82rem; }
  .trasab-card-badges-label { color: var(--df-text-5); margin-right: 6px; }

  /* Revizie badges */
  .trasab-rev-badge, .trasab-rev-badge-root {
    display: inline-block; padding: 4px 10px; border-radius: 8px;
    font-size: 0.78rem; font-weight: 600; cursor: pointer;
    background: rgba(255,255,255,0.06);
    border: 1px solid var(--df-border-2);
    color: var(--df-text-2); margin-right: 6px;
    font-family: monospace;
    transition: background 0.15s, border-color 0.15s;
  }
  .trasab-rev-badge:hover { background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.4); }
  .trasab-rev-badge-root {
    background: rgba(251,191,36,0.18);
    border-color: #fbbf24;
    color: #fde68a;
    box-shadow: 0 0 0 2px rgba(251,191,36,0.3);
  }
  .trasab-here { color: #fbbf24; }

  /* ORD cards (în interior ALOP) */
  .trasab-card-ord {
    background: rgba(34,197,94,0.04);
    border: 1px solid rgba(34,197,94,0.2);
    border-left: 3px solid #22c55e;
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 8px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .trasab-card-ord:hover { background: rgba(34,197,94,0.10); border-color: rgba(34,197,94,0.4); }
  .trasab-card-ord-curent { /* default verde plin */ }
  .trasab-card-ord-archived { opacity: 0.85; background: rgba(255,255,255,0.02); border-left-color: rgba(34,197,94,0.4); }
  .trasab-card-root {
    box-shadow: 0 0 0 2px #fbbf24;
    border-color: #fbbf24 !important;
  }
  .trasab-card-ord-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .trasab-card-ord-kicker { font-size: 0.78rem; font-weight: 600; color: var(--df-text-5); text-transform: uppercase; letter-spacing: 0.04em; }
  .trasab-card-ord-title { font-weight: 700; color: var(--df-text-2); font-size: 0.94rem; font-family: monospace; }
  .trasab-card-ord-aprob { font-family: inherit; font-weight: 500; color: var(--df-text-3); font-size: 0.82rem; }
  .trasab-card-ord-subtitle { color: var(--df-text-3); font-size: 0.84rem; margin-bottom: 4px; }

  .trasab-here-badge {
    display: inline-block; padding: 2px 8px;
    background: #fbbf24; color: #1f2937;
    border-radius: 6px; font-size: 0.7rem; font-weight: 700;
    letter-spacing: 0.04em;
  }

  /* Steps lichidare/plată */
  .trasab-step { font-size: 0.82rem; margin-top: 4px; padding-left: 4px; line-height: 1.5; }
  .trasab-step-done { color: var(--df-text-3); }
  .trasab-step-pending { color: #fbbf24; }
  .trasab-step strong { color: var(--df-text-2); }

  /* Status badges ALOP */
  .trasab-status {
    display: inline-block; padding: 2px 8px; border-radius: 6px;
    font-size: 0.78rem; font-weight: 600;
    background: rgba(255,255,255,0.06); border: 1px solid var(--df-border-2);
  }
  .trasab-status-draft    { color: #94a3b8; }
  .trasab-status-progress { background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.4); color: #93c5fd; }
  .trasab-status-done     { background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.4); color: #86efac; }
  .trasab-status-cancel   { background: rgba(148,163,184,0.15); border-color: rgba(148,163,184,0.4); color: #cbd5e1; }

  /* Connector între cards */
  .trasab-connector { display: flex; justify-content: center; padding: 4px 0; }

  /* Empty states */
  .trasab-empty, .trasab-empty-inline {
    text-align: center; padding: 16px;
    color: var(--df-text-3); font-style: italic;
    background: rgba(255,255,255,0.02);
    border: 1px dashed var(--df-border-2);
    border-radius: 10px;
  }
  .trasab-empty-inline { padding: 10px; font-size: 0.88rem; }

  /* Buton inline 🔗 lângă număr în lista DF/ORD */
  .trasab-inline-btn {
    background: transparent; border: none;
    color: var(--df-text-4, #94a3b8);
    cursor: pointer;
    padding: 1px 5px; margin-left: 6px;
    border-radius: 5px; font-size: 0.85rem;
    vertical-align: middle;
    transition: background 0.15s, color 0.15s;
  }
  .trasab-inline-btn:hover { background: rgba(124,58,237,0.18); color: #c4b5fd; }

  @media (max-width: 640px) {
    .trasab-modal-card { max-height: calc(100vh - 24px); }
    .trasab-modal-body { padding: 14px 16px; }
    .trasab-card-df { flex-direction: column; gap: 8px; }
    .trasab-card-alop .trasab-card-children { padding: 10px 14px 12px 18px; }
  }
</style>

<div id="trasabilitate-modal" style="display:none;">
  <div class="trasab-modal-card">
    <div class="trasab-modal-header">
      <h2 class="trasab-modal-title">🔗 Trasabilitate document</h2>
      <button type="button" class="trasab-modal-close" onclick="closeTrasabilitate()" title="Închide (ESC)">×</button>
    </div>
    <div class="trasab-modal-body">
      <div id="trasabilitate-loading">⏳ Se încarcă arborele de trasabilitate…</div>
      <div id="trasabilitate-error" style="display:none;"></div>
      <div id="trasabilitate-content" style="display:none;"></div>
    </div>
    <div class="trasab-modal-footer">
      <button type="button" class="df-action-btn" onclick="closeTrasabilitate()">Închide</button>
    </div>
  </div>
</div>
<!-- /TRASABILITATE MODAL -->

</body>

═══════════════════════════════════════════════════════════
PASUL 2.3 — Script tag pentru trasabilitate.js în formular.html
═══════════════════════════════════════════════════════════

Caută în formular.html lista de scripturi de la finalul body-ului
(`<script src="/js/formular/...">` ~linia 1117-1123). Adaugă referința
trasabilitate.js IMEDIAT DUPĂ list.js.

old_str:
<script src="/js/formular/list.js?v=3.9.446" defer></script>

new_str:
<script src="/js/formular/list.js?v=3.9.448" defer></script>
<script src="/js/formular/trasabilitate.js?v=3.9.448" defer></script>

NOTĂ: Verifică versiunea curentă din list.js cu:
  grep -n "list.js?v=" public/formular.html
Dacă găsești v=3.9.443 sau alta diferită de v=3.9.446, adaptează old_str
corespunzător înainte de str_replace.

═══════════════════════════════════════════════════════════
PASUL 2.4 — list.js: adaugă butoane 🔗 în 2 locuri
═══════════════════════════════════════════════════════════

În public/js/formular/list.js, în funcția _renderLstTable.

PASUL 2.4.1 — Buton inline 🔗 lângă numărul DF/ORD

old_str:
${nr}${revBadgeLst}${istoricBadgeLst}</a>${titlu?`<br>

new_str:
${nr}${revBadgeLst}${istoricBadgeLst}</a><button type="button" class="trasab-inline-btn" onclick="event.stopPropagation();openTrasabilitate('${type}','${safeId}');return false" title="Vezi trasabilitate (lanț DF↔ALOP↔ORD)">🔗</button>${titlu?`<br>

PASUL 2.4.2 — Buton 🔗 în coloana Acțiuni

NOTĂ: Caută cu `grep -n "cancelBtn" public/js/formular/list.js` ca să
identifici context-ul exact. În funcție de cum e structurată coloana,
poate fi `<td>${cancelBtn}</td>` sau cu mai multe butoane separate.
Folosește str_replace cu un pattern UNIC din zona respectivă.

Dacă structura e simplă: `<td>${cancelBtn}</td>`:

old_str:
${cancelBtn}</td>

new_str:
${cancelBtn}<button type="button" class="df-action-btn sm" onclick="openTrasabilitate('${type}','${safeId}')" title="Trasabilitate" style="margin-left:4px">🔗</button></td>

Dacă apare „found multiple matches", folosește un anchor mai unic — de
exemplu adăugând linia anterioară (cu `</tr>` sau </tbody>):

  old_str:
  ${cancelBtn}</td>
  </tr>`;

  new_str:
  ${cancelBtn}<button type="button" class="df-action-btn sm" onclick="openTrasabilitate('${type}','${safeId}')" title="Trasabilitate" style="margin-left:4px">🔗</button></td>
  </tr>`;

═══════════════════════════════════════════════════════════
PASUL 2.5 — Cache busting (3.9.447 → 3.9.448, SW v163 → v164)
═══════════════════════════════════════════════════════════

5.1 — package.json:
  old_str:   "version": "3.9.447",
  new_str:   "version": "3.9.448",

5.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v163';
  new_str: const CACHE_VERSION = 'docflowai-v164';

5.3 — Cache busting în 4 HTML-uri (consistență):

VERIFICARE PRELIMINARĂ — care versiune e curentă în HTML-uri?
  grep -oE "v=3\.9\.4[0-9][0-9]" public/formular.html | sort -u

Probabil vei găsi v=3.9.446 (din PASUL 2 Clasa 8) și acum v=3.9.448 nou
introdus. Bumpează tot ce e ≠ 3.9.448:

  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    sed -i -E 's/v=3\.9\.44[0-7]/v=3.9.448/g' "$f"
    sed -i -E 's/v=3\.9\.4[0-3][0-9]/v=3.9.448/g' "$f"
  done

  Verifică:
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    OLD=$(grep -oE "v=3\.9\.4[0-9]{2}" "$f" | grep -v "v=3.9.448" | wc -l)
    NEW=$(grep -c "v=3.9.448" "$f")
    echo "$f: 448=$NEW, alte_44X=$OLD"
    [ "$OLD" -eq 0 ] && echo "  ✓ OK" || echo "  ✗ FAIL"
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Modul JS sintactic OK:
   node --check public/js/formular/trasabilitate.js

2. Modal-ul există în formular.html:
   grep -c 'id="trasabilitate-modal"' public/formular.html
   → 1
   grep -c 'id="trasabilitate-content"\|id="trasabilitate-loading"\|id="trasabilitate-error"' public/formular.html
   → 3

3. Script tag prezent:
   grep -c "js/formular/trasabilitate.js" public/formular.html
   → 1

4. Butoane 🔗 în list.js:
   grep -c "openTrasabilitate(" public/js/formular/list.js
   → 2 (inline + acțiuni)
   grep -c "trasab-inline-btn" public/js/formular/list.js
   → 1

5. CSS pentru modal prezent:
   grep -c "trasab-modal-card\|trasab-card-df\|trasab-card-alop\|trasab-card-ord" public/formular.html
   → ≥ 4

6. Public API exportat:
   grep -cE "window\.(openTrasabilitate|closeTrasabilitate|_trasabOpenNode)" public/js/formular/trasabilitate.js
   → 3

7. Cache busting curat:
   for f in public/formular.html public/refnec-form.html \
            public/notafd-invest-form.html public/admin.html; do
     [ "$(grep -oE 'v=3\.9\.4[0-9]{2}' "$f" | grep -v 'v=3.9.448' | wc -l)" -eq 0 ] && echo "OK $f" || echo "FAIL $f"
   done

8. Sintaxă globală + teste:
   node --check public/sw.js
   npm run check
   npm test verde, fără regresii (UI nu testat unitar; suite-ul rămâne 379/379)

═══════════════════════════════════════════════════════════
COMMIT pe develop  ⚠️ EXCLUSIV develop, nu main!
═══════════════════════════════════════════════════════════
git add public/js/formular/trasabilitate.js \
        public/js/formular/list.js \
        public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "feat(trasabilitate): UI modal + butoane lanț DF↔ALOP↔ORD (v3.9.448)

PASUL 2 din 2 — UI complet pentru modal Trasabilitate.
Backend e gata din v3.9.447 (verificat verde pe staging).

UI:
  - Buton 🔗 mic lângă nr_unic_inreg în lista DF/ORD (vizibilitate)
  - Buton 🔗 în coloana Acțiuni alături de butoanele existente (consistență)
  - Modal #trasabilitate-modal cu arbore vizual:
      DF (cards cu badges revizii) → ALOP (cards mov) → ORD (cards verzi:
      ord_curent + cicluri_arhivate)
  - Connectori SVG verticali între nivele (linie albastră dashed + săgetă)
  - Hover effects, click-to-navigate, ESC pentru închidere, click overlay

Comportament click pe nod:
  - DF/ORD → switchListTab + openDocFromList(type, id)
  - ALOP   → switchListTab('alop') + openAlop(id)
  - Modal-ul se închide automat înainte de navigare (delay 50ms)

Marcaj 'TU EȘTI AICI':
  - Folosește flag-urile is_root_df / is_root_df_link / is_root_ord din backend
  - Border galben + box-shadow + badge auriu '● TU EȘTI AICI'

Edge cases tratate:
  - 401 → redirect /
  - 404 → 'Document negăsit (poate a fost șters)'
  - ALOP fără ord_curent (stadiu Angajare) → empty state inline
  - DF fără ALOP-uri → empty state inline
  - ORD fără df_id (date legacy) → empty state explicativ
  - 'noua lichidare' → cicluri_arhivate listate ASC + ord_curent la final

Fișier nou:
  - public/js/formular/trasabilitate.js — module IIFE, ~280 linii

Modificări:
  - public/formular.html: modal HTML + CSS (~150 linii) + script tag
  - public/js/formular/list.js: 2 str_replace (buton inline + buton Acțiuni)
  - public/sw.js: v163 → v164
  - package.json: 3.9.447 → 3.9.448
  - 4 HTML-uri (formular/refnec-form/notafd-invest-form/admin):
    bump cache busting la v=3.9.448"

git push origin develop  # ⚠️ NU ORIGIN MAIN

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — checklist UI manual
═══════════════════════════════════════════════════════════

1. Hard refresh /formular.html (Ctrl+Shift+R) → tab DF.

2. Rândurile au acum un buton 🔗 mic după număr (înainte de subtitlu)
   ȘI un buton 🔗 în coloana Acțiuni (alături de 🚫 anulare dacă e cazul).

3. Click pe 🔗 inline din rândul unui DF aprobat cu cicluri ALOP:
   → se deschide modal Trasabilitate
   → loading 1-2 secunde apoi arbore:
     - Card DF (border albastru) cu titlu + badges R0, R1... (R curent
       are border galben + ● TU EȘTI AICI)
     - Săgetă SVG dashed jos
     - Card ALOP (border mov) cu titlu, status, valoare totală, plătit
       - În interior: cards verzi pentru fiecare ORD:
         * Cicluri arhivate (mai sus, opacity ușor redusă)
         * ORD curent (jos, plin)

4. Click pe ESC → modal se închide.

5. Click pe overlay (zona neagră de deasupra modal-ului) → se închide.

6. Click pe 🔗 din coloana Acțiuni: același comportament ca inline.

7. Click pe un badge revizie (ex R0) în interior modal:
   → modal se închide, lista comutează la DF, formularul DF R0 se deschide.

8. Re-deschide Trasabilitate pe DF din pasul 7 → vezi acum că R0 are
   marcajul ● TU EȘTI AICI.

9. Click pe card ALOP în arbore: → modal închis, comută la tab ALOP, panel
   detaliu ALOP deschis.

10. Click pe ORD curent sau ciclu arhivat: → modal închis, comută la tab
    ORD, formular ORD deschis.

11. Test ORD root: deschide un ORD din tab ORD → click 🔗 → vezi că DF
    parent are marcajul ● TU EȘTI AICI și ORD-ul (curent sau arhivat) are
    badge-ul auriu.

12. Test ALOP cu „noua lichidare" (cicluri 2+):
    → pe DF root, vezi cicluri_arhivate listate cronologic + ord_curent
      la final
    → fiecare ciclu arhivat afișează lichidare_at + factura + PV +
      plată_at + nr_ordin + suma_efectiva

13. Mobile viewport (DevTools → Toggle device toolbar → 375x667):
    → modal scade ca dimensiune
    → cards se stivuiesc vertical

STOP dacă:
- Modal nu apare la click → check console pentru erori; verifică
  openTrasabilitate exists în window
- Loading rămâne pe ecran fără să dispară → API-ul nu răspunde sau
  trasabilitate.js nu s-a încărcat (verifică Network)
- Click pe nod nu navighează → openDocFromList sau openAlop nu sunt
  globale pe window (verifică în consolă)
- Marcajul ● TU EȘTI AICI nu apare → flag-urile is_root_* nu vin din
  API; verifică curl pentru endpoint
- 4 HTML-uri au cache busting mixed (unele cu v=3.9.446) → re-rulează
  sed-urile din 5.3
```
