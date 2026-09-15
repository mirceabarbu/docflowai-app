---
prompt: 209
titlu: "Plăți în tranșe / din conturi diferite — acceptarea unei linii OPME, reluarea confirmării, confirmare manuală multi-OP"
model_suggested: "Fable 5.1"
efort: high
branch: develop
versiune_curenta: v3.9.861
versiune_tinta: v3.9.862
migratii: NU
scrieri_in_baza: DA — scrieri FINANCIARE (desface și reface o confirmare de plată) ⇒ `pg_dump` OBLIGATORIU înainte de deploy
fisiere_din_public: DA ⇒ `?v=` ȚINTIT + verificare `CACHE_VERSION`
zona_no_touch_atinsa: NU
tip: flux nou pe cale financiară
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

# ⚠️ DE CE E LOTUL CEL MAI RISCANT DIN SERIE

Toate loturile #202–#208 aveau proprietatea „nicio cifră nu se mișcă". **Ăsta o încalcă
deliberat**: desface o confirmare de plată și o reface. Sunt scrieri financiare pe documente
închise.

Regula care înlocuiește proprietatea veche: **nicio cifră nu se mișcă fără acțiunea explicită a
unui responsabil CAB, cu motiv scris și cu valorile vechi păstrate în audit.**

---

# CONTEXTUL — măsurat pe producție (15.09.2026)

Importul OPME din 03.09 a adus două ordine de plată către același furnizor (MORANI CONSTRUCT,
CIF 31306329), pe același angajament (cod `AAB3AE5XPX3`, indicator `AAB`), pentru ORD-ul cu
valoarea totală **20.891,04**:

```
OP 2791 — 19.164,51 → match_status='partial',   matched_alop_id SETAT, matched_at NULL
                       match_notes: „Plată parțială 19164.51 din 20891.04 RON"
OP 2792 —  1.726,53 → match_status='unmatched', matched_alop_id NULL
                       match_notes: „IBAN diferit față de ordonanțare (beneficiar și ...)"
```

19.164,51 + 1.726,53 = **20.891,04** — exact valoarea ORD-ului. Furnizorul a fost plătit din
două conturi. Matcher-ul a recunoscut corect situația, dar **nu are cale de finalizare**:
`_processAlop` confirmă doar când `actual === expected` (`opme-matcher.mjs:~494`), altfel intră
pe ramura `partial` și nu confirmă.

Utilizatorul a confirmat atunci **manual** OP 2792 (1.726,53). Dosarul apare plătit cu 1.726,53,
deși s-au virat 20.891,04.

**Amploarea:** 4 linii „IBAN diferit" (555.075,55 lei) + 8 linii „date insuficiente". Cele 163 de
linii `unmatched` în total sunt în majoritate (151 / 3,0 mil.) plăți din afara circuitului ALOP —
acelea sunt normale și **nu** ne interesează.

⭐ **Contabilitatea agregată e corectă.** Verificat: zero dosare unde plățile confirmate depășesc
`suma_totala_platita + plata_suma_efectiva`. Clasa 8 **nu** subevaluează. Lotul rezolvă o **gaură
de flux**, nu o eroare de calcul — nu porni de la premisa că repari cifre stricate.

---

# DECIZII DE PRODUS (luate, nu de renegociat)

| | |
|---|---|
| Cine poate accepta / relua | **Responsabilul CAB** — `isCabDept(actorComp, cabComp)`, exact poarta folosită în `alop.mjs:355`. Nu inventa alt criteriu. |
| Cele două căi | (A) acceptarea unei linii OPME respinse, când OP-ul e deja în platformă din import; (B) confirmare manuală cu **listă de OP-uri și sumă totală**, când OP-urile nu sunt în platformă. |
| Dosare deja confirmate greșit | Se repară prin **reluarea confirmării** — în acest lot. |

---

# ETAPA 0 — ancore

```bash
grep -n "applyPlataConfirmedSideEffects" server/routes/alop.mjs server/services/opme-matcher.mjs
grep -n "AND plata_confirmed_at IS NULL" server/routes/alop.mjs
# ⭐ Garda care face ca o a doua confirmare să nu aibă efect. O păstrăm.

grep -n "tryAutoConfirmAlop\|_bulkMarkMatched\|_processAlop" server/services/opme-matcher.mjs | head
grep -n "export" server/services/opme-matcher.mjs | head
# Ce e exportat azi? Dacă tryAutoConfirmAlop nu e exportat, RAPORTEAZĂ.

grep -n "isCabDept\|loadActorCompAndCab\|loadOrgCabComp" server/routes/alop.mjs | head
grep -n "match_status" server/db/index.mjs | head -5
# ⭐ Ce valori sunt permise pe match_status? Există CHECK constraint?
#    'manual' apare în opme-report-drawer.js:112 ca status recunoscut de UI.

grep -n "opme-report-drawer.js?v=\|opme" public/*.html | head
grep -c "opme-report-drawer" public/sw.js
# ⚠️ La #207 presupunerea că fișierele nu sunt în PRECACHE s-a dovedit GREȘITĂ. Verifică.
```

⛔ Dacă `match_status` are `CHECK` care nu include `'manual'`, **oprește-te și raportează** —
adăugarea unei valori ar cere migrare, iar lotul e declarat fără migrări.

---

# ETAPA A — acceptarea unei linii OPME (calea A)

`POST /api/opme/lines/:id/accept`, în `server/routes/opme.mjs`, cu `csrfMiddleware`.

**Corp:** `{ alopId, motiv }`. `motiv` **obligatoriu**, minim 10 caractere — e justificarea scrisă
a unei decizii financiare („verificat extrasul, IBAN secundar al aceluiași furnizor").

**Pași, într-o singură tranzacție:**

1. `SELECT ... FOR UPDATE` pe linia OPME și pe ALOP.
2. Poarta: `isCabDept(actorComp, cabComp)`. Altfel **403 `doar_responsabil_cab`**.
3. ⭐ Acceptă **doar** linii cu `match_status IN ('unmatched','partial','ambiguous')`. O linie
   `matched` deja procesată ⇒ **409 `deja_potrivita`**.
4. ⭐ Verifică `org_id` al liniei == `org_id` al ALOP-ului == `org_id` al actorului. Altfel **404**.
   (Fără asta, o linie dintr-o organizație s-ar putea lega de dosarul alteia.)
5. `UPDATE opme_lines SET match_status='manual', matched_at=NOW(), matched_alop_id=$alopId,
   match_notes = <motiv, cu prefix „Acceptat manual de <email>: ">`.
   ⚠️ **Nu șterge nota veche** — concatenează. Motivul respingerii inițiale e informație de audit.
6. Audit `opme_line_accepted_manual` cu: `line_id`, `alop_id`, `nr_op`, `suma_op`,
   `match_status` **vechi**, nota **veche**, motivul, actorul.
7. **Cheamă matcher-ul** pe acel ALOP (`tryAutoConfirmAlop`), în **aceeași tranzacție**, pasând
   clientul — nu deschide o conexiune nouă.

⭐ **Pasul 7 e miezul lotului.** Cu linia acceptată, `actual` devine 20.891,04 = `expected`, iar
ramura de la `opme-matcher.mjs:~494` confirmă singură, cu suma totală, lista completă de OP-uri
în `plata_nr_ordin`, audit și tot restul. **Zero logică nouă de confirmare.**

8. Răspunsul întoarce rezultatul matcher-ului (`matched` / `partial` / `already_confirmed` /
   `overpay`), ca UI-ul să poată spune ce s-a întâmplat. ⚠️ `already_confirmed` e un **răspuns
   legitim**, nu eroare: înseamnă că dosarul are deja o plată confirmată și trebuie mai întâi
   reluată (Etapa B).

---

# ⭐ ETAPA B — reluarea confirmării plății (partea cea mai delicată)

`POST /api/alop/:id/plata/reia`, cu `csrfMiddleware`. **Corp:** `{ motiv }` obligatoriu, min. 10
caractere.

Desface confirmarea existentă ca matcher-ul s-o poată reface corect.

**Gărzi, toate obligatorii:**

1. `SELECT ... FOR UPDATE` pe ALOP.
2. `isCabDept`. Altfel **403**.
3. ⭐ **Doar dacă `plata_confirmed_at IS NOT NULL`.** Altfel **409 `nu_e_confirmata`**.
4. ⭐⭐ **Doar dacă dosarul e în ciclul curent și NU a avansat.** Dacă `ciclu_curent` s-a
   incrementat față de momentul confirmării, sau există cicluri arhivate ulterioare, **refuză cu
   409 `ciclu_avansat`**. Reluarea unei plăți dintr-un ciclu închis ar corupe
   `suma_totala_platita` și istoricul. **Nu improviza o soluție — refuză.**
5. ⭐ **`suma_totala_platita` NU se atinge.** Ea ține ciclurile arhivate; reluarea privește
   exclusiv ciclul curent.

**Ce face:**

```sql
UPDATE alop_instances SET
  plata_confirmed_by = NULL, plata_confirmed_at = NULL,
  plata_nr_ordin = NULL, plata_data = NULL,
  plata_suma_efectiva = NULL, plata_observatii = NULL, plata_notes = NULL,
  plata_source = 'manual',
  status = 'plata', completed_at = NULL,
  updated_at = NOW(), updated_by = $actor
WHERE id = $1 AND org_id = $2
  AND plata_confirmed_at IS NOT NULL
RETURNING *
```

⚠️ Coloanele de mai sus sunt **cele resetate la avansarea de ciclu** (`alop.mjs:~2062`). Citește
acel `UPDATE` și **oglindește exact aceeași listă**, minus `suma_totala_platita`, `ciclu_curent`,
`ord_id` și câmpurile de lichidare — pe acelea **nu** le atingem. Dacă lista diferă, raportează.

6. ⭐ **Audit `plata_confirmare_reluata`, cu TOATE valorile vechi**: `plata_nr_ordin`,
   `plata_suma_efectiva`, `plata_data`, `plata_source`, `plata_confirmed_by`,
   `plata_confirmed_at`, `status` vechi, plus motivul și actorul. Dacă se pierde ceva, trebuie să
   se poată reconstrui din audit.
7. ⚠️ Liniile OPME deja `matched` pe acest ALOP **rămân** `matched`. Reluarea desface confirmarea
   de pe ALOP, nu potrivirile. Matcher-ul le va reagrega.
8. Opțional, dacă răspunsul cere: recheamă matcher-ul imediat după, în aceeași tranzacție.
   Raportează dacă ai făcut-o și de ce.

---

# ETAPA C — confirmarea manuală cu listă de OP-uri (calea B)

Confirmarea manuală existentă acceptă **un** număr de OP. `plata_nr_ordin` e `text` și ține deja
liste — la ORD 3985 conține literal `"2745, 2746, 2747, 2742, ..."`, scris de matcher. Formatul e
suportat; **doar interfața nu-l oferă**.

**Server:** validare pe `nr_ordin_plata` — acceptă numere separate prin virgulă, normalizează
spațiile, refuză caractere în afara cifrelor, virgulelor și spațiilor.

**Frontend:** câmpul acceptă mai multe numere, cu ajutor vizibil („separate prin virgulă").

⭐ **Verificare de sumă, neblocantă:** dacă suma introdusă diferă de valoarea totală a ORD-ului,
afișează diferența explicit („Suma introdusă e cu X lei sub valoarea ORD-ului de Y"). **Nu
bloca** — plățile parțiale sunt legitime, iar un blocaj ar reproduce exact problema pe care o
rezolvăm. Informează, nu împiedica.

---

# ETAPA D — interfața

`public/js/components/opme-report-drawer.js` are deja cardurile și filtrul „Probleme".

Pe rândurile cu `match_status IN ('unmatched','partial','ambiguous')`, **doar pentru responsabil
CAB**, un buton „Acceptă potrivirea" care deschide un mic dialog:
- selectorul dosarului ALOP (pre-completat cu `matched_alop_id` când există, ca la `partial`)
- câmp **motiv**, obligatoriu
- avertisment vizibil: acceptarea confirmă că plata a fost verificată în extras

După răspuns, arată ce a decis matcher-ul: dosar închis, rămas parțial, sau **„dosarul are deja o
plată confirmată — reia confirmarea întâi"**, cu legătură către acțiunea din Etapa B.

⚠️ Dreptul se ia de la server (un câmp în răspunsul rutei de raport), **nu** se deduce în
frontend. Butonul nu apare dacă serverul nu confirmă dreptul.

Pentru Etapa B, acțiunea stă pe ecranul ALOP, lângă plata confirmată, cu text explicit
(„Reia confirmarea plății") și confirmare cu motiv.

---

# ETAPA E — teste

## E.1 — `server/tests/db/opme-accept-linie.test.mjs` (nou)

1. ⭐ **Scenariul 8836 reprodus**: ORD 20.891,04; linie A 19.164,51 `partial` cu `matched_alop_id`;
   linie B 1.726,53 `unmatched`. CAB acceptă linia B ⇒ matcher-ul confirmă cu
   **`plata_suma_efectiva = 20.891,04`**, `plata_nr_ordin` conține **ambele** numere, status
   `completed`.
2. ⭐ Non-CAB ⇒ **403 `doar_responsabil_cab`**, zero scrieri.
3. Linie deja `matched` ⇒ **409 `deja_potrivita`**.
4. ⭐ Linie din **altă organizație** ⇒ **404**, zero scrieri.
5. `motiv` lipsă sau sub 10 caractere ⇒ **400**, zero scrieri.
6. ⭐ Nota veche **se păstrează** în `match_notes` alături de motiv.
7. Acceptare care nu completează suma (rămâne parțial) ⇒ linia devine `manual`, dosarul **nu** se
   confirmă, răspunsul spune `partial`.

## E.2 — `server/tests/db/plata-reia-confirmare.test.mjs` (nou)

8. ⭐ ALOP confirmat ⇒ reluare de către CAB ⇒ câmpurile de plată golite, `status='plata'`,
   `completed_at` NULL, **`suma_totala_platita` NEATINSĂ**.
9. ⭐ Auditul conține **toate** valorile vechi (numărul de OP, suma, data, sursa, confirmatorul).
10. ⭐⭐ ALOP cu **ciclu avansat** ⇒ **409 `ciclu_avansat`**, zero scrieri. Testul care apără
    istoricul.
11. ALOP neconfirmat ⇒ **409 `nu_e_confirmata`**.
12. Non-CAB ⇒ 403.
13. ⭐ **Cap-coadă**: 8836 confirmat greșit cu 1.726,53 → reluare → acceptarea liniei A →
    matcher ⇒ `plata_suma_efectiva = 20.891,04`, ambele OP-uri în `plata_nr_ordin`.
14. Liniile OPME `matched` rămân `matched` după reluare.

## E.3 — `npm test`

15. Validarea listei de OP-uri: `"2791, 2792"` acceptat; `"2791;2792"`, `"abc"`, `""` respinse.
16. Calculul diferenței de sumă (neblocant).

## E.4

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.**

---

# ETAPA F — versiune, cache, commit

```bash
npm version 3.9.862 --no-git-tag-version
npm install --package-lock-only
git status --short
```

`?v=` **țintit**. `CACHE_VERSION` doar dacă un fișier din `PRECACHE_ASSETS` s-a schimbat —
verifică prin grep și raportează dovada. `git add` explicit. Arhivează promptul în `docs/archive/`.

```
feat(#209): plati in transe / din conturi diferite — acceptare linie OPME, reluarea
confirmarii, confirmare manuala multi-OP — v3.9.862

Incident productie: furnizor platit din doua conturi (OP 2791 19.164,51 +
OP 2792 1.726,53 = 20.891,04, exact valoarea ORD). Matcher-ul a recunoscut
corect („Plata partiala 19164.51 din 20891.04"), dar confirma DOAR cand
actual === expected, deci nu avea cale de finalizare. Utilizatorul a confirmat
manual doar al doilea OP; dosarul aparea platit cu 1.726,53.

Contabilitatea agregata era CORECTA (zero dosare cu plati confirmate peste
suma_totala_platita + plata_suma_efectiva). Lotul repara o gaura de FLUX.

A) POST /api/opme/lines/:id/accept — responsabilul CAB accepta o linie
   unmatched/partial cu motiv scris; linia devine 'manual' si se recheama
   matcher-ul, care confirma singur cu suma si lista completa de OP-uri.
   Zero logica noua de confirmare.
B) POST /api/alop/:id/plata/reia — desface o confirmare gresita (doar in ciclul
   curent, niciodata pe ciclu avansat), cu toate valorile vechi in audit.
   suma_totala_platita NU se atinge.
C) Confirmarea manuala accepta lista de OP-uri; plata_nr_ordin tinea deja liste
   (matcher-ul scrie „2745, 2746, ..."), doar UI-ul nu o oferea.

Poarta: isCabDept, aceeasi ca in alop.mjs:355. Dreptul vine de la server.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**. ⭐ În special: `CHECK` pe `match_status` și ce e
   exportat din `opme-matcher.mjs`.
2. Cum ai pasat clientul de tranzacție în matcher fără a deschide conexiune nouă.
3. ⭐ Lista exactă de coloane resetate la Etapa B, comparată cu `UPDATE`-ul de avansare de ciclu.
4. ⭐ Cum ai detectat „ciclu avansat" și de ce criteriul e sigur.
5. Rezultatul fiecărui test, **în special 1, 4, 8, 10, 13**.
6. Ce întoarce ruta când matcher-ul zice `already_confirmed`.
7. Teste preexistente atinse.
8. Decizia `CACHE_VERSION` + dovada + lista `?v=`.
9. Numere reale, secvențial, cu sursa verdictului declarată.
10. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
11. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy. **`pg_dump` înainte de deploy — obligatoriu.**
- **`suma_totala_platita` NU se atinge niciodată** în Etapa B.
- **Reluare pe ciclu avansat: REFUZ**, nu improvizație.
- `motiv` obligatoriu pe ambele acțiuni. Fără motiv, fără scriere.
- Nota veche din `match_notes` se **păstrează**, nu se suprascrie.
- Garda `AND plata_confirmed_at IS NULL` din `applyPlataConfirmedSideEffects`: **NEATINSĂ**.
- Verificarea de sumă la Etapa C: **informează, nu bloca**.
- Dreptul CAB vine de la **server**, `isCabDept`, nu dedus în frontend.
- `_processAlop`, `_potrivireBloc`, `profiluriBlocuri`: **NEATINSE**. Lotul le cheamă, nu le
  modifică.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
