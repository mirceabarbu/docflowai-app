import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Control DB_READY + pool.query prin mock hoisted (vi.mock e ridicat deasupra codului).
const h = vi.hoisted(() => ({ dbReady: true, queryMock: vi.fn() }));
vi.mock('../../db/index.mjs', () => ({
  pool: { query: h.queryMock },
  get DB_READY() { return h.dbReady; },
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  redactUrl: (u) => u,
}));

import { authenticateWsToken, isWsOriginAllowed } from '../../ws/auth.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

const sign = (payload) => jwt.sign(payload, JWT_SECRET);

// Rând „activ" din DB — corespunde payload-ului normal.
const dbRow = (o = {}) => ({
  id: 7, email: 'nou@x.ro', role: 'user', org_id: 12, token_version: 1, ...o,
});
const goodToken = (o = {}) => sign({ userId: 7, email: 'nou@x.ro', role: 'user', orgId: 12, tv: 1, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  h.dbReady = true;
});

describe('authenticateWsToken — refuzuri (fail-closed)', () => {
  it('#1 token cu requires2fa:true (pending_token 2FA) ⇒ null — G2', async () => {
    const token = sign({ userId: 7, email: 'nou@x.ro', tv: 1, requires2fa: true });
    const res = await authenticateWsToken(token);
    expect(res).toBeNull();
    expect(h.queryMock).not.toHaveBeenCalled();   // refuzat înainte de orice atingere DB
  });

  it('#2 token fără userId (payload de upload/signer) ⇒ null — G5', async () => {
    const token = sign({ flowId: 42, signerToken: 'abc', preHash: 'deadbeef' });
    const res = await authenticateWsToken(token);
    expect(res).toBeNull();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('#3 user cu deleted_at (0 rânduri) ⇒ null — G1a', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await authenticateWsToken(goodToken());
    expect(res).toBeNull();
  });

  it('#4 tv JWT=1 dar token_version DB=2 ⇒ null — G1b', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [dbRow({ token_version: 2 })] });
    const res = await authenticateWsToken(goodToken({ tv: 1 }));
    expect(res).toBeNull();
  });

  it('#6 DB_READY=false ⇒ null (fail-closed), fără query', async () => {
    h.dbReady = false;
    const res = await authenticateWsToken(goodToken());
    expect(res).toBeNull();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('token invalid criptografic ⇒ null', async () => {
    const res = await authenticateWsToken('not-a-jwt');
    expect(res).toBeNull();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('token gol/undefined ⇒ null', async () => {
    expect(await authenticateWsToken('')).toBeNull();
    expect(await authenticateWsToken(undefined)).toBeNull();
  });

  it('pool.query respinge ⇒ null (fail-closed)', async () => {
    h.queryMock.mockRejectedValueOnce(new Error('db down'));
    const res = await authenticateWsToken(goodToken());
    expect(res).toBeNull();
  });
});

describe('authenticateWsToken — succes', () => {
  it('#5 email vine din DB, NU din token', async () => {
    // token cu email VECHI; DB cu email NOU ⇒ rezultatul e cel din DB.
    h.queryMock.mockResolvedValueOnce({ rows: [dbRow({ email: 'nou@x.ro' })] });
    const token = sign({ userId: 7, email: 'VECHI@x.ro', role: 'user', orgId: 12, tv: 1 });
    const res = await authenticateWsToken(token);
    expect(res).toMatchObject({ userId: 7, email: 'nou@x.ro', role: 'user', orgId: 12, tv: 1 });
  });

  it('email din DB e lowercased', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [dbRow({ email: 'Nou@X.RO' })] });
    const res = await authenticateWsToken(goodToken());
    expect(res.email).toBe('nou@x.ro');
  });

  it('SQL: WHERE id=$1 + deleted_at IS NULL, param = userId', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [dbRow()] });
    await authenticateWsToken(goodToken());
    const [sql, params] = h.queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(params).toEqual([7]);
  });
});

describe('isWsOriginAllowed', () => {
  it('#7 origine externă absentă din listă ⇒ false', () => {
    expect(isWsOriginAllowed('https://evil.ro', ['https://app.docflowai.ro'])).toBe(false);
  });

  it('origine prezentă în listă ⇒ true', () => {
    expect(isWsOriginAllowed('https://app.docflowai.ro', ['https://app.docflowai.ro'])).toBe(true);
  });

  it('#8 fără Origin (client non-browser) ⇒ true', () => {
    expect(isWsOriginAllowed(undefined, ['https://app.docflowai.ro'])).toBe(true);
    expect(isWsOriginAllowed('', ['https://app.docflowai.ro'])).toBe(true);
  });

  it('#9 allowed=false (CORS blocat) ⇒ false pentru orice origine', () => {
    expect(isWsOriginAllowed('https://app.docflowai.ro', false)).toBe(false);
  });

  it('allowed non-array (defensiv) ⇒ false', () => {
    expect(isWsOriginAllowed('https://app.docflowai.ro', 'https://app.docflowai.ro')).toBe(false);
  });
});
