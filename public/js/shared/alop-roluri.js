/* DocFlowAI — alop-roluri.js (#175)
 * Harta rol ALOP → atribut de semnătură, partajată între ecrane.
 * Perechea pe server e `server/services/alop-roluri.mjs` (#173); un test de paritate
 * ține cele două în acord și cade dacă diverg.
 * A trăit până acum în `public/js/formular/alop.js`, unde nu putea fi folosită de
 * `semdoc-initiator`, care e cel care construiește efectiv rândurile de semnatari.
 */
(function () {
  'use strict';
  var ROL_ATRIBUT = {
    initiator: 'ÎNTOCMIT',
    sef_compartiment: 'VIZAT',
    responsabil_cab: 'VERIFICAT',
    sef_cab: 'VIZAT',
    director_economic: 'VIZĂ ECONOMICĂ',
    ordonator_credite: 'APROBAT',
    cfp_propriu: 'VIZĂ CFPP'
  };
  window.DFAlopRoluri = {
    ROL_ATRIBUT: ROL_ATRIBUT,
    /** Atributul unui rând de șablon: cel salvat explicit are precădere (rol personalizat). */
    atribut: function (s) {
      if (!s) return 'SEMNAT';
      if (typeof s.atribut === 'string' && s.atribut.trim()) return s.atribut.trim();
      return ROL_ATRIBUT[s.role] || 'SEMNAT';
    }
  };
})();
