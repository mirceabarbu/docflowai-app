/**
 * Unit tests pentru server/services/opme-matcher.mjs — Pachet B.
 *
 * Folosește un client pg mock-uit (vi.fn pe query) + un mic „router" SQL
 * care recunoaște query-urile prin pattern matching și întoarce rezultate
 * adecvate pentru fiecare scenariu.
 *
 * Acoperire:
 *   ✓ 0 candidați → unmatched
 *   ✓ 1 candidat + sumă egală + 1 linie → confirmat, alop completed
 *   ✓ 1 candidat + sumă egală + 2 linii pe același triplet → confirmat,
 *      plata_nr_ordin = "1310, 1311"
 *   ✓ 1 candidat + sumă mai mică → partial, ALOP rămâne în 'plata'
 *   ✓ 1 candidat + sumă mai mare → partial (overpay), NU confirmă
 *   ✓ >1 candidați → ambiguous
 *   ✓ Idempotență: a doua rulare nu modifică nimic
 *   ✓ Tenant isolation: linie org=1 nu matchează ciclu org=2
 *   ✓ tryAutoConfirmAlop absoarbe linia pending pe ALOP nou „intrat în plată"
 *   ✓ already_confirmed (race) — nu re-confirmă
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock pool — folosim un client custom în fiecare test ────────────────────
vi.mock('../../db/index.mjs', () => ({ pool: { connect: vi.fn(), query: vi.fn() } }));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as dbModule from '../../db/index.mjs';
import { matchImport, tryAutoConfirmAlop, summarizeReport } from '../../services/opme-matcher.mjs';

// ── Helper: client mock care răspunde la query-uri prin pattern matching ─────
function makeMockClient(handlers) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      const handler = handlers.find(h => h.match(sql, params));
      if (!handler) return { rows: [] }; // default: empty
      return await handler.respond(sql, params, calls);
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

function H(matcher, responder) {
  const match = typeof matcher === 'string'
    ? (sql) => sql.includes(matcher)
    : matcher;
  return { match, respond: responder };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Scenarii ────────────────────────────────────────────────────────────────

describe('matchImport — 0 candidați', () => {
  it('linia rămâne unmatched cu notă explicativă', async () => {
    const handlers = [
      H('FROM opme_imports', async () => ({
        rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99, nr_document: '0000130', data_op: new Date('2026-05-06') }]
      })),
      H('FROM opme_lines\n       WHERE opme_import_id', async () => ({
        rows: [{
          id: 'line-1', cod_angajament: 'XYZ', indicator_angajament: 'XYZ',
          cif_beneficiar: '999', suma_op: 100, nr_op: '1310',
        }]
      })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'), async () => ({ rows: [] })),
      H(s => s.startsWith('\n    UPDATE opme_lines'), async () => ({ rows: [] })),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep.unmatched).toBe(1);
    expect(rep.matched).toBe(0);
    expect(rep.confirmed_alopuri).toEqual([]);
  });
});

describe('matchImport — 1 candidat, sumă egală, 1 linie', () => {
  it('confirmă ALOP, marchează linia auto, nr_ordin=nr_op', async () => {
    let updatedLines = false;
    let confirmedAlop = false;
    const handlers = [
      H('FROM opme_imports', async () => ({
        rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99, nr_document: '0130', data_op: new Date('2026-05-06') }]
      })),
      H(s => s.includes('WHERE opme_import_id ='), async () => ({
        rows: [{ id: 'line-1', cod_angajament: 'AAB2F', indicator_angajament: 'AAB',
                 cif_beneficiar: '12345', suma_op: 4061.00, nr_op: '1310' }]
      })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'), async () => ({
        rows: [{ alop_id: 'alop-1' }]
      })),
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'")
            , async () => ({ rows: [{ expected: 4061.00 }] })),
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async (_sql, _params) => ({ rows: [
          { id: 'line-1', suma_op: 4061.00, nr_op: '1310', opme_import_id: 'imp-1' }
        ] })),
      H(s => s.includes('FROM opme_imports\n         WHERE id = ANY'),
        async () => ({ rows: [{ data_op: new Date('2026-05-06'), nr_documents: '0130' }] })),
      H(s => s.includes('UPDATE alop_instances') && s.includes('plata_confirmed_at=NOW()'),
        async () => { confirmedAlop = true; return { rows: [{ id: 'alop-1', status: 'completed' }] }; }),
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status=$3"),
        async () => { updatedLines = true; return { rows: [] }; }),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep.matched).toBe(1);
    expect(rep.confirmed_alopuri).toEqual(['alop-1']);
    expect(confirmedAlop).toBe(true);
    expect(updatedLines).toBe(true);
  });
});

describe('matchImport — 1 candidat, 2 linii pe același triplet (sumă egală)', () => {
  it('plata_nr_ordin agregă "1310, 1311"', async () => {
    let nrOrdinSent = null;
    const handlers = [
      H('FROM opme_imports', async () => ({
        rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99, nr_document: '0130', data_op: new Date('2026-05-06') }]
      })),
      H(s => s.includes('WHERE opme_import_id ='), async () => ({
        rows: [
          { id: 'L1', cod_angajament: 'AAB', indicator_angajament: 'AAB',
            cif_beneficiar: '12', suma_op: 100, nr_op: '1310' },
          { id: 'L2', cod_angajament: 'AAB', indicator_angajament: 'AAB',
            cif_beneficiar: '12', suma_op: 200, nr_op: '1311' },
        ]
      })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'), async () => ({
        rows: [{ alop_id: 'alop-1' }]
      })),
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'"),
        async () => ({ rows: [{ expected: 300 }] })),
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async () => ({ rows: [
          { id: 'L1', suma_op: 100, nr_op: '1310', opme_import_id: 'imp-1' },
          { id: 'L2', suma_op: 200, nr_op: '1311', opme_import_id: 'imp-1' },
        ] })),
      H(s => s.includes('FROM opme_imports\n         WHERE id = ANY'),
        async () => ({ rows: [{ data_op: new Date('2026-05-06'), nr_documents: '0130' }] })),
      H(s => s.includes('UPDATE alop_instances') && s.includes('plata_confirmed_at=NOW()'),
        async (_sql, params) => {
          // params: [userId, notes, nr_ordin_plata, data_plata, suma_efectiva, observatii, alopId, orgId, source]
          nrOrdinSent = params[2];
          return { rows: [{ id: 'alop-1' }] };
        }),
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status=$3"),
        async () => ({ rows: [] })),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep.matched).toBe(2);
    expect(nrOrdinSent).toBe('1310, 1311');
  });
});

describe('matchImport — sumă mai mică (partial)', () => {
  it('linia devine partial, ALOP rămâne în plata', async () => {
    let confirmCalled = false;
    let partialNote = null;
    const handlers = [
      H('FROM opme_imports', async () => ({
        rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99 }]
      })),
      H(s => s.includes('WHERE opme_import_id ='), async () => ({
        rows: [{ id: 'L1', cod_angajament: 'A', indicator_angajament: 'A',
                 cif_beneficiar: '12', suma_op: 50, nr_op: '1310' }]
      })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'),
        async () => ({ rows: [{ alop_id: 'alop-1' }] })),
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'"),
        async () => ({ rows: [{ expected: 100 }] })),
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async () => ({ rows: [{ id: 'L1', suma_op: 50, nr_op: '1310', opme_import_id: 'imp-1' }] })),
      H(s => s.includes('UPDATE alop_instances') && s.includes('plata_confirmed_at=NOW()'),
        async () => { confirmCalled = true; return { rows: [{ id: 'alop-1' }] }; }),
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status='partial'"),
        async (_sql, params) => { partialNote = params[2]; return { rows: [] }; }),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep.matched).toBe(0);
    expect(rep.partial).toBe(1);
    expect(confirmCalled).toBe(false);
    expect(partialNote).toMatch(/Plată parțială/);
  });
});

describe('matchImport — overpay', () => {
  it('linia devine partial, NU confirmă', async () => {
    const handlers = [
      H('FROM opme_imports', async () => ({ rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99 }] })),
      H(s => s.includes('FROM opme_lines') && s.includes('opme_import_id'),
        async () => ({ rows: [{ id: 'L1', cod_angajament: 'A', indicator_angajament: 'A',
                                 cif_beneficiar: '12', suma_op: 200, nr_op: '1310' }] })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'),
        async () => ({ rows: [{ alop_id: 'alop-1' }] })),
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'"),
        async () => ({ rows: [{ expected: 100 }] })),
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async () => ({ rows: [{ id: 'L1', suma_op: 200, nr_op: '1310', opme_import_id: 'imp-1' }] })),
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status='partial'"), async () => ({ rows: [] })),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep.partial).toBe(1);
    expect(rep.matched).toBe(0);
    expect(rep.details[0].result).toBe('overpay');
  });
});

describe('matchImport — >1 candidați (ambiguous)', () => {
  it('linia devine ambiguous cu lista de alop_ids', async () => {
    let ambiguousNote = null;
    const handlers = [
      H('FROM opme_imports', async () => ({ rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99 }] })),
      H(s => s.includes('FROM opme_lines') && s.includes('opme_import_id'),
        async () => ({ rows: [{ id: 'L1', cod_angajament: 'A', indicator_angajament: 'A',
                                 cif_beneficiar: '12', suma_op: 100, nr_op: '1310' }] })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'),
        async () => ({ rows: [{ alop_id: 'a-1' }, { alop_id: 'a-2' }, { alop_id: 'a-3' }] })),
      H(s => s.includes('UPDATE opme_lines SET match_status=$2'),
        async (_sql, params) => { ambiguousNote = { status: params[1], note: params[2] }; return { rows: [] }; }),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep.ambiguous).toBe(1);
    expect(ambiguousNote.status).toBe('ambiguous');
    expect(ambiguousNote.note).toMatch(/a-1, a-2, a-3/);
  });
});

describe('matchImport — idempotență (a doua rulare: zero linii pending)', () => {
  it('returnează raport gol fără să facă side-effects', async () => {
    const handlers = [
      H('FROM opme_imports', async () => ({ rows: [{ id: 'imp-1', org_id: 7, uploaded_by: 99 }] })),
      H(s => s.includes('FROM opme_lines') && s.includes('opme_import_id'),
        async () => ({ rows: [] })), // zero pending după prima rulare
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client, calls } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    expect(rep).toMatchObject({ matched: 0, ambiguous: 0, unmatched: 0, partial: 0 });
    // verifică că NU s-a făcut nicio interogare către alop_instances
    expect(calls.some(c => /FROM alop_instances/.test(c.sql))).toBe(false);
    expect(calls.some(c => /UPDATE alop_instances/.test(c.sql))).toBe(false);
  });
});

describe('matchImport — tenant isolation', () => {
  it('candidatul cu org diferit nu apare (mock returnează [] pentru CIF cross-org)', async () => {
    // În acest test simulăm: linia este org=1 (din opme_imports), iar ALOP-ul
    // potențial similar pe (cod, ind, cif) este în org=2 — query-ul SQL
    // include filtrare a.org_id = $1, deci mock-ul returnează [] pentru org=1.
    let alopQueryParams = null;
    const handlers = [
      H('FROM opme_imports', async () => ({
        rows: [{ id: 'imp-1', org_id: 1, uploaded_by: 99 }]
      })),
      H(s => s.includes('FROM opme_lines') && s.includes('opme_import_id'),
        async () => ({ rows: [{ id: 'L1', cod_angajament: 'A', indicator_angajament: 'A',
                                 cif_beneficiar: '99', suma_op: 100, nr_op: '1310' }] })),
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'),
        async (_sql, params) => { alopQueryParams = params; return { rows: [] }; }),
      H('UPDATE opme_lines', async () => ({ rows: [] })),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const rep = await matchImport('imp-1');
    // verifică că query-ul candidaților a folosit org_id=1
    expect(alopQueryParams[0]).toBe(1);
    expect(rep.unmatched).toBe(1);
  });
});

describe('tryAutoConfirmAlop — absorbție retro', () => {
  it('absoarbe linii pending vechi când ALOP intră în plata', async () => {
    let confirmCalled = false;
    let bulkMarkCalled = false;
    const handlers = [
      H(s => s.includes('FROM alop_instances') && s.includes('LEFT JOIN formulare_ord') && s.includes('WHERE a.id = $1'),
        async () => ({ rows: [{
          id: 'alop-1', org_id: 7, status: 'plata', plata_confirmed_at: null,
          created_by: 33, ord_id: 'ord-1', cif_beneficiar: '12',
          ord_rows: [{ cod_angajament: 'A', indicator_angajament: 'A', suma_ordonantata_plata: '100' }]
        }] })),
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'"),
        async () => ({ rows: [{ expected: 100 }] })),
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async () => ({ rows: [
          // linie deja existentă pending pe un import vechi
          { id: 'OLD', suma_op: 100, nr_op: '999', opme_import_id: 'imp-old' }
        ] })),
      H(s => s.includes('FROM opme_imports\n         WHERE id = ANY'),
        async () => ({ rows: [{ data_op: new Date('2026-04-01'), nr_documents: '0099' }] })),
      H(s => s.includes('UPDATE alop_instances') && s.includes('plata_confirmed_at=NOW()'),
        async () => { confirmCalled = true; return { rows: [{ id: 'alop-1' }] }; }),
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status=$3"),
        async () => { bulkMarkCalled = true; return { rows: [] }; }),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const out = await tryAutoConfirmAlop('alop-1', { actorUserId: 33 });
    expect(out.confirmed).toBe(true);
    expect(out.reason).toBe('matched');
    expect(confirmCalled).toBe(true);
    expect(bulkMarkCalled).toBe(true);
  });

  it('NU confirmă dacă ALOP nu e în plata', async () => {
    const handlers = [
      H(s => s.includes('FROM alop_instances') && s.includes('LEFT JOIN formulare_ord') && s.includes('WHERE a.id = $1'),
        async () => ({ rows: [{ id: 'a', status: 'ordonantare', plata_confirmed_at: null }] })),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const out = await tryAutoConfirmAlop('alop-x');
    expect(out.confirmed).toBe(false);
    expect(out.reason).toBe('wrong_status');
  });

  it('NU re-confirmă dacă plata_confirmed_at e deja setat', async () => {
    const handlers = [
      H(s => s.includes('FROM alop_instances') && s.includes('LEFT JOIN formulare_ord') && s.includes('WHERE a.id = $1'),
        async () => ({ rows: [{ id: 'a', status: 'plata',
                                 plata_confirmed_at: new Date() }] })),
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
    ];
    const { client } = makeMockClient(handlers);
    dbModule.pool.connect.mockResolvedValue(client);

    const out = await tryAutoConfirmAlop('alop-x');
    expect(out.confirmed).toBe(false);
    expect(out.reason).toBe('already_confirmed');
  });
});

describe('summarizeReport — format text user-friendly', () => {
  it('include numere și etichete în limba română', () => {
    const t = summarizeReport({
      matched: 12, ambiguous: 3, unmatched: 2, partial: 0,
      confirmed_alopuri: ['a', 'b', 'c'],
      details: [],
    });
    expect(t).toMatch(/17 linii citite/);
    expect(t).toMatch(/3 ALOP confirmate automat/);
    expect(t).toMatch(/3 ambigue/);
    expect(t).toMatch(/2 fără match/);
  });
});
