import { describe, it, expect } from 'vitest';
import { computeAlopCapabilities } from '../../services/alop-capabilities.mjs';

const ACTOR = { userId: 1, role: 'user', orgId: 1 };
const A = (o = {}) => ({ id: 'alop-1', created_by: 1, status: 'draft', ...o });
const C = (o) => computeAlopCapabilities(A(o), ACTOR);

describe('computeAlopCapabilities — owner & terminal', () => {
  it('non-owner → nicio acțiune owner-gated', () => {
    const c = computeAlopCapabilities(A({ created_by: 99, status: 'angajare' }), ACTOR);
    expect(c.is_owner).toBe(false);
    expect(c.df_action).toBeNull();
    expect(c.can_delete).toBe(false);
  });
  it('admin → owner chiar dacă nu e creator', () => {
    const c = computeAlopCapabilities(A({ created_by: 99, status: 'angajare' }), { userId: 1, role: 'admin' });
    expect(c.is_owner).toBe(true);
  });
  it('completed → fără acțiuni active; can_refresh=false', () => {
    const c = C({ status: 'completed' });
    expect(c.is_completed).toBe(true);
    expect(c.df_action).toBeNull();
    expect(c.phase_action).toBeNull();
    expect(c.can_refresh).toBe(false);
  });
  it('completed + ramas>0 → nouă ordonanțare (NU owner-gated)', () => {
    expect(computeAlopCapabilities(A({ created_by: 99, status: 'completed', ramas: 500 }), ACTOR)
      .can_start_noua_ordonantare).toBe(true);
  });
  it('cancelled → can_refresh=false, fără acțiuni', () => {
    const c = C({ status: 'cancelled' });
    expect(c.is_cancelled).toBe(true);
    expect(c.can_refresh).toBe(false);
  });
  it('activ → can_refresh=true', () => {
    expect(C({ status: 'angajare' }).can_refresh).toBe(true);
  });
});

describe('computeAlopCapabilities — df_action (7-way)', () => {
  it('revizie în lucru → in_lucru_disabled', () =>
    expect(C({ status: 'angajare', df_revizie_in_lucru: true, df_id: 'd' }).df_action).toBe('in_lucru_disabled'));
  it('fără df → completeaza', () =>
    expect(C({ status: 'angajare', df_id: null }).df_action).toBe('completeaza'));
  it('df neaprobat → revizuieste_neaprobat', () =>
    expect(C({ status: 'angajare', df_id: 'd', df_status: 'neaprobat' }).df_action).toBe('revizuieste_neaprobat'));
  it('angajare + df pe flux → flow_waiting', () =>
    expect(C({ status: 'angajare', df_id: 'd', df_flow_id: 'f', df_status: 'transmis_flux' }).df_action).toBe('flow_waiting'));
  it('df aprobat (alt status) → deschide', () =>
    expect(C({ status: 'lichidare', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f' }).df_action).toBe('deschide'));
  it('df_id fără flow → deschide', () =>
    expect(C({ status: 'lichidare', df_id: 'd', df_flow_id: null, df_status: 'completed' }).df_action).toBe('deschide'));
});

describe('computeAlopCapabilities — phase_action + can_revise_df', () => {
  it('lichidare neconfirmată → confirma_lichidare + revise(df)', () => {
    const c = C({ status: 'lichidare', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f' });
    expect(c.phase_action).toBe('confirma_lichidare');
    expect(c.can_revise_df).toBe(true);
  });
  it('ordonantare fără ord → completeaza_ord', () =>
    expect(C({ status: 'ordonantare', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f', ord_id: null }).phase_action).toBe('completeaza_ord'));
  it('ordonantare ord fără flow → genereaza_lanseaza_ord', () =>
    expect(C({ status: 'ordonantare', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f', ord_id: 'o', ord_flow_id: null }).phase_action).toBe('genereaza_lanseaza_ord'));
  it('ordonantare ord pe flux nefinalizat → marcheaza_ord_semnat', () =>
    expect(C({ status: 'ordonantare', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f', ord_id: 'o', ord_flow_id: 'of', ord_completed_at: null }).phase_action).toBe('marcheaza_ord_semnat'));
  it('plata → confirma_plata (fără revise)', () => {
    const c = C({ status: 'plata', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f', ord_id: 'o' });
    expect(c.phase_action).toBe('confirma_plata');
    expect(c.can_revise_df).toBe(false);
  });
  it('lichidare deja confirmată → fără phase_action', () =>
    expect(C({ status: 'lichidare', df_id: 'd', lichidare_confirmed_at: '2026-01-01' }).phase_action).toBeNull());
});

describe('computeAlopCapabilities — can_delete (detaliu, owner-gated)', () => {
  it('fără df/ord → can_delete', () =>
    expect(C({ status: 'draft', df_id: null, ord_id: null }).can_delete).toBe(true));
  it('cu df → fără delete', () =>
    expect(C({ status: 'angajare', df_id: 'd' }).can_delete).toBe(false));
  it('cu ord → fără delete', () =>
    expect(C({ status: 'ordonantare', ord_id: 'o' }).can_delete).toBe(false));
  it('non-owner → fără delete chiar fără df/ord', () =>
    expect(computeAlopCapabilities(A({ created_by: 99, status: 'draft' }), ACTOR).can_delete).toBe(false));
});
