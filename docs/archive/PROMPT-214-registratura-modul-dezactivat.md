---
prompt: 214
titlu: "Registratură — modulul dezactivat pe organizație oprește numerotarea fluxurilor noi și închide rutele"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.866
versiune_tinta: v3.9.867
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: NU  (⇒ FĂRĂ `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU  (`flows/crud.mjs` NU e în listă; subsolul PDF folosește ramura „fără număr" care există deja)
tip: bugfix de comportament (poarta unui modul) + teste
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
`main` = producție, gestionat manual DOAR de Mircea.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL — măsurat pe producție (16.09.2026)

Primăria Zărnești are modulul **Registratură DEZACTIVAT** la nivel de organizație din 20.05.2026,
10:36 (`module_entitlements`: `scope_type='org'`, `enabled=false`). Există două override-uri
`user` cu `enabled=true`, pe cele două conturi ale lui Mircea.

Cu toate astea, **fiecare flux creat primește un număr de înregistrare**:

| Lună | Numere pe fluxuri | Înregistrări manuale |
|---|---|---|
| 2026-05 | 194 (00001–00194) | 0 |
| 2026-06 | 477 | 0 |
| 2026-07 | 697 | 0 |
| 2026-08 | 880 | 0 |
| 2026-09 | 435 (până la 02683) | 0 |

Numărul se tipărește în subsolul PDF-ului („Nr. inreg. 02683") **înainte de semnare**, deci intră în
documentul semnat QES. Registratura oficială a primăriei nu e în DocFlowAI (zero înregistrări
manuale în patru luni), deci actele semnate poartă un **al doilea număr de înregistrare, neoficial**.

## Cauza, verificată pe cod

1. **Alocarea nu verifică modulul.** `flows/crud.mjs:~421` cheamă `allocateNumber` la fiecare
   creare de flux, necondiționat.
2. **Rutele verifică modulul într-un singur loc.** Din cele 10 rute din `routes/registratura.mjs`,
   doar `GET /api/me/can-registratura` (ascunde ecranul) și `POST /api/registratura/intrari` citesc
   `isModuleEnabled`. Lista, exportul CSV, schimbarea de status, legarea răspunsului, atașamentele și
   asignatarii răspund oricui din organizație.

## Regula pe care o implementează lotul

- **Numerotarea automată a fluxurilor** se decide **la nivel de ORGANIZAȚIE**: override `org`, altfel
  `module_catalog.default_enabled`. **Override-urile `user` și `comp` NU contează aici** — altfel, în
  aceeași primărie, fluxurile lansate de Mircea ar avea număr, iar ale colegilor nu, cu goluri în
  serie.
- **Accesul la ecran și la rute** rămâne per utilizator (regula existentă `isModuleEnabled`:
  user > comp > org > catalog) — Mircea continuă să vadă registrul istoric.
- **Numerele deja alocate rămân.** Alocarea e idempotentă pe sursă; nimic din istoric nu se atinge.
- **La reactivare, seria continuă** de unde a rămas (în perioada dezactivată nu s-a consumat nimic).

---

# ETAPA 0 — ancore (READ-ONLY, raportează valorile OBȚINUTE)

```bash
git branch --show-current
# Așteptat: develop

grep -rn "allocateNumber\|_allocateRegNumber" server --include=*.mjs | grep -v tests
# Așteptat: definiția (services/registratura.mjs), crud.mjs (import + apel ~423),
#           routes/registratura.mjs (import + apel ~207, înregistrarea manuală).
# ⭐ Dacă mai există un apelant, RAPORTEAZĂ înainte de a scrie.

grep -n "isModuleEnabled" server/routes/registratura.mjs
# Așteptat: import (19) + can-registratura (~68) + POST intrari (~190).

grep -n "^router\." server/routes/registratura.mjs
# Așteptat: 10 rute. Toate cele 9 sub `/api/registratura/` încep cu aceeași triadă
# requireAuth → !actor → _db. `/api/me/can-registratura` e singura în afara prefixului.

grep -n "app.use('/', registraturaRouter)" server/index.mjs

grep -n "export async function isModuleEnabled\|async function _computeEnabled\|export function invalidate" server/services/entitlements.mjs

grep -rln "services/registratura\|services/entitlements\|api/registratura" server/tests
# Cunoscute: integration/presigned-upload (mock pe allocateNumber), db/tenant-isolation (test 6:
# GET /api/registratura/intrari ⇒ 200), db/helpers/app.mjs.
```

⭐ **Testele mock pe `POST /flows`** (`unit/flows-create`, `integration/flows`,
`integration/sec-p0-fail-closed`) folosesc `pool.query.mockResolvedValueOnce` în secvență și **nu**
mock-uiesc `services/registratura.mjs`. Azi `allocateNumber` cade acolo pe `pool.connect` (absent în
mock) și întoarce `null`. ⛔ **Consecință de design:** verificarea modulului **NU** se face cu un
`pool.query` nou în `crud.mjs` — ar consuma un răspuns din coadă și ar decala toate aserțiunile
următoare. Se face **înăuntrul** `allocateNumber`, pe clientul tranzacției pe care îl deschide deja.

```bash
grep -n "TRUNCATE_TABLES" -A25 server/tests/helpers/db-real.mjs | head -30
```
⭐ Confirmă dacă `module_entitlements`, `registru_serii`, `registru_intrari` sunt golite între teste
(direct sau prin `CASCADE` din `organizations`/`users`). Raportează dovada. Dacă **nu** sunt, testele
din Etapa D curăță explicit ce seedează — un override `org=false` rămas în bază ar întoarce 403 la
`tenant-isolation` testul 6, în altă suită, fără legătură aparentă.

---

# ETAPA A — regula la nivel de organizație, în sursa unică a entitlements

`server/services/entitlements.mjs`. Funcție nouă, lângă `isModuleEnabled`, care folosește **aceeași
ierarhie** (org > catalog), fără user/comp și **fără cache** (un apel per flux creat; zero
problemă de invalidare).

`old_str`:
```js
async function _computeEnabled(pool, { moduleKey, userId, compartiment, orgId }) {
```
`new_str`:
```js
/**
 * #214 — Rezolvă dacă un modul e activ pentru ORGANIZAȚIE, ignorând override-urile user/comp.
 * Regula: override `org` > `module_catalog.default_enabled` (doar `active=true`) > false.
 *
 * Folosire: decizii care trebuie să fie IDENTICE pentru toți utilizatorii unei organizații
 * (ex. numerotarea automată a fluxurilor în Registratură — o serie de numere nu poate avea
 * goluri după cine a lansat fluxul). Pentru acces la ecrane/rute rămâne `isModuleEnabled`.
 *
 * Acceptă un Pool SAU un client de tranzacție (orice obiect cu `.query`). NU prinde erorile —
 * apelantul decide ce înseamnă „nu știu" (la numerotare: fără număr).
 *
 * @param {{ query: Function }} db
 * @param {{ moduleKey: string, orgId: number|string }} ctx
 * @returns {Promise<boolean>}
 */
export async function isModuleEnabledForOrg(db, { moduleKey, orgId } = {}) {
  const key = String(moduleKey || '').trim();
  if (!key || orgId == null || orgId === '') return false;
  const { rows: ov } = await db.query(
    `SELECT enabled FROM module_entitlements
      WHERE module_key = $1 AND scope_type = 'org' AND scope_id = $2::text
      LIMIT 1`,
    [key, String(orgId)]
  );
  if (ov && ov.length) return !!ov[0].enabled;
  const { rows: cat } = await db.query(
    'SELECT default_enabled FROM module_catalog WHERE module_key=$1 AND active=true',
    [key]
  );
  if (!cat || !cat.length) return false;
  return !!cat[0].default_enabled;
}

async function _computeEnabled(pool, { moduleKey, userId, compartiment, orgId }) {
```

⛔ `isModuleEnabled`, `_computeEnabled`, `getAllModulesForUser`, cache-ul și `invalidate` rămân
**neatinse**.

---

# ETAPA B — `allocateNumber` poate refuza când modulul e dezactivat

`server/services/registratura.mjs`.

**B.1 — parametrul.** În docblock-ul lui `allocateNumber`, după linia `@param {number} [p.createdBy]`,
adaugă:
```js
 * @param {string} [p.doarDacaModululEActiv] — #214: cheia modulului (ex. 'registratura'). Dacă e
 *   dată, o poziție NOUĂ se alocă doar dacă modulul e activ pe ORGANIZAȚIE
 *   (`isModuleEnabledForOrg`). O poziție deja existentă pentru aceeași sursă se întoarce oricum.
```

**B.2 — importul**, după `import { logger } from '../middleware/logger.mjs';`:
```js
import { isModuleEnabledForOrg } from './entitlements.mjs';
```
⚠️ Verifică să nu existe import circular (`entitlements.mjs` importă doar `db/index.mjs` și
`logger`). Raportează.

**B.3 — verificarea, DUPĂ idempotență și ÎNAINTE de consumul din serie.** `old_str`:
```js
    // 2. Upsert seria + incrementare atomică a contorului.
```
`new_str`:
```js
    // 1b. #214 — modulul dezactivat pe organizație ⇒ NU se consumă un număr nou.
    //     Pe același client de tranzacție (fără conexiune nouă). Poziția existentă (pasul 1)
    //     a fost deja întoarsă mai sus, deci istoricul rămâne neatins. O eroare aici cade în
    //     catch-ul funcției ⇒ ROLLBACK ⇒ null ⇒ flux fără număr (fail-closed pe numerotare).
    if (p.doarDacaModululEActiv) {
      const activ = await isModuleEnabledForOrg(client, {
        moduleKey: String(p.doarDacaModululEActiv), orgId,
      });
      if (!activ) {
        await client.query('COMMIT');
        return null;
      }
    }

    // 2. Upsert seria + incrementare atomică a contorului.
```

⛔ Restul funcției — seria, `ON CONFLICT`, revert-ul de contor, formatul — **neatins**.
⛔ Fără parametrul nou, comportamentul e **bit-identic** cu cel de azi (înregistrarea manuală din
`POST /api/registratura/intrari` nu îl trimite și nu trebuie să îl trimită: are propria poartă, per
utilizator).

---

# ETAPA C — cele două apelante

**C.1 — `server/routes/flows/crud.mjs`**, crearea fluxului. `old_str`:
```js
      _reg = await _allocateRegNumber({
        orgId,
        sursaId: flowId,
        sursaTip: 'flow',
        flowId,
```
`new_str`:
```js
      _reg = await _allocateRegNumber({
        orgId,
        sursaId: flowId,
        sursaTip: 'flow',
        flowId,
        // #214: numerotarea automată respectă modulul Registratură, la nivel de ORGANIZAȚIE.
        // Dezactivat ⇒ _reg = null ⇒ subsolul PDF fără „Nr. inreg." (ramura existentă).
        doarDacaModululEActiv: 'registratura',
```

⛔ Nimic altceva din `crud.mjs`. `nrInregistrare: _reg ? … : null` și
`nrInregistrareFormat: _reg ? … : null` gestionează deja `null`.

**C.2 — `server/routes/registratura.mjs`**, poarta pe toate rutele de sub `/api/registratura/`.

După `const _csrf = csrfMiddleware;`, adaugă:

```js

// #214 — poarta modulului, O SINGURĂ DATĂ pentru tot prefixul /api/registratura/.
// Înainte, doar POST /intrari verifica modulul; lista, exportul, statusul, legarea,
// atașamentele și asignatarii răspundeau oricui din organizație. Regula e cea per
// utilizator (isModuleEnabled: user > comp > org > catalog) — accesul la ecran, nu
// numerotarea (aceea e per organizație, în allocateNumber). `/api/me/can-registratura`
// e în afara prefixului și rămâne liberă: ea e cea care îi spune interfeței să ascundă ecranul.
router.use('/api/registratura', async (req, res, next) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  try {
    const can = await isModuleEnabled(pool, {
      moduleKey: 'registratura', userId: actor.id || actor.userId, orgId: actor.orgId,
    });
    if (!can) return res.status(403).json({ error: 'module_disabled' });
    return next();
  } catch (e) {
    logger.warn({ err: e }, 'registratura: verificarea modulului a eșuat');
    return res.status(503).json({ error: 'entitlements_unavailable' });
  }
});
```

Apoi scoate verificarea inline, acum dublată, din `POST /api/registratura/intrari`. `old_str`:
```js
    const can = await isModuleEnabled(pool, {
      moduleKey: 'registratura', userId: actor.id || actor.userId, orgId: actor.orgId,
    });
    if (!can) return res.status(403).json({ error: 'module_disabled' });

    const b = req.body || {};
```
`new_str`:
```js
    // #214: poarta modulului e acum pe tot prefixul (router.use de mai sus).
    const b = req.body || {};
```

⚠️ Același bloc `const can = await isModuleEnabled(pool, {` apare și în `can-registratura`, dar cu
`userId: actor.id || actor.userId,` pe o linie separată — `old_str`-ul de mai sus include `const b =
req.body` ca să fie unic. Dacă nu se potrivește exact o dată, **oprește-te**.

⚠️ Verifică ordinea: `router.use` trebuie să fie **înaintea** definițiilor rutelor din fișier ca să
ruleze primul. Verifică și că middleware-ul nu interceptează `GET /api/me/can-registratura`
(prefix diferit). Raportează.

⛔ Handlerele păstrează `requireAuth` propriu (dublă decodare, inofensivă). Nu le rescrie.

---

# ⭐ ETAPA D — teste

## D.1 — `server/tests/db/registratura-modul-dezactivat.test.mjs` (nou)

Seed: organizație + utilizator, apoi `invalidateAll()` din `services/entitlements.mjs` în
`beforeEach` (cache-ul de 60s trăiește în proces între teste). Override-urile se inserează direct
în `module_entitlements` (`set_by` e NOT NULL ⇒ un user existent). Curăță explicit ce seedezi dacă
Etapa 0 arată că tabelele nu sunt golite.

**`isModuleEnabledForOrg`**
1. Fără override ⇒ `default_enabled` din catalog (pentru `registratura`: `true`).
2. Override `org=false` ⇒ `false`.
3. ⭐ Override `org=false` + override `user=true` pe un user al organizației ⇒ **`false`** (user nu contează).
4. Override `org=true` ⇒ `true`.
5. Modul inexistent în catalog ⇒ `false`.

**`allocateNumber`**
6. ⭐ `doarDacaModululEActiv: 'registratura'`, org dezactivat ⇒ `null`; **zero** rânduri noi în
   `registru_intrari`; `registru_serii.contor` **neschimbat** (sau rândul seriei inexistent).
7. Același apel, org activ (fără override) ⇒ număr alocat, contor +1.
8. ⭐ Poziție deja existentă pentru sursă (alocată când modulul era activ), apoi org dezactivat,
   același `sursaId` ⇒ se întoarce **poziția existentă** (idempotența primează).
9. ⭐ Neregresie înregistrare manuală: **fără** parametru, org dezactivat ⇒ număr alocat.
10. Apoi reactivare (override șters sau `org=true`) ⇒ următoarea alocare continuă seria de unde
    rămăsese înainte de dezactivare (fără salt, fără reluare de la 1).

**Crearea fluxului, cap-coadă** (modelează `POST /flows` după `db/flow-link-audit.test.mjs`)
11. ⭐⭐ Org dezactivat ⇒ 200; `flows.data->>'nrInregistrare'` **NULL**; zero rânduri în
    `registru_intrari` cu `flow_id` = noul flux.
12. ⭐ Org dezactivat + override `user=true` pe inițiator ⇒ **tot fără număr** (regula e pe org).
13. Neregresie: fără override ⇒ `nrInregistrare` setat și rândul în registru există.

**Poarta pe rute**
14. ⭐ Org dezactivat, user fără override ⇒ **403 `module_disabled`** pe: `GET /intrari`,
    `GET /export.csv`, `POST /intrari/:id/status`, `POST /intrari/:id/leaga-raspuns`,
    `POST /intrari/:id/atasament`, `GET /intrari/:id/atasamente`, `GET /atasament/:attId`,
    `GET /asignatari`, `POST /intrari` (parametrizat; cele POST cu CSRF valid, ca 403-ul să fie al
    modulului, nu al CSRF — verifică `error` în corp).
15. Org dezactivat + `user=true` ⇒ `GET /intrari` 200 (accesul rămâne per utilizator).
16. `GET /api/me/can-registratura` ⇒ 200 cu `{ can:false }` pentru user fără override (neinterceptat).
17. Neregresie: fără override ⇒ `GET /intrari` 200.

## D.2 — rulare pe codul NEREPARAT

Scrie testele, rulează **doar fișierul nou** pe codul actual:
```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/registratura-modul-dezactivat.test.mjs
```
⭐ Raportează lista roșiilor **ÎNAINTE** de patch. Așteptat roșii: 1–5 (funcția nu există), 6, 8,
10 (parametrul nu există ⇒ alocă), 11, 12, 14 (parțial — `POST /intrari` e deja verde), 15/16 pot fi
verzi. Un test de regresie care n-a fost niciodată roșu nu dovedește nimic.

## D.3 — suitele

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`. `npm test` verde, fără regresii.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Candidați:
`db/tenant-isolation` testul 6 (dacă un override rămâne în bază) și testele mock pe `POST /flows`
(dacă verificarea s-a strecurat pe `pool.query` în loc de clientul din `allocateNumber`). În ambele
cazuri, **repară patch-ul sau curățenia testului nou, nu testul vechi**.

---

# ETAPA E — versiune și commit

```bash
npm version 3.9.867 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json   # ≤ 4 linii
git status --short
```

**Zero fișiere din `public/`** ⇒ `?v=` și `CACHE_VERSION` neatinse. Verifică.

`git add` **explicit**, fișier cu fișier. Arhivează promptul ca
`docs/archive/PROMPT-214-registratura-modul-dezactivat.md`, în același commit. Dacă
`docs/archive/sql/SQL-214-2fa-si-registratura.sql` există netrackat, adaugă-l.

```
fix(#214): Registratura dezactivata nu mai numeroteaza fluxurile noi si nu mai raspunde pe rute — v3.9.867

Primaria Zarnesti are modulul Registratura dezactivat pe organizatie din
20.05.2026, dar fiecare flux creat primea un numar de inregistrare (2683 pana
la 16.09), tiparit in subsolul PDF inainte de semnare. Registratura oficiala
nu e in DocFlowAI (zero inregistrari manuale), deci actele semnate purtau un
al doilea numar, neoficial.

Cauza: allocateNumber era chemat necondiționat la crearea fluxului, iar din
cele 10 rute ale modulului doar doua verificau entitlement-ul.

- entitlements: isModuleEnabledForOrg (override org > catalog), fara user/comp
- allocateNumber: parametrul doarDacaModululEActiv, verificat pe clientul
  tranzactiei, dupa idempotenta si inainte de consumul din serie
- crud.mjs: crearea fluxului trimite parametrul; subsolul fara numar foloseste
  ramura existenta
- routes/registratura: poarta pe tot prefixul /api/registratura/, verificarea
  inline duplicata din POST /intrari scoasa

Numerotarea se decide pe ORGANIZATIE (o serie nu are goluri dupa cine a lansat
fluxul); accesul la ecran ramane per utilizator. Numerele deja alocate raman.
Inregistrarea manuala nu e afectata. Teste scrise intai, rulate rosii pe codul
nereparat.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE** — în special apelanții `allocateNumber` și ce
   golește `truncateAll`.
2. ⭐ Lista testelor roșii pe codul nereparat (D.2).
3. Confirmarea că verificarea modulului **nu** face niciun `pool.query` nou pe calea `POST /flows`
   (doar pe `client` din `allocateNumber`) — cum ai verificat.
4. ⭐ Confirmarea că `router.use` rulează înaintea rutelor și nu interceptează `can-registratura`.
5. Rezultatul fiecărui test nou, **în special 3, 6, 8, 9, 11, 12, 14**.
6. Teste preexistente atinse (așteptat: niciunul), cu diff și motiv.
7. Numere reale `npm test` și `npm run test:db`, secvențial, cu sursa verdictului declarată.
8. `git diff` scurt pe fiecare fișier; `public/` gol.
9. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
10. Colaterale observate, **nereparate**. Cunoscute, de confirmat sau infirmat:
    - linkul „Registratură" din bara laterală (`df-shell.js:~110`) e injectat pentru toată lumea,
      indiferent de modul;
    - reinițierea (`flows/lifecycle.mjs:~124`) copiază prin `...data` `nrInregistrare` din fluxul
      părinte, dar re-ștampilează subsolul **fără** număr și nu alocă o poziție nouă — fluxul nou
      poartă în date numărul părintelui, iar registrul arată spre fluxul vechi.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy. `git push origin develop`, apoi **stop**.
- **Zero migrații, zero scrieri de date, zero fișiere din `public/`.**
- Numerotarea automată: regula pe **organizație** (org > catalog). Accesul la rute: regula per
  **utilizator**, neschimbată.
- ⛔ Niciun `pool.query` nou pe calea de creare a fluxului în `crud.mjs`.
- ⛔ `isModuleEnabled`, cache-ul și `invalidate` — neatinse.
- ⛔ Numerele deja alocate, `registru_serii`, `registru_intrari` — neatinse. Nicio reparație de date.
- ⛔ `stampFooterOnPdf`, reinițierea, subsolul, zona STS/PAdES — neatinse.
- ⛔ Înregistrarea manuală (`POST /intrari`) nu primește parametrul nou.
- Testele se scriu și se rulează **înainte** de patch-uri; lista roșiilor se raportează.
- `git add` explicit. Niciodată `git add -A` / `git add .`.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
