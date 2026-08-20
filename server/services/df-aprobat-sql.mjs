/**
 * server/services/df-aprobat-sql.mjs — CE INSEAMNA "DF APROBAT" (#134d)
 *
 * Reconul #134a a gasit CINCI forme distincte, neechivalente, in arbore. Aceasta
 * e forma STRICTA (4), cea deja folosita pe caile care iau DECIZII DE RELEGARE.
 *
 * De ce fiecare garda:
 *  - flow_id IS NOT NULL      : fara flux nu exista aprobare derivata
 *  - f.deleted_at IS NULL     : un flux SOFT-STERS nu mai aproba nimic (#131 fix D)
 *  - status != 'cancelled'    : anulat nu e aprobat
 *  - status != 'refused'      : refuzat nu e aprobat
 *  - completed / completed=true: cele doua reprezentari istorice ale finalizarii
 *
 * ⛔ Coloana formulare_df.status='aprobat' NU e sursa de adevar: pe calea de
 *    semnare CLOUD ea ramane 'completed'. E doar cache de afisare.
 * ⛔ Nu adauga backtick-uri in acest fisier in interiorul sirurilor returnate:
 *    rezultatul se interpoleaza in template literal-e SQL.
 */
export const dfAprobatSql = (fd = 'fd', f = 'f') => `(
  ${fd}.flow_id IS NOT NULL
  AND ${f}.deleted_at IS NULL
  AND (${f}.data->>'status') IS DISTINCT FROM 'cancelled'
  AND (${f}.data->>'status') IS DISTINCT FROM 'refused'
  AND ((${f}.data->>'status') = 'completed' OR (${f}.data->>'completed')::boolean = true)
)`;

/**
 * Varianta CORELATA, pentru interogari care NU au flows in FROM (ex. WHERE-ul de
 * COUNT din GET /api/alop, care nu are niciun JOIN — vezi #121/#132b).
 * `flowExpr` = expresia care produce id-ul fluxului (text).
 */
export const dfAprobatExistsSql = (flowExpr, fx = 'fx') => `EXISTS (
  SELECT 1 FROM flows ${fx}
   WHERE ${fx}.id::text = ${flowExpr}
     AND ${fx}.deleted_at IS NULL
     AND (${fx}.data->>'status') IS DISTINCT FROM 'cancelled'
     AND (${fx}.data->>'status') IS DISTINCT FROM 'refused'
     AND ((${fx}.data->>'status') = 'completed' OR (${fx}.data->>'completed')::boolean = true)
)`;
