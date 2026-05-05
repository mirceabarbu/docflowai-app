// ─────────────────────────────────────────────────────────────────────────────
// authz-formular.mjs — helper centralizat pentru autorizare DF/ORD/ALOP
//
// Reguli (FEATURE 3.A + 3.B):
//   1. admin / org_admin → întotdeauna access
//   2. compartiment match strict (case-sensitive, după trim)
//   3. compartiment '' = doar creator/assigned (fără grup virtual)
//   4. ALOP = uniunea (alop.compartiment text + users.compartiment al creatorului)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Încarcă compartiment-ul actor-ului din DB.
 * @returns string trimmed (poate fi '')
 */
export async function loadActorComp(pool, userId) {
  const { rows } = await pool.query('SELECT compartiment FROM users WHERE id=$1', [userId]);
  return (rows[0]?.compartiment || '').trim();
}

/**
 * Verifică dacă userul cu id=createdBy are compartimentul targetComp.
 */
async function _creatorIsInComp(pool, createdBy, targetComp) {
  if (!targetComp || !createdBy) return false;
  const { rows } = await pool.query(
    "SELECT 1 FROM users WHERE id=$1 AND TRIM(compartiment) = $2 AND TRIM(compartiment) <> ''",
    [createdBy, targetComp]
  );
  return rows.length > 0;
}

/**
 * Verifică acces editare pe DF/ORD.
 * @param {Object} doc - rândul DB (formulare_df sau formulare_ord)
 * @param {string} actorComp - compartiment actor (trimmed)
 * @param {Object} opts
 * @param {boolean} opts.assignedCounts - true dacă assigned_to=actor dă acces (PUT, complete, returneaza)
 * @returns {Promise<{allowed: boolean, reason?: string, role?: 'creator'|'assigned'|'comp'|'admin'}>}
 */
export async function canEditFormular(pool, actor, doc, actorComp, opts = {}) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (doc.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  if (opts.assignedCounts !== false && doc.assigned_to === actor.userId)
    return { allowed: true, role: 'assigned' };
  if (actorComp && await _creatorIsInComp(pool, doc.created_by, actorComp))
    return { allowed: true, role: 'comp' };
  return { allowed: false, reason: 'forbidden' };
}

/**
 * Verifică acces editare pe ALOP.
 * @param {Object} alop - rândul alop_instances
 * @param {string} actorComp - compartiment actor (trimmed)
 */
export async function canEditAlop(pool, actor, alop, actorComp) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (alop.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  if (actorComp) {
    const alopComp = (alop.compartiment || '').trim();
    if (alopComp && alopComp === actorComp)
      return { allowed: true, role: 'comp' };
    if (await _creatorIsInComp(pool, alop.created_by, actorComp))
      return { allowed: true, role: 'comp' };
  }
  return { allowed: false, reason: 'forbidden' };
}

/**
 * Verificare STRICTĂ pentru acțiuni distructive (anulare, delete).
 * Doar creator + admin/org_admin. NU compartiment, NU assigned.
 */
export function canDestroyOnly(actor, doc) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (doc.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  return { allowed: false, reason: 'forbidden_destroy_creator_only' };
}
