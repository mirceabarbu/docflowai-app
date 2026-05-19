---
name: docflowai-ui
description: >
  Convenții UI obligatorii pentru orice lucru pe frontend-ul DocFlowAI
  (fișiere din public/ — .html și js/*.js). Folosește acest skill ORI DE
  CÂTE ORI creezi sau modifici un formular, modal, input de dată, input de
  fișier, buton, tabel sau orice element vizibil în public/. Acoperă: design
  system-ul df (tokens.css + components.css, prefix .df-), patternul de dată
  în format românesc (zz.ll.aaaa, NU input type=date nativ), patternul de
  upload fișier (input ascuns + buton .df-action-btn, NU butonul nativ
  „Choose File"), structura de modal, sistemul de butoane, CSRF, escaping,
  interdicția localStorage și bump-ul de versiune. Declanșează-l înainte de a
  scrie orice markup sau JS de UI; ignorarea lui produce UI inconsistent cu
  restul aplicației (exact regresia native date picker / native file button).
---

# DocFlowAI — Convenții UI frontend

Scop: orice element vizibil nou trebuie să fie **indistinct** de restul
aplicației. Înainte de a livra UI, treci checklist-ul de la final.

## Design system

- CSS-ul partajat e în `public/css/df/tokens.css` (variabile) +
  `public/css/df/components.css` (clase `.df-*`). **Nu inventa clase noi** dacă
  există una `.df-*` care acoperă cazul. Nu hardcoda culori — folosește
  `var(--df-...)` (`--df-surface`, `--df-border-2`, `--df-text-2`,
  `--df-brand`, `--df-primary-bg` etc.).
- Stilurile inline ad-hoc sunt permise doar pentru poziționare punctuală, nu
  pentru a reproduce ceva ce o clasă `.df-*` face deja.
- La fonturi folosește `font-family:inherit`, **niciodată** `font:inherit`
  (shorthand-ul resetează size/line-height și sparge layout-ul).

## Input de DATĂ — format românesc (REGULĂ DURĂ)

**Niciodată** nu lăsa un `<input type="date">` ca element vizibil — browser-ul
îl randează în locale-ul lui (`mm/dd/yyyy` în en-US), inconsistent cu aplicația
și derutant pentru utilizatori români.

Pattern corect (vezi `public/js/formular/draft.js` + `public/js/df-utils.js`):

```html
<div class="df-frow">
  <label>Dată doc. expeditor</label>
  <input type="text" id="x-data" maxlength="10" placeholder="zz.ll.aaaa"
         autocomplete="off" inputmode="numeric">
</div>
```

Conversie la trimitere/citire prin helperele globale (read-only, din `df-utils.js`):

```javascript
const iso = window.df.parseDMYtoISO(el.value); // "12.05.2026" → "2026-05-12" | ""
// trimite spre API: iso || null   (coloanele DATE acceptă YYYY-MM-DD)
el.value = window.df.isoToDMY(isoFromApi);      // "2026-05-12" → "12.05.2026"
```

Dacă e nevoie de calendar-picker, folosește patternul de overlay din
`formular.html` (input text vizibil + `input[type=date]` mic, `opacity:0`,
poziționat absolut peste, cu `onchange` care scrie în display-ul text).
Nu expune niciodată direct widget-ul nativ ca singur câmp.

## Input de FIȘIER — input ascuns + buton stilizat (REGULĂ DURĂ)

**Niciodată** nu lăsa vizibil `<input type="file">` nativ (butonul „Choose
File / No file chosen" e nestilizat și inconsistent).

Pattern canonic — replică din `public/js/components/opme-import-modal.js`:

```html
<input type="file" id="x-file" accept="application/pdf,.pdf" style="display:none">
<button type="button" class="df-action-btn" id="x-file-btn">
  <svg class="df-ico"><use href="/icons.svg#ico-upload"/></svg>
  Alege fișier
</button>
<div class="df-file-pick" id="x-file-name" style="display:none">
  <span></span>
  <button type="button" class="df-file-remove" title="Elimină">&times;</button>
</div>
```

```javascript
const inp = df.$('x-file'), btn = df.$('x-file-btn');
btn.addEventListener('click', () => inp.click());
inp.addEventListener('change', () => {
  const f = inp.files && inp.files[0];
  // validează tip + dimensiune client-side înainte de upload
  // afișează numele în #x-file-name, ascunde butonul dacă vrei
});
```

Citește fișierul ca base64 (`FileReader.readAsDataURL`, ia partea de după `,`)
și trimite-l ca JSON `{ filename, mimeType, fileB64 }`. Validează tipul
(`application/pdf`) și dimensiunea pe client înainte de POST.

## Modale

- Overlay `.df-modal-bg` + container `.df-modal`; deschidere/închidere prin
  `classList.add('open')` / `classList.remove('open')` (NU `style.display`).
- Câmpuri în `.df-frow` (label `.df-frow label` + input). Două coloane:
  `.df-grid-2`. Inputurile capătă stilul df automat din `.df-modal input/select/textarea`.
- Footer: `.df-modal-footer` cu `<button class="df-action-btn">Renunță</button>`
  + `<button class="df-action-btn primary">Acțiune</button>`.
- Mesaje inline: element cu `.df-msg`, setat prin `window.df.showMsg(el,'text','ok'|'err')`.

## Butoane

Folosește `.df-action-btn` (+ modifiers: `.primary`, `.success`, `.warning`,
`.danger`, `.teal`, `.sm`, `.lg`, `.ghost`, `.icon-only`, `.full-width`).
Nu construi butoane cu stil propriu.

## CSRF (toate requesturile care schimbă stare)

Schema e double-submit cookie. Pe **fiecare** `fetch` POST/PUT/DELETE:

```javascript
function csrfHdr() {
  const t = (window.df && window.df.getCsrf) ? window.df.getCsrf() : null;
  return t ? { 'x-csrf-token': t } : {};
}
fetch(url, { method:'POST', credentials:'same-origin',
  headers: { 'Content-Type':'application/json', ...csrfHdr() },
  body: JSON.stringify(payload) });
```

Lipsa headerului → `403 csrf_invalid`. Model viu: `public/js/setari/entitlements.js`.

## Reguli transversale

- Escapează **tot** ce vine de la server/utilizator înainte de a-l pune în DOM:
  `window.df.esc(value)`. Nu construi HTML cu valori neescapate.
- **Zero** `localStorage` / `sessionStorage` (nesuportat în mediul aplicației;
  starea trăiește în memorie pe durata sesiunii).
- Reutilizează helperele din `df-utils.js`: `$ $q $qa`, `esc`,
  `parseDMYtoISO isoToDMY`, `getCsrf`, `debounce`, `downloadBlob`, `showMsg`.
- La orice modificare de frontend: bump `package.json` + `CACHE_VERSION` în
  `public/sw.js` + cache busting `?v=<versiune>` în HTML-urile atinse.
- Referințele de iconițe folosesc `/icons.svg#ico-...`; păstrează stilul de
  versionare deja prezent pe pagina respectivă, nu inventa alt scheme.

## Checklist înainte de a livra UI (rulează-l mental, pe toate)

1. Niciun `<input type="date">` vizibil ca singur câmp? (text `zz.ll.aaaa` +
   `parseDMYtoISO`/`isoToDMY`)
2. Niciun `<input type="file">` vizibil nativ? (ascuns + `.df-action-btn`
   „Alege fișier" + preview nume)
3. Toate inputurile/butoanele/modalele folosesc clase `.df-*`, zero culori
   hardcodate?
4. Toate POST/PUT/DELETE trimit `x-csrf-token` din `window.df.getCsrf()`?
5. Tot conținutul dinamic trecut prin `window.df.esc()`?
6. Zero `localStorage`/`sessionStorage`?
7. `font-family:inherit` (nu `font:inherit`)?
8. Bump versiune + `sw.js` `CACHE_VERSION` + cache busting `?v=` făcut?
9. Vizual: noul element e indistinct de un element echivalent existent în
   altă pagină a aplicației?

Dacă oricare răspuns e „nu", nu e gata.
