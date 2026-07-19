---
title: "Facturi — F2 frontend (subtab centralizator read-only + filtru Notificări)"
branch: develop
model_suggested: Sonnet 4.6 (Default)   # UX izolat, fără authz/financiar
version_bump: 3.9.692 → 3.9.693
cache_bump: NU (niciun fișier din PRECACHE_ASSETS nu e atins — vezi nota de la Pas 5)
depends_on: PROMPT_F1_facturi_backend.md  # rulează F1 ÎNTÂI și verifică endpointul
---

# ⚠️⚠️ BRANCH: develop ⚠️⚠️
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. NU checkout/merge/push pe `main`.

====================================================================
PRECONDIȚIE — F1 e deja pe develop și verde
====================================================================
```bash
grep -n "router.get('/api/alop/facturi'" server/routes/alop.mjs   # Așteptat: 1 rută
grep -n "'facturi'" server/db/index.mjs                            # Așteptat: în module_catalog
```
Contractul endpointului `GET /api/alop/facturi` → `{ ok:true, facturi:[...], total:N }`,
fiecare factură: alop_id, alop_titlu, df_id, ord_id, nr_factura, data_factura, nr_pv,
data_pv, notes, confirmed_at, confirmed_by_name, ciclu_nr, sursa.

====================================================================
CONTEXT
====================================================================
Subtabul „Facturi" în pagina Formulare (DUPĂ Clasa 8), tabel READ-ONLY cu toate facturile
din lichidări. Coloane clicabile: ALOP (mereu), DF (mereu), ORD (doar când e legată).
Gate permis/nepermis: `data-df-module="facturi"` (df-entitlements.js îl ascunde automat
când modulul e off — F1 a înregistrat cheia în catalog).
Plus: subtab „Facturi" în pagina Notificări care numără notificările `alop_factura_lichidata`.

Helperi globali disponibili: `window.esc`, `window.switchListTab`, `window.openAlop`,
`window.openDocFromList('df'|'ord', id)`.

====================================================================
PAS 1 — Buton subtab în formular.html (DUPĂ Clasa 8)
====================================================================
old_str:
```html
  <button class="df-subtab"        id="ltab-clasa8" data-df-module="clasa8"         onclick="switchListTab('clasa8')"><svg class="df-ico"><use href="/icons.svg?v=3.9.539#ico-landmark"/></svg> Clasa 8</button>
  <button class="df-subtab"        id="ltab-verify" data-df-module="verif-furnizor" onclick="switchListTab('verify')"><svg class="df-ico"><use href="/icons.svg?v=3.9.539#ico-shield"/></svg> Verificare furnizor</button>
```
new_str:
```html
  <button class="df-subtab"        id="ltab-clasa8" data-df-module="clasa8"         onclick="switchListTab('clasa8')"><svg class="df-ico"><use href="/icons.svg?v=3.9.539#ico-landmark"/></svg> Clasa 8</button>
  <button class="df-subtab"        id="ltab-facturi" data-df-module="facturi"       onclick="switchListTab('facturi')"><svg class="df-ico"><use href="/icons.svg?v=3.9.539#ico-file-text"/></svg> Facturi</button>
  <button class="df-subtab"        id="ltab-verify" data-df-module="verif-furnizor" onclick="switchListTab('verify')"><svg class="df-ico"><use href="/icons.svg?v=3.9.539#ico-shield"/></svg> Verificare furnizor</button>
```

====================================================================
PAS 2 — Secțiunea #facturi-section (DUPĂ /clasa8-section)
====================================================================
Anchor: comentariul de închidere al secțiunii Clasa 8.
old_str:
```html
</div><!-- /clasa8-section -->

<!-- ════════════ VERIFICARE FURNIZOR ═════════════════════════════════════════ -->
```
new_str:
```html
</div><!-- /clasa8-section -->

<!-- ════════════ FACTURI (centralizator lichidări, read-only) ═════════════════ -->
<div id="facturi-section" style="display:none;">
  <div style="padding:10px 14px;margin-bottom:14px;background:var(--df-teal-bg);border:1px solid var(--df-teal-bd);border-radius:var(--df-radius-md);font-size:.85rem;color:var(--df-text-2);">
    🧾 <strong>Centralizator facturi</strong> — toate facturile completate în lichidarea ciclurilor ALOP
    (curente și arhivate). Read-only. Coloanele <strong>ALOP</strong> și <strong>DF</strong> sunt clicabile;
    <strong>ORD</strong> devine clicabilă după întocmire.
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
    <span id="facturi-counter" style="margin-left:auto;font-size:.83rem;color:var(--df-text-3);">— facturi</span>
  </div>
  <div id="facturi-error" style="display:none;background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:10px 14px;font-size:.9rem;margin-bottom:12px;"></div>
  <div id="facturi-empty" style="display:none;padding:32px 20px;text-align:center;background:var(--df-surface);border:1px dashed var(--df-border-2);border-radius:12px;color:var(--df-text-3);">
    Nicio factură lichidată încă.
  </div>
  <div id="facturi-table-wrap" style="overflow-x:auto;">
    <table id="facturi-table" style="width:100%;border-collapse:collapse;font-size:.88rem;">
      <thead>
        <tr style="text-align:left;color:var(--df-text-3);font-size:.78rem;text-transform:uppercase;">
          <th style="padding:10px 12px;">Nr. factură</th>
          <th style="padding:10px 12px;">Data factură</th>
          <th style="padding:10px 12px;">Nr. PV</th>
          <th style="padding:10px 12px;">Data PV</th>
          <th style="padding:10px 12px;">ALOP</th>
          <th style="padding:10px 12px;">DF</th>
          <th style="padding:10px 12px;">ORD</th>
          <th style="padding:10px 12px;">Confirmat de</th>
          <th style="padding:10px 12px;">Data confirmare</th>
          <th style="padding:10px 12px;">Observații</th>
        </tr>
      </thead>
      <tbody id="facturi-tbody"></tbody>
    </table>
  </div>
  <style>
    #facturi-table tbody tr { border-top:1px solid var(--df-border-2); }
    #facturi-table tbody tr:hover { background: rgba(124,58,237,.06); }
    #facturi-table tbody td { padding:10px 12px; vertical-align:top; }
    #facturi-table .fact-link { color: var(--df-accent, #a78bfa); cursor:pointer; text-decoration:none; }
    #facturi-table .fact-link:hover { text-decoration:underline; }
    #facturi-table .fact-muted { color: var(--df-text-3); }
  </style>
</div><!-- /facturi-section -->

<!-- ════════════ VERIFICARE FURNIZOR ═════════════════════════════════════════ -->
```

====================================================================
PAS 3 — Ramura `facturi` în switchListTab (public/js/formular/list.js)
====================================================================
3.1 Toggle activ pentru noul tab. Găsește blocul de toggle pentru clasa8:
old_str:
```js
  const ltabClasa8=document.getElementById('ltab-clasa8');
  if(ltabClasa8)ltabClasa8.classList.toggle('active',type==='clasa8');
```
new_str:
```js
  const ltabClasa8=document.getElementById('ltab-clasa8');
  if(ltabClasa8)ltabClasa8.classList.toggle('active',type==='clasa8');
  const ltabFacturi=document.getElementById('ltab-facturi');
  if(ltabFacturi)ltabFacturi.classList.toggle('active',type==='facturi');
```

3.2 Referință la secțiune (lângă celelalte const …Section):
old_str:
```js
  const clasa8Section=document.getElementById('clasa8-section');
```
new_str:
```js
  const clasa8Section=document.getElementById('clasa8-section');
  const facturiSection=document.getElementById('facturi-section');
```

3.3 Ramura de afișare. Adaugă un `else if(type==='facturi')` DUPĂ ramura clasa8.
Găsește sfârșitul ramurii clasa8:
old_str:
```js
    if(clasa8Section)clasa8Section.style.display='';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof openClasa8==='function')openClasa8();
  }else if(type==='rfn'){
```
new_str:
```js
    if(clasa8Section)clasa8Section.style.display='';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof openClasa8==='function')openClasa8();
  }else if(type==='facturi'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    if(facturiSection)facturiSection.style.display='';
    const _foF=document.getElementById('foList');if(_foF)_foF.style.display='none';
    if(typeof openFacturi==='function')openFacturi();
  }else if(type==='rfn'){
```

⚠️ De asemenea, în TOATE celelalte ramuri (alop, verify, clasa8, rfn, nfi, else)
secțiunea facturi trebuie ASCUNSĂ. Adaugă în FIECARE ramură (după linia care ascunde
`clasa8Section`) o linie:
```js
    if(facturiSection)facturiSection.style.display='none';
```
Fă asta la fiecare din cele 6 ramuri (alop / verify / clasa8 / rfn / nfi / else final).
Verifică la final:
```bash
grep -c "facturiSection.style.display='none'" public/js/formular/list.js
# Așteptat: 6 (câte una în fiecare ramură care NU e 'facturi')
```

====================================================================
PAS 4 — Fișier nou: public/js/formular/facturi.js
====================================================================
Creează fișierul:

```js
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

  async function openFacturi(){
    const tbody = document.getElementById('facturi-tbody');
    const errEl = document.getElementById('facturi-error');
    const emptyEl = document.getElementById('facturi-empty');
    const counter = document.getElementById('facturi-counter');
    const wrap = document.getElementById('facturi-table-wrap');
    if(!tbody) return;
    if(errEl) errEl.style.display='none';
    if(emptyEl) emptyEl.style.display='none';
    tbody.innerHTML = '<tr><td colspan="10" style="padding:20px;text-align:center;color:var(--df-text-3)">Se încarcă…</td></tr>';
    try {
      const r = await fetch('/api/alop/facturi', { credentials:'include' });
      const j = await r.json();
      if(!r.ok || !j.ok) throw new Error(j.error || 'Eroare la încărcare');
      const facturi = j.facturi || [];
      if(counter) counter.textContent = `${facturi.length} ${facturi.length===1?'factură':'facturi'}`;
      if(!facturi.length){
        tbody.innerHTML='';
        if(wrap) wrap.style.display='none';
        if(emptyEl) emptyEl.style.display='';
        return;
      }
      if(wrap) wrap.style.display='';
      tbody.innerHTML = facturi.map(renderRow).join('');
    } catch(e){
      tbody.innerHTML='';
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
```

Încarcă scriptul în formular.html după clasa8.js:
old_str:
```html
<script src="/js/formular/clasa8.js?v=3.9.673" defer></script>
<script src="/js/formular/list.js?v=3.9.685" defer></script>
```
new_str:
```html
<script src="/js/formular/clasa8.js?v=3.9.673" defer></script>
<script src="/js/formular/facturi.js?v=3.9.693" defer></script>
<script src="/js/formular/list.js?v=3.9.685" defer></script>
```
(Valoarea `?v=` va fi normalizată la 3.9.693 de bulk-sed la Pas 6.)

====================================================================
PAS 5 — Subtab „Facturi" în pagina Notificări
====================================================================
5.1 Buton de filtru în public/notifications.html, după butonul „Formulare":
old_str:
```html
        <button class="filter-btn" data-filter="formulare"><svg class="df-ico df-ico-sm" viewBox="0 0 24 24" style="margin-right:5px;"><use href="/icons.svg?v=3.9.518#ico-file-text"/></svg>Formulare</button>
        <button class="filter-btn" data-filter="primite">📥 Primite</button>
```
new_str:
```html
        <button class="filter-btn" data-filter="formulare"><svg class="df-ico df-ico-sm" viewBox="0 0 24 24" style="margin-right:5px;"><use href="/icons.svg?v=3.9.518#ico-file-text"/></svg>Formulare</button>
        <button class="filter-btn" data-filter="facturi">🧾 Facturi</button>
        <button class="filter-btn" data-filter="primite">📥 Primite</button>
```

5.2 Logica de filtrare în public/js/notifications/notifications.js.
(a) Filtrul propriu-zis — adaugă în `filtered()`, lângă ramura 'formulare':
old_str:
```js
  if (currentFilter === 'formulare') return allNotifs.filter(n => FORMULARE_TYPES.has(n.type));
```
new_str:
```js
  if (currentFilter === 'formulare') return allNotifs.filter(n => FORMULARE_TYPES.has(n.type));
  if (currentFilter === 'facturi') return allNotifs.filter(n => n.type === 'alop_factura_lichidata');
```
(b) Contorul de badge — adaugă în obiectul de counts, lângă `formulare:`:
old_str:
```js
    formulare: allNotifs.filter(n => FORMULARE_TYPES.has(n.type)).length,
```
new_str:
```js
    formulare: allNotifs.filter(n => FORMULARE_TYPES.has(n.type)).length,
    facturi: allNotifs.filter(n => n.type === 'alop_factura_lichidata').length,
```
(c) Eticheta — adaugă în obiectul `labels`:
old_str:
```js
  const labels = { all:'Toate', unread:'Necitite', urgent:'🚨 Urgente', YOUR_TURN:'De semnat', REVIEW_REQUESTED:'De revizuit', COMPLETED:'Finalizate', REFUSED:'Refuzate', formulare:'📄 Formulare', primite:'📥 Primite' };
```
new_str:
```js
  const labels = { all:'Toate', unread:'Necitite', urgent:'🚨 Urgente', YOUR_TURN:'De semnat', REVIEW_REQUESTED:'De revizuit', COMPLETED:'Finalizate', REFUSED:'Refuzate', formulare:'📄 Formulare', facturi:'🧾 Facturi', primite:'📥 Primite' };
```
(d) Navigare la click — notificarea deschide DF-ul legat. Tipul nostru poartă
`data.form_type='df'` + `data.form_id=<df_id>`. Extinde condiția de navigare formulare
ca să includă și `alop_factura_lichidata`:
old_str:
```js
      if (FORMULARE_TYPES.has(n.type) && n.data) {
        const d = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
        if (d.form_type && d.form_id) {
          location.href = `/formular.html?form_type=${encodeURIComponent(d.form_type)}&form_id=${encodeURIComponent(d.form_id)}`;
```
new_str:
```js
      if ((FORMULARE_TYPES.has(n.type) || n.type === 'alop_factura_lichidata') && n.data) {
        const d = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
        if (d.form_type && d.form_id) {
          location.href = `/formular.html?form_type=${encodeURIComponent(d.form_type)}&form_id=${encodeURIComponent(d.form_id)}`;
```

NOTĂ cache: `notif-widget.js` (bell) NU se atinge — pentru `alop_factura_lichidata`
fără flowId, `buildActionUrl` întoarce deja `/notifications` (comportament IDENTIC cu
notificările formulare existente). Deci NICIUN fișier din PRECACHE_ASSETS nu e modificat →
NU se bumpează CACHE_VERSION. (`notifications.js`, `list.js`, `facturi.js`, `formular.html`,
`notifications.html` NU sunt în PRECACHE_ASSETS.)

====================================================================
PAS 6 — Version bump + ?v= + teste
====================================================================
```bash
# package.json 3.9.692 → 3.9.693
sed -i 's/"version": "3.9.692"/"version": "3.9.693"/' package.json
grep '"version"' package.json   # 3.9.693

# Bulk ?v= în toate HTML-urile (bust cache pentru fișierele NEprecache-uite)
sed -i -E 's/\?v=3\.9\.[0-9]+/?v=3.9.693/g' public/*.html
grep -c '?v=3.9.693' public/formular.html         # >0
grep -c 'facturi.js?v=3.9.693' public/formular.html  # Așteptat: 1

# NU bumpa CACHE_VERSION (vezi nota Pas 5)
grep -n "CACHE_VERSION" public/sw.js | head -1   # rămâne docflowai-v289

npm test
# Așteptat: verde, fără regresii
```

====================================================================
VERIFICARE MANUALĂ (post-deploy staging)
====================================================================
1. DevTools → Application → Service Workers → Unregister, apoi Ctrl+Shift+R.
2. /formular.html → apare subtabul „Facturi" ÎNTRE „Clasa 8" și „Verificare furnizor".
3. Click „Facturi" → tabel read-only cu facturile din lichidări; contor corect.
4. Click pe titlul unui ALOP → comută pe tab ALOP și deschide detaliul.
5. Click „Deschide DF" → se deschide DF-ul legat. „Deschide ORD" apare doar unde ord_id există.
6. Setări → Module & permisiuni → scope Organizație/Compartiment/User → dezactivează „Facturi"
   → subtabul dispare (df-entitlements.js). Reactivează → reapare.
7. Fă o lichidare cu factură dintr-un cont NON-Serviciu Buget → loghează-te cu un user din
   Serviciul Buget → /notifications → subtab „🧾 Facturi" numără notificarea; click → deschide DF.
8. Console: zero erori.

====================================================================
RAPORT FINAL (obligatoriu)
====================================================================
- confirmarea celor 6 ascunderi `facturiSection` + ramura nouă în switchListTab
- confirmarea că notif-widget.js NU a fost atins (deci fără cache bump)
- rezultat `npm test`, versiune, count `?v=3.9.693`
- orice presupunere făcută

⛔ CONSTRÂNGERI ABSOLUTE
- develop ONLY. NU main.
- NU atinge server/signing/* și NU atinge notif-widget.js (evită cache bump inutil).
- Modal/secțiuni: toggle prin `.style.display` pe secțiuni (pattern existent switchListTab),
  fără onclick inline cu escape — folosește data-* + delegare (deja în facturi.js).
- Tabelul e STRICT read-only: fără butoane de editare/ștergere.
