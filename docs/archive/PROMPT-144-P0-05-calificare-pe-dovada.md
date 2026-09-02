---
lot: "#144 (P0-05, pasul 4) — „calificat\" pe DOVADĂ, nu pe potrivire de nume"
versiune_start: v3.9.801
versiune_tinta: v3.9.802
model_suggested: Opus 5
migratii: 0
scriere_de_date: NU
fisiere_din_public: 0 (⇒ FĂRĂ CACHE_VERSION, FĂRĂ `?v=`)
---

# ⚠️ BRANCH: develop

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.

# ⛔ ZONA NO-TOUCH

`cloud-signing.mjs`, `bulk-signing.mjs`, `STSCloudProvider.mjs`, `pades.mjs`,
`java-pades-client.mjs`. Lotul ăsta atinge EXCLUSIV calea de **verificare**
(read-only). Dacă un patch pare să ceară o modificare pe calea de semnare:
OPREȘTE-TE și raportează.

---

## CONTEXT

Două module emit independent afirmația „semnătură electronică calificată":

| Fișier | Linie | Expresie |
|---|---|---|
| `server/services/certificate-verify.mjs` | 391 | `result.isQES = qtsp.found \|\| hasQcExt;` |
| `server/verify.mjs` | 374 | `result.isQES = isKnownQTSP \|\| !!qcExt;` |

Ambii operanzi sunt slabi:

1. **`qtsp.found` / `isKnownQTSP`** = potrivire de ȘIRURI pe numele emitentului
   (`KNOWN_QTSP` la `certificate-verify.mjs:77`, `KNOWN_ROMANIAN_QTSP` la
   `verify.mjs:36` — două liste, deja divergente). Un certificat auto-semnat cu
   „STS" în CN trece.
2. **`hasQcExt` / `qcExt`** = doar PREZENȚA extensiei `1.3.6.1.5.5.7.1.3`, fără
   să se uite ce conține. `OID.QC_COMPLIANCE` e definit la
   `certificate-verify.mjs:70` și **nefolosit**.

Afirmația nu rămâne internă: ajunge în `sign-trust-report.mjs:446` ca eticheta
tipărită **„CALIFICAT (QES)"**, într-un PDF pe care instituția îl poate preda
unui terț. Ruta de verificare e publică.

### Adevărul de teren (măsurat pe un PDF real din producție, 3 semnături STS)

Certificatele emise de `STS Qualified CA II` poartă dovada completă:

| Element | OID | Prezent |
|---|---|---|
| QcCompliance | `0.4.0.1862.1.1` | DA |
| QcSSCD (cheia într-un dispozitiv calificat) | `0.4.0.1862.1.4` | DA |
| QcPDS | `0.4.0.1862.1.5` | DA |
| QcType | `0.4.0.1862.1.6` | DA |
| QcType-esign | `0.4.0.1862.1.6.1` | DA |
| Politica QCP-n-qscd | `0.4.0.194112.1.2` | DA |
| key usage | — | `non_repudiation`, `digital_signature`, `key_encipherment` |

⇒ **Consecință de acceptanță: documentele reale trebuie să rămână „calificat".**
Lotul nu schimbă verdictul pentru semnăturile STS; îl schimbă doar pentru
certificatele care azi trec pe potrivire de nume sau pe o extensie goală.

Alte fapte măsurate pe același PDF, relevante pentru Etapa E:
- `SubFilter` = `ETSI…`, semnături `sha256_ecdsa`, lanț de 3 certificate;
- atributele semnate sunt EXACT: `content_type`, `message_digest`,
  `signing-certificate-v2` (`1.2.840.113549.1.9.16.2.47`);
- **`signing_time` LIPSEȘTE**, nu există atribut de marcă temporală, nu există
  `DocTimeStamp`, `/DSS` sau `/VRI` ⇒ nivelul real e **PAdES-B-B**. Datele
  vizibile vin din `/M` (autodeclarat de semnatar, acoperit de ByteRange dar
  neatestat de o terță parte).

---

## PASUL 0 — ancore

```bash
git branch --show-current                        # develop
grep '"version"' package.json                    # 3.9.801

grep -n "isQES = " server/services/certificate-verify.mjs   # 1 linie (391)
grep -n "isQES = " server/verify.mjs                        # 1 linie (374)
grep -c "QC_COMPLIANCE" server/services/certificate-verify.mjs   # 1 (doar definiția)
grep -n "ltv_ready" server/services/certificate-verify.mjs  # 1 linie (403)
```

Dacă vreo ancoră diferă: **OPREȘTE-TE și raportează.**

---

## PASUL 1 — RECON (raportează ÎNAINTE de a scrie cod)

Nu pot vedea de aici forma exactă în care parserele existente expun valoarea unei
extensii. Am nevoie de trei răspunsuri, cu citat de cod:

1. În `certificate-verify.mjs`, obiectul întors de parser pentru
   `signerCert.extensions[i]`: ce câmpuri are (`extnID`, `extnValue`,
   `parsedValue`?), iar `extnValue` e `Buffer`, `Uint8Array`, șir hex, sau
   structură ASN.1 deja parsată? Arată cum e consumată azi o extensie care CHIAR
   se citește (AIA / CRL_DIST / KEY_USAGE sunt candidați).
2. Aceeași întrebare pentru `verify.mjs` — e alt parser sau același?
3. Există deja în proiect un utilitar care scoate OID-uri dintr-un DER? Caută
   înainte să scrii unul nou.

**Raportează cele trei răspunsuri și așteaptă confirmarea mea înainte de Etapa B.**
Etapele A, D, F pot fi scrise între timp — nu depind de răspuns.

---

## ETAPA A — modul PUR nou: `server/services/qc-evidence.mjs`

Fără importuri, fără I/O, fără DB. Singura sursă de adevăr pentru „ce înseamnă
calificat". Ambele motoare vor consuma DE AICI.

```js
/**
 * #144 (P0-05) — evaluarea calificării unui certificat pe DOVADĂ, nu pe nume.
 *
 * De ce există: până la #144, ambele motoare de verificare decideau
 * „calificat" din `numeEmitentPotrivit || extensiaExistă`. Amândoi operanzii
 * sunt falsificabili — numele emitentului e un șir liber, iar extensia poate fi
 * prezentă și goală. Aici se cere CONȚINUTUL: OID-urile definite de
 * ETSI EN 319 412-5 (qcStatements) și EN 319 411-2 (politici).
 *
 * ⛔ Numele QTSP-ului rămâne o ETICHETĂ de afișare. NU e niciodată dovadă și nu
 *    intră în nicio decizie booleană din fișierul ăsta.
 */

export const QC_OID = {
  COMPLIANCE:   '0.4.0.1862.1.1',    // certificat calificat conform eIDAS
  SSCD:         '0.4.0.1862.1.4',    // cheia privată într-un QSCD
  PDS:          '0.4.0.1862.1.5',
  TYPE:         '0.4.0.1862.1.6',
  TYPE_ESIGN:   '0.4.0.1862.1.6.1',
  TYPE_ESEAL:   '0.4.0.1862.1.6.2',
  TYPE_WEB:     '0.4.0.1862.1.6.3',
  POLICY_QCP_N_QSCD: '0.4.0.194112.1.2',   // persoană fizică, cu QSCD
  POLICY_QCP_L_QSCD: '0.4.0.194112.1.3',   // persoană juridică (sigiliu), cu QSCD
  POLICY_QCP_N:      '0.4.0.194112.1.0',
  POLICY_QCP_L:      '0.4.0.194112.1.1',
};

/**
 * @param {object} input
 * @param {string[]} input.qcStatementOids — OID-urile găsite în extensia 1.3.6.1.5.5.7.1.3
 * @param {string[]} input.certPolicyOids  — OID-urile găsite în extensia 2.5.29.32
 * @param {string[]} input.keyUsage        — ex. ['digital_signature','non_repudiation']
 * @returns {{
 *   qcCompliance: boolean, qscd: boolean, esign: boolean, nonRepudiation: boolean,
 *   isQualifiedCert: boolean, isQES: boolean, evidence: string[], missing: string[]
 * }}
 */
export function evaluateQcEvidence(input = {}) { /* … */ }
```

Regulile, în exact forma asta (fiecare cu comentariu care spune DE CE):

- `qcCompliance` = `QC_OID.COMPLIANCE` prezent în `qcStatementOids`.
- `qscd` = `QC_OID.SSCD` prezent, SAU o politică din
  {`POLICY_QCP_N_QSCD`, `POLICY_QCP_L_QSCD`} prezentă în `certPolicyOids`.
- `esign` = `TYPE_ESIGN` prezent, SAU `TYPE` complet absent. Motiv, scris în cod:
  ETSI EN 319 412-5 tratează absența lui QcType ca esign implicit; dar dacă
  QcType E prezent și indică ESEAL sau WEB, certificatul **nu** e pentru
  semnătură de persoană ⇒ `esign = false`.
- `nonRepudiation` = prezent în `keyUsage` (acceptă și forma `nonRepudiation`).
- `isQualifiedCert` = `qcCompliance && esign`.
- **`isQES` = `isQualifiedCert && qscd && nonRepudiation`.**
  Comentariu obligatoriu: eIDAS art. 3 pct. 12 — o semnătură calificată cere
  certificat calificat **ȘI** dispozitiv calificat de creare. Fără dovada QSCD,
  maximul demonstrabil e „avansată cu certificat calificat" (AdES-QC), nu QES.
- `evidence` = lista lizibilă a dovezilor GĂSITE; `missing` = ce lipsește pentru
  QES. Ambele în română, scurte — se afișează.

⛔ Fără fallback-uri „dacă nu știm, presupunem calificat". Absența dovezii ⇒ `false`.

---

## ETAPA B — extragerea OID-urilor (DUPĂ confirmarea reconului)

Un singur ajutor, în același fișier `qc-evidence.mjs`, ca să nu apară două
implementări:

```js
/**
 * Scanează un DER și întoarce toate OID-urile din el (etichetă 0x06).
 * Deliberat TOLERANT: nu construiește arborele ASN.1, doar caută OID-uri.
 * Ne interesează apartenența la o mulțime cunoscută, nu structura — iar un
 * parser strict s-ar rupe pe codificări legale dar neobișnuite (așa cum s-a
 * întâmplat deja la parsarea CMS a acestor PDF-uri).
 */
export function derOids(buf) { /* … */ }
```

Implementare: parcurge octet cu octet; la `0x06` cu lungime 1..16, decodează
OID-ul standard (primul octet = `40*a + b`, apoi base-128 cu bitul 7 de
continuare) și sare peste corp. Ignoră orice nu decodează curat.

Dacă reconul arată că parserul existent expune deja OID-urile parsate, folosește
ALEA și lasă `derOids` doar ca fallback — dar păstrează funcția și testele ei.

---

## ETAPA C — cablare `certificate-verify.mjs`

Înlocuiește blocul L6 (`:387-399`). Forma nouă:

- extrage `qcStatementOids` din extensia `OID.QC_STATEMENTS` și `certPolicyOids`
  din `2.5.29.32` (adaugă OID-ul politicilor în tabelul `OID`);
- `const qc = evaluateQcEvidence({ qcStatementOids, certPolicyOids, keyUsage });`
- `result.isQES = qc.isQES;`
- `result.levels.L6.ok = qc.isQES;`
- `result.levels.L6.qtsp = qtsp.name;` — **rămâne**, ca etichetă;
- `result.levels.L6.evidence = qc.evidence;` și `.missing = qc.missing;` (câmpuri noi);
- `result.certificate.certificateType`:
  `qc.isQES ? 'qualified' : qc.isQualifiedCert ? 'qualified_no_qscd' : 'unknown'`;
- `result.certificate_qc_status`: `qc.isQES ? 'qualified' : qc.isQualifiedCert ? 'qualified-no-qscd' : 'non-qualified'`.

⚠️ `certificate_qc_status` și `certificateType` sunt CONSUMATE de
`sign-trust-report.mjs` (`:252`, `:445-471`) și de `routes/report.mjs` (`:89`).
Valoarea nouă `qualified_no_qscd` / `qualified-no-qscd` trebuie să aibă o ramură
de afișare acolo — etichetă **„CALIFICAT, FĂRĂ DOVADĂ QSCD"**, culoare `COL.warn`.
⛔ Nu o lăsa să cadă pe ramura „NECUNOSCUT": ar fi mai puțin adevărat decât azi.

---

## ETAPA D — cablare `verify.mjs`, ca să dispară a doua versiune a adevărului

Același modul, aceeași derivare, la `verify.mjs:367-378`. `KNOWN_ROMANIAN_QTSP`
rămâne DOAR pentru eticheta `qtspName`.

⛔ Nu unifica cele două motoare în lotul ăsta și nu muta cod între ele. Singurul
lucru care se unifică e **definiția calificării**. Restul (L1-L5, parsarea) rămâne
unde e.

Dacă `verify.mjs` folosește alt parser și extragerea OID-urilor cere mai mult de
~15 linii acolo: **OPREȘTE-TE și raportează** — atunci Etapa D devine lot separat,
iar în locul ei pui în `verify.mjs` un comentariu care trimite la `qc-evidence.mjs`
și semnalează divergența rămasă.

---

## ETAPA E — două afirmații corectate în același perimetru

**E1 — `ltv_ready` (`certificate-verify.mjs:403`).** Azi:
`!!(result.signingTime && result.levels.L5?.ok === true)`, unde `signingTime` vine
din atributul CMS `signing_time` (`:272`) — **autodeclarat de semnatar**, nu de o
terță parte. „LTV" fără marcă temporală e o afirmație falsă. Nou: cere un token de
marcă temporală REAL — atributul nesemnat `1.2.840.113549.1.9.16.2.14`
(`OID.TIMESTAMP`, definit și nefolosit) sau un `DocTimeStamp` în PDF. Fără el,
`ltv_ready = false`.

**E2 — nivel PAdES declarat.** Câmp nou `result.padesLevel`:
`'B-LT'`/`'B-T'` dacă există marcă temporală (și `/DSS` pentru LT), altfel
**`'B-B'`**. Plus `result.levels.L6.note` care spune explicit că verdictul e
valabil **la momentul verificării**, fiindcă fără marcă temporală nu se poate
proba momentul semnării.

⚠️ Pe documentele voastre reale rezultatul va fi `B-B` și `ltv_ready:false` —
identic cu azi ca efect (`signing_time` lipsește deja), dar din motivul corect.

---

## ETAPA F — teste

### F1 — `server/tests/unit/qc-evidence.test.mjs` (pur, fără DB)

⭐⭐ **Cazul de aur — certificatul STS real.** Exact mulțimile măsurate:
```js
qcStatementOids: ['0.4.0.1862.1.1','0.4.0.1862.1.4','0.4.0.1862.1.5',
                  '0.4.0.1862.1.6','0.4.0.1862.1.6.1'],
certPolicyOids:  ['0.4.0.194112.1.2','0.4.0.19431.1.1.3',
                  '1.3.6.1.4.1.20625.1.1.10.1','1.3.6.1.5.5.7.2.1'],
keyUsage: ['digital_signature','non_repudiation','key_encipherment'],
```
⇒ `isQES === true`. Comentariu în test: **acesta e cazul de non-regresie al
producției**; dacă pică, lotul ar declasa documente reale, valide.

Restul:
1. ⭐⭐ extensie prezentă dar GOALĂ (`qcStatementOids: []`) ⇒ `isQES:false`,
   `isQualifiedCert:false`. Ăsta e defectul reparat.
2. ⭐ QcCompliance fără QcSSCD și fără politică QSCD ⇒ `isQualifiedCert:true`,
   `isQES:false`, `missing` menționează QSCD.
3. QcCompliance + politică `POLICY_QCP_N_QSCD`, fără OID-ul SSCD ⇒ `isQES:true`
   (politica e dovadă echivalentă).
4. QcCompliance + QcSSCD + `TYPE_ESEAL` ⇒ `esign:false` ⇒ `isQES:false`.
5. QcCompliance + QcSSCD, QcType complet ABSENT ⇒ `esign:true` ⇒ `isQES:true`.
6. ⭐ fără `non_repudiation` în keyUsage ⇒ `isQES:false`.
7. intrări degenerate (`undefined`, `null`, `{}`, OID-uri necunoscute) ⇒
   `isQES:false`, fără excepție aruncată.
8. `derOids`: DER cu OID-uri cunoscute ⇒ le găsește; buffer gol ⇒ `[]`; gunoi
   binar ⇒ `[]` sau OID-uri, dar **fără excepție**.

### F2 — `server/tests/unit/qes-claim-wiring.test.mjs` (structural)

9. ⭐ nici `certificate-verify.mjs`, nici `verify.mjs` nu mai conțin o atribuire
   către `isQES` care folosească operatorul `||` între o verificare de nume și una
   de prezență a extensiei — ambele deleagă la modulul nou (asertează prezența
   importului și a apelului în ambele fișiere).
10. `sign-trust-report.mjs` tratează valoarea intermediară (grep pe eticheta nouă).

⛔ Nu adăuga în repo niciun PDF real: documentele de producție conțin date cu
caracter personal ale cetățenilor. Testele lucrează pe mulțimi de OID-uri.

### Verificare manuală (o face Mircea, nu agentul)

Se apelează ruta publică de verificare cu un PDF STS real și se compară JSON-ul:
`isQES` trebuie să rămână `true`, iar `levels.L6.evidence` să enumere
QcCompliance + QSCD + esign. `padesLevel` = `B-B`.

```bash
npm test        # verde
npm run test:db # PASSED REAL
```

---

## PASUL FINAL

```bash
# package.json: 3.9.801 → 3.9.802
git status --short   # stage-uiește DOAR căile atinse, NICIODATĂ `git add -A`
git add server/services/qc-evidence.mjs \
        server/services/certificate-verify.mjs \
        server/verify.mjs \
        server/services/sign-trust-report.mjs \
        server/tests/unit/qc-evidence.test.mjs \
        server/tests/unit/qes-claim-wiring.test.mjs \
        package.json
git diff --cached --stat
git commit -m "fix(#144/P0-05): calificarea certificatului se decide pe dovada (qcStatements/politici), nu pe numele emitentului (v3.9.802)"
git push origin develop
```

```bash
git diff --stat -- public/     # GOL
git status --short -- server/services/cloud-signing.mjs server/services/pades.mjs
                               # GOL (zona NO-TOUCH neatinsă)
```

---

## RAPORT FINAL

1. Branch, ancorele din PASUL 0.
2. **Răspunsurile reconului** (PASUL 1) și ce ai ales în consecință la Etapa B.
3. ⭐⭐ Cazul de aur (F1, certificatul STS real): `isQES` rămâne `true`? Arată
   obiectul întors integral. **Dacă e `false`, OPREȘTE-TE — lotul declasează
   producția și ceva e greșit în reguli, nu în date.**
4. ⭐⭐ Cazul extensiei goale: ce întorcea codul VECHI vs. cel nou.
5. Etapa D: ai reușit cablarea lui `verify.mjs`, sau ai oprit-o pe regula de
   ~15 linii? Dacă ai oprit-o, ce rămâne divergent.
6. Ce afișează acum `sign-trust-report.mjs` pentru fiecare din cele trei stări
   (calificat / calificat-fără-QSCD / necalificat).
7. `npm test` / `npm run test:db` — cifre, PASSED REAL.
8. Commit, versiune, push.
9. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri, zero `public/`.
- Zona NO-TOUCH neatinsă — lotul e exclusiv pe calea de verificare.
- Numele QTSP-ului nu intră NICIODATĂ într-o decizie booleană; e etichetă.
- Niciun PDF real în repo.
- `qc-evidence.mjs` rămâne PUR: fără importuri, fără I/O, fără DB.
- Dacă un `old_str` nu se potrivește sau reconul contrazice promptul:
  OPREȘTE-TE și raportează.
