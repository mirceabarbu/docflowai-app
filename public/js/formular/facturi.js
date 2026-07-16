/**
 * DocFlowAI — Facturi (centralizator lichidări) — READ-ONLY
 * Populează #facturi-section din GET /api/alop/facturi.
 * Coloane clicabile: ALOP (openAlop), DF (openDocFromList 'df'), ORD (openDocFromList 'ord').
 */
(function(){
  const esc = window.esc || (s=>String(s==null?'':s));

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
    const counter = document.getElementById('facturi-counter');
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
      const facturi = j.facturi || [];
      if(counter) counter.textContent = `${facturi.length} ${facturi.length===1?'factură':'facturi'}`;
      if(!facturi.length){
        tbody.innerHTML='';
        if(tfoot) tfoot.style.display='none';
        if(wrap) wrap.style.display='none';
        if(emptyEl) emptyEl.style.display='';
        return;
      }
      if(wrap) wrap.style.display='';
      tbody.innerHTML = facturi.map(renderRow).join('');
      // TOTAL pe valorile afișate
      const totalEl = document.getElementById('facturi-total');
      if(totalEl && tfoot){
        const sum = facturi.reduce((acc,f)=>{
          const n = parseFloat(f.valoare);
          return acc + (Number.isFinite(n) ? n : 0);
        }, 0);
        totalEl.textContent = fmtRON(sum) || '0,00 RON';
        tfoot.style.display='';
      }
    } catch(e){
      tbody.innerHTML='';
      const tf = document.getElementById('facturi-tfoot');
      if(tf) tf.style.display='none';
      if(counter) counter.textContent='— facturi';
      if(errEl){ errEl.textContent = 'Nu s-au putut încărca facturile: '+e.message; errEl.style.display=''; }
    }
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
})();
