---
lot: "#146 — verificatorul public arată TOATE semnăturile, iar verdictul e al documentului"
versiune_start: v3.9.803 (develop)
versiune_tinta: v3.9.804
model_suggested: Sonnet 5 (efort medium)
migratii: 0
scriere_de_date: NU
fisiere_din_public: DA (verifica.html, verifica.js) ⇒ `?v=` țintit, dar VEZI PASUL 0
---

# ⚠️ BRANCH: develop

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.

# ⛔ ZONA NO-TOUCH

`cloud-signing.mjs`, `bulk-signing.mjs`, `STSCloudProvider.mjs`, `pades.mjs`,
`java-pades-client.mjs`. ⛔ **Și nucleul criptografic reparat la #145**:
selecția certificatului, conversia ECDSA DER→raw, evaluarea QC. Lotul ăsta e
**exclusiv despre agregare și afișare**. Dacă un pas pare să ceară o modificare
în verificarea propriu-zisă: OPREȘTE-TE și raportează.

---

## CONTEXT

`verifyPdfSignatures` parcurge toate ByteRange-urile și întoarce `signatures[]`,
fiecare cu propriile niveluri L1–L6, certificat și lanț. Două locuri strâng
rezultatul la unul singur:

| Loc | Cod | Efect |
|---|---|---|
| `server/verify.mjs:464` | `const sig = result.signatures?.[0];` | `summary` descrie doar prima semnătură |
| `public/js/verifica/verifica.js:147` | `const sig = data.signatures?.[0];` | tot ecranul (verdict, niveluri, certificat, lanț) e al primei |

Tabloul complet supraviețuiește (`formatVerificationResult` face spread peste
`result`), deci **backendul trimite deja tot** — se aruncă la afișare.

**Consecința care contează**, nu doar de completitudine: verdictul din antet e al
primului semnatar, prezentat ca verdict al documentului. Pe un act cu ÎNTOCMIT /
VERIFICAT / VIZAT, dacă a doua semnătură ar fi invalidă, pagina publică ar afișa
în continuare bifa verde „Semnătură electronică calificată (QES)".

### Fapte verificate pe cod (nu le re-descoperi)

- `summary` are **un singur consumator** în tot proiectul: `verifica.js:148`.
  Deci semantica lui se poate schimba în același commit, fără efect colateral.
  ⚠️ Confirmă totuși cu `grep -rn "summary" server/ public/ --include=*.mjs --include=*.js | grep -v tests`.
- Nici `verifica.html`, nici `verifica.js` nu sunt în `PRECACHE_ASSETS`
  (`grep -n "verifica" public/sw.js` ⇒ gol) ⇒ **`?v=` țintit ajunge, FĂRĂ bump de
  `CACHE_VERSION`**. Verifică din nou tu însuți înainte de a decide.
- DOM-ul actual folosește ID-uri fixe pentru zonele care devin repetabile:
  `levelsBox`, `certInfoGrid`, `chainSection`, `chainBox` (`verifica.html:106-130`).
  ⛔ ID-uri duplicate sunt HTML invalid — blocurile per semnătură se construiesc
  cu **clase**, nu cu ID-uri.
- `dbSection` / `signersTable` (semnatarii din baza de date, când se dă `flowId`)
  e o secțiune SEPARATĂ și rămâne **neatinsă**.

---

## PASUL 0 — ancore

```bash
git branch --show-current            # develop
grep '"version"' package.json        # 3.9.803
grep -n "result.signatures?.\[0\]" server/verify.mjs        # 1 linie (~464)
grep -n "data.signatures?.\[0\]" public/js/verifica/verifica.js  # 1 linie (~147)
grep -n "verifica" public/sw.js      # gol ⇒ fără CACHE_VERSION
```

⚠️ După #145 numerotarea a driftat față de promptul precedent — ancorează pe
conținut, nu pe număr de linie. Dacă un ȘIR lipsește: OPREȘTE-TE.

---

## ETAPA A — MĂSURĂTOARE, înainte de orice cod

Mircea îți pune la dispoziție un PDF real cu **trei** semnături, la o cale
**în afara repo-ului** (ți-o dă el; ⛔ nu-l copia în proiect, nu-l comite, nu-l
lăsa în `/tmp` la final — conține datele unui cetățean).

Scrie un script temporar (nu în repo, șters după) care importă
`verifyPdfSignatures` din `server/verify.mjs`, îl rulează pe fișier și afișează,
**per semnătură**: CN-ul semnatarului, seria, `L1.ok`, `L2.ok`, `L6.ok`, `isQES`,
lungimea lanțului.

**Raportează tabelul și AȘTEAPTĂ confirmarea mea înainte de Etapa B.**

Motivul: ordinea certificatelor în sacul CMS **diferă între semnăturile aceluiași
document** (măsurat: la prima `[rădăcină, CA II, semnatar]`, la a doua și a treia
`[rădăcină, semnatar, CA II]`). Selecția reparată la #145 ar trebui să le trateze
pe toate, dar nimic n-o probează încă. Dacă vreo semnătură iese greșit, lotul se
oprește aici și devine un fix de verificare, nu de afișare.

Așteptat: **3 semnături**, semnatari distincți, toate `L2.ok === true`.

---

## ETAPA B — agregarea în `formatVerificationResult`

`summary` descrie de acum **documentul**. Câmpuri:

```
signatureCount   număr total de semnături găsite
allValid         TOATE au L2.ok === true            (conjuncție strictă)
allQES           TOATE au isQES === true
anyInconclusive  vreuna are L2.ok === null          (necunoscut ≠ invalid)
signers[]        { cn, o, issuerCN, signingTime, isValid, isQES }, în ordinea din document
```

Câmpurile existente (`isValid`, `isQES`, `signer`, `organization`, `issuer`,
`signingTime`, `qtsp`, `levels`) **rămân**, dar cu semantică redefinită explicit:

- `summary.isValid` = `allValid` (⛔ nu mai e valoarea primei semnături);
- `summary.isQES` = `allQES`;
- `signer` / `organization` / `issuer` / `signingTime` / `qtsp` / `levels` rămân
  ale PRIMEI semnături, cu un comentariu deasupra care spune că sunt păstrate
  pentru compatibilitate și că **nu descriu documentul** — cine vrea documentul
  citește `allValid` / `allQES` / `signers`.

Comentariu de bloc obligatoriu, care explică de ce s-a schimbat `isValid`:
altfel un document cu a doua semnătură invalidă raporta „valid".

⛔ Regula #144/#145 se păstrează: `null` nu devine `false`. Dacă o semnătură are
`L2.ok === null`, ea NU face `allValid` fals — se reflectă în `anyInconclusive`.
Zero semnături ⇒ `signatureCount: 0`, `allValid: false`, `signers: []`, fără
excepție aruncată (azi funcția întoarce `result` neschimbat pe `!sig` — păstrează
comportamentul pentru ramura „niciun element", dar adaugă câmpurile).

---

## ETAPA C — randarea (`verifica.html` + `verifica.js`)

### C1 — verdictul din antet devine al documentului

| Situație | Stare | Titlu | Subtitlu |
|---|---|---|---|
| toate valide + toate QES | `valid` ✅ | `N semnături electronice calificate (QES)` (la N=1: textul de azi, neschimbat) | lista semnatarilor, separată prin `·` |
| toate valide, nu toate QES | `valid` ✅ | `N semnături valide (X calificate)` | idem |
| vreuna invalidă | `invalid` ❌ | `X din N semnături invalide` | care anume |
| vreuna neconcludentă, restul valide | `warn` ⚠️ | `N semnături · X neconcludente` | care anume |

⛔ La **N = 1** ecranul trebuie să arate **identic cu azi** — ăsta e criteriul de
non-regresie și se asertează în test.

### C2 — un bloc per semnătură

Container nou `#sigList` în `verifica.html`, în locul actualelor `levelsBox` /
`cryptoSection` repetabile. Fiecare bloc conține:

- **capul blocului**: bifă de stare, `#N`, CN-ul semnatarului, organizația,
  eticheta QES; clicabil pentru pliere;
- **corpul**: grila de niveluri L1–L6 (exact componenta de azi), grila de
  certificat, lanțul de certificare.

Primul bloc **desfășurat**, blocurile 2+ **pliate** implicit. Starea fiecăruia se
vede în cap fără a-l desfășura — asta e cerința, nu pliere ca ascundere.

⛔ Fără ID-uri duplicate: în interiorul blocurilor se folosesc **clase**
(`.sig-block`, `.sig-levels`, `.sig-cert`, `.sig-chain`), iar elementele se
creează cu `document.createElement` / `textContent` acolo unde intră valori din
certificat. Unde se păstrează `innerHTML`, treci **obligatoriu** prin `esc()`,
funcția existentă — valorile vin dintr-un PDF încărcat de un anonim pe o pagină
publică.

Pliere fără `onclick` inline (convenția proiectului): `addEventListener` la
construcție.

### C3 — refactorizare, nu rescriere

Logica de randare a nivelurilor, a grilei de certificat și a lanțului există deja
(`verifica.js:175-215`). **Extrage-o** în `renderSignatureBlock(sig, index)` și
cheam-o în buclă. ⛔ Nu schimba etichetele, ordinea câmpurilor, formatarea datelor
sau clasele CSS existente — un singur lucru se schimbă: de câte ori se apelează.

`dbSection` / `signersTable` rămân neatinse și în afara buclei.

---

## ETAPA D — teste

### D1 — `server/tests/unit/verify-summary-agregat.test.mjs` (pur)

Pe `formatVerificationResult`, cu obiecte construite de mână:

1. ⭐⭐ trei semnături, a doua cu `L2.ok:false` ⇒ `allValid:false`,
   `summary.isValid:false`. **Ăsta e testul lotului** — azi ar da `true`.
2. ⭐ trei valide ⇒ `allValid:true`, `signatureCount:3`, `signers` are 3 intrări
   în ordine.
3. ⭐ două valide + una cu `L2.ok:null` ⇒ `allValid:true`, `anyInconclusive:true`.
   (Necunoscut nu invalidează documentul.)
4. toate valide dar una cu `isQES:false` ⇒ `allValid:true`, `allQES:false`.
5. o singură semnătură validă ⇒ toate câmpurile vechi identice cu azi.
6. `signatures: []` ⇒ `signatureCount:0`, fără excepție.

### D2 — `server/tests/unit/verifica-render.test.mjs` (happy-dom)

Docblock `// @vitest-environment happy-dom`. Convenția de încărcare a unui script
clasic e cea din `pagin-component.test.mjs`: `new Function(src).call(globalThis)`.
⚠️ Capcană cunoscută: sub happy-dom, `new URL('.', import.meta.url)` aruncă —
folosește `dirname(fileURLToPath(import.meta.url))`.

7. ⭐⭐ trei semnături (a doua invalidă) ⇒ verdictul din antet e cel de eșec și
   NU conține „QES" ca afirmație pozitivă; se randează 3 blocuri.
8. ⭐ o singură semnătură validă ⇒ verdict identic cu cel de azi, un bloc,
   desfășurat.
9. ⭐ blocurile 2 și 3 sunt pliate implicit, dar starea lor e prezentă în DOM
   (fără desfășurare).
10. ⭐ un CN care conține `<img src=x onerror=...>` ⇒ apare escapat, nu se
    creează elementul. XSS pe pagină publică.
11. zero semnături ⇒ mesajul existent, fără blocuri.

⛔ Nu cădea pe analiză statică cu regex dacă încărcarea în DOM eșuează —
raportează în schimb.

```bash
npm test         # verde
npm run test:db  # PASSED REAL
```

---

## PASUL FINAL

```bash
# package.json: 3.9.803 → 3.9.804
# ?v= țintit DOAR pe verifica.js în verifica.html (și pe CSS-ul propriu dacă l-ai atins)
# CACHE_VERSION: NU se bumpează dacă grep-ul din PASUL 0 a ieșit gol — confirmă în raport

git status --short   # NICIODATĂ `git add -A`
git add server/verify.mjs \
        public/verifica.html \
        public/js/verifica/verifica.js \
        server/tests/unit/verify-summary-agregat.test.mjs \
        server/tests/unit/verifica-render.test.mjs \
        package.json
git diff --cached --stat
git commit -m "fix(#146): verdictul verificatorului public e al documentului, nu al primei semnaturi; toate semnaturile afisate (v3.9.804)"
git push origin develop
```

```bash
git status --short -- server/services/certificate-verify.mjs   # GOL
git diff -- server/verify.mjs | grep -c "signerCert\|DER\|ECDSA"  # 0 — nucleul #145 neatins
```

---

## RAPORT FINAL

1. Branch, ancore (cu liniile REALE, nu cele din prompt).
2. ⭐⭐ Tabelul din Etapa A: cele trei semnături, așa cum le-a raportat codul.
3. `summary` a avut într-adevăr un singur consumator? Ce a dat grep-ul.
4. `CACHE_VERSION` — bumpat sau nu, și pe ce dovadă.
5. ⭐⭐ Testele D1.1 și D2.7: ce ar fi raportat codul VECHI.
6. ⭐ D2.8 (o singură semnătură = ecran identic): cum ai probat identitatea.
7. Ai atins `innerHTML` cu valori din certificat? Unde, și cum sunt escapate.
8. `npm test` / `npm run test:db` — cifre, PASSED REAL.
9. Confirmarea că fișierul cu 3 semnături NU a rămas nicăieri pe disc și nu e în stage.
10. Commit, versiune, push.
11. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- Nucleul criptografic #145 NEATINS. `certificate-verify.mjs` NEATINS.
- `null` nu devine niciodată `false`.
- N=1 ⇒ ecran identic cu azi.
- Niciun PDF nou în repo; fișierul cu trei semnături nu supraviețuiește sesiunii.
- Fără ID-uri duplicate, fără `onclick` inline, tot ce vine din certificat trece
  prin `esc()`.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
