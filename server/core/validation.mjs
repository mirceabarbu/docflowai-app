/**
 * server/core/validation.mjs — request body validation middleware.
 *
 * Usage:
 *   router.post('/endpoint', validateBody({
 *     name:  { type: 'string', required: true, min: 1, max: 100 },
 *     age:   { type: 'number', required: false, min: 0, max: 150 },
 *   }), handler);
 */

import { ValidationError } from './errors.mjs';

const SUPPORTED_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

/**
 * Returns an Express middleware that validates req.body against the given rules.
 * Throws ValidationError (HTTP 422) with a fields map if validation fails.
 *
 * @param {Record<string, { type?: string, required?: boolean, min?: number, max?: number }>} rules
 */
export function validateBody(rules) {
  return (req, _res, next) => {
    const fields = {};
    const body = req.body ?? {};

    for (const [field, rule] of Object.entries(rules)) {
      const value = body[field];
      const missing = value === undefined || value === null || value === '';

      if (rule.required && missing) {
        fields[field] = `Field '${field}' is required`;
        continue;
      }

      if (missing) continue; // optional and absent — skip remaining checks

      if (rule.type && SUPPORTED_TYPES.has(rule.type)) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== rule.type) {
          fields[field] = `Field '${field}' must be of type ${rule.type}`;
          continue;
        }
      }

      if (rule.type === 'string') {
        if (rule.min !== undefined && value.length < rule.min) {
          fields[field] = `Field '${field}' must be at least ${rule.min} characters`;
          continue;
        }
        if (rule.max !== undefined && value.length > rule.max) {
          fields[field] = `Field '${field}' must be at most ${rule.max} characters`;
          continue;
        }
      }

      if (rule.type === 'number') {
        if (rule.min !== undefined && value < rule.min) {
          fields[field] = `Field '${field}' must be ≥ ${rule.min}`;
          continue;
        }
        if (rule.max !== undefined && value > rule.max) {
          fields[field] = `Field '${field}' must be ≤ ${rule.max}`;
          continue;
        }
      }

      if (rule.type === 'array') {
        if (rule.min !== undefined && value.length < rule.min) {
          fields[field] = `Field '${field}' must have at least ${rule.min} items`;
          continue;
        }
        if (rule.max !== undefined && value.length > rule.max) {
          fields[field] = `Field '${field}' must have at most ${rule.max} items`;
          continue;
        }
      }
    }

    if (Object.keys(fields).length > 0) {
      return next(new ValidationError('Validation failed', fields));
    }

    next();
  };
}
