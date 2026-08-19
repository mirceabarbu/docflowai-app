# PROMPT #128a — RECON READ-ONLY: ORD cu blocuri multiple (multi-furnizor / multi-cont)

> ## ⚠️ BRANCH: `develop` — ⛔ RECON STRICT READ-ONLY
> **NU modifica NICIUN fișier de producție. NU face commit. NU face push.**
> Singurul artefact permis: **un fișier nou** `docs/audits/ORD-128-RECON-2026-08.md`.
> La final, `git status --short` trebuie să arate DOAR acel fișier ca netracked (plus zgomotul
> preexistent de ~50 de fișiere netracked din sesiuni anterioare, care NU se atinge).
> ⛔ Fără bump de versiune. ⛔ Fără `CACHE_VERSION`. ⛔ Fără teste noi.

**Model recomandat:** Opus · **Punct de plecare:** `develop` = producție = **v3.9.759**

---

## 1. Cerința, enunțată de Mircea

O singură Ordonanțare de plată trebuie să poată conține **mai multe blocuri**, adăugate dintr-un
buton, exact ca în formularul oficial MF: fiecare apăsare adaugă **și partea completată de P1, și
partea completată de P2**, împreună.

Terminologia a oscilat între „multi-furnizor" și „multi-cont". La nivel de date **e același
mecanism** — blocul repetat poartă și beneficiarul, și contul. Diferența e o regulă de business
(același furnizor cu IBAN-uri diferite vs. furnizori diferiți), nu una de model. Reconul tratează
cazul general; restrângerea, dacă se dorește, e o validare de câteva linii.

---

## 2. Fapte DEJA STABILITE — nu le reverifica, pleacă de la ele

Extrase de mine din XFA-ul formularului oficial MF
(`OrdonantareDePlata_2026_05_27_011`, stream `template`, 222 KB) și din
`server/services/alop-xml/schemas/ordnt_v0.xsd`.

**Ierarhia formularului oficial:**

```
MainForm
  SubformAntet          ← O SINGURĂ DATĂ: DenInstPb, cif, NrOpl, DataOpl
  SubformInf            ← ⭐ BLOCUL REPETAT, <occur max="-1"/> = nelimitat
    Subform1            ← NrUnicInreg  (‼ per bloc)
    Table1              ← tabelul CAB, Row1 repetabil, Cell1…Cell8   (partea P1)
    SubformCaptura
      Table2            ← captura/documente, Row1 repetabil
    SubformBeneficiar
      SubformBen        ← Beneficiar, DocumenteJustificative, Table3, AtasFis
      SubformBen1       ← CifBeneficiar, IbanBeneficiar, BancaBeneficiar,
                          InfPvPlata, InfPvPlata1                    (partea P2)
  SubformBtnInf         ← butonul „adaugă bloc" (în afara repetiției)
  SubformSemnatura*     ← O SINGURĂ DATĂ: toate semnăturile
```

- ⇒ **un singur `NrOpl`, o singură `DataOpl`, un singur set de semnături, N blocuri.**
- ⇒ **`NrUnicInreg` e ÎN interiorul blocului** — MF permite ca fiecare bloc să trimită la un DF
  DIFERIT.
- XSD: `ordnt_v0.xsd:8` are `docFd maxOccurs="unbounded"`; fiecare `DocFdType` poartă
  `beneficiar`, `iban_beneficiar`, `cif_beneficiar`, `banca_beneficiar` (liniile 24-28).
- `serializeOrdnt` (`alop-xml/ordnt-serializer.mjs`) normalizează deja obiect→array
  („forward-compat"); blocajul e `ordRowToXsd` (`ord-to-xsd.mjs`), care construiește UN docFd din
  coloanele plate.

**Formularul DF oficial — verificat sub aceeași lupă (stream `template`, 285 KB):**

- DF-ul e **STRICT MONO-BLOC**. `MainForm` poartă un `<occur max="-1"/>`, dar **nimic nu îl
  instanțiază** — nu există niciun `MainForm.instanceManager.insertInstance`. Singurele butoane de
  multiplicare sunt la nivel de RÂND („Adaugă rând" / „Adaugă linie nouă") în Table1…Table4.
  (Template-ul DF conține referințe MOARTE la `SubformInf` — cod de bibliotecă partajat cu ORD-ul,
  inert aici.)
- Structura DF: `SubformAntet` → `SubformSectiuneaA` (Table1, Table2) → `SubformSemnaturaA` →
  `SubformSectiuneaB` (Table3, Table4) → `SubformSemnaturaB` → `SubformSemnaturaOrdonator`.
- ⇒ **CONSECINȚĂ DE SCOP:** în modelul MF, DF-ul NU e un container de blocuri — **ORD-ul e
  agregatorul**, și agregă peste DF-uri posibil DIFERITE. Deci varianta „un singur DF per ORD" e o
  RESTRICȚIE reală față de MF, nu o reformulare echivalentă. ⛔ **`formulare_df` NU se atinge în
  acest șantier** — tot lucrul e cantonat în ORD. Dacă reconul ajunge la concluzia că DF-ul
  trebuie modificat, aia e o constatare majoră și se raportează ca atare.

**Regulile de validare MF, aplicate PER BLOC** (din `FData.validFormular`, buclă pe
`FData.SubformInf.all.item(ik)`):

- tabelul trebuie să aibă ≥ 1 rând;
- `Cod angajament` = 11 caractere, `Indicator` = 3, `Program` = 10, `Cod SSI` = 15;
- Cod SSI: primele 2 = sector `01`–`05`; al 3-lea = sursă NEnumerică din nomenclator; ultimele 12
  numerice; `Program` trebuie să existe în nomenclator PENTRU acel sector (excepție `0000000000`);
- cel puțin una din coloanele 2–5 completată;
- coloanele 2 (Recepții), 3 (Plăți anterioare), 5 (Recepții neplătite) **≥ 0**;
- **coloana 4 (Suma ordonanțată) POATE fi negativă, dar `|col.4| ≤ |col.3|`**;
- `Beneficiar`, `DocumenteJustificative`, `InfPvPlata` — **obligatorii per bloc**;
- `CifBeneficiar`, `IbanBeneficiar`, `BancaBeneficiar` — opționale, dar validate dacă există
  (CUI/CNP; checksum IBAN pentru prefix `RO`; avertisment ne-blocant dacă nu e cont TREZ);
- validare în DOUĂ faze prin `StareSemnatura`: faza 0 = antet + beneficiar, apoi deblochează
  coloanele 1-3 și 5; faza 1 = tabelul complet, apoi generează XML.

---

## 3. Ce trebuie să stabilească reconul — pe COD, nu din memorie

Pentru fiecare punct: fișier + linie + citat scurt. Unde nu poți stabili cu certitudine, scrie
explicit „NEDETERMINAT" — o notă onestă e mai utilă decât o presupunere.

### R1. Modelul de date — cele trei variante și costul lor real

`formulare_ord` (migrația 049) ține antetul în coloane PLATE și tabelul CAB în `rows JSONB`.
Evaluează **exact trei** variante și pune-le într-un tabel comparativ:

- **(A) `rows` rămâne PLAT + un câmp `bloc_idx` pe fiecare rând**, iar antetul per bloc trece
  într-o coloană nouă `blocuri JSONB` (array de obiecte cu beneficiar/cif/iban/banca/docs/inf/
  nr_unic). Agregările `SUM(...)` peste `rows` continuă să funcționeze **neschimbate**.
- **(B) `rows` devine IMBRICAT** (array de blocuri, fiecare cu rândurile lui).
- **(C) tabel separat** `formulare_ord_blocuri` cu FK.

Pentru fiecare: câte situri de cod se rup, care anume, și dacă ruperea e **zgomotoasă** (eroare)
sau **tăcută** (numără doar primul bloc). ⚠️ Ruperea tăcută e clasa de bug de la #115 (plata OPME
sub-numărată) — marcheaz-o distinct.

### R2. Inventarul agregărilor — numără-le tu, nu mă crede pe cuvânt

Estimarea mea e ~20 de situri: `routes/alop.mjs` ~11, `routes/formulare/clasa8.mjs` ~6,
`services/opme-matcher.mjs` ~3. **Verifică pe cod** și dă lista completă cu linie și expresie
(`SUM((r->>'suma_ordonantata_plata')::numeric)` și variante). Marchează pentru fiecare dacă ar
supraviețui variantei (A) fără modificare.

### R3. `df_id` — întrebarea care decide domeniul de aplicare

`formulare_ord.df_id` e unic și pe el atârnă modelul ALOP↔ORD, `deriveOrdIdentityCols` (#100.2,
corelare POZIȚIONALĂ cu `rows_ctrl` al DF-ului legat) și poarta de proveniență din #122.
Stabilește:

- ce se rupe dacă blocurile pot trimite la DF-uri DIFERITE (cazul MF complet);
- ce rămâne valabil dacă impunem **un singur DF per ORD** (toate blocurile cu același
  `NrUnicInreg`) — varianta restrânsă;
- cum trebuie să devină corelarea din `deriveOrdIdentityCols` în varianta restrânsă (probabil
  „pozițională PER BLOC") și dacă asta e implementabil fără a atinge DF-ul.

**Nu decide tu** între cele două — pune costurile față în față; decizia e a lui Mircea.

### R4. Frontendul

Inventarul exact al referințelor la id-uri unice `o-*` (`o-benef`, `o-cifb`, `o-iban`, `o-banca`,
`o-docsj`, `o-inf1/2`, `o-nrUnic`, `o-tbody`, `o-df-sel`), pe fișier, cu numărul de apariții.
Estimarea mea: ~98 total (`doc.js` 43, `list.js` 25, `formular.html` 14, `core.js` 11, `draft.js`
3, `alop.js` 2) — **verific-o**. În plus: ce face `lockOrdIdentityCols` la cele 11 situri
`lockAll` și cum se generalizează la N blocuri; și cum se comportă `draft.js` (salvare la 2 s în
localStorage) cu o structură repetată.

### R5. PDF-ul generat și XML-ul

În `routes/formulare.mjs` (generarea PDF DF/ORD): ce presupune layout-ul despre unicitatea
secțiunii beneficiar și ce înseamnă N blocuri pentru paginare. Separat: ce anume din
`ordRowToXsd` trebuie schimbat ca `docFd` să devină array — și dacă `serializeOrdnt` chiar
suportă deja array-ul fără modificare (verifică, nu presupune).

### R6. Validări existente vs. regulile MF

Compară regulile MF din §2 cu ce avem: `validateOrdCol5`, `codSsiValidate` (FORMULAR_TYPES,
`DF=true` / `ORD=false`), `normalizeAngajamentRows`, validările de IBAN/CIF dacă există.
Semnalează în special dacă regula **`|col.4| ≤ |col.3|`** există undeva în codul nostru — eu nu am
găsit-o, dar nu am căutat exhaustiv.

**R6-bis (constatare colaterală, NU face parte din multi-bloc — raporteaz-o separat):** formularul
DF oficial are `FData.comparTable1Table2`, o regulă de ECHILIBRU între tabele — totalul tabelului 4
(`TableFD`, suma pe `Cell7`, sau `sumRamasaFD` când `CheckBox2` nu e bifat) trebuie să fie **EGAL**
cu totalul tabelului 5 (`TableANG`, suma pe `Cell1…Cell6` a tuturor rândurilor); altfel:
„Totaluri inegale pentru tabel 4/5". Verifică dacă avem echivalentul (caută în jurul
`bugetPentruAnul`, `rows_plati`, `suma_plati_pct5`). Dacă lipsește, **NU propune fix aici** — e un
lot de conformitate separat; doar consemnează.

### R7. Propunere de decupaj

Pe baza celor de mai sus, propune împărțirea în prompturi (#128b…) cu ordinea și motivul, plus
ce migrații ar fi necesare pentru varianta recomandată. ⚠️ Reține contextul operațional: **nu
există cale de `pg_dump` pe stația curentă**, deci orice lot cu migrație e blocat până se rezolvă
asta — spune explicit care lot e afectat.

---

## 4. Formatul documentului

`docs/audits/ORD-128-RECON-2026-08.md`, cu secțiuni R1…R7 în ordinea de mai sus. Fiecare
afirmație despre cod = fișier + linie + citat scurt. La final, o secțiune
**„Ce NU am putut stabili"** — explicită, nu ascunsă.

⛔ Nu propune cod. ⛔ Nu scrie patch-uri. Reconul stabilește terenul; deciziile le ia Mircea.

---

## 5. RAPORT FINAL

- confirmarea că ZERO fișiere de producție au fost modificate (`git status --short` în raport)
- rezumat în maximum 15 rânduri: varianta de model recomandată și de ce, numărul REAL de agregări
  găsite, numărul REAL de referințe `o-*`, și cea mai mare necunoscută rămasă
- orice loc în care faptele din §2 (pe care ți le-am dat ca stabilite) **nu se potrivesc** cu
  ce găsești în cod — acelea sunt cele mai valoroase constatări, raportează-le explicit
