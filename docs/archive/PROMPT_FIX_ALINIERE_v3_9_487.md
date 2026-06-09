# PROMPT Claude Code — Fix aliniere butoane filtru Registratură (v3.9.487)

> ⚠️ BRANCH: `develop` EXCLUSIV.
> Patch mic, frontend-only — corectează un fix incomplet din v3.9.486.
> Aliniază butoanele de filtru pe AMBELE subtab-uri (Ieșiri + Intrări)
> cu inputurile (An / Registru / Căutare / Status).

## Context

În v3.9.486 am aliniat baseline-ul butoanelor cu inputurile printr-un
spacer span. Funcționează parțial — bottoms match — DAR butoanele rămân
~5 px mai scurte decât inputurile fiindcă:

- `.df-action-btn`: `padding:7px 13px; font-size:.8rem;`  → înălțime ~30 px
- `.df-frow input/select`: `padding:9px 12px; font-size:.88rem;`  → înălțime ~35 px

Vizual, vârful butoanelor stă sub vârful inputurilor → impresia că nu
sunt aliniate, deși tehnic bottom-urile coincid.

Fix:
1. Înlocuiesc `<span aria-hidden>&nbsp;</span>` cu `<label aria-hidden>&nbsp;</label>`
   — preia EXACT CSS-ul `.df-frow label` (font-size, margin-bottom,
   font-weight, letter-spacing). Înălțime garantat identică cu label-urile
   reale, indiferent de viitoare schimbări în `components.css`.
2. Override inline pe butoane: `padding-top:9px; padding-bottom:9px;`
   → match cu padding-ul vertical al inputurilor. Diferența de font-size
   rămâne (~2 px) — negligibilă vizual.

## ⛔ NO-TOUCH

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/db/migrate.mjs
migrările existente 000…078
componenta registratura-action-modal.js (gata, funcționează)
public/css/df/components.css (nu schimbăm design tokens / clase globale)
```

## Modificări (2 fișiere)

### 1. `public/registratura.html` — Ieșiri (~linia 142)

Verifică structura curentă (din v3.9.486):
```bash
sed -n '141,150p' public/registratura.html
```

**old_str:**
```html
              <div class="df-frow" style="display:flex;flex-direction:column;justify-content:flex-end;margin-bottom:0;">
                <span aria-hidden="true" style="display:block;font-size:.75rem;margin-bottom:5px;visibility:hidden;">&nbsp;</span>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="reg-refresh" type="button">Reîncarcă</button>
                  <button class="df-action-btn primary" id="reg-export" type="button">Export CSV</button>
                </div>
              </div>
```

**new_str:**
```html
              <div class="df-frow" style="margin-bottom:0;">
                <label aria-hidden="true" style="visibility:hidden;">&nbsp;</label>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="reg-refresh" type="button" style="padding-top:9px;padding-bottom:9px;">Reîncarcă</button>
                  <button class="df-action-btn primary" id="reg-export" type="button" style="padding-top:9px;padding-bottom:9px;">Export CSV</button>
                </div>
              </div>
```

### 2. `public/registratura.html` — Intrări (~linia 213)

```bash
sed -n '212,221p' public/registratura.html
```

**old_str:**
```html
              <div class="df-frow" style="display:flex;flex-direction:column;justify-content:flex-end;margin-bottom:0;">
                <span aria-hidden="true" style="display:block;font-size:.75rem;margin-bottom:5px;visibility:hidden;">&nbsp;</span>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="regin-refresh" type="button">Reîncarcă</button>
                  <button class="df-action-btn primary" id="regin-new" type="button">+ Înregistrare intrare</button>
                </div>
              </div>
```

**new_str:**
```html
              <div class="df-frow" style="margin-bottom:0;">
                <label aria-hidden="true" style="visibility:hidden;">&nbsp;</label>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="regin-refresh" type="button" style="padding-top:9px;padding-bottom:9px;">Reîncarcă</button>
                  <button class="df-action-btn primary" id="regin-new" type="button" style="padding-top:9px;padding-bottom:9px;">+ Înregistrare intrare</button>
                </div>
              </div>
```

### 3. Bump versiune — `package.json`

```bash
grep '"version"' package.json
# Așteptat: "version": "3.9.486"
```

**old_str:**
```json
  "version": "3.9.486",
```

**new_str:**
```json
  "version": "3.9.487",
```

### 4. Bump `CACHE_VERSION` — `public/sw.js`

```bash
grep CACHE_VERSION public/sw.js
# Așteptat: 'docflowai-v201'
```

**old_str:**
```javascript
const CACHE_VERSION = 'docflowai-v201';
```

**new_str:**
```javascript
const CACHE_VERSION = 'docflowai-v202';
```

### 5. Actualizează `?v=` în registratura.html (consistență)

În v3.9.486 ai bump-uit toate `?v=3.9.484` → `?v=3.9.486`. Acum repetă
pentru `?v=3.9.486` → `?v=3.9.487`:

```bash
grep -n "?v=3.9.486" public/registratura.html
# Vezi câte hituri sunt — toate trebuie să devină ?v=3.9.487.
```

Folosește `sed` într-un singur pas:
```bash
sed -i 's/?v=3\.9\.486/?v=3.9.487/g' public/registratura.html
```

Verifică după:
```bash
grep -c "?v=3.9.487" public/registratura.html
grep -c "?v=3.9.486" public/registratura.html
# Așteptat: hituri pe 3.9.487 = nr. inițial pe 3.9.486; hituri pe 3.9.486 = 0.
```

## Verificări obligatorii

```bash
# 1. NO-TOUCH
git status
git diff --name-only
# Așteptat EXACT: public/registratura.html, package.json, public/sw.js
# Orice altceva → STOP.

# 2. Structura nouă prezentă (label spacer, nu span)
grep -c '<label aria-hidden="true" style="visibility:hidden;">' public/registratura.html
# Așteptat: 2 (Ieșiri + Intrări).

# 3. Vechea structură (span spacer) eradicată
grep -c '<span aria-hidden="true" style="display:block;font-size:.75rem;margin-bottom:5px;visibility:hidden;">' public/registratura.html
# Așteptat: 0.

# 4. Padding-ul nou pe butoane
grep -c 'padding-top:9px;padding-bottom:9px;' public/registratura.html
# Așteptat: 4 (2 butoane × 2 subtab-uri).

# 5. Versiuni sincronizate
grep '"version"' package.json
grep CACHE_VERSION public/sw.js
# Așteptat: 3.9.487 și docflowai-v202.

# 6. Niciun ?v vechi rămas
grep -c '?v=3.9.486' public/registratura.html
# Așteptat: 0.

# 7. Teste
npm run check
npm test
# Așteptat: pass + npm test verde, fără regresii.
```

Dacă oricare pică → STOP, raportează.

## Commit + push pe develop

```bash
git add public/registratura.html package.json public/sw.js

git commit -m "fix(registratura): aliniere completă butoane filtru (v3.9.487)

Fix incomplet din v3.9.486: spacer-ul span alinia baseline-ul OK, dar
butoanele rămâneau ~5px mai scurte decât inputurile (padding-top/bottom
diferit) — vizual nu păreau aliniate.

- Înlocuit <span> spacer cu <label aria-hidden visibility:hidden> ca să
  preia automat CSS-ul .df-frow label (font-size, margin-bottom,
  font-weight) — înălțime garantat identică cu label-urile reale
- Adăugat padding-top:9px; padding-bottom:9px; inline pe butoane ca să
  match-eze padding-ul vertical al inputurilor (.df-frow input padding:9px 12px)

Bump CACHE_VERSION v201 → v202 + ?v=3.9.486 → ?v=3.9.487 în registratura.html."

git push origin develop
```

## RAPORT FINAL

```
COMMIT: <SHA scurt> pe develop
Fișiere: 3
  - public/registratura.html  (4 butoane × inline style + ?v= bump)
  - package.json              (+1 -1)
  - public/sw.js              (+1 -1)
Verificări:
  - git diff --name-only: doar cele 3 fișiere ✅
  - label spacer hits: 2 ✅
  - span spacer rămase: 0 ✅
  - padding-top:9px hits: 4 ✅
  - npm run check: pass ✅
  - npm test: pass (589/589) ✅
  - versiuni: 3.9.487 + docflowai-v202 ✅
NO-TOUCH respectat: ✅
Push: develop @ <SHA scurt>
Staging: redeploy automat
```

## Post-deploy

După ~2 min, hard-refresh pe staging (`Ctrl+Shift+R`). Pe AMBELE
subtab-uri verifică:
- Butoanele și inputurile au acum aceeași înălțime aproximativă.
- Bottom-urile și top-urile aliniate vizual fără gap perceptibil.

Dacă încă pare ușor off (problema reală e diferența de font-size — 0.8rem
buton vs 0.88rem input), spune-mi și aplicăm și `font-size:.86rem;` pe
butoane în următorul patch. Dar prima dată verifică doar cu padding —
de obicei e suficient.

## Următorul commit care intră în prod (info)

Lanțul curent pe develop după acest patch:
```
de88a20  v3.9.484                           [pe main, vechi]
3969d9c  v3.9.485  fix(stability)           [intră]
d1055c9            chore(skills) deploy     [intră]
8822ac2  v3.9.486  feat(registratura)       [intră]
<NEW>    v3.9.487  fix(aliniere filtru)     [intră — acest patch]
```

Producția va sări `3.9.484 → 3.9.487` la următorul merge prin
`docflowai-deploy`.
