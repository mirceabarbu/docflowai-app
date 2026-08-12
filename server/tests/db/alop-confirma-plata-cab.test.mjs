/**
 * test:db — #126 Etapa B: confirmarea MANUALĂ a plății e rezervată compartimentului CAB.
 *
 * Înainte, `POST /api/alop/:id/confirma-plata` verifica doar `canEditAlop` ⇒ inițiatorul
 * dosarului își confirma singur plata. Cerință (separare de atribuții): doar utilizatorii
 * din `organizations.cab_compartiment`.
 *
 * ⛔ Fail-closed: CAB nesetat pe organizație ⇒ 409, nimic scris.
 * ⛔ `org_admin` NU e exceptat (separare de atribuții, nu poartă de tenant); `admin`
 *    (platform) e exceptat deliberat.
 * ⛔ Calea AUTOMATĂ (OPME → applyPlataConfirmedSideEffects) NU trece prin rută ⇒ neafectată.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { tryAutoConfirmAlop } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());

const CAB = 'Contabilitate';
const ALT = 'Achizitii';

async function getAlopRow(id) {
  const { rows } = await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id]);
  return rows[0];
}

d('#126 B — confirma-plata: doar compartimentul CAB', () => {
  let app, initiatorId, cabUserId, admUserId, orgAdminId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    // user 1 = inițiatorul dosarului, din alt compartiment decât CAB
    const { userId } = await seedOrgUser({ role: 'user', email: 'init@x.ro', compartiment: ALT });
    initiatorId = userId;
    cabUserId   = await seedUser({ orgId: 1, email: 'cab@x.ro',  compartiment: CAB, nume: 'CAB' });
    admUserId   = await seedUser({ orgId: 1, email: 'adm@x.ro',  role: 'admin',     compartiment: ALT, nume: 'ADM' });
    orgAdminId  = await seedUser({ orgId: 1, email: 'oadm@x.ro', role: 'org_admin', compartiment: ALT, nume: 'OADM' });
    await pool.query('UPDATE organizations SET cab_compartiment=$2 WHERE id=$1', [1, CAB]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user') => makeAuthCookie({ userId, role, orgId: 1, email: `u${userId}@x.ro` });

  // ALOP în status 'plata', cu ORD de 1000 (plafonul plată ≤ ordonanțat).
  async function seedAlopPlata() {
    const dfId  = await seedDf({ orgId: 1, createdBy: initiatorId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initiatorId, dfId,
      rows: [{ cod_angajament: 'AAB1', indicator_angajament: 'AAB', suma_ordonantata_plata: 1000 }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: initiatorId, status: 'plata',
      dfId, ordId, compartiment: ALT });
    return { alopId, ordId, dfId };
  }

  const payload = { nr_ordin_plata: 'OP-1', data_plata: '2026-08-01', suma_efectiva: 1000, observatii: 'x' };

  it('1. utilizator din CAB ⇒ 200, plata confirmată în DB', async () => {
    const { alopId } = await seedAlopPlata();
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(cabUserId)).send(payload);
    expect(res.status).toBe(200);
    const a = await getAlopRow(alopId);
    expect(a.plata_confirmed_at).not.toBeNull();
    expect(a.status).toBe('completed');
    expect(a.plata_source).toBe('manual');
  });

  it('2. inițiatorul dosarului (alt compartiment) ⇒ 403 doar_cab, plata_confirmed_at rămâne NULL în DB', async () => {
    const { alopId } = await seedAlopPlata();
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(initiatorId)).send(payload);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_cab');
    const a = await getAlopRow(alopId);
    expect(a.plata_confirmed_at).toBeNull();
    expect(a.status).toBe('plata');
  });

  // Actorul e INIȚIATORUL: e singurul care trece de `canEditAlop` când org-ul n-are CAB
  // (fără cab_compartiment, vizibilitatea „membru CAB" nu mai există) — deci e singurul
  // prin care se poate observa garda nouă. Un user CAB primește 403 de la canEditAlop,
  // înaintea ei: tot fail-closed, dar cu alt cod.
  it('3. cab_compartiment gol pe organizație ⇒ 409 cab_compartiment_nesetat, nimic scris (fail-closed)', async () => {
    await pool.query('UPDATE organizations SET cab_compartiment=NULL WHERE id=1');
    const { alopId } = await seedAlopPlata();
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(initiatorId)).send(payload);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cab_compartiment_nesetat');
    const a = await getAlopRow(alopId);
    expect(a.plata_confirmed_at).toBeNull();
    expect(a.status).toBe('plata');
  });

  it('4. admin (platform) din alt compartiment ⇒ 200 (excepție deliberată)', async () => {
    const { alopId } = await seedAlopPlata();
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(admUserId, 'admin')).send(payload);
    expect(res.status).toBe(200);
    expect((await getAlopRow(alopId)).plata_confirmed_at).not.toBeNull();
  });

  it('5. org_admin din alt compartiment ⇒ 403 doar_cab (separare de atribuții, nu poartă de tenant)', async () => {
    const { alopId } = await seedAlopPlata();
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(orgAdminId, 'org_admin')).send(payload);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_cab');
    expect((await getAlopRow(alopId)).plata_confirmed_at).toBeNull();
  });

  it('6. non-regresie: confirmarea AUTOMATĂ prin OPME nu e afectată de garda CAB', async () => {
    const { alopId, ordId } = await seedAlopPlata();
    await pool.query(`UPDATE formulare_ord SET cif_beneficiar='8971726' WHERE id=$1`, [ordId]);
    const { rows: imp } = await pool.query(
      `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
       VALUES (1,$1,'h-cab','f1129.pdf','0000130', DATE '2026-05-06') RETURNING id`, [initiatorId]);
    await pool.query(
      `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                               indicator_angajament, cif_beneficiar, suma_op)
       VALUES ($1,1,1,'123','AAB1','AAB','8971726',1000)`, [imp[0].id]);

    const out = await tryAutoConfirmAlop(alopId, { actorUserId: initiatorId });
    expect(out.confirmed).toBe(true);
    const a = await getAlopRow(alopId);
    expect(a.plata_source).toBe('opme_auto');
    expect(a.status).toBe('completed');
  });
});
