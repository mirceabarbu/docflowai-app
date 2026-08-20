# PROMPT #128e — export XML, PDF și validare pe N blocuri

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus — atinge exportul către trezorerie și documentul oficial
**Target versiune:** `v3.9.765` (de la 3.9.764 — **citește `package.json`**)
**Migrații:** ZERO · **Fișiere din `public/`:** ZERO

---

## 1. De ce lotul ăsta vine ÎNAINTEA frontendului

Planul inițial punea frontendul înaintea PDF/XML. **A fost reordonat deliberat.** Frontendul e
exact ce permite crearea primului ORD cu două blocuri; dacă exportul nu e pregătit până atunci,
acel document produce un XML către Forexebug care conține **tăcut doar blocul 1** (oglinda
coloanelor plate). Un fișier trimis la trezorerie cu jumătate din beneficiari e mai grav decât
orice bug reparat în ultima săptămână.

Regula seriei rămâne: **nimeni nu poate crea un al doilea bloc până când tot lanțul din spate nu
îl duce corect.** Frontendul devine #128f, ultimul.

Cele trei locuri, raportate de agent la #128d și neatinse atunci:

| Fișier | Problema |
|---|---|
| `server/services/alop-xml/ord-to-xsd.mjs` | construiește UN `docFd` din coloanele plate |
| `server/routes/formulare.mjs` — `buildOrdnt` (~:835) | PDF-ul randează un singur beneficiar |
| `server/routes/formulare.mjs` — `validateOrdnt` (~:50) | validează un singur `docFd` |

**Fapt care ieftinește lotul:** `serializeOrdnt` (`ordnt-serializer.mjs:81`) normalizează DEJA
`docFd` la array și emite un bloc `DocFd` per element. ⛔ **Nu-l atinge** — e gata.

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/services/alop-xml/ordnt-serializer.mjs` — deja suportă array
⛔ `server/services/alop-xml/notafd-serializer.mjs` și `df-to-xsd.mjs` — DF-ul e mono-bloc
⛔ `server/routes/formulare/ord.mjs`, `opme-matcher.mjs` — gata din #128c/#128d
⛔ orice fișier din `public/` — frontendul e #128f
⛔ **Nu adăuga validări noi obligatorii.** MF cere per bloc și `documente_justificative` și
   `inf_pv_plata`; noi cerem azi doar `beneficiar`, `iban_beneficiar`, `cif_beneficiar`. Paritatea
   se păstrează EXACT — documente aflate în lucru chiar acum în producție ar fi respinse altfel.
   Alinierea la MF e decizie separată.

---

## 3. Criteriul de acceptanță al întregului lot

**Pentru un ORD cu UN SINGUR bloc — adică tot ce există azi în producție — XML-ul generat,
PDF-ul generat și lista de erori de validare trebuie să fie IDENTICE cu cele de dinainte de
patch.** Fără antet nou, fără prefix la mesajele de eroare, fără spațiere schimbată în PDF.
Dacă un test arată o diferență la un singur bloc, patch-ul e greșit, nu testul.

---

## 4. Etapa A — `ordRowToXsd` emite un array

Fișier: `server/services/alop-xml/ord-to-xsd.mjs`.

`docFd` devine un **array**, câte un element per bloc:

- blocurile vin din `blocuriDinOrd(row)` (import din `../ord-blocuri.mjs`) — un ORD legacy cu
  `blocuri` NULL dă exact un bloc, derivat din coloanele plate, deci ieșirea rămâne identică;
- cheile fiecărui element rămân EXACT cele de azi (`nr_unic_inreg`, `beneficiar`,
  `documente_justificative`, `iban_beneficiar`, `cif_beneficiar`, `banca_beneficiar`,
  `inf_pv_plata`, `inf_pv_plata1`, `rowTfd`), cu același `?? ''`;
- `rowTfd` al blocului *k* = `randuriBloc(row.rows, k)` — **nu** toate rândurile.

⚠️ Actualizează și comentariul de antet: azi spune că `docFd` e un obiect. Un comentariu care
descrie altceva decât face codul e cum am pierdut o zi la `reinitiatedAs`.

⚠️ `server/tests/unit/alop-xml-ord-to-xsd.test.mjs` există și verifică echivalența cu `colO()`.
Va cere actualizare — actualizează **forma** aserțiunilor (obiect → array cu un element), ⛔ nu
slăbi verificarea de echivalență a cheilor.

---

## 5. Etapa B — `validateOrdnt` validează fiecare bloc

Fișier: `server/routes/formulare.mjs` (~:50).

- normalizează la început: `const docs = Array.isArray(d.docFd) ? d.docFd : [d.docFd || {}];`
  (același tipar ca serializatorul — ⛔ nu inventa altul);
- validările existente pe bloc se aplică **fiecărui** element, în ordine;
- ⭐ **mesajele:** când există **un singur** bloc, textele rămân **byte-identice** cu azi
  (`'beneficiar obligatoriu'`, …). Când sunt mai multe, fiecare mesaj se prefixează cu
  `` `blocul ${i + 1}: ` ``, ca utilizatorul să știe care bloc e incomplet. Ăsta e singurul loc
  din lot unde mesajele se schimbă, și numai pe o cale care azi nu poate fi atinsă;
- validările de root (`Cif`, `DenInstPb`, `NrOrdonantPl`, `DataOrdontPl`) rămân o singură dată;
- dacă `docs` e gol → o eroare nouă `'Cel putin un bloc docFd obligatoriu'`. Nu se poate produce
  azi, dar e fail-closed corect.

---

## 6. Etapa C — PDF-ul randează N blocuri

Fișier: `server/routes/formulare.mjs`, `buildOrdnt` (~:835).

Corpul actual (nr unic → tabel → Beneficiar → Documente justificative → CIF → IBAN/Bancă →
Informații plată) devine corpul unui **bloc**, apelat în buclă peste `docs`, normalizat identic
ca la §5.

**Reguli de randare, respectă-le exact:**

- **un singur bloc ⇒ ieșire byte-identică** cu azi: fără antet, fără separator, fără spațiu în
  plus. Verificabil: generează același ORD înainte și după patch și compară dimensiunea și
  numărul de pagini;
- **mai multe blocuri ⇒** înaintea fiecăruia, de la al doilea încolo, un titlu discret pe un rând
  (`Beneficiar 2 din 3`, cu `fB`, size 8.5, urmat de `LH`), plus mecanismul `ensureY` existent
  ca blocul să nu fie tăiat prost de o pagină nouă. ⛔ Nu introduce `addPage()` forțat per bloc —
  formularul MF nu paginează per bloc, iar o pagină nouă pe fiecare beneficiar ar umfla documentul;
- fiecare bloc își randează PROPRIILE rânduri (`rowTfd`-ul lui), cu propriul rând de totaluri —
  `drawTable(..., { totals: true })` rămâne apelat per bloc. ⛔ Nu construi un total general peste
  blocuri: nu există în formularul oficial;
- ⛔ Nu schimba nicio lățime de coloană, niciun `numLabel`, niciun text de antet.

---

## 7. Etapa D — teste

**D.1 unitare** — extinde `server/tests/unit/alop-xml-ord-to-xsd.test.mjs`:

1. ⭐ ORD legacy (`blocuri` NULL) → `docFd` e array cu **un** element, cu conținut identic cu
   obiectul produs înainte de patch (comparat cheie cu cheie);
2. ORD cu 2 blocuri → 2 elemente, fiecare cu beneficiarul lui și cu **doar** rândurile lui în
   `rowTfd` (verifică `bloc_idx`-urile, nu doar lungimile);
3. rânduri fără `bloc_idx` + `blocuri` cu 2 elemente → toate cad pe blocul 0, blocul 1 are
   `rowTfd` gol (regula din `randuriBloc`).

**D.2 XML** — un test care trece rezultatul prin `serializeOrdnt` și verifică:

4. ⭐ un bloc → XML **identic** cu cel de dinainte de patch (string comparat exact);
5. două blocuri → **două** elemente `DocFd` în XML, fiecare cu `beneficiar`/`cif_beneficiar`/
   `iban_beneficiar` proprii, iar rezultatul trece validarea XSD prin calea existentă din suită.

**D.3 validare** — extinde testele existente pe `validateOrdnt`:

6. ⭐ un bloc, câmp lipsă → mesaj **fără** prefix, byte-identic cu azi;
7. două blocuri, al doilea fără CIF → mesajul are prefixul `blocul 2: `, iar primul bloc nu
   generează erori;
8. `docFd` gol → `'Cel putin un bloc docFd obligatoriu'`.

**D.4 PDF** — dacă suita are deja un test care generează PDF-ul ORD, extinde-l cu un caz pe două
blocuri (asertează că generarea nu aruncă și că numărul de pagini e ≥ cel de la un bloc). Dacă
NU există, ⛔ nu construi o schelă nouă de test PDF pentru atât — spune-o în raport.

---

## 8. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.765`; commit pe `develop`:
`feat(#128e): export XML, PDF și validare ORD pe N blocuri (docFd devine array)`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 9. Verificări de ieșire (verbatim în raport)

```bash
grep -n "docFd" server/services/alop-xml/ord-to-xsd.mjs
# Așteptat: docFd construit ca ARRAY (map peste blocuri)

grep -n "Array.isArray(d.docFd)\|Array.isArray(data.docFd)" server/routes/formulare.mjs
# Așteptat: 2 linii — normalizarea din validateOrdnt și din buildOrdnt

git diff server/services/alop-xml/ordnt-serializer.mjs
# Așteptat: GOL — serializatorul suporta deja array

grep -rn "blocuri" public/ | grep -v "sub-blocuri\|blocuri inline"
# Așteptat: 0 rezultate — frontendul e #128f

git status --short
# Așteptat: package.json, ord-to-xsd.mjs, formulare.mjs, ord-blocuri.mjs (dacă e nevoie),
#           fișierele de test. Nimic din public/.
```

---

## 10. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 4 și 6** menționate separat — sunt dovada că un ORD mono-bloc
  produce ieșire identică (XSD, XML, mesaje de validare)
- dacă ai reușit comparația PDF înainte/după pe un ORD mono-bloc: dimensiune și număr de pagini,
  înainte și după
- confirmarea explicită că **nu ai adăugat nicio validare nouă obligatorie**
- orice test preexistent modificat, cu motivul
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
