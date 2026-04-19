/**
 * DocFlowAI — Admin shared helpers
 * Extrase din admin.mjs pentru reutilizare în sub-module.
 */

// Acceptă atât admin cât și org_admin
// org_admin vede/modifică doar propria organizație (orgId din JWT)
// admin vede totul (orgId=null sau orice)
export function isAdminOrOrgAdmin(actor) {
  return actor?.role === 'admin' || actor?.role === 'org_admin';
}

// Returnează orgId filtru pentru query (null = toate, number = filtrat)
export function actorOrgFilter(actor) {
  if (actor?.role === 'org_admin') return actor.orgId || null;
  return null; // admin = fără filtru
}

// Determină URL-ul aplicației din request (fallback la env var)
export function getAppUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host') || req.get('host') || 'app.docflowai.ro';
  return `${proto}://${host}`;
}
