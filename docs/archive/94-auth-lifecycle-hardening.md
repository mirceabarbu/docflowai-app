---
model_suggested: Opus 4.8
tip: SECURITATE — ciclu de viață sesiune/parolă.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire):** `signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`

---

## Obiectiv

Patru remedieri în `server/routes/auth.mjs` + `server/middleware/auth.mjs`, toate pe același
temă: **ciclul de viață al sesiunii și al parolei**. Plus un pas de RECON, fără reparare.

Backend-only. **Zero fișiere în `public/`.** Fără bump `CACHE_VERSION`.

---

## A — Refresh fail-open când DB e indisponibil (AUTH-01)

`server/routes/auth.mjs:207` — TOATĂ validarea de identitate e închisă într-un `if`:

```js
if (pool && DB_READY) {
  // SELECT ... WHERE id=$1 AND deleted_at IS NULL
  // verificare token_version
  // rehidratare claims din DB
}
const newToken = jwt.sign({ ...decoded }, JWT_SECRET, ...);   // ← rulează ORICUM
setAuthCookie(res, newToken, jwtExpiresMs());
```

Dacă DB-ul e picat, blocul se sare complet și se semnează un token **nou, valabil 8h**, din
claim-urile vechi. Un cont șters, un rol retrogradat sau o parolă resetată își prelungesc
sesiunea exact în fereastra de incident.

**Fix:** fail-closed. Dacă `!pool || !DB_READY` ⇒ **503**, fără token nou, fără cookie:

```js
if (!pool || !DB_READY) {
  return res.status(503).json({
    error: 'db_unavailable',
    message: 'Serviciul nu poate valida sesiunea momentan. Reîncearcă în câteva momente.'
  });
}
```

⚠️ **NU șterge cookie-ul** (`clearAuthCookie`) pe această cale. Un incident DB de 30 de secunde
nu trebuie să deconecteze toți utilizatorii. Cookie-ul rămâne; refresh-ul doar eșuează temporar.

⚠️ **NU folosi codul `token_revoked` / `session_revoked`** — `notif-widget.js` le tratează ca
revocare și redirecționează la login (vezi `REVOKED_CODES` din #88.3). Aici vrem eșec temporar,
nu deconectare. `db_unavailable` e un cod nou, pe care frontendul îl ignoră.

---

## B — Schimbarea propriei parole NU invalidează celelalte sesiuni

Asta e pe dos față de cum trebuie:

| Cale | Bump `token_version`? |
|---|---|
| Admin resetează parola altcuiva (`admin/users.mjs:600`, `:818`) | ✅ DA |
| Soft-delete / reactivare user (`admin/users.mjs:655`, `:739`) | ✅ DA |
| **Utilizatorul își schimbă singur parola** (`auth.mjs:270`) | 🔴 **NU** |

Adică: un utilizator care bănuiește că i-a fost compromis contul își schimbă parola — și
**sesiunea atacatorului rămâne validă 8 ore.** Exact scenariul pentru care există funcția.

`server/routes/auth.mjs:270`:
```js
await pool.query('UPDATE users SET password_hash=$1, force_password_change=FALSE WHERE id=$2', ...)
```

**Fix — dar cu o capcană majoră.**

Adaugi `token_version=COALESCE(token_version,1)+1`. **Dar dacă te oprești aici, utilizatorul
care tocmai și-a schimbat parola e deconectat instantaneu de propriul `sessionGuard`** (tokenul
lui are `tv` vechi). Schimbi parola ⇒ ești dat afară. Inacceptabil.

**Soluția corectă, în doi timpi, în același handler:**
1. `UPDATE ... token_version=COALESCE(token_version,1)+1 ... RETURNING token_version`
2. Cu noul `token_version` din `RETURNING`, **re-emite cookie-ul de sesiune** pentru utilizatorul
   curent — `jwt.sign({...claims, tv: newTv})` + `setAuthCookie(res, ...)`.

Efect: **sesiunea curentă supraviețuiește, toate celelalte mor.** Exact ce vrei.

Emite și un `csrf_token` nou prin `setCsrfCookie()` (există din #92), ca perechea să rămână
consistentă.

Scrie și un `writeAuditEvent` cu `eventType: 'PASSWORD_CHANGED'`.
⚠️ **Nu redenumi chei de event-type existente** — asta e una nouă. Verifică dacă `EVENT_LABELS_RO`
are nevoie de traducere și adaug-o dacă da.

---

## C — `verifyPassword` compară hash-urile cu `===`

`server/middleware/auth.mjs`, în `verifyPassword()` — **ambele** ramuri (v2 și v1 legacy):
```js
return { ok: check === hash, ... };
```

Comparație de string cu short-circuit ⇒ canal lateral de timing.

**Fix:** `crypto.timingSafeEqual` pe `Buffer`-e.

⚠️ **`timingSafeEqual` ARUNCĂ dacă buffer-ele au lungimi diferite.** Nu-l chema direct pe date
neverificate — un hash trunchiat din DB ar produce un 500 la login. Verifică lungimea întâi, și
întoarce `false` (nu excepție) dacă diferă:

```js
function _safeEq(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
```

Aplică pe ambele ramuri. **Nu schimba nimic altceva** în `verifyPassword` — nici `PBKDF2_ITER_V1`,
nici `PBKDF2_ITER_V2`, nici logica de `needsRehash` (migrarea lazy v1→v2 trebuie să continue
să funcționeze pentru conturile vechi).

---

## D — Lungimea minimă a parolei: 6 → 10

`server/routes/auth.mjs:263` — `if (new_password.length < 6)`.

Șase caractere e sub orice prag rezonabil pentru o aplicație care semnează documente cu
efect juridic.

**Ridică la 10.** Motivul pentru care exact 10, nu 12:
`generatePassword()` (`middleware/auth.mjs`) produce formatul `xxx-xxx-xxx` = **11 caractere**.
Un minim de 12 ar face parolele generate de admin invalide dacă vreodată trec prin aceeași
validare. **10 e compatibil, 12 nu.**

- Fără reguli de compoziție (majuscule/cifre/simboluri) — NIST SP 800-63B le descurajează explicit.
- Păstrează maximul de 200.
- **Nu atinge parolele existente.** Se aplică doar la parole noi/schimbate. Zero risc de blocare.
- Actualizează mesajul de eroare: „minim 10 caractere".

---

## E — RECON, FĂRĂ REPARARE: `force_password_change`

`force_password_change` e setat `TRUE` pentru **fiecare utilizator nou** (`admin/users.mjs:257`)
și e returnat frontendului (`auth.mjs:131`, `:177`). `sessionGuard` îl **selectează** din DB
(`session-guard.mjs:102`) dar — verifică — pare că **nu-l impune**.

Dacă e așa, un utilizator cu `force_password_change=TRUE` poate ignora ecranul de schimbare
a parolei și folosi aplicația normal cu parola temporară primită pe email.

**NU repara asta în promptul curent.** O impunere server-side (403 pe tot, până se schimbă
parola) poate bloca utilizatori reali dacă frontendul nu tratează codul corect. Vreau datele
înainte de decizie.

**Raportează doar:**
1. `sessionGuard` chiar NU impune flagul? (citește codul, nu presupune)
2. Ce face frontendul azi cu `force_password_change` din răspunsul de login? Unde e tratat?
3. Rulează pe **staging** (nu producție):
   `SELECT COUNT(*) FROM users WHERE force_password_change = TRUE AND deleted_at IS NULL;`

---

## PAS F — Teste

Extinde suita **DB** (`server/tests/db/`), nu doar mock-urile — `npm test` nu rulează suita DB,
deci un verde acolo nu spune nimic despre asta.

1. `/auth/refresh` cu DB indisponibil ⇒ **503**, **fără** `Set-Cookie` nou. (Simulează `DB_READY=false`.)
2. Schimbare de parolă ⇒ `token_version` **crescut cu 1** în DB.
3. Schimbare de parolă ⇒ răspunsul **conține** un `Set-Cookie` nou cu `auth_token`, iar noul JWT
   are `tv` egal cu noul `token_version` din DB. **Sesiunea curentă rămâne validă.**
4. Un JWT emis **înainte** de schimbarea parolei ⇒ respins de `sessionGuard` pe o rută `/api/`.
5. `verifyPassword` — parolă corectă ⇒ `ok: true`; parolă greșită ⇒ `ok: false`; hash trunchiat/
   malformat ⇒ `ok: false` **fără excepție**.
6. Parolă de 9 caractere ⇒ 400 `password_too_short`; de 10 ⇒ acceptată.

⛔ **Testele IMPORTĂ funcțiile din producție.** Nu redeclara `verifyPassword` sau `_safeEq` în
fișierul de test. Avem deja trei teste care își testează propria oglindă — nu mai facem al patrulea.

---

## PAS G — Versiune și verificare

`package.json` → **v3.9.678**. **Fără** `CACHE_VERSION`, **fără** `?v=` — zero fișiere în `public/`.

```bash
git diff --name-only public/
# Așteptat: GOL

grep -n "if (pool && DB_READY)" server/routes/auth.mjs
# Așteptat: ZERO pe calea /auth/refresh

grep -n "=== hash" server/middleware/auth.mjs
# Așteptat: ZERO — ambele comparații trec prin timingSafeEqual

npm run check   # verde
npm test        # verde, fără regresii
npm run test:db # rulează-l EXPLICIT — npm test NU-l acoperă
```

Commit:
```
sec: refresh fail-closed, token_version la schimbarea parolei, timingSafeEqual, min 10 caractere (v3.9.678)
```

---

## RAPORT FINAL

1. `/auth/refresh` cu DB picat ⇒ 503? Cookie-ul vechi **rămâne** (nu e șters)? Codul e `db_unavailable`, nu `token_revoked`?
2. Schimbarea parolei bumpează `token_version` **și** re-emite cookie-ul? **Utilizatorul rămâne logat?** (Ăsta e punctul unde promptul poate produce un dezastru — confirmă explicit.)
3. Un JWT vechi (dinainte de schimbare) e respins de `sessionGuard`? Test verde?
4. `timingSafeEqual` — aplicat pe **ambele** ramuri (v2 și v1 legacy)? Lungimi diferite ⇒ `false`, nu excepție?
5. Migrarea lazy v1→v2 (`needsRehash`) încă funcționează? Neatinsă?
6. Minim 10 — mesajul de eroare actualizat? `generatePassword()` (11 caractere) rămâne compatibil?
7. **RECON E:** `sessionGuard` impune `force_password_change`? Ce face frontendul cu flagul? Câți useri au `TRUE` pe staging?
8. `writeAuditEvent 'PASSWORD_CHANGED'` adăugat? Traducere în `EVENT_LABELS_RO`?
9. `npm test` **și** `npm run test:db` — ambele verzi? (Raportează-le separat.)
10. `git diff --name-only public/` gol? Versiune 3.9.678?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **NU deconecta utilizatorul care își schimbă parola.** Bump `token_version` **fără**
  re-emiterea cookie-ului = toți cei 48 de utilizatori sunt dați afară la prima schimbare de parolă.
- ⛔ **NU șterge cookie-ul** pe calea `db_unavailable` din refresh.
- ⛔ **NU folosi codurile `token_revoked`/`session_revoked`** pentru 503 — frontendul le tratează ca revocare.
- ⛔ **NU chema `timingSafeEqual`** fără verificarea prealabilă a lungimii — aruncă excepție.
- ⛔ **NU repara `force_password_change`** în acest prompt. Doar RECON (pasul E).
- ⛔ **NU ridica minimul peste 10** — ar rupe compatibilitatea cu `generatePassword()`.
- ⛔ **NU atinge `public/`.** Zero fișiere frontend.
- ⛔ **NU redeclara logică în teste.** Importă din producție.
- ⛔ Zonele NO-TOUCH: doar citire. **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, **oprește-te și raportează.**
