-- ============================================================================
-- SQL-217 — PREVIZUALIZARE „ultimul din CAB care a lucrat pe document" (17.09.2026)
-- DocFlowAI, producție. DOAR SELECT. Consola Railway: Q1 și Q2 separat.
--
-- Regula previzualizată (aceeași ca în `isCabDept`: TRIM, egalitate exactă, șir gol exclus):
--   dintre (a) evenimentele din jurnalul de audit al documentului și (b) ultima salvare
--   (`updated_by` / `updated_at`), se ia cea mai RECENTĂ făcută de un utilizator aflat
--   ACUM în compartimentul CAB al organizației.
-- ============================================================================


-- ─── Q1 — cum ar arăta coloana pe ultimele 40 de DF-uri ─────────────────────
SELECT fd.nr_unic_inreg                                           AS nr,
       fd.revizie_nr                                              AS rev,
       fd.status,
       COALESCE(u2.nume, u2.email, NULLIF(TRIM(fd.p2_compartiment), '')) AS responsabil_azi,
       pc.nume                                                    AS ultim_din_cab,
       pc.at                                                      AS ultim_din_cab_la,
       pc.sursa
  FROM formulare_df fd
  JOIN organizations o ON o.id = fd.org_id
  LEFT JOIN users u2   ON u2.id = fd.assigned_to
  LEFT JOIN users u3   ON u3.id = fd.updated_by
  LEFT JOIN LATERAL (
    SELECT x.nume, x.at, x.sursa
      FROM (
        SELECT COALESCE(NULLIF(uc.nume, ''), uc.email) AS nume, fa.created_at AS at,
               'audit: ' || fa.event_type AS sursa
          FROM formulare_audit fa
          JOIN users uc ON uc.id = fa.actor_id
         WHERE fa.form_type = 'df' AND fa.form_id = fd.id
           AND TRIM(uc.compartiment) <> ''
           AND TRIM(uc.compartiment) = TRIM(COALESCE(o.cab_compartiment, ''))
        UNION ALL
        SELECT COALESCE(NULLIF(u3.nume, ''), u3.email), fd.updated_at, 'ultima salvare'
         WHERE u3.id IS NOT NULL
           AND TRIM(u3.compartiment) <> ''
           AND TRIM(u3.compartiment) = TRIM(COALESCE(o.cab_compartiment, ''))
      ) x
     ORDER BY x.at DESC
     LIMIT 1
  ) pc ON TRUE
 WHERE fd.deleted_at IS NULL
 ORDER BY fd.updated_at DESC
 LIMIT 40;


-- ─── Q2 — acoperire: pe câte documente atribuite COMPARTIMENTULUI am avea un nume ─
-- cu_nume_din_audit  = nume stabil (completat/returnat etc. rămân în jurnal)
-- doar_din_salvare   = nume care poate dispărea la următoarea salvare a altcuiva
SELECT t.tip,
       count(*)                                                        AS atribuite_compartimentului,
       count(*) FILTER (WHERE t.din_audit)                             AS cu_nume_din_audit,
       count(*) FILTER (WHERE NOT t.din_audit AND t.din_salvare)       AS doar_din_salvare,
       count(*) FILTER (WHERE NOT t.din_audit AND NOT t.din_salvare)   AS fara_nume
  FROM (
    SELECT 'DF' AS tip,
           EXISTS (SELECT 1 FROM formulare_audit fa JOIN users uc ON uc.id = fa.actor_id
                    WHERE fa.form_type = 'df' AND fa.form_id = fd.id
                      AND TRIM(uc.compartiment) <> ''
                      AND TRIM(uc.compartiment) = TRIM(COALESCE(o.cab_compartiment, ''))) AS din_audit,
           EXISTS (SELECT 1 FROM users u3 WHERE u3.id = fd.updated_by
                      AND TRIM(u3.compartiment) <> ''
                      AND TRIM(u3.compartiment) = TRIM(COALESCE(o.cab_compartiment, ''))) AS din_salvare
      FROM formulare_df fd JOIN organizations o ON o.id = fd.org_id
     WHERE fd.deleted_at IS NULL AND NULLIF(TRIM(fd.p2_compartiment), '') IS NOT NULL
    UNION ALL
    SELECT 'ORD',
           EXISTS (SELECT 1 FROM formulare_audit fa JOIN users uc ON uc.id = fa.actor_id
                    WHERE fa.form_type = 'ord' AND fa.form_id = fo.id
                      AND TRIM(uc.compartiment) <> ''
                      AND TRIM(uc.compartiment) = TRIM(COALESCE(o.cab_compartiment, ''))),
           EXISTS (SELECT 1 FROM users u3 WHERE u3.id = fo.updated_by
                      AND TRIM(u3.compartiment) <> ''
                      AND TRIM(u3.compartiment) = TRIM(COALESCE(o.cab_compartiment, '')))
      FROM formulare_ord fo JOIN organizations o ON o.id = fo.org_id
     WHERE fo.deleted_at IS NULL AND NULLIF(TRIM(fo.p2_compartiment), '') IS NOT NULL
  ) t
 GROUP BY t.tip
 ORDER BY t.tip;
