-- ═══════════════════════════════════════════════════════════════════════════
-- DIAGNOSTIC — ALOP care pointează spre o revizie DF NEAPROBATĂ
-- A se rula READ-ONLY pe PRODUCȚIE, înainte de a decide reparația (#134).
-- Zero UPDATE, zero DELETE. Rulează interogările pe rând.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── POARTĂ DE SIGURANȚĂ — nu o șterge ───────────────────────────────────────
-- Orice INSERT/UPDATE/DELETE ajuns aici din greșeală va EȘUA, nu va scrie.
SET default_transaction_read_only = on;
\pset pager off
\timing on

-- ── 1. Amploarea: câte dosare ALOP au azi df_id pe o revizie NEAPROBATĂ ──────
-- „Aprobat" = derivat din flux (viu, necancelat, nerefuzat, completat) SAU
-- status='aprobat' — aceeași definiție ca în relinkAlopOnDfDelete (v3.9.746).
SELECT
  count(*) FILTER (WHERE NOT aprobat)                        AS alop_pe_revizie_neaprobata,
  count(*) FILTER (WHERE NOT aprobat AND revizie_nr > 0)     AS dintre_care_revizii_R1_plus,
  count(*) FILTER (WHERE NOT aprobat AND alop_status = 'completed') AS dintre_care_alop_finalizat,
  count(*)                                                   AS total_alop_cu_df
FROM (
  SELECT a.id,
         a.status AS alop_status,
         COALESCE(df.revizie_nr, 0) AS revizie_nr,
         (df.status = 'aprobat' OR (
            df.flow_id IS NOT NULL AND f.deleted_at IS NULL
            AND f.data->>'status' IS DISTINCT FROM 'cancelled'
            AND f.data->>'status' IS DISTINCT FROM 'refused'
            AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
         )) AS aprobat
    FROM alop_instances a
    JOIN formulare_df df ON df.id = a.df_id AND df.deleted_at IS NULL
    LEFT JOIN flows f    ON f.id  = df.flow_id
   WHERE a.cancelled_at IS NULL
) t;

-- ── 2. Cazurile concrete, cu diferența de bani față de ultima revizie APROBATĂ
-- Coloana `delta_valoare` = cât de mult minte azi cardul ALOP.
-- `ramas_azi` vs `ramas_corect` = expunerea reală pe „Nouă ordonanțare parțială".
SELECT
  a.id                                   AS alop_id,
  a.titlu,
  a.status                               AS alop_status,
  df.nr_unic_inreg                       AS nr_df,
  COALESCE(df.revizie_nr,0)              AS revizie_pointata,
  df.status                              AS status_revizie_pointata,
  apr.revizie_nr                         AS ultima_revizie_aprobata,
  round(val_pointat.v, 2)                AS valoare_afisata_azi,
  round(val_aprobat.v, 2)                AS valoare_corecta,
  round(val_pointat.v - val_aprobat.v, 2) AS delta_valoare,
  round(GREATEST(0, val_pointat.v - COALESCE(a.suma_totala_platita,0) - COALESCE(a.plata_suma_efectiva,0)), 2) AS ramas_azi,
  round(GREATEST(0, val_aprobat.v - COALESCE(a.suma_totala_platita,0) - COALESCE(a.plata_suma_efectiva,0)), 2) AS ramas_corect
FROM alop_instances a
JOIN formulare_df df ON df.id = a.df_id AND df.deleted_at IS NULL
LEFT JOIN flows f    ON f.id  = df.flow_id
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0) AS v
    FROM jsonb_array_elements(COALESCE(df.rows_val,'[]'::jsonb)) r
) val_pointat
-- ultima revizie APROBATĂ din același dosar (același nr_unic_inreg + org)
LEFT JOIN LATERAL (
  SELECT fd.id, fd.revizie_nr, fd.rows_val
    FROM formulare_df fd
    LEFT JOIN flows ff ON ff.id = fd.flow_id
   WHERE fd.org_id = df.org_id
     AND fd.nr_unic_inreg = df.nr_unic_inreg
     AND fd.deleted_at IS NULL
     AND (fd.status = 'aprobat' OR (
            fd.flow_id IS NOT NULL AND ff.deleted_at IS NULL
            AND ff.data->>'status' IS DISTINCT FROM 'cancelled'
            AND ff.data->>'status' IS DISTINCT FROM 'refused'
            AND (ff.data->>'status' = 'completed' OR (ff.data->>'completed')::boolean = true)
     ))
   ORDER BY fd.revizie_nr DESC
   LIMIT 1
) apr ON TRUE
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0) AS v
    FROM jsonb_array_elements(COALESCE(apr.rows_val,'[]'::jsonb)) r
) val_aprobat
WHERE a.cancelled_at IS NULL
  AND NOT (df.status = 'aprobat' OR (
        df.flow_id IS NOT NULL AND f.deleted_at IS NULL
        AND f.data->>'status' IS DISTINCT FROM 'cancelled'
        AND f.data->>'status' IS DISTINCT FROM 'refused'
        AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
  ))
ORDER BY abs(val_pointat.v - val_aprobat.v) DESC;

-- ── 3. Confirmă că `df_revizie_in_lucru` e cod MORT azi ─────────────────────
-- Prima cifră ar trebui să fie 0 (premisa ruptă: df_id pointează chiar la copil,
-- deci nu mai există niciun fd2 cu parent_df_id = df_id).
-- A doua e ce ar fi întors dacă df_id ar rămâne pe părinte.
SELECT
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM formulare_df fd2
     WHERE fd2.parent_df_id = a.df_id AND fd2.org_id = a.org_id
       AND fd2.status IN ('draft','pending_p2','completed','returnat','transmis_flux','de_revizuit')
       AND fd2.deleted_at IS NULL
  )) AS in_lucru_cum_se_calculeaza_azi,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM formulare_df fd2
     WHERE fd2.parent_df_id = df.parent_df_id AND fd2.org_id = a.org_id
       AND fd2.id <> df.id
       AND fd2.status IN ('draft','pending_p2','completed','returnat','transmis_flux','de_revizuit')
       AND fd2.deleted_at IS NULL
  )) AS in_lucru_cu_pointerul_pe_parinte
FROM alop_instances a
JOIN formulare_df df ON df.id = a.df_id AND df.deleted_at IS NULL
WHERE a.cancelled_at IS NULL;

-- ── 4. Cronologie: când a apărut prima dată tiparul ─────────────────────────
-- Reviziile create ordonate în timp, cu momentul aprobării. Dacă înainte de o
-- anumită dată reviziile erau MEREU aprobate înainte ca ALOP-ul să le adopte,
-- se vede aici.
SELECT date_trunc('month', fd.revizie_at) AS luna,
       count(*)                            AS revizii_create,
       count(*) FILTER (WHERE fd.status = 'draft') AS ramase_draft
  FROM formulare_df fd
 WHERE fd.revizie_nr > 0 AND fd.deleted_at IS NULL
 GROUP BY 1 ORDER BY 1;
