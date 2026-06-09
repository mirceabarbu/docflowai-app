# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): `signing.mjs`, `bulk-signing.mjs`, `cloud-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`.

---

## Obiectiv — Etapa 3a (ALOP capabilities, backend ADITIV)

Aducem același tipar ca la DF/ORD (sursă unică server-side) pe modulul ALOP, care are magnetul
de acțiuni cel mai dens (`renderAlopDetail` din `alop.js`, ~liniile 504–551). **Avantaj ALOP:** UI-ul
re-fetch-uiește via `openAlop(id)` după FIECARE mutație (lichidare/plată/ord-completed/nouă
ordonanțare/refuz/auto-refresh), deci NU există update optimist → **nicio problemă de staleness**.
Ajunge să atașăm caps pe endpoint-ul de **detaliu** (alimentează `renderAlopDetail`) + `can_delete` pe **listă**.

Această etapă: DOAR backend aditiv + teste. `alop.js` rămâne neatins (încă nu citește caps).
`renderAlopDetail` va consuma caps în Etapa 3b.

### Toate intrările sunt server-side

Nu există echivalent de `hasPdf` (stare client). Matricea depinde 100% de date server:
`status`, `created_by`+rol (owner), `df_id`, `df_flow_id`, `df_status`, `df_revizie_in_lucru`,
`ord_id`, `ord_flow_id`, `ord_completed_at`, `lichidare_confirmed_at`, `ramas`. Toate există în
răspunsul de la `GET /api/alop/:id` (query-ul îmbogățit + `alop.ramas` calculat înainte de `res.json`).

### Maparea exactă `renderAlopDetail` → capabilities

`is_owner = String(created_by)===String(actor.userId) || actor.role∈{admin,org_admin}`.

**În afara owner-gate (mirror exact — NU sunt owner-gated în codul actual):**
- `can_refresh = !is_completed && !is_cancelled`  (butonul ↻ Actualizează)
- `can_start_noua_ordonantare = is_completed && ramas>0`  (🔄 Nouă ordonanțare parțială)

**Doar dacă `!is_completed && !is_cancelled && is_owner`** (altfel toate null/false):

`df_action` (7-way, primul match):
1. `df_revizie_in_lucru` → `'in_lucru_disabled'`
2. `!df_id` → `'completeaza'`
3. `df_status==='neaprobat'` → `'revizuieste_neaprobat'`
4. `status==='angajare' && df_flow_id` → `'flow_waiting'`
5. `df_status ∈ {aprobat,transmis_flux,de_revizuit}` → `'deschide'`
6. `df_id && !df_flow_id` → `'deschide'`
7. else → `'completeaza'`

`phase_action` (primul match) + `can_revise_df`:
1. `status==='lichidare' && !lichidare_confirmed_at` → `'confirma_lichidare'`, `can_revise_df=!!df_id`
2. `status==='ordonantare' && !ord_id` → `'completeaza_ord'`, `can_revise_df=!!df_id`
3. `status==='ordonantare' && ord_id && !ord_flow_id` → `'genereaza_lanseaza_ord'`, `can_revise_df=!!df_id`
4. `status==='ordonantare' && ord_flow_id && !ord_completed_at` → `'marcheaza_ord_semnat'`
5. `status==='plata'` → `'confirma_plata'`

`can_delete = !df_id && !ord_id`  (owner-gated, fiindcă e în blocul `isAlopOwner`)

> ATENȚIE la o discrepanță existentă pe care o PĂSTRĂM 1:1: în **listă** ștergerea NU e owner-gated
> (`active && !df_id && !ord_id`), dar în **detaliu** ESTE (în blocul `isAlopOwner`). Deci `can_delete`
> de pe listă (SQL) ≠ `can_delete` din `capabilities` de pe detaliu (owner-gated). Autorizarea reală
> e oricum pe ruta `/cancel`. NU „repara" discrepanța aici (ar fi schimbare de comportament).

---

## Patch 1 — fișier nou `server/services/alop-capabilities.mjs`

**CREATE** `server/services/alop-capabilities.mjs`:
```js
/**
 * alop-capabilities.mjs — sursa unică pentru "ce acțiuni se pot face" pe un ALOP,
 * oglindind EXACT logica de afișare din public/js/formular/alop.js → renderAlopDetail().
 *
 * ⚠️ Hint de AFIȘARE, NU autorizare. Mutațiile rămân păzite de rutele ALOP (org/comp/owner checks).
 * Funcție PURĂ (fără DB). Toate intrările sunt date server (nu există stare client gen hasPdf).
 */
export function computeAlopCapabilities(alop, actor) {
  const caps = {
    is_owner: false,
    is_completed: false,
    is_cancelled: false,
    df_action: null,        // 'completeaza'|'revizuieste_neaprobat'|'deschide'|'in_lucru_disabled'|'flow_waiting'
    phase_action: null,     // 'confirma_lichidare'|'completeaza_ord'|'genereaza_lanseaza_ord'|'marcheaza_ord_semnat'|'confirma_plata'
    can_revise_df: false,
    can_delete: false,
    can_start_noua_ordonantare: false,
    can_refresh: false,
  };
  if (!alop) return caps;

  const status = alop.status;
  caps.is_completed = status === 'completed';
  caps.is_cancelled = status === 'cancelled';
  caps.is_owner = String(alop.created_by) === String(actor?.userId)
    || actor?.role === 'admin' || actor?.role === 'org_admin';

  // În afara owner-gate (mirror exact: refresh + nouă ordonanțare nu sunt owner-gated)
  caps.can_refresh = !caps.is_completed && !caps.is_cancelled;
  caps.can_start_noua_ordonantare = caps.is_completed && parseFloat(alop.ramas || 0) > 0;

  if (caps.is_completed || caps.is_cancelled || !caps.is_owner) return caps;

  // DF action (7-way, primul match)
  const dfStatus = alop.df_status || '';
  if (alop.df_revizie_in_lucru) caps.df_action = 'in_lucru_disabled';
  else if (!alop.df_id) caps.df_action = 'completeaza';
  else if (dfStatus === 'neaprobat') caps.df_action = 'revizuieste_neaprobat';
  else if (status === 'angajare' && alop.df_flow_id) caps.df_action = 'flow_waiting';
  else if (['aprobat', 'transmis_flux', 'de_revizuit'].includes(dfStatus)) caps.df_action = 'deschide';
  else if (alop.df_id && !alop.df_flow_id) caps.df_action = 'deschide';
  else caps.df_action = 'completeaza';

  // Phase action (primul match) + can_revise_df
  if (status === 'lichidare' && !alop.lichidare_confirmed_at) {
    caps.phase_action = 'confirma_lichidare'; caps.can_revise_df = !!alop.df_id;
  } else if (status === 'ordonantare' && !alop.ord_id) {
    caps.phase_action = 'completeaza_ord'; caps.can_revise_df = !!alop.df_id;
  } else if (status === 'ordonantare' && alop.ord_id && !alop.ord_flow_id) {
    caps.phase_action = 'genereaza_lanseaza_ord'; caps.can_revise_df = !!alop.df_id;
  } else if (status === 'ordonantare' && alop.ord_flow_id && !alop.ord_completed_at) {
    caps.phase_action = 'marcheaza_ord_semnat';
  } else if (status === 'plata') {
    caps.phase_action = 'confirma_plata';
  }

  caps.can_delete = !alop.df_id && !alop.ord_id;
  return caps;
}
```

---

## Patch 2 — `server/routes/alop.mjs`: import + atașare pe detaliu + `can_delete` pe listă

### 2a — import (lângă celelalte importuri sus în fișier)

Adaugă (sub importurile existente de servicii/helpers):
```js
import { computeAlopCapabilities } from '../services/alop-capabilities.mjs';
```

### 2b — detail endpoint (`GET /api/alop/:id`): atașează `capabilities` după `ramas`

**old_str**
```
    const dfVal = parseFloat(alop.df_valoare || 0);
    const sumaPlatita = parseFloat(alop.suma_platita_total || 0);
    alop.ramas = dfVal > 0 ? Math.max(0, dfVal - sumaPlatita) : 0;

    res.json({ alop });
```
**new_str**
```
    const dfVal = parseFloat(alop.df_valoare || 0);
    const sumaPlatita = parseFloat(alop.suma_platita_total || 0);
    alop.ramas = dfVal > 0 ? Math.max(0, dfVal - sumaPlatita) : 0;

    alop.capabilities = computeAlopCapabilities(alop, actor);
    res.json({ alop });
```

### 2c — list endpoint: `can_delete` în SQL (mirror exact al `canCancel` din listă — FĂRĂ owner)

**old_str**
```
        EXISTS (
          SELECT 1 FROM opme_lines ol WHERE ol.matched_alop_id = a.id
        ) AS has_opme_lines
      FROM alop_instances a
```
**new_str**
```
        EXISTS (
          SELECT 1 FROM opme_lines ol WHERE ol.matched_alop_id = a.id
        ) AS has_opme_lines,
        (a.status NOT IN ('completed','cancelled') AND a.df_id IS NULL AND a.ord_id IS NULL) AS can_delete
      FROM alop_instances a
```

---

## Patch 3 — fișier nou `server/tests/unit/alop-capabilities.test.mjs` (lock matrice)

**CREATE** `server/tests/unit/alop-capabilities.test.mjs`:
```js
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
```

---

## Patch 4 — fișier nou `server/tests/db/alop-capabilities.test.mjs` (caracterizare)

**CREATE** `server/tests/db/alop-capabilities.test.mjs`:
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/alop/:id → alop.capabilities (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ALOP draft fără DF/ORD → df_action=completeaza, can_delete=true', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const c = res.body.alop.capabilities;
    expect(c).toBeTruthy();
    expect(c.df_action).toBe('completeaza');
    expect(c.can_delete).toBe(true);
    expect(c.can_refresh).toBe(true);
  });

  it('ALOP lichidare cu DF aprobat → confirma_lichidare + can_revise_df + can_delete=false', async () => {
    const fid = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fid });
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: fid });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    const c = res.body.alop.capabilities;
    expect(c.phase_action).toBe('confirma_lichidare');
    expect(c.can_revise_df).toBe(true);
    expect(c.df_action).toBe('deschide');
    expect(c.can_delete).toBe(false);
  });

  it('ALOP ordonantare fără ORD → completeaza_ord', async () => {
    const fid = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fid });
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, dfFlowId: fid });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    expect(res.body.alop.capabilities.phase_action).toBe('completeaza_ord');
  });

  it('ALOP plata → confirma_plata', async () => {
    const fid = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fid });
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', dfId, dfFlowId: fid, ordId: null });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    expect(res.body.alop.capabilities.phase_action).toBe('confirma_plata');
  });

  it('lista → can_delete pe rânduri active fără DF/ORD', async () => {
    await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop[0].can_delete).toBe(true);
  });
});
```

> Dacă `seedAlop` nu acceptă vreun câmp (ex. `dfFlowId`), adaptează apelul la signatura reală din
> `db-real.mjs` (NU helperul). Pentru `lichidare`/`ordonantare`/`plata`, `lichidare_confirmed_at` și
> `ord_completed_at` rămân NULL implicit (corect pentru cazurile testate).

---

## Patch 5 — `package.json`: version bump

**old_str**
```
  "version": "3.9.526",
```
**new_str**
```
  "version": "3.9.527",
```

---

## Verificări

```bash
node --check server/services/alop-capabilities.mjs
node --check server/tests/unit/alop-capabilities.test.mjs

grep -c "computeAlopCapabilities" server/routes/alop.mjs   # 1 import + 1 atașare = 2
grep -n "AS can_delete" server/routes/alop.mjs             # 1 (lista)

npm test   # verde; raportează noul total (778 + testele unitare ALOP)

npm run db:test:up
export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db   # verde, inclusiv alop-capabilities (5 cazuri)
npm run db:test:down ; unset TEST_DATABASE_URL

git diff --name-only | grep -E "^public/" ; echo "↑ trebuie GOL (3a nu atinge frontend)"
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.526 → 3.9.527
- [ ] Patch 1: `alop-capabilities.mjs` (funcție pură; df_action 7-way, phase_action 5-way)
- [ ] Patch 2: import + `alop.capabilities` pe detaliu + `can_delete` pe listă (SQL, fără owner — 1:1)
- [ ] Patch 3: teste unitare (owner/terminal, df_action, phase_action, can_delete)
- [ ] Patch 4: caracterizare DB (draft/lichidare/ordonantare/plata + listă)
- [ ] `npm test` verde (raportează nr.); niciun test existent picat
- [ ] `npm run test:db` verde (raportează nr.)
- [ ] `git diff` fără `public/**`, fără fișiere de semnare
- [ ] commit + push **doar pe develop** → CI verde

Commit sugerat:
```
feat(alop): capabilities server-side (Etapa 3a, aditiv) — matrice acțiuni ALOP

- alop-capabilities.mjs: funcție pură oglindind renderAlopDetail (df_action 7-way, phase_action 5-way, delete, revise, refresh, nouă ordonanțare)
- atașat alop.capabilities pe GET detaliu + can_delete pe listă (SQL, fără owner — 1:1 cu codul actual)
- teste unitare (toate ramurile) + caracterizare pe Postgres real
- frontend neatins; pregătește 3b (renderAlopDetail citește din caps)
- v3.9.527
```
```

---

## Ce urmează (3b — frontend)

`alop.js`: `renderAlopDetail` consumă `a.capabilities` — `df_action`/`phase_action` (enum) aleg butonul
(label+icon+onclick rămân client, prezentare), `can_revise_df`/`can_delete`/`can_start_noua_ordonantare`/
`can_refresh` gate-uiesc butoanele; lista folosește `a.can_delete`. Fără staleness (ALOP re-fetch via
openAlop), deci 3b e o singură trecere. Plus verificare vizuală pe staging pe toate fazele.
