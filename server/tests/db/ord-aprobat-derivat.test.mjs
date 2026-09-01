/**
 * #166 — Aprobarea DERIVATĂ pe ramura ORD + cele patru rute de DETALIU.
 *
 * #165 a mutat pe sursa unică (`services/df-aprobat-sql.mjs`) doar ramura DF din `shared.mjs`.
 * Aceeași formă laxă trăia încă în:
 *   - ramura ORD din `shared.mjs` (fragment de filtru `_foAprobat`, coloana `aprobat`, `badge_status`);
 *   - `GET /api/formulare-df` (`df.mjs`) — nici măcar `f.deleted_at IS NULL`;
 *   - cele patru rute de DETALIU (df detaliu + df /xml + ord detaliu + ord /xml), care aveau
 *     `deleted_at` dar NU `cancelled`/`refused` ⇒ prindeau anularea ADMINISTRATIVĂ (soft-delete)
 *     și ratau anularea OBIȘNUITĂ (doar `status='cancelled'`, fluxul rămâne viu în tabel).
 *
 * Un flux anulat păstrează `completed:true` în JSONB (istoric intenționat, #164) ⇒ documentul
 * rămânea „Aprobat", iar `computeDocCapabilities` ieșea devreme pe `if (aprobat)` (fără `can_reopen`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { computeDocCapabilities } from '../../services/formular-capabilities.mjs';

const d = describe.skipIf(!hasTestDb());

const ACTOR = { userId: 1, role: 'org_admin', orgId: 1, email: 'p1@x.ro' };

async function setFlowStatus(flowId, status) {
  await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', to_jsonb($2::text)) WHERE id=$1`,
    [flowId, status]);
}
async function softDeleteFlow(flowId) {
  await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id=$1`, [flowId]);
}
// Anulare ADMINISTRATIVĂ: cancelled + soft-delete, `completed:true` păstrat ca istoric (#164).
async function adminCancelFlow(flowId) {
  await setFlowStatus(flowId, 'cancelled');
  await softDeleteFlow(flowId);
}
// Anulare OBIȘNUITĂ: DOAR `status='cancelled'`, fluxul rămâne viu (fără soft-delete).
// Ăsta e cazul pe care rutele de detaliu îl ratau — aveau doar garda pe `deleted_at`.
async function cancelFlow(flowId) {
  await setFlowStatus(flowId, 'cancelled');
}

d('#166 — aprobarea derivată ORD + rutele de detaliu trec pe sursa unică', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie(ACTOR);

  const listAll = async () => {
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.rows;
  };
  const listBy = async (status) => {
    const res = await request(app).get(`/api/formulare/list?type=ord&status=${status}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.rows;
  };
  const capsOf = (row) => computeDocCapabilities(row, ACTOR, 'ord', '');

  // ── 1. ne-regresie: flux VIU finalizat ───────────────────────────────────────
  it('1. flux VIU și completat ⇒ aprobat=true, badge aprobat, apare la filtrul „Aprobat"', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-166-001' });

    const row = (await listAll()).find(r => r.id === ordId);
    expect(row.aprobat).toBe(true);
    expect(row.badge_status).toBe('aprobat');
    expect((await listBy('aprobat')).some(r => r.id === ordId)).toBe(true);
  });

  // ── 2. ⭐ anulare ADMINISTRATIVĂ ─────────────────────────────────────────────
  it('2. ⭐ flux anulat ADMINISTRATIV (soft-delete + cancelled, completed:true păstrat) ⇒ NU e aprobat', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-166-002' });
    await adminCancelFlow(flowId);

    const row = (await listAll()).find(r => r.id === ordId);
    expect(row.aprobat).toBe(false);
    expect(row.badge_status).not.toBe('aprobat');
    expect(row.badge_status).toBe('completed');
    expect((await listBy('aprobat')).some(r => r.id === ordId)).toBe(false);
  });

  // ── 3. ⭐ anulare OBIȘNUITĂ (cazul ratat de rutele de detaliu) ───────────────
  it('3. ⭐ flux anulat OBIȘNUIT (cancelled, FĂRĂ soft-delete, completed:true păstrat) ⇒ identic cu (2)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-166-003' });
    await cancelFlow(flowId);

    const row = (await listAll()).find(r => r.id === ordId);
    expect(row.aprobat).toBe(false);
    expect(row.badge_status).not.toBe('aprobat');
    expect((await listBy('aprobat')).some(r => r.id === ordId)).toBe(false);
  });

  // ── 4. ⭐ flux REFUZAT care poartă completed:true ────────────────────────────
  it('4. ⭐ flux refuzat cu completed:true ⇒ nu e aprobat, badge neaprobat (ramura _foRespins)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-166-004' });
    await setFlowStatus(flowId, 'refused');

    const row = (await listAll()).find(r => r.id === ordId);
    expect(row.aprobat).toBe(false);
    expect(row.badge_status).toBe('neaprobat');
    expect((await listBy('neaprobat')).some(r => r.id === ordId)).toBe(true);
    expect((await listBy('aprobat')).some(r => r.id === ordId)).toBe(false);
  });

  // ── 5. fără flux ────────────────────────────────────────────────────────────
  it('5. ORD fără flux ⇒ aprobat=false, badge = status brut, fără eroare', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft', nrOrd: 'ORD-166-005' });

    const row = (await listAll()).find(r => r.id === ordId);
    expect(row.aprobat).toBe(false);
    expect(row.badge_status).toBe('draft');
  });

  // ── 6. ⭐ paritate filtru ⟺ badge, EXHAUSTIV ────────────────────────────────
  it('6. ⭐ PARITATE filtru⟺badge: pentru fiecare stare, mulțimea de id-uri din filtru = mulțimea cu badge_status egal', async () => {
    // (a) flux viu finalizat → aprobat
    const fA = await seedFlow({ orgId, completed: true });
    const idA = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: fA, nrOrd: 'ORD-166-P-A' });
    // (b) flux anulat ADMINISTRATIV, completed:true → NU aprobat
    const fB = await seedFlow({ orgId, completed: true });
    const idB = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: fB, nrOrd: 'ORD-166-P-B' });
    await adminCancelFlow(fB);
    // (c) flux anulat OBIȘNUIT, completed:true → NU aprobat
    const fC = await seedFlow({ orgId, completed: true });
    const idC = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: fC, nrOrd: 'ORD-166-P-C' });
    await cancelFlow(fC);
    // (d) flux refuzat cu completed:true → neaprobat
    const fD = await seedFlow({ orgId, completed: true });
    const idD = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: fD, nrOrd: 'ORD-166-P-D' });
    await setFlowStatus(fD, 'refused');
    // (e) flux activ nefinalizat → transmis_flux
    const fE = await seedFlow({ orgId, completed: false });
    const idE = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: fE, nrOrd: 'ORD-166-P-E' });
    // (f) stări brute, fără flux
    const idF1 = await seedOrd({ orgId, createdBy: userId, status: 'draft',      nrOrd: 'ORD-166-P-F1' });
    const idF2 = await seedOrd({ orgId, createdBy: userId, status: 'pending_p2', nrOrd: 'ORD-166-P-F2' });
    const idF3 = await seedOrd({ orgId, createdBy: userId, status: 'returnat',   nrOrd: 'ORD-166-P-F3' });
    const toate = [idA, idB, idC, idD, idE, idF1, idF2, idF3];

    const all = await listAll();
    expect(all.length).toBe(toate.length);

    const badge = Object.fromEntries(all.map(r => [r.id, r.badge_status]));
    expect(badge[idA]).toBe('aprobat');
    expect(badge[idB]).toBe('completed');   // anulare administrativă
    expect(badge[idC]).toBe('completed');   // anulare obișnuită
    expect(badge[idD]).toBe('neaprobat');
    expect(badge[idE]).toBe('transmis_flux');

    const statusuri = ['aprobat', 'neaprobat', 'transmis_flux', 'completed',
                       'draft', 'pending_p2', 'returnat'];
    for (const st of statusuri) {
      const dinFiltru = [...new Set((await listBy(st)).map(r => r.id))].sort();
      const dinBadge  = [...new Set(all.filter(r => r.badge_status === st).map(r => r.id))].sort();
      expect(dinFiltru, `filtru status=${st}`).toEqual(dinBadge);
    }

    // Acoperire completă, fără suprapunere.
    const acoperite = [];
    for (const st of statusuri) acoperite.push(...(await listBy(st)).map(r => r.id));
    expect(acoperite.slice().sort()).toEqual(toate.slice().sort());
  });

  // ── 7. ⭐ capabilities pe rândul de listă al cazului (2) ─────────────────────
  it('7. ⭐ computeDocCapabilities pe ORD cu flux anulat administrativ ⇒ can_reopen disponibil', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-166-007' });
    await adminCancelFlow(flowId);

    const row = (await listAll()).find(r => r.id === ordId);
    const caps = capsOf(row);
    expect(caps.aprobat).toBe(false);
    expect(caps.can_reopen).toBe(true);
  });

  // ── 8. ⭐ rutele de DETALIU pentru cazul (3) — anulare OBIȘNUITĂ ─────────────
  it('8. ⭐ GET /api/formulare-ord/:id și /api/formulare-df/:id întorc aprobat=false pe flux anulat OBIȘNUIT', async () => {
    const fOrd = await seedFlow({ orgId, completed: true });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: fOrd, nrOrd: 'ORD-166-008' });
    await cancelFlow(fOrd);

    const fDf = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: fDf, nrUnic: 'DF-166-008' });
    await cancelFlow(fDf);

    const rOrd = await request(app).get(`/api/formulare-ord/${ordId}`).set('Cookie', cookie());
    expect(rOrd.status).toBe(200);
    expect(rOrd.body.document.aprobat).toBe(false);

    const rDf = await request(app).get(`/api/formulare-df/${dfId}`).set('Cookie', cookie());
    expect(rDf.status).toBe(200);
    expect(rDf.body.document.aprobat).toBe(false);
  });
});
