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

describe('computeAlopCapabilities — df_action (DOAR în angajare, FIX 4)', () => {
  it('revizie în lucru → in_lucru_disabled', () =>
    expect(C({ status: 'angajare', df_revizie_in_lucru: true, df_id: 'd' }).df_action).toBe('in_lucru_disabled'));
  it('fără df → completeaza', () =>
    expect(C({ status: 'angajare', df_id: null }).df_action).toBe('completeaza'));
  it('df neaprobat → revizuieste_neaprobat', () =>
    expect(C({ status: 'angajare', df_id: 'd', df_status: 'neaprobat' }).df_action).toBe('revizuieste_neaprobat'));
  it('angajare + df pe flux → flow_waiting', () =>
    expect(C({ status: 'angajare', df_id: 'd', df_flow_id: 'f', df_status: 'transmis_flux' }).df_action).toBe('flow_waiting'));
  it('df aprobat fără flux agățat → deschide', () =>
    expect(C({ status: 'angajare', df_id: 'd', df_status: 'transmis_flux', df_flow_id: null }).df_action).toBe('deschide'));
  it('df_id fără flow → deschide', () =>
    expect(C({ status: 'angajare', df_id: 'd', df_flow_id: null, df_status: 'completed' }).df_action).toBe('deschide'));

  // FIX 4: df_action NU se mai calculează după aprobarea DF (post-angajare) → buton DF ascuns.
  it('lichidare cu df aprobat → df_action null', () =>
    expect(C({ status: 'lichidare', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f' }).df_action).toBeNull());
  it('ordonantare cu df aprobat → df_action null', () =>
    expect(C({ status: 'ordonantare', df_id: 'd', df_status: 'aprobat', ord_id: 'o' }).df_action).toBeNull());
  it('plata cu df aprobat → df_action null', () =>
    expect(C({ status: 'plata', df_id: 'd', df_status: 'aprobat', ord_id: 'o' }).df_action).toBeNull());
});

describe('computeAlopCapabilities — phase_action', () => {
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
  it('plata → confirma_plata', () =>
    expect(C({ status: 'plata', df_id: 'd', df_status: 'aprobat', df_flow_id: 'f', ord_id: 'o' }).phase_action).toBe('confirma_plata'));
  it('lichidare deja confirmată → fără phase_action', () =>
    expect(C({ status: 'lichidare', df_id: 'd', lichidare_confirmed_at: '2026-01-01' }).phase_action).toBeNull());
});

describe('computeAlopCapabilities — can_revise_df (FIX 6: permanent post-angajare + ciclu închis)', () => {
  it('lichidare → true', () =>
    expect(C({ status: 'lichidare', df_id: 'd' }).can_revise_df).toBe(true));
  it('ordonantare → true', () =>
    expect(C({ status: 'ordonantare', df_id: 'd', ord_id: 'o' }).can_revise_df).toBe(true));
  it('plata → true', () =>
    expect(C({ status: 'plata', df_id: 'd', ord_id: 'o' }).can_revise_df).toBe(true));
  it('completed (ciclu închis) → true', () =>
    expect(C({ status: 'completed', df_id: 'd' }).can_revise_df).toBe(true));
  it('angajare → false (acolo accesul e prin df_action)', () =>
    expect(C({ status: 'angajare', df_id: 'd' }).can_revise_df).toBe(false));
  it('cancelled → false', () =>
    expect(C({ status: 'cancelled', df_id: 'd' }).can_revise_df).toBe(false));
  it('fără df_id → false', () =>
    expect(C({ status: 'plata', df_id: null }).can_revise_df).toBe(false));
  it('non-owner → false', () =>
    expect(computeAlopCapabilities(A({ created_by: 99, status: 'plata', df_id: 'd' }), ACTOR).can_revise_df).toBe(false));
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
