# DocFlowAI — 🎨 Fix: modalul de email apare nestilat pe semdoc-initiator (scurgere CSS din pagină)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.548 → v3.9.549
Branch: develop
Subiect: fix(email-modal): izolează componentul de CSS-ul generic al paginii-gazdă (checkbox/câmp rupte pe semdoc-initiator)
Tip: FIX CSS — doar email-modal.css. Schimbare de frontend → BUMP CACHE_VERSION + ?v=.
```

---

## 🎯 Problema (cauză-rădăcină confirmată)

Modalul global de email (`df-email-modal.js` + `css/df/email-modal.css`) apare **stilat corect pe
`flow.html`** dar **rupt pe `semdoc-initiator.html`** (checkbox „Raport de Conformitate" umflat, etichetă
ruptă pe verticală, câmpul de destinatari arată diferit).

Cauza NU e versiune/cache, ci o **scurgere de cascadă**: `semdoc-initiator.css` se încarcă DUPĂ
`email-modal.css` și conține selectori pe **element gol**:
- `input, select { width:100%; padding:10px 10px; border:...; background:...; }`
- `input, select, textarea { ... }`
- `label { display:block; font-size:12px; opacity:.85; margin-bottom:6px; }`

`email-modal.css` stilează prin **clase** (`.dfem-*`). Pe proprietățile pe care clasa le **declară**,
clasa câștige (mai specifică) — de-aia Subiect/Mesaj arată bine. Dar pe proprietățile pe care clasa
NU le declară, regula generică a paginii se aplică:
- **checkbox** — clasa nu declară `width` → prinde `input{width:100%}` → se întinde, eticheta se rupe.
- **`.dfem-chip-input`** (câmp destinatari) — nu declară `width` → prinde `width:100%` → flux schimbat.

`flow.css` n-are reguli `input`/`label` generice (doar `*{box-sizing}`), de-aia pe flow e ok.
(Indiciu: pe semdoc-initiator există deja un checkbox `urgentCheck` peticit inline cu
`style="width:16px;height:16px"` — același `input{width:100%}` a fost lovit înainte.)

## 🛠️ Soluția: fă componentul AUTO-CONȚINUT (defensiv)

NU atinge `semdoc-initiator.css` (scoping-ul lui e follow-up separat, risc mai mare). Imunizează
componentul: adaugă în `email-modal.css` reguli scopate sub `.dfem-overlay` cu specificitate suficientă
cât să bată selectorii pe element gol (specificitate 0,0,1) ai oricărei pagini-gazdă — acum și în viitor.

---

## 🚫 Zone interzise

- NU atinge `semdoc-initiator.css`, `flow.css`, alte CSS-uri de pagină. DOAR `css/df/email-modal.css`.
- NU atinge `df-email-modal.js` (markup-ul e corect; problema e pur CSS). NU atinge cod backend.
- NU atinge signing NO-TOUCH, schema, migrări.

---

## 📋 Pas 0 — context (CITEȘTE fișierul real întâi)

```bash
git checkout develop && git pull origin develop
git status   # clean

# Citește CSS-ul curent al modalului (conține și stilurile checkbox-ului din v3.9.548 — pe care eu nu le văd):
cat public/css/df/email-modal.css

# Confirmă scurgerea din pagină:
grep -nE "^\s*(input|label|textarea|select)[ ,{:]" public/css/semdoc-initiator/semdoc-initiator.css
```

Notează ce **clase de label/input** din modal NU declară explicit proprietățile pe care pagina le
suprascrie: `width` (pe checkbox + `.dfem-chip-input`), și `display`/`font-size`/`opacity`/`margin-bottom`
(pe etichete: `.dfem-label`, `.dfem-check`).

---

## 📋 Pas 1 — adaugă blocul defensiv în `email-modal.css`

La **finalul** fișierului (ca să se aplice ultimul, dar miza reală e specificitatea, nu ordinea),
adaugă verbatim — adaptând numele claselor la ce ai văzut la Pas 0:

```css
/* ──────────────────────────────────────────────────────────────────────
   Izolare defensivă față de CSS-ul generic al paginii-gazdă.
   Unele pagini (ex. semdoc-initiator.css) au selectori pe element gol
   încărcați DUPĂ acest fișier: input{width:100%}, label{display:block;...}.
   Scopăm sub .dfem-overlay ca să batem specificitatea element-only (0,0,1).
   NU folosi `.dfem-overlay label{...}` general — ar bate .dfem-check (flex).
   ────────────────────────────────────────────────────────────────────── */

/* Checkbox: nu trebuie întins de input{width:100%} al paginii */
.dfem-overlay input[type="checkbox"]{
  width:auto; height:auto;
  flex:0 0 auto;
  margin:0;
  accent-color:var(--df-primary);
}

/* Câmp destinatari: păstrează flex, nu lățime forțată */
.dfem-overlay .dfem-chip-input{ width:auto; }

/* Etichetele modalului: neutralizează label{display:block;font-size;opacity;margin-bottom} */
.dfem-overlay .dfem-label{ font-size:inherit; opacity:1; margin-bottom:8px; }
.dfem-overlay .dfem-check{ display:flex; font-size:.88rem; opacity:1; margin-bottom:0; }
.dfem-overlay .dfem-check-text{ font-size:.82rem; }
```

> ⚠️ Specificitate — verifică, nu presupune:
> - `.dfem-overlay input[type="checkbox"]` = 0,2,1 → bate `input` (0,0,1). ✓
> - `.dfem-overlay .dfem-check` = 0,2,0 → bate `label` (0,0,1) ȘI eventualul `.dfem-check` simplu existent
>   din fișier; păstrează `display:flex` aici ca să nu-l piardă. ✓
> - NU adăuga `.dfem-overlay label{...}` generic (0,1,1) — ar suprascrie `display:flex` de pe `.dfem-check`
>   și ar rerupe checkbox-ul. ✗
> Dacă valorile reale din fișier (font-size, margin) diferă de ce am pus aici, folosește valorile DEJA
> existente în `.dfem-label`/`.dfem-check` din fișier — scopul e doar să le faci imune, nu să le schimbi
> aspectul pe flow.html (unde arată corect).

---

## 📋 Pas 2 — cache busting (schimbare de frontend)

```bash
grep -rn "email-modal.css?v=" public --include="*.html"   # bump pe toate referințele
grep -n "CACHE_VERSION" public/sw.js
```
- `?v=3.9.549` pe `email-modal.css` în toate paginile care-l referă (admin.html, flow.html,
  semdoc-initiator.html).
- Bumpează `CACHE_VERSION` în `public/sw.js`.
- ⚠️ Folosește `sed` **țintit pe fișierele care chiar referă asset-ul** (nu `sed` pe `public/*.html`,
  ca să nu rescrii line-endings pe toate — vezi lecția din v3.9.548). Verifică cu `git diff --stat` că
  ai atins EXACT paginile cu referința, nu mai multe.

---

## 📋 Pas 3 — verificare

```bash
npm run check
npm test     # verde, fără regresii (n-ai atins JS/backend)
```

**Verificare vizuală OBLIGATORIE (nu există test automat pentru scurgeri de cascadă):**
deschide modalul de email pe **AMBELE** pagini și confirmă identitate vizuală:
1. `flow.html` (pagina de detaliu flux) — trebuie să rămână neschimbat față de cum era (corect).
2. `semdoc-initiator.html` (Fluxurile mele) — checkbox mic aliniat la stânga cu eticheta lângă el,
   câmpul de destinatari ca pe flow.html.
Confirmarea reală e pe staging după deploy (clear cache / hard reload pentru SW). Nu raporta „rezolvat"
doar pe baza `npm test` — bug-ul e vizual, dovada e vizuală.

---

## 📋 Pas 4 — bump + commit + push

```bash
# package.json: 3.9.548 → 3.9.549. CACHE_VERSION bumped. ?v= bumped pe email-modal.css.

git add public/css/df/email-modal.css public/sw.js public/*.html package.json
git commit -m "fix(email-modal): izolează componentul de CSS-ul generic al paginii-gazdă (checkbox/câmp rupte pe semdoc-initiator)"
git push origin develop
```

---

## ✅ Definiție de „gata"

1. Bloc defensiv în `email-modal.css`: checkbox `width:auto`, `.dfem-chip-input` `width:auto`, etichete
   imunizate — toate scopate sub `.dfem-overlay`, fără `.dfem-overlay label{}` generic.
2. `semdoc-initiator.css`/`flow.css` NEatinse.
3. Modalul identic vizual pe flow.html (neschimbat) ȘI semdoc-initiator.html (reparat) — confirmat vizual.
4. Cache busting: `?v=3.9.549` pe email-modal.css peste tot + `CACHE_VERSION` bumped; `git diff --stat`
   arată DOAR fișierele cu referința atinse.
5. `npm run check` + `npm test` verzi; push pe develop; CI verde.
6. Raport: ce reguli defensive s-au adăugat, confirmarea vizuală pe ambele pagini (sau „de validat pe
   staging" dacă nu poți reda local), și notarea ca follow-up opțional a scoping-ului
   `semdoc-initiator.css` (`input{}`→`.scope input{}`) + curățarea peticului inline `urgentCheck`.

> Follow-up (NU în acest prompt): scoping-ul selectorilor generici din `semdoc-initiator.css` ar fixa
> cauza la sursă pentru ORICE component, dar are blast radius pe formularele paginii — merită etapă
> separată cu verificare vizuală proprie.
