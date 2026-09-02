# PROMPT #147 — nucleul criptografic verificat, portat în motorul Raportului de încredere

> ⚠️ **BRANCH: `develop`.** Niciun `checkout`, `merge` sau `push` spre `main`.
> Dacă `git branch --show-current` nu arată `develop`, OPREȘTE-TE.

- **Model recomandat:** Opus 5
- **versiune_start:** 3.9.805
- **versiune_tinta:** 3.9.806
- **Migrații:** ZERO
- **CACHE_VERSION:** se decide pe dovadă (lot server-side; probabil NU)

---

## DE CE

`server/verify.mjs` (pagina publică de verificare) are din #145 un nucleu
criptografic real: selecția semnatarului pe **emitent + serie**, algoritmul
citit din `SignerInfo`, curba citită din cheie, conversia semnăturii ECDSA din
DER în raw și verificare prin WebCrypto.

`server/services/certificate-verify.mjs` (motorul **Raportului de încredere** —
PDF-ul pe care primăria îl dă mai departe) nu are nimic din toate acestea.

Defectul central, confirmat pe cod la linia 213:

```js
const verOk = await sd.verify({ signer: 0, data: ab, ... });
```

`ab` (linia 179) este **bufferul CMS însuși**, nu octeții din ByteRange. Adică
îi cerem bibliotecii să verifice semnătura contra propriului plic. Pentru o
semnătură PAdES detașată acest apel **nu poate reuși cu niciun algoritm**.
Excepția care apare pe ECDSA doar maschează faptul că apelul e greșit din
construcție. Consecința: motorul Raportului de încredere **nu a confirmat
criptografic niciodată** o semnătură, dar tipărește verdict.

Al doilea defect, linia 243: selecția semnatarului destructurează `issuer` și
**nu îl folosește** — potrivește doar pe număr de serie. Două certificate cu
aceeași serie de la emitenți diferiți se confundă.

Lotul portează nucleul verificat și abia apoi strânge formula verdictului —
în ordinea asta, fiindcă invers ar tipări „invalid" pe acte valide.

---

## ⛔ REGULA CENTRALĂ: ORDINEA NU E NEGOCIABILĂ

```
Etapa B (L2 real)  →  POARTĂ DE MĂSURARE  →  Etapa D (fail-closed)
```

**Dacă poarta de la finalul Etapei B nu trece, Etapa D NU se aplică.**
Un fail-closed peste un L2 care încă nu funcționează transformă fiecare
semnătură STS în „invalidă" pe un document oficial — un fals negativ, la fel
de greșit ca falsul pozitiv de azi.

Nu „compensa" un L2 care nu iese slăbind formula. Oprește-te și raportează.

---

## PASUL 0 — ancore (nu modifica nimic)

```bash
git branch --show-current           # develop
git status --short
grep -n '"version"' package.json    # 3.9.805
```

```bash
grep -n "sd.verify" server/services/certificate-verify.mjs          # aștept 1 (linia ~213)
grep -n "const ab " server/services/certificate-verify.mjs          # aștept 1 (linia ~179)
grep -n "issuerAndSerialNumber" server/services/certificate-verify.mjs  # aștept ~242-243
grep -c "ok !== false" server/services/certificate-verify.mjs       # aștept 2
grep -n "^export" server/verify.mjs                                 # aștept 9 exporturi
```

Verificarea absenței ciclului de import — **obligatorie înainte de Etapa B**:

```bash
grep -n "certificate-verify" server/verify.mjs   # aștept 0
```

`verify.mjs` NU trebuie să importe `certificate-verify.mjs`. Dacă apare ceva,
oprește-te: cablarea propusă ar crea un ciclu.

---

## ETAPA A — caracterizare, înainte de orice modificare (obligatorie)

Pe fixtura `server/tests/fixtures/sts-signed-staging.pdf`, rulează **ambele**
motoare și raportează tabelul complet:

| motor | L1 | L2 | L3 | L4 | L5 | L6 | isValid |
|---|---|---|---|---|---|---|---|
| `verify.mjs` (public) | | | | | | | |
| `certificate-verify.mjs` (Raport) | | | | | | | |

Valori exacte: `true` / `false` / `null`. Plus, pentru al doilea motor:

- ⭐ ce face azi `sd.verify` — întoarce `false`, sau **aruncă**? Dacă aruncă,
  mesajul exact al excepției.
- ce notă are L2 pe ecran.
- ce ramură de selecție a prins semnatarul (metoda 1, 2 sau fallback).

⭐⭐ **Ancora de non-regresie a lotului:** motorul public (`verify.mjs`) trebuie
să iasă la final **identic** cu rândul lui de aici. Lotul nu-l atinge; dacă se
schimbă, ceva a fost cablat greșit.

Nu trece la Etapa B fără tabelul ăsta în raport.

---

## ETAPA B — L2 real în `certificate-verify.mjs`

**B1 — importă, nu duplica.** `verify.mjs` exportă deja tot ce trebuie:

```js
import {
  _selectSignerCert, _sigAlgInfo, _curveFromSpki, ecdsaDerToRaw, computeVerdict
} from '../verify.mjs';
```

⛔ Nu copia tabelele `SIG_ALGS` / `EC_CURVES` / `DIGEST_ALGS` în al doilea
fișier. Două copii ale aceleiași tabele diverg — e exact datoria tehnică pe
care o avem deja la mapperele XSD.

**B2 — datele semnate se reconstituie corect.** Oglindește logica din
`verify.mjs` (liniile ~420-428): când `signedAttrs` există, datele semnate sunt
**DER-ul atributelor semnate** cu tagul implicit `[0]` (`0xa0`) înlocuit cu
`SET` (`0x31`) conform RFC 5652 — **nu** `hashData` și **nu** bufferul CMS.
Când `signedAttrs` lipsește, datele sunt conținutul semnat.

**B3 — înlocuiește blocul L2.** `old_str`:

```js
    result.levels.L2 = { name: 'Semnătură CMS/PKCS#7', ok: null, note: 'Parsare reușită' };
    try {
      const verOk = await sd.verify({ signer: 0, data: ab, extendedMode: true, checkChain: false });
      result.levels.L2.ok   = verOk === true || verOk?.signatureVerified === true;
      result.levels.L2.note = result.levels.L2.ok ? 'Semnătură criptografică validă' : 'Semnătură invalidă';
    } catch(e) {
      result.levels.L2.ok   = null;
      result.levels.L2.note = 'Verificare parțială (context WebCrypto server)';
      result.warnings.push('Verificare CMS completă necesită contextul original al datelor semnate');
    }
```

`new_str`: verificarea manuală, în aceeași formă ca în `verify.mjs`:

- algoritmul REAL din `si.signatureAlgorithm` + `si.digestAlgorithm`, prin `_sigAlgInfo`;
- ECDSA: curba prin `_curveFromSpki` (⛔ **nu presupune P-256**), semnătura
  convertită prin `ecdsaDerToRaw(sigValue, curve.size)`, apoi `webcrypto.subtle.verify`;
- RSA: `RSASSA-PKCS1-v1_5` cu hash-ul real;
- RSA-PSS: `ok = null`, notă explicită „nesuportat" (paritate cu motorul public);
- algoritm sau curbă necunoscută: `ok = null`, notă explicită;
- `catch`: `ok = null` + notă cu mesajul scurtat.

⛔ `false` înseamnă „am verificat și NU se potrivește". `null` înseamnă „nu am
putut verifica". Nu le confunda niciodată, în nicio ramură.

⚠️ Blocul L2 se execută **înaintea** blocului L3, deci `signerCert` nu e încă
selectat acolo. Mută selecția semnatarului (Etapa C) ÎNAINTE de L2, sau
selectează certificatul în interiorul blocului L2. Raportează ce ai ales și de
ce — este singura restructurare de ordine permisă în acest lot.

### ⭐⭐ POARTA DE MĂSURARE — obligatorie, înainte de Etapa D

Rulează din nou motorul Raportului pe fixtură și raportează:

```
L2.ok = ?      L2.note = ?
```

- **`L2.ok === true`** ⇒ poarta e trecută, continuă cu Etapa D.
- **`L2.ok === false`** ⇒ OPREȘTE-TE. Semnătura fixturii este validă (motorul
  public o confirmă). `false` înseamnă că portarea are un defect — cel mai
  probabil datele semnate (B2) sau conversia DER→raw. Raportează, nu continua.
- **`L2.ok === null`** ⇒ OPREȘTE-TE. Raportează ramura exactă care a produs `null`.

---

## ETAPA C — selecția semnatarului pe emitent + serie

Azi (linia ~242) codul destructurează `issuer` și **nu îl folosește** —
potrivirea e doar pe număr de serie. Două certificate cu aceeași serie de la
emitenți diferiți se confundă tăcut.

Înlocuiește cele trei metode locale (issuer+serial parțial, euristica „nu e CA
/ nu e self / nu e OCSP", fallback `certs[0]`) cu apelul partajat:

```js
const _sel = _selectSignerCert(sd, certs, pkijs);
const signerCert = _sel.cert;
```

- `_sel.branch === 4` (fallback pe `certs[0]`) ⇒ pune o notă de aproximare pe
  L3 și un `warning`, ca în motorul public. Nu-l lăsa mut.
- Raportează ce ramură prinde fixtura ACUM față de ce prindea în Etapa A.

⚠️ Verifică semnătura reală a lui `_selectSignerCert` în `verify.mjs:101`
înainte de a o apela — primul parametru este obiectul `SignedData`. Dacă
diferă de ce scriu aici, folosește forma reală și raportează diferența.

---

## ETAPA D — fail-closed, DOAR dacă poarta a trecut

Acum, și numai acum, formula devine identică cu cea a motorului public:

`old_str`
```js
  result.isValid =
    result.levels.L1?.ok !== false &&
    result.levels.L2?.ok !== false &&
    result.levels.L3?.ok === true;
```
`new_str`
```js
  // #147 — aceeași formulă ca motorul public, prin funcția partajată. `null`
  // (nu am putut verifica) nu mai contribuie la un verdict pozitiv. L4 și L5
  // rămân DELIBERAT în afara formulei — vezi comentariul din verify.mjs.
  result.isValid = computeVerdict(result.levels);
```

Și L1 pe ramura fără atribut (linia ~206) — singura rămășiță fail-open:

`old_str`
```js
      result.levels.L1 = { name: 'Integritate document', ok: true, note: 'Hash intact (atribut msgDigest absent)' };
```
`new_str`
```js
      // #147 — fail-closed: absența atributului nu dovedește integritatea.
      result.levels.L1 = { name: 'Integritate document', ok: null, note: 'Neconcludent — atributul messageDigest lipseste din CMS' };
```

```bash
grep -c "ok !== false" server/services/certificate-verify.mjs   # 0
```

---

## ETAPA E — două afirmații nedovedite, văzute pe ecran la smoke-testul #149

**E1 — nota de la L5.** Ecranul public afișează azi:
„URL OCSP nedisponibil în certificat — validitate confirmată prin QcStatements și L6".

QcStatements descrie **calificarea certificatului**; nu spune nimic despre
**revocare**. Este exact clasa de afirmație pe care #149 a curățat-o, rămasă
lângă L4-ul reparat. Găsește șirul prin grep (poate fi în `verify.mjs` sau în
`certificate-verify.mjs` — verifică ambele) și reformulează-l ca observație:
starea de revocare rămâne **neverificată** când nu există URL OCSP.

⛔ Nu schimba `L5.ok` și nu-l introduce în formulă. Doar textul.

**E2 — „DATA SEMNĂRII —".** Ambele documente reale afișează liniuță: STS nu
pune atributul `signingTime` în CMS (conform PAdES, care preferă marca
temporală). Afișează un text explicit în locul liniuței — „nedeclarată în
semnătură" sau echivalent — în loc să pară un câmp care lipsește din eroare.

---

## ETAPA F — REPORT-ONLY, nu repara

Măsoară și raportează, fără să modifici:

1. `certificate-verify.mjs:~285` calculează `validAtSigning` cu
   `result.signingTime || new Date()`. Când `signingTime` lipsește (adică
   întotdeauna, vezi E2), validitatea se evaluează la **momentul curent**, nu
   la momentul semnării. Motorul public nu are acest fallback. Câte semnături
   din fixtură sunt afectate și ce ar arăta fără fallback?
2. `si` (linia 194) și `si0` (linia 239) sunt două variabile pentru aceeași
   valoare. Confirmă că sunt identice și că nicio ramură nu le folosește
   divergent.

---

## ETAPA G — teste

**G1 — pinning-ul de la #149 trebuie să devină ROȘU și să fie rescris.**
Testul care asertează azi „`certificate-verify.mjs` păstrează formula veche:
L1 `null` + L2 `null` + L3 `true` ⇒ `isValid === true`, stare intenționată
până la #147" își atinge scopul acum. **Rescrie-l**, nu-l șterge: aceeași
combinație trebuie să dea acum `isValid === false`.

Raportează explicit că a devenit roșu înainte de rescriere — e dovada că
pinning-ul a funcționat.

**G2 — fișier nou** `server/tests/unit/trust-report-crypto.test.mjs`:

1. ⭐⭐ fixtura reală ⇒ `L2.ok === true` în motorul Raportului. **Cade pe codul
   vechi** (azi e `null`). Ancora lotului.
2. ⭐⭐ un octet inversat în ByteRange ⇒ `L1.ok === false` **și**
   `isValid === false`.
3. ⭐ `L1 true` + `L2 null` + `L3 true` ⇒ `isValid === false`.
4. ⭐ `L5 null` cu L1/L2/L3 `true` ⇒ `isValid === true` — pinuiește scopul,
   la fel ca în #149.
5. ⭐⭐ selecția: două certificate cu **aceeași serie**, emitenți diferiți ⇒
   se alege cel cu emitentul corect. **Cade pe codul vechi.**
6. ⭐ ambele motoare dau **același** `isValid` pe fixtură — testul de paritate
   care împiedică redivergența.

```bash
npm test
npm run test:db
```

⚠️ Înainte de `test:db`: omoară rulările anterioare și recreează baza.
O rulare expirată care încă trăiește lovește aceeași bază și produce eșecuri
fantomă (`fileParallelism:false` e per-proces, nu între procese) — s-a
întâmplat la #149, cu 76 de eșecuri care nu existau.

Dacă lipsește Docker: **nu e motiv de skip** — instanță PG efemeră pe 55433.

---

## PASUL FINAL

```bash
# package.json: 3.9.805 → 3.9.806
git status --short          # NICIODATĂ `git add -A`
git add server/services/certificate-verify.mjs \
        server/verify.mjs \
        server/tests/unit/trust-report-crypto.test.mjs \
        <fisierul de pinning rescris> \
        package.json
git diff --cached --stat
git commit -m "fix(#147): nucleu criptografic verificat in motorul Raportului de incredere + fail-closed (v3.9.806)"
git push origin develop
```

Dacă ai atins `verify.mjs`, justifică fiecare linie — lotul ar trebui să-l
atingă cel mult pentru șirul de la E1.

---

## RAPORT FINAL

1. Branch, versiune, ancorele din PASUL 0 cu cifrele reale + confirmarea
   absenței ciclului de import.
2. ⭐⭐ Tabelul din Etapa A (ambele motoare, înainte).
3. ⭐⭐ Ce face azi `sd.verify` — întoarce sau aruncă, cu mesajul exact.
4. ⭐⭐ **Poarta de măsurare:** `L2.ok` și nota, după Etapa B.
5. Ce ai ales la restructurarea de ordine L2/L3 și de ce.
6. Etapa C: ce ramură prinde fixtura acum vs. în Etapa A.
7. ⭐⭐ Tabelul din Etapa A refăcut DUPĂ tot lotul, ambele motoare. Motorul
   public trebuie să fie identic cu rândul lui inițial.
8. Etapa E: unde erau cele două șiruri și cum arată acum.
9. ⭐ Etapa F: cele două constatări, măsurate.
10. ⭐⭐ Confirmarea că pinning-ul de la #149 a devenit roșu, apoi rescris.
11. `npm test` / `npm run test:db` — cifre, PASSED REAL, zero skipped.
12. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- **Ordinea B → poartă → D este obligatorie.** Fail-closed peste un L2
  nefuncțional = fals negativ pe acte oficiale.
- Zero duplicare de tabele de algoritmi/curbe — se importă din `verify.mjs`.
- `false` ≠ `null`. Nicio ramură nu le confundă.
- L4 și L5 NU intră în formula verdictului.
- Motorul public trebuie să iasă identic cu Etapa A.
- Niciun PDF nou în repo.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
