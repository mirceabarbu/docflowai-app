-- Backfill idempotent: DF completed cu flux ACTIV legat prin ALOP → transmis_flux.
-- Îngust: doar rânduri cu flux real în curs (nici completed, nici cancelled).
UPDATE formulare_df fd
   SET status = 'transmis_flux', updated_at = NOW()
  FROM alop_instances a
  JOIN flows f ON f.id::text = a.df_flow_id
 WHERE a.df_id = fd.id
   AND a.df_flow_id IS NOT NULL
   AND a.cancelled_at IS NULL
   AND fd.status = 'completed'
   AND fd.deleted_at IS NULL
   AND (f.data->>'completed') IS DISTINCT FROM 'true'
   AND (f.data->>'status')    IS DISTINCT FROM 'cancelled';
