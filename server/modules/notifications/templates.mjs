/**
 * server/modules/notifications/templates.mjs — Email templates (RO, HTML responsive)
 */

const BRAND_COLOR = '#2563eb';
const BASE_STYLE  = `
  body { margin:0; padding:0; background:#f3f4f6; font-family:Arial,Helvetica,sans-serif; }
  .wrap { max-width:600px; margin:32px auto; background:#fff; border-radius:8px;
          box-shadow:0 1px 4px rgba(0,0,0,.08); overflow:hidden; }
  .hdr  { background:${BRAND_COLOR}; padding:24px 32px; }
  .hdr h1 { margin:0; color:#fff; font-size:20px; font-weight:700; }
  .hdr p  { margin:4px 0 0; color:#bfdbfe; font-size:13px; }
  .body { padding:32px; color:#374151; font-size:15px; line-height:1.6; }
  .body h2 { font-size:17px; color:#111827; margin-top:0; }
  .btn  { display:inline-block; margin:20px 0; padding:12px 28px;
          background:${BRAND_COLOR}; color:#fff; text-decoration:none;
          border-radius:6px; font-size:15px; font-weight:600; }
  .meta { background:#f9fafb; border-radius:6px; padding:16px; margin:20px 0;
          font-size:13px; color:#6b7280; }
  .meta b { color:#374151; }
  .ftr  { padding:16px 32px; font-size:12px; color:#9ca3af; border-top:1px solid #e5e7eb; }
`;

function _wrap(title, subtitle, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_STYLE}</style></head><body>
<div class="wrap">
  <div class="hdr"><h1>DocFlowAI</h1><p>${_esc(subtitle)}</p></div>
  <div class="body">${bodyHtml}</div>
  <div class="ftr">DocFlowAI &mdash; Semnare electronică calificată &bull;
    Acest mesaj a fost generat automat. Nu răspundeți la acest email.</div>
</div></body></html>`;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _meta(rows) {
  return `<div class="meta">${rows.map(([k,v]) => `<b>${_esc(k)}:</b> ${_esc(v)}`).join('<br>')}</div>`;
}

// ── buildSignerEmail ──────────────────────────────────────────────────────────

export function buildSignerEmail({ flow, signer, signerLink }) {
  const docName = flow.doc_name || flow.docName || 'document';
  const subject = `Aveți un document de semnat — ${docName}`;
  const html    = _wrap(
    'Document de semnat',
    'Acțiune necesară: semnătură electronică',
    `<h2>Bună ziua, ${_esc(signer.name || signer.email)},</h2>
     <p>Aveți un document care necesită semnătura dumneavoastră electronică calificată.</p>
     ${_meta([
       ['Document',     docName],
       ['Flux',         flow.title || flow.id],
       ['Inițiator',    flow.initiator_name || flow.initName || ''],
       ['Organizație',  flow.org_name || ''],
     ])}
     <p>Accesați link-ul de mai jos pentru a semna documentul:</p>
     <a class="btn" href="${_esc(signerLink)}">Semnați documentul</a>
     <p style="font-size:12px;color:#9ca3af;">Link-ul este valabil 72 de ore.</p>`
  );
  return { subject, html };
}

// ── buildCompletedEmail ───────────────────────────────────────────────────────

export function buildCompletedEmail({ flow, initiator }) {
  const docName = flow.doc_name || flow.docName || 'document';
  const subject = `Document semnat — ${docName}`;
  const html    = _wrap(
    'Document semnat',
    'Toți semnatarii au aprobat documentul',
    `<h2>Document finalizat</h2>
     <p>Documentul <b>${_esc(docName)}</b> a fost semnat de toți semnatarii.</p>
     ${_meta([
       ['Document',     docName],
       ['Flux',         flow.title || flow.id],
       ['Finalizat la', new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' })],
     ])}
     <p>Puteți descărca documentul semnat din aplicație.</p>`
  );
  return { subject, html };
}

// ── buildRefusedEmail ─────────────────────────────────────────────────────────

export function buildRefusedEmail({ flow, refusedBy, reason }) {
  const docName = flow.doc_name || flow.docName || 'document';
  const subject = `Document refuzat — ${docName}`;
  const html    = _wrap(
    'Document refuzat',
    'Un semnatar a refuzat documentul',
    `<h2>Document refuzat</h2>
     <p>Documentul <b>${_esc(docName)}</b> a fost refuzat.</p>
     ${_meta([
       ['Document',     docName],
       ['Refuzat de',   _esc(refusedBy || '')],
       ['Motiv',        _esc(reason    || 'nespecificat')],
     ])}
     <p>Puteți reinițializa fluxul din aplicație după corectarea documentului.</p>`
  );
  return { subject, html };
}

// ── buildCancelledEmail ───────────────────────────────────────────────────────

export function buildCancelledEmail({ flow, signer }) {
  const docName = flow.doc_name || flow.docName || 'document';
  const subject = `Document anulat — ${docName}`;
  const html    = _wrap(
    'Document anulat',
    'Fluxul de semnare a fost anulat',
    `<h2>Document anulat</h2>
     <p>Fluxul de semnare pentru documentul <b>${_esc(docName)}</b> a fost anulat.</p>
     ${_meta([
       ['Document', docName],
       ['Flux',     flow.title || flow.id],
     ])}
     <p>Nu mai este necesară nicio acțiune din partea dumneavoastră.</p>`
  );
  return { subject, html };
}

// ── buildDelegatedEmail ───────────────────────────────────────────────────────

export function buildDelegatedEmail({ flow, newSigner, reason }) {
  const docName = flow.doc_name || flow.docName || 'document';
  const subject = `Document delegat către dumneavoastră — ${docName}`;
  const html    = _wrap(
    'Document delegat',
    'Semnătura a fost delegată dumneavoastră',
    `<h2>Bună ziua, ${_esc(newSigner.name || newSigner.email)},</h2>
     <p>Semnătura pentru documentul <b>${_esc(docName)}</b> v-a fost delegată.</p>
     ${_meta([
       ['Document', docName],
       ['Motiv delegare', _esc(reason || 'nespecificat')],
     ])}
     <p>Veți primi un link separat de semnare.</p>`
  );
  return { subject, html };
}

// ── buildWelcomeEmail ─────────────────────────────────────────────────────────

export function buildWelcomeEmail({ user, tempPassword }) {
  const subject = 'Cont DocFlowAI creat';
  const html    = _wrap(
    'Bun venit la DocFlowAI',
    'Contul dumneavoastră a fost creat',
    `<h2>Bun venit, ${_esc(user.name || user.email)}!</h2>
     <p>Contul dumneavoastră DocFlowAI a fost creat de administratorul organizației.</p>
     ${_meta([
       ['Email',        user.email],
       ['Parolă temp.', tempPassword || '(setată de administrator)'],
     ])}
     <p><b>Schimbați parola la prima autentificare.</b></p>
     <p style="font-size:12px;color:#9ca3af;">
       Dacă nu ați solicitat acest cont, ignorați acest email.
     </p>`
  );
  return { subject, html };
}
