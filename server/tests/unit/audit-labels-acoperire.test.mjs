/**
 * #179 — vocabularul de audit al documentului: acoperire + paritate server↔client.
 *
 * Testul care contează e (1): acoperirea NU e o listă scrisă de mână, ci se derivă din COD.
 * Când cineva adaugă un `eventType` nou la un apel `recordFormularAudit` fără să-i dea
 * etichetă, testul cade — exact scenariul care a produs `FLOW_ADMIN_CANCELLED` brut în
 * documentul de audit exportat al unei instituții publice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_LABELS, etichetaAudit } from '../../services/audit-labels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Toate fișierele .mjs din server/, mai puțin suita de teste. */
function fisiereServer(dir = path.join(ROOT, 'server'), acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p.split(path.sep).includes('tests')) continue;
      fisiereServer(p, acc);
    } else if (e.name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

/**
 * Valorile `eventType` trimise către `recordFormularAudit`, extrase din sursă.
 * Fereastra de 600 de caractere după apel acoperă cu marjă toate call-site-urile
 * (cel mai lung are ~350). ⚠️ `[A-Za-z0-9_]` — clasa fără cifre ratează `trimis_p2`.
 */
function eventTypesDinCod() {
  const set = new Set();
  for (const f of fisiereServer()) {
    const src = fs.readFileSync(f, 'utf8');
    let i = 0;
    while ((i = src.indexOf('recordFormularAudit(', i)) !== -1) {
      const m = src.slice(i, i + 600).match(/eventType:\s*'([A-Za-z0-9_]+)'/);
      if (m) set.add(m[1]);
      i += 'recordFormularAudit('.length;
    }
  }
  return set;
}

/** Perechea din client, parsată din fișier (nu importată — e script clasic, nu modul). */
function labelsClient() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/shared/audit-labels.js'), 'utf8');
  const body = src.slice(src.indexOf('var LABELS = {') + 'var LABELS = {'.length);
  const map = {};
  for (const m of body.slice(0, body.indexOf('};')).matchAll(/([A-Za-z0-9_]+)\s*:\s*'([^']*)'/g))
    map[m[1]] = m[2];
  return map;
}

describe('#179 — acoperirea vocabularului de audit', () => {
  it('(1) fiecare eventType trimis către recordFormularAudit are etichetă', () => {
    const dinCod = [...eventTypesDinCod()].sort();
    expect(dinCod.length).toBeGreaterThanOrEqual(11); // canar: extragerea chiar găsește ceva
    const fara = dinCod.filter(t => !Object.prototype.hasOwnProperty.call(AUDIT_LABELS, t));
    expect(fara).toEqual([]);
  });

  it('(1b) extragerea prinde și cheile cu cifre (trimis_p2) — capcana clasei [A-Za-z_]', () => {
    expect(eventTypesDinCod().has('trimis_p2')).toBe(true);
  });

  it('(2) paritate server↔client: chei și valori identice', () => {
    expect(labelsClient()).toEqual({ ...AUDIT_LABELS });
  });

  it('(3) etichetaAudit(k, {upper:true}) === AUDIT_LABELS[k].toUpperCase()', () => {
    for (const [k, v] of Object.entries(AUDIT_LABELS))
      expect(etichetaAudit(k, { upper: true })).toBe(v.toUpperCase());
  });

  it('(4) non-regresie export CSV/PDF: cele 7 chei vechi dau EXACT șirurile de dinainte', () => {
    // Copiate literal din `FORMULAR_AUDIT_LABELS` (shared.mjs, v3.9.833) — fixează exportul
    // byte cu byte, diacritice incluse.
    const VECHI = {
      creat:         'CREAT',
      trimis_p2:     'TRIMIS LA RESPONSABIL CAB',
      completat:     'COMPLETAT DE RESPONSABIL CAB',
      legat_alop:    'LEGAT DE ALOP',
      returnat:      'RETURNAT',
      transmis_flux: 'TRANSMIS ÎN FLUX',
      revizuit:      'REVIZUIT',
      sters:         'ȘTERS',
    };
    for (const [k, v] of Object.entries(VECHI))
      expect(etichetaAudit(k, { upper: true })).toBe(v);
  });

  it('(4b) cele trei etichete noi decise de Mircea', () => {
    expect(AUDIT_LABELS.FLOW_ADMIN_CANCELLED).toBe('Flux finalizat anulat administrativ');
    expect(AUDIT_LABELS.flux_refuzat).toBe('Flux refuzat');
    expect(AUDIT_LABELS.neaprobat).toBe('Neaprobat');
  });

  it('(5) eveniment necunoscut ⇒ numele brut, nu undefined', () => {
    expect(etichetaAudit('EVENIMENT_INEXISTENT')).toBe('EVENIMENT_INEXISTENT');
    expect(etichetaAudit('EVENIMENT_INEXISTENT', { upper: true })).toBe('EVENIMENT_INEXISTENT');
    expect(etichetaAudit(undefined)).toBe('');
  });

  it('(6) AUDIT_LABELS e înghețat', () => {
    expect(Object.isFrozen(AUDIT_LABELS)).toBe(true);
  });
});
