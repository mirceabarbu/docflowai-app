# PROMPT Claude Code — Aliniere filter buttons cu height EXPLICIT (v3.9.489)

> ⚠️ BRANCH: `develop` EXCLUSIV.
> Patch final pentru alinierea butoanelor din filter bar Registratură.
> Abordare brută, predictibilă — height EXPLICIT pe butoane + stretch
> pe wrapper. Fără calcule de line-height/padding/font-size care s-au
> dovedit fragile în v3.9.486-488.

## Diagnostic final

`.df-frow` are conținut label (~23px) + input (~37px) = ~60px.
`.df-filter-actions` din v3.9.488 are doar butoane (~37px) cu
`align-self: flex-end` → wrapper scund, butoanele apar mai jos decât
inputurile cu ~5px (observat vizual de utilizator).

**Rezolvare: forțez wrapper-ul să fie la fel de înalt ca rândul flex
(`align-self: stretch`), apoi aliniez butoanele la fundul wrapper-ului
(`align-items: flex-end`). Butoanele au înălțime EXPLICITĂ 38px (≈
înălțime input), zero ambiguitate de calcul.**

## ⛔ NO-TOUCH

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/db/migrate.mjs
migrările 000…078
componenta registratura-action-modal.js
restul componentelor și paginilor
```

## Modificări (3 fișiere)

### 1. `public/css/df/components.css` — rescrie clasa `.df-filter-actions`

Verifică prima:
```bash
grep -n "\.df-filter-actions" public/css/df/components.css
# Așteptat: clasa există din v3.9.488.
```

Localizează blocul existent (cele 2 reguli adăugate în v3.9.488):
```bash
grep -B1 -A12 "Filter actions" public/css/df/components.css
```

**old_str:**
```css
.df-filter-actions{
  display:flex;
  gap:8px;
  align-self:flex-end;
}
.df-filter-actions .df-action-btn{
  padding:9px 13px;       /* match .df-frow input/select padding vertical */
  font-size:.88rem;       /* match .df-frow input/select font-size */
  line-height:1.2;        /* explicit ca să nu inheritm un line-height variabil */
}
```

**new_str:**
```css
.df-filter-actions{
  display:flex;
  gap:8px;
  align-self:stretch;       /* ia înălțimea rândului flex (= max child = .df-frow ~60px) */
  align-items:flex-end;     /* butoanele la fundul wrapper-ului */
}
.df-filter-actions .df-action-btn{
  height:38px;              /* înălțime explicită — match aproximativ cu input ~37-38px */
  padding:0 13px;           /* zero vertical padding când height e fix */
  font-size:.88rem;         /* match cu .df-frow input/select */
  /* line-height nu mai e necesar — .df-action-btn are display:inline-flex + align-items:center */
}
```

Verifică după:
```bash
grep -c "align-self:stretch" public/css/df/components.css
# Așteptat: 1 hit nou.
grep -c "height:38px" public/css/df/components.css
# Așteptat: ≥1 hit.
grep -c "align-self:flex-end" public/css/df/components.css
# Așteptat: 0 (a fost înlocuit).
```

### 2. `package.json`

```bash
grep '"version"' package.json
# Așteptat: "3.9.488"
```

**old_str:** `  "version": "3.9.488",`  
**new_str:** `  "version": "3.9.489",`

### 3. `public/sw.js`

```bash
grep CACHE_VERSION public/sw.js
# Așteptat: 'docflowai-v203'
```

**old_str:** `const CACHE_VERSION = 'docflowai-v203';`  
**new_str:** `const CACHE_VERSION = 'docflowai-v204';`

### 4. `?v=` în `registratura.html` (consistență)

```bash
grep -c "?v=3.9.488" public/registratura.html
sed -i 's/?v=3\.9\.488/?v=3.9.489/g' public/registratura.html
grep -c "?v=3.9.489" public/registratura.html
grep -c "?v=3.9.488" public/registratura.html
# Așteptat după sed: N hits pe 489 = nr. inițial pe 488; 0 pe 488.
```

## Verificări OBLIGATORII

```bash
# 1. NO-TOUCH
git diff --name-only
# Așteptat EXACT: 
#   public/css/df/components.css
#   public/registratura.html
#   package.json
#   public/sw.js

# 2. CSS nou
grep "align-self:stretch" public/css/df/components.css
grep "height:38px" public/css/df/components.css
grep "padding:0 13px" public/css/df/components.css
# Așteptat: toate găsite în blocul .df-filter-actions.

# 3. CSS vechi eradicat
grep "align-self:flex-end" public/css/df/components.css
# Așteptat: 0 hits (în zona .df-filter-actions cel puțin).
grep "line-height:1.2;" public/css/df/components.css | head -5
# Verifică să nu fi rămas line-height vechi cu intenție de aliniere.

# 4. HTML neatins (decât ?v=)
git diff public/registratura.html | grep -E '^\+|^-' | head
# Așteptat: doar bump-uri ?v=3.9.488 → 3.9.489.

# 5. Versiuni
grep '"version"' package.json
grep CACHE_VERSION public/sw.js
grep -c "?v=3.9.489" public/registratura.html
# Așteptat: 3.9.489 + docflowai-v204 + ≥3 hits pe ?v=3.9.489.

# 6. Teste
npm run check
npm test
# Așteptat: pass + npm test verde, fără regresii.
```

## Commit + push pe develop

```bash
git add public/css/df/components.css public/registratura.html package.json public/sw.js

git commit -m "fix(registratura): height explicit pe butoane filter bar (v3.9.489)

Abandonează abordarea cu padding+font+line-height match din v3.9.488
care nu producea aliniere pixel-perfect din cauza variabilității
line-height-ului între input și button în diverse browsere.

Abordare brută, predictibilă:
- .df-filter-actions: align-self:stretch (ia înălțimea rândului flex
  ~60px = label + input din .df-frow) + align-items:flex-end (butoanele
  la fundul wrapper-ului)
- .df-action-btn în .df-filter-actions: height:38px EXPLICIT (match
  cu input ~37-38px), padding:0 13px (zero vertical padding când
  height e fix), font-size:.88rem

Bottom-aligned cu inputurile, fără calcule fragile de line-height.

Bump CACHE_VERSION v203 → v204 + ?v= în registratura.html."

git push origin develop
```

## RAPORT

```
COMMIT: <SHA scurt> pe develop
Fișiere: 4
Verificări:
  - align-self:stretch în CSS: găsit ✅
  - height:38px în CSS: găsit ✅
  - align-self:flex-end vechi: 0 hits ✅
  - npm test: pass (589/589) ✅
  - versiuni: 3.9.489 + docflowai-v204 ✅
NO-TOUCH respectat: ✅
Push: develop @ <SHA scurt>
Staging: redeploy automat
```

## Post-deploy

**ÎNCHIDE DevTools complet** (nu îl micșora, ÎNCHIDE F12), apoi
hard-refresh pe staging (Ctrl+Shift+R). DevTools deschis lateral
îngustează viewport-ul și activează `flex-wrap` → butoanele apar
pe rând nou (nu e bug, e responsive).

Verifică la lățime plină (DevTools închis):
- Tab Ieșiri: butoane „Reîncarcă" + „Export CSV" pe același rând cu
  inputurile, top-uri și bottom-uri aliniate.
- Tab Intrări: butoane „Reîncarcă" + „+ Înregistrare intrare" idem.
  Atenție: Intrările au 4 câmpuri (An + Registru + Căutare + Status),
  poate apărea wrap la lățimi < ~1100px chiar fără DevTools — atunci
  e responsive corect, nu bug.

Dacă vezi misaliniere VIZIBILĂ (nu sub-pixel) la lățime plină fără
DevTools, măsoară în screenshot diferența exactă în pixeli între
bottom-ul unui input și bottom-ul unui buton, și raportează. Atunci
trec la fallback CSS Grid (rescriere completă a filter bar-ului), nu
mai iterez pe flex.
