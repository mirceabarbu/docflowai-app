---
fix: Generare XML oficial DF (NOTAFD) — serializer pur + validare XSD pe exemplele din ghid (Etapa 1/2, ORD urmează)
target_branch: develop
model_suggested: Opus 4.8 (serializare financiară oficială — conversii de format exacte, mapare pe XSD; mize mari)
risk: SCĂZUT pe codebase (pur ADITIV — modul + teste noi, zero atingere a codului existent), dar precizia conversiilor e critică
version: 3.9.588 → 3.9.589
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Lista de semnare (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`) + **întreg codul existent**. Acest task e **pur aditiv**: creezi un modul nou și teste noi. `git diff` pe fișiere existente trebuie să fie ZERO, cu excepția `package.json` (versiune + o devDependency) și, dacă e nevoie, `package-lock.json`. NU atinge generatorul PDF, formularul, DB, UI.

## Context — alinierea cu schema oficială
Modelul de date DocFlowAI e ~1:1 cu schema oficială MF. Generatorul PDF (`server/routes/formulare.mjs`) consumă deja DF-ul ca obiect structurat identic cu XSD:
```
data.sectiuneaA = { compartiment_specialitate, obiect_fd_reviz_scurt, obiect_fd_reviz_lung,
                    ang_legale_val:  { rowT_ang_pl_val:[…],  ckbx_stab_tin_cont, ckbx_ramane_suma, ramane_suma },
                    ang_legale_plati:{ rowT_ang_pl_plati:[…], ckbx_fara_ang_emis_ancrt, ckbx_cu_ang_emis_ancrt,
                                       ckbx_sting_ang_in_ancrt, ckbx_fara_plati_ang_in_ancrt,
                                       ckbx_cu_plati_ang_in_mmani, ckbx_ang_leg_emise_ct_an_urm } }
data.sectiuneaB = { ckbx_secta_inreg_ctrl_ang, rowT_ang_ctrl_ang:[…], ckbx_fara_inreg_ctrl_ang,
                    sum_fara_inreg_ctrl_crdbug, sum_fara_inreg_ctrl_crd_bug,
                    ckbx_interzis_emit_ang, ckbx_interzis_intrucat, intrucat }
```
Numele de atribute = numele din `notafd_v0.xsd`. Serializer-ul doar parcurge acest obiect și emite XML.

## Etapa 0 — precondiție (owner) + caracterizare
**Owner:** copiază în repo cele două scheme MF: `server/services/alop-xml/schemas/notafd_v0.xsd` și `ordnt_v0.xsd` (din atașamentele Ministerului). Confirmă că există înainte de a rula testele.

Caracterizare (Claude Code):
```bash
# 1. Sursa obiectului XSD-shaped (root + sectiuni) — de unde vin Cif/DenInstPb/NrUnicInreg/Revizuirea/DataRevizuirii
grep -n "sectiuneaA\|sectiuneaB\|Cif\|DenInstPb\|NrUnicInreg\|Revizuirea\|DataRevizuirii\|data JSONB\|\.data\b" server/routes/formulare.mjs server/db/index.mjs | head -25
# 2. Confirmă structura rândurilor (rowT_ang_pl_val / rowT_ang_pl_plati / rowT_ang_ctrl_ang)
grep -n "rowT_ang_pl_val\|rowT_ang_pl_plati\|rowT_ang_ctrl_ang" server/routes/formulare.mjs | head
# 3. Schema țintă
sed -n '1,60p' server/services/alop-xml/schemas/notafd_v0.xsd
```
Mapează root-ul XSD (`Cif`, `DenInstPb`, `SubtitluDF`, `NrUnicInreg`, `Revizuirea`, `DataRevizuirii`) din înregistrarea DF (același obiect/coloane de unde le ia generatorul PDF). Dacă ceva diferă → OPREȘTE și raportează.

## Implementare (toate fișiere NOI)

### 1. `server/services/alop-xml/format.mjs` — helpers puri de conversie
Reguli derivate din XSD (autoritative):
| Tip XSD | Regulă de emitere |
|---|---|
| `IntPoz12SType` (xs:integer 0…999999999999) | sume în **bani** (lei×100), întreg, fără zecimale. `ronToBani("11.523.668,69") → "1152366869"`. Tratează separator mii „.", zecimal „,". Valoare lipsă/empty → omite atributul (vezi mai jos). |
| `DateSType` (`dd.mm.yyyy`) | data în format românesc, zero-padding opțional conform pattern. |
| `Str1` (bife) | bifat → `"1"`, nebifat → `""` (nu `true/false`). |
| `CuiSType` (`[1-9]\d{1,9}`) | CIF fără prefix „RO", fără zero la început. |
| `Str150/250/500/20/...` | escape XML (`& < > " '`) + clamp la maxLength din XSD (nu trunchia silențios date financiare — dacă depășește, aruncă eroare descriptivă). |

Funcții: `ronToBani(str)`, `dateRo(val)`, `ckbx(bool|str)`, `cif(str)`, `xmlEscape(str)`, `strClamp(str, max, fieldName)`.

### 2. `server/services/alop-xml/notafd-serializer.mjs` — pur: obiect DF → XML
- Semnătură: `serializeNotafd(df) -> string` (XML cu declarație `<?xml version="1.0" encoding="UTF-8"?>` + namespace `mfp:anaf:dgti:notafd:declaratie:v1`).
- Emite root `<NOTAFD Cif=… DenInstPb=… SubtitluDF=… NrUnicInreg=… Revizuirea=… DataRevizuirii=…>` cu `<sectiuneaA>` și `<sectiuneaB>`.
- Sect.A: atribute + `<ang_legale_val>` (rânduri `rowT_ang_pl_val` cu `element_fd/program/codSSI/param_fd/valt_rev_prec/influente/valt_actualiz`) + `<ang_legale_plati>` (cele 6 bife pct.5 + rânduri `rowT_ang_pl_plati`).
- Sect.B: bife + `sum_fara_inreg_ctrl_crdbug` + rânduri `rowT_ang_ctrl_ang` (col.1–10).
- **DECIZIE owner (confirmat):** în XML emite DOAR `sum_fara_inreg_ctrl_crdbug`. **NU emite `sum_fara_inreg_ctrl_crd_bug`** (pereche 2) — rămâne câmp intern pentru afișaj/PDF, nu are corespondent în schema oficială.
- Atribute `use="required"` din XSD care pot fi goale (`param_fd`, etc.): emite-le mereu, cu `""` când lipsesc.
- Sume `IntPoz12SType` opționale absente: omite atributul (nu emite `="0"` decât dacă valoarea reală e 0 și câmpul a fost completat — respectă semantica „necompletat").

### 3. `server/tests/unit/alop-xml-notafd.test.mjs` — validare XSD pe exemplele din ghid
- Validator: adaugă devDependency **`xmllint-wasm`** (pur WASM, fără dependență de sistem — merge în CI node). Dacă are probleme, alternativă acceptată: `libxmljs2`. Scopul: validare reală contra `notafd_v0.xsd`.
- Construiește obiecte DF din exemplele MF din ghid și asertează că XML-ul generat **validează contra XSD**:
  - **Ex.1** (art.47, credite bugetare 11.523.668,69; col.6=0, col.9=11.523.668,69)
  - **Ex.2 rev.0** (Achiziție licență IT, 560)
  - **Ex.3** (drepturi de personal, 301.000.000 + 27.650.000, două rânduri)
  - **Ex.4 rev.0** (an următor — `ckbx_ang_leg_emise_ct_an_urm`, „rămâne în sumă de" pe rev.1 separat)
  - **Ex.5** (terț / obligație legală, buget insuficient — SecB `ckbx_fara_inreg_ctrl_ang` + `sum_fara_inreg_ctrl_crdbug` + `ckbx_interzis_emit_ang`)
- Verifică și conversiile: o aserțiune că `11.523.668,69 lei` apare în XML ca `1152366869` (bani).

### ⚠️ Limitare cunoscută v0 — influențe negative
`influente`/`influente_c6`/`influente_c9` sunt `IntPoz12SType` (`minInclusive=0`), dar reviziile cu diminuare au influențe negative (Ex.2 rev.1: −10; Ex.4 rev.1). **Serializează valorile fidel — NU clampa/abs** (ar corupe datele financiare). Adaugă testele pentru **Ex.2 rev.1** și **Ex.4 rev.1** ca `it.todo(...)` cu comentariu explicând conflictul: schema `v0` nu acceptă influențe negative, deși ghidul le cere — de ridicat cu MF / de reluat când apare XSD corectat. (Disciplina „skipped ≠ passed": marcate explicit, nu ascunse.)

## Versiune
- bump `package.json`: `3.9.588` → `3.9.589`. (Fără schimbare frontend → fără `?v=`, fără `sw.js`.)
- adaugă `xmllint-wasm` în `devDependencies`.

## Guardrails diff
`git diff --name-only` (excluzând fișierele NOI din `server/services/alop-xml/` și `server/tests/unit/alop-xml-notafd.test.mjs`) trebuie să arate EXCLUSIV `package.json` (+ eventual `package-lock.json`). Zero diff pe `formulare.mjs`, DB, UI:
```bash
git diff --name-only | grep -vE "services/alop-xml/|tests/unit/alop-xml-notafd|package(-lock)?\.json" && echo "⛔ STOP: ai atins cod existent!" || echo "✅ pur aditiv"
```

## Teste
`npm test verde, fără regresii`. Cele 5 exemple non-revizie validează contra XSD (verde); cele 2 cu influențe negative sunt `it.todo` documentate. `npm run check` OK.

## La final
```bash
git add server/services/alop-xml/ server/tests/unit/alop-xml-notafd.test.mjs package.json package-lock.json
git commit -m "feat(alop-xml): serializer DF NOTAFD + validare XSD pe exemplele MF (v3.9.589)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: ce exemple validează verde contra XSD, conversia bani confirmată (11.523.668,69 → 1152366869), și statusul celor 2 `it.todo` (influențe negative vs v0). ORD (`ordnt`) e Etapa 2, prompt separat după ce DF e verde.
