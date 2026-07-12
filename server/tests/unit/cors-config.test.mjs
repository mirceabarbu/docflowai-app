import { describe, it, expect } from 'vitest';
import { resolveAppOrigins, envLeaksLandingOrigin, LANDING_ORIGINS, LANDING_ROUTE }
  from '../../utils/cors-config.mjs';

describe('SEC-P0.4 — resolveAppOrigins', () => {
  it('CORS_ORIGIN are prioritate și se despică pe virgulă', () => {
    expect(resolveAppOrigins({ CORS_ORIGIN: 'https://app.docflowai.ro, https://x.ro' }))
      .toEqual(['https://app.docflowai.ro', 'https://x.ro']);
  });

  it('fallback la PUBLIC_BASE_URL, normalizat (fără slash final)', () => {
    expect(resolveAppOrigins({ PUBLIC_BASE_URL: 'https://app.docflowai.ro/' }))
      .toEqual(['https://app.docflowai.ro']);
  });

  it('fără configurație ⇒ false (CORS blocat), NU true', () => {
    expect(resolveAppOrigins({})).toBe(false);
    expect(resolveAppOrigins({ CORS_ORIGIN: '   ' })).toBe(false);
  });

  // ⭐ TESTUL CRITIC — v1 al fix-ului pica exact aici.
  it('elimină ACTIV originile landing-ului chiar dacă apar în CORS_ORIGIN', () => {
    expect(resolveAppOrigins({
      CORS_ORIGIN: 'https://app.docflowai.ro,https://docflowai.ro,https://www.docflowai.ro',
    })).toEqual(['https://app.docflowai.ro']);
  });

  it('elimină landing-ul și când vine cu slash final sau din PUBLIC_BASE_URL', () => {
    expect(resolveAppOrigins({ CORS_ORIGIN: 'https://docflowai.ro/' })).toBe(false);
    expect(resolveAppOrigins({ PUBLIC_BASE_URL: 'https://www.docflowai.ro' })).toBe(false);
  });

  it('envLeaksLandingOrigin semnalează configurația greșită din Railway', () => {
    expect(envLeaksLandingOrigin({ CORS_ORIGIN: 'https://app.docflowai.ro' })).toBe(false);
    expect(envLeaksLandingOrigin({ CORS_ORIGIN: 'https://app.docflowai.ro,https://docflowai.ro' })).toBe(true);
  });

  it('landing-ul are acces la exact o rută', () => {
    expect(LANDING_ROUTE).toBe('/api/contact');
    expect(LANDING_ORIGINS).toHaveLength(2);
  });
});
