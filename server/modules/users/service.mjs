/**
 * server/modules/users/service.mjs — User business logic (v4)
 * Wraps repository with validation.
 */

import { ConflictError, ValidationError } from '../../core/errors.mjs';
import * as repo from './repository.mjs';

const VALID_ROLES = new Set(['user', 'admin', 'superadmin']);

export async function createUser(params) {
  const { org_id, email } = params;

  if (!email || !email.includes('@')) {
    throw new ValidationError('Email invalid', { email: 'Email invalid' });
  }
  if (params.role && !VALID_ROLES.has(params.role)) {
    throw new ValidationError('Rol invalid', { role: `Rol valid: ${[...VALID_ROLES].join(', ')}` });
  }

  // Uniqueness check within org
  const existing = await repo.getUserByEmail(email);
  if (existing && existing.org_id === org_id) {
    throw new ConflictError(`Utilizatorul ${email} există deja în organizație`);
  }

  return repo.createUser(params);
}

export async function getUserById(id, requestingUser) {
  const user = await repo.getUserById(id);
  if (!user) return null;

  // Org isolation: only same-org or superadmin can see user
  if (requestingUser.role !== 'admin' && requestingUser.role !== 'superadmin') {
    if (user.org_id !== requestingUser.org_id) return null;
  }
  return user;
}

export async function updateUser(id, updates, requestingUser) {
  if (updates.role && !VALID_ROLES.has(updates.role)) {
    throw new ValidationError('Rol invalid', { role: `Rol valid: ${[...VALID_ROLES].join(', ')}` });
  }
  // Only superadmin can assign superadmin role
  if (updates.role === 'superadmin' && requestingUser.role !== 'superadmin') {
    throw new ConflictError('Nu ai permisiunea să setezi rolul superadmin');
  }
  return repo.updateUser(id, updates);
}

export async function listUsers(org_id, opts) {
  return repo.listUsers(org_id, opts);
}

export async function softDeleteUser(id) {
  return repo.softDeleteUser(id);
}

export async function bulkImportCsv(org_id, csvText) {
  return repo.bulkImportCsv(org_id, csvText);
}
