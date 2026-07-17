/**
 * Chat Etapa 1 (v3.9.705) — izolarea e invariantul critic ⇒ DB REAL, nu mock.
 *
 * Testul lovește routerul REAL prin lanțul real de middleware (requireAuth +
 * csrfMiddleware + requireModule('chat')) peste un Postgres efemer, și importă
 * helper-ele DIN PRODUCȚIE (isConversationParticipant / assertSameOrgParticipants)
 * — nu redeclară logica.
 *
 * Regula verificată peste tot: „ești participant ACTIV?", NU „e mesajul în org-ul
 * meu" — de aceea `platform_support` traversează org-ul legitim, iar un ne-participant
 * primește 404 (nu 403) chiar dacă e în același org.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, makeAuthCookie } from '../helpers/db-real.mjs';

// Doar logger-ul e mock-uit (zgomot în output) — csrf, require-module, chat-access, db: REALE.
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const chatMod = await import('../../routes/chat.mjs');
const chatRouter = chatMod.default;
const { isConversationParticipant, assertSameOrgParticipants } =
  await import('../../services/chat-access.mjs');

function buildRealApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/chat', chatRouter);
  return app;
}

const CSRF = 'test-csrf-token-chat';
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;

const d = describe.skipIf(!hasTestDb());

d('chat — izolare pe „participant activ" (Etapa 1 P1)', () => {
  let app;
  // Org A: a1 (user 1), a2 (user 2), a3 (user 3). Org B: b1 (user 4). Platformă: adminul (user 5).
  let orgA, orgB, a1, a2, a3, b1, adminId;

  const A1 = () => ({ userId: a1, role: 'user',  orgId: orgA, email: 'a1@x.ro' });
  const A2 = () => ({ userId: a2, role: 'user',  orgId: orgA, email: 'a2@x.ro' });
  const A3 = () => ({ userId: a3, role: 'user',  orgId: orgA, email: 'a3@x.ro' });
  const B1 = () => ({ userId: b1, role: 'user',  orgId: orgB, email: 'b1@x.ro' });
  const ADM = () => ({ userId: adminId, role: 'admin', orgId: orgA, email: 'admin@x.ro' });

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    // Rate-limit-ul e in-memory, keyed pe userId; truncateAll resetează id-urile SERIAL
    // ⇒ fără reset, testul următor ar moșteni cota consumată de cel precedent.
    chatMod.__resetSendRateForTests();
    const A = await seedOrgUser({ orgName: 'Org A', email: 'a1@x.ro', role: 'user' });
    orgA = A.orgId; a1 = A.userId;
    a2 = await seedUser({ orgId: orgA, email: 'a2@x.ro', nume: 'A Doi' });
    a3 = await seedUser({ orgId: orgA, email: 'a3@x.ro', nume: 'A Trei' });
    const B = await seedOrgUser({ orgName: 'Org B', email: 'b1@x.ro', role: 'user' });
    orgB = B.orgId; b1 = B.userId;
    adminId = await seedUser({ orgId: orgA, email: 'admin@x.ro', role: 'admin', nume: 'Platforma' });
    app = buildRealApp();
  });
  afterAll(() => pool.end());

  // ── helpers de request ─────────────────────────────────────────────────────
  const createConv = (u, body) =>
    request(app).post('/api/chat/conversations')
      .set('Cookie', authz(u)).set('x-csrf-token', CSRF).send(body);
  const listConvs = (u) =>
    request(app).get('/api/chat/conversations').set('Cookie', authz(u));
  const getMsgs = (u, id, qs = '') =>
    request(app).get(`/api/chat/conversations/${id}/messages${qs}`).set('Cookie', authz(u));
  const sendMsg = (u, id, body) =>
    request(app).post(`/api/chat/conversations/${id}/messages`)
      .set('Cookie', authz(u)).set('x-csrf-token', CSRF).send({ body });
  const markRead = (u, id) =>
    request(app).post(`/api/chat/conversations/${id}/read`)
      .set('Cookie', authz(u)).set('x-csrf-token', CSRF).send({});

  const conv1to1 = async () => {
    const r = await createConv(A1(), { kind: 'internal', participant_ids: [a2] });
    expect(r.status).toBe(200);
    return r.body.conversation.id;
  };

  // ── 1. Participant activ vs. non-participant ───────────────────────────────
  describe('1. participant activ vede; non-participant primește 404', () => {
    it('participantul vede conversația și mesajele', async () => {
      const id = await conv1to1();
      expect((await sendMsg(A1(), id, 'salut')).status).toBe(200);

      const r = await getMsgs(A2(), id);
      expect(r.status).toBe(200);
      expect(r.body.messages.map(m => m.body)).toEqual(['salut']);
      expect(r.body.messages[0].from_nume).toBeTruthy();

      const l = await listConvs(A2());
      expect(l.body.conversations.map(c => c.id)).toContain(id);
    });

    it('non-participant DIN ACELAȘI org primește 404 pe GET/POST messages și read', async () => {
      const id = await conv1to1();
      // a3 e în org-ul A (deci „mesajul e în org-ul lui"), dar NU e participant ⇒ 404.
      expect((await getMsgs(A3(), id)).status).toBe(404);
      expect((await sendMsg(A3(), id, 'intrus')).status).toBe(404);
      expect((await markRead(A3(), id)).status).toBe(404);
      // și nu apare în lista lui
      expect((await listConvs(A3())).body.conversations).toEqual([]);
    });

    it('helper-ul de producție confirmă regula (activ vs. plecat)', async () => {
      const id = await conv1to1();
      expect(await isConversationParticipant(id, a1, pool)).toBe(true);
      expect(await isConversationParticipant(id, a3, pool)).toBe(false);
      // left_at setat ⇒ nu mai e participant ACTIV
      await pool.query(
        `UPDATE conversation_participants SET left_at = NOW() WHERE conv_id=$1 AND user_id=$2`,
        [id, a2]
      );
      expect(await isConversationParticipant(id, a2, pool)).toBe(false);
      expect((await getMsgs(A2(), id)).status).toBe(404);
    });
  });

  // ── 2. Cross-org ───────────────────────────────────────────────────────────
  describe('2. cross-org: user din B nu poate fi adăugat la o conversație internal a lui A', () => {
    it('POST /conversations cu participant din alt org ⇒ 403 cross_org_forbidden', async () => {
      const r = await createConv(A1(), { kind: 'internal', participant_ids: [b1] });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('cross_org_forbidden');
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM conversations');
      expect(rows[0].n).toBe(0); // nimic nu s-a creat
    });

    it('grup mixt (un participant din alt org) ⇒ tot 403', async () => {
      const r = await createConv(A1(), { kind: 'internal', participant_ids: [a2, b1] });
      expect(r.status).toBe(403);
    });

    it('helper-ul de producție assertSameOrgParticipants respinge mixul', async () => {
      expect(await assertSameOrgParticipants(orgA, [a1, a2], pool)).toBe(true);
      expect(await assertSameOrgParticipants(orgA, [a1, b1], pool)).toBe(false);
    });
  });

  // ── 3. Idempotență 1-la-1 ──────────────────────────────────────────────────
  describe('3. idempotență 1-la-1 internal', () => {
    it('două POST cu aceiași 2 useri ⇒ ACEEAȘI conv_id', async () => {
      const id1 = await conv1to1();
      const id2 = await conv1to1();
      expect(id2).toBe(id1);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM conversations');
      expect(rows[0].n).toBe(1);
    });

    it('dedup e simetric (a2 inițiază spre a1 ⇒ aceeași conversație)', async () => {
      const id1 = await conv1to1();
      const r = await createConv(A2(), { kind: 'internal', participant_ids: [a1] });
      expect(r.body.conversation.id).toBe(id1);
    });

    it('grupurile NU se dedup', async () => {
      const g1 = await createConv(A1(), { kind: 'internal', participant_ids: [a2, a3] });
      const g2 = await createConv(A1(), { kind: 'internal', participant_ids: [a2, a3] });
      expect(g1.body.conversation.is_group).toBe(true);
      expect(g2.body.conversation.id).not.toBe(g1.body.conversation.id);
    });
  });

  // ── 4. platform_support ────────────────────────────────────────────────────
  describe('4. platform_support traversează org-ul', () => {
    it('conversația îl include pe admin; adminul o vede; user din B primește 404', async () => {
      const r = await createConv(A1(), { kind: 'platform_support' });
      expect(r.status).toBe(200);
      const id = r.body.conversation.id;
      expect(r.body.conversation.kind).toBe('platform_support');
      // org_id = org-ul actorului, ca platforma să vadă din ce primărie vine
      expect(r.body.conversation.org_id).toBe(orgA);

      expect(await isConversationParticipant(id, adminId, pool)).toBe(true);

      await sendMsg(A1(), id, 'am o problemă');
      const asAdmin = await getMsgs(ADM(), id);
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.messages.map(m => m.body)).toEqual(['am o problemă']);

      // b1 nu e participant ⇒ 404, deși conversația e cross-org prin natura ei
      expect((await getMsgs(B1(), id)).status).toBe(404);
      expect((await listConvs(B1())).body.conversations).toEqual([]);
    });
  });

  // ── 5. unread ──────────────────────────────────────────────────────────────
  describe('5. unread', () => {
    it('2 mesaje de la altul ⇒ unread=2; după POST /read ⇒ 0', async () => {
      const id = await conv1to1();
      await sendMsg(A1(), id, 'unu');
      await sendMsg(A1(), id, 'doi');

      let l = await listConvs(A2());
      let c = l.body.conversations.find(x => x.id === id);
      expect(c.unread).toBe(2);
      expect(c.last_message.body).toBe('doi');
      expect(c.participants.map(p => p.user_id).sort()).toEqual([a1, a2].sort());

      expect((await markRead(A2(), id)).status).toBe(200);
      l = await listConvs(A2());
      expect(l.body.conversations.find(x => x.id === id).unread).toBe(0);

      // propriile mesaje nu se numără ca necitite pentru expeditor
      expect((await listConvs(A1())).body.conversations.find(x => x.id === id).unread).toBe(0);
    });
  });

  // ── 6. rate-limit ──────────────────────────────────────────────────────────
  describe('6. rate-limit trimitere', () => {
    it('al 31-lea POST în aceeași fereastră ⇒ 429', async () => {
      const id = await conv1to1();
      for (let i = 0; i < 30; i++) {
        expect((await sendMsg(A1(), id, `m${i}`)).status).toBe(200);
      }
      const over = await sendMsg(A1(), id, 'peste limită');
      expect(over.status).toBe(429);
      expect(over.body.error).toBe('rate_limited');
      // limita e PER user — a2 trimite în continuare
      expect((await sendMsg(A2(), id, 'eu pot')).status).toBe(200);
    });
  });

  // ── validare body ──────────────────────────────────────────────────────────
  describe('validare body mesaj', () => {
    it('gol / doar spații / >4000 chars ⇒ 400 body_invalid', async () => {
      const id = await conv1to1();
      expect((await sendMsg(A1(), id, '   ')).status).toBe(400);
      const r = await sendMsg(A1(), id, 'x'.repeat(4001));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('body_invalid');
      expect((await sendMsg(A1(), id, 'x'.repeat(4000))).status).toBe(200);
    });
  });

  // ── tombstone ──────────────────────────────────────────────────────────────
  describe('tombstone mesaj șters', () => {
    it('rândul se întoarce cu body golit, nu se filtrează din SQL', async () => {
      const id = await conv1to1();
      const m = await sendMsg(A1(), id, 'secret');
      await pool.query('UPDATE messages SET deleted_at = NOW() WHERE id=$1', [m.body.message.id]);
      const r = await getMsgs(A2(), id);
      expect(r.body.messages).toHaveLength(1);
      expect(r.body.messages[0].body).toBe('');
      expect(r.body.messages[0].deleted_at).toBeTruthy();
      // ...dar nu se numără la unread
      expect((await listConvs(A2())).body.conversations.find(x => x.id === id).unread).toBe(0);
    });
  });
});
