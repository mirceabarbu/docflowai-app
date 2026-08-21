/**
 * #138 — Poarta de stări ALOP în modul BLOCARE (migrarea 109: RAISE EXCEPTION).
 *
 * Exercită trigger-ul REAL (`trg_alop_status_guard`) pe Postgres real. Complementul
 * lui `alop-state-gate.test.mjs`, care acoperă auditul + matricea; aici dovedim că
 * poarta CHIAR blochează, și — la fel de important — că NU blochează căile legitime.
 *
 * ⛔ NU redeclara matricea în JS ca sursă de adevăr: ea trăiește DOAR în SQL (109).
 * Listele de mai jos generează cazuri, nu validează logica.
 *
 * Cazurile ⭐ (plata→ordonantare, completed→lichidare) apără PRODUSUL, nu fixul: dacă
 * pică, ai rupt reparația admin-cancel (#113), respectiv ciclul multi-ORD.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedAlop, getAlop } from '../helpers/db-real.mjs';

const d = describe.skipIf(!hasTestDb());

// alop_status_log NU are FK spre alop_instances → TRUNCATE ... CASCADE nu-l atinge.
async function clearLog() { await pool.query('TRUNCATE alop_status_log RESTART IDENTITY'); }
async function logFor(id) {
  const { rows } = await pool.query('SELECT * FROM alop_status_log WHERE alop_id=$1 ORDER BY id', [id]);
  return rows;
}

// Matricea reală din 109 (identică cu 103). Aici DOAR pentru generarea cazurilor.
const VALID = [
  ['draft', 'angajare'], ['draft', 'lichidare'], ['draft', 'cancelled'],
  ['angajare', 'lichidare'], ['angajare', 'plata'], ['angajare', 'cancelled'],
  ['lichidare', 'ordonantare'], ['lichidare', 'cancelled'],
  ['ordonantare', 'plata'], ['ordonantare', 'cancelled'],
  ['plata', 'completed'], ['plata', 'cancelled'],
];

d('#138 — poarta ALOP blochează (migrarea 109)', () => {
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await clearLog(); await seedOrgUser({ role: 'user' }); });
  afterAll(() => pool.end());

  // 7 — poarta e CHIAR activă după migrări. Prinde capcana de ordonare a migrărilor:
  // dacă 094/103 ar re-suprascrie funcția în faza 3 din migrateForTests, testul ăsta pică
  // în loc să treacă tăcut cu o poartă în modul observare.
  it('funcția alop_status_guard conține RAISE EXCEPTION (poarta e în modul blocare)', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'alop_status_guard' AND n.nspname = 'public'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].def).toMatch(/RAISE EXCEPTION/);
    // Ramura de violare NU mai scrie în log (excepția ar aborta oricum tranzacția).
    expect(rows[0].def).not.toMatch(/INSERT INTO alop_status_log/i);
  });

  // 1 — tranziție invalidă ⇒ ARUNCĂ, iar rândul rămâne NESCHIMBAT.
  it('lichidare → plata (invalidă) ARUNCĂ, iar rândul rămâne în lichidare', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' });
    await expect(
      pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['plata', id])
    ).rejects.toThrow(/ALOP transition violation: lichidare -> plata/);
    expect((await getAlop(id)).status).toBe('lichidare');
  });

  // 2 — nu se mai scrie NIMIC în log: excepția a abortat tranzacția, deci nici
  // trigger-ul de audit (093, AFTER UPDATE) nu a apucat să insereze.
  it('după o tranziție respinsă, alop_status_log NU are niciun rând nou', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' });
    await expect(
      pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['plata', id])
    ).rejects.toThrow();
    expect(await logFor(id)).toEqual([]);
  });

  // ⭐ 3 — calea admin-cancel (#113), legalizată de 103. Dacă pică, ai rupt reparația
  // fluxurilor ORD neconforme în producție.
  it('⭐ plata → ordonantare TRECE (calea admin-cancel #113)', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['ordonantare', id]);
    expect((await getAlop(id)).status).toBe('ordonantare');
    const rows = await logFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0].violation).toBe(false);
  });

  // ⭐ 4 — ciclul „nouă lichidare" (ALOP cu mai multe ordonanțări). Dacă pică, ai blocat
  // comportamentul normal multi-ciclu.
  it('⭐ completed → lichidare TRECE (ciclul noua-lichidare, multi-ORD)', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['lichidare', id]);
    expect((await getAlop(id)).status).toBe('lichidare');
    const rows = await logFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0].violation).toBe(false);
  });

  // 5 — restul tranzițiilor valide trec, fiecare cu exact 1 rând de audit.
  it.each(VALID)('tranziție validă %s → %s: trece, 1 rând audit fără violare', async (from, to) => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: from });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', [to, id]);
    expect((await getAlop(id)).status).toBe(to);
    const rows = await logFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0].violation).toBe(false);
  });

  // 5b — cancelled e stare terminală: NICIO ieșire nu mai e permisă.
  it.each([['draft'], ['angajare'], ['lichidare'], ['completed']])(
    'cancelled → %s ARUNCĂ (stare terminală)', async (to) => {
      const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'cancelled' });
      await expect(
        pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', [to, id])
      ).rejects.toThrow(/ALOP transition violation/);
      expect((await getAlop(id)).status).toBe('cancelled');
    }
  );

  // 5c — sărituri inventate, respinse una câte una (dovedesc că poarta n-a fost slăbită).
  it.each([
    ['draft', 'completed'], ['plata', 'draft'], ['ordonantare', 'lichidare'],
    ['lichidare', 'angajare'], ['completed', 'cancelled'],
  ])('tranziție invalidă %s → %s ARUNCĂ', async (from, to) => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: from });
    await expect(
      pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', [to, id])
    ).rejects.toThrow(/ALOP transition violation/);
    expect((await getAlop(id)).status).toBe(from);
  });

  // 6 — no-op (NEW.status = OLD.status) ⇒ trece, fără excepție și fără rând în log.
  it('no-op (status neschimbat) trece, fără excepție și fără rând în log', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    await pool.query("UPDATE alop_instances SET status='ordonantare', titlu='B' WHERE id=$1", [id]);
    expect((await getAlop(id)).status).toBe('ordonantare');
    expect(await logFor(id)).toEqual([]);
  });
});
