---
id: CHAT-P2
titlu: CHAT Etapa 1 — Real-time (WS) + notificări in-app
model_suggested: Opus 4.8
branch: develop
bump: 3.9.706   # backend-only, FĂRĂ cache bump, FĂRĂ ?v= bump
ordine: rulează DUPĂ P1 (verifică că /api/chat funcționează și formele de răspuns sunt cele din P1)
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU merge/push/checkout pe `main` (= PRODUCȚIE, manual, Mircea).

===============================================================================
CONTEXT (verificat pe cod v3.9.704 — nu re-investiga)
===============================================================================

P1 a livrat schema + `/api/chat`, dar POST message doar face INSERT (are un TODO).
P2 adaugă livrarea live + notificările, reutilizând țevile existente:
 • WS: `wsClients: Map<email, Set<ws>>`; `wsPush(email, payload)` (index.mjs:1172)
   trimite pe toate socketurile emailului. Socketul e legat de email DUPĂ aceleași
   verificări ca sessionGuard. „Conectat acum" = `wsClients.has(email.toLowerCase())`.
 • Pattern de injecție dovedit (F5/Facturi): `alop.mjs` exportă `injectWsPush`, wire în
   index.mjs lângă `injectAlopWsPush(wsPush)` (index.mjs:1559). OGLINDEȘTE-l.
 • Notificare in-app: `sendNotif(userId, type, title, message, data)`
   (server/services/formular-shared.mjs:28) — resolvă userId→email, scrie în
   `notifications` (coloana `data` JSONB), întoarce `{id, created_at, email}`. NU
   împinge WS singură — apelantul o face.
 • Contractul WS al consumatorilor (post-F6, verificat): `notif-widget.js:387` și
   `notifications.js:315` ascultă `event:'notification'` cu `data` PLAT. Pentru chat
   NU refolosim `notification` (ar amesteca cu toast-urile de flux) — emitem un event
   NOU `chat_message` pe care îl va asculta P3 în pagina de chat.

===============================================================================
PAS 1 — Wire injecția WS în chat.mjs (mirror alop.mjs)
===============================================================================

În `server/routes/chat.mjs`: confirmă că există deja (din P1) `let _wsPush;` +
`export function injectWsPush(fn){ _wsPush = fn; }`. Dacă lipsește, adaugă (mirror
alop.mjs:38-39).

În `server/index.mjs`: dacă P1 a importat doar `chatRouter`, extinde importul la
`import chatRouter, { injectWsPush as injectChatWsPush } from './routes/chat.mjs';`
și adaugă LÂNGĂ `injectAlopWsPush(wsPush);` (index.mjs:1559):
    injectChatWsPush(wsPush);

Verificare:
    grep -n "injectChatWsPush(wsPush)" server/index.mjs   # Așteptat: 1 linie
    node --check server/index.mjs

===============================================================================
PAS 2 — Push live + notificare la POST /conversations/:id/messages
===============================================================================

Înlocuiește TODO-ul din P1 (după INSERT message + UPDATE conversations.updated_at,
ÎNAINTE de `res.json`). Ia participanții ACTIVI (mai puțin expeditorul) cu emailul lor:

    const { rows: recips } = await pool.query(
      `SELECT p.user_id, u.email
         FROM conversation_participants p
         JOIN users u ON u.id = p.user_id
        WHERE p.conv_id = $1 AND p.left_at IS NULL AND p.user_id <> $2`,
      [convId, actor.userId]
    );

    // ⚠️ CONSISTENȚĂ CU P1: P1 coerce id/conv_id la Number (pg întoarce BIGINT ca string).
    // convId de aici TREBUIE să fie Number (Number(req.params.id)), ca P3 să compare corect
    // `data.conv_id === conversaţiaDeschisă`. Dacă handlerul nu l-a coerced deja sus, fă-o.
    const payload = {
      event: 'chat_message',
      data: {
        conv_id: Number(convId),
        message: { id: msg.id, conv_id: convId, from_user: actor.userId,
                   from_nume: actor.nume || '', body: msg.body, created_at: msg.created_at },
      },
    };

    for (const r of recips) {
      const email = (r.email || '').toLowerCase();
      const online = _wsPush && email && wsClientsHas(email);  // vezi mai jos
      if (online) {
        try { _wsPush(email, payload); } catch (e) { logger.warn({ err:e }, '[chat] wsPush non-fatal'); }
      } else {
        // offline → notificare in-app persistentă (o vede la următorul login)
        try {
          await sendNotif(r.user_id, 'chat_message',
            '💬 Mesaj nou', preview(msg.body), { conv_id: convId });
        } catch (e) { logger.warn({ err:e }, '[chat] sendNotif non-fatal'); }
      }
    }

`preview(body)` = primele ~80 caractere, o linie (fără newline), pentru titlul notificării.
TOT blocul e non-fatal (try/catch) — o eroare de livrare NU trebuie să rupă răspunsul
200 al trimiterii mesajului.

„Online?" — avem nevoie de un predicat expus din index.mjs. `wsClients` e local acolo.
Adaugă în index.mjs un mic exporter injectat (mirror felul în care wsPush e injectat):
în chat.mjs `let _isOnline = () => false; export function injectPresence(fn){ _isOnline = fn; }`
și `function wsClientsHas(email){ return _isOnline(email); }`; în index.mjs, lângă
`injectChatWsPush(wsPush)`: `injectPresence((email) => wsClients.has(String(email||'').toLowerCase()));`
(Astfel chat.mjs NU importă direct starea WS — rămâne testabil.)

⚠️ IMPORTANT — semnătura `sendNotif` are nevoie de `actor.nume`. Verifică ce câmpuri
poartă `actor` (requireAuth). Dacă `nume` NU e pe actor, ia-l printr-un SELECT scurt pe
users la trimitere (o singură dată per request), NU per recipient.

Verificare:
    node --check server/routes/chat.mjs server/index.mjs

===============================================================================
PAS 3 — Alerta platformei la o conversație platform_support NOUĂ
===============================================================================

În `POST /conversations`, DUPĂ commit-ul creării, DOAR când `kind==='platform_support'`
ȘI conversația e nou creată (nu una idempotentă reîntoarsă): notifică fiecare admin al
platformei (role='admin'), mai puțin creatorul, prin `sendNotif` (in-app, decizia lui
Mircea — nu email):

    if (kind === 'platform_support' && created /* nu idempotent */) {
      const { rows: admins } = await pool.query(
        `SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL AND id <> $1`,
        [actor.userId]
      );
      for (const a of admins) {
        try { await sendNotif(a.id, 'chat_support_new',
          '🆘 Cerere de suport nouă',
          `${actor.nume || actor.email} a deschis o conversație de suport.`,
          { conv_id: newConvId }); } catch (_) {}
      }
    }

(Push live către un admin conectat vine „gratis" din PAS 2 la primul mesaj; alerta de
AICI e pentru evenimentul „conversație de suport deschisă".)

Verificare:
    grep -n "chat_support_new" server/routes/chat.mjs   # Așteptat: 1 linie

===============================================================================
PAS 4 — Test (extinde chat-access.test.mjs sau fișier nou chat-realtime.test.mjs)
===============================================================================

Test DB real, importă din producție. Cum WS-ul propriu-zis nu e ușor de testat prin
harness, testează OBSERVABILELE deterministe:
 1. POST message către un participant OFFLINE creează un rând în `notifications`
    (type='chat_message', data->>'conv_id' corect) pentru acel participant, NU pentru expeditor.
 2. Crearea unei conversații `platform_support` inserează notificări `chat_support_new`
    pentru userii role='admin' (mai puțin creatorul).
 3. Non-regresie: POST message întoarce în continuare 200 + forma din P1 chiar dacă
    livrarea ar eșua (simulează prin lipsă de recipienți — nu aruncă).

(Injecția `_isOnline` permite forțarea „offline" în test: injectează un stub care
întoarce false → forțează calea sendNotif.)

Verificare:
    npx vitest run --config vitest.config.db.mjs server/tests/db/chat-realtime.test.mjs
    npm test && npm run test:db     # verzi, fără regresii

===============================================================================
PAS 5 — Bump
===============================================================================
`package.json`: 3.9.705 → 3.9.706. FĂRĂ cache bump, FĂRĂ ?v= (backend-only).

===============================================================================
RAPORT FINAL
===============================================================================
1. Diff-ul blocului de livrare din POST message (push online / sendNotif offline).
2. `injectChatWsPush(wsPush)` + `injectPresence(...)` în index.mjs (grep).
3. Contractul WS emis: `event:'chat_message'` cu `data:{conv_id,message}` — pinat pentru P3.
4. Teste: enumeră cazurile 1–3, toate verzi. `npm test`+`test:db` passed/0 fail.
5. `git diff --name-only`: server/routes/chat.mjs, server/index.mjs, test(e), package.json. Zero frontend.
6. Commit+push develop (`feat(chat): Etapa 1 P2 — WS chat_message live + notificări in-app (v3.9.706)`) + hash.

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU atinge `server/signing/*`. NU atinge frontend (P3 se ocupă). NU atinge sw.js/?v=.
⛔ Livrarea e NON-FATALĂ — orice eroare de push/notif NU rupe răspunsul 200 al trimiterii.
⛔ Emit event NOU `chat_message` — NU refolosi `notification` (nu amesteca cu toast-urile de flux).
⛔ Push DOAR către participanți ACTIVI (left_at IS NULL), NICIODATĂ către expeditor.
⛔ chat.mjs NU importă direct `wsClients` — primește predicate injectate (testabilitate).
⛔ Totul pe `develop`. NU merge/push pe `main`. Contrazicere grep vs prompt ⇒ oprește-te și raportează.
