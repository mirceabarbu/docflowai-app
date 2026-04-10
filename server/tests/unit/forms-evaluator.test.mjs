/**
 * server/tests/unit/forms-evaluator.test.mjs — Pure logic tests for forms evaluator.
 * No mocks needed — all functions are stateless.
 */

import { describe, it, expect } from 'vitest';
import {
  getNestedValue,
  evaluateCondition,
  evaluateRules,
  validateFormData,
} from '../../modules/forms/evaluator.mjs';

// ── getNestedValue ─────────────────────────────────────────────────────────────

describe('getNestedValue', () => {
  it('reads top-level key', () => {
    expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
  });

  it('reads nested key via dot notation', () => {
    expect(getNestedValue({ sectionA: { valoare: 1000 } }, 'sectionA.valoare')).toBe(1000);
  });

  it('returns undefined for missing path', () => {
    expect(getNestedValue({ a: 1 }, 'b.c')).toBeUndefined();
  });

  it('returns undefined for null object', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
  });
});

// ── evaluateCondition ──────────────────────────────────────────────────────────

describe('evaluateCondition', () => {
  const data = {
    status: 'approved',
    amount: 5000,
    tags:   ['urgent', 'finance'],
    note:   '',
  };

  it('eq operator — match', () => {
    expect(evaluateCondition({ field: 'status', operator: 'eq', value: 'approved' }, data)).toBe(true);
  });

  it('eq operator — no match', () => {
    expect(evaluateCondition({ field: 'status', operator: 'eq', value: 'draft' }, data)).toBe(false);
  });

  it('gt operator', () => {
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 1000 }, data)).toBe(true);
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 9999 }, data)).toBe(false);
  });

  it('in operator', () => {
    expect(evaluateCondition({ field: 'status', operator: 'in', value: ['approved', 'completed'] }, data)).toBe(true);
    expect(evaluateCondition({ field: 'status', operator: 'in', value: ['draft', 'cancelled'] }, data)).toBe(false);
  });

  it('empty operator', () => {
    expect(evaluateCondition({ field: 'note', operator: 'empty', value: null }, data)).toBe(true);
    expect(evaluateCondition({ field: 'status', operator: 'empty', value: null }, data)).toBe(false);
  });

  it('not_empty operator', () => {
    expect(evaluateCondition({ field: 'status', operator: 'not_empty', value: null }, data)).toBe(true);
    expect(evaluateCondition({ field: 'note', operator: 'not_empty', value: null }, data)).toBe(false);
  });

  it('contains operator', () => {
    expect(evaluateCondition({ field: 'status', operator: 'contains', value: 'prov' }, data)).toBe(true);
    expect(evaluateCondition({ field: 'status', operator: 'contains', value: 'xyz' }, data)).toBe(false);
  });

  it('unknown operator returns false', () => {
    expect(evaluateCondition({ field: 'status', operator: 'unknown_op', value: 'x' }, data)).toBe(false);
  });
});

// ── evaluateRules ──────────────────────────────────────────────────────────────

describe('evaluateRules', () => {
  it('returns empty sets for empty rules array', () => {
    const result = evaluateRules([], {});
    expect(result.hidden.size).toBe(0);
    expect(result.required.size).toBe(0);
    expect(Object.keys(result.computed)).toHaveLength(0);
  });

  it('hide action adds field to hidden set', () => {
    const rules = [{
      id: 'r1',
      condition: { field: 'type', operator: 'eq', value: 'simple' },
      action:    { type: 'hide', field: 'advancedField' },
    }];
    const { hidden } = evaluateRules(rules, { type: 'simple' });
    expect(hidden.has('advancedField')).toBe(true);
  });

  it('require action adds field to required set', () => {
    const rules = [{
      id: 'r2',
      condition: { field: 'serviciiConforme', operator: 'eq', value: false },
      action:    { type: 'require', field: 'observatii' },
    }];
    const { required } = evaluateRules(rules, { serviciiConforme: false });
    expect(required.has('observatii')).toBe(true);
  });

  it('set_value action populates computed map', () => {
    const rules = [{
      id: 'r3',
      condition: { field: 'category', operator: 'eq', value: 'special' },
      action:    { type: 'set_value', field: 'priority', value: 'high' },
    }];
    const { computed } = evaluateRules(rules, { category: 'special' });
    expect(computed.priority).toBe('high');
  });

  it('rule with unmet condition does not fire', () => {
    const rules = [{
      id: 'r4',
      condition: { field: 'amount', operator: 'gt', value: 10000 },
      action:    { type: 'require', field: 'approval' },
    }];
    const { required } = evaluateRules(rules, { amount: 500 });
    expect(required.has('approval')).toBe(false);
  });
});

// ── validateFormData ───────────────────────────────────────────────────────────

describe('validateFormData', () => {
  const schema = {
    fields: [
      { name: 'institutie', label: 'Instituția',   type: 'text',   required: true  },
      { name: 'valoare',    label: 'Valoarea',     type: 'number', required: true  },
      { name: 'observatii', label: 'Observații',   type: 'text',   required: false },
    ],
  };

  it('valid data returns { valid: true, errors: {} }', () => {
    const result = validateFormData({ institutie: 'Primăria X', valoare: '1000' }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('missing required field returns error', () => {
    const result = validateFormData({ valoare: '500' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.institutie).toBeTruthy();
  });

  it('invalid number returns error', () => {
    const result = validateFormData({ institutie: 'X', valoare: 'abc' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.valoare).toBeTruthy();
  });

  it('hidden field is not validated even when required', () => {
    const rules = [{
      id: 'hide-institutie',
      condition: { field: 'tip', operator: 'eq', value: 'hidden' },
      action:    { type: 'hide', field: 'institutie' },
    }];
    const result = validateFormData({ tip: 'hidden', valoare: '100' }, schema, rules);
    // institutie is hidden → not required → no error
    expect(result.valid).toBe(true);
  });

  it('extra required field from rule is enforced', () => {
    const rules = [{
      id: 'require-obs',
      condition: { field: 'valoare', operator: 'gt', value: 10000 },
      action:    { type: 'require', field: 'observatii' },
    }];
    const result = validateFormData({ institutie: 'X', valoare: '50000' }, schema, rules);
    expect(result.valid).toBe(false);
    expect(result.errors.observatii).toBeTruthy();
  });
});
