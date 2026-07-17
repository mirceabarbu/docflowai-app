/**
 * server/routes/chat.mjs — Chat Etapa 1 (mesagerie), montat pe /api/chat
 *
 *   GET  /conversations                 — conversațiile active ale actorului
 *   POST /conversations                 — creează (internal | platform_support)
 *   GET  /conversations/:id/messages    — istoric paginat (spre trecut)
 *   POST /conversations/:id/messages    — trimite mesaj
 *   POST /conversations/:id/read        — marchează citit
 *
 * Auth: cookie JWT (requireAuth MIDDLEWARE-mode în tot fișierul — NU amesteca
 * cu helper-mode, vezi CLAUDE.md). Gating: requireModule('chat').
 *
 * IZOLARE — regula unică: „ești participant ACTIV?" (chat-access.mjs), NU
 * „e mesajul în org-ul meu". Conversația e unitatea de izolare; o conversație
 * `platform_support` traversează intenționat org-urile. Gate-ul răspunde 404
 * (nu 403) pe non-participant — nu divulgăm existența conversației.
 *
 * Livrare (P2): participant conectat ⇒ push WS `chat_message`; deconectat ⇒
 * notificare in-app persistentă. Ambele NON-FATALE — vezi `deliverMessage`.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { requireModule } from '../middleware/require-module.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { isConversationParticipant, assertSameOrgParticipants } from '../services/chat-access.mjs';
import { sendNotif } from '../services/formular-shared.mjs';

const router = Router();
const _chat = requireModule('chat');

const MAX_BODY = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function _db(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return false; }
  return true;
}

function _noStore(res) { res.set('Cache-Control', 'no-store'); }

// ── Rate-limit trimitere (Etapa 1: in-memory — se resetează la restart Railway,
// acceptat pentru etapa asta; aceeași convenție ca middleware/rateLimiter.mjs).
const _sendWindows = new Map(); // userId -> number[] (timestamps ms)
function checkSendRate(userId) {
  const now = Date.now(), win = 60_000, max = 30;
  const arr = (_sendWindows.get(userId) || []).filter(t => now - t < win);
  if (arr.length >= max) return false;
  arr.push(now); _sendWindows.set(userId, arr); return true;
}
// Test-only: ferestrele sunt in-memory și supraviețuiesc lui truncateAll (care resetează
// id-urile SERIAL) → fără reset, testele ar moșteni cota userului cu același id.
export function __resetSendRateForTests() { _sendWindows.clear(); }

// ── Livrare live (P2) ────────────────────────────────────────────────────────
// Starea WS trăiește în index.mjs; aici primim DOAR două funcții injectate, ca
// routerul să rămână testabil fără server WS pornit.
let _wsPush = null;
export function injectWsPush(fn) { _wsPush = fn; }

let _isOnline = () => false;
export function injectPresence(fn) { _isOnline = fn; }
function wsClientsHas(email) {
  try { return !!_isOnline(email); } catch (_) { return false; }
}
// Test-only: reset la starea implicită (offline, fără push).
export function __resetDeliveryForTests() { _wsPush = null; _isOnline = () => false; }

/** Corpul notificării: o singură linie, ~80 caractere (titlul e fix). */
function preview(body) {
  const one = String(body || '').replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
}

/**
 * Livrează mesajul participanților ACTIVI, mai puțin expeditorul.
 * Conectat ⇒ push WS `chat_message` (event NOU — nu refolosim `notification`,
 * ca să nu amestecăm cu toast-urile de flux). Deconectat ⇒ notificare in-app.
 *
 * ⚠️ NON-FATAL în întregime: apelantul a răspuns deja 200 conceptual — o eroare
 * de livrare NU trebuie să transforme un mesaj salvat într-un 500.
 */
async function deliverMessage(convId, actor, msg) {
  try {
    const { rows: recips } = await pool.query(
      `SELECT p.user_id, u.email
         FROM conversation_participants p
         JOIN users u ON u.id = p.user_id
        WHERE p.conv_id = $1 AND p.left_at IS NULL AND p.user_id <> $2`,
      [convId, actor.userId]
    );

    const payload = {
      event: 'chat_message',
      data: {
        conv_id: Number(convId),
        message: {
          id: Number(msg.id),
          conv_id: Number(convId),
          from_user: actor.userId,
          from_nume: actor.nume || '',
          body: msg.body,
          created_at: msg.created_at,
        },
      },
    };

    for (const r of recips) {
      const email = String(r.email || '').toLowerCase();
      if (_wsPush && email && wsClientsHas(email)) {
        try { _wsPush(email, payload); }
        catch (e) { logger.warn({ err: e, convId }, '[chat] wsPush non-fatal'); }
      } else {
        try {
          await sendNotif(r.user_id, 'chat_message', '💬 Mesaj nou',
            preview(msg.body), { conv_id: Number(convId) });
        } catch (e) { logger.warn({ err: e, convId }, '[chat] sendNotif non-fatal'); }
      }
    }
  } catch (e) {
    logger.warn({ err: e, convId }, '[chat] livrare mesaj eșuată (non-fatal)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations — conversațiile ACTIVE ale actorului, desc după updated_at
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations', requireAuth, _chat, async (req, res) => {
  if (!_db(res)) return;
  const actor = req.actor;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.kind, c.is_group, c.title, c.org_id, c.updated_at,
              lm.body       AS lm_body,
              lm.from_user  AS lm_from_user,
              lm.created_at AS lm_created_at,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.conv_id = c.id
                   AND m.deleted_at IS NULL
                   AND m.from_user <> $1
                   AND m.created_at > COALESCE(me.last_read_at, 'epoch'::timestamptz)
              )::int AS unread,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'user_id', u.id, 'nume', u.nume, 'email', u.email)
                         ORDER BY u.id)
                  FROM conversation_participants p2
                  JOIN users u ON u.id = p2.user_id
                 WHERE p2.conv_id = c.id AND p2.left_at IS NULL
              ), '[]'::json) AS participants
         FROM conversations c
         JOIN conversation_participants me
           ON me.conv_id = c.id AND me.user_id = $1 AND me.left_at IS NULL
         LEFT JOIN LATERAL (
              SELECT m.body, m.from_user, m.created_at
                FROM messages m
               WHERE m.conv_id = c.id AND m.deleted_at IS NULL
               ORDER BY m.created_at DESC, m.id DESC
               LIMIT 1
         ) lm ON TRUE
        ORDER BY c.updated_at DESC`,
      [actor.userId]
    );
    _noStore(res);
    res.json({
      ok: true,
      conversations: rows.map(r => ({
        id: Number(r.id),
        kind: r.kind,
        is_group: r.is_group,
        title: r.title,
        org_id: r.org_id,
        updated_at: r.updated_at,
        last_message: r.lm_created_at
          ? { body: r.lm_body, from_user: r.lm_from_user, created_at: r.lm_created_at }
          : null,
        unread: r.unread,
        participants: r.participants,
      })),
    });
  } catch (e) {
    logger.error({ err: e, userId: actor.userId }, 'chat: listare conversații eșuată');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations — { kind, participant_ids:[int], is_group:bool, title? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations', requireAuth, csrfMiddleware, _chat, async (req, res) => {
  if (!_db(res)) return;
  const actor = req.actor;
  const kind = String(req.body?.kind || 'internal');
  const title = req.body?.title ? String(req.body.title).slice(0, 200) : null;

  if (kind !== 'internal' && kind !== 'platform_support') {
    return res.status(400).json({ error: 'kind_invalid' });
  }

  let ids = [];
  if (kind === 'internal') {
    const raw = Array.isArray(req.body?.participant_ids) ? req.body.participant_ids : [];
    ids = [...new Set([Number(actor.userId), ...raw.map(Number)].filter(Boolean))];
    if (ids.length < 2) return res.status(400).json({ error: 'participants_invalid' });
    const sameOrg = await assertSameOrgParticipants(actor.orgId, ids, pool);
    if (!sameOrg) return res.status(403).json({ error: 'cross_org_forbidden' });
  }

  const client = await pool.connect();
  try {
    if (kind === 'platform_support') {
      // Platforma = toți userii cu role='admin'. Conversația traversează org-ul
      // INTENȚIONAT → NU se aplică assertSameOrgParticipants.
      const { rows: admins } = await client.query(
        `SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`
      );
      ids = [...new Set([Number(actor.userId), ...admins.map(a => Number(a.id))].filter(Boolean))];
    }

    // Idempotență 1-la-1 `internal`: aceiași 2 participanți activi ⇒ aceeași conversație.
    // (Grupurile NU se dedup — pot exista mai multe grupuri cu aceiași membri.)
    if (kind === 'internal' && ids.length === 2) {
      const { rows: existing } = await client.query(
        `SELECT c.id, c.kind, c.is_group, c.title, c.org_id, c.created_at
           FROM conversations c
          WHERE c.kind = 'internal' AND c.is_group = FALSE
            AND (SELECT COUNT(*) FROM conversation_participants p
                  WHERE p.conv_id = c.id AND p.left_at IS NULL) = 2
            AND (SELECT COUNT(*) FROM conversation_participants p
                  WHERE p.conv_id = c.id AND p.left_at IS NULL
                    AND p.user_id = ANY($1::int[])) = 2
          ORDER BY c.id
          LIMIT 1`,
        [ids]
      );
      if (existing.length) {
        _noStore(res);
        return res.json({ ok: true, conversation: {
          id: Number(existing[0].id), kind: existing[0].kind, is_group: existing[0].is_group,
          title: existing[0].title, org_id: existing[0].org_id, created_at: existing[0].created_at,
        } });
      }
    }

    const isGroup = ids.length >= 3;

    await client.query('BEGIN');
    // org_id = org-ul actorului și pentru platform_support (platforma vede din ce primărie vine).
    const { rows: conv } = await client.query(
      `INSERT INTO conversations (org_id, kind, is_group, title, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, is_group, title, org_id, created_at`,
      [actor.orgId ?? null, kind, isGroup, title, actor.userId]
    );
    const convId = conv[0].id;
    for (const uid of ids) {
      const isOwner = Number(uid) === Number(actor.userId);
      await client.query(
        `INSERT INTO conversation_participants (conv_id, user_id, role, last_read_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conv_id, user_id) DO NOTHING`,
        [convId, uid, isOwner ? 'owner' : 'member', isOwner ? new Date() : null]
      );
    }
    await client.query('COMMIT');

    // Alertă „cerere de suport nouă" către platformă. Se ajunge aici DOAR pe
    // conversație nou creată — ramura idempotentă de mai sus a returnat deja
    // (și oricum privește doar `internal`). Push-ul live către un admin conectat
    // vine din deliverMessage la primul mesaj; alerta de aici marchează
    // evenimentul „s-a deschis o conversație de suport". Non-fatală.
    if (kind === 'platform_support') {
      try {
        const { rows: admins } = await pool.query(
          `SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL AND id <> $1`,
          [actor.userId]
        );
        for (const a of admins) {
          await sendNotif(a.id, 'chat_support_new', '🆘 Cerere de suport nouă',
            `${actor.nume || actor.email} a deschis o conversație de suport.`,
            { conv_id: Number(convId) });
        }
      } catch (e) {
        logger.warn({ err: e, convId }, '[chat] alertă suport non-fatală');
      }
    }

    _noStore(res);
    res.json({ ok: true, conversation: {
      id: Number(conv[0].id), kind: conv[0].kind, is_group: conv[0].is_group,
      title: conv[0].title, org_id: conv[0].org_id, created_at: conv[0].created_at,
    } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e, userId: actor.userId }, 'chat: creare conversație eșuată');
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations/:id/messages?before=<msgId>&limit=50
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:id/messages', requireAuth, _chat, async (req, res) => {
  if (!_db(res)) return;
  const actor = req.actor;
  const convId = Number(req.params.id);
  if (!convId) return res.status(404).json({ error: 'not_found' });

  try {
    // Gate: non-participant ⇒ 404 (nu 403 — nu divulgăm existența conversației).
    if (!await isConversationParticipant(convId, actor.userId, pool)) {
      return res.status(404).json({ error: 'not_found' });
    }

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    limit = Math.min(limit, MAX_LIMIT);
    const before = Number(req.query.before) || null;

    // Cele mai recente `limit` mesaje (desc), apoi inversate în ASC pentru client.
    // +1 rând ca să știm dacă mai există istoric (has_more).
    const { rows } = await pool.query(
      `SELECT m.id, m.conv_id, m.from_user, u.nume AS from_nume,
              m.body, m.created_at, m.deleted_at
         FROM messages m
         LEFT JOIN users u ON u.id = m.from_user
        WHERE m.conv_id = $1
          AND ($2::bigint IS NULL OR m.id < $2::bigint)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $3`,
      [convId, before, limit + 1]
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    _noStore(res);
    res.json({
      ok: true,
      // Tombstone: rândul șters se ÎNTOARCE (nu se filtrează din SQL), dar cu body
      // golit — P3 afișează „mesaj șters" fără să afle conținutul.
      messages: page.reverse().map(r => ({
        id: Number(r.id),
        conv_id: Number(r.conv_id),
        from_user: r.from_user,
        from_nume: r.from_nume,
        body: r.deleted_at ? '' : r.body,
        created_at: r.created_at,
        deleted_at: r.deleted_at,
      })),
      has_more: hasMore,
    });
  } catch (e) {
    logger.error({ err: e, convId, userId: actor.userId }, 'chat: citire mesaje eșuată');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations/:id/messages — { body:string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/messages', requireAuth, csrfMiddleware, _chat, async (req, res) => {
  if (!_db(res)) return;
  const actor = req.actor;
  const convId = Number(req.params.id);
  if (!convId) return res.status(404).json({ error: 'not_found' });

  try {
    if (!await isConversationParticipant(convId, actor.userId, pool)) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!checkSendRate(actor.userId)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    const body = String(req.body?.body ?? '').trim();
    if (!body || body.length > MAX_BODY) {
      return res.status(400).json({ error: 'body_invalid' });
    }

    const { rows } = await pool.query(
      `INSERT INTO messages (conv_id, from_user, body)
       VALUES ($1, $2, $3)
       RETURNING id, conv_id, from_user, body, created_at`,
      [convId, actor.userId, body]
    );
    await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [convId]);

    // Livrare live / notificare — non-fatală prin construcție (deliverMessage
    // își înghite propriile erori) ⇒ răspunsul 200 de mai jos e garantat.
    await deliverMessage(convId, actor, rows[0]);

    _noStore(res);
    res.json({ ok: true, message: {
      id: Number(rows[0].id),
      conv_id: Number(rows[0].conv_id),
      from_user: rows[0].from_user,
      body: rows[0].body,
      created_at: rows[0].created_at,
    } });
  } catch (e) {
    logger.error({ err: e, convId, userId: actor.userId }, 'chat: trimitere mesaj eșuată');
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations/:id/read
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/read', requireAuth, csrfMiddleware, _chat, async (req, res) => {
  if (!_db(res)) return;
  const actor = req.actor;
  const convId = Number(req.params.id);
  if (!convId) return res.status(404).json({ error: 'not_found' });

  try {
    if (!await isConversationParticipant(convId, actor.userId, pool)) {
      return res.status(404).json({ error: 'not_found' });
    }
    await pool.query(
      `UPDATE conversation_participants SET last_read_at = NOW()
        WHERE conv_id = $1 AND user_id = $2`,
      [convId, actor.userId]
    );
    _noStore(res);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e, convId, userId: actor.userId }, 'chat: marcare citit eșuată');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
