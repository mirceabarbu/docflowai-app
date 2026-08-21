/**
 * server/services/alop-dosar-sql.mjs — STAREA UNUI DOSAR ALOP (#134e)
 *
 * De ce exista: pana acum starea se deriva din POINTERUL a.df_id, care se muta pe
 * revizia noua in clipa crearii ei. Reconul #134a a aratat ca asta face ca:
 *  - badge-ul "Revizie pe flux" sa nu se aprinda niciodata pentru o revizie in draft;
 *  - COALESCE(df.flow_id, a.df_flow_id) sa nu poata vedea fluxul reviziei odata ce
 *    pointerul e mutat inapoi pe revizia aprobata (varianta A).
 * Derivarea pe DOSAR e corecta sub AMBELE regimuri, deci muta riscul in afara
 * schimbarii de semantica.
 *
 * ⛔ Corelat STRICT pe a.* — WHERE-ul de COUNT din GET /api/alop nu are joinuri (#121).
 *    O singura referinta la aliasul `df` (sau la orice alt JOIN) sparge COUNT-ul.
 * ⛔ Fara backtick-uri si fara diacritice in comentariile SQL de mai jos (lectia #134b:
 *    rup template literal-ul in care se interpoleaza fragmentele).
 *
 * Modul PUR — fara `pool`, pe tiparul lui df-dosar-key.mjs si df-aprobat-sql.mjs.
 */
import { dfAprobatSql, dfAprobatExistsSql } from './df-aprobat-sql.mjs';

/**
 * Fluxul DF-ului POINTAT azi de `a.df_id` (NULL daca nu exista pointer sau DF-ul
 * n-are flux). Folosit doar ca sa reproducem EXACT semantica veche a
 * `COALESCE(df.flow_id, a.df_flow_id)` pe ramura de compatibilitate.
 */
const flowDinPointer = (a) =>
  `(SELECT dpf.flow_id FROM formulare_df dpf WHERE dpf.id = ${a}.df_id)`;

/**
 * Predicat: randul `fd` apartine DOSARULUI ALOP-ului `a`.
 *
 * Ramura principala — `fd.source_alop_id = a.id`. Indexata: idx partial pe
 * formulare_df(source_alop_id) (migrarea 084) + unicul df_source_alop_revizie_uniq
 * (source_alop_id, revizie_nr) (migrarea 095). E identitatea reala a lantului de revizii.
 *
 * Ramura LEGACY — DF-uri fara provenienta (source_alop_id NULL, dinainte de 084):
 * acelasi org + acelasi nr_unic_inreg ca DF-ul pointat azi de a.df_id.
 * ⚠️ Ramura legacy e SINGURUL loc care mai poate amesteca doua dosare care si-au
 *    partajat numarul din registratura (vezi docs/incidents/DF-NR-DUPLICAT.md).
 *    De aceea e limitata STRICT la source_alop_id IS NULL: un dosar cu provenienta
 *    nu poate fi contaminat de un omonim legacy si viceversa.
 */
export const sqlFdInDosar = (fd = 'fd', a = 'a') => `(
    ${fd}.deleted_at IS NULL
    AND (
      ${fd}.source_alop_id = ${a}.id
      OR (
        ${fd}.source_alop_id IS NULL
        AND ${fd}.org_id = ${a}.org_id
        AND ${fd}.nr_unic_inreg = (SELECT d0.nr_unic_inreg FROM formulare_df d0 WHERE d0.id = ${a}.df_id)
      )
    )
  )`;

/** Gardele "flux viu" — identice cu fostul SQL_ALOP_FLUX_DF_ACTIV. */
const fluxViu = (f) => `${f}.deleted_at IS NULL
       AND (${f}.data->>'completed') IS DISTINCT FROM 'true'
       AND (${f}.data->>'status')    IS DISTINCT FROM 'cancelled'
       AND (${f}.data->>'status')    IS DISTINCT FROM 'refused'`;

/**
 * O revizie ORICARE a dosarului se afla pe un flux VIU (nesters, nefinalizat,
 * neanulat, nerefuzat).
 *
 * A doua ramura pastreaza compatibilitatea cu vechiul COALESCE(df.flow_id, a.df_flow_id):
 * cand DF-ul pointat n-are flow_id propriu, pointerul de pe ALOP (a.df_flow_id) ramane
 * sursa. Conditionata pe "pointerul DF n-are flux" ca sa NU resusciteze un flux zombi
 * cand DF-ul are deja unul autoritar.
 */
export const sqlDosarAreFluxActiv = (a = 'a') => `(
    EXISTS (
      SELECT 1 FROM formulare_df fdfa
       WHERE ${sqlFdInDosar('fdfa', a)}
         AND fdfa.flow_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM flows ffa
            WHERE ffa.id::text = fdfa.flow_id
              AND ${fluxViu('ffa')}
         )
    )
    OR (
      ${a}.df_flow_id IS NOT NULL
      AND ${flowDinPointer(a)} IS NULL
      AND EXISTS (
        SELECT 1 FROM flows fpa
         WHERE fpa.id::text = ${a}.df_flow_id
           AND ${fluxViu('fpa')}
      )
    )
  )`;

/**
 * DOSARUL are cel putin o revizie APROBATA.
 * ⛔ Definitia aprobarii NU se rescrie aici — vine din df-aprobat-sql.mjs (#134d).
 */
export const sqlDosarAreAprobat = (a = 'a') => `(
    EXISTS (
      SELECT 1 FROM formulare_df fdap
        JOIN flows fap ON fap.id::text = fdap.flow_id
       WHERE ${sqlFdInDosar('fdap', a)}
         AND ${dfAprobatSql('fdap', 'fap')}
    )
    OR (
      ${a}.df_flow_id IS NOT NULL
      AND ${flowDinPointer(a)} IS NULL
      AND ${dfAprobatExistsSql(`${a}.df_flow_id`, 'fxap')}
    )
  )`;

/**
 * Subinterogare interna: revizia "in lucru" a dosarului = revizia cu revizie_nr MAXIM
 * care NU e aprobata.
 *
 * ⚠️ DECIZII EXPLICITE (nu sunt bug-uri, nu le "repara" la urmatoarea sesiune):
 *  1. revizie_nr > 0 obligatoriu — un R0 in draft e DOCUMENTUL INITIAL, nu o revizie
 *     in lucru; altfel orice dosar nou ar bloca butonul "Revizuieste DF".
 *  2. O revizie REFUZATA se numara ca "in lucru" — are nevoie de rework, deci dosarul
 *     NU trebuie sa permita deschiderea unei a doua revizii paralele peste ea.
 *     (dfAprobatSql exclude explicit status 'refused'.)
 */
const revizieInLucru = (col, a) => `(
    SELECT ${col} FROM formulare_df fdrl
     WHERE ${sqlFdInDosar('fdrl', a)}
       AND COALESCE(fdrl.revizie_nr, 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM flows frl
          WHERE frl.id::text = fdrl.flow_id
            AND ${dfAprobatSql('fdrl', 'frl')}
       )
     ORDER BY fdrl.revizie_nr DESC, fdrl.created_at DESC
     LIMIT 1
  )`;

/** Id-ul reviziei in lucru a dosarului, sau NULL. */
export const sqlRevizieInLucruId = (a = 'a') => revizieInLucru('fdrl.id', a);

/** Numarul (revizie_nr) reviziei in lucru a dosarului, sau NULL. */
export const sqlRevizieInLucruNr = (a = 'a') => revizieInLucru('fdrl.revizie_nr', a);

/**
 * Subinterogare interna: revizia IN VIGOARE a dosarului = revizia cu revizie_nr
 * MAXIM care ESTE aprobata. Complementara exacta a lui revizieInLucru.
 *
 * ⚠️ DECIZII EXPLICITE (nu sunt scapari):
 *  1. FARA conditia revizie_nr > 0 — un R0 aprobat ESTE documentul in vigoare.
 *  2. Se deriva pe DOSAR, deci ramane corecta chiar daca a.df_id a ramas pe o
 *     revizie neaprobata (pointer scris inainte de #134f).
 *  3. Poate intoarce NULL desi df_aprobat e true: ramura de compatibilitate din
 *     sqlDosarAreAprobat (aprobare prin a.df_flow_id, cand DF-ul pointat n-are
 *     flow_id propriu) nu produce un revizie_nr. Consumatorul cade inapoi pe
 *     pointer in acel caz — vezi ETAPA C.
 */
const revizieInVigoare = (col, a) => `(
    SELECT ${col} FROM formulare_df fdrv
     WHERE ${sqlFdInDosar('fdrv', a)}
       AND EXISTS (
         SELECT 1 FROM flows frv
          WHERE frv.id::text = fdrv.flow_id
            AND ${dfAprobatSql('fdrv', 'frv')}
       )
     ORDER BY COALESCE(fdrv.revizie_nr, 0) DESC, fdrv.created_at DESC
     LIMIT 1
  )`;

/** Id-ul reviziei in vigoare a dosarului, sau NULL. */
export const sqlRevizieInVigoareId = (a = 'a') => revizieInVigoare('fdrv.id', a);

/** Numarul (revizie_nr) reviziei in vigoare a dosarului, sau NULL. */
export const sqlRevizieInVigoareNr = (a = 'a') =>
  revizieInVigoare('COALESCE(fdrv.revizie_nr, 0)', a);
