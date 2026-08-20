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

// ── #134f — calea (b) de proveniență cu pointerul DEJA ocupat ────────────────
// `alop.df_id` e acum „revizia ÎN VIGOARE", deci fluxul lui R(n+1) revendică un ALT
// document decât cel pointat. Calea (b) trebuie să se deschidă — dar NUMAI pentru `df`.
// (Aici pool-ul e un dublu: verificăm CE se interoghează, nu conținutul bazei — acoperirea
// pe date reale e în server/tests/db/alop-revizie-in-vigoare.test.mjs, F6/F7/F9/F10.)
describe('flow-provenance — #134f: proveniență cu df_id non-NULL', () => {
  const ALOP = { id: 'alop-1', df_id: 'df-vechi', ord_id: 'ord-curent' };

  // Pool fals: primul query = metadatele fluxului; al doilea (dacă apare) = calea (b).
  function fakePool({ metaDocId, provenientaOk }) {
    const queries = [];
    return {
      queries,
      query: async (sql) => {
        queries.push(sql);
        if (/FROM flows/.test(sql)) {
          return { rows: [{ id: 'flow-1', same_org: true, live: true, meta_doc_id: metaDocId }] };
        }
        // calea (b): SELECT 1 FROM formulare_{df,ord} ... source_alop_id = $2
        expect(sql).toContain('source_alop_id');
        expect(sql).not.toContain('nr_unic_inreg');   // ⛔ fără fallback pe număr
        return { rows: provenientaOk ? [{ '?column?': 1 }] : [] };
      },
    };
  }

  it('7. df: fluxul unei ALTE revizii din același dosar e ACCEPTAT deși df_id e ocupat', async () => {
    const pool = fakePool({ metaDocId: 'df-revizie-noua', provenientaOk: true });
    const r = await checkFlowLinkable(pool, {
      flowId: 'flow-1', kind: 'df', alop: ALOP, orgId: 1,
    });
    expect(r.ok).toBe(true);
    expect(pool.queries.length).toBe(2);              // calea (b) chiar s-a executat
  });

  it('8. df: un document care NU aparține dosarului rămâne REFUZAT (poarta nu s-a lărgit)', async () => {
    const pool = fakePool({ metaDocId: 'df-alt-dosar', provenientaOk: false });
    const r = await checkFlowLinkable(pool, {
      flowId: 'flow-1', kind: 'df', alop: ALOP, orgId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.body.error).toBe('flux_alt_document');
  });

  it('9. ord: relaxarea NU se aplică — calea (b) nici măcar nu se interoghează', async () => {
    // Un ORD arhivat dintr-un ciclu anterior poartă tot source_alop_id = alop.id;
    // dacă am ridica garda, fluxul lui ar putea deveni fluxul ORD curent.
    const pool = fakePool({ metaDocId: 'ord-arhivat', provenientaOk: true });
    const r = await checkFlowLinkable(pool, {
      flowId: 'flow-1', kind: 'ord', alop: ALOP, orgId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.body.error).toBe('flux_alt_document');
    expect(pool.queries.length).toBe(1);              // doar interogarea fluxului
  });

  it('10. ord: calea (b) rămâne DISPONIBILĂ când ord_id e NULL (cazul cloud „Fără ORD")', async () => {
    const pool = fakePool({ metaDocId: 'ord-nou', provenientaOk: true });
    const r = await checkFlowLinkable(pool, {
      flowId: 'flow-1', kind: 'ord', alop: { id: 'alop-1', df_id: 'df-x', ord_id: null }, orgId: 1,
    });
    expect(r.ok).toBe(true);
    expect(pool.queries.length).toBe(2);
  });
});
