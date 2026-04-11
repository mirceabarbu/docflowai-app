/**
 * server/core/tenant.mjs — multi-tenancy helpers.
 */

import { ForbiddenError } from './errors.mjs';

/**
 * Extract org_id from the authenticated request (set by JWT middleware).
 * @returns {number}
 */
export function getOrgId(req) {
  return req.user.org_id;
}

/**
 * Throw ForbiddenError if the request's org differs from the given orgId.
 * Super-admins bypass the check.
 */
export function assertSameOrg(req, orgId) {
  if (isSuperAdmin(req)) return;
  if (req.user.org_id !== Number(orgId)) {
    throw new ForbiddenError('Access to another organization is not allowed');
  }
}

/**
 * Returns true if the authenticated user is a super-admin (role === 'admin').
 */
export function isSuperAdmin(req) {
  return req.user?.role === 'admin';
}
