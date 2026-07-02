# FIX UX: avertismentul „PDF pre-semnat" dispare prea repede (redirect 4.5s)

> ⚠️ **ATENȚIE — BRANCH DISCIPLINE**
> Toate modificările se fac **EXCLUSIV pe branch-ul `develop`**.
> NU propune și NU executa merge/push/checkout către `main`. `main` = producție, gestionat manual.
> **ZONA NO-TOUCH:** `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs` — zero modificări.

## Context

În v3.9.552 am adăugat bannerul `preSignedUpload` în semdoc-initiator, afișat după POST /flows, cu redirect automat la semnare după 4.5s când inițiatorul e primul semnatar. Problemă raportată: bannerul abia apucă să fie citit înainte de redirect. Avertismentul e important (explică de ce nu se aplică footer/cartuș) și nu trebuie să depindă de un timer.

## Obiectiv

Avertismentul trebuie văzut și înțeles, în trei puncte:

### 1. Detecție client-side LA SELECTAREA FIȘIERULUI (înainte de creare)

În JS-ul modular al inițiatorului (handler-ul de upload fișier din `public/js/` aferent semdoc-initiator):
- La selectarea unui PDF, citește fișierul cu `FileReader` (`readAsArrayBuffer`), decodează ca latin1 și aplică aceeași euristică din `pdfLooksSigned` (server: `server/utils/pdf-signed-placement.mjs`) — căutare substring `/ByteRange`, `/Type/Sig`, `/Type /Sig` etc. Extrage euristica într-o funcție JS mică, comentată cu referință la sursa server-side (sincronizare manuală).
- Doar pentru fișiere PDF (verifică magic bytes `%PDF`); pentru DOCX/altele convertite server-side, sari peste (nu pot avea semnături PAdES).
- Dacă e detectată semnătură: afișează imediat, sub zona de upload, același banner de avertizare (conținut identic cu cel existent), persistent până la schimbarea fișierului sau crearea fluxului. Nu bloca fluxul — doar informează.

### 2. Redirect MANUAL când preSignedUpload e true

În handler-ul răspunsului POST /flows (acolo unde acum e redirect-ul cu timer 4.5s):
- Dacă răspunsul are `preSignedUpload: true` ȘI inițiatorul e primul semnatar: NU porni timerul. Afișează bannerul cu un buton primar „Am înțeles — continuă la semnare" care face redirect-ul la click. Bannerul rămâne pe ecran nelimitat până la click.
- Dacă `preSignedUpload` e false/absent: comportament identic cu acum (mesajul „Flux creat... te redirecționăm" + redirect existent).
- Respectă CLAUDE.md la CSS: stiluri scoped, fără `!important` pe selectori bare; refolosește `.df-action-btn` cu variantă semantică pentru buton.

### 3. Bannerul repetat pe pagina semnatarului

În `semdoc-signer` (JS-ul aferent): dacă datele fluxului expuse semnatarului conțin `preSignedUpload: true` (verifică ce întoarce endpoint-ul de status/flow data pentru semnatar; dacă flag-ul nu e expus, adaugă-l în răspunsul relevant din `server/routes/flows/` — NU în zona NO-TOUCH; flag-ul e deja pe `data`, doar nu e stripat/expus), afișează un banner informativ discret deasupra zonei de semnare, cu același text. Fără timer, fără dismiss obligatoriu.

## Teste

- Unit JS dacă există infrastructură pentru frontend; altfel, integration pe server: răspunsul de flow data pentru semnatar include `preSignedUpload` când flag-ul e setat, și NU îl include/`false` altfel.
- Verifică manual (descriere în PR/commit): (a) selectezi PDF-ul de buget semnat → banner apare imediat sub upload; (b) creezi fluxul ca prim semnatar → fără redirect automat, buton „continuă"; (c) pagina semnatarului afișează bannerul; (d) PDF normal → zero schimbări de comportament (timer/redirect identic).

## Criterii de acceptare

- `npm test` verde, fără regresii.
- Zona NO-TOUCH: `git diff` gol pe cele 5 fișiere.
- Cache-bust țintit pe asset-urile JS modificate + bump versiune (`package.json`, `?v=`), CLAUDE.md actualizat dacă apar reguli noi.
- Commit-uri mici, doar pe `develop`.
