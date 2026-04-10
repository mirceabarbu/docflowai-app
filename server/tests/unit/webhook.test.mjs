/**
 * server/tests/unit/webhook.test.mjs — Webhook dispatcher unit tests.
 *
 * Tests:
 *   ✓ fire() with valid webhook → POST sent with correct HMAC header
 *   ✓ fire() with invalid URL   → does not throw, logs error
 *   ✓ fire() with no webhooks   → skips silently
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { pool }   from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { fire }   from '../../services/webhook.mjs';
import crypto     from 'crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute the expected HMAC-SHA256 signature for a webhook body */
function expectedSig(body, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let globalFetch;

beforeEach(() => {
  vi.clearAllMocks();
  globalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = globalFetch;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fire() — valid webhook', () => {
  it('sends POST with HMAC-SHA256 X-DocFlow-Signature header', async () => {
    const ORG_ID     = 1;
    const EVENT_TYPE = 'flow.completed';
    const PAYLOAD    = { flowId: 'abc', status: 'completed' };
    const SECRET     = 'super-secret-webhook-key';
    const URL        = 'https://example.com/hooks/docflow';

    // Mock DB to return org with a webhook
    pool.query.mockResolvedValueOnce({
      rows: [{
        settings: { webhooks: [{ url: URL, secret: SECRET, events: ['flow.completed'] }] },
        webhook_url: null, webhook_secret: null, webhook_events: [], webhook_enabled: false,
      }],
    });

    // Capture what fetch was called with
    let capturedUrl, capturedOptions;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedUrl     = url;
      capturedOptions = options;
      return { ok: true, status: 200 };
    });

    await fire(ORG_ID, EVENT_TYPE, PAYLOAD);

    // Verify fetch was called once to the right URL
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(capturedUrl).toBe(URL);
    expect(capturedOptions.method).toBe('POST');

    // Verify HMAC signature
    const body = capturedOptions.body;
    const sig  = capturedOptions.headers['X-DocFlow-Signature'];
    expect(sig).toBe(expectedSig(body, SECRET));

    // Verify body shape
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe(EVENT_TYPE);
    expect(parsed.data).toEqual(PAYLOAD);
    expect(parsed.timestamp).toBeTruthy();
  });

  it('sends without signature header when no secret configured', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        settings: { webhooks: [{ url: 'https://example.com/hook', events: ['*'] }] },
        webhook_url: null, webhook_enabled: false,
      }],
    });

    let capturedHeaders;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedHeaders = options.headers;
      return { ok: true, status: 200 };
    });

    await fire(1, 'flow.started', { flowId: 'xyz' });

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(capturedHeaders['X-DocFlow-Signature']).toBeUndefined();
  });
});

describe('fire() — invalid URL (network error)', () => {
  it('does not throw, logs warning instead', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        settings: { webhooks: [{ url: 'https://unreachable.invalid/hook', events: ['*'] }] },
        webhook_url: null, webhook_enabled: false,
      }],
    });

    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fire(1, 'flow.started', {})).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not throw on timeout (AbortError)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        settings: { webhooks: [{ url: 'https://slow.example.com/hook', events: ['*'] }] },
        webhook_url: null, webhook_enabled: false,
      }],
    });

    const abortErr = new Error('The operation was aborted');
    abortErr.name  = 'AbortError';
    global.fetch   = vi.fn().mockRejectedValue(abortErr);

    await expect(fire(1, 'flow.completed', {})).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('fire() — no webhooks configured', () => {
  it('skips silently when settings.webhooks is empty', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        settings: { webhooks: [] },
        webhook_url: null, webhook_enabled: false,
      }],
    });

    global.fetch = vi.fn();

    await fire(1, 'flow.started', {});

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips silently when org_id is null', async () => {
    global.fetch = vi.fn();
    pool.query.mockResolvedValue({ rows: [] });

    await fire(null, 'flow.started', {});

    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('skips silently when org not found in DB', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    global.fetch = vi.fn();

    await fire(999, 'flow.started', {});

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses legacy webhook_url column when v4 settings.webhooks is absent', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        settings: {},
        webhook_url:     'https://legacy.example.com/hook',
        webhook_secret:  'legacy-secret',
        webhook_events:  ['flow.completed'],
        webhook_enabled: true,
      }],
    });

    let capturedUrl;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      capturedUrl = url;
      return { ok: true };
    });

    await fire(1, 'flow.completed', { flowId: 'abc' });

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(capturedUrl).toBe('https://legacy.example.com/hook');
  });
});
