-- ============================================================================
-- SQL-213d — REPARAȚIE: OP-urile RATBV din 18.08 revin pe ciclul 2
-- DocFlowAI, producție. SCRIERE. 16.09.2026
--
-- ⛔ ÎNAINTE: backup (Railway → Postgres → Backups). Scriere pe date financiare.
-- ⚠️ Consola Railway: rulează O SINGURĂ interogare pe execuție. Pas 1, verificare,
--    apoi (opțional) pas 2, verificare.
--
-- Dovada (SQL-213c, Q6): ciclul 2 al dosarului „DIFERENTA DE TARIF transport public
-- local" are ORD 43702 = 231.117,77 și plată confirmată MANUAL 231.117,77 pe 18.08.
--   770,00 + 550,00 + 31.532,00 + 198.265,77 = 231.117,77  (OP 2666–2669, toate din 18.08)
-- Ciclul 3: ORD 45339 = 191.790,72, plată manuală 191.790,72 = OP 2781.
--
-- De ce statusul rămâne `manual`: e singurul status exclus din AMBELE ramuri ale
-- agregării din `_processAlop`. O linie `unmatched`/`partial` cu `matched_alop_id` pe
-- dosar e reabsorbită fără filtru de ciclu ⇒ ar ajunge din nou pe ciclul 4.
-- ============================================================================


-- ─── PAS 1 (OBLIGATORIU, înainte să se finalizeze fluxul ORD 47842) ─────────
-- Mută 2666, 2667, 2668 de pe ciclul curent (4) înapoi pe ciclul 2.
-- Gardă: dacă nu sunt EXACT 3 linii, instrucțiunea pică pe „division by zero" și
-- NU se scrie nimic (instrucțiunea e atomică). 0 rânduri = deja reparat sau altă stare.
WITH c2 AS (
  SELECT c.id, c.alop_id
    FROM alop_ord_cicluri c
   WHERE c.id = '50d1d27e-c6b8-4dff-b99c-28d40df9d96f'::uuid
     AND c.ciclu_nr = 2
     AND c.org_id = 1
     AND c.plata_suma_efectiva = 231117.77
),
upd AS (
  UPDATE opme_lines l
     SET matched_ciclu_id = c2.id,
         match_notes = COALESCE(l.match_notes, '')
           || ' [SQL-213d 16.09.2026: mutată înapoi pe ciclul 2 (ORD 43702, plată manuală 231117.77), acceptarea din 16.09 o pusese greșit pe ciclul curent]'
    FROM c2
   WHERE l.org_id = 1
     AND TRIM(l.cif_beneficiar) = '1102556'
     AND l.nr_op IN ('2666', '2667', '2668')
     AND l.match_status = 'manual'
     AND l.matched_alop_id = c2.alop_id
     AND l.matched_ciclu_id IS NULL
  RETURNING l.nr_op, l.suma_op, l.match_status, l.matched_ciclu_id
)
SELECT u.nr_op, u.suma_op, u.match_status, u.matched_ciclu_id,
       1 / (CASE WHEN (SELECT count(*) FROM upd) = 3 THEN 1 ELSE 0 END) AS garda_3_linii
  FROM upd u
 ORDER BY u.nr_op;


-- ─── VERIFICARE (după fiecare pas) — read-only ─────────────────────────────
-- Așteptat după PAS 1: ciclu 1 = 26166.00 (3 OP); ciclu 2 = 32852.00 (3 OP);
--                      pe ciclul curent: NICIUN rând.
-- Așteptat după PAS 2: ciclu 2 = 231117.77 (4 OP) = plata; ciclu 3 = 191790.72 (1 OP).
SELECT COALESCE(c.ciclu_nr::text, 'CURENT (4)') AS ciclu,
       count(*)                                 AS op_uri,
       sum(l.suma_op)                           AS suma_op_legate,
       max(c.plata_suma_efectiva)               AS plata_confirmata_ciclu,
       string_agg(l.nr_op || ':' || l.match_status, ', ' ORDER BY l.nr_op) AS linii
  FROM opme_lines l
  LEFT JOIN alop_ord_cicluri c ON c.id = l.matched_ciclu_id
 WHERE l.org_id = 1
   AND l.matched_alop_id = (SELECT alop_id FROM alop_ord_cicluri
                             WHERE id = '50d1d27e-c6b8-4dff-b99c-28d40df9d96f'::uuid)
 GROUP BY c.ciclu_nr
 ORDER BY c.ciclu_nr NULLS LAST;


-- ─── PAS 2 (RECOMANDAT imediat după PAS 1) — 2669 pe ciclul 2, 2781 pe ciclul 3 ─
-- Financiar NU schimbă nimic: ambele cicluri sunt deja plătite corect, manual.
-- ⚠️ De ce e recomandat: după PAS 1, cardul ciclului 2 afișează lista OPME în locul
--    sumei confirmate ⇒ „3 OP · total 32.852,00", adică arată ca o plată parțială.
--    Cu 2669 adăugat: „4 OP · total 231.117,77" = exact plata ciclului.
-- Efect secundar bun: cele două linii ies din „Probleme" în raportul OPME.
-- Echivalentul unei acceptări, făcută pe ciclul corect.
-- Gardă: exact 2 linii, altfel nu se scrie nimic.
WITH tinta(nr_op, ciclu_id, ciclu_nr, suma_asteptata) AS (
  VALUES ('2669', '50d1d27e-c6b8-4dff-b99c-28d40df9d96f'::uuid, 2, 198265.77::numeric),
         ('2781', 'e1814c53-454e-4634-bbcf-9bec1b4294a6'::uuid, 3, 191790.72::numeric)
),
cic AS (
  SELECT t.nr_op, c.id AS ciclu_id, c.alop_id, t.ciclu_nr, t.suma_asteptata
    FROM tinta t
    JOIN alop_ord_cicluri c
      ON c.id = t.ciclu_id AND c.ciclu_nr = t.ciclu_nr AND c.org_id = 1
),
upd AS (
  UPDATE opme_lines l
     SET match_status     = 'manual',
         matched_alop_id  = cic.alop_id,
         matched_ciclu_id = cic.ciclu_id,
         matched_at       = NOW(),
         match_notes      = 'SQL-213d 16.09.2026: legată de ciclul ' || cic.ciclu_nr
           || ' (plată confirmată manual cu aceeași sumă) [anterior: ' || COALESCE(l.match_notes, '') || ']'
    FROM cic
   WHERE l.org_id = 1
     AND TRIM(l.cif_beneficiar) = '1102556'
     AND l.nr_op = cic.nr_op
     AND l.suma_op = cic.suma_asteptata
     AND l.match_status = 'unmatched'
     AND l.matched_alop_id IS NULL
  RETURNING l.nr_op, l.suma_op, l.match_status, l.matched_ciclu_id
)
SELECT u.nr_op, u.suma_op, u.match_status, u.matched_ciclu_id,
       1 / (CASE WHEN (SELECT count(*) FROM upd) = 2 THEN 1 ELSE 0 END) AS garda_2_linii
  FROM upd u
 ORDER BY u.nr_op;
