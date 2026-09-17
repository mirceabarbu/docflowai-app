/**
 * #217 — coloana „Responsabil CAB" din `GET /api/formulare/list` (DF + ORD) arată, pe
 * lângă atribuirea curentă (compartiment sau persoană), și ULTIMUL utilizator din
 * compartimentul CAB al organizației care a lucrat pe document: cel mai recent dintre
 * evenimentele din `formulare_audit` și ultima salvare (`updated_by`/`updated_at`).
 *
 * Regula CAB = isCabDept (TRIM, egalitate exactă, șir gol exclus), pe compartimentul de
 * AZI al utilizatorului, aceeași organizație cu documentul.
 *
 * La atribuire pe COMPARTIMENT: `p2_ultim_cab` apare mereu (dacă există un candidat).
 * La atribuire pe PERSOANĂ: apare DOAR dacă ultimul din CAB e ALT utilizator decât cel
 * atribuit — decizia se ia pe server (`NULL` explicit), nu în browser.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const CAB = 'Serviciul Buget';

async function insertAudit(orgId, formType, formId, actorId, createdAt, eventType = 'completat') {
  await pool.query(
    `INSERT INTO formulare_audit (org_id, form_type, form_id, actor_id, event_type, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, formType, formId, actorId, eventType, createdAt]
  );
}

async function touchUpdatedBy(table, id, userId, updatedAt) {
  await pool.query(`UPDATE ${table} SET updated_by=$1, updated_at=$2 WHERE id=$3`, [userId, updatedAt, id]);
}

function rowFor(rows, id) {
  return rows.find(r => String(r.id) === String(id));
}

d('#217 — ultimul din CAB care a lucrat pe document (liste DF/ORD)', () => {
  let app, orgId, initId, xId, yId, zId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();

    const s = await seedOrgUser({ orgName: 'Org 217', email: 'init@x.ro', role: 'user', compartiment: 'Serviciul Tehnic' });
    orgId = s.orgId; initId = s.userId;
    await pool.query(`UPDATE organizations SET cab_compartiment=$1 WHERE id=$2`, [CAB, orgId]);
    xId = await seedUser({ orgId, email: 'x@x.ro', role: 'user', compartiment: CAB, nume: 'X Popescu' });
    yId = await seedUser({ orgId, email: 'y@x.ro', role: 'user', compartiment: CAB, nume: 'Y Ionescu' });
    zId = await seedUser({ orgId, email: 'z@x.ro', role: 'user', compartiment: 'Achizitii', nume: 'Z Georgescu' });
  });
  afterAll(() => pool.end());

  const me = () => makeAuthCookie({ userId: initId, role: 'org_admin', orgId });
  const list = async (type, qs = '') => {
    const res = await request(app).get(`/api/formulare/list?type=${type}${qs}`).set('Cookie', me());
    expect(res.status).toBe(200);
    return res.body.rows;
  };

  // ── DF ──────────────────────────────────────────────────────────────

  it('1. ⭐ DF atribuit compartimentului; audit completat de X ⇒ p2_ultim_cab = X, cu p2_ultim_cab_at', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-1' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    const t = new Date('2026-01-01T10:00:00Z');
    await insertAudit(orgId, 'df', dfId, xId, t, 'completat');

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row).toHaveProperty('p2_ultim_cab');
    expect(row.p2_ultim_cab).toBe('X Popescu');
    expect(new Date(row.p2_ultim_cab_at).getTime()).toBe(t.getTime());
  });

  it('2. ⭐ apoi inițiatorul salvează (updated_by=init, mai nou) ⇒ rămâne X (init nu e CAB)', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-2' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    const t1 = new Date('2026-01-01T10:00:00Z');
    await insertAudit(orgId, 'df', dfId, xId, t1, 'completat');
    const t2 = new Date('2026-01-02T10:00:00Z');
    await touchUpdatedBy('formulare_df', dfId, initId, t2);

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row.p2_ultim_cab).toBe('X Popescu');
  });

  it('3. ⭐ apoi Y salvează (mai nou decât evenimentul lui X), fără eveniment ⇒ Y', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-3' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    const t1 = new Date('2026-01-01T10:00:00Z');
    await insertAudit(orgId, 'df', dfId, xId, t1, 'completat');
    const t2 = new Date('2026-01-03T10:00:00Z');
    await touchUpdatedBy('formulare_df', dfId, yId, t2);

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row.p2_ultim_cab).toBe('Y Ionescu');
  });

  it('4. ⭐ atribuit PERSOANEI X; audit completat de X ⇒ p2_ultim_cab null (aceeași persoană)', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-4', assignedTo: xId });
    const t = new Date('2026-01-01T10:00:00Z');
    await insertAudit(orgId, 'df', dfId, xId, t, 'completat');

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row).toHaveProperty('p2_ultim_cab');
    expect(row.p2_ultim_cab).toBeNull();
  });

  it('5. ⭐ atribuit persoanei X; audit completat de Y ⇒ Y', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-5', assignedTo: xId });
    const t = new Date('2026-01-01T10:00:00Z');
    await insertAudit(orgId, 'df', dfId, yId, t, 'completat');

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row.p2_ultim_cab).toBe('Y Ionescu');
  });

  it('6. evenimente doar de Z (non-CAB) și de un admin fără compartiment ⇒ null', async () => {
    const adminId = await seedUser({ orgId, email: 'admin@x.ro', role: 'admin', compartiment: '', nume: 'Admin Nimeni' });
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-6' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    await insertAudit(orgId, 'df', dfId, zId, new Date('2026-01-01T10:00:00Z'), 'completat');
    await insertAudit(orgId, 'df', dfId, adminId, new Date('2026-01-02T10:00:00Z'), 'returnat');

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row).toHaveProperty('p2_ultim_cab');
    expect(row.p2_ultim_cab).toBeNull();
  });

  it('7. X a lucrat, apoi X e mutat în alt compartiment ⇒ null (regula e pe compartimentul de azi)', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-7' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    await insertAudit(orgId, 'df', dfId, xId, new Date('2026-01-01T10:00:00Z'), 'completat');
    await pool.query(`UPDATE users SET compartiment=$1 WHERE id=$2`, ['Achizitii', xId]);

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row.p2_ultim_cab).toBeNull();
  });

  it('8. paritate TRIM (cab_compartiment/compartiment cu spații) + cab_compartiment gol/NULL ⇒ null', async () => {
    await pool.query(`UPDATE organizations SET cab_compartiment=$1 WHERE id=$2`, [' Serviciul Buget ', orgId]);
    await pool.query(`UPDATE users SET compartiment=$1 WHERE id=$2`, ['Serviciul Buget  ', xId]);
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-8' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    await insertAudit(orgId, 'df', dfId, xId, new Date('2026-01-01T10:00:00Z'), 'completat');

    let rows = await list('df');
    let row = rowFor(rows, dfId);
    expect(row.p2_ultim_cab).toBe('X Popescu');

    await pool.query(`UPDATE organizations SET cab_compartiment=NULL WHERE id=$1`, [orgId]);
    rows = await list('df');
    row = rowFor(rows, dfId);
    expect(row.p2_ultim_cab).toBeNull();
  });

  it('9. ⭐ filtru p2=<fragment nume X> găsește documentul atribuit compartimentului pe care a lucrat X; p2=Buget tot găsește (neregresie)', async () => {
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-9' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    await insertAudit(orgId, 'df', dfId, xId, new Date('2026-01-01T10:00:00Z'), 'completat');

    const byName = await list('df', '&p2=Popescu');
    expect(byName.map(r => String(r.id))).toContain(String(dfId));

    const byComp = await list('df', `&p2=${encodeURIComponent('Buget')}`);
    expect(byComp.map(r => String(r.id))).toContain(String(dfId));
  });

  it('10. utilizator din ALTĂ organizație cu compartiment „Serviciul Buget", eveniment pe document ⇒ ignorat', async () => {
    const other = await seedOrgUser({ orgName: 'Org 217b', email: 'w@other.ro', role: 'user', compartiment: CAB });
    const dfId = await seedDf({ orgId, createdBy: initId, status: 'completed', nrUnic: 'DF-10' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [CAB, dfId]);
    await insertAudit(orgId, 'df', dfId, other.userId, new Date('2026-01-01T10:00:00Z'), 'completat');

    const rows = await list('df');
    const row = rowFor(rows, dfId);
    expect(row).toHaveProperty('p2_ultim_cab');
    expect(row.p2_ultim_cab).toBeNull();
  });

  // ── ORD ─────────────────────────────────────────────────────────────

  it('11. ⭐ ORD atribuit compartimentului; audit completat de X ⇒ p2_ultim_cab = X', async () => {
    const ordId = await seedOrd({ orgId, createdBy: initId, status: 'completed', nrOrd: 'ORD-11' });
    await pool.query(`UPDATE formulare_ord SET p2_compartiment=$1 WHERE id=$2`, [CAB, ordId]);
    const t = new Date('2026-01-01T10:00:00Z');
    await insertAudit(orgId, 'ord', ordId, xId, t, 'completat');

    const rows = await list('ord');
    const row = rowFor(rows, ordId);
    expect(row).toHaveProperty('p2_ultim_cab');
    expect(row.p2_ultim_cab).toBe('X Popescu');
    expect(new Date(row.p2_ultim_cab_at).getTime()).toBe(t.getTime());
  });

  it('12. ⭐ ORD atribuit PERSOANEI X; audit completat de X ⇒ null', async () => {
    const ordId = await seedOrd({ orgId, createdBy: initId, status: 'completed', nrOrd: 'ORD-12', assignedTo: xId });
    await insertAudit(orgId, 'ord', ordId, xId, new Date('2026-01-01T10:00:00Z'), 'completat');

    const rows = await list('ord');
    const row = rowFor(rows, ordId);
    expect(row).toHaveProperty('p2_ultim_cab');
    expect(row.p2_ultim_cab).toBeNull();
  });
});
