/**
 * server/services/df-dosar-key.mjs — CHEIA LANȚULUI DE REVIZII DF (#126, v3.9.755)
 *
 * Modul PUR, fără dependențe (nici măcar pool) — ca să poată fi importat din
 * orice rută/serviciu fără să tragă după el jumătate din backend.
 *
 * ── De ce există ────────────────────────────────────────────────────────────
 * În producție există `nr_unic_inreg` DUPLICATE între DOSARE ALOP DIFERITE:
 * utilizatorii deschid un dosar nou pentru cheltuiala următoare pe același obiect
 * și refolosesc numărul din registratură. (Calea corectă e o REVIZIE a DF-ului
 * existent — vezi docs/incidents/DF-NR-DUPLICAT.md.)
 *
 * Identitatea lanțului de revizii e DEJA dosarul, la nivel de constrângere:
 * indexul unic `df_source_alop_revizie_uniq (source_alop_id, revizie_nr)`
 * (migrarea 095). Interogările care cheiau pe NUMĂR amestecau dosare străine:
 *   • /revizuieste — după ce un dosar ajungea la R1, celălalt primea „Această
 *     revizie (R0) nu mai este cea curentă" PE VIAȚĂ;
 *   • /aprobate — `DISTINCT ON (nr_unic_inreg)` ștergea un DF din dropdown-ul ORD;
 *   • has_newer_revision — documente marcate „istoric" de un dosar străin;
 *   • /revizii + trasabilitate — „R0 ✓ | R0 ⏳" în același lanț.
 *
 * ⛔ Fallback-ul e `nr_unic_inreg`, NU `id` — DF-urile LEGACY (source_alop_id NULL)
 *    trebuie să-și păstreze lanțul exact ca înainte; cu `id::text` fiecare revizie
 *    legacy ar deveni un lanț separat.
 * ⛔ La `DISTINCT ON`, primul termen din ORDER BY trebuie să fie EXACT aceeași
 *    expresie — de aceea e definită O SINGURĂ dată aici și importată peste tot.
 * ⛔ NU există și NU poate exista index unic pe `nr_unic_inreg`: în producție două
 *    documente în coliziune au deja semnături QES aplicate (au ieșit din aplicație).
 *    Garda de la PUT (doar la SCHIMBAREA numărului) e tot ce se poate face.
 */

/** Fragment SQL: cheia de dosar pentru un alias de `formulare_df`. */
export const dosarKeyExpr = (alias = 'fd') =>
  `COALESCE(${alias}.source_alop_id::text, ${alias}.nr_unic_inreg)`;

/** Cheia de dosar a unui rând deja încărcat în JS — aceeași semantică cu dosarKeyExpr. */
export function dosarKeyOf(row) {
  return row?.source_alop_id ? String(row.source_alop_id) : (row?.nr_unic_inreg ?? null);
}
