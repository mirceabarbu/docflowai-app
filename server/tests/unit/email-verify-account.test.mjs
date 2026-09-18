import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emailVerifyAccount } from '../../emailTemplates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('emailVerifyAccount', () => {
  it('genereaza subiect neschimbat si HTML pe fundal alb, fara fundalul inchis vechi', () => {
    const { subject, html } = emailVerifyAccount({
      verifyUrl: 'https://app.docflowai.ro/auth/verify-email/abc123',
      numeUser: 'Ion Popescu',
      expiraOre: 72,
    });
    expect(subject).toBe('✅ Verificare adresă email — DocFlowAI');
    expect(html).toContain('background:#ffffff');
    expect(html).not.toContain('#0f1731');

    const occurrences = html.split('https://app.docflowai.ro/auth/verify-email/abc123').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toContain('href="https://app.docflowai.ro/auth/verify-email/abc123"');

    expect(html).toContain('Ion Popescu');
    expect(html).toContain('72 de ore');
  });

  it('face escaping la numele utilizatorului si la URL cu ghilimele', () => {
    const { html } = emailVerifyAccount({
      verifyUrl: 'https://app.docflowai.ro/x?a="onmouseover="alert(1)',
      numeUser: '<script>x</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('a="onmouseover="alert(1)"');
  });

  it('cade pe 72 de ore la expiraOre invalid', () => {
    expect(emailVerifyAccount({ verifyUrl: 'https://x', numeUser: 'A', expiraOre: 0 }).html).toContain('72 de ore');
    expect(emailVerifyAccount({ verifyUrl: 'https://x', numeUser: 'A', expiraOre: 'abc' }).html).toContain('72 de ore');
    expect(emailVerifyAccount({ verifyUrl: 'https://x', numeUser: 'A' }).html).toContain('72 de ore');
  });

  it('server/routes/admin/users.mjs nu mai contine fundalul inchis si foloseste emailVerifyAccount', () => {
    const src = readFileSync(join(__dirname, '../../routes/admin/users.mjs'), 'utf8');
    expect(src).not.toContain('#0f1731');
    expect(src).toContain('emailVerifyAccount(');
  });
});
