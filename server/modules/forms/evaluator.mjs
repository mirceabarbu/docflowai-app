/**
 * server/modules/forms/evaluator.mjs — Rules evaluator (pure logic, no side effects).
 *
 * Evaluates a set of rules against a data object and returns field-level
 * visibility/required overrides plus any validation errors.
 *
 * Rule schema (stored in form_versions.rules_json):
 * {
 *   id: string,
 *   condition: { field: string, operator: string, value: any },
 *   action: { type: 'show'|'hide'|'require'|'set_value', field: string, value?: any }
 * }
 *
 * Supported operators: eq, neq, gt, gte, lt, lte, contains, not_contains,
 *                      in, not_in, empty, not_empty
 */

// ── getNestedValue ─────────────────────────────────────────────────────────────

/**
 * Reads a (possibly nested) value from an object using dot notation.
 * e.g. getNestedValue({ a: { b: 1 } }, 'a.b') → 1
 */
export function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

// ── evaluateCondition ──────────────────────────────────────────────────────────

/**
 * Evaluates a single condition against data.
 * @param {{ field: string, operator: string, value: any }} condition
 * @param {object} data
 * @returns {boolean}
 */
export function evaluateCondition(condition, data) {
  const { field, operator, value } = condition;
  const fieldValue = getNestedValue(data, field);

  switch (operator) {
    case 'eq':          return fieldValue == value;           // loose equality for mixed types
    case 'neq':         return fieldValue != value;
    case 'gt':          return Number(fieldValue) > Number(value);
    case 'gte':         return Number(fieldValue) >= Number(value);
    case 'lt':          return Number(fieldValue) < Number(value);
    case 'lte':         return Number(fieldValue) <= Number(value);
    case 'contains':    return String(fieldValue ?? '').includes(String(value));
    case 'not_contains':return !String(fieldValue ?? '').includes(String(value));
    case 'in':          return Array.isArray(value) && value.includes(fieldValue);
    case 'not_in':      return Array.isArray(value) && !value.includes(fieldValue);
    case 'empty':       return fieldValue == null || fieldValue === '' || (Array.isArray(fieldValue) && fieldValue.length === 0);
    case 'not_empty':   return fieldValue != null && fieldValue !== '' && !(Array.isArray(fieldValue) && fieldValue.length === 0);
    default:            return false;
  }
}

// ── evaluateRules ──────────────────────────────────────────────────────────────

/**
 * Runs all rules against data, returning field overrides and computed values.
 *
 * @param {Array} rules          — array of rule objects
 * @param {object} data          — current form data
 * @returns {{
 *   hidden: Set<string>,         — fields that should be hidden
 *   required: Set<string>,       — extra required fields (from 'require' actions)
 *   computed: Record<string,any> — fields with values set by 'set_value' actions
 * }}
 */
export function evaluateRules(rules, data) {
  const hidden   = new Set();
  const required = new Set();
  const computed = {};

  if (!Array.isArray(rules)) return { hidden, required, computed };

  for (const rule of rules) {
    if (!rule?.condition || !rule?.action) continue;

    const conditionMet = evaluateCondition(rule.condition, data);
    if (!conditionMet) continue;

    const { type, field, value } = rule.action;
    switch (type) {
      case 'show':      hidden.delete(field);     break;
      case 'hide':      hidden.add(field);        break;
      case 'require':   required.add(field);      break;
      case 'set_value': computed[field] = value;  break;
    }
  }

  return { hidden, required, computed };
}

// ── validateFormData ───────────────────────────────────────────────────────────

/**
 * Validates form data against the schema (required fields, types) and rules.
 *
 * @param {object} data          — submitted form data
 * @param {object} schema        — form_versions.schema_json
 * @param {Array}  rules         — form_versions.rules_json
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateFormData(data, schema, rules = []) {
  const errors = {};
  const { hidden, required: extraRequired } = evaluateRules(rules, data);

  const fields = schema?.fields ?? [];

  for (const field of fields) {
    if (hidden.has(field.name)) continue;   // hidden fields are not validated

    const value = getNestedValue(data, field.name);
    const isRequired = field.required || extraRequired.has(field.name);

    if (isRequired) {
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
        errors[field.name] = `Câmpul "${field.label || field.name}" este obligatoriu.`;
        continue;
      }
    }

    if (value != null && value !== '') {
      if (field.type === 'number' && isNaN(Number(value))) {
        errors[field.name] = `Câmpul "${field.label || field.name}" trebuie să fie un număr.`;
      }
      if (field.maxLength && String(value).length > field.maxLength) {
        errors[field.name] = `Câmpul "${field.label || field.name}" depășește lungimea maximă (${field.maxLength}).`;
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
