---
prompt: 121
titlu: Filtre listă ALOP + căutare Nr. extinsă (DF→ALOP, ORD→furnizor) + dimensionare De la/Până la/Status
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_bump: 3.9.750 → 3.9.751
migratii: NU
cache_version_bump: NU (niciun fișier atins nu e în PRECACHE_ASSETS)
v_param_bump: DOAR pe alop.js și formular.css (list.js NU e atins)
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
`main` = PRODUCȚIE, administrat MANUAL de Mircea. NU face niciodată checkout/merge/push pe `main`.
Toate commit-urile pe `develop`. Pasul final OBLIGATORIU: `git push origin develop` (declanșează auto-deploy pe staging).

Primul lucru pe orice stație:
```
git fetch origin && git status && git log --oneline --graph --all -6
```
Trebuie să fii pe `develop`, curat, aliniat cu `origin/develop` (v3.9.750).

---

# CONTEXT

Trei fixuri pe zona de LISTE (DF/ORD + ALOP), toate low-risk (UX + o extindere mărginită de căutare pe backend). Fără migrații. Fără atingerea zonei de semnare NO-TOUCH.

**A. Căutare Nr. extinsă** (backend `server/routes/formulare/shared.mjs`, ruta `GET /api/formulare/list`):
- la **DF**, căutarea după `nr` să acopere ȘI denumirea ALOP-ului legat;
- la **ORD**, căutarea după `nr` să acopere ȘI denumirea furnizorului (`fo.beneficiar`).

**B. Filtre pe lista ALOP** (ca la DF/ORD, vizual identice): backend `server/routes/alop.mjs` (`GET /api/alop`) + markup în `public/formular.html` + logică în `public/js/formular/alop.js`.

**C. Dimensionare filtre** (`public/css/formular/formular.css` + un `id` în `formular.html`): câmpurile **De la / Până la** mai mici (cât să încapă `zz.ll.aaaa` + iconița 📅), câmpul **Status** mai lat (să încapă „La Responsabil CAB"). Se aplică la DF ȘI la noile filtre ALOP.

**Fapte de cod deja verificate (nu le re-descoperi, folosește-le):**
- ALOP list backend suportă DEJA `status`; query-ul de COUNT (`SELECT COUNT(*) FROM alop_instances a WHERE ${where}`) **nu are JOIN pe `users`** ⇒ orice filtru nou trebuie să fie pe `a.*` SAU printr-un `EXISTS` corelat (NU adăuga un JOIN).
- `buildAlopVisibilityWhere` referă doar `a.*` + subquery-uri corelate ⇒ compatibil cu COUNT-ul.
- Legătura DF↔ALOP: `alop_instances.df_id = formulare_df.id` (activ) SAU `formulare_df.source_alop_id = alop_instances.id` (proveniență). Ambele coloane există.
- ORD: `fo.beneficiar` = furnizorul (deja selectat `AS titlu` în listă).
- Helperele de dată `window.onDateTextInput(displayEl, hiddenIsoId)` și `window.onDatePickerChange(pickerEl, displayId)` există în `draft.js` (încărcat de formular.html). `onDateTextInput` face `dispatchEvent('change')` pe input-ul ascuns când data e completă ⇒ oglindim exact pattern-ul DF.
- Lista compartimentelor: `window.ST.orgProfile._compList` (același folosit de `_populateCompartimente` din list.js).
- PRECACHE_ASSETS (sw.js) NU conține alop.js / formular.css / formular.html ⇒ **fără bump CACHE_VERSION**, doar `?v=` țintit.
- `?v=` curent: `formular.css?v=3.9.697`, `alop.js?v=3.9.723`, `list.js?v=3.9.722` (list.js NU se atinge).

⛔ ZONĂ NO-TOUCH (neatinsă de acest prompt): `server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`.

===============================================================================
# ETAPA A — Căutare Nr. extinsă (backend, `server/routes/formulare/shared.mjs`)
===============================================================================

## Pas A1 — DF: nr caută și în denumirea ALOP legat

Găsește în ramura DF (în jur de linia 477) blocul:
```
      if (nr) {
        conds.push(`fd.nr_unic_inreg ILIKE $${params.push('%' + nr + '%')}`);
      }
```
Înlocuiește-l (`str_replace`) cu:
```
      if (nr) {
        // #121: căutarea după Nr. la DF acoperă și denumirea ALOP-ului legat —
        // activ (a.df_id=fd.id) sau proveniență (fd.source_alop_id=a.id). org_id egal ⇒ fără canal cross-tenant.
        const iNr = params.push('%' + nr + '%');
        conds.push(`(fd.nr_unic_inreg ILIKE $${iNr} OR EXISTS (
          SELECT 1 FROM alop_instances a_s
          WHERE (a_s.df_id = fd.id OR a_s.id = fd.source_alop_id)
            AND a_s.org_id = fd.org_id
            AND a_s.titlu ILIKE $${iNr}
        ))`);
      }
```

## Pas A2 — ORD: nr caută și în denumirea furnizorului

Găsește în ramura ORD (în jur de linia 603) blocul:
```
      if (nr) {
        conds.push(`fo.nr_ordonant_pl ILIKE $${params.push('%' + nr + '%')}`);
      }
```
Înlocuiește-l cu:
```
      if (nr) {
        // #121: căutarea după Nr. la ORD acoperă și denumirea furnizorului (fo.beneficiar).
        const iNr = params.push('%' + nr + '%');
        conds.push(`(fo.nr_ordonant_pl ILIKE $${iNr} OR fo.beneficiar ILIKE $${iNr})`);
      }
```

### Verificare A
```
grep -n "a_s.titlu ILIKE\|fo.beneficiar ILIKE" server/routes/formulare/shared.mjs
# Așteptat: câte o linie pentru fiecare (una în ramura DF, una în ORD)
grep -c "params.push('%' + nr + '%')" server/routes/formulare/shared.mjs
# Așteptat: 0  (ambele au trecut pe const iNr = params.push(...))
```

===============================================================================
# ETAPA B — Filtre listă ALOP
===============================================================================

## Pas B1 — Backend: extinde `GET /api/alop` (`server/routes/alop.mjs`)

Găsește (în jur de linia 321):
```
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const params = [isPlatformAdmin(actor) ? null : actor.orgId];
    let where = '($1::int IS NULL OR a.org_id = $1) AND a.cancelled_at IS NULL';
    where += await buildAlopVisibilityWhere(actor, params);
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }
```
Înlocuiește cu:
```
    const { status, q, creat, comp, from, to, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const params = [isPlatformAdmin(actor) ? null : actor.orgId];
    let where = '($1::int IS NULL OR a.org_id = $1) AND a.cancelled_at IS NULL';
    where += await buildAlopVisibilityWhere(actor, params);
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }
    // #121: filtre listă ALOP (oglindesc DF/ORD). Toate pe a.* (valabile și în COUNT, care n-are JOIN),
    // iar „creat de" printr-un EXISTS corelat pe users — NU adăuga un JOIN în cele două query-uri.
    if (q) {
      params.push('%' + String(q).trim() + '%');
      where += ` AND a.titlu ILIKE $${params.length}`;
    }
    if (comp) {
      params.push(comp);
      where += ` AND a.compartiment = $${params.length}`;
    }
    if (from) {
      params.push(from);
      where += ` AND a.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(to + 'T23:59:59');
      where += ` AND a.created_at < $${params.length}`;
    }
    if (creat) {
      const iCreat = params.push('%' + String(creat).trim() + '%');
      where += ` AND EXISTS (SELECT 1 FROM users cu WHERE cu.id = a.created_by AND (cu.nume ILIKE $${iCreat} OR cu.email ILIKE $${iCreat}))`;
    }
```
⛔ NU muta `LIMIT/OFFSET` — rămân `$${params.length + 1}`/`$${params.length + 2}` la finalul query-ului principal, iar COUNT-ul folosește `params` fără ele. Nu schimba `a.cancelled_at IS NULL` (ALOP anulate rămân ascunse din listă — de aceea „Anulat" NU apare în dropdown-ul de status; NU-l adăuga).

### Verificare B1
```
grep -n "a.titlu ILIKE\|EXISTS (SELECT 1 FROM users cu WHERE cu.id = a.created_by" server/routes/alop.mjs
# Așteptat: liniile noi prezente
```

## Pas B2 — Markup filtre în `public/formular.html`

Găsește:
```
  <div id="alop-list-panel">
    <div class="lst-table-wrap">
```
Înlocuiește cu (inserează blocul de filtre ÎNTRE ele):
```
  <div id="alop-list-panel">
    <div class="lst-filters">
      <div class="lst-filter-row">
        <!-- 1. Titlu -->
        <div class="flt-grp" id="flt-a-q-grp">
          <label class="flt-lbl">Titlu</label>
          <input type="text" id="flt-a-q" class="flt-inp" placeholder="Căutați..." oninput="debouncedLoadAlop()"/>
        </div>
        <!-- 2. Creat de -->
        <div class="flt-grp" id="flt-a-creat-grp">
          <label class="flt-lbl">Creat de</label>
          <input type="text" id="flt-a-creat" class="flt-inp" placeholder="Căutați..." oninput="debouncedLoadAlop()"/>
        </div>
        <!-- 3. Compartiment -->
        <div class="flt-grp" id="flt-a-comp-wrap">
          <label class="flt-lbl">Compartiment</label>
          <select id="flt-a-comp" class="flt-sel" onchange="_alopFilterChanged()"><option value="">Toate</option></select>
        </div>
        <!-- 4. Status -->
        <div class="flt-grp" id="flt-a-status-grp">
          <label class="flt-lbl">Status</label>
          <select id="flt-a-status" class="flt-sel" onchange="_alopFilterChanged()">
            <option value="">Toate</option>
            <option value="draft">Draft</option>
            <option value="angajare">DF în lucru</option>
            <option value="lichidare">Lichidare</option>
            <option value="ordonantare">Ordonanțare</option>
            <option value="plata">Plată</option>
            <option value="completed">Finalizat</option>
          </select>
        </div>
        <!-- 5. De la -->
        <div class="flt-grp" id="flt-a-from-grp">
          <label class="flt-lbl">De la</label>
          <div style="position:relative;width:100%;">
            <input type="text" id="flt-a-from-display" class="flt-inp" placeholder="zz.ll.aaaa" maxlength="10" autocomplete="off"
              style="width:100%;padding-right:32px;letter-spacing:.5px;box-sizing:border-box;"
              oninput="onDateTextInput(this,'flt-a-from')" />
            <input type="date" id="flt-a-from" data-ro-date="1" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;opacity:0;cursor:pointer;" onchange="onDatePickerChange(this,'flt-a-from-display');_alopFilterChanged();" />
            <span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:13px;">📅</span>
          </div>
        </div>
        <!-- 6. Până la -->
        <div class="flt-grp" id="flt-a-to-grp">
          <label class="flt-lbl">Până la</label>
          <div style="position:relative;width:100%;">
            <input type="text" id="flt-a-to-display" class="flt-inp" placeholder="zz.ll.aaaa" maxlength="10" autocomplete="off"
              style="width:100%;padding-right:32px;letter-spacing:.5px;box-sizing:border-box;"
              oninput="onDateTextInput(this,'flt-a-to')" />
            <input type="date" id="flt-a-to" data-ro-date="1" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;opacity:0;cursor:pointer;" onchange="onDatePickerChange(this,'flt-a-to-display');_alopFilterChanged();" />
            <span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:13px;">📅</span>
          </div>
        </div>
        <!-- 7. Reset -->
        <button class="df-action-btn sm" style="align-self:flex-end" onclick="resetAlopFilters()" title="Resetează filtrele">↺</button>
      </div>
    </div>
    <div class="lst-table-wrap">
```

## Pas B3 — Logică filtre în `public/js/formular/alop.js`

### B3.1 — citește filtrele în `loadAlop()`
Găsește:
```
    const qs=new URLSearchParams();
    qs.set('page',_alopState.page);
    qs.set('limit',_alopState.limit);
```
Înlocuiește cu:
```
    _populateAlopCompartimente();
    const qs=new URLSearchParams();
    const _q     =(document.getElementById('flt-a-q')?.value||'').trim();
    const _creat =(document.getElementById('flt-a-creat')?.value||'').trim();
    const _comp  =document.getElementById('flt-a-comp')?.value||'';
    const _fstat =document.getElementById('flt-a-status')?.value||'';
    const _from  =document.getElementById('flt-a-from')?.value||'';
    const _to    =document.getElementById('flt-a-to')?.value||'';
    if(_q)     qs.set('q',_q);
    if(_creat) qs.set('creat',_creat);
    if(_comp)  qs.set('comp',_comp);
    if(_fstat) qs.set('status',_fstat);
    if(_from)  qs.set('from',_from);
    if(_to)    qs.set('to',_to);
    qs.set('page',_alopState.page);
    qs.set('limit',_alopState.limit);
```

### B3.2 — adaugă helperele (debounce / reset / populate)
Găsește semnătura funcției:
```
async function loadAlop(){
```
și inserează ÎNAINTE de ea blocul:
```
let _alopFltTimer=null;
function debouncedLoadAlop(){
  clearTimeout(_alopFltTimer);
  _alopFltTimer=setTimeout(()=>{ _alopState.page=1; loadAlop(); },400);
}
function _alopFilterChanged(){ _alopState.page=1; loadAlop(); }
function resetAlopFilters(){
  ['flt-a-q','flt-a-creat','flt-a-from','flt-a-to','flt-a-from-display','flt-a-to-display'].forEach(id=>{
    const e=document.getElementById(id); if(e){ e.value=''; e.style.borderColor=''; }
  });
  const cp=document.getElementById('flt-a-comp'); if(cp) cp.value='';
  const st=document.getElementById('flt-a-status'); if(st) st.value='';
  _alopState.page=1; loadAlop();
}
function _populateAlopCompartimente(){
  const sel=document.getElementById('flt-a-comp');
  if(!sel)return;
  const list=window.ST?.orgProfile?._compList||[];
  if(!list.length)return;
  const cur=sel.value;
  sel.innerHTML='<option value="">Toate</option>'+list.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value=cur;
}
```

### B3.3 — exportă noile funcții pe `window`
Găsește blocul de export (în jur de linia 1192):
```
  window.loadAlop                   = loadAlop;
```
și inserează IMEDIAT DUPĂ:
```
  window.debouncedLoadAlop          = debouncedLoadAlop;
  window._alopFilterChanged         = _alopFilterChanged;
  window.resetAlopFilters           = resetAlopFilters;
```

### Verificare B3
```
grep -n "debouncedLoadAlop\|_alopFilterChanged\|resetAlopFilters\|_populateAlopCompartimente" public/js/formular/alop.js
# Așteptat: definiții + exporturi + apelul din loadAlop
node -e "require('fs').readFileSync('public/js/formular/alop.js','utf8')" && echo "sintaxa fișierului OK (citire)"
```

===============================================================================
# ETAPA C — Dimensionare filtre (De la/Până la mai mici, Status mai lat)
===============================================================================

## Pas C1 — `id` pe grupul Status DF în `public/formular.html`

Găsește:
```
      <!-- 5. Status -->
      <div class="flt-grp">
        <label class="flt-lbl">Status</label>
        <select id="flt-status" class="flt-sel" onchange="loadList()">
```
Înlocuiește cu:
```
      <!-- 5. Status -->
      <div class="flt-grp" id="flt-status-grp">
        <label class="flt-lbl">Status</label>
        <select id="flt-status" class="flt-sel" onchange="loadList()">
```

## Pas C2 — reguli de lățime în `public/css/formular/formular.css`

Găsește blocul:
```
    /* Lățimi proporționale per filtru (oglindesc ordinea și nevoile coloanelor) */
    .flt-grp#flt-nr-grp{flex:0.5 1 70px}
    .flt-grp#flt-init-grp{flex:1.1 1 110px}
    .flt-grp#flt-comp-wrap{flex:1.4 1 140px}
    .flt-grp#flt-p2-grp{flex:1.1 1 110px}
    .flt-grp#flt-from-grp,
    .flt-grp#flt-to-grp{flex:1.3 1 130px}
```
Înlocuiește cu:
```
    /* Lățimi proporționale per filtru (oglindesc ordinea și nevoile coloanelor) */
    .flt-grp#flt-nr-grp{flex:0.7 1 90px}
    .flt-grp#flt-init-grp{flex:1.1 1 110px}
    .flt-grp#flt-comp-wrap{flex:1.4 1 140px}
    .flt-grp#flt-p2-grp{flex:1.1 1 110px}
    /* #121: Status mai lat (încape „La Responsabil CAB") — DF + ALOP */
    .flt-grp#flt-status-grp,
    .flt-grp#flt-a-status-grp{flex:1.9 1 170px}
    /* #121: De la / Până la — compacte, cât să încapă zz.ll.aaaa + iconița 📅 (DF + ALOP) */
    .flt-grp#flt-from-grp,
    .flt-grp#flt-to-grp,
    .flt-grp#flt-a-from-grp,
    .flt-grp#flt-a-to-grp{flex:0 0 118px}
    /* #121: filtre ALOP — titlu / creat de / compartiment */
    .flt-grp#flt-a-q-grp{flex:1.5 1 150px}
    .flt-grp#flt-a-creat-grp{flex:1.1 1 120px}
    .flt-grp#flt-a-comp-wrap{flex:1.4 1 140px}
```

Apoi găsește blocul media-query îngust:
```
    @media (max-width:1100px){
      .lst-filter-row{flex-wrap:wrap}
      .flt-grp{flex:1 1 140px}
      .flt-grp#flt-nr-grp,
      .flt-grp#flt-init-grp,
      .flt-grp#flt-comp-wrap,
      .flt-grp#flt-p2-grp,
      .flt-grp#flt-from-grp,
      .flt-grp#flt-to-grp{flex:1 1 140px}
    }
```
Înlocuiește cu:
```
    @media (max-width:1100px){
      .lst-filter-row{flex-wrap:wrap}
      .flt-grp{flex:1 1 140px}
      .flt-grp#flt-nr-grp,
      .flt-grp#flt-init-grp,
      .flt-grp#flt-comp-wrap,
      .flt-grp#flt-p2-grp,
      .flt-grp#flt-a-q-grp,
      .flt-grp#flt-a-creat-grp,
      .flt-grp#flt-a-comp-wrap{flex:1 1 140px}
      .flt-grp#flt-status-grp,
      .flt-grp#flt-a-status-grp{flex:1 1 160px}
      .flt-grp#flt-from-grp,
      .flt-grp#flt-to-grp,
      .flt-grp#flt-a-from-grp,
      .flt-grp#flt-a-to-grp{flex:0 1 118px}
    }
```

### Verificare C
```
grep -n "flt-status-grp\|flt-a-status-grp\|flt-a-from-grp\|flt:0 0 118px\|flex:0 0 118px" public/css/formular/formular.css
grep -n 'id="flt-status-grp"' public/formular.html
# Așteptat: grupul Status DF are id, regulile CSS pentru status+date prezente
```

===============================================================================
# ETAPA D — Teste (test:db REAL, PASSED nu SKIPPED)
===============================================================================

⚠️ „Docker absent" NU e motiv de skip. PostgreSQL 17 e disponibil local. Folosește rețeta EFEMERĂ din `CLAUDE.md` (instanță proprie pe port dedicat, parolă proprie, curățare la final). `npm run test:db` trebuie să ruleze REAL și să treacă ÎNAINTE de push. Mock-urile pe `pool.query` confirmă FORMA, nu comportamentul — o cale de listă fără test DB real e o cale netestată.

## Pas D1 — Test DB: căutare Nr. extinsă (`server/tests/db/formulare-list-nr-search.test.mjs`, NOU)
Importă din PRODUCȚIE (montează app-ul real / router-ul real, NU redeclara logica). Folosește `seedOrgUser`/helperele existente din `server/tests/helpers/db-real.mjs`.
Cazuri:
1. **DF → denumire ALOP**: creează un ALOP cu `titlu='Reparatii strada Garii'` legat de un DF (setează `alop_instances.df_id = <df.id>` sau `formulare_df.source_alop_id = <alop.id>` — testează AMBELE direcții în două sub-cazuri). `GET /api/formulare/list?type=df&nr=Reparatii` ⇒ DF-ul apare, `total>=1`.
2. **DF → nr numeric încă merge**: căutare după fragmentul din `nr_unic_inreg` întoarce același DF.
3. **DF → izolare org**: un ALOP cu titlu care s-ar potrivi dar dintr-o ALTĂ org NU face DF-ul altei org să apară (org egal impus prin `a_s.org_id = fd.org_id`).
4. **ORD → furnizor**: creează un ORD cu `beneficiar='SC ACME DISTRIBUTIE SRL'`. `GET /api/formulare/list?type=ord&nr=ACME` ⇒ ORD-ul apare.
5. **ORD → nr numeric încă merge**.

## Pas D2 — Test DB: filtre ALOP (`server/tests/db/alop-list-filtre.test.mjs`, NOU)
Seed: 1 org, 2 useri în compartimente diferite (ex. „Serviciul Buget" și „Compartimentul Juridic"), câțiva ALOP cu titluri/status/created_at/creator diferite. Ca actor folosește un org_admin (vede tot org-ul), ca să testezi filtrele, nu vizibilitatea.
Cazuri (fiecare verifică `total` + prezența/absența id-urilor așteptate):
1. `?q=<fragment titlu>` — întoarce doar ALOP-urile cu titlul potrivit.
2. `?status=lichidare` — doar cele în lichidare.
3. `?comp=Serviciul%20Buget` — doar ALOP cu `compartiment` potrivit.
4. `?creat=<nume/email creator>` — doar ALOP create de acel user (verifică și că EXISTS-ul corelat merge în COUNT: `total` corect).
5. `?from=&to=` — interval pe `created_at` (folosește un ALOP vechi și unul azi; verifică `to` inclusiv până la 23:59:59).
6. combinație `?status=...&comp=...` — intersecție corectă.
7. negativ: `?q=zzz-inexistent` ⇒ `total=0`, `alop=[]`.

## Pas D3 — Test structural ușor (`server/tests/unit/`, extinde sau nou)
Aserții pe surse (readFileSync):
- `public/formular.html` conține `id="flt-a-q"`, `id="flt-a-status"`, `id="flt-a-from"`, `resetAlopFilters()` și `id="flt-status-grp"`;
- `public/js/formular/alop.js` conține `window.resetAlopFilters`, `window.debouncedLoadAlop`, `_populateAlopCompartimente` și citește `qs.set('q'`/`qs.set('status'`;
- `public/css/formular/formular.css` conține `flt-a-status-grp` și `flt-a-from-grp`.

===============================================================================
# ETAPA E — Versionare + cache-busting + rulare completă
===============================================================================

## Pas E1 — bump versiune
- `package.json`: `3.9.750` → `3.9.751` (patch).

## Pas E2 — `?v=` ȚINTIT (DOAR pe assetele atinse), în `public/formular.html`
```
sed -i -E 's#(formular/alop\.js\?v=)[0-9.]+#\13.9.751#g' public/formular.html
sed -i -E 's#(formular/formular\.css\?v=)[0-9.]+#\13.9.751#g' public/formular.html
```
⛔ NU atinge `list.js?v=3.9.722` (fișierul nu e modificat). NU face bulk-sed pe toate `?v=`.
⚠️ După `sed` pe HTML: grupul de captură e `\1`, NU `\g<1>`. Verifică linia atinsă cu `grep` (un `?v=` corupt nu pică niciun test).

### Verificare E2
```
grep -n "formular/alop.js?v=\|formular/formular.css?v=\|formular/list.js?v=" public/formular.html
# Așteptat: alop.js=3.9.751, formular.css=3.9.751, list.js=3.9.722 (NEATINS)
```

## Pas E3 — CACHE_VERSION: NU se bumpează
Niciun fișier atins (alop.js, formular.css, formular.html) nu e în `PRECACHE_ASSETS`. Confirmă:
```
grep -n "alop.js\|formular.css\|formular.html" public/sw.js
# Așteptat: nicio potrivire în lista PRECACHE_ASSETS
```

## Pas E4 — rulare completă (poartă obligatorie înainte de push)
```
npm test
# Așteptat: verde, fără regresii (numărul de teste crește cu cele noi)

# test:db REAL — rețeta efemeră PG 17 din CLAUDE.md:
export TEST_DATABASE_URL=<instanța efemeră proprie>
npm run test:db
# Așteptat: PASSED REAL (NU „skipped"), inclusiv cele două fișiere noi
```
Dacă `test:db` raportează „skipped / no Docker": OPREȘTE-TE, pornește instanța PG efemeră din CLAUDE.md și rulează din nou. Skipped ≠ passed.

## Pas E5 — commit + push
```
git add -A
git commit -m "feat(#121): filtre listă ALOP + căutare Nr. extinsă (DF→ALOP, ORD→furnizor) + dimensionare De la/Până la/Status — v3.9.751"
git push origin develop
```
⛔ Push DOAR pe `origin develop`. NICIODATĂ pe `main`.

===============================================================================
# RAPORT FINAL (completează după rulare)
===============================================================================
- Commit hash (develop): __________
- Rezultat `git push origin develop`: __________
- `npm test`: ____ fișiere / ____ teste (verde? da/nu)
- `npm run test:db`: ____ fișiere / ____ teste — PASSED REAL? (da/nu; dacă „skipped" → NEACCEPTAT)
- ETAPA A: liniile noi în shared.mjs (DF a_s.titlu, ORD fo.beneficiar) — confirmate? __________
- ETAPA B: `?page/?limit` + noile filtre în /api/alop; COUNT-ul rulează fără eroare de alias (fără JOIN users)? __________
- ETAPA C: `id="flt-status-grp"` adăugat; reguli CSS status(lat)/date(compacte) prezente? __________
- `?v=`: alop.js=____, formular.css=____, list.js=3.9.722 (neatins)? __________
- CACHE_VERSION: neschimbat (confirmat că niciun asset atins nu-i în PRECACHE)? __________
- Abateri de la prompt (dacă există) + motiv: __________

===============================================================================
# ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================
- ⛔ EXCLUSIV `develop`. Nimic pe `main`. Pasul final = `git push origin develop`.
- ⛔ Zona de semnare NO-TOUCH neatinsă (STSCloudProvider / cloud-signing / bulk-signing / pades / java-pades-client).
- ⛔ FĂRĂ migrații (niciun `.sql` nou, nimic în `server/db/index.mjs`).
- ⛔ FĂRĂ bump `CACHE_VERSION` (niciun asset atins nu-i în PRECACHE). `?v=` DOAR pe alop.js + formular.css. NU atinge list.js.
- ⛔ NU muta `LIMIT/OFFSET` în /api/alop; NU adăuga JOIN pe users (folosește EXISTS corelat pentru „creat de"), altfel COUNT-ul crapă.
- ⛔ NU adăuga „Anulat" în dropdown-ul de status ALOP (lista ascunde `cancelled_at IS NOT NULL` ⇒ ar fi mereu gol).
- ⛔ `test:db` PASSED REAL, nu SKIPPED. Mock pe `pool.query` = FORMĂ, nu comportament — căile de listă cer test DB real.
- ⛔ Nu redeclara logica în teste — importă din producție.
- ⛔ Citește fiecare fișier ÎNAINTE de patch; `old_str` unic (whitespace inclus). După orice `sed` pe HTML, verifică linia cu `grep`.
