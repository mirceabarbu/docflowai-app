# PROMPT — v3.9.505 — UX: consolidare "Document aprobat" pe un singur rând

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.504 e merge-uit pe develop și `git pull origin develop` rulat local.

============================================================
## CONTEXT

În formular DF/ORD pe status `aprobat`, mesajul "Document aprobat" apare DUPLICAT pe două bare separate:

1. **Bara de sus** (în `.back-bar`, lângă "← Înapoi la lista" și titlu form): mov/violet, text "✔ Document aprobat — fluxul de semnare a fost finalizat." — setată prin `setLockedBar(ft, msg, 'info')` la linia 496 din `public/js/formular/doc.js`.

2. **Bara de jos** (`#sBar`, separat sub back-bar): verde cu prefix ✅, text "Document aprobat" — setată prin `setS('Document aprobat','ok')` la linia 502.

Redundanța vizuală e zgomot. User cere consolidare: păstrează o singură bară, pe rândul de sus, cu stilul verde (semantic corect — success state).

Fix:
- Elimină apelul `setS('Document aprobat','ok')` la linia 502
- Schimbă tipul `setLockedBar` la `'ok'` (în loc de `'info'`) când status=aprobat
- Adaugă variantă CSS `.locked-bar.ok` (verde) — pattern existent pentru `.warn` și `.info`

============================================================
## PAS 1 — CSS: adaugă variantă `.locked-bar.ok`

În `public/css/formular/formular.css`, localizează blocul cu `.locked-bar.info` la linia 155:

```css
    .locked-bar.warn{background:rgba(255,170,30,.08);border:1px solid rgba(255,170,30,.2);color:#ffcc44}
    .locked-bar.info{background:rgba(108,79,240,.08);border:1px solid rgba(108,79,240,.2);color:#b0a0ff}
```

Adaugă o linie nouă imediat DUPĂ `.locked-bar.info`:

```css
    .locked-bar.warn{background:rgba(255,170,30,.08);border:1px solid rgba(255,170,30,.2);color:#ffcc44}
    .locked-bar.info{background:rgba(108,79,240,.08);border:1px solid rgba(108,79,240,.2);color:#b0a0ff}
    .locked-bar.ok{background:rgba(29,200,174,.08);border:1px solid rgba(29,200,174,.2);color:#5dcaa5}
```

NB: culorile sunt identice cu `df-lock-ok` existent (linia 282) — același vocabular vizual pentru "success state".

Verifică:
```bash
grep -n "\.locked-bar\.ok" public/css/formular/formular.css
```

Expected: 1 match.

============================================================
## PAS 2 — JS: schimbă tipul + elimină redundanța sBar

În `public/js/formular/doc.js`, localizează blocul de la linia 492-503 (branch-ul `ST.docAprobat[ft]`). Înlocuiește:

```js
    if(ST.docAprobat[ft]){
      lockAll(ft,true);
      lockCaptureAndAttachments(ft,true);
      // p2-field eliminat (uniformizare vizuală) — nu mai e nimic de curățat
      setLockedBar(ft,'✔ Document aprobat — fluxul de semnare a fost finalizat.','info');
      renderActions(ft);
      if(ft==='notafd')applyDfRoleState('aprobat',ST.docRole[ft]);
      else if(ft==='ordnt')applyOrdRoleState('aprobat',ST.docRole[ft]);
      refreshDocs(ft);
      document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c=>c.classList.toggle('active',c.dataset.id===id));
      setS('Document aprobat','ok');
      return;
    }
```

cu:

```js
    if(ST.docAprobat[ft]){
      lockAll(ft,true);
      lockCaptureAndAttachments(ft,true);
      // p2-field eliminat (uniformizare vizuală) — nu mai e nimic de curățat
      // v3.9.505: tip 'ok' (verde) pentru semantic success + elimină redundanța sBar
      // (mesajul era duplicat: locked-bar de sus + sBar de jos cu același conținut)
      setLockedBar(ft,'✔ Document aprobat — fluxul de semnare a fost finalizat.','ok');
      renderActions(ft);
      if(ft==='notafd')applyDfRoleState('aprobat',ST.docRole[ft]);
      else if(ft==='ordnt')applyOrdRoleState('aprobat',ST.docRole[ft]);
      refreshDocs(ft);
      document.querySelectorAll(`#docs-list-${ft} .doc-card`).forEach(c=>c.classList.toggle('active',c.dataset.id===id));
      return;
    }
```

Două schimbări:
- `'info'` → `'ok'` (linia setLockedBar) → bara devine verde
- linia `setS('Document aprobat','ok');` ELIMINATĂ → sBar rămâne curat

Verifică:
```bash
grep -n "v3.9.505" public/js/formular/doc.js
grep -n "setS('Document aprobat','ok')" public/js/formular/doc.js
grep -n "setLockedBar(ft,'✔ Document aprobat" public/js/formular/doc.js
```

Expected:
- 1 match v3.9.505 (comentariu)
- **0 match-uri** pentru `setS('Document aprobat','ok')` (eliminat)
- 1 match pentru setLockedBar cu `,'ok'` la final (nu `,'info'`)

============================================================
## PAS 3 — Test guard

Creează `server/tests/unit/v3-9-505-locked-bar.test.mjs`:

```js
/**
 * v3.9.505 — guard că:
 * - locked-bar.ok CSS rule e prezent
 * - setLockedBar pentru status aprobat folosește tip 'ok' (nu 'info')
 * - setS('Document aprobat','ok') a fost eliminat (redundanță cu locked-bar)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('Document aprobat — consolidare pe un singur rând (v3.9.505)', () => {
  it('CSS: .locked-bar.ok rule e prezent cu culoarea teal/verde', () => {
    const css = readFileSync(path.join(REPO, 'public/css/formular/formular.css'), 'utf8');
    expect(css).toMatch(/\.locked-bar\.ok\s*\{[^}]*background:\s*rgba\(29,200,174/);
    expect(css).toMatch(/\.locked-bar\.ok\s*\{[^}]*color:\s*#5dcaa5/);
  });

  it('doc.js: setLockedBar pentru aprobat folosește tip "ok"', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.505/);
    // setLockedBar cu mesajul "Document aprobat" trebuie să folosească 'ok'
    expect(src).toMatch(/setLockedBar\(ft,\s*'✔ Document aprobat[^']*','ok'\)/);
  });

  it('doc.js: setS("Document aprobat","ok") a fost eliminat (redundanță)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // Această linie era duplicată cu setLockedBar — eliminată în v3.9.505
    expect(src).not.toMatch(/setS\(['"]Document aprobat['"],['"]ok['"]\)/);
  });

  it('doc.js: alte folosiri ale setS rămân intacte (regression check)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // setS pe erori (eg "Document aprobat — nu poate fi modificat") trebuie să rămână
    expect(src).toMatch(/setS\(['"]Document aprobat — nu poate fi modificat['"]/);
  });
});
```

Verifică:
```bash
node --check server/tests/unit/v3-9-505-locked-bar.test.mjs
npx vitest run server/tests/unit/v3-9-505-locked-bar.test.mjs
```

Expected: cele 4 teste trec.

============================================================
## PAS 4 — npm test verde

```bash
npm test 2>&1 | tail -30
```

Expected: +4 teste față de v3.9.504. Toate verzi.

============================================================
## PAS 5 — Version bump

În `package.json`: `3.9.504` → `3.9.505`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v219` → `docflowai-v220`.

============================================================
## PAS 6 — Commit + push develop

```bash
git status
git add public/css/formular/formular.css \
        public/js/formular/doc.js \
        server/tests/unit/v3-9-505-locked-bar.test.mjs \
        package.json public/sw.js
git commit -m "ux(form): consolidare \"Document aprobat\" pe un singur rând (v3.9.505)

Pe status='aprobat' apăreau două bare cu același mesaj:
1. .locked-bar (în back-bar): mov, '✔ Document aprobat — fluxul...'
2. #sBar (sub back-bar): verde, '✅ Document aprobat'

Redundanță vizuală. Fix:
- Adaugă variantă CSS .locked-bar.ok (verde, identic cu df-lock-ok)
- Schimbă setLockedBar tip 'info' → 'ok' pentru aprobat (verde)
- Elimină setS('Document aprobat','ok') redundant

Rezultat: o singură bară verde sus, cu textul complet, pe același rând
cu '← Înapoi la lista DF · 📋 Document de Fundamentare'.

NB: alte folosiri ale setS pe documente aprobate rămân intacte (ex.
'Document aprobat — nu poate fi modificat' din handler-ul de edit).

Test: v3-9-505-locked-bar.test.mjs (4 cazuri guard)."
git push origin develop
```

============================================================
## RAPORT FINAL

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi?
3. SHA commit pushed pe develop?
4. `grep -c "v3.9.505" public/js/formular/doc.js` → 1?
5. `grep -c "setS('Document aprobat','ok')" public/js/formular/doc.js` → **0** (eliminat)?
6. `git status` → working tree clean?

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`, `pades.mjs`, `java-pades-client.mjs`
- `server/routes/flows/*` — niciun fișier
- `server/routes/*.mjs` — neatinse
- `server/services/*`
- `server/utils/*`
- `server/db/index.mjs` — nicio migrație
- Restul claselor CSS `.locked-bar` — doar adăugăm `.ok`, nu modificăm `.warn`/`.info`
- Restul branch-urilor din `openDoc` în doc.js — neatinse (pending_p2, returnat, completed)
- `setS` function în core.js — neatinsă
- `setLockedBar` function în doc.js — neatinsă (doar folosirea cu type='ok')
- `core.js` complete — neatins
- `list.js` complete — neatins
- `public/formular.html` — neatins

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
