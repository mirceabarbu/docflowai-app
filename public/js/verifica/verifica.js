// JS specific verifica.html — pagină publică de verificare semnături.
// Conține logica din Block 1 inline (fost L408-L729): tab switching, file drop/upload,
// verificare prin ID, verificare prin PDF, afișare rezultate.
// Rulează la final de <body>, fără defer — IIFE auto-invocat la DOM gata.

const $ = id => document.getElementById(id);

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(tab) {
  $('tab-id').style.display  = tab === 'id'  ? '' : 'none';
  $('tab-pdf').style.display = tab === 'pdf' ? '' : 'none';
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === (tab === 'id' ? 0 : 1)));
  clearResult();
}

// ── File handling ──────────────────────────────────────────────────────────
let _pdfB64 = null;

function onDrop(e) {
  e.preventDefault();
  $('dropZone').classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
}
function onFileSelect(inp) {
  if (inp.files[0]) loadFile(inp.files[0]);
}
function loadFile(f) {
  if (!f.name.toLowerCase().endsWith('.pdf')) {
    showErr('Te rog selectează un fișier PDF.'); return;
  }
  if (f.size > 50 * 1024 * 1024) {
    showErr('Fișierul depășește 50 MB.'); return;
  }
  const r = new FileReader();
  r.onload = e => {
    _pdfB64 = e.target.result;
    $('fileName').textContent = f.name;
    $('fileSize').textContent = (f.size / 1024).toFixed(0) + ' KB';
    $('fileInfo').style.display = 'block';
    $('dropZone').style.display = 'none';
    clearResult();
  };
  r.readAsDataURL(f);
}
function clearFile() {
  _pdfB64 = null;
  $('fileInfo').style.display = 'none';
  $('dropZone').style.display = '';
  $('fileInput').value = '';
  clearResult();
}

// ── Verify ─────────────────────────────────────────────────────────────────
async function verifyById() {
  const flowId = $('inputFlowId').value.trim().toUpperCase();
  if (!flowId) { showErr('Introduceți ID-ul fluxului.'); return; }
  clearResult(); setLoading(true);
  try {
    const r = await fetch('/verify/' + encodeURIComponent(flowId), {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });
    let j;
    try { j = await r.json(); } catch(parseErr) {
      showErr('Eroare: răspuns invalid de la server (status ' + r.status + '). Verificați consola.'); return;
    }
    if (!r.ok) { showErr(j.message || j.error || 'Eroare server: ' + r.status); return; }
    renderDbResult(j);
  } catch(e) { showErr('Eroare de rețea: ' + e.message); }
  finally { setLoading(false); }
}

async function verifyByPdf() {
  if (!_pdfB64) { showErr('Te rog selectează un PDF.'); return; }
  const flowId = $('inputFlowIdPdf').value.trim().toUpperCase() || null;
  clearResult(); setLoading(true);
  try {
    const r = await fetch('/verify/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfB64: _pdfB64, flowId }),
    });
    const j = await r.json();
    if (!r.ok) { showErr(j.message || j.error || 'Eroare server.'); return; }
    renderCryptoResult(j);
  } catch(e) { showErr('Eroare de rețea: ' + e.message); }
  finally { setLoading(false); }
}

// ── Render DB result (verificare după flow ID) ─────────────────────────────
function renderDbResult(data) {
  $('result').style.display = 'block';
  $('levelsSection').style.display = 'block';
  $('sigList').innerHTML = '';

  // Verdict
  const isComplete = data.status === 'completed';
  const v = $('verdictBox');
  v.className = 'verdict ' + (isComplete ? 'valid' : 'partial');
  $('verdictIcon').textContent = isComplete ? '✅' : '⏳';
  $('verdictTitle').textContent = isComplete
    ? 'Document autentic — flux finalizat'
    : 'Document în procesare — flux activ';
  $('verdictSub').textContent =
    `Flow ID: ${data.flowId} · ${data.signers.filter(s => s.status === 'signed').length}/${data.signers.length} semnatari`;

  // Niveluri — pentru DB verification avem L1 (hash) + DB match
  const levels = [
    { name: 'Document găsit în platformă', status: 'ok', note: 'Autentic' },
    { name: 'Integritate flux',   status: isComplete ? 'ok' : 'partial', note: isComplete ? 'Finalizat' : 'În procesare' },
    { name: 'Semnatari confirmați', status: data.signers.every(s=>s.status==='signed') ? 'ok' : 'partial', note: `${data.signers.filter(s=>s.status==='signed').length}/${data.signers.length}` },
    { name: 'Timestamp DocFlowAI', status: 'ok', note: data.completedAt ? fmt(data.completedAt) : '—' },
    { name: 'Semnătură criptografică', status: 'unknown', note: 'Upload PDF pentru verificare completă' },
    { name: 'Conformitate QES/eIDAS',  status: 'unknown', note: 'Upload PDF pentru verificare' },
  ];
  renderLevels(levels);

  // Date document
  $('dbSection').style.display = 'block';
  $('dbInfoGrid').innerHTML = [
    { lbl: 'Document', val: data.docName },
    { lbl: 'Flow ID',  val: data.flowId, mono: true },
    { lbl: 'Instituție', val: data.institutie || '—' },
    { lbl: 'Compartiment', val: data.compartiment || '—' },
    { lbl: 'Tip flux', val: data.flowType === 'ancore' ? '⚓ Ancore existente' : '📋 Tabel generat' },
    { lbl: 'Status', val: statusLabel(data.status) },
    { lbl: 'Creat la', val: fmt(data.createdAt) },
    { lbl: 'Finalizat la', val: data.completedAt ? fmt(data.completedAt) : '—' },
  ].map(i => `<div class="info-box"><div class="lbl">${i.lbl}</div><div class="val ${i.mono?'mono':''}">${esc(i.val)}</div></div>`).join('');

  // Semnatari
  if (data.signers.length > 0) {
    $('signersSection').style.display = 'block';
    $('signersTbody').innerHTML = data.signers.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td style="color:var(--muted);">${esc(s.rol)}</td>
        <td><span class="signed-badge ${s.status==='signed'?'signed':'unsigned'}">${s.status==='signed'?'SEMNAT':'NESEMNAT'}</span></td>
        <td style="font-size:.78rem;color:var(--muted);font-family:var(--mono);">${s.signedAt ? fmt(s.signedAt) : '—'}</td>
      </tr>`).join('');
  }
}

// ── Render Crypto result (verificare criptografică PDF) ────────────────────
function renderCryptoResult(data) {
  $('result').style.display = 'block';
  $('levelsSection').style.display = 'none';
  $('sigList').innerHTML = '';

  const sigs = data.signatures || [];
  const sig  = sigs[0];
  const sum  = data.summary;

  if (!sig && data.error === 'no_signatures') {
    setVerdict('invalid', '❌', 'Nicio semnătură electronică găsită', 'PDF-ul nu conține o semnătură electronică calificată PAdES.');
    return;
  }

  if (!sig) {
    setVerdict('invalid', '⚠', 'Eroare verificare', data.error || 'Necunoscut');
    return;
  }

  renderAggregateVerdict(sigs, sum);

  sigs.forEach((s, i) => $('sigList').appendChild(renderSignatureBlock(s, i, sigs.length)));

  // Date din DB (dacă au fost corelate)
  if (data.dbData) {
    $('dbSection').style.display = 'block';
    $('dbInfoGrid').innerHTML = [
      { lbl: 'Document',   val: data.dbData.docName },
      { lbl: 'Instituție', val: data.dbData.institutie || '—' },
      { lbl: 'Finalizat',  val: data.dbData.completedAt ? fmt(data.dbData.completedAt) : '—' },
      { lbl: 'Status',     val: statusLabel(data.dbData.status) },
    ].map(i => `<div class="info-box"><div class="lbl">${i.lbl}</div><div class="val">${esc(i.val)}</div></div>`).join('');

    if (data.dbData.signers?.length > 0) {
      $('signersSection').style.display = 'block';
      $('signersTbody').innerHTML = data.dbData.signers.map(s => `
        <tr>
          <td>${esc(s.name)}</td>
          <td style="color:var(--muted);">${esc(s.rol)}</td>
          <td><span class="signed-badge ${s.status==='signed'?'signed':'unsigned'}">${s.status==='signed'?'SEMNAT':'NESEMNAT'}</span></td>
          <td style="font-size:.78rem;color:var(--muted);font-family:var(--mono);">${s.signedAt ? fmt(s.signedAt) : '—'}</td>
        </tr>`).join('');
    }
  }
}

// ── Verdict agregat (documentul, nu prima semnătură — #146) ────────────────
// La N=1, comportamentul e IDENTIC cu versiunea veche (criteriu de non-regresie):
// `summary.isValid`/`isQES` la un singur element sunt egale cu `sig.isValid`/`isQES`.
function renderAggregateVerdict(sigs, sum) {
  const sig = sigs[0];
  if (sigs.length === 1) {
    const isQES   = sum?.isQES ?? sig.isQES;
    const isValid = sum?.isValid ?? sig.isValid;
    if (isValid && isQES) {
      setVerdict('valid', '✅', 'Semnătură electronică calificată (QES)', `Semnată de ${sum?.signer || sig.certificate?.subject?.CN || '?'} · ${sum?.qtsp || ''}`);
    } else if (isValid) {
      setVerdict('partial', '🔐', 'Semnătură validă — conformitate QES neverificată', `QTSP nerecunoscut sau certificat fără QcCompliance`);
    } else {
      setVerdict('invalid', '❌', 'Semnătură invalidă sau document modificat', sig.errors?.join(' · ') || '');
    }
    return;
  }

  const N = sigs.length;
  const cnOf = s => s.certificate?.subject?.CN || '?';
  const names            = sigs.map(cnOf).join(' · ');
  const invalidNames     = sigs.filter(s => s.isValid === false).map(cnOf);
  const inconclusiveNames = sigs.filter(s => s.levels?.L2?.ok === null).map(cnOf);
  const qesCount = sigs.filter(s => s.isQES).length;

  if (sum?.allValid && sum?.allQES) {
    setVerdict('valid', '✅', `${N} semnături electronice calificate (QES)`, names);
  } else if (sum?.allValid) {
    setVerdict('valid', '✅', `${N} semnături valide (${qesCount} calificate)`, names);
  } else if (invalidNames.length > 0) {
    setVerdict('invalid', '❌', `${invalidNames.length} din ${N} semnături invalide`, invalidNames.join(' · '));
  } else if (inconclusiveNames.length > 0) {
    setVerdict('partial', '⚠', `${N} semnături · ${inconclusiveNames.length} neconcludente`, inconclusiveNames.join(' · '));
  } else {
    setVerdict('partial', '⚠', `${N} semnături — stare neclară`, names);
  }
}

// ── Bloc per semnătură (calea PDF) ──────────────────────────────────────────
// Extras din vechiul renderCryptoResult — aceeași logică de randare pentru
// niveluri/certificat/lanț, apelată acum o dată per semnătură.
function renderSignatureBlock(sig, index, total) {
  const block = document.createElement('div');
  block.className = 'sig-block' + (index > 0 ? ' collapsed' : '');

  const head = document.createElement('div');
  head.className = 'sig-head';

  const dotState = sig.isValid === false ? 'fail' : (sig.isValid === true ? 'ok' : 'unknown');
  const dot = document.createElement('div');
  dot.className = 'sig-dot ' + dotState;
  head.appendChild(dot);

  const idxEl = document.createElement('div');
  idxEl.className = 'sig-index';
  idxEl.textContent = '#' + (index + 1);
  head.appendChild(idxEl);

  const nameWrap = document.createElement('div');
  nameWrap.className = 'sig-name-wrap';
  const cnEl = document.createElement('div');
  cnEl.className = 'sig-cn';
  cnEl.textContent = sig.certificate?.subject?.CN || 'Necunoscut';
  nameWrap.appendChild(cnEl);
  if (sig.certificate?.subject?.O) {
    const orgEl = document.createElement('div');
    orgEl.className = 'sig-org';
    orgEl.textContent = sig.certificate.subject.O;
    nameWrap.appendChild(orgEl);
  }
  head.appendChild(nameWrap);

  if (sig.isQES) {
    const qesBadge = document.createElement('span');
    qesBadge.className = 'sig-qes-badge';
    qesBadge.textContent = 'QES';
    head.appendChild(qesBadge);
  }

  const chevron = document.createElement('span');
  chevron.className = 'sig-chevron';
  chevron.textContent = '▾';
  head.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'sig-body';

  // Niveluri
  const L = sig.levels || {};
  const levels = [
    { name: 'Integritate document (L1)',     status: dotStatus(L.L1?.ok), note: L.L1?.ok ? 'Hash intact' : (L.L1?.ok === false ? 'Modificat!' : 'Neverificat') },
    { name: 'Semnătură CMS/PKCS#7 (L2)',    status: dotStatus(L.L2?.ok), note: L.L2?.note || (L.L2?.ok ? 'Validă' : 'Invalidă') },
    { name: 'Certificat semnatar (L3)',      status: dotStatus(L.L3?.ok), note: L.L3?.ok ? 'Prezent' : 'Lipsă' },
    // #149 — `null` = neconcludent (rădăcină dedusă), NU „incomplet". Folosim
    // nota serverului când există, ca să nu afirmăm pe pagina publică altceva.
    { name: 'Lanț certificare (L4)',         status: dotStatus(L.L4?.ok), note: L.L4?.ok ? `${sig.chain?.length || 0} niveluri` : (L.L4?.note || (L.L4?.ok === false ? 'Incomplet' : 'Neconcludent')) },
    { name: 'OCSP/CRL — revocare (L5)',      status: dotStatus(L.L5?.ok), note: L.L5?.note || (L.L5?.ok === null ? 'URL OCSP lipsă' : L.L5?.ok ? 'Valabil' : 'Revocat!') },
    { name: 'Conformitate QES/eIDAS (L6)',   status: dotStatus(L.L6?.ok), note: L.L6?.qtspName || (L.L6?.ok ? 'QES confirmat' : 'Neverificat') },
  ];
  const levelsBox = document.createElement('div');
  levelsBox.className = 'levels sig-levels';
  levelsBox.innerHTML = levels.map(l => `
    <div class="level-item">
      <div class="level-dot ${l.status}"></div>
      <div>
        <div class="level-name">${esc(l.name)}</div>
        <div class="level-status ${l.status}">${esc(l.note)}</div>
      </div>
    </div>`).join('');
  body.appendChild(levelsBox);

  // Certificat
  if (sig.certificate) {
    const c = sig.certificate;
    const certGrid = document.createElement('div');
    certGrid.className = 'info-grid sig-cert';
    certGrid.innerHTML = [
      { lbl: 'Semnatar (CN)', val: c.subject?.CN || '—' },
      { lbl: 'Organizație',   val: c.subject?.O || '—' },
      { lbl: 'Emis de',       val: c.issuer?.CN || '—' },
      // #147/E2 — STS nu pune atributul CMS `signingTime` (PAdES preferă marca
      // temporală). O liniuță pare un câmp lipsă din eroare; spunem explicit.
      { lbl: 'Data semnării', val: sig.signingTime ? fmt(sig.signingTime) : 'nedeclarată în semnătură' },
      { lbl: 'Valabil de la', val: c.notBefore ? fmt(c.notBefore) : '—' },
      { lbl: 'Valabil până la', val: c.notAfter ? fmt(c.notAfter) : '—' },
      { lbl: 'Valabil la semnare', val: c.validAtSigning === true ? '✅ Da' : (c.validAtSigning === false ? '❌ Nu' : '—') },
      { lbl: 'URL OCSP', val: c.ocspUrl || '—' },
    ].map(i => `<div class="info-box"><div class="lbl">${esc(i.lbl)}</div><div class="val" style="font-size:.82rem;">${esc(String(i.val))}</div></div>`).join('');
    body.appendChild(certGrid);
  }

  // Lanț certificare
  if (sig.chain?.length > 0) {
    const chainBox = document.createElement('div');
    chainBox.className = 'chain sig-chain';
    chainBox.innerHTML = sig.chain.map((c, i) => {
      const type = c.isSelfSigned ? 'root' : (i === 0 ? 'end' : 'ca');
      const icon = type === 'root' ? '🏛' : (type === 'end' ? '👤' : '🔗');
      const label = type === 'root' ? 'CA Rădăcină' : (type === 'end' ? 'Semnatar' : 'CA Intermediar');
      return `<div class="chain-item">
        <span class="chain-icon">${icon}</span>
        <div style="flex:1;">
          <div class="chain-cn">${esc(c.CN || '?')}</div>
          <div class="chain-org">${esc(c.O || c.issuerCN || '')} · ${fmtShort(c.notBefore)} – ${fmtShort(c.notAfter)}</div>
        </div>
        <span class="chain-badge ${type}">${label}</span>
      </div>`;
    }).join('');
    body.appendChild(chainBox);
  }

  block.appendChild(head);
  block.appendChild(body);

  head.addEventListener('click', () => block.classList.toggle('collapsed'));

  return block;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function setVerdict(cls, icon, title, sub) {
  const v = $('verdictBox');
  v.className = 'verdict ' + cls;
  $('verdictIcon').textContent  = icon;
  $('verdictTitle').textContent = title;
  $('verdictSub').textContent   = sub;
}

function renderLevels(levels) {
  $('levelsBox').innerHTML = levels.map(l => `
    <div class="level-item">
      <div class="level-dot ${l.status}"></div>
      <div>
        <div class="level-name">${l.name}</div>
        <div class="level-status ${l.status}">${l.note}</div>
      </div>
    </div>`).join('');
}

function dotStatus(val) {
  if (val === true)  return 'ok';
  if (val === false) return 'fail';
  if (val === null || val === undefined) return 'unknown';
  return 'partial';
}

function fmt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' });
  } catch { return String(iso); }
}
function fmtShort(iso) {
  if (!iso) return '—';
  try { return new Date(iso).getFullYear(); } catch { return '?'; }
}

function statusLabel(s) {
  return { completed: '✅ Finalizat', active: '⏳ Activ', cancelled: '🚫 Anulat', refused: '⛔ Refuzat' }[s] || s || '—';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showErr(msg) {
  const e = $('errBox');
  e.textContent = '⚠ ' + msg;
  e.style.display = '';
}

function clearResult() {
  $('result').style.display = 'none';
  $('errBox').style.display = 'none';
  $('dbSection').style.display = 'none';
  $('levelsSection').style.display = 'none';
  $('signersSection').style.display = 'none';
  $('signersTbody').innerHTML = '';
  $('dbInfoGrid').innerHTML = '';
  $('levelsBox').innerHTML = '';
  $('sigList').innerHTML = '';
}

function setLoading(on) {
  $('loading').style.display = on ? 'block' : 'none';
}

// Expunere pentru teste (happy-dom, `new Function(src).call(globalThis)` nu
// lasă declarațiile top-level pe window) — fără efect în producție.
if (typeof window !== 'undefined') {
  window.__verificaTest = { renderCryptoResult, renderDbResult, renderAggregateVerdict, renderSignatureBlock, clearResult };
}

// Precompletare ID din URL: /verifica?id=PT_XXXX sau /verifica#PT_XXXX
(function() {
  const params = new URLSearchParams(window.location.search);
  const idFromUrl = params.get('id') || params.get('flow') || window.location.hash.replace('#','');
  if (idFromUrl) {
    const inp = document.getElementById('inputFlowId');
    if (inp) {
      inp.value = idFromUrl.trim().toUpperCase();
      // Triggeram verificarea automat dupa 300ms
      setTimeout(() => { verifyById && verifyById(); }, 300);
    }
  }
})();
