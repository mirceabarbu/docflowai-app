import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '../../index.mjs'), 'utf8');

// Linia de emit a notificării in-app din notify() — identificată univoc prin `title: displayTitle`
const emitLine = indexSrc
  .split('\n')
  .find(l => l.includes('wsPush(email') && l.includes('title: displayTitle'));

describe('F6 — contractul WS al notify() pentru toast live', () => {
  it('linia de emit a notificării există', () => {
    expect(emitLine, 'nu am găsit linia wsPush a notificării in-app din notify()').toBeTruthy();
  });

  it('emite event:\'notification\' cu payload plat sub cheia data', () => {
    expect(emitLine).toMatch(/event:\s*['"]notification['"]/);
    expect(emitLine).toMatch(/\bdata:\s*\{/);
  });

  it('NU mai emite event:\'new_notification\' nicăieri (formă orfană, 0 consumatori)', () => {
    expect(indexSrc).not.toMatch(/event:\s*['"]new_notification['"]/);
  });

  it('payload-ul poartă flowId (camelCase) pentru buildActionUrl din notif-widget.js', () => {
    expect(emitLine).toMatch(/\bflowId\b/);
  });
});
