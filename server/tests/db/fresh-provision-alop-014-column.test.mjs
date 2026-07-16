/**
 * fresh-provision-alop-014-column.test.mjs
 *
 * Reproduce ORDINEA REALĂ de producție pe un DB genuinely fresh — NU migrateForTests()
 * (helper-ul de test amână/reordonează migrările V4-referencing ca să evite exact acest
 * gol, deci NU poate servi drept dovadă pentru el — vezi comentariul din migrateForTests
 * în server/db/index.mjs).
 *
 * Secvența reală de boot (server/index.mjs):
 *   initDbWithRetry() → inline runMigrations (o singură tranzacție, `alop_instances` și
 *   `formulare_oficiale` NU există încă) → runMigrationsV4 (server/db/migrate.mjs, creează
 *   ambele din server/db/migrations/014_alop.sql + 015_formulare_oficiale.sql).
 *
 * Două goluri confirmate pe boot fresh, NEACOPERITE de migrateForTests:
 *
 * 1. 099_lichidare_valoare_factura (inline) e gardată pe existența `alop_instances`
 *    (guard identic celorlalte migrări ALOP) → pe boot fresh SARE silențios (RETURN în
 *    DO $g$), la fel ca 055-062 înaintea ei. Singura sursă de adevăr pentru coloană pe
 *    fresh boot e deci `014_alop.sql` (V4) — de aceea coloana a fost dublată acolo.
 *
 * 2. 068_formular_attachments (inline) NU avea nicio gardă și făcea
 *    `CREATE TABLE ... REFERENCES formulare_oficiale(id)` — pe boot fresh formulare_oficiale
 *    nu există încă (V4-only, creat DUPĂ inline) → migrația arunca eroare reală (nu skip),
 *    ceea ce făcea ROLLBACK pe ÎNTREAGA tranzacție inline (toate cele ~99 migrații, nu doar
 *    068) → DB_READY rămânea false permanent pe orice boot genuinely fresh, indiferent de
 *    fix-ul de mai sus. Fix: 068 gardată la fel ca restul (IF NOT EXISTS formulare_oficiale
 *    THEN RETURN), iar `formular_attachments` mutat garantat în `015_formulare_oficiale.sql`
 *    (V4), imediat după CREATE TABLE formulare_oficiale.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { hasTestDb } from '../helpers/db-real.mjs';

const d = describe.skipIf(!hasTestDb())('provisioning fresh — ordinea NE-AMÂNATĂ (inline apoi V4)', () => {
  let adminClient;
  let freshDbName;
  let freshPool;
  let originalDatabaseUrl;

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    const base = new URL(process.env.TEST_DATABASE_URL);
    freshDbName = `docflow_fresh_${Date.now()}`;

    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    adminClient = new pg.Client({ connectionString: adminUrl.toString() });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${freshDbName}"`);

    const freshUrl = new URL(base);
    freshUrl.pathname = `/${freshDbName}`;
    process.env.DATABASE_URL = freshUrl.toString();
  }, 30_000);

  afterAll(async () => {
    // NU așteptăm DROP DATABASE: pe clusterul de test (partajat cu restul suitei DB, ~70
    // fișiere înaintea acestuia) comanda poate rămâne agățată pe contenție de conexiuni —
    // nu e o problemă de corectitudine, doar cosmetică. Instanța Postgres însăși e efemeră
    // (spin-up local per rulare / container `postgres:16` în CI, aruncat după job) — o bază
    // "docflow_fresh_*" rămasă nu supraviețuiește dincolo de instanța curentă. Best-effort,
    // fără await, ca să nu blocheze afterAll.
    freshPool?.end().catch(() => {});
    if (adminClient) {
      adminClient.query(`DROP DATABASE IF EXISTS "${freshDbName}" WITH (FORCE)`)
        .catch(() => {})
        .finally(() => adminClient.end().catch(() => {}));
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  }, 5_000);

  it('inline (nedeferrat) reușește integral, apoi V4 aduce coloana ALOP + tabela formular_attachments', async () => {
    // Import dinamic cu query string unic DUPĂ ce DATABASE_URL arată spre baza fresh —
    // bypass-uiește cache-ul de module (Vite/Vitest) ca `export const pool = new Pool(...)`
    // din db/index.mjs să se re-evalueze legat de noul DATABASE_URL, izolat de pool-ul
    // partajat cu restul suitei DB.
    const dbIndex = await import(/* @vite-ignore */ `../../db/index.mjs?fresh=${freshDbName}`);
    const migrateV4 = await import(/* @vite-ignore */ `../../db/migrate.mjs?fresh=${freshDbName}`);
    freshPool = dbIndex.pool;

    // Pas 1 — EXACT ce rulează server/index.mjs primul la boot: inline, fără nicio
    // pre-marcare/amânare. TREBUIE să reușească integral (fără ROLLBACK) — înainte de fix-ul
    // pentru 068, tocmai asta eșua (FK negardat spre formulare_oficiale inexistent).
    await dbIndex.initDbWithRetry();
    expect(dbIndex.DB_LAST_ERROR).toBeNull();

    const { rows: beforeV4 } = await freshPool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('alop_instances','formulare_oficiale','formular_attachments')`
    );
    expect(beforeV4.map(r => r.table_name).sort()).toEqual([]); // confirmă premisa: toate trei sunt V4-only pe fresh boot

    // Pre-marcăm V4 000-013 ca deja aplicate: reproduce REALITATEA istorică a producției
    // (organizations/users/flows au fost migrate ani în urmă, mult înainte ca inline și V4
    // să intre în conflict pe ele — CLAUDE.md documentează exact acest gap la `organizations.slug`,
    // ne-legat de fix-ul curent). Fără asta, 003_flows.sql eșuează pe `flows` (creat de inline
    // fără coloana `status` pe care V4 o presupune) și blochează bucla ÎNAINTE să ajungă la
    // 014/015 — tech-debt pre-existent, separat de 068/099, NU adresat aici.
    await freshPool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await freshPool.query(
      `INSERT INTO schema_migrations (id)
       SELECT unnest(ARRAY['000_extensions','001_organizations','002_users','003_flows','004_documents',
         '005_signing','006_forms','007_verification','008_audit','009_notifications',
         '010_archive','011_policies','012_outreach','013_forms_engine'])
       ON CONFLICT (id) DO NOTHING`
    );

    // Pas 2 — EXACT ce rulează server/index.mjs al doilea: V4 file-based, creează
    // alop_instances (014_alop.sql, cu coloana lichidare_valoare_factura inclusă) și
    // formulare_oficiale + formular_attachments (015_formulare_oficiale.sql).
    await migrateV4.runMigrations(freshPool);

    const { rows: col } = await freshPool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='alop_instances'
         AND column_name='lichidare_valoare_factura'`
    );
    expect(col.length).toBe(1);
    expect(col[0].data_type).toBe('numeric');

    const { rows: att } = await freshPool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='formular_attachments'`
    );
    expect(att.length).toBe(1);
  }, 30_000);
});

export default d;
