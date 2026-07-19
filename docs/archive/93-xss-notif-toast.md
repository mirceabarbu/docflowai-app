---
model_suggested: Opus 4.8
tip: SECURITATE — stored XSS confirmat, exploatabil în producție.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire):** `signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`

---

## Context — vulnerabilitate reală, confirmată

Lanț de **stored XSS**, verificat în cod:

1. `server/routes/flows/crud.mjs:63` — `docName` e text liber, până la 500 de caractere.
   **Zero sanitizare.** Singurele validări: lungime minimă 2, maximă 500.
2. `server/routes/flows/crud.mjs:488` — `docName` e interpolat în mesajul notificării:
   ``message: `${initName} te-a adăugat ca semnatar pe documentul „${data.docName}". ...` ``
3. Notificarea se persistă în `notifications` și se împinge prin WebSocket.
4. `public/notif-widget.js:342` — toast-ul o randează prin **`innerHTML`**, neescapat:
   ```js
   t.innerHTML = `<div class="nw-toast-title">${notif.title||'Notificare'}</div><div class="nw-toast-msg">${notif.message||''}</div>`;
   ```

**Exploit:** orice utilizator care poate crea un flux numește documentul
`<img src=x onerror="...">`, adaugă o victimă ca semnatar, iar codul rulează în browserul
victimei, cu sesiunea ei. CSP-ul are `scriptSrcAttr: ['unsafe-inline']`, deci `onerror=`
**se execută**.

---

## ⛔ CITEȘTE ASTA ÎNAINTE DE ORICE — capcana principală

**NU escapa `docName` pe server.** Pare fixul evident. Ar strica lucrurile.

Motiv: **pagina de notificări escapează deja corect.** `public/js/notifications/notifications.js:139-140`
folosește `escHtml(n.title)` și `escHtml(n.message)` (helperul e definit la linia 255).
Dacă escapezi și pe server, textul ajunge dublu-escapat și utilizatorul vede
`&lt;img src=x&gt;` în lista de notificări, ca text vizibil. Ai stricat afișarea reparând altceva.

**Datele rămân brute în DB. Se repară RANDAREA.** Regula corectă e encoding contextual la
punctul de ieșire, nu sanitizare la intrare.

---

## PAS 1 — Inventarul randărilor (înainte de orice patch)

`notif-widget.js` are exact **4** utilizări de `innerHTML`/`textContent`. Confirmă:

```bash
grep -n "innerHTML\|insertAdjacentHTML\|textContent" public/notif-widget.js
# Așteptat: liniile 101 (textContent, CSS — safe), 271 (innerHTML, SVG STATIC — safe),
#           314 (textContent, badge — safe), 342 (innerHTML, TOAST — 🔴 VULNERABIL)
```

**Doar linia 342 e vulnerabilă.** Liniile 271 și 101 sunt string-uri statice, fără date de
utilizator — **nu le atinge.** Nu porni o cruciadă generală anti-`innerHTML` în acest prompt.

Confirmă și că pagina de notificări e deja curată:
```bash
grep -n "escHtml" public/js/notifications/notifications.js | head -5
# Așteptat: escHtml folosit pe title și message (liniile ~139-140), definit la ~255
```
Dacă **nu** e escapată, OPREȘTE-TE și raportează — premisa promptului s-a schimbat.

---

## PAS 2 — Fixul (o singură funcție)

`public/notif-widget.js`, funcția `showToast(notif)` (~linia 337).

Înlocuiește construcția prin `innerHTML` cu DOM API. Nu folosi un helper de escape —
folosește `textContent`, care e imun prin construcție:

```js
  function showToast(notif) {
    const area = document.getElementById('nw-toast-area');
    if (!area) return;
    const t = document.createElement('div');
    t.className = `nw-toast nw-toast-type-${notif.type||''}`;

    const titleEl = document.createElement('div');
    titleEl.className = 'nw-toast-title';
    titleEl.textContent = notif.title || 'Notificare';

    const msgEl = document.createElement('div');
    msgEl.className = 'nw-toast-msg';
    msgEl.textContent = notif.message || '';

    t.replaceChildren(titleEl, msgEl);

    t.onclick = () => { window.location.href = buildActionUrl(notif); };
    area.appendChild(t);
    setTimeout(() => {
      t.classList.add('nw-exit');
      setTimeout(() => t.remove(), 350);
    }, 5000);
  }
```

⚠️ **Păstrează neschimbate:** `t.className` (inclusiv `nw-toast-type-${notif.type}` —
`type` e o enumerare server-side, nu input de utilizator), `t.onclick`, `buildActionUrl(notif)`,
cele două `setTimeout` și clasa `nw-exit`. Schimbi **exclusiv** modul de inserare a
titlului și mesajului. Structura DOM rezultată trebuie să fie **identică** — aceleași două
`div`-uri, aceleași clase — ca CSS-ul existent să prindă fără modificări.

**NU atinge `public/css/`.** Dacă ți se pare că trebuie CSS nou, ai greșit structura.

---

## PAS 3 — Verifică restul căilor de notificare (doar citire)

Notificarea mai ajunge în două locuri. Verifică-le și **raportează** — nu le modifica dacă
sunt deja sigure:

```bash
grep -n "new Notification" public/notif-widget.js       # ~linia 463
grep -n "showNotification" public/sw.js                 # ~linia 178
```

Ambele folosesc **Web Notifications API**, care primește `title` și `body` ca **text simplu**
— browserul nu interpretează HTML acolo. Ar trebui să fie sigure prin construcție.
Confirmă în RAPORT FINAL că așa e. Dacă găsești `innerHTML` pe vreuna, raportează.

---

## PAS 4 — Test de regresie cu payload ACTIV

Fișier nou: `server/tests/unit/notif-toast-xss.test.mjs`.

Testul trebuie să demonstreze că un payload **executabil** ajunge text, nu DOM.

**Cerințe stricte:**
- Folosește `happy-dom` sau `jsdom` (verifică ce e deja în `devDependencies` — nu adăuga
  dependențe noi dacă una există deja; dacă nu există niciuna, **oprește-te și raportează**).
- Payload-uri de testat, minimum trei:
  `<img src=x onerror="window.__pwned=1">`, `<script>window.__pwned=1</script>`,
  `<svg/onload=window.__pwned=1>`
- Asertă **trei** lucruri după `showToast()`:
  1. `window.__pwned` este `undefined` — codul NU s-a executat
  2. `toastEl.querySelector('img, script, svg')` este `null` — NU s-au creat elemente
  3. `toastEl.querySelector('.nw-toast-msg').textContent` **conține** payload-ul ca text literal
- Asertă și că structura rămâne intactă: există `.nw-toast-title` și `.nw-toast-msg`.

⛔ **Testul TREBUIE să importe `showToast` din producție.** Nu-l redeclara, nu copia funcția
în fișierul de test. Avem deja trei teste care își testează propria oglindă
(`alop-state.test.mjs`, `helpers.test.mjs`, `suma-plati-pct5.test.mjs`) — nu mai facem al patrulea.

`notif-widget.js` e un script clasic (IIFE), nu un modul ES. Dacă `showToast` nu e exportabilă,
**nu rescrie fișierul ca modul** — ar sparge toate cele ~12 pagini care îl încarcă prin
`<script src>`. În schimb, expune-o minimal (ex. pe `window.docflow`, unde deja există
`apiFetch`) sau, dacă și asta e riscant, încarcă sursa în test cu `readFileSync` + `new Function`
în contextul DOM-ului fals și cheam-o de acolo. Alege calea cea mai puțin invazivă și
**explică în raport ce ai ales și de ce**.

---

## PAS 5 — Versiune și cache

`notif-widget.js` **ESTE** în `PRECACHE_ASSETS` (`public/sw.js:22`). Deci:

- `package.json` → **v3.9.677**
- `public/sw.js` → `CACHE_VERSION`: `'docflowai-v286'` → `'docflowai-v287'` (linia 11)
- `?v=` pe `notif-widget.js` în **toate** HTML-urile care îl încarcă:
  ```bash
  grep -rln "notif-widget.js" public/*.html
  ```
  Actualizează fiecare la `?v=3.9.677`.

Fără bump de `CACHE_VERSION`, utilizatorii cu SW activ rămân pe versiunea vulnerabilă
din cache. **Fixul n-ar ajunge la ei.**

---

## PAS 6 — Verificare finală

```bash
grep -n "innerHTML" public/notif-widget.js
# Așteptat: DOAR linia ~271 (SVG static). Linia 342 nu mai există.

grep -n "CACHE_VERSION" public/sw.js | head -1
# Așteptat: docflowai-v287

grep -rn "notif-widget.js?v=" public/*.html | grep -v "3.9.677"
# Așteptat: GOL — niciun HTML rămas pe versiune veche

git diff --name-only server/
# Așteptat: DOAR server/tests/unit/notif-toast-xss.test.mjs (fișier nou)
#           ZERO modificări în server/routes/ — nu escapăm nimic pe server

npm run check   # verde
npm test        # verde, fără regresii
```

Commit unic pe `develop`:
```
sec: fix stored XSS în toast-ul de notificări — textContent în loc de innerHTML (v3.9.677)
```

---

## RAPORT FINAL

1. Câte `innerHTML` erau în `notif-widget.js` înainte și câte au rămas? Care?
2. `notifications.js` chiar escapa deja `title`/`message`? Confirmă cu numerele de linie.
3. **Ai atins ceva în `server/routes/`?** Așteptat: NU. Confirmă cu `git diff --name-only server/routes/` gol.
4. Structura DOM a toast-ului — identică? Ai atins vreun fișier CSS? (Așteptat: NU.)
5. Web Notifications API (`notif-widget.js:463`, `sw.js:178`) — sigure prin construcție? Confirmă.
6. Cum ai făcut `showToast` testabilă? Ce cale ai ales și de ce? Ai transformat fișierul în modul ES? (Sperăm că NU.)
7. Testul importă din producție — nu redeclară funcția? Arată linia de `import`/încărcare.
8. Payload-urile: `window.__pwned` rămâne `undefined`? `querySelector('img,script,svg')` e `null`? Payload-ul apare ca text în `.nw-toast-msg`?
9. `CACHE_VERSION` bumped la v287? Câte HTML-uri au primit `?v=3.9.677`?
10. `npm run check` + `npm test` verzi? Versiune 3.9.677?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **NU escapa nimic pe server.** `notifications.js` escapează deja → dublu-escaping →
  utilizatorul vede `&lt;img&gt;` ca text. Zero modificări în `server/routes/`.
- ⛔ **NU valida/sanitiza `docName` la intrare** în `crud.mjs`. Nu e fixul. Datele rămân brute.
- ⛔ **NU transforma `notif-widget.js` în modul ES.** E încărcat prin `<script src>` de ~12 pagini.
- ⛔ **NU porni o curățenie generală anti-`innerHTML`.** Sunt ~420 în tot frontendul. Astăzi
  reparăm UNA. Restul e un sprint separat, cu inventar și clasificare pe context.
- ⛔ **NU atinge `public/css/`.** Structura DOM rămâne identică.
- ⛔ **NU adăuga dependențe noi** pentru test fără să raportezi. Dacă nu există nici `jsdom`,
  nici `happy-dom`, oprește-te și întreabă.
- ⛔ **NU redeclara logică în teste.** Testul importă din producție sau nu există.
- ⛔ Zonele NO-TOUCH: doar citire.
- ⛔ **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, **oprește-te și raportează.** Nu improviza.
