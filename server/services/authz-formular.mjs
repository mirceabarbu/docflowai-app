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
//   'cab_dept'   → membru al compartimentului CAB al ORGANIZAȚIEI (org.cab_compartiment). NOU.
//                  Vede+editează tot ALOP/DF/ORD din org (opts.cabComp, încărcat o dată/handler).
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

// FEAT ALOP-CAB: compartimentul CAB al ORGANIZAȚIEI (organizations.cab_compartiment) e organul
// de supraveghere financiară — vede și editează tot ALOP/DF/ORD din org, ca un org_admin limitat.
// Se leagă de CAB-ul organizației, spre deosebire de `p2_comp` care e CAB-ul unui document anume.
// ⚠️ Se încarcă O DATĂ per handler (nu în fiecare apel de authz) și se pasează prin opts —
// listele cheamă canEdit* de zeci de ori/pagină, un SELECT în fiecare ar fi redundant.
export async function loadOrgCabComp(pool, orgId) {
  if (!orgId) return '';
  const { rows } = await pool.query(
    'SELECT cab_compartiment FROM organizations WHERE id=$1', [orgId]
  );
  return (rows[0]?.cab_compartiment || '').trim();
}

// Pur, testabil. actorComp și cabComp sunt AMBELE deja trimmed. Case-sensitive azi (datorie
// `compartiment` din audit — NU se repară aici). Fail-safe: cabComp gol ⇒ false.
export function isCabDept(actorComp, cabComp) {
  return !!cabComp && !!actorComp && actorComp === cabComp;
}

// FEAT ALOP-CAB: încarcă ÎNTR-UN SINGUR query compartimentul actorului ȘI cab_compartiment-ul
// org-ului. O singură rundă la DB (nu două) — contorul de query-uri per handler rămâne cel de
// dinainte (`loadActorComp`), deci testele mock poziționale nu se decalează. Cheia `compartiment`
// din rând e păstrată identică cu `loadActorComp` (back-compat cu fixture-urile de test).
export async function loadActorCompAndCab(pool, userId, orgId) {
  const { rows } = await pool.query(
    `SELECT u.compartiment AS compartiment,
            (SELECT o.cab_compartiment FROM organizations o WHERE o.id=$2) AS cab_compartiment
       FROM users u WHERE u.id=$1`,
    [userId, orgId]
  );
  return {
    actorComp: (rows[0]?.compartiment || '').trim(),
    cabComp:   (rows[0]?.cab_compartiment || '').trim(),
  };
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
  // FEAT ALOP-CAB: membrul compartimentului CAB al org-ului editează tot (verificat DUPĂ rolurile
  // existente, înainte de refuz). Documentul e deja încărcat org-scoped în handler; cabComp vine din
  // actor.orgId, deci un doc din alt org n-ar ajunge aici.
  if (opts.cabComp && isCabDept(actorComp, opts.cabComp))
    return { allowed: true, role: 'cab_dept' };
  return { allowed: false, reason: 'forbidden' };
}

export async function canViewFormular(pool, actor, doc, actorComp, opts = {}) {
  const edit = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true, cabComp: opts.cabComp });
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

export async function canEditAlop(pool, actor, alop, actorComp, opts = {}) {
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
  // FEAT ALOP-CAB: membrul CAB al org-ului editează tot ALOP-ul org-ului (ALOP încărcat org-scoped).
  if (opts.cabComp && isCabDept(actorComp, opts.cabComp))
    return { allowed: true, role: 'cab_dept' };
  return { allowed: false, reason: 'forbidden' };
}

export function canDestroyOnly(actor, doc) {
  if (['admin','org_admin'].includes(actor.role))
    return { allowed: true, role: 'admin' };
  if (doc.created_by === actor.userId)
    return { allowed: true, role: 'creator' };
  return { allowed: false, reason: 'forbidden_destroy_creator_only' };
}
