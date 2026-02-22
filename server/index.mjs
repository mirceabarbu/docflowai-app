import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { readAll, writeAll, nowIso, genId, sanitizeSigner } from './storage.mjs';

// Optional: OpenAI (for AI text suggestions)
import OpenAI from 'openai';

const app = express();
app.disable('x-powered-by');

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/api/', limiter);

function bad(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

function roClean(t) {
  const m = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
  return String(t || '').split('').map(c => m[c] || c).join('');
}

function flowForSigner(flow, idx) {
  // minimize what signers receive (no EmailJS public key needed if you switch to server mail)
  return {
    id: flow.id,
    docName: flow.docName,
    initName: flow.initName,
    initEmail: flow.initEmail,
    createdAt: flow.createdAt,
    signers: flow.signers.map((s, i) => ({
      order: s.order,
      rol: s.rol,
      name: s.name,
      email: s.email,
      status: s.status,
      signedAt: s.signedAt,
      // token only for the current signer
      token: i === idx ? s.token : undefined,
    })),
    pdfB64: flow.pdfB64,
  };
}

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Notify signer (email sending is server-side; currently logs only)
app.post('/api/notify-signer', async (req, res) => {
  try {
    const { toEmail, toName, subject, signerLink, flowId, fromName } = req.body || {};
    if (!toEmail || !signerLink) return bad(res, 'toEmail sau signerLink lipseste');

    // MVP-clean: no client-side EmailJS. Here we only log the notification.
    // Later we will integrate Resend / SendGrid using server-side API keys from Railway Variables.
    console.log('[notify-signer]', {
      toEmail,
      toName,
      subject,
      signerLink,
      flowId,
      fromName,
      at: nowIso(),
    });

    return res.json({ ok: true, queued: true });
  } catch (e) {
    console.error('notify-signer error:', e);
    return bad(res, 'Eroare server la notify-signer', 500);
  }
});

// Create flow
app.post('/api/flows', async (req, res) => {
  const { docName, initName, initEmail, signers, pdfB64, meta } = req.body || {};
  if (!pdfB64 || typeof pdfB64 !== 'string') return bad(res, 'pdfB64 lipseste');
  if (!initName) return bad(res, 'initName lipseste');
  if (!Array.isArray(signers) || signers.length < 1) return bad(res, 'signers invalid');

  const id = genId();
  const flow = {
    id,
    docName: String(docName || 'Document').slice(0, 200),
    initName: String(initName).slice(0, 160),
    initEmail: String(initEmail || '').slice(0, 200),
    createdAt: nowIso(),
    status: 'active',
    signers: signers.map(sanitizeSigner),
    pdfB64,
    meta: meta || {},
    audit: [{ at: nowIso(), ev: 'created', by: roClean(initName) }],
  };

  // Ensure ordering is correct
  flow.signers = flow.signers
    .map((s, i) => ({ ...s, order: i + 1 }))
    .filter(s => s.email && s.token);

  if (flow.signers.length < 1) return bad(res, 'Niciun semnatar valid (email + token)');

  const db = await readAll();
  db.flows[id] = flow;
  await writeAll(db);

  res.json({ ok: true, id });
});

// Get flow for dashboard (initiator only)
app.get('/api/flows/:id', async (req, res) => {
  const { id } = req.params;
  const db = await readAll();
  const flow = db.flows[id];
  if (!flow) return bad(res, 'Flow inexistent', 404);
  // For demo: no auth; in production, protect this endpoint.
  res.json({ ok: true, flow });
});

// Get flow for signer
app.get('/api/flows/:id/signer', async (req, res) => {
  const { id } = req.params;
  const idx = Number(req.query.idx);
  const token = String(req.query.token || '');

  if (!Number.isInteger(idx) || idx < 0) return bad(res, 'idx invalid');

  const db = await readAll();
  const flow = db.flows[id];
  if (!flow) return bad(res, 'Flow inexistent', 404);

  const signer = flow.signers[idx];
  if (!signer || signer.token !== token) return bad(res, 'Token invalid', 403);
  if (idx > 0 && flow.signers[idx - 1].status !== 'signed') return bad(res, 'Nu este randul tau (semnare secventiala)', 409);

  res.json({ ok: true, flow: flowForSigner(flow, idx) });
});

// Submit signature (signer)
app.post('/api/flows/:id/sign', async (req, res) => {
  const { id } = req.params;
  const { idx, token, pdfB64, signedAt, signerIpMeta } = req.body || {};
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0) return bad(res, 'idx invalid');
  if (!token) return bad(res, 'token lipseste');
  if (!pdfB64) return bad(res, 'pdfB64 lipseste');

  const db = await readAll();
  const flow = db.flows[id];
  if (!flow) return bad(res, 'Flow inexistent', 404);

  const signer = flow.signers[i];
  if (!signer || signer.token !== String(token)) return bad(res, 'Token invalid', 403);
  if (signer.status === 'signed') return bad(res, 'Deja semnat', 409);
  if (i > 0 && flow.signers[i - 1].status !== 'signed') return bad(res, 'Nu este randul tau', 409);

  signer.status = 'signed';
  signer.signedAt = signedAt || nowIso();
  flow.pdfB64 = pdfB64;

  flow.audit.push({ at: nowIso(), ev: 'signed', by: roClean(signer.name || signer.email), idx: i, meta: signerIpMeta || {} });

  // Update flow status if complete
  if (flow.signers.every(s => s.status === 'signed')) {
    flow.status = 'completed';
    flow.audit.push({ at: nowIso(), ev: 'completed', by: 'system' });
  }

  db.flows[id] = flow;
  await writeAll(db);

  res.json({ ok: true, flow });
});

// AI suggestions (optional)
app.post('/api/ai/suggest', async (req, res) => {
  const { task, context } = req.body || {};
  if (!task) return bad(res, 'task lipseste');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return bad(res, 'OPENAI_API_KEY nu este setat pe server', 501);

  const client = new OpenAI({ apiKey });

  // Uses Responses API (recommended by OpenAI)
  const prompt = `Task: ${task}\n\nContext (RO):\n${JSON.stringify(context || {}, null, 2)}\n\nReturneaza doar textul final in limba romana, fara ghilimele.`;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5',
    input: prompt,
  });

  res.json({ ok: true, text: response.output_text || '' });
});

// Redirect root to initiator
app.get('/', (req, res) => res.redirect('/semdoc-initiator.html'));

// Static
app.use('/', express.static(new URL('../public', import.meta.url).pathname));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`SemDoc+ server running on http://localhost:${port}`);
});
