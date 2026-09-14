---
prompt: 182
titlu: "force_password_change devine o poartă reală pe server, nu un banner din localStorage"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.836
versiune_tinta: v3.9.837
migratii: NU
fisiere_din_public: NU   (⇒ FĂRĂ bump `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Context

`users.force_password_change` există din migrația `020`, se pune la creare, la bulk-import,
la resetarea parolei și la retrimiterea credențialelor, și se stinge într-un singur loc:
`POST /auth/change-password` (`auth.mjs:273`).

Pe server nu îl aplică **nimic**. `session-guard.mjs:102` îl citește în `SELECT` și nu-l
folosește. Singura consecință vizibilă e un banner desenat din `localStorage`
(`public/js/admin/admin.js:137-138`) — adică o sugestie pe care utilizatorul o poate închide,
sau care dispare la prima golire a stocării locale. Un cont care trebuie să-și schimbe parola
poate opera nelimitat, inclusiv semna documente, cu parola generată de administrator și
cunoscută de el.

**Măsurat pe producție înainte de acest lot** (nu presupus):

- 56 de conturi active, **6 cu steagul pus**;
- toate cele 6 au **zero evenimente** în `audit_log` și **zero fluxuri** în care apar ca semnatari;
- controlul pozitiv confirmă că măsurătoarea nu e mută: 15.113 evenimente în `audit_log`,
  43 din 56 de conturi au activitate auditată, 42 apar ca semnatari.

⇒ Poarta **nu blochează niciun utilizator care lucrează azi**. Cele 6 conturi n-au fost
folosite niciodată.

---

## Ce NU face acest lot

- ⛔ **Nu atinge `public/`.** Frontendul nu tratează codul nou. E o alegere, nu o omisiune:
  `_apiFetch` are **patru definiții** (`admin/core.js:3`, `df-apifetch-shim-full.js:15`,
  `df-apifetch-shim.js:11`, `bulk-signer/bulk-signer.js:24`), iar cablarea aceleiași ramuri în
  patru locuri e exact tiparul care produce divergență. Se face după consolidarea shim-ului,
  ca lot separat. Până atunci: bannerul de la logare există deja și butonul „Schimbă parola"
  din el funcționează.
- ⛔ Nu schimbă cine primește steagul și când. Cele patru locuri care îl scriu rămân neatinse.
- ⛔ Nu dezactivează conturi. Curățarea celor 6 e o decizie separată a lui Mircea.

---

## ETAPA 0 — ancorele (READ-ONLY)

Rulează și raportează valorile **OBȚINUTE**. Orice nepotrivire ⇒ **OPREȘTE-TE**.

```bash
node -p "require('./package.json').version"
# Așteptat: 3.9.836

grep -n "force_password_change" server/middleware/session-guard.mjs
# Așteptat: exact 1 linie — în lista de coloane a SELECT-ului (~102). Dacă apar mai multe,
# altcineva a atins fișierul între timp: OPREȘTE-TE.

grep -n "req._actorRow = row;" server/middleware/session-guard.mjs
# Așteptat: exact 1 linie (~164)

grep -rn "password_change_required" server public --include=*.mjs --include=*.js
# Așteptat: 0 linii

grep -c "" server/middleware/session-guard.mjs
# raportează numărul de linii, ca reper
```

Apoi citește **întreg** `server/middleware/session-guard.mjs` înainte de a scrie ceva. Poarta
pe care o adaugi se aplică pe TOATE rutele autentificate — e cea mai mare rază de acțiune din
proiect. Nu lucra din fragmente.

---

## ETAPA A — poarta

`server/middleware/session-guard.mjs`, imediat înainte de pasul 10.

`old_str`
```js
    // 10. Rândul validat se pune pe req ⇒ `resolveActor` îl refolosește, fără al doilea query.
    //     Astfel „fără cache" nu adaugă un query pe rutele care chemau deja resolveActor.
    req._actorRow = row;
    return next();
```

`new_str`
```js
    // 10. #182 — schimbarea obligatorie a parolei. Steagul se pune la creare, la bulk-import,
    //     la resetarea parolei și la retrimiterea credențialelor; se stinge EXCLUSIV la
    //     POST /auth/change-password. Până acum era doar un banner desenat din localStorage,
    //     adică o sugestie: contul putea opera nelimitat, inclusiv semna, cu o parolă generată
    //     de administrator și cunoscută de el.
    //
    //     403, nu 401: sesiunea E validă, iar 401 ar declanșa deconectarea în frontend și l-ar
    //     trimite pe om înapoi la logare, într-o buclă — se loghează, e deconectat, se loghează.
    //     403 spune „ești cine zici că ești, dar nu poți face asta încă".
    //
    //     Nu e nevoie de listă albă: `/auth/` NU e printre GUARDED_PREFIXES, deci
    //     change-password, /auth/me, /auth/csrf-token și ieșirea din cont trec pe lângă poartă.
    //     Paginile HTML nu sunt nici ele guarded ⇒ omul își poate încărca pagina, vede
    //     bannerul și își schimbă parola. Dacă adaugi vreodată `/auth/` la GUARDED_PREFIXES,
    //     poarta asta devine o capcană fără ieșire.
    if (row.force_password_change === true) {
      logger.warn({ userId: payload.userId, path: req.path },
        'sessionGuard: schimbarea parolei e obligatorie — acces refuzat (403)');
      return res.status(403).json({
        error: 'password_change_required',
        message: 'Trebuie să îți schimbi parola înainte de a continua.',
      });
    }

    // 11. Rândul validat se pune pe req ⇒ `resolveActor` îl refolosește, fără al doilea query.
    //     Astfel „fără cache" nu adaugă un query pe rutele care chemau deja resolveActor.
    req._actorRow = row;
    return next();
```

⚠️ `=== true` e deliberat: coloana e `NOT NULL DEFAULT FALSE`, dar dacă vreodată devine
nullable, un `if (row.force_password_change)` pe `null` s-ar comporta corect, iar unul pe orice
altă valoare adevărată ar bloca pe toată lumea. Compară explicit.

---

## ETAPA B — testele

### B.1 — unitar, `server/tests/unit/session-guard.test.mjs` (fișier EXISTENT)

Adaugă cazuri **fără să modifici sau să slăbești** vreunul existent. Dacă structura fișierului
nu permite adăugarea curată, spune asta în raport și creează un fișier nou în loc — nu rescrie
testele existente ca să încapă ale tale.

Ce trebuie acoperit, dacă fișierul testează `isGuardedPath`:
1. `/auth/change-password`, `/auth/me`, `/auth/csrf-token` ⇒ **NU** sunt guarded. Ăsta e testul
   care ține poarta să nu devină o capcană fără ieșire; scrie-i un nume care spune asta.
2. `/api/`, `/flows`, `/flows/x`, `/admin/x`, `/bulk-signing/x`, `/my-flows` ⇒ guarded
   (nedeteriorare, dacă nu sunt deja acoperite).

### B.2 — DB, fișier NOU `server/tests/db/force-password-change-gate.test.mjs`

Pe Postgres real, cu utilizatori reali:

1. **Poarta ține:** utilizator cu `force_password_change=TRUE`, autentificat corect ⇒ `GET` pe o
   rută din `/api/` întoarce **403 `password_change_required`**.
2. **Aceeași poartă pe suprafața de semnare:** același utilizator pe o rută din `/flows/` sau
   `/bulk-signing/` ⇒ tot 403. (Ăsta e motivul lotului: nu voiam să poată semna.)
3. **Ieșirea există:** același utilizator ⇒ `POST /auth/change-password` cu parola curentă și una
   nouă validă **reușește**. Nu 403.
4. **Ciclul complet, cazul care dovedește totul:** după pasul 3, cu cookie-ul nou primit,
   aceeași rută din pasul 1 întoarce **200**. Steagul e `FALSE` în DB.
5. **Nedeteriorare:** utilizator fără steag ⇒ 200 de la început, neschimbat.
6. **Ordinea gărzilor:** utilizator cu steag **și** `token_version` nepotrivit ⇒ **401**
   (`token_revoked`), nu 403. Revocarea sesiunii are prioritate față de schimbarea parolei —
   verifică pe cod că poarta e după pasul 7, și scrie testul care fixează ordinea.
7. **Cont dezactivat cu steag** ⇒ 401 `session_revoked`, nu 403. Aceeași familie ca 6.

⚠️ Pasul 4 e cel care contează cel mai mult. O poartă din care nu se poate ieși e mai rea decât
lipsa porții. Dacă pasul 4 nu trece, **oprește-te și raportează** — nu ajusta testul.

```bash
npm test
npm run test:db
```

`test:db` trebuie să ruleze **COMPLET, REAL** (rețeta cu PostgreSQL 17 efemer din `CLAUDE.md`).
**Skipped ≠ passed.**

⚠️ Suspectul numărul unu la regresii: orice test existent care se autentifică cu un utilizator
creat prin `POST /admin/users` capătă acum steagul (ruta îl pune hardcodat, `users.mjs:257`) și
va lua 403 pe primul apel de după. **Dacă pică teste preexistente, oprește-te și raportează
ÎNAINTE de a le modifica** — lista lor e informația cea mai valoroasă din acest lot, fiindcă
spune exact ce cale reală se lovește de poartă. Nu le repara tăcut inserând un `UPDATE` pe steag
în fixture.

---

## ETAPA C — evidența

În `CLAUDE.md`, în secțiunea de securitate, o intrare scurtă: steagul e de acum aplicat pe
server în `session-guard.mjs`; `/auth/` e în afara `GUARDED_PREFIXES` și **asta e** ieșirea din
poartă; frontendul nu tratează încă `password_change_required` (lot separat, după consolidarea
celor patru copii ale lui `_apiFetch`).

---

## ETAPA D — versiune, lockfile, commit

```bash
npm version 3.9.837 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
# Așteptat: 2 linii de versiune, zero mișcare în arborele de dependențe
git status --short
```

`git add` **explicit**, pe fișiere numite. **Niciodată `git add -A`.**

Commit:
```
feat(#182): schimbarea obligatorie a parolei devine poarta pe server — v3.9.837

force_password_change era citit in session-guard si nefolosit; singura lui
consecinta era un banner desenat din localStorage, adica o sugestie. Un cont
care trebuia sa-si schimbe parola putea opera nelimitat, inclusiv semna, cu
parola generata de administrator si cunoscuta de el.

Poarta intoarce 403 password_change_required pe rutele autentificate. Nu 401,
care ar deconecta si ar produce o bucla de logare. Iesirea din poarta exista
prin constructie: /auth/ nu e in GUARDED_PREFIXES, deci change-password ramane
accesibil. Ordinea gardilor e fixata prin test: revocarea sesiunii are
prioritate.

Masurat pe productie inainte: 6 din 56 de conturi au steagul, toate cu zero
evenimente in audit_log si zero fluxuri ca semnatar, pe un audit_log cu 15.113
evenimente si 43 de conturi cu activitate. Niciun utilizator care lucreaza azi
nu e afectat.

Frontendul nu trateaza inca noul cod: _apiFetch are patru definitii, iar
cablarea aceleiasi ramuri in patru locuri se face dupa consolidarea lor.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**.
2. Poziția exactă la care ai inserat poarta și **confirmarea că e după** verificarea de
   `token_version` și după cea de cont dezactivat. Dacă ai mutat-o, spune de ce.
3. Rezultatul fiecărui caz din B.2, cu accent pe **4** (ieșirea din poartă) și pe **6/7**
   (ordinea gărzilor).
4. **Lista completă a testelor preexistente care au picat**, dacă au picat, cu ruta pe care
   s-au lovit de poartă — înainte de orice reparație. Dacă n-a picat niciunul, spune-o explicit;
   e o informație, nu o absență.
5. Ai adăugat în fișierul unitar existent sau ai creat unul nou, și de ce.
6. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat **COMPLET**.
7. Rezultatul verificării lockfile-ului.
8. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
9. Constatări colaterale. Mă interesează în mod special: mai există vreo cale prin care un
   utilizator poate schimba parola în afară de `POST /auth/change-password`? Dacă da, poarta
   are o a doua ieșire pe care n-am prevăzut-o.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. **Zero fișiere din `public/`.** Zero atingeri NO-TOUCH.
- Poarta se pune **numai** în `session-guard.mjs`. Nu împrăștia verificarea prin rute.
- Nu atinge cele patru locuri care SCRIU steagul.
- Nu modifica `GUARDED_PREFIXES` / `GUARDED_EXACT`. Dacă ți se pare că trebuie, oprește-te
  și raportează — ar însemna că am înțeles greșit suprafața.
- Un test preexistent care pică e **semnal**, nu obstacol: raportezi întâi.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
