/**
 * public/js/shared/atribute.js
 *
 * Lista de ATRIBUTE ale semnatarilor — sursă unică pentru cele două ecrane care o
 * foloseau, fiecare cu propria copie: `semdoc-initiator/main.js` (opțiuni <option>
 * scrise de mână) și `templates/templates.js` (array + buildAtribOptions).
 *
 * La #168 conținutul celor două era încă identic. Consolidarea s-a făcut ATUNCI tocmai
 * ca a treia cerere de atribut să nu găsească liste divergente.
 *
 * Script CLASIC, încărcat explicit de fiecare pagină consumatoare ÎNAINTE de scriptul
 * care apelează DFAtribute. Expune window.DFAtribute.
 *
 * ⛔ `__alt__` NU e un atribut — e santinela pentru „Alt atribut…", care deschide inputul
 *    de text liber. Rămâne ULTIMA în listă și e singura cu etichetă diferită de valoare.
 * ⛔ Valorile sunt constante scrise aici, nu date de utilizator ⇒ nu se escapează (la fel
 *    ca în implementarea originală din templates.js).
 */
(function () {
  'use strict';

  var LIST = [
    'ÎNTOCMIT', 'VERIFICAT', 'VIZAT', 'AVIZAT', 'APROBAT',
    'VIZĂ CFPP', 'VIZĂ JURIDICĂ', 'VIZĂ TEHNICĂ', 'VIZĂ ECONOMICĂ',
    'CONTROLAT', 'CERTIFICAT', 'CONTRASEMNAT', 'ÎNSUȘIT', 'ASUMAT',
    'SEMNAT', 'LUAT LA CUNOȘTINȚĂ',
    'ÎNREGISTRAT',
    'ÎNREGISTRAT CAB',   // #168 — atribut NOU, imediat după ÎNREGISTRAT (cerere Mircea)
    'CONFIRMAT',
    '__alt__'
  ];

  function buildOptions(selected) {
    return LIST.map(function (a) {
      var label = a === '__alt__' ? 'Alt atribut...' : a;
      return '<option value="' + a + '"' + (a === selected ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
  }

  function isKnown(value) {
    return LIST.indexOf(value) !== -1;
  }

  window.DFAtribute = { LIST: LIST, buildOptions: buildOptions, isKnown: isKnown };
})();
