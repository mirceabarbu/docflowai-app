/**
 * server/modules/policies/evaluator.mjs — Policy rules evaluator.
 *
 * Fetches active policy_rules from DB for the given scope + org, then evaluates
 * each rule's condition against context. Reuses evaluateCondition from the
 * forms evaluator (same pure logic, different condition format: `op` vs `operator`).
 *
 * Policy rule_json format:
 * {
 *   "condition": { "field": "...", "op": "...", "value": ... },
 *   "effect":    "require" | "deny" | "warn",
 *   "target":    "signer_role:CFP" | "provider:qes" | ...  (optional)
 *   "message":   "Human-readable reason"
 * }
 */

import { pool }              from '../../db/index.mjs';
import { evaluateCondition } from '../forms/evaluator.mjs';

// Map symbol operators (policy format) to word operators (forms evaluator format)
const OP_MAP = {
  '>':  'gt',  '>=': 'gte',
  '<':  'lt',  '<=': 'lte',
  '=':  'eq',  '==': 'eq', '!=': 'neq', '<>': 'neq',
};

function _normalizeOp(op) {
  return OP_MAP[op] ?? op;
}

// ── evaluatePolicy ────────────────────────────────────────────────────────────

/**
 * Evaluates all active policy rules for the given scope and context.
 *
 * @param {string} scope      — 'flow' | 'signing' | 'form'
 * @param {object} context    — arbitrary data object matching rule field paths
 * @param {number} org_id     — organization ID (rules apply to this org + global rules)
 * @returns {Promise<{ allowed: boolean, requires: string[], messages: string[] }>}
 */
export async function evaluatePolicy(scope, context, org_id) {
  const { rows: rules } = await pool.query(
    `SELECT * FROM policy_rules
     WHERE (org_id=$1 OR org_id IS NULL)
       AND scope=$2
       AND is_active=TRUE
     ORDER BY priority DESC`,
    [org_id, scope]
  );

  const requires = [];
  const messages = [];
  let   denied   = false;

  for (const rule of rules) {
    const ruleJson = rule.rule_json ?? {};
    const cond     = ruleJson.condition;

    if (!cond) continue;

    // Map policy `op` → forms evaluator `operator`
    // Policy format uses symbols ('>','<','=') or words ('gt','lt','eq')
    const rawOp = cond.op ?? cond.operator ?? 'eq';
    const adapted = {
      field:    cond.field,
      operator: _normalizeOp(rawOp),
      value:    cond.value,
    };

    const conditionMet = evaluateCondition(adapted, context);
    if (!conditionMet) continue;

    const effect  = ruleJson.effect  ?? rule.effect  ?? 'warn';
    const target  = ruleJson.target  ?? rule.target  ?? null;
    const message = ruleJson.message ?? rule.message ?? rule.name ?? '';

    switch (effect) {
      case 'deny':
        denied = true;
        messages.push(message);
        break;
      case 'require':
        if (target && !requires.includes(target)) requires.push(target);
        if (message) messages.push(message);
        break;
      case 'warn':
        if (message) messages.push(message);
        break;
    }
  }

  return {
    allowed:  !denied,
    requires,
    messages,
  };
}
