---
prompt: 183
titlu: "Sursa unică de acces la API în frontend — extragerea nucleului, fără migrarea apelurilor"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.837
versiune_tinta: v3.9.838
migratii: NU
fisiere_din_public: DA   (⇒ bump `?v=` ȚINTIT + eventual `CACHE_VERSION`, vezi Etapa E)
zona_no_touch_atinsa: NU
etapa: "1 din 4 din consolidarea completă"
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Context — măsurat, nu presupus

Frontendul are **șase** moduri diferite de a vorbi cu API-ul:

| # | unde | ce face | ce NU face |
|---|---|---|---|
| 1 | `public/notif-widget.js:189` — `docflow.apiFetch` | refresh la 401, `REVOKED_CODES` → login, retry `csrf_invalid` | — |
| 2 | `public/js/admin/core.js:3` | CSRF + retry `csrf_invalid` | nicio tratare de 401 |
| 3 | `public/js/df-apifetch-shim-full.js:15` | identică cu 2 | idem |
| 4 | `public/js/df-apifetch-shim.js:11` | CSRF simplu | fără retry, fără 401 |
| 5 | `public/js/bulk-signer/bulk-signer.js:24` | redirect la 401 cu `?next=` | **nu trimite CSRF deloc** |
| 6 | restul aplicației | `fetch()` brut | tot |

Cifre pe arhivă: **179 de apeluri `fetch(` în 37 de fișiere**, dintre care **111 mutații**.

Divergența nu e cosmetică. Implementarea 1 face `delete headers['Authorization']`
(`notif-widget.js:191`); implementările 2, 3 și 4 fac exact invers — citesc `docflow_token`
din `localStorage` și îl **adaugă** ca Bearer. Aceeași funcție, același nume, comportament opus
pe autentificare.

## De ce acest lot NU migrează niciun apel

Mircea a cerut consolidarea completă. Ținta e corectă și rămâne neschimbată. Forma de livrare
e în **patru loturi**, nu unul, din motive care se pot verifica:

- 111 mutații într-un singur commit nu se pot verifica manual, iar frontendul nu are teste care
  să prindă o regresie de rețea (există 17 fișiere cu `happy-dom`, dar testează logică, nu
  apeluri HTTP).
- Modul de eșec al unei regresii aici nu e o eroare în log. E un buton care nu mai face nimic,
  descoperit de un funcționar la ghișeu, la trei zile după deploy.
- Într-un lot unic, revenirea e totul-sau-nimic. În patru, `git revert` pe lotul vinovat lasă
  restul în picioare.

Vestea bună, verificată: **zero teste ancorează pe forma apelurilor `fetch(` din `public/`**
⇒ migrarea ulterioară nu va sparge teste pe text.

**Acest lot creează sursa unică și face cele cinci implementări să convergă la ea. Nu atinge
niciun `call-site`.** Dacă la final numărul de apeluri `fetch(` din aplicație s-a schimbat,
ai făcut altceva decât ți-am cerut.

---

## ETAPA 0 — ancorele (READ-ONLY)

Raportează valorile **OBȚINUTE**. Orice nepotrivire ⇒ **OPREȘTE-TE**.

```bash
node -p "require('./package.json').version"        # Așteptat: 3.9.837
grep -c "" public/notif-widget.js                  # Așteptat: 585
grep -n "window._apiFetch = async function" public/js/admin/core.js public/js/df-apifetch-shim.js public/js/df-apifetch-shim-full.js
# Așteptat: exact 1 linie în fiecare (3, 11, 15)
grep -n "async function _apiFetch" public/js/bulk-signer/bulk-signer.js   # Așteptat: 1 linie (24)
grep -rho "fetch(" public/js --include=*.js | wc -l                        # Așteptat: 179 — REPER, se recalculează la final
ls public/js/shared/                                                        # vezi ce convenție urmează fișierele partajate
```

Citește **integral**, înainte de a scrie ceva: `public/notif-widget.js` (585 de linii),
cele trei shim-uri, și definiția din `bulk-signer.js`.

---

## ETAPA A — sursa unică: `public/js/shared/df-api.js`

Model de urmat: `public/js/shared/pagin.js` — script clasic, IIFE, `'use strict'`, expune un
singur obiect pe `window`. **Nu ESM**, nu `import`/`export`: paginile îl încarcă prin `<script>`.

Expune `window.DFApi` cu:

- `DFApi.fetch(url, options)` — implementarea canonică, **mutată** din `notif-widget.js:189-248`,
  nu rescrisă. Copiaz-o și adapteaz-o la dependențe, nu o reimplementa din memorie.
- `DFApi.getCsrf()` — mutată din aceeași sursă.
- `DFApi.setCsrf(token)` — scrie `window._csrfToken` (celelalte fișiere îl citesc direct;
  variabila globală rămâne contractul, nu o schimba).
- `DFApi._setRefreshHook(fn)` și `DFApi._setRedirectHook(fn)` — vezi mai jos.

### Problema dependențelor, și forma cerută

`apiFetch` din widget depinde de trei lucruri definite tot acolo: `refreshToken()` (`:130`),
`redirectLogin()` (`:172`), `REVOKED_CODES` (`:29`) și variabila `_lastCsrfToken` (`:128`).

`refreshToken` și `redirectLogin` **rămân în widget** — sunt legate de ciclul lui de viață
(WebSocket, toast-uri). `df-api.js` le primește prin cârlige:

```js
// df-api.js — cârligele sunt OPȚIONALE prin construcție.
// Fără ele, DFApi.fetch se comportă exact ca shim-ul minimal de azi: trimite CSRF,
// face retry pe csrf_invalid, și întoarce răspunsul brut la 401. Cu ele, capătă
// comportamentul complet al widget-ului. Asta e ce permite paginilor FĂRĂ widget
// (registratura.html, setari.html, bulk-signer.html) să folosească aceeași funcție.
let _refreshHook  = null;   // () => Promise<boolean>
let _redirectHook = null;   // () => void
```

`REVOKED_CODES` **se mută în `df-api.js`** — e o listă de coduri de eroare ale serverului,
nu o preocupare a widget-ului de notificări. Widget-ul o citește de acolo dacă mai are nevoie
de ea.

⚠️ **Ce NU are voie să facă `DFApi.fetch`:** să adauge `Authorization` din `localStorage`.
Canonica îl ȘTERGE deliberat (`:191`). Convergența se face pe comportamentul canonic, iar
ștergerea Bearer-ului e **cea mai riscantă schimbare din tot lotul** — vezi Etapa D.

---

## ETAPA B — widget-ul devine consumator, nu proprietar

În `public/notif-widget.js`:

1. Șterge corpul lui `apiFetch` (`:189-248`), al lui `getCsrf` (intern), și `REVOKED_CODES`.
2. `apiFetch` devine un apel către `DFApi.fetch`.
3. La inițializare, widget-ul își înregistrează cârligele:
   `DFApi._setRefreshHook(refreshToken); DFApi._setRedirectHook(redirectLogin);`
4. `window.docflow.apiFetch = apiFetch;` (`:500`) **rămâne neschimbat** — e contractul pe care
   se bazează toate cele trei shim-uri. Nu-l atinge.
5. `window.docflow.refreshToken` și `window.docflow.showToast` (`:501-502`) rămân neatinse.
   Al doilea are un test de regresie XSS ancorat pe el.

⚠️ `df-api.js` trebuie încărcat **înaintea** lui `notif-widget.js` pe fiecare pagină care îl
are. Widget-ul e încărcat la sfârșitul lui `<body>` în majoritatea paginilor. Verifică
FIECARE pagină, una câte una, și raportează tabelul.

---

## ETAPA C — cele patru definiții converg

Fiecare dintre `admin/core.js:3`, `df-apifetch-shim.js:11`, `df-apifetch-shim-full.js:15` devine:

```js
window._apiFetch = function(url, options) { return window.DFApi.fetch(url, options); };
```

Blocul `initCsrf` de la finalul lui `core.js` și al lui `shim-full.js` (identice) se mută în
`df-api.js`, executat o singură dată, cu gardă de reintrare.

`bulk-signer.js:24` — funcția **locală** `_apiFetch` devine tot un apel către `DFApi.fetch`.
⚠️ Două schimbări reale de comportament aici, ambele intenționate, ambele de raportat:
- capătă CSRF, pe care azi nu-l trimite deloc;
- redirectul la 401 vine acum din cârligul `_redirectHook`. `bulk-signer.html` **nu încarcă**
  `notif-widget.js` ⇒ cârligul nu e înregistrat ⇒ **redirectul s-ar pierde**.
  Soluția cerută: `bulk-signer.js` își înregistrează singur cârligul de redirect, păstrând
  `?next=` exact ca azi. Nu ștergi comportamentul, îl muți.

---

## ETAPA D — testele, și cazul care mă îngrijorează cel mai tare

Fișier nou `server/tests/unit/df-api-sursa-unica.test.mjs`. Foloseşte `happy-dom`, ca cele
17 fișiere existente care fac asta; ia unul ca model, nu inventa un harness nou.

Comportament (încarcă `df-api.js` într-un DOM, cu `fetch` falsificat):

1. GET ⇒ **fără** header `x-csrf-token`; mutație ⇒ **cu**.
2. `credentials: 'include'` pe fiecare apel.
3. ⭐ **`Authorization` este ȘTERS**, chiar dacă apelantul îl pune explicit în `options.headers`
   **și** chiar dacă `localStorage` conține `docflow_token`. Ăsta e testul care fixează
   convergența pe comportamentul canonic și împiedică pe cineva să „repare" prin reintroducerea
   Bearer-ului.
4. 403 `csrf_invalid` pe o mutație ⇒ cere token nou și **reîncearcă o singură dată**; un al
   doilea 403 nu produce buclă.
5. 401 **fără** cârlig de refresh ⇒ răspunsul se întoarce brut, fără excepție, fără redirect.
6. 401 **cu** cârlig ⇒ cârligul e chemat; dacă întoarce `true`, apelul se reia.
7. Cod din `REVOKED_CODES` la 401 ⇒ cârligul de redirect e chemat și refresh-ul **NU** e chemat.
8. Fără `window.DFApi` încărcat, `df-api.js` se poate include de două ori fără să dubleze
   `initCsrf` (garda de reintrare).

Analiză statică:

9. Cele patru fișiere din Etapa C nu mai conțin `localStorage.getItem('docflow_token')`.
10. `public/notif-widget.js` nu mai conține o a doua definiție de `apiFetch` cu corp propriu.
11. Fiecare pagină care încarcă `notif-widget.js` sau vreunul dintre shim-uri încarcă și
    `df-api.js`, **înainte** — test care parcurge fișierele `.html`, nu o listă scrisă de mine.
    Ăsta e testul care prinde o pagină uitată; scrie-l ca să cadă dacă apare o pagină nouă.

```bash
npm test
npm run test:db
```

⚠️ **Riscul numărul unu al acestui lot: ștergerea Bearer-ului.** Dacă în producție mai există
sesiuni care funcționează *doar* pe `docflow_token` din `localStorage`, ele se rup în clipa
deploy-ului, pe paginile care azi folosesc shim-urile. Înainte de a scrie cod:

- verifică pe server dacă `Authorization: Bearer` mai e acceptat ca sursă de sesiune și
  raportează unde anume;
- verifică dacă mai există vreun loc care **scrie** `docflow_token` în `localStorage`
  (dacă nimic nu-l mai scrie, fallback-ul e mort și ștergerea e gratuită).

**Raportează concluzia ÎNAINTE de Etapa A.** Dacă rezultă că fallback-ul e viu, oprește-te și
spune-mi — schimbăm forma lotului, nu trecem peste.

---

## ETAPA E — cache busting

`public/` e atins ⇒ regulile obișnuite:

- `df-api.js` e fișier NOU: verifică dacă e în `PRECACHE_ASSETS` din service worker. Dacă
  adaugi ceva acolo, `CACHE_VERSION` trebuie bumpat.
- `?v=` **țintit**, doar pe fișierele modificate, în fiecare `.html` care le încarcă.
  Nu bumpa la nimereală și nu atinge fișiere nemodificate.
- Raportează exact ce ai bumpat și de ce.

---

## ETAPA F — versiune, lockfile, commit

```bash
npm version 3.9.838 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json     # Așteptat: 2 linii de versiune
grep -rho "fetch(" public/js --include=*.js | wc -l
# ⚠️ Așteptat: ÎN JUR DE 179, minus cele eliminate din shim-uri. NU raporta „conform",
#    raportează CIFRA și explică diferența față de reperul din Etapa 0. Dacă a crescut,
#    ai adăugat apeluri — oprește-te.
git status --short
```

`git add` **explicit**, pe fișiere numite. **Niciodată `git add -A`.**

Commit:
```
refactor(#183): sursa unica de acces la API in frontend (etapa 1/4) — v3.9.838

Frontendul avea sase moduri de a vorbi cu API-ul, dintre care trei divergeau
semantic de a patra: implementarea canonica din notif-widget sterge antetul
Authorization, iar cele trei shim-uri il adaugau din localStorage.

Nucleul se muta in public/js/shared/df-api.js (window.DFApi), iar cele cinci
puncte de intrare converg la el. Cargligele optionale de refresh si redirect
raman in widget, ceea ce permite si paginilor fara widget sa foloseasca aceeasi
functie — inclusiv bulk-signer, care pana acum nu trimitea CSRF deloc.

Niciun call-site nu e migrat in acest lot: cele 179 de apeluri fetch din 37 de
fisiere raman neatinse. Migrarea lor urmeaza in loturile 2-4, ca fiecare sa
poata fi dat inapoi separat.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**.
2. ⭐ **Concluzia despre Bearer/`localStorage`, cerută în Etapa D, ÎNAINTE de orice cod.**
3. Tabelul complet pagină → scripturi încărcate → ordinea lor, după modificare.
4. Rezultatul fiecărui caz din Etapa D, în special 3, 5, 6, 7 și 11.
5. Ce ai bumpat la Etapa E și de ce; dacă ai atins `CACHE_VERSION`.
6. Numărul final de `fetch(` din `public/js`, cu explicația diferenței.
7. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat COMPLET.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**. Dacă pică vreunul, raportează ÎNAINTE
   de a-l modifica.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Pentru lotul următor: lista fișierelor cu `fetch()` brut, ordonată după numărul de
    **mutații** din fiecare. Vreau să migrez întâi ce e mai riscant, cât atenția e proaspătă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero atingeri pe server, în afara fișierelor de test.
- **Niciun `call-site` migrat.** Nu înlocui `fetch(` cu `DFApi.fetch(` nicăieri în afara
  celor cinci definiții. Dacă vezi un apel care „ar merita", notează-l pentru lotul următor.
- Implementarea canonică se **mută**, nu se rescrie.
- `window.docflow.apiFetch` rămâne expus, cu același nume.
- Comportamentul de redirect al lui `bulk-signer` se păstrează, inclusiv `?next=`.
- `git add` explicit, niciodată `-A`.
- Orice `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
