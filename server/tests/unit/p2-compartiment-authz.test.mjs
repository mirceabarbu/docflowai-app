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
import { deriveDocRole } from '../../services/formular-capabilities.mjs';

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

// ─────────────────────────────────────────────────────────────────────────────
// #131c (v3.9.781) — ORDINEA ramurilor din blocul `if (actorComp)`.
//
// La #131a ramura `p2_compartiment` era ULTIMA din bloc, deci nu se atingea niciodată când
// inițiatorul e coleg de compartiment cu actorul: ramura `'comp'` (P1-comp, back-compat)
// câștiga și întorcea rolul `'comp'`. `returnFormular`/`completeFormular` cer
// `['admin','assigned','p2_comp']` sau `doc.assigned_to === actor.userId` — pe atribuirea
// pe COMPARTIMENT `assigned_to` e NULL ⇒ 403 pe butoane vizibile în UI
// (`deriveDocRole` e o funcție separată și dădea corect 'p2').
// ─────────────────────────────────────────────────────────────────────────────
describe('#131c — ordinea p2_compartiment ÎNAINTEA lui comp', () => {
  const COMP = 'Serviciul Buget';
  // creator A (id 7) și actor B (id 99) sunt AMBII în COMP; documentul e atribuit lui COMP.
  const bothTrue = { created_by: 7, assigned_to: null, p2_compartiment: COMP };

  it('1. ⭐ bug-ul raportat: creator coleg + doc atribuit compartimentului meu ⇒ p2_comp (nu comp)', async () => {
    const r = await canEditFormular(fakePool({ 7: COMP, 99: COMP }), actor, bothTrue, COMP);
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('p2_comp');   // fără fix: 'comp' ⇒ returneaza/complete dau 403
  });

  it('8. ⭐ poartă de ordine: AMBELE condiții adevărate ⇒ câștigă atribuirea EXPLICITĂ', async () => {
    // De ce contează ordinea: „documentul mi-a fost atribuit ca Responsabil CAB" e o
    // revendicare mai specifică decât „creatorul se întâmplă să-mi fie coleg". Dacă un
    // refactor mută ramura `'comp'` deasupra, acest test pică — exact defectul #131c.
    const r = await canEditFormular(fakePool({ 7: COMP, 99: COMP }), actor, bothTrue, COMP);
    expect(r.role).not.toBe('comp');
    expect(r.role).toBe('p2_comp');
  });

  it('4. NON-REGRESIE ramura P1-comp: doc FĂRĂ p2_compartiment (NULL) ⇒ rolul rămâne `comp`', async () => {
    const doc = { created_by: 7, assigned_to: null, p2_compartiment: null };
    const r = await canEditFormular(fakePool({ 7: COMP, 99: COMP }), actor, doc, COMP);
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('comp');
  });

  it('5. actor din ALT compartiment, pe doc cu p2_compartiment=COMP ⇒ refuzat', async () => {
    const r = await canEditFormular(fakePool({ 7: COMP }), actor, bothTrue, 'Juridic');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('6. creatorul însuși, membru al compartimentului atribuit ⇒ rămâne `creator` (INTENȚIONAT)', async () => {
    // Separarea sarcinilor: ramura `creator` e deasupra blocului `actorComp` și câștigă, deci
    // inițiatorul NU-și returnează/finalizează propriul document (403 pe returneaza).
    const doc = { created_by: actor.userId, assigned_to: null, p2_compartiment: COMP };
    const r = await canEditFormular(fakePool({ 99: COMP }), actor, doc, COMP);
    expect(r.role).toBe('creator');
  });

  it('7. atribuire pe PERSOANĂ (assigned_to setat, p2_compartiment NULL) ⇒ roluri neschimbate', async () => {
    // 7a — actorul E persoana atribuită ⇒ 'assigned'
    const rA = await canEditFormular(
      fakePool({ 7: 'Achizitii', 99: COMP }),
      actor, { created_by: 7, assigned_to: actor.userId, p2_compartiment: null }, COMP);
    expect(rA.role).toBe('assigned');
    // 7b — actorul e COLEG cu persoana atribuită ⇒ 'p2_comp' prin assigned_to (ramura veche)
    const rB = await canEditFormular(
      fakePool({ 7: 'Achizitii', 42: COMP }),
      actor, { created_by: 7, assigned_to: 42, p2_compartiment: null }, COMP);
    expect(rB.role).toBe('p2_comp');
  });

  it('9. ⭐ `deriveDocRole` și `canEditFormular` sunt DE ACORD pe același scenariu', async () => {
    // Divergența dintre ele (UI zicea 'p2', authz zicea 'comp') a fost forma reală a bug-ului.
    expect(deriveDocRole(bothTrue, actor, COMP)).toBe('p2');
    expect((await canEditFormular(fakePool({ 7: COMP, 99: COMP }), actor, bothTrue, COMP)).role)
      .toBe('p2_comp');
    // și pe scenariul de non-regresie (fără p2_compartiment): UI 'view', authz 'comp' —
    // ambele „nu e P2", deci tot de acord.
    const docNull = { created_by: 7, assigned_to: null, p2_compartiment: null };
    expect(deriveDocRole(docNull, actor, COMP)).toBe('view');
    expect((await canEditFormular(fakePool({ 7: COMP, 99: COMP }), actor, docNull, COMP)).role)
      .toBe('comp');
  });
});
