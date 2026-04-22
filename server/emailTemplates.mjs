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
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <p style="margin:0 0 8px;font-size:1rem;color:#1a1a1a;">Bună${signerName ? ', <strong>' + esc(signerName) + '</strong>' : ''},</p>
  <p style="margin:0 0 20px;color:#4a5568;line-height:1.6;">
    ${initName ? `<strong style="color:#1a1a1a;">${esc(initName)}</strong> te-a adăugat ca semnatar pe documentul de mai jos.` : 'Ești invitat să semnezi electronic un document.'}
    ${initFunctie || institutie ? `<br><span style="font-size:.85rem;color:#7a8ab0;">${[initFunctie, institutie].filter(Boolean).map(esc).join(' · ')}</span>` : ''}
  </p>
  <div style="background:#f7f9fc;border:1px solid #dde4f5;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
    <div style="font-weight:700;color:#1a1a1a;margin-bottom:8px;">${esc(docName || 'Document de semnat')}</div>
    ${institutie  ? `<div style="font-size:.85rem;color:#5a6a9a;margin-bottom:3px;">Instituție: ${esc(institutie)}</div>` : ''}
    ${compartiment ? `<div style="font-size:.85rem;color:#5a6a9a;margin-bottom:3px;">Compartiment: ${esc(compartiment)}</div>` : ''}
    <div style="font-size:.82rem;color:#7a8ab0;margin-top:6px;">ID flux: <span style="font-family:monospace;color:#5a6a9a;">${esc(flowId)}</span></div>
  </div>
  ${roundInfo ? `<div style="background:#fff7e6;border:1px solid #f3d88c;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:.88rem;color:#856000;">${esc(roundInfo)}</div>` : ''}
  <div style="text-align:center;margin:24px 0 16px;">
    <a href="${signerLink}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:6px;font-weight:600;font-size:.95rem;">Semnează documentul</a>
  </div>
  <div style="text-align:center;margin-bottom:20px;">
    <a href="${flowUrl}" style="font-size:.85rem;color:#7c5cff;text-decoration:none;">Vezi statusul fluxului</a>
  </div>
  <div style="background:#fef6f6;border:1px solid #f5c6c6;border-radius:6px;padding:10px 14px;font-size:.85rem;color:#8b3a3a;">
    Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi în aplicație.
  </div>
  <p style="margin-top:24px;font-size:.75rem;color:#7a8ab0;text-align:center;">Link valabil 90 de zile · DocFlowAI · Dacă nu ești semnatarul acestui document, ignoră acest email.</p>
</div>`;
  return { subject, html };
}

// ── 2. GENERIC — COMPLETED, REFUSED, REVIEW_REQUESTED, DELEGATED ─────────────
export function emailGeneric({ appUrl, flowId, type, title, message, urgent }) {
  const iconMap = { COMPLETED: '✅', REFUSED: '⛔', REVIEW_REQUESTED: '🔄', DELEGATED: '👥' };
  const icon    = iconMap[type] || 'ℹ️';
  const subject = urgent ? `🚨 [URGENT] ${title}` : title;
  const html = `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <h2 style="margin:0 0 12px;font-size:1.1rem;color:#1a1a1a;">${icon} ${esc(title)}</h2>
  <p style="margin:0 0 16px;color:#4a5568;line-height:1.6;">${esc(message)}</p>
  ${flowId ? `<div style="text-align:center;margin-top:24px;"><a href="${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:.9rem;font-weight:600;">Vezi detalii flux</a></div>` : ''}
  <p style="margin-top:24px;font-size:.75rem;color:#7a8ab0;text-align:center;">DocFlowAI · Platformă documente electronice</p>
</div>`;
  return { subject, html };
}

// ── 3. DELEGARE — email pentru noul semnatar delegat ─────────────────────────
export function emailDelegare({ signerLink, resolvedName, originalName, docName, flowId, initName, initEmail, reason, institutie }) {
  const subject = `👥 Delegare semnătură — ${docName}`;
  const html = `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <h2 style="margin:0 0 8px;font-size:1.05rem;color:#1a1a1a;">Bună${resolvedName ? ', ' + esc(resolvedName) : ''},</h2>
  <p style="margin:0 0 12px;color:#4a5568;line-height:1.6;">
    <strong style="color:#1a1a1a;">${esc(originalName)}</strong> ți-a delegat semnarea electronică a documentului:
  </p>
  <div style="background:#f7f9fc;border:1px solid #dde4f5;border-radius:8px;padding:16px 20px;margin:16px 0 20px;">
    <div style="font-weight:700;color:#1a1a1a;margin-bottom:6px;">${esc(docName || flowId)}</div>
    <div style="font-size:.85rem;color:#5a6a9a;margin-bottom:4px;">Inițiat de: ${esc(initName || initEmail || '')}</div>
    <div style="font-size:.85rem;color:#856000;">Motiv delegare: ${esc(String(reason || '').trim())}</div>
  </div>
  <div style="background:#fef6f6;border:1px solid #f5c6c6;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:.85rem;color:#8b3a3a;">
    Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi.
  </div>
  <div style="text-align:center;">
    <a href="${signerLink}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:.95rem;">Deschide documentul pentru semnare</a>
  </div>
  <p style="margin-top:24px;font-size:.75rem;color:#7a8ab0;text-align:center;">Link valid 90 de zile · DocFlowAI · ${esc(institutie || '')}</p>
</div>`;
  return { subject, html };
}

// ── 4. RESET PASSWORD — email cu parolă temporară ────────────────────────────
export function emailResetPassword({ appUrl, numeUser, email, newPwd }) {
  const subject = '🔑 Parolă resetată — DocFlowAI';
  const html = `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <h2 style="margin:0 0 8px;font-size:1.05rem;color:#1a1a1a;">Bună${numeUser ? ', ' + esc(numeUser) : ''},</h2>
  <p style="margin:0 0 20px;color:#4a5568;line-height:1.6;">Parola contului tău a fost resetată de un administrator.</p>
  <div style="background:#f7f9fc;border:1px solid #dde4f5;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
    <div style="margin-bottom:14px;">
      <div style="color:#5a6a9a;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Email</div>
      <strong style="color:#1a1a1a;">${esc(email)}</strong>
    </div>
    <div>
      <div style="color:#5a6a9a;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Parolă temporară</div>
      <strong style="color:#7c5cff;font-family:monospace;font-size:1rem;">${esc(newPwd)}</strong>
    </div>
  </div>
  <p style="color:#5a6a9a;font-size:.85rem;margin:0 0 24px;">Schimbă parola după prima autentificare.</p>
  <div style="text-align:center;">
    <a href="${appUrl}/login" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:.95rem;">Accesează aplicația</a>
  </div>
</div>`;
  return { subject, html };
}

// ── 5. SEND CREDENTIALS — email la creare cont sau trimitere credențiale ──────
export function emailCredentials({ appUrl, numeUser, email, newPwd }) {
  const subject = 'Cont DocFlowAI — credențiale de acces';
  const html = `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <h2 style="margin:0 0 8px;font-size:1.05rem;color:#1a1a1a;">Bună${numeUser ? ', ' + esc(numeUser) : ''},</h2>
  <p style="margin:0 0 20px;color:#4a5568;line-height:1.6;">Contul tău în <strong style="color:#1a1a1a;">DocFlowAI</strong> a fost creat sau parola a fost resetată.</p>
  <div style="background:#f7f9fc;border:1px solid #dde4f5;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
    <div style="margin-bottom:14px;">
      <div style="color:#5a6a9a;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Email</div>
      <strong style="color:#1a1a1a;">${esc(email)}</strong>
    </div>
    <div>
      <div style="color:#5a6a9a;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Parolă temporară</div>
      <strong style="color:#7c5cff;font-family:monospace;font-size:1rem;">${esc(newPwd)}</strong>
    </div>
  </div>
  <p style="color:#5a6a9a;font-size:.85rem;margin:0 0 24px;">Această parolă este valabilă pentru o singură utilizare. Recomandăm schimbarea ei după prima autentificare.</p>
  <div style="text-align:center;">
    <a href="${appUrl}/login" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:.95rem;">Accesează aplicația</a>
  </div>
</div>`;
  return { subject, html };
}

// ── 6. VERIFICARE EMAIL GWS ───────────────────────────────────────────────────
export function emailVerifyGws({ verifyUrl, numeUser }) {
  const subject = '✅ Verificare adresă email — DocFlowAI';
  const html = `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <h2 style="margin:0 0 10px;font-size:1.05rem;color:#1a1a1a;">Verificare adresă email</h2>
  <p style="margin:0 0 24px;color:#4a5568;line-height:1.6;">Bună${numeUser ? ' ' + esc(numeUser) : ''},<br>Apasă butonul de mai jos pentru a verifica adresa de email și a activa contul.</p>
  <div style="text-align:center;margin-bottom:24px;">
    <a href="${verifyUrl}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:6px;font-weight:600;font-size:.95rem;">Verifică adresa de email</a>
  </div>
  <p style="color:#7a8ab0;font-size:.78rem;text-align:center;">Dacă nu ai solicitat această verificare, ignoră emailul.</p>
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
          Accesează direct pagina de verificare:
          <a href="${trackedUrl}" target="_blank" style="color:#7c5cff;">verifica</a>
        </p>
      </div>`;

  const html = `<!DOCTYPE html>
<html lang="ro"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fc;font-family:'Segoe UI',Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
    <div style="background:#7c5cff;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:14px 14px 0 0;padding:24px 32px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;"><tr>
        <td style="width:52px;vertical-align:middle;">
          <div style="width:40px;height:40px;background:rgba(255,255,255,.2);border-radius:10px;text-align:center;line-height:40px;font-size:20px;">&#128203;</div>
        </td>
        <td style="vertical-align:middle;padding-left:12px;">
          <div style="font-size:11px;color:rgba(255,255,255,.85);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Document semnat electronic</div>
          <div style="font-size:17px;font-weight:700;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.25);">${data.docName || flowId}</div>
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
      <p style="margin:0 0 4px;font-size:12px;color:#5a6a9a;">Trimis prin <a href="https://www.docflowai.ro" style="color:#7c5cff;text-decoration:none;font-weight:700;">DocFlowAI</a> · contact@docflowai.ro</p>
    </div>
  </div>
</body></html>`;

  return { html };
}
