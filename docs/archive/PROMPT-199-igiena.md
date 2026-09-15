---
prompt: 199
titlu: "Igienă: migrația forțată la fiecare boot, cinci limitatoare moarte, poarta #182 ocolită pe WebSocket"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.851
versiune_tinta: v3.9.852
migratii: NU
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul

Trei lucruri independente, fiecare mic. **Fă-le în ordine, ca etape separate** — dacă una
trebuie revenită după deploy, vrem să știm care.

Etapa C e singura cu efect vizibil pentru un utilizator.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                       # Așteptat: 3.9.851
grep -rn "DELETE FROM schema_migrations" scripts/ server/ --include=*.mjs
grep -rn "_uploadRateLimit" server/ --include=*.mjs | grep -v tests
grep -n "SELECT id, email, role, org_id, token_version" server/ws/auth.mjs
grep -rn "force_password_change" server/ws/ server/middleware/session-guard.mjs
ls server/tests/db/ | grep -i "force-password\|ws-auth\|rate"
```

⭐ A treia comandă trebuie să arate **șase definiții** și **o singură montare**
(`signing.mjs:95`). Dacă apare vreo a doua montare, **oprește-te și raportează** — premisa
Etapei B cade.

---

## ETAPA A — migrația care se re-execută la fiecare pornire

`scripts/migrate.mjs`, în `runMigrationsLocked`:

```js
  // Force re-run 014_alop — migration rescrisă cu ALTER TABLE idempotent
  await pool.query(
    "DELETE FROM schema_migrations WHERE id='014_alop'"
  ).catch(() => {});
```

A fost o măsură **de o singură dată**, când migrația a fost rescrisă idempotentă. A rămas
în cod și rulează la **fiecare** pornire a aplicației în producție: șterge marcajul și
re-aplică `014_alop.sql`. Costul e mic, dar e o migrație care rulează necontrolat la fiecare
deploy și la fiecare restart de container — inclusiv `ALTER TABLE` pe tabele cu date reale.
Ziua în care cineva editează `014_alop.sql` și introduce fără să vrea ceva neidempotent,
pornirea se rupe în producție, nu într-un test.

**Șterge blocul**, cu un comentariu de o linie în loc: re-rularea forțată a fost o măsură
unică, consumată; migrația e aplicată peste tot.

⚠️ Verifică înainte că `014_alop` **există** azi în `schema_migrations` după o pornire
normală (e reinserată de fiecare re-rulare). Dacă nu, spune-mi înainte de a șterge.

⛔ Nu atinge `014_alop.sql`. Nu atinge restul lui `runMigrationsLocked`, lock-ul consultativ,
sau ordinea de aplicare.

---

## ETAPA B — cinci limitatoare care nu limitează nimic

`_uploadRateLimit` e definit **identic** în șase fișiere:

| Fișier | Montat? |
|---|---|
| `server/routes/flows/signing.mjs:23` | **DA** — `router.use('/flows/:flowId/upload-signed-pdf', …)` la :95 |
| `server/routes/flows/email.mjs:18` | nu |
| `server/routes/flows/attachments.mjs:18` | nu |
| `server/routes/flows/crud.mjs:32` | nu |
| `server/routes/flows/acroform.mjs:16` | nu |
| `server/routes/flows/lifecycle.mjs:23` | nu |

Fiecare `createRateLimiter` își creează propriul `Map` și se înregistrează în `_allStores`,
măturat la 5 minute. Deci cele cinci nu fac rău — fac ceva mai rău: **mint**. Cine deschide
`attachments.mjs` vede un rate limiter definit acolo și presupune că upload-urile de
atașamente sunt protejate. Nu sunt.

**Șterge cele cinci definiții nefolosite**, plus importul `createRateLimiter` din fișierele
unde rămâne neutilizat. `signing.mjs` rămâne neatins.

⛔ **NU monta limitatoare noi.** Dacă rutele de upload din celelalte fișiere ar trebui
protejate, aia e o schimbare de comportament în producție și o decide Mircea, nu lotul ăsta.

⭐ În raport, listează **rutele de upload care rămân fără niciun rate limiter**, ca să existe
decizia informată. Asta e livrabilul cel mai valoros al etapei.

---

## ETAPA C — poarta #182 e ocolită pe WebSocket

`server/ws/auth.mjs` citește din `users`:

```sql
SELECT id, email, role, org_id, token_version
```

Nu citește `force_password_change`. `sessionGuard` (`middleware/session-guard.mjs:177`) îl
verifică și răspunde **403 `password_change_required`** pe rutele guarded — dar conexiunea
WebSocket nu trece prin el. Un cont cu steagul activ e blocat pe HTTP și **primește totuși**
chat, prezență și notificări în timp real.

Poarta #182 spune „nimic până nu schimbi parola". Trebuie să însemne același lucru pe ambele căi.

- Adaugă `force_password_change` în `SELECT`.
- Respinge conexiunea când e `true`, pe aceeași cale prin care se respinge azi o sesiune
  revocată (G1b, `token_version` nepotrivit) — **reutilizează tiparul existent, nu inventa
  altul**. Dacă funcția întoarce `null` la respingere, întoarce `null`.
- Loghează motivul distinct de revocarea de sesiune; altfel diagnosticul viitor confundă
  două cauze diferite.

⚠️ Utilizatorul trebuie să poată totuși **schimba parola**: `/auth/change-password` e HTTP și
nu e sub `GUARDED_PREFIXES`, deci nu e afectat. Confirmă asta explicit în raport — dacă
închiderea WS ar bloca și calea de ieșire, am crea o capcană.

---

## ETAPA D — teste

Pentru fiecare etapă, ce se poate testa:

**A.** Un test pe sursă: `scripts/migrate.mjs` nu mai conține
`DELETE FROM schema_migrations`. Simplu, dar apără împotriva reintroducerii.

**B.** Un test pe sursă: `_uploadRateLimit` apare **exact** o dată în `server/routes/flows/`,
în fișierul în care e și montat. Construiește-l ca număr, nu ca listă de fișiere, ca să prindă
și adăugarea unei a șaptea copii.

**C.** ⭐⭐ Teste DB, în `server/tests/db/`:
1. Utilizator cu `force_password_change = true` ⇒ autentificarea WS **eșuează**.
   ⇒ Trebuie să **pice** pe codul actual. Pune mesajul de eșec în raport.
2. Anti-regresie: utilizator normal, token valid ⇒ autentificarea WS **reușește**.
3. Anti-regresie: `token_version` nepotrivit ⇒ eșuează în continuare (G1b neatins).
4. Steagul e `false` explicit ⇒ reușește. (Apără contra unei comparații greșite pe `NULL`.)

Dacă există deja un fișier de teste pentru `ws/auth.mjs`, extinde-l; altfel creează unul nou.

```bash
npm test
npm run test:db
```

⚠️ **O singură rulare `test:db` pe instanță**, bază proaspătă, rezultat citit **din log**,
numărul de fișiere confruntat cu discul. Așteptat: **137 + fișierele noi**.
⚠️ `npm test` și `test:db` **secvențial**.
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica.

---

## ETAPA E — versiune, commit

```bash
npm version 3.9.852 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
git status --short
```
⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=`.
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**

```
chore(#199): igiena — migratie la boot, limitatoare moarte, poarta #182 pe WS — v3.9.852

A. scripts/migrate.mjs stergea marcajul lui 014_alop la FIECARE pornire si
   re-aplica migratia — masura de o singura data, ramasa in cod. In productie
   insemna un ALTER TABLE necontrolat la fiecare deploy si la fiecare restart
   de container. Blocul dispare.

B. _uploadRateLimit era definit identic in sase fisiere, dar montat intr-unul
   singur (signing.mjs). Celelalte cinci nu faceau rau — induceau in eroare:
   cine deschidea attachments.mjs presupunea ca upload-urile sunt limitate.
   Nu erau. Cele cinci definitii nefolosite dispar; nu se monteaza nimic nou,
   iar rutele ramase fara limitator sunt listate in raport pentru decizie.

C. ws/auth.mjs nu citea force_password_change. sessionGuard raspunde 403
   password_change_required pe HTTP, dar conexiunea WebSocket nu trece prin el:
   un cont cu steagul activ primea in continuare chat, prezenta si notificari.
   Poarta #182 inseamna acum acelasi lucru pe ambele cai. /auth/change-password
   ramane accesibil — calea de iesire nu se inchide.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0. ⭐ Confirmarea „șase definiții, o singură montare".
2. Etapa A: confirmarea că `014_alop` e prezentă în `schema_migrations` înainte de ștergere.
3. ⭐ Etapa B: **lista rutelor de upload rămase fără rate limiter**, pe fișier și metodă.
4. ⭐⭐ Etapa C: dovada că testul 1 pica pe codul vechi, cu mesajul de eșec. Plus confirmarea
   explicită că `/auth/change-password` rămâne accesibil unui cont cu steagul activ.
5. Rezultatul fiecărui test din Etapa D.
6. Numere reale `npm test` / `test:db`, secvențial, bază proaspătă, citite din log, cu
   numărul de fișiere confruntat cu discul.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații noi. Zero scrieri în baza de date.
- ⛔ `014_alop.sql` — **neatins**. Lock-ul consultativ și ordinea migrațiilor — neatinse.
- ⛔ **Nu monta rate limitatoare noi.** Doar ștergerea celor moarte.
- ⛔ `signing.mjs` — neatins.
- ⛔ În Etapa C, reutilizează tiparul de respingere existent (G1b). Nu schimba forma
  returnată de funcția de autentificare WS.
- ⛔ Testul 1 din Etapa C trebuie să pice pe codul vechi. Fără dovada asta, etapa nu e completă.
- **O singură rulare `test:db` pe instanță**, rezultat citit din log.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
