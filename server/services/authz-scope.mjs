/**
 * DocFlowAI — Contract unic de scope pe organizație (authz-scope)
 * ---------------------------------------------------------------
 * Sursa canonică pentru distincția platform-admin vs. org-scoped.
 *
 * Contract (decis 22.07.2026):
 *   - platform-admin = role==='admin' ȘI fără org_id (contul de platformă,
 *     bootstrap admin@docflowai.ro). Vede/acționează cross-org.
 *   - orice actor CU org_id (inclusiv un eventual role==='admin' cu org_id)
 *     e org-scoped la propriul org_id. Fail-CLOSED: un actor non-platform
 *     fără org_id filtrează pe `= NULL` (0 rânduri), niciodată „fără filtru".
 *
 * NOTĂ (#105a): modulul e INTRODUS fără a fi cablat nicăieri. Cablarea
 * efectivă (listări, guard-uri, lockout) vine în #105b–#105e.
 * `authz-formular.mjs` (logică per-compartiment) rămâne separat și neatins.
 */

/**
 * Platform-admin = admin de platformă, fără org_id. Singurul care vede tot cross-org.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @returns {boolean}
 */
export function isPlatformAdmin(actor) {
  return actor?.role === 'admin' && !actor?.orgId;
}

/**
 * admin SAU org_admin (poartă generală de rol; scoping-ul se face separat).
 * Oglindește `admin/_helpers.mjs:isAdminOrOrgAdmin` — în #105c devine sursa unică.
 * @param {{role?:string}} actor
 * @returns {boolean}
 */
export function isAdminOrOrgAdmin(actor) {
  return actor?.role === 'admin' || actor?.role === 'org_admin';
}

/**
 * Fragment SQL de scope pe org pentru un query.
 *  - platform-admin ⇒ '' (fără filtru, vede tot)
 *  - altfel ⇒ împinge org_id pe `params` și întoarce ` AND <alias>.org_id = $N`.
 *    Un actor non-platform fără org_id împinge `null` ⇒ ` = NULL` ⇒ 0 rânduri
 *    (fail-closed), NICIODATĂ fără filtru.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @param {string} alias  aliasul tabelei în query (ex. 'a', 'fd', 'f')
 * @param {Array<any>} params  array-ul de parametri al query-ului (mutat prin push)
 * @returns {string}
 */
export function orgScopeSql(actor, alias, params) {
  if (isPlatformAdmin(actor)) return '';
  params.push(actor?.orgId ?? null);
  return ` AND ${alias}.org_id = $${params.length}`;
}

/**
 * Poartă pe obiect deja încărcat (nu SQL): platform-admin SAU același org.
 * Fail-closed: dacă oricare org_id lipsește (și nu e platform-admin) ⇒ false.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @param {number|string|null|undefined} targetOrgId
 * @returns {boolean}
 */
export function actorCanAccessOrg(actor, targetOrgId) {
  if (isPlatformAdmin(actor)) return true;
  return actor?.orgId != null && targetOrgId != null
    && String(actor.orgId) === String(targetOrgId);
}
