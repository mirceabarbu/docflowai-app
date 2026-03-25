/**
 * DocFlowAI — Script reparare rol admin
 *
 * Utilizare:
 *   node scripts/fix-admin.mjs                        # fix admin@docflowai.ro (default)
 *   node scripts/fix-admin.mjs user@institutie.ro     # fix email specificat
 *   node scripts/fix-admin.mjs --list                 # afișează toți adminii fără modificări
 *
 * Pe Railway:
 *   railway run node scripts/fix-admin.mjs
 *   railway run node scripts/fix-admin.mjs user@institutie.ro
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL nu este setat în variabilele de mediu.');
  console.error('   Pe Railway: railway run node scripts/fix-admin.mjs');
  process.exit(1);
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const targetEmail = args.find(a => a.includes('@')) || 'admin@docflowai.ro';

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let exitCode = 0;

try {
  console.log('🔗 Conectare la baza de date...');
  await pool.query('SELECT 1'); // test conexiune
  console.log('✅ Conectat.\n');

  // ── Mod --list ──────────────────────────────────────────────────────────────
  if (listOnly) {
    const { rows } = await pool.query(
      "SELECT id, email, nume, role, org_id FROM users WHERE role IN ('admin','org_admin') ORDER BY role, id"
    );
    console.log(`📋 Administratori în DB (${rows.length}):`);
    if (rows.length === 0) {
      console.log('   ❌ Niciun administrator găsit!');
      exitCode = 1;
    } else {
      rows.forEach(u =>
        console.log(`   [${u.role.padEnd(9)}] id=${String(u.id).padEnd(4)} | ${u.email} | ${u.nume || '—'}`)
      );
    }
    process.exit(exitCode);
  }

  // ── Fix rol ─────────────────────────────────────────────────────────────────
  console.log(`🎯 Target: ${targetEmail}`);

  // 1. Verificam ca userul exista
  const { rows: found } = await pool.query(
    'SELECT id, email, nume, role FROM users WHERE lower(email) = lower($1)',
    [targetEmail]
  );

  if (found.length === 0) {
    console.error(`❌ Utilizatorul "${targetEmail}" nu există în baza de date!`);
    console.log('\n📋 Utilizatori existenți (primii 20):');
    const { rows: all } = await pool.query(
      'SELECT id, email, role FROM users ORDER BY id LIMIT 20'
    );
    if (all.length === 0) {
      console.log('   (tabela users este goală — setează ADMIN_INIT_PASSWORD și repornește serverul)');
    } else {
      all.forEach(u => console.log(`   id=${u.id} | ${u.email} | role=${u.role}`));
    }
    exitCode = 1;
    process.exit(exitCode);
  }

  const before = found[0];
  console.log(`📋 Stare curentă: id=${before.id} | ${before.email} | role=${before.role}`);

  if (before.role === 'admin') {
    console.log('✅ Utilizatorul are deja role=admin. Nicio modificare necesară.');
    process.exit(0);
  }

  // 2. Aplicam fix
  const { rows: fixed } = await pool.query(
    "UPDATE users SET role='admin' WHERE lower(email) = lower($1) RETURNING id, email, role, nume",
    [targetEmail]
  );

  if (fixed.length === 0) {
    console.error('❌ UPDATE nu a afectat niciun rând — situație neașteptată.');
    exitCode = 1;
  } else {
    console.log(`✅ Fix aplicat: ${fixed[0].email} → role='${fixed[0].role}'`);
    console.log('\n🏁 Acum te poți loga cu acest cont.');
  }

  // 3. Stare finala administratori
  const { rows: admins } = await pool.query(
    "SELECT id, email, nume, role FROM users WHERE role IN ('admin','org_admin') ORDER BY role, id"
  );
  console.log(`\n📋 Administratori după fix (${admins.length}):`);
  admins.forEach(u =>
    console.log(`   [${u.role.padEnd(9)}] id=${u.id} | ${u.email} | ${u.nume || '—'}`)
  );

} catch(e) {
  console.error('❌ Eroare:', e.message);
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  process.exit(exitCode);
}
