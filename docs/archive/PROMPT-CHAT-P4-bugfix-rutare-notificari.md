---
id: CHAT-P4
titlu: CHAT Etapa 1 — Bugfix: rutare notificări chat (conv_id → /chat.html)
model_suggested: Sonnet 4.6 / Default   # fix chirurgical de rutare frontend, bine delimitat
branch: develop
bump: 3.9.708   # frontend; ⚠️ CERE CACHE_VERSION bump (notif-widget.js e în PRECACHE) + ?v=
ordine: după P3 (chat.html/chat.js există)
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU merge/push/checkout pe `main` (= PRODUCȚIE, manual, Mircea).

===============================================================================
CONTEXT (bug raportat + diagnostic verificat pe cod — nu re-investiga)
===============================================================================

BUG: „la acționarea unei notificări de CHAT nu se întâmplă nimic". (Notificările de
FLUX rutează corect post-F6 — confirmat de Mircea; NU le atinge.)

Cauză (verificată): P2 creează notificări `chat_message` / `chat_support_new` cu
`data:{ conv_id }` și FĂRĂ `flow_id`. Dar rutarea de click nu știe de ele:
 • `public/notif-widget.js` → `buildActionUrl(notif)` (linia ~327):
   `if (!flowId) return '/notifications';` → notificarea de chat (fără flowId) cade pe
   /notifications → click aparent inert.
 • `public/js/notifications/notifications.js` → `card.onclick` (linia ~152): ramuri doar
   pentru FORMULARE_TYPES / alop_factura_lichidata / flow — niciuna pentru conv_id.

FIX: mapează notificarea de chat la conversație: `/chat.html?conv=<conv_id>`, iar chat.js
deschide conversația din query param la load.

DETECȚIA unei notificări de chat (folosește AMBELE, robust):
 • `type === 'chat_message' || type === 'chat_support_new'`, SAU
 • `conv_id` prezent în payload (`notif.conv_id` sau `notif.data.conv_id`; `data` poate fi
   string JSON în pagina de notificări — parsează dacă e string, la fel ca ramura formulare).

===============================================================================
PAS 1 — public/notif-widget.js :: buildActionUrl — ramură chat ÎNAINTE de flow
===============================================================================

Adaugă ramura de chat IMEDIAT după linia `actionUrl` și ÎNAINTE de `if (!flowId)`.
Verifică întâi forma exactă a funcției (poate diferă ușor):
    grep -n "function buildActionUrl" public/notif-widget.js

old_str (ancorat pe începutul funcției — adaptează dacă liniile diferă):
     const flowId = notif && (notif.flowId || notif.flow || (notif.data && (notif.data.flowId || notif.data.flow)));
     const token = notif && (notif.token || (notif.data && notif.data.token));
     if (!flowId) return '/notifications';

new_str:
     // Chat: notificare de mesaj/suport → deschide conversația (nu are flowId)
     const convId = notif && (notif.conv_id || (notif.data && notif.data.conv_id));
     const isChat = notif && ((notif.type === 'chat_message' || notif.type === 'chat_support_new') || convId);
     if (isChat) return convId ? `/chat.html?conv=${encodeURIComponent(convId)}` : '/chat.html';
     const flowId = notif && (notif.flowId || notif.flow || (notif.data && (notif.data.flowId || notif.data.flow)));
     const token = notif && (notif.token || (notif.data && notif.data.token));
     if (!flowId) return '/notifications';

(Ambele locuri care apelează buildActionUrl — toast `t.onclick` ~353 și item-ul din widget
~484 — beneficiază automat; NU le atinge separat.)

Verificare:
    grep -n "chat.html?conv=" public/notif-widget.js   # Așteptat: 1 linie

===============================================================================
PAS 2 — public/js/notifications/notifications.js :: card.onclick — ramură chat
===============================================================================

În handler-ul `card.onclick`, adaugă ramura de chat DUPĂ `markRead(n.id);` și ÎNAINTE de
ramura formulare (ordinea: chat verifică conv_id, nu tipuri de formular — nu se suprapun).

Inserează:
    // Notificare de chat → deschide conversația
    if (n.type === 'chat_message' || n.type === 'chat_support_new' || (n.data && (typeof n.data === 'string' ? n.data.includes('conv_id') : n.data.conv_id != null))) {
      const dd = n.data ? (typeof n.data === 'string' ? JSON.parse(n.data) : n.data) : {};
      if (dd && dd.conv_id != null) { location.href = `/chat.html?conv=${encodeURIComponent(dd.conv_id)}`; return; }
      location.href = '/chat.html'; return;
    }

(Parsarea `n.data` string→obj oglindește exact ramura formulare de dedesubt — consistență.)

Verificare:
    grep -n "chat.html?conv=" public/js/notifications/notifications.js   # Așteptat: 1 linie

===============================================================================
PAS 3 — public/js/chat/chat.js — deschide conversația din ?conv= la load
===============================================================================

⚠️ chat.js a fost scris în P3 (nu e în arhiva mea) — CITEȘTE-l întâi și adaptează-te la
structura reală. Comportament de adăugat, NU o implementare literală:

La inițializarea paginii, DUPĂ ce `loadConversations()` a populat lista:
 • citește `new URLSearchParams(location.search).get('conv')`;
 • dacă există, apelează funcția EXISTENTĂ de deschidere a unei conversații (cea folosită
   la click pe un item din listă — probabil `openConversation(id)`), cu `Number(conv)`
   (conv_id e Number pe tot fluxul — vezi coerciția P1);
 • dacă acea conversație nu e în lista curentă (ex. una nouă de suport), fie o încarcă
   direct prin GET /api/chat/conversations/:id/messages (gate-ul de participant o va
   respinge cu 404 dacă nu ai voie — tratează grațios), fie re-fetch lista întâi.
 • curăță param-ul din URL după deschidere (history.replaceState) ca refresh-ul să nu
   re-forțeze aceeași conversație — OPȚIONAL, dacă se potrivește cu restul paginii.

NU reimplementa deschiderea conversației dacă există deja — reutilizeaz-o. Dacă `?conv`
lipsește, comportamentul actual rămâne neschimbat.

Verificare:
    grep -n "conv\b\|URLSearchParams\|openConversation" public/js/chat/chat.js | head

===============================================================================
PAS 4 — Cache: bump CACHE_VERSION (OBLIGATORIU aici) + ?v=
===============================================================================

⚠️ Spre deosebire de P3: `notif-widget.js` ESTE în `PRECACHE_ASSETS` (sw.js:22). L-am
modificat → CACHE_VERSION TREBUIE bumpat, altfel userii primesc versiunea veche din cache.
    - `public/sw.js`: CACHE_VERSION `docflowai-v290` → `docflowai-v291`.
    - `notifications.js` și `chat.js`: verifică dacă sunt în PRECACHE_ASSETS; dacă DA, sunt
      deja acoperite de bump; oricum, `?v=` pe assetele modificate acolo unde sunt încărcate.
    - `?v=` țintit → 3.9.708 pe assetele atinse (notif-widget.js, notifications.js, chat.js)
      în paginile care le încarcă. NU bulk-sed pe tot ?v=.

Verificare:
    grep -n "CACHE_VERSION" public/sw.js                 # Așteptat: docflowai-v291
    grep -rn "notif-widget.js?v=3.9.708" public/*.html | head

===============================================================================
PAS 5 — Suită + acceptance
===============================================================================
    npm test     # Așteptat: verde, fără regresii

RAPORT FINAL:
1. Diff buildActionUrl (ramura chat înaintea flow) + notifications.js (ramura chat).
2. Ce ai adăugat în chat.js pentru `?conv=` (reutilizarea funcției existente de deschidere).
3. CACHE_VERSION v290→v291 (motiv: notif-widget.js în PRECACHE) + ?v= țintite.
4. `npm test` passed/0 fail. `git diff --name-only`.
5. Commit+push develop (`fix(chat): rutare notificări chat conv_id → /chat.html (v3.9.708)`) + hash.

ACCEPTANCE (manual, Mircea, staging după deploy):
 • Trimite un mesaj către un user offline → la login, click pe notificarea 💬 → se
   deschide /chat.html pe CONVERSAȚIA corectă (nu pe /notifications).
 • Toast live de chat (dacă apare) → click → aceeași conversație.
 • Notificarea de suport (admin) → click → conversația de suport.

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU atinge rutarea notificărilor de FLUX (funcționează post-F6) — doar ADAUGĂ ramura chat ÎNAINTE.
⛔ NU atinge `notify()` / backend — bug-ul e pur de rutare frontend.
⛔ NU reimplementa deschiderea conversației în chat.js — reutilizează funcția existentă din P3.
⛔ CACHE_VERSION bump OBLIGATORIU (notif-widget.js e în PRECACHE) — altfel fix-ul nu ajunge la useri.
⛔ ?v= țintit pe assetele atinse, NU bulk-sed.
⛔ Totul pe `develop`. NU merge/push pe `main`. Contrazicere grep vs prompt ⇒ oprește-te și raportează.
