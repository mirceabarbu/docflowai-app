/**
 * #131a (v3.9.779) — vizibilitatea în `GET /api/formulare/list`, ambele tipuri.
 *
 * Două lucruri:
 *  (a) documentul atribuit COMPARTIMENTULUI meu apare în listă (funcționalitate nouă);
 *  (b) GAURA VECHE: documentul atribuit unei PERSOANE din compartimentul meu — pe care
 *      `canEditFormular` îmi dădea deja dreptul să-l EDITEZ (rol `p2_comp`) — nu apărea
 *      în listă. Puteam edita ceva ce nu puteam găsi. Se repară aici.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const COMP = 'Serviciul Buget';

d('#131a — vizibilitate liste pentru Responsabil CAB pe compartiment', () => {
  let app, orgId, meId, colegId, strainId, faraCompId;
  let dfComp, dfPersoana, dfAltComp, dfStrain;
  let ordComp, ordPersoana, ordAltComp;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();
    // `me` și `coleg` sunt în COMP; `strain` e în alt compartiment (și creează documentele,
    // ca vizibilitatea să NU vină din ramura „creatorul e în compartimentul meu").
    const s = await seedOrgUser({ orgName: 'Org 131a vis', email: 'me@x.ro', role: 'user', compartiment: COMP });
    orgId = s.orgId; meId = s.userId;
    colegId    = await seedUser({ orgId, email: 'coleg@x.ro',  compartiment: COMP });
    strainId   = await seedUser({ orgId, email: 'strain@x.ro', compartiment: 'Achizitii' });
    faraCompId = await seedUser({ orgId, email: 'fara@x.ro',   compartiment: '' });

    dfComp     = await seedDf({ orgId, createdBy: strainId, status: 'pending_p2', nrUnic: 'DF-COMP' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, [COMP, dfComp]);
    dfPersoana = await seedDf({ orgId, createdBy: strainId, status: 'pending_p2', nrUnic: 'DF-PERS', assignedTo: colegId });
    dfAltComp  = await seedDf({ orgId, createdBy: strainId, status: 'pending_p2', nrUnic: 'DF-ALT' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment='Juridic' WHERE id=$1`, [dfAltComp]);
    dfStrain   = await seedDf({ orgId, createdBy: strainId, status: 'draft', nrUnic: 'DF-STRAIN' });

    ordComp     = await seedOrd({ orgId, createdBy: strainId, status: 'pending_p2', nrOrd: 'ORD-COMP' });
    await pool.query(`UPDATE formulare_ord SET p2_compartiment=$1 WHERE id=$2`, [COMP, ordComp]);
    ordPersoana = await seedOrd({ orgId, createdBy: strainId, status: 'pending_p2', nrOrd: 'ORD-PERS', assignedTo: colegId });
    ordAltComp  = await seedOrd({ orgId, createdBy: strainId, status: 'pending_p2', nrOrd: 'ORD-ALT' });
    await pool.query(`UPDATE formulare_ord SET p2_compartiment='Juridic' WHERE id=$1`, [ordAltComp]);
  });
  afterAll(() => pool.end());

  const me   = () => makeAuthCookie({ userId: meId, role: 'user', orgId });
  const ids  = (rows) => rows.map(r => String(r.id));
  const list = async (type, cookie, qs = '') => {
    const res = await request(app).get(`/api/formulare/list?type=${type}${qs}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.rows;
  };

  it('17. ⭐ DF atribuit COMPARTIMENTULUI meu, creat de altcineva ⇒ apare în listă', async () => {
    expect(ids(await list('df', me()))).toContain(String(dfComp));
  });

  it('17b. ⭐ ORD atribuit COMPARTIMENTULUI meu ⇒ apare în listă', async () => {
    expect(ids(await list('ord', me()))).toContain(String(ordComp));
  });

  it('18. ⭐ GAURA VECHE: DF atribuit unei PERSOANE din compartimentul meu ⇒ apare acum', async () => {
    expect(ids(await list('df', me()))).toContain(String(dfPersoana));
  });

  it('18b. ⭐ GAURA VECHE, ORD: atribuit unei PERSOANE din compartimentul meu ⇒ apare acum', async () => {
    expect(ids(await list('ord', me()))).toContain(String(ordPersoana));
  });

  it('19. document atribuit ALTUI compartiment ⇒ NU apare (DF + ORD)', async () => {
    expect(ids(await list('df',  me()))).not.toContain(String(dfAltComp));
    expect(ids(await list('ord', me()))).not.toContain(String(ordAltComp));
  });

  it('19b. document fără legătură cu mine (alt creator, neatribuit) ⇒ NU apare', async () => {
    expect(ids(await list('df', me()))).not.toContain(String(dfStrain));
  });

  it('20. NON-REGRESIE: utilizator FĂRĂ compartiment vede exact ce vedea înainte (doar ale lui)', async () => {
    const propriu = await seedDf({ orgId, createdBy: faraCompId, status: 'draft', nrUnic: 'DF-PROPRIU' });
    const rows = await list('df', makeAuthCookie({ userId: faraCompId, role: 'user', orgId }));
    expect(ids(rows)).toEqual([String(propriu)]);
  });

  it('21. filtrul „Responsabil CAB" cu textul compartimentului găsește documentul', async () => {
    const rowsDf = await list('df', me(), '&p2=Buget');
    expect(ids(rowsDf)).toContain(String(dfComp));
    expect(ids(rowsDf)).not.toContain(String(dfPersoana));   // coleg = nume 'P2', email coleg@x.ro
    const rowsOrd = await list('ord', me(), '&p2=Buget');
    expect(ids(rowsOrd)).toContain(String(ordComp));
  });

  it('21b. filtrul pe PERSOANĂ rămâne funcțional (non-regresie)', async () => {
    const rows = await list('df', me(), '&p2=coleg@x.ro');
    expect(ids(rows)).toContain(String(dfPersoana));
    expect(ids(rows)).not.toContain(String(dfComp));
  });

  it('22. coloana p2 = numele compartimentului când assigned_to e NULL, altfel al persoanei', async () => {
    const rows = await list('df', me());
    const rComp = rows.find(r => String(r.id) === String(dfComp));
    const rPers = rows.find(r => String(r.id) === String(dfPersoana));
    expect(rComp.p2).toBe(COMP);
    expect(rComp.p2_compartiment).toBe(COMP);
    expect(rPers.p2).toBe('P2');                  // seedUser: nume='P2'
    expect(rPers.p2_compartiment).toBeNull();     // atribuire pe PERSOANĂ ⇒ marcaj gol pentru #131b
  });
});
