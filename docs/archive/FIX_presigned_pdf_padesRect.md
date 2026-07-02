# FIX: PDF-uri pre-semnate la upload — padesRect lipsă → semnături plasate peste conținut

> ⚠️ **ATENȚIE — BRANCH DISCIPLINE**
> Toate modificările se fac **EXCLUSIV pe branch-ul `develop`**.
> NU propune și NU executa merge/push/checkout către `main`. `main` = producție, gestionat manual.
> **ZONA NO-TOUCH (interzis de modificat):** `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs`. Le poți CITI pentru context, dar nicio linie modificată în ele.

## Context — bug confirmat în producție

Un utilizator a încărcat un PDF care **conținea deja o semnătură QES** (câmp `Signature2`, `adbe.pkcs7.detached`, aplicată în alt soft înainte de upload). Lanțul cauzal, verificat pe fișierele reale:

1. La crearea fluxului, `crud.mjs` (~linia 310) apelează `stampFooterOnPdf(..., { preventRewriteIfSigned: true })`.
2. În `server/index.mjs` (~linia 944), `pdfLooksSigned()` detectează `/ByteRange` → funcția returnează PDF-ul neatins (log: `stampFooterOnPdf skipped: PDF already contains signatures`). Guard CORECT — un re-save pdf-lib ar invalida semnătura existentă. NU elimina acest guard.
3. Consecință: `signerRects` nu se returnează → `signer.padesRect` rămâne `undefined` pentru toți semnătarii.
4. La callback-ul STS (flux tabel, `cloud-signing.mjs` — NO-TOUCH), fallback-ul hardcodat plasează câmpurile la `x = 30 + idx*190, y = 30, w = 180, h = 50, page = 1` → aparențele iText au fost desenate **pe pagina 1, peste conținutul documentului**, fără footer, fără cartuș.

## Obiectivul fix-ului

Pentru PDF-uri deja semnate la upload: **NU modificăm PDF-ul** (păstrăm validitatea semnăturii existente — deci fără footer și fără cartușul desenat, by design), dar **calculăm read-only `padesRect` per semnătar** în spațiul liber de pe **ultima pagină**, astfel încât aparențele iText (care deja desenează rol + nume + dată per semnătar, în incremental update) să fie plasate corect. Plus semnalizare explicită către inițiator.

Fix-ul face fallback-ul din `cloud-signing.mjs` cod mort (padesRect garantat populat) — fără să atingem fișierul NO-TOUCH.

## Implementare

### 1. Util nou: `server/utils/pdf-signed-placement.mjs`

- Mută (sau duplică și exportă) `pdfLooksSigned(pdfB64)` din `server/index.mjs` aici, exportată; `server/index.mjs` o importă de aici (fără schimbare de comportament).
- Funcție nouă exportată: `computeSignerRectsReadOnly(pdfB64, signers, PDFLib)`:
  - Încarcă PDF-ul cu `PDFDocument.load(..., { ignoreEncryption: true })` și **NU îl salvează niciodată** (read-only).
  - Lucrează exclusiv pe **ultima pagină** (nu putem adăuga pagini fără a invalida semnătura existentă).
  - Refolosește `detectContentYs` / `findLowestUsableGap` din `server/utils/pdf-content-detect.mjs` și **aceeași geometrie de celule** ca în `stampFooterOnPdf` din `server/index.mjs` (sideMargin, colGap, rowGap, cols = min(n,3), cellW, cellH, h=65) — extrage constantele/formula într-un helper comun dacă e curat, altfel replică fidel cu comentariu de sincronizare.
  - Strategie de plasare, în ordine: (a) bottom placement dacă există spațiu sub conținut pe ultima pagină; (b) cel mai jos gap utilizabil (mid-page); (c) dacă nu există spațiu suficient, plasează totuși în banda cea mai liberă disponibilă pe ultima pagină și loghează `warn` — NICIODATĂ page 1 și NICIODATĂ coordonate care nu țin cont de conținut.
  - Returnează `{ signerRects: [{ page, x, y, w, h }], placement: 'bottom'|'gap'|'forced' }` — `page` e 1-based, identic cu formatul din `stampFooterOnPdf` (vezi `signerRects.push({ page: cartusPageNum, ... })`).
  - Atenție la PDF-uri cu conținut rotit (tabele landscape pe pagini portrait, `cm` cu rotație) — `detectContentYs` are tracking CTM (v3.9.496); verifică acoperirea și pentru rotații 90°, nu doar Y-flip.

### 2. `server/routes/flows/crud.mjs` — crearea fluxului

În blocul existent de stamping (~linia 310), înainte de apelul `_stampFooterOnPdf`:

- Dacă `pdfLooksSigned(finalPdfB64)` și flowType ≠ 'ancore':
  - NU apela `_stampFooterOnPdf` (oricum ar sări intern; facem decizia explicită la call-site).
  - Apelează `computeSignerRectsReadOnly` și setează `normalizedSigners[idx].padesRect` pentru fiecare semnătar.
  - Setează pe `data`: `preSignedUpload: true` și adaugă în `events` un eveniment `{ type: 'PRESIGNED_UPLOAD_DETECTED', at, detail: 'Footer/cartuș omise pentru a păstra validitatea semnăturii existente' }`.
  - Include `preSignedUpload: true` în răspunsul API al creării fluxului, ca frontend-ul să poată afișa avertismentul.
- Comportamentul pentru PDF-uri nesemnate rămâne **identic bit-cu-bit** (test de caracterizare obligatoriu).

### 3. `server/routes/flows/lifecycle.mjs` — reinitiate

Aceleași două call-site-uri de `_stampFooterOnPdf` (~liniile 79 și 255): aplică aceeași decizie explicită (PDF semnat → rects read-only + padesRect + flag), folosind `originalPdfB64`/sursa corespunzătoare fiecărui call-site.

### 4. Frontend — avertisment inițiator

În `semdoc-initiator` (JS-ul modular aferent creării fluxului): dacă răspunsul POST /flows conține `preSignedUpload: true`, afișează un banner/toast persistent: „Documentul încărcat conține deja o semnătură electronică. Pentru a nu o invalida, antetul/footer-ul și cartușul DocFlowAI nu vor fi aplicate; semnăturile QES vor fi plasate în spațiul liber de pe ultima pagină." Respectă regulile de CSS scoping din CLAUDE.md (fără `!important` pe selectori bare `input`/`label`; clase scoped).

### 5. Teste

- **Unit** (`server/tests/unit/`): `computeSignerRectsReadOnly` — fixture PDF generat în test cu pdf-lib + un dicționar /Sig cu /ByteRange simulat (sau fixture binar mic comis în `tests/fixtures/`): rects pe ultima pagină, page 1-based corect, niciun byte modificat în PDF (hash identic înainte/după), cele 3 strategii de plasare.
- **Unit**: `pdfLooksSigned` re-exportată — comportament identic (caracterizare).
- **Integration** (`server/tests/integration/`): creare flux cu PDF pre-semnat → toți semnătarii au `padesRect` setat, `padesRect.page` = ultima pagină, `data.preSignedUpload === true`, eveniment prezent; creare flux cu PDF normal → comportament neschimbat (footer aplicat, signerRects din stampFooterOnPdf, fără flag).
- Rulează și testele existente `stamp-cartus-placement.test.mjs`, `pdf-content-detect.test.mjs`, `trim-empty-trailing-pages.test.mjs` — trebuie să rămână verzi.

### 6. CLAUDE.md

Adaugă o secțiune scurtă: „PDF-uri pre-semnate la upload: stampFooterOnPdf se sare intenționat (preventRewriteIfSigned); padesRect se calculează read-only prin computeSignerRectsReadOnly; fallback-ul de coordonate din cloud-signing.mjs trebuie să rămână cod mort — orice path nou care creează fluxuri TREBUIE să populeze padesRect."

## Criterii de acceptare

- `npm test` verde, fără regresii.
- Zona NO-TOUCH: zero modificări (verifică cu `git diff --stat` la final).
- PDF pre-semnat: semnătura existentă rămâne criptografic validă după semnările DocFlowAI (incremental updates), aparențele plasate pe ultima pagină în spațiu liber, `preSignedUpload` vizibil în API + UI.
- PDF normal: comportament identic cu înainte (caracterizare).
- Commit-uri mici, mesaje descriptive, doar pe `develop`.
