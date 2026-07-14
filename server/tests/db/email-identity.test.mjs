/**
 * SEC-102: „email = identitate" — cele 7 căutări `WHERE email=$1` din flows/ nu filtrau
 * `deleted_at IS NULL`. Migrația 067 a înlocuit `UNIQUE(email)` cu un index PARȚIAL
 * (`users_email_active_uniq ON lower(email) WHERE deleted_at IS NULL`) ⇒ un email poate
 * exista de mai multe ori (activ + N șterși). Fără filtru, `rows[0]` putea fi rândul ȘTERS.
 *
 * Scenariul de reutilizare NU se poate simula credibil cu mock-uri — de-aceea testul e pe
 * Postgres real. Exercită situl cel mai important (crud.mjs: creare flux) prin lanțul real:
 * `POST /flows` → auto-redirect concediu → funcția/identitatea rezolvată din `users`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    newFlowId: () => `EMAIL_ID_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    buildSignerLink: (_req, flowId, signerToken) => `https://test/flow=${flowId}&token=${signerToken}`,
    stripSensitive: (data) => data, stripPdfB64: (data) => data,
    sendSignerEmail: async () => ({ ok: true }),
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

async function insertOrg(name) {
  return (await pool.query(`INSERT INTO organizations(name) VALUES($1) RETURNING id`, [name])).rows[0].id;
}
async function insertUser({ orgId, email, nume = 'U', functie = '', role = 'user', deleted = false }) {
  const { rows } = await pool.query(
    `INSERT INTO users(email,password_hash,nume,functie,role,org_id,token_version,deleted_at)
     VALUES($1,'x',$2,$3,$4,$5,1,${deleted ? 'NOW()' : 'NULL'}) RETURNING id`,
    [email, nume, functie, role, orgId]
  );
  return rows[0].id;
}
// Setează concediu activ + delegat direct în DB (ocolind validarea leave_start_in_past).
async function setLeaveWithDelegate(userId, delegateId) {
  await pool.query(
    `UPDATE users SET leave_start=CURRENT_DATE-1, leave_end=CURRENT_DATE+2, delegate_user_id=$1 WHERE id=$2`,
    [delegateId, userId]
  );
}
const cookie = (userId, orgId) => makeAuthCookie({ userId, role: 'user', orgId, email: 'p1@x.ro', tv: 1 });

beforeAll(migrate);
beforeEach(truncateAll);

d('SEC-102 — email = identitate (deleted_at IS NULL + lower(email))', () => {
  it('reutilizare email → funcția rezolvată e a userului ACTIV (Secretar), nu a celui ȘTERS (Primar)', async () => {
    const orgId = await insertOrg('Org Reuse');
    const creatorId = await insertUser({ orgId, email: 'p1@x.ro', nume: 'Creator' });
    // Rândul ȘTERS se inserează PRIMUL: pe heap-ul proaspăt, un `WHERE email=$1` fără filtru
    // (bug-ul) l-ar întoarce ca rows[0]. Forțăm ordinea ca testul să pice fără fix.
    await insertUser({ orgId, email: 'x@y.ro', nume: 'Vechi', functie: 'Primar', deleted: true });
    const delegateId = await insertUser({ orgId, email: 'delegat@y.ro', nume: 'Delegatul', functie: 'Delegat-Fn' });
    const activeId = await insertUser({ orgId, email: 'x@y.ro', nume: 'Nou', functie: 'Secretar' });
    await setLeaveWithDelegate(activeId, delegateId);

    // Sanity: chiar EXISTĂ 2 rânduri pentru același email (activ + șters).
    const dup = await pool.query(`SELECT id FROM users WHERE email='x@y.ro'`);
    expect(dup.rowCount).toBe(2);

    const res = await request(createApp()).post('/flows').set('Cookie', cookie(creatorId, orgId)).send({
      docName: 'Doc reuse', initName: 'ignorat', initEmail: 'p1@x.ro',
      signers: [{ name: 'Semnatar X', email: 'x@y.ro', rol: 'AVIZAT', order: 1 }],
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [res.body.flowId]);
    const s0 = rows[0].data.signers[0];
    // Auto-redirect concediu se declanșează DOAR dacă lookup-ul a găsit userul ACTIV (are concediu+delegat).
    expect(s0.delegatedForUserId).toBe(activeId);
    expect(s0.delegatedFrom.functie).toBe('Secretar');   // NU 'Primar' (rândul șters)
    expect(s0.email).toBe('delegat@y.ro');                // substituit cu delegatul
  });

  it('email doar pe rând ȘTERS → lookup gol, fluxul se creează fără delegare, fără crash', async () => {
    const orgId = await insertOrg('Org DeletedOnly');
    const creatorId = await insertUser({ orgId, email: 'p1@x.ro', nume: 'Creator' });
    await insertUser({ orgId, email: 'ghost@y.ro', nume: 'Fantoma', functie: 'Primar', deleted: true });

    const res = await request(createApp()).post('/flows').set('Cookie', cookie(creatorId, orgId)).send({
      docName: 'Doc ghost', initName: 'ignorat', initEmail: 'p1@x.ro',
      signers: [{ name: 'Ghost', email: 'ghost@y.ro', rol: 'AVIZAT', order: 1 }],
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [res.body.flowId]);
    const s0 = rows[0].data.signers[0];
    expect(s0.delegatedForUserId).toBeNull();     // negăsit ⇒ nicio delegare
    expect(s0.delegatedFrom).toBeUndefined();
    expect(s0.email).toBe('ghost@y.ro');          // slotul rămâne neschimbat
  });

  it('email ne-lowercase (Mircea@Y.ro) → găsit prin lower(email); funcția rezolvată = Secretar', async () => {
    const orgId = await insertOrg('Org MixedCase');
    const creatorId = await insertUser({ orgId, email: 'p1@x.ro', nume: 'Creator' });
    const delegateId = await insertUser({ orgId, email: 'delegat2@y.ro', nume: 'Del2', functie: 'D2' });
    // Rând activ cu email stocat MIXED-CASE (legacy, dinainte de disciplina lowercase).
    const activeId = await insertUser({ orgId, email: 'Mircea@Y.ro', nume: 'Mircea', functie: 'Secretar' });
    await setLeaveWithDelegate(activeId, delegateId);

    const res = await request(createApp()).post('/flows').set('Cookie', cookie(creatorId, orgId)).send({
      docName: 'Doc mixed', initName: 'ignorat', initEmail: 'p1@x.ro',
      signers: [{ name: 'Mixed', email: 'mircea@y.ro', rol: 'AVIZAT', order: 1 }],
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [res.body.flowId]);
    const s0 = rows[0].data.signers[0];
    // `lower(email)=$1` REPARĂ, nu doar decorează: emailul stocat 'Mircea@Y.ro' e găsit cu 'mircea@y.ro'.
    expect(s0.delegatedForUserId).toBe(activeId);
    expect(s0.delegatedFrom.functie).toBe('Secretar');
  });
});
