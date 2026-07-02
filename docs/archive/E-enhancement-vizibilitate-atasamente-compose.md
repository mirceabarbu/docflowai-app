---
enhancement: E — Vizibilitate atașamente formular la compose (preview „vor fi preluate din formular")
target_branch: develop
model_suggested: Sonnet 4.6 (frontend-only, un fetch + randare, reutilizează endpoint + modal existente)
risk: SCĂZUT — pur frontend, read-only; NU atinge copierea, semnarea, sau logica de flux
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. NU atinge `crud.mjs`, `formular-shared.mjs`, helper-ul de copiere — logica de copiere atașamente NU se schimbă deloc.

## Context (de ce)
La compose (semdoc-initiator), utilizatorul vede widget-ul manual „Documente suport — Adaugă fișier" (`main.js:1858`, lista `_attachFiles`), dar NU vede atașamentele care VOR FI preluate din formular la lansare (copiate în `flow_attachments` de fix 11, în POST /flows). Lipsește doar VIZIBILITATEA: utilizatorul nu știe ce documente vin deja din formular, deci nu știe ce să mai adauge.

Copierea reală rămâne neschimbată (la lansare). Acest enhancement DOAR afișează, înainte de lansare, ce atașamente există pe formular.

## Resurse care EXISTĂ deja (reutilizează, nu reinventa)
- Endpoint listare: `GET /api/formulare-atasamente/:type/:id` (server/routes/formulare/shared.mjs:187) — întoarce lista atașamentelor formularului (filename, mime, size; FĂRĂ data). `:type` = `df`/`ord`.
- Endpoint descărcare/preview: `GET /api/formulare-atasamente/:type/:id/:attId` (shared.mjs:225).
- Modalul de preview unificat (fix 5) — refolosește-l pentru „Previzualizează".
- Contextul de prefill la compose: `_prefDocId` / `_prefDocType` (main.js ~1973), respectiv `meta.dfId/ordId`. `_prefDocType` e `notafd`→`df` / `ordnt`→`ord` (vezi `_pfApi` în main.js).

## Fix (frontend-only — `public/js/semdoc-initiator/main.js` + eventual CSS)
1. La inițializarea ecranului de compose, dacă există `prefill_doc_id` + tip:
   - mapează tipul: `notafd`→`df`, `ordnt`→`ord`.
   - `GET /api/formulare-atasamente/{df|ord}/{prefill_doc_id}` (credentials include, CSRF la fel ca celelalte fetch-uri).
2. Randează rezultatul în secțiunea „Documente suport", DEASUPRA widget-ului manual, ca listă READ-ONLY:
   - antet: „📎 Vor fi preluate din formular" (sau similar);
   - per fișier: nume + dimensiune + buton „Previzualizează" (modalul fix 5) + opțional „Descarcă" (endpoint-ul de download existent);
   - dacă lista e goală sau nu există prefill → nu afișa nimic (no-op, fără erori).
3. Widget-ul manual „Adaugă fișier" (`_attachFiles`) rămâne NEATINS, dedesubt, pentru extras.
4. NU modifica `_uploadAttachments` și NU modifica payload-ul POST /flows. Lista preluată din formular e PUR informativă la compose — copierea reală o face backend-ul la lansare (fix 11). NU trimite lista asta în payload (ar dubla).

### Atenție (non-regresie)
- Read-only: NU permite ștergerea atașamentelor formularului din ecranul de compose (sursa `formulare_atasamente` e sacră — ștergerea se face doar din formular, cu lacăt). Butoanele sunt doar Previzualizează/Descarcă.
- Dacă fetch-ul pică (rețea/404) → degradare grațioasă: nu bloca lansarea, nu arăta eroare intruzivă; lista preluată e opțională vizual.
- Fără dublare: documentele „preluate din formular" și cele „manuale" sunt două liste distincte vizual; manualele se urcă prin `_uploadAttachments`, preluatele se copiază de backend. Să nu apară aceleași fișiere de două ori în `flow_attachments` — dar asta e deja garantat de idempotența `NOT EXISTS` din copiere; aici e doar afișare, deci nu introduce dublare.

## Teste
- Manual/staging (frontend pur, fără DB): DF cu 2 atașamente → compose afișează „vor fi preluate din formular: 2 fișiere" + Previzualizează funcțional; widget-ul manual adaugă un al 3-lea; lansezi → `flow_attachments` are 3 (2 preluate + 1 manual), `formulare_atasamente` neatins.
- DF fără atașamente → secțiunea „preluate" nu apare; widget manual normal.
- `node --check` pe fișierele atinse; dacă există teste de integrare pe semdoc-initiator, rulează-le. `npm test` verde, fără regresii.

## Acceptare
- Pur frontend; `git diff` NU atinge crud.mjs / formular-shared.mjs / helper copiere / NO-TOUCH.
- La compose se văd atașamentele formularului (read-only, cu preview), separat de widget-ul manual.
- Lansarea și copierea rămân identice (fix 11 neatins); `formulare_atasamente` neatins.
- Cache-bust pe `main.js` (semdoc-initiator) + CSS dacă s-a atins (`?v=`) + bump `package.json` patch.
- CLAUDE.md: o linie („compose afișează atașamentele formularului (read-only, preview) ca «vor fi preluate din formular», prin GET /api/formulare-atasamente/:type/:id; copierea reală rămâne la lansare").

## Finalizare
```
git add <fișierele acestei sarcini: main.js (semdoc-initiator), CSS?, CLAUDE.md, package.json>
git commit -m "feat(compose): afișează atașamentele formularului care vor fi preluate în flux (read-only, preview) înainte de lansare"
git push origin develop
```
