/**
 * DocFlowAI — Unit tests: ALOP state machine
 *
 * Testează logica pură a mașinii de stări ALOP, fără DB sau Express.
 * Mașina este implementată în server/routes/alop.mjs — replicăm logica
 * identică aici pentru a o putea testa izolat.
 *
 * Acoperire:
 *   ✓ Statusuri valide în ordinea corectă
 *   ✓ Tranziții valide acceptate
 *   ✓ Tranziții invalide respinse
 *   ✓ Statusuri terminale (completed, cancelled) nu permit tranziții
 *   ✓ canTransition pentru status inexistent returnează false
 */

import { describe, it, expect } from 'vitest';

// ── Replică exactă a state machine din alop.mjs ───────────────────────────────
// (Nu importăm direct deoarece nu e exportat — testăm comportamentul ca spec)

const VALID_TRANSITIONS = {
  draft:       ['angajare', 'cancelled'],
  angajare:    ['lichidare', 'cancelled'],
  lichidare:   ['ordonantare', 'cancelled'],
  ordonantare: ['plata', 'cancelled'],
  plata:       ['completed', 'cancelled'],
  completed:   [],
  cancelled:   [],
};

function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

const ORDERED_STATUSES = ['draft', 'angajare', 'lichidare', 'ordonantare', 'plata', 'completed'];

// ─────────────────────────────────────────────────────────────────────────────

describe('ALOP state machine — statusuri și ordine', () => {
  it('sunt definite exact 7 statusuri (inclusiv cancelled)', () => {
    const statuses = Object.keys(VALID_TRANSITIONS);
    expect(statuses).toHaveLength(7);
    expect(statuses).toContain('cancelled');
  });

  it('fluxul principal parcurge statusurile în ordinea corectă', () => {
    for (let i = 0; i < ORDERED_STATUSES.length - 1; i++) {
      const from = ORDERED_STATUSES[i];
      const to   = ORDERED_STATUSES[i + 1];
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('nu se poate sări peste etape (ex: draft → lichidare)', () => {
    expect(canTransition('draft', 'lichidare')).toBe(false);
    expect(canTransition('draft', 'ordonantare')).toBe(false);
    expect(canTransition('angajare', 'ordonantare')).toBe(false);
    expect(canTransition('lichidare', 'plata')).toBe(false);
    expect(canTransition('ordonantare', 'completed')).toBe(false);
  });

  it('nu se poate merge înapoi (ex: angajare → draft)', () => {
    expect(canTransition('angajare', 'draft')).toBe(false);
    expect(canTransition('lichidare', 'angajare')).toBe(false);
    expect(canTransition('ordonantare', 'lichidare')).toBe(false);
    expect(canTransition('plata', 'ordonantare')).toBe(false);
    expect(canTransition('completed', 'plata')).toBe(false);
  });
});

describe('ALOP state machine — tranziții valide', () => {
  it('draft → angajare (link-df)', () => {
    expect(canTransition('draft', 'angajare')).toBe(true);
  });

  it('angajare → lichidare (df-completed)', () => {
    expect(canTransition('angajare', 'lichidare')).toBe(true);
  });

  it('lichidare → ordonantare (confirma-lichidare)', () => {
    expect(canTransition('lichidare', 'ordonantare')).toBe(true);
  });

  it('ordonantare → plata (ord-completed)', () => {
    expect(canTransition('ordonantare', 'plata')).toBe(true);
  });

  it('plata → completed (confirma-plata)', () => {
    expect(canTransition('plata', 'completed')).toBe(true);
  });

  it('orice status activ poate fi anulat (→ cancelled)', () => {
    ['draft', 'angajare', 'lichidare', 'ordonantare', 'plata'].forEach(s => {
      expect(canTransition(s, 'cancelled')).toBe(true);
    });
  });
});

describe('ALOP state machine — statusuri terminale', () => {
  it('completed nu permite nicio tranziție', () => {
    expect(VALID_TRANSITIONS['completed']).toHaveLength(0);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('completed', 'plata')).toBe(false);
  });

  it('cancelled nu permite nicio tranziție', () => {
    expect(VALID_TRANSITIONS['cancelled']).toHaveLength(0);
    expect(canTransition('cancelled', 'draft')).toBe(false);
    expect(canTransition('cancelled', 'angajare')).toBe(false);
  });
});

describe('ALOP state machine — tranziții invalide / edge cases', () => {
  it('status inexistent returnează false', () => {
    expect(canTransition('inexistent', 'angajare')).toBe(false);
    expect(canTransition('draft', 'inexistent')).toBe(false);
  });

  it('tranziție identică (self-loop) nu este permisă', () => {
    ORDERED_STATUSES.forEach(s => {
      expect(canTransition(s, s)).toBe(false);
    });
  });

  it('string gol returnează false', () => {
    expect(canTransition('', 'angajare')).toBe(false);
    expect(canTransition('draft', '')).toBe(false);
  });
});
