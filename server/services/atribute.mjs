/**
 * DocFlowAI — atribute.mjs  (#173)
 * -------------------------------------------------------------------------
 * Lista de ATRIBUTE de semnătură, pereche pe SERVER a lui
 * `public/js/shared/atribute.js` (window.DFAtribute, #168). Serverul are nevoie
 * de ea ca să valideze atributul ales pentru un rol cu etichetă liberă.
 *
 * ⛔ Cele două liste trebuie să rămână IDENTICE. Un test de paritate
 *    (`server/tests/unit/atribute-paritate.test.mjs`) parsează fișierul din
 *    `public/` și cade dacă diverg. NU „repara" divergența schimbând doar una.
 * ⛔ `__alt__` e santinela pentru „Alt atribut…", NU un atribut — de aceea
 *    `esteAtributValid` o respinge.
 */

export const ATRIBUTE = Object.freeze([
  'ÎNTOCMIT', 'VERIFICAT', 'VIZAT', 'AVIZAT', 'APROBAT',
  'VIZĂ CFPP', 'VIZĂ JURIDICĂ', 'VIZĂ TEHNICĂ', 'VIZĂ ECONOMICĂ',
  'CONTROLAT', 'CERTIFICAT', 'CONTRASEMNAT', 'ÎNSUȘIT', 'ASUMAT',
  'SEMNAT', 'LUAT LA CUNOȘTINȚĂ',
  'ÎNREGISTRAT', 'ÎNREGISTRAT CAB', 'CONFIRMAT',
]);

export function esteAtributValid(v) {
  return typeof v === 'string' && ATRIBUTE.includes(v.trim());
}
