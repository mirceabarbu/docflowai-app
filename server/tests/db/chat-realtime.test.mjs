/**
 * Chat Etapa 1 P2 (v3.9.706) — livrare: push WS live / notificare in-app.
 *
 * WS-ul propriu-zis nu se poate testa prin harness (nu pornim serverul WS), dar
 * livrarea NU depinde de el: chat.mjs primește prezența și push-ul ca funcții
 * INJECTATE (`injectPresence` / `injectWsPush`). Testul le stub-uiește și verifică
 * observabilele deterministe: ce rând apare în `notifications` și ce payload
 * pleacă spre push — inclusiv contractul `event:'chat_message'` pinat pentru P3.
 *
 * Routerul REAL, prin lanțul real de middleware, peste un Postgres efemer.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const chatMod = await import('../../routes/chat.mjs');
const chatRouter = chatMod.default;

function buildRealApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/chat', chatRouter);
  return app;
}

const CSRF = 'test-csrf-token-chat-rt';
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;

const d = describe.skipIf(!hasTestDb());

d('chat — livrare live + notificări (Etapa 1 P2)', () => {
  let app;
  let orgA, a1, a2, adminId, admin2Id;

  const A1 = () => ({ userId: a1, role: 'user', orgId: orgA, email: 'a1@x.ro' });
  const A2 = () => ({ userId: a2, role: 'user', orgId: orgA, email: 'a2@x.ro' });

  const newConv = (u, body) =>
    request(app).post('/api/chat/conversations')
      .set('Cookie', authz(u)).set('x-csrf-token', CSRF).send(body);
  const sendMsg = (u, id, body) =>
    request(app).post(`/api/chat/conversations/${id}/messages`)
      .set('Cookie', authz(u)).set('x-csrf-token', CSRF).send({ body });

  const notifs = async (email, type) => (await pool.query(
    `SELECT type, title, message, data FROM notifications
      WHERE user_email = $1 AND type = $2 ORDER BY id`, [email, type])).rows;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    // `notifications` e keyed pe user_email (TEXT, fără FK) ⇒ TRUNCATE ... CASCADE
    // pe `users` NU o atinge. Fără curățarea asta, rândurile ar curge între teste.
    await pool.query('DELETE FROM notifications');
    chatMod.__resetSendRateForTests();
    chatMod.__resetDeliveryForTests();

    const A = await seedOrgUser({ orgName: 'Org A', email: 'a1@x.ro', role: 'user' });
    orgA = A.orgId; a1 = A.userId;
    a2 = await seedUser({ orgId: orgA, email: 'a2@x.ro', nume: 'A Doi' });
    adminId  = await seedUser({ orgId: orgA, email: 'admin@x.ro',  role: 'admin', nume: 'Platforma' });
    admin2Id = await seedUser({ orgId: orgA, email: 'admin2@x.ro', role: 'admin', nume: 'Platforma 2' });
    app = buildRealApp();
  });
  afterEach(() => { chatMod.__resetDeliveryForTests(); });

  it('participant OFFLINE ⇒ notificare in-app; expeditorul NU primește nimic', async () => {
    const c = await newConv(A1(), { kind: 'internal', participant_ids: [a2] });
    expect(c.status).toBe(200);
    const convId = c.body.conversation.id;

    // Implicit (fără injectPresence) toată lumea e „offline" ⇒ calea sendNotif.
    const r = await sendMsg(A1(), convId, 'Salut, ai văzut nota de fundamentare?');
    expect(r.status).toBe(200);

    const forA2 = await notifs('a2@x.ro', 'chat_message');
    expect(forA2).toHaveLength(1);
    expect(forA2[0].title).toBe('💬 Mesaj nou');
    expect(forA2[0].message).toBe('Salut, ai văzut nota de fundamentare?');
    expect(forA2[0].data.conv_id).toBe(convId);

    // NICIODATĂ către expeditor.
    expect(await notifs('a1@x.ro', 'chat_message')).toHaveLength(0);
  });

  it('participant ONLINE ⇒ push WS `chat_message`, FĂRĂ notificare in-app', async () => {
    const push = vi.fn();
    chatMod.injectWsPush(push);
    chatMod.injectPresence((email) => email === 'a2@x.ro');

    const c = await newConv(A1(), { kind: 'internal', participant_ids: [a2] });
    const convId = c.body.conversation.id;
    const r = await sendMsg(A1(), convId, 'Mesaj live');
    expect(r.status).toBe(200);

    expect(push).toHaveBeenCalledTimes(1);
    const [email, payload] = push.mock.calls[0];
    expect(email).toBe('a2@x.ro');
    // Contract pinat pentru P3: event NOU, `data` cu conv_id (Number) + message.
    expect(payload.event).toBe('chat_message');
    expect(payload.data.conv_id).toBe(convId);
    expect(typeof payload.data.conv_id).toBe('number');
    expect(payload.data.message).toMatchObject({
      id: r.body.message.id, conv_id: convId, from_user: a1, body: 'Mesaj live',
    });

    // Livrat live ⇒ nicio notificare persistentă.
    expect(await notifs('a2@x.ro', 'chat_message')).toHaveLength(0);
  });

  it('conversație `platform_support` nouă ⇒ `chat_support_new` la adminii platformei, nu la creator', async () => {
    const c = await newConv(A1(), { kind: 'platform_support' });
    expect(c.status).toBe(200);
    const convId = c.body.conversation.id;

    for (const email of ['admin@x.ro', 'admin2@x.ro']) {
      const rows = await notifs(email, 'chat_support_new');
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('🆘 Cerere de suport nouă');
      expect(rows[0].data.conv_id).toBe(convId);
    }
    // Creatorul (non-admin) nu se auto-alertează.
    expect(await notifs('a1@x.ro', 'chat_support_new')).toHaveLength(0);
  });

  it('creatorul ADMIN nu se auto-alertează la propria conversație de suport', async () => {
    const ADM = { userId: adminId, role: 'admin', orgId: orgA, email: 'admin@x.ro' };
    const c = await newConv(ADM, { kind: 'platform_support' });
    expect(c.status).toBe(200);

    expect(await notifs('admin@x.ro', 'chat_support_new')).toHaveLength(0);
    expect(await notifs('admin2@x.ro', 'chat_support_new')).toHaveLength(1);
  });

  it('non-regresie: fără destinatari (participant plecat) mesajul rămâne 200 + forma din P1', async () => {
    const c = await newConv(A1(), { kind: 'internal', participant_ids: [a2] });
    const convId = c.body.conversation.id;
    await pool.query(
      `UPDATE conversation_participants SET left_at = NOW() WHERE conv_id=$1 AND user_id=$2`,
      [convId, a2]
    );

    const r = await sendMsg(A1(), convId, 'Nimeni activ în afară de mine');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.message).toMatchObject({
      conv_id: convId, from_user: a1, body: 'Nimeni activ în afară de mine',
    });
    expect(typeof r.body.message.id).toBe('number');
    expect(r.body.message.created_at).toBeTruthy();

    // Participantul plecat NU mai primește nimic.
    expect(await notifs('a2@x.ro', 'chat_message')).toHaveLength(0);
  });

  it('non-regresie: un push care ARUNCĂ nu rupe răspunsul 200', async () => {
    chatMod.injectWsPush(() => { throw new Error('ws mort'); });
    chatMod.injectPresence(() => true);

    const c = await newConv(A1(), { kind: 'internal', participant_ids: [a2] });
    const convId = c.body.conversation.id;
    const r = await sendMsg(A1(), convId, 'Mesajul se salvează oricum');
    expect(r.status).toBe(200);
    expect(r.body.message.body).toBe('Mesajul se salvează oricum');

    // Mesajul e persistat chiar dacă livrarea a eșuat.
    const { rows } = await pool.query('SELECT body FROM messages WHERE conv_id=$1', [convId]);
    expect(rows).toHaveLength(1);
  });
});
