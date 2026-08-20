---
prompt_id: 107
titlu: Semafor concurență LibreOffice + rate limit pe rutele de conversie
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.712
migratii: NU
cache_version_bump: NU (nimic din PRECACHE_ASSETS nu se atinge)
v_param_bump: NU (zero fișiere frontend modificate)
---

# ⚠️ BRANCH: develop

**Lucrezi EXCLUSIV pe `develop`.** Nu propune și nu executa `checkout main`, `merge main`, `push origin main`.
`main` = producție și e gestionat MANUAL de Mircea, după backup.

Verifică înainte de orice:

```bash
git branch --show-current
# Așteptat: develop
git status --porcelain
# Așteptat: gol (working tree curat)
```

---

# CONTEXT — de ce facem asta

`server/utils/convertToPdf.mjs:109` lansează `execFile('libreoffice', …)` **fără nicio limită de concurență**.
Are exact **doi** apelanți:

1. `server/routes/convert.mjs:33` — `POST /api/convert-to-pdf`, autentificat dar **fără rate limit**, `fileSize: 50MB`
2. `server/routes/flows/crud.mjs:311` — în `createFlow`, deci pe `POST /flows` și `POST /api/flows`, **fără rate limit** (are doar `_largePdf` = limită de body)

Fiecare proces LibreOffice consumă câteva sute de MB RSS. N conversii simultane pe containerul Railway ⇒ OOM ⇒ **moare tot procesul Node**, nu doar requestul. Nu e nevoie de rea intenție: cinci oameni care încarcă simultan documente Word mari produc același efect.

**Observație verificată:** `_uploadRateLimit` e DECLARAT în `crud.mjs:30` dar nu e montat pe nicio rută din fișier. Îl vom folosi.

**Observație verificată (nu extinde scopul):** `POST /api/formulare/generate` și `POST /api/formulare-oficiale/:id/generate-pdf` **NU** apelează LibreOffice — generează PDF in-process (pdf-lib). Nu primesc semafor. Primesc doar rate limit, ca al doilea strat.

---

# PRINCIPIU DE IZOLARE (obligatoriu)

Promptul are DOUĂ etape care se validează separat:

- **ETAPA A** = modul nou, pur, cu testele lui. Zero call-site atins. La finalul etapei A, `npm test` trebuie să fie verde FĂRĂ ca vreun comportament de producție să se fi schimbat.
- **ETAPA B** = cablarea consumatorilor.

Dacă apare o regresie, trebuie să putem reverti B fără A. **Nu amesteca cele două etape într-un singur commit intermediar** — un singur commit final e ok, dar rulează verificarea de la finalul Etapei A înainte să începi B.

---

# ETAPA A — modulul semafor (pur, testabil fără LibreOffice)

## Pas A1 — creează `server/utils/concurrency-gate.mjs`

Fișier NOU. Modul generic, fără nicio dependență de LibreOffice — de asta poate fi testat cu funcții false.

```js
/**
 * DocFlowAI — Semafor de concurență cu coadă mărginită (#107)
 *
 * Protejează resurse care lansează subprocese scumpe (LibreOffice) de la a fi
 * pornite în paralel nelimitat. Trei praguri:
 *   max            — câte task-uri rulează simultan
 *   maxQueue       — câte așteaptă; peste asta se refuză IMEDIAT (fail fast)
 *   queueTimeoutMs — cât așteaptă un task în coadă înainte să renunțe
 *
 * Erorile poartă `err.code` ca să poată fi mapate la HTTP de către apelant:
 *   GATE_BUSY    — coada e plină
 *   GATE_TIMEOUT — a expirat așteptarea în coadă
 *
 * În memorie, per proces — ca middleware/rateLimiter.mjs. Nu supraviețuiește
 * restartului Railway și nu e partajat între instanțe. Acceptat: o singură
 * instanță în producție azi, iar scopul e protecția memoriei procesului.
 */
export function createConcurrencyGate({
  max = 2,
  maxQueue = 8,
  queueTimeoutMs = 45_000,
  name = 'gate',
} = {}) {
  let active = 0;
  const queue = []; // { resolve, reject, timer, settled }

  function _next() {
    while (queue.length) {
      const w = queue.shift();
      if (w.settled) continue;      // expirat între timp — sari peste, NU pierde slotul
      w.settled = true;
      clearTimeout(w.timer);
      w.resolve();
      return;                        // slotul rămâne ocupat, doar și-a schimbat proprietarul
    }
    active--;                        // nimeni în coadă — eliberează efectiv
  }

  async function _acquire() {
    if (active < max) { active++; return; }
    if (queue.length >= maxQueue) {
      const e = new Error(`${name}: coadă plină (${maxQueue})`);
      e.code = 'GATE_BUSY';
      throw e;
    }
    await new Promise((resolve, reject) => {
      const w = { resolve, reject, settled: false, timer: null };
      w.timer = setTimeout(() => {
        if (w.settled) return;
        w.settled = true;
        const e = new Error(`${name}: timeout în coadă (${queueTimeoutMs}ms)`);
        e.code = 'GATE_TIMEOUT';
        reject(e);
      }, queueTimeoutMs);
      if (typeof w.timer.unref === 'function') w.timer.unref();
      queue.push(w);
    });
  }

  return {
    /**
     * Rulează fn() cu slot rezervat. Slotul se eliberează ÎNTOTDEAUNA,
     * inclusiv dacă fn aruncă.
     */
    async run(fn) {
      await _acquire();
      try { return await fn(); }
      finally { _next(); }
    },
    stats() { return { active, queued: queue.length, max, maxQueue }; },
  };
}
```

⚠️ Punctul critic al implementării e `_next()`: când un task termină și există un waiter valid, slotul **se transferă** (nu se decrementează `active`). Dacă decrementezi și apoi incrementezi, apare o fereastră în care un al treilea apel poate să se strecoare peste `max`. Nu modifica logica asta.

## Pas A2 — creează `server/tests/unit/concurrency-gate.test.mjs`

Fișier NOU. Testul **importă din producție**, nu redeclară logica (regula din CLAUDE.md).

Acoperă exact aceste cazuri:

1. `max=2`: cu 5 task-uri lansate simultan, concurența observată nu depășește niciodată 2 (măsurată cu un contor incrementat/decrementat în interiorul task-ului fals).
2. Toate cele 5 se termină și întorc valorile corecte, în ciuda serializării.
3. `max=1, maxQueue=1`: al treilea apel simultan respinge cu `err.code === 'GATE_BUSY'` — **imediat**, fără să aștepte.
4. `max=1, maxQueue=5, queueTimeoutMs=30`: un waiter care așteaptă după un task lent (~200ms) respinge cu `err.code === 'GATE_TIMEOUT'`.
5. **Un task care aruncă eliberează slotul** — după o eroare, un apel următor rulează normal (`stats().active === 0` la final).
6. După timeout, dacă slotul se eliberează, el NU se pierde: un apel ulterior obține slot (asta validează bucla `while` cu `settled` din `_next`).

Folosește fake timers doar dacă îți e mai simplu; cu durate de 30–200 ms testul rulează oricum în sub o secundă. Nu introduce `sleep` mai lungi de 300 ms.

## Pas A3 — poarta Etapei A

```bash
npx vitest run server/tests/unit/concurrency-gate.test.mjs
# Așteptat: toate testele noi verzi

npm test
# Așteptat: verde, fără regresii (numărul de teste a crescut doar cu cele noi)

git diff --stat
# Așteptat: EXACT 2 fișiere noi, zero modificări în server/routes/ sau server/utils/convertToPdf.mjs
```

**Nu trece la Etapa B dacă `git diff --stat` arată vreun fișier modificat (nu doar adăugat).**

---

# ETAPA B — cablarea consumatorilor

## Pas B1 — `server/utils/convertToPdf.mjs`: semafor DOAR pe apelul LibreOffice

Import, imediat după linia 8 (`import crypto from 'crypto';`):

`old_str`
```js
import crypto from 'crypto';

const exec = promisify(execFile);
```

`new_str`
```js
import crypto from 'crypto';
import { createConcurrencyGate } from './concurrency-gate.mjs';

const exec = promisify(execFile);

// #107 — LibreOffice e singura resursă din pipeline care lansează subprocese
// grele (câteva sute de MB RSS fiecare). Fără plafon, N conversii simultane
// scot procesul Node prin OOM. Configurabil prin env pentru tuning fără deploy.
const LO_MAX          = Math.max(1, parseInt(process.env.LO_MAX_CONCURRENCY || '2', 10) || 2);
const LO_MAX_QUEUE    = Math.max(0, parseInt(process.env.LO_MAX_QUEUE       || '8', 10) || 8);
const LO_QUEUE_WAIT_MS = Math.max(1000, parseInt(process.env.LO_QUEUE_WAIT_MS || '45000', 10) || 45000);

export const loGate = createConcurrencyGate({
  max: LO_MAX,
  maxQueue: LO_MAX_QUEUE,
  queueTimeoutMs: LO_QUEUE_WAIT_MS,
  name: 'libreoffice',
});
```

Apoi înfășoară **exclusiv** apelul `exec`. Nu muta `writeFile`, nu muta `finally`-ul de curățare — vrem ca fișierele temporare să fie șterse și când semaforul refuză.

`old_str`
```js
      await writeFile(inPath, buffer);
      await exec('libreoffice', [
        '--headless',
        '--norestore',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        inPath,
      ], {
        timeout: 90_000,
        env: { ...process.env, HOME: '/tmp' },
      });
```

`new_str`
```js
      await writeFile(inPath, buffer);
      // #107 — un singur slot de semafor per conversie. Timpul petrecut în
      // coadă NU consumă din timeout-ul de 90s al procesului LibreOffice.
      await loGate.run(() => exec('libreoffice', [
        '--headless',
        '--norestore',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        inPath,
      ], {
        timeout: 90_000,
        env: { ...process.env, HOME: '/tmp' },
      }));
```

⚠️ Ramurile `.pdf` passthrough și jpg/png (pdf-lib, ~10 ms, fără subprocess) rămân **complet neatinse** — nu au nevoie de semafor și n-au voie să stea în coadă.

## Pas B2 — `server/routes/convert.mjs`: rate limit + 503 corect pe refuz de semafor

Astăzi, `catch` întoarce `422` cu `e.message` pentru orice eroare. Un `GATE_BUSY` mapat la 422 („tip fișier nesuportat", semantic) ar minți utilizatorul și l-ar face să nu reîncerce. Trebuie 503 + `Retry-After`.

`old_str`
```js
import { convertToPdf } from '../utils/convertToPdf.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = Router();

// POST /api/convert-to-pdf
// Primește un fișier multipart, returnează PDF ca base64
router.post('/api/convert-to-pdf', (req, res) => {
```

`new_str`
```js
import { convertToPdf } from '../utils/convertToPdf.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { createRateLimiter } from '../middleware/rateLimiter.mjs';

const router = Router();

// #107 — aceeași convenție ca _uploadRateLimit din flows/*: 5 conversii/minut.
// Rulează ÎNAINTE de Busboy, deci refuzul nu consumă banda de upload.
const _convertRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Prea multe conversii. Încearcă în 1 minut.',
});

// POST /api/convert-to-pdf
// Primește un fișier multipart, returnează PDF ca base64
router.post('/api/convert-to-pdf', _convertRateLimit, (req, res) => {
```

`old_str`
```js
    } catch (e) {
      res.status(422).json({ error: e.message });
    }
  });
```

`new_str`
```js
    } catch (e) {
      // #107 — semaforul LibreOffice a refuzat: e o condiție TEMPORARĂ de
      // încărcare, nu un fișier invalid. 503 + Retry-After, ca să reîncerce.
      if (e && (e.code === 'GATE_BUSY' || e.code === 'GATE_TIMEOUT')) {
        res.setHeader('Retry-After', '30');
        return res.status(503).json({
          error: 'convert_busy',
          message: 'Serverul de conversie e ocupat. Reîncearcă în câteva secunde.',
        });
      }
      res.status(422).json({ error: e.message });
    }
  });
```

## Pas B3 — `server/routes/flows/crud.mjs`: rate limit pe creare flux + refuz FATAL pe semafor

**B3.1 — montează limiterul deja declarat** (linia ~521):

`old_str`
```js
router.post('/flows', _largePdf, createFlow);
router.post('/api/flows', _largePdf, createFlow);
```

`new_str`
```js
router.post('/flows', _uploadRateLimit, _largePdf, createFlow);
router.post('/api/flows', _uploadRateLimit, _largePdf, createFlow);
```

⚠️ Ordinea contează: limiterul ÎNAINTE de `_largePdf`, ca un refuz să nu parseze un body mare degeaba.
⚠️ `_uploadRateLimit` cheiază pe `ip:req.path`, iar cele două rute au path-uri diferite (`/flows` vs `/api/flows`) ⇒ două cote separate de câte 5/min. Acceptat pentru acest prompt (frontendul folosește o singură variantă); **nu** unifica acum, ar însemna modificarea middleware-ului partajat folosit de 8 fișiere.

**B3.2 — refuzul de semafor NU are voie să cadă în fallback-ul „non-fatal".**

Astăzi, orice eroare din `convertToPdf` e înghițită și fluxul se creează cu **buffer-ul original** (DOCX) salvat în locul PDF-ului. Sub încărcare, asta ar produce fluxuri corupte în loc de o eroare onestă.

`old_str`
```js
        try {
          const convertedBuf = await convertToPdf(inputBuf, body.originalFileName);
          finalPdfB64 = convertedBuf.toString('base64');
        } catch(convErr) {
          logger.warn({ err: convErr, originalFileName: body.originalFileName },
            'convertToPdf non-fatal, using original');
        }
```

`new_str`
```js
        try {
          const convertedBuf = await convertToPdf(inputBuf, body.originalFileName);
          finalPdfB64 = convertedBuf.toString('base64');
        } catch(convErr) {
          // #107 — refuzul semaforului e o condiție de încărcare, NU un fișier
          // invalid. Fallback-ul „folosește originalul" ar salva un DOCX pe post
          // de PDF și ar produce un flux corupt — preferăm 503 și reîncercare.
          if (convErr && (convErr.code === 'GATE_BUSY' || convErr.code === 'GATE_TIMEOUT')) {
            logger.warn({ err: convErr, originalFileName: body.originalFileName },
              'convertToPdf refuzat de semafor — răspund 503');
            res.setHeader('Retry-After', '30');
            return res.status(503).json({
              error: 'convert_busy',
              message: 'Serverul de conversie e ocupat. Reîncearcă în câteva secunde.',
            });
          }
          logger.warn({ err: convErr, originalFileName: body.originalFileName },
            'convertToPdf non-fatal, using original');
        }
```

⚠️ **Verifică prin citire, nu presupune:** confirmă că blocul de mai sus se află într-o funcție care are `res` în scope și că un `return` acolo iese ÎNAINTE de orice `INSERT`/`UPDATE` în DB pentru fluxul respectiv. Dacă fluxul a fost deja persistat mai sus în funcție, **oprește-te și raportează** — atunci soluția corectă nu e `return` aici, ci mutarea conversiei mai devreme, și vreau să decid eu.

## Pas B4 — rate limit pe cele două rute de generare PDF (strat secundar, fără semafor)

`server/routes/formulare-oficiale.mjs` — adaugă importul lângă celelalte middleware-uri și un limiter:

```js
import { createRateLimiter } from '../middleware/rateLimiter.mjs';
```

```js
// #107 — generare PDF in-process (pdf-lib): CPU-heavy, fără subprocess.
const _genPdfRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Prea multe generări PDF. Încearcă în 1 minut.',
});
```

`old_str`
```js
router.post('/:id/generate-pdf', requireAuth, csrfMiddleware, async (req, res) => {
```

`new_str`
```js
router.post('/:id/generate-pdf', _genPdfRateLimit, requireAuth, csrfMiddleware, async (req, res) => {
```

`server/routes/formulare.mjs` — același tratament (verifică dacă `createRateLimiter` e deja importat; dacă da, NU dubla importul):

`old_str`
```js
router.post('/api/formulare/generate', _json5m, async (req, res) => {
```

`new_str`
```js
router.post('/api/formulare/generate', _genFormRateLimit, _json5m, async (req, res) => {
```

cu limiterul declarat lângă celelalte constante din capul fișierului:

```js
// #107 — generare PDF DF/ORD in-process. 20/min acoperă lejer uzul normal
// (previzualizare + retrimitere), dar taie buclele accidentale.
const _genFormRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Prea multe generări. Încearcă în 1 minut.',
});
```

⚠️ Limitare cunoscută, de documentat în RAPORT, nu de reparat aici: limiterul cheiază pe `ip:req.path`, iar la `/:id/generate-pdf` path-ul conține id-ul documentului ⇒ cote separate per document. E un plafon slab. Protecția reală pe ruta asta rămâne faptul că nu lansează subprocese.

---

# VERIFICĂRI FINALE

```bash
node --check server/utils/concurrency-gate.mjs
node --check server/utils/convertToPdf.mjs
node --check server/routes/convert.mjs
node --check server/routes/flows/crud.mjs
node --check server/routes/formulare.mjs
node --check server/routes/formulare-oficiale.mjs
# Așteptat: fără output (toate valide sintactic)

grep -n "loGate.run" server/utils/convertToPdf.mjs
# Așteptat: EXACT 1 rezultat (doar apelul libreoffice, nu ramurile pdf/jpg/png)

grep -c "await exec(" server/utils/convertToPdf.mjs
# Așteptat: 0 — singurul exec e acum înfășurat în loGate.run

grep -n "GATE_BUSY" server/routes/convert.mjs server/routes/flows/crud.mjs
# Așteptat: 1 rezultat în fiecare fișier

grep -rn "_uploadRateLimit" server/routes/flows/crud.mjs | grep "router.post"
# Așteptat: 2 rezultate (/flows și /api/flows)

npm test
# Așteptat: verde, fără regresii

npm run test:db
# Așteptat: verde, fără regresii
# ⚠️ „skipped" NU înseamnă „passed" — dacă suita DB e sărită, raportează asta explicit
```

Bump versiune:

```bash
npm version 3.9.712 --no-git-tag-version
grep '"version"' package.json
# Așteptat: "version": "3.9.712"
```

**FĂRĂ** bump `CACHE_VERSION` în `sw.js` și **FĂRĂ** bump `?v=` — zero fișiere din `public/` sunt atinse. Confirmă:

```bash
git diff --name-only | grep '^public/' || echo "OK — niciun fișier frontend atins"
# Așteptat: OK — niciun fișier frontend atins
```

Commit + push:

```bash
git add -A
git commit -m "feat(sec): semafor concurență LibreOffice + rate limit rute conversie (#107, v3.9.712)"
git push origin develop
```

---

# RAPORT FINAL (obligatoriu, în acest format)

1. **Diff pe fiecare fișier** — ce s-a schimbat, în două rânduri per fișier.
2. **Poarta Etapei A** — a fost `git diff --stat` curat (doar fișiere noi) înainte de Etapa B? DA/NU.
3. **Testele semaforului** — câte cazuri, care, toate verzi? Confirmă explicit că testul **importă** din `concurrency-gate.mjs` și nu redeclară logica.
4. **Verificarea de la B3.2** — unde exact se persistă fluxul în `createFlow` față de blocul de conversie, și de ce `return res.status(503)` e sigur acolo (sau de ce NU e, caz în care te-ai oprit).
5. **Valorile implicite alese** — `LO_MAX_CONCURRENCY=2`, `LO_MAX_QUEUE=8`, `LO_QUEUE_WAIT_MS=45000`. Confirmă că sunt citite din env și că există fallback la valorile astea.
6. **Ce NU ai atins** — lista rutelor cu `convertToPdf` pe care le-ai lăsat neschimbate, dacă există.
7. **Rezultate**: `npm test` și `npm run test:db` (passed/failed, nu „skipped").
8. **Commit hash** + confirmarea că e pe `develop`.
9. **Orice abatere de la prompt**, cu motivul. Abaterile justificate sunt binevenite — abaterile tăcute, nu.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Zero atingeri în `server/signing/`** — zona NO-TOUCH (`cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`, `providers/STSCloudProvider.mjs`).
- ⛔ **Nu modifica `server/middleware/rateLimiter.mjs`.** E folosit de 8+ fișiere de rute; orice schimbare acolo e o suprafață de regresie disproporționată față de câștig. Îl folosim ca atare.
- ⛔ **Nu pune semafor pe ramurile `.pdf` / `.jpg` / `.png`** din `convertToPdf` — n-au subprocess și n-au voie să aștepte în coadă.
- ⛔ **Nu schimba `timeout: 90_000`** al procesului LibreOffice și nu-l muta în afara `loGate.run`.
- ⛔ **Nu adăuga fișiere `.sql`** — nu există migrații în acest prompt.
- ⛔ **Nu bumpa `CACHE_VERSION` și nu atinge `?v=`** — commit backend-only.
- ⛔ **Nu redeclara logica testată.** Testul importă din producție.
- ⛔ Dacă un `old_str` nu se potrivește exact, **OPREȘTE-TE și raportează** cu contextul real din fișier. Nu improviza patch-ul.
- ⛔ Dacă verificarea de la B3.2 arată că fluxul e deja persistat înainte de conversie, **OPREȘTE-TE** la acel pas, livrează restul și raportează — decizia e a lui Mircea.
