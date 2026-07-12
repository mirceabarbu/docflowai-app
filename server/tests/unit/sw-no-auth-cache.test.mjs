import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(__dirname, '../../../public/sw.js');
const SW = readFileSync(SW_PATH, 'utf8');

describe('SEC-P0.1 — service worker network-only pe rute autentificate', () => {
  it('CACHE_VERSION este docflowai-v285', () => {
    expect(SW).toContain("const CACHE_VERSION = 'docflowai-v285';");
  });

  it('nu mai există funcția networkFirst( (înlocuită cu networkOnly)', () => {
    expect(SW).not.toContain('networkFirst(');
  });

  it('AUTHENTICATED_PREFIXES conține toate cele 4 prefixe', () => {
    for (const p of ['/api/', '/auth/', '/flows/', '/admin/']) {
      expect(SW).toContain(`'${p}'`);
    }
    // prezente într-un array dedicat
    expect(SW).toMatch(/AUTHENTICATED_PREFIXES\s*=\s*\[/);
  });

  it('handler-ul fetch rutează prin isAuthenticatedRoute + networkOnly', () => {
    expect(SW).toMatch(/if\s*\(\s*isAuthenticatedRoute\(url\.pathname\)\s*\)/);
    expect(SW).toContain('e.respondWith(networkOnly(e.request))');
  });

  it('corpul networkOnly NU atinge Cache Storage (fără caches.match / cache.put)', () => {
    const start = SW.indexOf('async function networkOnly');
    expect(start).toBeGreaterThan(-1);
    // corpul se termină la primul `\n}` la nivel zero după declarație
    const end = SW.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    const body = SW.slice(start, end);
    expect(body).not.toContain('caches.match');
    expect(body).not.toContain('cache.put');
  });
});
