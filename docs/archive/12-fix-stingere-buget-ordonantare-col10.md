---
fix: 12 — Bifa „Stingere" rupe bugetul: verificarea la ordonanțare trebuie pe credite bugetare (col.10), cardul pe tabel 1
target_branch: develop
model_suggested: Opus 4.8 (logică financiară ALOP multi-sit + distincție ordonanțat/plătit — risc ridicat, bani publici)
risk: RIDICAT — atinge plafonul de buget la ordonanțare/noua-lichidare. DIAGNOSTIC READ-ONLY OBLIGATORIU înainte de orice modificare.
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

# ⚠️ BANI PUBLICI — DIAGNOSTIC ÎNAINTE DE FIX
Aceasta schimbă plafonul de buget la ordonanțare. NU modifica nimic până nu confirmi în RAPORT pașii de diagnostic. Owner-ul (Mircea, expert ALOP) a confirmat regula de domeniu — respect-o LITERAL, nu o reinterpreta.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`.

## Regula de domeniu (confirmată de owner)
DF-ul are trei tabele (JSONB pe `formulare_df`):
- **Tabel 1** = `rows_val` (pct.4 „Valoarea angajamentelor legale"), total = `valoare_totala`.
- **Tabel 2** = `rows_plati` (pct.5 plăți estimate, benzi `plati_estim_ancrt`/np1/…). Dezactivat când e bifat „Stingere".
- **Tabel 3** = `rows_ctrl` (Secțiunea B CAB). **col.10 = `sum_rezv_crdt_bug_act`** (credite bugetare an curent actualizat, „10=8+9").

Bifa „Stingere" = `ckbx_sting_ang_in_ancrt`. Când e bifată, frontend-ul dezactivează tabelul 2 (`core.js:229: tabelActiv=(...)&&!stingere`) → banda anului curent = 0.

**Regula:**
1. **Cardul ALOP „buget exercițiu"** (valoarea afișată): dacă „Stingere" bifat → `valoare_totala` (tabel 1); altfel → banda anului curent din `rows_plati` (REGULA ACTUALĂ, neschimbată).
2. **Verificarea la ordonanțare ȘI la noua-lichidare**: plafonul = SUMĂ peste `rows_ctrl` din `sum_rezv_crdt_bug_act` (col.10, credite bugetare) **minus ordonanțările anterioare** — INDIFERENT de bifă. (NU banda `rows_plati`. NU creditele de angajament col.7. Creditele BUGETARE col.10.)

⚠️ DISTINCȚIE CRITICĂ confirmată de owner: se scad **ordonanțările anterioare** (ce s-a ordonanțat), NU plățile efectuate. Codul actual (`alop.mjs:1313-1316`) scade `plata_suma_efectiva` (plătit) — ASTA TREBUIE SCHIMBAT în suma ordonanțată anterior. [Owner a confirmat: minus ordonanțări, nu minus plăți.]

## DIAGNOSTIC READ-ONLY (raportează ÎNAINTE de fix)
```
# 1. Confirmă câmpurile
grep -n "sum_rezv_crdt_bug_act\|rows_ctrl\|ckbx_sting_ang_in_ancrt\|valoare_totala" server/db/index.mjs public/js/formular/core.js
# 2. Confirmă cele 3 situri care folosesc bugetul anului curent
grep -rn "bugetPentruAnul\|sqlBugetAnExercitiu\|buget_an_curent_depasit\|df_buget_an_curent" server/routes/alop.mjs server/routes/formulare/ord.mjs server/services/formular-shared.mjs server/services/buget-an.mjs
# 3. Cum se scade acum (plata vs ordonantat) — alop.mjs noua-lichidare + formular-shared budget ctx
sed -n '1289,1323p' server/routes/alop.mjs
sed -n '200,285p' server/services/formular-shared.mjs
```
Raportează: (a) `sum_rezv_crdt_bug_act` e câmpul col.10 în `rows_ctrl`? (b) `rows_ctrl` persistă pe DF (e în SELECT/save, spre deosebire de `sum_fara_inreg_ctrl_crdbug` care e bug-ul de persistență separat)? (c) confirmarea că verificarea actuală scade plăți, nu ordonanțări. **Dacă ceva nu se potrivește cu regula de mai sus, OPREȘTE-TE și întreabă — nu improviza pe buget.**

## FIX — Partea A: verificarea (plafonul) → credite bugetare col.10 minus ordonanțări
Sursa unică de plafon e `bugetPentruAnul` (banda `rows_plati`). Introdu un helper nou (NU șterge `bugetPentruAnul` — rămâne pentru card):
- `server/services/buget-an.mjs`: helper `crediteBugetareAnCurent(rowsCtrl)` = SUMĂ `num(r.sum_rezv_crdt_bug_act)` peste `rows_ctrl` (cu parsarea RON corectă, `num()` existent — atenție format „150000,00").
- `formular-shared.mjs` (budget ctx ~256): plafonul ORD = `crediteBugetareAnCurent(rows_ctrl)` − (suma ordonanțată anterior pe ALOP). Selectează `df.rows_ctrl` în query-ul de context (acum selectează `rows_plati`). Suma ordonanțată anterior: reutilizează logica existentă `suma_ordonantata_plata` (alop.mjs:297,308 are deja SUM-uri pe ordonanțat) — NU `plata_suma_efectiva`.
- `alop.mjs:1289-1322` (noua-lichidare): `bugetAnCurent` = `crediteBugetareAnCurent(rows_ctrl)`; `ramas = bugetAnCurent − suma_ordonantata_anterioara` (NU `sumaPlata`). Mesajul rămâne clar.
- Verifică ambele puncte de check (frontend `doc.js:298,312` citește `buget_an_curent` din backend — se aliniază automat dacă backend-ul întoarce noua valoare; server 422 `buget_an_curent_depasit` în `formular-shared.mjs:279` folosește noul plafon).

## FIX — Partea B: cardul → tabel 1 la Stingere
- `alop.mjs` `sqlBugetAnExercitiu(df)` (sau la maparea `df_buget_an_curent`, liniile 295/501): dacă `df.ckbx_sting_ang_in_ancrt` e truthy → `valoare_totala` (tabel 1); altfel → expresia actuală (banda `rows_plati`). Atenție: `ckbx_*` sunt TEXT (truthy = 'true'/'on'/non-gol — confirmă convenția în save).
- Frontend `alop.js:601-671`: afișarea folosește `df_buget_an_curent` + `df_an_referinta`. La Stingere, valoarea vine din tabel 1 (independent de `an_referinta`) — verifică să nu apară „—" din cauza guard-ului `df_an_referinta != null` când e Stingere. Ajustează condiția de afișare dacă e nevoie (Stingere → afișează `valoare_totala` chiar dacă `an_referinta` e null).

## Teste (caz real owner)
DF cu „Stingere" bifat, `rows_ctrl` col.10 (`sum_rezv_crdt_bug_act`) = 150.000, banda `rows_plati` an curent = 0, `valoare_totala` = 250.000:
- **Verificare:** ordonanțare 50.000 → PERMISĂ (150.000 − 0 ordonanțat anterior = 150.000 ≥ 50.000). A doua ordonanțare de 120.000 → BLOCATĂ (rămas 100.000). Confirmă că scade ordonanțat, nu plătit (test cu plată≠ordonanțat).
- **Card:** `df_buget_an_curent` = 250.000 (tabel 1), nu 0.
- **Non-regresie fără Stingere:** „Cu plăți"/„Fără plăți" → card pe banda `rows_plati` (regula veche), verificarea tot pe col.10 (regula nouă, indiferent de bifă).
- `npm test` verde — confirmă în CI (testele DB rulează doar acolo).

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH gol.
- Diagnosticul raportat ÎNAINTE de modificări.
- `bugetPentruAnul` NEATINS (rămâne pentru card pe calea non-Stingere); helper nou pentru col.10.
- Cache-bust pe `alop.js`/`doc.js` dacă s-au atins (`?v=`) + bump `package.json` patch.
- CLAUDE.md: regula („card buget exercițiu = tabel 1 (`valoare_totala`) la Stingere, altfel banda `rows_plati`; verificare ordonanțare/noua-lichidare = col.10 `sum_rezv_crdt_bug_act` din `rows_ctrl` minus ordonanțări anterioare, indiferent de bifă").

## Finalizare
```
git add <fișierele acestei sarcini: buget-an.mjs, alop.mjs, formular-shared.mjs, ord.mjs?, alop.js, doc.js?, test, CLAUDE.md, package.json>
git commit -m "fix(alop): bifa Stingere — verificare ordonanțare pe credite bugetare (col.10) minus ordonanțări; card pe valoarea angajamentului (tabel 1)"
git push origin develop
```
