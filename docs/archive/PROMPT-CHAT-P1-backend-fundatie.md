---
id: CHAT-P1
titlu: CHAT Etapa 1 — Fundație backend (schema + chat-access + endpoints REST)
model_suggested: Opus 4.8
branch: develop
bump: 3.9.705   # backend-only (migrație + rute noi), FĂRĂ cache bump, FĂRĂ ?v= bump
ordine: rulează P1 ÎNTÂI. Verifică formele de răspuns (§CONTRACTE) apoi P2, apoi P3.
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU face merge / push / checkout pe `main`.
`main` = PRODUCȚIE, gestionat manual DOAR de Mircea. Totul rămâne pe `develop`.

===============================================================================
CONTEXT (arhitectură decisă — nu re-proiecta, execută; verificat pe cod v3.9.704)
===============================================================================

Construim un chat in-app. Etapa 1 = MESAGERIE (fără presence — aia e Etapa 2).
Regula de aur a izolării, o SINGURĂ regulă peste tot: „ești participant ACTIV?"
(participant cu `left_at IS NULL`) — NU „e mesajul în org-ul meu". Conversația e
unitatea de izolare, nu mesajul. Două tipuri de conversație:
 • `internal`       — user↔user în ACEEAȘI org (toți participanții din același org)
 • `platform_support` — user↔platformă (traversează org; platforma = role='admin')

Fundații existente pe care ne bazăm (verificate):
 • FK sigure pe fresh-provision: `users.id` (SERIAL) și `organizations.id` (SERIAL)
   sunt create INLINE (index.mjs:166 / :293) → migrația nouă cu FK către ele NU e
   clasa de mină 068. `users.org_id` (INTEGER) există (ALTER la index.mjs:319).
 • Gating pe modul: `requireModule('chat')` (server/middleware/require-module.mjs) —
   403 `module_disabled`, bypass superadmin, fail-closed 503. Catalog + entitlements
   deja există (migrațiile 070/071). `/api/entitlements/me` întoarce `{modules}`.
 • sessionGuard păzește deja `/api/` → rutele `/api/chat/*` sunt acoperite automat.
 • Următoarea migrație inline = **100** (ultima e 099).

MODELE DE OGLINDIT (mirror structura, nu reinventa):
 • `server/routes/registratura.mjs` — router module-gated: importuri (requireAuth,
   csrfMiddleware, isModuleEnabled), auth helper-mode, izolare pe `actor.orgId`.
 • `server/services/flow-access.mjs` — modul-helper de acces (analog pt chat-access).

===============================================================================
PAS 1 — Migrația 100_chat (INLINE în server/db/index.mjs, la finalul array-ului MIGRATIONS)
===============================================================================

Adaugă un obiect nou în array-ul MIGRATIONS, IMEDIAT după `099_lichidare_valoare_factura`.
FK-urile țintesc doar users/organizations (inline) → NU necesită gardă IF EXISTS.
Verifică întâi tipul real al `organizations.id` și `users.id` cu grep (nu presupune):
    grep -n "CREATE TABLE IF NOT EXISTS users\|CREATE TABLE IF NOT EXISTS organizations" server/db/index.mjs
    # Așteptat: ambele SERIAL (INTEGER) → conv_id BIGINT, user FK INTEGER

    {
      id: '100_chat',
      sql: `
        CREATE TABLE IF NOT EXISTS conversations (
          id          BIGSERIAL   PRIMARY KEY,
          org_id      INTEGER     REFERENCES organizations(id) ON DELETE CASCADE,
          kind        TEXT        NOT NULL DEFAULT 'internal'
                                  CHECK (kind IN ('internal','platform_support')),
          is_group    BOOLEAN     NOT NULL DEFAULT FALSE,
          title       TEXT,
          created_by  INTEGER     NOT NULL REFERENCES users(id),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS conversation_participants (
          id            BIGSERIAL   PRIMARY KEY,
          conv_id       BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role          TEXT        NOT NULL DEFAULT 'member',
          last_read_at  TIMESTAMPTZ,
          left_at       TIMESTAMPTZ,
          joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (conv_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conv_part_active
          ON conversation_participants (user_id) WHERE left_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_conv_part_conv
          ON conversation_participants (conv_id);

        CREATE TABLE IF NOT EXISTS messages (
          id          BIGSERIAL   PRIMARY KEY,
          conv_id     BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          from_user   INTEGER     NOT NULL REFERENCES users(id),
          body        TEXT        NOT NULL,
          deleted_at  TIMESTAMPTZ,
          meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv
          ON messages (conv_id, created_at);
      `
    },

Verificare:
    grep -n "id: '100_chat'" server/db/index.mjs        # Așteptat: 1 linie
    node --check server/db/index.mjs                     # fără eroare

===============================================================================
PAS 2 — Migrația 101_module_chat (INLINE) — înscrie modulul în catalog
===============================================================================

Adaugă IMEDIAT după `100_chat` (mirror exact 098_module_facturi):

    {
      id: '101_module_chat',
      sql: `
        INSERT INTO module_catalog
          (module_key, display_name, category, default_enabled, display_order)
        VALUES
          ('chat', 'Chat (mesagerie internă)', 'comunicare', TRUE, 80)
        ON CONFLICT (module_key) DO NOTHING;
      `
    },

(`default_enabled TRUE` = activ pentru toți din start, ca Facturi; admin poate dezactiva
per org/comp/user din Setări. Categorie nouă `comunicare` — separată de subtaburile alop.)

Verificare:
    grep -n "id: '101_module_chat'" server/db/index.mjs  # Așteptat: 1 linie

===============================================================================
PAS 3 — server/services/chat-access.mjs (modul NOU — mirror flow-access.mjs)
===============================================================================

Creează fișier NOU cu DOUĂ funcții pure de acces. NIMIC despre WS/notificări aici.

    import { pool as defaultPool } from '../db/index.mjs';

    /**
     * Regula unică de acces: ești participant ACTIV (left_at IS NULL) la conversație?
     * @returns {Promise<boolean>}
     */
    export async function isConversationParticipant(convId, userId, pool = defaultPool) {
      if (!convId || !userId) return false;
      const { rows } = await pool.query(
        `SELECT 1 FROM conversation_participants
          WHERE conv_id = $1 AND user_id = $2 AND left_at IS NULL
          LIMIT 1`,
        [convId, userId]
      );
      return rows.length > 0;
    }

    /**
     * La CREAREA unei conversații `internal`: TOȚI participanții (inclusiv creatorul)
     * trebuie să aparțină aceluiași org. Nu se aplică pentru `platform_support`.
     * @param {number} orgId
     * @param {number[]} userIds  — toți participanții, inclusiv creatorul
     * @returns {Promise<boolean>} true dacă toți sunt în org și activi
     */
    export async function assertSameOrgParticipants(orgId, userIds, pool = defaultPool) {
      if (!orgId || !Array.isArray(userIds) || !userIds.length) return false;
      const uniq = [...new Set(userIds.map(Number).filter(Boolean))];
      const { rows } = await pool.query(
        `SELECT id FROM users
          WHERE id = ANY($1::int[]) AND org_id = $2 AND deleted_at IS NULL`,
        [uniq, orgId]
      );
      return rows.length === uniq.length;
    }

Verificare:
    node --check server/services/chat-access.mjs
    grep -n "org_id\|deleted_at" server/db/index.mjs | grep -i "user" | head
    # Confirmă că users.org_id și users.deleted_at EXISTĂ pe schema live (nu presupune)

===============================================================================
PAS 4 — server/routes/chat.mjs (router NOU) montat pe /api/chat
===============================================================================

Creează fișier NOU. Oglindește importurile și stilul din registratura.mjs
(requireAuth helper-mode, csrfMiddleware, logger, pool). Exportă `default router`
ȘI `export function injectWsPush(fn)` (pentru P2 — în P1 rămâne neapelat, dar wire-ul
există). Toate rutele mutante: `requireAuth` → `csrfMiddleware` → `requireModule('chat')`.
Rutele read: `requireAuth` → `requireModule('chat')`.

⛔ Ordinea Express contează: rutele specifice ÎNAINTE de cele cu `:id`.

CONTRACTE (P2/P3 depind de aceste forme EXACTE — nu le schimba):

--- GET /conversations  → conversațiile active ale actorului, sortate desc după updated_at
    Răspuns: { ok:true, conversations: [{
      id, kind, is_group, title, org_id, updated_at,
      last_message: { body, from_user, created_at } | null,
      unread: <int>,                       // mesaje cu created_at > last_read_at, de la alții
      participants: [{ user_id, nume, email }]
    }] }
    SQL: conversații unde actorul e participant activ (JOIN conversation_participants
    ON user_id=actor AND left_at IS NULL); last_message = lateral pe messages
    (deleted_at IS NULL, ORDER BY created_at DESC LIMIT 1); unread = COUNT messages
    de la ALȚII cu created_at > COALESCE(last_read_at,'epoch'); participants = agregat.

--- POST /conversations  body { kind, participant_ids:[int], is_group:bool, title? }
    • `internal`: participanții = [actor, ...participant_ids]; assertSameOrgParticipants(
      actor.orgId, aceștia) ⇒ altfel 403 { error:'cross_org_forbidden' }.
      org_id conversație = actor.orgId.
    • `platform_support`: participanții = [actor] + TOȚI userii cu role='admin'
      (platforma). org_id conversație = actor.orgId (ca platforma să vadă din ce primărie
      vine). NU aplica assertSameOrgParticipants.
    • is_group = true doar dacă ≥3 participanți; altfel false.
    • IDEMPOTENȚĂ 1-la-1 internal: dacă există deja o conversație `internal`,
      is_group=false, cu EXACT aceiași 2 participanți activi → întoarce-o pe aia
      (nu crea duplicat). (Grupurile NU se dedup.)
    Răspuns: { ok:true, conversation: { id, kind, is_group, title, org_id, created_at } }
    Tranzacție: INSERT conversation + INSERT participants (creatorul cu role='owner')
    într-un singur BEGIN/COMMIT; last_read_at al creatorului = NOW().

--- GET /conversations/:id/messages?before=<msgId>&limit=50
    Gate: isConversationParticipant(id, actor) ⇒ altfel 404 (nu 403 — nu divulga existența).
    Răspuns: { ok:true, messages: [{ id, conv_id, from_user, from_nume, body,
      created_at, deleted_at }], has_more:<bool> }
    Cele mai recente `limit` mesaje (default 50, max 100), ASC după created_at;
    `before` = paginare spre mesaje mai vechi (id < before). deleted_at NU se filtrează
    din SQL — se întoarce cu `body` golit la '' dacă deleted_at IS NOT NULL (tombstone;
    P3 afișează „mesaj șters").

--- POST /conversations/:id/messages  body { body:string }
    Gate: isConversationParticipant ⇒ altfel 404. Rate-limit 30/min per user (vezi mai jos).
    body trim, non-gol, max 4000 chars (altfel 400 { error:'body_invalid' }).
    INSERT message + UPDATE conversations SET updated_at=NOW() WHERE id=:id.
    Răspuns: { ok:true, message: { id, conv_id, from_user, body, created_at } }
    ⚠️ NU face push WS / notificări aici în P1 — doar INSERT. (P2 adaugă push-ul.)
    Lasă un TODO explicit: `// P2: wsPush + sendNotif participanților activi (mai puțin expeditorul)`

--- POST /conversations/:id/read
    Gate: isConversationParticipant ⇒ altfel 404.
    UPDATE conversation_participants SET last_read_at=NOW() WHERE conv_id=:id AND user_id=actor.
    Răspuns: { ok:true }

RATE-LIMIT (Etapa 1, in-memory — acceptabil, se resetează la restart):
    const _sendWindows = new Map(); // userId -> number[] (timestamps ms)
    function checkSendRate(userId) {
      const now = Date.now(), win = 60_000, max = 30;
      const arr = (_sendWindows.get(userId) || []).filter(t => now - t < win);
      if (arr.length >= max) return false;
      arr.push(now); _sendWindows.set(userId, arr); return true;
    }
    // în POST message: if (!checkSendRate(actor.userId)) return res.status(429).json({ error:'rate_limited' });

Toate răspunsurile: `Cache-Control: no-store` (convenția aplicației).

Verificare:
    node --check server/routes/chat.mjs

===============================================================================
PAS 5 — Montare router în server/index.mjs
===============================================================================

Import (lângă ceilalți routeri, ex. după alopRouter):
    import chatRouter, { injectWsPush as injectChatWsPush } from './routes/chat.mjs';

Montare (lângă celelalte app.use('/api/...') — ex. după `app.use('/api/clasa8', clasa8Router)`):
    app.use('/api/chat', chatRouter);      // Chat Etapa 1: mesagerie

NU apela încă `injectChatWsPush` (P2 o face). Importul poate rămâne, dar dacă linterul
se plânge de import nefolosit, importă DOAR `chatRouter` în P1 și adaugă
`{ injectWsPush as injectChatWsPush }` în P2.

Verificare:
    grep -n "app.use('/api/chat'" server/index.mjs   # Așteptat: 1 linie
    node --check server/index.mjs

===============================================================================
PAS 6 — Test DB REAL (izolarea e invariantul critic — nu mock)
===============================================================================

Creează `server/tests/db/chat-access.test.mjs` (pe PG efemer, ca alte teste db/).
Testul IMPORTĂ din producție (`isConversationParticipant`, `assertSameOrgParticipants`)
și lovește rutele prin harness-ul real — NU redeclară logica. Fixture: 2 orguri (A, B),
useri în fiecare (mirror `seedOrgUser`/`seedTwoOrgs` din helpers existenți).

Grupuri de aserții:
 1. Participant activ vede conversația + mesajele; non-participant primește 404 pe
    GET/POST messages și read.
 2. Cross-org: user din B NU poate fi adăugat la o conversație `internal` a lui A
    (POST /conversations cu participant din alt org ⇒ 403 cross_org_forbidden).
 3. Idempotență 1-la-1: două POST /conversations internal cu aceiași 2 useri ⇒
    ACEEAȘI conv_id.
 4. platform_support: user din A creează → conversația îl include pe admin-ul platformei;
    admin-ul (participant) o vede; un user oarecare din B (ne-participant) primește 404.
 5. unread: după 2 mesaje de la altul, GET /conversations arată unread=2; după
    POST /read, unread=0.
 6. rate-limit: al 31-lea POST message în aceeași fereastră ⇒ 429.

Verificare:
    npx vitest run --config vitest.config.db.mjs server/tests/db/chat-access.test.mjs
    # Așteptat: toate verzi

===============================================================================
PAS 7 — Suită completă + bump
===============================================================================

    npm test           # Așteptat: verde, fără regresii (importă din producție)
    npm run test:db    # Așteptat: verde (include noul test de izolare)

Bump `package.json`: 3.9.704 → 3.9.705.
 • FĂRĂ CACHE_VERSION bump (backend-only, niciun asset PRECACHE).
 • FĂRĂ `?v=` bump (niciun HTML/asset frontend).

===============================================================================
RAPORT FINAL (obligatoriu)
===============================================================================
1. Cele 3 migrații (100_chat tabele, 101_module_chat) + confirmarea că FK-urile
   țintesc users/organizations (inline, fresh-safe, fără gardă necesară).
2. Formele de răspuns EXACTE ale celor 5 endpointuri (copiază din implementare) —
   P2/P3 depind de ele.
3. `npx vitest ...chat-access.test.mjs` → toate verzi (enumeră grupurile 1–6).
4. `npm test` + `npm run test:db` → nr. passed, 0 fail.
5. `git diff --name-only` → server/db/index.mjs, server/services/chat-access.mjs,
   server/routes/chat.mjs, server/index.mjs, server/tests/db/chat-access.test.mjs,
   package.json. (Niciun fișier frontend, niciun sw.js.)
6. Commit + push develop (`feat(chat): Etapa 1 P1 — schema + chat-access + endpoints REST /api/chat (v3.9.705)`) + hash.

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU atinge `server/signing/*` (NO-TOUCH).
⛔ NU push WS / notificări în P1 (POST message doar INSERT + TODO pentru P2).
⛔ NU atinge frontend în P1 (nici HTML, nici JS, nici sw.js/?v=).
⛔ NU renumerota migrații; 100 și 101 sunt următoarele libere (verifică `tail` întâi).
⛔ FK numai către users/organizations (inline) — NU introduce FK către tabele V4-only.
⛔ Rate-limit, gate 404-nu-403, izolarea „participant activ" — implementate exact ca mai sus.
⛔ Totul pe `develop`. NU merge/push pe `main`.
⛔ Dacă un `grep`/verificare contrazice promptul (ex. tip coloană diferit) — OPREȘTE-te
   și raportează, nu improviza.
