/**
 * DocFlowAI — Unit tests: funcții crypto auth
 *
 * Testează hashPassword + verifyPassword fără nicio dependență externă.
 * Aceste funcții sunt pure (no side-effects, no DB) — rulează instant.
 *
 * Acoperire:
 *   ✓ hashPassword — format corect, unicitate salt, lungime
 *   ✓ verifyPassword — hash v2 (600k), hash v1 legacy (100k), parolă greșită
 *   ✓ round-trip — hash → verify consistent pe multiple parole
 *   ✓ edge cases — null, undefined, string gol
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { hashPassword, verifyPassword } from '../../middleware/auth.mjs';

// ── hashPassword ──────────────────────────────────────────────────────────────

describe('hashPassword', () => {
  it('generează hash cu prefix v2', () => {
    const hash = hashPassword('testPassword123');
    expect(hash.startsWith('v2:')).toBe(true);
  });

  it('hash conține exact 3 segmente (v2:salt:hash)', () => {
    const hash = hashPassword('altaParola');
    const parts = hash.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toHaveLength(32);   // 16 bytes hex
    expect(parts[2]).toHaveLength(128);  // 64 bytes hex
  });

  it('produce hash-uri diferite pentru aceeași parolă (salt aleatoriu)', () => {
    const h1 = hashPassword('aceeasi_parola');
    const h2 = hashPassword('aceeasi_parola');
    expect(h1).not.toBe(h2);
    // Dar ambele trebuie să verifice corect — verifyPassword importat top-level
    expect(verifyPassword('aceeasi_parola', h1).ok).toBe(true);
    expect(verifyPassword('aceeasi_parola', h2).ok).toBe(true);
  });

  it('funcționează cu parola de lungime maximă (200 chars)', () => {
    const longPwd = 'a'.repeat(200);
    const hash = hashPassword(longPwd);
    expect(hash.startsWith('v2:')).toBe(true);
  });

  it('funcționează cu parole cu diacritice / caractere speciale', () => {
    const special = 'Parolă!@# ș ț â î Ș Ț';
    const hash = hashPassword(special);
    expect(hash.startsWith('v2:')).toBe(true);
    expect(verifyPassword(special, hash).ok).toBe(true);
  });
});

// ── verifyPassword ────────────────────────────────────────────────────────────

describe('verifyPassword', () => {
  it('verifică corect o parolă cu hash v2 (PBKDF2 600k)', () => {
    const pwd  = 'ParolaTest@2025';
    const hash = hashPassword(pwd);

    const result = verifyPassword(pwd, hash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);  // v2 nu necesită re-hash
  });

  it('returnează ok:false pentru parolă greșită pe hash v2', () => {
    const hash   = hashPassword('parolaCorecta');
    const result = verifyPassword('parolaGresita', hash);

    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it('detectează hash v1 (legacy 100k) și marchează needsRehash=true', () => {
    // Construim manual un hash v1 — format: "salt:hash" (fără prefix v2:)
    const salt  = crypto.randomBytes(16).toString('hex');
    const hVal  = crypto.pbkdf2Sync('parola_v1_test', salt, 100_000, 64, 'sha256').toString('hex');
    const v1Hash = `${salt}:${hVal}`;

    const result = verifyPassword('parola_v1_test', v1Hash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);   // trebuie migrat la v2
  });

  it('respinge parolă greșită pe hash v1', () => {
    const salt  = crypto.randomBytes(16).toString('hex');
    const hVal  = crypto.pbkdf2Sync('parola_corecta', salt, 100_000, 64, 'sha256').toString('hex');
    const v1Hash = `${salt}:${hVal}`;

    const result = verifyPassword('parola_gresita', v1Hash);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it('returnează ok:false pentru stored null/undefined/string gol', () => {
    expect(verifyPassword('orice', null).ok).toBe(false);
    expect(verifyPassword('orice', undefined).ok).toBe(false);
    expect(verifyPassword('orice', '').ok).toBe(false);
  });

  it('returnează ok:false pentru hash malformat (fără separator :)', () => {
    const result = verifyPassword('test', 'hashfaraseparator');
    expect(result.ok).toBe(false);
  });

  it('round-trip hash → verify consistent pe multiple parole', () => {
    const passwords = [
      'abc123',
      'P@rola!Complicată2025',
      'a'.repeat(200),
      '     spaces     ',
      '12345',
    ];
    for (const pwd of passwords) {
      const hash = hashPassword(pwd);
      expect(verifyPassword(pwd, hash).ok, `Parola: "${pwd.slice(0, 20)}"`).toBe(true);
      expect(verifyPassword('altceva_gresit', hash).ok, `Fals pozitiv pentru: "${pwd.slice(0, 20)}"`).toBe(false);
    }
  });
});
