# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): `signing.mjs`, `bulk-signing.mjs`, `cloud-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`.

---

## Obiectiv — Etapa 3b (`renderAlopDetail` randează din `capabilities`)

`renderAlopDetail` din `public/js/formular/alop.js` devine consumator de `a.capabilities` (atașat în 3a
pe `GET /api/alop/:id`, dovedit prin teste). Enum-urile `df_action`/`phase_action` decid BUTONUL;
label/icon/onclick rămân client (prezentare). `can_revise_df`/`can_delete`/`can_start_noua_ordonantare`/
`can_refresh` gate-uiesc butoanele. Lista folosește `a.can_delete`. **Fără staleness** (ALOP re-fetch via
`openAlop` după orice mutație), deci o singură trecere. Trebuie **1:1** cu comportamentul actual.

Bonus igienă: dispare `console.log('[ALOP owner check]', …)` de la ~linia 509 (debug rămas în producție);
logica de owner trăiește acum în caps (server).

### Maparea enum → buton (verificat 1:1 cu blocul actual)

`df_action`: `in_lucru_disabled`→buton disabled "Revizie DF în lucru…"; `completeaza`→"Completează
Document de Fundamentare"; `revizuieste_neaprobat`→"Revizuiește DF (neaprobat)"; `flow_waiting`→text
"DF pe fluxul de semnare — în așteptare"; `deschide`→"Deschide DF".
`phase_action`: `confirma_lichidare`/`completeaza_ord`/`genereaza_lanseaza_ord` → buton + (`can_revise_df`?
"Revizuiește DF"); `marcheaza_ord_semnat`→"Marchează ORD semnat complet"; `confirma_plata`→"Confirmă Plata"
(cu arg `parseFloat(a.ord_valoare||0)` păstrat).

---

## Patch 1 — `alop.js`: lista folosește `a.can_delete`

**old_str**
```
      const active=a.status!=='completed'&&a.status!=='cancelled';
      // Ștergere permisă doar dacă ALOP nu are DF/ORD legat
      const canCancel=active&&!a.df_id&&!a.ord_id;
```
**new_str**
```
      // Ștergere: flag server-side (can_delete din /api/alop). 1:1 cu vechiul active&&!df_id&&!ord_id.
      const canCancel=a.can_delete===true;
```

---

## Patch 2 — `alop.js`: `renderAlopDetail` — variabila `caps`

Adaugă `caps` lângă `isCompleted`/`isCancelled`.

**old_str**
```
  const isCompleted=a.status==='completed';
  const isCancelled=a.status==='cancelled';
```
**new_str**
```
  const isCompleted=a.status==='completed';
  const isCancelled=a.status==='cancelled';
  const caps=a.capabilities||{}; // sursă unică server-side (Etapa 3)
```

> Dacă cele două linii apar și în altă funcție, ancorează pe contextul `renderAlopDetail` (sunt în
> deschiderea ei, ~liniile 460–461).

---

## Patch 3 — `alop.js`: înlocuiește blocul de acțiuni (magnetul) cu randare din caps

Înlocuiește INTEGRAL blocul de la `let actionsHtml='';` până la `}` care închide
`if(!isCompleted&&!isCancelled&&isAlopOwner){ … }` (inclusiv `console.log`-ul de debug).

**old_str**
```
  let actionsHtml='';
  const currentUserId = ST.user?.userId;
  const isAlopOwner = !currentUserId || String(a.created_by) === String(currentUserId)
    || ST.user?.role === 'admin'
    || ST.user?.role === 'org_admin';
  console.log('[ALOP owner check]', {
    currentUserId, aCreatedBy: a.created_by,
    match: String(a.created_by) === String(currentUserId),
    role: ST.user?.role, isAlopOwner
  });
  if(!isCompleted&&!isCancelled&&isAlopOwner){
    const id=esc(a.id);
    const dfInLucru=!!a.df_revizie_in_lucru;
    const dfStatus=a.df_status||'';
    if(dfInLucru){
      actionsHtml+=`<button class="df-action-btn" disabled title="Există deja o revizie DF în lucru — finalizați revizia curentă">${_alopIcoBtn('ico-file-text')}Revizie DF în lucru...</button>`;
    }else if(!a.df_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-file-text')}Completează Document de Fundamentare</button>`;
    }else if(dfStatus==='neaprobat'){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF (neaprobat)</button>`;
    }else if(a.status==='angajare'&&a.df_flow_id){
      actionsHtml+=`<span style="color:var(--df-text-3);font-size:.85rem"><svg class="df-ic" style="vertical-align:-3px;margin-right:4px;"><use href="/icons.svg?v=3.9.475#ico-clock"/></svg>DF pe fluxul de semnare — în așteptare</span>`;
    }else if(['aprobat','transmis_flux','de_revizuit'].includes(dfStatus)){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-file-text')}Deschide DF</button>`;
    }else if(a.df_id&&!a.df_flow_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-file-text')}Deschide DF</button>`;
    }else{
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-file-text')}Completează Document de Fundamentare</button>`;
    }
    if(a.status==='lichidare'&&!a.lichidare_confirmed_at){
      actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmLichidare('${id}')">${_alopIcoBtn('ico-check-square')}Confirmă Lichidarea</button>`;
      if(a.df_id)actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF</button>`;
    }else if(a.status==='ordonantare'&&!a.ord_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}')">${_alopIcoBtn('ico-file-signature')}Completează Ordonanțare de Plată</button>`;
      if(a.df_id)actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF</button>`;
    }else if(a.status==='ordonantare'&&a.ord_id&&!a.ord_flow_id){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}')">${_alopIcoBtn('ico-rocket')}Generează PDF + Lansează flux ORD</button>`;
      if(a.df_id)actionsHtml+=`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF</button>`;
    }else if(a.status==='ordonantare'&&a.ord_flow_id&&!a.ord_completed_at){
      actionsHtml+=`<button class="df-action-btn primary" onclick="alopOrdCompleted('${id}')">${_alopIcoBtn('ico-check-circle')}Marchează ORD semnat complet</button>`;
    }else if(a.status==='plata'){
      actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmPlata('${id}',${parseFloat(a.ord_valoare||0)})">${_alopIcoBtn('ico-landmark')}Confirmă Plata</button>`;
    }
    // Ștergere ascunsă când ALOP are DF/ORD legat
    if(!a.df_id&&!a.ord_id){
      actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-trash')}Șterge</button>`;
    }
  }
```
**new_str**
```
  let actionsHtml='';
  {
    const id=esc(a.id);
    // DF action — enum din caps decide butonul; label/icon/onclick = prezentare (1:1 cu vechiul if/else)
    switch(caps.df_action){
      case 'in_lucru_disabled':
        actionsHtml+=`<button class="df-action-btn" disabled title="Există deja o revizie DF în lucru — finalizați revizia curentă">${_alopIcoBtn('ico-file-text')}Revizie DF în lucru...</button>`;
        break;
      case 'completeaza':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-file-text')}Completează Document de Fundamentare</button>`;
        break;
      case 'revizuieste_neaprobat':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF (neaprobat)</button>`;
        break;
      case 'flow_waiting':
        actionsHtml+=`<span style="color:var(--df-text-3);font-size:.85rem"><svg class="df-ic" style="vertical-align:-3px;margin-right:4px;"><use href="/icons.svg?v=3.9.475#ico-clock"/></svg>DF pe fluxul de semnare — în așteptare</span>`;
        break;
      case 'deschide':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideDF('${id}')">${_alopIcoBtn('ico-file-text')}Deschide DF</button>`;
        break;
    }
    // Phase action — enum din caps; "Revizuiește DF" secundar gated de can_revise_df
    const reviseBtn=caps.can_revise_df?`<button class="df-action-btn" onclick="alopRevizuiesteDF('${id}','${esc(a.df_id)}')">${_alopIcoBtn('ico-rotate-ccw')}Revizuiește DF</button>`:'';
    switch(caps.phase_action){
      case 'confirma_lichidare':
        actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmLichidare('${id}')">${_alopIcoBtn('ico-check-square')}Confirmă Lichidarea</button>`+reviseBtn;
        break;
      case 'completeaza_ord':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}')">${_alopIcoBtn('ico-file-signature')}Completează Ordonanțare de Plată</button>`+reviseBtn;
        break;
      case 'genereaza_lanseaza_ord':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopDeschideORD('${id}')">${_alopIcoBtn('ico-rocket')}Generează PDF + Lansează flux ORD</button>`+reviseBtn;
        break;
      case 'marcheaza_ord_semnat':
        actionsHtml+=`<button class="df-action-btn primary" onclick="alopOrdCompleted('${id}')">${_alopIcoBtn('ico-check-circle')}Marchează ORD semnat complet</button>`;
        break;
      case 'confirma_plata':
        actionsHtml+=`<button class="df-action-btn primary" onclick="openAlopConfirmPlata('${id}',${parseFloat(a.ord_valoare||0)})">${_alopIcoBtn('ico-landmark')}Confirmă Plata</button>`;
        break;
    }
    // Ștergere (owner-gated în caps.can_delete)
    if(caps.can_delete){
      actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-trash')}Șterge</button>`;
    }
  }
```

---

## Patch 4 — `alop.js`: butonul refresh din caps

**old_str**
```
          ${!isCompleted&&!isCancelled?`<button class="df-action-btn sm" onclick="alopRefreshCurrent()" title="Actualizează status">↻ Actualizează</button>`:''}
```
**new_str**
```
          ${caps.can_refresh?`<button class="df-action-btn sm" onclick="alopRefreshCurrent()" title="Actualizează status">↻ Actualizează</button>`:''}
```

---

## Patch 5 — `alop.js`: "Nouă ordonanțare parțială" din caps

**old_str**
```
    ${isCompleted&&(a.ramas>0)?`
      <div style="background:rgba(108,79,240,.08);border:1px solid rgba(108,79,240,.2);border-radius:8px;padding:10px 14px;font-size:.82rem;margin-top:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
```
**new_str**
```
    ${caps.can_start_noua_ordonantare?`
      <div style="background:rgba(108,79,240,.08);border:1px solid rgba(108,79,240,.2);border-radius:8px;padding:10px 14px;font-size:.82rem;margin-top:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
```

---

## Patch 6 — version bump + cache-busting (`alop.js` e referit cu `?v=` în formular.html)

`alop.js` NU e în `PRECACHE_ASSETS` → fără bump `CACHE_VERSION`. Doar `?v=` + package.json:

```bash
OLD=$(node -p "require('./package.json').version")   # 3.9.527
NEW=3.9.528
sed -i "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json
sed -i "s/?v=$OLD/?v=$NEW/g" public/formular.html
grep -c "?v=$NEW" public/formular.html
```

---

## Verificări

```bash
node --check public/js/formular/alop.js

# renderAlopDetail consumă caps; magnetul if/else status×rol eliminat
grep -n "caps.df_action\|caps.phase_action\|caps.can_delete\|caps.can_refresh\|caps.can_start_noua" public/js/formular/alop.js
grep -c "console.log('\[ALOP owner check\]'" public/js/formular/alop.js   # → 0 (debug eliminat)
grep -c "isAlopOwner" public/js/formular/alop.js                          # → 0

npm test                # verde (raportează nr.)
npm run db:test:up && export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db         # verde
npm run db:test:down ; unset TEST_DATABASE_URL

grep -c "?v=3.9.528" public/formular.html
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

## ⚠️ Verificare manuală pe staging (nu există teste DOM)

Parcurge un ALOP prin toate fazele și confirmă vizual butoanele identice cu înainte:
- **draft / fără DF** → "Completează Document de Fundamentare" + "Șterge"
- **angajare + DF pe flux** → text "DF pe fluxul de semnare — în așteptare"
- **DF neaprobat** → "Revizuiește DF (neaprobat)"
- **lichidare** → "Deschide DF" + "Confirmă Lichidarea" + "Revizuiește DF"
- **ordonantare fără ORD** → "Completează Ordonanțare de Plată" + "Revizuiește DF"
- **ordonantare ORD fără flux** → "Generează PDF + Lansează flux ORD" + "Revizuiește DF"
- **ordonantare ORD pe flux** → "Marchează ORD semnat complet"
- **plata** → "Confirmă Plata"
- **completed + ramas>0** → "🔄 Nouă ordonanțare parțială"
- **activ** → butonul "↻ Actualizează" prezent; **completed/cancelled** → absent
- **revizie DF în lucru** → buton disabled "Revizie DF în lucru..."

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.527 → 3.9.528 (package.json + `?v=` formular.html)
- [ ] Lista: `canCancel` din `a.can_delete`
- [ ] `renderAlopDetail`: `caps` consumat; blocul magnet înlocuit cu enum-uri; `console.log` debug eliminat; `isAlopOwner` client eliminat
- [ ] refresh + nouă-ordonanțare din caps
- [ ] `npm test` verde (raportează nr.)
- [ ] `npm run test:db` verde (raportează nr.)
- [ ] cache-bust `?v=3.9.528`
- [ ] verificare manuală staging pe toate fazele (raportează pe scurt)
- [ ] diff fără fișiere de semnare
- [ ] commit + push **doar pe develop** → CI verde

Commit sugerat:
```
feat(alop): renderAlopDetail randează din capabilities (Etapa 3b)

- alop.js: df_action/phase_action (enum) aleg butonul; can_revise_df/can_delete/can_refresh/can_start_noua_ordonantare gate-uiesc
- lista folosește a.can_delete; magnetul if/else status×rol eliminat (1:1)
- eliminat console.log de debug '[ALOP owner check]' + logica isAlopOwner client (owner trăiește în caps server)
- v3.9.528
```
```

---

## Ce rămâne (2c/3c — curățenie + list.js, opțional)

`ST.docStatus` etc. și câmpuri redundante; mutarea `list.js` (DF/ORD) complet pe capabilities;
consolidarea `stLabel`/badge-maps. Mic, ușor, după validarea staging a 3b.
