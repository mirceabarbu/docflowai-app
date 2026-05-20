# 🚀 PROMOTE develop → main — Release OPME F1129 + UI fixes

```
═══════════════════════════════════════════════════════════════════
⚠️  EXECUȚIE MANUALĂ — DocFlowAI standard
═══════════════════════════════════════════════════════════════════
Operațiunile pe `main` sunt MANUAL de către Mircea, NU prin Claude Code.
Acest fișier este ghid de execuție pentru tine, nu prompt pentru AI.
Rulezi comenzile în terminal local (Git Bash, WSL, sau echivalent).
Branch `main` = producția live (app.docflowai.ro).
═══════════════════════════════════════════════════════════════════
```

## 📦 Conținutul release-ului

Acest merge consolidează **5 commit-uri** pe `develop` într-un release pe `main`:

| Commit | Versiune | Conținut |
|---|---|---|
| `356bd92` | 3.9.466 | OPME Pachet A — schema 072 + parser XFA + endpoint /api/opme/import |
| `b23eb9f` | 3.9.467 | OPME Pachet B — matching engine + auto-confirm ALOP + helper extras |
| `5494e8a` | 3.9.468 | OPME Pachet C — UI (modal, drawer, badge Auto/Manual) + GET-uri + listă OP în card Plată |
| `f4612e8` | 3.9.469 | OPME Pachet D — audit_log + export CSV + rematch-all + E2E + docs |
| `1bc10ed` | 3.9.470 | Fix gating OPME — `_hasOpmeImportRole` query SQL corectat (UNION+LIMIT) |
| `554fe07` | 3.9.471 | UI fixes — Sec B lățimi coloane + ORD autocomplete + header compact + inputs sume |
| (latest)  | 3.9.472 | UI follow-up — td:has() pentru lățimi + sBar revert + display:none img2 + padding inputs |

**Total**: 7 commit-uri, ~94 teste noi (529 verzi pe `develop`), 2 migrări noi (072 + 073).

**Funcționalitate nouă**: import F1129 OPME cu auto-confirmare plată ALOP pe triplet `(cod_angajament, indicator_angajament, cif_beneficiar)`, înlocuiește confirmarea manuală a P2-ului pentru plățile sosite prin trezorerie.

---

## 🔒 ETAPA A — Safety checks pre-merge

```bash
# 1. Asigură-te că ești pe develop și sincronizat
git checkout develop
git pull origin develop

# 2. Verifică că working tree e clean
git status
# AȘTEPTAT: "nothing to commit, working tree clean"

# 3. Ultima rulare teste — verde obligatoriu
npm test
# AȘTEPTAT: 529+ teste verzi, zero erori, zero skipped neașteptate

# 4. Verifică ultimele commit-uri (să fie cele 7 de mai sus)
git log --oneline -10

# 5. Confirmă diff cumulativ față de main e ce te aștepți
git log main..develop --oneline
# Numărul de linii = numărul de commit-uri pe care le promovezi
```

**STOP dacă oricare din verificările de mai sus eșuează.** Nu continua până când nu sunt toate verzi.

---

## 🔀 ETAPA B — Merge --no-ff develop → main

```bash
# 1. Switch pe main
git checkout main
git pull origin main

# 2. Verifică că main NU are commit-uri locale neîmpinse
#    (ar fi ciudat, dar safety check)
git log origin/main..main --oneline
# AȘTEPTAT: gol (empty)

# 3. Merge develop cu mesaj de release complet (copy-paste TOT blocul)
git merge develop --no-ff -m "release: OPME F1129 import + auto-confirm ALOP + UI polish

Modulul OPME (Ordin de Plată Multiplă Electronic, format F1129 Forexebug)
livrat complet în 4 pachete + fix gating + 2 runde UI fixes.

Funcționalitate principală:
- Upload PDF F1129 (XFA) → parse server-side → matching automat ALOP
- Triplet matching: (cod_angajament, indicator_angajament, cif_beneficiar)
- Auto-confirmare plată pentru ALOP în status='plata' (sincron la upload
  + lazy la tranziție 'plata' pentru linii OPME pre-existente)
- Backfill matched_ciclu_id la noua-lichidare pentru cicluri arhivate
- Audit trail în audit_log (event_type='plata_auto_opme')
- Export CSV per import (BOM UTF-8, virgulă decimală RO)
- Rematch idempotent (per import sau admin global)

Pachete consolidate:
- Pachet A (356bd92, 3.9.466): schema 072 + parser + endpoint
- Pachet B (b23eb9f, 3.9.467): matcher + hook-uri auto-confirm
- Pachet C (5494e8a, 3.9.468): UI modal + drawer + listă OP card Plată
- Pachet D (f4612e8, 3.9.469): audit + CSV + E2E + docs
- Fix gating (1bc10ed, 3.9.470): _hasOpmeImportRole SQL EXISTS
- UI Fix 1 (554fe07, 3.9.471): Sec B lățimi + ORD autocomplete + header
- UI Fix 2 (3.9.472): td:has() + sBar revert + img2 + padding

Migrări noi:
- 072_opme_imports: tabelele opme_imports + opme_lines + 5 indexuri
- 073_alop_plata_source: coloană plata_source pe alop_instances + arhivă

Teste: 529 verzi total (+94 OPME-specifice).
Permisiuni: gating prin formulare_df.assigned_to / formulare_ord.assigned_to
            (modelul real P2 = utilizator asignat ca Responsabil CAB).

NO-TOUCH respectat pe toată durata: cloud-signing.mjs, bulk-signing.mjs,
pades.mjs, java-pades-client.mjs, STSCloudProvider.mjs intacte.

Known-issues nerezolvate (pentru sesiune viitoare):
- Captură 2 din ORD afișează broken icon dacă img2 lipsește în DB
  (non-blocker, vizual minor, nu afectează salvare/PDF gen)
"

# 4. Verifică că merge commit-ul s-a creat corect
git log --oneline -3
# AȘTEPTAT: ultimul = merge commit, înainte ultimele commit-uri de pe develop

# 5. Push pe origin/main
git push origin main
```

---

## 🏷️ ETAPA C — Tag release (opțional dar recomandat)

```bash
# Tag-uire pentru audit ușor în viitor
git tag -a v3.9.472 -m "Release OPME F1129 + UI polish — auto-confirm ALOP plată"
git push origin v3.9.472
```

---

## 🚂 ETAPA D — Monitor Railway deploy

1. Deschide [Railway dashboard](https://railway.app) → proiect `docflowai-app`
2. Deployments tab → urmărește deployment-ul nou pe `main` declanșat automat de push
3. **Build phase** (~2-3 min): verifică log-urile pentru erori `npm install` sau `npm run build`
4. **Deploy phase** (~30s): verifică că aplicația pornește
5. **În logs, caută la pornire**:
   ```
   Migrare: 072_opme_imports ... OK
   Migrare: 073_alop_plata_source ... OK
   ```
   Dacă apare `SKIP (already applied)` pentru migrările 072/073 — OK, înseamnă că au fost aplicate deja pe environment-ul staging și aceleași migrări rulează pe production prima oară.

6. Verifică `https://app.docflowai.ro/` se încarcă (pagina de login)
7. Verifică în Network tab că răspunsul `/health` (sau echivalent) returnează versiunea corectă

---

## ✅ ETAPA E — Smoke test pe producție (~5 minute)

Login cu un utilizator de test pe producție (sau cu utilizator real, dacă ai unul dedicat de smoke test):

| # | Test | Așteptat |
|---|---|---|
| 1 | Login funcționează | OK, intri pe dashboard |
| 2 | Pagina **ALOP** se încarcă | Listing-ul ALOP-urilor afișat corect |
| 3 | Pentru user cu rol P2 (Responsabil CAB pe vreun DF/ORD): butonul **„Import OPME"** vizibil în antet ALOP | Vizibil |
| 4 | Click „Import OPME" → deschide modal drag&drop | OK |
| 5 | (Opțional, dacă ai un F1129 real de producție) Upload → primește raport `{matched: N, ambiguous: 0, ...}` | Raport corect, fără 500 |
| 6 | Pagina **DF** → deschide un DF aprobat → vezi bara verde **„✅ Document aprobat"** + header compact | Toate prezente |
| 7 | **Sec B DF** → coloana **Cod SSI** (15 chars) și **Program** (10 chars) integral vizibile fără trunchiere | OK |
| 8 | **ORD** din ALOP în Lichidare → confirmare lichidare → deschide ORD → tabela auto-completată cu rândurile din DF aprobat din primul moment (NU trebuie să schimbi DF-ul manual) | OK |
| 9 | Pagina DF cu inputurile **„Nu s-au rezervat..."** → înălțime vizibilă, nu turtite | OK |
| 10 | Service Worker activ — în DevTools → Application → Service Workers, vezi versiunea nouă | OK |
| 11 | **Captură 2** ORD: deschidere ORD fără captură 2 → zona afișează broken icon (known issue, NU blocker) | Acceptabil pentru release-ul ăsta |

**STOP dacă** oricare din testele 1-9 eșuează. Mergi la ETAPA F (rollback).

---

## 🚨 ETAPA F — Rollback plan (dacă ceva pică pe producție)

```bash
# 1. Identifică hash-ul merge commit-ului tocmai făcut pe main
git log --oneline main -5

# 2. Revert merge commit (-m 1 = primary parent = main pre-merge)
git revert -m 1 <merge-commit-hash> --no-edit

# 3. Push revert pe main
git push origin main
```

Railway detectează push-ul și re-deploy production la starea anterioară (3.9.465 sau ce era pe `main` înainte). Migrările 072 + 073 rămân aplicate în DB (NU sunt rollback-uite — schema-ul e backward compatible: noile tabele nu sunt folosite de codul vechi, doar ignorate).

După rollback stabil:
- Capturi screenshot DevTools + log Railway al erorii
- Diagnoză pe `develop`
- Re-fix → re-test → re-merge

---

## ✅ Criterii succes release

- [ ] Merge `--no-ff develop → main` cu succes
- [ ] Push origin main fără erori
- [ ] Tag `v3.9.472` pushed (opțional)
- [ ] Railway deploy production finalizat fără erori
- [ ] `https://app.docflowai.ro/` se încarcă
- [ ] Migrările 072 + 073 aplicate (log Railway)
- [ ] Smoke test 1-9 toate verzi
- [ ] Cunoscute neblocator: captură 2 broken icon — notat pentru fix viitor

---

## 🎉 La sfârșit

Dacă toate verzi:

**Release OPME COMPLET ÎNCHIS PE PRODUCȚIE.**

Funcționalitate nouă disponibilă:
- Import OPME F1129 pentru P2 (Responsabili CAB) și admin
- Auto-confirmare plată ALOP (înlocuiește confirma-plata manual pentru
  plățile sosite prin trezorerie)
- Audit complet în drawer raport + CSV export

Total adăugat din ianuarie până la acest release pe OPME:
- 7 commit-uri pe develop
- 2 migrări DB (072, 073)
- 2 servicii noi (opme-parser.mjs, opme-matcher.mjs)
- 1 rută nouă (opme.mjs cu 8 endpoint-uri)
- 2 componente UI globale (DFOpmeImportModal, DFOpmeReportDrawer)
- ~94 teste noi
- Documentație: docs/opme-import.md + secțiune CLAUDE.md

**🏆 Release închis.**

---

## 📝 Pentru sesiune viitoare (TODO)

1. **Captură 2 broken icon** — diagnoză + fix proper (inspect element pe `<img id="o-cimg2">` să vezi style/display efectiv, plus verifică `populateOrd` în doc.js pentru toate path-urile de afișare).
2. **Eventuală unificare a celor 2 afișaje „Document aprobat"** — dacă vrei să revenim pe asta, începem cu screenshot complet al paginii DF aprobat ca să mapăm vizual toate elementele.
3. Orice apare la smoke test sau de la utilizatori reali pe producție.
