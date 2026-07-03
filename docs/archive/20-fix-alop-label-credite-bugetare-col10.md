---
fix: ALOP — text „buget exercitiu" complet + paranteza „rămas exercițiu" corectată la col.10 (credite bugetare reale)
target_branch: develop
model_suggested: Opus 4.8 (afișare financiară — valoarea din paranteză trebuie să fie baza reală a calculului)
risk: SCĂZUT — expune col.10 (read-only, refolosește helper existent) + 2 schimbări de afișare; zero atingere a calculelor
version: 3.9.599 → 3.9.600
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
Semnare + lifecycle. **Calculele financiare:** NU modifica `sqlRamasAnExercitiu`, `sqlBugetAnExercitiu`, `sqlCrediteBugetareCol10`, `crediteBugetareAnCurent`, logica de plafon/noua-lichidare. Le **refolosești**, nu le schimbi. Cardul `df_buget_an_curent` (alop.js:608, valoarea) rămâne neschimbat — doar eticheta lui.

## Context — confirmat în cod
Distincție DOCUMENTATĂ intenționat (`alop.mjs:40-48, 77-84, 116-122`):
- `df_buget_an_curent` (card „buget exercițiu" = 250.000) — afișare (banda `rows_plati` / regula stingere fix 12).
- col.10 `sqlCrediteBugetareCol10` (`sum_rezv_crdt_bug_act` = 150.000) — plafonul real; baza pentru `ramas_an_curent` (= col.10 − ordonanțat).

`ramas_an_curent` (75.000) se calculează din col.10 (150.000 − 75.000), dar linia de jos (`alop.js:681`) afișează în paranteză `df_buget_an_curent` (250.000) — **inconsecvent cu cifra rămas pe care o însoțește**. Owner cere corectarea parantezei la col.10 (valoarea reală a bazei).

## Etapa 0 — caracterizare
```bash
grep -n "sqlCrediteBugetareCol10\|df_buget_an_curent\|ramas_an_curent\|sqlRamasAnExercitiu" server/routes/alop.mjs | head
sed -n '606,612p' public/js/formular/alop.js   # cardul (608)
sed -n '679,682p' public/js/formular/alop.js   # linia de jos (681)
grep -rn "alop.js?v=\|formular/alop.js" public/*.html   # unde se cache-bustează alop.js
```

## Implementare

### 1. `server/routes/alop.mjs` — expune col.10 ca `credite_bugetare_an_curent` (AMBELE SELECT-uri)
Imediat după linia `${sqlBugetAnExercitiu('df')} AS df_buget_an_curent,` în **ambele** SELECT-uri (lista ~343 ȘI detaliul ~550), adaugă:
```sql
${sqlCrediteBugetareCol10('df')} AS credite_bugetare_an_curent,
```
Refolosește EXACT `sqlCrediteBugetareCol10` (același fragment folosit intern de `sqlRamasAnExercitiu`) → valoarea expusă = baza reală a lui `ramas_an_curent`. NU adăuga alt calcul.

### 2. `public/js/formular/alop.js:608` — text card (fără prescurtare), valoare neschimbată
`buget ex. ${_exAn}` → `buget exercitiu ${_exAn}`. NU schimba valoarea (`a.df_buget_an_curent`) — doar textul. (Folosește diacritice corecte conform restului UI: „exercițiu" dacă așa e convenția; owner a scris „exercitiu" — păstrează forma cerută.)

### 3. `public/js/formular/alop.js:681` — paranteza „rămas exercițiu" → col.10 + etichetă corectă
Schimbă DOAR partea din paranteză. Din:
```js
` din buget exercițiu (${fmtRON(parseFloat(a.df_buget_an_curent||0))})`
```
în:
```js
` din credite bugetare exercitiu curent (${fmtRON(parseFloat(a.credite_bugetare_an_curent||0))})`
```
⚠️ În UI apare **DOAR valoarea** în paranteză (ex. `(150.000,00 RON)`). „= valoarea din DF tabelul 3, col. 10" a fost indicația de SURSĂ (de unde se ia cifra = col.10 `sqlCrediteBugetareCol10`) — NU se afișează. `a.ramas_an_curent` (cifra principală, 75.000) rămâne neschimbat — corectăm doar referința din paranteză (250.000 → col.10 = 150.000) + eticheta. NU atinge linia 680 (Rămas din DF aprobat — folosește corect `df_valoare`/angajament).

## Teste
Extinde un test ALOP (ex. lângă `alop-card-ramas-an-curent.test.mjs`):
- detaliul/lista `/api/alop/:id` întoarce `credite_bugetare_an_curent` = `crediteBugetareAnCurent(df.rows_ctrl)` (col.10).
- **consistență:** `credite_bugetare_an_curent === ramas_an_curent + ordonanțat_curent` (valoarea din paranteză = baza calculului rămasului). Aceasta blochează re-divergența.
- caz fără DF → `credite_bugetare_an_curent` NULL/0 (ca `ramas_an_curent`), fără NaN.
`npm test verde, fără regresii` (`node_modules` instalat). DB autoritativ în CI. `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/alop.mjs`, `public/js/formular/alop.js`, testul, `public/<pagina>.html` (cache-bust), `public/sw.js`, `package.json`.
```bash
git diff server/routes/alop.mjs | grep -iE "function sqlRamasAnExercitiu|function sqlBugetAnExercitiu|function sqlCrediteBugetareCol10" && echo "⛔ STOP: ai modificat un helper de calcul!" || echo "✅ helperele de calcul neatinse (doar refolosite)"
git diff public/js/formular/alop.js | grep -n "df_buget_an_curent" # confirmă: valoarea cardului (608) neschimbată; 681 trecut pe credite_bugetare_an_curent
```

## Cache busting + versiune
- bump `package.json`: `3.9.599` → `3.9.600`;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.600` pe `alop.js` în pagina care-l încarcă.

## La final
```bash
git add server/routes/alop.mjs public/js/formular/alop.js server/tests/... public/*.html public/sw.js package.json
git commit -m "fix(alop): text 'buget exercitiu' complet + paranteza rămas exercițiu pe col.10 credite bugetare reale (v3.9.600)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: guardrail (helpere de calcul neatinse), că valoarea cardului (608) e neschimbată, testul de consistență (col.10 = ramas + ordonanțat), status CI. Confirmare owner pe staging: cardul arată „...buget exercitiu 2026"; linia de jos „...din credite bugetare exercitiu curent (150.000,00 RON = valoarea din DF tabelul 3, col. 10)".
