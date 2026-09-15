---
prompt: 200
titlu: "Clasa C nu mai raportează ciclurile ORD arhivate ca divergențe"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.852
versiune_tinta: v3.9.853
migratii: NU
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO — modulul e strict de detecție
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul — un fals pozitiv, dovedit pe date de producție

Cardul „Consistență document↔flux" arată **1 divergență**, clasa `alop_fara_document`:

```
ORD 42714 · doc 2edd5722-72ea-49f5-b6f7-5508929a5d3d
ALOP 06c71fef-593d-4321-8075-daf1c7f007bf
„ALOP fără ord_id, dar există un ORD cu source_alop_id = ALOP"
```

Interogat pe producție, `alop_ord_cicluri` pentru acel dosar întoarce:

```
ciclu_nr = 1 · status = completed · ord_id = 2edd5722-72ea-49f5-b6f7-5508929a5d3d
```

Adică exact ORD-ul semnalat. **Dosarul e sănătos.** `noua-lichidare` (`alop.mjs:1751`)
arhivează ciclul în `alop_ord_cicluri` și golește `alop.ord_id` ca să pornească ciclul
următor; ORD-ul vechi rămâne legat de dosar prin `source_alop_id`, cum e normal.

Ramura ORD a clasei C nu verifică ciclurile arhivate, deci raportează **fiecare dosar care a
trecut vreodată printr-o nouă lichidare**.

⚠️ De ce contează mai mult decât un rând pe ecran: cardul e util **doar cât timp zero e
normalul**. Un card care arată permanent un număr diferit de zero e ignorat în două
săptămâni, iar divergența reală de a treia oară trece neobservată. La #190 am scris un test
dedicat ca noua clasă E să nu raporteze starea normală de după o anulare. Clasa C, din #120,
n-a primit niciodată aceeași grijă față de `noua-lichidare`.

⛔ **Zero reparații de date.** Nu se atinge niciun rând. Se îngustează detectorul.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                   # Așteptat: 3.9.852
grep -n "alop_fara_document" server/services/flow-link-audit.mjs
grep -n "alop_fara_flux" server/services/flow-link-audit.mjs
grep -n "noua-lichidare" server/routes/alop.mjs
grep -n "alop_ord_cicluri" server/services/flow-link-audit.mjs   # Așteptat: NICIUNUL azi
```

⭐ Confirmă pe cod două lucruri, nu le presupune:
1. `noua-lichidare` chiar **golește `alop.ord_id`** când arhivează ciclul (citește
   `UPDATE alop_instances` din acea ramură și spune ce coloane pune pe NULL).
2. Ramura **ORD a clasei B** cere `a.ord_id IS NOT NULL`, deci **nu** are aceeași orbire.
   Dacă descoperi că are, **oprește-te și raportează** — se schimbă scopul lotului.

---

## ETAPA A — testele ÎNTÂI

⛔ **Nu atinge detectorul până testul 1 nu e scris și nu PICĂ pe codul actual.**

Extinde `server/tests/db/flow-link-audit.test.mjs` (nu fișier nou — pool partajat,
`pool.end()` o singură dată, în ultimul `describe`).

1. ⭐⭐ **Cazul de producție reprodus.** ALOP ne-anulat cu `ord_id = NULL`, un ORD nedeleted
   cu `source_alop_id` = ALOP, **și** un rând în `alop_ord_cicluri` cu `alop_id` = ALOP și
   `ord_id` = acel ORD (`ciclu_nr = 1`, `status = 'completed'`).
   ⇒ **NU** e raportat. `alop_fara_document` = 0, `total` = 0.
   Pe codul actual testul **trebuie să pice**. Pune mesajul de eșec în raport.
2. ⭐ **Clasa își păstrează dinții.** ALOP cu `ord_id = NULL`, ORD cu `source_alop_id` = ALOP,
   **fără niciun rând** în `alop_ord_cicluri` ⇒ **este** raportat.
   Fără testul ăsta, îngustarea ar putea stinge clasa complet, iar noi n-am ști.
3. ⭐ **Excluderea e scopată pe dosar.** Ciclul arhivat care conține acel `ord_id` aparține
   **altui** ALOP ⇒ ORD-ul **este** raportat pe dosarul lui. Apără contra unui `NOT EXISTS`
   scris fără condiția pe `alop_id`.
4. **Ramura DF neschimbată.** ALOP cu `df_id = NULL` și un DF cu `source_alop_id` = ALOP
   ⇒ raportat, ca azi. (`noua-lichidare` nu golește `df_id` — DF-ul e al dosarului, nu al
   ciclului.)
5. **Clasa B neatinsă** — fixtura ei existentă dă același rezultat.
6. **`orgId` respectat** pe cazul nou.

---

## ETAPA B — îngustarea

În ramura **ORD** a clasei C (`alop_fara_document`), adaugă în `WHERE`:

```sql
         AND NOT EXISTS (SELECT 1 FROM alop_ord_cicluri c
                          WHERE c.alop_id = a.id AND c.ord_id = d.id)
```

Comentariu deasupra ramurii, o frază: un ORD care aparține unui ciclu **arhivat** al
aceluiași dosar nu e o divergență — `noua-lichidare` golește `alop.ord_id` prin proiectare,
iar ORD-ul rămâne legat prin `source_alop_id`.

⛔ **Doar ramura ORD.** Ramura DF a clasei C rămâne **neatinsă**: `noua-lichidare` nu
golește `df_id`.
⛔ Clasele A, B, D, E, `CLASS_KEYS`, bucla de numărare, `lim`, semnătura funcției —
**neatinse**.
⛔ Nu redefini predicate. Nu atinge `flow-provenance.mjs`.

---

## ETAPA C — rulare

```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/flow-link-audit.test.mjs
npm test
npm run test:db
```

⚠️ Fișierul atins întâi, suita completă **o singură dată, la final**, pe **bază proaspătă**.
⚠️ **O singură rulare `test:db` pe instanță**, rezultat citit **din log**, numărul de fișiere
confruntat cu discul.
⚠️ `npm test` și `test:db` **secvențial**.
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica.

---

## ETAPA D — versiune, commit

```bash
npm version 3.9.853 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
git status --short
```
⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=` — lotul nu atinge `public/`.
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**

```
fix(#200): clasa C nu mai raporteaza ciclurile ORD arhivate ca divergente — v3.9.853

Cardul arata o divergenta pe ORD 42714. Interogat pe productie, ciclul 1 al
dosarului e arhivat in alop_ord_cicluri cu exact acel ord_id, status completed:
dosarul e sanatos. `noua-lichidare` arhiveaza ciclul si goleste alop.ord_id prin
proiectare, iar ORD-ul ramane legat prin source_alop_id.

Ramura ORD a clasei C nu verifica ciclurile arhivate, deci raporta fiecare dosar
care a trecut vreodata printr-o noua lichidare. Cardul e util doar cat timp zero
e normalul; unul care arata permanent altceva decat zero e ignorat, iar
divergenta reala trece neobservata.

Un NOT EXISTS scopat pe (alop_id, ord_id) exclude ciclurile arhivate ale
ACELUIASI dosar. Ramura DF ramane neatinsa: noua-lichidare nu goleste df_id.
Doua teste apara marginile — clasa isi pastreaza dintii cand nu exista niciun
ciclu, iar un ciclu al altui dosar nu mai acopera divergenta.

Zero reparatii de date: niciun rand atins.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0. ⭐ Ce coloane golește `noua-lichidare`, citite din cod.
   ⭐ Confirmarea că ramura ORD a clasei B cere `a.ord_id IS NOT NULL`.
2. ⭐⭐ Dovada că testul 1 pica pe codul vechi, cu mesajul de eșec.
3. Rezultatul fiecăruia dintre cele 6 cazuri, în special **2 și 3**.
4. `old_str` → `new_str`, cu confirmarea că ramura DF e neatinsă.
5. Confirmarea că `flow-link-audit.mjs` are în continuare **zero** `UPDATE/INSERT/DELETE`.
6. Numere reale `npm test` / `test:db`, secvențial, bază proaspătă, citite din log, cu
   numărul de fișiere confruntat cu discul.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale. ⭐ În special: mai există vreun detector din cele cinci clase care
    raportează o stare produsă **prin proiectare** de un flux normal al aplicației
    (`noua-lichidare`, revizuire DF, reinițiere după refuz, anulare administrativă)?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. **Zero scrieri în baza de date** — nici în lot, nici ca
  „reparație" a dosarului semnalat. Dosarul e sănătos.
- ⛔ Doar ramura **ORD** a clasei C. Ramura DF, clasele A/B/D/E — neatinse.
- ⛔ `NOT EXISTS` trebuie scopat pe **ambele** coloane (`alop_id` ȘI `ord_id`). Testul 3 e
  garda.
- ⛔ Testul 1 trebuie să pice pe codul vechi. Fără dovada asta, lotul nu e complet.
- ⛔ Fără reparare automată a pointerilor. Decizia #120(b) rămâne.
- **O singură rulare `test:db` pe instanță**, rezultat citit din log.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
