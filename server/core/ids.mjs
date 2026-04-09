/**
 * server/core/ids.mjs — ID and token generation utilities.
 */

import { nanoid } from 'nanoid';
import crypto from 'crypto';

export function generateId() {
  return nanoid(21);
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
