/**
 * alop-capabilities.mjs — sursa unică pentru "ce acțiuni se pot face" pe un ALOP,
 * oglindind EXACT logica de afișare din public/js/formular/alop.js → renderAlopDetail().
 *
 * ⚠️ Hint de AFIȘARE, NU autorizare. Mutațiile rămân păzite de rutele ALOP (org/comp/owner checks).
 * Funcție PURĂ (fără DB). Toate intrările sunt date server (nu există stare client gen hasPdf).
 */
import { isCabDept } from './authz-formular.mjs';

export function computeAlopCapabilities(alop, actor, opts = {}) {
  const caps = {
    is_owner: false,
    is_cab: false,
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

  // ⛔ #134e — GARDA ANTI-REVIZII-PARALELE, NU O ȘTERGE.
  // Până la #134e, `df_aprobat` însemna „revizia POINTATĂ e aprobată": cât timp
  // pointerul `alop.df_id` stătea pe revizia în draft, ieșea `false` și ASTA ascundea
  // butonul „Revizuiește DF". Începând cu #134e, `df_aprobat` e o proprietate a
  // DOSARULUI (R0 aprobat ⇒ true pe viață), deci acea protecție implicită a DISPĂRUT.
  // Singurul lucru care mai împiedică deschiderea unei a doua revizii peste una în
  // lucru e `!alop.df_revizie_in_lucru` de mai jos — coloană care, tot la #134e, a
  // trecut de la un EXISTS pe parentaj (cod MORT din 2026-05-03, întotdeauna false)
  // la derivarea pe dosar din services/alop-dosar-sql.mjs. Test: V7 din
  // server/tests/db/alop-dosar-derivari.test.mjs (pică roșu fără această clauză).
  //
  // FIX 6: „Revizuiește DF" disponibil permanent în toate fazele post-angajare,
  // INCLUSIV pentru ALOP completat (ciclu închis). Owner-gated; fals la cancelled
  // și în angajare (acolo accesul la DF e prin df_action). Setat ÎNAINTE de return-ul
  // devreme ca să fie true și pentru ALOP completat (care iese la linia de mai jos).
  caps.can_revise_df = caps.is_owner && !caps.is_cancelled && !!alop.df_id
    && !['draft', 'angajare'].includes(status)
    && alop.df_aprobat === true          // doar dacă DOSARUL are o revizie APROBATĂ (#134e)
    && !alop.df_revizie_in_lucru;        // ⛔ GARDA ANTI-REVIZII-PARALELE — vezi mai sus

  // #130: membrul compartimentului CAB are DEJA drept de editare pe orice ALOP al organizației
  // (canEditAlop → role 'cab_dept', din #ALOP-CAB v3.9.690). `computeAlopCapabilities` nu aflase
  // niciodată, deci ieșea devreme pe `!is_owner` și `phase_action` rămânea null ⇒ butonul
  // „Confirmă Plata" nu se randa DELOC pentru CAB, în timp ce garda #126 B1 îl rezervă tocmai
  // lor. Rezultat: nimeni nu putea confirma plata, în afară de cineva simultan creator ȘI CAB.
  caps.is_cab = isCabDept(opts.actorComp, opts.cabComp);

  if (caps.is_completed || caps.is_cancelled || (!caps.is_owner && !caps.is_cab)) return caps;

  // FIX 4: DF action se calculează DOAR în faza de creare/aprobare a DF-ului ('draft' +
  // 'angajare'). Post-aprobare (lichidare/ordonantare/plata) butonul „Completează/Deschide DF"
  // NU mai apare în zona de acțiuni — accesul la DF rămâne prin „Revizuiește DF"
  // (can_revise_df) și prin tab-ul DF. ('draft' = ALOP nou fără df_id → 'completeaza'.)
  if (['draft', 'angajare'].includes(status)) {
    const dfStatus = alop.df_status || '';
    if (alop.df_revizie_in_lucru) caps.df_action = 'in_lucru_disabled';
    else if (!alop.df_id) caps.df_action = 'completeaza';
    else if (dfStatus === 'neaprobat') caps.df_action = 'revizuieste_neaprobat';
    else if (alop.df_flow_id) caps.df_action = 'flow_waiting';
    else if (['aprobat', 'transmis_flux', 'de_revizuit'].includes(dfStatus)) caps.df_action = 'deschide';
    else if (alop.df_id && !alop.df_flow_id) caps.df_action = 'deschide';
    else caps.df_action = 'completeaza';
  }

  // Phase action (primul match)
  if (status === 'lichidare' && !alop.lichidare_confirmed_at) {
    caps.phase_action = 'confirma_lichidare';
  } else if (status === 'ordonantare' && !alop.ord_id) {
    caps.phase_action = 'completeaza_ord';
  } else if (status === 'ordonantare' && alop.ord_id && !alop.ord_flow_id) {
    caps.phase_action = 'genereaza_lanseaza_ord';
  } else if (status === 'ordonantare' && alop.ord_flow_id && !alop.ord_completed_at) {
    caps.phase_action = 'marcheaza_ord_semnat';
  } else if (status === 'plata') {
    caps.phase_action = 'confirma_plata';
  }

  // canDestroyOnly (routes/alop.mjs /cancel) permite DOAR creator+admin, NU cab_dept —
  // owner-gatat explicit ca să nu apară un buton care eșuează la clic pentru membri CAB.
  caps.can_delete = caps.is_owner && !alop.df_id && !alop.ord_id;
  return caps;
}
