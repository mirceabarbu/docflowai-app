/**
 * formular-capabilities.mjs — sursa unică de adevăr pentru "ce acțiuni se pot face"
 * pe un DF/ORD, oglindind EXACT logica de afișare din public/js/formular/doc.js → renderActions().
 *
 * ⚠️ Acesta este un hint de AFIȘARE, NU autorizare. Mutațiile rămân păzite de
 *    authz-formular.mjs (canEditFormular/canDestroyOnly) pe rutele POST/PUT.
 *
 * Funcție PURĂ (fără DB, fără I/O) → ușor de testat și imposibil de divergat între liste/detaliu.
 * Singura intrare ne-derivabilă pe server (hasPdf — blob generat în client) NU e tratată aici;
 * frontend-ul decide split-ul Generează/Lansează pe baza lui can_generate_or_launch + hasPdf local.
 */

/** Rol identic cu doc.js: 'p1' (creator) | 'p2' (assigned) | 'view'. */
export function deriveDocRole(doc, actor) {
  const uid = actor?.userId;
  if (doc?.created_by === uid) return 'p1';
  if (doc?.assigned_to === uid) return 'p2';
  return 'view';
}

function emptyCaps() {
  return {
    can_send_p2: false,
    can_reset: false,
    can_save: false,
    can_complete_p2: false,
    can_return: false,
    can_generate_or_launch: false,
    can_revise: false,
    can_download_signed: false,
    can_download_flux: false,
    can_export_xml: false,
    // flags informaționale (pentru alegerea bannerelor în frontend — oglindesc doc.js)
    aprobat: false,
    is_neaprobat: false,
    is_de_revizuit: false,
    is_on_flow: false,
    is_waiting_p2: false,
    is_completed_p2: false,
    is_historic_revision: false,
    revizie_nr: 0,
    latest_revizie_nr: 0,
  };
}

/**
 * @param {object} doc  — rândul DF/ORD (status, created_by, assigned_to, aprobat, flow_id,
 *                        revizie_nr, has_newer_revision, latest_revizie_nr, ...)
 * @param {object} actor — { userId, role, orgId }
 * @param {'notafd'|'ordnt'} ft — tip formular (DF=notafd, ORD=ordnt)
 * @returns {object} capabilities
 */
export function computeDocCapabilities(doc, actor, ft) {
  const caps = emptyCaps();
  if (!doc) return caps;

  const status   = doc.status;
  const role     = deriveDocRole(doc, actor);
  const docId    = doc.id || null;
  const flowId   = doc.flow_id || null;
  const aprobat  = doc.aprobat === true || status === 'aprobat';
  const revNr    = doc.revizie_nr || 0;
  const latest   = doc.latest_revizie_nr || 0;
  const areNoua  = doc.has_newer_revision === true;
  const isNotafd = ft === 'notafd';
  // DF/ORD aflat pe un flux de semnare NON-terminal (nici completed, nici cancelled).
  // Server-driven: detaliul calculează `flow_active`. Blochează (re)generarea/relansarea
  // ca să nu apară un al doilea flux peste primul activ (cauza zombi df_flow_id).
  const onActiveFlow = doc.flow_active === true;

  caps.aprobat = aprobat;
  caps.revizie_nr = revNr;
  caps.latest_revizie_nr = latest;
  caps.is_on_flow = status === 'transmis_flux';
  caps.is_neaprobat = isNotafd && status === 'neaprobat';
  caps.is_de_revizuit = isNotafd && status === 'de_revizuit';

  // Export XML oficial NOTAFD/ORDNT (v3.9.591): permis când Secțiunea A+B sunt COMPLETE =
  // documentul a fost finalizat de P2 (status 'completed') ori e dincolo de asta ('transmis_flux'
  // sau aprobat). Util pentru verificare înainte de semnare ȘI după finalizare. NU pe draft/
  // pending_p2/returnat/neaprobat/de_revizuit (Secțiunea B incompletă). Set ÎNAINTE de
  // return-urile pe ramuri (toate întorc același obiect `caps`), deci e role-independent.
  // Hint de AFIȘARE — endpoint-ul /xml re-verifică gate-ul independent.
  caps.can_export_xml = aprobat || status === 'completed' || status === 'transmis_flux';

  // Ordinea de scurtcircuit identică cu renderActions (primul match câștigă):
  if (isNotafd && status === 'neaprobat') {
    if (areNoua) { caps.is_historic_revision = true; }
    else { caps.can_revise = true; }
    return caps;
  }
  if (isNotafd && status === 'de_revizuit') {
    caps.can_send_p2 = true;
    caps.can_reset = true;
    return caps;
  }
  if (aprobat) {
    caps.can_download_signed = !!flowId;
    caps.can_revise = isNotafd && !areNoua;
    caps.is_historic_revision = isNotafd && areNoua;
    return caps;
  }
  if (!docId) {
    caps.can_send_p2 = true;
    caps.can_reset = true;
    return caps;
  }
  if (status === 'draft' && role === 'p1') {
    caps.can_send_p2 = true;
    caps.can_reset = true;
    return caps;
  }
  if (status === 'returnat' && role === 'p1') {
    caps.can_send_p2 = true;
    return caps;
  }
  if (status === 'pending_p2' && role === 'p2') {
    caps.can_save = true;
    caps.can_complete_p2 = true;
    caps.can_return = true;
    return caps;
  }
  if (status === 'pending_p2' && role === 'p1') {
    caps.is_waiting_p2 = true;
    return caps;
  }
  if (status === 'completed' && role === 'p1') {
    // Dacă DF-ul are deja un flux activ agățat (status n-a fost încă mutat la
    // transmis_flux dar flow_id non-terminal e setat), ascunde butonul.
    caps.can_generate_or_launch = !onActiveFlow;
    if (onActiveFlow) caps.is_on_flow = true;
    return caps;
  }
  if (status === 'transmis_flux') {
    caps.is_on_flow = true;
    caps.can_download_flux = !!flowId;
    return caps;
  }
  if (status === 'completed' && role === 'p2') {
    caps.is_completed_p2 = true;
    return caps;
  }
  // fallback (identic cu else-ul din renderActions)
  caps.can_send_p2 = true;
  caps.can_reset = true;
  return caps;
}
