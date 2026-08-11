/**
 * Unit — flow-provenance.mjs (P0-03).
 *
 * Acoperă partea PURĂ: fragmentele SQL (`liveFlowSql` / `validSignedFlowSql`) și
 * refuzul precoce din `checkFlowLinkable` (înainte de orice atingere a DB-ului).
 *
 * Testul de ECHIVALENȚĂ cu #120 (`flow-link-audit.mjs`) e plasa anti-drift: predicatul
 * trebuie definit O SINGURĂ DATĂ. Cât timp `flow-link-audit.mjs` mai avea copii locale,
 * testul le compara byte-cu-byte; după dedup (Etapa B4) verifică STRUCTURAL că fișierul
 * nu mai declară copii proprii, ci importă din `flow-provenance.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveFlowSql, validSignedFlowSql, checkFlowLinkable } from '../../services/flow-provenance.mjs';

const auditSrc = readFileSync(
  fileURLToPath(new URL('../../services/flow-link-audit.mjs', import.meta.url)), 'utf8'
);
const provSrc = readFileSync(
  fileURLToPath(new URL('../../services/flow-provenance.mjs', import.meta.url)), 'utf8'
);

// Extrage corpul unei funcții top-level (până la linia care e exact „}").
function extractFn(src, name) {
  const start = src.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
  if (start < 0) return null;
  const end = src.indexOf('\n}', start);
  return end < 0 ? null : src.slice(start, end + 2);
}
// `export ` nu face parte din semantica predicatului — se ignoră la comparație.
const norm = (s) => String(s).replace(/^export /, '').replace(/\s+/g, ' ').trim();

describe('flow-provenance — fragmente SQL pure', () => {
  it('1. liveFlowSql exclude șters/anulat/refuzat și folosește aliasul primit', () => {
    const sql = liveFlowSql('x');
    expect(sql).toContain('x.deleted_at IS NULL');
    expect(sql).toContain("x.data->>'status' IS DISTINCT FROM 'cancelled'");
    expect(sql).toContain("x.data->>'status' IS DISTINCT FROM 'refused'");
    expect(sql).not.toContain('f.'); // aliasul implicit nu se scurge
    expect(liveFlowSql()).toContain('f.deleted_at IS NULL'); // implicit 'f'
  });

  it('2. validSignedFlowSql include tot ce include liveFlowSql + ramura completed', () => {
    const live = liveFlowSql('a');
    const signed = validSignedFlowSql('a');
    for (const frag of live.split('AND').map((s) => s.trim()).filter(Boolean)) {
      expect(norm(signed)).toContain(norm(frag));
    }
    expect(signed).toContain("a.data->>'status' = 'completed'");
    expect(signed).toContain("(a.data->>'completed')::boolean = true");
  });

  it('3. anti-drift #120: predicatele sunt definite o SINGURĂ dată (flow-link-audit importă)', () => {
    const localLive = extractFn(auditSrc, 'liveFlowSql');
    const localSigned = extractFn(auditSrc, 'validSignedFlowSql');

    if (localLive || localSigned) {
      // Faza de tranziție: copiile locale mai există ⇒ trebuie să fie IDENTICE.
      expect(norm(localLive)).toBe(norm(extractFn(provSrc, 'liveFlowSql')));
      expect(norm(localSigned)).toBe(norm(extractFn(provSrc, 'validSignedFlowSql')));
    } else {
      // După dedup: fișierul importă predicatele din sursa unică.
      expect(auditSrc).toMatch(
        /import\s*\{[^}]*validSignedFlowSql[^}]*\}\s*from\s*'\.\/flow-provenance\.mjs'/
      );
      expect(auditSrc).toMatch(/import\s*\{[^}]*liveFlowSql[^}]*\}\s*from\s*'\.\/flow-provenance\.mjs'/);
    }
  });
});

describe('flow-provenance — checkFlowLinkable, refuz precoce', () => {
  const poolCareAruncă = { query: () => { throw new Error('pool nu trebuie atins'); } };

  it('4. flowId gol → 400 flow_id_invalid, fără să atingă pool-ul', async () => {
    for (const flowId of [undefined, null, '', 0, 123, {}]) {
      const r = await checkFlowLinkable(poolCareAruncă, {
        flowId, kind: 'df', alop: { id: 'a1', df_id: 7 }, orgId: 1,
      });
      expect(r.ok).toBe(false);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('flow_id_invalid');
      expect(typeof r.body.message).toBe('string');
    }
  });

  it('5. kind necunoscut → refuz (fail-closed), fără să atingă pool-ul', async () => {
    const r = await checkFlowLinkable(poolCareAruncă, {
      flowId: 'flow-1', kind: 'altceva', alop: { id: 'a1' }, orgId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('kind_invalid');
  });

  it('6. orgId lipsă → refuz 403 (fail-closed), fără să atingă pool-ul', async () => {
    const r = await checkFlowLinkable(poolCareAruncă, {
      flowId: 'flow-1', kind: 'df', alop: { id: 'a1', df_id: 7 }, orgId: null,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('flow_alt_org');
  });
});
