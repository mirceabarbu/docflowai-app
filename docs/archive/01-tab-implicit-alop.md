# FIX: Tab implicit ALOP pe pagina Formulare

> ⚠️ **BRANCH: `develop` EXCLUSIV.** NU face checkout/merge/push pe `main`.
> `main` = producție, gestionat manual de Mircea. Toată munca rămâne pe `develop`.

---

## Context

Pe `/formulare`, la prima navigare fără parametri URL, pagina deschide implicit
sub-tabul **Referat de necesitate** (RN). RN și NFI au accesul restricționat
momentan, deci landing-ul trebuie mutat pe **ALOP**.

Codul actual:
- `public/formular.html` — butonul `#ltab-rfn` are clasa `active` hardcodată.
- `public/js/formular/list.js` — `_lstState` are `type:'rfn'` ca default; funcția
  `showListSection(tab)` apelează `switchListTab` DOAR dacă `tab` e dat
  (`if(tab)switchListTab(tab)`), altfel rămâne default-ul HTML.
- `public/js/formular/doc.js` — la boot, când nu există `?tip`/`?id` în URL,
  apelează `showListSection()` fără argument.

## Cerință

La intrare pe `/formulare` (fără `?tip`/`?id`/`?alop_id`), să se deschidă
implicit sub-tabul **ALOP**. Restul comportamentului (navigare manuală, back din
ALOP, deep-link cu `?tip=`) rămâne neschimbat.

## Modificări exacte

### 1. `public/js/formular/list.js`

- Schimbă default-ul de stare:
  ```js
  let _lstState={type:'alop',page:1,limit:20};   // era 'rfn'
  ```
- În `showListSection(tab)`, înlocuiește:
  ```js
  if(tab)switchListTab(tab);
  ```
  cu:
  ```js
  switchListTab(tab||'alop');
  ```
  (astfel boot-ul fără argument deschide ALOP, iar apelurile cu tab explicit
  — ex. `showListSection('alop')` din back-button — rămân corecte).

### 2. `public/formular.html`

- Mută clasa `active` de pe `#ltab-rfn` pe `#ltab-alop`:
  - `<button class="df-subtab active" id="ltab-rfn" ...>` → scoate `active`
    (devine `class="df-subtab"`).
  - `<button class="df-subtab" id="ltab-alop" ...>` → adaugă `active`
    (devine `class="df-subtab active"`).

### 3. Cache-busting

- Bumpează `?v=` la versiunea curentă din `package.json` (3.9.538) DOAR pe
  liniile `<script>`/`<use href>` din `public/formular.html` care încarcă
  fișierele atinse. Restul referințelor `?v=` rămân neatinse.
- Incrementează `version` în `package.json` la `3.9.538`.

## Verificare

- `npm test` → **verde, fără regresii.**
- `npm run check` → fără erori de sintaxă.
- Test manual: `/formulare` fără parametri → ALOP activ; `/formulare?tip=df`
  → formular DF nou; back din ALOP → ALOP; click manual pe RN/NFI/Clasa8 →
  funcționează ca înainte.

## Finalizare (obligatoriu)

```bash
git add .
git commit -m "fix(formulare): tab implicit ALOP la prima navigare (RN/NFI restricționate) v3.9.538"
git push origin develop
```
