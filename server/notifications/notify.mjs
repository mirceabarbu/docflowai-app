/**
 * DocFlowAI — Notification dispatcher (v3.4.0)
 *
 * Trimite notificări pe toate canalele configurate per utilizator:
 *   - In-app  (tabel notifications + WebSocket push)
 *   - Web Push (service worker / PWA)
 *   - Email    (Resend / SMTP via mailer.mjs)
 *   - WhatsApp (via whatsapp.mjs, dacă e configurat)
 *
 * UTILIZARE:
 *   import { notify, injectNotifyDeps } from './notifications/notify.mjs';
 *
 *   // În index.mjs, după inițializarea pool-ului:
 *   injectNotifyDeps({ pool, wsPush, pushToUser, sendSignerEmail,
 *                      sendWaSignRequest, sendWaCompleted, sendWaRefused,
 *                      isWhatsAppConfigured, saveFlow, getFlowData, escHtml });
 *
 * TIPURI DE NOTIFICĂRI SUPORTATE:
 *   YOUR_TURN      — email complet cu CTA și link semnare
 *   COMPLETED      — flux finalizat
 *   REFUSED        — flux refuzat
 *   REVIEW_REQUESTED, DELEGATED, REMINDER — template generic
 */

import { logger } from '../middleware/logger.mjs';

// ── Dependențe injectate din index.mjs ─────────────────────────────────────
let _pool, _wsPush, _pushToUser, _sendSignerEmail;
let _sendWaSignRequest, _sendWaCompleted, _sendWaRefused, _isWhatsAppConfigured;
let _saveFlow, _getFlowData, _escHtml;

export function injectNotifyDeps(deps) {
  _pool                  = deps.pool;
  _wsPush                = deps.wsPush;
  _pushToUser            = deps.pushToUser;
  _sendSignerEmail       = deps.sendSignerEmail;
  _sendWaSignRequest     = deps.sendWaSignRequest;
  _sendWaCompleted       = deps.sendWaCompleted;
  _sendWaRefused         = deps.sendWaRefused;
  _isWhatsAppConfigured  = deps.isWhatsAppConfigured;
  _saveFlow              = deps.saveFlow;
  _getFlowData           = deps.getFlowData;
  _escHtml               = deps.escHtml;
}

// ── Email template YOUR_TURN ────────────────────────────────────────────────
function buildYourTurnEmail({ flowId, waParams, appUrl, escHtml }) {
  const signerLink = `${appUrl}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(waParams.signerToken)}`;
  const flowUrl    = `${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}`;
  return `
<div style="background:#0b1120;margin:0;padding:32px 16px;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);">
  <div style="background:linear-gradient(135deg,#1e1460 0%,#0f2a4a 100%);padding:28px 32px 24px;text-align:center;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:10px;padding:10px 18px;font-size:1.1rem;font-weight:800;color:#fff;letter-spacing:.5px;">📋 DocFlowAI</div>
    <div style="margin-top:14px;font-size:.8rem;color:rgba(255,255,255,.4);letter-spacing:1px;text-transform:uppercase;">Platformă documente electronice</div>
  </div>
  <div style="padding:28px 32px;">
    <p style="margin:0 0 6px;font-size:1rem;color:#cdd8ff;">Bună${waParams.signerName ? ', <strong>' + escHtml(waParams.signerName) + '</strong>' : ''},</p>
    <p style="margin:0 0 20px;font-size:.9rem;color:#9db0ff;line-height:1.6;">
      ${waParams.initName ? `<strong style="color:#eaf0ff;">${escHtml(waParams.initName)}</strong> te-a adăugat ca semnatar pe documentul de mai jos.` : 'Ești invitat să semnezi electronic un document.'}
      ${waParams.initFunctie || waParams.institutie ? `<br><span style="font-size:.82rem;color:#7c8db0;">${[waParams.initFunctie, waParams.institutie].filter(Boolean).map(escHtml).join(' · ')}</span>` : ''}
    </p>
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
      <div style="font-size:1rem;font-weight:700;color:#eaf0ff;margin-bottom:8px;">📄 ${escHtml(waParams.docName || 'Document de semnat')}</div>
      ${waParams.institutie   ? `<div style="font-size:.82rem;color:#9db0ff;margin-bottom:3px;">🏛 ${escHtml(waParams.institutie)}</div>`   : ''}
      ${waParams.compartiment ? `<div style="font-size:.82rem;color:#9db0ff;margin-bottom:3px;">📂 ${escHtml(waParams.compartiment)}</div>` : ''}
      <div style="font-size:.8rem;color:#5a6a8a;margin-top:6px;">ID flux: <code style="color:#7c8db0;">${escHtml(flowId)}</code></div>
    </div>
    ${waParams.roundInfo ? `<div style="background:rgba(250,180,0,.08);border:1px solid rgba(250,180,0,.2);border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:.83rem;color:#ffd580;">🔄 ${escHtml(waParams.roundInfo)}</div>` : ''}
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
  <div style="border-top:1px solid rgba(255,255,255,.06);padding:14px 32px;text-align:center;">
    <p style="margin:0;font-size:.72rem;color:rgba(255,255,255,.25);">Link valabil 90 de zile · DocFlowAI · Dacă nu ești semnatarul acestui document, ignoră acest email.</p>
  </div>
</div>
</div>`;
}

// ── Email template generic ──────────────────────────────────────────────────
function buildGenericEmail({ flowId, type, title, message, appUrl, escHtml }) {
  const iconMap = { COMPLETED: '✅', REFUSED: '⛔', REVIEW_REQUESTED: '🔄', DELEGATED: '👥' };
  const icon = iconMap[type] || 'ℹ️';
  return `
<div style="background:#0b1120;margin:0;padding:32px 16px;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08);">
  <div style="background:linear-gradient(135deg,#1e1460 0%,#0f2a4a 100%);padding:24px 32px;text-align:center;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:10px;padding:10px 18px;font-size:1.1rem;font-weight:800;color:#fff;">📋 DocFlowAI</div>
  </div>
  <div style="padding:28px 32px;">
    <h2 style="margin:0 0 12px;font-size:1.05rem;color:#eaf0ff;">${icon} ${escHtml(title)}</h2>
    <p style="margin:0 0 16px;font-size:.9rem;color:#9db0ff;line-height:1.6;">${escHtml(message)}</p>
    ${flowId ? `<div style="text-align:center;margin-top:20px;"><a href="${appUrl}/flow.html?flow=${encodeURIComponent(flowId)}" style="display:inline-block;background:rgba(124,92,255,.2);border:1px solid rgba(124,92,255,.4);color:#b39dff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:.88rem;font-weight:600;">🔍 Vezi detalii flux</a></div>` : ''}
  </div>
  <div style="border-top:1px solid rgba(255,255,255,.06);padding:12px 32px;text-align:center;">
    <p style="margin:0;font-size:.72rem;color:rgba(255,255,255,.25);">DocFlowAI · Platformă documente electronice</p>
  </div>
</div>
</div>`;
}

// ── notify() — funcția principală ──────────────────────────────────────────
export async function notify({ userEmail, flowId, type, title, message, waParams = {}, urgent = false }) {
  if (!_pool) return;
  const email = (userEmail || '').toLowerCase();
  if (!email) return;

  const [uRow] = (await _pool.query(
    'SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1',
    [email]
  )).rows;

  // Fiecare canal evaluat independent
  const needsInApp = uRow?.notif_inapp !== false;       // default TRUE
  const needsEmail = !!(uRow?.notif_email);             // explicit opt-in
  const needsWa    = !!(_isWhatsAppConfigured?.() && uRow?.notif_whatsapp && uRow?.phone);

  const displayTitle = urgent ? `🚨 [URGENT] ${title}` : title;

  // ── In-app + WebSocket ──────────────────────────────────────────────────
  if (needsInApp) {
    const r = await _pool.query(
      'INSERT INTO notifications (user_email,flow_id,type,title,message,urgent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, flowId || null, type, displayTitle, message, !!urgent]
    );
    _wsPush?.(email, {
      event: 'new_notification',
      notification: { id: r.rows[0]?.id, flow_id: flowId, type, title: displayTitle, message, read: false, created_at: new Date().toISOString(), urgent: !!urgent }
    });
    const { rows: cntRows } = await _pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [email]
    );
    _wsPush?.(email, { event: 'unread_count', count: parseInt(cntRows[0].count) });
  }

  // ── Web Push (PWA) ──────────────────────────────────────────────────────
  _pushToUser?.(_pool, email, {
    title: displayTitle, body: message,
    icon: '/icon-192.png', badge: '/icon-72.png',
    data: { flowId, type, urgent: !!urgent }
  }).catch(() => {});

  // ── Email ───────────────────────────────────────────────────────────────
  const appUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';
  const escHtml = _escHtml || ((s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));

  let emailHtml;
  if (type === 'YOUR_TURN' && waParams.signerToken) {
    emailHtml = buildYourTurnEmail({ flowId, waParams, appUrl, escHtml });
  } else {
    emailHtml = buildGenericEmail({ flowId, type, title, message, appUrl, escHtml });
  }

  // ── Trimitere paralela email + WhatsApp ─────────────────────────────────
  const eventsToAdd = [];
  const [emailResult, waResult] = await Promise.allSettled([
    needsEmail
      ? _sendSignerEmail({ to: email, subject: urgent ? `🚨 [URGENT] ${title}` : title, html: emailHtml })
      : Promise.resolve({ ok: false, reason: 'disabled' }),
    needsWa
      ? (async () => {
          if (type === 'YOUR_TURN') return _sendWaSignRequest?.({ phone: uRow.phone, signerName: waParams.signerName || '', docName: waParams.docName || '' });
          if (type === 'COMPLETED') return _sendWaCompleted?.({ phone: uRow.phone, docName: waParams.docName || '' });
          if (type === 'REFUSED')   return _sendWaRefused?.({ phone: uRow.phone, docName: waParams.docName || '', refuserName: waParams.refuserName || '', reason: waParams.reason || '' });
          return { ok: false, reason: 'unknown_type' };
        })()
      : Promise.resolve({ ok: false, reason: 'disabled' }),
  ]);

  if (emailResult.status === 'fulfilled' && emailResult.value?.ok)
    eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY', channel: 'email', to: email, notifType: type });
  else if (needsEmail)
    eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY_FAILED', channel: 'email', to: email, reason: String(emailResult.reason || emailResult.value?.error || 'failed') });

  if (waResult.status === 'fulfilled' && waResult.value?.ok)
    eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY', channel: 'whatsapp', to: uRow?.phone || email, notifType: type });
  else if (needsWa)
    eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY_FAILED', channel: 'whatsapp', to: uRow?.phone || email, reason: String(waResult.reason || waResult.value?.reason || 'failed') });

  // ── Persistă events în flow ─────────────────────────────────────────────
  if (eventsToAdd.length && flowId) {
    try {
      const fd = await _getFlowData(flowId);
      if (fd) {
        fd.events = [...(Array.isArray(fd.events) ? fd.events : []), ...eventsToAdd];
        await _saveFlow(flowId, fd);
      }
    } catch(e) { logger.error({ err: e, flowId }, 'notify event save error'); }
  }
}
