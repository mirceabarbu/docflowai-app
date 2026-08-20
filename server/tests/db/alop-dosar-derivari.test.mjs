/**
 * #134e — derivările de stare ALOP trec de la POINTERUL `a.df_id` pe DOSAR.
 *
 * Fundația variantei (A) din docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md: `df_id`
 * urmează să devină „revizia ÎN VIGOARE" (#134f). Acest lot NU mută pointerul — mută
 * DERIVĂRILE, fiindcă o derivare pe dosar e corectă ȘI sub regimul de azi (pointerul
 * sare pe revizia nouă la creare), ȘI sub cel de mâine.
 *
 * ⛔ Fixture-ul lasă pointerul EXACT cum îl pune codul de azi: pe revizia cea mai nouă,
 *    inclusiv când e în draft. Dacă un viitor lot îl mută, aceste aserții trebuie să
 *    rămână verzi fără modificări — ăsta e testul.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('#134e — ALOP: derivări de stare pe DOSAR, nu pe pointerul df_id', () => {
  let app;
  beforeAll(migrate);
  afterAll(() => pool.end());

  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  /** Creează ALOP-ul întâi (ca să existe `source_alop_id`), apoi DF-urile dosarului. */
  async function dosar({ status = 'lichidare', nrUnic, legacy = false, revizii = [] }) {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status, titlu: nrUnic });
    let pointer = null;
    for (const r of revizii) {
      const dfId = await seedDf({
        orgId: 1, createdBy: 1,
        status: r.status || 'aprobat',
        flowId: r.flowId ?? null,
        nrUnic, revizieNr: r.nr,
        sourceAlopId: legacy ? null : alopId,
        rowsVal: [{ valt_actualiz: '1000' }],
        rowsPlati: [{ plati_estim_ancrt: '400' }],
        anReferinta: 2026,
      });
      pointer = dfId; // codul de azi mută pointerul pe ULTIMA revizie creată
    }
    await pool.query(
      `UPDATE alop_instances SET df_id=$2, df_flow_id=$3 WHERE id=$1`,
      [alopId, pointer, revizii[revizii.length - 1]?.flowId ?? null]
    );
    return alopId;
  }

  let D1, D2, D3, D4;

  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();

    // D1 — R0 aprobat, fără revizii
    D1 = await dosar({ nrUnic: 'DOS-1', revizii: [
      { nr: 0, status: 'aprobat', flowId: await seedFlow({ completed: true }) },
    ]});

    // D2 — R0 aprobat + R1 în DRAFT (pointerul rămâne pe R1, ca azi)
    const f2 = await seedFlow({ completed: true });
    D2 = await dosar({ nrUnic: 'DOS-2', revizii: [
      { nr: 0, status: 'aprobat', flowId: f2 },
      { nr: 1, status: 'draft',   flowId: null },
    ]});
    // pointerul de flux al ALOP-ului rămâne pe fluxul aprobat al lui R0 (ca în producție)
    await pool.query(`UPDATE alop_instances SET df_flow_id=$2 WHERE id=$1`, [D2, f2]);

    // D3 — R0 aprobat + R1 pe flux ACTIV
    const f3 = await seedFlow({ completed: true });
    const f3r = await seedFlow({ completed: false });
    D3 = await dosar({ nrUnic: 'DOS-3', revizii: [
      { nr: 0, status: 'aprobat',       flowId: f3 },
      { nr: 1, status: 'transmis_flux', flowId: f3r },
    ]});

    // D4 — dosar LEGACY (source_alop_id NULL), R0 aprobat
    D4 = await dosar({ nrUnic: 'DOS-4', legacy: true, revizii: [
      { nr: 0, status: 'aprobat', flowId: await seedFlow({ completed: true }) },
    ]});
  });

  const lista = async () => {
    const r = await request(app).get('/api/alop?limit=100').set('Cookie', p1());
    expect(r.status).toBe(200);
    return r.body;
  };
  const rand = async (id) => (await lista()).alop.find(x => x.id === id);
  const detaliu = async (id) => {
    const r = await request(app).get(`/api/alop/${id}`).set('Cookie', p1());
    expect(r.status).toBe(200);
    return r.body.alop;
  };

  it('V1 — D1 (R0 aprobat, fără revizii): df_aprobat=true, df_flow_active=false, revizie în lucru NULL', async () => {
    for (const a of [await rand(D1), await detaliu(D1)]) {
      expect(a.df_aprobat).toBe(true);
      expect(a.df_flow_active).toBe(false);
      expect(a.df_revizie_lucru_id).toBeNull();
      expect(a.df_revizie_lucru_nr).toBeNull();
    }
    expect((await detaliu(D1)).df_revizie_in_lucru).toBe(false);
  });

  it('V2 ⭐ — D2 (R0 aprobat + R1 draft): df_aprobat=TRUE (azi era false) și df_revizie_lucru_nr=1', async () => {
    for (const a of [await rand(D2), await detaliu(D2)]) {
      // SCHIMBAREA CENTRALĂ a lotului: aprobarea e o proprietate a DOSARULUI,
      // nu a reviziei pe care se întâmplă să stea pointerul.
      expect(a.df_aprobat).toBe(true);
      expect(a.df_revizie_lucru_nr).toBe(1);
      expect(a.df_revizie_lucru_id).toBeTruthy();
    }
    expect((await detaliu(D2)).df_revizie_in_lucru).toBe(true);
  });

  it('V3 — D2: „în lucru" NU înseamnă „pe flux" — badge_status rămâne a.status, nu revizie_flux', async () => {
    const a = await rand(D2);
    expect(a.df_flow_active).toBe(false);        // R1 e în draft, fără flux
    expect(a.badge_status).toBe('lichidare');    // statusul brut, nu 'revizie_flux'
    expect(a.badge_status).not.toBe('revizie_flux');
  });

  it('V4 — D3 (R1 pe flux activ): df_flow_active=true și badge_status=revizie_flux', async () => {
    for (const a of [await rand(D3), await detaliu(D3)]) {
      expect(a.df_flow_active).toBe(true);
      expect(a.badge_status).toBe('revizie_flux');
      expect(a.df_aprobat).toBe(true);           // R0 al dosarului rămâne aprobat
      expect(a.df_revizie_lucru_nr).toBe(1);
    }
  });

  it('V5 — D4 (legacy, source_alop_id NULL): ramura legacy funcționează, dar NU trece granița de org', async () => {
    const a = await rand(D4);
    expect(a.df_aprobat).toBe(true);
    expect(a.df_revizie_lucru_id).toBeNull();

    // Alt ORG, ACELAȘI nr_unic_inreg, revizie neaprobată: nu are voie să intre în dosarul D4.
    const { orgId: org2 } = await seedOrgUser({ orgName: 'Org 2', email: 'alt@x.ro' });
    const u2 = await seedUser({ orgId: org2, email: 'alt2@x.ro' });
    await seedDf({ orgId: org2, createdBy: u2, status: 'draft', nrUnic: 'DOS-4', revizieNr: 1 });

    const dupa = await rand(D4);
    expect(dupa.df_revizie_lucru_id).toBeNull();   // intrusul din alt org e ignorat
    expect(dupa.df_revizie_lucru_nr).toBeNull();
    expect(dupa.df_aprobat).toBe(true);
  });

  it('V6 ⭐ — POARTA COUNT-FĂRĂ-JOIN: total == rows.length pentru fiecare filtru de status', async () => {
    const statusuri = ['draft', 'angajare', 'angajare_flux', 'lichidare',
                       'ordonantare', 'plata', 'completed', 'revizie_flux'];
    for (const s of statusuri) {
      const r = await request(app).get(`/api/alop?limit=100&status=${s}`).set('Cookie', p1());
      expect(r.status, `status=${s} a întors ${r.status}`).toBe(200);
      expect(r.body.total, `total != rows.length pentru status=${s}`).toBe(r.body.alop.length);
      for (const row of r.body.alop) expect(row.badge_status).toBe(s);
    }
    // și cel puțin un dosar chiar e pe 'revizie_flux' (altfel poarta ar trece pe gol)
    const rf = await request(app).get('/api/alop?limit=100&status=revizie_flux').set('Cookie', p1());
    expect(rf.body.total).toBe(1);
    expect(rf.body.alop[0].id).toBe(D3);
  });

  it('V7 ⭐ — D2: can_revise_df este FALSE (garda anti-revizii-paralele)', async () => {
    const det = await request(app).get(`/api/alop/${D2}`).set('Cookie', p1());
    expect(det.status).toBe(200);
    const a = det.body.alop;
    // Premisele gărzii: dosarul e aprobat (deci butonul ar apărea) DAR are o revizie în lucru.
    expect(a.df_aprobat).toBe(true);
    expect(a.df_revizie_in_lucru).toBe(true);
    expect(a.capabilities.can_revise_df).toBe(false);

    // Contraprobă: D1 (aprobat, fără revizie în lucru) POATE fi revizuit.
    const ok = await request(app).get(`/api/alop/${D1}`).set('Cookie', p1());
    expect(ok.body.alop.capabilities.can_revise_df).toBe(true);
  });

  it('V8 — o revizie REFUZATĂ se numără ca „în lucru" (are nevoie de rework)', async () => {
    const fRef = await seedFlow({ completed: false });
    await pool.query(`UPDATE flows SET data = data || '{"status":"refused"}'::jsonb WHERE id=$1`, [fRef]);
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: fRef,
      nrUnic: 'DOS-1', revizieNr: 1, sourceAlopId: D1,
    });
    await pool.query(`UPDATE alop_instances SET df_id=$2 WHERE id=$1`, [D1, dfId]);

    const a = await detaliu(D1);
    expect(a.df_revizie_lucru_nr).toBe(1);
    expect(a.df_revizie_in_lucru).toBe(true);
    expect(a.df_aprobat).toBe(true);              // R0 rămâne aprobat în dosar
    expect(a.df_flow_active).toBe(false);         // un flux refuzat NU e viu
    expect(a.capabilities.can_revise_df).toBe(false);
  });

  it('V9 — non-regresie financiară: df_valoare și df_buget_an_curent sunt NESCHIMBATE (lotul nu atinge banii)', async () => {
    for (const id of [D1, D2, D3, D4]) {
      const r = await rand(id);
      // rows_val = 1000 pe fiecare revizie; pointerul (nemutat de acest lot) decide valoarea
      expect(Number(r.df_valoare), `df_valoare pe ${id}`).toBe(1000);
      // rows_plati banda `ancrt` = 400, an_referinta 2026 == anul de exercițiu al fixture-ului
      expect(Number(r.df_buget_an_curent), `df_buget_an_curent pe ${id}`).toBe(400);
    }
  });
});
