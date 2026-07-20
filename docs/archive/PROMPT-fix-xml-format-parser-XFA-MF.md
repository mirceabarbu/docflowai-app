---
titlu: Aliniere serializatoare XML la parserul XFA al formularelor MF — apostrof + tag-uri de închidere (rămâne valid XSD)
model_suggested: Opus 4.8  # serializare financiară oficială; format care trebuie să treacă SIMULTAN XSD + parserul XFA
branch: develop
versiune_curenta: 3.9.701
---

# ⚠️ BRANCH: develop — EXCLUSIV. main = producție, manual, Mircea. NU merge/push/checkout pe main.

====================================================================
CONTEXT — de ce (dovadă din formularele MF, nu presupunere)
====================================================================
Formularele oficiale MF (NOTAFD/DF și ORDNT/ORD) NU parsează XML-ul ca XML. Au un parser
JavaScript XFA (Adobe) care caută tag-urile ca TEXT SIMPLU. Extras din PDF-urile lor:

  __GetAttributeValue: caută `nume + "='"`  →  cere APOSTROF: receptii='5000', NU receptii="5000".
  __Load_rowTfd: delimitează rândul între `<rowTfd` și `</rowTfd>` (indexOf('&lt;/rowTfd')).
                 Rând AUTO-ÎNCHIS (`<rowTfd .../>`) → nu există `</rowTfd>` → lrdtab negativ →
                 rândul NU se citește → tabelul rămâne gol în formular. (Simptom real ORD.)
  Parserul DF cere tag de închidere pentru: sectiuneaA, sectiuneaB, ang_legale_val,
                 ang_legale_plati, rowT_* (toate rândurile), rowTfd, docFd.

Verificat cu `xmllint` contra schemei oficiale: `receptii='5000'` + `<rowTfd ...></rowTfd>`
VALIDEAZĂ la fel (apostroful și tag-ul pereche sunt XML valid). Deci reparăm parserul XFA
FĂRĂ să stricăm validarea XSD — trebuie să meargă pe AMBELE.

Numele atributelor sunt DEJA corecte (parserul citește exact `nr_unic_inreg`, `beneficiar`,
`cif_beneficiar`, `program`, `cod_SSI`, `receptii`, `suma_ordonantata_plata` etc. — identice
cu ce emitem). NU redenumi niciun atribut. (`cod_program`/`nr_op`/`suma_op` sunt din secțiunea
`rand_op` = alt tip de document, pe care NU-l exportăm — ignoră-le.)

DOMENIU strict:
  server/services/alop-xml/notafd-serializer.mjs
  server/services/alop-xml/ordnt-serializer.mjs
  server/services/alop-xml/format.mjs  (doar dacă `xmlEscape` nu escape-uiește deja `'`)
  server/tests/unit/alop-xml-notafd.test.mjs
  server/tests/unit/alop-xml-ordnt.test.mjs
NU atinge mapper-ele, XSD-urile, validate.mjs, serve.mjs.

====================================================================
PASUL 1 — apostrof în loc de ghilimele la TOATE atributele
====================================================================
În ambele serializatoare, TOATE atributele emise trebuie delimitate cu `'`, nu `"`.
Concret, în funcțiile helper de emitere atribut (`aStr`, `aCkbx`, `aStrOpt`, `aSum`,
și emiterea IBAN din ordnt) schimbă delimitatorul din `"..."` în `'...'`. Ex.:

  return ` ${name}="${...}"`;   →   return ` ${name}='${...}'`;

Declarația XML de la începutul fiecărui serializer poate rămâne cu `"` (parserul nu o
citește), dar pentru consecvență o poți trece și pe ea la `'` — opțional, NU obligatoriu.

⚠️ ESCAPING (critic): fiindcă valorile sunt acum între `'`, `xmlEscape` TREBUIE să
transforme `'` → `&apos;` în valori (și NU mai e nevoie strict de `"`→`&quot;`, dar
lasă-l, e inofensiv). Verifică `format.mjs::xmlEscape`: dacă NU escape-uiește deja `'`,
adaugă `.replace(/'/g, '&apos;')`. NU dubla escaparea.

====================================================================
PASUL 2 — tag de închidere pe RÂNDURI (nu auto-închise)
====================================================================
Toate funcțiile de rând care azi întorc `... + '/>'` trebuie să întoarcă `...></NUME>`:

notafd-serializer.mjs:
  rowAngPlVal   → `<rowT_ang_pl_val ...></rowT_ang_pl_val>`
  rowAngPlPlati → `<rowT_ang_pl_plati ...></rowT_ang_pl_plati>`
  rowAngCtrl    → `<rowT_ang_ctrl_ang ...></rowT_ang_ctrl_ang>`

ordnt-serializer.mjs:
  rowTfd        → `<rowTfd ...></rowTfd>`

Concret: înlocuiește `+ '/>'` cu `+ '></NUME_ELEMENT>'` în fiecare (cu numele corect).

====================================================================
PASUL 3 — tag de închidere pe CONTAINERE emise azi auto-închise
====================================================================
notafd-serializer.mjs — ramurile fără rânduri emit `.../>`; fă-le pereche:
  linia `out.push('    <ang_legale_plati' + platiAttrs + '/>');`
    → `out.push('    <ang_legale_plati' + platiAttrs + '></ang_legale_plati>');`
  linia `out.push('  <sectiuneaB' + bAttrs + '/>');`
    → `out.push('  <sectiuneaB' + bAttrs + '></sectiuneaB>');`
Verifică și `ang_legale_val` / `sectiuneaA`: azi se emit mereu cu `>` + copii + tag închidere
(au deja formă pereche) — dacă vreo ramură le emite auto-închise, corectează la fel.
La ORD: `docFd` se emite deja cu `>` + rânduri + `</docFd>` — confirmă, nu-l strica.

⚠️ Rezultat: NICIUN `/>` rămas în output-ul niciunui serializer. Totul cu tag de închidere.

====================================================================
PASUL 4 — teste: apostrof + tag pereche
====================================================================
Actualizează aserțiunile din alop-xml-notafd.test.mjs și alop-xml-ordnt.test.mjs care
verifică output-ul XML:
  - `toContain('nume="valoare"')` → `toContain("nume='valoare'")` pentru atributele testate.
  - orice aserțiune care presupune `/>` pe rânduri/containere → tag pereche.
Adaugă câte o aserțiune per serializer care confirmă că output-ul NU conține ` />` sau `/>`:
  expect(xml).not.toMatch(/\/>/);
Și una care confirmă delimitatorul apostrof pe un atribut de sumă, ex.:
  expect(xml).toContain("receptii='5000'");  // ORD
  expect(xml).toContain("influente='...'");   // DF (valoarea corectă)

====================================================================
PASUL 5 — verificare că rămâne VALID XSD (ambele ținte)
====================================================================
Testele existente rulează deja validarea prin xmllint-wasm (validate.mjs) în serve/serializare?
Dacă există un test care validează output-ul contra XSD, trebuie să rămână VERDE (apostroful și
tag-urile pereche sunt XML valid). Dacă NU există, adaugă un test minimal care serializează un
DF și un ORD și le trece prin `validateXml(xml, 'notafd_v0'|'ordnt_v0')` → `valid === true`.
Așa garantăm „merge pe amândouă": XSD + parserul XFA.

bash:
  npm test
# Așteptat: verde, fără regresii. Serializare validă XSD + format nou (apostrof, tag pereche).

====================================================================
PASUL 6 — versiune + commit
====================================================================
package.json: 3.9.701 → 3.9.702 (backend-only, fără ?v=/CACHE bump).
bash:
  git checkout develop
  git add server/services/alop-xml/ server/tests/unit/alop-xml-notafd.test.mjs server/tests/unit/alop-xml-ordnt.test.mjs package.json
  git commit -m "fix(xml): format compatibil parser XFA MF — apostrof + tag-uri de închidere (rămâne valid XSD) (v3.9.702)"
  git push origin develop

====================================================================
RAPORT FINAL
====================================================================
1. Diff-uri serializatoare (apostrof; rânduri și containere cu tag de închidere).
2. Confirmare `xmlEscape` tratează `'` → `&apos;`.
3. Un ORD și un DF serializate de test (paste output) — să confirm vizual apostrof + `</rowTfd>` etc.
4. Rezultat validare XSD pe output (test verde) — dovada că merge pe AMBELE.
5. `npm test` verde, fără regresii.
6. Grep dovadă: `grep -c "/>" ` pe output = 0.
7. package.json = 3.9.702, commit hash.
8. NOTĂ Mircea: după deploy staging, re-exportă ORD + DF, importă în formularele MF și confirmă
   că TABELELE se populează. Rămâne separat: nerezervatul rezidual (valoare stricată DB) +
   `CompartSpecialit` la ORD (câmp în formular dar NU în ordnt_v0.xsd — de decis dacă-l adăugăm).

====================================================================
⛔ CONSTRÂNGERI
====================================================================
⛔ Doar develop. NU main. NU server/signing/*. NU mapper-ele. NU redenumi atribute.
⛔ NU emite `/>` nicăieri — toate elementele cu tag de închidere.
⛔ Rezultatul TREBUIE să rămână valid contra XSD (xmllint-wasm verde) ȘI cu apostrof/tag pereche.
⛔ Escaping corect pentru `'` (`&apos;`) — fără dublă escapare.
⛔ Fără refactor colateral.
