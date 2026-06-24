/**
 * Unit — copyFormularAttachmentsToFlow (fix 3/4)
 *
 * Verifică contractul helper-ului PUR cu un pool fake:
 *  - guard pe input invalid (fără pool / fără formId / formType greșit) → 0, fără query
 *  - INSERT...SELECT cu parametrii corecți [flowId, formType, formId]
 *  - întoarce numărul de rânduri copiate (rows.length)
 *
 * Logica de dedup (NOT EXISTS) + filtrul deleted_at trăiesc în SQL → caracterizate
 * la nivel DB în server/tests/db/formular-flow-attachments-copy.test.mjs.
 */
import { describe, it, expect, vi } from 'vitest';
import { copyFormularAttachmentsToFlow } from '../../services/formular-flow-attachments.mjs';

function fakePool(rows) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('copyFormularAttachmentsToFlow', () => {
  it('întoarce 0 și NU interoghează când lipsește pool/flowId/formId', async () => {
    const p = fakePool([]);
    expect(await copyFormularAttachmentsToFlow(null, { flowId: 'f1', formType: 'df', formId: '5' })).toBe(0);
    expect(await copyFormularAttachmentsToFlow(p, { flowId: '', formType: 'df', formId: '5' })).toBe(0);
    expect(await copyFormularAttachmentsToFlow(p, { flowId: 'f1', formType: 'df', formId: '' })).toBe(0);
    expect(p.query).not.toHaveBeenCalled();
  });

  it('întoarce 0 și NU interoghează pentru formType necunoscut', async () => {
    const p = fakePool([]);
    expect(await copyFormularAttachmentsToFlow(p, { flowId: 'f1', formType: 'xx', formId: '5' })).toBe(0);
    expect(p.query).not.toHaveBeenCalled();
  });

  it('rulează INSERT...SELECT cu [flowId, formType, formId] și întoarce numărul copiat', async () => {
    const p = fakePool([{ id: 1, filename: 'a.pdf' }, { id: 2, filename: 'b.pdf' }]);
    const n = await copyFormularAttachmentsToFlow(p, { flowId: 'flow-9', formType: 'ord', formId: '42' });
    expect(n).toBe(2);
    expect(p.query).toHaveBeenCalledTimes(1);
    const [sql, params] = p.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO flow_attachments/i);
    expect(sql).toMatch(/FROM formulare_atasamente/i);
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).toMatch(/deleted_at IS NULL/i);
    expect(params).toEqual(['flow-9', 'ord', '42']);
  });

  it('întoarce 0 când nu există atașamente de copiat', async () => {
    const p = fakePool([]);
    expect(await copyFormularAttachmentsToFlow(p, { flowId: 'f1', formType: 'df', formId: '5' })).toBe(0);
  });
});
