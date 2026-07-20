---
title: "Formulare — coerență vizuală subtaburi (bannere descriere + contoare + bară filtre)"
branch: develop
model_suggested: Sonnet 4.6 (Default)   # pur CSS + markup, zero JS/backend, risc mic
version_bump: citește versiunea curentă din package.json și incrementează patch (aștept 3.9.696 → 3.9.697)
cache_bump: NU (formular.css / formular.html NU sunt în PRECACHE_ASSETS)
---

# ⚠️⚠️ BRANCH: develop ⚠️⚠️
`main` = PRODUCȚIE, MANUAL de Mircea. NU checkout/merge/push pe `main`.

====================================================================
OBIECTIV
====================================================================
La navigarea între taburile DF/ORD · Clasa 8 · Facturi · Verificare furnizor, bannerele de
descriere și contoarele arată diferit (altă culoare, alt font, altă plasare). Le aducem la o
regulă unică. STRICT CSS + markup HTML — NU atinge JS (toate id-urile rămân neschimbate,
`clasa8.js`/`facturi.js` continuă să seteze `clasa8-counter`/`facturi-counter` și inputurile
prin aceleași id-uri) și NU atinge backend.

Diagnostic (verificat pe cod v3.9.696):
  • Banner descriere: DF/ORD, Clasa 8, Verificare = `.df-info-banner` (mov). FACTURI = box
    teal inline (altă culoare + font). → Facturi trece pe `.df-info-banner`.
  • Marginile bannerului: clasa dă 12px, dar Clasa 8/Verificare suprascriu inline 18px,
    Facturi 14px. → o singură valoare în clasă, fără suprascrieri.
  • Contor: Clasa 8 e în bara de filtre, Facturi pe rând separat; fonturi ușor diferite față
    de `.lst-count` (DF/ORD). → clasă comună `.df-count`, plasare identică deasupra tabelului.
  • Filtru Clasa 8: inputuri cu stiluri inline brute; DF/ORD/Facturi folosesc `.flt-*`. →
    Clasa 8 migrează la clasele canonice.

Regula finală pentru un tab tip-listă:
  [.df-info-banner] → [.lst-filters/.flt-*] → [.df-count-row cu .df-count] → [tabel]

⛔ NU atinge server/* și nici JS-ul. Doar `public/css/formular/formular.css` +
`public/formular.html`.

====================================================================
PAS 1 — CSS: clase comune + margine banner unică (public/css/formular/formular.css)
====================================================================
1.1 Contor comun. Adaugă lângă `.lst-count` (≈ linia 189):
```css
    .df-count-row{display:flex;justify-content:flex-end;align-items:center;margin-bottom:12px}
    .df-count{font-size:13px;color:var(--df-text-3)}
    .df-count b,.df-count strong{color:var(--df-text);font-weight:600}
```
1.2 Margine banner unică. Găsește `.df-info-banner` (≈ linia 367) și schimbă DOAR
`margin-bottom:12px` → `margin-bottom:16px` (valoare unică pentru toate bannerele; restul
proprietăților rămân neatinse). Verifică:
```bash
grep -n "df-info-banner{" public/css/formular/formular.css
# după edit: margin-bottom:16px în regulă
```

====================================================================
PAS 2 — Facturi: box teal → .df-info-banner (public/formular.html)
====================================================================
old_str:
```html
  <div style="padding:10px 14px;margin-bottom:14px;background:var(--df-teal-bg);border:1px solid var(--df-teal-bd);border-radius:var(--df-radius-md);font-size:.85rem;color:var(--df-text-2);">
    🧾 <strong>Centralizator facturi</strong> — toate facturile completate în lichidarea ciclurilor ALOP
    (curente și arhivate). Read-only. Coloanele <strong>ALOP</strong> și <strong>DF</strong> sunt clicabile;
    <strong>ORD</strong> devine clicabilă după întocmire.
  </div>
```
new_str:
```html
  <div class="df-info-banner">
    🧾 <strong>Centralizator facturi</strong> — toate facturile completate în lichidarea ciclurilor ALOP
    (curente și arhivate). Read-only. Coloanele <strong>ALOP</strong> și <strong>DF</strong> sunt clicabile;
    <strong>ORD</strong> devine clicabilă după întocmire.
  </div>
```

====================================================================
PAS 3 — Facturi: contorul pe clasa comună (public/formular.html)
====================================================================
Contorul Facturi e deja pe rând propriu, dar cu stil inline. Normalizează-l.
old_str:
```html
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
    <span id="facturi-counter" style="margin-left:auto;font-size:.83rem;color:var(--df-text-3);">— facturi</span>
  </div>
```
new_str:
```html
  <div class="df-count-row">
    <span id="facturi-counter" class="df-count">— facturi</span>
  </div>
```

====================================================================
PAS 4 — Verificare furnizor: scoate suprascrierea de margine (public/formular.html)
====================================================================
Verificare furnizor e un tab-„tool" (carduri CUI/IBAN) — lăsăm cardurile așa cum sunt, doar
aliniem bannerul.
old_str:
```html
  <div class="df-info-banner" style="margin-bottom:18px;">
    ℹ️ Modul de verificare furnizor
```
new_str:
```html
  <div class="df-info-banner">
    ℹ️ Modul de verificare furnizor
```
(păstrează restul textului bannerului neschimbat)

====================================================================
PAS 5 — Clasa 8: banner + filtru canonic + contor pe rând propriu
====================================================================
5.1 Bannerul Clasa 8 — scoate suprascrierea de margine:
old_str:
```html
  <div class="df-info-banner" style="margin-bottom:18px;">
    🏛️ <strong>Centralizator Clasa 8</strong>
```
new_str:
```html
  <div class="df-info-banner">
    🏛️ <strong>Centralizator Clasa 8</strong>
```
(restul textului neschimbat)

5.2 Bara de filtre → clase canonice + contor scos din bară pe rând propriu.
Citește blocul de filtre Clasa 8 (≈ liniile 356-376). Înlocuiește-l:
old_str:
```html
  <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;max-width:420px;">
      <label style="font-size:.77rem;color:var(--df-text-3);display:block;margin-bottom:4px;">
        🔎 Filtrare după Cod SSI
      </label>
      <input id="clasa8-filter-ssi" type="text" autocomplete="off"
             placeholder="ex: 510, 0001, A52... (caută în orice poziție)"
             style="width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid var(--df-border-2);border-radius:8px;color:var(--df-text);font-size:.9rem;box-sizing:border-box;">
    </div>
    <button id="clasa8-btn-reset" type="button" class="df-action-btn sm" title="Curăță toate filtrele">
      <svg class="df-ic"><use href="/icons.svg?v=3.9.693#ico-refresh"/></svg> Reset
    </button>
    <span id="clasa8-counter" style="margin-left:auto;font-size:.83rem;color:var(--df-text-3);">— înregistrări</span>
    <button id="clasa8-btn-import" type="button" class="df-action-btn" data-df-module="clasa8">
      <svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-upload-cloud"/></svg> Import buget
    </button>
    <button id="clasa8-btn-export" type="button" class="df-action-btn primary">
      <svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-download"/></svg> Export Excel
    </button>
  </div>
```
new_str:
```html
  <div class="lst-filters">
    <div class="lst-filter-row">
      <div class="flt-grp" style="flex:1.6 1 240px;">
        <label class="flt-lbl">🔎 Filtrare Cod SSI</label>
        <input id="clasa8-filter-ssi" class="flt-inp" type="text" autocomplete="off"
               placeholder="ex: 510, 0001, A52... (caută în orice poziție)">
      </div>
      <button id="clasa8-btn-reset" type="button" class="df-action-btn sm" style="align-self:flex-end" title="Curăță toate filtrele">
        <svg class="df-ic"><use href="/icons.svg?v=3.9.693#ico-refresh"/></svg> Reset
      </button>
      <button id="clasa8-btn-import" type="button" class="df-action-btn" style="align-self:flex-end" data-df-module="clasa8">
        <svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-upload-cloud"/></svg> Import buget
      </button>
      <button id="clasa8-btn-export" type="button" class="df-action-btn primary" style="align-self:flex-end">
        <svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-download"/></svg> Export Excel
      </button>
    </div>
  </div>
  <div class="df-count-row">
    <span id="clasa8-counter" class="df-count">— înregistrări</span>
  </div>
```
⚠️ Id-urile `clasa8-filter-ssi`, `clasa8-counter`, `clasa8-btn-reset/import/export` rămân
IDENTICE → `clasa8.js` funcționează fără nicio modificare. NU atinge clasa8.js.

====================================================================
PAS 6 — (finețe, opțional dar recomandat) buton Reset uniform la Facturi
====================================================================
Butonul Reset de la Facturi e doar „↺"; la Clasa 8 e „↺ Reset". Aliniază-l (dacă e ușor):
în bara de filtre Facturi, butonul `_resetFacturiFilters()` → conținut `↺ Reset` în loc de `↺`.
Dacă modificarea nu e curată (spațiu îngust), las-o — nu strica layout-ul.

====================================================================
PAS 7 — Version bump + ?v=
====================================================================
```bash
node -p "require('./package.json').version"
# incrementează patch (ex. 3.9.696 → 3.9.697) în package.json
# ?v= bulk pe public/*.html (formular.css + formular.html s-au schimbat)
sed -i -E 's/\?v=3\.9\.[0-9]+/?v=3.9.697/g' public/*.html
grep -c 'formular.css?v=3.9.697' public/formular.html   # Așteptat: 1 (linkul CSS bumpat)
npm test   # verde — nu există teste pe markup; verifică non-regresie
```
NU bumpa CACHE_VERSION (formular.css / formular.html NU sunt în PRECACHE_ASSETS — confirmă
cu `grep -n "formular.css\|formular.html" public/sw.js` → nu apar în PRECACHE_ASSETS).

====================================================================
VERIFICARE MANUALĂ (staging)
====================================================================
1. DevTools → SW → Unregister, Ctrl+Shift+R.
2. Comută DF → ORD → Clasa 8 → Facturi → Verificare furnizor: bannerul de descriere are
   ACEEAȘI culoare (mov), font și margine în toate.
3. Clasa 8 și Facturi: bara de filtre arată identic cu DF/ORD (același input/label/spacing);
   contorul e pe rând propriu, aliniat dreapta, deasupra tabelului, cu același font/culoare.
4. Filtrarea Clasa 8 după Cod SSI încă funcționează (id neschimbat); contorul se actualizează.
5. Filtrele/sortarea/exportul Facturi funcționează neschimbat.
6. Console: zero erori.

RAPORT FINAL: lista fișierelor atinse (doar formular.css + formular.html), confirmarea că
NICIUN fișier JS/backend nu a fost modificat, că toate id-urile s-au păstrat, npm test,
versiune, confirmarea că CACHE_VERSION a rămas neatins.
⛔ develop ONLY · doar CSS+HTML · id-uri păstrate · fără JS/backend · fără cache bump.
