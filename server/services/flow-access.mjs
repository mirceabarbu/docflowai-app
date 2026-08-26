// ─────────────────────────────────────────────────────────────────────────────
// flow-access.mjs — Poartă de acces la nivel de obiect pentru fluxuri
//
//   canActorReadFlow(actor, data, signerToken) → PUR: init | semnatar | admin
//                                                 same-org | signer token
//   isFlowAccessAllowed(pool, actor, data, signerToken) → canActorReadFlow ∪
//                                                 destinatar repartizat ∪
//                                                 vizualizator al DF/ORD legat (async)
//
// Folosit de GET /flows/:flowId (metadata) ȘI de endpointurile de conținut
// (signed-pdf / pdf / attachments) — aceeași poartă peste tot, ca să nu mai
// existe IDOR pe documentele financiare de flux.
// ─────────────────────────────────────────────────────────────────────────────
import { isFlowRecipient } from './flow-transmit.mjs';
import { isPlatformAdmin } from './authz-scope.mjs';
import { canViewFormular, loadActorCompAndCab } from './authz-formular.mjs';
import { logger } from '../middleware/logger.mjs';

// Mutat din routes/flows/crud.mjs (v3.9.502) — semantică IDENTICĂ.
// v3.9.502 (A-3 P0): înainte GET /flows/:flowId permitea citire pentru ORICE
// user autentificat → leak metadata cross-org. Acum: doar initiator, signer,
// sau admin/org_admin din aceeași org. Plus signer token (semnatari neînregistrați).
export function canActorReadFlow(actor, data, signerToken) {
  if (signerToken && (data.signers || []).some(s => s.token === signerToken)) return true;
  if (!actor) return false;
  const email = String(actor.email || '').toLowerCase();
  const isInit = String(data.initEmail || '').toLowerCase() === email;
  const isSigner = (data.signers || []).some(s => String(s.email || '').toLowerCase() === email);
  const sameOrg = actor.orgId && data.orgId && String(actor.orgId) === String(data.orgId);
  const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
  // #105f: platform-admin (admin fără org_id) vede tot cross-org; altfel same-org (fail-closed)
  return isInit || isSigner || (isAdmin && (isPlatformAdmin(actor) || sameOrg));
}

// Poarta la nivel de obiect pentru vizualizare flux + conținut (signed-pdf/pdf/attachments).
// Extinde canActorReadFlow cu ramura „destinatar repartizat" (transmitere internă).
// flowId explicit (din URL) are prioritate față de data.flowId (JSONB poate lipsi pe fluxuri
// inserate direct în test sau legacy care nu au persitat flowId în blob).
export async function isFlowAccessAllowed(pool, actor, data, signerToken, flowId = null) {
  if (canActorReadFlow(actor, data, signerToken)) return true;
  const fid = flowId || data?.flowId || null;
  if (!actor || !fid) return false;
  if (await isFlowRecipient(pool, fid, actor)) return true;
  return await isAllowedViaFormular(pool, actor, fid);
}

// ─────────────────────────────────────────────────────────────────────────────
// #153 — accesul la CONȚINUTUL fluxului se derivă din DOCUMENT, nu din ROL.
//
// Simptomul: un membru al compartimentului Responsabil CAB (organizations.cab_compartiment)
// vede DF-ul aprobat prin `authz-formular.mjs` (ramura `cab_dept`), dar la „Descarcă PDF
// semnat" primea 403 — poarta asta nu știa nimic despre compartimente.
//
// ⛔ Fixul NU este o ramură „dacă actorul e CAB ⇒ true". Poarta e generică peste TOATE
// fluxurile organizației (contracte, documente de personal, orice a trecut prin DocFlowAI):
// o ramură pe rol ar transforma CAB-ul într-un al doilea org_admin pe conținut — un IDOR
// proiectat de noi, exact clasa pe care poarta a fost creată s-o închidă. Măsurat pe
// producție (#153, Etapa A): 2.093 fluxuri vii, din care doar 177 au un DF/ORD atașat;
// restul de 1.916 (91,5%) TREBUIE să rămână închise.
//
// Deci: fluxul se deschide DOAR dacă e fluxul de semnare al unui DF/ORD pe care actorul
// are deja dreptul să-l vadă. Verdictul îl dă `canViewFormular` — autorizarea NU se
// rescrie aici; orice viitoare ramură de authz pe formulare se propagă automat.
//
// Cost: se atinge DB doar pe calea de FALLBACK (după ce init/semnatar/admin/destinatar au
// eșuat) — căile fericite rămân la același număr de query-uri.
// Fără ciclu de import: `authz-formular.mjs` nu importă nimic (ramura ei de semnatari
// interoghează direct tabela `flows`, nu trece înapoi prin fișierul acesta).
// ─────────────────────────────────────────────────────────────────────────────
async function isAllowedViaFormular(pool, actor, flowId) {
  // Fără org nu se poate scopa căutarea ⇒ fail-closed. Granița organizației nu se traversează.
  if (!actor?.userId || !actor?.orgId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT id, created_by, assigned_to, p2_compartiment, flow_id
         FROM formulare_df
        WHERE flow_id = $1 AND org_id = $2 AND deleted_at IS NULL
        UNION ALL
       SELECT id, created_by, assigned_to, p2_compartiment, flow_id
         FROM formulare_ord
        WHERE flow_id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [flowId, actor.orgId]
    );
    if (!rows.length) return false;

    const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
    for (const doc of rows) {
      const view = await canViewFormular(pool, actor, doc, actorComp, { cabComp });
      if (view.allowed) return true;
    }
    return false;
  } catch (e) {
    // Fail-closed: un acces refuzat din greșeală se repară cu un click; unul acordat din
    // greșeală e o breșă. Eroarea NU se înghite tăcut — se loghează.
    logger.error({ err: e, flowId }, 'flow-access: ramura DF/ORD a eșuat — acces REFUZAT (fail-closed)');
    return false;
  }
}
