/**
 * #137 — notificări duplicate la semnarea în masă (cursă paralelă pe dedup).
 *
 * insertNotificationOnce (notify-dedup.mjs) trebuie să serializeze inserările
 * concurente pe (email, flowId, type) via pg_advisory_xact_lock, în ACEEAȘI
 * tranzacție cu re-verificarea + INSERT-ul. Testul ⭐⭐ reproduce direct cursa
 * măsurată în producție (5 apeluri paralele → 1 singur rând).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { hasTestDb, migrate, pool } from '../helpers/db-real.mjs';
import { insertNotificationOnce } from '../../services/notify-dedup.mjs';

const EMAIL = 'notif-dedup-137@test.local';

async function cleanup() {
  await pool.query('DELETE FROM notifications WHERE user_email = $1', [EMAIL]);
}

const d = describe.skipIf(!hasTestDb())('insertNotificationOnce — poarta atomică (#137)', () => {
  beforeAll(async () => {
    await migrate();
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(() => pool.end());

  it('⭐⭐ 5 apeluri PARALELE pe același (email, flowId, type) → EXACT 1 rând', async () => {
    const flowId = 'flow-137-race';
    const results = await Promise.all(
      Array.from({ length: 5 }, () => insertNotificationOnce(pool, {
        email: EMAIL, flowId, type: 'YOUR_TURN',
        title: 'Document de semnat', message: 'test',
        dedupWindow: '2 minutes',
      }))
    );
    const insertedCount = results.filter(r => r.inserted).length;
    expect(insertedCount).toBe(1);

    const { rows } = await pool.query(
      'SELECT id FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type=$3',
      [EMAIL, flowId, 'YOUR_TURN']
    );
    expect(rows.length).toBe(1);
  });

  it('⭐ REMINDER (dedupWindow: null) NU se blochează — 2 apeluri → 2 rânduri', async () => {
    const flowId = 'flow-137-reminder';
    const results = await Promise.all([
      insertNotificationOnce(pool, { email: EMAIL, flowId, type: 'REMINDER', title: 'Reminder', message: 'test', dedupWindow: null }),
      insertNotificationOnce(pool, { email: EMAIL, flowId, type: 'REMINDER', title: 'Reminder', message: 'test', dedupWindow: null }),
    ]);
    expect(results.every(r => r.inserted)).toBe(true);

    const { rows } = await pool.query(
      'SELECT id FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type=$3',
      [EMAIL, flowId, 'REMINDER']
    );
    expect(rows.length).toBe(2);
  });

  it('secvențial în fereastră → al doilea inserted:false, 1 rând', async () => {
    const flowId = 'flow-137-sequential';
    const first = await insertNotificationOnce(pool, { email: EMAIL, flowId, type: 'YOUR_TURN', title: 't', message: 'm', dedupWindow: '2 minutes' });
    const second = await insertNotificationOnce(pool, { email: EMAIL, flowId, type: 'YOUR_TURN', title: 't', message: 'm', dedupWindow: '2 minutes' });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const { rows } = await pool.query(
      'SELECT id FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type=$3',
      [EMAIL, flowId, 'YOUR_TURN']
    );
    expect(rows.length).toBe(1);
  });

  it('email diferit, același flux → 2 rânduri', async () => {
    const flowId = 'flow-137-diff-email';
    const otherEmail = 'notif-dedup-137-other@test.local';
    await insertNotificationOnce(pool, { email: EMAIL, flowId, type: 'YOUR_TURN', title: 't', message: 'm', dedupWindow: '2 minutes' });
    await insertNotificationOnce(pool, { email: otherEmail, flowId, type: 'YOUR_TURN', title: 't', message: 'm', dedupWindow: '2 minutes' });

    const { rows } = await pool.query(
      'SELECT id FROM notifications WHERE flow_id=$1 AND type=$2',
      [flowId, 'YOUR_TURN']
    );
    expect(rows.length).toBe(2);
    await pool.query('DELETE FROM notifications WHERE user_email = $1', [otherEmail]);
  });

  it('flowId diferit → 2 rânduri', async () => {
    const r1 = await insertNotificationOnce(pool, { email: EMAIL, flowId: 'flow-137-a', type: 'YOUR_TURN', title: 't', message: 'm', dedupWindow: '2 minutes' });
    const r2 = await insertNotificationOnce(pool, { email: EMAIL, flowId: 'flow-137-b', type: 'YOUR_TURN', title: 't', message: 'm', dedupWindow: '2 minutes' });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);

    const { rows } = await pool.query(
      'SELECT id FROM notifications WHERE user_email=$1 AND type=$2 AND flow_id IN ($3,$4)',
      [EMAIL, 'YOUR_TURN', 'flow-137-a', 'flow-137-b']
    );
    expect(rows.length).toBe(2);
  });

  it('flowId: null → inserează normal, fără lacăt', async () => {
    const r = await insertNotificationOnce(pool, { email: EMAIL, flowId: null, type: 'SYSTEM', title: 't', message: 'm', dedupWindow: null });
    expect(r.inserted).toBe(true);

    const { rows } = await pool.query(
      'SELECT id FROM notifications WHERE user_email=$1 AND type=$2 AND flow_id IS NULL',
      [EMAIL, 'SYSTEM']
    );
    expect(rows.length).toBe(1);
  });

  it('fără scurgeri de conexiuni — idle in transaction = 0', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction'`
    );
    expect(rows[0].n).toBe(0);
  });
});

export default d;
