-- ============================================================================
-- SQL-213b — OP-urile din august pe dosarele cu mai multe cicluri (16.09.2026)
-- DocFlowAI, producție. DOAR SELECT, read-only.
-- ⚠️ Consola Railway: rulează Q4 și Q5 SEPARAT, câte una.
--
-- Întrebarea: pe dosarul RATBV, ciclul 4 (lichidare 11.09, ORD 47842 încă nelansat)
-- afișează la „Plată" 3 OP-uri din 18.08 (2666, 2667, 2668 = 32.852,00). Afișarea pune
-- pe ciclul curent orice linie cu matched_alop_id = dosarul și matched_ciclu_id NULL.
-- Dacă ele rămân acolo, la intrarea ciclului 4 în plată matcher-ul le va ADUNA la
-- OP-urile din septembrie ⇒ ciclul 4 nu se va confirma corect.
-- ============================================================================


-- ─── Q4 — toate liniile OPME din aug–sep pe cei trei furnizori, cu ciclul lor ─
--   pe_ciclul_curent = true pe un OP mai vechi decât ciclul curent ⇒ linie mutată greșit.
SELECT TRIM(l.cif_beneficiar)                          AS cif,
       l.den_beneficiar,
       i.data_op,
       l.nr_op,
       l.suma_op,
       l.match_status,
       a.titlu                                         AS dosar,
       a.status                                        AS status_dosar,
       a.ciclu_curent,
       c.ciclu_nr                                      AS ciclu_arhivat,
       (l.matched_alop_id IS NOT NULL
        AND l.matched_ciclu_id IS NULL)                AS pe_ciclul_curent,
       l.matched_at,
       LEFT(l.match_notes, 160)                        AS nota,
       l.id                                            AS linie_id
  FROM opme_lines l
  JOIN opme_imports i          ON i.id = l.opme_import_id
  LEFT JOIN alop_instances a   ON a.id = l.matched_alop_id
  LEFT JOIN alop_ord_cicluri c ON c.id = l.matched_ciclu_id
 WHERE l.org_id = 1
   AND TRIM(l.cif_beneficiar) IN ('1102556', '19113639', '31306329')
   AND i.data_op >= DATE '2026-08-01'
 ORDER BY TRIM(l.cif_beneficiar), i.data_op, l.nr_op;


-- ─── Q5 — ce au făcut, pas cu pas, acțiunile tale de test din 15–16.09 ──────
--   dosar_status/ciclu = starea DE AZI a dosarului pe care s-a acceptat linia.
--   O acceptare cu status_vechi 'partial' pe un dosar care nu era în plată e exact
--   mecanismul care mută un OP vechi pe ciclul următor.
SELECT al.created_at,
       al.event_type,
       al.payload->>'nr_op'                 AS nr_op,
       al.payload->>'suma_op'               AS suma_op,
       al.payload->>'match_status_vechi'    AS status_vechi,
       (al.payload->>'matched_alop_id_vechi') = (al.payload->>'alop_id') AS era_deja_legata_de_dosar,
       a.titlu                              AS dosar,
       a.status                             AS dosar_status_azi,
       a.ciclu_curent,
       al.payload->'vechi'                  AS valori_vechi_reluare,
       al.payload->>'motiv'                 AS motiv
  FROM audit_log al
  LEFT JOIN alop_instances a ON a.id::text = al.payload->>'alop_id'
 WHERE al.event_type IN ('opme_line_accepted_manual', 'plata_confirmare_reluata')
 ORDER BY al.created_at;
