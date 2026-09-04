/* DocFlowAI — audit-labels.js (#179)
 * Vocabularul evenimentelor din jurnalul unui formular (DF/ORD), partajat între
 * modalul „Audit document" (formular/doc.js) și ecranele de audit/activitate ale
 * administratorului (admin/audit.js, admin/activity.js).
 * Perechea pe server e `server/services/audit-labels.mjs`; un test de paritate
 * ține cele două în acord și cade dacă diverg.
 * ⛔ Nu adăuga o etichetă doar aici — treci întâi prin perechea de pe server.
 */
(function () {
  'use strict';
  var LABELS = {
    creat:                'Creat',
    trimis_p2:            'Trimis la Responsabil CAB',
    completat:            'Completat de Responsabil CAB',
    legat_alop:           'Legat de ALOP',
    returnat:             'Returnat',
    transmis_flux:        'Transmis în flux',
    revizuit:             'Revizuit',
    sters:                'Șters',
    flux_refuzat:         'Flux refuzat',
    neaprobat:            'Neaprobat',
    FLOW_ADMIN_CANCELLED: 'Flux finalizat anulat administrativ'
  };
  window.DFAuditLabels = {
    LABELS: LABELS,
    /** Eticheta unui eveniment; necunoscutele se întorc ca atare. */
    eticheta: function (eventType) {
      return LABELS[eventType] || String(eventType == null ? '' : eventType);
    }
  };
})();
