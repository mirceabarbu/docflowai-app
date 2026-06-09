# DocFlowAI — 🎨 v3.9.482: Registratură Faza 2.2 — modal intrare conform design system (dată zz.ll.aaaa + upload stilizat)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.481 → v3.9.482 (SW v197 → v198)
Branch: develop
Subiect: fix(registratura,ui): modal „Înregistrare document intrat" conform
         design system — dată în format românesc zz.ll.aaaa (fără picker
         nativ mm/dd/yyyy) + upload fișier stilizat (fără „Choose File" nativ)
```

> **Citește mai întâi skill-ul `.claude/skills/docflowai-ui/SKILL.md`** (adăugat
> separat de Mircea). Acest fix aplică exact patternurile din el. Dacă skill-ul
> nu există încă în repo, aplică oricum patternurile descrise aici.

---

## 🎯 Context — 2 abateri de stil în modalul de intrare

Pe `registratura.html`, modalul „Înregistrare document intrat":

1. **Dată doc. expeditor** — `<input type="date">` nativ → browser-ul afișează
   `mm/dd/yyyy` (locale US), inconsistent cu restul aplicației care folosește
   format românesc `zz.ll.aaaa`. Pattern corect: input text + helperele
   `window.df.parseDMYtoISO` / `isoToDMY` (vezi `public/js/formular/draft.js`,
   `public/js/df-utils.js`).
2. **Document scanat (PDF)** — `<input type="file">` nativ → buton „Choose File
   / No file chosen" nestilizat. Pattern corect (canonic în
   `public/js/components/opme-import-modal.js`): input ascuns + buton stilizat
   `.df-action-btn` „Alege fișier" + rând de preview cu numele fișierului.

Logica funcțională (Faza 2 / 2.1) e corectă — schimbăm **doar prezentarea**
acestor două câmpuri și conversia datei la trimitere.

---

## ⛔ ABSOLUTE — NU se ating

1. `server/` — **nimic**. Acest fix e exclusiv frontend (`public/`).
2. NO-TOUCH permanent: `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`,
   `java-pades-client.mjs`, `STSCloudProvider.mjs`, `lifecycle.mjs`,
   `crud.mjs`, `stampFooterOnPdf`.
3. Endpoint-urile registratură și serviciul `allocateNumber` — neatinse
   (`dataDocExpeditor` deja acceptă `YYYY-MM-DD` sau `null`; trimitem ISO).
4. Logica de submit / upload atașament din Faza 2.1 — păstrată; se schimbă
   doar markup-ul celor 2 câmpuri și conversia datei înainte de POST.
5. Niciun test existent șters / dezactivat.

---

## 📋 Modificări detaliate (`public/registratura.html` + `public/js/registratura/main.js`)

> Inspectează ambele fișiere. Identifică în modalul de înregistrare câmpul
> „Dată doc. expeditor" și câmpul „Document scanat". Aplică punctual:

### 1. Câmpul „Dată doc. expeditor" → text `zz.ll.aaaa`

**Markup** — înlocuiește `<input type="date" ...>` cu:
```html
<input type="text" id="regin-f-data" maxlength="10" placeholder="zz.ll.aaaa"
       autocomplete="off" inputmode="numeric">
```
(păstrează `id`-ul existent dacă diferă — esențial e `type="text"` +
`placeholder="zz.ll.aaaa"` + `maxlength="10"`; clasa de stil vine din
`.df-modal input`, nu adăuga stil inline).

**La submit** — înainte de a construi payload-ul `POST /api/registratura/intrari`,
convertește valoarea:
```javascript
const _dataIso = window.df.parseDMYtoISO(
  (document.getElementById('regin-f-data')?.value || '').trim()
); // "12.05.2026" → "2026-05-12" ; invalid/gol → ""
```
și trimite `dataDocExpeditor: _dataIso || null` (în loc de valoarea brută a
inputului). Dacă utilizatorul a tastat ceva ce nu e dată validă (parse → ""),
trimite `null` (câmpul e opțional).

### 2. Câmpul „Document scanat (PDF, opțional)" → upload stilizat

**Markup** — înlocuiește `<input type="file" ...>` vizibil cu patternul ascuns
+ buton (replică structura din `opme-import-modal.js`):
```html
<input type="file" id="regin-f-file" accept="application/pdf,.pdf"
       style="display:none">
<button type="button" class="df-action-btn" id="regin-f-file-btn">
  <svg class="df-ico"><use href="/icons.svg#ico-upload"/></svg>
  Alege fișier
</button>
<div class="df-file-pick" id="regin-f-file-name" style="display:none;
     margin-top:8px;display:flex;align-items:center;gap:8px;
     font-size:.82rem;color:var(--df-text-2);">
  <svg class="df-ico"><use href="/icons.svg#ico-file-text"/></svg>
  <span id="regin-f-file-label">—</span>
  <button type="button" class="df-action-btn sm ghost" id="regin-f-file-clear"
          title="Elimină">&times;</button>
</div>
```
> Folosește exact stilul de iconiță (`/icons.svg#...`) deja prezent în
> `registratura.html`. Dacă pagina versionează `?v=` pe `icons.svg`, păstrează
> același scheme; nu inventa altul.

**JS** — în `main.js`, la inițializarea modalului:
```javascript
const _fIn  = document.getElementById('regin-f-file');
const _fBtn = document.getElementById('regin-f-file-btn');
const _fBox = document.getElementById('regin-f-file-name');
const _fLbl = document.getElementById('regin-f-file-label');
const _fClr = document.getElementById('regin-f-file-clear');
_fBtn.addEventListener('click', () => _fIn.click());
_fIn.addEventListener('change', () => {
  const f = _fIn.files && _fIn.files[0];
  if (!f) { _fBox.style.display = 'none'; return; }
  if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
    window.df.showMsg('regin-msg', 'Doar fișiere PDF sunt acceptate.', 'err');
    _fIn.value = ''; return;
  }
  if (f.size > 15 * 1024 * 1024) {
    window.df.showMsg('regin-msg', 'Fișierul depășește 15 MB.', 'err');
    _fIn.value = ''; return;
  }
  _fLbl.textContent = window.df.esc(f.name);
  _fBox.style.display = 'flex';
});
_fClr.addEventListener('click', () => {
  _fIn.value = ''; _fBox.style.display = 'none';
});
```
> ID-ul elementului de mesaj (`regin-msg` mai sus) trebuie să fie cel real din
> modal — inspectează și folosește id-ul existent al containerului `.df-msg`.

Logica de upload după create (Faza 2.1) rămâne neatinsă — citește în
continuare `_fIn.files[0]` ca base64 și face POST pe `/{id}/atasament`.
La reset/închidere modal, golește și `_fIn.value` + ascunde `_fBox` (adaugă
asta în funcția de reset existentă a modalului dacă există).

### 3. (Opțional, dacă lipsește) clasă utilitară `.df-file-pick`

Dacă `public/css/df/components.css` **nu** are deja `.df-file-pick`, adaug-o
(strict aditiv, la finalul fișierului, nu modifica reguli existente):
```css
.df-file-pick{display:flex;align-items:center;gap:8px;}
```
Dacă există deja o clasă echivalentă, folosește-o pe aceea și NU adăuga duplicat.

---

### 4. Bump versiune & cache busting

**4a. `package.json`:** old_str: `"version": "3.9.481",` → new_str: `"version": "3.9.482",`

**4b. `public/sw.js`:** old_str: `const CACHE_VERSION = 'docflowai-v197';` → new_str: `const CACHE_VERSION = 'docflowai-v198';`

**4c.** Cache busting:
```bash
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.481/\?v=3.9.482/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII

```bash
# 1. Data: nu mai există input type=date în registratura.html, există placeholder ro
grep -c 'type="date"' public/registratura.html                 # Așteptat: 0
grep -c 'placeholder="zz.ll.aaaa"' public/registratura.html     # Așteptat: ≥ 1
grep -c "parseDMYtoISO" public/js/registratura/main.js          # Așteptat: ≥ 1
grep -c "dataDocExpeditor: _dataIso" public/js/registratura/main.js  # Așteptat: 1

# 2. Fișier: input ascuns + buton stilizat, fără file input vizibil
grep -c 'type="file"[^>]*display:none' public/registratura.html  # Așteptat: ≥ 1
grep -c "regin-f-file-btn" public/registratura.html public/js/registratura/main.js | tail -1  # ≥ 1
grep -Ec 'class="df-action-btn"[^>]*>\s*<svg|Alege fișier' public/registratura.html  # ≥ 1
# Nu există file input vizibil (fără display:none) în modal:
grep -nE 'type="file"' public/registratura.html
# Inspectează manual: fiecare ocurență trebuie să aibă style="display:none"

# 3. Versiune + SW + cache busting
grep '"version"' package.json | head -1            # "version": "3.9.482",
grep "^const CACHE_VERSION" public/sw.js           # docflowai-v198
grep -rE "\?v=3\.9\.481" public/*.html | wc -l     # 0

# 4. NO-TOUCH — server intact (fix pur frontend)
git diff develop --name-only | grep -c "^server/" # Așteptat: 0
for p in cloud-signing bulk-signing pades java-pades-client; do
  git diff develop --name-only | grep -q "$p" && echo "FAIL $p" || echo "OK $p"
done
git diff develop -- server/index.mjs | wc -l       # Așteptat: 0

# 5. Syntax
node --check public/sw.js && echo "OK sw"
node -e "process.exit(0)" # placeholder; main.js e ES browser, validează prin lint dacă există
npm run check 2>/dev/null || echo "(npm run check indisponibil — skip)"

# 6. Tests
npm test
# Așteptat: verde, fără regresii (≥ 589)
```

---

## 📊 RAPORT FINAL

```
═══════════════════════════════════════════════════════════
RAPORT FINAL — v3.9.482 Registratură Faza 2.2 (UI)
═══════════════════════════════════════════════════════════
[ ] Data: input text zz.ll.aaaa, conversie parseDMYtoISO la submit
    (dataDocExpeditor = ISO || null), zero input type=date
[ ] Fișier: input ascuns + buton .df-action-btn „Alege fișier" + preview nume
    + clear; zero „Choose File" nativ vizibil
[ ] (dacă a fost cazul) .df-file-pick adăugată aditiv în components.css
[ ] reset modal golește file input + ascunde preview
[ ] package.json 3.9.482 + sw v198 + cache busting (0 ?v=3.9.481)
[ ] VERIFICĂRILE 1–5 trec
[ ] npm test VERDE (≥ 589) — output atașat
[ ] server/ neatins (git diff --name-only ^server/ = 0)
[ ] git push origin develop

Smoke staging (Mircea):
  [ ] Modal intrare: data se tastează zz.ll.aaaa, se salvează corect (verifică
      în listă / DB că data_doc_expeditor e corectă, nu offset de lună/zi)
  [ ] „Alege fișier" stilizat ca restul aplicației; numele apare; clear merge
  [ ] Înregistrare cu PDF atașat → poziție creată + atașament descărcabil
  [ ] Vizual: modalul e indistinct de modalele OPME/formular ca stil

Fișiere modificate: ____   OBSERVAȚII: ____
═══════════════════════════════════════════════════════════
```

---

## 🔒 CONSTRÂNGERI ABSOLUTE

1. develop only. Niciun checkout/merge/push pe `main`.
2. Fix **pur frontend** — `server/` rămâne neatins (verificat: `git diff
   --name-only` nu conține `^server/`).
3. Patternuri conform `.claude/skills/docflowai-ui/SKILL.md`: dată
   `zz.ll.aaaa` + `parseDMYtoISO`/`isoToDMY`; fișier ascuns + `.df-action-btn`.
4. Zero culori hardcodate; clase `.df-*` + `var(--df-...)`.
5. `window.df.esc()` pe numele fișierului afișat. Zero `localStorage`.
6. Logica funcțională Faza 2/2.1 (submit, CSRF, upload pe id) — neatinsă.
7. `npm test` verde, fără regresii. Niciun test șters.
8. La final, după teste verzi: `git add -A && git commit && git push origin develop`.
```
