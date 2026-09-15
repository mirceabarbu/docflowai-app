---
prompt: 201
titlu: "Mediul local: PostgreSQL 17 pentru test:db + notele învechite din CLAUDE.md"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.853
versiune_tinta: v3.9.854
migratii: NU
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
tip: mediu + documentație
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul

Mircea lucrează de pe mai multe calculatoare. Pe unele, `npm run test:db` rulează complet —
PostgreSQL 17 e disponibil, rețeta din `CLAUDE.md` ridică o instanță efemeră pe portul 55432.
**Pe mașina asta nu.** Ultimele două loturi (#199, #200) au raportat `test:db` ca
`1 passed / 136 skipped`, iar dovada a venit abia din CI, după push.

Asta inversează ordinea sănătoasă: descoperim problemele **după** ce codul e pe `develop`,
nu înainte. Și ne obligă să acceptăm inspecția manuală în locul rulării — la #200, „ar fi
eșuat cu expected 0, got 1" a fost o deducție onestă, dar nu o dovadă.

Lotul ăsta face `test:db` să ruleze local, pe mașina asta, și scrie în `CLAUDE.md` cum se
face — ca următoarea sesiune, pe orice calculator, să n-o descopere din nou.

---

## ETAPA A — PostgreSQL 17 local

Rețeta existentă din `CLAUDE.md` ridică o instanță **efemeră**: `initdb` într-un `PGDATA`
temporar, `pg_ctl` pe portul 55432, ștearsă la final. Deci **nu ai nevoie de un serviciu
Windows instalat și pornit — ai nevoie doar de binare** (`initdb`, `pg_ctl`, `createdb`,
`psql`).

Ordinea de preferință, oprește-te la prima care reușește:

1. **Binare portabile PostgreSQL 17** (arhiva „PostgreSQL Binaries" de pe pagina oficială de
   descărcare). Se dezarhivează într-un director, fără drepturi de administrator, fără
   serviciu. Cea mai curată variantă pentru scopul nostru.
2. **`winget`**, dacă e disponibil: caută întâi pachetul (`winget search PostgreSQL`) și
   confirmă că versiunea e **17.x** înainte de instalare. Nu instala 16 sau 18 — CI rulează
   pe 17 și vrem același motor.
3. **Instalatorul oficial**, dacă primele două nu merg. Dacă cere drepturi de administrator
   pe care nu le ai, **oprește-te și raportează** — nu încerca ocolișuri.

⛔ Nu instala Docker. E o dependență grea pentru o nevoie mică.
⛔ Nu porni un serviciu PostgreSQL permanent. Instanța rămâne efemeră, ca azi.
⛔ Nu descărca de pe altă sursă decât site-ul oficial PostgreSQL sau un manager de pachete
   recunoscut. Verifică versiunea după instalare cu `initdb --version`.

**Criteriul de reușită al etapei:**

```bash
"$PGBIN/initdb" --version          # trebuie să arate 17.x
npm run test:db
```

Rularea trebuie să arate **137 de fișiere**, toate trecute, **zero skipped**. Dacă apar
skip-uri, etapa nu e terminată.

---

## ETAPA B — `CLAUDE.md`: mediul, scris o dată pentru totdeauna

Adaugă în secțiunea rețetei de test o subsecțiune scurtă:

1. **Unde se caută binarele**, în ordine — variabila de mediu dacă e setată, locurile
   obișnuite de instalare, directorul portabil. Scrie calea reală pe care ai găsit-o pe
   mașina asta.
2. **Ce se face dacă lipsesc** — trimite la Etapa A de mai sus, pe scurt.
3. ⭐ **Regula bazei proaspete.** Măsurat la #195: aceeași suită a rulat în **806 s** pe o
   bază nouă și în **1327 s** pe una refolosită de câteva ori. Recreează `PGDATA` la fiecare
   sesiune, și după vreo cinci rulări dacă sesiunea e lungă. `initdb` costă secunde; o bază
   obosită costă zece minute pe rulare.
4. ⭐ **Regula de măsurare** (din corecția #197): **o singură rulare `test:db` pe instanță**.
   Rezultatul se citește **din log**, nu din notificări de fundal, iar numărul de fișiere se
   confruntă cu discul. Două rulări suprapuse peste aceeași bază au produs deja cifre false
   într-un raport.
5. **`skipped ≠ passed`.** Dacă `test:db` sare fișiere, raportul spune „nerulat", nu „verde".

---

## ETAPA C — două note care au devenit false

`#199` a șters forțarea re-rulării migrației `014_alop` la fiecare pornire. Două locuri încă
o descriu ca existentă:

1. **`CLAUDE.md`** — fraza „Există un force-rerun pe 014_alop — nu adăuga altele".
   Înlocuiește-o: re-rularea forțată a existat până la #199 și a fost eliminată; nu se adaugă
   altele. ⚠️ Ăsta e fișierul pe care-l citește fiecare sesiune viitoare — o instrucțiune
   falsă acolo costă mai mult decât un comentariu greșit în cod.
2. **`server/tests/db/migrations-advisory-lock.test.mjs`** — comentariile care pomenesc
   „force-rerun-ul idempotent 014_alop". Aserțiile sunt corecte și verzi; se corectează
   **doar comentariile**.

⛔ Nu atinge nicio aserție din acel test. Dacă o corecție de comentariu ar cere schimbarea
unei aserții, **oprește-te și raportează**.

---

## ETAPA D — rulare, versiune, commit

```bash
npm test
npm run test:db
```

⭐ **Ăsta e testul de acceptanță al lotului:** `test:db` trebuie să ruleze **complet local**,
137 de fișiere, zero skipped, citit din log, pe bază proaspătă.

```bash
npm version 3.9.854 --no-git-tag-version
npm install --package-lock-only
git status --short
```
⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=`.
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`** — directorul are
fișiere netrackate (prompturi, SQL-uri) și, posibil acum, binare PostgreSQL dezarhivate.
⛔ **Binarele PostgreSQL nu intră în repo.** Dacă le-ai extras în directorul proiectului,
mută-le în afara lui sau adaugă-le în `.gitignore` — și spune în raport ce ai făcut.

```
chore(#201): test:db ruleaza local pe PG17 + CLAUDE.md corectat — v3.9.854

Pe masina asta lipsea PostgreSQL, iar test:db sarea 136 de fisiere. Loturile
#199 si #200 si-au luat dovada abia din CI, dupa push — adica descopeream
problemele dupa ce codul era pe develop, nu inainte. Acum ruleaza local.

CLAUDE.md primeste sectiunea de mediu: unde se cauta binarele, ce se face daca
lipsesc, regula bazei proaspete (806s pe baza noua vs 1327s pe una refolosita,
masurat la #195), o singura rulare pe instanta cu rezultatul citit din log
(corectia #197), si regula ca skipped nu inseamna passed.

Separat, doua note devenite false dupa #199, care stergea forta re-rularii
migratiei 014_alop la fiecare pornire: fraza din CLAUDE.md si comentariile din
migrations-advisory-lock.test.mjs. Aserttiile testului raman neatinse.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Cum ai obținut PostgreSQL 17: metoda, sursa, calea finală a binarelor, ieșirea lui
   `initdb --version`.
2. ⭐⭐ Rularea `test:db` **locală**: numărul de fișiere, de teste, durata, **zero skipped**,
   citite din log, cu numărul de fișiere confruntat cu discul.
3. `npm test` — numere reale.
4. Ce ai scris în `CLAUDE.md`, pe scurt, și confirmarea că fraza despre `014_alop` a fost
   corectată.
5. Confirmarea că **nicio aserție** din `migrations-advisory-lock.test.mjs` nu a fost atinsă.
6. Unde au ajuns binarele PostgreSQL și confirmarea că **nu** sunt în repo.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. ⭐ Dacă acum, cu baza reală disponibilă, vreun test din #199 sau #200 **pică** — raportează
   imediat și **nu-l repara**. Amândouă loturile au fost validate doar în CI; o rulare locală
   completă e prima verificare independentă.
10. Divergențe prompt↔cod și constatări colaterale.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero scrieri în baza de producție.
- ⛔ Fără Docker. Fără serviciu PostgreSQL permanent. Fără instalare care cere drepturi de
  administrator pe care nu le ai — în acel caz, oprește-te și raportează.
- ⛔ Sursă oficială, versiune **17.x** verificată după instalare.
- ⛔ Binarele nu intră în repo.
- ⛔ Aserțiile din `migrations-advisory-lock.test.mjs` — neatinse.
- ⛔ `skipped ≠ passed`. Dacă `test:db` tot sare fișiere la final, lotul **nu** e terminat —
  raportează ce a blocat.
- `git add` explicit, niciodată `-A`.
