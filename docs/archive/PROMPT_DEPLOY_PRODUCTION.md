# DocFlowAI — 🚀 DEPLOY PRODUCTION: merge develop → main (toate v3.9.434 → v3.9.441)

```
DocFlowAI — production deploy
Branch: develop → main
Commituri incluse: v3.9.434 .. v3.9.441 (8 livrări)

═══════════════════════════════════════════════════════════
CE INTRĂ ÎN PRODUCȚIE — REZUMAT
═══════════════════════════════════════════════════════════

  v3.9.434  outreach fix (.dockerignore PDF brosură + dropdown
            color-scheme + ALOP în template)
  v3.9.435  soft-delete users + organizations (mig 067, partial
            unique index pe email pentru reuse după dezactivare)
  v3.9.436  reactivare users/orgs cu conflict detection
  v3.9.437  refactor org admin UI: tabel + detail view cu 5 sub-tabs
            (General/Users/Webhook/Signing/Stats) + 2 endpoint-uri
            noi backend
  v3.9.438  RN fix save (1MB→50MB body limit) + atașamente Caiet
            sarcini sect J + Estimare valoare sect F (mig 068)
  v3.9.439  hotfix STS PAdES: stampFooterOnPdf save AFTER addPage
            (rezolvă IndexOutOfBoundsException pentru PDF-uri unde
            cartușul nu încape pe pagina existentă)
  v3.9.440  gap placement cartuș — plasare în cea mai joasă bandă
            goală >= cartusH+30 (în loc de mereu „la baza")
  v3.9.441  parser detectContentYs prinde Td/TD (PDF-uri office
            LibreOffice/Word) — fix definitiv „pagină inutilă"

DB MIGRATIONS noi (idempotente, non-destructive):
  067_soft_delete_users_orgs   — ALTER TABLE ADD deleted_at + index
  068_formular_attachments     — CREATE TABLE attachments

Cache final: 3.9.441 / SW v157.

═══════════════════════════════════════════════════════════
PASUL 0 — PRE-FLIGHT (5 min, OBLIGATORIU înainte de merge)
═══════════════════════════════════════════════════════════

Pe orice computer (oriunde ai develop la zi):

# 0.1 Sincronizează local
git fetch --all --prune
git checkout develop
git pull origin develop

# 0.2 Verifică versiune curentă
grep '"version"' package.json
# AȘTEPTAT: "version": "3.9.441"
grep "^const CACHE_VERSION" public/sw.js
# AȘTEPTAT: docflowai-v157

# 0.3 Listează exact ce vine în main
git log origin/main..develop --oneline | nl
# Așteptat: 8 commituri (v3.9.434 → v3.9.441), eventual mai multe
# dacă ai și alte commituri intermediare.

# 0.4 Verifică dacă main are commit-uri DIVERGENTE (hotfix-uri direct)
git log develop..origin/main --oneline
# Așteptat: gol (main e direct ascendent al develop)
# Dacă apare ceva: opriți, alegeți strategia merge --no-ff (PASUL 1B)

# 0.5 Build + teste verzi local pe develop
npm ci
npm run check    # TypeScript / lint
npm test         # vitest suite
# AȘTEPTAT: toate teste verzi, fără warnings critice

# 0.6 Verificare CRITICĂ pe staging (test smoke înainte de prod)
# Deschide https://docflowai-app-staging.up.railway.app/ și testează:
#   ☐ Login funcționează
#   ☐ Creează flux nou cu un .docx → 1 pagină în signer (NU 2)
#   ☐ Semnează cu STS → primește PDF semnat fără eroare „page 2 out of bounds"
#   ☐ Tab Organizații se deschide → tabel + click pe rând deschide detail
#   ☐ Tab Utilizatori → filtru status (activi/dezactivați/toți) merge
#   ☐ RN form → click „Salvează draft" → fără stuck infinit
#   ☐ /admin#organizatii/123 (URL direct) → deschide detail org

# 0.7 Backup DB ÎNAINTE de deploy production (hard requirement)
# Pe Railway:
#   Postgres service → ⋮ → Backup → "Create manual backup"
#   Așteaptă să termine (1-3 min). Notează timestamp.

═══════════════════════════════════════════════════════════
PASUL 1A — MERGE FAST-FORWARD (cazul comun)
═══════════════════════════════════════════════════════════

Dacă PASUL 0.4 a returnat gol (main NU are commit-uri divergente):

git checkout main
git pull origin main
git merge --ff-only develop
# Dacă funcționează: main avansează direct la HEAD-ul develop.
# Dacă eșuează cu "Not possible to fast-forward": treci la PASUL 1B.

git push origin main
# Railway auto-detectează push pe main → declanșează build production.

═══════════════════════════════════════════════════════════
PASUL 1B — MERGE COMMIT (cazul cu hotfix direct pe main)
═══════════════════════════════════════════════════════════

Dacă PASUL 0.4 a arătat commituri pe main care nu sunt în develop:

git checkout develop
git pull origin develop

# Întâi mergem main → develop ca să rezolvăm conflicte LOCAL pe develop
git merge --no-ff origin/main -m "merge: sync main hotfixes into develop"
# Rezolvă orice conflict (improbabil, dar posibil pe package.json/sw.js
# dacă a fost aplicat un hotfix de versiune direct pe main).

# Verifică build după merge
npm test
# Verde → continuă. Roșu → STOP, investighează.

git push origin develop

# Apoi mergem develop → main
git checkout main
git pull origin main
git merge --no-ff develop -m "release: v3.9.434 → v3.9.441 (deploy production)

Include:
- v3.9.434 outreach fix (.dockerignore brosură PDF, ALOP template)
- v3.9.435 soft-delete users + organizations (mig 067)
- v3.9.436 reactivare users/orgs
- v3.9.437 refactor org admin UI (tabel + detail view 5 tabs)
- v3.9.438 RN fix save + atașamente sect F & J (mig 068)
- v3.9.439 hotfix STS PAdES save order (IndexOutOfBoundsException)
- v3.9.440 gap placement cartuș (mid-page in empty bands)
- v3.9.441 parser detectContentYs Td/TD (PDF-uri office)

Migrations idempotente (067, 068). Cache 3.9.441 / SW v157.
Verzi pe staging: signing STS, soft-delete, reactivare, RN, atașamente.
"

git push origin main

═══════════════════════════════════════════════════════════
PASUL 2 — WATCH PRODUCTION DEPLOY (3-5 min)
═══════════════════════════════════════════════════════════

# 2.1 Pe Railway, deschide log-ul producției:
#     Project → docflowai-app (production env) → Deployments → cel mai recent
#     URMĂREȘTE log-ul în timp real

# 2.2 Aștept-ai să apară în log:
#     - "Build successful"
#     - "Migrations: aplicare 067_soft_delete_users_orgs..." → "OK"
#     - "Migrations: aplicare 068_formular_attachments..." → "OK"
#     - "Server listening on port 8080"
#     - "v: 3.9.441" în primul request

# 2.3 Health check direct
curl -s https://app.docflowai.ro/health | jq .
# AȘTEPTAT: { "ok": true, ... }

# 2.4 Verifică versiunea live
curl -s https://app.docflowai.ro/api/version 2>/dev/null || \
  curl -sI https://app.docflowai.ro/ | grep -i "docflowai\|x-version"
# Aștept-ai 3.9.441 (sau verifică în UI după login)

═══════════════════════════════════════════════════════════
PASUL 3 — SMOKE TEST PRODUCTION (5-10 min)
═══════════════════════════════════════════════════════════

Login pe https://app.docflowai.ro/ cu un cont admin de test, apoi:

  ☐ TEST 1 — STS signing (cazul critic care era stricat)
    1. Creează flux nou cu un .docx
    2. PDF preview → 1 pagină
    3. Adaugă un semnatar (tu însuți cu STS configurat)
    4. Semnează cu STS
    → PASS dacă: PDF rezultat semnat fără eroare „page 2 out of bounds"

  ☐ TEST 2 — soft-delete + reactivare org (mig 067)
    1. Creează un org de test
    2. Tab Organizații → click rând → Detail General → Zona periculoasă
       → Șterge organizația
    3. Filtru „Doar dezactivate" → vezi org-ul cu badge DEZACTIVATĂ
    4. Click ↻ Reactivează
    → PASS dacă: org reapare ca ACTIVĂ

  ☐ TEST 3 — atașamente RN (mig 068)
    1. Creează un Referat de Necesitate, salvează draft
    2. Sect F → upload un PDF de „demonstrare estimare valoare"
    3. Sect J → bifează „Există Caiet de sarcini" → upload PDF
    → PASS dacă: ambele atașamente apar în liste cu butoane Download/Șterge

  ☐ TEST 4 — UI tab Organizații (refactor)
    1. Tab Organizații → vezi tabel cu coloane
       Nume / CIF / Useri / Fluxuri / Webhook / Status / Activitate / Acțiuni
    2. Caută în tabel după nume
    3. Click rând → detail cu 5 sub-tabs
    4. URL devine /admin#organizatii/<id>
    5. Browser back → revine la lista
    → PASS dacă: tot funcționează fluid, fără erori console

  ☐ TEST 5 — webhook config preserved
    1. Detail org cu webhook configurat → tab Webhook
    2. Verifică că URL + Events + secret marker sunt populate
    → PASS dacă: config-ul webhook EXISTENT NU a fost șters
       (verifică suplimentar SQL: signing_providers_config nu e {})

═══════════════════════════════════════════════════════════
PASUL 4 — POST-DEPLOY MONITORING (24h)
═══════════════════════════════════════════════════════════

# 4.1 Log Railway production în primele 30 min
railway logs --service docflowai-app | grep -iE "error|warn|exception" | head -50
# CAUTĂ: orice error 500, exception necunoscută, OOM, timeout

# 4.2 Verifică audit_log pentru anomalii
psql $DATABASE_URL -c "
  SELECT event_type, COUNT(*)
    FROM audit_log
   WHERE created_at >= NOW() - INTERVAL '1 hour'
   GROUP BY event_type
   ORDER BY 2 DESC;
"

# 4.3 Verifică că NU există fluxuri stuck în 'pending sign' fără progres
psql $DATABASE_URL -c "
  SELECT id, created_at, data->>'status' AS status
    FROM flows
   WHERE created_at >= NOW() - INTERVAL '1 hour'
     AND deleted_at IS NULL
   ORDER BY created_at DESC LIMIT 20;
"

═══════════════════════════════════════════════════════════
PLAN ROLLBACK (în caz de probleme grave)
═══════════════════════════════════════════════════════════

⚠ Dacă production-ul e parțial broken (TEST 1-5 eșuează), AI 2 OPȚIUNI:

  A. ROLLBACK SOFT (preferat — păstrează DB migrations 067, 068)
  Pe Railway:
    Production → Deployments → găsește deploy-ul ANTERIOR (v3.9.433
    sau echivalent dinaintea merge-ului) → ⋮ → Redeploy
  Avantaj: păstrează migrările (067, 068 sunt non-destructive,
  rămânerea lor în DB nu strică nimic).
  Dezavantaj: codul vechi nu folosește deleted_at — useri șterși cu
  v3.9.435 vor reveni în liste (nu-i dramă, sunt doar marcați
  deleted_at în DB).

  B. ROLLBACK HARD (revert merge commit + redeploy)
  git checkout main
  git revert -m 1 <SHA-MERGE-COMMIT>
  git push origin main
  Railway redeployază automat.
  Avantaj: revine la starea exactă pre-merge.
  Dezavantaj: migrările 067, 068 rămân în DB (idempotent,
  nu sunt re-rulate, dar coloanele rămân — fără efect pe codul vechi).

⚠ NU ȘTERGE migrările din DB. Rollback de migration nu e implementat
  și ar pierde date (ex: dacă useri au fost dezactivați cu v3.9.435,
  ștergerea coloanei deleted_at i-ar pierde definitiv).

═══════════════════════════════════════════════════════════
CHECKLIST FINAL
═══════════════════════════════════════════════════════════

Înainte să închei sesiunea de deploy, asigură-te că:

  ☐ git push origin main făcut, Railway a finalizat deploy-ul
  ☐ Migrations 067 + 068 aplicate cu succes (verificate în log)
  ☐ TEST 1 (STS signing) — PASS
  ☐ TEST 2-5 — PASS (sau notat care nu poate fi testat acum)
  ☐ Backup DB existent (timestamp notat)
  ☐ Production version = 3.9.441 (verificat în UI sau /api/version)
  ☐ Niciun error 500 în log production în primele 10 min

Dacă tot e ✅ — MERGE COMPLET CU SUCCES.

Dacă vreun ☐ rămâne nemarcat — investighează ÎNAINTE să închei.
Dacă e ceva critic stricat — execută rollback (SOFT preferabil).
```
