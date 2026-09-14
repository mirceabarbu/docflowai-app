---
prompt: 184
titlu: "Modulul formular pe sursa unică DFApi — migrarea apelurilor (etapa 2/4)"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.838
versiune_tinta: v3.9.839
migratii: NU
fisiere_din_public: DA   (⇒ bump `?v=` ȚINTIT; `CACHE_VERSION` doar dacă e cazul — vezi Etapa F)
zona_no_touch_atinsa: NU
etapa: "2 din 4 din consolidarea completă"
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Context

#183 a creat `window.DFApi` și a făcut cele cinci puncte de intrare să convergă la el, fără să
migreze niciun apel. Acum încep migrările. Modulul `formular/` e primul fiindcă e cel mai
riscant, iar riscul se atacă întâi, cât atenția e proaspătă: **10 fișiere, 7.895 de linii**, și
e inima aplicației — DF, ORD, ALOP, Clasa 8.

Modulul nu folosește niciun shim. Fiecare apel e `fetch()` brut cu
`credentials:'include'`, iar mutațiile își scriu antetul CSRF de mână, prin `df.getCsrf()`.

Distribuția mutațiilor, măsurată: `alop.js` 13, `doc.js` 10, `list.js` 4, `clasa8.js` 2,
`core.js` 1, `verif.js` 1, `formular.js` 1.

**Vestea bună, verificată:** 41 de fișiere de test citesc `formular/*.js`, dar **niciunul** nu
conține `fetch(` ⇒ nu există teste ancorate pe forma apelurilor. Migrarea nu sparge teste pe text.

---

## ⚠️ Cele patru capcane, în ordinea gravității

Citește-le înainte de a atinge orice fișier. Trei dintre ele produc bug-uri tăcute.

### C1 — antetul CSRF dublat (cel mai grav)

Call-site-urile scriu `'X-CSRF-Token'` cu **majuscule**. `DFApi.fetch` pune `'x-csrf-token'` cu
minuscule. Antetele HTTP sunt insensibile la majuscule, dar `fetch` normalizează cheile la
construirea obiectului `Headers` și **concatenează valorile duplicate cu virgulă**. Rezultatul ar
fi un token de forma `abc,abc` — invalid ⇒ 403 `csrf_invalid` ⇒ retry ⇒ posibil succes la a doua
încercare, deci un bug care se manifestă ca „uneori salvează, alteori nu".

⇒ **La fiecare mutație migrată, antetul CSRF se ȘTERGE din call-site.** `DFApi` îl pune.
Nu-l lăsa „pentru siguranță". Nu-l redenumi cu minuscule. Îl ștergi.

### C2 — încărcarea capturii, corp binar

`doc.js:1258` (`uploadCaptura`) trimite un `Blob` cu `Content-Type` dinamic (`image/png`) și un
antet `X-Filename`. Serverul își citește singur corpul brut.

⇒ `DFApi.fetch` **nu are voie** să forțeze `Content-Type: application/json` peste el. Verifică
pe codul lui `df-api.js` cum tratează antetele pe care le primește de la apelant și
**raportează ce ai găsit înainte de a migra acest apel**. Dacă rezultă că îl suprascrie,
oprește-te: schimbăm `df-api.js`, nu call-site-ul.

⚠️ Corolar: acest apel e învelit azi într-un `catch(_){}` gol, deci orice eșec e înghițit tăcut
și utilizatorul vede doar că nu apare captura. **Nu repara asta aici** — e o schimbare de
comportament vizibilă utilizatorului, deci lot separat. O migrezi la fel de tăcută cum e.

### C3 — răspunsuri binare

Șapte locuri fac `.blob()` pe răspuns: `doc.js:230, 902, 1042, 1051, 1074, 1308` (PDF semnat,
PDF nesemnat, XML, capturi). `DFApi.fetch` trebuie să întoarcă obiectul `Response` brut, nu
JSON deja parsat. Confirmă asta pe cod înainte de a migra, și scrie un test.

### C4 — `verif.js`, ultimul Bearer manual din modul

`verif.js:17` (`_vfFetch`) citește `localStorage.getItem('docflow_token') || localStorage.getItem('jwt')`
și îl trimite ca `Authorization: Bearer`. **Ambele chei sunt moarte** — verificat: zero
`setItem('docflow_token')` și zero `setItem('jwt')` în tot repo-ul; singura atingere e
`removeItem` la login. Cheia `jwt` nu fusese semnalată nici de audit, nici de raportul lui #183.

⇒ La migrare, `_vfFetch` devine un apel `DFApi.fetch` și antetul dispare. `DFApi` îl șterge
oricum, deci păstrarea lui ar fi doar cod mort care induce în eroare următorul cititor.

---

## ETAPA 0 — ancorele (READ-ONLY)

```bash
node -p "require('./package.json').version"        # Așteptat: 3.9.838
grep -rho "fetch(" public/js/formular --include=*.js | wc -l
grep -rho "X-CSRF-Token" public/js/formular --include=*.js | wc -l
grep -rn "DFApi" public/js/formular --include=*.js | wc -l    # Așteptat: 0
grep -n "df-api.js" public/formular.html                       # Așteptat: 1 linie, index MAI MIC decât toate /js/formular/*
```

Apoi **citește integral `public/js/shared/df-api.js`** — codul livrat de #183, nu ce am descris
eu în promptul precedent. Tot lotul ăsta depinde de ce face el efectiv cu antetele. Raportează
în special: cum tratează `Content-Type` primit de la apelant, ce întoarce (Response brut?),
și când adaugă CSRF.

---

## ETAPA A — ordinea de încărcare

`formular.html` are `df-api.js` **înainte** de `notif-widget.js` (linia 1516 azi) și de toate
`/js/formular/*.js`, care sunt `defer`. Verifică singur pe fișier și raportează indicii.

⚠️ Excepție de verificat: `audit-labels.js` (1522) și `alop-roluri.js` (1524) **nu** au `defer`.
Dacă vreunul face apeluri, rulează înaintea celor `defer` — confirmă că `DFApi` există deja la
momentul lor. Nu presupune.

Aceeași verificare pentru celelalte pagini care încarcă module `formular/`:
`notafd-invest-form.html` și `refnec-form.html`.

---

## ETAPA B — migrarea, fișier cu fișier, în ordinea asta

**Un commit pe fișier.** Nu unul singur la final. Motivul e practic: dacă ceva se rupe în
producție, `git revert` pe fișierul vinovat lasă restul migrat.

Ordinea, de la cel mai riscant la cel mai puțin:

1. `alop.js` (13 mutații) — legături DF/ORD, lichidare, plată, anulare
2. `doc.js` (10 mutații) — salvare document, capturi, PDF, XML
3. `list.js` (4)
4. `clasa8.js` (2)
5. `core.js`, `verif.js`, `formular.js` (1 fiecare)
6. `draft.js`, `facturi.js`, `trasabilitate.js` (fără mutații — doar citiri)

### Forma migrării

Înainte:
```js
const r=await fetch(`/api/alop/${encodeURIComponent(alopId)}/link-df`,{
  method:'POST',credentials:'include',
  headers:{'Content-Type':'application/json','X-CSRF-Token':df.getCsrf()},
  body:JSON.stringify(body),
});
```

După:
```js
const r=await DFApi.fetch(`/api/alop/${encodeURIComponent(alopId)}/link-df`,{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify(body),
});
```

Reguli, fără excepție:
- `credentials:'include'` **dispare** din call-site — `DFApi` îl impune. Dacă lipsea, tot îl capătă.
- `'X-CSRF-Token'` **dispare**. Vezi C1.
- `'Content-Type'` **rămâne** unde era, exact cum era. Vezi C2.
- Tot restul — URL, metodă, corp, tratarea răspunsului, `try/catch` — rămâne **neatins**.
- ⛔ Nu „îmbunătăți" nimic pe drum. Nu adăuga tratare de erori care nu era. Nu unifica
  `try/catch`-uri. Nu redenumi variabile. Un diff care conține altceva decât cele trei
  transformări de mai sus e un diff care nu se poate verifica.

### Ce NU se atinge

- Cele trei tratări locale de 401 (`clasa8.js:64`, `list.js:79`, `trasabilitate.js:80`).
  Devin parțial redundante — `formular.html` are widget, deci cârligele sunt înregistrate și
  `DFApi` tratează 401 singur — dar ștergerea lor e o schimbare de comportament, nu o migrare.
  Lot separat. Le lași exact cum sunt.
- `df.getCsrf()` însuși, în `df-utils.js`. Alte module îl folosesc.
- `catch(_){}` de la `uploadCaptura`. Vezi C2.

---

## ETAPA C — testele

Fișier nou `server/tests/unit/formular-dfapi-migrare.test.mjs`.

Analiză statică pe fișierele migrate:
1. Zero apariții `X-CSRF-Token` în `public/js/formular/`. **Testul care apără C1.**
2. Zero `credentials:` rămase în call-site-urile migrate.
3. Zero `getItem('docflow_token')` și zero `getItem('jwt')` în `public/js/formular/`.
   **Testul care apără C4.**
4. Numărul de `DFApi.fetch(` este egal cu numărul de `fetch(` de dinainte, pe fiecare fișier
   migrat. Derivă cifrele din fișier, nu le scrie de mână — și rulează contorul pe **fișierul
   întreg**, nu pe un grep îngust. (Am greșit asta de trei ori; vezi `CLAUDE.md`.)

Comportament, cu `happy-dom` și `fetch` falsificat, pe `df-api.js` real:
5. ⭐ **Un apel cu `Content-Type: image/png` și corp `Blob` ajunge la rețea cu tipul păstrat**,
   nu convertit la JSON, și cu `X-Filename` intact. Testul care apără C2.
6. ⭐ **`DFApi.fetch` întoarce un `Response` pe care se poate chema `.blob()`.** Apără C3.
7. O mutație migrată ajunge la rețea cu **exact un** antet CSRF.

```bash
npm test
npm run test:db
npm run check
```

⚠️ Dacă pică vreun test preexistent, **oprește-te și raportează ÎNAINTE de a-l modifica**. Cele
41 de fișiere care citesc `formular/*.js` verifică logică de afaceri, nu apeluri — dacă unul
pică, înseamnă că ai schimbat mai mult decât apelul.

---

## ETAPA D — verificarea manuală pe care o cer înainte de deploy

Nu de la tine, de la Mircea. Enumeră în raport, ca listă gata de bifat, minimul care exercită
fiecare clasă de apel migrat:

- salvarea unui DF nou și a unuia existent (POST și PUT prin `hdrs`);
- crearea unui ORD dintr-un dosar ALOP (legarea `link-df` / `link-ord`);
- o captură Forexebug încărcată pe un ORD (C2, corp binar);
- descărcarea unui PDF semnat și a unui XML (C3, răspuns binar);
- confirmarea unei lichidări sau a unei plăți în ALOP;
- deschiderea Raportului de încredere pe un document semnat (C4, `verif.js`).

---

## ETAPA E — versiune, lockfile

```bash
npm version 3.9.839 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
git status --short
```

`git add` **explicit**. **Niciodată `git add -A`.**

---

## ETAPA F — cache busting

`?v=` **țintit**, doar pe fișierele modificate, în **toate** paginile care le încarcă
(`formular.html`, și verifică `notafd-invest-form.html` / `refnec-form.html`).
`CACHE_VERSION` se atinge **doar** dacă vreunul dintre fișierele migrate e în `PRECACHE_ASSETS`
— verifică, nu presupune. Raportează exact ce ai bumpat.

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**.
2. ⭐ **Ce face efectiv `df-api.js` cu `Content-Type` primit de la apelant, ce întoarce, și când
   adaugă CSRF** — citit din codul livrat la #183, raportat ÎNAINTE de migrare.
3. Tabelul ordinii de încărcare pe cele trei pagini, cu indicii, inclusiv verdictul pe
   `audit-labels.js` / `alop-roluri.js` (fără `defer`).
4. Per fișier migrat: numărul de apeluri, câte mutații, hash-ul commitului.
5. Rezultatul fiecărui caz din Etapa C, în special **5, 6 și 7**.
6. Lista de verificare manuală din Etapa D.
7. Ce ai bumpat la Etapa F; dacă ai atins `CACHE_VERSION` și de ce.
8. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat COMPLET.
9. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
10. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
11. Constatări colaterale. Mă interesează în special: apeluri din `formular/` care fac ceva ce
    `DFApi` nu poate reprezenta, și locuri unde tratarea răspunsului presupune un comportament
    pe care migrarea îl schimbă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero atingeri pe server, în afara fișierelor de test.
- **Un commit pe fișier migrat.**
- Doar cele trei transformări din Etapa B. Nimic altceva în diff.
- Antetul CSRF se ȘTERGE din call-site, nu se rescrie cu minuscule.
- `catch(_){}` de la capturi, cele trei tratări locale de 401 și `df.getCsrf()` rămân neatinse.
- Dacă `df-api.js` suprascrie `Content-Type`, **oprește-te** — se repară acolo, nu în call-site.
- `git add` explicit, niciodată `-A`.
- Orice `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
