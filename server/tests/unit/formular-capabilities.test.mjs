import { describe, it, expect } from 'vitest';
import { computeDocCapabilities, deriveDocRole } from '../../services/formular-capabilities.mjs';

const ACTOR = { userId: 1, role: 'user', orgId: 1 };
// helper: doc minimal
const D = (o = {}) => ({ id: 'doc-1', created_by: 1, assigned_to: null, ...o });

describe('deriveDocRole', () => {
  it('creator → p1', () => expect(deriveDocRole(D({ created_by: 1 }), ACTOR)).toBe('p1'));
  it('assigned → p2', () => expect(deriveDocRole(D({ created_by: 2, assigned_to: 1 }), ACTOR)).toBe('p2'));
  it('nimic → view', () => expect(deriveDocRole(D({ created_by: 2, assigned_to: 3 }), ACTOR)).toBe('view'));
  it('creator are prioritate față de assigned', () =>
    expect(deriveDocRole(D({ created_by: 1, assigned_to: 1 }), ACTOR)).toBe('p1'));
});

describe('computeDocCapabilities (DF=notafd) — oglindă renderActions', () => {
  const C = (o) => computeDocCapabilities(D(o), ACTOR, 'notafd');

  it('draft + p1 → trimite P2 + reset', () => {
    const c = C({ status: 'draft', created_by: 1 });
    expect(c.can_send_p2).toBe(true);
    expect(c.can_reset).toBe(true);
    expect(c.can_save).toBe(false);
  });

  it('returnat + p1 → doar retrimite (fără reset)', () => {
    const c = C({ status: 'returnat', created_by: 1 });
    expect(c.can_send_p2).toBe(true);
    expect(c.can_reset).toBe(false);
  });

  it('pending_p2 + p2 → salvează/finalizează/returnează', () => {
    const c = C({ status: 'pending_p2', created_by: 2, assigned_to: 1 });
    expect(c.can_save).toBe(true);
    expect(c.can_complete_p2).toBe(true);
    expect(c.can_return).toBe(true);
  });

  it('pending_p2 + p1 → waiting, fără acțiuni', () => {
    const c = C({ status: 'pending_p2', created_by: 1, assigned_to: 2 });
    expect(c.is_waiting_p2).toBe(true);
    expect(c.can_save).toBe(false);
    expect(c.can_send_p2).toBe(false);
  });

  it('completed + p1 → generate_or_launch', () => {
    const c = C({ status: 'completed', created_by: 1 });
    expect(c.can_generate_or_launch).toBe(true);
  });

  it('completed + p1 + flux activ agățat → NU generate_or_launch (is_on_flow)', () => {
    const c = C({ status: 'completed', created_by: 1, flow_active: true });
    expect(c.can_generate_or_launch).toBe(false);
    expect(c.is_on_flow).toBe(true);
  });

  it('transmis_flux pe flux activ → fără generate_or_launch', () => {
    const c = C({ status: 'transmis_flux', created_by: 1, flow_id: 'f1', flow_active: true });
    expect(c.can_generate_or_launch).toBe(false);
    expect(c.is_on_flow).toBe(true);
  });

  it('completed + p2 → completed_p2, fără acțiuni', () => {
    const c = C({ status: 'completed', created_by: 2, assigned_to: 1 });
    expect(c.is_completed_p2).toBe(true);
    expect(c.can_generate_or_launch).toBe(false);
  });

  it('transmis_flux → on_flow + download_flux dacă are flow_id', () => {
    expect(C({ status: 'transmis_flux', flow_id: 'F1' }).can_download_flux).toBe(true);
    expect(C({ status: 'transmis_flux', flow_id: null }).can_download_flux).toBe(false);
    expect(C({ status: 'transmis_flux' }).is_on_flow).toBe(true);
  });

  it('aprobat → download_signed + revise (R0)', () => {
    const c = C({ status: 'aprobat', flow_id: 'F1', revizie_nr: 0 });
    expect(c.can_download_signed).toBe(true);
    expect(c.can_revise).toBe(true);
  });

  it('aprobat dar revizie istorică (has_newer_revision) → fără revise', () => {
    const c = C({ status: 'aprobat', flow_id: 'F1', has_newer_revision: true });
    expect(c.can_revise).toBe(false);
    expect(c.is_historic_revision).toBe(true);
    expect(c.can_download_signed).toBe(true);
  });

  it('ORDINE: completed + aprobat → ramura aprobat, NU completed&p1', () => {
    // doc completed dar deja aprobat pe flux → trebuie download_signed, nu generate_or_launch
    const c = C({ status: 'completed', created_by: 1, aprobat: true, flow_id: 'F1' });
    expect(c.can_download_signed).toBe(true);
    expect(c.can_generate_or_launch).toBe(false);
  });

  it('neaprobat (nu istoric) → revise', () => {
    const c = C({ status: 'neaprobat', revizie_nr: 1 });
    expect(c.can_revise).toBe(true);
    expect(c.is_neaprobat).toBe(true);
  });

  it('neaprobat + has_newer_revision → istoric, fără revise', () => {
    const c = C({ status: 'neaprobat', has_newer_revision: true });
    expect(c.can_revise).toBe(false);
    expect(c.is_historic_revision).toBe(true);
  });

  it('de_revizuit → trimite P2 + reset', () => {
    const c = C({ status: 'de_revizuit' });
    expect(c.can_send_p2).toBe(true);
    expect(c.can_reset).toBe(true);
    expect(c.is_de_revizuit).toBe(true);
  });
});

describe('computeDocCapabilities (ORD=ordnt) — fără revizii', () => {
  const C = (o) => computeDocCapabilities(D(o), ACTOR, 'ordnt');

  it('ORD aprobat → download_signed, FĂRĂ revise (ordnt)', () => {
    const c = C({ status: 'aprobat', flow_id: 'F1' });
    expect(c.can_download_signed).toBe(true);
    expect(c.can_revise).toBe(false);
  });
  it('ORD neaprobat NU intră pe ramura notafd (fallback)', () => {
    // pentru ordnt, status neaprobat nu există ca branch dedicat → fallback
    const c = C({ status: 'neaprobat' });
    expect(c.is_neaprobat).toBe(false);
    expect(c.can_revise).toBe(false);
  });
  it('ORD draft + p1 → trimite P2 + reset', () => {
    const c = C({ status: 'draft', created_by: 1 });
    expect(c.can_send_p2).toBe(true);
  });
});
