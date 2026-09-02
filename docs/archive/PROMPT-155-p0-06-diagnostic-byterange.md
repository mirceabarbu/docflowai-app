# PROMPT-155 — P0-06, pasul 1: diagnostic READ-ONLY „câte fluxuri au PDF fără semnătură reală"

⚠️ BRANCH: develop — NICIODATĂ main. `main` e producția, gestionată manual doar de Mircea.

**model_suggested:** Sonnet 5 (script nou, mecanic, strict citire — risc mic prin construcție)
**cache_version_bump:** NU (fișier nou în `tools/`, nu e servit către browser)
**migrations:** NU
**Acest lot NU se rulează de tine (agentul) pe producție.** Scrii fișierul, îl verifici local
(sintaxă + eventual pe o bază de test), îl commiți, îl pui pe `develop`. Rularea lui reală pe
producție e a lui Mircea, seara, off-peak — vezi „Cum se rulează" mai jos.

## Context

P0-06 (singurul P0 rămas din auditul extern) e garda moartă din `signing.mjs:404` — un PDF
NESEMNAT poate finaliza un flux. Planul agreat, în patru pași, e:
1. **acest script** — află retroactiv câte fluxuri deja `completed` din producție au un
   `signedPdfB64` care nu conține NICIO semnătură reală (zero apariții `/ByteRange`)
2. cod în mod OBSERVARE (scrie în audit, nu respinge)
3. flip la blocare, după o fereastră de observare curată
4. (opțional) reparație de date pe cazurile confirmate din pasul 1

Am verificat deja EU, pe cod, întrebarea care bloca pasul 1 în planul vechi — **rezolvată,
nu mai e nevoie s-o verifici tu**: `buildCartusBlob` (`public/js/semdoc-signer/main.js:963`)
desenează DOAR text și un widget `/Sig` gol (fără `/V`, fără `/Contents`, fără `/ByteRange`)
pentru cartușul vizual „SEMNAT ȘI APROBAT" — nu scrie niciodată tiparul `/ByteRange [...]`.
Deci `extractPdfSignatures` (`server/services/certificate-verify.mjs:100`) NU poate da
fals-pozitiv pe cartușul local — orice `/ByteRange` găsit într-un PDF descărcat de pe
platformă vine STRICT dintr-o semnătură reală aplicată de utilizator cu propriul instrument.

## Ce trebuie să facă scriptul

Fișier nou: `tools/diagnostic-p0-06-byterange-check.mjs`

1. Pool PROPRIU din `DATABASE_URL` (⛔ NU importă `server/db/index.mjs` — regula stabilită la
   #113, ca să nu declanșeze migrațiile inline pe conexiunea de diagnostic). Oglindește STRICT
   header-ul din `tools/repair-alop-status.mjs` (încărcarea manuală a `.env`, fără dependență
   nouă de `dotenv`).
2. STRICT READ-ONLY — zero `UPDATE`/`INSERT`/`DELETE` oriunde în fișier. Verifică asta chiar
   tu cu un grep înainte de raport (vezi verificarea de mai jos).
3. Importă `extractPdfSignatures` din `../server/services/certificate-verify.mjs` — NU
   reimplementa regexul de `/ByteRange` separat (clasa de bug #115: două motoare paralele
   care ajung să diverjă).
4. Interogarea de candidați (fluxuri finalizate, vii, cu artefact de semnătură stocat),
   folosind filtrul canonic „aprobat"/completed din `CLAUDE.md`/convențiile proiectului:

```sql
SELECT f.id, f.data->>'docName' AS doc_name, f.data->>'completedAt' AS completed_at
FROM flows f
WHERE (f.data->>'status'='completed' OR (f.data->>'completed')::boolean=true)
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
  AND f.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM flows_pdfs p WHERE p.flow_id=f.id AND p.key='signedPdfB64')
ORDER BY f.id
```

   Separat, numără (fără să le proceseze — nu au ce PDF verifica) fluxurile completate care
   NU au NICIUN rând `signedPdfB64` în `flows_pdfs` — și mai suspect decât cazul principal:

```sql
SELECT COUNT(*) FROM flows f
WHERE (f.data->>'status'='completed' OR (f.data->>'completed')::boolean=true)
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
  AND f.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM flows_pdfs p WHERE p.flow_id=f.id AND p.key='signedPdfB64')
```

5. Procesează lista de candidați în LOTURI (implicit 200, flag `--batch=N`), cu o pauză
   configurabilă între loturi (implicit 300ms, flag `--delay=N`, în ms) — ca să nu satureze
   conexiunea dacă rulează în timpul programului. Pentru fiecare lot:
   - `SELECT flow_id, data FROM flows_pdfs WHERE key='signedPdfB64' AND flow_id = ANY($1::text[])`
     (un singur query per lot, nu unul per flux)
   - pentru fiecare rând, SECVENȚIAL (nu ține toate bufferele lotului în memorie deodată):
     `Buffer.from(row.data, 'base64')` → `extractPdfSignatures(buf).length`
   - dacă rezultatul e `0` → flux marcat SUSPECT (candidat P0-06 real)
6. Flag opțional `--limit=N` — limitează la primii N candidați (pentru un test rapid pe un
   eșantion mic înainte de rularea completă)
7. Output pe măsură ce avansează (progres pe loturi) + un sumar final: total candidați
   verificați, câți SUSPECȚI (0 semnături), câți SĂNĂTOȘI (≥1 semnătură), plus numărul de la
   pasul 4 (completate fără NICIUN `signedPdfB64` stocat)
8. Lista fluxurilor SUSPECTE se scrie și într-un fișier `docs/audits/P0-06-DIAGNOSTIC-<data>.md`
   (id flux, `doc_name`, `completed_at`) — pentru ca Mircea să poată trece prin ele fără să
   rulezi din nou scriptul
9. `pool.end()` în `finally`, indiferent de rezultat

## Verificări obligatorii înainte de a scrie codul

```bash
git branch --show-current
# Așteptat: develop

grep -n "^export function extractPdfSignatures" server/services/certificate-verify.mjs
# Așteptat: 1 potrivire — confirmă semnătura exactă a funcției pe care o imported

grep -n "CREATE TABLE IF NOT EXISTS flows_pdfs" -A 8 server/db/index.mjs
# Așteptat: confirmă coloanele flow_id/key/data TEXT — dacă schema s-a schimbat față de
# premisa acestui prompt, OPREȘTE-TE și raportează înainte de a scrie scriptul
```

## Verificări după ce scrii fișierul

```bash
node --check tools/diagnostic-p0-06-byterange-check.mjs
# Așteptat: fără erori de sintaxă

grep -c "UPDATE \|INSERT INTO\|DELETE FROM" tools/diagnostic-p0-06-byterange-check.mjs
# Așteptat: 0 — scriptul e STRICT read-only

grep -c "server/db/index.mjs" tools/diagnostic-p0-06-byterange-check.mjs
# Așteptat: 0 — nu importă modulul de bază de date al aplicației

grep -c "extractPdfSignatures" tools/diagnostic-p0-06-byterange-check.mjs
# Așteptat: ≥2 (import + apel)
```

## Cum se rulează (de pus în comentariul de antet al fișierului, ca la scripturile-precedent)

```
DATABASE_URL=postgres://... node tools/diagnostic-p0-06-byterange-check.mjs
# opțional: --batch=200 --delay=300 --limit=50   (--limit pentru un test rapid întâi)
```

Recomandare operațională de scris explicit în comentariul de antet: se rulează SEARA, în
afara orelor de program, fiindcă decodează efectiv PDF-uri (potențial multe MB fiecare) în
loturi — nu e instant, dar nici nu blochează baza (SELECT-uri simple + decodare în Node,
nimic costisitor pe partea de Postgres).

## RAPORT FINAL (obligatoriu în răspunsul tău)

- Confirmare că fișierul e STRICT read-only (grep de mai sus)
- `node --check` trecut
- Commit hash + `git diff --stat` (un singur fișier nou)
- O rulare de test REALĂ, dacă ai acces la o bază cu date (test:db efemeră merge, chiar dacă
  n-are fluxuri reale — arată măcar că scriptul nu crapă pe o bază goală, cu 0 candidați)

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ NU rula scriptul împotriva producției — n-ai `DATABASE_URL` de producție, iar rularea
  reală e decizia și acțiunea lui Mircea
- ⛔ NU atinge `server/services/certificate-verify.mjs` — doar îl imported, nu-l modifici
- ⛔ NU scrie nicio interogare de `UPDATE`/`INSERT`/`DELETE` în acest fișier — pasul de
  reparare a datelor (dacă va fi nevoie) e un prompt SEPARAT, după ce vedem rezultatele
- ⛔ NU propune niciodată merge/push/checkout pe `main`

Ultimul pas, obligatoriu:
```bash
git push origin develop
```
