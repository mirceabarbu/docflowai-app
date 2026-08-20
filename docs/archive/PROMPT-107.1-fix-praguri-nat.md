---
prompt_id: 107.1
titlu: Corectare praguri rate limit — plafon pe INSTITUȚIE (NAT), nu pe utilizator
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.713
migratii: NU
cache_version_bump: NU
v_param_bump: NU
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: b2d456a (sau descendent) — #107
git status --porcelain      # fișierele .md din docs/archive/ pot rămâne netracked, nu le atinge
```

---

# CONTEXT — ce am greșit în #107

Pragurile din #107 au fost dimensionate **per utilizator**. Sunt greșite, pentru că `createRateLimiter` cheiază pe `ip:req.path`:

- opțiunea `keyBy:'ip+user'` citește DOAR headerul `Authorization: Bearer`, iar DocFlowAI folosește cookie `auth_token` ⇒ cade tăcut pe **IP-only**;
- utilizatorii unei primării ies în internet prin **un singur IP public** (NAT de birou).

Consecință în producție: `max: 5` pe `POST /flows` ar fi însemnat **cinci fluxuri pe minut pentru toată instituția** (47 de utilizatori la Primăria Zărnești). Primul om care încarcă trei documente i-ar bloca pe ceilalți.

Simptomul l-a prins CI-ul: `server/tests/db/flow-intocmit-lock.test.mjs:162` face 7 × `POST /flows` și primește 429 în loc de 400.

**Protecția reală a memoriei rămâne semaforul LibreOffice (`max=2`), care NU se schimbă în acest prompt.** Rate limitul e doar plasa grosieră contra buclelor accidentale.

---

# Pas 1 — `server/routes/flows/crud.mjs`: limiter dedicat pentru creare flux

`_uploadRateLimit` (max 5) e dimensionat pentru upload-uri de atașamente, nu pentru creare de flux. Nu-l redimensiona — declară unul dedicat, ca să nu schimbi semantica unei constante care poartă alt nume.

Adaugă lângă celelalte limitere din capul fișierului (~linia 31):

`old_str`
```js
const _readRateLimit   = createRateLimiter({ windowMs: 60_000, max: 60, message: 'Prea multe cereri. Încearcă în 1 minut.' });
```

`new_str`
```js
const _readRateLimit   = createRateLimiter({ windowMs: 60_000, max: 60, message: 'Prea multe cereri. Încearcă în 1 minut.' });
// #107.1 — plafon pe INSTITUȚIE, nu pe utilizator: limiterul cheiază pe `ip:path`,
// iar toți utilizatorii unei primării ies prin același IP public (NAT). 30/min
// acoperă lejer o zi de vârf pentru zeci de oameni, dar taie buclele accidentale.
// Protecția reală a memoriei e semaforul LibreOffice (max=2), nu acest plafon.
const _flowCreateRateLimit = createRateLimiter({ windowMs: 60_000, max: 30, message: 'Prea multe fluxuri create. Încearcă în 1 minut.' });
```

Apoi schimbă montarea făcută în #107:

`old_str`
```js
router.post('/flows', _uploadRateLimit, _largePdf, createFlow);
router.post('/api/flows', _uploadRateLimit, _largePdf, createFlow);
```

`new_str`
```js
router.post('/flows', _flowCreateRateLimit, _largePdf, createFlow);
router.post('/api/flows', _flowCreateRateLimit, _largePdf, createFlow);
```

---

# Pas 2 — `server/routes/convert.mjs`: 5 → 20

`old_str`
```js
const _convertRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Prea multe conversii. Încearcă în 1 minut.',
});
```

`new_str`
```js
// #107.1 — plafon pe INSTITUȚIE (NAT), nu pe utilizator. Frontendul apelează
// această rută înaintea FIECĂREI creări de flux cu document Office, deci
// pragul trebuie să acopere mai mulți oameni care lucrează simultan.
const _convertRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Prea multe conversii. Încearcă în 1 minut.',
});
```

Cele două limitere de generare PDF (`_genPdfRateLimit`, `_genFormRateLimit`, ambele 20/min) rămân **neschimbate**.

---

# Pas 3 — verifică dacă mai e nevoie de mock-uri în teste

Cu pragul la 30, fișierele care fac cele mai multe `POST /flows` sunt sub limită:

| Fișier | POST /flows |
|---|---|
| `server/tests/unit/flows-create.test.mjs` | 15 (avea DEJA `vi.mock` din trecut — nu-l atinge) |
| `server/tests/integration/flows.test.mjs` | 13 |
| `server/tests/integration/sec-p0-fail-closed.test.mjs` | 7 |
| `server/tests/db/flow-intocmit-lock.test.mjs` | 7 ← cel care a picat |

**NU adăuga niciun mock nou.** `flow-intocmit-lock.test.mjs` trebuie să treacă acum de la sine — asta e și dovada că pragul e dimensionat realist.

Mock-urile pe care le-ai adăugat în #107 în `flows.test.mjs` și `sec-p0-fail-closed.test.mjs`: **lasă-le pe loc**. Sunt inofensive, respectă convenția preexistentă din `flows-create.test.mjs` și izolează suitele alea de un comportament pe care oricum nu-l testează.

---

# Pas 4 — verificări

```bash
grep -n "max: 30\|max: 20\|max: 5," server/routes/flows/crud.mjs server/routes/convert.mjs
# Așteptat: crud.mjs are max:30 pe _flowCreateRateLimit ȘI max:5 pe _uploadRateLimit (neschimbat, nemontat)
#           convert.mjs are max:20

grep -n "_uploadRateLimit" server/routes/flows/crud.mjs
# Așteptat: DOAR declarația (linia ~30). Zero montări pe router.post.

grep -rn "vi.mock.*rateLimiter" server/tests/db/
# Așteptat: NICIUN rezultat — suita DB nu mock-uiește limiterul

node --check server/routes/flows/crud.mjs
node --check server/routes/convert.mjs
# Așteptat: fără output
```

**Poarta obligatorie — rulează suita DB LOCAL, nu te baza pe CI:**

```bash
npm run test:db
# Așteptat: PASSED, nu SKIPPED.
# Dacă apare „skipped", pornește Postgres local (PG 17 e disponibil) și reia.
# ⛔ NU raporta „nu blochează" pe baza unui skip — #107 a ajuns roșu în CI exact așa.

npx vitest run --config vitest.config.db.mjs server/tests/db/flow-intocmit-lock.test.mjs
# Așteptat: verde, inclusiv cazul de la linia 162 (400, nu 429)

npm test
# Așteptat: verde, fără regresii
```

Bump + commit:

```bash
npm version 3.9.713 --no-git-tag-version
git diff --name-only | grep '^public/' || echo "OK — niciun fișier frontend atins"
git add -A
git commit -m "fix(sec): praguri rate limit dimensionate pe instituție/NAT (#107.1, v3.9.713)"
git push origin develop
```

---

# RAPORT FINAL

1. Diff pe fiecare fișier atins.
2. **Rezultatul `npm run test:db` — PASSED sau SKIPPED?** Dacă e skipped, spune-o din primul rând și nu declara promptul terminat.
3. Confirmarea explicită că `flow-intocmit-lock.test.mjs:162` trece FĂRĂ mock adăugat.
4. `grep` care arată că `_uploadRateLimit` a rămas doar declarat, nemontat.
5. `npm test` — passed/failed.
6. Commit hash + confirmare că e pe `develop`.
7. Orice abatere, cu motivul.

---

# ⛔ CONSTRÂNGERI

- ⛔ **Nu atinge semaforul.** `concurrency-gate.mjs`, `convertToPdf.mjs` și mapările 503 din `convert.mjs`/`crud.mjs` rămân exact cum au aterizat în #107. Acest prompt schimbă DOAR numere de prag.
- ⛔ **Nu modifica `server/middleware/rateLimiter.mjs`.**
- ⛔ **Nu adăuga mock-uri noi de rate limiter** în niciun fișier de test. Dacă un test tot pică pe 429 după această schimbare, **OPREȘTE-TE și raportează** — înseamnă că pragul e încă greșit, iar decizia e a lui Mircea, nu a testului.
- ⛔ Zero atingeri în `server/signing/`.
- ⛔ Fără migrații, fără `CACHE_VERSION`, fără `?v=`.
