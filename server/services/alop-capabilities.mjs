/**
 * alop-capabilities.mjs — sursa unică pentru "ce acțiuni se pot face" pe un ALOP,
 * oglindind EXACT logica de afișare din public/js/formular/alop.js → renderAlopDetail().
 *
 * ⚠️ Hint de AFIȘARE, NU autorizare. Mutațiile rămân păzite de rutele ALOP (org/comp/owner checks).
 * Funcție PURĂ (fără DB). Toate intrările sunt date server (nu există stare client gen hasPdf).
 */
export function computeAlopCapabilities(alop, actor) {
  const caps = {
    is_owner: false,
    is_completed: false,
    is_cancelled: false,
    df_action: null,        // 'completeaza'|'revizuieste_neaprobat'|'deschide'|'in_lucru_disabled'|'flow_waiting'
    phase_action: null,     // 'confirma_lichidare'|'completeaza_ord'|'genereaza_lanseaza_ord'|'marcheaza_ord_semnat'|'confirma_plata'
    can_revise_df: false,
    can_delete: false,
    can_start_noua_ordonantare: false,
    can_refresh: false,
  };
  if (!alop) return caps;

  const status = alop.status;
  caps.is_completed = status === 'completed';
  caps.is_cancelled = status === 'cancelled';
  caps.is_owner = String(alop.created_by) === String(actor?.userId)
    || actor?.role === 'admin' || actor?.role === 'org_admin';

  // În afara owner-gate (mirror exact: refresh + nouă ordonanțare nu sunt owner-gated)
  caps.can_refresh = !caps.is_completed && !caps.is_cancelled;
  caps.can_start_noua_ordonantare = caps.is_completed && parseFloat(alop.ramas || 0) > 0;

  if (caps.is_completed || caps.is_cancelled || !caps.is_owner) return caps;

  // DF action (7-way, primul match)
  const dfStatus = alop.df_status || '';
  if (alop.df_revizie_in_lucru) caps.df_action = 'in_lucru_disabled';
  else if (!alop.df_id) caps.df_action = 'completeaza';
  else if (dfStatus === 'neaprobat') caps.df_action = 'revizuieste_neaprobat';
  else if (status === 'angajare' && alop.df_flow_id) caps.df_action = 'flow_waiting';
  else if (['aprobat', 'transmis_flux', 'de_revizuit'].includes(dfStatus)) caps.df_action = 'deschide';
  else if (alop.df_id && !alop.df_flow_id) caps.df_action = 'deschide';
  else caps.df_action = 'completeaza';

  // Phase action (primul match) + can_revise_df
  if (status === 'lichidare' && !alop.lichidare_confirmed_at) {
    caps.phase_action = 'confirma_lichidare'; caps.can_revise_df = !!alop.df_id;
  } else if (status === 'ordonantare' && !alop.ord_id) {
    caps.phase_action = 'completeaza_ord'; caps.can_revise_df = !!alop.df_id;
  } else if (status === 'ordonantare' && alop.ord_id && !alop.ord_flow_id) {
    caps.phase_action = 'genereaza_lanseaza_ord'; caps.can_revise_df = !!alop.df_id;
  } else if (status === 'ordonantare' && alop.ord_flow_id && !alop.ord_completed_at) {
    caps.phase_action = 'marcheaza_ord_semnat';
  } else if (status === 'plata') {
    caps.phase_action = 'confirma_plata';
  }

  caps.can_delete = !alop.df_id && !alop.ord_id;
  return caps;
}
