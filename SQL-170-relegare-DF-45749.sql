-- =============================================================================
-- DocFlowAI — RELEGARE DF 45749 „DOCUMENTATIE ACTUALIZARE DATE IMOBIL"
-- Document: 50c980ac-a473-4b72-af62-d961f1790753
-- Flux CORECT (viu, confirmat de Mircea): PZ_1B8C0B5B65
--
-- STAREA GĂSITĂ:
--   formulare_df.flow_id      = PZ_01CAA11CFE  (anulat 02.09)
--   alop_instances.df_flow_id = PZ_0E68C6E6A3  (anulat, din 26.08)
--   flux viu PZ_1B8C0B5B65    = nelegat de nimeni
--
-- DE CE E URGENT: `finalizeDfOnFlowCompleted` (alop-link.mjs:97) marchează DF-ul
-- aprobat prin `WHERE flow_id=$1`. Cu pointerul pe PZ_01CAA11CFE, la finalizarea
-- lui PZ_1B8C0B5B65 va găsi ZERO rânduri — documentul rămâne neaprobat definitiv.
--
-- ⚠️ Rulează pașii ÎN ORDINE, unul pe execuție. Pasul 1 nu modifică nimic.
-- =============================================================================


-- ── PASUL 1 — PREVIZUALIZARE (read-only). Rulează-l și trimite-mi rezultatul. ──

SELECT
  fd.nr_unic_inreg,
  fd.status                      AS status_df_acum,
  fd.flow_id                     AS pointer_doc_acum,
  a.id                           AS alop_id,
  a.status                       AS status_alop,
  a.df_flow_id                   AS pointer_alop_acum,
  a.df_completed_at,
  -- starea fluxului țintă, reconfirmată chiar acum
  f.id                           AS flux_tinta,
  (f.data->>'status')            AS status_flux_tinta,
  (f.data->>'completed')         AS completed_flux_tinta,
  f.deleted_at                   AS flux_tinta_sters,
  jsonb_array_length(COALESCE(f.data->'signers','[]'::jsonb)) AS nr_semnatari,
  (SELECT count(*) FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
    WHERE s->>'status' = 'signed')                           AS semnaturi_puse
FROM formulare_df fd
LEFT JOIN alop_instances a ON a.df_id = fd.id AND a.cancelled_at IS NULL
LEFT JOIN flows f          ON f.id = 'PZ_1B8C0B5B65'
WHERE fd.id = '50c980ac-a473-4b72-af62-d961f1790753'::uuid;

-- ⛔ OPREȘTE-TE dacă `status_flux_tinta` NU e `active`, dacă `flux_tinta_sters` nu e
--    NULL, sau dacă `flux_tinta` iese NULL. Orice altceva înseamnă că s-a schimbat
--    ceva între timp și relegarea trebuie regândită.


-- ── PASUL 2 — pointerul documentului ─────────────────────────────────────────
-- Cheiat pe valoarea VECHE, ca să nu poată lovi altceva dacă starea s-a schimbat
-- între pasul 1 și acum. Dacă întoarce 0 rânduri, NU insista — scrie-mi.

WITH upd AS (
  UPDATE formulare_df
     SET flow_id    = 'PZ_1B8C0B5B65',
         status     = 'transmis_flux',
         updated_at = NOW()
   WHERE id      = '50c980ac-a473-4b72-af62-d961f1790753'::uuid
     AND flow_id = 'PZ_01CAA11CFE'
  RETURNING id, nr_unic_inreg, flow_id, status
)
SELECT * FROM upd;

-- DE CE și `status`: documentul e pe un flux ACTIV, deci starea onestă e
-- `transmis_flux`, nu `completed`. E și starea pe care o așteaptă mașina de stare:
-- dacă fluxul se anulează, `lifecycle.mjs:569` face `transmis_flux → completed`;
-- dacă se finalizează, `finalizeDfOnFlowCompleted` scrie `aprobat` indiferent de
-- starea curentă. Lăsat pe `completed`, documentul ar apărea redeschizabil
-- (`can_reopen` cere `status='completed'`) deși e în semnare.


-- ── PASUL 3 — pointerul dosarului ALOP ───────────────────────────────────────

WITH upd AS (
  UPDATE alop_instances
     SET df_flow_id      = 'PZ_1B8C0B5B65',
         df_completed_at = NULL,
         updated_at      = NOW()
   WHERE df_id        = '50c980ac-a473-4b72-af62-d961f1790753'::uuid
     AND cancelled_at IS NULL
     AND df_flow_id   = 'PZ_0E68C6E6A3'
  RETURNING id, titlu, status, df_flow_id, df_completed_at
)
SELECT * FROM upd;

-- `df_completed_at = NULL` fiindcă fluxul nu e finalizat. Îl scrie
-- `alop-link.mjs` la finalizare, prin calea normală.


-- ── PASUL 4 — VERIFICARE (read-only) ─────────────────────────────────────────

SELECT
  fd.nr_unic_inreg,
  fd.status                                   AS status_df,
  fd.flow_id                                  AS pointer_doc,
  a.df_flow_id                                AS pointer_alop,
  a.df_completed_at,
  (fd.flow_id = a.df_flow_id)                 AS pointeri_aliniati,
  (fd.flow_id = 'PZ_1B8C0B5B65')              AS pointeaza_spre_fluxul_viu
FROM formulare_df fd
LEFT JOIN alop_instances a ON a.df_id = fd.id AND a.cancelled_at IS NULL
WHERE fd.id = '50c980ac-a473-4b72-af62-d961f1790753'::uuid;

-- Așteptat: status_df = transmis_flux, ambii pointeri = PZ_1B8C0B5B65,
--           pointeri_aliniati = true, df_completed_at = NULL.
--
-- Apoi verifică în interfață: DF 45749 apare „în semnare", iar cardul de
-- divergențe rămâne la 0 (PZ_01CAA11CFE e anulat, deci nu mai e „viu").
-- =============================================================================
