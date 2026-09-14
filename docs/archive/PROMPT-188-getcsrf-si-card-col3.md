---
prompt: 188
titlu: "Legarea fluxului la dosarul ALOP eșua pe o funcție inexistentă + col.3 însumată pe cardul ALOP"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.842
versiune_tinta: v3.9.843
migratii: NU
fisiere_din_public: DA   (⇒ bump `?v=` ȚINTIT)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Defectul 1 — `getCsrf` nu există în scopul din care e apelată

`public/js/semdoc-initiator/main.js` cheamă `getCsrf()` la liniile **2489, 2516 și 2532**.
Funcția nu e definită nicăieri accesibil din acel fișier:

- `df-utils.js` o definește, dar o exportă **doar** ca `window.df.getCsrf` (blocul de export de la
  finalul fișierului) — nu ca globală;
- `df-apifetch-shim-full.js:22` și `notif-widget.js:197` o au fiecare **în propriul IIFE**;
- `grep -rn "window.getCsrf" public/` ⇒ **zero rezultate**.

⇒ `getCsrf()` aruncă `ReferenceError`, **sincron**, înainte ca vreo cerere să plece. Excepția e
prinsă de `catch (e) { _alopLinkErr = 'eroare de rețea' }` (`:2524` și `:2540`), iar utilizatorul
vede banda galbenă „Fluxul a fost creat, dar **legarea la dosarul ALOP a eșuat**: eroare de rețea".

Nu e o eroare de rețea. Nu e nici o regresie recentă — `semdoc-initiator/main.js` e încă pe `fetch`
brut (nemigrat la `DFApi`), iar `df-utils.js` e neatins de mult.

**Măsurat pe producție:** 10 dosare cu `df_id` completat și `df_flow_id` NULL, **toate în status
`angajare`** — adică exact fluxurile aflate în derulare. Cele aprobate au fost reparate de
`selfHealAlopDfLink` și au avansat, de aceea nu apar. Tipar curat, nimic altceva nu l-ar produce.

Ce se pierde când apelul nu se execută: `alop_instances.df_flow_id` și, în același handler,
**copierea atașamentelor DF → flux** (`copyFormularAttachmentsToFlow`, `alop.mjs`).

---

## Defectul 2 — col.3 însumată peste rânduri pe cardul ALOP

`server/routes/alop.mjs:807` — `ord_col3`, introdus de #186: `SUM(rows[].plati_anterioare)` peste
ORD-ul curent, folosit pentru „Total plăți" pe cardul ALOP.

E exact defectul reparat de #187 în derivare, rămas pe calea de afișare: col.3 e **o proprietate a
angajamentului**, repetată identic în fiecare bloc (#128k), deci însumarea o multiplică cu numărul
de blocuri. Măsurat: în producție există **3 chei cu mai multe rânduri**, toate coerente ⇒ defectul
are pe ce să se manifeste.

Nu e cifră semnată și nu intră în nicio validare — doar afișare. Dar e greșită.

---

## ETAPA 0 — ancorele (READ-ONLY)

```bash
node -p "require('./package.json').version"          # Așteptat: 3.9.842
grep -n "getCsrf()" public/js/semdoc-initiator/main.js         # Așteptat: 3 linii (2489, 2516, 2532)
grep -rn "window.getCsrf" public/                              # Așteptat: 0
grep -n "df\." public/js/semdoc-initiator/main.js | head -5    # confirmă că `df.` e deja folosit acolo
grep -n "ord_col3" server/routes/alop.mjs
grep -n "cheieRand\|agregaCheiCol3" server/services/ord-lant.mjs
```

⚠️ Dacă `df.` **nu** e deja folosit în `semdoc-initiator/main.js`, oprește-te și raportează —
înseamnă că `window.df` poate să nu fie disponibil acolo și reparația are altă formă.

---

## ETAPA A — cele trei apeluri

`public/js/semdoc-initiator/main.js`, liniile 2489, 2516, 2532:

```
"X-CSRF-Token": getCsrf()   →   "X-CSRF-Token": df.getCsrf()
```

Fiecare pe rând, cu `old_str` lărgit până devine unic (cele trei linii se aseamănă).

⛔ Nu migra fișierul la `DFApi` în acest lot. `semdoc-initiator` e în lotul de migrare care urmează,
iar acolo antetul CSRF dispare complet din call-site. Aici repari doar apelul rupt.

---

## ETAPA B — mesajul care nu mai minte

Cele două `catch` (`:2524`, `:2540`) etichetează orice excepție drept „eroare de rețea". Asta ne-a
costat timp de diagnostic: simptomul spunea transport, cauza era cod.

Distinge, folosind `e.name`: o excepție de tip `TypeError` / `ReferenceError` e o **eroare a
aplicației**, nu de rețea. Textul pentru utilizator poate rămâne scurt (de ex. „eroare internă"),
dar `console.error` trebuie să păstreze obiectul complet, ca azi.

⛔ Nu schimba structura blocului, nu unifica cele două `catch`, nu muta nimic. Doar eticheta.

---

## ETAPA C — poarta care oprește repetarea

Test nou `server/tests/unit/csrf-helper-scope.test.mjs`, analiză statică pe `public/`:

Pentru **fiecare** fișier `.js` din `public/` care conține un apel `getCsrf(` **neprefixat**
(adică nu `df.getCsrf(`, nu `DFApi.getCsrf(`, nu `.getCsrf(`), fișierul trebuie să conțină și
propria definiție (`function getCsrf`). Altfel testul cade, cu numele fișierului și linia în mesaj.

Derivă lista din `readdirSync` recursiv, nu dintr-o listă scrisă de mine — altfel poarta protejează
doar fișierele de azi. Fișierele legitime, care își definesc funcția local, trebuie să treacă:
`df-utils.js`, `df-apifetch-shim-full.js`, `admin/core.js`, `notif-widget.js`.

Raportează în raport **câte fișiere** a examinat testul și **câte** au apeluri neprefixate.

---

## ETAPA D — col.3 pe cardul ALOP

`server/routes/alop.mjs:807` (`ord_col3`) nu mai însumează. Regula e cea stabilită la #187:
**col.3 se ia o singură dată per cheie din coloana 1**; între chei diferite valorile se adună
(sunt angajamente distincte), dar peste rândurile aceleiași chei **nu**.

Refolosește `cheieRand` / `agregaCheiCol3` din `services/ord-lant.mjs` — nu scrie a doua
normalizare de cheie și nu duplica agregarea. Dacă asta cere mutarea calculului din SQL în JS,
fă-o și explică în raport de ce; e o cifră de afișare, nu o cale critică.

⚠️ Dacă o cheie iese `col3_inconsistent`, afișarea **nu inventează** o valoare: folosește ce e mai
conservator și spune în raport ce ai ales. Măsurat în producție: zero cazuri azi.

⛔ Nu atinge nimic de pe calea col.4 (disponibil, plafoane, `sumaOrdonantataDosar`,
`validateOrdBugetAnCurent`, `noua-lichidare`).

---

## ETAPA E — teste

`server/tests/db/alop-card-col3.test.mjs` (nou):
1. ⭐ ORD cu 2 blocuri, aceeași cheie, col.3 = 300.424,95 repetată ⇒ cardul arată **300.424,95**,
   nu 600.849,90.
2. ORD cu două chei diferite ⇒ valorile se adună (sunt angajamente distincte).
3. **Nedeteriorare:** ORD cu un singur bloc ⇒ aceeași cifră ca azi.
4. **Nedeteriorare:** „Iluminat public" ciclul 2 ⇒ cifra rămâne cea de la #186.

```bash
npm test
npm run test:db
```

`test:db` COMPLET, REAL. ⚠️ **Nu rula `npm test` în paralel cu `test:db`** — a produs deja de trei
ori eșecuri false prin timeout (`auth-crypto`, `formulare-pdf-wrap`). Rulează-le secvențial și
spune în raport că ai făcut-o.

Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l modifica**.

---

## ETAPA F — versiune, cache, commit

```bash
npm version 3.9.843 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json
git status --short
```

`?v=` țintit pe `semdoc-initiator/main.js`, în `semdoc-initiator.html`. `CACHE_VERSION` doar dacă
atingi `PRECACHE_ASSETS` — verifică.

`git add` **explicit**. **Niciodată `git add -A`.**

Commit:
```
fix(#188): legarea fluxului la dosarul ALOP + coloana 3 pe cardul ALOP — v3.9.843

semdoc-initiator/main.js chema getCsrf() la trei call-site-uri, dar functia nu
e definita in niciun scop accesibil de acolo: df-utils o exporta doar ca
df.getCsrf, iar celelalte doua copii traiesc in IIFE-uri. Apelul arunca
ReferenceError sincron, prins de un catch care eticheta orice excepite drept
"eroare de retea" — de unde banda galbena "legarea la dosarul ALOP a esuat".

Consecinta reala: alop_instances.df_flow_id ramanea NULL si atasamentele DF nu
se copiau in flux. Masurat: 10 dosare, toate in status angajare — cele aprobate
fusesera reparate de selfHealAlopDfLink.

In plus, cardul ALOP insuma coloana 3 peste randurile ORD-ului, aceeasi
greseala pe care #187 a reparat-o in derivare: coloana 3 e o proprietate a
angajamentului, repetata in fiecare bloc (#128k). Trece pe agregarea per cheie.

Poarta noua de test: un apel getCsrf() neprefixat e permis doar in fisierele
care isi definesc singure functia.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**, inclusiv verdictul pe `df.` în initiator.
2. Cum ai făcut unic fiecare dintre cele trei `old_str`.
3. Ce etichetă ai ales la Etapa B și cum distingi excepția de cod de cea de transport.
4. Etapa C: câte fișiere a examinat poarta, câte au apeluri neprefixate, care sunt.
5. Etapa D: unde ai pus calculul (SQL sau JS) și de ce; ce faci pe `col3_inconsistent`.
6. Rezultatul cazurilor din Etapa E, în special **1**.
7. Confirmare că `npm test` și `test:db` au rulat **secvențial**, cu numerele reale.
8. Confirmare că nimic de pe calea col.4 nu a fost atins.
9. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
10. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
11. Constatări colaterale. În special: mai există alte funcții presupuse globale și apelate
    neprefixat din fișiere care nu le definesc? Poarta de la Etapa C acoperă doar `getCsrf`.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații.
- **Nu migra `semdoc-initiator` la `DFApi`** — lot separat.
- Calea col.4 — **neatinsă**.
- Col.3 nu se însumează peste rândurile aceleiași chei, nicăieri.
- `npm test` și `test:db` **secvențial**, niciodată în paralel.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact, sau se potrivește de mai multe ori ⇒ **OPREȘTE-TE**.
