---
id: F6
titlu: notify() — toast live pentru notificările de flux de semnare
model_suggested: Opus 4.8   # atinge notify() pe calea de semnare (index.mjs) — sensibil, dar patch de 1 linie
branch: develop
bump: 3.9.704   # backend-only, FĂRĂ cache bump, FĂRĂ ?v= bump
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU face merge / push / checkout pe `main`.
`main` = PRODUCȚIE, gestionat manual DOAR de Mircea. Toată munca rămâne pe `develop`.

===============================================================================
CONTEXT (diagnostic deja făcut pe cod, v3.9.703 — nu re-investiga, doar execută)
===============================================================================

`notify()` din `server/index.mjs` (linia ~1496) emite azi, pentru notificarea in-app:

    wsPush(email, { event: 'new_notification', notification: { … } });

`event:'new_notification'` cu payload IMBRICAT sub `notification` NU e ascultat de
NIMENI (verificat: unic emit, zero consumatori pe frontend și server). De aceea
toast-ul LIVE la notificările de flux de semnare nu s-a declanșat niciodată —
conținutul apărea doar la refresh. (Badge-ul de unread se actualiza totuși live,
prin `event:'unread_count'` de la linia următoare — acela rămâne NEATINS.)

Contractul CORECT (identic cu calea ALOP/Facturi din `server/routes/alop.mjs:1257`,
ascultat de `public/notif-widget.js:387` `showToast(msg.data)` ȘI de
`public/js/notifications/notifications.js:315` `allNotifs.unshift(msg.data)`):

    wsPush(email, { event: 'notification', data: { …payload plat… } });

Subtilitate confirmată pe cod — cei doi consumatori citesc câmpul fluxului DIFERIT:
 • pagina `notifications.js` citește `n.flow_id` (snake_case) — liniile 145/165/182
 • `buildActionUrl` din `notif-widget.js:325` citește `flowId`/`flow` (camelCase)
→ payload-ul TREBUIE să poarte AMBELE (`flow_id` ȘI `flowId`) ca click-through-ul
   spre flux să meargă din toast ȘI din pagină.

===============================================================================
PAS 1 — Patch chirurgical: aliniază emit-ul WS al lui notify() la contractul plat
===============================================================================

Fișier: `server/index.mjs`

old_str:
    wsPush(email, { event: 'new_notification', notification: { id: r.rows[0]?.id, flow_id: flowId, type, title: displayTitle, message, read: false, created_at: new Date().toISOString(), urgent: !!urgent } });

new_str:
    wsPush(email, { event: 'notification', data: { id: r.rows[0]?.id, flow_id: flowId || null, flowId: flowId || null, type, title: displayTitle, message, read: false, created_at: new Date().toISOString(), urgent: !!urgent } });

Ce s-a schimbat, exact:
 • `event: 'new_notification'` → `event: 'notification'`
 • cheia `notification:` → `data:`  (consumatorii citesc `msg.data`)
 • adăugat `flowId: flowId || null` lângă `flow_id: flowId || null` (alias camelCase
   pentru `buildActionUrl`); `|| null` doar pentru siguranță pe notificări fără flux
 • restul câmpurilor NESCHIMBATE
 • linia `unread_count` de dedesubt (badge) NU se atinge

Verificare:
    grep -n "event: 'notification', data: {" server/index.mjs
    # Așteptat: exact 1 linie (noul emit din notify())

    grep -rn "new_notification" server/ public/
    # Așteptat: 0 rezultate (forma orfană a dispărut complet)

    grep -n "event: 'unread_count'" server/index.mjs
    # Așteptat: 2 linii NESCHIMBATE (badge notify() + count inițial la WS connect)

    node --check server/index.mjs
    # Așteptat: fără eroare

===============================================================================
PAS 2 — Test de contract (source-guard, NU redeclară logică)
===============================================================================

`notify()` NU e exportat din `index.mjs` (monolitul de intrare), deci nu poate fi
invocat izolat într-un unit test. Consumatorii sunt deja testați pe forma corectă
(`notif-toast-xss.test.mjs` pe `showToast`). Adăugăm un guard care asertează
STRING-ul sursă real — blochează o regresie viitoare înapoi la `new_notification`.
NU redeclară nicio logică; citește exact fișierul de producție.

Creează fișier NOU: `server/tests/unit/notify-ws-contract.test.mjs`

    import { describe, it, expect } from 'vitest';
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { dirname, join } from 'node:path';

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const indexSrc = readFileSync(join(__dirname, '../../index.mjs'), 'utf8');

    // Linia de emit a notificării in-app din notify() — identificată univoc prin `title: displayTitle`
    const emitLine = indexSrc
      .split('\n')
      .find(l => l.includes('wsPush(email') && l.includes('title: displayTitle'));

    describe('F6 — contractul WS al notify() pentru toast live', () => {
      it('linia de emit a notificării există', () => {
        expect(emitLine, 'nu am găsit linia wsPush a notificării in-app din notify()').toBeTruthy();
      });

      it('emite event:\'notification\' cu payload plat sub cheia data', () => {
        expect(emitLine).toMatch(/event:\s*['"]notification['"]/);
        expect(emitLine).toMatch(/\bdata:\s*\{/);
      });

      it('NU mai emite event:\'new_notification\' nicăieri (formă orfană, 0 consumatori)', () => {
        expect(indexSrc).not.toMatch(/event:\s*['"]new_notification['"]/);
      });

      it('payload-ul poartă flowId (camelCase) pentru buildActionUrl din notif-widget.js', () => {
        expect(emitLine).toMatch(/\bflowId\b/);
      });
    });

Verificare:
    npx vitest run server/tests/unit/notify-ws-contract.test.mjs
    # Așteptat: 4 passed

===============================================================================
PAS 3 — Suita completă + bump versiune
===============================================================================

    npm test
    # Așteptat: verde, fără regresii (suita importă din producție — nu redeclară logică)

Bump în `package.json`: `3.9.703` → `3.9.704`.
 • FĂRĂ CACHE_VERSION bump în `public/sw.js` (nu s-a atins niciun asset din PRECACHE_ASSETS; `index.mjs` e backend)
 • FĂRĂ `?v=` bump (nu s-a atins niciun HTML/asset frontend)

Verificare:
    grep '"version"' package.json | head -1
    # Așteptat: "3.9.704"

    git diff --name-only
    # Așteptat EXACT: server/index.mjs, server/tests/unit/notify-ws-contract.test.mjs, package.json
    # (dacă apare public/sw.js sau vreun ?v= — GREȘIT, revocă)

===============================================================================
RAPORT FINAL (obligatoriu în răspuns)
===============================================================================

1. Diff-ul liniei din `notify()` (before/after).
2. Ieșirea celor 4 grep-uri de la Pas 1 (dovada: 1 emit nou, 0 `new_notification`, 2 `unread_count`).
3. `npx vitest run …notify-ws-contract…` → 4 passed.
4. `npm test` → nr. total passed, 0 fail.
5. `git diff --name-only` → exact cele 3 fișiere.
6. Commit + push pe `develop` (mesaj: `fix(notify): WS live toast pentru notificări de flux de semnare — event:'notification'+data plat (v3.9.704)`), cu hash-ul commit-ului.

ACCEPTANCE REALĂ (manual, de Mircea, pe staging după deploy `develop`):
 • Două sesiuni în browsere diferite (semnatar A, inițiator B). B pornește un flux
   către A → A, cu tab-ul DocFlowAI vizibil, trebuie să vadă TOAST-ul live „E rândul
   tău…" fără refresh; click pe toast → deschide `/flow.html?flow=…` (sau signer-ul).
 • Verifică și că badge-ul de unread se incrementează live (trebuia deja — regresie zero).

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================

⛔ NU atinge NICIUN fișier din `server/signing/*` (NO-TOUCH):
   cloud-signing.mjs, bulk-signing.mjs, pades.mjs, java-pades-client.mjs, providers/STSCloudProvider.mjs
⛔ NU atinge linia `event: 'unread_count'` (badge-ul funcționează — orice atingere = regresie).
⛔ NU atinge calea ALOP/Facturi din `server/routes/alop.mjs` (deja corectă — F5).
⛔ NU modifica `notif-widget.js` / `notifications.js` (consumatorii sunt deja corecți).
⛔ NU face bulk-sed pe `?v=` și NU bumpa CACHE_VERSION — nimic frontend nu s-a atins.
⛔ NU renumerota / atinge alte prompturi. NU merge/push pe `main`. Totul pe `develop`.
⛔ Dacă `old_str` de la Pas 1 nu se potrivește exact (versiune urcată între timp),
   NU improviza — raportează linia reală și oprește-te.
