# PROMPT — v3.9.505 — CRITIC: openDoc state cleanup la fetch fail

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.504 e merge-uit pe develop și `git pull origin develop` rulat local.

============================================================
## CONTEXT

**Bug critic raportat de user cu screenshot dovadă:** un DF anulat / draft / fără acces se afișează ca "✔ Document aprobat — fluxul de semnare a fost finalizat." cu butoanele "Descarcă PDF semnat" + "Revizuiește", deși sBar arată "❌ forbidden".

**Cauza:** în `public/js/formular/doc.js`, funcția `openDoc(ft, id)` la linia 421:

```js
const r=await fetch(`${ftApi(ft)}/${id}`,{credentials:'include'});
const j=await r.json();
if(!r.ok||!j.ok){setS(j.error||'Eroare la încărcare','err');return;}
```

**Early return** după fetch eșuat. Nu resetează `ST.docId`, `ST.docStatus`, `ST.docRole`, `ST.docAprobat`, `ST.docFlowId`, `ST.docRevizieNr` etc. Nu curăță locked-bar, motiv-bar, banner-an-urmator. Nu redesenează `renderActions`. **Toate rămân din openDoc-ul precedent.**

Scenariu reproductiv:
1. User deschide doc A (aprobat) → state setat corect, locked-bar verde, butoane aprobate
2. User click pe doc B (draft / anulat / fără acces) → GET 403/404 → early return
3. UI rămâne cu state-ul lui A, dar URL/context spune că e B → confuzie majoră

**Fix:** funcție helper `_resetDocStateOnError(ft)` care resetează toate state-urile + UI-ul. Apelată înainte de `return` în openDoc la fetch fail. Scope minim, atinge doar doc.js.

NB: dacă alte funcții au pattern similar (saveDoc, completeAsP2, etc.), nu le atingem aici. Acelea modifică un document **existent valid** — fetch fail e tranzitoriu (rețea, server), state-ul precedent e încă valid pentru documentul curent. Doar `openDoc` are situația specifică în care state-ul vechi devine invalid când fetch-ul pentru noul document eșuează.

============================================================
## PAS 1 — Adaugă helper `_resetDocStateOnError` în `public/js/formular/doc.js`

Localizează linia 416 unde începe `// ── Open document ───`. Înainte de `async function openDoc(ft,id){`, adaugă helper-ul:

```js
// v3.9.505 (BUG CRITIC): resetare completă state la fetch fail în openDoc.
// Înainte: dacă GET /api/formulare-{df|ord}/:id returna 403/404/500, early return
// lăsa ST.doc*, locked-bar, renderActions, populate fields din openDoc-ul anterior.
// Rezultat vizual: "Document aprobat" + butoane "Descarcă PDF / Revizuiește" pentru
// un alt document, plus eroare 'forbidden' în sBar. Confuzie + percepție bug.
function _resetDocStateOnError(ft){
  ST.docId[ft]                = null;
  ST.docStatus[ft]            = null;
  ST.docRole[ft]              = 'view';
  ST.docAprobat               = ST.docAprobat || {};         ST.docAprobat[ft]            = false;
  ST.docFlowId                = ST.docFlowId || {};          ST.docFlowId[ft]             = null;
  ST.docRevizieNr             = ST.docRevizieNr || {};       ST.docRevizieNr[ft]          = 0;
  ST.docRevizieAnUrmator      = ST.docRevizieAnUrmator || {};  ST.docRevizieAnUrmator[ft] = false;
  ST.docAreRevizieNoua        = ST.docAreRevizieNoua || {};  ST.docAreRevizieNoua[ft]     = false;
  ST.docLatestRevizieNr       = ST.docLatestRevizieNr || {}; ST.docLatestRevizieNr[ft]    = 0;
  // UI: locked-bar, motiv-bar, banner an următor — toate ascunse / golite
  if (typeof setLockedBar === 'function') setLockedBar(ft, '');
  const mb = document.getElementById('motiv-bar-' + ft);
  if (mb) mb.style.display = 'none';
  const ban = document.getElementById('banner-an-urmator-' + ft);
  if (ban) ban.style.display = 'none';
  // Butoanele de acțiune golite (renderActions cu docId=null nu mai afișează nimic relevant)
  const div = document.getElementById('actions-' + ft);
  if (div) div.innerHTML = '';
  // Deselectează doc card din lista laterală
  document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c => c.classList.remove('active'));
}
```

============================================================
## PAS 2 — Apelează helper-ul în `openDoc` la fetch fail

Localizează linia 421 în `openDoc`:

```js
    const r=await fetch(`${ftApi(ft)}/${id}`,{credentials:'include'});
    const j=await r.json();
    if(!r.ok||!j.ok){setS(j.error||'Eroare la încărcare','err');return;}
```

Înlocuiește linia 421 cu:

```js
    const r=await fetch(`${ftApi(ft)}/${id}`,{credentials:'include'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok){
      // v3.9.505 (BUG CRITIC): resetare state înainte de return, altfel
      // UI-ul rămâne în state-ul documentului anterior.
      _resetDocStateOnError(ft);
      setS(j.error||`Eroare la încărcare (HTTP ${r.status})`,'err');
      return;
    }
```

Două schimbări adiționale față de cod actual:
- `r.json().catch(()=>({}))` — protejează contra răspunsurilor non-JSON (ex. 500 cu HTML)
- Mesajul include statusul HTTP pentru debug user-side

Verifică:
```bash
grep -n "v3.9.505 (BUG CRITIC)" public/js/formular/doc.js
grep -n "function _resetDocStateOnError" public/js/formular/doc.js
```

Expected: 2 match-uri pentru comentariu (helper declaration + apel); 1 match pentru helper.

============================================================
## PAS 3 — Test unit guard

Creează `server/tests/unit/v3-9-505-opendoc-cleanup.test.mjs`:

```js
/**
 * v3.9.505 (BUG CRITIC) — guard că openDoc resetează state-ul la fetch fail.
 *
 * Test string-match: helper _resetDocStateOnError trebuie să existe și să fie
 * apelat în openDoc înainte de return la !r.ok || !j.ok.
 *
 * Comportament dynamic e testabil doar manual pe staging (deschide doc aprobat,
 * apoi click pe doc fără acces → UI nu mai trebuie să afișeze state-ul vechi).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('openDoc state cleanup la fetch fail (v3.9.505)', () => {
  it('helper _resetDocStateOnError e declarat', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.505 \(BUG CRITIC\)/);
    expect(src).toMatch(/function _resetDocStateOnError\(ft\)/);
  });

  it('helper resetează TOATE state-urile cheie', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const m = src.match(/function _resetDocStateOnError\(ft\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'corpul helper-ului nu a fost găsit').toBeTruthy();
    const body = m[0];
    // State-uri ST.doc* resetate
    expect(body).toMatch(/ST\.docId\[ft\]\s*=\s*null/);
    expect(body).toMatch(/ST\.docStatus\[ft\]\s*=\s*null/);
    expect(body).toMatch(/ST\.docAprobat\[ft\]\s*=\s*false/);
    expect(body).toMatch(/ST\.docFlowId\[ft\]\s*=\s*null/);
    expect(body).toMatch(/ST\.docRevizieNr\[ft\]\s*=\s*0/);
    expect(body).toMatch(/ST\.docAreRevizieNoua\[ft\]\s*=\s*false/);
    // UI cleanup
    expect(body).toMatch(/setLockedBar\(ft,\s*''\)/);
    expect(body).toMatch(/motiv-bar-/);
    expect(body).toMatch(/banner-an-urmator-/);
    expect(body).toMatch(/actions-/);
    expect(body).toMatch(/docs-list-/);
  });

  it('openDoc apelează _resetDocStateOnError înainte de return la fetch fail', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // Match blocul if(!r.ok || !j.ok) din openDoc
    const m = src.match(/if\(!r\.ok\|\|!j\.ok\)\s*\{[\s\S]*?return;\s*\}/);
    expect(m, 'blocul if(!r.ok||!j.ok) din openDoc nu e găsit').toBeTruthy();
    const block = m[0];
    expect(block).toMatch(/_resetDocStateOnError\(ft\)/);
    expect(block).toMatch(/setS\(/);
    // Helper-ul trebuie să fie ÎNAINTE de setS (curățăm state, apoi mesaj user)
    const idxReset = block.indexOf('_resetDocStateOnError');
    const idxSetS  = block.indexOf('setS(');
    expect(idxReset).toBeLessThan(idxSetS);
  });

  it('mesajul de eroare include status HTTP pentru debugging', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/HTTP \$\{r\.status\}/);
  });

  it('r.json() are .catch pentru răspunsuri non-JSON (ex. 500 cu HTML)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // În openDoc trebuie să fie un .catch după r.json() — defensiv
    const m = src.match(/async function openDoc\(ft,\s*id\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'corpul openDoc nu e găsit').toBeTruthy();
    expect(m[0]).toMatch(/r\.json\(\)\.catch/);
  });
});
```

Verifică:
```bash
node --check server/tests/unit/v3-9-505-opendoc-cleanup.test.mjs
npx vitest run server/tests/unit/v3-9-505-opendoc-cleanup.test.mjs
```

Expected: cele 5 teste trec.

============================================================
## PAS 4 — npm test verde, fără regresii

```bash
npm test 2>&1 | tail -30
```

Expected: +5 teste față de v3.9.504. Toate verzi.

NB: testele existente n-ar trebui să fie afectate — helper-ul e nou, openDoc-ul modificat tot returnează (nu se schimbă semantica happy path).

============================================================
## PAS 5 — Version bump

În `package.json`: `3.9.504` → `3.9.505`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v219` → `docflowai-v220`.

============================================================
## PAS 6 — Commit + push develop

```bash
git status
git add public/js/formular/doc.js \
        server/tests/unit/v3-9-505-opendoc-cleanup.test.mjs \
        package.json public/sw.js
git commit -m "fix(form): CRITIC — state cleanup la fetch fail în openDoc (v3.9.505)

Bug raportat de user cu screenshot dovadă: un DF/ORD draft/anulat/fără
acces se afișa ca 'Document aprobat — fluxul de semnare a fost finalizat'
cu butoanele 'Descarcă PDF semnat' și 'Revizuiește', deși sBar arăta
'forbidden'. Cauza: openDoc făcea early return la fetch 403/404/500
fără să reseteze ST.docId/Status/Role/Aprobat/FlowId/etc., locked-bar,
motiv-bar, banner-an-urmator, sau actions div. State-ul rămânea din
openDoc-ul anterior → UI inconsistent.

Fix: helper _resetDocStateOnError(ft) apelat înainte de return la fetch
fail. Resetează TOATE ST.doc*, golește locked-bar via setLockedBar(ft,''),
ascunde motiv-bar + banner-an-urmator, golește actions div, deselectează
doc cards. Plus mesaj de eroare include status HTTP pentru debug, și
r.json() are .catch defensiv pentru răspunsuri non-JSON.

Scope strict: doar openDoc. Alte funcții (saveDoc, completeAsP2) modifică
documente existente valid; fetch fail e tranzitoriu și state-ul precedent
rămâne valid pentru documentul curent.

Test: v3-9-505-opendoc-cleanup.test.mjs (5 cazuri guard string-match).
Comportament dinamic testabil manual pe staging."
git push origin develop
```

============================================================
## RAPORT FINAL

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi?
3. SHA commit pushed pe develop?
4. `grep -c "v3.9.505" public/js/formular/doc.js` → minim 2?
5. `git status` → working tree clean?

============================================================
## TESTARE MANUALĂ STAGING (după deploy)

1. **Reproducerea bug-ului original:**
   - Logează-te ca user A. Deschide un DF aprobat → vezi "Document aprobat" + butoane "Descarcă PDF / Revizuiește"
   - În alt tab/sesiune, ca user B din altă org, generează un flowId / docId la care A nu are acces
   - În tab-ul lui A, navighează manual la `/?id=<docId-userB>` sau click pe un doc fără acces
   - **Expected**: locked-bar dispare, butoanele dispar, sBar arată "Eroare la încărcare (HTTP 403)". **NU** rămâne în starea "Document aprobat".

2. **Regression check** — happy path:
   - Deschide un doc valid → totul ca înainte
   - Schimbă între 2 documente valide → state-urile se actualizează corect

3. **Edge case** — server crash (5xx):
   - Dacă serverul cade pe GET, sBar arată "Eroare la încărcare (HTTP 500)" — userul are info pentru debug, UI-ul nu se blochează

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/*`, `server/routes/flows/*`, `server/routes/auth.mjs`, `server/routes/alop.mjs`, `server/routes/formulare-db.mjs`
- `server/services/*`, `server/utils/*`, `server/db/index.mjs`
- `server/middleware/*`
- `public/formular.html`, `public/css/*`
- `public/js/formular/core.js`, `list.js`, `alop.js`, `draft.js`
- Restul funcțiilor din `doc.js` — atingem DOAR `openDoc` și adăugăm helper-ul. Niciun renderActions, applyDfRoleState, applyOrdRoleState, populateOrd, populateDf etc.
- saveDoc, completeAsP2, etc. — n-au pattern-ul problematic (modifică doc existent valid, fail-ul e tranzitoriu pe rețea)

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
