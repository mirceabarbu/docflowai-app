# FIX B (LOGICĂ BUGETARĂ): Ordonanțarea blocată hard la disponibilul anului curent

> ⚠️ **BRANCH DISCIPLINE** — EXCLUSIV pe `develop`. NU merge/push/checkout pe `main` (= producție, manual).
> **ZONA NO-TOUCH:** `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs` — zero modificări.
> 🔒 **INVARIANT (CLAUDE.md, v3.9.554):** relink ALOP de la revizie + guard `link-df` rămân neatinse.
> Recomandare model: acest prompt atinge **logică de business cu bani** — rulează-l pe **Opus 4.8** dacă vrei marjă suplimentară de siguranță; e scris să meargă și pe Sonnet 4.6.
> ⚠️ Rulează ACEST prompt DUPĂ FIX A (folosește `df_buget_an_curent` introdus acolo).

## Regula de business (confirmată de owner)

Ordonanțarea (și implicit plata) se poate face DOAR în limita „Plăților estimate în anul curent" = suma `formulare_df.rows_plati[].plati_estim_ancrt` a DF-ului aprobat (revizia activă), NU în limita angajamentului total multianual (`rows_val.valt_actualiz`). Depășirea = **blocaj hard (HTTP 422)**, simetric cu validarea existentă col.5 din `validateOrdCol5`.

Exemplu: DF aprobat cu angajament total 15.000.000 RON dar `plati_estim_ancrt` = 29.000 RON → suma ordonanțată cumulată în anul curent nu poate depăși 29.000 RON.

## Stare actuală (verificată în cod) — gap-ul

1. `validateOrdCol5` (`formular-shared.mjs` ~168) verifică doar `recepții − plăți_anterioare − ordonanțat ≥ 0` per rând. NU există plafon pe bugetul anului curent.
2. `noua-lichidare` (`alop.mjs` ~1177) calculează `ramas = dfVal − plătit` pe `dfVal = SUM(valt_actualiz)` = 15M, nu pe bugetul anului curent.

Adică azi sistemul ar permite ordonanțarea a 15M deși bugetul anului curent e 29.000. Acest fix închide gaura în ambele puncte.

## Implementare

### 1. Validare hard la finalizarea ORD (`formular-shared.mjs`, submitFormular/completare P2)

Acolo unde rulează `validateOrdCol5` pentru `cfg.budgetCheck === 'hard_col5'` (~275), adaugă o validare suplimentară de plafon an curent:

- Obține DF-ul legat: ORD-ul are `df_id` (confirmat în `ord.mjs`). Încarcă `formulare_df.rows_plati` al acelui DF.
- Calculează `bugetAnCurent = SUM(rows_plati[].plati_estim_ancrt)`.
- Calculează `ordonantatCumulatAnCurent`: suma `suma_ordonantata_plata` din ORD-ul curent (din `data.rows`) PLUS sumele deja ordonanțate în anul curent pe același DF/ALOP din alte ORD-uri completate și din ciclurile arhivate (`alop_ord_cicluri`). ATENȚIE la dublă numărare: dacă ORD-ul curent e o re-completare a unuia existent, nu-l număra de două ori. Modelează cumulul consecvent cu agregarea deja existentă din `alop.mjs` (~252, subquery-ul `formulare_ord fo2` + `alop_ord_cicluri`) — REFOLOSEȘTE aceeași logică de sumare, nu inventa alta.
- Dacă `ordonantatCumulatAnCurent > bugetAnCurent + 0.001` → întoarce `{ status: 422, body: { error: 'buget_an_curent_depasit', message: 'Suma ordonanțată în anul curent (X RON) depășește bugetul estimat al anului curent (Y RON).', bugetAnCurent, ordonantat: ordonantatCumulatAnCurent } }`.
- Defense-in-depth: backend respinge chiar dacă frontend e bypass-at (ca la col.5).

Decizii de modelare de confirmat în implementare (documentează alegerea în comentariu):
- „Anul curent" = exercițiul bugetar curent. Dacă schema NU are un marcaj explicit de an pe ORD/cicluri, tratează TOATE ORD-urile/ciclurile active ale DF-ului ca fiind în anul curent (model actual mono-an). NU introduce logică multi-an speculativă — dacă apare nevoia, e alt sprint.

### 2. Plafon la `noua-lichidare` (`alop.mjs` ~1147-1181)

Înlocuiește baza de calcul a lui `ramas`: în loc de `dfVal = SUM(valt_actualiz)`, folosește `bugetAnCurent = SUM(rows_plati.plati_estim_ancrt)` al DF-ului (`alop.df_id`). `ramas = bugetAnCurent − sumaPlata`. Mesajul de eroare `limita_depasita` actualizat să refere bugetul anului curent, nu valoarea DF totală.

ATENȚIE — interacțiune cu invariantul noua-lichidare post-revizie: după revizuirea DF-ului, `bugetAnCurent` se recalculează pe revizia nouă (via `alop.df_id`, deja relegat). Dacă revizia mărește `plati_estim_ancrt`, `ramas` crește corect → ciclu nou posibil. Testează explicit acest lanț.

### 3. Frontend — feedback la depășire

În modulul ORD (`doc.js` / `ord.js`): la primirea erorii `buget_an_curent_depasit`, afișează mesaj clar cu cele două sume (folosește mecanismul de eroare existent, ca la `receptii_neplatite_negative`). Opțional, indicator soft live în UI pe măsură ce se completează `suma_ordonantata_plata` vs. buget an curent — dacă e ușor în structura existentă; altfel doar mesajul de la 422.

### 4. Teste (cazuri critice)

- ORD cu suma_ordonantata ≤ buget an curent → trece (200).
- ORD cu cumulat > buget an curent → 422 `buget_an_curent_depasit` cu sumele corecte.
- Cumul corect peste mai multe ORD-uri/cicluri pe același DF — fără dublă numărare.
- `noua-lichidare`: `ramas` calculat pe `plati_estim_ancrt`, nu pe `valt_actualiz`; `limita_depasita` când bugetul an curent e epuizat chiar dacă angajamentul total mai are loc.
- Caracterizare: `validateOrdCol5` (col.5 ≥ 0) rămâne neschimbat și rulează ÎNAINTE de noul plafon (ordinea verificărilor documentată).
- Invariant: revizie care mărește `plati_estim_ancrt` → `noua-lichidare` permite ciclu nou.

## Criterii de acceptare

- `npm test` verde, fără regresii. Teste noi pentru toate cazurile de mai sus.
- NO-TOUCH + invariant relink: `git diff` curat (în `alop.mjs` se schimbă DOAR calculul `ramas` din `noua-lichidare`, NU WHERE-ul relink-ului ~468 sau guard-ul ~753).
- Cache-bust țintit, bump `package.json`, CLAUDE.md: secțiune scurtă („Ordonanțare plafonată hard pe bugetul anului curent = SUM(rows_plati.plati_estim_ancrt); col.5 ≥ 0 rămâne validare separată; noua-lichidare calculează `ramas` pe bugetul anului curent, nu pe angajamentul total").
- Commit-uri mici, doar pe `develop`.
