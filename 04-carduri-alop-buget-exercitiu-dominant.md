---
fix: 4 / 4 (varianta B) — Carduri ALOP: bugetul exercițiului curent devine cifra dominantă
target_branch: develop
model_suggested: Opus 4.8 (afișare financiară — schimbă cifra dominantă văzută de ordonator)
risk: SCĂZUT-MEDIU — doar afișare, dar cifra dominantă e materială pe bani publici
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat pe ele.

## Context
Pe pagina ALOP avem două carduri:
- **Card sus (header)**: azi „550.000 estimat · 550.000 DF actual" (ambele = angajament total).
- **Card jos (VALOARE DF)**: azi cifra MARE = `df_valoare` (550.000, angajament total) + linie secundară „Buget exercițiu {an}: {df_buget_an_curent}" (29.000).

Backend-ul **expune deja** `df_buget_an_curent` (din `rows_plati[].plati_estim_ancrt`) și anul de referință (`an_referinta`, migrarea 085) — în detail GET și în listă. Deci, foarte probabil, **fix-ul e exclusiv frontend** (confirmă la caracterizare; nu adăuga backend dacă valoarea ajunge deja în obiectul ALOP).

## Obiectiv (varianta B — decizie owner)
1. **Card jos — inversare ierarhie:**
   - Cifra MARE devine **`df_buget_an_curent`** (bugetul exercițiului curent), cu eticheta „Buget exercițiu {an}".
   - **`df_valoare`** (angajament total) trece pe **linia secundară**, etichetat clar „Angajament total DF" (folosește terminologia deja prezentă, ex. „DF actual", ca să fie consecvent).
2. **Card sus (header):** adaugă linia/badge-ul „Buget exercițiu {an}: {df_buget_an_curent}" lângă „estimat" și „DF actual". Cele două totaluri rămân.

## Regulă critică — distinge `null` de `0` (NU afișa cifră dominantă greșită)
Pentru cifra MARE din cardul jos:
- `df_buget_an_curent` **număr real, inclusiv `0`**, ȘI `an_referinta` setat (DF ancorat) → afișează acea valoare ca cifră mare (un DF cu plăți doar în N+1 are legitim `0` în an curent → „0,00 RON" e CORECT, comunică „nimic de plată anul acesta").
- `df_buget_an_curent` **`null`/lipsă** SAU `an_referinta` **`null`** (DF legacy/neancorat, pre-085) → **fallback**: cifra mare = `df_valoare` (angajament total) cu eticheta „Angajament total DF", plus o notă discretă „(exercițiu nedefinit)". NU afișa „—" sau „NaN" ca cifră dominantă, NU afișa `0` fals pentru un DF neancorat.

În **cardul sus**, linia bugetului de exercițiu e secundară → pentru legacy/null afișează discret „—" (acolo e ok, nu e cifra dominantă).

Anul afișat = anul de referință al DF-ului (`an_referinta`), nu `new Date()`. Dacă deja se afișează „Buget exercițiu 2026" în cardul jos, folosește exact aceeași sursă pentru an — nu o recalcula.

## Caracterizare-întâi
```
# unde se randează cardurile ALOP (header + VALOARE DF) și valorile
grep -n "df_buget_an_curent\|dfBugetAnCurent\|df_valoare\|VALOARE DF\|DF actual\|estimat\|Buget exercițiu\|Buget exercitiu\|an_referinta\|anReferinta" public/js/formular/alop.js
# confirmă că df_buget_an_curent + anul ajung deja în obiectul ALOP (frontend nu inventează)
grep -rn "df_buget_an_curent\|an_referinta" server/routes/alop.mjs
# helperul de formatare RO folosit în card
grep -n "fMR\|formatRO\|toLocaleString" public/js/formular/alop.js
```

## Implementare
- În `public/js/formular/alop.js`, în randarea ambelor carduri:
  - aplică regula `null`-vs-`0` de mai sus pentru cifra mare din cardul jos;
  - mută `df_valoare` pe linia secundară (card jos) cu etichetă clară;
  - adaugă linia bugetului de exercițiu în cardul sus (cu „—" pe legacy).
- Formatare RO cu helperul existent (`fMR`/echivalent). Clase scoped, fără `!important` pe selectori bare (CLAUDE.md).
- Dacă (și DOAR dacă) `df_buget_an_curent`/`an_referinta` NU ajung în frontend, expune-le în `server/routes/alop.mjs` cu același pattern defensiv ca restul (`COALESCE`, cast `::numeric` defensiv) — dar verifică întâi, probabil sunt deja acolo.

## Teste
- Caracterizare/integration: ALOP cu DF ancorat + `df_buget_an_curent` > 0 → cifra mare jos = bugetul de exercițiu, secundar = angajament total; header conține linia de buget.
- DF ancorat cu `df_buget_an_curent = 0` (plăți doar N+1) → cifra mare = „0,00 RON" cu eticheta exercițiului (NU fallback).
- DF legacy (`an_referinta` null) → cifra mare = angajament total cu „(exercițiu nedefinit)", header „—".
- `df_valoare` rămâne neschimbat ca valoare calculată (doar repoziționat vizual).
- `npm test` verde.

## Acceptare
- `npm test` → **verde, fără regresii**.
- `git diff` NO-TOUCH gol.
- Cache-bust țintit pe `alop.js` (+ `alop.mjs` doar dacă a fost atins) + bump `package.json` patch.
- CLAUDE.md: o linie („cardul ALOP afișează `df_buget_an_curent` ca cifră dominantă (var. B); fallback la `df_valoare` când `an_referinta`/buget e null").

## Finalizare
```
git add <doar fișierele acestei sarcini>
git commit -m "feat(alop): cardurile afișează bugetul exercițiului curent ca cifră dominantă (var. B), fallback la angajament total pe DF neancorat"
git push origin develop
```
