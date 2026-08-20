---
prompt_id: PAGIN-1
titlu: Componentă partajată de paginare (modul pur, ZERO consumatori)
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.715
migratii: NU
cache_version_bump: NU
v_param_bump: NU (niciun fișier HTML nu se atinge în acest prompt)
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: 696aee2 (logo v3.9.714) sau descendent
git status --porcelain      # fișierele .md netracked din docs/archive/ pot rămâne, nu le atinge
```

---

# CONTEXT

Aplicația are **șase** implementări separate de paginare în frontend, în DOUĂ familii vizuale legitime:

| Familia | Fișiere | Clase CSS | Navigare | Etichetă |
|---|---|---|---|---|
| **simple** | `formular/list.js`, `formular/alop.js` | `.lst-pagination`, `.lst-page-info` | prev/next | „Pagina X din Y (N total)" |
| **numbered** | `admin/flows.js`, `admin/users.js`, `admin/audit.js`, `admin/primarii.js` | `.pagination`, `.pg-btn`, `.pg-info` | prev/next **+ butoane numerotate cu „…"** | „51–60 din 234" |

Backendurile sunt corecte peste tot (`page/limit/total/pages`). Datoria e strict de frontend.

**Acest prompt creează DOAR componenta partajată, cu testele ei. ZERO consumatori.** Fișierul rămâne deliberat neîncărcat de nicio pagină până la PAGIN-2 — asta e intenția, nu o scăpare: dacă apare o regresie la cablare, o putem reverti fără să atingem componenta.

⚠️ Componenta trebuie să suporte AMBELE moduri. Familia „numbered" e mai bogată — a o coborî la prev/next ar fi o regresie funcțională pentru adminii cu liste lungi.

---

# Pas 1 — `public/js/shared/pagin.js` (fișier NOU)

**Script CLASIC**, nu modul ES. Toate fișierele din `public/js/` se încarcă prin `<script src=…>` fără `type="module"` (verificat în `admin.html`). Expune `window.DFPagin`.

Contract public:

```js
window.DFPagin = {
  pageWindow(page, totalPages, maxVisible),  // pur — întoarce [1,'…',4,5,6,'…',20]
  render(opts),                              // randează în container
};
```

### `pageWindow(page, totalPages, maxVisible = 7)`

Funcție **pură**, fără DOM — asta e logica delicată și de asta o testăm separat.

- dacă `totalPages <= maxVisible` ⇒ întoarce toate paginile: `[1,2,…,totalPages]`
- altfel: întotdeauna include `1` și `totalPages`, plus fereastra `page-2 … page+2`, cu `'…'` (caracterul U+2026, nu trei puncte) inserat în golurile rezultate
- niciodată două `'…'` consecutive; niciodată `'…'` în locul unei singure pagini lipsă (dacă golul e de exact 1 pagină, pune pagina)
- `page` în afara intervalului se clamează la `[1, totalPages]`
- `totalPages <= 0` ⇒ `[]`

### `render(opts)`

```js
DFPagin.render({
  container,          // Element SAU string id — obligatoriu
  total,              // număr total de înregistrări (de la server, NU rows.length)
  page,               // pagina curentă (1-based)
  limit,              // înregistrări per pagină
  onChange,           // (newPage:number) => void — obligatoriu
  mode = 'simple',    // 'simple' | 'numbered'
  maxVisible = 7,     // doar pentru 'numbered'
});
```

Comportament obligatoriu:

1. **Golește containerul** la fiecare apel (`replaceChildren()`) — apeluri repetate NU dublează butoanele.
2. `totalPages = Math.ceil(total / limit) || 1`. Dacă `limit <= 0` sau nu e finit, tratează ca `1` și nu arunca.
3. Dacă `totalPages <= 1` ⇒ `container.style.display = 'none'` și **nu randa nimic**.
4. Altfel `container.style.display = ''` (mode `numbered`) sau `'flex'` (mode `simple`, ca `.lst-pagination` din `formular.css`).
5. **mode `simple`** — reproduce exact ce e azi în `formular.html` (păstrăm compatibilitatea vizuală):
   - `container.className = 'lst-pagination'`
   - buton `← Anterior` (`class="df-action-btn sm"`, `disabled` când `page <= 1`)
   - `<span class="lst-page-info">Pagina X din Y (N total)</span>`
   - buton `Următor →` (`class="df-action-btn sm"`, `disabled` când `page >= totalPages`)
6. **mode `numbered`** — reproduce familia admin:
   - `container.className = 'pagination'`
   - buton `◀` (`class="pg-btn"`, `disabled` când `page <= 1`)
   - `<span class="pg-info">{from}–{to} din {total}</span>` unde `from = (page-1)*limit + 1` și `to = Math.min(page*limit, total)`
   - butoanele numerotate din `pageWindow(...)`; cel curent primește `class="pg-btn active"`; elementele `'…'` devin `<span class="pg-info">…</span>` **fără** handler
   - buton `▶` (`class="pg-btn"`, `disabled` când `page >= totalPages`)
7. **Zero `onclick` inline, zero `innerHTML`.** Doar `document.createElement`, `textContent` și `addEventListener('click', …)`. (Regula casei — clasa XSS-01.)
8. `onChange` primește **numărul paginii țintă**, nu o direcție. Prev ⇒ `page-1`, next ⇒ `page+1`, buton numerotat ⇒ acel număr. Nu apela `onChange` pentru butoane `disabled` sau pentru pagina curentă.
9. Fără `fetch`, fără stare globală, fără citiri din DOM în afara containerului. Componenta randează ce i se dă și anunță ce s-a apăsat — atât.

Adaugă în capul fișierului un comentariu-antet care spune de ce există (consolidarea celor șase implementări) și că e încărcată explicit de fiecare pagină, în ordinea de dinaintea scripturilor care o folosesc.

---

# Pas 2 — `server/tests/unit/pagin-component.test.mjs` (fișier NOU)

⚠️ Testul **importă comportamentul real**, nu redeclară logica. Fișierele din `public/js/` sunt scripturi clasice, deci nu se pot `import`-a direct. Convenția din repo pentru teste de frontend e `readFileSync` (vezi `server/tests/unit/clasa8-frontend.test.mjs`) — dar acolo se face doar analiză statică pe text, ceea ce e prea slab pentru o componentă cu logică.

Folosește DOM real prin `happy-dom` (deja în `package.json`), cu docblock per fișier:

```js
// @vitest-environment happy-dom
```

și încarcă scriptul clasic evaluându-l o singură dată:

```js
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const src = readFileSync(join(__dir, '../../../public/js/shared/pagin.js'), 'utf8');
// evaluează scriptul clasic în contextul global al happy-dom
new Function(src).call(globalThis);
const DFPagin = globalThis.window.DFPagin;
```

⚠️ Dacă `happy-dom` nu expune `window` pe `globalThis` așa cum te aștepți, **verifică prin rulare**, nu presupune — ajustează încărcarea și raportează cum ai făcut-o. Nu ocoli problema mock-uind componenta.

Cazuri obligatorii:

**A. `pageWindow` (pur)**
1. `totalPages = 5, maxVisible = 7` ⇒ `[1,2,3,4,5]`, fără `'…'`
2. `page = 10, totalPages = 20` ⇒ conține `1`, `20`, fereastra `8..12` și exact două `'…'`
3. `page = 1, totalPages = 20` ⇒ începe cu `1,2,3`, nu are `'…'` la început
4. `page = 20, totalPages = 20` ⇒ se termină cu `18,19,20`, nu are `'…'` la final
5. niciodată două `'…'` consecutive (verifică pe mai multe combinații)
6. un gol de exact o pagină e umplut cu pagina, nu cu `'…'`
7. `totalPages = 0` ⇒ `[]`; `page = 99` cu `totalPages = 3` ⇒ clamp, fără excepție

**B. `render` — mod `simple`**
8. `total = 5, limit = 20` ⇒ container ascuns (`display === 'none'`), zero copii randați
9. `total = 45, limit = 20, page = 1` ⇒ text „Pagina 1 din 3 (45 total)", prev `disabled`, next activ
10. `page = 3` ⇒ next `disabled`
11. click pe next ⇒ `onChange` primit cu `2` (nu cu `+1`)

**C. `render` — mod `numbered`**
12. `total = 234, limit = 10, page = 6` ⇒ `.pg-info` conține „51–60 din 234"
13. ultima pagină clamează intervalul la `total` (ex. `total = 45, limit = 10, page = 5` ⇒ „41–45 din 45")
14. pagina curentă are clasa `active`; exact UNA singură
15. click pe un buton numerotat ⇒ `onChange` cu acel număr
16. click pe pagina CURENTĂ ⇒ `onChange` NU se apelează
17. elementele `'…'` nu au handler de click (nu declanșează `onChange`)

**D. Robustețe**
18. două apeluri `render` consecutive pe același container ⇒ numărul de butoane NU se dublează
19. `limit = 0` ⇒ nu aruncă, tratează ca o singură pagină
20. **igienă XSS**: sursa componentei nu conține `innerHTML` și nu conține `onclick=` — verifică prin regex pe `src` (asta e singura aserțiune statică justificată)

---

# Pas 3 — verificări

```bash
node --check public/js/shared/pagin.js
# Așteptat: fără output

grep -c "innerHTML\|onclick=" public/js/shared/pagin.js
# Așteptat: 0

grep -rn "pagin.js" public/*.html
# Așteptat: NICIUN rezultat — componenta e deliberat necablată în acest prompt

npx vitest run server/tests/unit/pagin-component.test.mjs
# Așteptat: toate cele 20 de cazuri verzi

npm test
# Așteptat: verde, fără regresii

npm run test:db
# Așteptat: PASSED (nu SKIPPED). Setează întâi:
#   TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/docflow_test
# Promptul nu atinge backendul, dar poarta rămâne — „skipped" nu se raportează ca „ok".

git diff --stat
# Așteptat: EXACT 2 fișiere NOI + package.json/package-lock.json (bump).
# ZERO fișiere modificate în public/js/formular/, public/js/admin/ sau public/*.html.
```

```bash
npm version 3.9.715 --no-git-tag-version
git add -A
git commit -m "feat(ui): componentă partajată de paginare, simple + numbered (PAGIN-1, v3.9.715)"
git push origin develop
```

---

# RAPORT FINAL

1. Diff pe fiecare fișier.
2. **Confirmarea izolării**: `git diff --stat` arată doar fișiere NOI + bump? `grep -rn "pagin.js" public/*.html` e gol?
3. Cum ai încărcat scriptul clasic în happy-dom (codul exact) — mai ales dacă a fost nevoie de ajustări față de ce am scris eu.
4. Cele 20 de cazuri: câte verzi, care (dacă vreunul) a cerut ajustarea componentei și de ce.
5. `pageWindow` — arată ieșirea REALĂ pentru `(10, 20, 7)` și `(1, 20, 7)`, ca să pot verifica eu forma ferestrei.
6. `npm test` și `npm run test:db` — PASSED/FAILED, nu SKIPPED.
7. Commit hash + confirmare `develop`.
8. Orice abatere, cu motivul.

---

# ⛔ CONSTRÂNGERI

- ⛔ **ZERO consumatori.** Nu atinge `list.js`, `alop.js`, `admin/flows.js`, `admin/users.js`, `admin/audit.js`, `admin/primarii.js`, `registratura/main.js`, `semdoc-initiator/main.js` sau vreun `.html`. Cablarea e PAGIN-2.
- ⛔ **Nu modifica CSS.** Componenta reutilizează clasele EXISTENTE (`.lst-pagination`, `.lst-page-info`, `.pagination`, `.pg-btn`, `.pg-info`, `.df-action-btn sm`). Dacă o clasă îți lipsește, **oprește-te și raportează** — nu inventa stiluri.
- ⛔ **Fără `innerHTML`, fără `onclick` inline.** Doar `createElement` / `textContent` / `addEventListener`.
- ⛔ **Nu face din `pagin.js` un modul ES.** Scripturile din `public/js/` se încarcă clasic; un `export` ar rupe încărcarea la PAGIN-2.
- ⛔ Fără migrații, fără `CACHE_VERSION`, fără `?v=`.
- ⛔ Zero atingeri în `server/` în afara fișierului nou de test.
- ⛔ Dacă testul nu poate încărca scriptul în happy-dom, **NU trece la analiză statică pe text ca înlocuitor** — oprește-te și raportează. Un test care doar caută șiruri în sursă nu validează comportamentul, iar aici comportamentul e tot ce contează.
