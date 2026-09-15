/**
 * #206 (v3.9.859) — poarta de server pe Secțiunea B a DF-ului.
 *
 * Normele ALOP: Secțiunea A (obiect, valori, distribuția pe ani — DF_P1_FIELDS) e atributul
 * inițiatorului (P1); Secțiunea B (controlul angajamentului — `rows_ctrl` și celelalte
 * DF_P2_FIELDS) e atributul responsabilului CAB (P2). Regula era aplicată DOAR în interfață:
 * `PUT /api/formulare-df/:id` filtra ASIMETRIC — P2 pur primea doar DF_P2_FIELDS, dar P1
 * primea AMBELE seturi, deci un inițiator putea scrie Secțiunea B direct pe API.
 *
 * Rulează ruta REALĂ peste Postgres real (buildApp: csrf/logger mock-uite, DB reală).
 *
 * ⚠️ `pick()` FILTREAZĂ, nu golește: un câmp refuzat lipsește din UPDATE, deci valoarea din
 *    bază rămâne intactă (testele 1 și 2 o dovedesc). Când TOATE câmpurile trimise sunt
 *    filtrate, garda preexistentă `no_fields` (df.mjs) răspunde 400 — comportament de dinainte
 *    de lot, identic pentru un P2 pur care trimite doar câmpuri P1 (testul 1 îl ancorează la
 *    realitate: 400, NU 200, cum spunea promptul inițial).
 *
 * ⭐ Cine e simultan P1 și P2 (comune mici, #131c) primește AMBELE seturi (testul 4).
 * ⭐ `cab_dept` păstrează AMBELE seturi — decizie owner #206 (funcție intenționată ALOP-CAB
 *    „editează tot", ancorată și de cab-dept-visibility #8). Testul 6 e neregresie explicită,
 *    ca un lot viitor să nu îngusteze din reflex.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const CTRL_INITIAL = [{ cod_angajament: 'INIT', indicator_angajament: 'I0', program: 'p0', sum_rezv_crdt_bug_act: '100' }];
const CTRL_NOU     = [{ cod_angajament: 'NOU',  indicator_angajament: 'N1', program: 'p1', sum_rezv_crdt_bug_act: '999' }];

d('#206 — Secțiunea B (rows_ctrl) e atributul responsabilului CAB (poartă pe PUT)', () => {
  let app, orgId;
  let p1Id, p2Id, cabId, strainId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId: p1Id } = await seedOrgUser({ role: 'user', email: 'p1@x.ro', compartiment: 'Achizitii' }));
    p2Id     = await seedUser({ orgId, email: 'p2@x.ro',     compartiment: 'Contabilitate' });
    cabId    = await seedUser({ orgId, email: 'cab@x.ro',    compartiment: 'Serviciul Buget' });
    strainId = await seedUser({ orgId, email: 'strain@x.ro', compartiment: 'Juridic' });
    await pool.query(`UPDATE organizations SET cab_compartiment='Serviciul Buget' WHERE id=$1`, [orgId]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = (userId, role = 'user') => makeAuthCookie({ userId, role, orgId });
  const put = (dfId, userId, body, role = 'user') =>
    request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', cookie(userId, role)).send(body);

  // ── 1 ⭐ P1 pur, doar rows_ctrl ⇒ filtrat complet ⇒ 400 no_fields, baza NEATINSĂ ─────────
  it('1 ⭐ P1 pur (creator, draft) trimite DOAR rows_ctrl ⇒ 400 no_fields, rows_ctrl din bază NESCHIMBAT', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, p1Id, { rows_ctrl: CTRL_NOU });
    // Garda preexistentă `no_fields`: după filtrare nu rămâne niciun câmp de scris.
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_fields');
    const df = await getDf(dfId);
    expect(df.rows_ctrl).toEqual(CTRL_INITIAL);
    expect(df.updated_by).toBeNull();          // UPDATE-ul nu a rulat deloc
  });

  // ── 2 ⭐ P1 pur, câmp P1 + rows_ctrl ⇒ 200, P1 scris, rows_ctrl NU ─────────────────────
  it('2 ⭐ P1 pur trimite câmp P1 ȘI rows_ctrl ⇒ 200, câmpul P1 se scrie, rows_ctrl rămâne cel vechi', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, p1Id, { subtitlu_df: 'scris de P1', rows_ctrl: CTRL_NOU });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const df = await getDf(dfId);
    expect(df.subtitlu_df).toBe('scris de P1');
    expect(df.rows_ctrl).toEqual(CTRL_INITIAL);   // fără pierdere de date, fără scriere
    expect(df.updated_by).toBe(p1Id);
  });

  // ── 3 P2 pur: rows_ctrl se aplică, câmpul P1 e ignorat (neregresie) ─────────────────────
  it('3 P2 pur (assigned_to) scrie rows_ctrl ⇒ se aplică; câmpul P1 trimis simultan e ignorat', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'pending_p2', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    await pool.query(`UPDATE formulare_df SET subtitlu_df='orig' WHERE id=$1`, [dfId]);
    const r = await put(dfId, p2Id, { subtitlu_df: 'P2 încearcă Secțiunea A', rows_ctrl: CTRL_NOU });
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.rows_ctrl).toEqual(CTRL_NOU);
    expect(df.subtitlu_df).toBe('orig');
  });

  // ── 4 ⭐ P1 ȘI P2 simultan ⇒ ambele seturi ────────────────────────────────────────────
  it('4 ⭐ același user e creator ȘI assigned_to (comuna mică) ⇒ AMBELE seturi se scriu', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p1Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, p1Id, { subtitlu_df: 'P1+P2', rows_ctrl: CTRL_NOU });
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.subtitlu_df).toBe('P1+P2');
    expect(df.rows_ctrl).toEqual(CTRL_NOU);
  });

  // ── 5 admin / org_admin ⇒ ambele seturi ─────────────────────────────────────────────
  it('5 admin ⇒ ambele seturi', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, strainId, { subtitlu_df: 'admin', rows_ctrl: CTRL_NOU }, 'admin');
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.subtitlu_df).toBe('admin');
    expect(df.rows_ctrl).toEqual(CTRL_NOU);
  });

  it('5b org_admin ⇒ ambele seturi', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, strainId, { subtitlu_df: 'org_admin', rows_ctrl: CTRL_NOU }, 'org_admin');
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.subtitlu_df).toBe('org_admin');
    expect(df.rows_ctrl).toEqual(CTRL_NOU);
  });

  // ── 6 ⭐ cab_dept ⇒ AMBELE seturi (decizie owner #206 — NU îngusta) ─────────────────────
  it('6 ⭐ cab_dept (membru CAB al org-ului, nici creator, nici atribuit) ⇒ AMBELE seturi se scriu', async () => {
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, cabId, { subtitlu_df: 'scris de CAB', rows_ctrl: CTRL_NOU });
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.subtitlu_df).toBe('scris de CAB');
    expect(df.rows_ctrl).toEqual(CTRL_NOU);
  });

  // ── 7 controale: coleg P1 (comp) e P1 ⇒ rows_ctrl refuzat; p2_comp ⇒ rows_ctrl permis ──
  it('7 coleg de compartiment al creatorului (comp) e P1 ⇒ rows_ctrl NU se scrie, câmpul P1 da', async () => {
    const colegP1 = await seedUser({ orgId, email: 'coleg-p1@x.ro', compartiment: 'Achizitii' });
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'draft', assignedTo: p2Id, rowsCtrl: CTRL_INITIAL });
    const r = await put(dfId, colegP1, { subtitlu_df: 'coleg P1', rows_ctrl: CTRL_NOU });
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.subtitlu_df).toBe('coleg P1');
    expect(df.rows_ctrl).toEqual(CTRL_INITIAL);
  });

  it('7b membru al compartimentului atribuit (p2_comp, via p2_compartiment) ⇒ rows_ctrl se scrie, câmpul P1 nu', async () => {
    const colegP2 = await seedUser({ orgId, email: 'coleg-p2@x.ro', compartiment: 'Contabilitate' });
    const dfId = await seedDf({ orgId, createdBy: p1Id, status: 'pending_p2', rowsCtrl: CTRL_INITIAL });
    await pool.query(`UPDATE formulare_df SET p2_compartiment='Contabilitate', subtitlu_df='orig' WHERE id=$1`, [dfId]);
    const r = await put(dfId, colegP2, { subtitlu_df: 'p2_comp încearcă A', rows_ctrl: CTRL_NOU });
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.rows_ctrl).toEqual(CTRL_NOU);
    expect(df.subtitlu_df).toBe('orig');
  });
});
