/**
 * notify-dedup.mjs — inserarea ATOMICĂ a unei notificări in-app.
 *
 * De ce există: garda cu fereastră din notify() (index.mjs) face SELECT, apoi
 * INSERT, fără tranzacție. Două polluri concurente (semnare în masă) trec
 * amândouă de SELECT și inserează amândouă — măsurat în producție 21.08.2026,
 * la 86-283 ms distanță, până la 3 rânduri pe același flux.
 *
 * Soluția: pg_advisory_xact_lock pe (email, flowId, type) + re-verificare +
 * INSERT, toate în ACEEAȘI tranzacție. Al doilea apelant așteaptă la lacăt,
 * apoi vede rândul primului și se retrage.
 *
 * ⚠️ DEPINDE DE READ COMMITTED (implicit în Postgres). Sub READ COMMITTED
 * fiecare instrucțiune ia un snapshot NOU, iar SELECT-ul de re-verificare
 * rulează DUPĂ eliberarea lacătului ⇒ vede rândul comis de câștigător. Sub
 * REPEATABLE READ n-ar vedea nimic și garda ar fi inutilă, TĂCUT.
 * NU schimba nivelul de izolare al acestei tranzacții.
 */
export async function insertNotificationOnce(pool, {
  email, flowId, type, title, message, urgent = false, dedupWindow = null,
}) {
  if (!flowId || !dedupWindow) {
    const r = await pool.query(
      'INSERT INTO notifications (user_email,flow_id,type,title,message,urgent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, flowId || null, type, title, message, !!urgent]
    );
    return { inserted: true, id: r.rows[0]?.id };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`notif:${email}:${flowId}:${type}`]);

    const { rows: dup } = await client.query(
      `SELECT 1 FROM notifications
        WHERE user_email=$1 AND flow_id=$2 AND type=$3
          AND created_at > NOW() - $4::interval
        LIMIT 1`,
      [email, flowId, type, dedupWindow]
    );
    if (dup.length) {
      await client.query('COMMIT');
      return { inserted: false, reason: 'duplicate' };
    }

    const r = await client.query(
      'INSERT INTO notifications (user_email,flow_id,type,title,message,urgent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, flowId, type, title, message, !!urgent]
    );
    await client.query('COMMIT');
    return { inserted: true, id: r.rows[0]?.id };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
