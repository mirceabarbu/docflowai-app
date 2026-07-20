---
fix(ux): meniul kebab rămâne mereu deschis — regula CSS `display:flex` calcă peste atributul `hidden`
target_branch: develop
model_suggested: Sonnet 5 (fix CSS de o linie)
risk: FOARTE SCĂZUT (o regulă CSS corectată)
version: 3.9.619 → 3.9.620
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema
Meniul kebab (`.df-kebab-menu`) din „Fluxurile mele" e vizibil permanent, de la încărcare, și nu
se închide. JS-ul e corect (setează/scoate atributul `hidden` — confirmat), DAR regula CSS
`.df-kebab-menu { display: flex; ... }` din promptul 40 NU are excepție pentru starea `hidden`.

Atributul HTML `hidden` ascunde un element prin `display: none` (comportament implicit al
browserului), dar **orice `display` explicit în CSS îl anulează**. Deci `display: flex` face
meniul vizibil indiferent că JS-ul îi pune `hidden`. Root cause = CSS, nu JS.

# Etapa 0 — caracterizare
```bash
grep -n "df-kebab-menu" public/css/semdoc-initiator/semdoc-initiator.css
```
Confirmă că regula `.df-kebab-menu` are `display: flex` (sau `display: block`) necondiționat.

# Implementare — `public/css/semdoc-initiator/semdoc-initiator.css`
Fă regula de `display` să se aplice DOAR când meniul NU e ascuns. Două variante echivalente —
alege una:

**Varianta A (recomandată, minimă):** adaugă o regulă care restabilește `display:none` pentru
starea `hidden`, plasată DUPĂ regula existentă `.df-kebab-menu`:
```css
.df-kebab-menu[hidden] { display: none !important; }
```
(`!important` e justificat aici: `[hidden]` trebuie să învingă orice `display` de layout,
indiferent de ordinea/specificitatea regulilor.)

**Varianta B (mai curată dacă preferi):** condiționează regula de layout pe `:not([hidden])`:
```css
.df-kebab-menu:not([hidden]) { display: flex; /* + restul proprietăților de layout */ }
```
și scoate `display: flex` din regula `.df-kebab-menu` de bază (păstrează acolo doar
position/min-width/background/border/etc., care sunt inofensive cât timp elementul e `hidden`
via `display:none`).

Preferă Varianta A dacă regula de bază are multe proprietăți (mai puțin risc de a rupe ceva);
Varianta B dacă vrei să eviți `!important`.

# Verificare manuală (CRITICĂ — bug vizual)
Pe staging după deploy:
1. „Fluxurile mele" se încarcă → meniurile kebab sunt ÎNCHISE implicit (doar butonul „⋮" vizibil).
2. Click pe „⋮" → meniul se deschide.
3. Click din nou pe „⋮" SAU click în afară SAU Escape → meniul se închide.
4. Un singur meniu deschis simultan (deschizi altul → primul se închide).
5. Click pe o acțiune din meniu → acțiunea rulează ȘI meniul se închide.

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `public/css/semdoc-initiator/semdoc-initiator.css`, `public/semdoc-initiator.html` (bump ?v=), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -vE "semdoc-initiator\.css|semdoc-initiator\.html|public/sw\.js|package\.json" && echo "⛔ STOP" || echo "✅ scope curat"
```

# Cache busting + versiune
3.9.619 → 3.9.620; `CACHE_VERSION` sw.js; `?v=3.9.620` pe `semdoc-initiator/semdoc-initiator.css` în `public/semdoc-initiator.html`.

# La final
```bash
git add public/css/semdoc-initiator/semdoc-initiator.css public/semdoc-initiator.html public/sw.js package.json
git commit -m "fix(ux): kebab închis implicit — [hidden] învinge display de layout (v3.9.620)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Care variantă (A/B) ai aplicat și regula exactă.
2. Confirmare (după deploy) că meniurile pornesc închise și toggle/close funcționează.
3. CI verde, v3.9.620.
