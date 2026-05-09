/**
 * DocFlowAI — Integration tests: POST /api/contact
 *
 * Acoperire:
 *   ✓ 400 câmp obligatoriu lipsă (inst)
 *   ✓ 400 email invalid
 *   ✓ 400 telefon invalid (litere)
 *   ✓ 400 subject > 200 chars
 *   ✓ 400 msg > 5000 chars
 *   ✓ 200 happy path — escHtml aplicat: <script> → &lt;script&gt; în payload Resend
 *   ✓ 200 CR/LF în subject — stripat din payload Resend
 *   ✓ 200 telefon valid (format internațional)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock-uri ESM ──────────────────────────────────────────────────────────────

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
  redactUrl: (u) => u,
}));

vi.mock('../../middleware/rateLimiter.mjs', () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

// fetch mock global
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helper: escHtml identic cu implementarea din auth.mjs ─────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── App Express minimală — replică handler-ul din index.mjs ───────────────────

function _stripHeaderInjection(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim();
}

const CONTACT_LIMITS = { inst: 200, name: 150, email: 200, phone: 40, subject: 200, msg: 5000 };

function createContactApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/contact', async (req, res) => {
    try {
      const { inst, name, email, phone, subject, msg } = req.body || {};

      const _t = (v) => String(v || '').trim();
      const instTrim    = _t(inst);
      const nameTrim    = _t(name);
      const emailTrim   = _t(email).toLowerCase();
      const phoneTrim   = _t(phone);
      const subjectTrim = _stripHeaderInjection(_t(subject));
      const msgTrim     = _t(msg);

      if (!instTrim || !nameTrim || !emailTrim || !subjectTrim)
        return res.status(400).json({ error: 'Câmpuri obligatorii lipsesc.' });

      if (instTrim.length    > CONTACT_LIMITS.inst    ||
          nameTrim.length    > CONTACT_LIMITS.name    ||
          emailTrim.length   > CONTACT_LIMITS.email   ||
          phoneTrim.length   > CONTACT_LIMITS.phone   ||
          subjectTrim.length > CONTACT_LIMITS.subject ||
          msgTrim.length     > CONTACT_LIMITS.msg)
        return res.status(400).json({ error: 'Unul sau mai multe câmpuri depășesc lungimea maximă.' });

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim))
        return res.status(400).json({ error: 'Email invalid.' });

      if (phoneTrim && !/^[0-9+\-\s().]{6,40}$/.test(phoneTrim))
        return res.status(400).json({ error: 'Telefon invalid.' });

      const RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';
      const MAIL_FROM = process.env.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>';

      const htmlBody = `<div>${escHtml(instTrim)}|${escHtml(nameTrim)}|${escHtml(emailTrim)}|${escHtml(phoneTrim || '—')}|${escHtml(subjectTrim)}|${escHtml(msgTrim || '—')}</div>`;

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: 'contact@docflowai.ro',
          reply_to: emailTrim,
          subject: '[DocFlowAI Demo] ' + subjectTrim + ' — ' + instTrim,
          html: htmlBody,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'Eroare la trimiterea emailului.' });
      return res.json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: 'Eroare server.' });
    }
  });

  return app;
}

const app = createContactApp();

const VALID_BODY = {
  inst: 'Primăria Testului',
  name: 'Ion Popescu',
  email: 'ion@primaria.ro',
  subject: 'Demo solicitat',
  msg: 'Doresc o demonstrație.',
};

function mockResendOk() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ id: 'resend-id-123' }),
  });
}

describe('POST /api/contact', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('400 — câmp obligatoriu lipsă (inst)', async () => {
    const { inst: _, ...body } = VALID_BODY;
    const res = await request(app).post('/api/contact').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/obligatorii/i);
  });

  it('400 — email invalid', async () => {
    const res = await request(app).post('/api/contact').send({ ...VALID_BODY, email: 'nu-e-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email invalid/i);
  });

  it('400 — telefon invalid (litere)', async () => {
    const res = await request(app).post('/api/contact').send({ ...VALID_BODY, phone: 'abcdefg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/telefon invalid/i);
  });

  it('400 — subject > 200 chars', async () => {
    const res = await request(app).post('/api/contact').send({ ...VALID_BODY, subject: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lungimea/i);
  });

  it('400 — msg > 5000 chars', async () => {
    const res = await request(app).post('/api/contact').send({ ...VALID_BODY, msg: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lungimea/i);
  });

  it('200 happy path — escHtml aplicat pe <script>', async () => {
    mockResendOk();
    const res = await request(app).post('/api/contact').send({
      ...VALID_BODY,
      subject: 'Test <script>alert(1)</script>',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verificăm că fetch a fost apelat cu HTML escape-uit în body
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.html).toContain('&lt;script&gt;');
    expect(sentBody.html).not.toContain('<script>');
    // Subject este plain text — conține textul raw (nu HTML-escaped)
    expect(sentBody.subject).toContain('Test <script>alert(1)</script>');
  });

  it('200 — CR/LF în subject stripat din payload Resend', async () => {
    mockResendOk();
    const res = await request(app).post('/api/contact').send({
      ...VALID_BODY,
      subject: 'Subiect\r\nInjected-Header: evil',
    });
    expect(res.status).toBe(200);

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.subject).not.toMatch(/\r|\n/);
    expect(sentBody.subject).toContain('Subiect');
  });

  it('200 — telefon valid (format internațional)', async () => {
    mockResendOk();
    const res = await request(app).post('/api/contact').send({
      ...VALID_BODY,
      phone: '+40 721 123 456',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
