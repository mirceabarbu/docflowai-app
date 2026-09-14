---
prompt: 181
titlu: "Parole — garda cross-tenant fail-closed la reset + politica de parole ca sursă unică"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.835
versiune_tinta: v3.9.836
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

Auditul extern din 28.08 a semnalat patru lucruri pe zona de parole. Lotul ăsta rezolvă
**două** dintre ele. Celelalte două sunt scoase DELIBERAT (vezi „Ce NU face acest lot").

**(1) Garda cross-tenant de la resetarea parolei e permisivă.**
`server/routes/admin/users.mjs:616` refuză doar dacă poate DOVEDI că organizațiile diferă:

```js
if (actor.role === 'org_admin' && actorOrgId && target.org_id && actorOrgId !== target.org_id) {
```

Dacă `actorOrgId` e `NULL` **sau** `target.org_id` e `NULL`, condiția e falsă și resetarea trece.
Sora ei din același fișier (PUT `/admin/users/:id`, ~linia 575) e deja **fail-closed** și are
comentariul care explică de ce: „un `org_admin` fără `org_id` e o stare invalidă, nu o
permisiune". Aici e forma veche. Rezultatul unei resetări reușite e o parolă nouă + un email
cu ea ⇒ preluare de cont, exact clasa P0-02.

**(2) Politica de lungime a parolei e scrisă în trei locuri, cu două valori diferite.**

| loc | prag | ce se întâmplă sub prag |
|---|---|---|
| `auth.mjs:260` — `POST /auth/change-password` | 10 | 400 `password_too_short` (corect) |
| `admin/users.mjs:198` — creare utilizator | 4 | parola scrisă de admin e **înlocuită tăcut** cu una generată |
| `admin/users.mjs:560` — PUT utilizator | 4 | parola scrisă de admin e **ignorată tăcut**; răspunsul e 200 |

Al treilea rând e un bug de produs, nu doar o inconsecvență de politică: un admin care tastează
`abc123` în câmpul de parolă de la editare primește 200, crede că a schimbat parola, și n-a
schimbat nimic. `generatePassword()` (`middleware/auth.mjs:230`) produce `xxx-xxx-xxx` = **11
caractere**, deci pragul 10 nu invalidează parolele generate de platformă.

---

## Ce NU face acest lot (scos deliberat — nu „uitat")

- ⛔ **NU scoate `tempPassword` din răspunsul lui `reset-password`.** E consumat de interfață
  (`public/js/admin/users.js:631,638,692` îl afișează în modalul „Credențiale resetate"), deci
  scoaterea lui e o **decizie de produs a lui Mircea**, nu o reparație de securitate. Lasă linia
  neatinsă. Dacă o vezi și te tentează, treci mai departe.
- ⛔ **NU aplica `force_password_change` pe server.** Azi e doar un banner din `localStorage`
  (`public/js/admin/admin.js:137`), deci ocolibil, dar aplicarea lui pe server poate bloca din
  prima secundă orice cont care are steagul pus în producție. Se face după ce se măsoară câte
  conturi sunt în starea aia. Lot separat.
- ⛔ Zero fișiere din `public/`. Zero migrații. Zero atingeri în zona NO-TOUCH.

---

## ETAPA 0 — ancorele (READ-ONLY, obligatoriu înainte de orice modificare)

Rulează și **raportează valorile OBȚINUTE**. Dacă vreuna nu se potrivește, **OPREȘTE-TE**.

```bash
node -p "require('./package.json').version"
# Așteptat: 3.9.835

grep -n "actorOrgId && target.org_id && actorOrgId !== target.org_id" server/routes/admin/users.mjs
# Așteptat: exact 1 linie (616)

grep -n "password.length >= 4" server/routes/admin/users.mjs
# Așteptat: exact 2 linii (198 și 560)

grep -n "password_too_short" server/routes/auth.mjs
# Așteptat: exact 1 linie (260)

grep -rn "password-policy" server public --include=*.mjs --include=*.js
# Așteptat: 0 linii (modulul nu există încă)

grep -rln "reset-password\|password_too_short" server/tests/
# Așteptat: cele două fișiere db/admin-users-tenant-guard.test.mjs și db/auth-lifecycle-hardening.test.mjs
```

⚠️ Ultima comandă nu e decorativă: `db/admin-users-tenant-guard.test.mjs:97` are deja un caz
numit „Paritate: cross-tenant pe `POST /admin/users/:id/reset-password` rămâne 403". Trebuie să
**rămână verde fără nicio modificare** — dacă strângerea gărzii îl sparge, ai schimbat altceva
decât credeai.

---

## ETAPA A — modul pur nou: politica de parole

Creează `server/services/password-policy.mjs`. **Modul PUR**: fără `pool`, fără `express`, fără
import din `db/`. Doar funcții și constante.

Conținut cerut (adaptează stilul la restul serviciilor din proiect, dar păstrează semantica exact):

- `export const MIN_PASSWORD_LEN = 10;`
- `export const MAX_PASSWORD_LEN = 200;`
- `export function validatePassword(pwd)` → întoarce
  - `{ ok: true }` dacă `typeof pwd === 'string'` și lungimea e în interval;
  - `{ ok: false, error: 'password_too_short', message: 'Parola trebuie să aibă minim 10 caractere.' }`
  - `{ ok: false, error: 'password_too_long', max: MAX_PASSWORD_LEN }`
  - `{ ok: false, error: 'password_missing' }` pentru `null` / `undefined` / non-string / șir gol.
- Mesajul se construiește din constantă (template literal), **nu** cu cifra scrisă de mână — dacă
  pragul se schimbă vreodată, textul trebuie să se schimbe odată cu el.
- ⛔ Fără backtick-uri în comentariile din interiorul șirurilor returnate (a patra oară când
  greșeala asta apare în proiect — vezi `CLAUDE.md`).

Test unitar nou `server/tests/unit/password-policy.test.mjs`, minim aceste cazuri:

1. 9 caractere ⇒ `password_too_short`; 10 caractere ⇒ `ok:true` (frontiera, ambele laturi).
2. 200 ⇒ `ok:true`; 201 ⇒ `password_too_long` cu `max: 200`.
3. `null`, `undefined`, `''`, `12345`, `{}` ⇒ `password_missing`, fără să arunce.
4. **Cazul care leagă politica de platformă:** `generatePassword()` importat din
   `server/middleware/auth.mjs`, rulat de 50 de ori, trece `validatePassword` de fiecare dată.
   Ăsta e testul care oprește pe cineva să urce pragul la 12 și să invalideze tăcut toate
   parolele pe care le emite chiar platforma.
5. Mesajul de la `password_too_short` conține valoarea lui `MIN_PASSWORD_LEN` (derivat, nu
   hardcodat în aserțiune — citește constanta importată).

Poartă de Etapa A:
```bash
npx vitest run server/tests/unit/password-policy.test.mjs
node --check server/services/password-policy.mjs
```

---

## ETAPA B — cablarea în `/auth/change-password` (comportament IDENTIC)

Această etapă **nu schimbă niciun comportament observabil**. Pragurile rămân 10 și 200, codurile
de eroare rămân aceleași. Se schimbă doar de unde vin.

`server/routes/auth.mjs` — adaugă importul lângă celelalte:
```js
import { validatePassword } from '../services/password-policy.mjs';
```

`old_str`
```js
  if (new_password.length < 10) return res.status(400).json({ error: 'password_too_short', message: 'Parola nouă trebuie să aibă minim 10 caractere.' });
  if (new_password.length > 200) return res.status(400).json({ error: 'password_too_long', max: 200 });
```

`new_str`
```js
  // #181 — politica de lungime vine din services/password-policy.mjs (SURSĂ UNICĂ). Aceleași
  // praguri și aceleași coduri de eroare ca înainte; se schimbă doar locul unde sunt definite.
  // Motivul: aceeași regulă era scrisă în trei locuri, cu două valori diferite.
  const _pol = validatePassword(new_password);
  if (!_pol.ok) return res.status(400).json({ error: _pol.error, message: _pol.message, ...(_pol.max ? { max: _pol.max } : {}) });
```

⚠️ Verifică singur că `db/auth-lifecycle-hardening.test.mjs:147` („parolă de 9 caractere ⇒ 400
`password_too_short`; de 10 ⇒ acceptată") rămâne verde **fără să-l modifici**. Dacă nu e verde,
ai schimbat forma răspunsului — repară codul, nu testul.

---

## ETAPA C — garda fail-closed la resetarea parolei

`server/routes/admin/users.mjs`

`old_str`
```js
    // FIX: role='admin' (super-admin) poate reseta parola oricărui user
    if (actor.role === 'org_admin' && actorOrgId && target.org_id && actorOrgId !== target.org_id) {
      return res.status(403).json({ error: 'forbidden_cross_tenant' });
    }
```

`new_str`
```js
    // #181 — FAIL-CLOSED, aceeași formă ca sora ei de la PUT /admin/users/:id (P0-02).
    // Forma veche refuza doar când putea DOVEDI că organizațiile diferă: dacă oricare dintre
    // cele două org_id era NULL, condiția cădea și resetarea trecea. Un org_admin fără org_id
    // e o stare invalidă, nu o permisiune — iar o resetare reușită înseamnă parolă nouă
    // trimisă pe email, adică preluare de cont.
    // Platform-adminul (role === 'admin') rămâne cross-org, deliberat, ca la surori.
    if (actor.role === 'org_admin') {
      if (!actorOrgId || actorOrgId !== target.org_id) {
        logger.warn({ actorId: actor.userId, targetId, actorOrgId, targetOrgId: target.org_id },
          '[SEC] POST /admin/users/:id/reset-password cross-tenant REFUZAT');
        return res.status(403).json({ error: 'forbidden_cross_tenant' });
      }
    }
```

---

## ETAPA D — parola scrisă de admin nu mai dispare tăcut

Două locuri, aceeași boală: parola tastată de admin e evaluată cu un prag care nu e politica
platformei, iar sub prag e aruncată **fără ca adminul să afle**.

### D.1 — creare utilizator (`server/routes/admin/users.mjs`, ~198)

`old_str`
```js
  const plainPwd  = password && password.length >= 4 ? password : generatePassword();
```

`new_str`
```js
  // #181 — dacă adminul NU trimite parolă, platforma generează una (comportament neschimbat,
  // câmpul din interfață e opțional: „generată automat dacă e gol"). Dacă trimite una care
  // nu respectă politica, primește 400 — înainte îi era înlocuită tăcut cu una generată, iar
  // el rămânea cu impresia că a setat parola pe care a scris-o.
  if (password != null && String(password).length > 0) {
    const _pol = validatePassword(password);
    if (!_pol.ok) return res.status(400).json({ error: _pol.error, message: _pol.message, ...(_pol.max ? { max: _pol.max } : {}) });
  }
  const plainPwd  = (password != null && String(password).length > 0) ? password : generatePassword();
```

### D.2 — PUT utilizator (`server/routes/admin/users.mjs`, ~560)

`old_str`
```js
  if (password && password.length >= 4) {
    updates.push(`password_hash=$${i++}`); vals.push(await hashPassword(password));
    newPlainPwd = password;
  }
```

`new_str`
```js
  // #181 — o parolă trimisă și respinsă de politică întoarce acum 400, nu 200 tăcut.
  // Înainte, o parolă sub prag nu intra în lista de updates: răspunsul era 200, iar adminul
  // credea că a schimbat-o. Câmpul gol înseamnă în continuare „nu atinge parola".
  if (password != null && String(password).length > 0) {
    const _pol = validatePassword(password);
    if (!_pol.ok) return res.status(400).json({ error: _pol.error, message: _pol.message, ...(_pol.max ? { max: _pol.max } : {}) });
    updates.push(`password_hash=$${i++}`); vals.push(await hashPassword(password));
    newPlainPwd = password;
  }
```

Adaugă importul în `server/routes/admin/users.mjs`, lângă celelalte:
```js
import { validatePassword } from '../../services/password-policy.mjs';
```

⚠️ D.2 e ÎNAINTE de `if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });`
— verifică pe fișier că ordinea rămâne așa după patch, altfel un PUT cu doar parola validă ar
putea cădea pe ramura greșită.

---

## ETAPA E — testele care fixează comportamentul

`server/tests/db/admin-users-password-policy.test.mjs` (nou), minim:

1. **Fail-closed C, cazul care era gaura:** `org_admin` cu `org_id` NULL → `reset-password` pe un
   user din orice organizație ⇒ **403 `forbidden_cross_tenant`**, și `password_hash`-ul țintei
   **nemodificat în DB** (verifică în baza de date, nu doar codul HTTP).
2. **Fail-closed C, a doua jumătate:** țintă cu `org_id` NULL, actor `org_admin` cu `org_id`
   setat ⇒ 403, hash nemodificat.
3. **Nedeteriorare C:** `org_admin` pe un user din PROPRIA organizație ⇒ 200 și hash **schimbat**.
4. **Nedeteriorare C:** `role='admin'` (platform-admin) pe user din altă organizație ⇒ 200
   (cross-org păstrat deliberat).
5. **D.2:** PUT cu parolă de 6 caractere ⇒ 400 `password_too_short` **și** hash nemodificat.
   PUT cu parolă de 10 ⇒ 200 și hash modificat. Ăsta e cazul care documentează schimbarea de
   comportament: înainte era 200 fără modificare.
6. **D.1:** creare cu parolă de 6 ⇒ 400. Creare **fără** câmpul `password` ⇒ 201/200, iar parola
   întoarsă trece `validatePassword` (adică platforma nu-și încalcă propria politică).
7. **Nedeteriorare pe `nothing_to_update`:** PUT fără niciun câmp ⇒ tot 400 `nothing_to_update`,
   nu `password_missing`.

Rulează:
```bash
npm test
npm run test:db
```

`test:db` trebuie să ruleze **COMPLET, REAL** (rețeta cu PostgreSQL 17 efemer din `CLAUDE.md`).
**Skipped ≠ passed.** Dacă nu poate rula, spune asta explicit în raport, nu o ascunde.

⚠️ Dacă pică un test PREEXISTENT, **oprește-te și raportează ÎNAINTE de a-l modifica**. Un test
care pică aici e semnal, nu obstacol. În special cele două fișiere din Etapa 0.

---

## ETAPA F — versiune, lockfile, commit

```bash
npm version 3.9.836 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
# Așteptat: modificare de versiune; dacă apare mișcare în arborele de dependențe, OPREȘTE-TE și raportează
```

⚠️ `package-lock.json` urcă în **același commit** cu `package.json` — regenerat cu
`npm install --package-lock-only`, nu editat pe două linii. Driftul a blocat CI-ul la merge-ul
lui 831 prin `needs: audit`, care oprește și suita de teste.

Verificări finale:
```bash
git status --short          # NU `git diff --stat` — nu vede fișierele netrackate
grep -rn "password.length >= 4" server --include=*.mjs
# Așteptat: 0 linii
grep -rn "new_password.length < " server/routes/auth.mjs
# Așteptat: 0 linii
```

`git add` **explicit**, pe fișiere numite. **Niciodată `git add -A`** — arborele de lucru conține
fișiere netrackate cu date personale.

Commit:
```
fix(#181): garda cross-tenant fail-closed la resetarea parolei + politica de parole pe sursa unica — v3.9.836

Resetarea parolei refuza cross-tenant doar cand putea DOVEDI ca organizatiile
difera: cu oricare org_id NULL, un org_admin reseta parola unui utilizator din
alta organizatie si primea parola noua pe email. Garda ia acum forma fail-closed
a surorii ei de la PUT /admin/users/:id (P0-02).

Politica de lungime era scrisa in trei locuri cu doua valori (10 la schimbarea
proprie, 4 la creare si la PUT). Trece intr-un modul pur, services/password-policy.mjs,
cu un test care verifica faptul ca parolele generate de platforma isi respecta
propria politica. Efect vizibil: o parola prea scurta trimisa de admin intoarce
acum 400, in loc sa fie inlocuita tacit (creare) sau ignorata tacit cu raspuns
200 (PUT).

Nu atinge tempPassword din raspuns (decizie de produs) si nu aplica
force_password_change pe server (cere masuratoare in productie intai).
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Toate ancorele din Etapa 0, cu valorile **OBȚINUTE** (nu cele așteptate de mine).
2. Conținutul final al lui `password-policy.mjs` și de ce ai ales forma aia pentru
   `password_missing` (șir gol vs. `null` — spune explicit cum le tratezi).
3. Rezultatul fiecărui caz din Etapa E, în special cazurile 1, 2 și 5.
4. Confirmare că `db/admin-users-tenant-guard.test.mjs:97` și
   `db/auth-lifecycle-hardening.test.mjs:147` au rămas verzi **nemodificate**.
5. Numerele reale `npm test` / `npm run test:db` și dacă `test:db` a rulat **COMPLET**.
6. Rezultatul verificării lockfile-ului (`git diff --stat`, numărul de linii).
7. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
8. Divergențe prompt↔cod — **raportate, NU reparate tăcut**. Dacă un `old_str` nu se potrivește
   caracter cu caracter, oprește-te.
9. Constatări colaterale — consemnate, nereparate. Mă interesează în mod special dacă găsești
   alte locuri care validează parole și pe care nu le-am enumerat eu.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero fișiere din `public/`. Zero atingeri în zona NO-TOUCH.
- `tempPassword` din răspunsul lui `reset-password` rămâne **NEATINS**.
- `force_password_change` rămâne **NEAPLICAT** pe server.
- Platform-adminul (`role === 'admin'`) rămâne cross-org peste tot — nu-l strânge „din simetrie".
- Pragurile rămân 10 / 200. Acest lot **mută** politica, nu o schimbă.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
