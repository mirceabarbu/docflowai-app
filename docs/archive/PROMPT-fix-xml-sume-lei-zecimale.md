---
titlu: Fix export XML Forexebug — sume în LEI cu 2 zecimale (elimină conversia ×100 bani) + relaxare tip sumă în XSD
model_suggested: Opus 4.8  # atinge serializarea financiară + tipul din XSD + lanțul de validare runtime; risc ridicat
branch: develop
versiune_curenta: 3.9.698
---

# ⚠️ BRANCH: develop — EXCLUSIV
# `main` = PRODUCȚIE, administrat MANUAL de Mircea. NU face merge / push / checkout pe `main`.
# Toate modificările stau pe `develop` (auto-deploy pe staging).

====================================================================
CONTEXT — bug financiar la exportul XML (grav)
====================================================================
La exportul XML pentru Forexebug (NOTAFD / ORDNT), sumele sunt înmulțite cu 100
(lei → bani) în `format.mjs::ronToBani`. Dovadă empirică de la Mircea: o valoare de
6750 lei ajunge în XML ca "675000", iar la import în formularul oficial MF apare ca
675000 — deci **formularul MF interpretează numărul ca LEI, nu ca bani**. Conversia ×100
este GREȘITĂ.

CONFIRMARE de la Mircea (testat pe formularul MF real): câmpul de sumă MF acceptă
**lei cu 2 zecimale** (ex. "2964.50"). Deci reprezentarea corectă în XML este:
**valoarea în lei, ca zecimal cu exact 2 zecimale, separator "." (canonicul xs:decimal)**.

BLOCAJ actual de rezolvat împreună: tipul `IntPoz12SType` din ambele XSD-uri este
`xs:integer` (fără zecimale). `validate.mjs` rulează la runtime și `serve.mjs` respinge
cu 422 orice XML neconform. Deci NU e suficient să scoatem ×100 — dacă emitem "2964.50"
contra unui XSD `xs:integer`, validatorul îl respinge. Trebuie relaxat tipul la
`xs:decimal` cu 2 zecimale, ATOMIC cu schimbarea funcției.

DECIZIE DE DESIGN (aplic-o exact, NU improviza):
- Păstrăm NUMELE tipului `IntPoz12SType` în XSD (deși devine zecimal) ca să NU atingem
  cele ~16 atribute `type="IntPoz12SType"` din cele două scheme — schimbăm DOAR restricția.
- Redenumim funcția `ronToBani` → `ronToLeiXml` (numele vechi minte după fix).

DOMENIU strict (backend + XSD + teste serializatoare):
  server/services/alop-xml/format.mjs
  server/services/alop-xml/notafd-serializer.mjs
  server/services/alop-xml/ordnt-serializer.mjs
  server/services/alop-xml/schemas/notafd_v0.xsd
  server/services/alop-xml/schemas/ordnt_v0.xsd
  server/tests/unit/alop-xml-notafd.test.mjs
  server/tests/unit/alop-xml-ordnt.test.mjs
NU se ating mapper-ele (df-to-xsd / ord-to-xsd) — ele trec sumele nemodificate; testele
lor (alop-xml-df-to-xsd / alop-xml-ord-to-xsd) rămân verzi neschimbate. Verificat: niciun
consumator nu citește sumele înapoi din XML (DocFlowAI doar exportă).

⚠️ XSD-urile sunt marcate "NO-TOUCH (Etapele 1–2)" într-un comentariu de fișier. Îl
OVERRIDE-uim DELIBERAT aici: tipul `xs:integer` ERA chiar bug-ul (forța ×100 bani și nu
poate ține zecimale). NU intră în NO-TOUCH-ul hard (acela e DOAR server/signing/*).

====================================================================
PASUL 1 — format.mjs: rescrie funcția (lei, 2 zecimale, fără ×100) + redenumire
====================================================================
Fișier: server/services/alop-xml/format.mjs

1a. Actualizează comentariul de antet (linia ~5):

old_str:
// IntPoz12SType (xs:integer 0…999999999999) = sume în BANI (lei × 100).

new_str:
// IntPoz12SType (xs:decimal 0…999999999999.99, 2 zecimale) = sume în LEI (NU bani; fără ×100).

1b. Înlocuiește constanta MAX + JSDoc + funcția `ronToBani` cu varianta lei-zecimal:

old_str:
const MAX_BANI = 999999999999n; // IntPoz12SType maxInclusive (magnitudine)

new_str:
const MAX_LEI_CENTS = 99999999999999n; // 999999999999.99 lei, în bani-cents (IntPoz12SType maxInclusive)

old_str:
/**
 * Convertește o sumă RON la "bani" (lei × 100), întreg fără zecimale, ca string
 * potrivit pentru IntPoz12SType.
 *   ronToBani(11523668.69)        -> "1152366869"
 *   ronToBani("11.523.668,69")    -> "1152366869"
 *   ronToBani("") | null | undef  -> null  (apelantul OMITE atributul)
 *   ronToBani(0)                  -> "0"    (valoare completată = 0)
 * Păstrează semnul — influențele negative din revizii NU se clampază/abs (ar corupe
 * datele financiare); schema v0 le va respinge la validare (vezi it.todo în teste).
 * Aruncă pe input nenumeric sau magnitudine > 999999999999 bani.
 */
export function ronToBani(val) {
  if (val === null || val === undefined) return null;
  let n;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error(`ronToBani: valoare nefinită: ${val}`);
    n = val;
  } else {
    const s = String(val).trim();
    if (s === '') return null;
    n = parseAmount(s);
  }
  let bani = Math.round(n * 100);
  if (Object.is(bani, -0)) bani = 0;
  if (BigInt(Math.abs(bani)) > MAX_BANI)
    throw new Error(`ronToBani: depășește intervalul IntPoz12 (max ${MAX_BANI} bani): ${val}`);
  return String(bani);
}

new_str:
/**
 * Convertește o sumă RON la string-ul canonic xs:decimal în LEI, cu exact 2 zecimale
 * (separator "."), potrivit pentru IntPoz12SType. NU mai înmulțește cu 100 — formularul
 * MF interpretează numărul ca lei.
 *   ronToLeiXml(11523668.69)        -> "11523668.69"
 *   ronToLeiXml("11.523.668,69")    -> "11523668.69"
 *   ronToLeiXml(2964.5)             -> "2964.50"
 *   ronToLeiXml("") | null | undef  -> null  (apelantul OMITE atributul)
 *   ronToLeiXml(0)                  -> "0.00" (valoare completată = 0)
 * Aritmetică pe bani-cents (întregi) ca să nu apară artefacte de float (ex. "2964.5000001").
 * Păstrează semnul — influențele negative din revizii NU se clampază/abs (ar corupe
 * datele financiare); schema le respinge la validare (minInclusive 0).
 * Aruncă pe input nenumeric sau magnitudine > 999999999999.99 lei.
 */
export function ronToLeiXml(val) {
  if (val === null || val === undefined) return null;
  let n;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error(`ronToLeiXml: valoare nefinită: ${val}`);
    n = val;
  } else {
    const s = String(val).trim();
    if (s === '') return null;
    n = parseAmount(s);
  }
  let cents = Math.round(n * 100);
  if (Object.is(cents, -0)) cents = 0;
  if (BigInt(Math.abs(cents)) > MAX_LEI_CENTS)
    throw new Error(`ronToLeiXml: depășește intervalul IntPoz12 (max 999999999999.99 lei): ${val}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const lei = Math.floor(abs / 100);
  const bani = abs % 100;
  return `${sign}${lei}.${String(bani).padStart(2, '0')}`;
}

====================================================================
PASUL 2 — notafd-serializer.mjs: import + aSum + comentariu
====================================================================
Fișier: server/services/alop-xml/notafd-serializer.mjs

old_str:
import { ronToBani, dateRo, ckbx, cif, xmlEscape, strClamp } from './format.mjs';

new_str:
import { ronToLeiXml, dateRo, ckbx, cif, xmlEscape, strClamp } from './format.mjs';

old_str:
// Sumă opțională (IntPoz12, bani): OMISĂ când lipsește; "0" emis dacă a fost completată.
function aSum(name, val) {
  const bani = ronToBani(val);
  return bani === null ? '' : ` ${name}="${bani}"`;
}

new_str:
// Sumă opțională (IntPoz12, lei cu 2 zecimale): OMISĂ când lipsește; "0.00" dacă a fost completată.
function aSum(name, val) {
  const suma = ronToLeiXml(val);
  return suma === null ? '' : ` ${name}="${suma}"`;
}

====================================================================
PASUL 3 — ordnt-serializer.mjs: import + aSum + comentariu
====================================================================
Fișier: server/services/alop-xml/ordnt-serializer.mjs

old_str:
import { ronToBani, dateRo, cif, xmlEscape, strClamp } from './format.mjs';

new_str:
import { ronToLeiXml, dateRo, cif, xmlEscape, strClamp } from './format.mjs';

old_str:
// Sumă opțională (IntPoz12, bani): OMISĂ când lipsește; "0" emis dacă a fost completată.
function aSum(name, val) {
  const bani = ronToBani(val);
  return bani === null ? '' : ` ${name}="${bani}"`;
}

new_str:
// Sumă opțională (IntPoz12, lei cu 2 zecimale): OMISĂ când lipsește; "0.00" dacă a fost completată.
function aSum(name, val) {
  const suma = ronToLeiXml(val);
  return suma === null ? '' : ` ${name}="${suma}"`;
}

====================================================================
PASUL 4 — relaxare tip sumă în AMBELE XSD-uri (integer → decimal 2 zecimale)
====================================================================
Aplică ACEEAȘI modificare în ambele fișiere. Blocul e identic în ambele.

Fișier: server/services/alop-xml/schemas/notafd_v0.xsd
Fișier: server/services/alop-xml/schemas/ordnt_v0.xsd

old_str (în fiecare fișier):
	<xs:simpleType name="IntPoz12SType">
		<xs:restriction base="xs:integer">
			<xs:minInclusive value="0"/>
			<xs:maxInclusive value="999999999999"/>
		</xs:restriction>
	</xs:simpleType>

new_str (în fiecare fișier):
	<xs:simpleType name="IntPoz12SType">
		<xs:restriction base="xs:decimal">
			<xs:minInclusive value="0"/>
			<xs:maxInclusive value="999999999999.99"/>
			<xs:fractionDigits value="2"/>
		</xs:restriction>
	</xs:simpleType>

⚠️ Respectă indentarea EXISTENTĂ (TAB-uri, nu spații) — copiază exact structura de mai sus.

====================================================================
PASUL 5 — actualizează testele serializatoarelor la formatul lei-zecimal
====================================================================
Regula de conversie (mecanică, deterministă): fiecare sumă care înainte era afirmată
în BANI (întreg = lei×100) devine acum LEI cu exact 2 zecimale = (valoare_lei).toFixed(2),
separator ".". Funcția se numește acum `ronToLeiXml` (nu `ronToBani`).

5a. Fișier: server/tests/unit/alop-xml-notafd.test.mjs
    - Redenumește în import și în toate apelurile: `ronToBani` → `ronToLeiXml`.
    - Actualizează comentariul de antet (linia ~6) de la "lei×100 / bani" la "lei, 2 zecimale".
    - Actualizează TOATE așteptările de sumă conform tabelului:

        ronToLeiXml('11.523.668,69')  -> '11523668.69'
        ronToLeiXml(11523668.69)      -> '11523668.69'
        ronToLeiXml('11523668.69')    -> '11523668.69'
        ronToLeiXml(560)              -> '560.00'
        ronToLeiXml('301.000.000')    -> '301000000.00'
        ronToLeiXml('27.650.000')     -> '27650000.00'
        ronToLeiXml(0)                -> '0.00'
        ronToLeiXml(-10)              -> '-10.00'
        ronToLeiXml('')/null/undefined-> null (neschimbat)
        ronToLeiXml(9999999999999)    -> THROWS (9999999999999 lei > 999999999999.99 — neschimbat conceptual)

    - Aserțiunile de serializare (xml.toContain), conversii:
        '1152366869'                       -> '11523668.69'
        influente_c9="1152366869"          -> influente_c9="11523668.69"
        '"56000"'   (560 lei)              -> '"560.00"'
        '"30100000000"' (301.000.000 lei)  -> '"301000000.00"'
        '"2765000000"'  (27.650.000 lei)   -> '"27650000.00"'
        plati_estim_an_np1="12000000"      -> plati_estim_an_np1="120000.00"
        (orice sumă 0 completată)          -> "0.00"
      Actualizează și comentariile inline care spun "-> bani".

5b. Fișier: server/tests/unit/alop-xml-ordnt.test.mjs
    - Comentariul "receptii 50 lei -> 5000 bani." devine "receptii 50 lei -> 50.00".
    - Aserțiuni:
        receptii="5000"                 -> receptii="50.00"
        suma_ordonantata_plata="5000"   -> suma_ordonantata_plata="50.00"
        receptii_neplatite="0"          -> receptii_neplatite="0.00"

====================================================================
PASUL 6 — descoperă orice altă aserțiune de sumă rămasă (siguranță)
====================================================================
bash:
  grep -rn "ronToBani" server public
# Așteptat: 0 rezultate (redenumit complet peste tot).

bash:
  grep -rnE '="[0-9]{3,}"' server/tests/unit/alop-xml-notafd.test.mjs server/tests/unit/alop-xml-ordnt.test.mjs | grep -v '\.[0-9]{2}"'
# Așteptat: 0 sume întregi rămase fără cele 2 zecimale (ignoră CIF/coduri, care NU sunt sume).
# ⚠️ ATENȚIE: NU converti CIF-uri, coduri SSI, program, cod_angajament, nr unic — DOAR sumele
#   (atributele care trec prin aSum: receptii, plati_*, influente*, sum_rezv_*, valt_*, ramane_suma,
#    suma_ordonantata_plata, receptii_neplatite, plati_estim_*, sum_fara_inreg_ctrl_crdbug).

====================================================================
PASUL 7 — teste (fără regresii)
====================================================================
bash:
  npm test
# Așteptat: npm test verde, fără regresii. Testele alop-xml-df-to-xsd / alop-xml-ord-to-xsd
# NU trebuie să se schimbe (mapper-ele nu convertesc) — dacă pică, e semn că ai atins ceva greșit.

====================================================================
PASUL 8 — bump versiune (BACKEND-ONLY: fără ?v=, fără CACHE_VERSION)
====================================================================
- Modificare exclusiv backend + XSD + teste → NU bumpa `?v=` pe niciun asset, NU bumpa CACHE_VERSION.
- package.json: 3.9.698 → 3.9.699 (patch).

====================================================================
PASUL 9 — commit pe develop
====================================================================
bash:
  git checkout develop
  git add server/services/alop-xml/ server/tests/unit/alop-xml-notafd.test.mjs server/tests/unit/alop-xml-ordnt.test.mjs package.json
  git commit -m "fix(xml): export sume în lei cu 2 zecimale, elimină conversia ×100 bani + relaxează IntPoz12 la xs:decimal (v3.9.699)"
  git push origin develop
# NU atinge main.

====================================================================
RAPORT FINAL (obligatoriu)
====================================================================
1. Diff-ul din format.mjs (funcția redenumită + MAX + comentariu antet).
2. Diff-urile din cele 2 serializatoare (import + aSum + comentariu).
3. Diff-ul restricției IntPoz12SType din AMBELE XSD-uri (confirmă indentarea cu TAB-uri).
4. Rezumatul aserțiunilor de test actualizate (notafd + ordnt).
5. Ieșirea grep de la Pasul 6 (0 `ronToBani`; 0 sume întregi fără 2 zecimale).
6. Rezultatul `npm test` (verde / fără regresii), menționând explicit că
   alop-xml-df-to-xsd și alop-xml-ord-to-xsd au rămas verzi neschimbate.
7. Confirmare package.json = 3.9.699, fără bump `?v=`/CACHE_VERSION.
8. Commit hash pe develop.
9. NOTĂ pentru Mircea: după deploy pe staging, re-exportă un DF și un ORD cu sume care au
   bani (ex. 2964,50) și confirmă la import în formularul MF că apar corect (2964,50), nu ×100.

====================================================================
⛔ CONSTRÂNGERI ABSOLUTE
====================================================================
⛔ Doar `develop`. NU merge/push/checkout pe `main`.
⛔ NU atinge NO-TOUCH hard: server/signing/*.
⛔ NU atinge mapper-ele df-to-xsd.mjs / ord-to-xsd.mjs, nici testele lor.
⛔ NU redenumi tipul XSD `IntPoz12SType` (ar forța editarea a ~16 atribute) — schimbă DOAR restricția.
⛔ NU converti la zecimale valori care NU sunt sume (CIF, cod SSI, program, coduri, nr unic).
⛔ Aritmetica sumelor stă pe bani-cents întregi (NU `.toFixed` pe float direct în funcție) — evită artefacte.
⛔ Fără refactor colateral. Domeniul e strict cele 7 fișiere listate.
