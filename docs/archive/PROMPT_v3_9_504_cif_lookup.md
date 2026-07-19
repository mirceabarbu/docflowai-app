# PROMPT — v3.9.504 — ORD: CIF lookup → auto-fill beneficiar (local → ANAF)

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

**PREREQUISITE:** v3.9.503 e merge-uit pe develop și `git pull origin develop` rulat local.

============================================================
## CONTEXT

În formularul ORD secțiunea "Compartiment specialitate", userul completează manual câmpurile beneficiar (denumire, CIF, IBAN, bancă). Autocomplete existent pe denumire (`o-benef`) caută în tabela `beneficiari`. La submit, `_saveBeneficiarIfNew()` (list.js:161) salvează combinația în tabela locală.

Lipsește: lookup automat după CIF — userul are CIF-ul (din factură/contract) și ar trebui să primească denumirea + IBAN/bancă auto-completate. Infrastructura există deja:

- **Tabela `beneficiari`** (org_id, denumire, cif, iban, banca) — migrația 051
- **GET `/api/beneficiari?q=`** — search după denumire/cif/iban
- **GET `/api/v4/verify/cui?cui=`** — apelează ANAF prin `lookupCui`, returnează `{ok, data: {name, cui, address, ...}}`

Comportament dorit (toate confirmate cu user):

1. **Trigger: on blur** pe câmpul CIF (`o-cifb`) — fără apeluri inutile la ANAF, natural pentru tastare
2. **Suprascrie agresiv**: dacă userul schimbă CIF-ul, lookup-ul rescrie denumire + IBAN + bancă (din local) sau doar denumirea (din ANAF — nu returnează IBAN). User a schimbat CIF DELIBERAT → vrea date noi.
3. **Feedback minimal**: spinner inline lângă CIF + setS status bar pentru mesaj scurt
4. **Strip `RO` prefix**: `RO22270501` → `22270501` (auto-normalize)
5. **Validare format**: `^\d{2,10}$` înainte de orice apel (skip silent pe invalid)
6. **Fallback chain**: tabela locală **înainte** de ANAF. Local hit → toate câmpurile; ANAF hit → doar denumire (IBAN/bancă rămân neatinse manual).
7. **Câmpurile rămân editabile** după auto-fill (user poate corecta IBAN dacă firma a schimbat banca)

NB: `_saveBeneficiarIfNew()` existent (list.js:161) **rămâne neatins** — salvează în local la submit orice combinație nouă (CIF/IBAN/bancă), deci la următoarea folosire CIF-ul se va găsi local cu IBAN/bancă populate.

============================================================
## PAS 1 — HTML: adaugă `onblur` + spinner pe `o-cifb`

În `public/formular.html`, localizează linia 702-703:

```html
        <div class="dl req">CIF beneficiar</div>
        <input id="o-cifb" class="di" maxlength="10"/>
```

Înlocuiește cu:

```html
        <div class="dl req">CIF beneficiar <span id="o-cifb-spin" style="display:none;color:var(--df-text-3);font-size:.78rem;margin-left:6px">⏳</span></div>
        <input id="o-cifb" class="di" maxlength="12" onblur="window._lookupByCif&&window._lookupByCif()" autocomplete="off"/>
```

NB: `maxlength="12"` ca să permită prefix `RO` din scriere (e strippat în JS). `autocomplete="off"` previne sugestiile browser-ului care interferează cu UX-ul nostru de lookup.

Verifică:
```bash
grep -n "o-cifb-spin\|window._lookupByCif" public/formular.html
```

Expected: 2 match-uri (span + onblur).

============================================================
## PAS 2 — JS: funcția `_lookupByCif` în `public/js/formular/list.js`

În `public/js/formular/list.js`, localizează blocul existent cu autocomplete beneficiar (în jurul liniei 125-158 — `_searchBenef`, `selectBenef`). Imediat după `selectBenef` (înainte de event listener document click la linia 155), adaugă:

```js
// ── v3.9.504: CIF lookup → auto-fill beneficiar (local → ANAF fallback) ────────
// Trigger: onblur pe o-cifb (vezi formular.html). Suprascrie agresiv denumire+IBAN+bancă
// din local; doar denumire din ANAF (ANAF nu returnează IBAN). Strip RO prefix.
// Skip silent pe format invalid (^\d{2,10}$).
async function _lookupByCif(){
  const cifEl=document.getElementById('o-cifb');
  if(!cifEl)return;
  // Normalize: trim + uppercase + strip "RO" prefix
  let cif=(cifEl.value||'').trim().toUpperCase().replace(/^RO\s*/,'');
  cifEl.value=cif;  // afișează valoarea normalizată
  if(!/^\d{2,10}$/.test(cif))return;  // format invalid — skip silent

  const spin=document.getElementById('o-cifb-spin');
  const showSpin=v=>{if(spin)spin.style.display=v?'inline-block':'none';};
  const setF=(id,val)=>{const e=document.getElementById(id);if(e&&val!=null)e.value=val;};
  const _setS=(msg,type)=>{if(typeof window.setS==='function')window.setS(msg,type);};

  showSpin(true);
  let resolved=false;

  // 1. Caută local întâi (după CIF exact match)
  try{
    const r=await fetch('/api/beneficiari?q='+encodeURIComponent(cif),{credentials:'include'});
    if(r.ok){
      const j=await r.json();
      const match=(j.beneficiari||[]).find(b=>String(b.cif||'')===cif);
      if(match){
        setF('o-benef',match.denumire||'');
        setF('o-iban',match.iban||'');
        setF('o-banca',match.banca||'');
        _setS('Beneficiar găsit local: '+(match.denumire||cif),'ok');
        resolved=true;
      }
    }
  }catch(_){/* fall through to ANAF */}

  // 2. Fallback ANAF doar dacă nu am găsit local
  if(!resolved){
    _setS('Verificare CIF la ANAF...','info');
    try{
      const r=await fetch('/api/v4/verify/cui?cui='+encodeURIComponent(cif),{credentials:'include'});
      if(r.ok){
        const j=await r.json();
        // anafClient returnează { ok: true, data: { name, cui, address, ... } }
        if(j.ok&&j.data&&j.data.name){
          setF('o-benef',j.data.name);
          // ANAF NU returnează IBAN/bancă — lăsăm pe userul să completeze manual
          _setS('Denumire preluată ANAF: '+j.data.name,'ok');
          resolved=true;
        } else {
          _setS('CIF '+cif+' negăsit la ANAF','err');
        }
      } else {
        _setS('Eroare verificare ANAF (HTTP '+r.status+')','err');
      }
    }catch(e){
      _setS('Eroare rețea verificare ANAF','err');
    }
  }

  showSpin(false);
}
window._lookupByCif=_lookupByCif;
```

Verifică:
```bash
node --check public/js/formular/list.js 2>&1 | head -5 || echo "(node --check pe fișier JS frontend nu funcționează direct — verifică sintaxă în următoarea iterație)"
grep -n "v3.9.504\|_lookupByCif" public/js/formular/list.js
```

Expected: minim 1 match v3.9.504 (comentariu); 2+ match-uri `_lookupByCif` (declarare + window assign).

============================================================
## PAS 3 — Test guard

Creează `server/tests/unit/cif-lookup-frontend.test.mjs`:

```js
/**
 * v3.9.504 — guard că _lookupByCif e prezent în list.js cu logica corectă:
 * - trigger onblur pe o-cifb (din HTML)
 * - strip RO prefix
 * - validare regex ^\d{2,10}$
 * - chain local → ANAF fallback
 * - suprascrie denumire+IBAN+bancă din local, doar denumire din ANAF
 *
 * Test string-match. Comportament real testabil doar manual pe staging
 * (depinde de ANAF live + tabela locală).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('CIF lookup auto-fill (v3.9.504)', () => {
  it('HTML: o-cifb are onblur=_lookupByCif și spinner span', () => {
    const html = readFileSync(path.join(REPO, 'public/formular.html'), 'utf8');
    expect(html).toMatch(/id="o-cifb"[^>]*onblur="[^"]*_lookupByCif[^"]*"/);
    expect(html).toMatch(/id="o-cifb-spin"/);
  });

  it('list.js: funcția _lookupByCif e declarată și expusă pe window', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.504/);
    expect(src).toMatch(/async function _lookupByCif\(\)/);
    expect(src).toMatch(/window\._lookupByCif\s*=\s*_lookupByCif/);
  });

  it('list.js: strip RO prefix și validare regex', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // RO prefix strip
    expect(src).toMatch(/replace\(\/\^RO\\s\*\//);
    // Validare format ^\d{2,10}$
    expect(src).toMatch(/\/\^\\d\{2,10\}\\\$\//);
  });

  it('list.js: chain local first, ANAF fallback only if not found', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // Bloc local înainte de ANAF
    const m = src.match(/async function _lookupByCif\(\)[\s\S]*?\n\}\s*\n\s*window\._lookupByCif/);
    expect(m, 'corpul funcției _lookupByCif nu a fost găsit').toBeTruthy();
    const body = m[0];
    const idxLocal = body.indexOf('/api/beneficiari');
    const idxAnaf  = body.indexOf('/api/v4/verify/cui');
    expect(idxLocal, '/api/beneficiari trebuie să fie în corp').toBeGreaterThan(-1);
    expect(idxAnaf,  '/api/v4/verify/cui trebuie să fie în corp').toBeGreaterThan(-1);
    expect(idxLocal, 'local trebuie apelat ÎNAINTE de ANAF').toBeLessThan(idxAnaf);
    // ANAF e gated de `if(!resolved)`
    expect(body).toMatch(/if\(!resolved\)/);
  });

  it('list.js: ANAF response folosește j.data.name (nu denumire)', () => {
    // Confirmare că folosim contractul corect ANAF (anafClient.mjs returnează data.name)
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/j\.data\.name/);
  });

  it('list.js: local hit completează denumire+IBAN+bancă; ANAF hit doar denumire', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // În blocul local: setF pentru toate 3 câmpuri
    const localBlock = src.match(/\/\/ 1\. Caută local[\s\S]*?\}catch/);
    expect(localBlock, 'blocul local nu e găsit').toBeTruthy();
    expect(localBlock[0]).toMatch(/setF\('o-benef'/);
    expect(localBlock[0]).toMatch(/setF\('o-iban'/);
    expect(localBlock[0]).toMatch(/setF\('o-banca'/);

    // În blocul ANAF: setF DOAR pentru denumire (NU pentru IBAN/bancă)
    const anafBlock = src.match(/\/\/ 2\. Fallback ANAF[\s\S]*?showSpin\(false\)/);
    expect(anafBlock, 'blocul ANAF nu e găsit').toBeTruthy();
    expect(anafBlock[0]).toMatch(/setF\('o-benef'/);
    // IBAN și bancă NU trebuie atinse în blocul ANAF
    const ibanInAnaf = anafBlock[0].match(/setF\('o-iban'/);
    const bancaInAnaf = anafBlock[0].match(/setF\('o-banca'/);
    expect(ibanInAnaf, 'IBAN NU trebuie suprascris din ANAF (ANAF nu returnează IBAN)').toBeNull();
    expect(bancaInAnaf, 'Bancă NU trebuie suprascrisă din ANAF').toBeNull();
  });
});
```

Verifică:
```bash
node --check server/tests/unit/cif-lookup-frontend.test.mjs
npx vitest run server/tests/unit/cif-lookup-frontend.test.mjs
```

Expected: cele 6 teste trec.

============================================================
## PAS 4 — npm test verde

```bash
npm test 2>&1 | tail -30
```

Expected: +6 teste față de v3.9.503. Toate verzi.

============================================================
## PAS 5 — Version bump

În `package.json`: `3.9.503` → `3.9.504`.
În `public/sw.js`: `CACHE_VERSION` `docflowai-v218` → `docflowai-v219`.

============================================================
## PAS 6 — Commit + push develop

```bash
git status
git add public/formular.html \
        public/js/formular/list.js \
        server/tests/unit/cif-lookup-frontend.test.mjs \
        package.json public/sw.js
git commit -m "feat(ord): CIF lookup auto-fill beneficiar — local → ANAF (v3.9.504)

În formularul ORD, userul completa manual toate câmpurile beneficiar
(denumire, CIF, IBAN, bancă) sau folosea autocomplete pe denumire.
Lipsea workflow-ul natural: user are CIF din factură → vrea restul
auto-completat.

Fix: trigger onblur pe câmpul CIF (o-cifb) declanșează _lookupByCif:

1. Normalize: trim + uppercase + strip 'RO' prefix
2. Validare format ^\\d{2,10}$ — skip silent pe invalid
3. Caută în tabela locală beneficiari (după CIF exact match)
   - Hit → completează denumire + IBAN + bancă (tot)
4. Dacă nu local: fallback ANAF prin /api/v4/verify/cui
   - Hit → completează DOAR denumire (j.data.name)
   - IBAN/bancă rămân neatinse pentru completare manuală
5. Feedback: spinner inline ⏳ lângă label + setS status messages

Suprascrie agresiv (user a schimbat CIF deliberat → vrea date noi).
Câmpurile rămân editabile. Salvarea auto în tabela locală
(_saveBeneficiarIfNew la submit P2) e neatinsă — următoarea folosire
a aceluiași CIF va găsi totul local.

Infrastructură backend deja existentă (zero modificări):
- GET /api/beneficiari?q= (search)
- GET /api/v4/verify/cui (ANAF wrapper prin lookupCui)
- Tabela beneficiari (migrația 051)

Test: cif-lookup-frontend.test.mjs (6 cazuri string-match)."
git push origin develop
```

============================================================
## RAPORT FINAL

1. Versiune în `package.json` și `CACHE_VERSION` în `sw.js`?
2. Câte teste rulează? Toate verzi? Confirmă că testele din v3.9.497-503 trec.
3. SHA commit pushed pe develop?
4. `grep -c "v3.9.504" public/formular.html public/js/formular/list.js` — minim 1 per fișier (2 atinse)?
5. `git status` → working tree clean?

============================================================
## TESTARE MANUALĂ STAGING (după deploy)

1. **Local hit**: deschide formular ORD nou. Scrie un CIF care există deja în tabela `beneficiari` (poți verifica cu `SELECT cif, denumire FROM beneficiari LIMIT 5` pe staging DB). Tab → toate câmpurile (denumire + IBAN + bancă) se completează. Status bar: "Beneficiar găsit local: ..."

2. **ANAF hit**: scrie un CIF de firmă reală română care NU e în tabela locală (ex: `13548146` Dedeman). Tab → denumirea apare, IBAN/bancă rămân goale. Status: "Denumire preluată ANAF: ...". User completează manual IBAN/bancă. La submit → se salvează totul în local pentru data viitoare.

3. **RO prefix**: scrie `RO13548146`. Tab → câmpul se normalizează la `13548146` și lookup-ul rulează corect.

4. **CIF invalid**: scrie `abc123` sau gol. Tab → nimic nu se întâmplă (skip silent, fără erori).

5. **ANAF down**: dacă vrei testat fail-safe, simulează: scrie un CIF care ar trebui să existe dar ANAF e indisponibil → status bar "Eroare verificare ANAF" + spinner se oprește, câmpurile rămân ce-au fost.

6. **Override**: completează manual denumirea, apoi schimbă CIF cu altă firmă → lookup-ul SUPRASCRIE denumirea cu cea găsită (comportament intenționat — user a schimbat CIF deliberat).

============================================================
## CONSTRÂNGERI ABSOLUTE — NU MODIFICA

- `server/signing/providers/STSCloudProvider.mjs`, `pades.mjs`, `java-pades-client.mjs`
- `server/routes/flows/*` — niciun fișier
- `server/routes/auth.mjs`, `convert.mjs`, `alop.mjs`
- `server/routes/formulare-db.mjs` — endpoint-urile `/api/beneficiari` și `/api/v4/verify/cui` rămân neatinse (folosim ce există)
- `server/services/*` — niciun fișier (anafClient, ibanValidator, coherence rămân intacte)
- `server/utils/*`
- `server/db/index.mjs` — niciun migration nou (tabela beneficiari există din 051)
- `public/js/formular/core.js` — neatins (helper `setS` accesat via `window.setS`)
- `public/js/formular/doc.js` — neatins
- `_searchBenef`, `selectBenef`, `_saveBeneficiarIfNew` în list.js — rămân exact cum sunt (nu modificăm autocomplete-ul existent pe denumire; doar adăugăm _lookupByCif separat)
- Restul HTML-ului din `public/formular.html` — neatins

Niciun `git checkout main`, niciun merge towards main, niciun push pe alt branch decât develop.
