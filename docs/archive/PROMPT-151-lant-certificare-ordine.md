# PROMPT #151 — lanțul de certificare, construit prin emitent (motorul public)

> ⚠️ **BRANCH: `develop`.** Niciun `checkout`, `merge` sau `push` spre `main`.
> Dacă `git branch --show-current` nu arată `develop`, OPREȘTE-TE.

- **Model recomandat:** Sonnet 5 (efort mediu)
- **versiune_start:** 3.9.807
- **versiune_tinta:** 3.9.808
- **Migrații:** ZERO
- **CACHE_VERSION:** lot server-side — probabil NU; se decide pe dovadă

---

## DE CE

La #149 am introdus regula „un lanț cu rădăcina dedusă nu e un lanț verificat"
și am gătat-o pe câmpul `isInferred`. **Câmpul e calculat greșit**, iar regula
a fost construită peste eroare. Rezultatul e în producție de la v3.9.805:
pagina publică scrie „Neconcludent — rădăcina lanțului e dedusă" pe documente
al căror lanț **este** complet.

Cauza, `server/verify.mjs:565-593`:

1. Lanțul se construiește iterând `certs` **în ordinea din CMS**, nu urmărind
   emitentul. Ordinea din CMS nu e garantată leaf→root.
2. Testul „lipsește rădăcina?" se aplică doar **ultimului element al listei**.
   Cum acela e de obicei CA-ul intermediar, codul fabrică o rădăcină „dedusă",
   deși rădăcina reală se află deja în listă, pe altă poziție.

Măsurat la #150: motorul Raportului construiește corect 3 certificate,
niciunul dedus; motorul public construiește 4, cu al 4-lea `isInferred: true`
— un **duplicat** al rădăcinii deja prezente.

⚠️ Deducerea rămâne **legitimă** când rădăcina chiar lipsește: în `verify.mjs`,
`certs` (linia 375) conține DOAR certificatele din CMS, fără bundle-ul de
CA-uri de încredere. Fixul nu elimină deducerea — o face condiționată de
absența reală.

---

## PASUL 0 — ancore

```bash
git branch --show-current           # develop
git status --short
grep -n '"version"' package.json    # 3.9.807
grep -n "const certs = signedData.certificates" server/verify.mjs    # aștept ~375
grep -n "isInferred" server/verify.mjs                              # aștept 2
grep -n "_findIssuerCert" server/verify.mjs                         # exportat la ~143
grep -n "drawKV('Algoritm semnatura'" server/services/sign-trust-report.mjs
```

---

## ETAPA A — măsoară lanțul de azi (nu modifica nimic)

Pe `server/tests/fixtures/sts-signed-staging.pdf`, raportează pentru
`verify.mjs`:

1. ⭐ Câte certificate are `signedData.certificates` și **în ce ordine** apar
   (CN-ul fiecăruia, în ordinea din CMS).
2. Care dintre ele este self-signed (subiect DER === emitent DER).
3. Ce conține `result.chain` acum: câte intrări, care are `isInferred: true`,
   și dacă CN-ul intrării deduse **coincide** cu al unui certificat deja
   prezent în listă (asta e dovada duplicării).
4. `L4.ok` și nota afișată.

Fără tabelul ăsta nu treci mai departe.

---

## ETAPA B — construiește lanțul urmărind emitentul

Înlocuiește bucla care iterează `certs` în ordinea din CMS cu o urcare de la
semnatar spre rădăcină, folosind unealta care există deja:

```js
_findIssuerCert(cert, certs, pkijs)   // verify.mjs:143 — compară DER subiect vs DER emitent
```

Reguli:

- **Pornește de la `signerCert`**, nu de la `certs[0]`.
- Urcă din emitent în emitent cât timp `_findIssuerCert` întoarce ceva.
- **Oprire pe self-signed**: când subiectul DER === emitentul DER, vârful e
  atins; lanțul e închis. Nu mai deduce nimic.
- ⛔ **Protecție la buclă obligatorie**: mulțime de vizitate (pe DER-ul
  subiectului, nu pe CN) **și** o limită dură de adâncime (10). Certificatele
  încrucișat-semnate pot cicla; celălalt motor are deja acest tipar.
- **Deducerea se păstrează** doar dacă vârful atins NU e self-signed **și**
  `_findIssuerCert` nu găsește emitentul în `certs`. Doar atunci se adaugă
  intrarea cu `isInferred: true`, ca azi.

Regula L4 rămâne cea de la #149, neschimbată ca formă:

```js
const _chainInferred = chain.some(c => c.isInferred === true);
result.levels.L4.ok = chain.length >= 2 ? (_chainInferred ? null : true) : false;
```

⚠️ **Schimbare de semantică de raportat:** azi `chain` conține TOATE
certificatele din CMS; după fix conține doar **calea reală**. Un certificat
prezent în CMS dar din afara căii (de ex. un certificat de răspuns OCSP) nu va
mai apărea în lista „Lanț de certificare" de pe ecran. Este corect, dar e o
schimbare vizibilă — măsoar-o pe fixtură și raporteaz-o.

⛔ L4 NU intră în formula verdictului. `computeVerdict` nu se atinge.

---

## ETAPA C — eticheta contradictorie din §3 al Raportului

`sign-trust-report.mjs:475` tipărește:

```js
drawKV('Algoritm semnatura', c.signatureAlgorithm);
```

Sursa (`certificate-verify.mjs:515`) e `cert.signatureAlgorithm` — algoritmul
cu care **CA-ul a semnat certificatul**, nu cel al semnăturii de pe document.
Pe un raport real §3 afișează `sha256WithRSAEncryption` în timp ce §4 afișează
corect „ECDSA P-256/SHA-256": două afirmații aparent contradictorii.

Valoarea e corectă; eticheta e înșelătoare. Reformuleaz-o ca să spună clar că
descrie **certificatul**, nu semnătura documentului.

⛔ Nu schimba valoarea și nu o înlocui cu algoritmul semnăturii — sunt două
informații diferite, ambele utile.

---

## ETAPA D — testul de paritate de la #150/C3 se inversează

Testul scris la #150 **documentează** azi divergența `L4.ok` (public `null`,
Raport `true`) și explică bug-ul de ordine. După Etapa B divergența dispare.

Rescrie-l ca test de **paritate**: pe fixtură, `L4.ok` trebuie să fie identic
în cele două motoare. Păstrează în comentariu istoricul (ce a fost, de ce, ce
înseamnă dacă redevine roșu) — e memoria instituțională a bug-ului.

⛔ Nu-l șterge și nu-l relaxa la „oricare din două".

---

## ETAPA E — teste noi

`server/tests/unit/verify-chain-order.test.mjs`:

1. ⭐⭐ Fixtura reală ⇒ `L4.ok === true` și **niciun** element cu
   `isInferred: true`. **Cade pe codul vechi.** Ancora lotului.
2. ⭐⭐ Certificate date în ordine amestecată (root, leaf, intermediar) ⇒
   lanțul iese ordonat leaf→root și tot fără deducere. Ăsta e chiar bug-ul.
3. ⭐ Rădăcină ABSENTĂ din listă ⇒ deducerea se păstrează, `isInferred: true`,
   `L4.ok === null`. Confirmă că n-am eliminat comportamentul legitim.
4. ⭐ Un certificat din CMS în afara căii ⇒ nu apare în `chain`.
5. ⭐⭐ Protecția la buclă: două certificate care se emit reciproc ⇒ funcția se
   oprește, nu blochează procesul. Pune un timeout pe test.
6. ⭐ Un singur certificat, self-signed ⇒ `chain.length === 1`, `L4.ok === false`.

```bash
npm test
npm run test:db
```

⚠️ Înainte de `test:db`: omoară rulările anterioare și recreează baza — o
rulare expirată care încă trăiește produce eșecuri fantomă.

---

## PASUL FINAL

```bash
# package.json: 3.9.807 → 3.9.808
git status --short          # NICIODATĂ `git add -A`
git add <fișierele atinse> package.json
git diff --cached --stat
git commit -m "fix(#151): lantul de certificare construit prin emitent, nu prin ordinea CMS (v3.9.808)"
git push origin develop
```

---

## RAPORT FINAL

1. Branch, versiune, ancorele din PASUL 0.
2. ⭐⭐ Etapa A: ordinea certificatelor în CMS, care e self-signed, ce conținea
   `chain`, și confirmarea că intrarea dedusă era un DUPLICAT.
3. ⭐⭐ Etapa B: `chain` după fix — câte intrări, în ce ordine, `isInferred`
   pe vreuna, `L4.ok`.
4. ⭐ Schimbarea de semantică: a dispărut vreun certificat din lista afișată?
5. Etapa C: eticheta veche și cea nouă.
6. Etapa D: testul de paritate rescris — trece?
7. ⭐ Etapa E: cazul 3 (rădăcină absentă) și cazul 5 (buclă) — ce au dat.
8. `npm test` / `npm run test:db` — cifre, PASSED REAL, zero skipped.
9. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- Deducerea rădăcinii se PĂSTREAZĂ când rădăcina lipsește cu adevărat.
- Protecție la buclă obligatorie (vizitate pe DER + adâncime maximă).
- L4 NU intră în formula verdictului; `computeVerdict` neatins.
- `certificate-verify.mjs` nu se atinge în acest lot (doar eticheta din
  `sign-trust-report.mjs` la Etapa C).
- Niciun PDF nou în repo.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
