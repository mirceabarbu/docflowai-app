#!/usr/bin/env node
/**
 * backfill-df-source-alop.mjs — propagă `formulare_df.source_alop_id` pe LANȚURILE DE
 * REVIZII care sunt DEJA legate de un ALOP (#134g, v3.9.791).
 *
 * ── DE CE ───────────────────────────────────────────────────────────────────────────
 * `sqlFdInDosar` (server/services/alop-dosar-sql.mjs, #134e) are o ramură LEGACY pentru
 * DF-urile cu `source_alop_id IS NULL`, care cheiază pe `org_id + nr_unic_inreg` — exact
 * vectorul de coliziune din docs/incidents/DF-NR-DUPLICAT.md. Ca poartă de AFIȘARE e
 * acceptabilă; ca poartă de SECURITATE pentru lansarea unui flux (#134f), NU este.
 * Decizia owner-ului: nu slăbim poarta — ELIMINĂM cazul legacy, propagând proveniența
 * pe lanțurile deja identificabile fără ambiguitate.
 *
 * ── ⚠️ SCRIE CHEIA DE DOSAR, NU UN CÂMP OARECARE ────────────────────────────────────
 * `dosarKeyExpr = COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)` (#126). Scriind
 * `source_alop_id`, SCHIMBI cheia de dosar pentru acele DF-uri. Consumatori reali:
 * /aprobate (DISTINCT ON), has_newer_revision, nr_partajat, /revizii, trasabilitate.mjs,
 * clasa8.mjs, /revizuieste.
 *   • lanț cu număr UNIC           ⇒ comportament IDENTIC (aceeași partiție, alt nume);
 *   • lanțuri care ÎMPART un număr ⇒ se SEPARĂ (adică se repară bug-ul din #126).
 *
 * ── 🔒 REGULA DE FIER: ALL-OR-NOTHING PE LANȚ ───────────────────────────────────────
 * Dacă `source_alop_id` s-ar scrie pe o parte din lanț și nu pe alta, lanțul se RUPE:
 * `has_newer_revision` se strică și `/revizuieste` începe să spună „Această revizie nu
 * mai este cea curentă" PE VIAȚĂ (exact starea artificială de la #134c). De aceea:
 * o TRANZACȚIE PER LANȚ, scrisă integral sau deloc, cu verificare de `rowCount`.
 *
 * ── ⛔ NICIODATĂ PRIN `nr_unic_inreg` ───────────────────────────────────────────────
 * Lanțul se descoperă EXCLUSIV prin muchiile `parent_df_id` (în ambele direcții:
 * strămoși + descendenți). Propagarea prin număr ar importa chiar coliziunea pe care
 * lotul o elimină.
 *
 * ── Utilizare ───────────────────────────────────────────────────────────────────────
 *   node tools/backfill-df-source-alop.mjs                  # DRY-RUN (implicit)
 *   node tools/backfill-df-source-alop.mjs --apply          # scrie
 *   node tools/backfill-df-source-alop.mjs --org=7          # restrânge la o organizație
 *   node tools/backfill-df-source-alop.mjs --org=7 --apply
 *
 * ⚠️ `organizations.id` / `formulare_df.org_id` / `alop_instances.org_id` sunt INTEGER
 *    (migrațiile 048 + 014_alop.sql) — `--org=` primește un ÎNTREG, nu un UUID.
 *
 * Maintenance one-off, idempotent, NU migrație (corecție de DATE de tenant; are nevoie
 * de dry-run + raport, ceea ce tranzacția unică de la boot nu permite). Precedent în
 * arbore: tools/backfill-formular-flow-attachments.mjs.
 *
 * ⛔ NU mută `alop_instances.df_id` — aceea e reparația #134h, care rulează DUPĂ #134f.
 */

import { pathToFileURL } from 'node:url';

// Adâncime maximă a unei căi simple în lanț. Un lanț real de revizii DF are unități, nu
// sute. Depășirea plafonului = date corupte (buclă/graf dens) ⇒ lanțul se sare, nu se scrie.
const MAX_DEPTH = 200;

// ── SQL ───────────────────────────────────────────────────────────────────────────────

/**
 * Candidați: ALOP-uri VII care pointează la un DF fără proveniență.
 * `fd.deleted_at IS NULL` e obligatoriu — dintr-un DF șters nu se poate porni traversarea
 * lanțului (toate muchiile se plimbă doar prin rânduri active).
 */
const SQL_CANDIDATI = (filtruOrg) => `
  SELECT a.id AS alop_id, a.org_id, a.df_id, a.status AS alop_status
    FROM alop_instances a
    JOIN formulare_df fd ON fd.id = a.df_id
   WHERE a.df_id IS NOT NULL
     AND a.cancelled_at IS NULL
     AND fd.deleted_at IS NULL
     AND fd.source_alop_id IS NULL
     ${filtruOrg ? 'AND a.org_id = $1' : ''}
   ORDER BY a.created_at, a.id
`;

/**
 * Componenta conexă a lanțului, pornind de la `$1`, pe muchiile `parent_df_id` traversate
 * NEORIENTAT (strămoși ȘI descendenți). `NOT (n.id = ANY(c.path))` păstrează calea vizitată
 * și oprește repetiția — CTE-ul termină chiar și pe date cu buclă în `parent_df_id`
 * (bucla se detectează separat, în JS, pe harta părinților).
 */
const SQL_LANT = `
  WITH RECURSIVE chain AS (
    SELECT fd.id, fd.parent_df_id, ARRAY[fd.id] AS path
      FROM formulare_df fd
     WHERE fd.id = $1 AND fd.deleted_at IS NULL
    UNION ALL
    SELECT n.id, n.parent_df_id, c.path || n.id
      FROM chain c
      JOIN formulare_df n
        ON (n.id = c.parent_df_id OR n.parent_df_id = c.id)
     WHERE n.deleted_at IS NULL
       AND NOT (n.id = ANY(c.path))
       AND array_length(c.path, 1) < $2
  )
  SELECT DISTINCT
         fd.id, fd.parent_df_id, fd.org_id, fd.source_alop_id,
         fd.revizie_nr, fd.nr_unic_inreg, fd.status, fd.flow_id,
         (SELECT COALESCE(MAX(array_length(c2.path, 1)), 0) FROM chain c2) AS max_depth
    FROM chain c
    JOIN formulare_df fd ON fd.id = c.id
   ORDER BY fd.revizie_nr, fd.id
`;

/** S2 — ALOP-uri VII care pointează ORIUNDE în lanț (indiferent de org / de filtrul --org). */
const SQL_ALOP_PE_LANT = `
  SELECT id, org_id, df_id FROM alop_instances
   WHERE cancelled_at IS NULL AND df_id = ANY($1::uuid[])
   ORDER BY id
`;

/** S3 — rânduri care poartă DEJA `source_alop_id = $1` din AFARA lanțului (coliziune de index). */
const SQL_REVIZII_EXISTENTE = `
  SELECT id, revizie_nr FROM formulare_df
   WHERE source_alop_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))
   ORDER BY revizie_nr
`;

const SQL_SCRIE = `
  UPDATE formulare_df
     SET source_alop_id = $1, updated_at = NOW()
   WHERE id = ANY($2::uuid[]) AND source_alop_id IS NULL AND deleted_at IS NULL
`;

// ── Detecție de buclă (JS, pe harta părinților lanțului) ──────────────────────────────

/**
 * Întoarce `true` dacă urcarea pe `parent_df_id` din vreun membru se închide în buclă.
 * Muchiile spre afara lanțului (părinte șters/inexistent) se opresc natural.
 */
function areCiclu(membri) {
  const parinte = new Map(membri.map((m) => [m.id, m.parent_df_id]));
  for (const start of membri) {
    const vazuti = new Set();
    let cur = start.id;
    while (cur != null && parinte.has(cur)) {
      if (vazuti.has(cur)) return true;
      vazuti.add(cur);
      cur = parinte.get(cur);
    }
  }
  return false;
}

// ── Miezul ────────────────────────────────────────────────────────────────────────────

function raportGol({ apply, orgId }) {
  return {
    apply, orgId,
    lanturiExaminate: 0,
    lanturiScrise: 0,
    dfAtinse: 0,
    scrise: [],
    skip: { S1: [], S2: [], S3: [], S4: [], CICLU: [], EROARE: [] },
  };
}

/**
 * @param {object}  o
 * @param {import('pg').Pool} o.pool  pool deja conectat (scriptul îl construiește; testele îl injectează)
 * @param {boolean} o.apply           false (implicit) = DRY-RUN, nu se scrie NIMIC
 * @param {number|null} o.orgId       restrânge la o organizație (INTEGER), sau null = toate
 * @returns {Promise<object>} raportul (vezi `raportGol`)
 */
export async function backfillSourceAlop({ pool, apply = false, orgId = null } = {}) {
  if (!pool) throw new Error('backfillSourceAlop: `pool` este obligatoriu.');
  const raport = raportGol({ apply: !!apply, orgId: orgId ?? null });

  const { rows: candidati } = await pool.query(
    SQL_CANDIDATI(orgId != null),
    orgId != null ? [orgId] : []
  );

  for (const c of candidati) {
    // ⛔ Fără `process.exit` și fără `throw` în mijlocul buclei: un lanț problematic NU are
    //    voie să oprească restul. Orice eroare se raportează nominal și se merge mai departe.
    const context = { alopId: c.alop_id, alopOrgId: c.org_id, seedDfId: c.df_id };
    try {
      const { rows: membri } = await pool.query(SQL_LANT, [c.df_id, MAX_DEPTH]);
      if (membri.length === 0) {
        raport.skip.EROARE.push({ ...context, membri: [],
          detaliu: 'lanț gol — DF-ul pointat nu mai e activ între citiri' });
        continue;
      }
      raport.lanturiExaminate++;

      const ids = membri.map((m) => m.id);
      const desc = (m) => `${m.id}(R${m.revizie_nr ?? '?'})`;

      // ── Poarta CICLU (B11) — buclă în `parent_df_id` sau adâncime peste plafon ──
      const maxDepth = Number(membri[0].max_depth || 0);
      const ciclu = areCiclu(membri);
      if (ciclu || maxDepth >= MAX_DEPTH) {
        raport.skip.CICLU.push({ ...context, membri: ids,
          detaliu: ciclu
            ? 'buclă în parent_df_id — lanț neinterpretabil'
            : `adâncime ≥ ${MAX_DEPTH} — graf suspect` });
        continue;
      }

      // ── S1: revendicat de altcineva ──
      const straini = membri.filter((m) => m.source_alop_id && m.source_alop_id !== c.alop_id);
      if (straini.length > 0) {
        raport.skip.S1.push({ ...context, membri: ids,
          detaliu: `revendicat de alt ALOP: ${straini.map((m) => `${desc(m)}→${m.source_alop_id}`).join(', ')}` });
        continue;
      }

      // ── S4: org diferit ── (înaintea S2/S3: e cea mai gravă anomalie de tenant)
      const altOrg = membri.filter((m) => Number(m.org_id) !== Number(c.org_id));
      if (altOrg.length > 0) {
        raport.skip.S4.push({ ...context, membri: ids,
          detaliu: `org ALOP=${c.org_id}, membri cu alt org: ${altOrg.map((m) => `${desc(m)}→org=${m.org_id}`).join(', ')}` });
        continue;
      }

      // ── S2: două ALOP-uri VII pointează în același lanț ──
      // ⚠️ NEFILTRAT pe --org: un ALOP concurent din altă organizație trebuie tot văzut.
      const { rows: alopuri } = await pool.query(SQL_ALOP_PE_LANT, [ids]);
      if (alopuri.length > 1) {
        raport.skip.S2.push({ ...context, membri: ids,
          detaliu: `ambiguu — ${alopuri.length} ALOP-uri necancelate pointează în lanț: ${alopuri.map((a) => `${a.id}→df=${a.df_id}`).join(', ')}` });
        continue;
      }

      // ── S3: coliziune de `revizie_nr` (ar viola df_source_alop_revizie_uniq, migrarea 095) ──
      const perRevizie = new Map();
      for (const m of membri) {
        const k = String(m.revizie_nr ?? 'null');
        perRevizie.set(k, [...(perRevizie.get(k) || []), m]);
      }
      const dubluriInterne = [...perRevizie.entries()].filter(([, v]) => v.length > 1);
      if (dubluriInterne.length > 0) {
        raport.skip.S3.push({ ...context, membri: ids,
          detaliu: `revizie_nr duplicat în lanț: ${dubluriInterne.map(([k, v]) => `R${k}×${v.length} [${v.map((m) => m.id).join(' ')}]`).join('; ')}` });
        continue;
      }
      // …și contra rândurilor care poartă DEJA acest `source_alop_id` din afara lanțului.
      const { rows: existente } = await pool.query(SQL_REVIZII_EXISTENTE, [c.alop_id, ids]);
      const ciocniri = existente.filter((e) => perRevizie.has(String(e.revizie_nr ?? 'null')));
      if (ciocniri.length > 0) {
        raport.skip.S3.push({ ...context, membri: ids,
          detaliu: `revizie_nr deja ocupat pe ALOP de rânduri din afara lanțului: ${ciocniri.map((e) => `${e.id}(R${e.revizie_nr})`).join(', ')}` });
        continue;
      }

      // ── Scrierea ── all-or-nothing, tranzacție per lanț
      const deScrisRows = membri.filter((m) => m.source_alop_id == null);
      const deScris = deScrisRows.map((m) => m.id);
      if (deScris.length === 0) continue;   // deja backfillat integral (idempotență)

      const inregistreazaSucces = () => {
        raport.lanturiScrise++;
        raport.dfAtinse += deScris.length;
        raport.scrise.push({ ...context, membri: ids, scrise: deScris,
          detaliu: deScrisRows.map(desc).join(', ') });
      };

      if (!apply) { inregistreazaSucces(); continue; }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await client.query(SQL_SCRIE, [c.alop_id, deScris]);
        if (res.rowCount !== deScris.length) {
          await client.query('ROLLBACK');
          raport.skip.EROARE.push({ ...context, membri: ids,
            detaliu: `ROLLBACK — rowCount=${res.rowCount}, așteptat ${deScris.length} (lanțul s-a schimbat sub noi)` });
          continue;
        }
        await client.query('COMMIT');
        inregistreazaSucces();
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) {
          raport.skip.EROARE.push({ ...context, membri: ids,
            detaliu: `ROLLBACK eșuat: ${e2.message || String(e2)}` });
        }
        raport.skip.EROARE.push({ ...context, membri: ids,
          detaliu: `eroare la scriere: ${e.message || e.code || String(e)}` });
      } finally {
        client.release();
      }
    } catch (e) {
      raport.skip.EROARE.push({ ...context, membri: [],
        detaliu: `eroare la examinarea lanțului: ${e.message || e.code || String(e)}` });
    }
  }

  return raport;
}

// ── Raport ────────────────────────────────────────────────────────────────────────────

export const ANTET_DRY_RUN = 'DRY-RUN — nu s-a scris nimic. Reruleaza cu --apply.';

const ETICHETE = {
  S1: 'S1 revendicat de alt ALOP',
  S2: 'S2 ambiguu (2+ ALOP-uri pe lanț)',
  S3: 'S3 coliziune de revizie_nr',
  S4: 'S4 org diferit',
  CICLU: 'CICLU / adâncime (date corupte)',
  EROARE: 'EROARE (lanț neprelucrat)',
};

/** Raportul lizibil, IDENTIC ca formă în dry-run și în --apply. */
export function formatReport(raport) {
  const L = [];
  const linie = '─'.repeat(78);
  const linieG = '═'.repeat(78);

  L.push(linieG);
  L.push('  BACKFILL source_alop_id pe lanțurile de revizii DF legate de un ALOP (#134g)');
  L.push(linieG);
  if (!raport.apply) L.push(`  ⚠️  ${ANTET_DRY_RUN}`);
  else L.push('  ✍️  APPLY — modificările de mai jos AU FOST scrise.');
  L.push(linie);
  L.push(`  Filtru org:         ${raport.orgId == null ? 'toate organizațiile' : `org_id=${raport.orgId}`}`);
  L.push(`  Lanțuri examinate:  ${raport.lanturiExaminate}`);
  L.push(`  Lanțuri scrise:     ${raport.lanturiScrise}${raport.apply ? '' : ' (ar fi fost)'}`);
  L.push(`  DF-uri atinse:      ${raport.dfAtinse}${raport.apply ? '' : ' (ar fi fost)'}`);
  L.push(linie);

  L.push(`SCRISE (${raport.scrise.length}):`);
  if (raport.scrise.length === 0) L.push('  — niciun lanț —');
  for (const s of raport.scrise) {
    L.push(`  • ALOP ${s.alopId}  org=${s.alopOrgId}  seed DF=${s.seedDfId}`);
    L.push(`      lanț (${s.membri.length}): ${s.membri.join(' ')}`);
    L.push(`      source_alop_id ← ${s.alopId} pe ${s.scrise.length}: ${s.detaliu}`);
  }
  L.push(linie);

  L.push('SĂRITE:');
  for (const [k, eticheta] of Object.entries(ETICHETE)) {
    const arr = raport.skip[k] || [];
    L.push(`  ${eticheta} (${arr.length}):`);
    if (arr.length === 0) { L.push('      —'); continue; }
    for (const s of arr) {
      L.push(`    • ALOP ${s.alopId}  org=${s.alopOrgId}  seed DF=${s.seedDfId}`);
      L.push(`        lanț (${s.membri.length}): ${s.membri.join(' ') || '—'}`);
      L.push(`        motiv: ${s.detaliu}`);
    }
  }
  L.push(linieG);
  if (!raport.apply) L.push(ANTET_DRY_RUN);
  L.push('');
  return L.join('\n');
}

// ── main() — thin wrapper, rulat DOAR ca script ───────────────────────────────────────

/** Parsează argv. Orice combinație necunoscută ⇒ `{ eroare }` (NICIODATĂ apply implicit). */
export function parseArgs(argv) {
  const out = { apply: false, orgId: null };
  for (const a of argv) {
    if (a === '--apply') { out.apply = true; continue; }
    const m = /^--org=(.+)$/.exec(a);
    if (m) {
      // org_id e INTEGER în schemă (048_formulare_df / 014_alop.sql) — NU UUID.
      if (!/^[0-9]+$/.test(m[1])) {
        return { eroare: `--org= așteaptă un INTEGER (org_id), primit: "${m[1]}"` };
      }
      out.orgId = Number(m[1]);
      continue;
    }
    return { eroare: `argument necunoscut: "${a}"` };
  }
  return out;
}

const UTILIZARE = `
Utilizare:
  node tools/backfill-df-source-alop.mjs                 # DRY-RUN (implicit, nu scrie nimic)
  node tools/backfill-df-source-alop.mjs --apply         # scrie
  node tools/backfill-df-source-alop.mjs --org=<int>     # restrânge la o organizație
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.eroare) {
    console.error(`❌ ${args.eroare}\n\n${UTILIZARE}`);
    process.exit(1);
  }

  const [{ default: pg }, { readFileSync }, { resolve, dirname }, { fileURLToPath }] =
    await Promise.all([import('pg'), import('fs'), import('path'), import('url')]);

  // Încarcă .env manual (fără dependență de dotenv) — convenția tools/.
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* .env absent — se folosește environment-ul existent */ }

  const url = process.env.DATABASE_URL;
  if (!url) { console.error('❌ DATABASE_URL lipsă.'); process.exit(1); }

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    console.log('🔌 Conectare la baza de date...');
    const raport = await backfillSourceAlop({ pool, apply: args.apply, orgId: args.orgId });
    console.log(formatReport(raport));
    const problematice = Object.values(raport.skip).reduce((n, a) => n + a.length, 0);
    if (problematice > 0) {
      console.log(`ℹ️  ${problematice} lanț(uri) sărit(e) — vezi secțiunea SĂRITE pentru id-uri.`);
    }
  } catch (e) {
    console.error('❌ Eroare fatală:', e.message || e.code || String(e));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Rulat ca script vs. importat din teste.  e obligatoriu pe Windows
// (`file://D:\...` nu se potrivește niciodată cu `file:///D:/...` din import.meta.url).
const RULAT_CA_SCRIPT = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(arg).href; } catch { return false; }
})();

if (RULAT_CA_SCRIPT) await main();
