/**
 * server/tests/unit/policies.test.mjs — Policy evaluator unit tests.
 *
 * Mocks pool.query to control which policy rules are returned from DB.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── Mock pool ─────────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  requestLogger: (_req, _res, next) => next(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { pool }            from '../../db/index.mjs';
import { evaluatePolicy }  from '../../modules/policies/evaluator.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID = 1;

function makeRuleRow(overrides) {
  return {
    id:         'rule-uuid-1',
    org_id:     null,
    scope:      'flow',
    code:       'test.rule',
    name:       'Test Rule',
    is_active:  true,
    priority:   50,
    rule_json:  {},
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluatePolicy — allow when condition not met', () => {
  it('returns allowed=true when no rules match', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRuleRow({
          rule_json: {
            condition: { field: 'signers_count', op: '>', value: 10 },
            effect:    'deny',
            message:   'Too many signers',
          },
        }),
      ],
    });

    // signers_count=3 does NOT trigger > 10
    const result = await evaluatePolicy('flow', { signers_count: 3 }, ORG_ID);

    expect(result.allowed).toBe(true);
    expect(result.requires).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
  });

  it('returns allowed=true with empty policy list', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await evaluatePolicy('flow', { signers_count: 50 }, ORG_ID);

    expect(result.allowed).toBe(true);
    expect(result.requires).toHaveLength(0);
  });
});

describe('evaluatePolicy — deny when signers_count > 10', () => {
  it('returns allowed=false when signers_count exceeds limit', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRuleRow({
          rule_json: {
            condition: { field: 'signers_count', op: '>', value: 10 },
            effect:    'deny',
            message:   'Maximum 10 semnatari per flux',
          },
        }),
      ],
    });

    const result = await evaluatePolicy('flow', { signers_count: 11 }, ORG_ID);

    expect(result.allowed).toBe(false);
    expect(result.messages).toContain('Maximum 10 semnatari per flux');
  });

  it('boundary: signers_count=10 is NOT denied (> not >=)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRuleRow({
          rule_json: {
            condition: { field: 'signers_count', op: '>', value: 10 },
            effect:    'deny',
            message:   'Too many',
          },
        }),
      ],
    });

    const result = await evaluatePolicy('flow', { signers_count: 10 }, ORG_ID);

    expect(result.allowed).toBe(true);
  });
});

describe('evaluatePolicy — require signer_role when value > 50000', () => {
  it('returns require target when form valoare exceeds threshold', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRuleRow({
          scope:    'form',
          rule_json: {
            condition: { field: 'sectionA.valoareAngajata', op: '>', value: 50000 },
            effect:    'require',
            target:    'signer_role:AVIZ_FINANCIAR_SUPLIMENTAR',
            message:   'Valori mari necesită aviz suplimentar',
          },
        }),
      ],
    });

    const result = await evaluatePolicy('form', {
      sectionA: { valoareAngajata: 75000 },
    }, ORG_ID);

    expect(result.allowed).toBe(true);   // require, not deny
    expect(result.requires).toContain('signer_role:AVIZ_FINANCIAR_SUPLIMENTAR');
    expect(result.messages).toContain('Valori mari necesită aviz suplimentar');
  });

  it('does NOT require when value is below threshold', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRuleRow({
          scope:    'form',
          rule_json: {
            condition: { field: 'sectionA.valoareAngajata', op: '>', value: 50000 },
            effect:    'require',
            target:    'signer_role:AVIZ_FINANCIAR_SUPLIMENTAR',
            message:   'Valori mari necesită aviz suplimentar',
          },
        }),
      ],
    });

    const result = await evaluatePolicy('form', {
      sectionA: { valoareAngajata: 1000 },
    }, ORG_ID);

    expect(result.allowed).toBe(true);
    expect(result.requires).toHaveLength(0);
  });

  it('handles multiple rules — one deny + one require', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRuleRow({
          id:       'r1',
          priority: 100,
          rule_json: {
            condition: { field: 'signers_count', op: '>', value: 10 },
            effect:    'deny',
            message:   'Too many signers',
          },
        }),
        makeRuleRow({
          id:       'r2',
          priority: 50,
          rule_json: {
            condition: { field: 'amount', op: '>', value: 50000 },
            effect:    'require',
            target:    'signer_role:CFP',
            message:   'High amount requires CFP',
          },
        }),
      ],
    });

    const result = await evaluatePolicy('flow', {
      signers_count: 15,
      amount:        60000,
    }, ORG_ID);

    expect(result.allowed).toBe(false);
    expect(result.requires).toContain('signer_role:CFP');
    expect(result.messages).toHaveLength(2);
  });
});
