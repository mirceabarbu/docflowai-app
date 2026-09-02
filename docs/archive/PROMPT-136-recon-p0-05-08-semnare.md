---
lot: "#136 — RECON READ-ONLY pe constatările P0-05…P0-08 (zona de semnare)"
versiune_start: v3.9.793
versiune_tinta: v3.9.793 (NESCHIMBATĂ — reconul nu modifică cod)
model_suggested: Opus 5 (efort high)
migratii: 0
scriere_de_cod: NU
artefact_unic: docs/audits/SIGN-P0-05-08-RECON-2026-08.md
---

# ⚠️ BRANCH: develop · ⛔ STRICT READ-ONLY

`main` = PRODUCȚIE, gestionat manual de Mircea. Nu faci `checkout`, `merge` sau
`push` pe `main`.

**Acest lot NU repară nimic.** Singurul fișier pe care ai voie să-l creezi este
raportul din `docs/audits/`. Nu modifici nicio linie de cod de producție, niciun
test, `package.json` rămâne la `3.9.793`, niciun `?v=`, nicio migrație.

Zona atinsă de aceste constatări este **NO-TOUCH** (CLAUDE.md liniile 71-79):
`server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`,
`server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`,
`server/signing/java-pades-client.mjs`. **Ai voie să le CITEȘTI. Nu ai voie să le
modifici.** Exact de asta reconul e read-only: ca decizia de a atinge zona să fie
luată de Mircea, pe baza faptelor, nu în timpul unui patch.

---

## CONTEXT — și de ce disciplina contează aici mai mult ca oriunde

Auditul extern pe v3.9.746 a produs opt constatări P0. Patru au fost verificate
pe cod și **reparate**, toate live în producție (P0-01 gardă `test:db`, P0-02
tenant guard pe `PUT /admin/users/:id`, P0-03 proveniența fluxului la
`link-df-flow`/`link-ord-flow`, P0-04 cheia STS scoasă din DTO-ul generic).

Patru au rămas neverificate, fiindcă ating zona de semnare:

- **P0-05** — Trust Report ar produce fals-pozitiv „QES"
- **P0-06** — upload local finalizează fluxul fără PAdES valid
- **P0-07** — callback cloud fără corelare
- **P0-08** — DoS prin bufferizarea a 50 MB înainte de autorizare

⚠️ **Precedentul care dă tonul întregului lot:** auditul PRECEDENT (13.07, pe
v3.9.689) a raportat SIGN-02 ca vulnerabilitate reală. Verificarea pe cod a
arătat că `verifySignedDocument()` era un **stub mort, cu ZERO apelanți**, într-o
clasă de bază abstractă. Constatarea era corect descrisă și complet irelevantă.

Deci sarcina ta nu e să confirmi auditul. E să-l **judeci**. Pentru fiecare
constatare, obligatoriu:

1. **Găsește calea reală de execuție**, de la o rută montată până la linia
   incriminată. Dacă nu poți trasa calea, constatarea e MOARTĂ, oricât de corect
   ar fi descrisă.
2. **Încearcă activ să o INFIRMI** înainte de a o confirma. Scrie în raport ce
   ai încercat și de ce n-a ținut.
3. Verdictul se dă în una din patru forme, niciodată altfel:
   `CONFIRMAT` · `CONFIRMAT PARȚIAL (severitate mai mică decât în raport)` ·
   `FALS` · `NEDECIDABIL STATIC` (spune atunci exact ce interogare/test ar
   decide-o).

Fără dovadă `fișier:linie`, o afirmație nu intră în raport.

---

## PASUL 0 — punct de plecare

```bash
git branch --show-current
# Așteptat: develop

grep '"version"' package.json
# Așteptat: "version": "3.9.793",

ls docs/audits/
# orientare — vezi formatul rapoartelor anterioare (ALOP-134-RECON-REVIZIE-2026-08.md,
# AUTHZ-105-RECON-2026-07.md) și scrie-l pe al tău în același registru
```

---

## R1 — P0-05: Trust Report și afirmația „QES"

Ancore de pornire (verificate de mine în arhiva v3.9.793 — confirmă-le, nu le
lua pe încredere):

- `server/services/certificate-verify.mjs:391` — `result.isQES = qtsp.found || hasQcExt;`
- `server/services/certificate-verify.mjs:397,401` — `certificateType` și
  `certificate_qc_status` derivă din acel `isQES`
- `server/services/sign-trust-report.mjs:146,171-174` — `allQES` decide între
  două fraze cu valoare **juridică**, care invocă explicit eIDAS 910/2014,
  Legea 455/2001 și Legea 214/2024
- `server/services/sign-trust-report.mjs:446,466,468` — etichetele
  „CALIFICAT (QES)" din PDF-ul livrat utilizatorului

Întrebări la care raportul trebuie să răspundă:

1. Cum se calculează `qtsp.found`? Listă locală de QTSP-uri? Potrivire pe ce
   câmp — issuer CN, OID, amprentă? **Potrivirea e pe substring sau exactă?**
   O potrivire pe nume, dintr-un câmp controlat de emitentul certificatului, e
   spoofabilă cu un certificat self-signed al cărui issuer conține numele unui
   QTSP real. Demonstrează sau infirmă asta pe cod.
2. `||` e corect sau ar trebui `&&`? Care e regula eIDAS reală: QcStatements
   e obligatoriu pentru calificare, sau apartenența la Trusted List e
   suficientă? Spune ce zice codul și ce ar trebui, separat.
3. Se verifică lanțul de încredere până la o rădăcină din Trusted List, sau doar
   se citește o extensie din certificatul frunză?
4. **Cine vede raportul și în ce context?** Ajunge la terți (atașat pe email —
   `df-email-modal.js:86` îl prezintă ca certificând semnături calificate) sau e
   doar informativ intern? Asta decide dacă e problemă de securitate sau de
   răspundere juridică. Spune care dintre ele.
5. `verifyPdfSignatures` / `generateTrustReport` — **au apelanți reali?**
   Trasează-i. (Lecția SIGN-02.)

---

## R2 — P0-06: upload local și PAdES

Ancoră: `server/routes/flows/signing.mjs:291` —
`router.post('/flows/:flowId/upload-signed-pdf', _largePdf, async (req,res) => …)`.
Fișierul NU e în lista NO-TOUCH, deci un fix ulterior aici e ieftin — dar
reconul rămâne read-only.

Întrebări:

1. Ce validează ruta pe PDF-ul primit înainte de a marca semnatarul ca semnat?
   Există o verificare că PDF-ul **conține efectiv o semnătură** și că
   `ByteRange` acoperă documentul? Sau se acceptă orice bytes?
2. Ce se întâmplă la ULTIMUL semnatar — se scrie `completed` pe flux? Dacă da,
   un PDF nesemnat poate finaliza un flux, iar de acolo `dfAprobatSql` îl
   consideră **DF aprobat** ⇒ atinge lanțul financiar ALOP. Confirmă sau infirmă
   traseul complet până la `alop_instances`.
3. Cine poate apela ruta: doar semnatarul cu token valid, sau orice utilizator
   autentificat? Se verifică apartenența la org și că e rândul lui?
4. Cum interacționează cu calea `preSignedUpload: true` /
   `computeSignerRectsReadOnly` (semnături calificate preexistente pe PDF-uri
   încărcate)? Acolo comportamentul e intenționat — delimitează exact ce e
   funcționalitate acceptată și ce e gaură.
5. Raportează dacă `_uploadRateLimit` (definit la `signing.mjs:22`) e sau nu în
   lanțul rutei de la linia 291. Verifică, nu presupune.

---

## R3 — P0-07: callback-urile cloud

Ancore (fișier **NO-TOUCH**, doar citire):

- `server/routes/flows/cloud-signing.mjs:834` — `POST /flows/:flowId/signing-callback`
- `server/routes/flows/cloud-signing.mjs:868-880` — corelarea semnatarului pe
  `result.signerToken`, apoi `signedPdfB64`
- `server/routes/flows/cloud-signing.mjs:60` — `GET /flows/sts-oauth-callback`,
  sesiunea căutată după `sessionId` din query

Întrebări:

1. Cele două rute sunt **autentificate**? Trec prin `sessionGuard` (#88/#88.1 —
   verifică prefixele efectiv guardate) sau sunt publice prin construcție,
   fiindcă providerul extern trebuie să le poată apela?
2. Dacă sunt publice: ce leagă cererea de o sesiune de semnare reală?
   `signerToken` e secret, cu entropie suficientă, și e verificat înainte de
   orice scriere? Se poate ghici, refolosi (replay), sau afla dintr-un link de
   semnare?
3. Se verifică proveniența răspunsului de la provider — semnătură, `state`,
   `nonce`, HMAC, IP? Sau se acceptă orice corp bine format?
4. Scenariul care contează: **poate cineva din exterior să depună un PDF
   „semnat" pentru un semnatar arbitrar?** Trasează-l pas cu pas și spune unde
   se oprește, dacă se oprește.
5. IP-urile de egress statice Railway (constrângere operațională fermă: nu se
   dezactivează, regiunea nu se schimbă) — sunt folosite ca apărare aici, sau
   doar pentru conexiunile ieșite către STS?

---

## R4 — P0-08: 50 MB bufferizați înainte de autorizare

Fapt de plecare, confirmat de mine: `expressJson({ limit: '50mb' })` e declarat
în **șapte** fișiere (`acroform`, `attachments`, `cloud-signing`, `crud`,
`email`, `lifecycle`, `signing`) și montat ca middleware **de rută**, în timp ce
verificarea de autorizare se face **în interiorul handler-ului** ⇒ corpul e
citit și parsat integral înainte ca cineva să întrebe cine ești. Există și
`server/index.mjs:641-660`, care alege `50mb` vs `1mb` la nivel de aplicație.

Întrebări:

1. Inventariază **toate** rutele care bufferizează 50 MB înainte de orice gardă.
   Tabel: rută, fișier:linie, ce autentificare are și **unde** în lanț.
2. Care dintre ele sunt atingibile **neautentificat**? Alea sunt singurele care
   contează cu adevărat pentru DoS remote.
3. Ce rate limiting există pe fiecare? ⚠️ Calibrare deja învățată la #107.1:
   toți utilizatorii primăriei ies prin **un singur IP public** (NAT), deci un
   prag „per user" e de fapt per instituție.
4. Care e limita reală de memorie a containerului Railway și câte cereri
   concurente de 50 MB îl doboară? Dacă nu poți afla static, spune-o și indică
   cum s-ar măsura.
5. Interacțiunea cu poarta de concurență LibreOffice (#107) — o cerere care
   trece de buffer ajunge la conversie? Se cumulează?
6. Fluxul legitim: **cât de mare e cel mai mare PDF real** din producție? Dacă
   documentele reale sunt de 2-5 MB, limita de 50 MB e o alegere neîntrebată,
   nu o cerință. Spune ce interogare ar răspunde exact la asta (nu o rula — n-ai
   acces la producție).

---

## R5 — sinteza care decide ce facem mai departe

La final, un singur tabel cu cele patru constatări și, pentru fiecare:

- verdictul (una din cele patru forme de mai sus)
- exploatabilitatea: **neautentificat de pe internet** / **insider autentificat**
  / **doar cu configurare greșită** / **neexploatabil**
- ruperea e **ZGOMOTOASĂ** (eroare vizibilă) sau **TĂCUTĂ** (document greșit
  acceptat, cifră greșită scrisă) — clasa tăcută ne-a costat la #115 și #128l
- **cere sau nu atingerea zonei NO-TOUCH** — coloană separată, e cea după care
  Mircea decide ordinea
- ordinul de mărime al reparației: linii atinse, migrație da/nu, teste noi

Apoi, pentru fiecare constatare CONFIRMATĂ, **două-trei variante de reparație
puse față în față, cu costul real — ⛔ FĂRĂ să alegi tu.** Alegerea e a lui
Mircea. Tiparul e cel de la #134a: pentru fiecare variantă, situri atinse,
migrație, reparare de date existente, ce comportament legitim s-ar putea rupe.

⛔ Nu propune un plan pe 90 de zile și nu recomanda „BLOCK deploy". Contextul e
un dezvoltator unic, cu o singură instituție în producție. Calibrarea aia a fost
deja respinsă motivat la auditul precedent.

---

## PASUL FINAL — poarta read-only

```bash
git status --short
# Așteptat: EXACT o intrare, netrackuită:
#   ?? docs/audits/SIGN-P0-05-08-RECON-2026-08.md
# ⚠️ `git diff --stat` NU vede fișierele netrackuite (lecția #124f) — poarta e
#    `git status --short`, nu `git diff`.

git diff --stat
# Așteptat: GOL (niciun fișier existent modificat)
```

Dacă apare orice altă intrare, ai ieșit din mandat: raportează ce ai atins și de
ce, **înainte** de commit.

```bash
git add docs/audits/SIGN-P0-05-08-RECON-2026-08.md
git commit -m "docs: recon read-only pe constatarile P0-05..P0-08 din auditul v3.9.746"
git push origin develop
```

Fără bump de versiune (commit doc-only), fără `CACHE_VERSION`, fără `?v=`.

---

## RAPORT FINAL (în chat, pe lângă documentul din repo)

1. Branch la start și final.
2. Cele patru verdicte, într-o linie fiecare.
3. Care constatare te-a surprins cel mai mult și de ce.
4. Ce ai încercat să INFIRMI și n-ai reușit (sau ai reușit) — explicit.
5. Ce n-ai putut decide static și ce ar fi decis-o.
6. Confirmarea porții read-only: ieșirea exactă a lui `git status --short`.
7. Commit hash + confirmarea push-ului pe `develop`.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- Doar `develop`. Fără `main`.
- **Zero modificări de cod.** Un singur fișier nou, în `docs/audits/`.
- Fișierele NO-TOUCH se CITESC, nu se ating. Dacă ești tentat să „repari repede
  o linie" acolo — nu. Ăsta e exact motivul pentru care lotul e read-only.
- Nicio afirmație fără `fișier:linie`. Nicio generalizare dintr-un singur fișier
  citit: `grep` per fișier, niciodată global (lecția din P3, repetată de trei ori
  într-o singură sesiune).
- Nu inventa nume de fișiere sau de funcții. Dacă o cale din raportul de audit nu
  există în arbore, scrie că nu există — e o constatare în sine.
- Dacă găsești în trecere altceva grav, îl treci într-o secțiune separată
  „Găsit în trecere, în afara mandatului" și **nu-l repari**.
