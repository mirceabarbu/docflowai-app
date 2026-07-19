# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): `signing.mjs`, `bulk-signing.mjs`, `cloud-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`.

---

## Obiectiv — Etapa 2a (backend ADITIV, zero risc de regresie frontend)

Mutăm regula „ce acțiuni sunt permise pe un DF/ORD" pe **server**, ca o **singură sursă de adevăr**,
oglindind EXACT logica actuală din `public/js/formular/doc.js` → `renderActions()` (magnetul de regresii:
`status × role × aprobat × flowId × revizie`). În această etapă DOAR:
- creăm funcția pură de capabilities + teste unitare (lock pe comportamentul actual),
- o atașăm pe endpoint-urile de detaliu DF/ORD ca obiect `capabilities` (ADITIV — nu ștergem nimic),
- adăugăm un test de caracterizare pe Postgres real.

**Frontend-ul NU se atinge.** `renderActions` rămâne neschimbat. Câmpurile existente din răspuns
(`aprobat`, `flow_id`, `has_newer_revision`, etc.) rămân neschimbate. Adăugăm doar `document.capabilities`.
(Etapa 2b va face `renderActions` să citească din `capabilities`; 2c va curăța.)

### Distincție importantă (de pus în header-ul modulului)

`capabilities` = hint de **afișare** (ce butoane arătăm), NU autorizare. Mutațiile rămân păzite de
`authz-formular.mjs` (`canEditFormular`/`canDestroyOnly`) pe rutele POST/PUT. Capabilities nu înlocuiește
autorizarea — doar oglindește ce decide acum `renderActions` în client.

### Maparea exactă renderActions → capabilities (ordinea de scurtcircuit CONTEAZĂ)

Ordinea de evaluare (identică cu `renderActions`, primul match câștigă):
1. `ft==='notafd' && status==='neaprobat'`:
   - `has_newer_revision` (areNoua) → fără acțiuni (revizie istorică) → `is_historic_revision=true`
   - altfel → `can_revise=true`
2. `ft==='notafd' && status==='de_revizuit'` → `can_send_p2=true`, `can_reset=true`
3. `aprobat` → `can_download_signed = !!flowId`, `can_revise = (ft==='notafd' && !areNoua)`, `is_historic_revision = (ft==='notafd' && areNoua)`
4. `!docId` (form nesalvat — doar client) → `can_send_p2=true`, `can_reset=true`
5. `status==='draft' && role==='p1'` → `can_send_p2=true`, `can_reset=true`
6. `status==='returnat' && role==='p1'` → `can_send_p2=true`
7. `status==='pending_p2' && role==='p2'` → `can_save=true`, `can_complete_p2=true`, `can_return=true`
8. `status==='pending_p2' && role==='p1'` → `is_waiting_p2=true`
9. `status==='completed' && role==='p1'` → `can_generate_or_launch=true` (split Generează/Lansează rămâne client, după `hasPdf`)
10. `status==='transmis_flux'` → `is_on_flow=true`, `can_download_flux = !!flowId`
11. `status==='completed' && role==='p2'` → `is_completed_p2=true`
12. fallback → `can_send_p2=true`, `can_reset=true`

`role` derivat IDENTIC cu doc.js (linia 462): `created_by===actor.userId ? 'p1' : assigned_to===actor.userId ? 'p2' : 'view'`.
`aprobat` derivat IDENTIC cu doc.js (linia 464): `doc.aprobat===true || doc.status==='aprobat'`.

---

## Patch 1 — fișier nou `server/services/formular-capabilities.mjs`

**CREATE** `server/services/formular-capabilities.mjs`:
```js
/**
 * formular-capabilities.mjs — sursa unică de adevăr pentru "ce acțiuni se pot face"
 * pe un DF/ORD, oglindind EXACT logica de afișare din public/js/formular/doc.js → renderActions().
 *
 * ⚠️ Acesta este un hint de AFIȘARE, NU autorizare. Mutațiile rămân păzite de
 *    authz-formular.mjs (canEditFormular/canDestroyOnly) pe rutele POST/PUT.
 *
 * Funcție PURĂ (fără DB, fără I/O) → ușor de testat și imposibil de divergat între liste/detaliu.
 * Singura intrare ne-derivabilă pe server (hasPdf — blob generat în client) NU e tratată aici;
 * frontend-ul decide split-ul Generează/Lansează pe baza lui can_generate_or_launch + hasPdf local.
 */

/** Rol identic cu doc.js: 'p1' (creator) | 'p2' (assigned) | 'view'. */
export function deriveDocRole(doc, actor) {
  const uid = actor?.userId;
  if (doc?.created_by === uid) return 'p1';
  if (doc?.assigned_to === uid) return 'p2';
  return 'view';
}

function emptyCaps() {
  return {
    can_send_p2: false,
    can_reset: false,
    can_save: false,
    can_complete_p2: false,
    can_return: false,
    can_generate_or_launch: false,
    can_revise: false,
    can_download_signed: false,
    can_download_flux: false,
    // flags informaționale (pentru alegerea bannerelor în frontend — oglindesc doc.js)
    aprobat: false,
    is_neaprobat: false,
    is_de_revizuit: false,
    is_on_flow: false,
    is_waiting_p2: false,
    is_completed_p2: false,
    is_historic_revision: false,
    revizie_nr: 0,
    latest_revizie_nr: 0,
  };
}

/**
 * @param {object} doc  — rândul DF/ORD (status, created_by, assigned_to, aprobat, flow_id,
 *                        revizie_nr, has_newer_revision, latest_revizie_nr, ...)
 * @param {object} actor — { userId, role, orgId }
 * @param {'notafd'|'ordnt'} ft — tip formular (DF=notafd, ORD=ordnt)
 * @returns {object} capabilities
 */
export function computeDocCapabilities(doc, actor, ft) {
  const caps = emptyCaps();
  if (!doc) return caps;

  const status   = doc.status;
  const role     = deriveDocRole(doc, actor);
  const docId    = doc.id || null;
  const flowId   = doc.flow_id || null;
  const aprobat  = doc.aprobat === true || status === 'aprobat';
  const revNr    = doc.revizie_nr || 0;
  const latest   = doc.latest_revizie_nr || 0;
  const areNoua  = doc.has_newer_revision === true; // doar notafd are câmpul
  const isNotafd = ft === 'notafd';

  caps.aprobat = aprobat;
  caps.revizie_nr = revNr;
  caps.latest_revizie_nr = latest;
  caps.is_on_flow = status === 'transmis_flux';
  caps.is_neaprobat = isNotafd && status === 'neaprobat';
  caps.is_de_revizuit = isNotafd && status === 'de_revizuit';

  // Ordinea de scurtcircuit identică cu renderActions (primul match câștigă):
  if (isNotafd && status === 'neaprobat') {
    if (areNoua) { caps.is_historic_revision = true; }
    else { caps.can_revise = true; }
    return caps;
  }
  if (isNotafd && status === 'de_revizuit') {
    caps.can_send_p2 = true;
    caps.can_reset = true;
    return caps;
  }
  if (aprobat) {
    caps.can_download_signed = !!flowId;
    caps.can_revise = isNotafd && !areNoua;
    caps.is_historic_revision = isNotafd && areNoua;
    return caps;
  }
  if (!docId) {
    caps.can_send_p2 = true;
    caps.can_reset = true;
    return caps;
  }
  if (status === 'draft' && role === 'p1') {
    caps.can_send_p2 = true;
    caps.can_reset = true;
    return caps;
  }
  if (status === 'returnat' && role === 'p1') {
    caps.can_send_p2 = true;
    return caps;
  }
  if (status === 'pending_p2' && role === 'p2') {
    caps.can_save = true;
    caps.can_complete_p2 = true;
    caps.can_return = true;
    return caps;
  }
  if (status === 'pending_p2' && role === 'p1') {
    caps.is_waiting_p2 = true;
    return caps;
  }
  if (status === 'completed' && role === 'p1') {
    caps.can_generate_or_launch = true;
    return caps;
  }
  if (status === 'transmis_flux') {
    caps.is_on_flow = true;
    caps.can_download_flux = !!flowId;
    return caps;
  }
  if (status === 'completed' && role === 'p2') {
    caps.is_completed_p2 = true;
    return caps;
  }
  // fallback (identic cu else-ul din renderActions)
  caps.can_send_p2 = true;
  caps.can_reset = true;
  return caps;
}
```

---

## Patch 2 — `server/routes/formulare-db.mjs`: import + atașează `capabilities` pe detaliu DF/ORD

### 2a — import (lângă celelalte importuri de servicii, sus în fișier)

Găsește importul existent al `authz-formular.mjs` și adaugă sub el:

**old_str**
```
import { canViewFormular, canEditFormular, canDestroyOnly, loadActorComp } from '../services/authz-formular.mjs';
```
**new_str**
```
import { canViewFormular, canEditFormular, canDestroyOnly, loadActorComp } from '../services/authz-formular.mjs';
import { computeDocCapabilities } from '../services/formular-capabilities.mjs';
```

> Dacă signatura importului `authz-formular.mjs` diferă (alte nume/ordine), păstrează linia existentă
> neschimbată și adaugă DOAR linia nouă `import { computeDocCapabilities } ...` imediat sub ea.

### 2b — DF detail (ruta `GET /api/formulare-df/:id`)

**old_str**
```
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const view = await canViewFormular(pool, actor, doc, actorComp);
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df get error');
```
**new_str**
```
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const view = await canViewFormular(pool, actor, doc, actorComp);
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    doc.capabilities = computeDocCapabilities(doc, actor, 'notafd');
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-df get error');
```

### 2c — ORD detail (ruta `GET /api/formulare-ord/:id`)

**old_str**
```
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const view = await canViewFormular(pool, actor, doc, actorComp);
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord get error');
```
**new_str**
```
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const view = await canViewFormular(pool, actor, doc, actorComp);
      if (!view.allowed) return res.status(403).json({ error: view.reason });
    }
    doc.capabilities = computeDocCapabilities(doc, actor, 'ordnt');
    res.json({ ok: true, document: doc });
  } catch (e) {
    logger.error({ err: e }, 'formulare-ord get error');
```

> Cele două blocuri `old_str` sunt aproape identice — diferă prin mesajul de log
> (`formulare-df get error` vs `formulare-ord get error`), deci fiecare e unic. Aplică-le separat.

---

## Patch 3 — fișier nou `server/tests/unit/formular-capabilities.test.mjs` (lock comportament, mock tier)

**CREATE** `server/tests/unit/formular-capabilities.test.mjs`:
```js
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
```

---

## Patch 4 — fișier nou `server/tests/db/doc-capabilities.test.mjs` (caracterizare end-to-end)

**CREATE** `server/tests/db/doc-capabilities.test.mjs`:
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET detaliu DF/ORD → document.capabilities (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 }); // creator (id=1)

  it('DF draft → can_send_p2 + can_reset', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const c = res.body.document.capabilities;
    expect(c).toBeTruthy();
    expect(c.can_send_p2).toBe(true);
    expect(c.can_reset).toBe(true);
  });

  it('DF aprobat → download_signed + revise', async () => {
    const flowId = await seedFlowApproved();
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    const c = res.body.document.capabilities;
    expect(c.aprobat).toBe(true);
    expect(c.can_download_signed).toBe(true);
    expect(c.can_revise).toBe(true);
  });

  it('DF transmis_flux (neaprobat) → on_flow + download_flux', async () => {
    // flow NEcompletat
    const fid = `flow-pending-${Date.now()}`;
    await pool.query(`INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`, [fid, JSON.stringify({ status: 'in_progress' })]);
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: fid });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    const c = res.body.document.capabilities;
    expect(c.is_on_flow).toBe(true);
    expect(c.can_download_flux).toBe(true);
    expect(c.aprobat).toBe(false);
  });

  it('DF neaprobat → revise', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'neaprobat', revizieNr: 1 });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    const c = res.body.document.capabilities;
    expect(c.is_neaprobat).toBe(true);
    expect(c.can_revise).toBe(true);
  });

  it('ORD draft → can_send_p2; ORD aprobat → download_signed fără revise', async () => {
    const idDraft = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const r1 = await request(app).get(`/api/formulare-ord/${idDraft}`).set('Cookie', cookie());
    expect(r1.body.document.capabilities.can_send_p2).toBe(true);

    const flowId = await seedFlowApproved();
    const idApr = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });
    const r2 = await request(app).get(`/api/formulare-ord/${idApr}`).set('Cookie', cookie());
    const c = r2.body.document.capabilities;
    expect(c.can_download_signed).toBe(true);
    expect(c.can_revise).toBe(false);
  });
});
```

> NOTĂ: testul depinde de helperele din `server/tests/helpers/db-real.mjs` (`seedDf/seedOrd/seedFlowApproved`).
> Dacă signaturile lor s-au schimbat de la Etapa 1, adaptează apelurile (NU helperele).
> Dacă `canViewFormular` respinge creatorul în vreun caz, verifică seed-ul (created_by trebuie = userId din cookie = 1).

---

## Patch 5 — `package.json`: version bump

**old_str**
```
  "version": "3.9.521",
```
**new_str**
```
  "version": "3.9.522",
```

---

## Verificări

```bash
# Sintaxă
node --check server/services/formular-capabilities.mjs
node --check server/tests/unit/formular-capabilities.test.mjs

# Modulul e importat și atașat pe AMBELE detalii
grep -n "computeDocCapabilities" server/routes/formulare-db.mjs   # 1 import + 2 atașări = 3 hit-uri
grep -c "doc.capabilities = computeDocCapabilities" server/routes/formulare-db.mjs   # 2

# Suita mock — crește față de 758 DOAR prin testele unitare noi (zero eliminări)
npm test
#   → verde; raportează noul total (758 + testele din formular-capabilities.test.mjs).
#     NU trebuie să scadă sub 758 și niciun test existent să nu pice (capabilities e câmp ADITIV).

# Suita DB (Postgres real)
npm run db:test:up
export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db   # → 14 + cele din doc-capabilities.test.mjs, toate verzi
npm run db:test:down ; unset TEST_DATABASE_URL

# Frontend NEATINS
git diff --name-only | grep -E "^public/" ; echo "↑ trebuie GOL (Etapa 2a nu atinge frontend-ul)"

# NO-TOUCH semnare
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.521 → 3.9.522
- [ ] Patch 1: `formular-capabilities.mjs` (funcție pură, header „hint afișare, nu autorizare")
- [ ] Patch 2: import + `doc.capabilities` pe detaliu DF (`notafd`) și ORD (`ordnt`) — ADITIV
- [ ] Patch 3: teste unitare (lock pe toate ramurile renderActions + ordinea de scurtcircuit)
- [ ] Patch 4: test caracterizare pe Postgres real (capabilities consistent cu starea)
- [ ] `npm test` verde, total ≥ 758 (raportează noul nr.); niciun test existent picat
- [ ] `npm run test:db` verde (raportează nr.)
- [ ] `git diff --name-only` → fără `public/**`, fără fișiere de semnare
- [ ] commit + push **doar pe develop**

Commit sugerat:
```
feat(formulare): capabilities server-side (Etapa 2a, aditiv) — sursă unică pentru acțiuni DF/ORD

- formular-capabilities.mjs: funcție pură care oglindește EXACT renderActions (status×rol×aprobat×flux×revizie)
- atașat document.capabilities pe GET detaliu DF (notafd) + ORD (ordnt) — ADITIV, frontend neatins
- teste unitare (toate ramurile + ordinea de scurtcircuit completed+aprobat) + caracterizare pe Postgres real
- pregătește Etapa 2b (renderActions citește din capabilities) + 2c (curățenie)
- v3.9.522
```
```
