---
fix: Generare XML oficial ORD (ORDNT) — serializer pur + validare XSD pe exemplul din ghid (Etapa 2/2)
target_branch: develop
model_suggested: Opus 4.8 (serializare financiară oficială — aceeași rigoare ca DF)
risk: SCĂZUT pe codebase (pur ADITIV — refolosește format.mjs din Etapa 1), precizia conversiilor critică
version: 3.9.589 → 3.9.590
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Lista de semnare + **întreg codul existent, inclusiv `notafd-serializer.mjs` și `format.mjs` din Etapa 1** (le REFOLOSEȘTI, nu le modifici — dacă `format.mjs` chiar are nevoie de un helper nou, adaugă-l fără să atingi cei existenți). Pur aditiv. `git diff` pe fișiere existente = ZERO, exceptând `package.json` (versiune). Zero atingere pe `formulare.mjs`, DB, UI.

## Context — schema ORD (ordnt_v0.xsd)
```
ORDNT (root):  Cif(CuiSType) DenInstPb(Str150) NrOrdonantPl(Str20) DataOrdontPl(DateSType)
  └─ docFd  (maxOccurs=unbounded!)  — un bloc per Document de Fundamentare
       attrs: nr_unic_inreg, beneficiar, documente_justificative, iban_beneficiar(Str24),
              cif_beneficiar(CuiSType), banca_beneficiar, inf_pv_plata, inf_pv_plata1   (toate use="required")
       └─ rowTfd (maxOccurs=unbounded):
              cod_angajament(Str11) indicator_angajament(Str3) program(Str10) cod_SSI(Str15)
              receptii plati_anterioare suma_ordonantata_plata receptii_neplatite  (IntPoz12SType, bani)
```
Forma datelor pe server (consumată deja de generatorul PDF, `formulare.mjs`): `data.Cif/DenInstPb/NrOrdonantPl/DataOrdontPl` + `data.docFd = { nr_unic_inreg, beneficiar, documente_justificative, iban_beneficiar, cif_beneficiar, banca_beneficiar, inf_pv_plata, inf_pv_plata1, rowTfd:[…] }`. Nume 1:1 cu XSD.

## Etapa 0 — caracterizare
```bash
# 1. Confirmă forma ORD pe server + sursa root-ului
grep -n "NrOrdonantPl\|DataOrdontPl\|docFd\|rowTfd\|cif_beneficiar\|iban_beneficiar" server/routes/formulare.mjs | head
# 2. Schema țintă + helpers Etapa 1 de refolosit
sed -n '1,40p' server/services/alop-xml/schemas/ordnt_v0.xsd
grep -n "export" server/services/alop-xml/format.mjs
```
**Nuanță `docFd`:** DocFlowAI are azi un singur `data.docFd` (obiect). XSD permite mai multe (ORD multi-DF, replicarea „Adaugă informații" din ghid). Serializer-ul acceptă `docFd` fie obiect, fie array → emite un `<docFd>` per intrare (azi: unul). Forward-compat, fără rework la multi-DF.

## Implementare (fișiere NOI)

### 1. `server/services/alop-xml/ordnt-serializer.mjs` — pur: obiect ORD → XML
- Semnătură: `serializeOrdnt(ord) -> string` (declarație XML + namespace ORDNT din XSD).
- Root `<ORDNT Cif=… DenInstPb=… NrOrdonantPl=… DataOrdontPl=…>`.
- `docFd`: normalizează la array (`Array.isArray(ord.docFd) ? ord.docFd : [ord.docFd]`), emite `<docFd>` per bloc, cu rândurile `<rowTfd>`.
- **Refolosește `format.mjs`** (`ronToBani`, `dateRo`, `cif`, `xmlEscape`, `strClamp`). Sumele `receptii/plati_anterioare/suma_ordonantata_plata/receptii_neplatite` → bani întreg.
- **IBAN:** normalizează `iban_beneficiar` — scoate spațiile (ghidul îl arată cu spații) înainte de `strClamp(…, 24)`. Dacă după normalizare depășește 24 → eroare descriptivă.
- **Atribute `required` care pot fi goale** (`documente_justificative`, `banca_beneficiar`, `inf_pv_plata`, `inf_pv_plata1`): emite-le mereu, cu `""` când lipsesc (ghidul: „doar dacă e cazul" → nu blocăm, dar emitem atributul). `cif_beneficiar` validat cu pattern CuiSType.
- `receptii_neplatite` e `IntPoz12SType` (min 0) — fără negative (se aliniază cu blocarea ta server `receptii_neplatite_negative`). Fără probleme de influențe negative aici (ORD n-are influențe) → toate exemplele verzi.

### 2. `server/tests/unit/alop-xml-ordnt.test.mjs` — validare XSD
Construiește ORD-ul din **ghid Cap.IV** și asertează validare reală contra `ordnt_v0.xsd` (xmllint-wasm, deja în devDeps):
- root: NrOrdonantPl `121`, DataOrdontPl `05.02.2026`
- docFd: nr_unic_inreg `111`, beneficiar `Telekom România`, documente_justificative `Factura`, cif_beneficiar `427320`, iban_beneficiar `RO51 RNCB 0080 0029 7151 0001`, banca_beneficiar `BCR`, inf_pv_plata `Contravaloare factură aferentă lunii ianuarie`
- rowTfd: cod_angajament `AABBD7P9XP6`, indicator `AAB`, program `0000000541`, cod_SSI `01A510103200108`, receptii `50`, plati_anterioare `0`, suma_ordonantata_plata `50`, receptii_neplatite `0`
Aserțiuni suplimentare:
- IBAN apare în XML **fără spații** și ≤24 caractere (`RO51RNCB0080002971510001`).
- `receptii 50` → bani `5000` în XML.
- un al doilea test: `docFd` ca **array de 2** → XML cu două blocuri `<docFd>` (verifică forward-compat multi-DF), validează XSD.
- un test pe câmpuri opționale goale (`documente_justificative=""`) → atribut prezent, gol, validează XSD.

## Versiune
- bump `package.json`: `3.9.589` → `3.9.590`. (Fără frontend → fără `?v=`/`sw.js`.)

## Guardrails diff
```bash
git diff --name-only | grep -vE "services/alop-xml/ordnt-serializer|tests/unit/alop-xml-ordnt|package\.json" && echo "⛔ STOP: ai atins cod existent!" || echo "✅ pur aditiv"
```
(Dacă ai adăugat un helper nou în `format.mjs`, e acceptabil — dar confirmă că NU ai modificat helperii existenți și că testele Etapei 1 rămân verzi.)

## Teste
`npm test verde, fără regresii`. Toate exemplele ORD verzi (fără `it.todo` aici — ORD n-are influențe negative). Testele NOTAFD din Etapa 1 neatinse, încă verzi. `npm run check` OK.

## La final
```bash
git add server/services/alop-xml/ordnt-serializer.mjs server/tests/unit/alop-xml-ordnt.test.mjs server/services/alop-xml/format.mjs package.json
git commit -m "feat(alop-xml): serializer ORD ORDNT + validare XSD pe exemplul MF (v3.9.590)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: exemplul Cap.IV verde contra XSD, IBAN normalizat fără spații, bani confirmat (50→5000), test multi-docFd verde. Cu asta ambii serializeri (DF+ORD) sunt validați pe exemplele MF — pasul următor (Etapa 3, prompt separat) ar fi integrarea: buton „Export XML" în UI + endpoint care servește XML-ul generat.
