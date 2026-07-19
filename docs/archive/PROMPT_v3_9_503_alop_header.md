# PROMPT — v3.9.503 — ALOP detail header: afișează valoare estimată + DF actual

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.502 e merge-uit pe develop și `git pull origin develop` rulat local.

============================================================
## CONTEXT

În `renderAlopDetail` (`public/js/formular/alop.js:567`), header-ul detaliilor ALOP afișează doar `valoare_totala` (estimat la creare):
```js
${a.valoare_totala?`<div style="font-size:.85rem;color:#10b981;margin-top:4px;font-weight:600">${fmtRON(a.valoare_totala)}</div>`:''}
```

Valoarea efectivă din DF-ul activ (`a.df_valoare`) apare doar în cardul de jos "VALOARE DF" (linia 591). Userul observă discrepanța (estimat 2.500.000 vs DF curent 3.000.000 după revizie) doar dacă scrolează la card.

Fix: în header, lângă valoarea estimată, afișează valoarea DF-ului activ când există. Două coloane semantice diferite (verde pentru estimat — pre-existent, mov pentru DF — consistent cu cardul de jos).

============================================================
## PAS 1 — Modificare `public/js/formular/alop.js`

Localizează linia 567 în `renderAlopDetail`:

```js
          ${a.valoare_totala?`<div style="font-size:.85rem;color:#10b981;margin-top:4px;font-weight:600">${fmtRON(a.valoare_totala)}</div>`:''}
```

Înlocuiește cu:

```js
          ${(() => {
            // v3.9.503: în header arătăm valoarea estimată (la creare) + valoarea
            // DF-ului activ (din cea mai recentă revizie). Userul vede ambele în
            // header fără să scrolează la cardul "VALOARE DF" de jos. Util când
            // revizia DF a schimbat valoarea față de estimatul inițial.
            const _vEst = parseFloat(a.valoare_totala || 0);
            const _vDf  = parseFloat(a.df_valoare || 0);
            const _hasEst = _vEst > 0;
            const _hasDf  = _vDf > 0 && !!a.df_id;
            if (!_hasEst && !_hasDf) return '';
            const _est = _hasEst
              ? `<span style="color:#10b981;font-weight:600" title="Valoare estimată la creare ALOP">${fmtRON(_vEst)}<span style="color:var(--df-text-3);font-weight:400;font-size:.78rem;margin-left:4px">estimat</span></span>`
              : '';
            const _df = _hasDf
              ? `<span style="color:#b0a0ff;font-weight:600" title="Valoare din DF activ (cea mai recentă revizie)">${fmtRON(_vDf)}<span style="color:var(--df-text-3);font-weight:400;font-size:.78rem;margin-left:4px">DF actual</span></span>`
              : '';
            const _sep = (_est && _df) ? '<span style="color:var(--df-text-4);margin:0 8px">·</span>' : '';
            return `<div style="font-size:.85rem;margin-top:4px;display:flex;align-items:center;flex-wrap:wrap">${_est}${_sep}${_df}</div>`;
          })()}
```

NB: schimbarea folosește exact aceleași date deja disponibile pe `a` (provenite din `/api/alop/:id` — fără modificare backend). `fmtRON` e helper local declarat la linia 461. Culorile `#10b981` (verde) și `#b0a0ff` (mov) sunt deja folosite în acest fișier — consistent cu vocabularul vizual existent (verde = bani estimați/valoare totală, mov = DF).

Verifică:
```bash
grep -n "v3.9.503" public/js/formular/alop.js
grep -n "estimat\|DF actual" public/js/formular/alop.js | head -5
```

Expected: 1 match comentariu v3.9.503; 2 match-uri pentru cele 2 label-uri noi.

============================================================
## PAS 2 — Test unit guard

Creează `server/tests/unit/alop-header-df-actual.test.mjs`:

```js
/**
 * v3.9.503 — guard că header-ul ALOP detail afișează valoarea estimată
 * + valoarea DF actual (când DF există cu valoare > 0).
 *
 * Test string-match pentru a păzi împotriva eliminării accidentale.
 * Render efectiv DOM nu e testabil aici (renderAlopDetail e funcție DOM).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ALOP detail header — valoare estimată + DF actual (v3.9.503)', () => {
  it('comentariul v3.9.503 e prezent în renderAlopDetail', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.503/);
  });

  it('header-ul include atât valoarea estimată cât și DF actual', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    // Localizează blocul IIFE care construiește valoarea în header
    const m = src.match(/v3\.9\.503[\s\S]{0,2000}?return\s*''[\s\S]{0,800}/);
    expect(m, 'bloc IIFE v3.9.503 nu a fost găsit').toBeTruthy();
    const block = m[0];
    expect(block).toMatch(/valoare_totala/);
    expect(block).toMatch(/df_valoare/);
    expect(block).toMatch(/estimat/);
    expect(block).toMatch(/DF actual/);
  });

  it('guard logic: hasEst și hasDf bazat pe parseFloat + df_id', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/_hasEst\s*=\s*_vEst\s*>\s*0/);
    expect(src).toMatch(/_hasDf\s*=\s*_vDf\s*>\s*0\s*&&\s*!!a\.df_id/);
  });
});
```

Verifică:
```bash
node --check server/tests/unit/alop-header-df-actual.test.mjs
npx vitest run server/tests/unit/alop-header-df-actual.test.mjs
```

Expected: cele 3 teste trec.

============================================================
## PAS 3 — npm test verde

```bash
npm test 2>&1 | tail -30
```

Expected: +3 teste față de v3.9.502. Toate verzi.

============================================================
## PAS 4 — Version bump

În `package.json`: `3.9.502` → `3.9.503`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v217` → `docflowai-v218`.

============================================================
## PAS 5 — Commit + push develop

```bash
git status
git add public/js/formular/alop.js \
        server/tests/unit/alop-header-df-actual.test.mjs \
        package.json public/sw.js
git commit -m "ux(alop): header detail afișează valoare estimată + DF actual (v3.9.503)

În renderAlopDetail header-ul afișa doar valoarea estimată introdusă la
creare ALOP (a.valoare_totala). Valoarea efectivă din DF-ul activ
(a.df_valoare, schimbabilă prin revizii) apărea doar în cardul 'VALOARE
DF' de jos. Userul observa discrepanța (ex: estimat 2.500.000 vs DF
revizie 3.000.000) doar dacă scrolea.

Fix: în header, lângă valoarea estimată (verde, existentă), afișează și
valoarea DF actual (mov, consistent cu cardul de jos). Două label-uri
scurte ('estimat' / 'DF actual') clarifică distincția. Title tooltip
pentru fiecare. Bloc IIFE — render condiționat fără DF se păstrează
identic cu vechiul (just valoarea estimată).

Zero modificări backend — folosește datele deja prezente pe response-ul
/api/alop/:id. Test unit guard string-match.

Test: alop-header-df-actual.test.mjs (3 cazuri guard)."
git push origin develop
```

============================================================
## RAPORT FINAL

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi?
3. SHA commit pushed pe develop?
4. `grep -c "v3.9.503" public/js/formular/alop.js` → 1 match?
5. `git status` → working tree clean?

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`
- `server/routes/flows/cloud-signing.mjs`, `bulk-signing.mjs`
- `server/signing/pades.mjs`, `java-pades-client.mjs`
- `server/routes/flows/signing.mjs`, `lifecycle.mjs`, `crud.mjs`
- `server/routes/auth.mjs`
- `server/utils/*`
- `server/services/*`
- `server/db/index.mjs` — nicio migrație nouă în acest sprint
- `server/routes/alop.mjs` — backend ALOP rămâne intact (folosim datele existente)
- `public/formular.html` — niciun id schimbat
- `renderAlopDetail` în restul fișierului — atingem DOAR blocul `${a.valoare_totala?...}` de la linia 567
- Cardurile de jos "Valoare DF / Valoare ORD / Sumă plătită" — neatinse (rămân ca acum, datele se repetă intentionat)
- Testele existente — niciun fișier modificat

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
