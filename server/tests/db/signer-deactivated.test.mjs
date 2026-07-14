/**
 * SEC-103: un utilizator intern DEZACTIVAT nu mai poate fi semnatar — la creare flux,
 * la delegare, la semnare (local + STS). Semnarea nu are sesiune (token opac), deci
 * sessionGuard (#88) nu vede calea; clasificarea din `signer-identity.mjs` e singura gardă.
 *
 * TREI clase: active (OK), deactivated (REFUZ), external (fără cont — TREBUIE să treacă).
 * Postgres real: exercită lanțul complet de rute prin flowsRouter.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { hasTestDb, makeAuthCookie, migrate, pool, truncateAll } from '../helpers/db-real.mjs';
import flowsRouter, { injectFlowDeps } from '../../routes/flows.mjs';

const d = describe.skipIf(!hasTestDb());

function createApp() {
  injectFlowDeps({
    notify: async () => undefined, wsPush: () => undefined, PDFLib: null,
    stampFooterOnPdf: null, isSignerTokenExpired: () => false,
    newFlowId: () => `SEC103_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    buildSignerLink: (_req, flowId, signerToken) => `https://test/flow=${flowId}&token=${signerToken}`,
    stripSensitive: (data) => data, stripPdfB64: (data) => data,
    sendSignerEmail: async () => ({ ok: true }),
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

async function insertOrg(name) {
  return (await pool.query(`INSERT INTO organizations(name) VALUES($1) RETURNING id`, [name])).rows[0].id;
}
async function insertUser({ orgId, email, nume = 'U', role = 'user', deleted = false }) {
  const { rows } = await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,token_version,deleted_at)
     VALUES($1,'x',$2,$3,$4,1,${deleted ? 'NOW()' : 'NULL'}) RETURNING id`,
    [email, nume, role, orgId]
  );
  return rows[0].id;
}
// Flux cu un singur semnatar 'current' cu token cunoscut (inserat direct, ocolind creation guard).
async function seedFlowWithSigner(id, { orgId, signerEmail, token }) {
  const data = {
    status: 'in_progress', completed: false, orgId,
    initEmail: 'creator@x.ro', docName: 'Doc SEC-103',
    signers: [{ order: 1, name: 'Semnatar', email: signerEmail, rol: 'APROBAT', status: 'current', token }],
  };
  await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1,$2::jsonb,$3)`,
    [id, JSON.stringify(data), orgId]);
  return id;
}
const cookie = (userId, orgId, email = 'creator@x.ro') =>
  makeAuthCookie({ userId, role: 'user', orgId, email, tv: 1 });

beforeAll(migrate);
beforeEach(truncateAll);

d('SEC-103 — semnatar utilizator intern dezactivat', () => {
  // ── CREARE ────────────────────────────────────────────────────────────────
  it('8) creare flux cu semnatar dezactivat ⇒ 400 signer_deactivated, fluxul NU se salvează', async () => {
    const orgId = await insertOrg('Org SEC103 creare');
    const creatorId = await insertUser({ orgId, email: 'creator@x.ro', nume: 'Creator' });
    await insertUser({ orgId, email: 'mort@x.ro', nume: 'Dezactivat', deleted: true });

    const before = await pool.query('SELECT COUNT(*)::int AS n FROM flows');
    const res = await request(createApp()).post('/flows').set('Cookie', cookie(creatorId, orgId)).send({
      docName: 'Doc mort', initName: 'ignorat', initEmail: 'creator@x.ro',
      signers: [{ name: 'Mort', email: 'mort@x.ro', rol: 'AVIZAT', order: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signer_deactivated');
    expect(res.body.emails).toContain('mort@x.ro');

    const after = await pool.query('SELECT COUNT(*)::int AS n FROM flows');
    expect(after.rows[0].n).toBe(before.rows[0].n);   // niciun flux salvat
  });

  it('9) creare flux cu semnatar EXTERN (email fără cont) ⇒ 200, fluxul se creează', async () => {
    const orgId = await insertOrg('Org SEC103 extern');
    const creatorId = await insertUser({ orgId, email: 'creator@x.ro', nume: 'Creator' });

    const res = await request(createApp()).post('/flows').set('Cookie', cookie(creatorId, orgId)).send({
      docName: 'Doc extern', initName: 'ignorat', initEmail: 'creator@x.ro',
      signers: [{ name: 'Extern', email: 'nobody@extern.ro', rol: 'AVIZAT', order: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.flowId).toBeTruthy();

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [res.body.flowId]);
    expect(rows.length).toBe(1);
    expect(rows[0].data.signers.some(s => s.email === 'nobody@extern.ro')).toBe(true);
  });

  // ── SEMNARE (local) ─────────────────────────────────────────────────────────
  it('10) sign cu tokenul unui semnatar dezactivat DUPĂ creare ⇒ 403, status rămâne current în DB', async () => {
    const orgId = await insertOrg('Org SEC103 sign');
    await insertUser({ orgId, email: 'sign-mort@x.ro', nume: 'Sign Mort', deleted: true });
    const flowId = await seedFlowWithSigner('flow-sign-103', { orgId, signerEmail: 'sign-mort@x.ro', token: 'tok-sign' });

    const res = await request(createApp()).post(`/flows/${flowId}/sign`)
      .send({ token: 'tok-sign', signature: 'data:image/png;base64,AAAA' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signer_deactivated');

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    expect(rows[0].data.signers[0].status).toBe('current');   // NU s-a avansat la 'signed'
    expect(rows[0].data.signers[0].signedAt == null).toBe(true);
  });

  it('10b) sign cu semnatar ACTIV ⇒ trece (200), status devine signed', async () => {
    const orgId = await insertOrg('Org SEC103 sign activ');
    await insertUser({ orgId, email: 'sign-viu@x.ro', nume: 'Sign Viu' });
    const flowId = await seedFlowWithSigner('flow-sign-ok-103', { orgId, signerEmail: 'sign-viu@x.ro', token: 'tok-ok' });

    const res = await request(createApp()).post(`/flows/${flowId}/sign`)
      .send({ token: 'tok-ok', signature: 'data:image/png;base64,AAAA' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    expect(rows[0].data.signers[0].status).toBe('signed');
  });

  // ── SEMNARE (STS cloud) ─────────────────────────────────────────────────────
  it('11) initiate-cloud-signing cu semnatar dezactivat ⇒ 403 signer_deactivated', async () => {
    const orgId = await insertOrg('Org SEC103 sts');
    await insertUser({ orgId, email: 'sts-mort@x.ro', nume: 'STS Mort', deleted: true });
    const flowId = await seedFlowWithSigner('flow-sts-103', { orgId, signerEmail: 'sts-mort@x.ro', token: 'tok-sts' });

    const res = await request(createApp()).post(`/flows/${flowId}/initiate-cloud-signing`)
      .send({ token: 'tok-sts', providerId: 'sts' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signer_deactivated');
  });

  // ── DELEGARE ────────────────────────────────────────────────────────────────
  it('12) delegare către un cont dezactivat ⇒ 400 delegate_deactivated', async () => {
    const orgId = await insertOrg('Org SEC103 deleg');
    const signerId = await insertUser({ orgId, email: 'delegator@x.ro', nume: 'Delegator' });
    await insertUser({ orgId, email: 'tinta-moarta@x.ro', nume: 'Tinta Moarta', deleted: true });
    const flowId = await seedFlowWithSigner('flow-deleg-103', { orgId, signerEmail: 'delegator@x.ro', token: 'tok-del' });

    const res = await request(createApp()).post(`/flows/${flowId}/delegate`)
      .set('Cookie', cookie(signerId, orgId, 'delegator@x.ro'))
      .send({ fromToken: 'tok-del', toEmail: 'tinta-moarta@x.ro', reason: 'plec în concediu' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('delegate_deactivated');
  });

  it('13) delegare către un email FĂRĂ cont (extern) ⇒ trece (comportament de azi, neschimbat)', async () => {
    const orgId = await insertOrg('Org SEC103 deleg ext');
    const signerId = await insertUser({ orgId, email: 'delegator2@x.ro', nume: 'Delegator2' });
    const flowId = await seedFlowWithSigner('flow-deleg-ext-103', { orgId, signerEmail: 'delegator2@x.ro', token: 'tok-del2' });

    const res = await request(createApp()).post(`/flows/${flowId}/delegate`)
      .set('Cookie', cookie(signerId, orgId, 'delegator2@x.ro'))
      .send({ fromToken: 'tok-del2', toEmail: 'extern-nou@nowhere.ro', reason: 'deleg extern' });
    expect(res.status).toBe(200);
    expect(res.body.to).toBe('extern-nou@nowhere.ro');
  });

  // ── REFUZ (supapa — NU se blochează) ────────────────────────────────────────
  it('14) refuz de către un semnatar dezactivat ⇒ TRECE (supapa rămâne deschisă)', async () => {
    const orgId = await insertOrg('Org SEC103 refuz');
    await insertUser({ orgId, email: 'refuz-mort@x.ro', nume: 'Refuz Mort', deleted: true });
    const flowId = await seedFlowWithSigner('flow-refuz-103', { orgId, signerEmail: 'refuz-mort@x.ro', token: 'tok-refuz' });

    const res = await request(createApp()).post(`/flows/${flowId}/refuse`)
      .send({ token: 'tok-refuz', reason: 'nu sunt de acord' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    expect(rows[0].data.status).toBe('refused');
  });
});
