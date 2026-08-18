/**
 * #131a (v3.9.779) — Responsabil CAB pe COMPARTIMENT: `canEditFormular` acceptă orice membru al
 * compartimentului din `doc.p2_compartiment` (documentul are `assigned_to` NULL).
 *
 * Rolul întors e `'p2_comp'` — ACELAȘI ca ramura existentă (pe `assigned_to`). Consumatorii lui
 * (`df.mjs`/`ord.mjs` isP1/isP2, `formular-shared.mjs` isP2Side) îl tratează deja corect; un rol
 * NOU ar fi cerut modificarea tuturor.
 *
 * `pool` e primul argument al funcției ⇒ testul îi pasează un dublu, fără vi.mock.
 */
import { describe, it, expect } from 'vitest';
import { canEditFormular, canViewFormular } from '../../services/authz-formular.mjs';

// Dublu de pool: `_userIsInComp` întreabă „userul X e în compartimentul Y?".
// membership = { userId: compartiment }. Orice alt SELECT (flows/signers) ⇒ zero rânduri.
function fakePool(membership = {}) {
  return {
    async query(sql, params) {
      if (/FROM users/.test(sql)) {
        const [uid, comp] = params;
        const c = membership[String(uid)];
        return { rows: (c && String(c).trim() !== '' && String(c).trim() === comp) ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

const actor = { userId: 99, role: 'user', orgId: 1 };
// Document atribuit unui COMPARTIMENT: assigned_to NULL, creat de altcineva (id 7, alt compartiment).
const docComp = (p2_compartiment) => ({ created_by: 7, assigned_to: null, p2_compartiment });

describe('#131a — canEditFormular pe p2_compartiment', () => {
  it('1. ⭐ actor din compartimentul atribuit ⇒ allowed, rol p2_comp', async () => {
    const r = await canEditFormular(fakePool({ 7: 'Achizitii' }), actor, docComp('Serviciul Buget'), 'Serviciul Buget');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('p2_comp');
  });

  it('2. actor din alt compartiment ⇒ refuzat', async () => {
    const r = await canEditFormular(fakePool({ 7: 'Achizitii' }), actor, docComp('Serviciul Buget'), 'Juridic');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('3. actor FĂRĂ compartiment ("") ⇒ refuzat, chiar dacă p2_compartiment e gol', async () => {
    const r1 = await canEditFormular(fakePool(), actor, docComp(''), '');
    expect(r1.allowed).toBe(false);
    // și cu p2_compartiment setat: șirul gol nu se potrivește cu nimic
    const r2 = await canEditFormular(fakePool(), actor, docComp('Serviciul Buget'), '');
    expect(r2.allowed).toBe(false);
  });

  it('4. TRIM pe ambele părți: p2_compartiment=" Serviciul Buget " ⇒ allowed', async () => {
    const r = await canEditFormular(fakePool({ 7: 'Achizitii' }), actor, docComp(' Serviciul Buget '), 'Serviciul Buget');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('p2_comp');
  });

  it('5. NON-REGRESIE: ramura p2_comp existentă (pe assigned_to) rămâne verde', async () => {
    // documentul e atribuit PERSOANEI 42, care e în compartimentul actorului
    const doc = { created_by: 7, assigned_to: 42, p2_compartiment: null };
    const r = await canEditFormular(fakePool({ 7: 'Achizitii', 42: 'Serviciul Buget' }), actor, doc, 'Serviciul Buget');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('p2_comp');
  });

  it('5b. creatorul rămâne `creator` chiar dacă e și în compartimentul atribuit (ordinea contează)', async () => {
    const doc = { created_by: actor.userId, assigned_to: null, p2_compartiment: 'Serviciul Buget' };
    const r = await canEditFormular(fakePool(), actor, doc, 'Serviciul Buget');
    expect(r.role).toBe('creator');
  });

  it('6. canViewFormular se aliniază AUTOMAT prin delegare la canEditFormular', async () => {
    const r = await canViewFormular(fakePool({ 7: 'Achizitii' }), actor, docComp('Serviciul Buget'), 'Serviciul Buget');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('p2_comp');
    expect(r.mode).toBe('edit');
  });
});
