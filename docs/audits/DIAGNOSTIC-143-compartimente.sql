-- #143b — ETAPA E: diagnostic READ-ONLY pentru producție (consola Railway).
-- Doar SELECT-uri. O interogare per execuție — consola adaugă automat propriul LIMIT,
-- deci fiecare bloc se termină într-un SELECT. Fără extensii (unaccent poate lipsi) —
-- normalizarea diacriticelor se face cu translate().
--
-- ⛔ NU rula tot fișierul deodată. Copiază câte un bloc pe rând în consola Railway.

-- ─────────────────────────────────────────────────────────────────────────────
-- Q1 — cât de mult atârnă totul de compartimentul creatorului.
-- Câte dosare ALOP au `compartiment` gol/NULL, ca procent din total.
-- Un rezultat cu procent mare (ex. >30%) înseamnă că mutarea unui om la alt serviciu
-- rescrie tăcut proprietarii colectivi ai dosarelor lui vechi (moștenirea prin
-- compartimentul CURENT al creatorului, nu prin compartimentul declarat pe dosar).
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  COUNT(*) AS total_alop,
  COUNT(*) FILTER (WHERE COALESCE(TRIM(compartiment), '') = '') AS fara_compartiment,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE COALESCE(TRIM(compartiment), '') = '') / NULLIF(COUNT(*), 0),
    1
  ) AS procent_fara_compartiment
FROM alop_instances
WHERE cancelled_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Q2 — variante de scriere ale aceluiași compartiment.
-- Grupare pe cheie normalizată (lower + spații colapsate + translate pe diacritice),
-- peste users.compartiment (doar deleted_at IS NULL, doar valori nevide).
-- Orice rând returnat = oameni care se cred în același compartiment dar nu sunt,
-- pentru toate cele trei straturi de comparație (vizibilitate, authz, capabilities) —
-- comparația actuală e TRIM + case-sensitive, fără normalizare de diacritice.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  regexp_replace(
    lower(translate(TRIM(compartiment), 'ăâîșțĂÂÎȘȚşţŞŢ', 'aaistAAISTsttT')),
    '\s+', ' ', 'g'
  ) AS cheie_normalizata,
  COUNT(*) AS nr_utilizatori,
  array_agg(DISTINCT TRIM(compartiment)) AS variante_scriere
FROM users
WHERE deleted_at IS NULL
  AND COALESCE(TRIM(compartiment), '') <> ''
GROUP BY 1
HAVING COUNT(DISTINCT TRIM(compartiment)) > 1
ORDER BY nr_utilizatori DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Q3 — divergență pointer: dosare ALOP unde `compartiment` declarat pe rând diferă
-- (după aceeași normalizare ca Q2) de compartimentul CURENT al creatorului.
-- Un rezultat nevid arată dosare unde granița de drepturi (#143) s-ar putea comporta
-- diferit față de eticheta afișată pe dosar — creatorul s-a mutat de compartiment
-- după crearea dosarului, sau dosarul a fost etichetat manual diferit.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  a.id AS alop_id,
  a.titlu,
  a.compartiment AS compartiment_declarat_pe_dosar,
  u.compartiment AS compartiment_curent_creator,
  a.created_by,
  a.created_at
FROM alop_instances a
JOIN users u ON u.id = a.created_by
WHERE a.cancelled_at IS NULL
  AND COALESCE(TRIM(a.compartiment), '') <> ''
  AND COALESCE(TRIM(u.compartiment), '') <> ''
  AND regexp_replace(
        lower(translate(TRIM(a.compartiment), 'ăâîșțĂÂÎȘȚşţŞŢ', 'aaistAAISTsttT')),
        '\s+', ' ', 'g'
      )
      IS DISTINCT FROM
      regexp_replace(
        lower(translate(TRIM(u.compartiment), 'ăâîșțĂÂÎȘȚşţŞŢ', 'aaistAAISTsttT')),
        '\s+', ' ', 'g'
      )
ORDER BY a.created_at DESC;
