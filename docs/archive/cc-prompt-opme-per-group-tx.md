---
target_branch: develop
model_suggested: Opus 4.8 (logică financiară + concurență; plan mode înainte de editare)
risk: MEDIUM-HIGH — atinge calea de confirmare financiară OPME. Caracterizare-întâi OBLIGATORIE.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️

> NU atinge `main` (producție, manual de Mircea). Checkout/merge/push DOAR pe `develop`.

# Task: matchImport pe tranzacții per-grup + raportare a rezultatului parțial

## Decizie de design (owner, FIXĂ — nu o renegocia)
Importul OPME **NU** necesită atomicitate de batch. Dacă grupul 9 pică, primele 8
confirmate **rămân** confirmate. ÎN SCHIMB, rezultatul parțial **trebuie comunicat
userului** printr-un mesaj clar (confirmate / rămase pending / erori cu motiv).
Un eșec de grup NU mai are voie să se ascundă într-un 500.

## Context (verificat pe codul original; RE-CITEȘTE current, liniile au driftat după P0.2 f78b505)
- `server/services/opme-matcher.mjs`:
  - `matchImport(importId, opts)` deschide UN SINGUR `BEGIN` (~:62), iterează
    `groups.values()` (~:161), `COMMIT` la final (~:183). Fiecare `_processGroup`
    face `SELECT id FROM alop_instances WHERE id=$1 FOR UPDATE` (~:294) pe câte un
    alop diferit. Pattern-ul `ownClient` EXISTĂ deja (`if (ownClient) COMMIT/ROLLBACK`).
  - Raportul întors are `{ matched, ambiguous, unmatched, partial, results[] }`;
    `_processGroup` întoarce `{ alop_id, result: 'matched'|'no_lines'|'already_confirmed'|... }`.
  - `summarizeReport(rep)` există.
- Call-site-uri (`server/routes/opme.mjs`):
  - upload (~:234) — `matchImport` în try cu `catch` non-fatal (liniile rămân pending).
  - rematch (~:525) — `res.json({ ok:true, match_report })`; `catch` → 500.
  - rematch-all (~:669) — buclă per-import, `catch` non-fatal per import, întoarce summary.

Problema (din auditul de lock-ordering): BEGIN-ul unic ține zeci de lock-uri de rând
ALOP pe tot importul (contenție cu `confirma-plata` manual) ȘI deschide o fereastră
de deadlock multi-ALOP între două importuri concurente.

## Etapa 0 — caracterizare (înainte de orice modificare de producție)
Fixează comportamentul CURENT ca să detectezi regresii:
- forma raportului `matchImport` (câmpurile `matched/ambiguous/unmatched/partial` +
  `results[]`) pe un import cu mix de grupuri;
- idempotența: a doua rulare pe grupuri deja confirmate NU dublează confirmarea
  (garda `status='plata' AND plata_confirmed_at IS NULL` din `applyPlataConfirmedSideEffects`);
- comportamentul actual all-or-nothing pe eroare (documentează-l, ca să dovedești
  că-l schimbi intenționat).
Rulează `npm test` + (cu docker) `npm run test:db` → verzi pe baseline.

## Modificări cerute
1. **Per-grup tranzacțional.** Elimină `BEGIN`/`COMMIT`-ul unic care înconjoară
   bucla din `matchImport`. Fiecare grup rulează în propria tranzacție scurtă
   (folosește calea `ownClient` din `_processGroup`, sau wrappează fiecare
   iterație): `BEGIN` → `FOR UPDATE` pe alop-ul lui → muncă → `COMMIT`. La eroare
   pe un grup: `ROLLBACK` DOAR pe grupul ăla, înregistrează `{ alop_id, result:'error', reason }`
   în raport, și **continuă bucla**. Un grup picat nu abortează importul.
   - NU adăuga pre-lock global `WHERE id = ANY($1) ORDER BY id FOR UPDATE`. Per-grup
     elimină deadlock-ul prin construcție (max 1 lock de ALOP la un moment dat);
     pre-lock-ul ar reintroduce exact contenția pe care o rezolvi.
2. **Write-uri de nivel import.** Verifică dacă era ceva scris la nivel de
   matchImport (status import / timestamp / `matched_at`) ÎN vechea tranzacție.
   Dacă da: mută-l într-un statement mic standalone DUPĂ buclă (fără atomicitate de
   batch, conform deciziei owner). Dacă NU există → nimic de făcut.
3. **Raport extins.** Adaugă categoria de erori per-grup (`errors[]` cu
   `{ alop_id, reason }` + un `error_count`). `summarizeReport` trebuie să le includă.
4. **Mesaj către user pe TOATE cele 3 call-site-uri:**
   - upload: întoarce în răspuns sumarul (confirmate / rămase pending / erori),
     nu-l înghiți tăcut.
   - rematch: include erorile per-grup în `match_report`; NU mai da 500 pe un eșec
     de grup (500 doar pentru eșec real de infra, ex. DB down).
   - rematch-all: agregă erorile per-import + per-grup în summary.
5. **Frontend.** Găsește consumatorul în `public/js/` (zona OPME) și asigură-te că
   rezultatul parțial — în special erorile și „rămase pending" — se AFIȘEAZĂ ca
   mesaj vizibil, nu se pierde. Dacă schimbi forma răspunsului, actualizează
   consumatorul corespunzător (cache busting dacă atingi JS/CSS).

## Test cheie (cel care validează cerința owner-ului)
Un test `test:db`: import cu N grupuri unde unul e forțat să eșueze (ex. ALOP
inexistent / triplet invalid) → celelalte grupuri rămân confirmate ÎN DB ȘI raportul
conține grupul eșuat în `errors[]`. Plus: idempotență păstrată la re-rulare.
(NU încerca să provoci un `40P01` real — e timing-flaky; cu per-grup deadlock-ul
oricum dispare prin construcție. Asertează invariantul de izolare per-grup.)

## Zone interzise
- NO-TOUCH signing (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
  `pades.mjs`, `java-pades-client.mjs`) + `migrate.mjs` — neatinse.
- NU schimba garda de idempotență `status='plata' AND plata_confirmed_at IS NULL`.
- NU atinge tranzițiile de status guardate care merg deja.

## Definition of done
- `npm test verde, fără regresii` + (cu docker, sau CI) `npm run test:db verde`,
  incluzând testul de izolare per-grup de mai sus.
- `npm run check` verde.
- Cele 3 call-site-uri întorc sumar cu parțial + erori; frontend-ul îl afișează.
- Bump `package.json` patch +1 (citește versiunea CURENTĂ, nu hardcoda). Cache
  busting dacă ai atins frontend.
- Commit + push DOAR pe `develop`. Confirmă jobul CI verde pe develop (audit + test
  + test:db). STOP înainte de orice gând spre `main`.
- Raport: ce write de import ai mutat (dacă vreunul), forma nouă a raportului,
  ce call-site-uri și ce fișier frontend ai atins, link la run-ul CI verde.
