---
target_branch: develop
model_suggested: Opus 4.8 (paritate financiară card↔gardă; subtil). Caracterizare-întâi.
risk: MEDIUM — valoare financiară afișată unui ordonator. Citire (nu scrie bani), dar
                trebuie să fie IDENTICĂ cu garda, altfel induce decizii greșite.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️
> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: în cardul ALOP, afișează „Rămas de ordonanțat (exercițiu curent)" pe lângă rămasul din DF aprobat

## Decizie owner (FIXĂ)
- **Varianta A**: rămasul pe anul curent OGLINDEȘTE EXACT garda din `noua-lichidare`.
  Valoarea afișată în card TREBUIE să fie identică cu cea pe care garda o aplică, ca să
  nu existe divergență „cardul zice X, garda respinge la Y".
- Afișează **AMBELE** linii: rămasul din DF aprobat (existent) ȘI rămasul pe exercițiul curent (nou).

## Context (verificat în cod)
- ALOP detail GET (`server/routes/alop.mjs`, ~:271) întoarce deja:
  - `df_buget_an_curent` (via `sqlBugetAnExercitiu('df')`) — bugetul benzii anului curent
    (= „Buget exercițiu YYYY" din card);
  - `df_an_referinta`, `total_ord_valoare`, `total_platit`, `a.ramas` (rămasul vs DF aprobat).
- Garda din `noua-lichidare` (~:1255–1267) calculează:
  ```
  bugetAnCurent = bugetPentruAnul(df.rows_plati, anRef, anExercitiu)
  sumaPlata = SUM(plata_suma_efectiva) din alop_ord_cicluri
              WHERE alop_id=$1
                AND COALESCE(an_exercitiu, YEAR(plata_data), YEAR(created_at)) = anExercitiu
            + alop.plata_suma_efectiva   // plata live, neoglindită încă în ciclu
  ramas_an_curent = bugetAnCurent - sumaPlata
  ```
- Frontend card: `public/js/formular/alop.js`
  - linia „Buget exercițiu" ~:624;
  - linia existentă „💰 Rămas de ordonanțat: ... din DF aprobat (...)" ~:640.

## Etapa 0 — caracterizare (înainte de cod de producție)
Scrie un test (`test:db`) care, pentru un ALOP reprezentativ, calculează `ramas_an_curent`
prin NOUL câmp din detail GET ȘI prin formula gărzii din `noua-lichidare`, și asertează că
sunt EGALE (paritate card↔gardă). Acoperă: cu cicluri din anul curent, fără cicluri,
plata live prezentă, și cazul legacy `an_referinta = NULL`.

## Modificări cerute

### Backend (`alop.mjs`, detail GET care alimentează cardul)
- Adaugă un câmp `ramas_an_curent` (sau `df_ramas_an_curent`) = `df_buget_an_curent − sumaPlata`,
  unde `sumaPlata` folosește EXACT expresia gărzii: SUM(plata_suma_efectiva) pe ciclurile cu
  `COALESCE(an_exercitiu, YEAR(plata_data), YEAR(created_at)) = anul curent` **plus** plata live
  `a.plata_suma_efectiva`. Reutilizează fragmentul de an deja existent (`sqlBugetAnExercitiu` /
  scoping-ul gărzii) ca să nu reimplementezi anul diferit.
- Dacă `df_buget_an_curent` e NULL (DF legacy, `an_referinta` NULL) → `ramas_an_curent` = NULL
  (NU 0, NU NaN). Frontend-ul decide afișarea.
- NU modifica garda din `noua-lichidare` în acest task (calea de scriere financiară rămâne neatinsă).
  Doar CITEȘTI aceeași logică în GET. (Extragerea unui fragment SQL comun card+gardă = task viitor.)

### Frontend (`alop.js`, ~:640)
- Sub linia existentă „Rămas de ordonanțat ... din DF aprobat", adaugă o linie nouă etichetată clar:
  `Rămas de ordonanțat (exercițiu YYYY): <ramas_an_curent> din buget exercițiu (<df_buget_an_curent>)`.
  Folosește `fmtRON`/`fmtV` ca liniile existente.
- Dacă `ramas_an_curent` e null (legacy) → afișează „—" sau ascunde linia nouă, NU „NaN".
- Etichete distincte ca să nu deruteze: „din DF aprobat" vs „exercițiu YYYY".

## Zone interzise
- NU atinge garda `noua-lichidare`, tranzițiile de status, NO-TOUCH, `migrate.mjs`.
- NU schimba `a.ramas` (rămasul vs DF aprobat) existent.

## Definition of done
- Cardul arată ambele linii; valoarea pe exercițiu = identică cu garda (dovedit de testul de paritate).
- Legacy DF → „—", fără NaN.
- `npm test verde, fără regresii` + (CI) `npm run test:db verde` cu testul de paritate.
- `npm run check` verde. Cache busting `?v=` pe `alop.js` + bump `package.json` patch +1 (citește
  versiunea curentă) + CACHE_VERSION dacă există convenția.
- Commit + push DOAR pe `develop`. STOP înainte de `main`.
- Raport: câmpul nou, expresia de sumă folosită (confirmă că e identică cu garda), cum tratezi legacy.
