---
prompt: 192
titlu: "df-user-modals.js pe sursa unică DFApi + tratarea lui password_change_required"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.846
versiune_tinta: v3.9.847
migratii: NU
fisiere_din_public: DA  (`shared/df-api.js` e în PRECACHE_ASSETS ⇒ bump `CACHE_VERSION`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul — două lucruri care se rezolvă în același loc

**(a) A șasea copie.** Seria #183/#189 a adus frontendul pe o sursă unică de acces la API
(`public/js/shared/df-api.js`). `public/js/df-user-modals.js` a rămas pe dinafară: are
patru `fetch` brute și își construiește CSRF-ul citind cookie-ul de mână. E încărcat de
**10 pagini** — cea mai largă rază de acțiune dintre toate rămășițele.

**(b) Utilizatorul blocat.** `sessionGuard` (`server/middleware/session-guard.mjs:177`)
răspunde **403 `password_change_required`** pe rutele guarded când `force_password_change`
e activ. Frontendul nu tratează codul ăsta nicăieri: omul primește erori generice pe fiecare
apel, fără să afle ce trebuie să facă. Iar `df-user-modals.js` e chiar fișierul care **deține
modalul de schimbare a parolei** — deci același fișier care are problema are și soluția.

⚠️ Detaliu care face totul sigur: `/auth/` **nu** e în `GUARDED_PREFIXES`, deci
`/auth/change-password` nu poate întoarce `password_change_required`. Nu există buclă.
Docblock-ul de la `session-guard.mjs:170` explică de ce, și avertizează să nu fie adăugat
vreodată acolo.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                  # Așteptat: 3.9.846
grep -n "fetch(" public/js/df-user-modals.js                 # Așteptat: 4 apeluri
grep -n "csrf_token\|x-csrf-token" public/js/df-user-modals.js
grep -n "CACHE_VERSION" public/sw.js                         # citește, NU presupune
grep -rhoE "shared/df-api\.js\?v=[0-9.]+" public/*.html | sort -u
grep -rhoE "df-user-modals\.js\?v=[0-9.]+" public/*.html | sort -u
grep -n "CONSUMERS\|toBe(13)" server/tests/unit/df-api-sursa-unica.test.mjs
for f in flow formular notafd-invest-form refnec-form; do
  echo "--- $f"; grep -n "shared/df-api.js\|df-user-modals.js" public/$f.html; done
```

⭐ Ultima comandă trebuie să confirme faptul central al lotului: în **aceste patru pagini**
`df-user-modals.js` e încărcat **ÎNAINTEA** lui `df-api.js`. Niciunul dintre tag-uri nu are
`defer`, deci ordinea din document **este** ordinea de execuție.

Citește apoi integral `public/js/shared/df-api.js` și `public/js/df-user-modals.js`.

---

## ETAPA A — cârligul din DFApi

În `public/js/shared/df-api.js`, lângă blocurile existente de 401 și de 403 `csrf_invalid`,
adaugă tratarea lui `password_change_required`. Reguli, fiecare cu motivul ei:

1. **Se verifică pe ORICE metodă**, nu doar pe mutații. Blocul de 403 existent e gardat pe
   `isMutation` (corect pentru CSRF); `password_change_required` vine și pe `GET`. Deci e un
   bloc **separat**, nu o ramură în cel existent.
2. **Zăvor: cârligul se cheamă O SINGURĂ DATĂ per încărcare de pagină.** O pagină lansează
   zeci de apeluri în paralel; fără zăvor, utilizatorul primește modalul de zece ori peste el.
3. **Fără cârlig înregistrat, comportamentul rămâne exact cel de azi** — răspunsul 403 se
   întoarce brut, fără excepție, fără redirect. Paginile care nu au modal nu trebuie să se
   schimbe în niciun fel.
4. **Răspunsul se întoarce oricum**, chemat cârligul sau nu. Apelantul își face treaba lui.
   Nu înghiți eroarea.
5. Corpul se citește cu `res.clone().json()`, în `try/catch`, ca în blocurile vecine.

API-ul public capătă un singur nume nou, în stilul celor existente
(`setRefreshHook`/`setRedirectHook`): un `setPasswordChangeHook(fn)`.

⛔ Nu atinge logica de 401, `REVOKED_CODES`, `REFRESHABLE_CODES` sau retry-ul de
`csrf_invalid`. Sunt acoperite de 15 teste în `df-api-sursa-unica.test.mjs`.

---

## ETAPA B — `df-user-modals.js` pe DFApi

Cele **patru** `fetch` brute trec pe `DFApi.fetch`, iar construcția manuală a antetului CSRF
din cookie **dispare** — DFApi îl pune singur pe mutații.

⚠️ **Referințele la `window.DFApi` rămân STRICT în interiorul handlerelor**, niciodată la
nivelul de sus al fișierului. Motivul e la Etapa 0: în patru pagini fișierul se evaluează
înainte ca `DFApi` să existe. Reordonarea de la Etapa C repară asta, dar regula rămâne —
ea e cea care face fișierul robust indiferent de ordinea din pagină.

La final, tot aici, **înregistrează cârligul**: `df-user-modals.js` deține modalul, e
încărcat de exact cele 10 pagini care au nevoie de el, deci e locul firesc. Cârligul deschide
modalul de schimbare a parolei și afișează mesajul serverului.

⛔ **În afara scopului**, deliberat: `public/js/admin/organizations.js` și
`public/js/semdoc-signer/modals.js` au modaluri proprii și **nu** încarcă
`df-user-modals.js`. Rămân netratate în lotul ăsta. Nu le atinge.

⛔ Nu schimba textele, validările (pragul de 10 tocmai a venit la #191), structura
modalelor sau comportamentul la succes/eroare. Lotul mută **transportul**, nu interfața.

---

## ETAPA C — ordinea scripturilor în cele patru pagini

În `flow.html`, `formular.html`, `notafd-invest-form.html`, `refnec-form.html`: mută tag-ul
`<script src="/js/shared/df-api.js?v=…">` **imediat înaintea** tag-ului
`df-user-modals.js`. `df-api.js` e un IIFE fără dependențe, deci urcarea lui e sigură.

⚠️ **Mută tag-ul, nu-l duplica.** După modificare, `grep -c "shared/df-api.js"` trebuie să
dea **1** în fiecare dintre cele patru pagini. Două tag-uri ar însemna două evaluări —
testul 8 din `df-api-sursa-unica.test.mjs` acoperă cazul, dar nu te baza pe el.

---

## ETAPA D — teste

### D.1 — extinde `server/tests/unit/df-api-sursa-unica.test.mjs`

- Adaugă `df-user-modals.js` în lista `CONSUMERS` a testului 11.
- ⚠️ `expect(checked).toBe(13)` se va schimba. **Calculează** noua valoare din realitate,
  nu o ghici, și raportează vechea și noua valoare cu explicația diferenței.
- Cazuri noi pentru cârlig:
  1. ⭐ 403 `password_change_required` pe un **GET** ⇒ cârligul e chemat. (Cade dacă cineva
     îl mută sub `isMutation`.)
  2. ⭐ Trei apeluri consecutive care întorc 403 `password_change_required` ⇒ cârligul e
     chemat **o singură dată**. (Zăvorul.)
  3. ⭐ **Fără cârlig înregistrat**, un 403 `password_change_required` se întoarce brut:
     fără excepție, fără redirect, fără apel suplimentar. (Garda anti-regresie pentru
     paginile fără modal.)
  4. Un 403 `csrf_invalid` pe o mutație **își păstrează** retry-ul și **nu** cheamă cârligul.
  5. Răspunsul e întors și când cârligul a fost chemat.
  6. `df-user-modals.js` nu mai conține `csrf_token` citit din cookie și nu mai are `fetch(`
     brut — toate patru trec prin `DFApi`.

### D.2 — rulare

```bash
npm test
npm run test:db
```

⚠️ **Secvențial, niciodată în paralel.** Confirmă în raport că le-ai rulat așa.
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica. Singurul a cărui
modificare e autorizată aici e testul 11 (lista + numărătoarea).

---

## ETAPA E — versiune, cache, commit

```bash
npm version 3.9.847 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
```

**`CACHE_VERSION`** în `public/sw.js`: incrementează valoarea citită la Etapa 0
(`/js/shared/df-api.js` **este** în `PRECACHE_ASSETS`).

**`?v=` țintit**, pe cele două fișiere atinse. Citește valorile curente din fișiere:

```bash
sed -i -E "s#(js/shared/df-api\.js\?v=)[0-9.]+#\13.9.847#g" public/*.html
sed -i -E "s#(js/df-user-modals\.js\?v=)[0-9.]+#\13.9.847#g" public/*.html
grep -rn "shared/df-api.js?v=\|df-user-modals.js?v=" public/*.html
```

⚠️ Verificarea trebuie să arate **13 linii** pentru `df-api.js` și **10** pentru
`df-user-modals.js`, toate la `3.9.847`. Un `?v=` corupt nu pică niciun test și ajunge în
producție cu pagina moartă. Grupul de captură e `\1`, **nu** `\g<1>`.

```bash
git status --short
```
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**

```
refactor(#192): df-user-modals pe DFApi + tratarea lui password_change_required — v3.9.847

df-user-modals.js era a SASEA implementare de acces la API din frontend: patru
fetch-uri brute si CSRF construit de mana din cookie, pe 10 pagini. Trece pe
sursa unica; transportul se schimba, interfata nu.

In acelasi fisier se rezolva si golul de la #182: sessionGuard raspunde 403
password_change_required, iar frontendul nu trata codul nicaieri — utilizatorul
cu force_password_change primea erori generice pe fiecare apel, fara sa afle ce
are de facut. DFApi capata un carlig, iar df-user-modals.js il inregistreaza:
detine modalul si e incarcat de exact paginile care au nevoie de el.

Carligul se cheama pe ORICE metoda (403 vine si pe GET) si o SINGURA data per
pagina — fara zavor, zeci de apeluri paralele ar deschide modalul de zece ori.
Fara carlig inregistrat, comportamentul ramane neschimbat: 403-ul se intoarce brut.

/auth/ nu e in GUARDED_PREFIXES, deci change-password nu poate intoarce codul:
nu exista bucla.

In patru pagini df-api.js se incarca dupa consumator; tagul urca inaintea lui,
iar testul 11 acopera de acum si df-user-modals.js.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE.
2. Cele patru `fetch` convertite, cu linia dinainte și cea de după.
3. ⭐ Confirmarea că nicio referință la `window.DFApi` nu stă la nivelul de sus al lui
   `df-user-modals.js` — toate sunt în handlere.
4. Cele patru pagini reordonate: numerele de linie înainte și după, plus
   `grep -c "shared/df-api.js"` = **1** pe fiecare.
5. ⭐ `expect(checked)`: valoarea veche, cea nouă și de ce s-a schimbat.
6. Rezultatul fiecărui caz din D.1, în special **1, 2 și 3**.
7. `CACHE_VERSION` și `?v=` — înainte/după, cu cele 13 și 10 linii verificate.
8. Numerele reale `npm test` / `npm run test:db`, rulate **secvențial**.
9. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
10. Teste preexistente atinse. (Așteptat: **doar testul 11**.)
11. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
12. Constatări colaterale. În special: mai există în `public/` vreun `fetch` brut care
    trimite un antet CSRF construit de mână?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero scrieri în baza de date.
- ⛔ `server/` **neatins**. `sessionGuard` răspunde deja corect; lotul e pur frontend.
- ⛔ Logica de 401, `REVOKED_CODES`, `REFRESHABLE_CODES` și retry-ul `csrf_invalid` rămân
  **neatinse**.
- ⛔ Fără cârlig înregistrat, comportamentul lui DFApi e **identic** cu cel de azi.
- ⛔ `organizations.js` și `semdoc-signer/modals.js` — **în afara scopului**.
- ⛔ Texte, validări și structura modalelor — **neatinse**. Se mută transportul.
- ⛔ `df-api.js` se **mută**, nu se duplică: un singur tag per pagină.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
