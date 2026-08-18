/**
 * #131a (v3.9.779) — capabilități pentru documentele atribuite unui COMPARTIMENT.
 *
 * Bug-ul reparat: cu `assigned_to` NULL, `deriveDocRole` întorcea 'view' pentru membrul
 * compartimentului ⇒ cădea pe fallback-ul de la finalul lui `computeDocCapabilities`, care setează
 * `can_send_p2: true` ⇒ Responsabilul CAB vedea „Trimite la Responsabil CAB" în loc de
 * „Finalizez secțiunea". Exact inversul comportamentului corect.
 *
 * Al 4-lea argument (`actorComp`) e OPȚIONAL — fără el, rezultatul e identic cu cel de dinainte.
 */
import { describe, it, expect } from 'vitest';
import { computeDocCapabilities, deriveDocRole } from '../../services/formular-capabilities.mjs';

const actor = { userId: 99, role: 'user', orgId: 1 };
const COMP  = 'Serviciul Buget';

// Document trimis la COMPARTIMENT: pending_p2, assigned_to NULL, creat de altcineva.
const docComp = { id: 'd1', status: 'pending_p2', created_by: 7, assigned_to: null, p2_compartiment: COMP };

describe('#131a — deriveDocRole cu actorComp', () => {
  it('membru al compartimentului atribuit ⇒ p2', () => {
    expect(deriveDocRole(docComp, actor, COMP)).toBe('p2');
  });
  it('8. creatorul care e ȘI în compartimentul atribuit ⇒ rămâne p1', () => {
    expect(deriveDocRole({ ...docComp, created_by: actor.userId }, actor, COMP)).toBe('p1');
  });
  it('alt compartiment ⇒ view', () => {
    expect(deriveDocRole(docComp, actor, 'Juridic')).toBe('view');
  });
  it('actorComp gol / omis ⇒ view (retrocompatibil)', () => {
    expect(deriveDocRole(docComp, actor, '')).toBe('view');
    expect(deriveDocRole(docComp, actor)).toBe('view');
  });
});

describe('#131a — computeDocCapabilities cu actorComp', () => {
  it('6. ⭐ pending_p2 + assigned_to NULL + compartimentul meu ⇒ caps de P2 (NU can_send_p2)', () => {
    const caps = computeDocCapabilities(docComp, actor, 'notafd', COMP);
    expect(caps.can_complete_p2).toBe(true);
    expect(caps.can_return).toBe(true);
    expect(caps.can_save).toBe(true);
    // ăsta e chiar bug-ul: fără fix, fallback-ul îl punea pe true
    expect(caps.can_send_p2).toBe(false);
    expect(caps.can_reset).toBe(false);
  });

  it('6b. fără fix (fără al 4-lea argument) documentul ar arăta „Trimite la Responsabil CAB"', () => {
    const caps = computeDocCapabilities(docComp, actor, 'notafd');
    expect(caps.can_send_p2).toBe(true);       // comportamentul BUGGY, păstrat ca dovadă
    expect(caps.can_complete_p2).toBe(false);
  });

  it('7. actor din alt compartiment ⇒ caps de "view", exact ca azi', () => {
    const cu   = computeDocCapabilities(docComp, actor, 'notafd', 'Juridic');
    const fara = computeDocCapabilities(docComp, actor, 'notafd');
    expect(cu).toEqual(fara);
  });

  it('8. creatorul care e ȘI în compartimentul atribuit ⇒ caps de P1 (is_waiting_p2)', () => {
    const caps = computeDocCapabilities({ ...docComp, created_by: actor.userId }, actor, 'notafd', COMP);
    expect(caps.is_waiting_p2).toBe(true);
    expect(caps.can_complete_p2).toBe(false);
  });

  it('9. ⭐ RETROCOMPATIBILITATE: fără al 4-lea argument, obiectele sunt IDENTICE cu cele vechi', () => {
    // scenariile vechi = documente pe `assigned_to`, fără `p2_compartiment`
    const scenarii = [
      { id: 'a', status: 'draft',         created_by: 99, assigned_to: null },
      { id: 'b', status: 'returnat',      created_by: 99, assigned_to: 7 },
      { id: 'c', status: 'pending_p2',    created_by: 7,  assigned_to: 99 },
      { id: 'd', status: 'pending_p2',    created_by: 99, assigned_to: 7 },
      { id: 'e', status: 'completed',     created_by: 99, assigned_to: 7 },
      { id: 'f', status: 'completed',     created_by: 7,  assigned_to: 99 },
      { id: 'g', status: 'transmis_flux', created_by: 99, assigned_to: 7, flow_id: 'F1' },
      { id: 'h', status: 'aprobat',       created_by: 99, assigned_to: 7, flow_id: 'F1' },
      { id: 'i', status: 'neaprobat',     created_by: 99, assigned_to: 7 },
      { id: 'j', status: 'de_revizuit',   created_by: 99, assigned_to: 7 },
      { id: 'k', status: 'draft',         created_by: 7,  assigned_to: 8 },   // străin ⇒ view/fallback
    ];
    for (const ft of ['notafd', 'ordnt']) {
      for (const doc of scenarii) {
        // 3 argumente (semnătura veche) vs. 4 cu actorComp gol ⇒ același obiect;
        // și chiar cu un actorComp real, un doc FĂRĂ p2_compartiment nu se schimbă.
        expect(computeDocCapabilities(doc, actor, ft)).toEqual(computeDocCapabilities(doc, actor, ft, ''));
        expect(computeDocCapabilities(doc, actor, ft)).toEqual(computeDocCapabilities(doc, actor, ft, COMP));
      }
    }
    expect(computeDocCapabilities(null, actor, 'notafd', COMP)).toEqual(computeDocCapabilities(null, actor, 'notafd'));
  });

  it('10. can_reopen (#129) rămâne FALSE pentru membrul compartimentului (e p2, nu p1)', () => {
    const doc = { id: 'd2', status: 'completed', created_by: 7, assigned_to: null, p2_compartiment: COMP };
    expect(computeDocCapabilities(doc, actor, 'notafd', COMP).can_reopen).toBe(false);
    // …dar rămâne TRUE pentru creator (non-regresie #129)
    expect(computeDocCapabilities({ ...doc, created_by: actor.userId }, actor, 'notafd', COMP).can_reopen).toBe(true);
  });
});
