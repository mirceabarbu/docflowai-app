# PROMPT — v3.9.507 — Bulk signer UI: re-verificare automată items cu status='error'

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.506 e pe develop (post-revert v505 cosmetic) și `git pull origin develop` rulat local. Versiune curentă: `3.9.506`, CACHE_VERSION `docflowai-v221`.

============================================================
## CONTEXT

User-ul raportează: după semnare în masă (14 documente), UI arată `1 din 14 documente semnate, 13 erori` cu mesaj `PAdES PDF placeholder lipsă în flows_pdfs (key=padesPdf_1)`. Verificare empirică:

1. **Java service logs** (`docflowai-signing-service`) arată pentru fiecare flow: `finalizeSignature: PDF semnat generat (XXX bytes)` cu pipeline complet (TSA timestamp, CMS construit, embed în PDF) — semnătura QES s-a făcut cu succes.

2. **PDF-urile finale** au semnături QES valide (verificat vizual prin deschiderea PDF-ului în Adobe Reader / panou Signatures).

3. **Statusul flow-urilor** în backend: `completed: true` pentru toate 14.

Concluzie: **semnăturile sunt reale, eroarea în UI e false positive**. Cauza exactă în `bulk-signing.mjs` nu se investighează (zonă NO-TOUCH, semnătura funcționează — risc/beneficiu nu justifică atingerea).

Fix: în `public/js/bulk-signer/bulk-signer.js`, după primirea răspunsului poll cu items='error', **re-verificăm automat statusul real al fiecărui flow prin `GET /flows/:flowId`**. Dacă `flow.completed === true`, reclasificăm item ca `signed`. Update stats + items list.

============================================================
## DECIZII DE DESIGN (toate conservatoare)

**Verificare per item**: GET `/flows/:flowId` care întoarce metadata flow strippată (fără PDF, doar `completed`, `signers`, `events`). Endpoint-ul are ACL prin `canActorReadFlow` (din v3.9.502) — userul curent (semnatar) are acces.

**Criteriu reclasificare**:
- `flow.completed === true` → item ESTE semnat (toate semnăturile fluxului au avut loc)
- SAU dacă flow are signers și **TOȚI** au `status === 'signed'` (defense in depth pentru cazul unde `completed` lipsește)

**UX**:
- Mesaj inițial randat instant (cum e acum)
- Dacă există erori, apare spinner mic "🔄 Verificăm statusul real..."
- După N apeluri paralele (max 14), update UI:
  - Items reclasificate primesc badge "✅ Semnat (verificat)"
  - Stats counts recalculate
  - Titlu/mesaj actualizat dacă toate erorile s-au reclasificat

**Fără timeout** — apelurile rulează în paralel cu `Promise.allSettled`, oricare eșuează rămâne ca eroare originală.

**Zero atingere backend** — fix exclusiv frontend.

============================================================
## PAS 1 — Modifică `showPhaseDone` în `public/js/bulk-signer/bulk-signer.js`

Localizează funcția la linia 249. Înlocuiește integral cu varianta extinsă:

```js
// ── Faza Done ────────────────────────────────────────────────────────────────
function showPhaseDone(j) {
  $('phase-wait').style.display  = 'none';
  $('phase-init').style.display  = 'none';
  $('phase-done').style.display  = 'block';

  // v3.9.507: render initial cu datele primite de la backend
  _renderDoneState(j);

  // v3.9.507: dacă există items cu status='error', verificăm statusul real al
  // flow-urilor — bulk-signing.mjs poate clasifica greșit ca eroare items
  // deja semnate. Vezi context comentariu funcție _reverifyErrorItems.
  if (Array.isArray(j.items) && j.items.some(i => i.status === 'error')) {
    _reverifyErrorItems(j);
  }
}

// v3.9.507: render state extras din showPhaseDone — folosit și la re-render
// după re-verificare automată items cu status='error'.
function _renderDoneState(j) {
  const signed = j.signed || 0;
  const errors = j.errors || 0;
  const total  = j.total  || j.flowCount || (signed + errors);
  const allOk  = errors === 0;

  $('doneIcon').textContent  = allOk ? '✅' : (signed > 0 ? '⚠️' : '❌');
  $('doneTitle').textContent = allOk
    ? 'Semnare finalizată cu succes!'
    : signed > 0
      ? 'Semnare parțial finalizată'
      : 'Semnare eșuată';
  $('doneMsg').textContent = allOk
    ? `Toate cele ${total} documente au fost semnate cu succes cu semnătură electronică calificată QES.`
    : `${signed} din ${total} documente semnate. ${errors > 0 ? errors + ' erori.' : ''}`;

  $('doneStats').innerHTML = `
    <div class="stat"><div class="stat-n ok">${signed}</div><div class="stat-l">Semnate</div></div>
    ${errors > 0 ? `<div class="stat"><div class="stat-n bad">${errors}</div><div class="stat-l">Erori</div></div>` : ''}
    <div class="stat"><div class="stat-n">${total}</div><div class="stat-l">Total</div></div>
  `;

  if (Array.isArray(j.items) && j.items.length) {
    $('doneItems').innerHTML = `
      <div class="card">
        ${j.items.map(i => `
          <div class="item">
            <div class="item-icon">${i.status === 'signed' ? '✅' : '❌'}</div>
            <div style="flex:1;min-width:0">
              <div class="item-name">${esc(i.docName || i.flowId)}</div>
              ${i.error && i.status !== 'signed' ? `<div class="item-sub" style="color:#ffaaaa">${esc(i.error)}</div>` : ''}
              ${i._verifiedAfterError ? `<div class="item-sub" style="color:#8ac4ff">🔄 Verificat ulterior — semnătura QES validă</div>` : ''}
            </div>
            <span class="item-status ${i.status === 'signed' ? 'status-signed' : 'status-error'}">
              ${i.status === 'signed' ? '✅ Semnat' : '❌ Eroare'}
            </span>
            ${i.status === 'signed'
              ? `<a href="/flow.html?flow=${encodeURIComponent(i.flowId)}"
                   style="font-size:.8rem;color:var(--sub);text-decoration:none;
                     padding:5px 10px;border:1px solid var(--stroke);border-radius:7px;
                     white-space:nowrap;margin-left:6px">
                   🔍 Vezi
                 </a>`
              : ''}
          </div>`).join('')}
      </div>`;
  }
}

// v3.9.507: re-verificare automată a items cu status='error'. Bulk-signing
// poate raporta greșit ca eroare items care au semnătură QES validă
// (cauză suspectă: retry loop în pipeline-ul backend care iterează peste
// items deja procesate; placeholder șters după prima rulare → next iteration
// vede placeholder lipsă și aruncă eroare deși semnătura s-a făcut).
// Fix: verificăm pentru fiecare item de eroare statusul REAL al flow-ului
// prin GET /flows/:flowId. Dacă flow.completed === true sau toți signers
// sunt status='signed', reclasificăm item ca semnat (cu badge "verificat").
async function _reverifyErrorItems(j) {
  // Spinner mic în UI
  const msgEl = document.getElementById('doneMsg');
  const originalMsg = msgEl ? msgEl.textContent : '';
  if (msgEl) {
    msgEl.innerHTML = `${esc(originalMsg)} <span style="display:inline-block;margin-left:10px;color:#8ac4ff;font-size:.9em">🔄 Verificăm statusul real...</span>`;
  }

  const errorItems = j.items.filter(i => i.status === 'error');
  const checks = errorItems.map(async (item) => {
    try {
      const r = await fetch(`/flows/${encodeURIComponent(item.flowId)}`, { credentials: 'include' });
      if (!r.ok) return { item, isActuallySigned: false };
      const flowData = await r.json();
      // Criteriu: flow.completed === true SAU toți signers cu status='signed'
      const completed = flowData.completed === true || flowData.status === 'completed';
      const allSignersSigned = Array.isArray(flowData.signers) && flowData.signers.length > 0
        && flowData.signers.every(s => s.status === 'signed');
      const isActuallySigned = completed || allSignersSigned;
      return { item, isActuallySigned };
    } catch(_) {
      return { item, isActuallySigned: false };
    }
  });

  const results = await Promise.allSettled(checks);

  // Reclasificăm items pe baza rezultatelor
  let reclassified = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.isActuallySigned) {
      const it = r.value.item;
      // Marchez în obiectul original din j.items (find by reference flowId)
      const target = j.items.find(x => x.flowId === it.flowId);
      if (target) {
        target.status = 'signed';
        target._verifiedAfterError = true;
        reclassified++;
      }
    }
  }

  if (reclassified > 0) {
    // Update count-uri
    j.signed = (j.signed || 0) + reclassified;
    j.errors = Math.max(0, (j.errors || 0) - reclassified);
    // Re-render complet
    _renderDoneState(j);
  } else {
    // Niciuna nu s-a confirmat — restaurăm mesajul fără spinner
    if (msgEl) msgEl.textContent = originalMsg;
  }
}
```

Schimbări concrete:
1. `showPhaseDone` se descompune: render imediat + trigger async re-verify dacă există erori
2. `_renderDoneState` extras pentru a putea fi re-apelat după reclassify
3. `_reverifyErrorItems` nou: apeluri paralele la `/flows/:flowId`, criteriul `completed=true OR all signers signed`
4. Itemii reclasificați primesc `_verifiedAfterError: true` pentru badge informativ
5. Spinner inline în mesaj cât durează verificarea

Verifică:
```bash
grep -n "v3.9.507" public/js/bulk-signer/bulk-signer.js
grep -n "_reverifyErrorItems\|_renderDoneState" public/js/bulk-signer/bulk-signer.js
```

Expected: minim 3 match-uri v3.9.507; ambele funcții declarate + apelate.

============================================================
## PAS 2 — Test guard

Creează `server/tests/unit/v3-9-507-bulk-reverify.test.mjs`:

```js
/**
 * v3.9.507 — guard pentru re-verificarea automată a items cu status='error'
 * în bulk-signer UI.
 *
 * Test string-match. Comportament dynamic testabil manual pe staging:
 * bulk sign 5+ documente → UI raportează erori false → spinner "Verifică
 * statusul real..." → items reclasificate ca signed cu badge "🔄 Verificat".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('Bulk signer UI re-verify error items (v3.9.507)', () => {
  it('comentariu v3.9.507 prezent în bulk-signer.js', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.507/);
  });

  it('_renderDoneState extras ca funcție separată (re-render după reclassify)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/function _renderDoneState\(j\)/);
  });

  it('_reverifyErrorItems declarat și apelat în showPhaseDone', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/async function _reverifyErrorItems\(j\)/);
    // În showPhaseDone trebuie apelat condiționat de existența items cu status='error'
    const m = src.match(/function showPhaseDone\(j\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'corpul showPhaseDone nu a fost găsit').toBeTruthy();
    expect(m[0]).toMatch(/_reverifyErrorItems/);
    expect(m[0]).toMatch(/status\s*===\s*['"]error['"]/);
  });

  it('criteriul de reclassify: completed === true SAU all signers signed', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    const m = src.match(/async function _reverifyErrorItems\(j\)[\s\S]*?\n\}\s*$/m);
    expect(m).toBeTruthy();
    const body = m[0];
    // Apel către endpoint-ul de flow info
    expect(body).toMatch(/\/flows\/\$\{encodeURIComponent\(item\.flowId\)\}/);
    // Verificare completed
    expect(body).toMatch(/completed\s*===\s*true/);
    // Verificare all signers signed
    expect(body).toMatch(/signers\.every\(s\s*=>\s*s\.status\s*===\s*['"]signed['"]\)/);
    // Promise.allSettled pentru paralelism + fail tolerance
    expect(body).toMatch(/Promise\.allSettled/);
  });

  it('items reclasificați primesc _verifiedAfterError flag', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    expect(src).toMatch(/_verifiedAfterError\s*=\s*true/);
    // Badge afișat în UI pentru items verificate
    expect(src).toMatch(/Verificat ulterior/);
  });

  it('stats counts actualizate: j.signed și j.errors recalculate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/bulk-signer/bulk-signer.js'), 'utf8');
    const m = src.match(/async function _reverifyErrorItems\(j\)[\s\S]*?\n\}\s*$/m);
    expect(m).toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/j\.signed\s*=\s*\(j\.signed\s*\|\|\s*0\)\s*\+\s*reclassified/);
    expect(body).toMatch(/j\.errors\s*=\s*Math\.max\(0,\s*\(j\.errors\s*\|\|\s*0\)\s*-\s*reclassified\)/);
  });
});
```

Verifică:
```bash
node --check server/tests/unit/v3-9-507-bulk-reverify.test.mjs
npx vitest run server/tests/unit/v3-9-507-bulk-reverify.test.mjs
```

Expected: cele 6 teste trec.

============================================================
## PAS 3 — npm test verde

```bash
npm test 2>&1 | tail -30
```

Expected: +6 teste față de v3.9.506. Toate verzi.

NB: niciun test existent nu trebuie afectat (fix exclusiv frontend, zero atingere backend sau alt fișier).

============================================================
## PAS 4 — Version bump

În `package.json`: `3.9.506` → `3.9.507`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v221` → `docflowai-v222`.

============================================================
## PAS 5 — Commit + push develop

```bash
git status
git add public/js/bulk-signer/bulk-signer.js \
        server/tests/unit/v3-9-507-bulk-reverify.test.mjs \
        package.json public/sw.js
git commit -m "fix(bulk-signer): re-verificare automată items cu status='error' (v3.9.507)

Bulk signing raporta uneori 'X din N documente semnate, N-X erori' deși
toate semnăturile QES erau real efectuate. Cauza (suspectată în
bulk-signing.mjs NO-TOUCH): retry loop iterează peste items deja procesate,
placeholder șters după prima rulare → next iteration aruncă 'PAdES
placeholder lipsă' deși semnătura s-a făcut cu succes.

Fix pur frontend (zero atingere backend): după primirea răspunsului poll,
dacă există items cu status='error', verificăm pentru fiecare statusul
real al flow-ului prin GET /flows/:flowId. Criteriu reclassify:
flow.completed === true SAU toți signers cu status='signed'. Items
reclasificați primesc flag _verifiedAfterError + badge UI '🔄 Verificat
ulterior'. Stats counts (signed/errors) recalculate, mesaj titlu/sub
update-ate dacă toate erorile s-au reclasificat.

Apeluri paralele cu Promise.allSettled — fail-tolerant per-item.
Spinner inline '🔄 Verificăm statusul real...' în timpul verificării.

Test: v3-9-507-bulk-reverify.test.mjs (6 cazuri guard string-match).
Comportament dinamic testabil manual pe staging."
git push origin develop
```

============================================================
## RAPORT FINAL

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi?
3. SHA commit pushed pe develop?
4. `grep -c "v3.9.507" public/js/bulk-signer/bulk-signer.js` → minim 3?
5. `git status` → working tree clean?

============================================================
## TESTARE MANUALĂ STAGING

1. **Reproducerea scenariului tău (14 docs):**
   - Bulk sign 5-15 documente cu STS Cloud
   - Aștepți răspuns final UI

2. **Comportament așteptat:**
   - Inițial: vezi mesaj cu erori "X din N semnate, N-X erori" cu spinner mic "🔄 Verificăm statusul real..."
   - După 1-3 secunde (paralel): re-randare cu items reclasificate
   - Items cu badge "🔄 Verificat ulterior — semnătura QES validă"
   - Stats actualizate: dacă toate au fost re-verificate, "X din X semnate, 0 erori"
   - Titlul devine "Semnare finalizată cu succes!" dacă toate s-au confirmat

3. **Edge cases:**
   - Erori REALE (nu false positive): dacă `GET /flows/:flowId` raportează `completed: false` și nu toți signers='signed', item-ul rămâne în categoria eroare (corect — chiar a căzut semnătura)
   - Rețea instabilă: dacă unul din fetch-uri cade cu timeout/network err, item-ul rămâne în "eroare" (Promise.allSettled e fail-tolerant per item)

============================================================
## RECOMANDĂRI POST-SPRINT (nu implementăm acum)

1. **Investigare cauză root** în `bulk-signing.mjs` — necesită NO-TOUCH override + investigare detaliată (retry loop? race condition? placeholder lifecycle?). Risc/beneficiu nu justifică acum. Fix-ul cosmetic UI rezolvă problema vizibilă pentru utilizator.

2. **Endpoint dedicat bulk status** — în loc de N apeluri `/flows/:flowId`, un endpoint `/bulk-signing/:sessionId/verify-status` care întoarce statusul real al tuturor flow-urilor în 1 call. Optimizare, nu necesară pentru funcționalitate.

3. **Cleanup `flows_pdfs` orfan** — dacă există placeholder-uri `padesPdf_N` rămase din erori vechi, un job de cleanup nightly. Curățenie operațională.

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/*` (STSCloudProvider, pades.mjs, java-pades-client.mjs) — STRICT NO-TOUCH
- `server/routes/flows/bulk-signing.mjs` — STRICT NO-TOUCH (cauza root e aici, dar fix-ul nu o atinge — adresăm doar UI)
- `server/routes/flows/cloud-signing.mjs`, `signing.mjs`, `lifecycle.mjs`, `crud.mjs` — neatinse
- `server/routes/auth.mjs`, `alop.mjs`, `formulare-db.mjs` — neatinse
- `server/services/*`, `server/utils/*`, `server/db/index.mjs`, `server/middleware/*` — neatinse
- `public/bulk-signer.html` — neatins (modificările sunt în JS, nu în HTML)
- Endpoint-ul `/flows/:flowId` rămâne neatins — folosim ce există + ACL deja corect (din v3.9.502 canActorReadFlow)
- `public/js/formular/*` — neatins
- Toate celelalte teste existente — neatinse

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
