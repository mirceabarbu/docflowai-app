---
titlu: Centralizator Facturi — ascunde coloana "Observații", adaugă "Cod angajament" (din DF-ul legat)
model_suggested: Sonnet 4.6 (Default)  # display read-only + un scalar SQL; fără matematică de bani, fără migrație
branch: develop
versiune_curenta: 3.9.697
---

# ⚠️ BRANCH: develop — EXCLUSIV. main = producție, manual, Mircea. NU merge/push/checkout pe main.

====================================================================
CONTEXT (verificat pe cod v3.9.697)
====================================================================
Subtabul "Facturi" (centralizator read-only) trebuie să înlocuiască coloana "Observații"
cu o coloană "Cod angajament", populată cu codul de angajament din DF-ul legat facturii.

Fapt confirmat pe cod:
- Endpoint `GET /api/alop/facturi` (server/routes/alop.mjs:479–546) întoarce DEJA `df_id`
  pe fiecare rând (ambele ramuri UNION: `a.df_id AS df_id`).
- Codul de angajament stă în `formulare_df.rows_ctrl` (JSONB array, Secțiunea B), cheia
  `cod_angajament` pe fiecare element. Per Mircea: `cod_angajament` este UNIC pe toate
  rândurile din tabelul unui DF (doar `indicator_angajament` diferă) → luăm primul ne-gol.
- Frontend: antet STATIC în public/formular.html (thead cu `data-sort`) + `renderRow` și
  export CSV în public/js/formular/facturi.js. Cele trei (thead / renderRow / CSV) trebuie
  ținute SINCRONIZATE ca ordine de coloane.

Plasare cerută: coloana nouă "Cod angajament" IMEDIAT DUPĂ coloana "DF" (înainte de "ORD").
Numărul total de coloane rămâne 11 (scoatem Observații, adăugăm Cod angajament).

DOMENIU strict:
  server/routes/alop.mjs        (doar SELECT-ul endpointului facturi)
  public/formular.html          (doar thead-ul #facturi-table)
  public/js/formular/facturi.js (renderRow, CSV, căutare)
NU atinge: notificarea CAB, migrațiile, alte endpointuri, clasa8.js, mapper-ele XML.

====================================================================
PASUL 1 — backend: adaugă `cod_angajament` în răspunsul endpointului
====================================================================
În `server/routes/alop.mjs`, endpointul facturi, învelișul exterior este azi:
    SELECT * FROM ( <UNION current+cicluri> ) t
    ORDER BY t.data_factura DESC NULLS LAST, t.confirmed_at DESC NULLS LAST

Schimbă `SELECT *` în `SELECT t.*, <subcerere> AS cod_angajament`, cu subcererea corelată
pe `t.df_id` (ambele ramuri au deja `df_id`, deci se calculează O SINGURĂ dată pe setul unit):

    SELECT
      t.*,
      (
        SELECT r->>'cod_angajament'
          FROM formulare_df fd
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fd.rows_ctrl,'[]'::jsonb)) r
         WHERE fd.id = t.df_id
           AND fd.deleted_at IS NULL
           AND COALESCE(r->>'cod_angajament','') <> ''
         LIMIT 1
      ) AS cod_angajament
    FROM ( <UNION neschimbat> ) t
    ORDER BY t.data_factura DESC NULLS LAST, t.confirmed_at DESC NULLS LAST

NU modifica ramurile UNION, nu scoate `notes` din payload (rămâne, doar nu-l mai afișăm).
`cod_angajament` va fi `null` dacă DF-ul lipsește sau n-are rânduri — frontend-ul afișează „—".

====================================================================
PASUL 2 — frontend: antet static (public/formular.html, thead #facturi-table)
====================================================================
- ȘTERGE `<th ...>Observații</th>` (ultima coloană din thead).
- ADAUGĂ, IMEDIAT DUPĂ `<th ...>DF</th>` și înainte de `<th ...>ORD</th>`, o coloană sortabilă:
    <th style="padding:10px 12px;cursor:pointer;" data-sort="cod_angajament">Cod angajament <span class="fact-sort-ind"></span></th>
Ordinea finală a coloanelor din thead: Nr. factură · Data factură · Valoare · Nr. PV ·
Data PV · ALOP · DF · **Cod angajament** · ORD · Confirmat de · Data confirmare. (11 coloane)

====================================================================
PASUL 3 — frontend: renderRow (public/js/formular/facturi.js)
====================================================================
- ȘTERGE celula de note (ultima):
    <td style="max-width:220px;white-space:pre-wrap;">${esc(f.notes||'')||'<span class="fact-muted">—</span>'}</td>
- ADAUGĂ, imediat DUPĂ `<td>${dfCell}</td>` și înainte de `<td>${ordCell}</td>`, o celulă:
    <td style="font-variant-numeric:tabular-nums;">${esc(f.cod_angajament||'')||'<span class="fact-muted">—</span>'}</td>
Rezultat: ordinea celulelor `<td>` din renderRow trebuie să corespundă EXACT thead-ului (11).

====================================================================
PASUL 4 — frontend: export CSV (funcția _exportFacturiCsv)
====================================================================
Sincronizează head[] și body[] cu noua ordine:
- În `head`: scoate `'Observatii'` (ultimul) și adaugă `'Cod angajament'` pe poziția de după `'DF legat'`
  (adică între `'DF legat'` și `'ORD legata'`).
- În `body`: scoate `f.notes` (ultimul element) și adaugă `f.cod_angajament` imediat după
  `f.df_id ? 'DA' : ''` și înainte de `f.ord_id ? 'DA' : ''`.
Restul (BOM UTF-8, `;`, escCsv, respectarea filtrelor/sortării prin `_facturiSortate(_facturiFiltrate())`) rămâne neatins.

====================================================================
PASUL 5 — frontend: căutare (haystack)
====================================================================
La linia ~77, haystack-ul include azi `f.notes` (coloană acum ascunsă). Înlocuiește-l cu
`f.cod_angajament`, ca să cauți pe coloana vizibilă, nu pe una ascunsă:
    const hay = [f.nr_factura,f.nr_pv,f.alop_titlu,f.cod_angajament].map(...)...
Sortarea: `_facturiSortate` sortează generic după `_sort.key` — `cod_angajament` e string,
deci merge fără cod special. Nu modifica funcția de sortare.

====================================================================
PASUL 6 — versiune + cache
====================================================================
- package.json: 3.9.697 → 3.9.698.
- Frontend atins (formular.html + facturi.js) → bump `?v=` pe include-ul facturi.js și,
  dacă folosiți CACHE_VERSION global pentru formular.html, respectați convenția existentă
  a celorlalte subtaburi (aceeași schemă ca la F2–UI, fără să inventați alt mecanism).
- FĂRĂ migrație (nu atingem schema).

====================================================================
PASUL 7 — teste
====================================================================
- Dacă există un test pe endpointul facturi (server/tests), adaugă o aserțiune că răspunsul
  conține câmpul `cod_angajament` și că, pentru un ALOP cu DF având `rows_ctrl` cu
  `cod_angajament='X'` pe mai multe rânduri, valoarea întoarsă este `'X'` (primul ne-gol).
- Dacă NU există test pe acest endpoint, adaugă unul minimal (mock DF cu rows_ctrl:
  [{cod_angajament:'AAB54FEMNAA',indicator_angajament:'AAB'},{cod_angajament:'AAB54FEMNAA',indicator_angajament:'XYZ'}]
  → aștept `cod_angajament='AAB54FEMNAA'`).
bash:
  npm test
# Așteptat: verde, fără regresii.

====================================================================
RAPORT FINAL
====================================================================
1. Diff SQL (learul exterior cu subcererea cod_angajament) — paste.
2. Diff thead (Observații scos, Cod angajament adăugat după DF).
3. Diff renderRow + CSV + haystack.
4. Confirmare: renderRow are 11 `<td>`, în aceeași ordine ca thead-ul.
5. npm test verde, fără regresii.
6. package.json = 3.9.698 + `?v=` pe facturi.js.
7. NOTĂ Mircea: e READ-ONLY, fără migrație. `notes` rămâne în payload (doar ascuns) — reversibil ușor.

====================================================================
⛔ CONSTRÂNGERI
====================================================================
⛔ Doar develop. NU main. NU server/signing/*.
⛔ NU modifica ramurile UNION, notificarea CAB, migrațiile, alte subtaburi.
⛔ thead / renderRow / CSV — aceeași ordine de coloane (11). Nu lăsa desincronizare.
⛔ Fără refactor colateral. Fără onclick inline (păstrează delegarea existentă).
