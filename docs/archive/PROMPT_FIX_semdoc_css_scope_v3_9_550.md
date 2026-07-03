# DocFlowAI — 🧯 Fix la sursă: scopează selectorii generici din semdoc-initiator.css la `.df-shell`

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.549 → v3.9.550
Branch: develop
Subiect: fix(semdoc-initiator-css): scopează selectorii pe element gol la .df-shell (oprește scurgerea în componentele body-level)
Tip: FIX CSS la sursă — DOAR semdoc-initiator.css. Pagina trebuie să arate IDENTIC.
     Schimbare de frontend → BUMP CACHE_VERSION + ?v=.
```

---

## 🎯 Scop

`semdoc-initiator.css` are selectori pe **element gol** (`label`, `input`, `input,select,textarea`,
`:focus`, placeholder) — unii cu `!important`. Fiindcă CSS-ul e global, ei se aplică NU doar
formularelor paginii, ci și oricărui component injectat în `<body>` (ex. modalul de email
`.dfem-overlay`, atașat ca frate al `.df-shell`). De-aici scurgerea care a rupt modalul.

Fix la sursă: **scopează acești selectori la `.df-shell`** (wrapper-ul care conține tot conținutul
paginii). Efect:
- formularele paginii sunt TOATE în `.df-shell` → regulile le prind identic → **pagina arată
  byte-identic** (zero schimbare vizuală);
- modalul (și orice component body-level viitor) e în AFARA `.df-shell` → scapă de scurgere.

Nu ștergi și nu schimbi reguli — doar le constrângi *unde* se aplică. Tot ce depinde de ele e deja
în interiorul constrângerii.

**Criteriul de corectitudine:** pagina semdoc-initiator trebuie să arate **identic** înainte/după.
Modalul de email trebuie să fie corect (deja e, din v3.9.549 defensiv — acum și sursa e curată).

---

## 🚫 Zone interzise

- DOAR `public/css/semdoc-initiator/semdoc-initiator.css`. NU atinge alt CSS.
- **NU atinge `email-modal.css`** — regulile defensive din v3.9.549 RĂMÂN (strat dublu intenționat:
  component auto-conținut + pagină nescurgătoare). NU le „curăța" ca redundante.
- NU atinge HTML/JS/backend (excepție: pasul OPȚIONAL 3, dacă alegi să-l faci). NU atinge signing,
  schema, migrări.

---

## 📋 Pas 0 — context + siguranță

```bash
git checkout develop && git pull origin develop
git status   # clean

# 1) Confirmă că semdoc-initiator.css e încărcat DOAR de semdoc-initiator.html
#    (dacă ar fi shared, scoping-ul la .df-shell ar putea afecta altă pagină):
grep -rln "semdoc-initiator/semdoc-initiator.css" public --include="*.html"
# Așteptat: DOAR public/semdoc-initiator.html. Dacă apar alte pagini → STOP, raportează.

# 2) Confirmă wrapper-ul .df-shell și că modalul NU e în el:
grep -n "df-shell" public/semdoc-initiator.html | head -3
grep -n "document.body.appendChild" public/js/df-email-modal.js   # modalul → body, frate cu .df-shell

# 3) Citește fișierul țintă:
cat -n public/css/semdoc-initiator/semdoc-initiator.css | sed -n '1,70p'
```

Dacă `semdoc-initiator.css` e încărcat de mai multe pagini, sau dacă vreuna nu folosește `.df-shell`
ca wrapper → **STOP** și raportează (scoping-ul ar trebui regândit).

---

## 📋 Pas 1 — scopează selectorii care curg (la `.df-shell`)

Modifică DOAR aceste reguli, prefixând fiecare selector de element cu `.df-shell ` (păstrând valorile,
`!important`-urile și restul EXACT). NU atinge `*{box-sizing}` (L9) și `button,input,select{font:inherit}`
(L10) — sunt benigne și nu fac parte din scurgere.

- `label { display:block; font-size:12px; opacity:.85; margin-bottom:6px; }`
  → `.df-shell label { display:block; font-size:12px; opacity:.85; margin-bottom:6px; }`

- `input, select { width:100%; padding:10px 10px; border-radius:10px; border:...; background:...; color:...; }`
  → `.df-shell input, .df-shell select { …identic… }`

- `.muted, .card-sub, label{ color: var(--sub) !important; opacity:.9 !important; }`
  → `.df-shell .muted, .df-shell .card-sub, .df-shell label{ …identic, cu !important… }`

- `input, select, textarea{ background:…!important; color:…!important; border:…!important; border-radius:…!important; }`
  → `.df-shell input, .df-shell select, .df-shell textarea{ …identic… }`

- `input::placeholder, textarea::placeholder{ color:…!important; }`
  → `.df-shell input::placeholder, .df-shell textarea::placeholder{ …identic… }`

- `input:focus, select:focus, textarea:focus{ …!important… }`
  → `.df-shell input:focus, .df-shell select:focus, .df-shell textarea:focus{ …identic… }`

> Specificitate: `.df-shell input` = 0,1,1 → tot bate `components.css` (ce avea înainte) ȘI rămâne cu
> `!important` unde era. Pentru elementele paginii (în `.df-shell`) efectul e IDENTIC. Pentru modal
> (în afara `.df-shell`) regulile nu se mai aplică deloc.

---

## 📋 Pas 2 — verificare (criteriul „pagina identică")

```bash
npm run check
npm test     # verde (n-ai atins JS/backend)
```

**Verificare vizuală OBLIGATORIE — pagina trebuie IDENTICĂ:**
1. `semdoc-initiator.html` (Flux nou + Fluxurile mele): formularul de creare flux, tabelul de semnatari,
   câmpurile AcroForm, checkbox-ul „urgent", cardurile de flux — TOATE neschimbate față de înainte.
   *Orice* diferență vizuală pe pagină = un selector a ieșit din scope greșit → revino.
2. Modalul de email pe semdoc-initiator: corect (checkbox mic stânga, câmp destinatari fără casetă internă).
3. Modalul pe `flow.html`: neschimbat.
Confirmare reală pe staging (hard reload / clear cache pt. SW).

---

## 📋 Pas 3 — OPȚIONAL (poți sări) — curăță peticul `urgentCheck`

Doar dacă vrei să închizi complet clasa de bug. ATENȚIE: schimbă comportamentul checkbox-urilor PROPRII
ale paginii → extinde verificarea vizuală.

`urgentCheck` are inline `style="width:16px;height:16px"` ca petic peste `input{width:100%}`. Cu scoping-ul
la `.df-shell`, regula tot prinde checkbox-urile paginii (sunt în `.df-shell`). Ca să elimini peticul:
- în regula scopată de la Pas 1, exclude checkbox/radio din lățime:
  `.df-shell input:not([type="checkbox"]):not([type="radio"]), .df-shell select { width:100%; … }`
  (mută DOAR `width` sub `:not(...)`; bg/border/radius pot rămâne pe toate).
- apoi scoate `width:16px;height:16px` din `style`-ul inline al `urgentCheck` în
  `public/semdoc-initiator.html` și verifică vizual că rămâne un checkbox normal.

Dacă NU ești sigur sau nu poți verifica vizual toată pagina → **sări acest pas**, lasă peticul, notează-l
în raport. Fix-ul de bază (Pas 1) e valoros și fără asta.

---

## 📋 Pas 4 — cache busting + bump + commit + push

```bash
grep -rn "semdoc-initiator.css?v=" public --include="*.html"   # doar semdoc-initiator.html
grep -n "CACHE_VERSION" public/sw.js
# sed ȚINTIT pe semdoc-initiator.html (NU pe public/*.html). Verifică git diff --stat = 1 linie/fișier.

# package.json: 3.9.549 → 3.9.550. CACHE_VERSION bumped. ?v=3.9.550 pe semdoc-initiator.css.

git add public/css/semdoc-initiator/semdoc-initiator.css public/sw.js public/semdoc-initiator.html package.json
git commit -m "fix(semdoc-initiator-css): scopează selectorii pe element gol la .df-shell — oprește scurgerea CSS în componentele body-level"
git push origin develop
```

---

## ✅ Definiție de „gata"

1. Cei 6 selectori care curg (label×2, input/select, input/select/textarea, placeholder, :focus) scopați
   la `.df-shell`; `*{box-sizing}` și `font:inherit` lăsate neatinse.
2. `email-modal.css` (defensiva v3.9.549) NEatins.
3. Pagina semdoc-initiator arată **IDENTIC** (verificat vizual); modalul corect pe ambele pagini.
4. (Dacă ai făcut Pas 3) `urgentCheck` fără petic inline, checkbox normal — altfel peticul lăsat + notat.
5. `semdoc-initiator.css` confirmat încărcat DOAR de semdoc-initiator.html.
6. Cache busting: `?v=3.9.550` pe semdoc-initiator.css + `CACHE_VERSION` bumped; `git diff --stat` curat.
7. `npm run check` + `npm test` verzi; push pe develop; CI verde.
8. Raport: selectorii scopați, confirmarea „pagină identică" (sau „de validat pe staging"), dacă s-a
   făcut sau nu Pas 3, și confirmarea că defensiva din email-modal.css a rămas pe loc.

> După acest fix, clasa de bug e închisă la sursă: orice component injectat în `<body>` pe această
> pagină e imun la stilurile generice ale paginii. Lecția merită notată în CLAUDE.md (secțiunea de
> consolidare): „CSS de pagină = selectori scopați la wrapper-ul paginii, niciodată element gol —
> altfel se scurge în componentele globale injectate în body."
