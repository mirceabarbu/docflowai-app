# ⚠️ DEVELOP ONLY — Fix BUG MAJOR: butonul „Trimite la Responsabil CAB" dispare după auto-save DF — v3.9.534

⚠️ **BRANCH `develop` EXCLUSIV.** NU merge / push / checkout pe `main`.
`main` = producție, gestionat manual de Mircea.

⛔ **ZONE INTERZISE — NU ATINGE:**
```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/services/formular-capabilities.mjs   ← logica server e CORECTĂ, nu o atinge
```

## Diagnostic (cauză root confirmată)

După refactorul „Etapa 3" (capabilities calculate server-side), `renderActions()`
din `doc.js` afișează butonul DOAR dacă `caps.can_send_p2 === true`, unde
`caps = ST.docCapabilities[ft]`.

`saveDoc()` (manual, doc.js) actualizează `ST.docCapabilities[ft]` din răspuns
înainte de `renderActions`. **`_autoSaveDb()` (list.js) NU o face.**

Secvența bug-ului la creare DF nou:
1. DF blank (fără docId) → `renderActions` ramura `!docId` afișează butonul.
2. Tastezi → după 800ms auto-save POST creează DF-ul, setează `ST.docId[ft]`,
   `ST.docStatus[ft]='draft'`, `ST.docRole[ft]='p1'`, apoi apelează
   `renderActions(ft)` — DAR `ST.docCapabilities[ft]` rămâne stale/null.
3. `renderActions` rulează acum cu `docId` setat + `caps={}` → toate ramurile
   informaționale sunt false → asamblare goală → `div.innerHTML=''` →
   **butonul dispare.**

**Fix:** `_autoSaveDb` setează `ST.docCapabilities[ft]` din `j.document.capabilities`
pe ambele ramuri (POST înainte de `renderActions`, PUT pentru consistență), exact
ca `saveDoc`. Schimbare frontend → bump versiune + cache busting.

═══════════════════════════════════════════════════════════════

## PAS 0 — Stare curată + baseline

```bash
git rev-parse --abbrev-ref HEAD          # develop
git status                               # clean
npm test                                 # verde, fără regresii (baseline)
```

═══════════════════════════════════════════════════════════════

## PAS 1 — Fix ramura POST în `_autoSaveDb` (public/js/formular/list.js)

old_str:
```
      if(r.ok&&j.ok){
        ST.docId[ft]=j.document.id;ST.docStatus[ft]='draft';ST.docRole[ft]='p1';
        renderActions(ft);
```
new_str:
```
      if(r.ok&&j.ok){
        ST.docId[ft]=j.document.id;ST.docStatus[ft]='draft';ST.docRole[ft]='p1';
        // FIX v3.9.534 (buton "Trimite la Responsabil CAB" dispărea după auto-save):
        // actualizează capabilities din răspuns ÎNAINTE de renderActions. După ce docId
        // devine setat, renderActions rula cu caps={} (stale) → bara de acțiuni goală.
        ST.docCapabilities=ST.docCapabilities||{};
        ST.docCapabilities[ft]=j.document?.capabilities||null;
        renderActions(ft);
```

═══════════════════════════════════════════════════════════════

## PAS 2 — Fix ramura PUT în `_autoSaveDb` (consistență; același fișier)

old_str:
```
      if(r.ok&&j.ok){
        ST.docStatus[ft]=j.document.status;
        // v3.9.518: safety net — dacă linkul ratează pe POST (eroare rețea, race
```
new_str:
```
      if(r.ok&&j.ok){
        ST.docStatus[ft]=j.document.status;
        // FIX v3.9.534: ține capabilities în sincron și pe PUT (status se poate schimba).
        ST.docCapabilities=ST.docCapabilities||{};
        ST.docCapabilities[ft]=j.document?.capabilities||null;
        // v3.9.518: safety net — dacă linkul ratează pe POST (eroare rețea, race
```

═══════════════════════════════════════════════════════════════

## PAS 3 — Test de regresie (server/tests/unit/alop-autosave-link.test.mjs)

Inserează un nou `it(...)` între testul „cel puțin 2 apeluri _alopLinkDoc" și
testul „doc.js: saveDoc ...".

old_str:
```
    expect(count, '_alopLinkDoc trebuie apelat de minim 2 ori în _autoSaveDb (POST + PUT)').toBeGreaterThanOrEqual(2);
  });

  it('doc.js: saveDoc apelează _alopLinkDoc și pe ramura PUT (safety net)', () => {
```
new_str:
```
    expect(count, '_alopLinkDoc trebuie apelat de minim 2 ori în _autoSaveDb (POST + PUT)').toBeGreaterThanOrEqual(2);
  });

  it('list.js: _autoSaveDb setează docCapabilities din răspuns pe POST înainte de renderActions (fix v3.9.534 buton dispărut)', () => {
    const m = LIST.match(/async function _autoSaveDb\(ft\)\{[\s\S]*?\n\}\s*\nfunction _scheduleAutoSaveDb/);
    expect(m, 'corpul _autoSaveDb nu a fost găsit').toBeTruthy();
    const body = m[0];
    // Caps trebuie setate din j.document.capabilities, altfel renderActions rulează
    // cu caps={} și butonul "Trimite la Responsabil CAB" dispare după auto-save.
    expect(body).toMatch(/docCapabilities\[ft\]\s*=\s*j\.document\?\.\s*capabilities/);
    // Pe ramura POST: atribuirea caps apare ÎNAINTEA primului renderActions.
    const idxCaps   = body.indexOf('docCapabilities[ft]=j.document?.capabilities');
    const idxRender = body.indexOf('renderActions(ft)');
    expect(idxCaps).toBeGreaterThan(-1);
    expect(idxRender).toBeGreaterThan(-1);
    expect(idxCaps).toBeLessThan(idxRender);
  });

  it('doc.js: saveDoc apelează _alopLinkDoc și pe ramura PUT (safety net)', () => {
```

═══════════════════════════════════════════════════════════════

## PAS 4 — Verificare

```bash
npm run check        # node --check trece
npm test             # verde, fără regresii + noul test trece
git diff --stat HEAD
```

Dacă pică ceva → `git restore .` și raportează. NU relaxa testul.

═══════════════════════════════════════════════════════════════

## PAS 5 — Bump versiune + cache busting (frontend changed)

### 5a. package.json
old_str:
```
  "version": "3.9.533",
```
new_str:
```
  "version": "3.9.534",
```

### 5b. public/sw.js — CACHE_VERSION
old_str:
```
const CACHE_VERSION = 'docflowai-v229';
```
new_str:
```
const CACHE_VERSION = 'docflowai-v230';
```

### 5c. public/formular.html — ?v= pe list.js (singurul fișier atins)
old_str:
```
<script src="/js/formular/list.js?v=3.9.528" defer></script>
```
new_str:
```
<script src="/js/formular/list.js?v=3.9.534" defer></script>
```

═══════════════════════════════════════════════════════════════

## PAS 6 — Commit + push (DOAR develop)

```bash
git add -A
git commit -m "fix(df): butonul Trimite la Responsabil CAB dispărea după auto-save DF v3.9.534

_autoSaveDb (list.js) nu actualiza ST.docCapabilities din răspuns înainte de
renderActions (spre deosebire de saveDoc). După ce docId devenea setat la
auto-save POST, renderActions rula cu caps={} → bara de acțiuni goală →
butonul dispărea la DF nou. Setează caps din j.document.capabilities pe POST
și PUT. +1 test regresie (text-match pe sursă, ca testele _alopLinkDoc)."
git push origin develop
```

═══════════════════════════════════════════════════════════════

## ⛔ PROHIBIT

- ⛔ NU modifica `server/services/formular-capabilities.mjs` (logica server e corectă).
- ⛔ NU modifica `renderActions` în doc.js (problema nu e acolo — e în consumatorul auto-save).
- ⛔ NU atinge fișierele din ZONE INTERZISE.
- ⛔ NU merge / push / checkout pe `main`.

═══════════════════════════════════════════════════════════════

## RAPORT FINAL

1. Fișiere modificate (path + linii +/-).
2. `npm run check`: PASS/FAIL.
3. `npm test`: X teste, verde, fără regresii (noul test inclus).
4. Hash commit + confirmare push pe `develop`.
5. Versiune publicată (3.9.534) + sw v230.

═══════════════════════════════════════════════════════════════

## Verificare manuală pe staging (după redeploy)

1. Hard-refresh (Ctrl+Shift+R) ca să prindă sw v230 + list.js?v=3.9.534.
2. ALOP nou → Completează DF → tastează în Secțiunea A → așteaptă auto-save
   (badge „💾 HH:MM"). Butonul „📨 Trimite la Responsabil CAB" trebuie să RĂMÂNĂ
   vizibil în bara de acțiuni a DF-ului.
3. Reîncarcă pagina DF-ului (openDoc) → butonul tot acolo (verifică ambele căi).
4. Click pe buton → modalul P2 se deschide (regresia veche cu `_validateDf`
   e separată; dacă modalul tot nu apare, raportezi — alt fix).
