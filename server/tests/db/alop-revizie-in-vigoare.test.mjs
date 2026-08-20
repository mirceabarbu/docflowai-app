/**
 * #134f — `alop_instances.df_id` = REVIZIA ÎN VIGOARE (ultima aprobată).
 *
 * Schimbarea de semantică pregătită de #134e (derivările pe dosar) și #134g
 * (backfill `source_alop_id`): pointerul NU se mai mută la CREAREA unei revizii,
 * ci EXCLUSIV la aprobarea ei (`selfHealAlopDfLink`). Cât timp R(n+1) e în lucru
 * sau pe flux, dosarul continuă să citească cifrele lui R(n).
 *
 * ⚠️ F1-F4 sunt testele de CARACTERIZARE scrise ÎNAINTE de modificare (Etapa 0):
 *    au picat roșu contra codului vechi. F6/F7 sunt blocajul d7 — fără relaxarea
 *    de proveniență (Etapa 2), lansarea unui flux pentru R1 e refuzată cu
 *    403 `flux_alt_document`, fiindcă `df_id` rămâne pe R0.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { selfHealAlopDfLink } from '../../services/alop-link.mjs';
import { checkFlowLinkable, checkFlowSigned } from '../../services/flow-provenance.mjs';

const d = describe.skipIf(!hasTestDb());
const AN = new Date().getFullYear();

d('#134f — df_id este revizia ÎN VIGOARE', () => {
  let app;
  beforeAll(migrate);
  afterAll(() => pool.end());

  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  /** Dosar ALOP finalizat, cu R0 aprobat (55.000) — pointerul pe R0, ca în producție. */
  async function dosarR0Aprobat({ legacy = false, nrUnic = 'DOS-A', status = 'completed' } = {}) {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status, titlu: nrUnic });
    const r0 = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', nrUnic, revizieNr: 0,
      sourceAlopId: legacy ? null : alopId,
      rowsVal:   [{ valt_actualiz: '55000' }],
      rowsCtrl:  [{ sum_rezv_crdt_bug_act: '55000' }],
      rowsPlati: [{ plati_estim_ancrt: '55000' }],
      anReferinta: AN,
    });
    const flowR0 = await seedFlow({ completed: true, orgId: 1, meta: { dfId: r0 } });
    await pool.query(`UPDATE formulare_df SET flow_id=$2 WHERE id=$1`, [r0, flowR0]);
    await pool.query(
      `UPDATE alop_instances SET df_id=$2, df_flow_id=$3, df_completed_at=NOW() WHERE id=$1`,
      [alopId, r0, flowR0]
    );
    return { alopId, r0, flowR0 };
  }

  /** Apelul REAL /revizuieste + editarea reviziei la 195.000, lăsată în draft. */
  async function revizuiesteSiUmfla(r0) {
    const rv = await request(app)
      .post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1())
      .send({ motiv: 'suplimentare valoare' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    const r1 = rv.body.df.id;
    await pool.query(
      `UPDATE formulare_df SET rows_val=$2::jsonb, rows_ctrl=$3::jsonb WHERE id=$1`,
      [r1, JSON.stringify([{ valt_actualiz: '195000' }]),
           JSON.stringify([{ sum_rezv_crdt_bug_act: '195000' }])]
    );
    return r1;
  }

  const detaliu = async (id) => {
    const r = await request(app).get(`/api/alop/${id}`).set('Cookie', p1());
    expect(r.status).toBe(200);
    return r.body.alop;
  };

  let F;   // fixture-ul principal: { alopId, r0, flowR0, r1 }

  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // user 1, org 1
    app = buildApp();
    F = await dosarR0Aprobat();
    F.r1 = await revizuiesteSiUmfla(F.r0);
  });

  // ── Etapa 0 — caracterizare (au picat roșu înainte de Etapa 1) ─────────────

  it('F1 — GET /api/alop/:id întoarce df_valoare = 55000 (cifra lui R0, nu a draftului R1)', async () => {
    const a = await detaliu(F.alopId);
    expect(Number(a.df_valoare)).toBe(55000);
  });

  it('F2 — alop.df_id rămâne pe R0 după crearea reviziei', async () => {
    const a = await detaliu(F.alopId);
    expect(a.df_id).toBe(F.r0);
    expect(a.df_id).not.toBe(F.r1);
  });

  it('F3 — df_revizie_nr = 0 (revizia POINTATĂ e tot R0)', async () => {
    const a = await detaliu(F.alopId);
    expect(a.df_revizie_nr).toBe(0);
  });

  it('F4 — df_completed_at și df_flow_id rămân NON-NULL (dovada aprobării lui R0)', async () => {
    const a = await detaliu(F.alopId);
    expect(a.df_completed_at).not.toBeNull();
    expect(a.df_flow_id).toBe(F.flowR0);
  });

  // ── Etapa 4 — noua semantică, dincolo de caracterizare ─────────────────────

  it('F5 ⭐ — la APROBAREA fluxului lui R1, pointerul se mută pe R1 (dosarul nu îngheață)', async () => {
    const flowR1 = await seedFlow({ completed: true, orgId: 1, meta: { dfId: F.r1 } });
    await pool.query(`UPDATE formulare_df SET flow_id=$2, status='aprobat' WHERE id=$1`, [F.r1, flowR1]);

    // Mecanismul UNIC de mutare a pointerului (apelat din signing.mjs / crud.mjs).
    await selfHealAlopDfLink(pool, flowR1);

    const a = await detaliu(F.alopId);
    expect(a.df_id).toBe(F.r1);
    expect(Number(a.df_valoare)).toBe(195000);
    expect(a.df_revizie_nr).toBe(1);
    expect(a.df_flow_id).toBe(flowR1);
    expect(a.df_completed_at).not.toBeNull();
  });

  it('F6 ⭐ blocajul d7 — fluxul lui R1 POATE fi legat cât timp df_id e pe R0', async () => {
    const flowR1 = await seedFlow({ completed: false, orgId: 1, meta: { dfId: F.r1 } });

    // (a) decizia pură
    const { rows: [alopRow] } = await pool.query(
      `SELECT id, df_id, ord_id FROM alop_instances WHERE id=$1`, [F.alopId]);
    const dec = await checkFlowLinkable(pool, { flowId: flowR1, kind: 'df', alop: alopRow, orgId: 1 });
    expect(dec.ok, JSON.stringify(dec.body || {})).toBe(true);

    // (b) ruta reală
    const r = await request(app).post(`/api/alop/${F.alopId}/link-df-flow`)
      .set('Cookie', p1()).send({ flow_id: flowR1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('F7 — checkFlowSigned acceptă fluxul FINALIZAT al lui R1 deși df_id e pe R0', async () => {
    const flowR1 = await seedFlow({ completed: true, orgId: 1, meta: { dfId: F.r1 } });
    const { rows: [alopRow] } = await pool.query(
      `SELECT id, df_id, ord_id, df_flow_id, ord_flow_id FROM alop_instances WHERE id=$1`, [F.alopId]);
    const dec = await checkFlowSigned(pool, {
      kind: 'df', alop: { ...alopRow, df_flow_id: flowR1 }, orgId: 1,
    });
    expect(dec.ok, JSON.stringify(dec.body || {})).toBe(true);
  });

  it('F8 — badge revizie_flux rămâne APRINS cu pointerul pe R0 (Etapa 3)', async () => {
    const flowR1 = await seedFlow({ completed: false, orgId: 1, meta: { dfId: F.r1 } });
    await pool.query(`UPDATE formulare_df SET flow_id=$2, status='transmis_flux' WHERE id=$1`, [F.r1, flowR1]);

    const det = await detaliu(F.alopId);
    expect(det.df_revizie_nr).toBe(0);            // pointerul e pe R0 — exact cazul care stingea badge-ul
    expect(det.badge_status).toBe('revizie_flux');

    const lst = await request(app).get('/api/alop?limit=100').set('Cookie', p1());
    expect(lst.status).toBe(200);
    expect(lst.body.alop.find(x => x.id === F.alopId).badge_status).toBe('revizie_flux');

    // poarta COUNT-fără-join rămâne validă pe filtrul derivat
    const flt = await request(app).get('/api/alop?limit=100&status=revizie_flux').set('Cookie', p1());
    expect(flt.body.total).toBe(flt.body.alop.length);
    expect(flt.body.alop.map(x => x.id)).toContain(F.alopId);
  });

  it('F9 — poarta NU s-a lărgit: fluxul unui DF din ALT dosar rămâne refuzat', async () => {
    const alt = await dosarR0Aprobat({ nrUnic: 'DOS-B' });
    const flowAlt = await seedFlow({ completed: false, orgId: 1, meta: { dfId: alt.r0 } });

    const r = await request(app).post(`/api/alop/${F.alopId}/link-df-flow`)
      .set('Cookie', p1()).send({ flow_id: flowAlt });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('flux_alt_document');
  });

  it('F10 ⭐ — ORD NU e relaxat: fluxul unui ORD arhivat nu poate deveni fluxul ORD curent', async () => {
    // ORD-ul unui ciclu anterior poartă ACELAȘI source_alop_id ca ALOP-ul.
    const ordArhivat = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', nrOrd: 'ORD-VECHI' });
    await pool.query(`UPDATE formulare_ord SET source_alop_id=$2 WHERE id=$1`, [ordArhivat, F.alopId]);
    const ordCurent = await seedOrd({ orgId: 1, createdBy: 1, nrOrd: 'ORD-NOU' });
    await pool.query(`UPDATE alop_instances SET ord_id=$2 WHERE id=$1`, [F.alopId, ordCurent]);

    const flowVechi = await seedFlow({ completed: false, orgId: 1, meta: { ordId: ordArhivat } });
    const r = await request(app).post(`/api/alop/${F.alopId}/link-ord-flow`)
      .set('Cookie', p1()).send({ flow_id: flowVechi });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('flux_alt_document');

    // Contraprobă: fluxul ORD-ului CURENT (calea directă) trece.
    const flowNou = await seedFlow({ completed: false, orgId: 1, meta: { ordId: ordCurent } });
    const ok = await request(app).post(`/api/alop/${F.alopId}/link-ord-flow`)
      .set('Cookie', p1()).send({ flow_id: flowNou });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('F11 — noua-lichidare calculează plafonul pe R0 (55.000), nu pe draftul R1 (195.000)', async () => {
    const ordId = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ suma_ordonantata_plata: '55000' }],
    });
    await pool.query(`UPDATE alop_instances SET ord_id=$2 WHERE id=$1`, [F.alopId, ordId]);

    const r = await request(app).post(`/api/alop/${F.alopId}/noua-lichidare`)
      .set('Cookie', p1()).send({});
    // Creditele bugetare ale lui R0 (55.000) sunt integral ordonanțate ⇒ ramas = 0.
    // Pe draftul R1 (195.000) ar fi rămas 140.000 și ciclul s-ar fi deschis.
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toBe('limita_depasita');
    expect(String(r.body.message)).toContain('55000');
  });

  it('F12 — can_revise_df rămâne FALSE cât timp R1 e în lucru (garda #134e)', async () => {
    const a = await detaliu(F.alopId);
    expect(a.df_aprobat).toBe(true);
    expect(a.df_revizie_in_lucru).toBe(true);
    expect(a.capabilities.can_revise_df).toBe(false);
  });

  it('F13 — auto-tranziția lazy din GET nu promovează greșit dosarul în „angajare"', async () => {
    // ALOP finalizat: GET-ul nu îi atinge statusul, oricâte apeluri.
    await detaliu(F.alopId); await detaliu(F.alopId);
    const { rows: [dupa] } = await pool.query(`SELECT status FROM alop_instances WHERE id=$1`, [F.alopId]);
    expect(dupa.status).toBe('completed');

    // ALOP în draft cu R0 aprobat în dosar: recuperarea merge la 'lichidare', NICIODATĂ 'angajare'.
    const dr = await dosarR0Aprobat({ nrUnic: 'DOS-C', status: 'draft' });
    const a = await detaliu(dr.alopId);
    expect(a.status).toBe('lichidare');
    expect(a.status).not.toBe('angajare');
  });

  it('F14 — dosar LEGACY (source_alop_id NULL): lansarea fluxului R1 EȘUEAZĂ, fail-closed', async () => {
    // ⛔ NU e un bug de reparat aici: proveniența e singura cheie destul de strictă
    // (nr_unic_inreg e partajat între dosare — docs/incidents/DF-NR-DUPLICAT.md).
    // De aceea #134g (backfill source_alop_id) TREBUIE rulat cu --apply pe producție
    // ÎNAINTE de deploy-ul acestui lot.
    const L = await dosarR0Aprobat({ nrUnic: 'DOS-L', legacy: true });
    const lr1 = await revizuiesteSiUmfla(L.r0);
    const { rows: [chk] } = await pool.query(
      `SELECT source_alop_id FROM formulare_df WHERE id=$1`, [lr1]);
    expect(chk.source_alop_id).toBeNull();

    const flowL = await seedFlow({ completed: false, orgId: 1, meta: { dfId: lr1 } });
    const r = await request(app).post(`/api/alop/${L.alopId}/link-df-flow`)
      .set('Cookie', p1()).send({ flow_id: flowL });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('flux_alt_document');
  });
});
