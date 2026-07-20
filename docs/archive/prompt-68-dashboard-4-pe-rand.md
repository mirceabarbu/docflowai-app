---
prompt: 68
titlu: "style(dashboard): cardurile KPI — 4 pe rând (2 rânduri curate de 4)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX layout dashboard
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Cerință (owner)
Cele 8 carduri KPI din Dashboard curg 5+3 (inegal). Vrem **4 pe rând** → 2 rânduri curate de 4.

## Cauză
`.df-kpi-grid` (`public/css/df/shell.css:37`) folosește `repeat(auto-fit, minmax(200px,1fr))`, deci pe ecran lat încap 5 pe primul rând. Clasa e folosită **doar** pe `admin.html` (dashboard) — schimbarea e sigură, fără efecte pe alte pagini.

## Fix — `public/css/df/shell.css:37`
```css
.df-kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px;}
@media(max-width:1100px){.df-kpi-grid{grid-template-columns:repeat(2,1fr);}}
@media(max-width:560px){.df-kpi-grid{grid-template-columns:1fr;}}
```
(4 pe desktop, 2 pe tabletă, 1 pe mobil.)

## Cache busting + versiune
- Bump `?v=` la `shell.css` în paginile care-l referă (grep `shell.css?v=` în `public/*.html`).
- `public/sw.js`: `CACHE_VERSION` ++. `package.json`: următorul patch.

## Guardrails diff
EXCLUSIV: `public/css/df/shell.css`, HTML-uri cu `shell.css?v=`, `public/sw.js`, `package.json`. Fără JS/mjs.
```bash
git diff --name-only | grep -E "\.mjs$|/js/" && echo "⛔ STOP: nu trebuie atins cod!" || echo "✅ doar CSS/HTML/versiuni"
```

## Verificare (owner, staging)
Dashboard: 8 carduri în 2 rânduri de 4, aliniate. Responsive pe tabletă/mobil.

## Final
```bash
git add public/css/df/shell.css public/*.html public/sw.js package.json
git commit -m "style(dashboard): df-kpi-grid 4 pe rând"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
