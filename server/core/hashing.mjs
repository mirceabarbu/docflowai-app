/**
 * server/core/hashing.mjs — cryptographic hashing utilities.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

/**
 * SHA-256 hex digest of a string or Buffer.
 */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Hash a plaintext password with bcrypt (rounds=12).
 * @returns {Promise<string>}
 */
export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 * @returns {Promise<boolean>}
 */
export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
