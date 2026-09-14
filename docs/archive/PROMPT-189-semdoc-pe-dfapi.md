---
prompt: 189
titlu: "Paginile de semnare pe sursa unică DFApi (etapa 3/4) — semdoc-signer și semdoc-initiator"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.843
versiune_tinta: v3.9.844
migratii: NU
fisiere_din_public: DA   (⇒ bump `?v=` ȚINTIT)
zona_no_touch_atinsa: NU (zona NO-TOUCH e pe server; aici e doar frontend)
etapa: "3 din 4 din consolidarea completă"
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## ⚠️ Acesta e ecranul pe care se semnează. Citește tot înainte de a scrie o linie.

`semdoc-signer` e calea vie prin care se produc semnăturile QES: 10.535 de evenimente în cinci
luni. O regresie aici nu strică un badge — oprește semnarea pentru toată instituția, iar modul de
eșec e un buton care nu mai face nimic, nu o eroare în log.

Orice ancoră care nu iese, orice `old_str` care nu se potrivește ⇒ **OPREȘTE-TE și raportează**.

---

## Context — mai mic decât pare

Majoritatea apelurilor din aceste fișiere trec **deja** prin `_apiFetch`, care de la #183 deleagă
la `DFApi`. Măsurat pe arhivă:

| fișier | linii | `fetch(` brut | apeluri `_apiFetch` |
|---|---|---|---|
| `public/js/semdoc-initiator/main.js` | 2.680 | 5 | 19 |
| `public/js/semdoc-signer/main.js` | 1.461 | 2 | 20 |
| `public/js/semdoc-signer/modals.js` | 35 | 1 | 0 |
| `public/js/semdoc-signer/auth-guard.js` | 17 | 1 | 0 |

⇒ **opt** call-site-uri de migrat (al nouălea e exclus, vezi mai jos).

**Verificat, ca să știi că e sigur:** `authHeaders` (`initiator/main.js:14`) e un rest gol de la
SEC-01 — întoarce `extra` neschimbat. Tokenul semnatarului circulă **exclusiv ca parametru de
query** (`?token=…`), niciodată ca antet. Deci ștergerea lui `Authorization` de către `DFApi` nu
atinge autentificarea semnatarului. Era singurul lucru care ar fi făcut lotul periculos.

---

## ⛔ Ce NU se migrează

**`public/js/semdoc-signer/auth-guard.js` rămâne pe `fetch` brut.** Se încarcă la linia **14** din
`semdoc-signer.html`, iar `df-api.js` intră abia după `df-utils` (17-18). Comentariul din fișier e
explicit: „Trebuie încărcat EARLY — NU avem shell client să facă redirect." E garda care aruncă la
login un vizitator nelogat. Mutarea lui după `df-api.js` ar întârzia redirectul, iar `DFApi` fără
cârlige n-ar aduce nimic: face un `GET /auth/me`, fără CSRF și fără nevoie de refresh.

Adaugă în fișier un comentariu de o linie care spune de ce rămâne așa, ca următorul lot să nu-l
„uite" și nici să nu-l migreze din reflex.

---

## ⚠️ Capcanele, în ordinea gravității

### C1 — `FormData` fără `Content-Type` (nouă, nu apărea la #184)

`initiator/main.js:317` — `POST /api/convert-to-pdf` trimite un `FormData` **fără** antet
`Content-Type`, deliberat: browserul îl generează singur, cu `boundary`. Dacă `DFApi` ar adăuga
vreun `Content-Type`, boundary-ul se pierde și încărcarea se rupe tăcut.

⇒ Verifică pe codul lui `df-api.js` că nu atinge `Content-Type` **nici când lipsește**, și
raportează ce ai găsit **înainte** de a migra acest apel. La #184 s-a confirmat că nu-l
suprascrie când e prezent; cazul „absent" e altul.

### C2 — răspunsuri binare pe calea de semnare

`signer/main.js` are opt locuri cu `.blob()` / `.arrayBuffer()`: descărcarea PDF-ului
(`:656, :679, :880, :895`), hash-ul SHA-256 trimis la STS (`:926`), cartușul PAdES (`:907`),
fallback-ul (`:986`), și `:997, :1444`. `DFApi.fetch` întoarce `Response` brut — confirmat la #184,
cazul 6 — dar aici e calea vie de semnare. Test dedicat, nu presupunere.

### C3 — antetul CSRF dispare din call-site

La fiecare mutație migrată, `'X-CSRF-Token'` **se șterge**; `DFApi` îl pune. Motivul e cel de la
#184/C1: `fetch` normalizează cheile `Headers` și **concatenează valorile duplicate cu virgulă**,
deci un token `abc,abc` invalid ⇒ 403 ⇒ retry ⇒ „uneori merge, alteori nu".

⚠️ În `initiator/main.js`, trei dintre aceste apeluri folosesc `df.getCsrf()` (reparate la #188).
După migrare, apelul dispare complet — asta e chiar reparația structurală a clasei de bug de la
#188.

### C4 — `fetch` inline într-un atribut `onclick`

`signer/main.js:38` — butonul „Ieșire" are `onclick="fetch('/auth/logout',…)"` scris într-un
literal HTML. Migrarea la `DFApi.fetch` funcționează (e global), dar **verifică ghilimelele**:
literalul e deja imbricat. Dacă devine fragil, lasă-l pe `fetch` brut și spune de ce — un
`POST /auth/logout` care oricum termină cu `location.href` nu justifică riscul.

---

## ETAPA 0 — ancorele (READ-ONLY)

```bash
node -p "require('./package.json').version"          # Așteptat: 3.9.843
grep -c "fetch(" public/js/semdoc-initiator/main.js public/js/semdoc-signer/main.js \
                 public/js/semdoc-signer/modals.js public/js/semdoc-signer/auth-guard.js
grep -rn "DFApi" public/js/semdoc-initiator public/js/semdoc-signer   # Așteptat: 0
grep -n "df-api.js\|auth-guard.js\|df-apifetch-shim-full" public/semdoc-signer.html public/semdoc-initiator.html
grep -n "X-CSRF-Token" public/js/semdoc-initiator/main.js public/js/semdoc-signer/*.js
```

Apoi **citește integral `public/js/shared/df-api.js`** și raportează, înainte de orice modificare:
1. Ce face cu `Content-Type` **absent** (C1) — răspunsul decide dacă migrăm `convert-to-pdf`.
2. Ce întoarce (`Response` brut?) și dacă citește corpul pe vreo ramură.
3. Confirmarea că `df-api.js` e încărcat **înaintea** lui `semdoc-*/main.js` pe ambele pagini,
   cu indicii reale.

---

## ETAPA A — migrarea, un commit pe fișier, în ordinea riscului crescător

### A.1 — `public/js/semdoc-signer/modals.js` (1 apel)

`POST /auth/change-password`. Migrare simplă.

⚠️ **Nu atinge pragul `nw.length<6`.** Politica serverului e 10 de la #181, iar frontendul spune 6
în cinci locuri. E o divergență reală, dar e **lot separat** — dacă o repari aici, amesteci o
schimbare vizibilă utilizatorului cu o migrare mecanică și nu se mai poate spune care a stricat ce.

### A.2 — `public/js/semdoc-signer/main.js` (2 apeluri)

`:38` — vezi C4. `:1319` — `GET signer-status`, migrare simplă.
Apoi verifică cele opt locuri binare din C2 — **nu le modifica**, doar confirmă că trec prin
`_apiFetch`, deci deja prin `DFApi`.

### A.3 — `public/js/semdoc-initiator/main.js` (5 apeluri)

`:41` GET providers · `:317` **C1, FormData** · `:2487` link-flow · `:2514` link-df/ord ·
`:2530` link-df-flow/ord-flow.

Cele trei de la final sunt exact blocul reparat la #188. După migrare, `df.getCsrf()` dispare de
acolo. **Nu atinge** structura blocului, cele două `catch`, sau etichetele de eroare de la #188.

### Forma migrării — fără excepție

- `fetch(` → `DFApi.fetch(`
- `credentials:'include'` **dispare** (îl impune `DFApi`)
- `'X-CSRF-Token': …` **dispare**
- `'Content-Type'` **rămâne exact cum e**, inclusiv absent
- URL, metodă, corp, tratarea răspunsului, `try/catch` — **neatinse**
- ⛔ Nicio „îmbunătățire" pe drum. Un diff cu altceva în el nu se mai poate verifica prin citire,
  iar citirea e singura plasă de siguranță pe care o avem aici.

### Ce mai rămâne

Înlocuirea celor 39 de apeluri `_apiFetch` cu `DFApi.fetch` **nu se face în acest lot** —
`_apiFetch` deleagă deja la `DFApi`, deci ar fi zgomot fără câștig. Ștergerea shim-urilor rămâne
pentru etapa 4, după ce o poartă de test confirmă că n-au consumatori.

---

## ETAPA B — teste

`server/tests/unit/semdoc-dfapi-migrare.test.mjs` (nou).

Analiză statică:
1. Zero `X-CSRF-Token` în `public/js/semdoc-initiator/` și `public/js/semdoc-signer/`.
2. Zero `credentials:` rămase în call-site-urile migrate.
3. `auth-guard.js` **încă** are `fetch(` brut și **nu** are `DFApi` — testul apără decizia
   deliberată, ca un lot viitor să nu-l migreze din reflex. Numele testului să spună de ce.
4. Numărul de `DFApi.fetch(` per fișier = numărul de `fetch(` de dinainte, minus excluderile.
   Derivă cifrele din fișier, pe fișierul **întreg**, nu dintr-un grep îngust.

Comportament, `happy-dom` + `fetch` falsificat, pe `df-api.js` real:
5. ⭐ **C1:** un `POST` cu corp `FormData` și **fără** `Content-Type` ajunge la rețea tot fără
   `Content-Type`. Testul care apără încărcarea fișierelor de convertit.
6. ⭐ **C2:** `DFApi.fetch` întoarce un `Response` pe care `.blob()` și `.arrayBuffer()` dau
   exact octeții trimiși.
7. **C3:** o mutație migrată ajunge cu **exact un** antet CSRF.

```bash
npm test
npm run test:db
```

⚠️ **Secvențial, niciodată în paralel** — a produs deja de trei ori eșecuri false prin timeout.
Spune în raport că ai făcut-o. Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l modifica**.

---

## ETAPA C — verificarea manuală (lista pentru Mircea)

Enumeră în raport, gata de bifat. Aici nu există alternativă automată:

- semnare STS individuală **cap-coadă**, pe un link de semnatar real;
- semnare în masă cap-coadă (80% din trafic);
- încărcarea unui fișier **non-PDF** la inițiere ⇒ conversia reușește (C1);
- descărcarea PDF-ului semnat și a celui nesemnat din ecranul semnatarului (C2);
- pornirea unui flux dintr-un dosar ALOP ⇒ **fără** banda galbenă, `df_flow_id` completat;
- reîncărcarea paginii de semnare în mijlocul unei semnări STS ⇒ polling-ul se reia
  (`checkAndResumeStsPolling`, `signer/main.js:1319`);
- ieșirea din cont din ecranul semnatarului (C4).

---

## ETAPA D — versiune, cache, commit

```bash
npm version 3.9.844 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
git status --short
```

`?v=` **țintit** pe fișierele modificate, în `semdoc-signer.html` și `semdoc-initiator.html`.
`CACHE_VERSION` doar dacă atingi `PRECACHE_ASSETS` — verifică, nu presupune.

`git add` **explicit**, pe fișiere numite. **Niciodată `git add -A`.**

Commit final (după cele pe fișier), sau mesaj pe ultimul:
```
refactor(#189): paginile de semnare pe sursa unica DFApi (etapa 3/4) — v3.9.844

Opt call-site-uri fetch brute din semdoc-signer si semdoc-initiator trec pe
DFApi. Antetul CSRF dispare din call-site — aceeasi cheie duplicata cu
capitalizare diferita ar fi fost concatenata cu virgula de Headers, iar
getCsrf() apelat neprefixat a fost chiar defectul reparat la #188; dupa
migrare, apelul nu mai exista.

auth-guard.js ramane deliberat pe fetch brut: se incarca inaintea df-api.js
si trebuie sa redirectioneze cat mai devreme. Un test apara decizia.

Corpurile FormData fara Content-Type si raspunsurile binare de pe calea de
semnare sunt acoperite de teste dedicate. Cele 39 de apeluri _apiFetch raman
— delegheaza deja la DFApi; stergerea shim-urilor e etapa 4.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**.
2. ⭐ Ce face `df-api.js` cu `Content-Type` **absent** — raportat înainte de migrare.
3. Tabelul ordinii de încărcare pe cele două pagini, cu indicii reali.
4. Per fișier migrat: câte apeluri, câte mutații, hash-ul commitului.
5. Rezultatul fiecărui caz din Etapa B, în special **3, 5 și 6**.
6. Ce ai decis la C4 (`onclick`) și de ce.
7. Lista de verificare manuală din Etapa C.
8. Ce ai bumpat la Etapa D; dacă ai atins `CACHE_VERSION`.
9. Numerele reale `npm test` / `npm run test:db`, rulate **secvențial**.
10. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
11. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
12. Constatări colaterale. În special: mai există în aceste două module apeluri care fac ceva ce
    `DFApi` nu poate reprezenta, sau locuri unde tratarea răspunsului presupune un comportament
    pe care migrarea îl schimbă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero atingeri pe server, în afara fișierelor de test.
- **Un commit pe fișier migrat.**
- `auth-guard.js` rămâne **nemigrat**.
- Pragul `nw.length<6` din `modals.js` rămâne **neatins** — lot separat.
- Blocul ALOP reparat la #188 (structură, `catch`, etichete) rămâne **neatins**.
- Cele 39 de apeluri `_apiFetch` rămân **neatinse**.
- `Content-Type` rămâne exact cum e, inclusiv absent.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
