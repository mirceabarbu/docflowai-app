/**
 * v3.9.502 (A-4 P1) — guard că change-password are csrfMiddleware
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('auth /change-password CSRF', () => {
  it('ruta POST /auth/change-password include csrfMiddleware', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/auth.mjs'), 'utf8');
    expect(src).toMatch(/router\.post\(\s*['"]\/auth\/change-password['"]\s*,\s*csrfMiddleware\s*,/);
  });

  it('comentariul v3.9.502 A-4 e prezent', () => {
    const src = readFileSync(path.join(REPO, 'server/routes/auth.mjs'), 'utf8');
    expect(src).toMatch(/v3\.9\.502 \(A-4 P1\)/);
  });
});
