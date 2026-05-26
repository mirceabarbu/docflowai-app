// ─────────────────────────────────────────────────────────────────────────────
// authz-formular.mjs — autorizare DF/ORD/ALOP centralizată
//
// Roluri returnate:
//   'admin'      → admin / org_admin
//   'creator'    → autorul documentului
//   'assigned'   → P2 efectiv (assigned_to)
//   'comp'       → P1-comp (membru comp inițiator). Nume istoric, back-compat.
//   'p2_comp'    → P2-comp (membru comp Responsabil CAB). NOU.
//   'flow_viewer'→ semnatar în fluxul de semnare (view-only pe DF/ORD)
//
// canDestroyOnly  → creator + admin
// canEditFormular → admin + creator + (assigned dacă assignedCounts) + comp + p2_comp
// canViewFormular → canEditFormular ∪ flow_viewer
// canEditAlop     → admin + creator + comp + p2_comp (NU semnatari flux)
// ─────────────────────────────────────────────────────────────────────────────

export async function loadActorComp(pool, userId) {
  const { rows } = await pool.query('SELECT compartiment FROM users WHERE id=$1', [userId]);
  return (rows[0]?.compartiment || '').trim();
}

async function _userIsInComp(pool, targetUserId, targetComp) {
  if (!targetComp || !targetUserId) return false;
  const { rows } = await pool.query(
    "SELECT 1 FROM users WHERE id=$1 AND TRIM(compartiment) = $2 AND TRIM(compartiment) <> ''",
    [targetUserId, targetComp]
  );
  return rows.length > 0;
}

async function _isInFlowSigners(pool, flowId, userId) {
  if (!flowId || !userId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM flows
       WHERE id = $1
         AND data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $2::text))`,
    [flowId, userId]
  );
  return rows.length > 0;
}

export async function canEditFormular(pool, actor, doc, actorComp, opts = {}) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (doc.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  if (opts.assignedCounts !== false && doc.assigned_to === actor.userId)
    return { allowed: true, role: 'assigned' };
  if (actorComp) {
    if (await _userIsInComp(pool, doc.created_by, actorComp))
      return { allowed: true, role: 'comp' };  // P1-comp (back-compat)
    if (doc.assigned_to && await _userIsInComp(pool, doc.assigned_to, actorComp))
      return { allowed: true, role: 'p2_comp' };
  }
  return { allowed: false, reason: 'forbidden' };
}

export async function canViewFormular(pool, actor, doc, actorComp) {
  const edit = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true });
  if (edit.allowed) return { allowed: true, role: edit.role, mode: 'edit' };
  if (doc.flow_id && await _isInFlowSigners(pool, doc.flow_id, actor.userId))
    return { allowed: true, role: 'flow_viewer', mode: 'view_only' };
  return { allowed: false, reason: 'forbidden' };
}

export async function getAlopP2UserIds(pool, alop) {
  const ids = new Set();
  for (const arr of [alop.df_semnatari, alop.ord_semnatari]) {
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s?.role === 'responsabil_cab' && s?.user_id != null) {
          ids.add(String(s.user_id));
        }
      }
    }
  }
  if (alop.df_id || alop.ord_id) {
    try {
      const { rows } = await pool.query(`
        SELECT assigned_to FROM formulare_df  WHERE id=$1 AND assigned_to IS NOT NULL
        UNION
        SELECT assigned_to FROM formulare_ord WHERE id=$2 AND assigned_to IS NOT NULL
      `, [alop.df_id || null, alop.ord_id || null]);
      for (const r of rows) if (r.assigned_to != null) ids.add(String(r.assigned_to));
    } catch (_) { /* tabele opționale */ }
  }
  return Array.from(ids);
}

export async function isInAlopP2Comp(pool, alop, actorComp) {
  if (!actorComp) return false;
  const p2Ids = await getAlopP2UserIds(pool, alop);
  const numericIds = p2Ids.map(Number).filter(Number.isFinite);
  if (numericIds.length === 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM users
       WHERE id = ANY($1::int[])
         AND TRIM(compartiment) = $2
         AND TRIM(compartiment) <> ''
       LIMIT 1`,
    [numericIds, actorComp]
  );
  return rows.length > 0;
}

export async function canEditAlop(pool, actor, alop, actorComp) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (alop.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  if (actorComp) {
    const alopComp = (alop.compartiment || '').trim();
    if (alopComp && alopComp === actorComp)
      return { allowed: true, role: 'comp' };
    if (await _userIsInComp(pool, alop.created_by, actorComp))
      return { allowed: true, role: 'comp' };
    if (await isInAlopP2Comp(pool, alop, actorComp))
      return { allowed: true, role: 'p2_comp' };
  }
  return { allowed: false, reason: 'forbidden' };
}

export function canDestroyOnly(actor, doc) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (doc.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  return { allowed: false, reason: 'forbidden_destroy_creator_only' };
}
