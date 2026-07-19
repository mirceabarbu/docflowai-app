---
prompt: 100
titlu: "sec(ws): handshake WebSocket fail-closed — deleted_at + token_version + refuz pending_token 2FA + Origin + maxPayload"
model_suggested: Opus 4.8
branch: develop
zona: server/index.mjs (bloc WS), server/ws/auth.mjs (NOU), teste
versiune_tinta: v3.9.684
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.682)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`. NU atinge zona NO-TOUCH (semnare STS/PAdES).

---

## CONTEXT — patru găuri în handshake-ul WebSocket

Serverul WS e la `server/index.mjs:1866-1948`. Autentificarea se face pe **două căi**, și **ambele**
fac doar `jwt.verify` — semnătură și expirare. Atât.

| # | Gaura | Dovada |
|---|---|---|
| **G1** | Fără `deleted_at` / `token_version` | `index.mjs:1897` (cookie) și `index.mjs:1930` (auth manual). Un cont **dezactivat** rămâne conectat pe canalul de notificări până expiră JWT-ul (8h). `sessionGuard` (#88) NU atinge upgrade-ul WS. |
| **G2** | **Acceptă pending_token-ul de 2FA** | `server/routes/auth.mjs:100` semnează pending-token-ul cu **același `JWT_SECRET`**, iar payload-ul conține `email`. WS-ul face `jwt.verify` + `decoded.email` fără să verifice `requires2fa`. Cine are parola dar **NU** are codul TOTP deschide WS-ul și primește notificări 10 minute. |
| **G3** | Fără `maxPayload` | `new WebSocketServer({ server, path:'/ws' })` — un singur frame mare umple heap-ul. Clientul trimite doar `{type:'auth'}` / `{type:'ping'}`. |
| **G4** | Fără verificare `Origin` la upgrade | `SameSite=lax` atenuează, dar nu e o apărare pe care s-o pariezi. Lista de origini permise **există deja**: `corsOrigins` (`index.mjs:611`, din `mountCors()`). |

Bonus (G5): nu se cere `payload.userId`. Tokenurile funcționale (upload/signer) n-au `email` și pică
oricum în `catch`, dar cerința trebuie să fie **explicită**, nu accidentală.

---

## PAS 0 — RECON (read-only, fără modificări)

```bash
sed -n '1866,1950p' server/index.mjs
sed -n '1165,1175p' server/index.mjs          # wsClients / wsRegister / wsUnregister
sed -n '88,112p' server/routes/auth.mjs       # payload-ul pending_token (confirmă requires2fa + email)
cat server/utils/cors-config.mjs              # forma exactă a `appOrigins` (array | false?)
grep -n "mountCors\|corsOrigins" server/index.mjs
grep -rn "new WebSocket(" public/js | head    # ce trimite clientul: cookie sau {type:'auth'}?
```

**Nu scrie nimic până nu răspunzi la:** `appOrigins` e array de string-uri sau poate fi `false`?
Codul tău trebuie să trateze **ambele** forme.

---

## PAS 1 — Modul nou: `server/ws/auth.mjs`

O singură funcție, **pură ca interfață**, testabilă, importată de `index.mjs`.

```js
// server/ws/auth.mjs
// SEC-100: autentificarea WS trece prin ACELEAȘI verificări ca sessionGuard (#88).
// jwt.verify e necesar, dar NU e suficient: un JWT valid criptografic poate aparține
// unui cont dezactivat, unei sesiuni revocate sau unui login 2FA neterminat.

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/auth.mjs';
import { pool, DB_READY } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

/**
 * @returns {Promise<{userId:number, email:string, role:string, orgId:any}|null>}
 *          null = REFUZ. Niciodată nu returnează un obiect „parțial valid".
 */
export async function authenticateWsToken(token) {
  if (!token || typeof token !== 'string') return null;

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return null; }

  // G2 — pending_token de 2FA: parola e corectă, al doilea factor NU a fost prezentat.
  if (payload?.requires2fa) {
    logger.warn({ userId: payload?.userId }, 'WS: pending_token 2FA refuzat');
    return null;
  }

  // G5 — tokenurile funcționale (upload/signer) nu sunt sesiuni de utilizator.
  if (!payload?.userId) return null;

  // FAIL-CLOSED: fără DB nu putem verifica revocarea ⇒ refuzăm. Consistent cu sessionGuard,
  // care returnează 503 pe aceeași condiție.
  if (!pool || !DB_READY) {
    logger.error({ userId: payload.userId }, 'WS: DB indisponibil — fail-closed');
    return null;
  }

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, org_id, token_version
         FROM users
        WHERE id = $1
          AND deleted_at IS NULL`,
      [payload.userId]
    );
    row = rows[0] || null;
  } catch (e) {
    logger.error({ err: e, userId: payload.userId }, 'WS: lookup eșuat — fail-closed');
    return null;
  }

  if (!row) return null;                                        // G1a — cont șters/dezactivat

  const dbTv  = row.token_version ?? 1;
  const jwtTv = payload.tv ?? 1;
  if (Number(jwtTv) !== Number(dbTv)) return null;              // G1b — sesiune revocată

  return {
    userId: row.id,
    email:  String(row.email || '').toLowerCase(),              // email-ul din DB, NU din token
    role:   row.role,
    orgId:  row.org_id ?? null,
  };
}

/**
 * G4 — Origin permis la upgrade. `allowed` vine din `mountCors()` (`appOrigins`).
 * Tratează AMBELE forme: array de origini, sau `false` (CORS blocat complet).
 */
export function isWsOriginAllowed(origin, allowed) {
  if (!origin) return true;              // clienți non-browser (curl, teste) nu trimit Origin
  if (allowed === false) return false;   // CORS blocat ⇒ nu acceptăm origini externe
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(origin);
}
```

⚠️ **`email` se ia din rândul din DB, nu din token.** Notificările sunt indexate pe email
(`wsClients` e `Map<email, Set<ws>>`), iar migrația 067 permite **reutilizarea unui email**
după soft-delete. Emailul din DB e singurul adevăr.

---

## PAS 2 — `index.mjs`: cablează modulul

**2a. Import** — lângă celelalte importuri de server (`index.mjs`, ~linia 509):

```js
import { authenticateWsToken, isWsOriginAllowed } from './ws/auth.mjs';
```

**2b. `maxPayload` (G3)** — patch exact:

- `old_str`: `const wss = new WebSocketServer({ server: httpServer, path: '/ws' });`
- `new_str`:
```js
// SEC-100: G3 — clientul trimite doar {type:'auth'} / {type:'ping'}. 64 KB e generos.
const WS_MAX_PAYLOAD = 64 * 1024;
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: WS_MAX_PAYLOAD });
```

**2c. Origin (G4)** — la începutul lui `wss.on('connection', (ws, req) => {`, ÎNAINTE de orice altceva:

```js
  // SEC-100: G4 — origine necunoscută ⇒ conexiunea nu începe.
  const _origin = req.headers.origin || '';
  if (!isWsOriginAllowed(_origin, corsOrigins)) {
    logger.warn({ origin: _origin }, 'WS: origine respinsă');
    ws.close(4403, 'forbidden_origin');
    return;
  }
```

⚠️ `corsOrigins` e definit la `index.mjs:611` — **înaintea** blocului WS (linia 1866). Confirmă cu
`grep -n "corsOrigins" server/index.mjs` că e în scope, nu re-declara lista.

**2d. Calea cookie (G1/G2/G5)** — `wss.on('connection')` devine `async`. Înlocuiește tot blocul
`if (cookieToken) { try { const decoded = jwt.verify(cookieToken, JWT_SECRET); ... } catch ... }`
cu:

```js
  const cookieToken = getWsCookieToken(req);
  if (cookieToken) {
    const ident = await authenticateWsToken(cookieToken);
    if (ident) {
      clientEmail = ident.email;
      wsRegister(clientEmail, ws);
      ws._wsUserId = ident.userId;           // SEC-100: necesar pentru revalidarea periodică
      ws.send(JSON.stringify({ event: 'auth_ok', email: clientEmail }));
      if (pool && DB_READY) {
        pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [clientEmail])
          .then(r => ws.send(JSON.stringify({ event: 'unread_count', count: parseInt(r.rows[0].count) })))
          .catch(() => {});
      }
      logger.info({ email: clientEmail }, 'WS auto-auth (cookie)');
    } else {
      logger.warn('WS: cookie respins (invalid / revocat / 2FA neterminat)');
      // NU terminăm: clientul poate încerca auth manual. Timeout-ul de 15s îl prinde oricum.
    }
  }
```

**2e. Calea manuală (G1/G2/G5)** — `ws.on('message')` devine `async`. Blocul
`if (msg.type === 'auth' && msg.token)` cheamă `await authenticateWsToken(msg.token)`;
pe `null` ⇒ `ws.send({event:'auth_error', message:'invalid_or_revoked'})` **și `ws.terminate()`**
(spre deosebire de cookie, aici clientul a cerut explicit auth — un refuz e final).
Pe succes: identic cu 2d (inclusiv `ws._wsUserId`).

---

## PAS 3 — Revalidare periodică (G1, partea care contează)

Fără asta, un cont dezactivat **la 10:00** rămâne conectat până închide tabul. Heartbeat-ul există
deja (`wsHeartbeat`, la 30s). Adaugă un al doilea interval, la **5 minute**:

```js
// SEC-100: G1 — revocarea trebuie să ajungă și la socketurile DEJA deschise, nu doar la reconectare.
const WS_REVALIDATE_MS = 5 * 60 * 1000;
const wsRevalidate = setInterval(async () => {
  if (!pool || !DB_READY) return;                  // fără DB nu tăiem conexiuni pe orb
  for (const ws of wss.clients) {
    const uid = ws._wsUserId;
    if (!uid) continue;                            // socket neautentificat — timeout-ul îl prinde
    try {
      const { rows } = await pool.query(
        'SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL AND COALESCE(token_version,1)=$2',
        [uid, ws._wsTv ?? 1]
      );
      if (!rows.length) {
        logger.warn({ userId: uid }, 'WS: sesiune revocată — închidem socketul');
        ws.send(JSON.stringify({ event: 'session_revoked' }));
        ws.close(4401, 'session_revoked');
      }
    } catch (e) { logger.error({ err: e, userId: uid }, 'WS: revalidare eșuată'); }
  }
}, WS_REVALIDATE_MS);
wss.on('close', () => clearInterval(wsRevalidate));
```

⚠️ Ca să funcționeze, `authenticateWsToken` trebuie să întoarcă și `tv` (adaugă `tv: dbTv` în
obiectul returnat), iar la înregistrare pui `ws._wsTv = ident.tv`. **Fă modificarea în PAS 1** —
nu o improviza aici.

⚠️ `clearInterval(wsRevalidate)` trebuie adăugat **și** în `shutdown()` (`index.mjs`, lângă
`clearInterval(wsHeartbeat)`), altfel procesul nu se închide curat pe deploy Railway.

---

## PAS 4 — Teste (⛔ testele IMPORTĂ din producție — nu redeclara logica)

**Unit** — `server/tests/unit/ws-auth.test.mjs`, cu `pool` mock-uit:

1. token cu `requires2fa: true` ⇒ **`null`** ← *testul care dovedește G2*
2. token fără `userId` (payload de upload: `{flowId, signerToken, preHash}`) ⇒ `null`
3. token valid, user cu `deleted_at` setat (0 rânduri) ⇒ `null`
4. token cu `tv: 1`, DB are `token_version: 2` ⇒ `null`
5. token valid, user activ ⇒ obiect cu `email` **din DB**, nu din token (fixture: token cu
   `email: 'VECHI@x.ro'`, DB cu `nou@x.ro` ⇒ rezultatul e `nou@x.ro`)
6. `DB_READY = false` ⇒ `null` (fail-closed)
7. `isWsOriginAllowed('https://evil.ro', ['https://app.docflowai.ro'])` ⇒ `false`
8. `isWsOriginAllowed(undefined, [...])` ⇒ `true` (client non-browser)
9. `isWsOriginAllowed('https://app.docflowai.ro', false)` ⇒ `false`

**DB** — `server/tests/db/ws-auth.test.mjs`, Postgres real:

10. user seeded prin helperii existenți (`seedOrgUser`) + token semnat cu `tv` real ⇒ identitate validă
11. `UPDATE users SET deleted_at=NOW()` ⇒ același token ⇒ `null`
12. `UPDATE users SET token_version = token_version + 1` ⇒ același token ⇒ `null`

⛔ Fixture-urile trec prin funcțiile reale (`seedOrgUser`, `hashPassword`), nu prin valori literale.
⛔ Verifică numele coloanelor în `server/db/index.mjs` înainte să scrii SQL.

---

## PAS 5 — Versiune

`package.json` → **v3.9.684**.

```bash
grep -rn "notif-widget.js\|sw.js" public/sw.js | head -3
# Schimbare EXCLUSIV pe server ⇒ FĂRĂ bump CACHE_VERSION, FĂRĂ ?v=.
# Dacă ai atins vreun fișier din public/, OPREȘTE-TE și raportează — nu era în scope.
```

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
sec(ws): handshake fail-closed — deleted_at, token_version, refuz pending_token 2FA, Origin, maxPayload (v3.9.684)
```

---

## RAPORT FINAL

1. `appOrigins` — array sau `false`? Ce formă a returnat efectiv `mountCors()`? Le tratezi pe ambele?
2. **Testul #1 (pending_token 2FA) trece?** Lipește rezultatul. *Ăsta e testul care dovedește că repari o gaură reală.*
3. `wss.on('connection')` și `ws.on('message')` sunt `async` — ai verificat că o excepție în interior
   nu omoară procesul? (`unhandledRejection` are handler care face `process.exit(1)`!) Ai `try/catch`?
4. Revalidarea la 5 min: câte query-uri/oră la 48 de utilizatori conectați? E acceptabil?
5. `clearInterval(wsRevalidate)` e **și** în `shutdown()`? `grep -n "clearInterval" server/index.mjs`
6. `email`-ul înregistrat în `wsClients` vine din **DB**, nu din token? Testul #5 o dovedește?
7. Ai atins vreun fișier din `public/`? `git diff --name-only` — lipește ieșirea.
8. Zona NO-TOUCH: `git diff --name-only | grep -E "signing|pades"` ⇒ trebuie **gol**.
9. `npm test` și `npm run test:db` — **separat**, ambele verzi. Lipește ambele rezultate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Nu extrage WS-ul într-un modul separat.** Refactorul e la #105. Aici doar securitate.
- ⛔ **Fail-closed peste tot.** Fără DB ⇒ **refuz**, niciodată „lasă-l să treacă, probabil e ok".
- ⛔ **Zero modificări în `public/`.** Frontend-ul nu se schimbă la acest prompt.
- ⛔ Zona NO-TOUCH (`cloud-signing`, `bulk-signing`, `pades`, `java-pades-client`, `STSCloudProvider`) — **neatinsă**.
- ⛔ Nu re-declara lista de origini. Refolosește `corsOrigins`.
