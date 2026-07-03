---
target_branch: develop
model_suggested: Sonnet 4.6 (feature mic, frontend + un endpoint; fără logică sensibilă)
risk: LOW — nu atinge semnarea, DB-ul, sau migrările. Doar serving + un link UI.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️

> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: previzualizare inline a documentelor suport în pagina de signer (fără descărcare)

## Cerință (owner)
În pagina de signer, lângă butonul „Descarcă" al fiecărui document suport, un link/buton
„Previzualizează" care deschide documentul într-un TAB NOU, randat în browser, fără să-l
descarce. Aplicabil DOAR pentru PDF-uri (zip/rar nu se pot previzualiza — alea rămân download).

## Context (verificat în cod)
- Backend: `server/routes/flows/attachments.mjs`, ruta `GET /flows/:flowId/attachments/:attId`
  (~:114). Acum setează MEREU `Content-Disposition: attachment` (~:136) → forțează download.
  Tipuri acceptate la upload: `application/pdf`, `application/zip`, `application/x-rar-compressed`.
- Frontend: `public/semdoc-signer.html`, cutia „Documente suport" cu `#attachmentsList` (~:173–176),
  populată din JS (găsește funcția care randează item-ele listei — caută `attachmentsList` și
  fetch-ul către `/attachments`). Acolo se desenează „Descarcă".

## Modificări cerute

### Backend (`attachments.mjs`, ruta GET de download)
- Acceptă un query param `?preview=1`. Când e prezent **ȘI** `mime_type === 'application/pdf'`:
  - setează `Content-Disposition: inline; filename="..."` (în loc de `attachment`);
  - adaugă `X-Content-Type-Options: nosniff` pe răspuns (anti content-sniffing).
- Pentru orice alt mime (zip/rar/etc.) SAU fără `?preview=1`: comportament neschimbat
  (`attachment`). NU servi inline nimic ce nu e `application/pdf`.
- Authz NESCHIMBAT — aceeași verificare de acces ca la download. Preview-ul nu lărgește accesul.
- Restul rutei (citire din DB, fallback Drive, 404) — neatins.

### Frontend (`public/semdoc-signer.html` + JS-ul care randează `#attachmentsList`)
- La randarea fiecărui item: dacă `mimeType === 'application/pdf'`, adaugă un link/buton
  „Previzualizează" lângă „Descarcă", cu:
  - `href` = aceeași adresă ca download-ul + `?preview=1`;
  - `target="_blank"` și `rel="noopener noreferrer"`;
  - stil consistent cu sistemul existent (`df-action-btn` sau stilul link-ului „Descarcă" din pagină).
- Pentru non-PDF: NU afișa „Previzualizează" (doar „Descarcă").

## Zone interzise
- NU atinge fișierele de semnare (NO-TOUCH), nici `pades.mjs`/STS — feature-ul n-are legătură cu ele.
- NU schimba schema DB, upload-ul, sau validarea de mime la upload.
- NU schimba disposition-ul implicit (rămâne `attachment` fără param).

## Definition of done
- Preview pe PDF deschide în tab nou, randat inline (verificat manual pe staging cu un PDF real).
- Download (fără param) rămâne identic. Zip/rar rămân download, fără link de preview.
- `npm test verde, fără regresii` + `npm run check` verde.
- Cache busting `?v=` pe JS/HTML-ul atins (drift la versiunea curentă) + bump `package.json`
  patch +1 (citește versiunea CURENTĂ). Frontend atins ⇒ și `CACHE_VERSION` dacă există convenția.
- Commit + push DOAR pe `develop`. STOP înainte de orice gând spre `main`.
- Raport: ce param ai adăugat, ce fișiere frontend ai atins, confirmare comportament download neschimbat.
