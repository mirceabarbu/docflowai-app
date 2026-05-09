/**
 * DocFlowAI — Unit tests: redactUrl() helper
 *
 * Acoperire:
 *   ✓ URL fără query string — returnat intact
 *   ✓ ?token=... — redactat
 *   ✓ URL compus — chei sensibile redactate, cele non-sensibile păstrate
 *   ✓ multiple chei sensibile (code, state, session)
 *   ✓ case-insensitive pe numele cheii (Token, SECRET)
 *   ✓ signer_token și pending_token
 *   ✓ fragment (#...) păstrat intact
 *   ✓ null/undefined/'' — handle graceful
 *   ✓ pair fără = (flag param) — nu se rupe
 *   ✓ chei non-sensitive (flow, page, sort) — NU redactate
 */

import { describe, it, expect } from 'vitest';
import { redactUrl } from '../../middleware/logger.mjs';

describe('redactUrl()', () => {
  it('păstrează URL fără query string intact', () => {
    expect(redactUrl('/api/flows/abc')).toBe('/api/flows/abc');
  });

  it('redactează ?token=...', () => {
    expect(redactUrl('/sign?token=secret-xyz-123')).toBe('/sign?token=[REDACTED]');
  });

  it('redactează în URL-uri compuse, păstrează ce nu e sensibil', () => {
    expect(redactUrl('/sign?flow=FLOW-1&token=secret-xyz&page=2'))
      .toBe('/sign?flow=FLOW-1&token=[REDACTED]&page=2');
  });

  it('redactează multiple chei sensibile', () => {
    const out = redactUrl('/cb?code=AAA&state=BBB&session=CCC');
    expect(out).toContain('code=[REDACTED]');
    expect(out).toContain('state=[REDACTED]');
    expect(out).toContain('session=[REDACTED]');
  });

  it('case-insensitive pe nume cheie', () => {
    expect(redactUrl('/x?Token=ABC&SECRET=XYZ'))
      .toBe('/x?Token=[REDACTED]&SECRET=[REDACTED]');
  });

  it('redactează signer_token și pending_token', () => {
    const out = redactUrl('/x?signer_token=A&pending_token=B&visible=C');
    expect(out).toContain('signer_token=[REDACTED]');
    expect(out).toContain('pending_token=[REDACTED]');
    expect(out).toContain('visible=C');
  });

  it('păstrează fragmentul (#...)', () => {
    expect(redactUrl('/x?token=AAA#section'))
      .toBe('/x?token=[REDACTED]#section');
  });

  it('handle gracefully null/undefined/empty', () => {
    expect(redactUrl(null)).toBe(null);
    expect(redactUrl(undefined)).toBe(undefined);
    expect(redactUrl('')).toBe('');
  });

  it('NU rupe URL cu pair fără =', () => {
    expect(redactUrl('/x?abc&token=YYY&def'))
      .toBe('/x?abc&token=[REDACTED]&def');
  });

  it('NU redactează keys non-sensitive (flow, page, sort)', () => {
    const out = redactUrl('/x?flow=F1&page=2&sort=name');
    expect(out).toBe('/x?flow=F1&page=2&sort=name');
  });
});
