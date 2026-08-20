# PROMPT #128d — `opme-matcher` devine conștient de blocuri (un ORD, N beneficiari)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus — atinge confirmarea automată a plăților
**Target versiune:** `v3.9.764` (de la 3.9.763 — **citește `package.json`**)
**Migrații:** ZERO · **Fișiere din `public/`:** ZERO

---

## 1. De ce lotul ăsta s-a micșorat (și de ce restul e deja gata)

Reconul estima ~15 agregări de reparat. Verificat pe cod după #128c: sub varianta (A) rândurile
rămân o listă **PLATĂ** cu `bloc_idx` pe fiecare rând, deci:

- cele 15 `SUM(...)` peste `o.rows` continuă să dea **valoarea totală a ORD-ului** — corect,
  neschimbat, **nu se atinge nimic**;
- `expected` din `_processAlop` (suma tuturor rândurilor ORD) rămâne corect ca definiție: un ORD
  cu N blocuri e plătit integral când suma TUTUROR OP-urilor egalează valoarea TOTALĂ;
- `deriveOrdIdentityCols` corelează pozițional rândul *i* cu `rows_ctrl[i]` — valabil identic
  peste blocuri, fiindcă lista nu se imbrichează. **Nu se atinge.**

Rămâne un singur consumator care presupune **un singur beneficiar per ORD**:
`server/services/opme-matcher.mjs`. Acolo, `cif_beneficiar` și `iban_beneficiar` se citesc ca
niște coloane plate unice, iar tripletele se iau din TOATE rândurile ORD-ului, indiferent de bloc.
Cu blocuri multiple asta produce **sub-numărare tăcută** — exact clasa de bug de la #115.

⛔ **Nu extinde lotul.** Dacă în timpul lucrului găsești alte locuri care par să presupună un
singur beneficiar, **raportează-le, nu le repara** — le programăm separat.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/routes/formulare/df.mjs`, `formulare_df`
⛔ `server/routes/formulare/ord.mjs` — scrierea e gata din #128c
⛔ `server/services/formular-shared.mjs` (`deriveOrdIdentityCols`) — vezi §1
⛔ `server/routes/alop.mjs`, `server/services/clasa8.mjs` — agregările rămân neschimbate
⛔ orice fișier din `public/`
⛔ **Modelul tranzacțional și de confirmare NU se schimbă:** `FOR UPDATE` pe ALOP, tranzacție
   scurtă per grup, `(c1) actual === expected → confirmă o singură dată`, `(c2)/(c3) → partial`,
   `plata_source='opme_auto'`, garda `plata_confirmed_at IS NULL`. Doar SELECȚIA liniilor devine
   conștientă de bloc.

---

## 3. Etapa A — un profil per bloc, în modulul pur

În `server/services/ord-blocuri.mjs`, o funcție nouă exportată, pură:

```js
profiluriBlocuri(ord) → [ { bloc_idx, cif, iban, triplete: Set<'cod||ind'> }, ... ]
```

- blocurile se obțin prin `blocuriDinOrd(ord)` (deci un ORD legacy dă exact un profil, din
  coloanele plate — retrocompatibil prin construcție);
- `cif` și `iban` se iau din bloc, **trimuite**;
- `triplete` se construiește DOAR din rândurile blocului, prin `randuriBloc(ord.rows, bloc_idx)`,
  păstrând regula existentă: se adaugă `cod||ind` doar când AMBELE sunt nevide după `trim()`;
- un profil fără `cif` sau cu `triplete` goale se întoarce oricum — filtrarea o face apelantul,
  ca să poată raporta motivul.

⛔ Nu duplica `_ibanVerdict` aici. Rămâne în `opme-matcher.mjs`, un singur loc, exact cum cere
comentariul de la `:67` — profilul livrează IBAN-ul brut, verdictul îl dă tot helperul existent.

---

## 4. Etapa B — `_processAlop` agregă pe blocuri

Fișier: `server/services/opme-matcher.mjs`.

### B.1 Citirea ORD-ului (~:352)

Adaugă `o.blocuri` în `SELECT`, apoi construiește `const profile = profiluriBlocuri({ blocuri, rows: ord_rows, cif_beneficiar, iban_beneficiar })`.

Condiția existentă de ieșire (`tripSet.size === 0 || !cif` → `no_triplets`) devine: **niciun**
profil nu are și `cif`, și triplete. Codul de rezultat rămâne `'no_triplets'` — ⛔ nu inventa
coduri noi, sunt consumate de raport și de teste.

### B.2 `expected` (~:374) — NESCHIMBAT

Rămâne suma peste TOATE rândurile ORD-ului. Un ORD cu N blocuri se consideră plătit integral când
toate OP-urile lui, de la toți beneficiarii, însumează valoarea totală. Ăsta e modelul de produs;
⛔ nu-l schimba în „per bloc" fără decizie explicită de la Mircea.

### B.3 Bazinul de linii (~:388)

`TRIM(cif_beneficiar) = $2` devine `TRIM(cif_beneficiar) = ANY($2)`, cu array-ul CIF-urilor
DISTINCTE din profile. Restul filtrelor (`org_id`, `match_status IN (...)`,
`matched_alop_id IS NULL OR = $3`) rămân identice.

### B.4 Bucla de potrivire (~:401)

O linie se acceptă dacă **există un profil** pentru care, simultan:
`profil.cif === TRIM(linie.cif_beneficiar)`, `profil.triplete.has('cod||ind')`, iar
`_ibanVerdict(profil.iban, linie.iban_beneficiar) !== 'mismatch'`.

- prima potrivire câștigă (blocurile sunt disjuncte pe `(cif, triplet)` în practică);
- dacă verdictul e `'no_iban'`, păstrează logarea existentă `opme.match.candidate.no_iban`,
  adăugând `bloc_idx` în payload;
- ⛔ un `mismatch` pe un bloc **nu** respinge linia global — se încearcă blocul următor. Asta e
  singura schimbare semantică față de azi, și e cerută: un ORD cu doi beneficiari are două
  IBAN-uri, iar linia trebuie comparată cu al ei.

---

## 5. Etapa C — selecția candidaților în `matchImport` (~:146)

Aici SQL-ul cere azi `TRIM(o.cif_beneficiar) = $2` plus un `EXISTS` peste **toate** rândurile.

**Nu muta regula în SQL peste JSONB.** Folosește tiparul deja stabilit și motivat în fișier la
`#126 C` (comentariul de la `:160`): **SQL-ul selectează un SUPRASET, iar regula autoritară se
aplică în JS prin ACELAȘI helper** — altfel o linie s-ar potrivi la selecție dar nu s-ar agrega la
sumă, exact bugul de la #115.

Concret:

1. SQL-ul lărgește condiția de CIF ca să prindă și blocurile:
   `(TRIM(o.cif_beneficiar) = $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.blocuri,'[]'::jsonb)) b WHERE TRIM(b->>'cif_beneficiar') = $2))`
   iar `EXISTS`-ul pe rânduri rămâne pe toate rândurile (superset deliberat).
2. Imediat după, în JS, filtrează candidații cu `profiluriBlocuri` + verdictul IBAN existent:
   un candidat rămâne doar dacă are un bloc cu acel `cif`, cu tripletul cerut și cu IBAN
   necontradictoriu.
3. Contorii `ibanRespinse` / `ibanNedeclarat` și mesajele de `unmatched`/`ambiguous` rămân în
   forma actuală — sunt citite de UI și de teste.

⚠️ Trebuie să adaugi `o.blocuri` în `SELECT`-ul candidaților ca filtrul JS să aibă ce citi.

### C.1 `tryAutoConfirmAlop` (~:273)

`!alop.cif_beneficiar → 'ord_missing'` devine: niciun profil nu are `cif`. Adaugă `o.blocuri` în
`SELECT`. Verificarea „are cel puțin un triplet valid" (~:300) se face pe profile, nu pe lista
plată. Codurile de rezultat rămân neschimbate.

---

## 6. Etapa D — teste (Postgres real)

Fișier nou `server/tests/db/opme-matcher-blocuri.test.mjs`, oglindind montarea și helperii testelor
OPME existente. ⛔ Testele importă codul real.

1. ⭐ **NON-REGRESIE, cel mai important:** ORD legacy (`blocuri` NULL, un beneficiar) cu liniile
   OPME de azi → potrivire, agregare și confirmare **identice** cu înainte de patch. Dacă apare
   orice diferență, patch-ul e greșit, nu testul.
2. ⭐ **Două blocuri, doi furnizori, plată completă:** ORD cu blocul 0 (CIF A, 100 lei, triplet T1)
   și blocul 1 (CIF B, 220 lei, triplet T2); două linii OPME, una per furnizor →
   `actual === expected === 320` ⇒ ALOP **confirmat o singură dată**, cu suma totală.
3. **Plată parțială pe multi-bloc:** sosește doar linia furnizorului A → `partial`, ALOP rămâne în
   `plata`, `plata_confirmed_at` NULL.
4. **IBAN per bloc:** linia furnizorului B are IBAN-ul blocului 1 → se acceptă, DEȘI nu se
   potrivește cu IBAN-ul blocului 0. Ăsta e testul care apără schimbarea semantică de la §4.4.
5. **IBAN greșit:** linia furnizorului B cu un IBAN care nu e al niciunui bloc → respinsă,
   contorul `ibanRespinse` incrementat.
6. **Triplet dintr-un bloc, CIF din altul** (combinație inexistentă) → linia NU se potrivește.
   Apără disjuncția: fără el, o potrivire încrucișată ar trece neobservată.
7. **`ambiguous` neschimbat:** două ALOP-uri distincte, ambele în `plata`, cu același CIF și
   același triplet → linia rămâne `ambiguous`, cu mesajul de azi.
8. **Bloc fără CIF** (document incomplet) → profilul e ignorat, restul blocurilor funcționează.

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed". `test:db` e obligatoriu — e singura suită care rulează matcher-ul real.

Bump la `3.9.764`; commit pe `develop`:
`feat(#128d): opme-matcher conștient de blocuri — potrivire per (cif, iban, triplete) de bloc`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -n "profiluriBlocuri" server/services/opme-matcher.mjs
# Așteptat: 1 import + apeluri în _processAlop, matchImport și tryAutoConfirmAlop

grep -c "_ibanVerdict" server/services/opme-matcher.mjs
# Așteptat: NESCHIMBAT față de înainte (funcția rămâne definită și apelată într-un singur helper)

grep -rn "cif_beneficiar" server/services/opme-matcher.mjs | grep -v "b->>'cif_beneficiar'"
# Așteptat: nicio citire a coloanei PLATE ca sursă unică de adevăr în logica de potrivire

grep -rn "blocuri" server/routes/alop.mjs server/services/clasa8.mjs server/services/formular-shared.mjs
# Așteptat: 0 rezultate — agregările și derivarea rămân neatinse

git status --short
# Așteptat: package.json, opme-matcher.mjs, ord-blocuri.mjs, testul nou. Nimic din public/.
```

---

## 9. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 2 și 4** menționate separat — sunt acceptanța lotului
- confirmarea explicită că modelul de confirmare (`expected` = total ORD, confirmare unică,
  `FOR UPDATE`, coduri de rezultat) e **neschimbat**
- orice alt loc găsit care presupune un singur beneficiar per ORD — **raportat, nu reparat**
- orice test preexistent modificat, cu motivul
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
