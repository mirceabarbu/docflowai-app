// server/tests/unit/env-hardening.test.mjs
// SEC (incident 13.07.2026) — teste de regresie pentru înăsprirea NODE_ENV:
//  1. rutele de recovery (/auth/debug, /auth/fix-admin*) au fost ȘTERSE fizic din sursă;
//  2. validateNodeEnv respinge orice NODE_ENV invalid;
//  3. isProd e fail-secure (staging ⇒ isProd === true).
//
// ⛔ Testul IMPORTĂ din producție — nu redeclară logica locală.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateNodeEnv, VALID_NODE_ENVS } from '../../config.mjs';

describe('SEC: rutele de recovery șterse din sursă', () => {
  // Test de caracterizare pe sursă — legitim aici, pentru că afirmația ESTE despre sursă.
  const src = readFileSync(new URL('../../routes/auth.mjs', import.meta.url), 'utf8');

  it('nu mai conține /auth/debug', () => {
    expect(src).not.toContain('/auth/debug');
  });
  it('nu mai conține /auth/fix-admin', () => {
    expect(src).not.toContain('/auth/fix-admin');
  });
  it('nu mai conține /auth/fix-admin-role', () => {
    expect(src).not.toContain('/auth/fix-admin-role');
  });
});

describe('SEC: validateNodeEnv (fail-fast la boot)', () => {
  it('acceptă cele patru valori valide și le întoarce normalizate', () => {
    for (const v of VALID_NODE_ENVS) {
      expect(validateNodeEnv(v).nodeEnv).toBe(v);
    }
  });

  it('respinge NODE_ENV lipsă (undefined)', () => {
    expect(() => validateNodeEnv(undefined)).toThrow();
  });

  it('respinge NODE_ENV gol', () => {
    expect(() => validateNodeEnv('')).toThrow();
  });

  it('respinge o valoare cu majusculă greșită (Production)', () => {
    expect(() => validateNodeEnv('Production')).toThrow();
  });

  it('respinge un typo', () => {
    expect(() => validateNodeEnv('prod')).toThrow();
  });
});

describe('SEC: isProd fail-secure', () => {
  it('staging ⇒ isProd === true (comportament de securitate ca producția)', () => {
    expect(validateNodeEnv('staging').isProd).toBe(true);
  });
  it('production ⇒ isProd === true', () => {
    expect(validateNodeEnv('production').isProd).toBe(true);
  });
  it('development ⇒ isProd === false', () => {
    expect(validateNodeEnv('development').isProd).toBe(false);
    expect(validateNodeEnv('development').isDev).toBe(true);
  });
  it('test ⇒ isProd === false', () => {
    expect(validateNodeEnv('test').isProd).toBe(false);
  });
});
