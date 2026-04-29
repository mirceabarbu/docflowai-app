/* flow.js — DocFlowAI flow status page logic
 * Extracted from flow.html (Pas 2.10)
 * Depends on: _apiFetch (df-apifetch-shim.js)
 */
  const $ = (id) => document.getElementById(id);
  // esc global — folosit in loadFlow si orice alt context
  const esc = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const qs = new URLSearchParams(location.search);
  const flowId = qs.get("flow") || qs.get("id") || "";
  const linkToken = qs.get("token") || "";
  // SEC-01: token din cookie HttpOnly — eliminat jwt

  function setMsg(kind, text){
    const el = $("msg");
    if(!text){ el.innerHTML=""; return; }
    const cls = kind==="error" ? "alert err" : "alert";
    el.innerHTML = `<div class="${cls}">${text}</div>`;
  }

  function statusBadge(status){
    const s = (status||"").toLowerCase();
    if(["done","finalizat","completed","complete","finished"].includes(s)) return {cls:"ok", txt:"✅ Finalizat"};
    if(["refused","rejected","respins"].includes(s)) return {cls:"bad", txt:"⛔ Refuzat"};
    if(["draft","init","new"].includes(s)) return {cls:"warn", txt:"📝 Draft"};
    if(["active","in_progress","inprogress","in curs","running"].includes(s)) return {cls:"warn", txt:"⏳ În curs"};
    if(s === "review_requested") return {cls:"warn", txt:"🔄 Spre revizuire"};
    if(s === "reinitiated_after_review") return {cls:"", txt:"🔁 Reinițiat după revizuire"};
    if(s === "cancelled") return {cls:"bad", txt:"🚫 Anulat"};
    return {cls:"", txt:"ℹ️ " + (status||"necunoscut")};
  }

  function prettyTs(v){
    try{
      if(!v) return "—";
      const d = new Date(v);
      if(isNaN(d)) return String(v);
      return d.toLocaleString("ro-RO");
    }catch(e){ return String(v||"—"); }
  }

  async function apiFetchJson(url){
    // Folosește cookie HttpOnly; dacă nu are acces, încearcă fallback cu token din link.
    let r = await _apiFetch(url);
    if((r.status===401 || r.status===403) && linkToken){
      const u = new URL(url, location.origin);
      if(!u.searchParams.get("token")) u.searchParams.set("token", linkToken);
      r = await _apiFetch(u.toString());
    }

    const j = await r.json().catch(()=>({}));
    if(!r.ok){
      const msg = (j && (j.message || j.error)) || (r.status + " " + r.statusText);
      throw new Error(msg);
    }
    return j;
  }

  async function apiFetchBlob(url){
    let r = await _apiFetch(url);
    if((r.status===401 || r.status===403) && linkToken){
      const u = new URL(url, location.origin);
      if(!u.searchParams.get("token")) u.searchParams.set("token", linkToken);
      r = await _apiFetch(u.toString());
    }

    if(!r.ok){
      let t = "";
      try{ t = await r.text(); }catch(e){}
      throw new Error(t || (r.status + " " + r.statusText));
    }
    return await r.blob();
  }

  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "document.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1500);
  }

  function roleLabel(s){
    return (s||"").toString().toUpperCase();
  }


  // ── P-05: renderTimeline — jaloane principale ale fluxului ────────────────
  // b233: provider badge helper
  const _PROV_BADGE = {
    'local-upload': { icon: '💻', label: 'Upload local', color: 'rgba(157,176,255,.8)',  bg: 'rgba(157,176,255,.1)', border: 'rgba(157,176,255,.25)' },
    'sts-cloud':    { icon: '🏛️', label: 'STS Cloud',   color: 'rgba(45,212,191,.9)',   bg: 'rgba(45,212,191,.1)',  border: 'rgba(45,212,191,.25)' },
    'certsign':     { icon: '🔐', label: 'certSIGN',    color: 'rgba(255,176,32,.9)',   bg: 'rgba(255,176,32,.1)',  border: 'rgba(255,176,32,.25)' },
    'transsped':    { icon: '🔐', label: 'Trans Sped',  color: 'rgba(255,176,32,.9)',   bg: 'rgba(255,176,32,.1)',  border: 'rgba(255,176,32,.25)' },
    'alfatrust':    { icon: '🔐', label: 'AlfaTrust',   color: 'rgba(255,176,32,.9)',   bg: 'rgba(255,176,32,.1)',  border: 'rgba(255,176,32,.25)' },
    'namirial':     { icon: '🔐', label: 'Namirial',    color: 'rgba(255,176,32,.9)',   bg: 'rgba(255,176,32,.1)',  border: 'rgba(255,176,32,.25)' },
  };
  function _provBadge(pid) {
    const p = _PROV_BADGE[pid] || { icon: '🔏', label: pid || '?', color: 'rgba(234,240,255,.5)', bg: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.15)' };
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:20px;font-size:.7rem;font-weight:600;background:${p.bg};border:1px solid ${p.border};color:${p.color};">${p.icon} ${p.label}</span>`;
  }

  function renderTimeline(flow) {
    const card   = $('timelineCard');
    const wrap   = $('tlWrap');
    const tlSum  = $('tlSummary');
    if (!card || !wrap) return;

    const data    = flow.data || flow;
    const signers = data.signers || [];
    const evs     = (flow.events || data.events || []).slice().sort(
      (a, b) => new Date(a.at || a.ts || 0) - new Date(b.at || b.ts || 0)
    );

    // nameMap: email → nume afișat
    const nameMap = {};
    if (data.initEmail) nameMap[data.initEmail.toLowerCase()] = data.initName || data.initEmail;
    signers.forEach(s => {
      if (s.email) nameMap[s.email.toLowerCase()] = s.name || s.email;
    });
    const resolveName = (email) => nameMap[(email||'').toLowerCase()] || email || '—';

    const esc = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Evenimentele-cheie pentru timeline
    const EV_SHOW = new Set([
      'FLOW_CREATED','SIGNED','SIGNED_PDF_UPLOADED','FLOW_COMPLETED',
      'REFUSED','FLOW_CANCELLED','REVIEW_REQUESTED','DELEGATED',
      'FLOW_REINITIATED','FLOW_REINITIATED_AFTER_REVIEW',
      'EMAIL_SENT','EMAIL_OPENED'
    ]);

    // Filtrăm și grupăm evenimentele relevante (ignorăm moștenite din flux-parent)
    const relevant = evs.filter(e => EV_SHOW.has(e.type) && !e._inheritedFrom);

    // Construim pașii timeline
    const steps = [];

    // ── PASUL 1: FLOW_CREATED ────────────────────────────────────────────────
    const evCreated = relevant.find(e => e.type === 'FLOW_CREATED');
    steps.push({
      icon: '🚀', label: 'Flux creat',
      actor: data.initName || data.initEmail || '—',
      ts: evCreated?.at || data.createdAt || null,
      state: evCreated ? 'done' : 'active',
      extra: null
    });

    // ── PAȘI PER SEMNATAR ────────────────────────────────────────────────────
    const signedOrder = [...signers].sort((a, b) => (Number(a.order)||0) - (Number(b.order)||0));
    for (const s of signedOrder) {
      const st = (s.status || '').toLowerCase();
      const evSigned     = relevant.filter(e => e.type === 'SIGNED'              && (e.by||'').toLowerCase() === (s.email||'').toLowerCase());
      const evUploaded   = relevant.filter(e => e.type === 'SIGNED_PDF_UPLOADED' && (e.by||'').toLowerCase() === (s.email||'').toLowerCase());
      const evDelegated  = relevant.filter(e => e.type === 'DELEGATED'           && (e.to||'').toLowerCase() === (s.email||'').toLowerCase());
      const evRefused    = relevant.filter(e => e.type === 'REFUSED'             && (e.by||'').toLowerCase() === (s.email||'').toLowerCase());

      let state = 'pending';
      if      (st === 'signed')   state = 'done';
      else if (st === 'refused')  state = 'bad';
      else if (st === 'current')  state = 'active';
      else if (st === 'cancelled')state = 'bad';

      const _df1 = s.delegatedFrom;
      const _fromLabel1 = _df1 ? [_df1.name, _df1.functie].filter(Boolean).join(' - ') : '';
      const _isAutoReason1 = _df1 && _df1.reason === 'auto: utilizator în concediu';
      const _reasonStr1 = (_df1?.reason && !_isAutoReason1) ? _df1.reason : '';
      const _tooltip1 = _df1
        ? `Delegat de ${_fromLabel1}${_reasonStr1 ? ' · ' + _reasonStr1 : ''}`
        : '';
      const delegBadge = _df1 && _df1.name
        ? `<span class="tl-actor" title="${esc(_tooltip1)}">🔄 delegat de ${esc(_fromLabel1)}${_reasonStr1 ? ' · ' + esc(_reasonStr1) : ''}</span>`
        : (s.delegatedForName
          ? `<span class="tl-actor" title="În delegare pentru ${esc(s.delegatedForName)}">👥 în delegare pentru ${esc(s.delegatedForName)}</span>`
          : '');

      // Sub-pași: semnare + upload (dacă sunt distincte)
      const subRows = [];
      if (evSigned.length) {
        subRows.push({ done: true, icon: '✍️', label: 'Semnat', ts: evSigned[0].at });
      }
      if (evUploaded.length) {
        subRows.push({ done: true, icon: '📤', label: 'PDF încărcat', ts: evUploaded[0].at });
      }

      const mainTs = st === 'refused'
        ? (s.refusedAt || evRefused[0]?.at || null)
        : (s.signedAt   || evSigned[0]?.at  || null);

      const mainLabel = st === 'refused'
        ? `⛔ ${esc(s.name || s.email)} — Refuzat`
        : st === 'signed'
          ? `✅ ${esc(s.name || s.email)}`
          : st === 'current'
            ? `⏳ ${esc(s.name || s.email)} — Așteaptă semnătura`
            : st === 'cancelled'
              ? `🚫 ${esc(s.name || s.email)} — Anulat`
              : `⏸ ${esc(s.name || s.email)} — În așteptare`;

      const rolLabel = s.rol ? `<span style="font-size:.72rem;color:rgba(234,240,255,.45);margin-left:4px;">${esc(s.rol)}</span>` : '';
      const refuseBlock = (st === 'refused' && s.refuseReason)
        ? `<div class="tl-reason">Motiv: ${esc(s.refuseReason)}</div>` : '';

      // Provider: dacă a semnat → real; dacă pending/current → default org
      const _sProvId = s.signingProvider ||
        (st === 'current' || st === 'pending' || st === 'signed'
          ? (data.orgDefaultProvider || null) : null);
      const _provBadgeHtml = _sProvId ? `<div style="margin-top:4px;">${_provBadge(_sProvId)}</div>` : '';

      steps.push({
        icon: st === 'signed' ? '✍️' : st === 'refused' ? '⛔' : st === 'current' ? '👤' : st === 'cancelled' ? '🚫' : '⏸',
        labelHtml: mainLabel + rolLabel,
        actorHtml: delegBadge + _provBadgeHtml,
        ts: mainTs,
        state,
        subRows: subRows.length >= 1 ? subRows : [],   // afișăm sub-pași dacă există cel puțin unul
        extra: refuseBlock
      });
    }

    // ── PAȘI EMAIL EXTERN ────────────────────────────────────────────────────
    const emailSentEvs = relevant.filter(e => e.type === 'EMAIL_SENT');
    for (const ev of emailSentEvs) {
      const openEv = relevant.find(e => e.type === 'EMAIL_OPENED' && e.trackingId === ev.trackingId);
      // FIX: email complet (nu trunchiat) + nume din nameMap în loc de email
      const toFull   = ev.to || '—';
      const byName   = resolveName(ev.by);  // FIX: nume în loc de email
      const subjectShort = ev.subject ? (ev.subject.length > 60 ? ev.subject.substring(0,60) + '…' : ev.subject) : '';
      const openedPart = openEv
        ? `<div class="tl-sub"><div class="tl-sub-row done"><div class="tl-sub-dot"></div><span>📬 Deschis de destinatar</span><span class="tl-ts" style="margin-left:auto;">${prettyTs(openEv.at)}</span></div></div>`
        : '';
      steps.push({
        icon: '✉️',
        labelHtml: `📧 Email extern trimis <span style="font-size:.72rem;color:rgba(234,240,255,.45);margin-left:4px;">către ${esc(toFull)}</span>`,
        actorHtml: `<span class="tl-actor">${esc(byName)}</span>${subjectShort ? `<span style="font-size:.72rem;color:rgba(234,240,255,.35);margin-left:6px;">"${esc(subjectShort)}"</span>` : ''}`,
        ts: ev.at,
        state: 'done',
        subRows: [],
        extra: openedPart
      });
    }

    // ── PAS FINAL: stare finală a fluxului ───────────────────────────────────
    const flowStatus = data.status || '';
    const evCompleted = relevant.find(e => e.type === 'FLOW_COMPLETED');
    const evCancelled = relevant.find(e => e.type === 'FLOW_CANCELLED');
    const evReview    = relevant.find(e => e.type === 'REVIEW_REQUESTED');
    const evReinit    = relevant.find(e => e.type === 'FLOW_REINITIATED' || e.type === 'FLOW_REINITIATED_AFTER_REVIEW');

    if (data.completed || flowStatus === 'completed') {
      steps.push({ icon:'🏁', label:'Flux finalizat', actor: null, ts: data.completedAt || evCompleted?.at, state:'done', extra:null });
    } else if (flowStatus === 'cancelled') {
      steps.push({ icon:'🚫', label:'Flux anulat', actor: data.cancelledBy ? resolveName(data.cancelledBy) : null, ts: data.cancelledAt || evCancelled?.at, state:'bad', extra: data.cancelReason ? `<div class="tl-reason">Motiv: ${esc(data.cancelReason)}</div>` : null });
    } else if (flowStatus === 'review_requested') {
      steps.push({ icon:'🔄', label:'Trimis spre revizuire', actor: data.reviewRequestedBy ? resolveName(data.reviewRequestedBy) : null, ts: data.reviewRequestedAt || evReview?.at, state:'warn', extra: data.reviewReason ? `<div class="tl-reason">Motiv: ${esc(data.reviewReason)}</div>` : null });
    } else if (signers.some(s => s.status === 'refused')) {
      steps.push({ icon:'⛔', label:'Flux refuzat', actor: null, ts: null, state:'bad', extra:null });
    } else {
      // flux activ — pasul final e pending
      steps.push({ icon:'🏁', label:'Flux finalizat', actor: null, ts: null, state:'pending', extra:null });
    }

    // ── Render ───────────────────────────────────────────────────────────────
    // FIX: sortăm TOȚI pașii cu timestamp cronologic
    // FLOW_CREATED rămâne primul (nu are rival), restul inclusiv finalul — după timestamp
    const firstStep    = steps[0];  // FLOW_CREATED — mereu primul
    const restSteps    = steps.slice(1);
    // Pașii fără timestamp (pending fără dată) rămân la final
    const withTs    = restSteps.filter(s => s.ts).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const withoutTs = restSteps.filter(s => !s.ts);
    const sortedSteps = [firstStep, ...withTs, ...withoutTs];

    wrap.innerHTML = '';
    for (const step of sortedSteps) {
      const div = document.createElement('div');
      div.className = `tl-step tl-${step.state}`;

      const labelHtml = step.labelHtml || esc(step.label || '');
      const actorHtml = step.actorHtml || (step.actor ? `<span class="tl-actor">${esc(step.actor)}</span>` : '');
      const tsHtml    = step.ts ? `<span class="tl-ts">${prettyTs(step.ts)}</span>` : '';
      const metaItems = [actorHtml, tsHtml].filter(Boolean).join(' ');

      let subHtml = '';
      if (step.subRows && step.subRows.length) {
        subHtml = `<div class="tl-sub">` +
          step.subRows.map(r =>
            `<div class="tl-sub-row ${r.done?'done':''}">
               <div class="tl-sub-dot"></div>
               <span>${r.icon} ${esc(r.label)}</span>
               ${r.ts ? `<span class="tl-ts" style="margin-left:auto;">${prettyTs(r.ts)}</span>` : ''}
             </div>`
          ).join('') + `</div>`;
      }

      div.innerHTML = `
        <div class="tl-dot">${step.icon}</div>
        <div class="tl-body">
          <div class="tl-label">${labelHtml}</div>
          ${metaItems ? `<div class="tl-meta">${metaItems}</div>` : ''}
          ${subHtml}
          ${step.extra || ''}
        </div>
      `;
      wrap.appendChild(div);
    }

    // Sumar: "3/5 semnatari · Finalizat / În curs"
    const signedCount  = signers.filter(s => s.status === 'signed').length;
    const totalSigners = signers.length;
    const statusLabel  = data.completed ? 'Finalizat' :
      flowStatus === 'cancelled' ? 'Anulat' :
      flowStatus === 'review_requested' ? 'Spre revizuire' :
      signers.some(s => s.status === 'refused') ? 'Refuzat' : 'În curs';
    tlSum.textContent = `${signedCount}/${totalSigners} semnatari · ${statusLabel}`;

    card.style.display = '';
  }

  function renderSigners(flow){
    const esc = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const list = $("signers");
    list.innerHTML = "";
    const signers = (flow.signers || flow.data?.signers || []);
    if(!signers.length){
      list.innerHTML = `<div class="muted">Nu există semnatari.</div>`;
      return;
    }

    const currentId = flow.currentSignerId || flow.data?.currentSignerId || flow.currentSigner || flow.data?.currentSigner;

    const isFlowRefused = signers.some(s => (s.status || '').toLowerCase() === 'refused');

    for(const s of signers){
      const isCurrent = currentId && (s.id===currentId || s.signerId===currentId || s.token===currentId);
      const st = (s.status || "").toLowerCase();

      const isFlowCancelled = (flow.status || flow.data?.status || '') === 'cancelled';
      let right = `<span class="badge">⏳ în așteptare</span>`;
      if(st==="signed" || st==="done") right = `<span class="badge ok">✅ semnat</span>`;
      else if(st==="refused") right = `<span class="badge bad">⛔ refuz</span>`;
      else if(st==="cancelled") right = `<span class="badge bad">🚫 anulat</span>`;
      else if(isFlowCancelled && (st==="current" || st==="pending")) right = `<span class="badge bad">🚫 anulat</span>`;
      else if(isCurrent) right = `<span class="badge warn">⏱️ curent</span>`;
      else if(isFlowRefused && st==="pending") right = `<span class="badge bad">🚫 anulat</span>`;

      const when = st==="refused" ? (s.refusedAt || s.at) : (s.signedAt || s.at || s.updatedAt || s.date);
      const metaBits = [];
      const functieSigner = s.functie || s.function || "";
      const compartimentSigner = s.compartiment || s.department || "";
      if(functieSigner) metaBits.push(functieSigner);
      if(compartimentSigner) metaBits.push(compartimentSigner);
      if(s.rol || s.role || s.attr) metaBits.unshift(roleLabel(s.rol || s.role || s.attr));
      const meta = metaBits.filter(Boolean).join(" · ");

      const el = document.createElement("div");
      el.className = "item";
      // Badge delegare
      const _df = s.delegatedFrom;
      const _fromLabel = _df ? [_df.name, _df.functie].filter(Boolean).join(' - ') : '';
      const _isAutoReason = _df && _df.reason === 'auto: utilizator în concediu';
      const _reasonStr = (_df?.reason && !_isAutoReason) ? _df.reason : '';
      const _tooltip = _df
        ? `Delegat de: ${_fromLabel}${_reasonStr ? ' · ' + _reasonStr : ''}`
        : '';
      const delegBadge = _df && _df.name
        ? `<div style="margin-top:5px;"><span class="delegation-badge" title="${esc(_tooltip)}">🔄 delegat${_reasonStr ? ' · ' + esc(_reasonStr) : ' de ' + esc(_fromLabel)}</span></div>`
        : (s.delegatedForName
          ? `<div style="margin-top:5px;"><span class="delegation-badge" title="În delegare pentru ${esc(s.delegatedForName)}">👥 în delegare pentru ${esc(s.delegatedForName)}</span></div>`
          : '');
      el.innerHTML = `
        <div class="top">
          <div style="flex:1">
            <div class="name">${(s.name||s.fullName||"—")}</div>
            <div class="meta">${meta || '<span class="muted">—</span>'}</div>
            ${when ? `<div class="meta">📅 ${prettyTs(when)}</div>` : ``}
            ${delegBadge}
            ${st==="refused" && s.refuseReason ? `
              <div style="margin-top:6px; padding:6px 10px; background:rgba(255,77,90,.10); border-left:3px solid var(--bad); border-radius:0 8px 8px 0; font-size:.83rem; color:#ffaaaa;">
                <span style="font-weight:650; color:#ff8a94;">Motiv refuz:</span> ${s.refuseReason}
              </div>` : ``}
          </div>
          <div class="right">${right}</div>
        </div>
      `;
      list.appendChild(el);
    }

    if(linkToken && (flow.status || flow.data?.status) !== 'cancelled'){
      $("hintSigner").style.display = "";
      $("signLink").href = `/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(linkToken)}`;
    } else if (!linkToken) {
      // Verifica daca userul autentificat e semnatarul curent — fara token in URL
      const myEmail = (JSON.parse(localStorage.getItem("docflow_user") || "{}").email || "").toLowerCase();
      const data2 = flow.data || flow;
      const mySigner = (data2.signers || []).find(s => (s.email || "").toLowerCase() === myEmail && s.status === "current");
      if (mySigner) {
        // Obtine token-ul de semnare de la server
        // SEC-01: token din cookie HttpOnly — eliminat jwtToken
        fetch(`/api/my-signer-token/${encodeURIComponent(flowId)}`, { credentials: 'include' }).then(r => r.json()).then(j => {
          if (j.token) {
            $("hintSigner").style.display = "";
            $("signLink").href = `/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(j.token)}`;
            $("signLink").textContent = "✍ Semnează acum";
          }
        }).catch(() => {});
      } else {
        $("hintSigner").style.display = "none";
      }
    }
  }

  function renderEvents(flow){
    const evBox = $("events");
    evBox.innerHTML = "";
    const evs = flow.events || flow.data?.events || [];
    if(!evs.length){
      evBox.innerHTML = `<div class="muted">Nu există evenimente.</div>`;
      return;
    }

    // Construieste nameMap: email -> "Nume — Functie · Compartiment"
    const nameMap = {};
    const data = flow.data || flow;
    if (data.initEmail) nameMap[data.initEmail] = data.initName || data.initEmail;
    (data.signers || []).forEach(s => {
      if (s.email) {
        const extra = [s.functie, s.compartiment].filter(Boolean).join(' · ');
        nameMap[s.email] = (s.name || s.email) + (extra ? ` — ${extra}` : '');
      }
    });

    const esc = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Grupăm: mai întâi evenimentele moștenite (din flux parinte), apoi cele curente
    const sortByDate = (a, b) => new Date(a.at || a.ts || a.time || 0) - new Date(b.at || b.ts || b.time || 0);
    const inherited = evs.filter(e => e._inheritedFrom).sort(sortByDate);
    const current = evs.filter(e => !e._inheritedFrom).sort(sortByDate);

    const renderEv = (e, isInherited) => {
      const ts = prettyTs(e.at || e.ts || e.time || e.createdAt);
      const byRaw = e.who || e.actor || e.by || "";
      const who = nameMap[byRaw] ? esc(nameMap[byRaw]) : esc(byRaw);
      const kind = (e.type || e.kind || e.event || "EVENT").toString();
      const EVENT_LABELS = {
        'FLOW_CREATED':'FLUX CREAT','SIGNED':'SEMNAT','SIGNED_PDF_UPLOADED':'PDF SEMNAT ÎNCĂRCAT',
        'FLOW_COMPLETED':'FLUX FINALIZAT','FLOW_CANCELLED':'FLUX ANULAT','REFUSED':'REFUZAT',
        'DELEGATED':'DELEGAT','PDF_DOWNLOADED':'PDF DESCĂRCAT','REVIEW_REQUESTED':'TRIMIS SPRE REVIZUIRE',
        'FLOW_REINITIATED':'REINIȚIAT','FLOW_REINITIATED_AFTER_REVIEW':'REINIȚIAT DUPĂ REVIZUIRE',
        'EMAIL_SENT':   '📧 EMAIL TRIMIS EXTERN',
        'EMAIL_OPENED': '📬 EMAIL DESCHIS DE DESTINATAR',
      };
      const kindLabel = EVENT_LABELS[kind] || esc(kind.replace(/_/g,' '));
      let extra = '';
      if (kind === 'EMAIL_SENT') {
        extra = `către: ${esc(e.to||'')}`;
        if (e.subject) extra += ` · subiect: ${esc(e.subject)}`;
        if (e.extraAttachmentsCount > 0) extra += ` · +${e.extraAttachmentsCount} fișier(e) extra`;
      } else if (kind === 'EMAIL_OPENED') {
        // who = destinatarul (e.to), sentBy = cel care a trimis
        const sentBy = e.by ? (nameMap[e.by] || e.by) : '';
        extra = `destinatar: ${esc(e.to||'')}${sentBy ? ' · trimis de: ' + esc(sentBy) : ''}`;
      } else {
        extra = esc(e.msg || e.message || e.detail || e.reason || '');
      }
      const line = [kindLabel, kind === 'EMAIL_OPENED' ? '' : who].filter(Boolean).join(' · ');
      const txt = extra ? `${line} — ${extra}` : line;
      const d = document.createElement("div");
      d.className = "ev";
      if (kind === 'EMAIL_SENT')   d.style.cssText = "border-left:2px solid rgba(45,212,191,.6);padding-left:8px;";
      if (kind === 'EMAIL_OPENED') d.style.cssText = "border-left:2px solid rgba(52,211,153,.8);padding-left:8px;background:rgba(52,211,153,.04);";
      if (isInherited) d.style.cssText = "opacity:.65;border-left:2px solid rgba(124,92,255,.35);padding-left:8px;";
      d.innerHTML = `<div class="ts">${ts}</div><div class="txt">${txt}</div>`;
      evBox.appendChild(d);
    };

    if (inherited.length) {
      const sep = document.createElement("div");
      sep.style.cssText = "font-size:.72rem;color:rgba(124,92,255,.6);padding:6px 0 4px;font-weight:600;letter-spacing:.05em;";
      sep.textContent = "── FLUX PARINTE ────────────────────────";
      evBox.appendChild(sep);
      for (const e of inherited) renderEv(e, true);
      const sep2 = document.createElement("div");
      sep2.style.cssText = "font-size:.72rem;color:rgba(45,212,191,.6);padding:6px 0 4px;font-weight:600;letter-spacing:.05em;";
      sep2.textContent = "── FLUX CURENT ─────────────────────────";
      evBox.appendChild(sep2);
    }
    for(const e of current) renderEv(e, false);
  }

  // F-06: Documente suport
  async function loadAttachments() {
    try {
      const params = new URLSearchParams();
      if (linkToken) params.set('token', linkToken);
      const r = await _apiFetch(`/flows/${encodeURIComponent(flowId)}/attachments?${params}`);
      if (!r.ok) return;
      const j = await r.json();
      const atts = j.attachments || [];
      const card = $('attachmentsCard');
      const list = $('attachmentsList');
      if (!atts.length || !card || !list) return;
      card.style.display = '';
      const iconByMime = t => t.includes('pdf') ? '📄' : '🗜️';
      const tokenParam = linkToken ? `?token=${encodeURIComponent(linkToken)}` : '';
      list.innerHTML = atts.map(a => `
        <a href="/flows/${encodeURIComponent(flowId)}/attachments/${a.id}${tokenParam}"
           download="${a.filename.replace(/"/g,'')}"
           style="display:flex;align-items:center;gap:10px;padding:6px 10px;background:rgba(124,92,255,.1);border-radius:8px;text-decoration:none;color:var(--text);font-size:.85rem;border:1px solid rgba(124,92,255,.2);">
          <span>${iconByMime(a.mimeType)}</span>
          <span style="flex:1;">${a.filename}</span>
          <span style="color:var(--muted);font-size:.78rem;">${(a.sizeBytes/1024).toFixed(0)} KB</span>
          <span style="color:#b39dff;font-weight:700;font-size:.78rem;">⬇ Descarcă</span>
        </a>`).join('');
    } catch(e) { /* non-fatal */ }
  }

  async function loadFlow(){
    if(!flowId){
      setMsg("error", `Lipsește parametrul <b>flow</b> în URL. Exemplu: <code>/flow.html?flow=FLOW_...</code>`);
      return;
    }

    // FIX v3.2.2: flowId vine din URL — folosim textContent pentru a preveni XSS
    const pillFlow = $("pillFlow");
    pillFlow.innerHTML = '<strong>Flow</strong> ';
    const flowIdSpan = document.createTextNode(flowId);
    pillFlow.appendChild(flowIdSpan);

    setMsg("", "");

    try{
      let flowUrl = `/flows/${encodeURIComponent(flowId)}`;
      if (linkToken) flowUrl += `?token=${encodeURIComponent(linkToken)}`;
      const j = await apiFetchJson(flowUrl);
      const data = j.data || j;
      window._flowData = data; // pentru modal email

      // nameMap + resolveName — helper local pentru afișarea numelor
      // în loc de email-uri (duplicat de renderTimeline; necesar aici
      // pentru cardul reviewInfoCard L944).
      const nameMap = {};
      if (data.initEmail) nameMap[data.initEmail.toLowerCase()] = data.initName || data.initEmail;
      (data.signers || []).forEach(s => {
        if (s.email) nameMap[s.email.toLowerCase()] = s.name || s.email;
      });
      const resolveName = (email) => nameMap[(email||'').toLowerCase()] || email || '—';

      $("docName").textContent = (data.docName || data.documentName || data.name || data.title || "—");
      const ftPill = $("flowTypePill");
      if (ftPill) ftPill.innerHTML = data.flowType === 'ancore' ? '<span title="PDF cu ancore existente" style="color:#7cf0e0;font-weight:600;">⚓ Ancore</span>' : '<span title="PDF cu tabel generat" style="color:#b39dff;font-weight:600;">📋 Tabel generat</span>';
      // Badge metodă semnare
      const spPill = $("signingProviderPill");
      if (spPill) {
        const _PROV = {
          'sts-cloud':    { icon: '🏛️', label: 'STS Cloud QES',    color: '#7cf0e0' },
          'certsign':     { icon: '🔐', label: 'certSIGN Cloud',   color: '#b39dff' },
          'transsped':    { icon: '🔐', label: 'Trans Sped Cloud', color: '#b39dff' },
          'alfatrust':    { icon: '🔐', label: 'AlfaTrust Cloud',  color: '#b39dff' },
          'namirial':     { icon: '🔐', label: 'Namirial Cloud',   color: '#b39dff' },
          'local-upload': { icon: '⬆️', label: 'Upload local',     color: '#ffd580' },
        };
        const _usedProv = (data.signers || [])
          .filter(s => s.signingProvider).map(s => s.signingProvider).find(Boolean)
          || 'local-upload';
        const _pd = _PROV[_usedProv] || _PROV['local-upload'];
        spPill.innerHTML = `<span style="color:${_pd.color};font-weight:600;">${_pd.icon} ${_pd.label}</span>`;
      }
      // URGENT badge
      const badgeUrgent = $("badgeUrgent");
      if (badgeUrgent) badgeUrgent.style.display = data.urgent ? "" : "none";
      $("initName").textContent = (data.initName || data.initiatorName || "—");
      const instVal = data.institutie || data.institution ||
        (data.signers || []).map(s => s.institutie || s.institution).find(Boolean) || "—";
      $("inst").textContent = instVal;
      const compartVal = data.compartiment || data.compartiment ||
        (data.signers || []).map(s => s.compartiment).find(Boolean) || "—";
      $("compartiment").textContent = compartVal;
      $("updatedAt").textContent = prettyTs(data.updatedAt || data.updated_at || data.createdAt || data.created_at);

      // Banner flux reinițiat după refuz
      if (data.parentFlowId) {
        const banner = $("parentFlowBanner");
        const link   = $("parentFlowLink");
        if (banner && link) {
          link.textContent = data.parentFlowId;
          link.href = `/flow.html?flow=${encodeURIComponent(data.parentFlowId)}${linkToken ? '&token=' + encodeURIComponent(linkToken) : ''}`;
          banner.style.display = '';
        }
      }

      // Calculeaza status real din semnatari
      const signers = data.signers || [];
      let computedStatus = data.status || j.status || "";
      if (!computedStatus || computedStatus === "active") {
        if (signers.length && signers.every(s => s.status === "signed")) computedStatus = "completed";
        else if (signers.some(s => s.status === "refused")) computedStatus = "refused";
        else if (data.status === "review_requested") computedStatus = "review_requested";
        else if (data.status === "cancelled") computedStatus = "cancelled";
        else if (signers.some(s => s.status === "signed" || s.status === "current")) computedStatus = "active";
        else computedStatus = "active";
      }
      const b = statusBadge(computedStatus);
      const badge = $("badgeStatus");
      badge.className = "badge " + b.cls;
      badge.textContent = b.txt;

      const allSignedDone = signers.length > 0 && signers.every(s => s.status === "signed");
      const hasSigned = allSignedDone && !!(j.hasSignedPdf || data.hasSignedPdf);
      $("btnDownloadSigned").disabled = !hasSigned;
      $("btnDownloadSigned").title = hasSigned ? "Descarcă PDF semnat" : allSignedDone ? "Se procesează PDF-ul semnat..." : "Documentul nu a fost semnat de toți semnatarii";
      $("signHint").textContent = hasSigned ? "PDF semnat disponibil." : allSignedDone ? "Se procesează..." : "În așteptarea tuturor semnăturilor.";
      // Buton Trimite email — vizibil doar când PDF-ul semnat e disponibil
      const btnSendEmail = $("btnSendEmail");
      if (btnSendEmail) btnSendEmail.style.display = hasSigned ? "" : "none";
      const btnReport = $("btnTrustReport");
      if (btnReport) btnReport.style.display = (data.completed) ? "block" : "none";

      const hasPdf = !!(j.hasPdf || data.hasPdf);
      $("btnDownloadOriginal").disabled = !hasPdf;

      // Buton Reinitiere — vizibil dacă fluxul e refuzat și userul e inițiator sau admin
      const currentUser = JSON.parse(localStorage.getItem("docflow_user") || "{}");
      const isRefused = computedStatus === "refused";
      const refusedByAprobat = signers.some(s => s.status === "refused" && (s.rol || "").toUpperCase() === "APROBAT");
      // Daca initiatorul (INTOCMIT) a refuzat el insusi, reinitializarea nu are sens
      const refusedByInitiator = signers.some(s => s.status === "refused" &&
        (s.email || "").toLowerCase() === (data.initEmail || "").toLowerCase());
      const isReviewRequested = data.status === "review_requested";
      const isInitiator = (data.initEmail || "").toLowerCase() === (currentUser.email || "").toLowerCase();
      const isAdmin = currentUser.role === "admin" || currentUser.role === "org_admin";
      const btnRei = $("btnReinitiate");
      if (btnRei) btnRei.style.display = (isRefused && !refusedByAprobat && !refusedByInitiator && (isInitiator || isAdmin)) ? "" : "none";
      btnRei._flowId = flowId;

      // Buton Reinitiere după revizuire — vizibil dacă fluxul e în review_requested și user e inițiator
      const btnReiReview = $("btnReinitiateReview");
      if (btnReiReview) btnReiReview.style.display = (isReviewRequested && (isInitiator || isAdmin)) ? "" : "none";

      // Buton Anulează — vizibil pentru inițiator/admin dacă fluxul nu e finalizat/anulat/refuzat
      const btnCancelFlow = $("btnCancelFlow");
      const canCancel = !data.completed && computedStatus !== 'cancelled' && computedStatus !== 'refused' && (isInitiator || isAdmin);
      if (btnCancelFlow) {
        btnCancelFlow.style.display = canCancel ? "" : "none";
        btnCancelFlow.onclick = async () => {
          const reason = prompt('Motiv anulare (opțional):') ?? null;
          if (reason === null) return; // user a dat Cancel la prompt
          if (!confirm(`Anulezi fluxul „${data.docName || flowId}"? Acțiunea este ireversibilă.`)) return;
          btnCancelFlow.disabled = true; btnCancelFlow.textContent = '⏳ Se anulează...';
          try {
            const r = await _apiFetch(`/flows/${encodeURIComponent(flowId)}/cancel`, {
              method: 'POST', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ reason: reason || null })
            });
            const j = await r.json();
            if (j.ok) { setMsg('ok', '🚫 Flux anulat cu succes.'); setTimeout(() => loadFlow(), 800); }
            else setMsg('error', esc(j.message || j.error || 'Eroare la anulare.'));
          } catch(e) { setMsg('error', 'Eroare rețea.'); }
          finally { btnCancelFlow.disabled = false; btnCancelFlow.textContent = '🚫 Anulează'; }
        };
      }

      // Card info revizuire
      let reviewCard = $("reviewInfoCard");
      if (isReviewRequested) {
        if (!reviewCard) {
          reviewCard = document.createElement("div");
          reviewCard.id = "reviewInfoCard";
          reviewCard.style.cssText = "background:rgba(45,212,191,.07);border:1px solid rgba(45,212,191,.3);border-radius:14px;padding:18px 22px;margin-bottom:16px;";
          const msgEl = $("msg");
          if (msgEl) msgEl.parentNode.insertBefore(reviewCard, msgEl.nextSibling);
        }
        reviewCard.innerHTML = `
          <div style="font-weight:700;color:#7cf0e0;margin-bottom:8px;font-size:1rem;">🔄 Document trimis spre revizuire</div>
          <div style="color:var(--sub);font-size:.88rem;margin-bottom:6px;">
            <strong>Solicitat de:</strong> ${data.reviewRequestedBy ? esc(resolveName(data.reviewRequestedBy)) : "—"}
          </div>
          ${data.reviewReason ? `<div style="color:var(--sub);font-size:.88rem;margin-bottom:12px;"><strong>Motiv:</strong> ${data.reviewReason}</div>` : ""}
          ${(isInitiator || isAdmin) ? `
          <div style="margin-top:12px;">
            <div style="font-size:.82rem;color:var(--muted);margin-bottom:8px;">Încarcă un document revizuit (PDF, DOCX, XLSX, PPTX, ODT, imagine). Fișierele non-PDF vor fi convertite automat.</div>
            <input type="file" id="reviewPdfInput" accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.jpg,.jpeg,.png,.webp,.gif,.bmp" style="display:none;" onchange="const n=document.getElementById('reviewPdfName');n.textContent=this.files[0]?.name||'Niciun fișier selectat';n.style.color=this.files[0]?'var(--df-text)':'var(--muted)';" />
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
              <button type="button" onclick="document.getElementById('reviewPdfInput').click()" class="df-action-btn"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-folder"/></svg>Alege fișier</button>
              <span id="reviewPdfName" style="color:var(--muted);font-size:.83rem;">Niciun fișier selectat</span>
            </div>
            <button id="btnUploadReviewPdf" class="df-action-btn success"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.298#ico-upload-cloud"/></svg>Trimite documentul revizuit și repornește fluxul</button>
            <div id="reviewUploadStatus" style="margin-top:8px;font-size:.83rem;"></div>
          </div>
          ` : '<div style="font-size:.82rem;color:var(--muted);margin-top:4px;">Inițiatorul va re-uploada un document revizuit și va reporni fluxul.</div>'}
        `;
        if (isInitiator || isAdmin) {
          const btnUploadRev = $("btnUploadReviewPdf");
          if (btnUploadRev) {
            btnUploadRev.addEventListener("click", async () => {
              const fileInput = $("reviewPdfInput");
              const statusEl = $("reviewUploadStatus");
              if (!fileInput?.files?.length) { if(statusEl) statusEl.textContent = "❌ Selectează un fișier."; return; }
              const file = fileInput.files[0];
              const fName = file.name || '';
              const fExt = (fName.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
              const ACCEPTED = ['.pdf','.docx','.doc','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.odp','.jpg','.jpeg','.png','.webp','.gif','.bmp'];
              if (!ACCEPTED.includes(fExt)) {
                if(statusEl) statusEl.textContent = "❌ Tip fișier neacceptat. Folosește: PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, JPG, PNG, WEBP.";
                return;
              }
              btnUploadRev.disabled = true;
              const origLabel = '⬆️ Trimite documentul revizuit și repornește fluxul';
              try {
                let pdfB64;
                if (fExt === '.pdf') {
                  // Upload direct pentru PDF
                  btnUploadRev.textContent = "⏳ Se procesează...";
                  if(statusEl) statusEl.textContent = "";
                  pdfB64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                  });
                } else {
                  // Conversie server pentru non-PDF
                  btnUploadRev.textContent = `⏳ Convertesc ${fExt.replace('.','').toUpperCase()} la PDF...`;
                  if(statusEl) statusEl.textContent = "";
                  const fd = new FormData();
                  fd.append('file', file, fName);
                  const convResp = await fetch('/api/convert-to-pdf', {
                    method: 'POST', credentials: 'include', body: fd
                  });
                  if (!convResp.ok) {
                    const errJ = await convResp.json().catch(()=>({error:'conversion_failed'}));
                    throw new Error(errJ.message || errJ.error || `Conversie eșuată (${convResp.status})`);
                  }
                  const convJ = await convResp.json();
                  if (!convJ.pdfB64) throw new Error('Răspuns conversie invalid');
                  pdfB64 = convJ.pdfB64.startsWith('data:') ? convJ.pdfB64 : `data:application/pdf;base64,${convJ.pdfB64}`;
                }

                // Trimitem la reinitiate-review (format identic cu înainte)
                btnUploadRev.textContent = "⏳ Se repornește fluxul...";
                const r = await _apiFetch("/flows/" + encodeURIComponent(flowId) + "/reinitiate-review", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pdfB64 })
                });
                const j2 = await r.json();
                if (j2.ok) {
                  setMsg("ok", `✅ Document revizuit trimis! Fluxul a fost repornit (runda ${j2.round || 1}). Semnatarii au fost notificați.`);
                  if(statusEl) statusEl.textContent = "";
                  setTimeout(() => loadFlow(), 1200);
                } else {
                  if(statusEl) statusEl.textContent = "❌ " + (j2.message || j2.error || "Eroare");
                  btnUploadRev.disabled = false; btnUploadRev.textContent = origLabel;
                }
              } catch(e) {
                if(statusEl) statusEl.textContent = "❌ " + e.message;
                btnUploadRev.disabled = false; btnUploadRev.textContent = origLabel;
              }
            });
          }
        }
      } else if (reviewCard) {
        reviewCard.style.display = "none";
      }

      // Buton Audit PDF — vizibil pentru admin
      const btnAudit = $("btnAuditPdf");
      if (btnAudit) {
        btnAudit.style.display = isAdmin ? "" : "none";
        btnAudit.removeAttribute("href");
        btnAudit.onclick = async (e) => {
          e.preventDefault();
          btnAudit.textContent = "⏳ Se generează...";
          btnAudit.style.pointerEvents = "none";
          try {
            const r = await _apiFetch(`/admin/flows/${encodeURIComponent(flowId)}/audit?format=pdf`);
            if (!r.ok) { const er = await r.json().catch(()=>({})); throw new Error(er.error || `HTTP ${r.status}`); }
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          } catch(err) {
            alert("❌ Eroare export audit: " + err.message);
          } finally {
            btnAudit.innerHTML = "📄 Audit PDF";
            btnAudit.style.pointerEvents = "";
          }
        };
      }

      renderSigners(j);
      renderTimeline(j); // P-05
      renderEvents(j);
      loadAttachments(); // F-06

    }catch(e){
      setMsg("error", "❌ " + esc(String(e.message || e)));
    }
  }

  async function downloadSigned(){
    try{
      const blob = await apiFetchBlob(`/flows/${encodeURIComponent(flowId)}/signed-pdf`);
      downloadBlob(blob, `DocFlowAI_${flowId}_signed.pdf`);
    }catch(e){
      setMsg("error", "❌ Nu am putut descărca PDF-ul semnat: " + esc(String(e.message || e)));
    }
  }

  async function downloadOriginal(){
    try{
      const blob = await apiFetchBlob(`/flows/${encodeURIComponent(flowId)}/pdf`);
      downloadBlob(blob, `DocFlowAI_${flowId}.pdf`);
    }catch(e){
      setMsg("error", "❌ Nu am putut descărca PDF-ul original: " + esc(String(e.message || e)));
    }
  }

  $("btnRefresh").addEventListener("click", async () => {
    const btn = $("btnRefresh");
    const orig = btn.textContent;
    btn.textContent = '⏳ Se încarcă...';
    btn.disabled = true;
    try { await loadFlow(); } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });
  $("btnDownloadSigned").addEventListener("click", downloadSigned);
  $("btnDownloadOriginal").addEventListener("click", downloadOriginal);
  $("btnBack").addEventListener("click", ()=>{ window.location.href = "/?tab=flows"; });

  // Buton Trimite email
  // Buton Raport Trust
  const _btnReport = $("btnTrustReport");
  if (_btnReport) {
    // Vizibilitatea se setează în loadFlow() unde avem datele
    _btnReport.addEventListener("click", async () => {
      _btnReport.disabled = true;
      _btnReport.textContent = "⏳ Se generează...";
      try {
        // ?force=1 = ignora cache, regenereaza cu semnatarii actuali
        const r = await _apiFetch(`/api/flows/${encodeURIComponent(flowId)}/report?force=1`);
        if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.message || j.error || "Eroare server"); }
        const blob = await r.blob();
        if (!blob || blob.size < 100) throw new Error('PDF gol returnat de server');
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = `TrustReport_${flowId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch(e) {
        alert("❌ Eroare generare raport: " + e.message);
      } finally {
        _btnReport.disabled = false;
        _btnReport.textContent = "📜 Raport conformitate";
      }
    });
  }

  const _btnSendEmail = $("btnSendEmail");
  if (_btnSendEmail) _btnSendEmail.addEventListener("click", () => {
    const d = window._flowData || {};
    DFEmailModal.open(flowId, { docName: d.docName || flowId, institutie: d.institutie, compartiment: d.compartiment, onSuccess: () => loadFlow() });
  });

  $("btnReinitiate").addEventListener("click", async () => {
    if (!confirm("Reinițiezi fluxul de semnare?\nSe va crea un flux nou fără semnatarul care a refuzat. Semnatarii rămași vor fi notificați.")) return;
    try {
      const r = await _apiFetch("/flows/" + encodeURIComponent(flowId) + "/reinitiate", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        setMsg("ok", `✅ Flux reinițiat! ID nou: <strong>${j.newFlowId}</strong> — <a href="/flow.html?flow=${j.newFlowId}" style="color:#7cf0e0;">Deschide noul flux</a>`);
      } else {
        setMsg("error", "❌ " + esc(j.message || j.error || 'Eroare la reinițiere'));
      }
    } catch(e) { setMsg("error", '❌ ' + esc(String(e.message))); }
  });

  const _btnReiReview = $("btnReinitiateReview");
  if (_btnReiReview) {
    _btnReiReview.addEventListener("click", () => {
      const card = $("reviewInfoCard");
      if (card) {
        card.style.display = "";
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        // Focus pe input-ul de fisier dupa scroll
        setTimeout(() => {
          const inp = $("reviewPdfInput");
          if (inp) inp.click();
        }, 400);
      }
    });
  }

  loadFlow();
