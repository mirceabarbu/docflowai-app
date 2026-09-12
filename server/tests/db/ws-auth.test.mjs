/**
 * SEC-100: authenticateWsToken pe Postgres REAL — dovedește fail-closed la revocare.
 *
 * Rulează funcția reală de autentificare WS peste un user seeded prin helperii existenți
 * (seedOrgUser), cu token semnat cu `tv` real. Verifică:
 *  (10) user activ + token valid ⇒ identitate validă (email din DB);
 *  (11) deleted_at setat ⇒ ACELAȘI token ⇒ null (cont dezactivat);
 *  (12) token_version incrementat ⇒ ACELAȘI token ⇒ null (sesiune revocată).
 *
 * #199 Etapa C — poarta #182 (force_password_change) reutilizată pe WS (G6):
 *  (13) force_password_change=true ⇒ null (WS refuzat, la fel ca HTTP 403);
 *  (14) anti-regresie: user normal, token valid ⇒ reușește (neatins de G6);
 *  (15) anti-regresie: token_version nepotrivit rămâne refuzat (G1b neatins de G6);
 *  (16) force_password_change=false explicit ⇒ reușește (nu o comparație greșită pe NULL).
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser } from '../helpers/db-real.mjs';

// Mock ortogonal (NU db) — reduce zgomotul de log; db/index.mjs rămâne REAL.
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  redactUrl: (u) => u,
}));

const { authenticateWsToken } = await import('../../ws/auth.mjs');
const { JWT_SECRET } = await import('../../middleware/auth.mjs');

const d = describe.skipIf(!hasTestDb())('SEC-100 authenticateWsToken (Postgres real)', () => {
  beforeAll(migrate);
  beforeEach(truncateAll);

  async function seedActive(email = 'ws@x.ro') {
    const { orgId, userId } = await seedOrgUser({ email, role: 'user' });
    const { rows } = await pool.query('SELECT token_version FROM users WHERE id=$1', [userId]);
    const tv = rows[0].token_version;
    const token = jwt.sign({ userId, email: 'STALE@x.ro', role: 'user', orgId, tv }, JWT_SECRET, { expiresIn: '1h' });
    return { orgId, userId, tv, token };
  }

  it('#10 user activ + token valid ⇒ identitate validă (email din DB)', async () => {
    const { userId, orgId, token } = await seedActive('ws@x.ro');
    const res = await authenticateWsToken(token);
    expect(res).toMatchObject({ userId, email: 'ws@x.ro', role: 'user', orgId });
    // email din DB, nu 'STALE@x.ro' din token
    expect(res.email).toBe('ws@x.ro');
  });

  it('#11 deleted_at setat ⇒ același token ⇒ null', async () => {
    const { userId, token } = await seedActive('ws@x.ro');
    await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [userId]);
    expect(await authenticateWsToken(token)).toBeNull();
  });

  it('#12 token_version incrementat ⇒ același token ⇒ null', async () => {
    const { userId, token } = await seedActive('ws@x.ro');
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [userId]);
    expect(await authenticateWsToken(token)).toBeNull();
  });

  it('#13 force_password_change=true ⇒ null (poarta #182 pe WS)', async () => {
    const { userId, token } = await seedActive('ws-fpc@x.ro');
    await pool.query('UPDATE users SET force_password_change=TRUE WHERE id=$1', [userId]);
    expect(await authenticateWsToken(token)).toBeNull();
  });

  it('#14 anti-regresie: user normal, token valid ⇒ reușește (neatins de G6)', async () => {
    const { userId, orgId, token } = await seedActive('ws-ok@x.ro');
    const res = await authenticateWsToken(token);
    expect(res).toMatchObject({ userId, email: 'ws-ok@x.ro', role: 'user', orgId });
  });

  it('#15 anti-regresie: token_version nepotrivit rămâne refuzat (G1b neatins de G6)', async () => {
    const { userId, token } = await seedActive('ws-g1b@x.ro');
    await pool.query('UPDATE users SET token_version = token_version + 1, force_password_change=FALSE WHERE id=$1', [userId]);
    expect(await authenticateWsToken(token)).toBeNull();
  });

  it('#16 force_password_change=false explicit ⇒ reușește (nu o comparație greșită pe NULL)', async () => {
    const { userId, token } = await seedActive('ws-fpc-false@x.ro');
    await pool.query('UPDATE users SET force_password_change=FALSE WHERE id=$1', [userId]);
    expect(await authenticateWsToken(token)).not.toBeNull();
  });
});

export default d;
