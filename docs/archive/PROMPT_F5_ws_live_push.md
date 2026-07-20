---
title: "Facturi — F5 (push WS live pentru notificarea de factură către Serviciul Buget)"
branch: develop
model_suggested: Sonnet 4.6 (Default)   # wiring mic, dar atinge index.mjs → GRIJĂ
version_bump: citește versiunea curentă din package.json și incrementează patch (aștept 3.9.695 → 3.9.696)
cache_bump: NU
depends_on: F1 (notificarea CAB există deja în confirma-lichidare)
---

# ⚠️⚠️ BRANCH: develop ⚠️⚠️
`main` = PRODUCȚIE, MANUAL de Mircea. NU checkout/merge/push pe `main`.

====================================================================
OBIECTIV
====================================================================
Azi notificarea CAB de factură (F1) se scrie în DB via `sendNotif` dar NU se împinge live pe
WebSocket — apare la Serviciul Buget doar la refresh/poll. O facem LIVE: toast instant +
badge-ul de necitite actualizat, exact ca notificările de flux (`notify()` în index.mjs face
`wsPush({event:'new_notification'})` + `{event:'unread_count'}`).

Constatări (verificate pe cod):
  • `wsPush(email, payload)` e definit în server/index.mjs:1172 și injectat în
    notifications.mjs prin `injectWsPush(wsPush)` (index.mjs:1558).
  • `server/routes/alop.mjs` NU are încă injecție de deps → adăugăm `injectWsPush` acolo,
    mirror pe notifications.mjs.
  • `sendNotif` (formular-shared.mjs) inserează dar NU întoarce id-ul → îl facem să întoarcă
    `{id, created_at}` (non-breaking: apelanții actuali ignoră return-ul).

⛔ NO-TOUCH: server/signing/*. La index.mjs modifici DOAR punctul de injecție (o linie lângă
`injectWsPush(wsPush)` existent) — NU atinge `notify`, `wsPush`, handshake-ul WS sau signing.

====================================================================
PAS 1 — sendNotif întoarce rândul inserat (server/services/formular-shared.mjs)
====================================================================
Citește `sendNotif`. Adaugă `RETURNING id, created_at` și întoarce datele + email.
old_str:
```js
    await pool.query(
      `INSERT INTO notifications (user_email, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].email.toLowerCase(), type, title, message, JSON.stringify(data)]
    );
  } catch (_) { /* non-fatal */ }
}
```
new_str:
```js
    const ins = await pool.query(
      `INSERT INTO notifications (user_email, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [rows[0].email.toLowerCase(), type, title, message, JSON.stringify(data)]
    );
    return { id: ins.rows[0]?.id ?? null, created_at: ins.rows[0]?.created_at ?? null, email: rows[0].email.toLowerCase() };
  } catch (_) { /* non-fatal */ return null; }
}
```
(Verifică: ceilalți apelanți ai `sendNotif` nu folosesc return-ul → nicio regresie.)

====================================================================
PAS 2 — injectWsPush în server/routes/alop.mjs (mirror pe notifications.mjs)
====================================================================
2.1 Aproape de vârful fișierului (după importuri / lângă montarea routerului), adaugă:
```js
// WS push injectat la montare (pentru notificări live — ex. factură lichidată)
let _wsPush;
export function injectWsPush(fn) { _wsPush = fn; }
```
(Confirmă pattern-ul identic în server/routes/notifications.mjs:13-14.)

====================================================================
PAS 3 — Împinge live după sendNotif (în confirma-lichidare, blocul F1)
====================================================================
Citește blocul de notificare CAB din `confirma-lichidare` (adăugat de F1). Azi loop-ul
selectează doar `id` din users. Extinde SELECT-ul să aducă și `email`, apoi împinge WS după
fiecare `sendNotif`.
3.1 Extinde query-ul CAB users să întoarcă și emailul:
```sql
SELECT id, email FROM users
 WHERE org_id=$1 AND deleted_at IS NULL
   AND TRIM(compartiment) = $2 AND TRIM(compartiment) <> ''
   AND id <> $3
```
3.2 În loop, capturează return-ul lui sendNotif și împinge live:
```js
for (const u of cabUsers) {
  const ins = await sendNotif(
    u.id, 'alop_factura_lichidata', '🧾 Factură lichidată',
    /* message */ msgText, notifData
  );
  try {
    const email = (u.email || (ins && ins.email) || '').toLowerCase();
    if (email && _wsPush) {
      _wsPush(email, {
        event: 'new_notification',
        notification: {
          id: ins?.id ?? null,
          flow_id: null,
          type: 'alop_factura_lichidata',
          title: '🧾 Factură lichidată',
          message: msgText,
          data: notifData,
          read: false,
          created_at: ins?.created_at ?? new Date().toISOString(),
          urgent: false,
        },
      });
      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM notifications WHERE user_email=$1 AND read=FALSE',
        [email]
      );
      _wsPush(email, { event: 'unread_count', count: cnt[0]?.c ?? 0 });
    }
  } catch (wsErr) {
    logger.warn({ err: wsErr, alopId: req.params.id }, '[Facturi] wsPush live non-fatal');
  }
}
```
Notă: `msgText` = variabila cu textul mesajului construit în F1 (adaptează numele la cel real
din cod — poate e inline în apelul sendNotif; extrage-l într-o variabilă `const msgText = ...`
ca să-l refolosești în payload-ul WS). `notifData` = obiectul deja construit în F1.
Tot blocul rămâne în try/catch non-fatal moștenit de la F1 — o eroare WS NU rupe lichidarea.

3.3 Verifică forma payload-ului împotriva handler-ului din widget:
```bash
grep -n "new_notification\|unread_count\|ev.data\|JSON.parse" public/notif-widget.js
```
Confirmă că widget-ul ascultă `event:'new_notification'` și prepend-uiește `notification`,
și `event:'unread_count'` actualizează badge-ul. Dacă forma diferă, aliniază payload-ul la
ce așteaptă widget-ul (NU modifica widget-ul — el e în PRECACHE_ASSETS; adaptează serverul).

====================================================================
PAS 4 — Wire injectWsPush(alop) în server/index.mjs
====================================================================
Găsește linia existentă `injectWsPush(wsPush);` (≈ 1558, cea pentru notifications router).
Importă și injecția din alop și cheam-o lângă ea.
4.1 La importul routerului alop, adaugă injecția:
```bash
grep -n "from './routes/alop.mjs'\|alopRouter\|import.*alop" server/index.mjs | head
```
Extinde importul ca să aducă și `injectWsPush as injectAlopWsPush` (numele exact al
default/named export al lui alop.mjs — verifică: alop.mjs face `export default router` + acum
`export function injectWsPush`). Ex.:
old_str (adaptează la linia reală):
```js
injectWsPush(wsPush);
```
new_str:
```js
injectWsPush(wsPush);
injectAlopWsPush(wsPush);
```
și adaugă la importuri:
```js
import alopRouter, { injectWsPush as injectAlopWsPush } from './routes/alop.mjs';
```
(Dacă alop.mjs e importat deja doar ca default `import alopRouter from './routes/alop.mjs'`,
transformă-l în `import alopRouter, { injectWsPush as injectAlopWsPush } from ...`.)
⚠️ NU muta/atinge `injectWsPush(wsPush)` existent (notifications) sau `injectFlowDeps(...)`.

====================================================================
PAS 5 — Version bump + teste
====================================================================
```bash
node -p "require('./package.json').version"
# incrementează patch (ex. 3.9.695 → 3.9.696)
# ?v= bulk pe HTML DOAR dacă ai atins fișiere frontend (aici NU — backend-only → poți sări ?v=)
npm test    # verde
node --check server/routes/alop.mjs && node --check server/index.mjs && node --check server/services/formular-shared.mjs
```
NU bumpa CACHE_VERSION (notif-widget.js NEATINS).

====================================================================
VERIFICARE MANUALĂ
====================================================================
1. Două sesiuni: un user oarecare face lichidare cu factură; un user din Serviciul Buget e
   logat pe altă pagină (cu notif-widget) → primește TOAST live + badge-ul de necitite crește
   INSTANT, fără refresh.
2. Click pe toast/notificare → deschide DF-ul (comportament F1/F2).
3. Dacă WS e picat (offline) → lichidarea tot reușește; notificarea rămâne în DB (apare la
   următorul load). Nimic nu se rupe.

RAPORT FINAL: confirmarea că sendNotif întoarce id fără regresii la ceilalți apelanți,
forma payload-ului WS vs. widget, cele două injectWsPush coexistă în index.mjs, npm test,
node --check pe cele 3 fișiere, versiune.
⛔ develop ONLY · NU signing/* · în index.mjs DOAR punctul de injecție · WS push non-fatal.
