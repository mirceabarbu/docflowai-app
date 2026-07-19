---
model_suggested: Opus 4.8
tip: SECURITATE — remediere post-incident. Producția a fost expusă.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire, niciodată editare):**
> `server/routes/flows/signing.mjs`, `server/routes/flows/cloud-signing.mjs`,
> `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`,
> `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs`

---

## Context — incident real, 13.07.2026

`NODE_ENV` **nu era setat** pe Railway. `server/routes/auth.mjs:277` montează rutele de
recovery cu `if (process.env.NODE_ENV !== 'production')` — condiție **adevărată** când
variabila lipsește. Rezultat: `/auth/debug`, `/auth/fix-admin`, `/auth/fix-admin-role`
au fost **live pe internet, pe producție**, confirmat prin browser.

Cel mai grav: `/auth/debug` cade pe `jwt.decode()` când `jwt.verify()` eșuează — **fără
verificare de semnătură** — apoi are încredere în `decoded.role === 'admin'` din payload-ul
neverificat. Orice JWT fabricat, cu semnătură de gunoi, returna rânduri din tabela `users`.
Zero secrete necesare.

Containment-ul e făcut (`NODE_ENV=production` setat manual în Railway, `ADMIN_SECRET` rotit).
**Promptul ăsta face fix-ul permanent în cod**, ca aplicația să nu mai poată degrada în tăcere
când o variabilă de mediu lipsește.

**Principiul care guvernează tot promptul: securitatea nu se condiționează la runtime pe o
variabilă de mediu opțională. Ori codul periculos nu există, ori procesul refuză să pornească.**

---

## PAS 1 — Șterge fizic rutele de recovery

Fișier: `server/routes/auth.mjs`.

Blocul începe la **linia 275** (comentariul) / **277** (`if`) și se închide la **linia 397**
(`} // end development-only routes`). Conține exact trei rute:
`GET /auth/debug`, `POST /auth/fix-admin-role`, `GET /auth/fix-admin`.

**Șterge tot blocul, inclusiv `if`-ul și acolada de închidere.** Nu-l comenta, nu-l muta
sub alt flag. Îl ștergi.

Verifică granițele înainte:
```bash
sed -n '274,278p;395,399p' server/routes/auth.mjs
# Așteptat: comentariul + `if (process.env.NODE_ENV !== 'production') {`
#           și `} // end development-only routes`
```

După ștergere:
```bash
grep -n "auth/debug\|fix-admin" server/routes/auth.mjs
# Așteptat: ZERO rezultate

grep -rn "auth/debug\|fix-admin" public/ server/ --include="*.js" --include="*.mjs" --include="*.html" | grep -v tests | grep -v "scripts/fix-admin.mjs"
# Așteptat: ZERO. Nimic din frontend nu le apelează. Dacă apare ceva, OPREȘTE-TE și raportează.
```

**Înlocuitorul există deja: `scripts/fix-admin.mjs`.** Rulabil cu `railway run node
scripts/fix-admin.mjs`, suportă `--list` și email ca argument. Nu construi nimic nou.
Nu recrea rutele „într-o formă mai sigură". Nu ai nevoie de ele ca rute HTTP.

⚠️ **NU atinge `requireAdmin()` din `server/middleware/auth.mjs:132`.** Bypass-ul cu
`x-admin-secret` de acolo e o funcție separată, cu rate limiting persistent și audit log —
rămâne exact cum e. Nu confunda cele două lucruri.

---

## PAS 2 — Fail-fast la boot pe `NODE_ENV`

Fișier: `server/config.mjs`, linia 50:
```js
NODE_ENV: optional('NODE_ENV', 'development'),
```

Problema e chiar cuvântul `optional`. O variabilă care decide dacă rutele de administrare
sunt publice **nu are voie să aibă default**.

Fă-o **obligatorie și validată**: procesul pornește DOAR dacă `NODE_ENV` este exact una
dintre `production`, `staging`, `development`, `test`. Orice altceva (lipsă, gol, `Production`
cu P mare, typo) ⇒ mesaj clar pe `stderr` + `process.exit(1)`.

Validarea trebuie să ruleze **la import-ul modulului**, înainte ca serverul să asculte pe port.
`server/index.mjs` importă deja `config.mjs` — verifică-l și pune validarea acolo unde se
execută sigur la boot.

Mesajul de eroare trebuie să fie explicit, nu un stack trace:
```
FATAL: NODE_ENV lipsește sau are o valoare invalidă (primit: "<x>").
Valori acceptate: production | staging | development | test.
Setează variabila în Railway → Variables. Procesul se oprește.
```

⚠️ **`staging` e o valoare acceptată, dar NU e `production`.** Verifică fiecare loc care
compară cu `'production'` — dacă staging rulează cu `NODE_ENV=staging`, cookie-urile își
pierd flagul `Secure`. **Mircea a setat `NODE_ENV=production` și pe staging, deliberat**, deci
azi nu e o problemă — dar codul nu trebuie să presupună asta. Folosește `config.isProd` acolo
unde contează securitatea, și definește-l ca `NODE_ENV !== 'development' && NODE_ENV !== 'test'`
— adică **fail-secure**: orice mediu care nu e explicit dev/test primește cookie-uri `Secure`.

---

## PAS 3 — Un singur loc care decide flagurile de cookie

Azi sunt **două reguli diferite** pentru același lucru, iar cea greșită lovea exact
utilizatorii cu 2FA:

| Loc | Regulă | Efect când `NODE_ENV` lipsea |
|---|---|---|
| `middleware/auth.mjs:183` — `setAuthCookie()` | `secure: NODE_ENV !== 'test'` | ✅ `Secure` prezent |
| `routes/totp.mjs:256` — login 2FA | `secure: NODE_ENV === 'production'` | 🔴 **`Secure` LIPSĂ** |
| `routes/auth.mjs:120,149` — `csrf_token` | `secure: NODE_ENV === 'production'` | 🔴 `Secure` lipsă |
| `routes/totp.mjs:262` — `csrf_token` | `secure: NODE_ENV === 'production'` | 🔴 `Secure` lipsă |

Adică cine și-a activat 2FA a primit o sesiune **mai slabă** decât cine nu l-a activat.

**Fă asta:**
1. În `server/middleware/auth.mjs`, adaugă `setCsrfCookie(res, token, maxAgeMs)` — geamăn cu
   `setAuthCookie()`, cu `httpOnly: false`, `sameSite: 'strict'`, `secure: config.isProd`.
2. Înlocuiește **toate cele patru** `res.cookie('csrf_token', ...)` cu apeluri la ea
   (`routes/auth.mjs:117`, `routes/auth.mjs:147`, `routes/totp.mjs:259`, plus cel din
   `/auth/refresh` la ~`auth.mjs:236`).
3. În `routes/totp.mjs:253`, înlocuiește `res.cookie(AUTH_COOKIE, ...)` cu `setAuthCookie(res, fullToken, maxAgeMs)`.
4. `setAuthCookie` folosește și el `config.isProd`, nu `NODE_ENV !== 'test'`.

⚠️ **Atenție la `sameSite`:** `setAuthCookie` are `sameSite: 'lax'` **deliberat** (comentariul
de la linia 184: `'strict'` bloca cookie-ul la redirectul OAuth). Calea TOTP folosea `'strict'`.
**Păstrează `'lax'`** când unifici — altfel spargi OAuth-ul STS. Notează schimbarea în raport.

Verificare:
```bash
grep -rn "res.cookie(" server/routes/ server/middleware/ | grep -v tests
# Așteptat: DOAR în setAuthCookie/clearAuthCookie/setCsrfCookie din middleware/auth.mjs.
# Zero res.cookie() direct în routes/.
```

---

## PAS 4 — Decuplează logging-ul de securitate

`server/middleware/logger.mjs:46`:
```js
stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
```

Aceeași variabilă controlează și dacă rutele de admin sunt publice, și cât de verbose sunt
logurile. **Exact confuzia asta a produs incidentul.**

Separă-le: introdu `LOG_STACK` (`'1'` = include stack trace). Default: activ dacă
`config.isProd === false`, dar poate fi forțat cu `LOG_STACK=1` în orice mediu.

Astfel staging poate rula `NODE_ENV=production` + `LOG_STACK=1` — comportament de securitate
identic cu producția, dar diagnostic complet.

Adaugă `LOG_STACK` în `env.example`, cu un comentariu.

---

## PAS 5 — `env.example` și documentație

`env.example` **nu conține `NODE_ENV`** — de aceea a și lipsit din Railway. Adaugă-l primul
în fișier, cu avertisment:

```
# OBLIGATORIU. Fără el, procesul refuză să pornească.
# production | staging | development | test
NODE_ENV=production

# Opțional: include stack trace complet în loguri (util pe staging).
LOG_STACK=0
```

`Dockerfile` **nu** setează `NODE_ENV` — și e corect așa: îl setezi explicit per-mediu în
Railway. **Nu-l adăuga în Dockerfile.** Un `ENV NODE_ENV=production` în imagine ar readuce
exact problema pe care o reparăm: o valoare implicită, invizibilă, greu de auditat.

---

## PAS 6 — Teste de regresie (obligatorii)

Fișier nou: `server/tests/unit/env-hardening.test.mjs`.

1. **Rutele nu mai există în sursă** — citește `server/routes/auth.mjs` și asertă că nu
   conține `'/auth/debug'`, `'/auth/fix-admin'`, `'/auth/fix-admin-role'`.
   (Test de caracterizare pe sursă — acceptabil aici, pentru că afirmația *este* despre sursă.)
2. **`config.mjs` respinge un `NODE_ENV` invalid** — importă modulul de validare cu o valoare
   greșită și asertă că aruncă / iese. Nu chema `process.exit()` în test: extrage validarea
   într-o funcție pură exportată (ex. `validateNodeEnv(value)`) și testeaz-o pe aceea;
   `process.exit(1)` rămâne doar în caller-ul de la boot.
3. **`isProd` e fail-secure** — `validateNodeEnv('staging')` ⇒ `isProd === true`.

⛔ **Testul TREBUIE să importe din producție.** Nu redeclara `validateNodeEnv` în fișierul de
test. Avem deja trei teste care își testează propria oglindă (`alop-state.test.mjs`,
`helpers.test.mjs`, `suma-plati-pct5.test.mjs`) — nu mai facem al patrulea.

---

## PAS 7 — Versiune și verificare finală

Schimbare **exclusiv backend**: bump `package.json` la **v3.9.676**.
**NU** atinge `sw.js` / `CACHE_VERSION` / `?v=` — niciun fișier din `public/` nu se modifică.

```bash
npm run check      # Așteptat: verde
npm test           # Așteptat: verde, fără regresii (NU raporta o cifră ca dovadă de succes)
git diff --name-only public/
# Așteptat: GOL
grep -rn "NODE_ENV" server --include="*.mjs" | grep -v tests | grep -v config.mjs
# Așteptat: DOAR logger.mjs (LOG_STACK) — restul trebuie să treacă prin config.isProd
```

Commit unic pe `develop`:
```
sec: NODE_ENV fail-fast, eliminare rute recovery, unificare flaguri cookie (v3.9.676)
```

---

## RAPORT FINAL

1. Cele trei rute — șterse fizic? Confirmă cu grep-ul din PAS 1 (zero rezultate).
2. Grep în `public/` — chiar nu le apela nimeni? Ai găsit vreo referință neașteptată?
3. `requireAdmin()` din `middleware/auth.mjs` — **neatins**? Confirmă.
4. Câte `res.cookie()` erau în `routes/` înainte și câte au rămas? (Așteptat: 0 rămase.)
5. `sameSite: 'lax'` păstrat pe `auth_token`, inclusiv pe calea TOTP? Confirmă explicit —
   dacă ai pus `'strict'`, ai spart OAuth-ul STS.
6. `validateNodeEnv('staging')` ⇒ `isProd === true`? Confirmă fail-secure.
7. Testul nou **importă** din producție — nu redeclară nimic local? Arată linia de `import`.
8. Ce se întâmplă la boot cu `NODE_ENV` gol? Lipește mesajul exact.
9. `npm run check` + `npm test` — verzi?
10. `git diff --name-only public/` — gol? Versiune bumped la 3.9.676?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **NU recrea rutele de recovery** sub alt nume, alt flag, sau „într-o formă mai sigură".
  `scripts/fix-admin.mjs` există deja. Se șterg. Punct.
- ⛔ **NU atinge `requireAdmin()`** (`middleware/auth.mjs:132`) — bypass-ul `x-admin-secret`
  de acolo are rate limiting + audit și rămâne funcțional.
- ⛔ **NU adăuga `ENV NODE_ENV` în Dockerfile.**
- ⛔ **NU schimba `sameSite` de pe `'lax'` pe `'strict'`** la `auth_token` — sparge OAuth STS.
- ⛔ **NU atinge `public/`.** Zero fișiere frontend în acest prompt. XSS-ul e #93.
- ⛔ **NU redeclara logică în teste.** Testul importă din producție sau nu există.
- ⛔ **NU rota niciun secret din cod** și nu tipări valori de secrete în loguri sau raport.
- ⛔ Zonele NO-TOUCH: doar citire.
- ⛔ **NU atinge `main`.**
- ⛔ Dacă un grep de verificare nu dă `# Așteptat:`, **oprește-te și raportează.** Nu improviza.
