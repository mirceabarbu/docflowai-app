/**
 * DocFlowAI — Script reparare rol admin
 * Rulare: node scripts/fix-admin.mjs
 * 
 * Setează role='admin' pentru admin@docflowai.ro și afișează toți adminii.
 * Necesită DATABASE_URL în variabilele de mediu (Railway îl setează automat).
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL nu este setat în variabilele de mediu.');
  console.error('   Pe Railway: railway run node scripts/fix-admin.mjs');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('🔗 Conectare la baza de date...');
  
  // 1. Arată starea curentă
  const { rows: before } = await pool.query(
    "SELECT id, email, nume, role FROM users WHERE email LIKE '%admin%' OR role='admin' ORDER BY id"
  );
  console.log('\n📋 Utilizatori admin/admin@ înainte de fix:');
  if (before.length === 0) {
    console.log('   (niciun utilizator găsit cu email admin@ sau role=admin)');
  } else {
    before.forEach(u => console.log(`   id=${u.id} | ${u.email} | ${u.nume} | role=${u.role}`));
  }

  // 2. Setează role='admin' pentru admin@docflowai.ro
  const { rows: fixed } = await pool.query(
    "UPDATE users SET role='admin' WHERE lower(email)='admin@docflowai.ro' RETURNING id, email, role"
  );
  
  if (fixed.length === 0) {
    console.log('\n⚠️  admin@docflowai.ro nu există în baza de date!');
    
    // Arată toți userii existenți
    const { rows: all } = await pool.query('SELECT id, email, role FROM users ORDER BY id LIMIT 20');
    console.log('\n📋 Toți utilizatorii din DB:');
    all.forEach(u => console.log(`   id=${u.id} | ${u.email} | role=${u.role}`));
    
    if (all.length === 0) {
      console.log('   (tabela users este goală — setează ADMIN_INIT_PASSWORD în Railway și repornește serverul)');
    }
  } else {
    console.log(`\n✅ Fix aplicat: ${fixed[0].email} → role='${fixed[0].role}'`);
  }

  // 3. Arată starea finală a tuturor adminilor
  const { rows: after } = await pool.query(
    "SELECT id, email, nume, role FROM users WHERE role='admin' ORDER BY id"
  );
  console.log('\n📋 Administratori după fix:');
  if (after.length === 0) {
    console.log('   ❌ Niciun administrator în baza de date!');
  } else {
    after.forEach(u => console.log(`   ✅ id=${u.id} | ${u.email} | ${u.nume} | role=${u.role}`));
  }

  console.log('\n🏁 Script terminat. Acum te poți loga cu admin@docflowai.ro.');
  
} catch(e) {
  console.error('❌ Eroare:', e.message);
} finally {
  await pool.end();
}
