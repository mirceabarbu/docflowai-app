/**
 * DocFlowAI — Facturi (centralizator lichidări) — READ-ONLY
 * Populează #facturi-section din GET /api/alop/facturi.
 * Coloane clicabile: ALOP (openAlop), DF (openDocFromList 'df'), ORD (openDocFromList 'ord').
 */
(function(){
  const esc = window.esc || (s=>String(s==null?'':s));

  let _allFacturi = [];
  let _sort = { key:'data_factura', dir:'desc' };

  function fmtDate(d){
    if(!d) return '';
    try { return new Date(d).toLocaleDateString('ro-RO'); } catch(_) { return esc(d); }
  }

  function fmtRON(v){
    if(v==null||v==='') return '';
    const n = parseFloat(v);
    if(!Number.isFinite(n)) return '';
    return new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+' RON';
  }

  async function openFacturi(){
    const tbody = document.getElementById('facturi-tbody');
    const errEl = document.getElementById('facturi-error');
    const emptyEl = document.getElementById('facturi-empty');
    const wrap = document.getElementById('facturi-table-wrap');
    if(!tbody) return;
    if(errEl) errEl.style.display='none';
    if(emptyEl) emptyEl.style.display='none';
    const tfoot = document.getElementById('facturi-tfoot');
    if(tfoot) tfoot.style.display='none';
    tbody.innerHTML = '<tr><td colspan="11" style="padding:20px;text-align:center;color:var(--df-text-3)">Se încarcă…</td></tr>';
    try {
      const r = await fetch('/api/alop/facturi', { credentials:'include' });
      const j = await r.json();
      if(!r.ok || !j.ok) throw new Error(j.error || 'Eroare la încărcare');
      _allFacturi = j.facturi || [];
      const conf = [...new Set(_allFacturi.map(f=>f.confirmed_by_name).filter(Boolean))].sort();
      const sel = document.getElementById('fact-conf-by');
      if(sel) sel.innerHTML = '<option value="">Toți</option>' + conf.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
      if(!_allFacturi.length){
        tbody.innerHTML='';
        if(tfoot) tfoot.style.display='none';
        if(wrap) wrap.style.display='none';
        if(emptyEl) emptyEl.style.display='';
        _updateFacturiCounter(0,0);
        return;
      }
      if(wrap) wrap.style.display='';
      _renderFacturi();
    } catch(e){
      tbody.innerHTML='';
      const tf = document.getElementById('facturi-tfoot');
      if(tf) tf.style.display='none';
      _updateFacturiCounter(null,null);
      if(errEl){ errEl.textContent = 'Nu s-au putut încărca facturile: '+e.message; errEl.style.display=''; }
    }
  }

  function _updateFacturiCounter(shown,total){
    const counter = document.getElementById('facturi-counter');
    if(!counter) return;
    if(shown==null){ counter.textContent='— facturi'; return; }
    counter.textContent = `${shown} din ${total} ${total===1?'factură':'facturi'}`;
  }

  function _facturiFiltrate(){
    const q      = (document.getElementById('fact-q')?.value||'').trim().toLowerCase();
    const from   = document.getElementById('fact-from')?.value||'';
    const to     = document.getElementById('fact-to')?.value||'';
    const ordSt  = document.getElementById('fact-ord-status')?.value||'all';
    const confBy = document.getElementById('fact-conf-by')?.value||'';
    return _allFacturi.filter(f=>{
      if(q){
        const hay = [f.nr_factura,f.nr_pv,f.alop_titlu,f.notes].map(x=>(x||'').toString().toLowerCase()).join(' ');
        if(!hay.includes(q)) return false;
      }
      const dataFact = f.data_factura ? String(f.data_factura).slice(0,10) : '';
      if(from && (!dataFact || dataFact < from)) return false;
      if(to   && (!dataFact || dataFact > to))   return false;
      if(ordSt==='cu'   && !f.ord_id) return false;
      if(ordSt==='fara' &&  f.ord_id) return false;
      if(confBy && (f.confirmed_by_name||'') !== confBy) return false;
      return true;
    });
  }

  function _facturiSortate(rows){
    const { key, dir } = _sort;
    const mul = dir==='asc' ? 1 : -1;
    const sorted = rows.slice().sort((a,b)=>{
      let av = a[key], bv = b[key];
      if(key==='valoare'){
        av = parseFloat(av); if(!Number.isFinite(av)) av = -Infinity;
        bv = parseFloat(bv); if(!Number.isFinite(bv)) bv = -Infinity;
        return (av-bv)*mul;
      }
      av = (av==null?'':String(av));
      bv = (bv==null?'':String(bv));
      return av.localeCompare(bv)*mul;
    });
    return sorted;
  }

  function _renderFacturi(){
    const tbody = document.getElementById('facturi-tbody');
    const emptyEl = document.getElementById('facturi-empty');
    const wrap = document.getElementById('facturi-table-wrap');
    const tfoot = document.getElementById('facturi-tfoot');
    if(!tbody) return;
    const filtered = _facturiSortate(_facturiFiltrate());
    _updateFacturiCounter(filtered.length, _allFacturi.length);
    _updateSortIndicators();
    if(!filtered.length){
      tbody.innerHTML='';
      if(tfoot) tfoot.style.display='none';
      if(wrap) wrap.style.display = _allFacturi.length ? '' : 'none';
      if(emptyEl){ emptyEl.style.display=''; emptyEl.textContent = _allFacturi.length ? 'Nicio factură nu corespunde filtrelor.' : 'Nicio factură lichidată încă.'; }
      return;
    }
    if(emptyEl) emptyEl.style.display='none';
    if(wrap) wrap.style.display='';
    tbody.innerHTML = filtered.map(renderRow).join('');
    const totalEl = document.getElementById('facturi-total');
    if(totalEl && tfoot){
      const sum = filtered.reduce((acc,f)=>{
        const n = parseFloat(f.valoare);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      totalEl.textContent = fmtRON(sum) || '0,00 RON';
      tfoot.style.display='';
    }
  }

  function _resetFacturiFilters(){
    const ids = ['fact-q','fact-from','fact-from-display','fact-to','fact-to-display'];
    ids.forEach(id=>{ const el = document.getElementById(id); if(el) el.value=''; });
    const ordSt = document.getElementById('fact-ord-status'); if(ordSt) ordSt.value='all';
    const confBy = document.getElementById('fact-conf-by'); if(confBy) confBy.value='';
    _renderFacturi();
  }

  function _updateSortIndicators(){
    document.querySelectorAll('#facturi-table th[data-sort]').forEach(th=>{
      const ind = th.querySelector('.fact-sort-ind');
      if(!ind) return;
      ind.textContent = th.dataset.sort===_sort.key ? (_sort.dir==='asc'?'▲':'▼') : '';
    });
  }

  document.addEventListener('click', function(ev){
    const th = ev.target.closest('#facturi-table th[data-sort]');
    if(!th) return;
    const key = th.dataset.sort;
    if(_sort.key===key){ _sort.dir = _sort.dir==='asc'?'desc':'asc'; }
    else { _sort = { key, dir:'asc' }; }
    _renderFacturi();
  });

  function _exportFacturiCsv(){
    const rows = _facturiSortate(_facturiFiltrate());
    const head = ['Nr. factura','Data factura','Valoare','Nr. PV','Data PV','ALOP','DF legat','ORD legata','Confirmat de','Data confirmare','Observatii'];
    const escCsv = v => { const s=(v==null?'':String(v)); return /[";\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const fmtD = d => d ? new Date(d).toLocaleDateString('ro-RO') : '';
    const body = rows.map(f => [
      f.nr_factura, fmtD(f.data_factura),
      (f.valoare!=null?String(f.valoare).replace('.',','):''),
      f.nr_pv, fmtD(f.data_pv),
      f.alop_titlu,
      f.df_id ? 'DA' : '',
      f.ord_id ? 'DA' : '',
      f.confirmed_by_name, fmtD(f.confirmed_at), f.notes
    ].map(escCsv).join(';'));
    const csv = '﻿' + head.join(';') + '\n' + body.join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facturi_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  function renderRow(f){
    // Coloane clicabile prin data-attributes + delegare (fără onclick inline cu escape).
    const alopCell = f.alop_id
      ? `<span class="fact-link" data-fact-act="alop" data-id="${esc(f.alop_id)}">${esc(f.alop_titlu||'ALOP')}</span>`
      : `<span class="fact-muted">—</span>`;
    const dfCell = f.df_id
      ? `<span class="fact-link" data-fact-act="df" data-id="${esc(f.df_id)}">Deschide DF</span>`
      : `<span class="fact-muted">—</span>`;
    const ordCell = f.ord_id
      ? `<span class="fact-link" data-fact-act="ord" data-id="${esc(f.ord_id)}">Deschide ORD</span>`
      : `<span class="fact-muted">neîntocmită</span>`;
    return `<tr>
      <td><strong>${esc(f.nr_factura||'')}</strong></td>
      <td>${fmtDate(f.data_factura)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${fmtRON(f.valoare)||'<span class="fact-muted">—</span>'}</td>
      <td>${esc(f.nr_pv||'')||'<span class="fact-muted">—</span>'}</td>
      <td>${fmtDate(f.data_pv)||'<span class="fact-muted">—</span>'}</td>
      <td>${alopCell}</td>
      <td>${dfCell}</td>
      <td>${ordCell}</td>
      <td>${esc(f.confirmed_by_name||'')||'<span class="fact-muted">—</span>'}</td>
      <td>${fmtDate(f.confirmed_at)}</td>
      <td style="max-width:220px;white-space:pre-wrap;">${esc(f.notes||'')||'<span class="fact-muted">—</span>'}</td>
    </tr>`;
  }

  // Delegare de evenimente pe tbody (fără onclick inline)
  document.addEventListener('click', function(ev){
    const el = ev.target.closest('#facturi-tbody .fact-link');
    if(!el) return;
    const act = el.dataset.factAct, id = el.dataset.id;
    if(!id) return;
    if(act==='alop'){
      if(typeof switchListTab==='function') switchListTab('alop');
      if(typeof openAlop==='function') setTimeout(()=>openAlop(id), 60);
    } else if(act==='df'){
      if(typeof openDocFromList==='function') openDocFromList('df', id);
    } else if(act==='ord'){
      if(typeof openDocFromList==='function') openDocFromList('ord', id);
    }
  });

  window.openFacturi = openFacturi;
  window._renderFacturi = _renderFacturi;
  window._resetFacturiFilters = _resetFacturiFilters;
  window._exportFacturiCsv = _exportFacturiCsv;
})();
