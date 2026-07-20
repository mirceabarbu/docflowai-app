---
id: CHAT-P3
titlu: CHAT Etapa 1 — Frontend (pagină chat + creare grup + nav gated)
model_suggested: Opus 4.8   # coordonare pagină nouă + WS + gating pe mai multe fișiere
branch: develop
bump: 3.9.707   # frontend nou; ?v= pe assets noi/modificate; CACHE_VERSION doar dacă atingi un PRECACHE asset
ordine: rulează DUPĂ P2 (WS `chat_message` trebuie să existe). Consumă contractele pinate în P1+P2.
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU merge/push/checkout pe `main` (= PRODUCȚIE, manual, Mircea).

===============================================================================
CONTEXT (verificat pe cod v3.9.704)
===============================================================================

Backendul (P1+P2) e gata: `/api/chat/*` + WS `event:'chat_message'` cu
`data:{conv_id, message:{id,conv_id,from_user,from_nume,body,created_at}}`.
Construim UI-ul, în shell-ul df-enterprise, gated pe modulul `chat`.

Fundații existente (mirror, nu reinventa):
 • Gating frontend: `public/js/df-entitlements.js` — `window.df.canUseModule('chat')`
   (sincron), `window.df.entitlementsReady` (Promise), auto-ascunde `[data-df-module="chat"]`.
   Deja inclus în paginile shell prin `<script src="/js/df-entitlements.js?v=...">`.
 • Pagină-model: `public/registratura.html` (shell complet: `.df-sidebar`, grupul de nav
   „Comunicare" cu linkul Notificări, `.df-page-header`, `df-user-menu`).
 • Randare listă + delegare click FĂRĂ onclick inline: `public/js/formular/facturi.js`.
 • WS client existent: `public/notif-widget.js` (connectWS, `ws.onmessage`) — deja pe
   toate paginile; NU-l duplica. În pagina de chat deschidem PROPRIUL socket doar dacă e
   necesar, SAU (preferat, Etapa 1) ascultăm evenimentul pe care notif-widget îl poate
   re-emite. Vezi PAS 4 pentru decizia de wiring (fără a atinge notif-widget = fără cache bump).
 • Grupul de nav „Comunicare" apare în aceste 12 pagini shell (unde e linkul Notificări):
   admin.html, bulk-signer.html, flow.html, formular.html, notafd-invest-form.html,
   notifications.html, refnec-form.html, registratura.html, semdoc-initiator.html,
   semdoc-signer.html, setari.html, templates.html.

===============================================================================
PAS 1 — Pagina public/chat.html (mirror shell-ul din registratura.html)
===============================================================================

Creează `public/chat.html` copiind scheletul shell din registratura.html (head cu
aceleași `<script>`-uri de bootstrap: df-entitlements.js, notif-widget.js etc., cu `?v=3.9.707`),
sidebar identic (cu linkul Chat marcat activ — vezi PAS 3), header „Chat / Mesagerie internă".

Corp — layout 2 coloane sub `.df-page`:
 • Stânga: `#chat-list` — lista conversațiilor (fiecare rând: titlu/nume interlocutor(i),
   preview ultim mesaj, timestamp, badge unread). Buton „➕ Conversație nouă" sus.
 • Dreapta: `#chat-thread` — antet conversație + `#chat-messages` (firul, scroll) +
   `#chat-compose` (textarea + buton Trimite). Gol/placeholder până se selectează o conversație.
 • Modal `#chat-new-modal` (creare conversație): tip (Internă / Suport platformă),
   multi-select participanți (pentru grup ≥2 alți useri → is_group), câmp titlu opțional
   (doar la grup). Populează lista de useri din endpointul EXISTENT de useri ai org-ului
   (verifică care e — `GET /users` întoarce userii org-ului, post-#89/SEC-90). Pentru
   `platform_support` NU se aleg participanți (destinatarul e platforma).

CSS: reutilizează tokenii/clasele df (`.df-*`); adaugă clase `chat-*` într-un bloc `<style>`
în pagină SAU în `public/formular.css` dacă preferi (dacă atingi formular.css, NU e în
PRECACHE → fără cache bump; confirmă cu grep în sw.js). Fără librării externe.

⛔ GATING pagină: la load, după `df.entitlementsReady`, dacă `!df.canUseModule('chat')`
   → înlocuiește conținutul cu un mesaj „Modul indisponibil" (NU lăsa UI funcțional).
   Linkul de nav e deja ascuns prin `data-df-module`, dar pagina trebuie să se auto-apere
   (cineva poate naviga direct la /chat.html).

===============================================================================
PAS 2 — public/js/chat/chat.js (logica paginii — mirror facturi.js pentru stil)
===============================================================================

Creează `public/js/chat/chat.js`. Reguli DURE (convențiile aplicației):
 • Randare mesaje/nume cu `textContent` / `replaceChildren`, NICIODATĂ `innerHTML` pe
   `body` (clasa XSS-01 — body-ul e text de la user).
 • HTML dinamic prin template + `data-*` + DELEGARE de click; ZERO `onclick` inline.
 • Toate fetch-urile prin wrapperul canonic (`window.docflow.apiFetch` / shim-ul existent),
   cu tratarea 401 ca restul aplicației.

Funcționalitate:
 • `loadConversations()` → GET /api/chat/conversations → randează `#chat-list` (sortate
   desc; badge unread din `c.unread`). Click pe o conversație → `openConversation(id)`.
 • `openConversation(id)` → GET /api/chat/conversations/:id/messages → randează firul
   (ASC, cele mai noi jos, scroll la fund); apoi POST /api/chat/conversations/:id/read
   (și scoate badge-ul unread local).
 • `sendMessage()` → POST /api/chat/conversations/:id/messages {body} → la 200, adaugă
   mesajul propriu în fir optimist (folosind `message` din răspuns), golește textarea,
   bump conversația în capul listei. 429 → afișează discret „Prea multe mesaje, așteaptă un moment".
 • `openNewModal()` → construiește conversația: POST /api/chat/conversations cu
   {kind, participant_ids, is_group, title}. La succes, deschide conversația returnată
   (inclusiv cazul idempotent 1-la-1 care întoarce una existentă).
 • Mesaj cu `deleted_at` → afișează „mesaj șters" (tombstone), nu body-ul.

Verificare:
    node --check public/js/chat/chat.js   # (dacă e ESM; altfel doar încarcă-l în pagină)

===============================================================================
PAS 3 — Link „Chat" în sidebar, în TOATE cele 12 pagini shell, gated
===============================================================================

În grupul de nav „Comunicare", IMEDIAT ÎNAINTE de linkul Notificări, adaugă (identic în
toate cele 12 pagini care au grupul — mirror stilul linkului Notificări, cu icon inline
SVG „bulă de chat", fiindcă sprite-ul NU are `ico-message`/`ico-chat`, doar `ico-send`):

    <a href="/chat.html" class="df-nav-item" data-df-module="chat">
      <svg class="df-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      Chat
    </a>

`data-df-module="chat"` → df-entitlements.js îl ascunde automat dacă modulul e off.
În `chat.html` marchează acest link cu clasa activă (ca fiecare pagină își marchează linkul).

⚠️ Acesta e singurul pas repetitiv (12 fișiere). Fă-l cu un `old_str`/`new_str` per pagină
(ancorat pe linkul Notificári al fiecărei pagini), NU cu un sed global orb. Dacă o pagină
NU are grupul „Comunicare" (verifică prin grep înainte), sari peste ea și raportează.

Verificare:
    grep -rln 'href="/chat.html"' public/*.html | wc -l   # Așteptat: 12 (sau nr. real cu grupul Comunicare)

===============================================================================
PAS 4 — Live: ascultă `chat_message` fără a duplica socketul WS
===============================================================================

Etapa 1, scop minimal (fără a atinge notif-widget.js = fără CACHE_VERSION bump):
în pagina de chat deschide un socket WS propriu DOAR pe /chat.html (mirror `connectWS`
din notif-widget.js: `wss://.../ws`, cookie auto-auth, reconnect). La `event:'chat_message'`:
 • dacă `data.conv_id` == conversația deschisă → append live în fir + scroll;
 • altfel → incrementează badge-ul unread al acelei conversații în listă + urc-o în cap.

(De ce socket propriu în loc de a reutiliza pe cel din notif-widget: notif-widget.js e în
PRECACHE — orice modificare cere CACHE_VERSION bump. În Etapa 1 evităm asta ținând
logica de chat în chat.js. Un singur socket partajat = optimizare pentru Etapa 2.)

⚠️ Curăță socketul la `beforeunload` / la părăsirea paginii (nu lăsa reconnect zombi).

===============================================================================
PAS 5 — Bump versiune + cache
===============================================================================
`package.json`: 3.9.706 → 3.9.707.
`?v=` pe assetele NOI/modificate: chat.js (nou), df-entitlements.js și notif-widget.js
DOAR dacă le-ai atins (nu ar trebui), pe cele 12 pagini + chat.html — TARGETAT pe assetul
schimbat, NU bulk pe tot `?v=` (convenția: `?v=` driftează intenționat de package.json).
CACHE_VERSION în sw.js: bump DOAR dacă ai atins un fișier din PRECACHE_ASSETS. chat.js e
NOU (nu e în PRECACHE) → în mod normal NU bumpezi CACHE_VERSION. Verifică:
    grep -n "PRECACHE\|CACHE_VERSION\|chat.js\|notif-widget.js\|df-entitlements.js" public/sw.js
    # Dacă adaugi chat.js/chat.html în PRECACHE (opțional, pt offline) ⇒ ATUNCI bump CACHE_VERSION.
    # Recomandare Etapa 1: NU adăuga chat în PRECACHE → fără CACHE_VERSION bump.

===============================================================================
PAS 6 — Verificare & suită
===============================================================================
    npm test            # verde, fără regresii (frontend nou nu ar trebui să atingă teste)
    grep -rln 'href="/chat.html"' public/*.html | wc -l   # nr. paginilor cu linkul
    # Manual (Mircea, pe staging după deploy): vezi ACCEPTANCE.

===============================================================================
RAPORT FINAL
===============================================================================
1. Fișiere noi: public/chat.html, public/js/chat/chat.js (+ CSS dacă separat).
2. Numărul de pagini în care s-a adăugat linkul Chat gated (+ care au fost sărite, dacă vreuna).
3. Confirmarea gating-ului dublu: nav ascuns prin `data-df-module="chat"` ȘI pagina se
   auto-apără la load dacă `!canUseModule('chat')`.
4. Confirmarea XSS-safe: body randat cu textContent, zero innerHTML pe conținut de user,
   zero onclick inline.
5. `?v=` bumpate targetat; CACHE_VERSION bump DA/NU + motivul.
6. `npm test` passed/0 fail. `git diff --name-only`.
7. Commit+push develop (`feat(chat): Etapa 1 P3 — pagină chat + creare grup + nav gated (v3.9.707)`) + hash.

ACCEPTANCE (manual, Mircea, pe staging după deploy):
 • Două sesiuni, doi useri din aceeași org: A deschide „Conversație nouă" → B, trimite
   un mesaj → B îl vede LIVE fără refresh; B răspunde → apare live la A. Badge unread corect.
 • Grup: A creează grup cu B și C → toți trei văd mesajele.
 • Suport: un user deschide conversație „Suport platformă" → Mircea (admin) primește
   notificarea in-app „cerere de suport nouă" și vede conversația.
 • Gating: dezactivează modulul `chat` pentru un user din Setări → linkul dispare din nav
   ȘI /chat.html afișează „modul indisponibil".

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU atinge `server/signing/*` (nici backend în P3 — e pur frontend, în afară de ?v=).
⛔ NU atinge notif-widget.js dacă poți evita (evită CACHE_VERSION bump). Dacă TREBUIE →
   bump CACHE_VERSION obligatoriu (e în PRECACHE).
⛔ body randat cu textContent — NICIODATĂ innerHTML pe conținut de user (XSS-01).
⛔ ZERO onclick inline; delegare de click + data-*.
⛔ `?v=` TARGETAT pe assetul schimbat, NU bulk-sed pe toate.
⛔ Pasul pe 12 pagini: old_str/new_str per pagină, ancorat pe linkul Notificări; grep întâi
   care pagini au grupul „Comunicare"; sari peste cele fără și raportează.
⛔ Totul pe `develop`. NU merge/push pe `main`. Contrazicere grep vs prompt ⇒ oprește-te și raportează.
