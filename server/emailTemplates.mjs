/**
 * DocFlowAI — emailTemplates.mjs
 * Toate template-urile HTML pentru emailuri, extrase din index.mjs, flows.mjs și admin.mjs.
 *
 * Fiecare funcție primește parametrii necesari și returnează { subject, html }.
 * Logica de trimitere rămâne în fișierele originale.
 *
 * CODE-N01: refactorizare b82
 */

// ── Helper: escape HTML ──────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── 1. YOUR_TURN — invitație semnare ─────────────────────────────────────────
export function emailYourTurn({ appUrl, flowId, signerToken, signerName, docName, initName, initFunctie, institutie, compartiment, roundInfo, urgent }) {
  const signerLink = `${appUrl}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(signerToken)}`;
  const flowUrl    = `${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}`;
  const subject    = urgent ? `🚨 [URGENT] Document de semnat: ${docName}` : `✍️ Document de semnat: ${docName}`;
  const html = `
<div style="background:#0b1120;margin:0;padding:32px 16px;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1e1460 0%,#0f2a4a 100%);padding:28px 32px 24px;text-align:center;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:10px;padding:10px 18px;font-size:1.1rem;font-weight:800;color:#fff;letter-spacing:.5px;">📋 DocFlowAI</div>
    <div style="margin-top:14px;font-size:.8rem;color:rgba(255,255,255,.4);letter-spacing:1px;text-transform:uppercase;">Platformă documente electronice</div>
  </div>
  <!-- Body -->
  <div style="padding:28px 32px;">
    <p style="margin:0 0 6px;font-size:1rem;color:#cdd8ff;">Bună${signerName ? ', <strong>' + esc(signerName) + '</strong>' : ''},</p>
    <p style="margin:0 0 20px;font-size:.9rem;color:#9db0ff;line-height:1.6;">
      ${initName ? `<strong style="color:#eaf0ff;">${esc(initName)}</strong> te-a adăugat ca semnatar pe documentul de mai jos.` : 'Ești invitat să semnezi electronic un document.'}
      ${initFunctie || institutie ? `<br><span style="font-size:.82rem;color:#7c8db0;">${[initFunctie, institutie].filter(Boolean).map(esc).join(' · ')}</span>` : ''}
    </p>
    <!-- Document card -->
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
      <div style="font-size:1rem;font-weight:700;color:#eaf0ff;margin-bottom:8px;">📄 ${esc(docName || 'Document de semnat')}</div>
      ${institutie  ? `<div style="font-size:.82rem;color:#9db0ff;margin-bottom:3px;">🏛 ${esc(institutie)}</div>` : ''}
      ${compartiment ? `<div style="font-size:.82rem;color:#9db0ff;margin-bottom:3px;">📂 ${esc(compartiment)}</div>` : ''}
      <div style="font-size:.8rem;color:#5a6a8a;margin-top:6px;">ID flux: <code style="color:#7c8db0;">${esc(flowId)}</code></div>
    </div>
    ${roundInfo ? `<div style="background:rgba(250,180,0,.08);border:1px solid rgba(250,180,0,.2);border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:.83rem;color:#ffd580;">🔄 ${esc(roundInfo)}</div>` : ''}
    <!-- CTA -->
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${signerLink}" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:1rem;letter-spacing:.3px;">✍️ Semnează documentul</a>
    </div>
    <div style="text-align:center;margin-bottom:8px;">
      <a href="${flowUrl}" style="font-size:.8rem;color:#5a6a8a;text-decoration:none;">🔍 Vezi statusul fluxului</a>
    </div>
    <div style="background:rgba(255,100,100,.07);border:1px solid rgba(255,100,100,.18);border-radius:8px;padding:10px 14px;margin-top:16px;font-size:.8rem;color:#ffb3b3;">
      ⚠️ Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi în aplicație.
    </div>
  </div>
  <!-- Footer -->
  <div style="border-top:1px solid rgba(255,255,255,.06);padding:14px 32px;text-align:center;">
    <p style="margin:0;font-size:.72rem;color:rgba(255,255,255,.25);">Link valabil 90 de zile · DocFlowAI · Dacă nu ești semnatarul acestui document, ignoră acest email.</p>
  </div>
</div>
</div>`;
  return { subject, html };
}

// ── 2. GENERIC — COMPLETED, REFUSED, REVIEW_REQUESTED, DELEGATED ─────────────
export function emailGeneric({ appUrl, flowId, type, title, message, urgent }) {
  const iconMap = { COMPLETED: '✅', REFUSED: '⛔', REVIEW_REQUESTED: '🔄', DELEGATED: '👥' };
  const icon    = iconMap[type] || 'ℹ️';
  const subject = urgent ? `🚨 [URGENT] ${title}` : title;
  const html = `
<div style="background:#0b1120;margin:0;padding:32px 16px;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);">
  <div style="background:linear-gradient(135deg,#1e1460 0%,#0f2a4a 100%);padding:24px 32px;text-align:center;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:10px;padding:10px 18px;font-size:1.1rem;font-weight:800;color:#fff;">📋 DocFlowAI</div>
  </div>
  <div style="padding:28px 32px;">
    <h2 style="margin:0 0 12px;font-size:1.05rem;color:#eaf0ff;">${icon} ${esc(title)}</h2>
    <p style="margin:0 0 16px;font-size:.9rem;color:#9db0ff;line-height:1.6;">${esc(message)}</p>
    ${flowId ? `<div style="text-align:center;margin-top:20px;"><a href="${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}" style="display:inline-block;background:rgba(124,92,255,.2);border:1px solid rgba(124,92,255,.4);color:#b39dff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:.88rem;font-weight:600;">🔍 Vezi detalii flux</a></div>` : ''}
  </div>
  <div style="border-top:1px solid rgba(255,255,255,.06);padding:12px 32px;text-align:center;">
    <p style="margin:0;font-size:.72rem;color:rgba(255,255,255,.25);">DocFlowAI · Platformă documente electronice</p>
  </div>
</div>
</div>`;
  return { subject, html };
}

// ── 3. DELEGARE — email pentru noul semnatar delegat ─────────────────────────
export function emailDelegare({ signerLink, resolvedName, originalName, docName, flowId, initName, initEmail, reason, institutie }) {
  const subject = `👥 Delegare semnătură — ${docName}`;
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <div style="text-align:center;margin-bottom:28px;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div>
  </div>
  <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${resolvedName ? ', ' + esc(resolvedName) : ''},</h2>
  <p style="color:#9db0ff;margin:0 0 6px;line-height:1.6;">
    <strong style="color:#ffd580;">${esc(originalName)}</strong> ți-a delegat semnarea electronică a documentului:
  </p>
  <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px 20px;margin:16px 0 20px;">
    <div style="font-size:1rem;font-weight:700;color:#eaf0ff;margin-bottom:6px;">📄 ${esc(docName || flowId)}</div>
    <div style="font-size:.85rem;color:#9db0ff;margin-bottom:4px;">Inițiat de: ${esc(initName || initEmail || '')}</div>
    <div style="font-size:.85rem;color:#ffd580;">Motiv delegare: ${esc(String(reason || '').trim())}</div>
  </div>
  <div style="background:rgba(255,100,100,.08);border:1px solid rgba(255,100,100,.2);border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:.85rem;color:#ffb3b3;">
    ⚠️ Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi.
  </div>
  <div style="text-align:center;">
    <a href="${signerLink}" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:1rem;">✍️ Deschide documentul pentru semnare</a>
  </div>
  <p style="margin-top:20px;font-size:.78rem;color:rgba(255,255,255,.3);text-align:center;">Link valid 90 de zile · DocFlowAI · ${esc(institutie || '')}</p>
</div>`;
  return { subject, html };
}

// ── 4. RESET PASSWORD — email cu parolă temporară ────────────────────────────
export function emailResetPassword({ appUrl, numeUser, email, newPwd }) {
  const subject = '🔑 Parolă resetată — DocFlowAI';
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <div style="text-align:center;margin-bottom:28px;"><div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div></div>
  <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${numeUser ? ', ' + esc(numeUser) : ''},</h2>
  <p style="color:#9db0ff;margin:0 0 24px;line-height:1.6;">Parola contului tău a fost resetată de un administrator.</p>
  <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px 24px;margin-bottom:24px;">
    <div style="margin-bottom:14px;"><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">EMAIL</span><strong>${esc(email)}</strong></div>
    <div><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">PAROLĂ TEMPORARĂ</span><strong style="color:#ffd580;font-family:monospace;">${esc(newPwd)}</strong></div>
  </div>
  <p style="color:#5a6a8a;font-size:.8rem;margin:0 0 20px;">Schimbă parola după prima autentificare.</p>
  <div style="text-align:center;margin-top:28px;"><a href="${appUrl}/login" style="background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Accesează aplicația</a></div>
</div>`;
  return { subject, html };
}

// ── 5. SEND CREDENTIALS — email la creare cont sau trimitere credențiale ──────
export function emailCredentials({ appUrl, numeUser, email, newPwd }) {
  const subject = 'Cont DocFlowAI — credențiale de acces';
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <div style="text-align:center;margin-bottom:28px;"><div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div></div>
  <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${numeUser ? ', ' + esc(numeUser) : ''},</h2>
  <p style="color:#9db0ff;margin:0 0 24px;line-height:1.6;">Contul tău în <strong style="color:#eaf0ff;">DocFlowAI</strong> a fost creat sau parola a fost resetată.</p>
  <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px 24px;margin-bottom:24px;">
    <div style="margin-bottom:14px;"><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">EMAIL</span><strong>${esc(email)}</strong></div>
    <div><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">PAROLĂ TEMPORARĂ</span><strong style="color:#ffd580;font-family:monospace;">${esc(newPwd)}</strong></div>
  </div>
  <p style="color:#5a6a8a;font-size:.8rem;margin:0 0 20px;">Această parolă este valabilă pentru o singură utilizare. Recomandăm schimbarea ei după prima autentificare.</p>
  <div style="text-align:center;margin-top:28px;"><a href="${appUrl}/login" style="background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Accesează aplicația</a></div>
</div>`;
  return { subject, html };
}

// ── 6. VERIFICARE EMAIL GWS ───────────────────────────────────────────────────
export function emailVerifyGws({ verifyUrl, numeUser }) {
  const subject = '✅ Verificare adresă email — DocFlowAI';
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <div style="text-align:center;margin-bottom:24px;"><div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div></div>
  <h2 style="margin:0 0 10px;font-size:1.1rem;color:#cdd8ff;">Verificare adresă email</h2>
  <p style="color:#9db0ff;margin:0 0 24px;line-height:1.6;">Bună${numeUser ? ' ' + esc(numeUser) : ''},<br>Apasă butonul de mai jos pentru a verifica adresa de email și a activa contul.</p>
  <div style="text-align:center;margin-bottom:24px;">
    <a href="${verifyUrl}" style="background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:1rem;">✅ Verifică adresa de email</a>
  </div>
  <p style="color:#5a6a8a;font-size:.78rem;text-align:center;">Dacă nu ai solicitat această verificare, ignoră emailul.</p>
</div>`;
  return { subject, html };
}

/**
 * emailSendExtern — template email pentru trimitere document finalizat extern.
 * Extras din flows.mjs (A — b97) — zero modificări de conținut.
 *
 * @param {object} p
 * @param {string} p.flowId
 * @param {object} p.data        — datele fluxului (docName, institutie, compartiment, completedAt)
 * @param {Array}  p.signers     — lista semnatarilor normalizată [{name,rol,status,signedAt}]
 * @param {string} p.bodyText    — textul personalizat al mesajului (opțional)
 */
export function emailSendExtern({ flowId, data, signers = [], bodyText = '', trackingId = null, appBase = '' }) {
  const statusColor = (st) => st === 'semnat' ? '#1a7a4a' : st === 'refuzat' ? '#b03030' : '#7c5cff';
  const statusBg    = (st) => st === 'semnat' ? '#d4f5e5' : st === 'refuzat' ? '#fde8e8' : '#ede8ff';

  const signersTable = signers.map(s => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;color:#1a2340;font-weight:500;">${s.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;color:#3d5299;font-weight:600;">${s.rol}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;">
          <span style="background:${statusBg(s.status)};color:${statusColor(s.status)};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;">${s.status.toUpperCase()}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;color:#5a6a9a;font-size:12px;">${s.signedAt ? new Date(s.signedAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—'}</td>
      </tr>`).join('');

  const customBody = bodyText
    ? `<p style="margin:0 0 24px;line-height:1.8;color:#1a1a1a;font-size:14px;white-space:pre-line;">${bodyText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`
    : '';

  // Click tracking — link-ul "DocFlowAI" duce la docflowai.ro (site public)
  // Destinatarul emailului extern nu are cont în platformă
  const platformUrl = 'https://www.docflowai.ro';
  // URL tracking neutral — /d/:id nu contine "click"/"track"/"email" => mai putin blocat de Yahoo/Outlook
  const trackedUrl  = trackingId && appBase
    ? `${appBase}/d/${trackingId}`
    : platformUrl;

  // Link direct cu ID precompletat — tracking via /d/:trackingId, redirect la /verifica?id=FLOWID
  // URL-ul final dupa redirect: /verifica?id=FLOWID — se autocompleaza si se verifica automat
  const verifyUrl = appBase ? `${appBase}/verifica?id=${encodeURIComponent(flowId)}` : `https://www.docflowai.ro/verifica?id=${encodeURIComponent(flowId)}`;
  const linkSection = `
      <div style="margin:20px 0;padding:16px 20px;background:#f0f4ff;border:1px solid #c5d0f0;border-radius:10px;border-left:4px solid #7c5cff;">
        <p style="margin:0 0 6px;font-size:11px;color:#5a6a9a;text-transform:uppercase;letter-spacing:.6px;font-weight:700;">Document disponibil în platformă</p>
        <p style="margin:0 0 10px;font-size:13px;color:#1a2340;">Flow ID: <strong style="color:#7c5cff;">${flowId}</strong></p>
        <p style="margin:0;font-size:13px;color:#1a2340;">
          Accesează direct pagina de verificare:<br>
          <a href="${trackedUrl}" target="_blank" style="color:#7c5cff;word-break:break-all;">${verifyUrl}</a>
        </p>
      </div>`;

  const html = `<!DOCTYPE html>
<html lang="ro"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fc;font-family:'Segoe UI',Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
    <div style="background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:14px 14px 0 0;padding:24px 32px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;"><tr>
        <td style="width:52px;vertical-align:middle;">
          <div style="width:40px;height:40px;background:rgba(255,255,255,.2);border-radius:10px;text-align:center;line-height:40px;font-size:20px;">&#128203;</div>
        </td>
        <td style="vertical-align:middle;padding-left:12px;">
          <div style="font-size:11px;color:rgba(255,255,255,.85);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Document semnat electronic</div>
          <div style="font-size:17px;font-weight:700;color:#fff;">${data.docName || flowId}</div>
        </td>
      </tr></table>
    </div>
    <div style="background:#fff;border:1px solid #dde4f5;border-top:none;border-radius:0 0 14px 14px;padding:20px 32px 24px;margin-bottom:20px;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:4px 0;color:#5a6a9a;width:140px;font-weight:600;">Instituție</td><td style="color:#1a1a1a;">${data.institutie || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#5a6a9a;font-weight:600;">Compartiment</td><td style="color:#1a1a1a;">${data.compartiment || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#5a6a9a;font-weight:600;">Finalizat la</td><td style="color:#1a7a4a;font-weight:600;">${data.completedAt ? new Date(data.completedAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#5a6a9a;font-weight:600;">Flow ID</td><td style="color:#7c5cff;font-family:monospace;font-size:12px;">${flowId}</td></tr>
      </table>
    </div>
    <!-- Tabelul semnatarilor eliminat din emailul extern — detalii disponibile în PDF-ul atașat și în platformă -->
    <div style="background:#fff;border:1px solid #dde4f5;border-radius:10px;padding:20px 24px;margin-bottom:20px;">
      ${customBody || '<p style="margin:0;color:#1a1a1a;font-size:14px;">Vă transmitem atașat documentul semnat electronic.</p>'}
    </div>
    ${linkSection}
    <div style="border-top:1px solid #dde4f5;padding-top:16px;margin-top:4px;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;color:#5a6a9a;">Trimis prin <strong>DocFlowAI</strong> · noreply@docflowai.ro</p>
    </div>
  </div>
</body></html>`;

  return { html };
}
