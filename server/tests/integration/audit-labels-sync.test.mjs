// audit-labels-sync.test.mjs
//
// Test guard: orice event_type scris în audit_log via writeAuditEvent
// trebuie să aibă traducere în AMBELE dicționare client (activity.js +
// audit.js). Previne regresia "tag raw în UI" la adăugarea unui event
// type nou în backend fără update la client.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

function walkMjs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkMjs(full, out);
    else if (st.isFile() && full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function extractEventTypesFromBackend() {
  const files = walkMjs(path.join(REPO, 'server'));
  const types = new Set();

  // Pattern 1: audit_log via writeAuditEvent
  const reAudit = /eventType:\s*'([A-Za-z_.][A-Za-z_.0-9]*)'/g;

  // Pattern 2: flow_events JSONB — type: '...' într-un obiect care conține și `at:`
  // (filtrare strictă pentru a evita match-uri în notificări/payloads)
  const reFlowEv = /\{[^{}]*\bat:\s*[^,{}]+,[^{}]*\btype:\s*'([A-Z_][A-Z_0-9]*)'[^{}]*\}/g;
  const reFlowEvAlt = /\{[^{}]*\btype:\s*'([A-Z_][A-Z_0-9]*)'[^{}]*\bat:\s*[^,{}]+[^{}]*\}/g;

  for (const f of files) {
    if (f.includes(`${path.sep}tests${path.sep}`)) continue;
    const s = readFileSync(f, 'utf8');
    let m;
    while ((m = reAudit.exec(s)) !== null) types.add(m[1]);
    while ((m = reFlowEv.exec(s)) !== null) types.add(m[1]);
    while ((m = reFlowEvAlt.exec(s)) !== null) types.add(m[1]);
  }

  // Eventuri scrise cu raw SQL (rar) sau în notify pipelines fără `at:` în literal
  types.add('plata_auto_opme');
  types.add('entitlement_change');

  // Excludem eventuri tehnice care NU au `by:` setat (deci nu apar în Rapoarte)
  // NOTIFY/NOTIFY_FAILED sunt notificări auto, fără actor uman
  types.delete('NOTIFY');
  types.delete('NOTIFY_FAILED');

  return types;
}

function extractLabelsFromClient(relPath) {
  const content = readFileSync(path.join(REPO, relPath), 'utf8');
  const re = /['"]?([A-Za-z_][A-Za-z_.0-9]*)['"]?\s*:\s*['"][^'"]+['"]/g;
  const labels = new Set();
  let m;
  while ((m = re.exec(content)) !== null) labels.add(m[1]);
  return labels;
}

describe('audit labels sync', () => {
  const backendTypes = extractEventTypesFromBackend();
  const activityLabels = extractLabelsFromClient(
    'public/js/admin/activity.js'
  );
  const auditLabels = extractLabelsFromClient(
    'public/js/admin/audit.js'
  );

  for (const type of backendTypes) {
    it(`activity.js are traducere pentru ${type}`, () => {
      expect(activityLabels.has(type),
        `Lipsește în public/js/admin/activity.js > OP_LABELS_RO`
      ).toBe(true);
    });
    it(`audit.js are traducere pentru ${type}`, () => {
      expect(auditLabels.has(type),
        `Lipsește în public/js/admin/audit.js > AUDIT_EVENT_LABELS`
      ).toBe(true);
    });
  }
});
