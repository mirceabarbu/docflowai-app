/**
 * #165 — Aprobarea DERIVATĂ (`fd.flow_id` + starea fluxului) ține cont de fluxul DESFĂCUT.
 *
 * Incidentul DF 46149 (31.08.2026): după o anulare administrativă corectă (flux soft-șters,
 * `status='cancelled'`, `completed:true` PĂSTRAT ca istoric), documentul rămânea „Aprobat" în
 * listă, iar `computeDocCapabilities` ieșea devreme pe ramura `if (aprobat)` ⇒ nicio acțiune
 * de relansare. Cauza: predicatul lax din `shared.mjs` (fragment de filtru + coloana `aprobat`
 * + `badge_status`) și din `POST /api/formulare-df/:id/revizuieste` (`df.mjs`), care nu
 * verificau nici `f.deleted_at IS NULL`, nici `status <> 'cancelled'`.
 *
 * Sursa unică de adevăr: `services/df-aprobat-sql.mjs` → `dfAprobatSql(fd, f)`.
 *
 * Testul acoperă simultan cele trei fețe ale aceleiași derivări: `badge_status`, apartenența
 * la filtrul `status=...` (PARITATE filtru⟺badge) și `capabilities` calculate pe rândul listei.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
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
// Anulare administrativă „ca în producție": flux soft-șters + cancelled, dar `completed:true`
// rămâne în JSONB (istoric corect și intenționat — vezi #164).
async function adminCancelFlow(flowId) {
  await setFlowStatus(flowId, 'cancelled');
  await pool.query(`UPDATE flows SET data = jsonb_set(data, '{adminCancelled}', 'true'::jsonb) WHERE id=$1`, [flowId]);
  await softDeleteFlow(flowId);
}

d('#165 — aprobarea derivată DF ține cont de fluxul desfăcut', () => {
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
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.rows;
  };
  const listBy = async (status) => {
    const res = await request(app).get(`/api/formulare/list?type=df&status=${status}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.rows;
  };
  const capsOf = (row) => computeDocCapabilities(row, ACTOR, 'notafd', '');

  // ── 1. comportamentul normal, ne-regresie ────────────────────────────────────
  it('1. flux VIU și completat ⇒ badge aprobat, apare la filtrul „Aprobat", caps.aprobat=true', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId, nrUnic: 'DF-165-001' });

    const row = (await listAll()).find(r => r.id === dfId);
    expect(row.badge_status).toBe('aprobat');
    expect(row.aprobat).toBe(true);
    expect((await listBy('aprobat')).some(r => r.id === dfId)).toBe(true);
    expect(capsOf(row).aprobat).toBe(true);
  });

  // ── 2. ⭐ cazul DF 46149: flux SOFT-ȘTERS, completed:true păstrat ─────────────
  it('2. ⭐ flux SOFT-ȘTERS cu completed:true ⇒ NU e aprobat (badge, filtru, caps) și relansarea e disponibilă', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId, nrUnic: 'DF-165-002' });
    await softDeleteFlow(flowId);

    const row = (await listAll()).find(r => r.id === dfId);
    expect(row.aprobat).toBe(false);
    expect(row.badge_status).not.toBe('aprobat');
    expect(row.badge_status).toBe('completed');
    expect((await listBy('aprobat')).some(r => r.id === dfId)).toBe(false);

    const caps = capsOf(row);
    expect(caps.aprobat).toBe(false);
    // Documentul nu mai e „închis" pe ramura aprobată ⇒ P1/admin îl poate redeschide/relansa.
    expect(caps.can_reopen).toBe(true);
  });

  // ── 3. ⭐ flux cancelled cu completed:true ───────────────────────────────────
  it('3. ⭐ flux status=cancelled cu completed:true ⇒ identic cu (2)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId, nrUnic: 'DF-165-003' });
    await setFlowStatus(flowId, 'cancelled');

    const row = (await listAll()).find(r => r.id === dfId);
    expect(row.aprobat).toBe(false);
    expect(row.badge_status).not.toBe('aprobat');
    expect((await listBy('aprobat')).some(r => r.id === dfId)).toBe(false);

    const caps = capsOf(row);
    expect(caps.aprobat).toBe(false);
    expect(caps.can_reopen).toBe(true);
  });

  // ── 4. ne-regresie `_dfRespins` ──────────────────────────────────────────────
  it('4. flux refused ⇒ badge neaprobat (predicatul de refuz neatins de #165)', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId, nrUnic: 'DF-165-004' });
    await setFlowStatus(flowId, 'refused');

    const row = (await listAll()).find(r => r.id === dfId);
    expect(row.badge_status).toBe('neaprobat');
    expect(row.aprobat).toBe(false);
    expect((await listBy('neaprobat')).some(r => r.id === dfId)).toBe(true);
    expect((await listBy('aprobat')).some(r => r.id === dfId)).toBe(false);
  });

  // ── 5. ne-regresie `_dfTransmis` ─────────────────────────────────────────────
  it('5. flux activ nefinalizat ⇒ badge transmis_flux (predicatul de transmitere neatins)', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId, nrUnic: 'DF-165-005' });

    const row = (await listAll()).find(r => r.id === dfId);
    expect(row.badge_status).toBe('transmis_flux');
    expect(row.aprobat).toBe(false);
    expect((await listBy('transmis_flux')).some(r => r.id === dfId)).toBe(true);
  });

  // ── 6. ⭐ paritate filtru ⟺ badge, EXHAUSTIV, pe un dataset cu toate stările ──
  it('6. ⭐ PARITATE filtru⟺badge: pentru fiecare stare, mulțimea de id-uri din filtru = mulțimea cu badge_status egal', async () => {
    // (a) flux viu completat → aprobat
    const fA = await seedFlow({ orgId, completed: true });
    const idA = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: fA, nrUnic: 'DF-165-P-A' });
    // (b) flux soft-șters, completed:true → NU aprobat
    const fB = await seedFlow({ orgId, completed: true });
    const idB = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: fB, nrUnic: 'DF-165-P-B' });
    await softDeleteFlow(fB);
    // (c) flux anulat administrativ (cancelled + soft-delete), completed:true → NU aprobat
    const fC = await seedFlow({ orgId, completed: true });
    const idC = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: fC, nrUnic: 'DF-165-P-C' });
    await adminCancelFlow(fC);
    // (d) flux refuzat → neaprobat
    const fD = await seedFlow({ orgId, completed: false });
    const idD = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: fD, nrUnic: 'DF-165-P-D' });
    await setFlowStatus(fD, 'refused');
    // (e) flux activ nefinalizat → transmis_flux
    const fE = await seedFlow({ orgId, completed: false });
    const idE = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: fE, nrUnic: 'DF-165-P-E' });
    // (f) stări brute, fără flux
    const idF1 = await seedDf({ orgId, createdBy: userId, status: 'draft',       nrUnic: 'DF-165-P-F1' });
    const idF2 = await seedDf({ orgId, createdBy: userId, status: 'pending_p2',  nrUnic: 'DF-165-P-F2' });
    const idF3 = await seedDf({ orgId, createdBy: userId, status: 'returnat',    nrUnic: 'DF-165-P-F3' });
    const idF4 = await seedDf({ orgId, createdBy: userId, status: 'de_revizuit', nrUnic: 'DF-165-P-F4' });
    const idF5 = await seedDf({ orgId, createdBy: userId, status: 'neaprobat',   nrUnic: 'DF-165-P-F5' });
    const toate = [idA, idB, idC, idD, idE, idF1, idF2, idF3, idF4, idF5];

    const all = await listAll();
    expect(all.length).toBe(toate.length);

    // Așteptările explicite pe badge (ancora semantică a parității)
    const badge = Object.fromEntries(all.map(r => [r.id, r.badge_status]));
    expect(badge[idA]).toBe('aprobat');
    expect(badge[idB]).toBe('completed');       // fluxul șters nu mai aprobă nimic
    expect(badge[idC]).toBe('completed');       // anulare administrativă
    expect(badge[idD]).toBe('neaprobat');
    expect(badge[idE]).toBe('transmis_flux');

    const statusuri = ['aprobat', 'neaprobat', 'transmis_flux', 'completed',
                       'draft', 'pending_p2', 'returnat', 'de_revizuit'];
    for (const st of statusuri) {
      const dinFiltru = [...new Set((await listBy(st)).map(r => r.id))].sort();
      const dinBadge  = [...new Set(all.filter(r => r.badge_status === st).map(r => r.id))].sort();
      expect(dinFiltru, `filtru status=${st}`).toEqual(dinBadge);
    }

    // Fiecare document apare în EXACT un filtru ⇒ acoperire completă, fără suprapunere.
    const acoperite = [];
    for (const st of statusuri) acoperite.push(...(await listBy(st)).map(r => r.id));
    expect(acoperite.slice().sort()).toEqual(toate.slice().sort());
  });

  // ── 7/8. `revizuieste` — aprobarea ca POARTĂ, nu ca etichetă ─────────────────
  it('7. ⭐ revizuieste pe DF cu flux ANULAT ADMINISTRATIV ⇒ nu mai e tratat ca aprobat (400)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId, nrUnic: 'DF-165-007' });
    await adminCancelFlow(flowId);

    const res = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`)
      .set('Cookie', cookie()).send({ motiv: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aprobate sau neaprobate/i);
    // Nicio revizie creată.
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM formulare_df WHERE parent_df_id=$1`, [dfId]);
    expect(rows[0].n).toBe(0);
  });

  it('8. revizuieste pe DF cu flux VIU completat ⇒ neschimbat (200, R1)', async () => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId, nrUnic: 'DF-165-008' });

    const res = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`)
      .set('Cookie', cookie()).send({ motiv: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.df.revizie_nr).toBe(1);
    expect(res.body.df.parent_df_id).toBe(dfId);
  });
});
