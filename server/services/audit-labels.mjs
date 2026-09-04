/**
 * DocFlowAI — audit-labels.mjs  (#179)
 * -------------------------------------------------------------------------
 * VOCABULARUL evenimentelor din jurnalul unui formular (DF/ORD) — sursă unică.
 *
 * De ce există: aceleași etichete erau scrise în PATRU locuri, iar cele două
 * care ajung la utilizator (modalul din `public/js/formular/doc.js` și exportul
 * CSV/PDF din `server/routes/formulare/shared.mjs`) rataseră amândouă exact
 * aceleași trei evenimente ⇒ în documentul de audit al unei instituții publice
 * apăreau identificatori tehnici în loc de denumiri.
 *
 * ⛔ Perechea din client e `public/js/shared/audit-labels.js`. Un test de
 *    paritate le compară și cade dacă diverg — NU repara divergența
 *    schimbând doar una.
 * ⛔ Exportul CSV/PDF folosea MAJUSCULE. Se păstrează prin `.toUpperCase()`
 *    aplicat aici, nu printr-o a doua listă.
 * ⛔ Un eveniment nou trimis către `recordFormularAudit` TREBUIE să primească
 *    aici o intrare — testul de acoperire (`audit-labels-acoperire.test.mjs`)
 *    extrage valorile `eventType` direct din cod și cade altfel.
 */

export const AUDIT_LABELS = Object.freeze({
  creat:                 'Creat',
  trimis_p2:             'Trimis la Responsabil CAB',
  completat:             'Completat de Responsabil CAB',
  legat_alop:            'Legat de ALOP',
  returnat:              'Returnat',
  transmis_flux:         'Transmis în flux',
  revizuit:              'Revizuit',
  sters:                 'Șters',
  flux_refuzat:          'Flux refuzat',
  neaprobat:             'Neaprobat',
  FLOW_ADMIN_CANCELLED:  'Flux finalizat anulat administrativ',
});

/** Eticheta unui eveniment; `upper` pentru CSV/PDF. Necunoscutele se întorc ca atare. */
export function etichetaAudit(eventType, { upper = false } = {}) {
  const raw = AUDIT_LABELS[eventType] || String(eventType || '');
  return upper ? raw.toUpperCase() : raw;
}
