# PROMPT Claude Code — Filter-actions clasă CSS dedicată (v3.9.488)

> ⚠️ BRANCH: `develop` EXCLUSIV.
> Rezolvă DEFINITIV alinierea butoanelor de filtru din Registratură.
> Abandonează abordarea cu spacer-uri inline din v3.9.486+487
> (insuficiente fiindcă butoanele au padding ȘI font-size ȘI line-height
> diferite de inputuri — match parțial nu produce aliniere vizibilă).
> Adaugă o clasă CSS dedicată `.df-filter-actions` în design system
> (`components.css`) și un selector specific pentru butoanele dinăuntru.
> Aceasta este o EXTENSIE a design system-ului, nu o modificare —
> respectă convențiile din skill-ul `docflowai-ui`.

## Diagnostic

Inputurile `.df-frow input/select` au:
- `padding:9px 12px;`
- `font-size:.88rem;` (~14 px)
- `line-height` implicit (~1.4-1.5)

Butoanele `.df-action-btn` (implicit, în restul aplicației):
- `padding:7px 13px;`
- `font-size:.8rem;` (~12.8 px)
- `line-height` implicit

→ Înălțime input ~37 px, înălțime buton ~30 px. Cu `align-items:flex-end`
pe parent, bottom-urile se aliniază DAR top-urile diferă cu ~7 px →
vizual butoanele „plutesc" jos față de inputuri.

Fix-urile anterioare (v3.9.486 span spacer, v3.9.487 label spacer +
padding inline) au atins parțial problema dar nu și font-size →
diferența rămasă perceptibilă.

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
```

Notă: `public/css/df/components.css` ESTE permis pentru ADAUGARE de
clase noi (extensie design system). NU modificăm clase existente.

## Modificări (3 fișiere)

### 1. `public/css/df/components.css` — adaugă clasă nouă la final

Verifică dimensiunea actuală:
```bash
wc -l public/css/df/components.css
# Așteptat: ~536 linii (sau cât e după v3.9.487).
tail -5 public/css/df/components.css
# Verifică ce e la final ca să știi unde appendezi.
```

**Append la finalul fișierului** (după ultima regulă existentă, fără
modificări altundeva):

```css

/* ── Filter actions (butoane în rândul de filtre alături de .df-frow) ────────
   Aliniază vizual butoanele cu inputurile dintr-un container parent care
   are display:flex; align-items:flex-end. Wrapper-ul se duce la bottom
   prin align-self, iar butoanele dinăuntru match-ează padding-ul vertical
   ȘI font-size-ul inputurilor (.df-frow input/select) ca să arate la fel
   ca un câmp de formular. Folosit în registratura.html (subview-uri
   Intrări + Ieșiri) și disponibil pentru orice altă pagină cu filter bar. */
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

Verifică după:
```bash
grep -c "\.df-filter-actions" public/css/df/components.css
# Așteptat: 2 (declarația + selector pentru butoane).
```

### 2. `public/registratura.html` — Ieșiri (~liniile 142-149 după v3.9.487)

Întâi VEZI ce e acolo acum (poate Claude Code a aplicat puțin diferit
față de prompt-urile mele anterioare):

```bash
sed -n '140,155p' public/registratura.html
```

Vrei să ajungi la asta (curat, fără spacer, fără inline overrides pe
butoane):

```html
              <div class="df-filter-actions">
                <button class="df-action-btn" id="reg-refresh" type="button">Reîncarcă</button>
                <button class="df-action-btn primary" id="reg-export" type="button">Export CSV</button>
              </div>
```

Înlocuiește blocul curent (oricare ar fi: `.df-frow` cu `<span>` ȘI/SAU
cu `<label>` spacer ȘI/SAU cu inline-padding pe butoane). Folosește
**Edit** pe blocul exact pe care îl vezi din `sed`.

Dacă structura curentă e (cea mai probabilă, post-v3.9.487):
```html
              <div class="df-frow" style="margin-bottom:0;">
                <label aria-hidden="true" style="visibility:hidden;">&nbsp;</label>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="reg-refresh" type="button" style="padding-top:9px;padding-bottom:9px;">Reîncarcă</button>
                  <button class="df-action-btn primary" id="reg-export" type="button" style="padding-top:9px;padding-bottom:9px;">Export CSV</button>
                </div>
              </div>
```

Înlocuiește-o EXACT cu:
```html
              <div class="df-filter-actions">
                <button class="df-action-btn" id="reg-refresh" type="button">Reîncarcă</button>
                <button class="df-action-btn primary" id="reg-export" type="button">Export CSV</button>
              </div>
```

Dacă structura curentă e ALTCEVA (v3.9.486 cu span, sau cu mai multe
inline overrides), aplică același principiu: păstrează doar wrapper-ul
cu class `df-filter-actions` și butoanele cu `.df-action-btn` (FĂRĂ
niciun `style="..."` inline pe ele).

### 3. `public/registratura.html` — Intrări (~liniile 213-221 după v3.9.487)

```bash
sed -n '210,225p' public/registratura.html
```

Țintă identică structural:

```html
              <div class="df-filter-actions">
                <button class="df-action-btn" id="regin-refresh" type="button">Reîncarcă</button>
                <button class="df-action-btn primary" id="regin-new" type="button">+ Înregistrare intrare</button>
              </div>
```

### 4. Bump versiune — `package.json`

```bash
grep '"version"' package.json
# Așteptat: "3.9.487"
```

**old_str:** `  "version": "3.9.487",`  
**new_str:** `  "version": "3.9.488",`

### 5. Bump `CACHE_VERSION` — `public/sw.js`

```bash
grep CACHE_VERSION public/sw.js
# Așteptat: 'docflowai-v202'
```

**old_str:** `const CACHE_VERSION = 'docflowai-v202';`  
**new_str:** `const CACHE_VERSION = 'docflowai-v203';`

### 6. Bump `?v=` în `registratura.html`

```bash
grep -n "?v=3.9.487" public/registratura.html
# Vezi câte hituri.
sed -i 's/?v=3\.9\.487/?v=3.9.488/g' public/registratura.html
grep -c "?v=3.9.488" public/registratura.html
grep -c "?v=3.9.487" public/registratura.html
# Așteptat: hits-uri pe 488 = nr. inițial pe 487; 0 pe 487.
```

## Verificări OBLIGATORII

```bash
# 1. NO-TOUCH (lista exactă fișiere modificate)
git status
git diff --name-only
# Așteptat EXACT (în orice ordine):
#   public/css/df/components.css
#   public/registratura.html
#   package.json
#   public/sw.js
# Orice altceva → STOP.

# 2. CSS-ul are clasa nouă
grep -c "\.df-filter-actions" public/css/df/components.css
# Așteptat: 2.

# 3. HTML-ul folosește noua clasă în AMBELE subtab-uri
grep -c 'class="df-filter-actions"' public/registratura.html
# Așteptat: 2.

# 4. Toate hack-urile anterioare au dispărut din zona butoanelor de filtru
grep -c 'aria-hidden="true"' public/registratura.html
# Așteptat: 0 (NU mai e niciun spacer label/span hidden).
grep -c 'visibility:hidden' public/registratura.html
# Așteptat: 0.
grep -c 'padding-top:9px;padding-bottom:9px' public/registratura.html
# Așteptat: 0.

# 5. Butoanele din filter-bar NU au inline style
# Verifică manual cu sed că <button ... id="reg-refresh">, "reg-export",
# "regin-refresh", "regin-new" NU au style="..."
grep -E 'id="(reg-refresh|reg-export|regin-refresh|regin-new)"' public/registratura.html
# Așteptat: 4 linii, NICIUNA cu style="..."

# 6. Versiuni sincronizate
grep '"version"' package.json
grep CACHE_VERSION public/sw.js
# Așteptat: 3.9.488 și docflowai-v203.
grep -c "?v=3.9.488" public/registratura.html
grep -c "?v=3.9.487" public/registratura.html
# Așteptat: N pe 488 (≥3); 0 pe 487.

# 7. Teste
npm run check
npm test
# Așteptat: pass + npm test verde, fără regresii.
```

Dacă oricare pică → STOP, raportează exact ce vezi.

## Commit + push pe develop

```bash
git add public/css/df/components.css public/registratura.html package.json public/sw.js

git commit -m "fix(registratura): clasă dedicată .df-filter-actions (v3.9.488)

Abandonează abordarea cu spacer-uri inline din v3.9.486+487 — match
parțial pe înălțime nu producea aliniere vizibilă din cauza diferenței
de font-size între .df-action-btn (.8rem) și .df-frow input/select
(.88rem).

- Adăugat .df-filter-actions în components.css: align-self:flex-end +
  selector intern care match-ează padding-ul vertical (9px) ȘI font-size-ul
  (.88rem) ȘI line-height-ul (1.2) cu inputurile din .df-frow
- Eliminat toate hack-urile inline din registratura.html: spacer span/label
  cu visibility:hidden, padding-top/bottom inline pe butoane
- HTML acum curat: <div class=\"df-filter-actions\"> cu butoane standard
  .df-action-btn, fără inline style — folosibil oriunde altundeva e
  nevoie de filter bar

Bump CACHE_VERSION v202 → v203 + ?v=3.9.487 → ?v=3.9.488 în pagină."

git push origin develop
```

## RAPORT FINAL

```
COMMIT: <SHA scurt> pe develop
Fișiere: 4
  - public/css/df/components.css  (+~14 -0)
  - public/registratura.html      (-N hack lines, +M clean lines, ?v bump)
  - package.json                  (+1 -1)
  - public/sw.js                  (+1 -1)
Verificări:
  - .df-filter-actions în CSS: 2 hits ✅
  - class="df-filter-actions" în HTML: 2 hits ✅
  - aria-hidden hits: 0 ✅
  - visibility:hidden hits: 0 ✅
  - inline padding-top:9px hits: 0 ✅
  - butoane filter fără inline style: confirmat ✅
  - npm run check: pass ✅
  - npm test: pass (589/589) ✅
  - versiuni: 3.9.488 + docflowai-v203 ✅
NO-TOUCH respectat: ✅ (signing + migrate.mjs + migrările + JS modal neatinse)
Push: develop @ <SHA scurt>
Staging: redeploy automat
```

## Post-deploy — verificare CORECTĂ a alinierii

**OBLIGATORIU în incognito** (`Ctrl+Shift+N`) la
`https://docflowai-app-staging.up.railway.app/registratura.html`.
În tab normal, Service Worker-ul poate servi HTML cached → fix-ul pare
că n-a făcut nimic. În incognito, SW-ul nu există → vezi codul live.

În browser inspector (F12 → Elements):
1. Click pe butonul „Reîncarcă"
2. Panoul Styles trebuie să arate `padding: 9px 13px` și `font-size: 0.88rem`
   moștenite din `.df-filter-actions .df-action-btn`
3. Computed → Height ar trebui să fie ~37 px (același cu inputurile)

Dacă în incognito tot pare misaliniat:
- Salvează un screenshot al panoului Styles din F12
- Salvează un screenshot cu rulers (sau măsoară cu Page Ruler extension
  diferența exactă în px între bottom-input și bottom-buton)
- Trimite-mi-le și fac patch chirurgical pe baza diferenței măsurate

## Următorul commit care intră în prod

Lanțul curent pe develop:
```
de88a20  v3.9.484                          [pe main]
3969d9c  v3.9.485  fix(stability)          [pending]
d1055c9            chore(skills)           [pending]
8822ac2  v3.9.486  feat(registratura)      [pending]
<SHA>    v3.9.487  fix(aliniere v1)        [pending, va fi „rescris" de v3.9.488]
<NEW>    v3.9.488  fix(aliniere clasă CSS) [pending, soluția finală]
```

La merge `develop → main`: prod sare `3.9.484 → 3.9.488`, vede direct
soluția curată; commit-urile intermediare 486+487 rămân în istoria
git ca trail de iterație dar nu produc artefacte vizibile (HTML-ul final
e cel de la 488).
