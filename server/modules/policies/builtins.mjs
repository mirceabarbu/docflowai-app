/**
 * server/modules/policies/builtins.mjs — Seed global built-in policy rules.
 *
 * Idempotent: skips if a rule with the same code already exists.
 */

import { pool }   from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';

const BUILTIN_POLICIES = [
  {
    code:        'flow.max_signers',
    scope:       'flow',
    name:        'Maximum semnatari per flux',
    description: 'Limitează numărul maxim de semnatari la 10 per flux.',
    priority:    100,
    rule_json: {
      condition: { field: 'signers_count', op: '>', value: 10 },
      effect:    'deny',
      message:   'Maximum 10 semnatari per flux',
    },
  },
  {
    code:        'signing.qes_for_official',
    scope:       'signing',
    name:        'QES obligatoriu pentru documente oficiale',
    description: 'Documentele cu tip "oficial" necesită semnătură calificată (QES).',
    priority:    90,
    rule_json: {
      condition: { field: 'flow.doc_type', op: '=', value: 'oficial' },
      effect:    'require',
      target:    'provider:qes',
      message:   'Documentele oficiale necesită semnătură QES',
    },
  },
  {
    code:        'form.alop.cfp_required',
    scope:       'form',
    name:        'ALOP necesită viză CFP',
    description: 'Formularul ALOP-2024 necesită vizarea Controlului Financiar Preventiv (CFP).',
    priority:    80,
    rule_json: {
      condition: { field: 'form.code', op: '=', value: 'ALOP-2024' },
      effect:    'require',
      target:    'signer_role:CFP',
      message:   'ALOP necesită viză CFP obligatorie',
    },
  },
];

export async function seedBuiltinPolicies() {
  let seeded = 0;

  for (const policy of BUILTIN_POLICIES) {
    const { rows: existing } = await pool.query(
      `SELECT id FROM policy_rules WHERE code=$1 AND org_id IS NULL LIMIT 1`,
      [policy.code]
    );
    if (existing.length > 0) continue;

    await pool.query(
      `INSERT INTO policy_rules
         (org_id, scope, code, name, description, rule_json, priority, is_active)
       VALUES (NULL, $1, $2, $3, $4, $5::jsonb, $6, TRUE)`,
      [
        policy.scope, policy.code, policy.name,
        policy.description ?? null,
        JSON.stringify(policy.rule_json),
        policy.priority ?? 0,
      ]
    );
    seeded++;
  }

  if (seeded > 0) {
    logger.info({ seeded }, `${seeded} built-in policies seeded`);
  } else {
    logger.debug('Built-in policies already present — skipping seed');
  }
}
