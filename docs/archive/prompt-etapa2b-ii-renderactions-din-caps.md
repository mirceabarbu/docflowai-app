# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): `signing.mjs`, `bulk-signing.mjs`, `cloud-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`.

---

## Obiectiv — Etapa 2b-ii (frontend: `renderActions` randează din `capabilities`)

`renderActions` din `public/js/formular/doc.js` devine **consumator** de `capabilities` (sursa unică,
deja dovedită prin testele din 2a). Regula „ce butoane apar" vine 100% din caps; `status×role` aleg
DOAR eticheta (prezentare): «Trimite»/«Retrimite», «Câmpuri»/«Resetează». Split-ul Generează/Lansează
rămâne client (`hasPdf`). Trebuie să fie **1:1** cu comportamentul actual — niciun buton/text/handler schimbat.

### Garanție de prospețime caps (inventar făcut)

Toți apelanții `renderActions` au caps proaspăt:
- `openDoc`, `saveDoc` (create+PUT), `completeAsP2`, `resetDocToP1` → `j.document.capabilities` (2a/2b-i) ✓
- `confirmP2`, `mkFlow` → navighează (showListSection/redirect) ✓
- `genPdf`, `resetF` → nu schimbă statusul ✓
- `newDoc`, init → fără `docId` → fallback ✓
- `confirmReturn` → ruta `returneaza` NU întoarce document → **Patch 1** îl adaugă (aditiv)

---

## Patch 1 — backend: `returneaza` (DF + ORD) întoarce `document` + caps

`computeDocCapabilities` e deja importat în `formulare-db.mjs`.

### 1a — DF `returneaza`

**old_str**
```
    await pool.query(
      `UPDATE formulare_df SET status='returnat', motiv_returnare=$1, updated_at=NOW(), updated_by=$3 WHERE id=$2`,
      [motiv.trim(), req.params.id, actor.userId]
    );
    await sendNotif(doc.created_by, 'formulare_df_returnat',
      'Document de Fundamentare — returnat ca neconform',
      `${actor.nume || actor.email} a returnat DF "${doc.nr_unic_inreg || 'fără număr'}" cu observații`,
      { form_type: 'df', form_id: req.params.id });
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-df returnat de P2');
    res.json({ ok: true });
```
**new_str**
```
    const { rows: upd } = await pool.query(
      `UPDATE formulare_df SET status='returnat', motiv_returnare=$1, updated_at=NOW(), updated_by=$3 WHERE id=$2 RETURNING *`,
      [motiv.trim(), req.params.id, actor.userId]
    );
    await sendNotif(doc.created_by, 'formulare_df_returnat',
      'Document de Fundamentare — returnat ca neconform',
      `${actor.nume || actor.email} a returnat DF "${doc.nr_unic_inreg || 'fără număr'}" cu observații`,
      { form_type: 'df', form_id: req.params.id });
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-df returnat de P2');
    const outDf = upd[0];
    outDf.capabilities = computeDocCapabilities(outDf, actor, 'notafd');
    res.json({ ok: true, document: outDf });
```

### 1b — ORD `returneaza`

Găsește ruta `POST /api/formulare-ord/:id/returneaza` (~1064). Aplică ACELAȘI tipar:
- adaugă `RETURNING *` la UPDATE-ul de `status='returnat'`,
- după `logger.info(... 'formulare-ord returnat ...')`, atașează caps cu `'ordnt'` și întoarce `document`.

**old_str** (adaptează la textul EXACT al rutei ORD — UPDATE + sendNotif + logger + `res.json({ ok: true })`):
```
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-ord returnat de P2');
    res.json({ ok: true });
```
**new_str**
```
    logger.info({ id: req.params.id, actor: actor.email }, 'formulare-ord returnat de P2');
    const outOrd = upd[0];
    outOrd.capabilities = computeDocCapabilities(outOrd, actor, 'ordnt');
    res.json({ ok: true, document: outOrd });
```
> ATENȚIE: pentru ca `upd[0]` să existe, adaugă `RETURNING *` la UPDATE-ul ORD de returnare și
> redenumește variabila destinație în `upd` (ca la DF). Verifică numele variabilei existente în ruta ORD.

---

## Patch 2 — `doc.js`: stochează `ST.docCapabilities[ft]` din fiecare `j.document`

### 2a — openDoc (după blocul de populare ST din doc)

**old_str**
```
    ST.docLatestRevizieNr=ST.docLatestRevizieNr||{};
    ST.docLatestRevizieNr[ft]=doc.latest_revizie_nr||0;

    // Populare câmpuri
```
**new_str**
```
    ST.docLatestRevizieNr=ST.docLatestRevizieNr||{};
    ST.docLatestRevizieNr[ft]=doc.latest_revizie_nr||0;
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=doc.capabilities||null;

    // Populare câmpuri
```

### 2b — saveDoc (înainte de `renderActions(ft);refreshDocs(ft);`)

**old_str**
```
    renderActions(ft);refreshDocs(ft);
    setS('Salvat cu succes.','ok');
```
**new_str**
```
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    renderActions(ft);refreshDocs(ft);
    setS('Salvat cu succes.','ok');
```

### 2c — completeAsP2 (după `ST.docStatus[ft]='completed';`)

**old_str**
```
    ST.docStatus[ft]='completed';
    _alopLinkDoc(ft,ST.docId[ft]); // FIX: re-leagă la ALOP după completare (idempotent)
```
**new_str**
```
    ST.docStatus[ft]='completed';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    _alopLinkDoc(ft,ST.docId[ft]); // FIX: re-leagă la ALOP după completare (idempotent)
```

### 2d — resetDocToP1 (după `ST.docStatus[ft]='draft';`)

**old_str**
```
    ST.docStatus[ft]='draft';
    lockAll(ft,false);setLockedBar(ft,'');renderActions(ft);refreshDocs(ft);
    setS('Document redeschis pentru modificare.','ok');
```
**new_str**
```
    ST.docStatus[ft]='draft';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    lockAll(ft,false);setLockedBar(ft,'');renderActions(ft);refreshDocs(ft);
    setS('Document redeschis pentru modificare.','ok');
```

### 2e — confirmReturn (după `ST.docStatus[ft]='returnat';`)

**old_str**
```
    ST.docStatus[ft]='returnat';
    lockAll(ft,true);
    setLockedBar(ft,'Document returnat ca neconform. Inițiatorul va fi notificat.','warn');
```
**new_str**
```
    ST.docStatus[ft]='returnat';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    lockAll(ft,true);
    setLockedBar(ft,'Document returnat ca neconform. Inițiatorul va fi notificat.','warn');
```

### 2f — confirmP2 (după `ST.docStatus[ft]='pending_p2';` — consistență, deși navighează)

**old_str**
```
    ST.docStatus[ft]='pending_p2';
    // Redirect automat la centralizare după trimite P2
```
**new_str**
```
    ST.docStatus[ft]='pending_p2';
    ST.docCapabilities=ST.docCapabilities||{};
    ST.docCapabilities[ft]=j.document?.capabilities||null;
    // Redirect automat la centralizare după trimite P2
```

### 2g — newDoc (curăță caps la formular nou)

**old_str**
```
  ST.docId[ft]=null;ST.docStatus[ft]=null;ST.docRole[ft]='p1';
```
**new_str**
```
  ST.docId[ft]=null;ST.docStatus[ft]=null;ST.docRole[ft]='p1';
  ST.docCapabilities=ST.docCapabilities||{};ST.docCapabilities[ft]=null;
```

---

## Patch 3 — `doc.js`: rescrie `renderActions` să randeze din `capabilities`

Înlocuiește INTEGRAL funcția `renderActions` (de la `function renderActions(ft){` până la `}` final).

**old_str**
```
function renderActions(ft){
  const div=document.getElementById('actions-'+ft);if(!div)return;
  const status=ST.docStatus[ft],role=ST.docRole[ft],docId=ST.docId[ft];
  const B=(cls,txt,fn)=>`<button class="df-action-btn ${cls}" onclick="${fn}">${txt}</button>`;
  const BNou='';
  let html='';
  // Banner "an următor" — vizibil doar pentru notafd revizie an următor
  const bannerAnUrm=document.getElementById('banner-an-urmator-notafd');
  if(bannerAnUrm) bannerAnUrm.style.display=(ft==='notafd'&&ST.docRevizieAnUrmator?.[ft])?'':'none';

  if(ft==='notafd'&&ST.docStatus[ft]==='neaprobat'){
    const revNr=ST.docRevizieNr?.[ft]??0;
    const areNoua=ST.docAreRevizieNoua?.[ft];
    const latest=ST.docLatestRevizieNr?.[ft]||0;
    if(areNoua){
      div.innerHTML=`<span style="color:#f87171;font-size:.82rem;margin-right:8px">❌ DF neaprobat de semnatar (R${revNr}).</span>`
        +`<span style="color:var(--df-text-3);font-size:.82rem">🕒 Revizie istorică — revizia curentă este R${latest}.</span>`;
    }else{
      div.innerHTML=`<span style="color:#f87171;font-size:.82rem;margin-right:8px">❌ DF neaprobat de semnatar — fluxul a fost refuzat (R${revNr}).</span>`
        +B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`);
    }
    return;
  }
  if(ft==='notafd'&&ST.docStatus[ft]==='de_revizuit'){
    div.innerHTML=`<span style="color:#fbbf24;font-size:.82rem;margin-right:8px">🔄 Documentul a fost trimis înapoi din flux pentru revizuire.</span>`
      +B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează câmpuri',`resetF('${ft}')`);
    return;
  }
  if(ST.docAprobat?.[ft]){
    const fid=ST.docFlowId?.[ft];
    const revNr=ST.docRevizieNr?.[ft]||0;
    const isAnUrm=ft==='notafd'&&ST.docRevizieAnUrmator?.[ft];
    const areNoua=ft==='notafd'&&ST.docAreRevizieNoua?.[ft];
    const latest=ST.docLatestRevizieNr?.[ft]||0;
    const revBadge=ft==='notafd'&&revNr>0?`<span class="df-revizie-badge" style="margin-right:4px">Revizia ${revNr}</span>`:'';
    const istoricMsg=areNoua?`<span style="color:var(--df-text-3);font-size:.82rem;margin-left:8px">🕒 Revizie istorică — revizia curentă este R${latest}.</span>`:'';
    div.innerHTML=revBadge
      +(fid?B('teal','📄 Descarcă PDF semnat',`viewFlowPdf('${fid}')`):'')
      +((ft==='notafd'&&!areNoua)?B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`):'')
      +istoricMsg;
    return;
  }
  if(!docId){
    html=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează',`resetF('${ft}')`);
  }else if(status==='draft'&&role==='p1'){
    html=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +BNou
      +B('','↺ Câmpuri',`resetF('${ft}')`);
  }else if(status==='returnat'&&role==='p1'){
    html=B('teal','📨 Retrimite la Responsabil CAB',`showP2Modal('${ft}')`);
  }else if(status==='pending_p2'&&role==='p2'){
    html=B('','💾 Salvează',`saveDoc('${ft}')`)
      +B('primary','✅ Finalizez secțiunea',`completeAsP2('${ft}')`)
      +B('danger','↩ Returnează ca neconform',`showReturnModal('${ft}')`);
  }else if(status==='pending_p2'&&role==='p1'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">⏳ Așteptare Responsabil CAB...</span>`
      +BNou;
  }else if(status==='completed'&&role==='p1'){
    const hasPdf=!!(ST[ft]?.pdf);
    html=(hasPdf?B('primary','🔏 Lansează flux semnare',`mkFlow('${ft}')`)
                :`<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`);
  }else if(status==='transmis_flux'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">🔄 Document pe fluxul de semnare...</span>`
      +(ST.docFlowId?.[ft]?B('','📄 Descarcă PDF',`viewFlowPdf('${ST.docFlowId[ft]}')`):'');
  }else if(status==='completed'&&role==='p2'){
    html=`<span style="color:var(--df-text-3);font-size:.82rem">✅ Secțiunea ta este completată.</span>`
      +BNou;
  }else{
    html=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează',`resetF('${ft}')`);
  }
  div.innerHTML=html;
}
```
**new_str**
```
function renderActions(ft){
  const div=document.getElementById('actions-'+ft);if(!div)return;
  const status=ST.docStatus[ft],role=ST.docRole[ft],docId=ST.docId[ft];
  const caps=ST.docCapabilities?.[ft]||{};
  const B=(cls,txt,fn)=>`<button class="df-action-btn ${cls}" onclick="${fn}">${txt}</button>`;
  // Banner "an următor" — vizibil doar pentru notafd revizie an următor (prezentare, neschimbat)
  const bannerAnUrm=document.getElementById('banner-an-urmator-notafd');
  if(bannerAnUrm) bannerAnUrm.style.display=(ft==='notafd'&&ST.docRevizieAnUrmator?.[ft])?'':'none';

  // Etichete = prezentare (gated de caps): "Retrimite" doar la returnat&p1; "Câmpuri" doar la draft&p1.
  const lblSend =(status==='returnat'&&role==='p1')?'📨 Retrimite la Responsabil CAB':'📨 Trimite la Responsabil CAB';
  const lblReset=(status==='draft'&&role==='p1')?'↺ Câmpuri':'↺ Resetează';

  // Formular nesalvat (fără docId) → set fix de acțiuni (identic cu vechiul branch !docId)
  if(!docId){
    div.innerHTML=B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează',`resetF('${ft}')`);
    return;
  }

  const revNr=ST.docRevizieNr?.[ft]||0;
  const latest=ST.docLatestRevizieNr?.[ft]||0;

  // Stări terminale/informaționale — text identic cu originalul, butoane gated de caps:
  if(caps.is_neaprobat){
    if(caps.is_historic_revision){
      div.innerHTML=`<span style="color:#f87171;font-size:.82rem;margin-right:8px">❌ DF neaprobat de semnatar (R${revNr}).</span>`
        +`<span style="color:var(--df-text-3);font-size:.82rem">🕒 Revizie istorică — revizia curentă este R${latest}.</span>`;
    }else{
      div.innerHTML=`<span style="color:#f87171;font-size:.82rem;margin-right:8px">❌ DF neaprobat de semnatar — fluxul a fost refuzat (R${revNr}).</span>`
        +(caps.can_revise?B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`):'');
    }
    return;
  }
  if(caps.is_de_revizuit){
    div.innerHTML=`<span style="color:#fbbf24;font-size:.82rem;margin-right:8px">🔄 Documentul a fost trimis înapoi din flux pentru revizuire.</span>`
      +B('teal','📨 Trimite la Responsabil CAB',`showP2Modal('${ft}')`)
      +B('','↺ Resetează câmpuri',`resetF('${ft}')`);
    return;
  }
  if(caps.aprobat){
    const fid=ST.docFlowId?.[ft];
    const revBadge=ft==='notafd'&&revNr>0?`<span class="df-revizie-badge" style="margin-right:4px">Revizia ${revNr}</span>`:'';
    const istoricMsg=caps.is_historic_revision?`<span style="color:var(--df-text-3);font-size:.82rem;margin-left:8px">🕒 Revizie istorică — revizia curentă este R${latest}.</span>`:'';
    div.innerHTML=revBadge
      +(caps.can_download_signed?B('teal','📄 Descarcă PDF semnat',`viewFlowPdf('${fid}')`):'')
      +(caps.can_revise?B('','↻ Revizuiește',`dfInitiazaRevizie('${docId}')`):'')
      +istoricMsg;
    return;
  }
  if(caps.is_waiting_p2){
    div.innerHTML=`<span style="color:var(--df-text-3);font-size:.82rem">⏳ Așteptare Responsabil CAB...</span>`;
    return;
  }
  if(caps.is_completed_p2){
    div.innerHTML=`<span style="color:var(--df-text-3);font-size:.82rem">✅ Secțiunea ta este completată.</span>`;
    return;
  }
  if(caps.is_on_flow){
    div.innerHTML=`<span style="color:var(--df-text-3);font-size:.82rem">🔄 Document pe fluxul de semnare...</span>`
      +(caps.can_download_flux?B('','📄 Descarcă PDF',`viewFlowPdf('${ST.docFlowId?.[ft]}')`):'');
    return;
  }
  if(caps.can_generate_or_launch){
    const hasPdf=!!(ST[ft]?.pdf);
    div.innerHTML=(hasPdf?B('primary','🔏 Lansează flux semnare',`mkFlow('${ft}')`)
      :`<button id="bgen-${ft}" class="df-action-btn primary" onclick="genPdf('${ft}')">⚙ Generează PDF</button>`);
    return;
  }

  // Acțiuni „active" (draft/p1, returnat/p1, pending_p2/p2, fallback) — asamblate din caps:
  let html='';
  if(caps.can_send_p2)     html+=B('teal',lblSend,`showP2Modal('${ft}')`);
  if(caps.can_save)        html+=B('','💾 Salvează',`saveDoc('${ft}')`);
  if(caps.can_complete_p2) html+=B('primary','✅ Finalizez secțiunea',`completeAsP2('${ft}')`);
  if(caps.can_return)      html+=B('danger','↩ Returnează ca neconform',`showReturnModal('${ft}')`);
  if(caps.can_reset)       html+=B('',lblReset,`resetF('${ft}')`);
  div.innerHTML=html;
}
```

> Echivalența 1:1 (verificat pe fiecare stare): neaprobat(istoric/refuz), de_revizuit, aprobat
> (download semnat + revizuiește R0 + mesaj istoric), pending_p2&p1 (waiting), completed&p2,
> transmis_flux (on_flow + download), completed&p1 (generate/launch după hasPdf), draft&p1
> (Trimite+Câmpuri), returnat&p1 (Retrimite), pending_p2&p2 (Salvează+Finalizez+Returnează),
> fallback (Trimite+Resetează). Etichetele Retrimite/Câmpuri rămân gated pe status×role.

---

## Patch 4 — version bump + cache-busting (doc.js e referit cu `?v=` în formular.html)

`doc.js` NU e în `PRECACHE_ASSETS` din `sw.js` → **NU** bump-ezi `CACHE_VERSION`. Doar `?v=` + package.json:

```bash
OLD=$(node -p "require('./package.json').version")   # ex. 3.9.523
NEW=3.9.524
sed -i "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json
sed -i "s/?v=$OLD/?v=$NEW/g" public/formular.html
grep -c "?v=$NEW" public/formular.html   # confirmă că toate link-urile au noua versiune
```

---

## Patch 5 — test DB: `returneaza` întoarce capabilities

Extinde `server/tests/db/doc-capabilities-mutations.test.mjs` cu un caz (sau adaugă fișier nou):

```js
  it('POST returneaza DF → document.capabilities (returnat)', async () => {
    // creator + assigned distinct ca să avem o tranziție pending_p2 → returnat realistă
    await pool.query(`INSERT INTO users (email, password_hash, nume, role, org_id) VALUES ('p2@x.ro','x','P2','user',1)`);
    const created = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({ nr_unic_inreg: 'RET-1' });
    const id = created.body.document.id;
    await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', cookie()).send({ assigned_to: 2 });
    // P2 (user 2) returnează
    const p2cookie = makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p2cookie).send({ motiv: 'lipsă' });
    expect(res.status).toBe(200);
    expect(res.body.document).toBeTruthy();
    expect(res.body.document.capabilities).toBeTruthy();
  });
```
> Dacă autorizarea P2 pe submit/returneaza necesită setup suplimentar (compartiment etc.), adaptează
> seed-ul minimal cât să treacă `canEditFormular` pentru assigned_to. Dacă devine prea fragil, păstrează
> doar aserțiunea că `returneaza` întoarce `document.capabilities` într-un scenariu admin.

---

## Verificări

```bash
node --check server/routes/formulare-db.mjs

# renderActions nu mai conține lanțul de status hardcodat de decizie
grep -n "ST.docCapabilities" public/js/formular/doc.js   # storage (≥7) + renderActions
grep -c "caps.can_\|caps.is_\|caps.aprobat" public/js/formular/doc.js   # renderActions citește din caps

# returneaza întoarce document (df + ord)
grep -n "document: outDf\|document: outOrd" server/routes/formulare-db.mjs   # 2

# Suite
npm test                       # verde (raportează nr.)
npm run db:test:up && export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db                # verde, inclusiv cazul returneaza
npm run db:test:down ; unset TEST_DATABASE_URL

# Cache-bust aplicat
grep -c "?v=3.9.524" public/formular.html   # > 0, toate uniforme

# NO-TOUCH semnare
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

## ⚠️ Verificare manuală pe staging (recomandat — nu există teste DOM)

Deschide pe staging un DF/ORD în fiecare stare și confirmă vizual butoanele identice cu înainte:
draft (P1: Trimite+Câmpuri), pending_p2 (P2: Salvează/Finalizez/Returnează; P1: Așteptare),
returnat (P1: Retrimite), completed (P1: Generează→Lansează după PDF; P2: secțiune completată),
transmis_flux (Pe flux + Descarcă), aprobat (Descarcă PDF semnat + Revizuiește la DF R0),
neaprobat (Revizuiește / istoric), de_revizuit (Trimite + Resetează câmpuri).

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.523 → 3.9.524 (package.json + `?v=` în formular.html)
- [ ] Patch 1: `returneaza` DF+ORD întorc `document`+caps (RETURNING *)
- [ ] Patch 2: `ST.docCapabilities[ft]` stocat la openDoc/save/complete/resetDocToP1/confirmReturn/confirmP2; curățat la newDoc
- [ ] Patch 3: `renderActions` randează din caps (1:1; etichete gated pe status×role; hasPdf client)
- [ ] Patch 5: test DB pentru `returneaza` caps
- [ ] `npm test` verde (raportează nr.)
- [ ] `npm run test:db` verde (raportează nr.)
- [ ] cache-bust `?v=3.9.524` în formular.html
- [ ] verificare manuală staging pe toate stările (raportează pe scurt)
- [ ] diff fără fișiere de semnare
- [ ] commit + push **doar pe develop**

Commit sugerat:
```
feat(formulare): renderActions randează din capabilities (Etapa 2b-ii)

- doc.js: renderActions consumă ST.docCapabilities (sursă unică server); status×role doar pentru etichete
- caps stocate din fiecare j.document (openDoc + toate mutațiile); curățate la newDoc
- returneaza (df+ord) întoarce document+caps (RETURNING *) → fără stale după returnare
- magnetul de if/else status×rol eliminat; comportament 1:1 (verificat unit+DB+manual)
- v3.9.524
```
```

---

## Ce rămâne (2c — curățenie, opțional după validare)

`ST.docStatus`/`docRole`/`docAprobat`/`docFlowId`/`docRevizieNr` rămân necesare pentru etichete și
pentru alte locuri din doc.js — NU se elimină acum. 2c ar putea: elimina câmpuri redundante neutilizate,
muta și `list.js`/`alop.js` pe același tipar de capabilities, și consolida `stLabel`/badge-maps.
