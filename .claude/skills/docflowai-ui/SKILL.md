---
name: docflowai-ui
description: >
  Convenții UI obligatorii pentru orice lucru pe frontend-ul DocFlowAI
  (fișiere din public/ — .html și js/*.js). Folosește acest skill ORI DE
  CÂTE ORI creezi sau modifici un formular, modal, drawer, tabel, sub-tab,
  input de dată, input de fișier, buton, badge/status, toolbar, toast sau
  orice element vizibil în public/. Acoperă design system-ul df (tokens.css
  + components.css, prefix .df-), patternul de dată românesc (zz.ll.aaaa, NU
  input type=date nativ), upload fișier (input ascuns + .df-action-btn, NU
  „Choose File" nativ), modale, drawer-e, tabele, sub-tab-uri, badge-uri
  semantice, iconițe sprite, CSRF, escaping, interdicția localStorage,
  responsive și bump-ul de versiune. Declanșează-l înainte de a scrie orice
  markup sau JS de UI; ignorarea lui produce UI inconsistent cu restul
  aplicației.
---

# DocFlowAI — Convenții UI frontend

Scop: orice element vizibil nou trebuie să fie **indistinct** de un element
echivalent existent în altă pagină. Sursa de adevăr a stilului:
`public/css/df/tokens.css` (variabile) + `public/css/df/components.css`
(clase `.df-*`). Înainte de a livra UI, treci checklist-ul de la final.

## Design tokens (NU hardcoda culori)

Toate culorile/raze/fonturile vin din variabile CSS. Nu scrie hex/rgba direct.

- Suprafețe: `--df-bg`, `--df-bg-elevated`, `--df-surface`, `--df-surface-2`,
  `--df-surface-hover`.
- Borduri: `--df-border`, `--df-border-2`, `--df-border-hover`.
- Text (5 trepte, de la cel mai puternic la cel mai estompat): `--df-text`,
  `--df-text-2`, `--df-text-3`, `--df-text-4`, `--df-text-5`.
- Accente: `--df-primary*` (bleumarin enterprise — acțiunea principală),
  `--df-brand*` (violet — identitate/focus ring inputuri), `--df-teal*`
  (accent secundar / „ok").
- Semantic: `--df-success*`, `--df-warning*`, `--df-danger*`, `--df-info`.
  Fiecare are triada `*`, `*-bg`, `*-bd` (text/fundal/bordură).
- Radius: `--df-radius-sm|md|lg|xl` (6/8/10/12px). Fonturi:
  `--df-font-sans`, `--df-font-mono`.
- **Alias-uri legacy** (`--bg --card --text --sub --muted --line --accent
  --radius`) există DOAR pentru cele ~311 inline-styles din `admin.html`. NU
  le folosi în cod nou; în cod nou folosește direct `--df-*`. Nu le șterge.

## Input de DATĂ — format românesc (REGULĂ DURĂ)

**Niciodată** `<input type="date">` ca element vizibil — browser-ul îl
randează în locale-ul lui (`mm/dd/yyyy` en-US), inconsistent și derutant.

```html
<div class="df-frow">
  <label>Dată</label>
  <input type="text" id="x-data" maxlength="10" placeholder="zz.ll.aaaa"
         autocomplete="off" inputmode="numeric">
</div>
```
Conversie prin helperele globale (`df-utils.js`):
```javascript
const iso = window.df.parseDMYtoISO(el.value); // "12.05.2026"→"2026-05-12" | ""
el.value  = window.df.isoToDMY(isoFromApi);     // invers
// spre API: iso || null (coloanele DATE acceptă YYYY-MM-DD)
```
Calendar-picker doar prin overlay (input text vizibil + `input[type=date]`
mic `opacity:0` absolut deasupra) — model `formular.html`. Niciodată widget
nativ ca singur câmp.

## Input de FIȘIER — input ascuns + buton stilizat (REGULĂ DURĂ)

**Niciodată** `<input type="file">` nativ vizibil. Pattern canonic:
`public/js/components/opme-import-modal.js`.

```html
<input type="file" id="x-file" accept="application/pdf,.pdf" style="display:none">
<button type="button" class="df-action-btn" id="x-file-btn">
  <svg class="df-ico"><use href="/icons.svg#ico-upload"/></svg> Alege fișier
</button>
<div class="df-opme-preview" id="x-file-box" style="display:none">
  <div class="df-opme-preview__row">
    <svg class="df-ico"><use href="/icons.svg#ico-file-text"/></svg>
    <span class="df-opme-preview__name" id="x-file-name">—</span>
    <button type="button" class="df-opme-preview__remove" title="Elimină">&times;</button>
  </div>
</div>
```
`btn.onclick → input.click()`. Validează tip (`application/pdf`) + dimensiune
client-side înainte de POST. Trimite ca JSON `{ filename, mimeType, fileB64 }`
(base64 din `FileReader.readAsDataURL`, partea după `,`). Pentru drag&drop
folosește `.df-opme-modal__dropzone` (vezi modelul OPME).

## Modale

- Overlay `.df-modal-bg` + container `.df-modal` (max-width 920px, max-height
  90vh, scroll intern). Titlu `<h3>`. Deschidere/închidere prin
  `classList.add/remove('open')` — **NU** `style.display`.
- Câmpuri în `.df-frow` (label + input; stilul inputurilor vine automat din
  `.df-modal input/select/textarea` — nu re-stiliza). Layout pe coloane:
  `.df-grid-2` / `.df-grid-3` (colapsează la 1 col sub 640px).
- Footer: `.df-modal-footer` (alias `.df-modal-acts`); modifiere
  `.no-border`, `.split`. Conține `.df-action-btn` (anulare) +
  `.df-action-btn.primary` (acțiune).
- Mesaj inline în modal: element `.df-msg`, setat prin
  `window.df.showMsg(elem,'text','ok'|'err')`.

## Butoane

`.df-action-btn` + modifiers semantice: `.primary` (acțiune principală),
`.success`, `.warning`, `.danger` (distructiv/ireversibil — Șterge, Refuză),
`.teal`, `.cta` (un singur CTA major/pagină, gradient brand), `.ghost`.
Dimensiune: `.sm`, `.lg`. Formă: `.icon-only` (+ `.sm`), `.full-width`.
SVG-ul din buton se scalează automat după variantă — nu fixa tu width/height.
Nu construi butoane cu stil propriu.

## Tabele

Tabel standard: pune-l într-un `.card` (capătă automat polish: thead mic
uppercase `--df-text-4`, rânduri cu hover, fără bordură pe ultimul rând).
- Stare goală: `<div class="empty">Niciun rezultat</div>` (sau `.df-opme-lines__empty`).
- Filtre în thead: input cu clasa `.th-filter`; rândul `#filterRow`.
- Grilă editabilă (rânduri cu inputuri, ex. semnatari): `.signers-table`
  (input/select stilizate, `.drag-handle` pentru reordonare).
- Numere aliniate dreapta (clasa `.num` sau `text-align:right`), monospace
  unde ai coduri (`code` mic, `--df-text-3`).
- Tabel scrollabil orizontal pe mobil: wrapper `overflow-x:auto`.

## Badge-uri / status (convenție semantică unică)

Toate badge-urile folosesc aceeași limbă vizuală: pastilă mică, rotunjită,
triada `bg ~.14 alpha / border ~.3 / text` din culoarea semantică:
- ok / finalizat / succes → teal/verde (`--df-teal`/`--df-success`)
- în lucru / atenție / termen → amber (`--df-warning`)
- anulat / refuzat / eroare → roșu (`--df-danger`)
- neutru / inactiv / moștenit → slate (`--df-text-3`)
- info / revizie → bleumarin/violet (`--df-primary`/`--df-brand`)

Reutilizează familia existentă potrivită contextului: `.pill` (roluri),
`.stbadge.st-*` (statusuri flux/DF), `.df-revizie-badge`, `.df-opme-status--*`,
`.df-opme-badge--auto|manual`. Nu inventa o pastilă nouă dacă una din astea
acoperă cazul; dacă faci una nouă, respectă triada de mai sus.

## Sub-tab-uri (view fără reload)

```html
<div class="df-subtabs" data-subtabs-group="grup">
  <button class="df-subtab" data-subtab="a">Tab A
    <span class="df-subtab-count" id="aCount"></span></button>
  <button class="df-subtab" data-subtab="b">Tab B</button>
</div>
<div class="df-subview" data-subview="a">…</div>
<div class="df-subview" data-subview="b">…</div>
```
Wiring-ul îl face `public/js/df-subtabs.js` (include-l cu `?v=<versiune>` și
`defer`). Tab activ = `.df-subtab.active`; view activ = `.df-subview.active`.

## Iconițe

Sprite unic `/icons.svg`. Folosește `<svg class="df-ico"><use
href="/icons.svg#ico-NUME"/></svg>` (variante `.df-ico-sm|-lg|-xl`). Nu
lipi path-uri SVG inline. Păstrează schema de versionare `?v=` a iconițelor
exact cum e deja pe pagina respectivă.

## Heading-uri & secțiuni

- Titlu de secțiune cu icon: `.df-section-h2` (modifiere `.danger`, `.info`).
- Grupare în formulare lungi: `.df-form-section-title` (etichetă uppercase
  estompată, separator jos).
- Titlu card: `.card-title`.

## Mesaje, toast-uri, progres

- Inline (sub un câmp/secțiune): `.df-msg`. Atenție: există DOUĂ convenții —
  `.df-msg.ok/.err` (badge cu fundal) și `.df-msg--ok/--err` (doar culoare
  text, folosit de `window.df.showMsg`). Folosește `window.df.showMsg`
  pentru consistență; nu amesteca convențiile pe același element.
- Toast efemer (succes/eroare după acțiune): pattern host fix dreapta-jos,
  `pointer-events` corect (vezi `.df-opme-toast*` în `opme-import-modal.js`).
- Bară de progres upload: gradient `--df-primary → --df-teal`
  (`.df-opme-progress__bar`).

## Drawer (panou lateral pentru rapoarte/detalii read-only)

Pentru detalii ample (raport, listă mare) folosește drawer slide-in din
dreapta în loc de modal: overlay + panou (`.df-opme-drawer*`), animație
`dfOpmeSlideIn`, head + body scrollabil, tab-uri interne via `.df-subtabs`.
Pe mobil devine full-width. Model: `public/js/components/opme-report-drawer.js`.

## Carduri de statistici

Grilă `repeat(4,1fr)` → 2 coloane sub 640/768px. Card =
`.df-opme-stats-card` (număr mare + etichetă mică), cu variante semantice
`--ok|--warn|--muted|--yellow`.

## CSRF (toate requesturile care schimbă stare)

Double-submit cookie. Pe **fiecare** `fetch` POST/PUT/DELETE:
```javascript
function csrfHdr(){ const t=(window.df&&window.df.getCsrf)?window.df.getCsrf():null;
  return t?{'x-csrf-token':t}:{}; }
fetch(url,{method:'POST',credentials:'same-origin',
  headers:{'Content-Type':'application/json',...csrfHdr()},
  body:JSON.stringify(payload)});
```
Lipsa headerului → `403 csrf_invalid`. Model viu: `setari/entitlements.js`.

## Reguli transversale

- Escapează **tot** ce vine de la server/utilizator înainte de DOM:
  `window.df.esc(value)`. Nu construi HTML cu valori neescapate.
- **Zero** `localStorage` / `sessionStorage` (nesuportat — starea în memorie
  pe durata sesiunii).
- `font-family:inherit`, **niciodată** `font:inherit` (shorthand-ul resetează
  size/line-height). Pe inputuri în grile reia și `font-weight:inherit` dacă
  modelul vecin o face.
- Reutilizează helperele `df-utils.js`: `$ $q $qa`, `esc`,
  `parseDMYtoISO isoToDMY`, `getCsrf`, `debounce`, `downloadBlob`, `showMsg`.
- Responsive obligatoriu: orice layout multi-coloană trebuie să colapseze pe
  mobil. Breakpoint-uri folosite în proiect: **640px** (grile → 1 col),
  **768px** (drawer full-width, stats 2 col), **900px** (`.vf-grid-2` → 1 col).
- La orice modificare frontend: bump `package.json` + `CACHE_VERSION` în
  `public/sw.js` + cache busting `?v=<versiune>` în HTML-urile atinse.
- Adăugiri în `components.css`/`tokens.css`: **strict aditive**, la finalul
  fișierului, fără a modifica reguli existente; nu duplica o clasă existentă.

## Checklist înainte de a livra UI (toate trebuie „da")

1. Niciun `<input type="date">` vizibil ca singur câmp? (text `zz.ll.aaaa`)
2. Niciun `<input type="file">` nativ vizibil? (ascuns + `.df-action-btn`)
3. Zero culori hardcodate — totul `var(--df-*)`; zero alias legacy în cod nou?
4. Modale/butoane/tabele/badge/sub-tab folosesc clasele `.df-*` existente?
5. Toate POST/PUT/DELETE trimit `x-csrf-token` din `window.df.getCsrf()`?
6. Tot conținutul dinamic trecut prin `window.df.esc()`?
7. Zero `localStorage`/`sessionStorage`?
8. `font-family:inherit` (nu `font:inherit`)?
9. Layout-ul colapsează corect pe mobil (breakpoint-urile de mai sus)?
10. Iconițe din sprite `/icons.svg#ico-...`, nu SVG inline?
11. Bump versiune + `sw.js` `CACHE_VERSION` + cache busting `?v=` făcut?
12. Vizual: noul element e indistinct de un echivalent existent în aplicație?

Dacă oricare răspuns e „nu", nu e gata.
