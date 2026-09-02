# PROMPT #149 — „nu afirma ce n-ai dovedit": fail-closed în ambele motoare de verificare

> ⚠️ **BRANCH: `develop`.** Niciun `checkout`, `merge` sau `push` spre `main`.
> Dacă `git branch --show-current` nu arată `develop`, OPREȘTE-TE.

- **Model recomandat:** Opus 5
- **versiune_start:** 3.9.804
- **versiune_tinta:** 3.9.805
- **Migrații:** ZERO
- **CACHE_VERSION:** se decide pe dovadă la PASUL 0 (vezi mai jos)

---

## DE CE

Un audit extern pe v3.9.804 a găsit o clasă de defect pe care o confirmăm pe cod:
motoarele de verificare transformă „nu am putut verifica" în „valid".

Concret, în **ambele** motoare verdictul se calculează cu `ok !== false`, iar
`null` (necunoscut) trece drept adevărat. În plus, `verify.mjs` scrie explicit
`true` pe integritate în ramura `else` și în `catch`.

Consecința: pagina publică de verificare și Raportul de încredere pot declara
un document valid fără să fi confirmat nimic. Pe o pagină folosită de o
primărie pentru acte administrative, asta e o afirmație falsă, nu o imprecizie.

Lotul repară afirmația. **NU** repară motorul criptografic din
`certificate-verify.mjs` — aceea e treaba lui #147 și zona respectivă e
NO-TOUCH aici.

---

## ⛔ REGULA CENTRALĂ A LOTULUI, CITEȘTE-O DE DOUĂ ORI

Fail-closed se aplică **strict** pe L1 (integritate), L2 (semnătură CMS) și
L3 (certificat semnatar) — exact cele trei care compun deja verdictul.

**L5 (OCSP/CRL) rămâne în afara verdictului, așa cum e azi.** În practică L5
este `null` la majoritatea documentelor reale (OCSP indisponibil sau
neîncercat). Dacă îl introduci în formulă, transformi fiecare document al
primăriei în „neconcludent" — o supra-corecție mai gravă decât bug-ul.

**L4 nu intră în verdict** (nu e nici azi). Se repară doar afirmația afișată.

Dacă la un moment dat ai impresia că „ar fi mai riguros" să incluzi L5 sau L4:
NU. Raportează observația la punctul 11 din raport și mergi mai departe.

---

## PASUL 0 — verificarea ancorelor (nu modifica nimic)

```bash
git branch --show-current          # trebuie: develop
git status --short                 # notează ce e deja modificat/netrackuit
grep -n '"version"' package.json   # trebuie: 3.9.804
```

Ancorele. Rulează-le și **raportează cifrele REALE**, nu pe cele de mai jos —
dacă diferă, oprește-te și raportează:

```bash
grep -c "result.levels.L1.ok = true" server/verify.mjs        # aștept 3
grep -c "ok !== false" server/verify.mjs                      # aștept 2
grep -c "ok !== false" server/services/certificate-verify.mjs # aștept 2
grep -n "chain.length >= 2" server/verify.mjs                 # aștept 1 linie
grep -c "OID_ECDSA" server/verify.mjs                         # aștept 1 (mort)
grep -c "hasQcStatements" server/services/sign-trust-report.mjs # aștept 2
```

Decizia de cache:

```bash
grep -n "PRECACHE_ASSETS" -A 40 public/sw.js | grep -n "verifica"
```

Dacă `verifica.js` **nu** apare în listă, `CACHE_VERSION` NU se bumpează și
motivezi asta în raport pe baza acestui grep. Nu presupune în niciun sens.

---

## ETAPA A — caracterizare ÎNAINTE de orice modificare (obligatorie)

Scop: avem o linie de bază măsurată, nu presupusă. Fără ea nu putem dovedi
non-regresia.

Rulează motorul public pe fixtura din repo și **notează ieșirea de azi**:

```
server/tests/fixtures/sts-signed-staging.pdf
```

Raportează, pentru fiecare semnătură: `L1.ok`, `L2.ok`, `L3.ok`, `L4.ok`,
`L5.ok`, `L6.ok`, `isValid`, `isQES` — cu valorile exacte (`true` / `false` /
`null`), nu „ok" / „nu".

⭐ **Aceasta e ancora de non-regresie a întregului lot.** Documentul are o
singură semnătură ECDSA validă cu atribut `messageDigest` prezent ⇒ după
modificări trebuie să iasă **identic**: `isValid: true`. Dacă iese altfel,
modificarea e greșită, nu fixtura.

Nu trece la Etapa B fără tabelul ăsta în raport.

---

## ETAPA B — `server/verify.mjs`: integritatea nu se mai presupune

Trei atribuiri scriu `true` pe L1 atunci când codul **nu a putut** verifica.
Toate trei devin `null` cu notă explicativă.

⚠️ `result.levels.L1` e inițializat cu `ok: null` la linia ~328, deci `null`
este deja o valoare așteptată în structură — nu introduci un tip nou.

**B1** — lipsa atributului `messageDigest`:

`old_str`
```js
          } else {
            result.levels.L1.ok = true; // presupunem intact dacă nu găsim atribut
          }
```
`new_str`
```js
          } else {
            // #149 — fail-closed: absența atributului nu dovedește integritatea.
            result.levels.L1.ok   = null;
            result.levels.L1.note = 'Neconcludent — atributul messageDigest lipseste din CMS';
          }
```

**B2** — lipsa conținutului încapsulat:

`old_str`
```js
        } else {
          result.levels.L1.ok = true;
        }
      } catch { result.levels.L1.ok = true; }
```
`new_str`
```js
        } else {
          // #149 — fail-closed: nu am avut ce compara.
          result.levels.L1.ok   = null;
          result.levels.L1.note = 'Neconcludent — continut CMS indisponibil pentru comparare';
        }
      } catch (e) {
        // #149 — fail-closed: o eroare de parsare NU e o dovada de integritate.
        result.levels.L1.ok   = null;
        result.levels.L1.note = 'Neconcludent — eroare la verificarea integritatii';
      }
```

**B3** — formula verdictului:

`old_str`
```js
    const l1ok = result.levels.L1?.ok !== false;
    const l2ok = result.levels.L2?.ok !== false;
    const l3ok = result.levels.L3?.ok === true;
```
`new_str`
```js
    // #149 — fail-closed. `null` inseamna „nu am putut verifica" si NU mai
    // contribuie la un verdict pozitiv. L5 (OCSP) ramane DELIBERAT in afara
    // formulei: e `null` la majoritatea documentelor reale, iar includerea lui
    // ar marca neconcludent tot ce trece azi corect.
    const l1ok = result.levels.L1?.ok === true;
    const l2ok = result.levels.L2?.ok === true;
    const l3ok = result.levels.L3?.ok === true;
```

Verificare:

```bash
grep -c "result.levels.L1.ok = true" server/verify.mjs   # 0
grep -c "ok !== false" server/verify.mjs                 # 0
```

---

## ETAPA C — `server/verify.mjs`: lanțul nu se mai declară pe lungime

Azi: `result.levels.L4.ok = chain.length >= 2`, iar ultimul element poate fi
adăugat de noi cu `isInferred: true` — adică dedus din numele emitentului, nu
verificat. Asta dovedește cel mult că certificatul **își declară** un emitent.

`old_str`
```js
        result.levels.L4.ok = chain.length >= 2; // minim cert + CA
```
`new_str`
```js
        // #149 — un lanț a cărui rădăcină e DEDUSĂ din numele emitentului nu e
        // un lanț verificat. Nu-l mai declarăm `true`; `null` = neconcludent.
        // (L4 nu intră în `isValid` — nici azi, nici după acest lot.)
        const _chainInferred = chain.some(c => c.isInferred === true);
        result.levels.L4.ok = chain.length >= 2 ? (_chainInferred ? null : true) : false;
        if (_chainInferred) {
          result.levels.L4.note = 'Neconcludent — rădăcina lanțului e dedusă, nu verificată criptografic';
        }
```

⚠️ Verifică pe cod că obiectele din `chain` chiar poartă cheia `isInferred`
(există la liniile ~549 și ~562). Dacă numele cheii diferă, folosește-l pe cel
real și raportează diferența.

---

## ETAPA D — ⛔ MUTATĂ LA #147, NU O FACE AICI

Motorul Raportului de încredere (`certificate-verify.mjs`) are **identic**
aceeași formulă fail-open. Tentația e s-o repari în același lot. **NU.**

Motiv, verificat pe cod: L2 din acel motor cade azi în `catch` pe **fiecare**
semnătură ECDSA (`sd.verify`, nota „Verificare parțială (context WebCrypto
server)", `ok: null`). Cu formula strânsă acum, `isValid` ar deveni `false`
pe toate semnăturile STS, iar Raportul de încredere le-ar tipări ca
**invalide** — un fals negativ pe un document oficial. „Nu am verificat" nu
înseamnă „invalid", exact cum nu înseamnă „valid".

Ordinea corectă: **#147** dă acelui motor o verificare ECDSA reală, și abia
după aceea formula devine fail-closed acolo. Este parte obligatorie din #147.

În acest lot, `certificate-verify.mjs` se atinge **exclusiv** pentru E2 (un
câmp nou, inert). Formula lui `isValid` rămâne **NEATINSĂ**:

```bash
git diff -- server/services/certificate-verify.mjs | grep -c "isValid"   # 0
```

---

## ETAPA E — cele două afirmații nedovedite din Raportul de încredere

**E1** — eticheta QcStatements. Azi `sign-trust-report.mjs` tipărește
„Prezent (QES confirmed)" pe simpla **prezență** a extensiei, iar sursa
(`certificate-verify.mjs`) o calculează ca test de existență. Exact afirmația
demontată la #144.

`old_str`
```js
      drawKV('QcStatements', c.hasQcStatements ? 'Prezent (QES confirmed)' : 'Absent');
```
`new_str`
```js
      // #149 — prezența extensiei NU confirmă calificarea; calificarea vine din
      // evaluarea pe dovadă (#144). Eticheta descrie doar ce s-a observat.
      drawKV('QcStatements', c.hasQcStatements ? 'Prezent' : 'Absent');
```

**E2** — marca temporală optimistă. `_detectPdfTimestampFeatures` caută șirul
`/DocTimeStamp` în tot fișierul ca text binar, iar `hasTsAttr` verifică doar
**prezența** atributului RFC 3161 — niciun token nu e validat. Din asta iese
azi `padesLevel: 'B-T'` și `ltv_ready`.

Nu construim validare de token în acest lot. Facem afirmația onestă: adaugă în
`certificate-verify.mjs`, imediat după calculul `hasTimestamp` (blocul E1 de la
#144, în jurul liniei ~437), o notă care marchează nivelul ca **nevalidat**:

```js
      // #149 — marca temporală e DETECTATĂ, nu VALIDATĂ: nu verificăm tokenul
      // RFC 3161 și nici lanțul TSA. Nivelul declarat e o observație.
      result.timestampValidated = false;
```

și în `sign-trust-report.mjs`, oriunde se tipărește nivelul PAdES, sufixul
„(detectat, nevalidat)" când `timestampValidated !== true`. Găsește locul real
prin grep pe `padesLevel` și raportează unde ai intervenit — nu inventa
o funcție de desenare care nu există.

---

## ETAPA F — două curățenii mici, în același șantier

**F1** — garda mea de la #144 e prea largă. `qes-claim-wiring.test.mjs` prinde
orice `isQES = …` și interzice `||` în el, deci blochează și cod legitim (a
forțat deja un `Boolean(...)` inutil). Strânge-o: să se aplice **doar** când
`||` apare între cei doi operanzi slabi de dinainte de #144 (nume QTSP /
prezența extensiei), nu la orice apariție.

Testul de mai jos trebuie să treacă după strângere — scrie-l ca dovadă:
o atribuire de forma `isQES = qc.isQES === true || qc.isQES === 1` (legitimă,
fără operanzi slabi) NU mai declanșează garda.

**F2** — `OID_ECDSA` (linia ~25 din `verify.mjs`) e declarat și nefolosit; l-a
înlocuit tabelul `SIG_ALGS`. Șterge linia.

```bash
grep -c "OID_ECDSA" server/verify.mjs   # 0
```

---

## ETAPA G — teste

Fișier nou: `server/tests/unit/verify-fail-closed.test.mjs`

Cazuri (⭐ = obligatoriu să pice pe codul VECHI):

1. ⭐⭐ L1 `null` + L2 `true` + L3 `true` ⇒ `isValid === false`.
2. ⭐⭐ L2 `null` (algoritm necunoscut) + restul `true` ⇒ `isValid === false`.
3. ⭐ L1/L2/L3 toate `true` ⇒ `isValid === true`.
4. ⭐⭐ **L5 `null` cu L1/L2/L3 `true` ⇒ `isValid === true`** — pinuiește
   decizia de scop; dacă cineva adaugă L5 în formulă, testul cade.
5. ⭐ lanț cu `isInferred: true` ⇒ `L4.ok === null`, iar `isValid` **nu** se
   schimbă din cauza asta.
6. ⭐⭐ fixtura reală `sts-signed-staging.pdf` ⇒ `isValid === true`,
   identic cu tabelul din Etapa A. **Ancora de non-regresie.**
7. ⭐ `certificate-verify.mjs` păstrează formula veche — caz de pinning:
   L1 `null` + L2 `null` + L3 `true` ⇒ `isValid === true` acolo, DELIBERAT,
   până la #147. Testul documentează starea intermediară ca fiind intenționată.

⛔ Nu cădea pe analiză statică cu regex dacă nu poți instanția rezultatul —
raportează în schimb.

```bash
npm test         # verde
npm run test:db  # PASSED REAL — „skipped" nu e „passed"
```

Dacă lipsește Docker: **nu e motiv de skip.** Folosește instanța PG efemeră
(`initdb` + `pg_ctl` pe port 55433) documentată în `CLAUDE.md`.

---

## PASUL FINAL

```bash
# package.json: 3.9.804 → 3.9.805
# ?v= țintit pe verifica.js DOAR dacă l-ai atins (probabil NU — lotul e server-side)
# CACHE_VERSION: conform dovezii din PASUL 0

git status --short        # NICIODATĂ `git add -A`
git add server/verify.mjs \
        server/services/certificate-verify.mjs \
        server/services/sign-trust-report.mjs \
        server/tests/unit/verify-fail-closed.test.mjs \
        server/tests/unit/qes-claim-wiring.test.mjs \
        package.json
git diff --cached --stat
git commit -m "fix(#149): fail-closed in ambele motoare de verificare; null nu mai devine valid (v3.9.805)"
git push origin develop
```

Verificare că nu ai intrat în zona lui #147:

```bash
git diff -- server/services/certificate-verify.mjs | grep -c "signerCert\|ecdsaDerToRaw\|sd.verify\|issuerAndSerial\|isValid"   # 0
```

---

## RAPORT FINAL

1. Branch, versiune de start, ancorele din PASUL 0 cu **cifrele reale**.
2. ⭐⭐ Tabelul din Etapa A (linia de bază, înainte de modificări).
3. ⭐⭐ Același tabel DUPĂ modificări — și confirmarea că `isValid` a rămas
   `true` pe fixtura de staging.
4. ⭐⭐ Etapa D: confirmarea, cu diff-ul în mână, că
   încredere și de ce. Cifra exactă, fără atenuări.
5. Etapa C: cheia `isInferred` chiar există? Pe ce linii.
6. Etapa E2: unde se tipărește `padesLevel` și unde ai pus sufixul.
7. Etapa F1: cum arată garda strânsă și ce a dat testul de control.
8. ⭐ Ce ar fi raportat codul VECHI pe cazurile 1, 2 și 4.
9. `CACHE_VERSION` — bumpat sau nu, pe ce dovadă.
10. `npm test` / `npm run test:db` — cifre, PASSED REAL.
11. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- **L5 NU intră în formula verdictului.** L4 NU intră în formula verdictului.
- În `certificate-verify.mjs` se atinge DOAR E2. Formula `isValid`, selecția
  certificatului, L2, lanțul și ECDSA sunt NO-TOUCH — toate sunt #147.
- `false` nu devine niciodată `null`, și `null` nu devine niciodată `true`.
- Fixtura de staging trebuie să iasă identic cu Etapa A.
- Niciun PDF nou în repo.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
