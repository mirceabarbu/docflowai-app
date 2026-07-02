# FIX A (AFIȘARE): Cardul ALOP arată disponibilul anului curent, nu doar angajamentul total

> ⚠️ **BRANCH DISCIPLINE** — EXCLUSIV pe `develop`. NU merge/push/checkout pe `main` (= producție, manual).
> **ZONA NO-TOUCH:** `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs` — zero modificări.
> 🔒 **INVARIANT (CLAUDE.md, v3.9.554):** relink ALOP de la revizie + guard `link-df` rămân neatinse.
> Recomandare model: acest prompt e potrivit pentru **Sonnet 4.6** (afișare delimitată, fără logică de bani).

## Context

Cardul ALOP afișează `df_valoare = SUM(rows_val.valt_actualiz)` = angajamentul total multianual (ex. 15.000.000 RON). Dar bugetul efectiv al anului curent trăiește separat, în `formulare_df.rows_plati`, câmpul `plati_estim_ancrt` („Plăți estimate în anul curent", ex. 29.000 RON). Utilizatorul vrea să vadă AMBELE pe card: angajament total ȘI disponibil an curent, fiindcă ordonanțarea efectivă e limitată de al doilea (validarea hard vine în FIX B, separat).

Structura confirmată:
- `formulare_df.rows_val[]` → `valt_actualiz` (col.7) = valoare totală actualizată per rând. Suma = angajament total.
- `formulare_df.rows_plati[]` → `plati_estim_ancrt` = plăți estimate an curent per rând. Suma = buget an curent.

## Implementare (exclusiv afișare)

### 1. Backend — expune suma plăți an curent în query-urile ALOP

În `server/routes/alop.mjs`, în AMBELE query-uri care calculează `df_valoare` (în jur de liniile 246 și 450), adaugă un subquery paralel, cu același pattern defensiv:

```sql
(SELECT COALESCE(SUM((r->>'plati_estim_ancrt')::numeric),0)
 FROM jsonb_array_elements(COALESCE(df.rows_plati,'[]'::jsonb)) r) AS df_buget_an_curent,
```

Notă: `rows_plati` poate fi stocat ca jsonb sau ca text JSON (verifică tipul coloanei — în df.mjs e folosit ca `df.rows_plati` în INSERT...SELECT, deci e coloană reală). Dacă e `text`, folosește `COALESCE(df.rows_plati::jsonb,'[]'::jsonb)`. Tratează valorile non-numerice defensiv ca în `noua-lichidare` (regex `~ '^[0-9.]+$'` dacă valorile pot avea format neașteptat; verifică formatul real — `getNP()` în core.js trimite `String(pMR(...))` = număr normalizat cu punct zecimal, deci cast direct `::numeric` ar trebui să meargă, dar păstrează `COALESCE`).

Expune `df_buget_an_curent` în obiectul ALOP returnat (atât în detail GET, cât și în listă, oriunde e expus `df_valoare`).

### 2. Frontend — afișează pe card

În `public/js/formular/alop.js` (sau modulul care randează cardul ALOP — caută unde se afișează `df_valoare` / „VALOARE DF" / suma de 15.000.000):
- Lângă „DF actual" / valoarea totală, adaugă o linie/badge secundar: „Buget an curent: <df_buget_an_curent formatat RO> RON".
- Formatare consecventă cu restul (folosește helper-ul de formatare RO existent — `fMR` sau echivalentul din modul).
- Dacă `df_buget_an_curent` lipsește/0, afișează discret „—" (ca la celelalte câmpuri goale din card), nu ascunde linia complet (consistență vizuală).
- Respectă CSS scoping din CLAUDE.md (clase scoped, fără `!important` pe selectori bare).

### 3. Teste

- DB/integration: ALOP cu DF având `rows_plati` cu `plati_estim_ancrt` → `df_buget_an_curent` calculat corect și expus; ALOP cu `rows_plati` gol/absent → 0, fără eroare; revizie cu valori diferite → reflectă revizia activă (`alop.df_id`).
- Caracterizare: `df_valoare` rămâne neschimbat (nu strica calculul existent).

## Criterii de acceptare

- `npm test` verde, fără regresii.
- NO-TOUCH + invariant: `git diff` curat.
- Cache-bust țintit pe asset-ul JS modificat, bump `package.json`, CLAUDE.md: o linie („cardul ALOP expune `df_buget_an_curent` din rows_plati.plati_estim_ancrt").
- Commit-uri mici, doar pe `develop`.
