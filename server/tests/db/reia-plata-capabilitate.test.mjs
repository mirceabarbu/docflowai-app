/**
 * test:db — #211: `capabilities.can_reia_plata` (GET /api/alop/:id), pe toate condițiile.
 *
 * Fix: `server/services/alop-capabilities.mjs:83` calcula `can_reia_plata` doar din
 * `caps.is_cab`, deși poarta rutei POST /api/alop/:id/plata/reia fusese deja lărgită la
 * `admin OR (org_admin cu orgId) OR isCabDept` la #210. Un `admin` nu vedea butonul „Reia
 * confirmarea plății", deși ruta l-ar fi acceptat.
 *
 * Testele 11–13 contează la fel de mult ca 5: lărgirea de rol NU are voie să slăbească
 * celelalte trei condiții din expresie (`is_completed`, `!is_cancelled`, `plata_confirmed_at`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const CAB = 'Contabilitate';
const ALT = 'Achizitii';
const CIF = '31306329';
const COD = 'AAB3AE5XPX3';
const IND = 'AAB';
const IBAN_ORD = 'RO49TREZ0000000000000001';
const TOTAL  = 20891.04;
const SUMA_B = 1726.53;

d('#211 — GET /api/alop/:id → capabilities.can_reia_plata', () => {
  let app, initId, cabId, altId, admId, oadmId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'init@x.ro', compartiment: ALT });
    initId = s.userId;
    cabId  = await seedUser({ orgId: 1, email: 'cab@x.ro',  compartiment: CAB, nume: 'CAB' });
    altId  = await seedUser({ orgId: 1, email: 'alt@x.ro',  compartiment: ALT, nume: 'ALT' });
    admId  = await seedUser({ orgId: 1, email: 'adm@x.ro',  role: 'admin',     compartiment: ALT, nume: 'ADM' });
    oadmId = await seedUser({ orgId: 1, email: 'oadm@x.ro', role: 'org_admin', compartiment: ALT, nume: 'OADM' });
    await pool.query('UPDATE organizations SET cab_compartiment=$2 WHERE id=$1', [1, CAB]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user', orgId = 1) => makeAuthCookie({ userId, role, orgId, email: `u${userId}@x.ro` });

  async function seedDosar({ status = 'completed', plataConfirmedAt = true, cancelledAt = null } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: TOTAL }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN_ORD]);
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status, dfId, ordId,
      compartiment: ALT, cicluCurent: 1, sumaTotalaPlatita: 5000, cancelledAt });
    if (plataConfirmedAt) {
      await pool.query(`UPDATE alop_instances SET
          completed_at=NOW(), plata_confirmed_at=NOW() - INTERVAL '1 hour', plata_confirmed_by=$2,
          plata_suma_efectiva=$3, plata_nr_ordin='2792', plata_data=DATE '2026-09-03',
          plata_source='manual', plata_observatii='obs', plata_notes='note'
        WHERE id=$1`, [alopId, cabId, SUMA_B]);
    }
    return alopId;
  }

  async function capOf(alopId, cookie) {
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie);
    return res;
  }

  it('5. ⭐ admin (platform), dosar completed cu plată confirmată ⇒ can_reia_plata: true', async () => {
    const alopId = await seedDosar();
    const res = await capOf(alopId, ck(admId, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities.can_reia_plata).toBe(true);
  });

  it('6. ⭐ org_admin cu orgId ⇒ can_reia_plata: true', async () => {
    const alopId = await seedDosar();
    const res = await capOf(alopId, ck(oadmId, 'org_admin'));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities.can_reia_plata).toBe(true);
  });

  it('7. cab_dept ⇒ can_reia_plata: true (neregresie #209)', async () => {
    const alopId = await seedDosar();
    const res = await capOf(alopId, ck(cabId));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities.can_reia_plata).toBe(true);
  });

  it('8. ⭐ inspector obișnuit (non-CAB, non-owner) ⇒ can_reia_plata: false', async () => {
    const alopId = await seedDosar();
    const res = await capOf(alopId, ck(altId));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities.can_reia_plata).toBe(false);
  });

  it('9. inițiatorul dosarului, care nu e CAB ⇒ can_reia_plata: false', async () => {
    const alopId = await seedDosar();
    const res = await capOf(alopId, ck(initId));
    expect(res.status).toBe(200);
    expect(res.body.alop.capabilities.can_reia_plata).toBe(false);
  });

  it('10. org_admin FĂRĂ orgId ⇒ dosarul nu se găsește (404), la fel ca poarta rutei (nu trece de filtrul org_id)', async () => {
    // Oglindește exact comportamentul verificat pentru POST /plata/reia (#210): actor.orgId
    // null ⇒ `WHERE a.org_id=$2` cu $2=NULL nu potrivește niciodată rândul ⇒ 404, înainte
    // ca `_isAdminLike`/capabilitatea să fie evaluate. Nu există un `200` cu `false` de citit.
    const alopId = await seedDosar();
    const cookie = makeAuthCookie({ userId: oadmId, role: 'org_admin', orgId: null, email: 'oadm@x.ro' });
    const res = await capOf(alopId, cookie);
    expect(res.status).toBe(404);
  });

  it('11. ⭐ admin pe dosar completed FĂRĂ plată confirmată ⇒ can_reia_plata: false (condiția plata_confirmed_at rămâne)', async () => {
    const alopId = await seedDosar({ plataConfirmedAt: false });
    // #211 nu atinge starea implicită — un dosar 'completed' fără UPDATE-ul de plată nu
    // trece prin ramurile care setează completed_at; forțăm explicit completed_at pentru
    // realism (dosar închis) păstrând plata_confirmed_at NULL.
    await pool.query(`UPDATE alop_instances SET completed_at=NOW() WHERE id=$1`, [alopId]);
    const res = await capOf(alopId, ck(admId, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.alop.plata_confirmed_at).toBeNull();
    expect(res.body.alop.capabilities.can_reia_plata).toBe(false);
  });

  it('12. ⭐ admin pe dosar ANULAT ⇒ can_reia_plata: false (condiția !is_cancelled rămâne)', async () => {
    // `is_cancelled` se derivă din `status === 'cancelled'` (alop-capabilities.mjs), NU din
    // `cancelled_at` — coloană folosită separat de vizibilitatea GET (`WHERE cancelled_at IS
    // NULL`). Seedăm `status='cancelled'` cu `cancelled_at` NULL ca dosarul să rămână
    // vizibil prin ruta reală și să izolăm exact condiția `!is_cancelled` din expresie
    // (un dosar cancelled_at real n-ar mai fi accesibil deloc prin GET, indiferent de rol).
    const alopId = await seedDosar({ status: 'cancelled' });
    const res = await capOf(alopId, ck(admId, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('cancelled');
    expect(res.body.alop.capabilities.can_reia_plata).toBe(false);
  });

  it('13. ⭐ admin pe dosar în stare "plata" (necompletat) ⇒ can_reia_plata: false (condiția is_completed rămâne)', async () => {
    const alopId = await seedDosar({ status: 'plata', plataConfirmedAt: false });
    const res = await capOf(alopId, ck(admId, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('plata');
    expect(res.body.alop.capabilities.can_reia_plata).toBe(false);
  });
});
