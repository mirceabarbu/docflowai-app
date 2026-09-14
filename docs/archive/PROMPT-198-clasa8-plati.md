---
prompt: 198
titlu: "Clasa 8 — coloana Plăți: proporția care nu se închide + filtrele care nu se aplică"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.850
versiune_tinta: v3.9.851
migratii: NU
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul — două defecte în același CTE, ambele invizibile azi

Coloana **Plăți** din Clasa 8 ia `plata_suma_efectiva` (ciclurile arhivate din
`alop_ord_cicluri` + ciclul curent din `alop_instances`) și o împrăștie pe coduri bugetare,
proporțional cu rândurile ORD.

⭐ **Semantica e stabilită și NU se discută în acest lot** (decizie Mircea, 11.09.2026):
Plăți = **ce s-a plătit efectiv**, nu ce s-a ordonanțat. Suma ordonanțată are coloana ei.
Măsurat pe producție: din 25 de cicluri plătite în 2026, unul singur diferă, cu **0,31 lei**.
⛔ Nu înlocui `plata_suma_efectiva` cu `suma_ordonantata_plata`. Nicăieri.

### Defectul 1 — proporția nu se închide

```sql
ord_totals:   ... FROM formulare_ord fo ... WHERE fo.org_id=$1 AND fo.deleted_at IS NULL
              -- numitorul: TOATE rândurile

ord_rows_ssi: ... WHERE ... AND cod_SSI <> '' AND suma > 0
              -- numărătorul: DOAR rândurile cu cod completat și sumă pozitivă
```

`plati` calculează `SUM(plata_suma * (row_amount / total_ord))`. Numitorul numără rânduri pe
care numărătorul le ignoră ⇒ dacă un ORD are fie și un singur rând **fără `cod_SSI`**, suma
proporțiilor iese **sub 1** și plata apare mai mică decât pe cardul ALOP. Tăcut, fără niciun
semnal.

Aceeași formă ca bugul OPME din 04.08: sub-numărare prin alocare pe indicatori.

**Măsurat azi pe producție: 0 ORD-uri afectate.** Deci corecția nu schimbă nicio cifră acum —
închide o capcană care se deschide în ziua în care cineva lasă un rând fără cod.

### Defectul 2 — filtrele nu ajung la plăți

`ordCompFilter` și `ordQFilter` se aplică la `angajamente` și `ordonantari`, dar **niciun**
CTE de plăți nu le primește. Filtrezi Clasa 8 pe compartiment: primele trei coloane scad,
Plăți rămâne totală. Cele patru coloane nu mai sunt comparabile între ele pe același ecran.

⚠️ Ăsta **se vede azi**, la orice filtrare.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                    # Așteptat: 3.9.850
grep -n "plati_sources\|ord_totals\|ord_rows_ssi\|plati AS" server/services/clasa8.mjs
grep -n "ordCompFilter\|ordQFilter" server/services/clasa8.mjs
grep -n "plati" server/services/clasa8.mjs | awk -F: '$1 > 320'
```

⭐ Ultima comandă trebuie să întoarcă **nimic**: a doua interogare (`getBugetDisponibil`,
verificarea de plafon) calculează doar `angajamente` + `buget`, **nu** plăți. Lotul atinge o
singură interogare. Dacă întoarce ceva, **oprește-te și raportează**.

---

## ETAPA A — testele ÎNTÂI

⛔ **Nu atinge `clasa8.mjs` până testele nu sunt scrise și nu PICĂ pe codul actual.**

Fișier nou `server/tests/db/clasa8-plati.test.mjs` (intră sub glob-ul `clasa8*`; fișierul
#127 și `clasa8-flux-mort.test.mjs` de la #197 rămân neatinse).

1. ⭐⭐ **Proporția.** ORD cu trei rânduri: două cu `cod_SSI` (100 + 100), unul **fără cod**
   (200). Ciclu cu `plata_suma_efectiva = 300`, plata confirmată.
   - Azi: numitorul e 400, deci plățile repartizate ies `300 × (100/400) × 2 = 150`.
     **Se pierd 150 din 300.**
   - Corect: numitorul e 200 ⇒ fiecare cod primește 150, total **300**.
   ⇒ Testul trebuie să **pice** pe codul actual. Pune în raport mesajul de eșec.
2. ⭐ **Suma pe coduri = suma plătită.** Pentru orice ORD cu cel puțin un rând cu cod,
   `SUM(plati)` pe toate codurile trebuie să fie **egală** cu `plata_suma_efectiva`.
   Ăsta e invariantul pe care-l apărăm — scrie-l explicit, nu doar pe cazul de mai sus.
3. **Anti-regresie — cazul normal.** ORD cu toate rândurile având `cod_SSI` (200 + 300),
   plată 500 ⇒ 200 și 300. Trebuie să treacă **și înainte, și după**. Ăsta apără situația
   reală din producție, unde azi sunt 0 ORD-uri afectate.
4. **Anti-regresie — două surse.** Un ciclu arhivat (`alop_ord_cicluri`) + ciclul curent
   (`alop_instances`), pe ORD-uri diferite ⇒ ambele contribuie, sumele se adună corect.
5. ⭐ **Filtrul de compartiment.** Două ORD-uri plătite, în compartimente diferite.
   Cu `compartiment` = al primului ⇒ Plăți conține doar plata primului.
   ⇒ Testul trebuie să **pice** pe codul actual (azi întoarce ambele).
6. **Filtrul de text (`q`).** Același tipar, pe `ordQFilter`.
7. **Fără filtru** ⇒ ambele ORD-uri contribuie. Anti-regresia pentru 5 și 6.
8. **Dosar anulat.** Ciclu arhivat al unui dosar cu `cancelled_at` setat.
   ⚠️ Măsurat pe producție: **0 cazuri**. Nu repara comportamentul în acest lot —
   scrie testul care **documentează** ce face azi și notează în raport care e. Decizia
   e a lui Mircea, separat.

---

## ETAPA B — corecțiile

### B.1 — numitorul numără exact ce numără numărătorul

În CTE-ul `ord_totals`, adaugă cele două condiții pe rând care există deja în `ord_rows_ssi`:

```sql
        AND COALESCE(r->>'cod_SSI', r->>'codSSI', '') <> ''
        AND NULLIF(r->>'suma_ordonantata_plata','')::numeric > 0
```

Comentariu deasupra: numitorul trebuie să acopere exact aceleași rânduri ca numărătorul,
altfel suma proporțiilor iese sub 1 și plata se pierde tăcut (#198).

⚠️ **Limitare cunoscută, de raportat, NU de reparat aici:** un ORD la care **niciun** rând
nu are `cod_SSI` nu contribuie la Plăți nici înainte, nici după — banii nu sunt atribuibili
niciunui cod bugetar. Comportamentul e neschimbat; notează-l la constatări.

### B.2 — filtrele ajung la plăți

Adaugă `${ordCompFilter}` și `${ordQFilter}` în `ord_totals` **și** în `ord_rows_ssi`.
Ambele CTE-uri folosesc deja aliasul `fo`, cerut de ambele fragmente.

⚠️ Parametrii sunt poziționali; același `$N` poate apărea de mai multe ori în interogare —
**nu** adăuga parametri noi și **nu** atinge `paramIdx` sau `params.push`.
⚠️ `ordQFilter` conține un `EXISTS (… jsonb_array_elements(…) r …)`, iar CTE-urile au deja un
`CROSS JOIN LATERAL … r`. Umbrirea e intenționată și funcționează deja identic în CTE-ul
`ordonantari` — nu redenumi nimic.

⛔ **Nu atinge** `plati_sources` (sursele de plată), formula din `plati`, `angajamente`,
`ordonantari`, `buget`, agregatele finale, sau a doua interogare.

---

## ETAPA C — rulare

```bash
npm test
npx vitest run --config vitest.config.db.mjs server/tests/db/clasa8-plati.test.mjs
npm run test:db
```

⚠️ Fișierul atins întâi, suita completă **o singură dată, la final**, pe **bază proaspătă**.
⚠️ **O singură rulare pe instanță.** Nu porni o a doua peste prima — la #197 două rulări
suprapuse au corupt baza și au produs cifre false. Rezultatul se citește **din log**, nu din
notificări de fundal, iar numărul de fișiere se confruntă cu discul.
⚠️ `npm test` și `test:db` **secvențial**.
Așteptat: **137** fișiere (136 + `clasa8-plati`).
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica.

---

## ETAPA D — versiune, commit

```bash
npm version 3.9.851 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
git status --short
```
⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=`.
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**

```
fix(#198): Clasa 8 — plata nu se mai pierde pe randuri fara cod_SSI — v3.9.851

Coloana Plati imprastie plata_suma_efectiva pe coduri bugetare, proportional cu
randurile ORD. Numitorul (ord_totals) numara TOATE randurile; numaratorul
(ord_rows_ssi) doar pe cele cu cod_SSI completat si suma pozitiva. Un singur rand
fara cod facea ca suma proportiilor sa iasa sub 1 — plata aparea mai mica decat
pe cardul ALOP, tacut. Aceeasi forma ca bugul OPME din 04.08.

Masurat pe productie inainte de corectie: 0 ORD-uri afectate. Nicio cifra nu se
schimba acum; se inchide capcana pentru prima data cand un rand ramane fara cod.
Un test apara invariantul: suma pe coduri = suma platita.

Separat, ordCompFilter si ordQFilter nu ajungeau la niciun CTE de plati. La
filtrarea pe compartiment primele trei coloane scadeau, Plati ramanea totala —
cele patru coloane nu mai erau comparabile. Acum filtrele se aplica si acolo.

Semantica ramane neschimbata (decizie Mircea, 11.09.2026): Plati = ce s-a platit
efectiv, nu ce s-a ordonantat; suma ordonantata are coloana ei.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0. ⭐ În special confirmarea că a doua interogare nu calculează plăți.
2. ⭐⭐ **Dovada că testele 1 și 5 picau pe codul vechi**, cu mesajele de eșec (ce sumă
   întorcea, ce trebuia).
3. Rezultatul fiecăruia dintre cele 8 cazuri, în special **3, 4 și 7** (anti-regresie).
4. ⭐ Ce face azi cazul 8 (dosar anulat) — comportamentul documentat, nu reparat.
5. `old_str` → `new_str` pentru ambele corecții.
6. Confirmarea că `plati_sources`, formula din `plati`, `paramIdx` și `params.push` au rămas
   **neatinse**.
7. Numere reale `npm test` / `test:db`, secvențial, pe bază proaspătă, **citite din log**,
   cu numărul de fișiere confruntat cu discul (așteptat 137).
8. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
9. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
10. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
11. Constatări colaterale. În special limitarea de la B.1 (ORD fără niciun `cod_SSI`) și
    orice alt loc unde un numitor și un numărător acoperă mulțimi diferite de rânduri.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero scrieri în baza de date.
- ⛔ **Testele înainte de corecție**, și trebuie să pice pe codul vechi.
- ⛔ `plata_suma_efectiva` rămâne sursa pentru Plăți. Nu o înlocui cu suma ordonanțată.
- ⛔ `plati_sources`, formula proporțională, `angajamente`, `ordonantari`, `buget`,
  agregatele finale, a doua interogare — **neatinse**.
- ⛔ Fără parametri noi, fără atingerea lui `paramIdx` / `params.push`.
- ⛔ Cazul „dosar anulat" se **documentează**, nu se repară în acest lot.
- **O singură rulare `test:db` pe instanță**, rezultat citit din log.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
