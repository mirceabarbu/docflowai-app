---
lot: "#145 — verificatorul public alege certificatul GREȘIT: fals negativ pe orice document semnat"
versiune_start: v3.9.802 (develop)
versiune_tinta: v3.9.803
model_suggested: Opus 5
migratii: 0
scriere_de_date: NU
fisiere_din_public: 0 (⇒ FĂRĂ CACHE_VERSION, FĂRĂ `?v=`)
severitate: producția afișează „Semnătură invalidă sau document modificat" pe acte administrative VALIDE
---

# ⚠️ BRANCH: develop

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.

# ⛔ ZONA NO-TOUCH

`cloud-signing.mjs`, `bulk-signing.mjs`, `STSCloudProvider.mjs`, `pades.mjs`,
`java-pades-client.mjs`. Lotul atinge EXCLUSIV calea de **verificare** (read-only).

---

## CONTEXT — defectul, măsurat, nu presupus

`POST /api/verify/signature` (pagina publică „Verificator Public") rulează prin
`server/verify.mjs`. La `verify.mjs:151`:

```js
const certs = signedData.certificates || [];
const signerCert = certs[0]; // primul cert = semnatarul
```

Comentariul e fals. În CMS, `certificates` e un **SET** (RFC 5652) — sac
neordonat. În PDF-urile produse de fluxul STS, primul element este **rădăcina**.

Măsurat pe un document real semnat în staging (o singură semnătură):

| # în sac | Subiect | CA | Cheie | Valabilitate | Serie |
|---|---|---|---|---|---|
| **[0]** | *fără CN*, O=STS | DA | **RSA** | 2017-05-04 → 2042-05-05 | `118a6d5eeb7f77e58a` |
| **[1]** | CN=Barbu Ilie-Mircea, O=UAT Zarnesti | nu | **EC secp256r1** | 2024-04-11 → 2027-04-11 | `801020018ecd4a7f05` |
| [2] | CN=STS Qualified CA II, O=STS | DA | RSA | 2022 → 2038 | `1015e4bdbb9061e09e79` |

- `signerInfos[0].sid` este `issuerAndSerialNumber`, cu seria
  **`801020018ecd4a7f05`** și emitentul **`STS Qualified CA II`** ⇒ arată fără
  ambiguitate spre **[1]**. Informația necesară E în document; codul n-o citește.
- algoritmul semnăturii este **`sha256_ecdsa`**.

Cascada, exact ce se vede pe ecran: se alege [0] (rădăcina) → cheia ei e RSA →
ramura `isRSA` din `verify.mjs:202` încearcă `RSASSA-PKCS1-v1_5` peste o
semnătură ECDSA → **„Semnătură RSA INVALIDĂ"** → banner roșu „Semnătură invalidă
sau document modificat". Câmpurile CN / EMIS DE / DATA SEMNĂRII apar goale
fiindcă rădăcina n-are CN, iar 2017–2042 e valabilitatea ei.

⚠️ Defectul e ÎN PRODUCȚIE (v3.9.801), independent de #144. #144 a schimbat doar
L6 din verde-fals (evalua conformitatea tot pe rădăcină) în roșu-corect.

### Al doilea defect, care iese la iveală abia după primul

Semnătura ECDSA din CMS e **DER** (`SEQUENCE{r,s}`, 70 octeți în documentul
măsurat). `webcrypto.subtle.verify` pentru ECDSA cere formatul **raw**,
`r||s` concatenate, fiecare pe exact dimensiunea curbei (32 octeți la P-256) ⇒
64 octeți. Fără conversie, `verify.mjs:210` întoarce `false` **chiar și cu
certificatul corect**, iar defectul ar părea nereparat.

Proiectul are deja tiparul invers (raw→DER) pe calea de semnare STS; aici e
nevoie de DER→raw.

### Dovada că reparația e suficientă

Cu certificatul [1] și semnătura convertită, semnătura documentului de staging
**se verifică VALID**, iar `messageDigest` din atributele semnate coincide cu
`sha256(ByteRange)`. Deci nu lipsește nimic altceva.

---

## PASUL 0 — ancore

```bash
git branch --show-current            # develop
grep '"version"' package.json        # 3.9.802
grep -n "primul cert = semnatarul" server/verify.mjs      # 1 linie (151)
grep -n "namedCurve: 'P-256'" server/verify.mjs           # 1 linie (~196)
grep -n "checkOCSP(signerCert, certs\[1\]" server/verify.mjs  # 1 linie (~349)
```

Dacă vreo ancoră diferă: **OPREȘTE-TE și raportează.**

---

## ETAPA A — fixtura reală (se face PRIMA, ca testul să existe înainte de fix)

Mircea pune documentul semnat în staging la
`server/tests/fixtures/sts-signed-staging.pdf`.

✅ **Se poate comite**: e un formular-tip de adeverință **necompletat** (câmpuri
punctate, „Primaria Test"), semnat de Mircea însuși. Nu conține date ale
vreunui cetățean. ⛔ Niciun alt PDF de producție nu intră în repo.

Adevărul de teren al fixturii, de folosit ca aserțiuni:

```
o singură semnătură · SubFilter ETSI.CAdES.detached · sha256_ecdsa · secp256r1
signer  CN = "Barbu Ilie-Mircea", O = "UAT Zarnesti", serie 801020018ecd4a7f05
L1 (messageDigest == sha256(ByteRange)) = adevărat
L2 (semnătură criptografică)            = VALID
qcStatements: 0.4.0.1862.1.1 / .1.4 / .1.5 / .1.6 / .1.6.1
politici:     0.4.0.194112.1.2 (QCP-n-qscd) + alte trei
key usage:    digitalSignature, contentCommitment(nonRepudiation), keyEncipherment
atribute semnate: content_type, message_digest, signing-certificate-v2
       (⚠️ signingTime LIPSEȘTE ⇒ padesLevel "B-B", ltv_ready false)
```

**Scrie ÎNTÂI testul din Etapa E1, rulează-l, arată-l ROȘU** (L2 invalid, CN
gol). Abia apoi Etapele B–D. Raportează eșecul inițial în raport — el e dovada
că testul chiar prinde defectul.

---

## ETAPA B — alegerea certificatului semnatar (`verify.mjs`)

Înlocuiește linia 151. Ordinea, strict:

1. **`sid` = `issuerAndSerialNumber`** → potrivește certificatul pe **AMBELE**:
   numărul de serie ȘI DN-ul emitentului. Compararea DN-ului se face pe **DER**
   (`toSchema().toBER()` pe ambele părți, comparație de octeți), nu pe șiruri
   reconstruite — ordinea RDN-urilor și codificarea (UTF8String vs
   PrintableString) nu se pot compara textual fără fals-negative.
2. **`sid` = `subjectKeyIdentifier`** → potrivește pe extensia `2.5.29.14` a
   certificatului.
3. **Euristică**: primul certificat care nu e CA (`basicConstraints.cA` fals sau
   extensia absentă), nu e auto-semnat, nu are „OCSP" în CN.
4. **Ultimă instanță**: `certs[0]`, ȘI în acest caz:
   `result.warnings.push('Certificatul semnatar nu a putut fi identificat din SignerInfo — verificare aproximativă')`
   plus `result.levels.L3.note` care spune același lucru.

⛔ Pasul 4 nu trebuie să fie tăcut niciodată. Tăcerea lui e chiar bug-ul de față.

Extrage selecția într-o funcție cu nume propriu (`_selectSignerCert(signedData, certs, pkijs)`)
și pune deasupra ei un comentariu care spune DE CE nu se ia primul: `certificates`
e un SET neordonat, iar în fișierele STS primul e rădăcina.

⚠️ `signerCert` e folosit apoi la L3, AIA/OCSP și L6 — o singură atribuire
corectă repară toate.

---

## ETAPA C — verificarea criptografică

**C1 — semnătura ECDSA: DER → raw.** Înainte de `subtle.verify`, dacă ramura e
ECDSA, convertește `sigValue`: parsează `SEQUENCE{ INTEGER r, INTEGER s }`,
scoate zerourile de aliniere ale INTEGER-ilor, apoi **stânga-completează** fiecare
cu zerouri până la dimensiunea curbei (32 / 48 / 66 octeți) și concatenează.
Dacă valoarea nu e o secvență DER validă, tratează-o ca fiind deja raw și
continuă (⛔ fără excepție aruncată).

**C2 — curba nu se mai presupune.** Azi `namedCurve: 'P-256'` e fix. Citește
parametrii cheii din `subjectPublicKeyInfo` și mapează:
`1.2.840.10045.3.1.7`→P-256, `1.3.132.0.34`→P-384, `1.3.132.0.35`→P-521.
Hash-ul rămâne SHA-256 dacă algoritmul semnăturii e sha256; dacă e alt digest,
folosește-l pe acela. Curbă necunoscută ⇒ `L2.ok = null` + notă explicită,
NICIODATĂ `false` (necunoscut ≠ invalid — aceeași regulă ca la #144).

**C3 — coerență cheie/semnătură.** Dacă algoritmul semnăturii din `signerInfos[0]`
e ECDSA iar cheia certificatului ales e RSA (sau invers), NU încerca verificarea:
`L2.ok = null`, notă „Algoritmul semnăturii nu corespunde cheii certificatului
selectat". Exact combinația de azi ar fi produs asta în loc de un fals „INVALIDĂ".

**C4 — textul notei** se derivă din algoritmul REAL folosit, nu dintr-un ternar
`isECDSA ? … : 'RSA'` care numește RSA orice nu e ECDSA.

---

## ETAPA D — emitentul pentru OCSP

`verify.mjs:~349` pasează `certs[1]` drept certificat emitent. Același viciu.
Înlocuiește cu certificatul al cărui **subiect** (DER) coincide cu **emitentul**
(DER) al lui `signerCert`; dacă nu se găsește, transmite `null` și lasă L5
`null` cu notă, ⛔ nu ghici.

---

## ETAPA E — teste

### E1 — `server/tests/unit/verify-signer-selection.test.mjs`

Pe fixtura reală, prin `verifyPdfSignatures` (capăt-la-capăt, nu pe funcții interne):

1. ⭐⭐ `L2.ok === true`. **Ăsta e testul lotului.** Înainte de fix: `false`.
2. ⭐⭐ certificatul raportat are CN `Barbu Ilie-Mircea` și seria
   `801020018ecd4a7f05` (⇒ NU rădăcina). Înainte de fix: CN gol.
3. ⭐ `L1.ok === true`.
4. ⭐ `isQES === true` — capătul-la-capăt care lipsea la #144: dovedește că
   evaluarea calificării vede certificatul corect. Verifică și `evidence`.
5. `padesLevel === 'B-B'` și `ltv_ready === false`.
6. valabilitatea raportată e 2024→2027 (a semnatarului), nu 2017→2042.
7. lanțul raportat NU marchează certificatul semnatarului drept CA.

### E2 — `server/tests/unit/ecdsa-der-to-raw.test.mjs`

8. DER cu `r` și `s` pe 32 de octeți ⇒ 64 de octeți raw.
9. ⭐ DER cu INTEGER prefixat cu `0x00` (bit de semn) ⇒ tot 64, cu zeroul scos.
10. ⭐ DER cu `r` scurt (31 de octeți) ⇒ completat la stânga la 32. Ăsta e cazul
    care apare la ~1 din 256 de semnături și produce eșecuri intermitente.
11. intrare raw de 64 de octeți ⇒ neschimbată.
12. gunoi ⇒ întors neschimbat, fără excepție.
13. P-384 ⇒ 96 de octeți.

### E3 — regresie

14. Un PDF nesemnat / trunchiat ⇒ eroare curată, fără excepție nefiltrată.

```bash
npm test         # verde
npm run test:db  # PASSED REAL
```

---

## PASUL FINAL

```bash
# package.json: 3.9.802 → 3.9.803
git status --short    # stage-uiește DOAR căile de mai jos, NICIODATĂ `git add -A`
git add server/verify.mjs \
        server/tests/fixtures/sts-signed-staging.pdf \
        server/tests/unit/verify-signer-selection.test.mjs \
        server/tests/unit/ecdsa-der-to-raw.test.mjs \
        package.json
git diff --cached --stat
git commit -m "fix(#145): verificatorul public alegea certificatul radacina in loc de semnatar (fals negativ) + ECDSA DER->raw (v3.9.803)"
git push origin develop
```

```bash
git diff --stat -- public/                                   # GOL
git status --short -- server/services/certificate-verify.mjs # GOL (celalalt motor NEATINS)
```

---

## RAPORT FINAL

1. Branch, ancore.
2. ⭐⭐ **Testul E1 înainte de fix**: ce a raportat exact (L2, CN, serie).
3. ⭐⭐ Testul E1 după fix: obiectul complet întors pentru semnătură.
4. Ce ramură a selecției a prins certificatul (1/2/3/4) pe fixtură.
5. Lungimea semnăturii înainte și după conversie.
6. Ai găsit alte locuri care presupun ordinea certificatelor sau ale căror
   ramuri erau moarte fiindcă `signerCert` era greșit? Enumeră, nu repara.
7. `npm test` / `npm run test:db` — cifre, PASSED REAL.
8. Commit, versiune, push.
9. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri, zero `public/`.
- `certificate-verify.mjs` **NEATINS** — potrivește deja pe serie; unificarea
  celor două motoare e alt lot.
- „Necunoscut" nu devine niciodată „invalid": `null`, nu `false`.
- Ultima instanță a selecției e mereu însoțită de un avertisment vizibil.
- Un singur PDF în repo: fixtura din Etapa A.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
