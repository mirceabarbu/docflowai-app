---
prompt: 191
titlu: "Pragul de parolă din frontend se aliniază la politica serverului (6 → 10)"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.845
versiune_tinta: v3.9.846
migratii: NU
fisiere_din_public: DA  (`js/admin/organizations.js` e în PRECACHE_ASSETS ⇒ bump `CACHE_VERSION`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul

`#181` a urcat politica de parolă a serverului la **10 caractere**
(`server/services/password-policy.mjs`, `MIN_PASSWORD_LEN = 10`, fără reguli de compoziție
— NIST SP 800-63B). Frontendul a rămas la **6**, în cinci locuri.

Efectul pentru utilizator: își alege o parolă de 7 caractere, browserul o acceptă, serverul
o refuză cu `password_too_short`. Omul crede că aplicația e stricată. E cu atât mai neplăcut
cu cât cel mai des lovit e utilizatorul nou, aflat la prima logare, cu
`force_password_change` activ — adică exact cel care nu poate face nimic altceva până nu
reușește.

Lotul aliniază frontendul. **Serverul nu se atinge** — el e sursa de adevăr.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                        # Așteptat: 3.9.845
grep -n "MIN_PASSWORD_LEN" server/services/password-policy.mjs      # Așteptat: = 10
grep -rn "length < 6\|length<6\|minim 6 caractere" public/
grep -n "CACHE_VERSION" public/sw.js                                # citește valoarea, NU o presupune
grep -n "js/admin/organizations.js" public/sw.js                    # Așteptat: în PRECACHE_ASSETS
grep -rn "df-user-modals.js?v=" public/*.html | wc -l               # Așteptat: 10
```

⚠️ `CACHE_VERSION` a fost bumpat la #190. Citește valoarea reală din fișier și
incrementeaz-o cu 1 — nu presupune `v304`.

---

## ETAPA A — cele CINCI locuri

Două sunt etichete în HTML, trei sunt validări în JS. Toate spun același lucru; toate devin 10.

| # | Fișier | Ancoră |
|---|--------|--------|
| 1 | `public/admin.html` | eticheta `Parola nouă <span …>(minim 6 caractere)</span>` |
| 2 | `public/semdoc-signer.html` | aceeași etichetă |
| 3 | `public/js/admin/organizations.js` | `if(nw.length<6){…'Parola trebuie să aibă minim 6 caractere.'…}` |
| 4 | `public/js/df-user-modals.js` | `if (nw.length < 6) {` + mesajul de pe rândurile următoare |
| 5 | `public/js/semdoc-signer/modals.js` | `if(nw.length<6){…}` |

În fiecare: pragul `6` → `10` **și** textul „minim 6 caractere" → „minim 10 caractere".
Mesajul trebuie să fie identic cu cel al serverului („Parola trebuie să aibă minim 10
caractere.") — omul nu are de ce să vadă două formulări pentru aceeași regulă.

### ⛔⛔ CAPCANA — nu atinge asta

`public/js/admin/organizations.js`, **linia ~471**:

```js
if (!code || code.length < 6) { … 'Introduceți codul de 6 cifre.' … }
```

Ăsta e **codul TOTP de 6 cifre**, nu o parolă. Urcat la 10, autentificarea în doi pași se
rupe pentru toată lumea care o are activă. E singurul `length < 6` din `public/` care
**RĂMÂNE 6**.

Înainte de fiecare înlocuire, citește linia întreagă și confirmă că vorbește despre o
**parolă**, nu despre un cod. Dacă ai vreo îndoială pe o linie: **oprește-te și raportează**.

⛔ Nu atinge `server/services/password-policy.mjs`. Serverul e deja corect.
⛔ Nu adăuga reguli de compoziție (majuscule/cifre/simboluri). Politica e deliberat
   doar de lungime, iar docblock-ul explică de ce.
⛔ Nu adăuga `minlength` pe inputuri în lotul ăsta — validarea nativă a browserului are
   altă interacțiune (mesaj propriu, altă limbă) și e o schimbare de comportament separată.

---

## ETAPA B — testul care ține legătura vie

Problema nu e că frontendul era la 6. E că **nimic nu a cerut ca el să urce odată cu
serverul**. Fără o gardă, următoarea schimbare a politicii redeschide exact aceeași fisură.

Adaugă în **`server/tests/unit/password-policy.test.mjs`** (nu fișier nou) un caz care
citește sursele din `public/` și verifică alinierea la constantă:

1. ⭐ Fiecare dintre cele **trei fișiere JS** conține pragul `MIN_PASSWORD_LEN` importat din
   `password-policy.mjs`, nu numărul scris de mână în test. Construiește tiparul din
   constantă (`new RegExp('length\\\\s*<\\\\s*' + MIN_PASSWORD_LEN)`) — dacă cineva urcă
   politica la 12, testul cade și arată unde.
2. ⭐ Niciunul dintre cele trei nu mai conține un prag de parolă mai mic decât
   `MIN_PASSWORD_LEN`. ⚠️ Atenție la fals-pozitiv: `organizations.js` conține legitim
   `code.length < 6` (TOTP). Testul trebuie să excludă **exact** acea linie — de preferat
   verificând că singura potrivire rămasă e cea care conține `code`, nu ignorând orbește
   toate potrivirile.
3. Cele **două fișiere HTML** conțin textul „minim {MIN_PASSWORD_LEN} caractere", construit
   tot din constantă.
4. Mesajul de eroare din cele trei JS coincide cu cel produs de
   `validatePassword('scurt').message`.

Pattern-ul de urmat e cel din `server/tests/unit/df-api-sursa-unica.test.mjs`: citire cu
`readFileSync` din `public/`, aserții pe sursă. Nu e nevoie de `happy-dom` aici.

```bash
npm test
npm run test:db
```

⚠️ **Secvențial, niciodată în paralel.** Confirmă în raport că le-ai rulat așa.
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica.

---

## ETAPA C — versiune, cache, commit

```bash
npm version 3.9.846 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
```

**`CACHE_VERSION`** în `public/sw.js`: incrementează valoarea citită la Etapa 0
(`/js/admin/organizations.js` **este** în `PRECACHE_ASSETS`).

**`?v=` țintit**, doar pe fișierele atinse. Valorile curente diferă între ele — e drift
intenționat, citește-le din fișier, nu din `package.json`:

```bash
sed -i -E "s#(js/admin/organizations\.js\?v=)[0-9.]+#\13.9.846#g" public/*.html
sed -i -E "s#(js/df-user-modals\.js\?v=)[0-9.]+#\13.9.846#g" public/*.html
sed -i -E "s#(js/semdoc-signer/modals\.js\?v=)[0-9.]+#\13.9.846#g" public/*.html
grep -rn "organizations.js?v=\|df-user-modals.js?v=\|semdoc-signer/modals.js?v=" public/*.html
```

⚠️ `df-user-modals.js` e încărcat de **10 pagini** — `grep`-ul de verificare trebuie să
arate 10 linii pentru el, toate la `3.9.846`. Un `?v=` corupt nu pică niciun test și ajunge
în producție cu pagina moartă. Grupul de captură e `\1`, **nu** `\g<1>`.

⛔ `admin.html` și `semdoc-signer.html` se modifică doar la **textul etichetei**. Nu le
atinge alte `?v=`-uri — `admin.html` are `audit.js?v=3.9.845` de la #190, care rămâne.

```bash
git status --short
```
⚠️ Working tree-ul are fișiere netrackate din sesiuni vechi (prompturi, SQL-uri, PDF-uri cu
date reale). `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**
Confirmă în raport ce ai stage-uit.

```
fix(#191): pragul de parola din frontend se aliniaza la politica serverului — v3.9.846

#181 a urcat MIN_PASSWORD_LEN la 10, dar frontendul a ramas la 6 in cinci
locuri. Utilizatorul isi alegea o parola de 7 caractere, browserul o accepta,
serverul o refuza — cel mai des exact la prima logare, cu force_password_change
activ, cand omul nu poate face nimic altceva pana nu reuseste.

Cele cinci locuri urca la 10, cu acelasi mesaj ca al serverului. Serverul nu
se atinge: el e sursa de adevar.

Codul TOTP de 6 cifre din organizations.js RAMANE 6 — nu e o parola.

Un test nou citeste sursele din public/ si compara pragul cu MIN_PASSWORD_LEN
importat, nu cu un numar scris de mana: urmatoarea schimbare de politica cade
la test in loc sa treaca tacut in productie.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv `CACHE_VERSION` real).
2. Cele cinci locuri modificate, cu linia dinainte și cea de după.
3. ⭐ Confirmarea explicită că `code.length < 6` din `organizations.js` (TOTP) e **neatins**,
   cu linia citată.
4. Rezultatul fiecărui caz din Etapa B, în special **1** și **2**.
5. `CACHE_VERSION` și toate `?v=`-urile — înainte și după, cu `grep`-ul de verificare;
   pentru `df-user-modals.js`, cele 10 linii.
6. Numerele reale `npm test` / `npm run test:db`, rulate **secvențial**.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale. În special: mai există în `public/` vreo validare care duplică o
    regulă de-a serverului fără să o citească de la el?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero scrieri în baza de date.
- ⛔ `code.length < 6` (TOTP) **rămâne 6**.
- ⛔ `server/services/password-policy.mjs` **neatins**.
- ⛔ Fără reguli de compoziție, fără `minlength` nativ.
- ⛔ În `df-user-modals.js` se atinge **doar** blocul de validare a lungimii. CSRF-ul manual
  și `fetch`-urile brute de acolo sunt obiectul lotului **#192** — nu le atinge acum.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
