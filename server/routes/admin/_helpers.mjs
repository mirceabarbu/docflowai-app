/**
 * DocFlowAI — Admin shared helpers
 * Extrase din admin.mjs pentru reutilizare în sub-module.
 */

import { isPlatformAdmin } from '../../services/authz-scope.mjs';

// Acceptă atât admin cât și org_admin
// org_admin vede/modifică doar propria organizație (orgId din JWT)
// admin vede totul (orgId=null sau orice)
export function isAdminOrOrgAdmin(actor) {
  return actor?.role === 'admin' || actor?.role === 'org_admin';
}

// Returnează orgId filtru pentru query (null = fără filtru/vede tot, number = scopat pe org)
// #105c: contract canonic — DOAR platform-admin (admin fără org_id) vede tot (null).
// Orice actor cu org_id (inclusiv un admin cu org_id) e scopat la propriul org.
// (Apelanții gatează upstream pe isAdminOrOrgAdmin; org_admin are mereu org_id.)
export function actorOrgFilter(actor) {
  if (isPlatformAdmin(actor)) return null;
  return actor?.orgId ?? null;
}

// Determină URL-ul aplicației din request (fallback la env var)
export function getAppUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host') || req.get('host') || 'app.docflowai.ro';
  return `${proto}://${host}`;
}
