---
title: "Facturi — F4 (bară filtre + coloane sortabile + export CSV)"
branch: develop
model_suggested: Sonnet 4.6 (Default)   # frontend izolat pe #facturi-section
version_bump: citește versiunea curentă din package.json și incrementează patch (aștept 3.9.694 → 3.9.695)
cache_bump: NU
depends_on: F1 + F2 (obligatoriu); F3 recomandat ÎNAINTE (ca să existe coloana Valoare)
---

# ⚠️⚠️ BRANCH: develop ⚠️⚠️
`main` = PRODUCȚIE, MANUAL de Mircea. NU checkout/merge/push pe `main`.

====================================================================
OBIECTIV
====================================================================
Centralizatorul „Facturi" e read-only și încarcă toate facturile într-un array. Adăugăm,
STRICT client-side (fără schimbări de endpoint):
  1. bară de filtre focalizată (NU un filtru per coloană),
  2. coloane sortabile (click pe header),
  3. export CSV care respectă filtrele active.

Filtre (cum caută efectiv Serviciul Buget):
  • Căutare globală — un input care caută în nr. factură, nr. PV, titlu ALOP, observații.
  • Interval dată factură — De la / Până la (reutilizează pattern-ul RO din listă).
  • Status ORD — Toate / Cu ORD / Fără ORD.
  • Confirmat de — dropdown populat din datele încărcate.
  • Reset + contor „X din Y facturi".

⛔ NO-TOUCH: server/signing/*. Read-only rămâne read-only (fără editare/ștergere).
CITEȘTE `public/js/formular/facturi.js` și `#facturi-section` ÎNAINTE (F2/F3 le-au scris/
modificat — lucrează pe conținutul REAL, nu pe presupuneri).

====================================================================
PAS 1 — Refactor facturi.js: ține datele în memorie + funcție de randare filtrată
====================================================================
Azi `openFacturi()` face fetch și scrie direct în tbody. Refactorează minimal:
  • păstrează array-ul brut într-o variabilă de modul: `let _allFacturi = [];`
  • `openFacturi()` face fetch-ul, salvează în `_allFacturi`, populează dropdown-ul
    „Confirmat de", apoi cheamă `_renderFacturi()`.
  • `_renderFacturi()` aplică filtre + sortare pe `_allFacturi`, randează rândurile,
    actualizează contorul „X din Y" și (dacă F3 e livrat) TOTALUL pe rândurile filtrate.

Filtrarea (pură, pe array):
```js
function _facturiFiltrate(){
  const q       = (document.getElementById('fact-q')?.value||'').trim().toLowerCase();
  const from    = document.getElementById('fact-from')?.value||'';   // yyyy-mm-dd
  const to      = document.getElementById('fact-to')?.value||'';
  const ordSt   = document.getElementById('fact-ord-status')?.value||'all';
  const confBy  = document.getElementById('fact-conf-by')?.value||'';
  return _allFacturi.filter(f=>{
    if(q){
      const hay = [f.nr_factura,f.nr_pv,f.alop_titlu,f.notes].map(x=>(x||'').toString().toLowerCase()).join(' ');
      if(!hay.includes(q)) return false;
    }
    if(from && (!f.data_factura || f.data_factura < from)) return false;
    if(to   && (!f.data_factura || f.data_factura > to))   return false;
    if(ordSt==='cu'  && !f.ord_id) return false;
    if(ordSt==='fara'&&  f.ord_id) return false;
    if(confBy && (f.confirmed_by_name||'') !== confBy) return false;
    return true;
  });
}
```
Notă comparație date: `data_factura` vine ca ISO/`yyyy-mm-dd` din DB → comparație string
`>=`/`<=` e corectă dacă normalizezi la primele 10 caractere (`String(f.data_factura).slice(0,10)`).
Aplică `.slice(0,10)` la comparație ca să eviți diferențe de timezone.

Sortare: `let _sort = { key:'data_factura', dir:'desc' };` — click pe `<th data-sort="KEY">`
comută cheia/direcția; `_renderFacturi()` sortează înainte de randare. Chei sortabile:
nr_factura, data_factura, alop_titlu, confirmed_at (+ `valoare` dacă F3 e livrat).
Sortare numerică pentru `valoare`, string/localeCompare pentru rest, dată ca string ISO.

====================================================================
PAS 2 — Bară de filtre în #facturi-section (formular.html)
====================================================================
Citește secțiunea și inserează bara ÎNAINTE de `#facturi-table-wrap` (după banner/contor).
Refolosește clasele existente de filtre din listă (`df-filter-select` pt. dropdown dark) și
pattern-ul de date RO (`onDateTextInput`/`onDatePickerChange` + input `type=date data-ro-date="1"`).
Schelet:
```html
<div class="facturi-filters" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px;">
  <div style="flex:1 1 220px;min-width:200px;">
    <label class="alop-lbl">Căutare</label>
    <input id="fact-q" type="text" placeholder="Nr. factură / PV / ALOP / observații" autocomplete="off" oninput="_renderFacturi()"/>
  </div>
  <div>
    <label class="alop-lbl">Dată factură — de la</label>
    <div style="position:relative">
      <input type="text" id="fact-from-display" placeholder="zz.ll.aaaa" maxlength="10" autocomplete="off" oninput="onDateTextInput(this,'fact-from')"/>
      <input type="date" id="fact-from" data-ro-date="1" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;opacity:0;cursor:pointer" onchange="onDatePickerChange(this,'fact-from-display'); _renderFacturi()"/>
      <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:13px">📅</span>
    </div>
  </div>
  <div>
    <label class="alop-lbl">până la</label>
    <div style="position:relative">
      <input type="text" id="fact-to-display" placeholder="zz.ll.aaaa" maxlength="10" autocomplete="off" oninput="onDateTextInput(this,'fact-to')"/>
      <input type="date" id="fact-to" data-ro-date="1" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;opacity:0;cursor:pointer" onchange="onDatePickerChange(this,'fact-to-display'); _renderFacturi()"/>
      <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:13px">📅</span>
    </div>
  </div>
  <div>
    <label class="alop-lbl">Status ORD</label>
    <select id="fact-ord-status" class="df-filter-select" onchange="_renderFacturi()">
      <option value="all">Toate</option>
      <option value="cu">Cu ORD</option>
      <option value="fara">Fără ORD</option>
    </select>
  </div>
  <div>
    <label class="alop-lbl">Confirmat de</label>
    <select id="fact-conf-by" class="df-filter-select" onchange="_renderFacturi()">
      <option value="">Toți</option>
    </select>
  </div>
  <button class="df-action-btn sm" type="button" onclick="_resetFacturiFilters()">↺ Reset</button>
  <button class="df-action-btn primary sm" type="button" onclick="_exportFacturiCsv()">
    <svg class="df-ico"><use href="/icons.svg?v=3.9.539#ico-download"/></svg> Export CSV
  </button>
</div>
```
`onDateTextInput`/`onDatePickerChange` trebuie să reapeleze `_renderFacturi()` — dacă
`onDateTextInput` nu primește un callback, adaugă un `oninput="_renderFacturi()"` separat pe
inputul text (nu strica sincronizarea display↔date existentă).

Populează dropdown-ul „Confirmat de" în `openFacturi()`:
```js
const conf = [...new Set(_allFacturi.map(f=>f.confirmed_by_name).filter(Boolean))].sort();
const sel = document.getElementById('fact-conf-by');
if(sel) sel.innerHTML = '<option value="">Toți</option>' + conf.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
```
`_resetFacturiFilters()`: golește cele 5 câmpuri (+ display-urile de dată), apoi `_renderFacturi()`.

====================================================================
PAS 3 — Headere sortabile
====================================================================
Adaugă `data-sort="KEY"` + `style="cursor:pointer"` pe `<th>`-urile sortabile și un indicator
▲/▼ pe coloana activă. Delegare de click pe thead (fără onclick inline). La click: dacă e
aceeași cheie → comută dir; altfel cheie nouă cu `dir='asc'`. Apoi `_renderFacturi()`.

====================================================================
PAS 4 — Export CSV (respectă filtrele active)
====================================================================
```js
function _exportFacturiCsv(){
  const rows = _facturiSortate(_facturiFiltrate());   // aceleași date ca în tabel
  const head = ['Nr. factura','Data factura','Valoare','Nr. PV','Data PV','ALOP','DF legat','ORD legata','Confirmat de','Data confirmare','Observatii'];
  const esc = v => { const s=(v==null?'':String(v)); return /[";\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const fmtD = d => d ? new Date(d).toLocaleDateString('ro-RO') : '';
  const body = rows.map(f => [
    f.nr_factura, fmtD(f.data_factura),
    (f.valoare!=null?String(f.valoare).replace('.',','):''),   // F3: virgulă zecimală RO
    f.nr_pv, fmtD(f.data_pv),
    f.alop_titlu,
    f.df_id ? 'DA' : '',
    f.ord_id ? 'DA' : '',
    f.confirmed_by_name, fmtD(f.confirmed_at), f.notes
  ].map(esc).join(';'));
  const csv = '\uFEFF' + head.join(';') + '\n' + body.join('\n');   // BOM UTF-8 pt. diacritice în Excel
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `facturi_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
```
Dacă F3 NU e încă livrat (fără coloana `valoare`): scoate coloana Valoare din head+body,
sau lasă `f.valoare` gol (va fi `undefined` → string gol). Adaptează la starea reală.
Separator `;` (Excel-RO folosește `;` fiindcă `,` e separator zecimal); BOM UTF-8 obligatoriu
altfel diacriticele apar corupte în Excel.

Expune noile funcții pe window (ca celelalte din facturi.js): `_renderFacturi`,
`_resetFacturiFilters`, `_exportFacturiCsv` (cele apelate din onclick/oninput HTML).

====================================================================
PAS 5 — Version bump + teste
====================================================================
```bash
node -p "require('./package.json').version"
# incrementează patch în package.json (ex. 3.9.694 → 3.9.695)
# ?v= bulk pe public/*.html cu noua versiune
npm test    # verde (nu există teste pe filtre client-side; verifică non-regresie)
```
NU bumpa CACHE_VERSION.

====================================================================
VERIFICARE MANUALĂ
====================================================================
1. Căutare „123" → tabelul se filtrează live; contorul arată „N din Total".
2. Interval dată → filtrează pe perioadă; Status ORD „Fără ORD" → doar cele fără ord.
3. „Confirmat de" → un singur operator. Reset → totul revine.
4. Click pe header „Data factură" → sortare asc/desc cu indicator.
5. Export CSV → fișierul conține DOAR rândurile filtrate, se deschide corect în Excel cu
   diacritice și coloane separate.

RAPORT FINAL: confirmarea că e strict client-side (zero schimbări de endpoint), lista
funcțiilor expuse pe window, npm test, versiune, dacă F3 era prezent (coloana Valoare).
⛔ develop ONLY · NU signing/* · read-only (fără butoane de editare) · citește facturi.js real.
