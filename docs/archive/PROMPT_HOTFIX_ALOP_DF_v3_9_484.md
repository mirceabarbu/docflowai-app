# DocFlowAI — 🚨 v3.9.484 HOTFIX REGRESIE: ALOP nou deschide un DF anulat și-i face R1

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  HOTFIX REGRESIE — prioritate maximă. Frontend-only.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.483 → v3.9.484 (SW v199 → v200)
Branch: develop
Subiect: fix(alop): ALOP nou deschidea ultimul DF (anulat) din sesiune și-i
         genera Revizia 1 — alopDeschideDF reutiliza ST.docId['notafd']
         fără a verifica apartenența la ALOP sau statusul real
```

---

## 🐞 Simptom raportat

ALOP **nou** creat → click „Completează Document de Fundamentare" → se deschide
un **DF străin, ANULAT** (ultimul modificat în sesiune), iar sistemul generează
**Revizia 1** pornind de la el. Nu se creează un DF nou gol (R0) cum ar trebui.

NU e cauzat de modulul Registratură (fazele de registratură au fost NO-TOUCH
pe `alop`/`crud`/`lifecycle`). E un bug client-side preexistent în
`public/js/formular/alop.js`.

## 🔬 Cauza (confirmată pe cod)

`async function alopDeschideDF(alopId)` — pentru un ALOP nou serverul întoarce
corect `alop.df_id = null`. Logica:

```
if (alop.df_id)            → deschide DF-ul legat              [OK]
else if (ST.docId.notafd)  → „FIX 2": reutilizează DF sesiune  [BUG]
else                       → DF nou gol                        [OK]
```

În ramura „FIX 2", reutilizarea (`else`-ul intern) e blocată DOAR pentru
`docStatus==='aprobat'||docStatus==='transmis_flux'`. Un DF cu status
**`anulat`** (sau `refuzat`/`completed`/`inlocuit`/null) NU e exclus → cade pe
`else` → **re-leagă DF-ul mort la ALOP-ul nou și-l deschide**; logica de
revizie vede un document existent → generează R1.

Două defecte: (1) nu exclude statusurile moarte; (2) nu verifică deloc că
DF-ul din sesiune aparține *acestui* ALOP (un DF în lucru de la alt ALOP s-ar
lipi identic).

## ✅ Fix (chirurgical, frontend-only)

Reutilizarea DF-ului din sesiune se permite DOAR dacă **ambele**:
- DF-ul din sesiune aparținea *acestui* ALOP (`_alopContext.alopId` capturat
  ÎNAINTE de a fi suprascris === `alop.id`), ȘI
- statusul lui e cu adevărat în lucru: `draft` | `returnat` | `de_revizuit`.

Orice altceva → resetează contextul doc și creează DF nou gol (R0). Recuperarea
legitimă (DF creat în sesiunea curentă pentru ACELAȘI ALOP, când `link-df` pe
server a eșuat) rămâne funcțională.

---

## ⛔ ABSOLUTE — NU se ating

1. `server/` — **nimic**. Fix exclusiv `public/js/formular/alop.js`.
2. NO-TOUCH permanent: `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`,
   `java-pades-client.mjs`, `STSCloudProvider.mjs`, `lifecycle.mjs`,
   `crud.mjs`, `stampFooterOnPdf`.
3. Restul funcției `alopDeschideDF` (ramura `alop.df_id`, ramura `else` DF nou)
   — neatins.
4. Logica de revizie / `newDocFromList` / `openDocFromList` — neatinsă.
5. Niciun test existent șters / dezactivat.

---

## 📋 Modificări — `public/js/formular/alop.js`, funcția `alopDeschideDF`

### 1. Capturează ALOP-ul contextului ANTERIOR (înainte de suprascriere)

**Verificare context:**
```bash
grep -n "async function alopDeschideDF" public/js/formular/alop.js
grep -n "FIX 3: citim starea curentă din server" public/js/formular/alop.js
```

old_str:
```javascript
async function alopDeschideDF(alopId){
  try{
    // FIX 3: citim starea curentă din server — singura sursă de adevăr pentru df_id
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}`,{credentials:'include'});
```

new_str:
```javascript
async function alopDeschideDF(alopId){
  try{
    // HOTFIX v3.9.484: ALOP-ul căruia îi aparținea DF-ul din sesiune,
    // capturat ÎNAINTE ca _alopContext să fie suprascris mai jos.
    const _prevCtxAlop = window._alopContext && window._alopContext.alopId;
    // FIX 3: citim starea curentă din server — singura sursă de adevăr pentru df_id
    const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}`,{credentials:'include'});
```

### 2. Reutilizarea DF-ului din sesiune doar dacă e același ALOP ȘI status în lucru

**Verificare context:**
```bash
grep -n "FIX 2: DF creat în sesiunea curentă\|docStatus==='aprobat'||docStatus==='transmis_flux'" public/js/formular/alop.js
```

old_str:
```javascript
      // FIX 2: DF creat în sesiunea curentă dar link-df nu s-a salvat pe server
      const docStatus=ST.docStatus?.['notafd'];
      if(docStatus==='aprobat'||docStatus==='transmis_flux'){
        // Nu re-lega un DF aprobat — resetează și creează unul nou
```

new_str:
```javascript
      // FIX 2: DF creat în sesiunea curentă dar link-df nu s-a salvat pe server.
      // HOTFIX v3.9.484: reutilizează DOAR dacă DF-ul din sesiune aparținea
      // ACESTUI ALOP și e cu adevărat în lucru. Altfel (anulat/refuzat/aprobat/
      // alt ALOP/necunoscut) → DF nou gol, NU resuscita un document mort.
      const docStatus=ST.docStatus?.['notafd'];
      const _safeReuse = (_prevCtxAlop===alop.id)
        && ['draft','returnat','de_revizuit'].includes(docStatus);
      if(!_safeReuse){
        // Nu re-lega un DF nesigur — resetează și creează unul nou
```

> Restul blocului (reset + `newDocFromList()` în ramura `if`, re-link +
> `openDocFromList` în ramura `else`) rămâne **exact** cum e — se schimbă doar
> condiția care decide între cele două.

### 3. Bump versiune & cache busting

- `package.json`: `"version": "3.9.483",` → `"version": "3.9.484",`
- `public/sw.js`: `const CACHE_VERSION = 'docflowai-v199';` → `'docflowai-v200';`
- Cache busting:
```bash
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.483/\?v=3.9.484/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII

```bash
# 1. Fix aplicat
grep -c "_prevCtxAlop = window._alopContext" public/js/formular/alop.js     # 1
grep -c "const _safeReuse = (_prevCtxAlop===alop.id)" public/js/formular/alop.js  # 1
grep -c "\['draft','returnat','de_revizuit'\].includes(docStatus)" public/js/formular/alop.js  # 1
grep -c "if(!_safeReuse){" public/js/formular/alop.js                       # 1
# Vechea condiție fragilă a dispărut:
grep -c "if(docStatus==='aprobat'||docStatus==='transmis_flux'){" public/js/formular/alop.js  # 0

# 2. Restul funcției intact
grep -c "newDocFromList()" public/js/formular/alop.js                       # ≥ 2 (neschimbat)
grep -c "link-df" public/js/formular/alop.js                                # neschimbat (ramura else)

# 3. Versiune + SW + cache busting
grep '"version"' package.json | head -1            # "version": "3.9.484",
grep "^const CACHE_VERSION" public/sw.js           # docflowai-v200
grep -rE "\?v=3\.9\.483" public/*.html | wc -l     # 0

# 4. NO-TOUCH — server complet neatins
git diff develop --name-only | grep -c "^server/"  # 0
git diff develop --name-only
# Așteptat: doar public/js/formular/alop.js, package.json, public/sw.js,
#           public/*.html (cache busting)

# 5. Syntax + teste
node --check public/sw.js && echo "OK sw"
npm test
# Așteptat: verde, fără regresii (≥ 589)
```

---

## 📊 RAPORT FINAL

```
═══════════════════════════════════════════════════════════
RAPORT FINAL — v3.9.484 HOTFIX alopDeschideDF
═══════════════════════════════════════════════════════════
[ ] _prevCtxAlop capturat înainte de suprascrierea _alopContext
[ ] Reutilizare DF sesiune doar dacă (_prevCtxAlop===alop.id) ȘI
    status ∈ {draft,returnat,de_revizuit}; altfel DF nou gol
[ ] Vechea condiție aprobat/transmis_flux eliminată (grep = 0)
[ ] Restul funcției (DF nou, re-link, alop.df_id) neatins
[ ] server/ complet neatins (git diff --name-only ^server/ = 0)
[ ] package.json 3.9.484 + sw v200 + cache busting (0 ?v=3.9.483)
[ ] VERIFICĂRILE 1–5 trec
[ ] npm test VERDE (≥ 589) — output atașat
[ ] git push origin develop

Smoke staging (Mircea) — REPRODUCERE REGRESIE:
  [ ] Deschid un DF, îl ANULEZ (rămâne ca „ultimul modificat")
  [ ] Creez un ALOP NOU → „Completează DF" → se deschide DF NOU GOL,
      Revizia 0, NU DF-ul anulat, NU R1   ← criteriul de succes
  [ ] ALOP cu DF deja legat (alop.df_id) → deschide acel DF (neschimbat)
  [ ] Recuperare legitimă: creez DF pt ALOP-X în sesiune, simulez link-df
      eșuat, reintru pe ALOP-X → re-leagă același DF (neschimbat)
  [ ] Flux emis vechi / semnare STS — neafectat (fix e doar UI ALOP)

Fișiere modificate: ____   OBSERVAȚII: ____
═══════════════════════════════════════════════════════════
```

---

## 🔒 CONSTRÂNGERI ABSOLUTE

1. develop only. Niciun checkout/merge/push pe `main`.
2. Fix exclusiv `public/js/formular/alop.js` (+ bump versiune + cache busting).
   `server/` complet neatins.
3. Se schimbă DOAR condiția de reutilizare; ambele ramuri (reset+nou /
   re-link+deschide) rămân exact cum sunt.
4. NU resuscita niciodată un DF mort (anulat/refuzat/aprobat/completed) și
   NU lega un DF de alt ALOP.
5. `npm test` verde, fără regresii. Niciun test șters.
6. La final, după teste verzi: `git add -A && git commit && git push origin develop`.
```
