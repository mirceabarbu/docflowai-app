---
target_branch: develop
model_suggested: Opus 4.8 (gardă financiară + paritate inline↔backend; plan mode). Caracterizare-întâi.
risk: MEDIUM-HIGH — extinde o gardă financiară pe o cale nouă (P1) + avertizare în UI.
                    Paritate strictă obligatorie. Garda P2 existentă NU se schimbă.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️
> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: verificarea de depășire buget ORD și la P1 (hard) + atenționare inline în câmp (P1 + P2)

## Decizie owner (FIXĂ — Varianta A)
La P1, depășirea de buget **BLOCHEAZĂ hard finalizarea**, exact ca la P2 (nu „warn și trece mai
departe"). În plus, atât la P1 cât și la P2, o **atenționare inline** lângă câmpul de sumă, în timp
real (soft, vizuală — nu blochează tastarea; blocajul hard rămâne la finalizare).

## Context (verificat în cod)
- `server/services/formular-shared.mjs`:
  - `validateOrdBugetAnCurent({ ordDoc, newRows, orgId })` (~:222) → 422 `buget_an_curent_depasit`
    dacă `SUM(newRows.suma_ordonantata_plata) + cicluri_arhivate(an curent) > bugetAnCurent`.
  - Rulează DOAR la finalizarea P2 (blocul `cfg.budgetCheck === 'hard_col5'`, ~:354, gardat de
    `status === 'pending_p2'`). Acolo sunt și `validateOrdCol5` (col.5 ≥ 0) + budget check.
  - **Calea P1** = handler-ul de submit `draft → pending_p2` (~:285–310). UPDATE-ul setează doar
    `status='pending_p2'`/`assigned_to`/`submitted_at` — rândurile sunt DEJA salvate în `doc`
    (autosave). Acest handler NU rulează niciun check de buget acum.

## Etapa 0 — caracterizare (înainte de cod de producție)
- Fixează comportamentul P2 actual (over-budget → 422, under → 200) ca să dovedești că NU-l strici.
- Fixează comportamentul P1 actual (submit reușește chiar și over-budget) — ca să dovedești că-l schimbi intenționat.
Rulează `npm test` + (CI/docker) `npm run test:db` verzi pe baseline.

## Modificări cerute

### Backend — checkul și la P1 (hard) — DOAR bugetul, NU col.5
- În handler-ul de submit P1 (`draft → pending_p2`), ÎNAINTE de UPDATE-ul de status, dacă
  `cfg.budgetCheck === 'hard_col5'`, rulează **DOAR**
  `validateOrdBugetAnCurent({ ordDoc: doc, newRows: doc.rows, orgId: actor.orgId })`
  și returnează 422 dacă pică. Folosește `doc.rows` (rândurile salvate), NU body.
- **NU rula `validateOrdCol5` la P1.** Decizie owner, motiv tehnic confirmat în cod:
  `validateOrdCol5` calculează `c5 = receptii − plati_anterioare − suma_ordonantata_plata ≥ 0`,
  iar `receptii` (coloana 2 / recepția) e completată de **P2**, nu de P1. La P1 `receptii = 0`,
  deci c5 ar deveni negativ și checkul ar pica FALS de îndată ce P1 pune o sumă — blocând P1 să
  trimită vreodată. col.5 rămâne STRICT la P2 (neschimbat). La P1 se validează exclusiv plafonul
  de buget pe `suma_ordonantata_plata` (pe care P1 chiar o completează).
- NU modifica garda P2 existentă (rămâne `validateOrdCol5` + `validateOrdBugetAnCurent`).
  NU schimba `validateOrdBugetAnCurent`.

### Backend — expune datele pentru atenționarea inline
- În GET-ul care încarcă formularul ORD (cel care alimentează UI-ul P1 și P2), expune
  `buget_an_curent` ȘI `cicluri_arhivate` (suma arhivată pe anul curent), calculate cu EXACT
  aceeași logică ca `validateOrdBugetAnCurent` (același COALESCE pe an, același `bugetPentruAnul`/
  echivalent SQL). Astea sunt necesare ca frontend-ul să reproducă verdictul backend-ului.

### Frontend — atenționare inline (P1 + P2)
- În formularul ORD (găsește render-ul rândurilor cu `suma_ordonantata_plata` și handler-ul de
  editare a câmpului), la fiecare modificare de sumă calculează:
  `cumul = SUM(rânduri curente din UI) + cicluri_arhivate` și compară cu `buget_an_curent`.
- Dacă `cumul > buget_an_curent + 0.001` (ACEEAȘI toleranță ca backend), afișează o atenționare
  vizuală lângă câmp/total (text roșu + mesaj clar „depășește bugetul exercițiului YYYY"). NU bloca
  tastarea — e doar avertisment; blocajul hard rămâne la finalizare.
- Aceeași atenționare în AMBELE vederi (P1 și P2).

## Paritate (gardul real al task-ului)
Atenționarea inline TREBUIE să dea același verdict ca `validateOrdBugetAnCurent`. Test
(`test:db` + unit frontend dacă e fezabil): pentru aceleași date, verdictul inline (din valorile
expuse în GET) == verdictul backend-ului. Acoperă marginea: cumul exact la limită (egal cu buget →
NU depășește), și cumul = buget + 0.01 (depășește).

## Zone interzise
- NU atinge NO-TOUCH / `migrate.mjs` / garda din `noua-lichidare` / tranzițiile de status.
- NU modifica garda P2 (doar o oglindești la P1).

## Definition of done
- P1 finalize cu sumă peste buget → 422 (blocat), sub buget → 200. P2 neschimbat.
- Atenționare inline vizibilă la P1 ȘI P2, paritate cu backend dovedită de test.
- `npm test verde, fără regresii` + (CI) `npm run test:db verde`.
- `npm run check` verde. Cache busting `?v=` pe JS-ul ORD atins + bump `package.json` patch +1
  (citește versiunea curentă) + CACHE_VERSION dacă scriptul e în PRECACHE (`sw.js`).
- Commit + push DOAR pe `develop`. STOP înainte de `main`.
- Raport: ce cale P1 ai gardat (DOAR budget, fără col.5), ce ai expus în GET, ce fișier frontend
  ai atins, confirmarea parității inline↔backend.
