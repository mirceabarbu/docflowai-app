/**
 * DocFlowAI — alop-roluri.mjs  (#173)
 * -------------------------------------------------------------------------
 * VOCABULARUL rolurilor din șablonul de semnatari al unui dosar ALOP —
 * sursă unică pentru cheie, etichetă și atributul de semnătură.
 *
 * De ce există: aceleași roluri erau scrise de mână în PATRU locuri —
 * `ROLE_LABEL` (public/js/formular/alop.js), `ALOP_ROL` (același fișier),
 * `DF_DEFAULT_SEMNATARI`/`ORD_DEFAULT_SEMNATARI` (routes/alop.mjs) și validarea
 * din POST /api/alop/sablon. Ecranul de configurare ar fi fost al cincilea.
 * Un rol adăugat într-un loc și uitat în celălalt ajunge pe document cu
 * atributul greșit, fără nicio eroare.
 *
 * ⛔ Modul PUR: zero DB, zero I/O, zero import din rute.
 * ⛔ `atribut` trebuie să existe în lista de atribute (services/atribute.mjs).
 *    Un rol fără atribut valid ar semna un document financiar cu „SEMNAT".
 */

export const ALOP_ROLURI = Object.freeze({
  initiator:         Object.freeze({ eticheta: 'Inițiator',              atribut: 'ÎNTOCMIT' }),
  sef_compartiment:  Object.freeze({ eticheta: 'Șef compartiment',       atribut: 'VIZAT' }),
  responsabil_cab:   Object.freeze({ eticheta: 'Responsabil CAB',        atribut: 'VERIFICAT' }),
  sef_cab:           Object.freeze({ eticheta: 'Șef compartiment CAB',   atribut: 'VIZAT' }),
  director_economic: Object.freeze({ eticheta: 'Director Economic',      atribut: 'VIZĂ ECONOMICĂ' }),
  ordonator_credite: Object.freeze({ eticheta: 'Ordonator de credite',   atribut: 'APROBAT' }),
  cfp_propriu:       Object.freeze({ eticheta: 'CFP Propriu',            atribut: 'VIZĂ CFPP' }),
});

/** Roluri fără de care mecanica dosarului se rupe — nu pot lipsi din șablon. */
export const ROLURI_OBLIGATORII = Object.freeze(['initiator']);

export const MAX_ROLURI_SABLON = 12;

export function esteRolCunoscut(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ALOP_ROLURI, role);
}

export function atributImplicit(role) {
  return esteRolCunoscut(role) ? ALOP_ROLURI[role].atribut : null;
}
