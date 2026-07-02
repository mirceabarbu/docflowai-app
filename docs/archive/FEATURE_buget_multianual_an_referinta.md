# FEATURE: Buget multi-anual — ancorare an absolut pe DF, plafon ordonanțare per exercițiu

> ⚠️ **BRANCH DISCIPLINE** — EXCLUSIV pe `develop`. NU merge/push/checkout pe `main` (= producție, manual).
> **ZONA NO-TOUCH:** `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs` — zero modificări.
> 🔒 **INVARIANTE (CLAUDE.md):** relink ALOP de la revizie + guard `link-df` rămân neatinse.
> 🧠 **Recomandare model: rulează acest prompt pe Opus 4.8.** E o schimbare de model de date cu raționament multi-fișier și implicații bugetare; depășește zona de confort a unui prompt de execuție delimitată.
> ⚠️ Rulează DUPĂ HOTFIX-ul testului stale și DUPĂ ce FIX A + FIX B sunt verzi pe CI.

## Problema de model (de ce e nevoie de ancorare)

`rows_plati` are benzi RELATIVE: `plati_ani_precedenti`, `plati_estim_ancrt`, `plati_estim_an_np1`, `plati_estim_an_np2`, `plati_estim_an_np3`, `plati_estim_ani_ulter`. „an curent" e relativ la momentul completării DF-ului, dar NICĂIERI nu e stocat CARE an absolut e „ancrt". FIX B (v3.9.557) plafonează ordonanțarea pe `plati_estim_ancrt` tratând tot ca mono-an — corect pentru 2026, dar la 1 ianuarie 2027 plafonul ar trebui să devină `plati_estim_an_np1`, și sistemul nu poate ști asta fără un an de ancorare.

Fără ancorare, două convenții se ciocnesc ireconciliabil: un DF din 2026 (ancrt=2026) vs. un DF din ian. 2027 (ancrt=2027) nu pot fi distinși din `NOW()`.

## Decizia de model (confirmată de owner)

**Ancorare prin an absolut stocat pe DF: `an_referinta` (INTEGER).** `plati_estim_ancrt` aparține anului `an_referinta`; `np1` → `an_referinta+1`; `np2` → `+2`; `np3` → `+3`; `ani_precedenti` → `< an_referinta`; `ani_ulter` → `> an_referinta+3`. „Anul curent al exercițiului" pentru plafon = `EXTRACT(YEAR FROM NOW())` (sau un an de exercițiu setabil la nivel de organizație — vezi mai jos).

## ⚠️ DECIZIE DESCHISĂ — confirmă înainte de implementare

**DF legacy fără `rows_plati` / fără `an_referinta`:** comportamentul actual (FIX B) e „buget 0 → blochează ordonanțarea (422)". Acest hotfix a arătat deja că lovește și testele. Pentru DF-uri legacy reale în producție, blocajul total e riscant.
- **Recomandarea mea:** pentru DF-uri FĂRĂ `an_referinta` (deci create înainte de această migrare), tratează plafonul ca **nedeclarat → permite cu avertisment soft** (nu 422), păstrând blocajul hard DOAR pentru DF-uri cu `an_referinta` setat și buget pe anul de exercițiu. Asta evită ruperea retroactivă a fluxurilor în curs.
- NU implementa până nu confirmă owner-ul această ramură. Dacă owner-ul preferă „blochează oricum", documentează și execută varianta lui.

## Implementare

### 1. Migrarea 085 — `an_referinta` pe DF

- `ALTER TABLE formulare_df ADD COLUMN IF NOT EXISTS an_referinta INTEGER NULL;` (idempotent, pattern existent). NULL = legacy / nedeclarat.
- La crearea unui DF nou: setează `an_referinta` din body (frontend trimite anul ales) SAU default `EXTRACT(YEAR FROM NOW())` dacă nu e trimis. La REVIZIE: copiază `an_referinta` din părinte (revizia păstrează exercițiul — o suplimentare în 2026 rămâne 2026).
- Backfill: NU backfilla automat DF-urile legacy (rămân NULL → tratate ca nedeclarat conform deciziei deschise). Documentează asta.

### 2. Helper central de buget pe an de exercițiu

Funcție pură, testabilă, ex. `server/services/buget-an.mjs`:
```
bugetPentruAnul(rowsPlati, anReferinta, anExercitiu) → numeric
```
Mapează banda corectă în funcție de `anExercitiu − anReferinta`:
- offset 0 → `plati_estim_ancrt`
- offset 1 → `plati_estim_an_np1`
- offset 2 → `plati_estim_an_np2`
- offset 3 → `plati_estim_an_np3`
- offset < 0 → `plati_ani_precedenti` (sau 0 — decizie documentată: plafonul pentru ani trecuți nu mai e relevant la ordonanțare nouă)
- offset > 3 → `plati_estim_ani_ulter`
Returnează `SUM` peste rânduri pe banda selectată. Dacă `anReferinta` e NULL → semnalează „nedeclarat" (return null, NU 0), ca apelantul să aplice decizia deschisă (skip vs. block).

### 3. Plafon ordonanțare per exercițiu (`formular-shared.mjs`)

Înlocuiește `validateOrdBugetAnCurent` introdus la FIX B: în loc de `SUM(plati_estim_ancrt)` fix, folosește `bugetPentruAnul(df.rows_plati, df.an_referinta, anExercitiuCurent)`.
- `anExercitiuCurent`: `EXTRACT(YEAR FROM NOW())` ca default. Dacă există/adaugi un setting per organizație pentru anul de exercițiu activ (util pentru perioada de tranziție jan-mar când se mai operează pe anul precedent), folosește-l; altfel NOW(). NU inventa setting nou dacă owner-ul nu-l cere — default NOW() e acceptabil în prima iterație, documentat.
- Cumulul de ordonanțări/plăți trebuie să fie PER AN DE EXERCIȚIU: o ordonanțare făcută în 2026 consumă bugetul 2026, nu pe cel din 2027. Aici e nevoie de un an pe ciclurile arhivate — vezi punctul 4.
- Plafon depășit + `an_referinta` setat → 422 (ca FIX B). `an_referinta` NULL → decizia deschisă (skip+warn recomandat).

### 4. An de exercițiu pe cicluri/ordonanțări (pentru cumul corect per an)

`alop_ord_cicluri` și ordonanțările nu marchează anul. Pentru cumul corect per exercițiu:
- Derivă anul plății din `plata_data` (DATE existent) acolo unde e disponibil; pentru cicluri fără `plata_data`, din `created_at`/`completed_at`. Documentează regula de derivare.
- Alternativ (mai robust, dacă owner acceptă migrarea): `ALTER TABLE alop_ord_cicluri ADD COLUMN IF NOT EXISTS an_exercitiu INTEGER`, populat la arhivare din anul plății. Recomandat dacă raportarea per an devine recurentă.
- `noua-lichidare` (`alop.mjs`): `ramas = bugetPentruAnul(df.rows_plati, df.an_referinta, anExercitiuCurent) − sumaPlatitaInAnulExercitiului`. NU mai folosi totalul tuturor ciclurilor indiferent de an.

### 5. Frontend

- Formularul DF: câmp/afișare `an_referinta` (default anul curent, editabil la creare; read-only la revizie — moștenit). Etichetele coloanelor `rows_plati` pot afișa anul absolut calculat (ex. „Plăți estimate în anul curent (2026)", „N+1 (2027)") — opțional dar foarte util pentru utilizatori.
- Cardul ALOP (extinde FIX A): „Buget an curent" devine „Buget exercițiu <an> ", calculat prin `bugetPentruAnul`, nu fix pe `ancrt`.
- Eroarea 422 de plafon menționează anul exercițiului.

### 6. Teste (extinse)

- Helper `bugetPentruAnul`: toate offset-urile (negativ, 0, 1, 2, 3, >3), `an_referinta` NULL → null.
- DF cu `an_referinta=2026`: ordonanțare în exercițiu 2026 plafonată pe `ancrt`; simulează `anExercitiu=2027` → plafonată pe `np1`.
- Cumul per an: plăți în 2026 NU consumă bugetul 2027.
- `noua-lichidare`: `ramas` pe banda anului de exercițiu corect.
- Legacy (`an_referinta` NULL): conform deciziei confirmate (skip+warn SAU block).
- Invariant păstrat: revizie cu buget mărit pe anul de exercițiu → ciclu nou; revizia moștenește `an_referinta`.
- Caracterizare: DF cu `an_referinta` = anul curent se comportă IDENTIC cu FIX B (mono-an) — fără regresie pentru cazul curent 2026.

## Criterii de acceptare

- `npm test` verde + CI DB verde (NU te baza pe skip local pentru testele db/).
- NO-TOUCH + invariante relink: `git diff` curat pe fișierele protejate.
- Migrarea 085 idempotentă, pattern existent; fără backfill automat legacy.
- Decizia legacy implementată conform confirmării owner-ului, documentată în cod + CLAUDE.md.
- Cache-bust țintit, bump `package.json`, CLAUDE.md: secțiune „Buget multi-anual: an_referinta pe DF ancorează benzile rows_plati la ani absoluți; plafon ordonanțare per an de exercițiu prin bugetPentruAnul()".
- Commit-uri mici, separate logic (migrare → helper → plafon → frontend), doar pe `develop`.
```
