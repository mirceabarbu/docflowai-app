# DocFlowAI — 📝 Docs: codifică lecția de scoping CSS în CLAUDE.md

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.550 → v3.9.551
Branch: develop
Subiect: docs(css): codifică regula de scoping CSS & auto-conținere a componentelor globale
Tip: DOCS-ONLY — doar CLAUDE.md. Zero cod. Fără CACHE_VERSION, fără ?v=.
```

---

## 🎯 Scop

Codifică lecția din incidentele v3.9.549/550 (modalul de email rupt pe semdoc-initiator din cauza
scurgerii de CSS) ca regulă permanentă în CLAUDE.md, ca să nu se repete clasa de bug.

---

## 🚫 Zone interzise

- DOAR `CLAUDE.md`. NU atinge cod, CSS, schema, nimic altceva.

---

## 📋 Pas 1 — inserează secțiunea în CLAUDE.md

Găsește secțiunea `## Frontend`. La **finalul** ei (înainte de următoarea secțiune `## ...`), inserează
verbatim:

````markdown
### CSS: scoping & componente globale (din v3.9.551)

CSS-ul NU e scopat per component — într-o pagină fără Shadow DOM, fiecare stylesheet se aplică
*fiecărui* element din document, inclusiv componentelor injectate în `<body>` la runtime (modaluri,
toast-uri, widget-uri globale).

**Regula 1 — CSS de pagină = selectori scopați la wrapper-ul paginii, NICIODATĂ pe element gol.**
Un `input{width:100%}` sau `label{display:block}` într-un CSS de pagină (ex. `semdoc-initiator.css`)
se scurge în orice component global injectat în body și îi rupe stilul. Scopează la wrapper-ul de
conținut: `.df-shell input{…}`. Componentele se atașează în `<body>` ca frate al `.df-shell`, deci
rămân în afara razei.

**Regula 2 — componentele globale își declară DEFENSIV toate proprietățile (auto-conținere).**
Un component montat în body (ex. `df-email-modal`) NU se bazează pe igiena CSS a paginii-gazdă:
declară explicit width/display/etc. pe propriile clase, scopate sub rădăcina lui (`.dfem-overlay`),
cu specificitate suficientă cât să bată selectorii pe element gol ai paginii (și `!important`-ul lor,
dacă există). O proprietate nedeclarată = un gol pe care pagina-gazdă îl umple cu regulile ei generice.

**Stratul dublu e INTENȚIONAT, nu redundanță:** pagină scopată (Regula 1) + component auto-conținut
(Regula 2). Fiecare acoperă ce ratează celălalt; împreună fac montarea unui component pe orice pagină
sigură. NU „curăța" defensiva unui component pe motiv că pagina a fost scopată.

Incident de referință: modalul de email apărea rupt pe `semdoc-initiator.html` (dar corect pe
`flow.html`) fiindcă `semdoc-initiator.css` avea `input{width:100%}` + `input,select,textarea{…!important}`
pe element gol. Fix: defensivă în `email-modal.css` (v3.9.549) + scoping la `.df-shell` în
`semdoc-initiator.css` (v3.9.550).
````

Dacă structura secțiunii `## Frontend` face inserția neclară, pune secțiunea imediat după
`## Consolidare DF/ORD & asimetrii` (sunt ambele reguli anti-regresie). Alege un singur loc, coerent.

---

## 📋 Pas 2 — bump + commit + push

```bash
# package.json: 3.9.550 → 3.9.551. FĂRĂ CACHE_VERSION, FĂRĂ ?v= (docs-only).
npm run check   # confirmă că nimic de cod nu s-a atins (rapid)

git add CLAUDE.md package.json
git commit -m "docs(css): codifică regula de scoping CSS & auto-conținere a componentelor globale (lecția v3.9.549/550)"
git push origin develop
```

---

## ✅ Definiție de „gata"

1. Secțiunea „CSS: scoping & componente globale" în CLAUDE.md (în `## Frontend` sau lângă consolidare).
2. Ambele reguli + nota „strat dublu intenționat" + incidentul de referință prezente.
3. ZERO cod atins; fără CACHE_VERSION/?v=.
4. Push pe develop; CI verde.
5. Raport: unde s-a inserat secțiunea.
