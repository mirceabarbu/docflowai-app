/**
 * DocFlowAI — flow-completion.mjs  (audit #120, PAS 4)
 * ----------------------------------------------------
 * Igiena steagului `completed` la anularea unui flux.
 *
 * Un flux ANULAT nu trebuie să rămână marcat `completed=true` dacă nu era, de fapt,
 * semnat de toți semnatarii (incidentul PZ_8C34C4E842: 0/5 semnături, `completed=true`,
 * anulat, `completedAt` NULL). Orice interogare care se încrede în steag fără să
 * excludă `cancelled` dă fals-pozitive.
 *
 * ⚠️ Dacă fluxul CHIAR era complet semnat înainte de anulare, NU ștergem steagul —
 * ar rescrie istoria unui document semnat. Criteriul „complet semnat" = TOȚI
 * semnatarii au `status==='signed'` ȘI `pdfUploaded===true`.
 */

/**
 * @param {object} data  blob-ul de date al fluxului
 * @returns {boolean} true dacă TOȚI semnatarii au semnat și au încărcat PDF-ul
 */
export function isFullySigned(data) {
  const signers = Array.isArray(data?.signers) ? data.signers : [];
  if (!signers.length) return false;
  return signers.every((s) => s?.status === 'signed' && s?.pdfUploaded === true);
}

/**
 * Mutează `data` in-place: la anulare, dacă fluxul NU era complet semnat, curăță
 * `completed` (→ false) și `completedAt` (→ null). Dacă era complet semnat, nu atinge
 * nimic. Întoarce true dacă a curățat ceva (util pentru log/audit).
 *
 * @param {object} data
 * @returns {boolean}
 */
export function sanitizeCancelledCompletion(data) {
  if (!data || typeof data !== 'object') return false;
  if (isFullySigned(data)) return false;
  const changed = data.completed === true || data.completedAt != null;
  data.completed = false;
  data.completedAt = null;
  return changed;
}
