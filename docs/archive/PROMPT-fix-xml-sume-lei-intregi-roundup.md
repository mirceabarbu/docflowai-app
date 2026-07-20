---
titlu: CORECȚIE export XML — sume LEI ÎNTREGI cu rotunjire în sus (ceiling) + revert XSD la xs:integer (schema oficială MF)
model_suggested: Opus 4.8  # serializare financiară + tip XSD + teste; corectează o direcție greșită anterioară
branch: develop
versiune_curenta: 3.9.700
---

# ⚠️ BRANCH: develop — EXCLUSIV
# `main` = PRODUCȚIE, administrat MANUAL de Mircea. NU face merge / push / checkout pe `main`.

====================================================================
CONTEXT — de ce corectăm (dovadă din schema oficială MF)
====================================================================
Schema oficială de IMPORT a MF (confirmată byte-identică cu `schemas/notafd_v0.xsd`
și `schemas/ordnt_v0.xsd`) definește `IntPoz12SType` ca **`xs:integer`** (0…999999999999):
sumele sunt **LEI ÎNTREGI, FĂRĂ ZECIMALE**.

Fix-ul anterior (commit 7a4fc1c, v3.9.699) a relaxat GREȘIT XSD-ul la `xs:decimal` și a
emis sume cu 2 zecimale ("5000.00"). Rezultat verificat pe staging la import în formularul MF:
- valorile cu zecimale sunt INVALIDE pe câmp `xs:integer` → importul MF **respinge rândul
  `rowTfd` la ORD** (tabelul ORD nu se importă) și afectează `sectiuneaA` la DF (compartimentul).

DECIZIA lui Mircea pentru sume cu bani: **rotunjire în SUS (ceiling)**. 2964,50 → 2965.

CORECT: emitem **lei întregi**, `Math.ceil`, fără ×100, fără zecimale; și **revenim la
`xs:integer`** în ambele XSD-uri (ca validatorul nostru să prindă exact ce prinde MF).

DOMENIU strict:
  server/services/alop-xml/format.mjs
  server/services/alop-xml/schemas/notafd_v0.xsd
  server/services/alop-xml/schemas/ordnt_v0.xsd
  server/tests/unit/alop-xml-notafd.test.mjs
  server/tests/unit/alop-xml-ordnt.test.mjs
NU atinge serializatoarele (importă deja `ronToLeiXml`, doar corpul funcției se schimbă),
NU atinge mapper-ele (df-to-xsd/ord-to-xsd) sau testele lor.

⚠️ Simptomul separat „nerezervat 495000" NU e tratat aici — e o valoare stricată în DB
(rezidual Bug A), se rezolvă cu reintroducere + reparare, prompt separat.

====================================================================
PASUL 1 — format.mjs: `ronToLeiXml` → lei ÎNTREGI cu ceiling
====================================================================
Fișier: server/services/alop-xml/format.mjs

Înlocuiește CORPUL actual al funcției `ronToLeiXml` (cea care azi emite lei cu 2 zecimale
prin `padStart` — pusă de commit 7a4fc1c) cu varianta de mai jos. Ajustează `old_str` la
conținutul curent din fișier (ai fișierul în față); rezultatul FINAL trebuie să fie EXACT:

new (funcția completă + constanta MAX):
const MAX_LEI = 999999999999n; // IntPoz12SType maxInclusive (lei întregi)

/**
 * Convertește o sumă RON la string-ul canonic xs:integer în LEI ÎNTREGI, potrivit pentru
 * IntPoz12SType (schema oficială MF e xs:integer — FĂRĂ zecimale). Rotunjire în SUS (ceiling):
 * orice fracție de leu urcă la leul următor (decizie Mircea).
 *   ronToLeiXml(5000)            -> "5000"
 *   ronToLeiXml(2964.5)          -> "2965"   (ceiling)
 *   ronToLeiXml("11.523.668,69") -> "11523669"
 *   ronToLeiXml("") | null|undef -> null     (apelantul OMITE atributul)
 *   ronToLeiXml(0)               -> "0"
 * Rotunjim la bani-cents întâi (Math.round(n*100)) ca să evităm artefacte de float ÎNAINTE de
 * ceiling (ex. 2964.00 să nu devină 2965 dintr-un 2964.0000001). Semnul e păstrat; schema
 * respinge negativele la validare (minInclusive 0). Aruncă pe input nenumeric sau > MAX_LEI.
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
  const cents = Math.round(n * 100);       // exact la ban, fără artefacte float
  let lei = Math.ceil(cents / 100);        // rotunjire în SUS la leu
  if (Object.is(lei, -0)) lei = 0;
  if (BigInt(Math.abs(lei)) > MAX_LEI)
    throw new Error(`ronToLeiXml: depășește intervalul IntPoz12 (max ${MAX_LEI} lei): ${val}`);
  return String(lei);
}

- Actualizează și comentariul de antet din fișier dacă mai spune „2 zecimale"/„decimal" →
  „lei ÎNTREGI (xs:integer), rotunjire în sus".
- `parseAmount`, `dateRo`, `ckbx`, `cif`, `xmlEscape`, `strClamp` rămân NESCHIMBATE.

====================================================================
PASUL 2 — REVERT XSD la xs:integer în AMBELE fișiere
====================================================================
Fișier: server/services/alop-xml/schemas/notafd_v0.xsd
Fișier: server/services/alop-xml/schemas/ordnt_v0.xsd

Restricția `IntPoz12SType` a fost relaxată greșit la `xs:decimal`. Readu-o EXACT la forma
oficială (identică cu XSD-ul MF). Rezultatul FINAL în fiecare fișier:

	<xs:simpleType name="IntPoz12SType">
		<xs:restriction base="xs:integer">
			<xs:minInclusive value="0"/>
			<xs:maxInclusive value="999999999999"/>
		</xs:restriction>
	</xs:simpleType>

⚠️ Elimină `<xs:fractionDigits value="2"/>`, schimbă `xs:decimal`→`xs:integer`, max
`999999999999.99`→`999999999999`. Păstrează indentarea cu TAB-uri. NU schimba alt tip.

====================================================================
PASUL 3 — teste serializatoare: la ÎNTREG (ceiling)
====================================================================
Regula: fiecare așteptare de sumă (azi în format „x.00") devine ÎNTREGUL rotunjit în SUS.
Câmpurile care trec prin `aSum`/`ronToLeiXml`: receptii, plati_*, suma_ordonantata_plata,
receptii_neplatite, influente*, sum_rezv_*, valt_*, ramane_suma, plati_estim_*,
sum_fara_inreg_ctrl_crdbug. NU atinge CIF/coduri/nr.

3a. server/tests/unit/alop-xml-notafd.test.mjs — actualizează:
    ronToLeiXml('11.523.668,69') -> '11523669'   (ceiling de la ,69)
    ronToLeiXml(11523668.69)     -> '11523669'
    ronToLeiXml('11523668.69')   -> '11523669'
    ronToLeiXml(560)             -> '560'
    ronToLeiXml('301.000.000')   -> '301000000'
    ronToLeiXml('27.650.000')    -> '27650000'
    ronToLeiXml(0)               -> '0'
    ronToLeiXml(2964.5)          -> '2965'         (adaugă un caz explicit de ceiling)
    ronToLeiXml('')/null/undef   -> null
    ronToLeiXml(9999999999999)   -> THROWS
    Serializare (toContain): valorile devin întregi rotunjite în sus, ex.
    influente_c9="11523669", "560", "301000000", "27650000", plati_estim_an_np1="120000",
    orice "0.00" → "0". Actualizează comentariile „-> bani"/„-> 2 zecimale".

3b. server/tests/unit/alop-xml-ordnt.test.mjs:
    receptii="5000.00"               -> receptii="5000"
    suma_ordonantata_plata="5000.00" -> suma_ordonantata_plata="5000"
    receptii_neplatite="0.00"        -> receptii_neplatite="0"

====================================================================
PASUL 4 — verificări
====================================================================
bash:
  grep -rn "xs:decimal\|fractionDigits" server/services/alop-xml/schemas/
# Așteptat: 0 rezultate (ambele XSD revenite la integer).

bash:
  grep -rnE '="[0-9]+\.[0-9]{2}"' server/tests/unit/alop-xml-notafd.test.mjs server/tests/unit/alop-xml-ordnt.test.mjs
# Așteptat: 0 sume cu ".NN" rămase (toate întregi). Ignoră date/coduri dacă apar.

bash:
  npm test
# Așteptat: verde, fără regresii. alop-xml-df-to-xsd / alop-xml-ord-to-xsd NESCHIMBATE și verzi.

====================================================================
PASUL 5 — bump versiune (BACKEND + XSD + teste: fără ?v=/CACHE_VERSION)
====================================================================
package.json: 3.9.700 → 3.9.701.

====================================================================
PASUL 6 — commit pe develop
====================================================================
bash:
  git checkout develop
  git add server/services/alop-xml/format.mjs server/services/alop-xml/schemas/ server/tests/unit/alop-xml-notafd.test.mjs server/tests/unit/alop-xml-ordnt.test.mjs package.json
  git commit -m "fix(xml): export sume lei ÎNTREGI cu ceiling + revert IntPoz12 la xs:integer (schema oficială MF) (v3.9.701)"
  git push origin develop
# NU atinge main.

====================================================================
RAPORT FINAL
====================================================================
1. Diff format.mjs (corpul `ronToLeiXml` + MAX + antet).
2. Diff IntPoz12SType din AMBELE XSD (confirmă xs:integer, fără fractionDigits, TAB-uri).
3. Aserțiuni test actualizate (notafd + ordnt), inclusiv cazul de ceiling 2964.5 → "2965".
4. Ieșirea grep de la Pasul 4 (0 xs:decimal, 0 sume „.NN").
5. npm test verde; df-to-xsd/ord-to-xsd neschimbate și verzi.
6. package.json = 3.9.701, fără ?v=/CACHE bump.
7. Commit hash pe develop.
8. NOTĂ Mircea: după deploy staging, re-exportă DF + ORD cu sume care au bani (2964,50 → 2965)
   și confirmă la import MF că tabelul ORD ȘI compartimentul intră corect. Simptomul „nerezervat
   495000" NU se rezolvă aici (valoare stricată în DB — prompt separat de reparare).

====================================================================
⛔ CONSTRÂNGERI
====================================================================
⛔ Doar `develop`. NU merge/push/checkout pe `main`.
⛔ NU atinge server/signing/* (NO-TOUCH), nici mapper-ele df-to-xsd/ord-to-xsd sau testele lor.
⛔ NU emite zecimale și NU folosi ×100. Doar lei întregi cu Math.ceil.
⛔ Ceiling pe cents-întregi (Math.round(n*100) întâi), NU Math.ceil direct pe float.
⛔ Fără refactor colateral.
