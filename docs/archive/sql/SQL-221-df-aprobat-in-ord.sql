-- ============================================================================
-- SQL-221 — Previzualizarea DF-ului aprobat din ORD: date pentru decizie (17.09.2026)
-- DocFlowAI, producție. DOAR SELECT. Consola Railway: Q1 și Q2 separat.
-- ============================================================================


-- ─── Q1 — pe câte ORD-uri ar funcționa previzualizarea ──────────────────────
--   df_aprobat        = DF-ul pe care s-a emis ORD-ul are flux semnat valid
--   pdf_in_baza       = PDF-ul semnat e salvat în baza de date
--   pdf_pe_drive      = PDF-ul semnat e în Google Drive (se descarcă prin integrare)
--   fara_pdf          = DF aprobat, dar nu găsim PDF-ul semnat (cazuri de investigat)
SELECT count(*)                                                        AS ord_cu_df,
       count(*) FILTER (WHERE t.aprobat)                               AS df_aprobat,
       count(*) FILTER (WHERE t.aprobat AND t.pdf_baza)                AS pdf_in_baza,
       count(*) FILTER (WHERE t.aprobat AND NOT t.pdf_baza AND t.drive) AS pdf_pe_drive,
       count(*) FILTER (WHERE t.aprobat AND NOT t.pdf_baza AND NOT t.drive) AS fara_pdf,
       count(*) FILTER (WHERE NOT t.aprobat)                           AS df_neaprobat
  FROM (
    SELECT fo.id,
           COALESCE(fd.flow_id IS NOT NULL
             AND f.deleted_at IS NULL
             AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
             AND (f.data->>'status') IS DISTINCT FROM 'refused'
             AND ((f.data->>'status') = 'completed' OR (f.data->>'completed') = 'true'), false) AS aprobat,
           COALESCE(jsonb_typeof(f.data->'signedPdfB64') = 'string', false) AS pdf_baza,
           COALESCE(f.data->>'storage' = 'drive' AND (f.data->>'driveFileIdFinal') IS NOT NULL, false) AS drive
      FROM formulare_ord fo
      JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows f    ON f.id::text = fd.flow_id
     WHERE fo.deleted_at IS NULL
  ) t;


-- ─── Q2 — cine ar putea să NU aibă azi drept pe DF, deși vede ORD-ul ─────────
-- Aproximare: inițiatorul ORD-ului e din alt compartiment decât inițiatorul DF-ului și nu e
-- nici din CAB. Pentru ei, varianta „accesul se ia din DF" ar da „Acces interzis".
SELECT count(*)                                                     AS ord_cu_df,
       count(*) FILTER (WHERE TRIM(COALESCE(uo.compartiment,'')) <> TRIM(COALESCE(ud.compartiment,''))
                          AND TRIM(COALESCE(uo.compartiment,'')) <> TRIM(COALESCE(o.cab_compartiment,'')))
                                                                    AS initiator_ord_alt_compartiment
  FROM formulare_ord fo
  JOIN formulare_df fd   ON fd.id = fo.df_id
  JOIN users uo          ON uo.id = fo.created_by
  JOIN users ud          ON ud.id = fd.created_by
  JOIN organizations o   ON o.id = fo.org_id
 WHERE fo.deleted_at IS NULL;
