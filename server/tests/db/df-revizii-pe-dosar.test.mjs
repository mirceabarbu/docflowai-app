/**
 * test:db — #126 Etapa A: lanțul de revizii DF se cheie pe DOSARUL ALOP, nu pe număr.
 *
 * Fixtura REPRODUCE producția (3 coliziuni verificate în DB, 7 documente):
 * două DOSARE ALOP DIFERITE, fiecare cu DF R0, AMBELE cu același `nr_unic_inreg`.
 * Utilizatorii deschid un dosar nou pentru cheltuiala următoare pe același obiect
 * și refolosesc numărul din registratură.
 *
 * ⛔ Nu există index unic pe `nr_unic_inreg` și nu poate exista: în producție două
 *    documente în coliziune au deja semnături QES aplicate. Vezi
 *    docs/incidents/DF-NR-DUPLICAT.md.
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved,
         getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const NR = '40339';

d('#126 A — lanțul de revizii DF cheiat pe dosarul ALOP', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());

  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // Două dosare ALOP independente, fiecare cu DF R0 aprobat, ACELAȘI număr unic.
  async function seedColiziune() {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar B' });
    const flowA = await seedFlowApproved();
    const flowB = await seedFlowApproved();
    const dfA = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowA,
      nrUnic: NR, sourceAlopId: alopA });
    const dfB = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowB,
      nrUnic: NR, sourceAlopId: alopB });
    await pool.query('UPDATE alop_instances SET df_id=$2 WHERE id=$1', [alopA, dfA]);
    await pool.query('UPDATE alop_instances SET df_id=$2 WHERE id=$1', [alopB, dfB]);
    return { alopA, alopB, dfA, dfB };
  }

  // ── 1. TESTUL CENTRAL AL ETAPEI ────────────────────────────────────────────
  it('ambele dosare pot fi revizuite INDEPENDENT (înainte: al doilea primea 400 pe viață)', async () => {
    const { dfA, dfB } = await seedColiziune();

    const rA = await request(app).post(`/api/formulare-df/${dfA}/revizuieste`)
      .set('Cookie', p1()).send({ motiv: 'suplimentare dosar A' });
    expect(rA.status).toBe(200);
    const revA = rA.body.df.id;
    expect((await getDf(revA)).revizie_nr).toBe(1);

    // Dosarul B e neatins de R1-ul dosarului A → revizuirea lui trebuie să meargă.
    const rB = await request(app).post(`/api/formulare-df/${dfB}/revizuieste`)
      .set('Cookie', p1()).send({ motiv: 'suplimentare dosar B' });
    expect(rB.status).toBe(200);
    const revB = rB.body.df.id;
    const rowB = await getDf(revB);
    expect(rowB.revizie_nr).toBe(1);           // R1 în dosarul B, nu R2
    expect(rowB.parent_df_id).toBe(dfB);
  });

  // ── 2. dropdown-ul ORD nu mai pierde documente ─────────────────────────────
  it('/aprobate întoarce AMBELE DF-uri aprobate cu același număr (dosare diferite)', async () => {
    const { dfA, dfB } = await seedColiziune();
    const res = await request(app).get('/api/formulare-df/aprobate').set('Cookie', p1());
    expect(res.status).toBe(200);
    const ids = res.body.documents.map(x => x.id);
    expect(ids).toContain(dfA);
    expect(ids).toContain(dfB);
  });

  it('/aprobate păstrează DISTINCT ON pe dosar: doar ULTIMA revizie a unui dosar', async () => {
    const { dfA } = await seedColiziune();
    const flowRev = await seedFlowApproved();
    const alopA = (await getDf(dfA)).source_alop_id;
    const revA = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowRev,
      nrUnic: NR, revizieNr: 1, parentDfId: dfA, sourceAlopId: alopA });

    const res = await request(app).get('/api/formulare-df/aprobate').set('Cookie', p1());
    const ids = res.body.documents.map(x => x.id);
    expect(ids).toContain(revA);
    expect(ids).not.toContain(dfA);   // R0 al aceluiași dosar e ascuns de R1
  });

  // ── 3. lanțul de revizii ───────────────────────────────────────────────────
  it('/revizii pe DF-ul dosarului A conține DOAR reviziile dosarului A', async () => {
    const { dfA, dfB } = await seedColiziune();
    const rA = await request(app).post(`/api/formulare-df/${dfA}/revizuieste`)
      .set('Cookie', p1()).send({ motiv: 'A' });
    const revA = rA.body.df.id;

    const res = await request(app).get(`/api/formulare-df/${dfA}/revizii`).set('Cookie', p1());
    expect(res.status).toBe(200);
    const ids = res.body.revizii.map(x => x.id);
    expect(ids).toContain(dfA);
    expect(ids).toContain(revA);
    expect(ids).not.toContain(dfB);   // dosar STRĂIN — nu mai intră în lanț
  });

  // ── 4. has_newer_revision pe dosar ─────────────────────────────────────────
  it('has_newer_revision fals pe DF-ul B când doar dosarul A a fost revizuit', async () => {
    const { dfA, dfB } = await seedColiziune();
    await request(app).post(`/api/formulare-df/${dfA}/revizuieste`)
      .set('Cookie', p1()).send({ motiv: 'A' });

    const detB = await request(app).get(`/api/formulare-df/${dfB}`).set('Cookie', p1());
    expect(detB.status).toBe(200);
    expect(detB.body.document.has_newer_revision).toBe(false);
    expect(Number(detB.body.document.latest_revizie_nr)).toBe(0);

    const detA = await request(app).get(`/api/formulare-df/${dfA}`).set('Cookie', p1());
    expect(detA.body.document.has_newer_revision).toBe(true);   // în dosarul lui, DA

    // Lista centralizată (sursa badge-ului „istoric") folosește aceeași cheie.
    const lst = await request(app).get('/api/formulare/list?type=df&limit=50').set('Cookie', p1());
    expect(lst.status).toBe(200);
    const rowB = lst.body.rows.find(r => r.id === dfB);
    expect(rowB.has_newer_revision).toBe(false);
    const rowA = lst.body.rows.find(r => r.id === dfA);
    expect(rowA.has_newer_revision).toBe(true);
  });

  // ── 5/6/7. garda de la PUT ─────────────────────────────────────────────────
  it('PUT cu numărul NESCHIMBAT pe un document aflat în coliziune ⇒ 200 (nu blocăm documente vii)', async () => {
    const { dfB } = await seedColiziune();
    await pool.query(`UPDATE formulare_df SET status='draft', flow_id=NULL WHERE id=$1`, [dfB]);

    const res = await request(app).put(`/api/formulare-df/${dfB}`)
      .set('Cookie', p1()).send({ nr_unic_inreg: NR, subtitlu_df: 'editare normală' });
    expect(res.status).toBe(200);
    expect((await getDf(dfB)).subtitlu_df).toBe('editare normală');
  });

  it('PUT care SCHIMBĂ numărul într-unul folosit de alt dosar ⇒ 409, număr nemodificat în DB', async () => {
    const { dfA } = await seedColiziune();
    const alopC = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar C' });
    const dfC = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'ALT-999',
      sourceAlopId: alopC });

    const res = await request(app).put(`/api/formulare-df/${dfC}`)
      .set('Cookie', p1()).send({ nr_unic_inreg: NR });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nr_unic_duplicat');
    expect(res.body.message).toMatch(/revizuiți documentul/i);
    expect((await getDf(dfC)).nr_unic_inreg).toBe('ALT-999');   // nimic scris
    expect((await getDf(dfA)).nr_unic_inreg).toBe(NR);
  });

  it('PUT cu același număr dar cu spații („ 40339 ") ⇒ 409 (comparație TRIMMED pe ambele părți)', async () => {
    await seedColiziune();
    const alopC = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar C' });
    const dfC = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'ALT-999',
      sourceAlopId: alopC });

    const res = await request(app).put(`/api/formulare-df/${dfC}`)
      .set('Cookie', p1()).send({ nr_unic_inreg: `  ${NR}  ` });
    expect(res.status).toBe(409);
    expect((await getDf(dfC)).nr_unic_inreg).toBe('ALT-999');
  });

  it('PUT cu un număr liber ⇒ 200 și numărul se salvează TRIMMED', async () => {
    const alopC = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar C' });
    const dfC = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'ALT-999',
      sourceAlopId: alopC });

    const res = await request(app).put(`/api/formulare-df/${dfC}`)
      .set('Cookie', p1()).send({ nr_unic_inreg: '  LIBER-1  ' });
    expect(res.status).toBe(200);
    expect((await getDf(dfC)).nr_unic_inreg).toBe('LIBER-1');
  });

  // ── 8. LEGACY (source_alop_id NULL) — fallback-ul nu regresează ────────────
  it('LEGACY fără source_alop_id: lanțul R0→R1 funcționează ca înainte (fallback pe număr)', async () => {
    const flow0 = await seedFlowApproved();
    const legacy0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow0,
      nrUnic: 'LEG-1' });                       // source_alop_id NULL
    const legacy1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft',
      nrUnic: 'LEG-1', revizieNr: 1, parentDfId: legacy0 });

    // lanțul: /revizii le vede pe amândouă (grupate pe număr, ca înainte)
    const rev = await request(app).get(`/api/formulare-df/${legacy0}/revizii`).set('Cookie', p1());
    const ids = rev.body.revizii.map(x => x.id);
    expect(ids).toContain(legacy0);
    expect(ids).toContain(legacy1);

    // has_newer_revision pe R0 = true (există R1 în ACELAȘI lanț legacy)
    const det = await request(app).get(`/api/formulare-df/${legacy0}`).set('Cookie', p1());
    expect(det.body.document.has_newer_revision).toBe(true);
    expect(Number(det.body.document.latest_revizie_nr)).toBe(1);

    // garda „doar revizia curentă poate fi revizuită" rămâne activă în lanțul legacy
    const rr = await request(app).post(`/api/formulare-df/${legacy0}/revizuieste`)
      .set('Cookie', p1()).send({ motiv: 'x' });
    expect(rr.status).toBe(400);
    expect(String(rr.body.error)).toMatch(/nu mai este cea curentă/i);
  });

  // ── 9. revizia păstrează numărul ──────────────────────────────────────────
  it('/revizuieste păstrează nr_unic_inreg în revizie (garda de la PUT NU se aplică aici)', async () => {
    const { dfA } = await seedColiziune();
    const res = await request(app).post(`/api/formulare-df/${dfA}/revizuieste`)
      .set('Cookie', p1()).send({ motiv: 'A' });
    expect(res.status).toBe(200);
    const rev = await getDf(res.body.df.id);
    expect(rev.nr_unic_inreg).toBe(NR);
    expect(rev.source_alop_id).toBe((await getDf(dfA)).source_alop_id);
  });

  // ── 10. badge-ul „nr. partajat" (A6) ──────────────────────────────────────
  it('nr_partajat=true pe ambele DF-uri în coliziune, false pe un DF cu număr unic', async () => {
    const { dfA, dfB } = await seedColiziune();
    const alopC = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar C' });
    const dfUnic = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'UNIC-1',
      sourceAlopId: alopC });

    const lst = await request(app).get('/api/formulare/list?type=df&limit=50').set('Cookie', p1());
    expect(lst.status).toBe(200);
    const byId = Object.fromEntries(lst.body.rows.map(r => [r.id, r]));
    expect(byId[dfA].nr_partajat).toBe(true);
    expect(byId[dfB].nr_partajat).toBe(true);
    expect(byId[dfUnic].nr_partajat).toBe(false);

    // Reviziile ACELUIAȘI dosar NU declanșează badge-ul (același număr, același dosar).
    const alopD = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar D' });
    const d0 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DOS-D', sourceAlopId: alopD });
    const d1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DOS-D',
      revizieNr: 1, parentDfId: d0, sourceAlopId: alopD });
    const lst2 = await request(app).get('/api/formulare/list?type=df&limit=50').set('Cookie', p1());
    const byId2 = Object.fromEntries(lst2.body.rows.map(r => [r.id, r]));
    expect(byId2[d0].nr_partajat).toBe(false);
    expect(byId2[d1].nr_partajat).toBe(false);
  });
});
